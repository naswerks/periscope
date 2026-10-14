/**
 * Qwen Code's coverage law, held against the release it is pinned to.
 *
 * - Every message type, system subtype, stream event, content block and control request the pinned
 *   release declares has exactly one row in `QWEN_COVERAGE`, and no row names anything the release does
 *   not declare. The names come from `contracts/qwen-code-names.json`, which
 *   `scripts/derive-qwen-names.mjs` derives from the release's own source; nothing here is typed in from
 *   memory.
 * - The ask rules a session's settings carry name every tool of the release.
 * - The cause events Qwen Code can name a transition with are its wired message and answer rows,
 *   exactly, and every cause the Qwen lane records is one of them: driven through a real machine, none
 *   is refused as unnamed. Every agent event belongs to one runtime's table.
 * - Every control request the adapter sends is one the release routes, and its answer row is wired.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject } from '../control/frames.js';
import { fixedTicker } from '../core/time.js';
import { QWEN_PINNED_VERSION } from '../host/qwen-binary.js';
import { qwenAskRules } from '../host/qwen-home.js';
import { QWEN_NAMES, qwenNamesProblem } from '../host/qwen-names.js';
import type { QwenMessage } from '../host/qwen-wire.js';
import { QWEN_HOST_REQUESTS } from '../host/qwen-wire.js';
import { codexWiredNotifications } from '../state/codex-coverage.js';
import { SessionStateMachine } from '../state/machine.js';
import { AGENT_EVENTS, isCauseEvent } from '../state/model.js';
import type { TransitionCause } from '../state/model.js';
import { SessionObserver } from '../state/observer.js';
import { QWEN_COVERAGE, qwenWiredEvents } from '../state/qwen-coverage.js';
import { piWiredEvents } from '../state/pi-coverage.js';

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
    'message',
    Object.keys(QWEN_COVERAGE.messages),
    [
      ...QWEN_NAMES.messageTypes.filter((type) => type !== 'system'),
      ...QWEN_NAMES.systemSubtypes.map((subtype) => `system/${subtype}`),
    ],
  ],
  ['stream event', Object.keys(QWEN_COVERAGE.streamEvents), [...QWEN_NAMES.streamEvents]],
  ['content block', Object.keys(QWEN_COVERAGE.contentBlocks), [...QWEN_NAMES.contentBlocks]],
  ['control request', Object.keys(QWEN_COVERAGE.controlRequests), [...QWEN_NAMES.cliControlRequests]],
  ['answer', Object.keys(QWEN_COVERAGE.answers), [...QWEN_NAMES.hostControlRequests]],
] as const;

test('control: the comparison can fail both ways, and the release snapshot is not empty', () => {
  assert.deepEqual(difference(['a', 'b'], ['a', 'b']), { missing: [], invented: [] });
  assert.deepEqual(difference(['a'], ['a', 'b']), { missing: ['b'], invented: [] });
  assert.deepEqual(difference(['a', 'z'], ['a']), { missing: [], invented: ['z'] });
  for (const [what, , declared] of sets) assert.ok(declared.length > 0, `the snapshot declares no ${what}`);
});

test("the snapshot is the pinned release's, and reads whole", () => {
  assert.equal(qwenNamesProblem(QWEN_NAMES), null);
  assert.equal(QWEN_NAMES.version, QWEN_PINNED_VERSION);
  assert.equal(QWEN_NAMES.release, `v${QWEN_PINNED_VERSION}`);
});

test('control: an emptied, malformed or doubled list is refused at load, by name', () => {
  assert.match(qwenNamesProblem({ ...QWEN_NAMES, tools: [] }) ?? '', /tools list is empty/);
  assert.match(qwenNamesProblem({ ...QWEN_NAMES, tools: ['Read File'] }) ?? '', /not a name/);
  assert.match(qwenNamesProblem({ ...QWEN_NAMES, tools: ['edit', 'edit'] }) ?? '', /names an entry twice/);
  assert.match(qwenNamesProblem({ ...QWEN_NAMES, version: '' }) ?? '', /no version/);
});

for (const [what, table, declared] of sets) {
  test(`every ${what} of the release has exactly one coverage row, and no row names one it does not declare`, () => {
    const { missing, invented } = difference(table, declared);
    assert.deepEqual(missing, [], `${what}s with no coverage row: ${missing.join(', ')}`);
    assert.deepEqual(invented, [], `rows naming no ${what} of ${QWEN_NAMES.release}: ${invented.join(', ')}`);
  });
}

test('the ask rules a session carries name every tool of the release, and each attached server', () => {
  const rules = qwenAskRules(['nas']);
  const { missing } = difference(rules, QWEN_NAMES.tools);
  assert.deepEqual(missing, [], `tools with no ask rule: ${missing.join(', ')}`);
  assert.ok(rules.includes('mcp__nas'));
  assert.equal(rules.includes('*'), false, "a lone * names no tool in the CLI's rule language");
});

test("Qwen Code's cause events are its wired message and answer rows, exactly, both ways", () => {
  const wired = qwenWiredEvents().map((name) => `qwen-code:${name}`);
  const qwenEvents = AGENT_EVENTS.filter((event) => event.startsWith('qwen-code:'));
  const { missing, invented } = difference([...qwenEvents], wired);
  assert.deepEqual(missing, [], `wired rows with no cause event: ${missing.join(', ')}`);
  assert.deepEqual(invented, [], `cause events naming no wired row: ${invented.join(', ')}`);
  for (const event of qwenEvents) assert.ok(isCauseEvent(event), `${event} is not a declared cause event`);
});

test("every agent event belongs to one runtime's table: Codex's wired notifications, Qwen Code's wired rows or pi's", () => {
  const owned = new Set([
    ...codexWiredNotifications().map((method) => `codex:${method}`),
    ...qwenWiredEvents().map((name) => `qwen-code:${name}`),
    ...piWiredEvents().map((name) => `pi:${name}`),
  ]);
  const orphans = AGENT_EVENTS.filter((event) => !owned.has(event));
  assert.deepEqual(orphans, [], `agent events no runtime's table holds: ${orphans.join(', ')}`);
});

test('every control request the adapter sends is one the release routes, and its answer row is wired', () => {
  for (const subtype of QWEN_HOST_REQUESTS) {
    assert.ok(
      QWEN_NAMES.hostControlRequests.includes(subtype),
      `${subtype} is not routed by ${QWEN_NAMES.release}`,
    );
    assert.equal(QWEN_COVERAGE.answers[subtype].handling, 'wired', `${subtype}'s answer row is declined`);
  }
});

/** One message of every kind the Qwen lane moves the machine on. */
function everyTransition(): QwenMessage[] {
  const message = (body: JsonObject): QwenMessage => ({ kind: 'message', message: body });
  return [
    { kind: 'answer', subtype: 'initialize', request: {}, response: { session_id: 's1' } },
    message({ type: 'system', subtype: 'init', session_id: 's1', tools: [] }),
    message({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'call_1', name: 'run_shell_command', input: {} }] },
    }),
    message({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
    }),
    message({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5 }),
    message({ type: 'system', subtype: 'init', session_id: 's1', tools: [] }),
    message({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      error: { message: 'Operation cancelled.' },
    }),
    message({ type: 'system', subtype: 'init', session_id: 's1', tools: [] }),
    message({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      error: { message: '[API Error: 429]' },
    }),
  ];
}

