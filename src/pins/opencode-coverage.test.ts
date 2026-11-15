/**
 * opencode's coverage law, held against the SDK release it is pinned to.
 *
 * - Every event the pinned release's stream declares has exactly one row in `OPENCODE_COVERAGE`, and no row
 *   names an event the release does not declare. The names come from `contracts/opencode-names.json`, which
 *   `scripts/derive-opencode-names.mjs` derives from an install of the release; nothing here is typed in from
 *   memory.
 * - Every built-in tool this host names has one kind, and one local family where it reads, writes, searches
 *   or runs; the tools this host turns off have neither, and the rules every session is created with deny
 *   each of them, from the one list.
 * - The cause events opencode can name a transition with are its wired rows, exactly, and every cause the
 *   opencode lane records is one of them: driven through a real machine, none is refused as unnamed. Every
 *   agent event belongs to one runtime's table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixedTicker } from '../core/time.js';
import { OPENCODE_TOOL_FAMILIES } from '../gate/local.js';
import { OPENCODE_DENIED_TOOLS, OPENCODE_OTHER_TOOLS, OPENCODE_TOOL_KINDS } from '../gate/tool-kind.js';
import { opencodeRuleset } from '../host/opencode-home.js';
import { OPENCODE_NAMES, opencodeNamesProblem } from '../host/opencode-names.js';
import { OPENCODE_SDK_PACKAGE, OPENCODE_SDK_PINNED_VERSION } from '../host/opencode-sdk.js';
import type { OpencodeMessage } from '../host/opencode-wire.js';
import { codexWiredNotifications } from '../state/codex-coverage.js';
import { copilotWiredEvents } from '../state/copilot-coverage.js';
import { SessionStateMachine } from '../state/machine.js';
import { AGENT_EVENTS, isCauseEvent } from '../state/model.js';
import type { TransitionCause } from '../state/model.js';
import { SessionObserver } from '../state/observer.js';
import { OPENCODE_COVERAGE, opencodeWiredEvents } from '../state/opencode-coverage.js';
import { piWiredEvents } from '../state/pi-coverage.js';
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

test('control: the comparison can fail both ways, and the release snapshot is not empty', () => {
  assert.deepEqual(difference(['a', 'b'], ['a', 'b']), { missing: [], invented: [] });
  assert.deepEqual(difference(['a'], ['a', 'b']), { missing: ['b'], invented: [] });
  assert.deepEqual(difference(['a', 'z'], ['a']), { missing: [], invented: ['z'] });
  assert.ok(OPENCODE_NAMES.events.length >= 90, 'the snapshot declares too few events to be a release');
});

test("the snapshot is the pinned release's, and reads whole", () => {
  assert.equal(opencodeNamesProblem(OPENCODE_NAMES), null);
  assert.equal(OPENCODE_NAMES.package, OPENCODE_SDK_PACKAGE);
  assert.equal(OPENCODE_NAMES.version, OPENCODE_SDK_PINNED_VERSION);
});

test('control: an emptied, malformed or doubled list is refused at load, by name', () => {
  assert.match(opencodeNamesProblem({ ...OPENCODE_NAMES, events: [] }) ?? '', /events list is empty/);
  assert.match(
    opencodeNamesProblem({ ...OPENCODE_NAMES, events: ['session idle'] }) ?? '',
    /not an event name/,
  );
  assert.match(
    opencodeNamesProblem({ ...OPENCODE_NAMES, events: ['session.idle', 'session.idle'] }) ?? '',
    /names an entry twice/,
  );
  assert.match(opencodeNamesProblem({ ...OPENCODE_NAMES, version: '' }) ?? '', /no version/);
});

test('every event of the release has exactly one row, and no row names one it does not declare', () => {
  const { missing, invented } = difference(Object.keys(OPENCODE_COVERAGE.events), OPENCODE_NAMES.events);
  assert.deepEqual(missing, [], `events with no row: ${missing.join(', ')}`);
  assert.deepEqual(invented, [], `rows naming no event of ${OPENCODE_NAMES.version}: ${invented.join(', ')}`);
});

test('control: a deleted row and an invented one are each named', () => {
  const rows = Object.keys(OPENCODE_COVERAGE.events);
  assert.deepEqual(difference(rows.slice(1), OPENCODE_NAMES.events).missing, [rows[0]]);
  assert.deepEqual(difference([...rows, 'session.invented'], OPENCODE_NAMES.events).invented, [
    'session.invented',
  ]);
});

test('every tool a kind is named for is in at most one local family, every family member has a kind or is the directory request, and a turned-off tool has neither', () => {
  const families = Object.values(OPENCODE_TOOL_FAMILIES).filter(
    (family): family is readonly string[] => family !== undefined,
  );
  for (const tool of Object.keys(OPENCODE_TOOL_KINDS)) {
    assert.ok(families.filter((family) => family.includes(tool)).length <= 1, `${tool} is in two families`);
  }
  for (const family of families) {
    for (const tool of family) {
      // `external_directory` is the request a path outside the session's location raises before its own
      // action; it is read as a path and has no kind of its own.
      if (tool === 'external_directory') continue;
      assert.ok(Object.hasOwn(OPENCODE_TOOL_KINDS, tool), `${tool} has a family and no kind`);
    }
  }
  for (const tool of OPENCODE_DENIED_TOOLS) {
    assert.equal(Object.hasOwn(OPENCODE_TOOL_KINDS, tool), false, `${tool} is turned off and has a kind`);
    assert.equal(OPENCODE_OTHER_TOOLS.includes(tool), false, `${tool} is turned off and named as other`);
    assert.ok(!families.some((family) => family.includes(tool)), `${tool} is turned off and has a family`);
  }
  // Only the web tools read no path and run no command among the tools that have a kind.
  const unfamilied = Object.keys(OPENCODE_TOOL_KINDS).filter(
    (tool) => !families.some((family) => family.includes(tool)),
  );
  assert.deepEqual(unfamilied.sort(), ['webfetch', 'websearch']);
});

test('the rules every session is created with ask for everything, then deny each turned-off tool, from the one list', () => {
  const rules = opencodeRuleset();
  assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'ask' });
  assert.deepEqual(
    rules.slice(1).map((rule) => rule.action),
    [...OPENCODE_DENIED_TOOLS],
  );
  assert.ok(rules.slice(1).every((rule) => rule.effect === 'deny' && rule.resource === '*'));
  assert.equal(
    rules.some((rule) => rule.effect === 'allow'),
    false,
    'no rule this host writes can answer a call',
  );
});

test("opencode's cause events are its wired rows, exactly, both ways", () => {
  const wired = opencodeWiredEvents().map((name) => `opencode:${name}`);
  const opencodeEvents = AGENT_EVENTS.filter((event) => event.startsWith('opencode:'));
  const { missing, invented } = difference([...opencodeEvents], wired);
  assert.deepEqual(missing, [], `wired rows with no cause event: ${missing.join(', ')}`);
  assert.deepEqual(invented, [], `cause events naming no wired row: ${invented.join(', ')}`);
  for (const event of opencodeEvents)
    assert.ok(isCauseEvent(event), `${event} is not a declared cause event`);
});

test("every agent event belongs to one runtime's table: Codex's, Qwen Code's, pi's, Copilot's or opencode's", () => {
  const owned = new Set([
    ...codexWiredNotifications().map((method) => `codex:${method}`),
    ...qwenWiredEvents().map((name) => `qwen-code:${name}`),
    ...piWiredEvents().map((name) => `pi:${name}`),
    ...copilotWiredEvents().map((name) => `copilot:${name}`),
    ...opencodeWiredEvents().map((name) => `opencode:${name}`),
  ]);
  const orphans = AGENT_EVENTS.filter((event) => !owned.has(event));
  assert.deepEqual(orphans, [], `agent events no runtime's table holds: ${orphans.join(', ')}`);
});

/** One event of the session's own. */
function own(type: string, data: Record<string, unknown>, id: string): OpencodeMessage {
  return {
    kind: 'event',
    event: { id, type, data: { sessionID: 'ses_a', ...data } },
    session: 'ses_a',
    main: true,
    spawnedBy: null,
  };
}

