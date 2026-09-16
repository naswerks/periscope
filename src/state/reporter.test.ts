/**
 * The reporter enumerates; it never judges. What it owes is the open-entry age, the session each
 * entry belongs to, and the fact that nothing leaves the view unless a caller removes it.
 *
 * Real machines over a fixed clock and ticker, so the age is arithmetic rather than a wait.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixedClock, fixedTicker } from '../core/time.js';
import type { TransitionRequest } from './machine.js';
import { SessionStateMachine } from './machine.js';
import type { TransitionWhere } from './model.js';
import { SessionStateReporter } from './reporter.js';

const WHERE: TransitionWhere = {
  cwd: '/tmp/work',
  worktree: null,
  branch: null,
  unknownReason: 'not a repository',
};
const START_MS = Date.parse('2026-08-03T12:00:00.000Z');
const FORTY_MINUTES_MS = 40 * 60 * 1_000;

function machineAt(startMs = START_MS): {
  machine: SessionStateMachine;
  clock: ReturnType<typeof fixedClock>;
  ticker: ReturnType<typeof fixedTicker>;
} {
  const clock = fixedClock(startMs);
  const ticker = fixedTicker(startMs);
  return { machine: new SessionStateMachine({ where: WHERE, clock, ticker }), clock, ticker };
}

/** The request `observer.ts` builds for a PreToolUse: state working, a tool entry opened. */
const openTool = (entryId: string, name: string): TransitionRequest => ({
  to: 'working',
  cause: { kind: 'hook', event: 'PreToolUse', detail: `${name} started` },
  entry: { op: 'open', entryId, activity: { kind: 'tool', name } },
});

const reportedItself = (sessionId: string): TransitionRequest => ({
  to: 'ready',
  sessionId,
  cause: { kind: 'sdk-message', event: 'system/init', detail: 'the agent reported itself' },
});

/** The request `observer.ts` builds when the process ends: every open entry marked abandoned. */
const processEnded = (): TransitionRequest => ({
  to: 'ended',
  cause: { kind: 'process', event: 'process_ended', detail: 'the stream ended' },
  entry: { op: 'abandon-open', reason: 'the session ended with this entry still open' },
});

test('adding one machine twice counts it once', () => {
  const reporter = new SessionStateReporter();
  const { machine } = machineAt();

  reporter.add(machine);
  reporter.add(machine);

  assert.equal(reporter.count, 1);
  assert.equal(reporter.list().length, 1, 'a second add must not produce a second row');
});

test("list returns one snapshot per added machine, carrying that machine's state", () => {
  const reporter = new SessionStateReporter();
  const first = machineAt().machine;
  const second = machineAt().machine;
  reporter.add(first);
  reporter.add(second);

  const recorded = second.record(openTool('call-1', 'Bash'));
  assert.ok(recorded.ok);

  const snapshots = reporter.list();
  assert.equal(snapshots.length, 2);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.state),
    ['spawning', 'working'],
    'each row reports its own machine, in add order',
  );
  assert.deepEqual(snapshots[1]?.activity, { kind: 'tool', name: 'Bash' });
  assert.equal(snapshots[1]?.transitionCount, 1);
});

test('an open tool entry surfaces with an age equal to what the ticker advanced', () => {
  const reporter = new SessionStateReporter();
  const { machine, ticker } = machineAt();
  reporter.add(machine);

  const recorded = machine.record(openTool('call-1', 'Bash'));
  assert.ok(recorded.ok);
  assert.equal(reporter.openEntries()[0]?.ageMs, 0, 'freshly opened, no age yet');

  ticker.advance(FORTY_MINUTES_MS);

  const entries = reporter.openEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.entryId, 'call-1');
  assert.deepEqual(entries[0]?.activity, { kind: 'tool', name: 'Bash' });
  assert.equal(entries[0]?.ageMs, 2_400_000, 'the age is the ticker arithmetic, nothing else');
  assert.equal(entries[0]?.abandonedAt, null);
});

test("an open entry carries a null session id before the agent reports itself, and the agent's id after", () => {
  const reporter = new SessionStateReporter();
  const { machine } = machineAt();
  reporter.add(machine);

  assert.ok(machine.record(openTool('call-1', 'Bash')).ok);
  assert.equal(reporter.openEntries()[0]?.sessionId, null, 'no id exists yet, and none may be invented');

  assert.ok(machine.record(reportedItself('agent-7')).ok);
  assert.equal(reporter.openEntries()[0]?.sessionId, 'agent-7');
  assert.equal(reporter.openEntries()[0]?.entryId, 'call-1', 'the same entry, now attributed');
});

test('an abandon-open marks the entry and it still surfaces, with its reason and its age', () => {
  const reporter = new SessionStateReporter();
  const { machine, clock, ticker } = machineAt();
  reporter.add(machine);

  assert.ok(machine.record(openTool('call-1', 'Bash')).ok);
  clock.advance(FORTY_MINUTES_MS);
  ticker.advance(FORTY_MINUTES_MS);
  assert.ok(machine.record(processEnded()).ok);

  const entries = reporter.openEntries();
  assert.equal(entries.length, 1, 'marking must never erase');
  assert.equal(entries[0]?.abandonedAt, clock());
  assert.equal(entries[0]?.abandonReason, 'the session ended with this entry still open');
  assert.equal(entries[0]?.ageMs, 2_400_000, 'the age survives the mark');
  assert.equal(machine.activity, null, 'an abandoned entry no longer holds the session');
});

test('an ended machine stays in the view until a caller removes it', () => {
  const reporter = new SessionStateReporter();
  const { machine } = machineAt();
  reporter.add(machine);

  assert.ok(machine.record(openTool('call-1', 'Bash')).ok);
  assert.ok(machine.record(processEnded()).ok);

  assert.equal(reporter.count, 1, 'nothing self-evicts');
  assert.equal(reporter.list()[0]?.state, 'ended');
  assert.equal(reporter.openEntries().length, 1, 'the evidence of what it ended holding is still reported');
});

test('remove drops that machine and its entries, and nothing else', () => {
  const reporter = new SessionStateReporter();
  const kept = machineAt().machine;
  const dropped = machineAt().machine;
  reporter.add(kept);
  reporter.add(dropped);
  assert.ok(kept.record(openTool('kept-call', 'Read')).ok);
  assert.ok(dropped.record(openTool('dropped-call', 'Bash')).ok);
  assert.equal(reporter.openEntries().length, 2, 'both entries are visible before the remove');

  reporter.remove(dropped);

  assert.equal(reporter.count, 1);
  assert.deepEqual(
    reporter.openEntries().map((entry) => entry.entryId),
    ['kept-call'],
    "only the removed machine's entries left the view",
  );
  assert.equal(reporter.list()[0]?.activity?.name, 'Read');

  reporter.remove(dropped);
  assert.equal(reporter.count, 1, 'removing an absent machine changes nothing');
});
