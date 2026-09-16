/**
 * The narrowing wrapper around the SDK's query object.
 *
 * `query()` returns something that IS an async generator AND carries `setPermissionMode`,
 * `applyFlagSettings`, `setMcpServers` and `setMcpPermissionModeOverride` — four calls that change
 * permission outcomes mid-session. The handle hands out a wrapper instead, so those are unreachable
 * rather than merely un-annotated. This file pins the two halves of that: the controls are gone, and
 * the wrapper still behaves like the iterator it replaced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { SDKMessage } from './agent-process.js';
import {
  AGENT_PROCESS_REQUEST_KEYS,
  AGENT_SELECTION_OPTION_KEYS,
  CLI_PARITY_OPTION_KEYS,
  PERSISTENCE_OPTION_KEYS,
  SHADOWING_LANES,
  STREAMING_OPTION_KEYS,
  TOOL_SURFACE_OPTION_KEYS,
  messagesOf,
} from './agent-process.js';

const message = (id: string): SDKMessage => ({ type: 'user', session_id: id }) as unknown as SDKMessage;

/** Stands in for the SDK's query object: an async generator carrying the control methods too. */
function fakeQuery(
  count: number,
): AsyncGenerator<SDKMessage, void> & { returned: boolean; setPermissionMode: () => void } {
  let index = 0;
  const generator = {
    returned: false,
    setPermissionMode: () => undefined,
    setMcpServers: () => undefined,
    applyFlagSettings: () => undefined,
    setMcpPermissionModeOverride: () => undefined,
    async next(): Promise<IteratorResult<SDKMessage, void>> {
      if (index >= count) return { done: true, value: undefined };
      index += 1;
      return { done: false, value: message(`m${index}`) };
    },
    async return(): Promise<IteratorResult<SDKMessage, void>> {
      generator.returned = true;
      return { done: true, value: undefined };
    },
    async throw(error: unknown): Promise<IteratorResult<SDKMessage, void>> {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return generator;
    },
  };
  return generator;
}

test('the wrapper carries the messages through in order', async () => {
  const seen: string[] = [];
  for await (const item of messagesOf(fakeQuery(3))) seen.push(String(item.session_id));
  assert.deepEqual(seen, ['m1', 'm2', 'm3']);
});

// `for await…of` calls `iterator.return()` when the loop leaves early, and that call is what
// releases the underlying subprocess. A wrapper implementing only `next` would swallow it, leaking
// a session per abandoned loop, with no error, no log and nothing null.
test('regression: leaving the loop early still closes the underlying query', async () => {
  const source = fakeQuery(10);
  for await (const _item of messagesOf(source)) break;
  assert.equal(
    source.returned,
    true,
    'an early break did not reach the query — every abandoned loop leaks a session',
  );
});

test('a throw inside the loop body also closes the underlying query', async () => {
  const source = fakeQuery(10);
  await assert.rejects(async () => {
    for await (const _item of messagesOf(source)) throw new Error('the consumer failed');
  });
  assert.equal(source.returned, true);
});

test('throw() is delegated rather than dropped', async () => {
  const wrapped = messagesOf(fakeQuery(3));
  await assert.rejects(() => wrapped.throw(new Error('injected')), /injected/);
});

// The point of the wrapper: four mid-session calls change permission outcomes after any
// construction-time check has run; hiding them behind an annotation leaves them one cast away.
test("regression: the four permission mutators are not reachable through the handle's message stream", () => {
  const source = fakeQuery(1);
  assert.equal(
    typeof source.setPermissionMode,
    'function',
    'the stand-in must carry them, or this proves nothing',
  );

  const wrapped = messagesOf(source) as unknown as Record<string, unknown>;
  for (const control of [
    'setPermissionMode',
    'setMcpServers',
    'applyFlagSettings',
    'setMcpPermissionModeOverride',
    'interrupt',
    'reinitialize',
  ]) {
    assert.equal(
      wrapped[control],
      undefined,
      `${control} is reachable through messages — the narrowing is theatre`,
    );
  }
});

// The `Options` lanes that alter a permission outcome are imported rather than restated: a
// duplicated list is how two copies come to disagree.

