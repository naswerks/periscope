/**
 * What the registry composes for the two tool-surface keys — including the default that is the
 * whole point of `strictMcpConfig`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry } from './registry.js';
import type { AgentProcess, AgentProcessRequest } from '../host/agent-process.js';

/** Records the composed request without starting anything. */
function capture(): { requests: AgentProcessRequest[]; registry: SessionRegistry } {
  const requests: AgentProcessRequest[] = [];
  const registry = new SessionRegistry({
    baseEnv: {},
    homeDir: '/home/user',
    startProcess: (request): AgentProcess => {
      requests.push(request);
      return {
        messages: (async function* () {})(),
        prompt: () => true,
        interrupt: async () => undefined,
        setModel: () => Promise.resolve(),
        setPermissionMode: () => Promise.resolve(),
        setThinking: () => Promise.resolve(),
        close: () => undefined,
      };
    },
  });
  return { requests, registry };
}

// The default is the important part. Without it, a workspace the host provisioned can declare its
// own MCP servers through a project `.mcp.json`, so a directory's contents decide what tools exist.
test('regression: strictMcpConfig defaults to true, so a provisioned workspace cannot register its own servers', () => {
  const { requests, registry } = capture();
  registry.create({ cwd: '/work/s1' });

  assert.equal(requests[0]?.strictMcpConfig, true);
});

test('a caller can turn strict off deliberately, and the value is carried unchanged', () => {
  const { requests, registry } = capture();
  registry.create({ cwd: '/work/s1', strictMcpConfig: false });

  assert.equal(
    requests[0]?.strictMcpConfig,
    false,
    'the opt-out was ignored — a stated choice was overridden',
  );
});

test('no mcpServers means null, never an empty object that reads as "declared none"', () => {
  const { requests, registry } = capture();
  registry.create({ cwd: '/work/s1' });

  assert.equal(requests[0]?.mcpServers, null);
});

test('servers a caller supplies are carried through to the composed request', () => {
  const { requests, registry } = capture();
  const server = { type: 'sdk' as const, name: 'controller', instance: {} as never };
  registry.create({ cwd: '/work/s1', mcpServers: { controller: server } });

  assert.deepEqual(Object.keys(requests[0]?.mcpServers ?? {}), ['controller']);
});

test('the two keys are independent — servers can be supplied with strict off', () => {
  const { requests, registry } = capture();
  const server = { type: 'sdk' as const, name: 'controller', instance: {} as never };
  registry.create({ cwd: '/work/s1', mcpServers: { controller: server }, strictMcpConfig: false });

  assert.equal(requests[0]?.strictMcpConfig, false);
  assert.deepEqual(Object.keys(requests[0]?.mcpServers ?? {}), ['controller']);
});

// Where the copy is, stated because it is not here. The registry carries the caller's map by
// reference, exactly as it does `settingSources` and `plugins`; `startAgentProcess` spreads all
// three when it builds the SDK's `Options`. That happens synchronously inside `create()`, so a
// caller mutating its own object after `create()` returns cannot reach the running session — but the
// intermediate request does alias it, and an embedder-supplied `startProcess` that retains the
// request sees later mutations. Asserted as the behaviour that exists rather than the one that reads
// better, and consistent across all three keys rather than special for this one.
test("the caller's server map is carried through faithfully, by the same route as plugins", () => {
  const { requests, registry } = capture();
  const servers: Record<string, { type: 'sdk'; name: string; instance: never }> = {
    controller: { type: 'sdk', name: 'controller', instance: {} as never },
  };
  const plugins = [{ type: 'local' as const, path: '/plugins/one' }];
  registry.create({ cwd: '/work/s1', mcpServers: servers, plugins });

  assert.deepEqual(requests[0]?.mcpServers, servers);
  assert.deepEqual(requests[0]?.plugins, plugins);

  // The aliasing is identical for both, which is the consistency worth pinning: a defensive copy
  // added for one of them and not the others would imply the others were unsafe.
  servers['later'] = { type: 'sdk', name: 'later', instance: {} as never };
  plugins.push({ type: 'local' as const, path: '/plugins/two' });
  assert.equal(Object.keys(requests[0]?.mcpServers ?? {}).length, 2);
  assert.equal(requests[0]?.plugins?.length, 2);
});
