/**
 * Copilot's coverage law, held against the SDK release it is pinned to.
 *
 * - Every session event the pinned release declares has exactly one row in `COPILOT_COVERAGE`, and no row
 *   names an event the release does not declare. The names come from `contracts/copilot-names.json`, which
 *   `scripts/derive-copilot-names.mjs` derives from an install of the release; nothing here is typed in
 *   from memory.
 * - Every built-in tool this host names has one kind, and one local family where it reads, writes, searches
 *   or runs; a tool that runs a command states its dialect.
 * - The cause events Copilot can name a transition with are its wired rows, exactly, and every cause the
 *   Copilot lane records is one of them: driven through a real machine, none is refused as unnamed. Every
 *   agent event belongs to one runtime's table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixedTicker } from '../core/time.js';
import { COPILOT_TOOL_FAMILIES } from '../gate/local.js';
import { COPILOT_SHELL_DIALECTS, COPILOT_TOOL_KINDS } from '../gate/tool-kind.js';
import { COPILOT_NAMES, copilotNamesProblem } from '../host/copilot-names.js';
import {
  COPILOT_RUNTIME_PINNED_VERSION,
  COPILOT_SDK_PACKAGE,
  COPILOT_SDK_PINNED_VERSION,
} from '../host/copilot-sdk.js';
import type { CopilotMessage } from '../host/copilot-wire.js';
import { codexWiredNotifications } from '../state/codex-coverage.js';
import { COPILOT_COVERAGE, copilotWiredEvents } from '../state/copilot-coverage.js';
import { SessionStateMachine } from '../state/machine.js';
import { AGENT_EVENTS, isCauseEvent } from '../state/model.js';
import type { TransitionCause } from '../state/model.js';
import { SessionObserver } from '../state/observer.js';
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
  assert.ok(
    COPILOT_NAMES.sessionEvents.length >= 100,
    'the snapshot declares too few events to be a release',
  );
});

test("the snapshot is the pinned release's, and reads whole", () => {
  assert.equal(copilotNamesProblem(COPILOT_NAMES), null);
  assert.equal(COPILOT_NAMES.package, COPILOT_SDK_PACKAGE);
  assert.equal(COPILOT_NAMES.version, COPILOT_SDK_PINNED_VERSION);
  assert.equal(COPILOT_NAMES.runtimeVersion, COPILOT_RUNTIME_PINNED_VERSION);
});

test('control: an emptied, malformed or doubled list is refused at load, by name', () => {
  assert.match(
    copilotNamesProblem({ ...COPILOT_NAMES, sessionEvents: [] }) ?? '',
    /sessionEvents list is empty/,
  );
  assert.match(
    copilotNamesProblem({ ...COPILOT_NAMES, sessionEvents: ['session idle'] }) ?? '',
    /not an event name/,
  );
  assert.match(
    copilotNamesProblem({ ...COPILOT_NAMES, sessionEvents: ['session.idle', 'session.idle'] }) ?? '',
    /names an entry twice/,
  );
  assert.match(copilotNamesProblem({ ...COPILOT_NAMES, version: '' }) ?? '', /no version/);
});

test('every session event of the release has exactly one row, and no row names one it does not declare', () => {
  const { missing, invented } = difference(Object.keys(COPILOT_COVERAGE.events), COPILOT_NAMES.sessionEvents);
  assert.deepEqual(missing, [], `events with no row: ${missing.join(', ')}`);
  assert.deepEqual(invented, [], `rows naming no event of ${COPILOT_NAMES.version}: ${invented.join(', ')}`);
});

test('control: a deleted row and an invented one are each named', () => {
  const rows = Object.keys(COPILOT_COVERAGE.events);
  assert.deepEqual(difference(rows.slice(1), COPILOT_NAMES.sessionEvents).missing, [rows[0]]);
  assert.deepEqual(difference([...rows, 'session.invented'], COPILOT_NAMES.sessionEvents).invented, [
    'session.invented',
  ]);
});

test('every tool a kind is named for is in at most one local family, every family member has a kind, and a tool that runs a command states its grammar', () => {
  const families = Object.values(COPILOT_TOOL_FAMILIES).filter(
    (family): family is readonly string[] => family !== undefined,
  );
  for (const tool of Object.keys(COPILOT_TOOL_KINDS)) {
    assert.ok(families.filter((family) => family.includes(tool)).length <= 1, `${tool} is in two families`);
    assert.equal(
      COPILOT_TOOL_KINDS[tool] === 'shell',
      Object.hasOwn(COPILOT_SHELL_DIALECTS, tool),
      `${tool}'s dialect and kind disagree`,
    );
  }
  for (const family of families) {
    for (const tool of family)
      assert.ok(Object.hasOwn(COPILOT_TOOL_KINDS, tool), `${tool} has a family and no kind`);
  }
  // Only `web_fetch` reads no path and runs no command among the tools that have a kind.
  const unfamilied = Object.keys(COPILOT_TOOL_KINDS).filter(
    (tool) => !families.some((family) => family.includes(tool)),
  );
  assert.deepEqual(unfamilied, ['web_fetch']);
});

test("Copilot's cause events are its wired rows, exactly, both ways", () => {
  const wired = copilotWiredEvents().map((name) => `copilot:${name}`);
  const copilotEvents = AGENT_EVENTS.filter((event) => event.startsWith('copilot:'));
  const { missing, invented } = difference([...copilotEvents], wired);
  assert.deepEqual(missing, [], `wired rows with no cause event: ${missing.join(', ')}`);
  assert.deepEqual(invented, [], `cause events naming no wired row: ${invented.join(', ')}`);
  for (const event of copilotEvents) assert.ok(isCauseEvent(event), `${event} is not a declared cause event`);
});

test("every agent event belongs to one runtime's table: Codex's, Qwen Code's, pi's or Copilot's", () => {
  const owned = new Set([
    ...codexWiredNotifications().map((method) => `codex:${method}`),
    ...qwenWiredEvents().map((name) => `qwen-code:${name}`),
    ...piWiredEvents().map((name) => `pi:${name}`),
    ...copilotWiredEvents().map((name) => `copilot:${name}`),
  ]);
  const orphans = AGENT_EVENTS.filter((event) => !owned.has(event));
  assert.deepEqual(orphans, [], `agent events no runtime's table holds: ${orphans.join(', ')}`);
});

/** One message of every kind the Copilot lane moves the machine on. */
function everyTransition(): CopilotMessage[] {
  let id = 0;
  const event = (type: string, data: Record<string, unknown>): CopilotMessage => {
    id += 1;
    return { kind: 'event', event: { id: `e${id}`, parentId: null, timestamp: '', type, data } };
  };
  return [
    {
      kind: 'opened',
      sessionId: 'copilot-a',
      model: 'm',
      agentMode: 'interactive',
      tools: [],
      origin: 'new',
    },
    event('user.message', { content: 'go' }),
    event('tool.execution_start', { toolCallId: 'call_1', toolName: 'view' }),
    event('tool.execution_complete', { toolCallId: 'call_1', success: true }),
    event('session.compaction_start', { trigger: 'threshold', currentTokens: 900 }),
    event('session.compaction_complete', {
      success: true,
      preCompactionTokens: 900,
      postCompactionTokens: 100,
    }),
    event('session.idle', {}),
    event('user.message', { content: 'again' }),
    event('session.idle', { aborted: true }),
    event('user.message', { content: 'once more' }),
    event('session.error', { errorType: 'authentication', message: 'Not authenticated' }),
    event('session.idle', {}),
  ];
}

