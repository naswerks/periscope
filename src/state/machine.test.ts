import test from 'node:test';
import assert from 'node:assert/strict';

import { fixedClock, fixedTicker } from '../core/time.js';
import type { TransitionCause, TransitionWhere } from './model.js';
import { SessionStateMachine } from './machine.js';

const WHERE: TransitionWhere = {
  cwd: '/tmp/work',
  worktree: '/tmp/work',
  branch: 'main',
  unknownReason: null,
};

const START_MS = Date.parse('2026-08-03T12:00:00.000Z');

function machine(correlationId: string | null = null): {
  machine: SessionStateMachine;
  clock: ReturnType<typeof fixedClock>;
  ticker: ReturnType<typeof fixedTicker>;
} {
  const clock = fixedClock(START_MS);
  const ticker = fixedTicker(START_MS);
  return { machine: new SessionStateMachine({ where: WHERE, clock, ticker, correlationId }), clock, ticker };
}

const because = (event: TransitionCause['event'], detail = 'because'): TransitionCause => ({
  kind: 'control',
  event,
  detail,
});

test('a session begins in spawning before anything has been recorded', () => {
  const { machine: m } = machine();
  assert.equal(m.state, 'spawning');
  assert.equal(m.activity, null);
  assert.equal(m.sessionId, null);
  assert.equal(m.transitionCount, 0);
});

test('state, activity and sessionId are derived — recording is the only way any of them moves', () => {
  const { machine: m } = machine();

  m.record({ to: 'ready', sessionId: 'sess-1', cause: because('create_requested') });
  assert.equal(m.state, 'ready');
  assert.equal(m.sessionId, 'sess-1');

  // The session id is carried forward without being repeated: a later transition that does not
  // mention it must not silently drop back to "unidentified".
  m.record({ to: 'working', cause: because('prompt_submitted') });
  assert.equal(m.sessionId, 'sess-1');
  assert.equal(m.state, 'working');
});

