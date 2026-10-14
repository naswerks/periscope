/**
 * pi's coverage law, held against the release it is pinned to.
 *
 * - Every event, RPC record, RPC command, extension UI method and message delta the pinned release
 *   declares has exactly one row in `PI_COVERAGE`, and no row names anything the release does not
 *   declare. The names come from `contracts/pi-names.json`, which `scripts/derive-pi-names.mjs` derives
 *   from the release's own source; nothing here is typed in from memory.
 * - Every built-in tool of the release has one kind and one local family, and a shell tool its dialect.
 * - The cause events pi can name a transition with are its wired event and command rows, exactly, and
 *   every cause the pi lane records is one of them: driven through a real machine, none is refused as
 *   unnamed. Every agent event belongs to one runtime's table.
 * - Every command the adapter sends is one the release reads, and its row is wired; every dialog the
 *   envelope cancels is a method the release declares.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject } from '../control/frames.js';
import { fixedTicker } from '../core/time.js';
import { PI_TOOL_FAMILIES } from '../gate/local.js';
import { PI_SHELL_DIALECTS, PI_TOOL_KINDS } from '../gate/tool-kind.js';
import { PI_PINNED_VERSION } from '../host/pi-binary.js';
import { PI_NAMES, piEventNames, piNamesProblem } from '../host/pi-names.js';
import type { PiMessage } from '../host/pi-wire.js';
import { PI_DIALOG_METHODS, PI_HOST_COMMANDS } from '../host/pi-wire.js';
import { codexWiredNotifications } from '../state/codex-coverage.js';
import { SessionStateMachine } from '../state/machine.js';
import { AGENT_EVENTS, isCauseEvent } from '../state/model.js';
import type { TransitionCause } from '../state/model.js';
import { SessionObserver } from '../state/observer.js';
import { PI_COVERAGE, piWiredEvents } from '../state/pi-coverage.js';
import { qwenWiredEvents } from '../state/qwen-coverage.js';

/** What `table` names that `declared` does not, and what `declared` names that `table` does not. */
function difference(table: readonly string[], declared: readonly string[]) {
  const rows = new Set(table);
  const names = new Set(declared);
  return {
    missing: declared.filter((name) => !rows.has(name)),
    invented: table.filter((name) => !names.has(name)),
  };
}

const sets = [
  ['event', Object.keys(PI_COVERAGE.events), piEventNames()],
  ['record', Object.keys(PI_COVERAGE.records), [...PI_NAMES.rpcRecords]],
  ['command', Object.keys(PI_COVERAGE.commands), [...PI_NAMES.rpcCommands]],
  ['UI method', Object.keys(PI_COVERAGE.uiMethods), [...PI_NAMES.uiMethods]],
  ['delta', Object.keys(PI_COVERAGE.deltas), [...PI_NAMES.assistantMessageEvents]],
  ['tool kind', Object.keys(PI_TOOL_KINDS), [...PI_NAMES.tools]],
] as const;

test('control: the comparison can fail both ways, and the release snapshot is not empty', () => {
  assert.deepEqual(difference(['a', 'b'], ['a', 'b']), { missing: [], invented: [] });
  assert.deepEqual(difference(['a'], ['a', 'b']), { missing: ['b'], invented: [] });
  assert.deepEqual(difference(['a', 'z'], ['a']), { missing: [], invented: ['z'] });
  for (const [what, , declared] of sets) assert.ok(declared.length > 0, `the snapshot declares no ${what}`);
});

test("the snapshot is the pinned release's, and reads whole", () => {
  assert.equal(piNamesProblem(PI_NAMES), null);
  assert.equal(PI_NAMES.version, PI_PINNED_VERSION);
  assert.equal(PI_NAMES.release, `v${PI_PINNED_VERSION}`);
});

test('control: an emptied, malformed or doubled list is refused at load, by name', () => {
  assert.match(piNamesProblem({ ...PI_NAMES, tools: [] }) ?? '', /tools list is empty/);
  assert.match(piNamesProblem({ ...PI_NAMES, tools: ['read file'] }) ?? '', /not a name/);
  assert.match(
    piNamesProblem({ ...PI_NAMES, rpcCommands: ['abort', 'abort'] }) ?? '',
    /names an entry twice/,
  );
  assert.match(piNamesProblem({ ...PI_NAMES, version: '' }) ?? '', /no version/);
});

for (const [what, table, declared] of sets) {
  test(`every ${what} of the release has exactly one row, and no row names one it does not declare`, () => {
    const { missing, invented } = difference(table, declared);
    assert.deepEqual(missing, [], `${what}s with no row: ${missing.join(', ')}`);
    assert.deepEqual(invented, [], `rows naming no ${what} of ${PI_NAMES.release}: ${invented.join(', ')}`);
  });
}

test('every built-in tool is in exactly one local family, and a tool that runs a command states the grammar it runs in', () => {
  const families = [
    PI_TOOL_FAMILIES.write,
    PI_TOOL_FAMILIES.read,
    PI_TOOL_FAMILIES.shell,
    PI_TOOL_FAMILIES.search ?? [],
  ];
  for (const tool of PI_NAMES.tools) {
    assert.equal(
      families.filter((family) => family.includes(tool)).length,
      1,
      `${tool} is in no family, or in two`,
    );
    assert.equal(
      PI_TOOL_KINDS[tool] === 'shell',
      Object.hasOwn(PI_SHELL_DIALECTS, tool),
      `${tool}'s dialect and kind disagree`,
    );
  }
});