test('every cause the Copilot lane records is an agent event the vocabulary declares, and none is refused', () => {
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
  for (const message of everyTransition()) observer.observeCopilotMessage(message);
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

test("a sub-agent's events move none of the session's state", () => {
  const machine = new SessionStateMachine({
    where: { worktree: null, branch: null, cwd: 'C:/work', unknownReason: 'not a repository' },
    clock: () => '2000-01-01T00:00:00.000Z',
    ticker: fixedTicker(0),
  });
  const observer = new SessionObserver(machine, {
    controlTier: { level: 'intercepted-with-residual', degrades: [] },
  });
  observer.observeCopilotMessage({
    kind: 'opened',
    sessionId: 'a',
    model: null,
    agentMode: 'interactive',
    tools: [],
    origin: 'new',
  });
  const states: string[] = [];
  machine.onTransition((transition) => states.push(transition.to));
  for (const type of ['user.message', 'tool.execution_start', 'session.error', 'session.idle']) {
    observer.observeCopilotMessage({
      kind: 'event',
      event: {
        id: type,
        parentId: null,
        timestamp: '',
        type,
        agentId: 'sub-1',
        data: { toolCallId: 'c', toolName: 'view' },
      },
    });
  }
  assert.deepEqual(states, []);
});

test('the first ready states the tier, and a degrade known at the open lowers it with its name', () => {
  const machine = new SessionStateMachine({
    where: { worktree: null, branch: null, cwd: 'C:/work', unknownReason: 'not a repository' },
    clock: () => '2000-01-01T00:00:00.000Z',
    ticker: fixedTicker(0),
  });
  const observer = new SessionObserver(machine, {
    controlTier: { level: 'intercepted-with-residual', degrades: [] },
  });
  observer.stateSpawnDegrades(['gate-hook-foreign']);
  const tiers: unknown[] = [];
  machine.onTransition((transition) => tiers.push(transition.controlTier));
  observer.observeCopilotMessage({
    kind: 'opened',
    sessionId: 'a',
    model: null,
    agentMode: 'interactive',
    tools: [],
    origin: 'new',
  });
  assert.deepEqual(tiers, [{ level: 'intercepted-with-residual', degrades: ['gate-hook-foreign'] }]);
});
