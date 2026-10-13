/**
 * Codex's coverage law, held against the release it is pinned to.
 *
 * - Every notification, server request and item kind the pinned release declares has exactly one row
 *   in `CODEX_COVERAGE`, and no row names anything the release does not declare. The names come from
 *   `contracts/codex-protocol-names.json`, which `scripts/derive-codex-names.mjs` derives from the
 *   release's own exports; nothing here is typed in from memory.
 * - Every experimental name is declined: this host never opts into experimental API.
 * - The cause events Codex can name a transition with are the wired notifications, exactly, and every
 *   cause the Codex lane records is one of them: driven through a real machine, none is refused as
 *   unnamed.
 * - Every client method the adapter calls is stable at the release.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject } from '../control/frames.js';
import { CODEX_NAMES, codexNamesProblem, codexWireKey } from '../host/codex-names.js';
import type { CodexMessage } from '../host/codex-wire.js';
import { CODEX_CLIENT_METHODS } from '../host/codex-wire.js';
import { fixedTicker } from '../core/time.js';
import { CODEX_COVERAGE, codexWiredNotifications } from '../state/codex-coverage.js';
import { SessionStateMachine } from '../state/machine.js';
import { AGENT_EVENTS, isCauseEvent } from '../state/model.js';
import type { TransitionCause } from '../state/model.js';
import { SessionObserver } from '../state/observer.js';

/** The names one side has and the other lacks, both ways. */
function difference(
  table: readonly string[],
  declared: readonly string[],
): { missing: string[]; invented: string[] } {
  const rows = new Set(table);
  const names = new Set(declared);
  return {
    missing: declared.filter((name) => !rows.has(name)),
    invented: table.filter((name) => !names.has(name)),
  };
}

const sets = [
  [
    'notification',
    Object.keys(CODEX_COVERAGE.notifications),
    CODEX_NAMES.notifications.map((entry) => entry.method),
  ],
  [
    'server request',
    Object.keys(CODEX_COVERAGE.serverRequests),
    CODEX_NAMES.serverRequests.map((entry) => entry.method),
  ],
  ['item kind', Object.keys(CODEX_COVERAGE.itemKinds), [...CODEX_NAMES.itemKinds]],
] as const;

test('control: the comparison can fail both ways, and the release snapshot is not empty', () => {
  assert.deepEqual(difference(['a', 'b'], ['a', 'b']), { missing: [], invented: [] });
  assert.deepEqual(difference(['a'], ['a', 'b']), { missing: ['b'], invented: [] });
  assert.deepEqual(difference(['a', 'z'], ['a']), { missing: [], invented: ['z'] });
  for (const [what, , declared] of sets) {
    assert.ok(
      declared.length > 0,
      `the snapshot declares no ${what}: a comparison with nothing passes for nothing`,
    );
  }
  assert.ok(CODEX_NAMES.clientMethods.length > 0, 'the snapshot declares no client method');
});

for (const [what, table, declared] of sets) {
  test(`every ${what} the pinned release declares has one coverage row, and no row names one it does not`, () => {
    const { missing, invented } = difference(table, declared);
    assert.deepEqual(
      missing,
      [],
      `${CODEX_NAMES.release} declares ${what}s with no row: ${missing.join(', ')}`,
    );
    assert.deepEqual(
      invented,
      [],
      `rows for ${what}s ${CODEX_NAMES.release} does not declare: ${invented.join(', ')}`,
    );
    assert.equal(table.length, new Set(table).size, `a ${what} has two rows`);
  });
}

test('every experimental notification and server request is declined: this host never opts in', () => {
  for (const entry of CODEX_NAMES.notifications.filter((name) => name.experimental)) {
    const row = (CODEX_COVERAGE.notifications as Readonly<Record<string, { handling: string }>>)[
      entry.method
    ];
    assert.equal(row?.handling, 'declined', `${entry.method} is experimental and not declined`);
  }
  for (const entry of CODEX_NAMES.serverRequests.filter((name) => name.experimental)) {
    const row = (CODEX_COVERAGE.serverRequests as Readonly<Record<string, { handling: string }>>)[
      entry.method
    ];
    assert.equal(row?.handling, 'declined', `${entry.method} is experimental and not declined`);
  }
});

test('every row says why, in more than a word', () => {
  for (const [table, rows] of Object.entries(CODEX_COVERAGE)) {
    for (const [name, row] of Object.entries(rows as Readonly<Record<string, { note: string }>>)) {
      assert.ok(
        row.note.length >= 20,
        `${table} ${name}: a note of ${row.note.length} characters says nothing`,
      );
    }
  }
});

test('every client method the adapter calls is stable at the pinned release', () => {
  const stable = new Set(
    CODEX_NAMES.clientMethods.filter((entry) => !entry.experimental).map((entry) => entry.method),
  );
  const all = new Set(CODEX_NAMES.clientMethods.map((entry) => entry.method));
  for (const method of CODEX_CLIENT_METHODS) {
    assert.ok(all.has(method), `${method} is not a client method of ${CODEX_NAMES.release}`);
    assert.ok(stable.has(method), `${method} is experimental at ${CODEX_NAMES.release}`);
  }
});

test("Codex's cause events are its wired notifications, exactly, both ways", () => {
  const wired = codexWiredNotifications().map((method) => `codex:${method}`);
  const { missing, invented } = difference([...AGENT_EVENTS], wired);
  assert.deepEqual(missing, [], `wired notifications with no cause event: ${missing.join(', ')}`);
  assert.deepEqual(invented, [], `cause events naming no wired notification: ${invented.join(', ')}`);
  for (const event of AGENT_EVENTS) assert.ok(isCauseEvent(event), `${event} is not a declared cause event`);
});