test('every cause the Qwen lane records is an agent event the vocabulary declares, and none is refused', () => {
  const machine = new SessionStateMachine({
    where: { worktree: null, branch: null, cwd: 'C:/work', unknownReason: 'not a repository' },
    clock: () => '2000-01-01T00:00:00.000Z',
    ticker: fixedTicker(0),
  });
  const observer = new SessionObserver(machine, {
    controlTier: { level: 'intercepted-with-residual', degrades: [] },
  });
  const causes: TransitionCause[] = [];
  const states: string[] = [];
  const rejected: string[] = [];
  machine.onTransition((transition) => {
    causes.push(transition.cause);
    states.push(transition.to);
  });
  machine.onRejected((rejection) => rejected.push(rejection.refusal.detail));
  for (const message of everyTransition()) observer.observeQwenMessage(message);
  assert.deepEqual(rejected, [], `the machine refused causes: ${rejected.join('; ')}`);
  assert.deepEqual(states, [
    'ready',
    'working',
    'working',
    'working',
    'idle',
    'working',
    'interrupted',
    'working',
    'errored',
  ]);
  for (const cause of causes) {
    assert.equal(cause.kind, 'agent-event', `${cause.event} recorded under kind ${cause.kind}`);
    assert.ok((AGENT_EVENTS as readonly string[]).includes(cause.event), `${cause.event} is no agent event`);
  }
});
