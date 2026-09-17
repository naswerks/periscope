/**
 * Three properties about a session, each proven where it can be.
 *
 *   1. `model` and `systemPrompt` reach the SDK's options.
 *   2. The agent's report carries `mcpServers`, so a registration is provable by report.
 *   3. The workspace a session actually got reaches the wire; this is the regression pin that stops
 *      "already true" rotting into "was true".
 *
 * What this file proves is composition, not registration. That an `{type:'http'}` MCP server
 * actually connects is a claim about a real agent process and is exercised in `http-mcp.live.test.ts`.
 * A substitute proves the substitute; that distinction is the package's standing rule and this file
 * does not blur it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentProcess, AgentProcessRequest, SDKMessage } from './agent-process.js';
import { readInitFacts } from './agent-process.js';
import { AsyncQueue } from '../core/async-queue.js';
import { SessionRegistry } from '../sessions/registry.js';
import { composeSession } from './host.js';
import type { FrameSink } from '../control/stream.js';
import { readStateTransition } from '../control/frames.js';
import type { JsonObject, SessionPayload } from '../control/frames.js';
import { ok } from '../core/result.js';

/** Captures what the composer asked for, without starting anything. */
function capturing(): {
  requests: AgentProcessRequest[];
  start: (request: AgentProcessRequest) => AgentProcess;
} {
  const requests: AgentProcessRequest[] = [];
  return {
    requests,
    start: (request) => {
      requests.push(request);
      const queue = new AsyncQueue<SDKMessage>();
      return {
        messages: (async function* () {
          for await (const message of queue) yield message;
        })(),
        prompt: () => true,
        interrupt: async () => undefined,
        setModel: () => Promise.resolve(),
        setPermissionMode: () => Promise.resolve(),
        setThinking: () => Promise.resolve(),
        close: () => queue.end(),
      };
    },
  };
}

const registryWith = (start: (request: AgentProcessRequest) => AgentProcess): SessionRegistry =>
  new SessionRegistry({ baseEnv: {}, homeDir: 'C:/home', startProcess: start });

// ---------------------------------------------------------------------------
// 1. The agent-selection keys reach the process request.
// ---------------------------------------------------------------------------

test('regression: model and systemPrompt reach the process request', () => {
  const captured = capturing();
  const created = registryWith(captured.start).create({
    cwd: 'C:/work',
    model: 'claude-fable-5',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'stay terse' },
  });

  assert.equal(created.ok, true);
  const request = captured.requests[0];
  assert.equal(request?.model, 'claude-fable-5');
  assert.deepEqual(request?.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'stay terse' });
});

test('unset stays null rather than becoming this package’s own choice of model', () => {
  // A default here would make the package's preference look like the CLI's, and the CLI's is the one
  // an operator can see and change.
  const captured = capturing();
  registryWith(captured.start).create({ cwd: 'C:/work' });
  assert.equal(captured.requests[0]?.model, null);
  assert.equal(captured.requests[0]?.systemPrompt, null);
});

// ---------------------------------------------------------------------------
// 2. The MCP receipt on the init message.
// ---------------------------------------------------------------------------

const initMessage = (extra: Record<string, unknown>): SDKMessage =>
  ({
    type: 'system',
    subtype: 'init',
    session_id: 'agent-1',
    uuid: 'uuid-1',
    claude_code_version: '9.9.9',
    cwd: 'C:/work',
    model: 'a-model',
    permissionMode: 'default',
    apiKeySource: 'oauth',
    tools: ['Bash'],
    skills: [],
    plugins: [],
    ...extra,
  }) as unknown as SDKMessage;

test('regression: the agent’s own report carries its MCP servers, by name and connection status', () => {
  const facts = readInitFacts(
    initMessage({
      mcp_servers: [
        { name: 'probe', status: 'connected' },
        { name: 'broken', status: 'failed' },
      ],
    }),
  );

  assert.deepEqual(facts?.mcpServers, [
    { name: 'probe', status: 'connected' },
    { name: 'broken', status: 'failed' },
  ]);
});

