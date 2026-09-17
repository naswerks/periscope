/**
 * The live probe for one property: does an `{ type: 'http' }` MCP server actually register
 * through this host?
 *
 * Why it is a probe and not an assumption: the clean way for a controller to give an agent its own
 * tools is to register an HTTP MCP server pointing back at itself, over
 * `session_new.request.mcpServers`, because there is no wire lane for a tool call, so descriptors
 * alone give an in-process server whose calls the controller cannot see. Every design above this
 * rests on the registration working. The package's own MCP tests use in-process servers, and an
 * in-process server cannot fail to connect, so nothing else exercises the failure mode a networked
 * server has and an in-process one does not.
 *
 * The receipt is the agent's own report, twice over. `system/init` carries `mcp_servers` (name
 * plus connection status) and `tools`. Either alone is weaker: a status without tools would say
 * the socket opened and nothing was published, and tools without a status would leave "connected"
 * inferred from a name prefix. Both together settle it in one message, proven by the host's
 * report, never by the request.
 *
 * It skips loudly. Without `PERISCOPE_LIVE=1` this is skipped with the reason in its own name, so
 * the suite's `skipped` count is the standing reminder that the property is NOT exercised.
 *
 * The known limit, stated so a skip is never read as a pass: these probes cannot be run from
 * inside an agent session, because the child inherits the enclosing harness's tool surface. A run
 * from an ordinary terminal is what settles this one.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry } from '../sessions/registry.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const skip = LIVE ? false : 'PERISCOPE_LIVE is not set — this property is NOT exercised';

const START_TIMEOUT_MS = 120_000;

/**
 * The smallest thing that answers MCP over Streamable HTTP: initialize, then one tool.
 *
 * Hand-rolled rather than pulled from a library because the question is whether this host registers
 * a networked server, not whether somebody's SDK speaks the protocol, and a dependency here would
 * put a second thing in the failure path of a probe whose whole value is an unambiguous answer.
 */
function toolServer(): Promise<{ url: string; close: () => void; initialized: () => boolean }> {
  let sawInitialize = false;

  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      let message: { id?: unknown; method?: string };
      try {
        message = JSON.parse(body) as { id?: unknown; method?: string };
      } catch {
        response.writeHead(400).end();
        return;
      }

      const reply = (result: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };

      if (message.method === 'initialize') {
        sawInitialize = true;
        reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'periscope-http-probe', version: '0.0.1' },
        });
        return;
      }
      if (message.method === 'tools/list') {
        reply({
          tools: [
            {
              name: 'echo_probe',
              description: 'Echoes its argument. Exists so a registration has something to publish.',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            },
          ],
        });
        return;
      }
      if (message.method === 'tools/call') {
        reply({ content: [{ type: 'text', text: 'probe-ok' }] });
        return;
      }
      // Notifications carry no id and expect no body.
      response.writeHead(202).end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => server.close(),
        initialized: () => sawInitialize,
      });
    });
  });
}

test(
  'live: an { type: "http" } MCP server registers, and the agent reports it, by status and by tool',
  { skip },
  async () => {
    const probe = await toolServer();
    // Outside any repository: the agent walks UP from its working directory for project settings, so
    // a workspace inside a checkout inherits that checkout's hooks and settings.
    const cwd = mkdtempSync(`${tmpdir()}/periscope-http-mcp-`);
    const registry = new SessionRegistry({
      baseEnv: process.env,
      homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
      startTimeoutMs: START_TIMEOUT_MS,
    });

    try {
      const opened = await registry.open({
        cwd,
        // The registration under test, expressed exactly as the wire now carries it.
        mcpServers: { probe: { type: 'http', url: probe.url } as never },
        // Strict stays ON, which is the property that stops a provisioned workspace's own .mcp.json
        // registering anything: whatever arrives is what the controller asked for and nothing else.
        strictMcpConfig: true,
        prompt: 'Reply with the single word ready. Do not use any tool.',
      });

      assert.equal(opened.ok, true, opened.ok ? '' : `${opened.refusal.reason}: ${opened.refusal.detail}`);
      const facts = opened.ok ? opened.value.facts : null;
      assert.ok(facts !== null, 'the session never reported itself');

      // ---- RECEIPT 1: the agent says the server connected, by name and status. ----
      const reported = facts.mcpServers.find((server) => server.name === 'probe');
      assert.ok(
        reported !== undefined,
        `the agent reported no server named "probe" — it reported: ${JSON.stringify(facts.mcpServers)}`,
      );
      assert.equal(
        reported.status,
        'connected',
        `the registration did not connect (status "${reported.status}"). This is the finding, not a ` +
          `flake: the agent surface designed on top of an HTTP MCP registration changes shape.`,
      );

      // ---- RECEIPT 2: its tools are in the agent's own tool list. ----
      const published = facts.tools.filter((name) => name.includes('probe'));
      assert.ok(
        published.some((name) => name.includes('echo_probe')),
        `the server connected but published no tool the agent can see: ${JSON.stringify(facts.tools)}`,
      );

      // ---- And the server itself agrees it was spoken to, so neither receipt rests on the other. ----
      assert.equal(probe.initialized(), true, 'the agent never initialized the server it claims to have');

      if (opened.ok) opened.value.stop('probe complete');
    } finally {
      probe.close();
      registry.stopAll('probe complete');
    }
  },
);

test(
  'live: control: a server that is not there reports something other than connected',
  { skip },
  async () => {
    // Know what made the green above green. A probe can pass for a reason that has nothing to do
    // with the property: if `status` were reported as `connected` for anything the host was merely
    // asked to register, the test above would be a receipt for the request rather than for the
    // registration, which is the one thing the property forbids. So the same path is driven with
    // the one thing the claim is about changed, and the result must move.
    const cwd = mkdtempSync(`${tmpdir()}/periscope-http-mcp-dead-`);
    const registry = new SessionRegistry({
      baseEnv: process.env,
      homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
      startTimeoutMs: START_TIMEOUT_MS,
    });

    try {
      // Port 1 on loopback: reserved, unbound, and refused immediately rather than left hanging.
      const opened = await registry.open({
        cwd,
        mcpServers: { deadprobe: { type: 'http', url: 'http://127.0.0.1:1/mcp' } as never },
        strictMcpConfig: true,
        prompt: 'Reply with the single word ready. Do not use any tool.',
      });

      assert.equal(opened.ok, true, 'a server that cannot connect must not stop the SESSION from starting');
      const facts = opened.ok ? opened.value.facts : null;
      assert.ok(facts !== null, 'the session never reported itself');

      const reported = facts.mcpServers.find((server) => server.name === 'deadprobe');
      assert.ok(reported !== undefined, 'the agent did not mention a server it was asked to register at all');
      assert.notEqual(
        reported.status,
        'connected',
        `a server with nothing behind it reported "connected" — the status is not measuring connection, ` +
          `so the receipt above proves the REQUEST rather than the registration`,
      );

      if (opened.ok) opened.value.stop('control complete');
    } finally {
      registry.stopAll('control complete');
    }
  },
);