// ---------------------------------------------------------------------------
// The Codex lane, driven through a real machine
// ---------------------------------------------------------------------------

const THREAD = 'thread-1';
const notification = (method: string, params: JsonObject): CodexMessage => ({
  kind: 'notification',
  method,
  params,
});
const item = (type: string, extra: JsonObject = {}): JsonObject => ({ type, id: `item-${type}`, ...extra });
const ITEM_FIELDS: Readonly<Record<string, JsonObject>> = {
  mcpToolCall: { server: 'docs', tool: 'search' },
  collabAgentToolCall: { tool: 'spawnAgent', receiverThreadIds: ['thread-2'] },
};

/** A session's worth of Codex messages that reaches every transition the lane can record. */
function everyTransition(): CodexMessage[] {
  const turn = (status: string, error: JsonObject | null = null): JsonObject => ({
    id: 'turn-1',
    status,
    error,
  });
  const items = CODEX_NAMES.itemKinds.flatMap((kind) => {
    const body = item(kind, ITEM_FIELDS[kind] ?? {});
    return [
      notification('item/started', { item: body, threadId: THREAD, turnId: 'turn-1' }),
      notification('item/completed', {
        item: { ...body, status: 'completed' },
        threadId: THREAD,
        turnId: 'turn-1',
      }),
    ];
  });
  return [
    { kind: 'answer', method: 'thread/start', params: {}, result: { thread: { id: THREAD }, model: 'm' } },
    notification('thread/started', { thread: { id: THREAD, cliVersion: '0.162.1' } }),
    notification('turn/started', { threadId: THREAD, turn: turn('inProgress') }),
    ...items,
    notification('item/started', { item: item('commandExecution'), threadId: THREAD, turnId: 'turn-1' }),
    notification('thread/status/changed', {
      threadId: THREAD,
      status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] },
    }),
    notification('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } }),
    notification('turn/completed', { threadId: THREAD, turn: turn('completed') }),
    notification('turn/completed', { threadId: THREAD, turn: turn('interrupted') }),
    notification('turn/completed', {
      threadId: THREAD,
      turn: turn('failed', { message: 'boom', codexErrorInfo: 'unauthorized', additionalDetails: null }),
    }),
    notification('error', {
      threadId: THREAD,
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'down' },
    }),
    notification('thread/status/changed', { threadId: THREAD, status: { type: 'systemError' } }),
    ...codexWiredNotifications().map((method) => notification(method, { threadId: THREAD })),
    notification('thread/closed', { threadId: THREAD }),
  ];
}

function observed(messages: readonly CodexMessage[]): { causes: TransitionCause[]; rejected: string[] } {
  const machine = new SessionStateMachine({
    where: { worktree: null, branch: null, cwd: 'C:/work', unknownReason: 'not a repository' },
    clock: () => '2000-01-01T00:00:00.000Z',
    ticker: fixedTicker(0),
  });
  const observer = new SessionObserver(machine, { controlTier: { level: 'none', degrades: [] } });
  const causes: TransitionCause[] = [];
  const rejected: string[] = [];
  machine.onTransition((transition) => causes.push(transition.cause));
  machine.onRejected((rejection) => rejected.push(rejection.refusal.detail));
  for (const message of messages) observer.observeCodexMessage(message);
  return { causes, rejected };
}

test('every cause the Codex lane records is an agent event the vocabulary declares, and none is refused', () => {
  const { causes, rejected } = observed(everyTransition());
  assert.deepEqual(rejected, [], `the machine refused causes: ${rejected.join('; ')}`);
  const events = new Set(causes.map((cause) => cause.event));
  for (const expected of [
    'codex:thread/started',
    'codex:turn/started',
    'codex:turn/completed',
    'codex:item/started',
    'codex:item/completed',
    'codex:thread/status/changed',
    'codex:error',
    'codex:thread/closed',
  ]) {
    assert.ok(events.has(expected as TransitionCause['event']), `the lane never recorded ${expected}`);
  }
  for (const cause of causes) {
    assert.equal(cause.kind, 'agent-event', `${cause.event} recorded under kind ${cause.kind}`);
    assert.ok((AGENT_EVENTS as readonly string[]).includes(cause.event), `${cause.event} is no agent event`);
  }
});

// ---------------------------------------------------------------------------
// The key table
// ---------------------------------------------------------------------------

test('the key table maps exactly one non-empty wire key of an agent message to stage', () => {
  assert.equal(codexNamesProblem(CODEX_NAMES), null);
  const key = codexWireKey('agentMessage', 'stage');
  assert.ok(key.length > 0, 'the stage key is empty');
  assert.notEqual(key, 'stage', 'the wire key is the member name itself, so the table maps nothing');
});

test('control: a blanked, emptied or doubled key table is refused at load, by name', () => {
  const blanked = { ...CODEX_NAMES, wireKeys: {} };
  assert.match(codexNamesProblem(blanked) ?? '', /no agentMessage row/);
  const emptied = { ...CODEX_NAMES, wireKeys: { agentMessage: {} } };
  assert.match(codexNamesProblem(emptied) ?? '', /maps 0 wire keys of agentMessage to stage/);
  const doubled = { ...CODEX_NAMES, wireKeys: { agentMessage: { a: 'stage', b: 'stage' } } };
  assert.match(codexNamesProblem(doubled) ?? '', /maps 2 wire keys of agentMessage to stage/);
  assert.match(codexNamesProblem({ ...CODEX_NAMES, notifications: [] }) ?? '', /notifications list is empty/);
});