test('regression: a status this package does not model is carried verbatim, never mapped to one it does', () => {
  // The agent's vocabulary, not this package's. Translating it here would be a second translation site, and
  // there is exactly one of those in this package by design.
  const facts = readInitFacts(initMessage({ mcp_servers: [{ name: 'probe', status: 'needs-auth' }] }));
  assert.equal(facts?.mcpServers[0]?.status, 'needs-auth');
});

test('regression: an init message with no mcp_servers does not throw; the runtime wins over the types', () => {
  // The SDK declares `mcp_servers` required, so `message.mcp_servers.map(…)` typechecks, and a
  // message without it would throw a TypeError inside `readInitFacts`. The pump's own catch would
  // convert the throw into `process_failed`: the session ends, and the reader's bug is reported as
  // the agent process dying. (`readInitFacts` has one caller, `HostedSession.#pump`, which calls it
  // outside the per-listener guard, and `state/observer.ts` has no catch at all, so no observer
  // wrapper can swallow the throw.)
  const facts = readInitFacts(initMessage({}));
  assert.deepEqual(facts?.mcpServers, [], 'a missing field must read as "none reported", never as a throw');
  assert.equal(facts?.sessionId, 'agent-1', 'and the rest of the receipt must survive it');
});

test('regression: an init message with no plugins does not throw either; the same class, one member over', () => {
  // `plugins` is declared required and read with `.map(…)`, exactly like `mcp_servers`. Every
  // fixture in this file supplies it, which is why this case must remove it explicitly: a default
  // that is always present cannot exercise an absence.
  const facts = readInitFacts(initMessage({ plugins: undefined }));
  assert.deepEqual(facts?.plugins, [], 'a missing field must read as "none reported", never as a throw');
  assert.equal(facts?.sessionId, 'agent-1', 'and the rest of the receipt must survive it');
});

// ---------------------------------------------------------------------------
// 3. The granted workspace reaches the wire. Pinned so it stays true.
// ---------------------------------------------------------------------------

test('regression: the workspace a session actually got rides its first transition, not the one it was asked for', () => {
  // With a provider configured the controller's `cwd` is advisory, and the directory the session
  // really got travels on `where.cwd` of every transition, the first of which is the first frame a
  // controller ever sees. Adding a second field for it would be a second name for one fact, so this
  // pins the existing path instead.
  const sent: SessionPayload[] = [];
  const sink: FrameSink = {
    send: (_sessionId, payload) => {
      sent.push(payload);
      return ok(undefined);
    },
  };

  const captured = capturing();
  const composed = composeSession({
    registry: registryWith(captured.start),
    sessionKey: 'handle-1',
    // What the provider decided, deliberately different from anything a controller would have named.
    cwd: 'C:/provisioned/by-the-host',
    sink,
    decide: async () => ({ behavior: 'deny', message: 'no' }),
  });
  assert.equal(composed.ok, true, composed.ok ? '' : composed.refusal.detail);

  const transitions = sent
    .filter((payload) => payload.kind === 'session_update')
    .map((payload) => readStateTransition((payload as { body: JsonObject }).body))
    .filter((transition) => transition !== null);

  assert.ok(transitions.length > 0, 'no transition reached the wire at all');
  assert.equal(
    transitions[0]?.where.cwd,
    'C:/provisioned/by-the-host',
    'the first frame a controller sees must carry the directory the session ACTUALLY got',
  );
});

// ---------------------------------------------------------------------------
// The crash the wire could otherwise reach.
// ---------------------------------------------------------------------------

test('regression: an inverted deadline pair is a named refusal from the composer, never a thrown crash', () => {
  // `permissionHooks` throws on this pair, correctly, but gate timings ride `session_new`, so a
  // controller can produce one, and a throw escaping the dispatcher's fire-and-forget open is a
  // command that vanishes: the controller gets no answer at all. The throw stays for embedders; the
  // composer converts it.
  const captured = capturing();
  const composed = composeSession({
    registry: registryWith(captured.start),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink: { send: () => ok(undefined) },
    decide: async () => ({ behavior: 'deny', message: 'no' }),
    gate: { decisionTimeoutMs: 60_000, matcherTimeoutSeconds: 60 },
  });

  assert.equal(composed.ok, false);
  assert.equal(composed.ok ? '' : composed.refusal.reason, 'gate-deadlines-inverted');
  assert.equal(captured.requests.length, 0, 'a refused composition must not have started a process');
});