/** One message of every kind the opencode lane moves the machine on. */
function everyTransition(): OpencodeMessage[] {
  let id = 0;
  const event = (type: string, data: Record<string, unknown> = {}): OpencodeMessage => {
    id += 1;
    return own(type, data, `evt_${id}`);
  };
  return [
    { kind: 'opened', sessionId: 'ses_a', model: 'endpoint-stub/m', agent: 'build', origin: 'new' },
    event('session.execution.started'),
    event('session.tool.input.started', { id: 'call_1', name: 'read' }),
    event('session.tool.called', { id: 'call_1', input: { filePath: 'a.ts' } }),
    event('session.tool.success', { id: 'call_1' }),
    event('session.compaction.started', { reason: 'auto' }),
    event('session.compaction.ended', { reason: 'auto' }),
    event('session.execution.succeeded'),
    event('session.execution.started'),
    event('session.tool.input.started', { id: 'call_2', name: 'shell' }),
    event('session.tool.called', { id: 'call_2', input: { command: 'git status' } }),
    event('session.execution.interrupted', { reason: 'user' }),
    event('session.execution.started'),
    event('session.execution.failed', { error: { type: 'auth', message: 'Unauthorized' } }),
  ];
}

function machineAndObserver() {
  const machine = new SessionStateMachine({
    where: { worktree: null, branch: null, cwd: 'C:/work', unknownReason: 'not a repository' },
    clock: () => '2000-01-01T00:00:00.000Z',
    ticker: fixedTicker(0),
  });
  const observer = new SessionObserver(machine, {
    controlTier: { level: 'intercepted-with-residual', degrades: [] },
  });
  return { machine, observer };
}