test('a transition whose cause cannot be named is refused, counted, and reported', () => {
  const { machine: m } = machine();
  const rejections: string[] = [];
  m.onRejected((rejected) => rejections.push(rejected.refusal.reason));

  // The compiler closes CauseEvent, so this is the shape that only ever arrives off the wire.
  const result = m.record({
    to: 'working',
    cause: { kind: 'hook', event: 'NotAnEventTheSdkHas' as TransitionCause['event'], detail: 'x' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal.reason, 'transition-cause-unnamed');
  assert.deepEqual(rejections, ['transition-cause-unnamed']);
  assert.equal(m.rejectedCount, 1);
  // The refusal did not become a state change.
  assert.equal(m.state, 'spawning');
  assert.equal(m.transitionCount, 0);
});

test('a refused transition never throws — a throw would be swallowed by the hook wrapper', () => {
  const { machine: m } = machine();
  assert.doesNotThrow(() => {
    m.record({ to: 'working', cause: undefined as unknown as TransitionCause });
  });
  assert.equal(m.rejectedCount, 1);
});

test('seq is dense from 1, so a gap in a trace is detectable by arithmetic alone', () => {
  const { machine: m } = machine();
  const seqs: number[] = [];
  m.onTransition((transition) => seqs.push(transition.seq));

  for (const to of ['ready', 'working', 'idle', 'ended'] as const) {
    m.record({ to, cause: because('create_requested') });
  }

  assert.deepEqual(seqs, [1, 2, 3, 4]);
});

test('an entry opens, holds the session, and exits — and the activity follows it', () => {
  const { machine: m } = machine();

  m.record({
    to: 'working',
    entry: { op: 'open', entryId: 'tu-1', activity: { kind: 'tool', name: 'Bash' } },
    cause: because('prompt_submitted', 'Bash started'),
  });
  assert.deepEqual(m.activity, { kind: 'tool', name: 'Bash' });
  assert.equal(m.openEntries().length, 1);

  m.record({
    to: 'working',
    entry: { op: 'close', entryId: 'tu-1' },
    cause: because('prompt_submitted', 'Bash finished'),
  });
  assert.equal(m.activity, null);
  assert.equal(m.openEntries().length, 0);
});

test('an unpaired entry is surfaced with its age rather than reconciled away', () => {
  const { machine: m, ticker } = machine();

  m.record({
    to: 'working',
    entry: { op: 'open', entryId: 'tu-abandoned', activity: { kind: 'tool', name: 'Bash' } },
    cause: because('prompt_submitted'),
  });

  ticker.advance(40 * 60 * 1000);

  const [open] = m.openEntries();
  assert.equal(open?.entryId, 'tu-abandoned');
  assert.equal(open?.ageMs, 40 * 60 * 1000, 'the age is what makes a stuck session visible');
});

test('ending a session marks every open entry abandoned — it never erases one', () => {
  const { machine: m, clock, ticker } = machine();

  m.record({
    to: 'working',
    entry: { op: 'open', entryId: 'tu-1', activity: { kind: 'tool', name: 'Bash' } },
    cause: because('prompt_submitted'),
  });

  clock.advance(60_000);
  ticker.advance(60_000);
  m.record({
    to: 'ended',
    entry: { op: 'abandon-open', reason: 'the process died holding this' },
    cause: { kind: 'process', event: 'process_failed', detail: 'the stream threw' },
  });

  const [open] = m.openEntries();
  assert.equal(m.openEntries().length, 1, 'the entry survives the end — erasing it destroys the evidence');
  assert.equal(open?.abandonedAt, '2026-08-03T12:01:00.000Z');
  assert.equal(open?.abandonReason, 'the process died holding this');
  assert.equal(open?.ageMs, 60_000, 'and it still carries how long it was open');

  // An abandoned entry no longer holds the session: it is a record, not a live block.
  assert.equal(m.activity, null);
});

test('backgrounded work stops holding the session but stays open, ageing, and still exits', () => {
  const { machine: m, clock, ticker } = machine();

  m.record({
    to: 'working',
    entry: { op: 'open', entryId: 'tu-build', activity: { kind: 'tool', name: 'Bash' } },
    cause: because('prompt_submitted'),
  });
  assert.deepEqual(m.activity, { kind: 'tool', name: 'Bash' }, 'foreground work holds it');

  clock.advance(5_000);
  ticker.advance(5_000);
  m.record({
    to: 'idle',
    entry: { op: 'background', entryId: 'tu-build' },
    cause: { kind: 'sdk-message', event: 'system/task_updated', detail: 'backgrounded' },
  });

  assert.equal(m.activity, null, 'a session with only background work is not blocked on it');
  assert.equal(m.state, 'idle');
  const [backgrounded] = m.openEntries();
  assert.equal(backgrounded?.lane, 'background');
  assert.equal(backgrounded?.backgroundedAt, '2026-08-03T12:00:05.000Z');
  assert.equal(backgrounded?.openedAt, '2026-08-03T12:00:00.000Z', 'backgrounding is not a new entry');

  ticker.advance(600_000);
  assert.equal(m.openEntries()[0]?.ageMs, 605_000, 'it keeps ageing while backgrounded');

  m.record({
    to: 'idle',
    entry: { op: 'close', entryId: 'tu-build' },
    cause: { kind: 'sdk-message', event: 'system/task_notification', detail: 'completed' },
  });
  assert.equal(m.openEntries().length, 0, 'backgrounding is not completion — the exit still comes');
});

test('re-reporting the same condition keeps the original openedAt, so the age is not reset', () => {
  const { machine: m, clock, ticker } = machine();

  m.record({
    to: 'working',
    entry: { op: 'open', entryId: 'compaction', activity: { kind: 'compacting', name: null } },
    cause: { kind: 'hook', event: 'PreCompact', detail: 'auto' },
  });

  clock.advance(30_000);
  ticker.advance(30_000);
  m.record({
    to: 'working',
    entry: { op: 'open', entryId: 'compaction', activity: { kind: 'compacting', name: null } },
    cause: { kind: 'sdk-message', event: 'system/status', detail: 'compacting' },
  });

  assert.equal(m.openEntries()[0]?.ageMs, 30_000);
});

test('activity names the most recent foreground entry while the whole open set stays enumerable', () => {
  const { machine: m } = machine();

  for (const [entryId, name] of [
    ['tu-1', 'Read'],
    ['tu-2', 'Grep'],
  ] as const) {
    m.record({
      to: 'working',
      entry: { op: 'open', entryId, activity: { kind: 'tool', name } },
      cause: because('prompt_submitted'),
    });
  }

  assert.deepEqual(m.activity, { kind: 'tool', name: 'Grep' }, 'what it is doing now');
  assert.deepEqual(
    m
      .openEntries()
      .map((entry) => entry.entryId)
      .sort(),
    ['tu-1', 'tu-2'],
    'and both are still open — parallel calls are not collapsed into one',
  );
});

test('where is carried forward, and a relocation updates every later transition', () => {
  const { machine: m } = machine();
  const seen: (string | null)[] = [];
  m.onTransition((transition) => seen.push(transition.where.cwd));

  m.record({ to: 'working', cause: because('prompt_submitted') });
  m.record({
    to: 'working',
    where: { ...WHERE, cwd: '/tmp/elsewhere' },
    cause: { kind: 'hook', event: 'CwdChanged', detail: 'moved' },
  });
  m.record({ to: 'idle', cause: because('prompt_submitted') });

  assert.deepEqual(seen, ['/tmp/work', '/tmp/elsewhere', '/tmp/elsewhere']);
  assert.equal(m.where.cwd, '/tmp/elsewhere');
});

test('every transition carries where, what and why — enough to answer all three without a transcript', () => {
  const { machine: m } = machine('corr-42');
  const recorded = m.record({
    to: 'working',
    sessionId: 'sess-7',
    entry: { op: 'open', entryId: 'tu-9', activity: { kind: 'tool', name: 'Bash' } },
    cause: { kind: 'hook', event: 'PreToolUse', detail: 'Bash started' },
  });

  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  const transition = recorded.value;

  // where
  assert.equal(transition.sessionId, 'sess-7');
  assert.equal(transition.where.worktree, '/tmp/work');
  assert.equal(transition.where.branch, 'main');
  // what
  assert.equal(transition.to, 'working');
  assert.deepEqual(transition.activity, { kind: 'tool', name: 'Bash' });
  // why
  assert.equal(transition.cause.kind, 'hook');
  assert.equal(transition.cause.event, 'PreToolUse');
  // and the controller's own thread, carried but never read
  assert.equal(transition.correlationId, 'corr-42');
});

test('a permission denial and a permission-path outage are two discriminators apart', () => {
  const { machine: m } = machine();

  const denial = m.record({
    to: 'working',
    cause: { kind: 'hook', event: 'PermissionDenied', detail: 'Bash was denied: not allowed here' },
  });
  const outage = m.record({
    to: 'working',
    cause: { kind: 'refusal', event: 'link-send-failed', detail: 'the decision path was unreachable' },
  });

  assert.equal(denial.ok && denial.value.cause.kind, 'hook');
  assert.equal(outage.ok && outage.value.cause.kind, 'refusal');
  assert.notEqual(
    denial.ok && denial.value.cause.event,
    outage.ok && outage.value.cause.event,
    'an outage must never be readable as a deliberate no',
  );
});

test('a snapshot is this session as this host sees it — and carries nothing about what it means', () => {
  const { machine: m } = machine('corr-1');
  m.record({
    to: 'working',
    sessionId: 'sess-1',
    entry: { op: 'open', entryId: 'tu-1', activity: { kind: 'tool', name: 'Bash' } },
    cause: because('prompt_submitted'),
  });

  const snapshot = m.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'activity',
    'correlationId',
    'lastTransitionAt',
    'openEntries',
    'sessionId',
    'state',
    'transitionCount',
    'where',
  ]);
  assert.equal(snapshot.openEntries.length, 1);
});