test("pi's cause events are its wired event and command rows, exactly, both ways", () => {
  const wired = piWiredEvents().map((name) => `pi:${name}`);
  const piEvents = AGENT_EVENTS.filter((event) => event.startsWith('pi:'));
  const { missing, invented } = difference([...piEvents], wired);
  assert.deepEqual(missing, [], `wired rows with no cause event: ${missing.join(', ')}`);
  assert.deepEqual(invented, [], `cause events naming no wired row: ${invented.join(', ')}`);
  for (const event of piEvents) assert.ok(isCauseEvent(event), `${event} is not a declared cause event`);
});

test("every agent event belongs to one runtime's table: Codex's, Qwen Code's or pi's", () => {
  const owned = new Set([
    ...codexWiredNotifications().map((method) => `codex:${method}`),
    ...qwenWiredEvents().map((name) => `qwen-code:${name}`),
    ...piWiredEvents().map((name) => `pi:${name}`),
  ]);
  const orphans = AGENT_EVENTS.filter((event) => !owned.has(event));
  assert.deepEqual(orphans, [], `agent events no runtime's table holds: ${orphans.join(', ')}`);
});

test('every command the adapter sends is one the release reads, and its row is wired; every dialog it cancels is a method the release declares', () => {
  for (const command of PI_HOST_COMMANDS) {
    assert.ok(PI_NAMES.rpcCommands.includes(command), `${command} is not read by ${PI_NAMES.release}`);
    assert.equal(PI_COVERAGE.commands[command].handling, 'wired', `${command}'s row is declined`);
  }
  for (const method of PI_DIALOG_METHODS) {
    assert.ok(PI_NAMES.uiMethods.includes(method), `${method} is no method of ${PI_NAMES.release}`);
  }
  for (const never of ['bash', 'follow_up', 'steer']) {
    assert.ok(!(PI_HOST_COMMANDS as readonly string[]).includes(never), `the adapter sends ${never}`);
  }
});

/** One message of every kind the pi lane moves the machine on. */
function everyTransition(): PiMessage[] {
  const event = (body: JsonObject): PiMessage => ({ kind: 'event', event: body });
  const answered = (command: 'get_state' | 'prompt', response: JsonObject): PiMessage => ({
    kind: 'response',
    command,
    request: {},
    response: { type: 'response', command, ...response },
  });
  return [
    answered('get_state', { success: true, data: { sessionId: 'pi-session-a' } }),
    event({ type: 'agent_start' }),
    event({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash' }),
    event({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', isError: false, result: {} }),
    event({ type: 'compaction_start', reason: 'threshold' }),
    event({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 10 }, aborted: false }),
    event({ type: 'agent_settled', aborted: false }),
    event({ type: 'agent_start' }),
    event({ type: 'agent_settled', aborted: true }),
    event({ type: 'agent_start' }),
    event({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401' },
    }),
    event({ type: 'agent_settled', aborted: false }),
    answered('prompt', { success: false, error: 'No API key found for openrouter.' }),
  ];
}

test('every cause the pi lane records is an agent event the vocabulary declares, and none is refused', () => {
  const machine = new SessionStateMachine({
    where: { worktree: null, branch: null, cwd: 'C:/work', unknownReason: 'not a repository' },
    clock: () => '2000-01-01T00:00:00.000Z',
    ticker: fixedTicker(0),
  });
  const observer = new SessionObserver(machine, { controlTier: { level: 'intercepted', degrades: [] } });
  const causes: TransitionCause[] = [];
  const states: string[] = [];
  const rejected: string[] = [];
  machine.onTransition((transition) => {
    causes.push(transition.cause);
    states.push(transition.to);
  });
  machine.onRejected((rejection) => rejected.push(rejection.refusal.detail));
  for (const message of everyTransition()) observer.observePiMessage(message);
  assert.deepEqual(rejected, [], `the machine refused causes: ${rejected.join('; ')}`);
  assert.deepEqual(states, [
    'ready',
    'working',
    'working',
    'working',
    'working',
    'working',
    'idle',
    'working',
    'interrupted',
    'working',
    'errored',
    'errored',
  ]);
  for (const cause of causes) {
    assert.equal(cause.kind, 'agent-event', `${cause.event} recorded under kind ${cause.kind}`);
    assert.ok((AGENT_EVENTS as readonly string[]).includes(cause.event), `${cause.event} is no agent event`);
  }
});

test('the first ready states the tier, and a degrade known at the open lowers it with its name', () => {
  const machine = new SessionStateMachine({
    where: { worktree: null, branch: null, cwd: 'C:/work', unknownReason: 'not a repository' },
    clock: () => '2000-01-01T00:00:00.000Z',
    ticker: fixedTicker(0),
  });
  const observer = new SessionObserver(machine, { controlTier: { level: 'intercepted', degrades: [] } });
  observer.stateSpawnDegrades(['gate-foreign-extension'], 'intercepted-with-residual');
  const tiers: unknown[] = [];
  machine.onTransition((transition) => tiers.push(transition.controlTier));
  observer.observePiMessage({
    kind: 'response',
    command: 'get_state',
    request: {},
    response: { type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-session-a' } },
  });
  assert.deepEqual(tiers, [{ level: 'intercepted-with-residual', degrades: ['gate-foreign-extension'] }]);
});