// The closed set as a compile-time fact: `AGENT_PROCESS_REQUEST_KEYS` is declared
// `satisfies Record<keyof AgentProcessRequest, true>`, so adding a composable option breaks the
// build. This runtime half exists so the list is also readable as evidence, and so a reader can
// see what the closed set actually is.
//
// The assertion is an exact deepEqual over the whole set: never a subset, never a "contains", never
// a count. Each widening is declared as data (`STREAMING_OPTION_KEYS`, `TOOL_SURFACE_OPTION_KEYS`,
// `PERSISTENCE_OPTION_KEYS`, `AGENT_SELECTION_OPTION_KEYS`, `CLI_PARITY_OPTION_KEYS`) and checked
// against the shadowing names below, so a new key cannot be waved in by editing this array.
//
// The widenings have different reasons and are deliberately not one list. The streaming three
// select what the process emits. The tool-surface two change which tools exist, which is a larger
// claim and safe for a structural reason instead. The persistence two decide where the transcript
// goes: the egress lane, safe because a store is an object with methods and so cannot cross a JSON
// wire at all. The selection two choose which agent runs and what it is told. Collapsing any of
// them would file a false reason next to a true one, and the reason is the only part of a widening
// that can be checked.
//
// `model` and `systemPrompt` were absent, not narrowed. They were never composable, so opening
// them fills a gap rather than re-opening a lane somebody closed. The eight lanes in
// `SHADOWING_LANES` were each considered and closed, and they stay closed, asserted by name.
test('regression: the composable option set is exactly twenty keys; permissionMode is among them deliberately, and nothing else that answers a permission is', () => {
  assert.deepEqual(Object.keys(AGENT_PROCESS_REQUEST_KEYS).sort(), [
    'cwd',
    'effort',
    'env',
    'fork',
    'forwardSubagentText',
    'hooks',
    'includePartialMessages',
    'mcpServers',
    'model',
    'onStderr',
    'permissionMode',
    'plugins',
    'resume',
    'sessionStore',
    'sessionStoreFlush',
    'settingSources',
    'spawn',
    'strictMcpConfig',
    'systemPrompt',
    'thinking',
  ]);

  for (const shadowing of SHADOWING_LANES) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(AGENT_PROCESS_REQUEST_KEYS, shadowing),
      false,
      `${shadowing} became composable — it can shadow the gate, and several act AFTER construction`,
    );
  }
});

// The CLI-parity list is the one that re-opens a closed lane on purpose. `effort` fills a gap;
// `permissionMode` leaves the shadowing list by name. The gate's authority is the `PreToolUse`
// hook, which fires under every mode, so the eight lanes that remain closed are the rule files and
// pre-answers, never a posture the operator chooses in the open.
test('regression: the CLI-parity keys are composable; permissionMode left the shadowing list deliberately and effort was never on it', () => {
  assert.deepEqual([...CLI_PARITY_OPTION_KEYS], ['effort', 'permissionMode']);
  for (const key of CLI_PARITY_OPTION_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(AGENT_PROCESS_REQUEST_KEYS, key),
      true,
      `${key} is declared a CLI-parity key but is not composable — the list describes nothing`,
    );
    assert.equal(
      SHADOWING_LANES.includes(key),
      false,
      `${key} is composable AND still listed as shadowing — one of the two lists lies`,
    );
  }
  assert.deepEqual(
    [...SHADOWING_LANES],
    [
      'settings',
      'managedSettings',
      'toolAliases',
      'permissionPromptToolName',
      'allowedTools',
      'disallowedTools',
      'canUseTool',
      'permissions',
    ],
    'the eight lanes that stay closed, by name; a ninth leaving would be a second decision',
  );
});

// Why the boundary moved, as a check rather than a comment. A reader who sees the key list was
// edited has to be able to tell in seconds whether it was widened for something harmless or
// weakened. `STREAMING_OPTION_KEYS` is that answer stated as data, and this asserts the data is
// true: every key on it is genuinely composable, and none of them is a closed lane. A future option
// can only join by being added to the request type and surviving this.
test('regression: every streaming key is composable, and none is a permission lane', () => {
  assert.deepEqual([...STREAMING_OPTION_KEYS], ['includePartialMessages', 'thinking', 'forwardSubagentText']);

  for (const key of STREAMING_OPTION_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(AGENT_PROCESS_REQUEST_KEYS, key),
      true,
      `${key} is declared a streaming lane but is not composable — the list describes nothing`,
    );
    assert.equal(
      SHADOWING_LANES.includes(key),
      false,
      `${key} is declared a streaming lane and IS a permission lane — the widening was a weakening`,
    );
  }
});

// The tool-surface widening is a different claim. `mcpServers` introduces tools, and `PreToolUse`
// fires for MCP tools and inside subagents, so this genuinely enlarges the surface the gate must
// cover. It is safe because `permissionHooks` registers `PreToolUse` with no matcher, so a tool
// nobody predicted reaches the same handler as `Bash`. This asserts the data is true; the
// structural claim underneath it is asserted separately in gate/gate.test.ts, because a list
// cannot check a matcher.
test('regression: the tool-surface keys are composable, and neither is a closed permission lane', () => {
  assert.deepEqual([...TOOL_SURFACE_OPTION_KEYS], ['mcpServers', 'strictMcpConfig']);

  for (const key of TOOL_SURFACE_OPTION_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(AGENT_PROCESS_REQUEST_KEYS, key),
      true,
      `${key} is declared a tool-surface key but is not composable — the list describes nothing`,
    );
    assert.equal(
      SHADOWING_LANES.includes(key),
      false,
      `${key} is declared a tool-surface key and IS a permission lane — the widening was a weakening`,
    );
  }
});