test('every cause the opencode lane records is an agent event the vocabulary declares, and none is refused', () => {
  const { machine, observer } = machineAndObserver();
  const causes: TransitionCause[] = [];
  const states: string[] = [];
  const rejected: string[] = [];
  machine.onTransition((transition) => {
    causes.push(transition.cause);
    states.push(transition.to);
  });
  machine.onRejected((rejection) => rejected.push(rejection.refusal.detail));
  for (const message of everyTransition()) observer.observeOpencodeMessage(message);
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
    'working',
    'working',
    'interrupted',
    'working',
    'errored',
  ]);
  for (const cause of causes) {
    assert.equal(cause.kind, 'agent-event', `${cause.event} recorded under kind ${cause.kind}`);
    assert.ok((AGENT_EVENTS as readonly string[]).includes(cause.event), `${cause.event} is no agent event`);
  }
  assert.equal(causes[0]?.event, 'opencode:session.created', 'the first cause event: the open, proven');
  assert.equal(causes.at(-1)?.event, 'opencode:session.execution.failed', 'the last: the run that failed');
  assert.match(String(causes.at(-1)?.detail), /auth: Unauthorized/);
});

test("a subagent's events and the server's own move none of the session's state", () => {
  const { machine, observer } = machineAndObserver();
  observer.observeOpencodeMessage({
    kind: 'opened',
    sessionId: 'a',
    model: null,
    agent: 'build',
    origin: 'new',
  });
  const states: string[] = [];
  machine.onTransition((transition) => states.push(transition.to));
  for (const type of ['session.execution.started', 'session.tool.called', 'session.execution.failed']) {
    observer.observeOpencodeMessage({
      kind: 'event',
      event: { id: type, type, data: { sessionID: 'ses_child', id: 'c' } },
      session: 'ses_child',
      main: false,
      spawnedBy: 'call_task',
    });
  }
  observer.observeOpencodeMessage({
    kind: 'event',
    event: { id: 'p', type: 'plugin.updated', data: {} },
    session: null,
    main: false,
    spawnedBy: null,
  });
  assert.deepEqual(states, []);
});

test('the first ready states the tier, and a degrade known at the open lowers it with its name', () => {
  const { machine, observer } = machineAndObserver();
  observer.stateSpawnDegrades(['gate-foreign-extension']);
  const tiers: unknown[] = [];
  machine.onTransition((transition) => tiers.push(transition.controlTier));
  observer.observeOpencodeMessage({
    kind: 'opened',
    sessionId: 'a',
    model: null,
    agent: 'build',
    origin: 'new',
  });
  assert.deepEqual(tiers, [{ level: 'intercepted-with-residual', degrades: ['gate-foreign-extension'] }]);
});

test("a provider-run call opens no tool entry, and a run's end closes every entry still open", () => {
  const { machine, observer } = machineAndObserver();
  const touched: string[] = [];
  machine.onTransition((transition) => {
    if (transition.entryId !== null) touched.push(`${transition.cause.event}:${transition.entryId}`);
  });
  observer.observeOpencodeMessage({
    kind: 'opened',
    sessionId: 'ses_a',
    model: null,
    agent: 'build',
    origin: 'new',
  });
  observer.observeOpencodeMessage(own('session.execution.started', {}, 'e1'));
  observer.observeOpencodeMessage(own('session.tool.called', { id: 'provider_1', executed: true }, 'e2'));
  observer.observeOpencodeMessage(own('session.tool.called', { id: 'call_open' }, 'e3'));
  observer.observeOpencodeMessage(own('session.execution.succeeded', {}, 'e4'));
  assert.deepEqual(touched, [
    'opencode:session.tool.called:call_open',
    'opencode:session.execution.succeeded:call_open',
  ]);
});
