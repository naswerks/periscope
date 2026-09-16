/**
 * Registration: descriptors in, an in-process server out — and what a call carries when it lands.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { planTools } from './server.js';
import type { McpServerOptions, ToolCall, ToolResponse } from './server.js';
import type { ToolDescriptor } from './descriptor.js';
import { createToolServer } from '../host/mcp-server.js';

const echo: ToolDescriptor = {
  name: 'echo',
  description: 'Returns the note it was given.',
  inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
};

function options(overrides: Partial<McpServerOptions> = {}): McpServerOptions {
  return {
    name: 'controller',
    descriptors: [echo],
    invoke: async () => ({ text: 'ok' }),
    identity: () => ({ sessionId: 's1' }),
    ...overrides,
  };
}

/** Call a built tool the way the SDK does, and hand back what the invoker saw. */
async function callTool(
  built: McpServerOptions,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ seen: ToolCall[]; result: unknown }> {
  const seen: ToolCall[] = [];
  const tools = planTools({
    ...built,
    invoke: async (call): Promise<ToolResponse> => {
      seen.push(call);
      return built.invoke(call);
    },
  });
  assert.equal(tools.ok, true, tools.ok ? '' : tools.refusal.detail);
  if (!tools.ok) return { seen, result: null };

  const plan = tools.value.find((candidate) => candidate.name === toolName);
  assert.ok(plan !== undefined, `no tool named ${toolName} was planned`);
  const result = await plan.handler(args);
  return { seen, result };
}

test('a descriptor becomes a tool carrying its own name and description', () => {
  const tools = planTools(options());

  assert.equal(tools.ok, true);
  assert.equal(tools.ok && tools.value.length, 1);
  assert.equal(tools.ok && tools.value[0]?.name, 'echo');
  assert.equal(tools.ok && tools.value[0]?.description, 'Returns the note it was given.');
});

test('an in-process server is created, carrying a live instance rather than a command line', () => {
  const server = createToolServer(options());

  assert.equal(server.ok, true);
  if (!server.ok) return;
  assert.equal(server.value.type, 'sdk');
  assert.equal(server.value.name, 'controller');
  // The whole win: an object in this process, not a child to spawn and wait to attach to.
  assert.notEqual(server.value.instance, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(server.value, 'command'), false);
});

test('a validated call reaches the invoker with its arguments and the server and tool names', async () => {
  const { seen } = await callTool(options(), 'echo', { note: 'hello' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.serverName, 'controller');
  assert.equal(seen[0]?.toolName, 'echo');
  assert.deepEqual(seen[0]?.arguments, { note: 'hello' });
});

test("the invoker's answer becomes the tool result the model sees", async () => {
  const { result } = await callTool(options({ invoke: async () => ({ text: 'the answer' }) }), 'echo', {
    note: 'x',
  });

  assert.deepEqual(result, { content: [{ type: 'text', text: 'the answer' }] });
});

test('an error answer is marked as one rather than returned as ordinary text', async () => {
  const { result } = await callTool(
    options({ invoke: async () => ({ text: 'that failed', isError: true }) }),
    'echo',
    { note: 'x' },
  );

  assert.deepEqual(result, { content: [{ type: 'text', text: 'that failed' }], isError: true });
});

// Read at call time. An agent reports no session id until its first turn is queued, so a server
// composed at start would capture null forever if identity were a value instead of a function.
test('regression: session identity is read when the call happens, not at composition', async () => {
  let current: string | null = null;
  const { seen } = await callTool(options({ identity: () => ({ sessionId: current }) }), 'echo', {
    note: 'a',
  });
  assert.equal(seen[0]?.identity.sessionId, null, 'the pre-init case must be reachable');

  current = 'session-abc';
  const later = await callTool(options({ identity: () => ({ sessionId: current }) }), 'echo', { note: 'b' });
  assert.equal(
    later.seen[0]?.identity.sessionId,
    'session-abc',
    'the identity was captured at composition time, so it can never carry a real session id',
  );
});

test('several descriptors all register, in the order they were given', () => {
  const tools = planTools(
    options({
      descriptors: [
        echo,
        { name: 'ping', description: 'Answers pong.', inputSchema: { type: 'object' } },
        {
          name: 'count',
          description: 'Counts.',
          inputSchema: { type: 'object', properties: { n: { type: 'integer' } } },
        },
      ],
    }),
  );

  assert.deepEqual(tools.ok ? tools.value.map((entry) => entry.name) : null, ['echo', 'ping', 'count']);
});

// ---------------------------------------------------------------------------
// Refusals — every one happens at registration, before a session exists.
// ---------------------------------------------------------------------------

test('a tool whose schema cannot be converted refuses the whole registration', () => {
  const tools = planTools(
    options({
      descriptors: [
        echo,
        {
          name: 'bad',
          description: 'Has a bad schema.',
          inputSchema: { type: 'object', properties: { x: { type: 'mystery' } } },
        },
      ],
    }),
  );

  assert.equal(tools.ok, false, 'a server registered with one tool validating nothing');
  assert.equal(!tools.ok && tools.refusal.reason, 'mcp-schema-unsupported');
  assert.match(!tools.ok ? tools.refusal.detail : '', /bad\.inputSchema/);
});

test('a duplicate tool name is refused rather than letting the second shadow the first', () => {
  const tools = planTools(options({ descriptors: [echo, { ...echo, description: 'A different tool.' }] }));

  assert.equal(tools.ok, false);
  assert.equal(!tools.ok && tools.refusal.reason, 'mcp-descriptor-invalid');
  assert.match(!tools.ok ? tools.refusal.detail : '', /twice/);
});

test('a tool with no description is refused — the model would never call it', () => {
  const tools = planTools(options({ descriptors: [{ ...echo, description: '   ' }] }));

  assert.equal(tools.ok, false);
  assert.equal(!tools.ok && tools.refusal.reason, 'mcp-descriptor-invalid');
});

test('a tool name that would break the mcp__server__tool address is refused', () => {
  for (const name of ['has space', 'has__separator', 'has.dot', '', 'has/slash']) {
    const tools = planTools(options({ descriptors: [{ ...echo, name }] }));
    assert.equal(tools.ok, false, `"${name}" was accepted as a tool name`);
    assert.equal(!tools.ok && tools.refusal.reason, 'mcp-descriptor-invalid');
  }
});

test('an unusable server name is refused before any tool is built', () => {
  const server = createToolServer(options({ name: 'not a name' }));

  assert.equal(server.ok, false);
  assert.equal(!server.ok && server.refusal.reason, 'mcp-descriptor-invalid');
});

test('a server with no tools is legal — a controller may register them later', () => {
  const server = createToolServer(options({ descriptors: [] }));
  assert.equal(server.ok, true);
});