// The persistence widening is the egress lane. A store receives every message the agent saw, so
// "it only selects what is emitted" is false of it and "the gate has no matcher" says nothing about
// where bytes end up. What makes it safe is that `SessionStore` is an object with methods: it has
// no JSON form, cannot ride a frame, and can only be supplied by the code composing this host. This
// asserts the data is true; the structural claim is asserted separately in
// pins/persistence-egress.test.ts, because a list cannot check what survives a wire.
test('regression: the persistence keys are composable, and neither is a closed permission lane', () => {
  assert.deepEqual([...PERSISTENCE_OPTION_KEYS], ['sessionStore', 'sessionStoreFlush']);

  for (const key of PERSISTENCE_OPTION_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(AGENT_PROCESS_REQUEST_KEYS, key),
      true,
      `${key} is declared a persistence key but is not composable — the list describes nothing`,
    );
    assert.equal(
      SHADOWING_LANES.includes(key),
      false,
      `${key} is declared a persistence key and IS a permission lane — the widening was a weakening`,
    );
  }
});

// The one documented incompatibility is unreachable by construction, and that is a pinnable fact
// rather than a promise. A store may not be combined with session persistence turned off, because
// the mirror fires only after the local write succeeds. `persistSession` is not composable here, so
// the SDK's own default stands and the combination cannot be built through this type at all.
test('regression: persistSession is not composable, so a store can never be paired with local writes off', () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(AGENT_PROCESS_REQUEST_KEYS, 'persistSession'),
    false,
    'persistSession became composable — the store contract forbids that pairing and nothing else stops it',
  );
});

// The agent-selection widening's reason is one the other lists cannot make. `model` and
// `systemPrompt` do not select what is emitted, do not change which tools exist, and do not decide
// where a transcript goes: they choose which agent runs and what it is told at the start. Filing
// them under any existing list would put a false sentence inside a constant whose whole job is to
// make the reason checkable. This asserts the data is true; that neither appears in a permission
// evaluation path is asserted by the shadowing check below, because a list cannot check a code path.
test('regression: the agent-selection keys are composable, and neither is a closed permission lane', () => {
  assert.deepEqual([...AGENT_SELECTION_OPTION_KEYS], ['model', 'systemPrompt']);

  for (const key of AGENT_SELECTION_OPTION_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(AGENT_PROCESS_REQUEST_KEYS, key),
      true,
      `${key} is declared an agent-selection key but is not composable — the list describes nothing`,
    );
    assert.equal(
      SHADOWING_LANES.includes(key),
      false,
      `${key} is declared an agent-selection key and IS a permission lane — the widening was a weakening`,
    );
  }
});

// The lists must stay pairwise disjoint, or the distinction they exist to carry is decorative: a
// key on two would be documented by two different reasons, one of which is necessarily wrong.
test('regression: the widenings share no key, and together they are the whole growth', () => {
  const streaming = new Set<string>(STREAMING_OPTION_KEYS);
  const surface = new Set<string>(TOOL_SURFACE_OPTION_KEYS);
  const persistence = new Set<string>(PERSISTENCE_OPTION_KEYS);
  const selection = new Set<string>(AGENT_SELECTION_OPTION_KEYS);
  const parity = new Set<string>(CLI_PARITY_OPTION_KEYS);

  for (const [leftName, left, rightName, right] of [
    ['tool-surface', surface, 'streaming', streaming],
    ['persistence', persistence, 'streaming', streaming],
    ['persistence', persistence, 'tool-surface', surface],
    ['selection', selection, 'streaming', streaming],
    ['selection', selection, 'tool-surface', surface],
    ['selection', selection, 'persistence', persistence],
    ['cli-parity', parity, 'streaming', streaming],
    ['cli-parity', parity, 'tool-surface', surface],
    ['cli-parity', parity, 'persistence', persistence],
    ['cli-parity', parity, 'selection', selection],
  ] as const) {
    for (const key of left) {
      assert.equal(
        right.has(key),
        false,
        `${key} is filed under ${leftName} AND ${rightName}, so one is false`,
      );
    }
  }

  // The original nine keys, plus the declared widenings, is exactly the composable set. A key that
  // joined without landing on one of the lists shows up here as an unexplained addition.
  const declared = new Set([
    ...ORIGINAL_NINE,
    ...streaming,
    ...surface,
    ...persistence,
    ...selection,
    ...parity,
  ]);
  assert.deepEqual(
    Object.keys(AGENT_PROCESS_REQUEST_KEYS).sort(),
    [...declared].sort(),
    'a composable key belongs to no declared widening — it grew the set with no stated reason',
  );
});

/** The set before any widening: what a caller could compose when the boundary was first drawn. */
const ORIGINAL_NINE = [
  'cwd',
  'env',
  'settingSources',
  'plugins',
  'hooks',
  'resume',
  'fork',
  'onStderr',
  'spawn',
];
