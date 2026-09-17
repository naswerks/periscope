/**
 * The store-level properties. Everything here asserts on what was retained, never on what a call
 * site claims it passed — the emitter proving its own emission is the assertion and the subject
 * being one object.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixedClock, fixedTicker } from '../core/time.js';
import { SESSION_STATES, ACTIVITY_KINDS } from './model.js';
import type { ActivityKind, SessionState, TransitionCause, TransitionWhere } from './model.js';
import { SessionStateMachine } from './machine.js';
import { TransitionStore } from './store.js';

const START_MS = Date.parse('2026-08-03T12:00:00.000Z');

const WHERE: TransitionWhere = { cwd: '/tmp/w', worktree: '/tmp/w', branch: 'main', unknownReason: null };

function build(correlationId: string | null = null, where: TransitionWhere = WHERE): SessionStateMachine {
  return new SessionStateMachine({
    where,
    clock: fixedClock(START_MS),
    ticker: fixedTicker(START_MS),
    correlationId,
  });
}

const control = (detail: string): TransitionCause => ({ kind: 'control', event: 'prompt_submitted', detail });

/**
 * One session's whole life, driven by the same script every time.
 *
 * The script mentions nothing about the session it is driving — no id, no correlation, no
 * observers, no origin. That is what makes the same-trace property below mean something: the only
 * variable between runs is the session, and the script cannot see it.
 */
function driveWholeLife(machine: SessionStateMachine, sessionId: string): void {
  machine.record({ to: 'spawning', cause: { kind: 'control', event: 'create_requested', detail: 'asked' } });
  machine.record({
    to: 'ready',
    sessionId,
    cause: { kind: 'sdk-message', event: 'system/init', detail: 'named' },
  });
  machine.record({ to: 'working', cause: { kind: 'hook', event: 'UserPromptSubmit', detail: 'a turn' } });
  machine.record({
    to: 'working',
    entry: { op: 'open', entryId: 'req', activity: { kind: 'requesting', name: null } },
    cause: { kind: 'sdk-message', event: 'system/status', detail: 'requesting' },
  });
  machine.record({
    to: 'working',
    entry: { op: 'close', entryId: 'req' },
    cause: { kind: 'sdk-message', event: 'system/status', detail: 'done' },
  });
  machine.record({
    to: 'working',
    entry: { op: 'open', entryId: 'perm', activity: { kind: 'permission', name: 'Bash' } },
    cause: { kind: 'hook', event: 'PermissionRequest', detail: 'Bash?' },
  });
  machine.record({
    to: 'working',
    entry: { op: 'close', entryId: 'perm' },
    cause: { kind: 'hook', event: 'PermissionDenied', detail: 'no' },
  });
  machine.record({
    to: 'working',
    entry: { op: 'open', entryId: 'tu-1', activity: { kind: 'tool', name: 'Bash' } },
    cause: { kind: 'hook', event: 'PreToolUse', detail: 'Bash' },
  });
  machine.record({
    to: 'working',
    entry: { op: 'open', entryId: 'ag-1', activity: { kind: 'subagent', name: 'Explore' } },
    cause: { kind: 'hook', event: 'SubagentStart', detail: 'Explore' },
  });
  machine.record({
    to: 'working',
    entry: { op: 'close', entryId: 'ag-1' },
    cause: { kind: 'hook', event: 'SubagentStop', detail: 'Explore' },
  });
  machine.record({
    to: 'working',
    entry: { op: 'open', entryId: 'el-1', activity: { kind: 'elicitation', name: 'notes' } },
    cause: { kind: 'hook', event: 'Elicitation', detail: 'asked' },
  });
  machine.record({
    to: 'working',
    entry: { op: 'close', entryId: 'el-1' },
    cause: { kind: 'hook', event: 'ElicitationResult', detail: 'accept' },
  });
  machine.record({
    to: 'working',
    entry: { op: 'open', entryId: 'compaction', activity: { kind: 'compacting', name: null } },
    cause: { kind: 'hook', event: 'PreCompact', detail: 'auto' },
  });
  machine.record({
    to: 'working',
    entry: { op: 'close', entryId: 'compaction' },
    cause: { kind: 'hook', event: 'PostCompact', detail: 'auto' },
  });
  machine.record({
    to: 'idle',
    entry: { op: 'background', entryId: 'tu-1' },
    cause: { kind: 'sdk-message', event: 'system/task_updated', detail: 'backgrounded' },
  });
  machine.record({
    to: 'interrupted',
    cause: { kind: 'control', event: 'interrupt_requested', detail: 'stop' },
  });
  machine.record({ to: 'errored', cause: { kind: 'hook', event: 'StopFailure', detail: 'api_error' } });
  machine.record({ to: 'idle', cause: { kind: 'hook', event: 'Stop', detail: 'the turn ended cleanly' } });
  machine.record({
    to: 'ended',
    entry: { op: 'abandon-open', reason: 'still open at the end' },
    cause: { kind: 'process', event: 'process_ended', detail: 'the stream completed' },
  });
}

test('every retained transition names a cause — asserted on the store, not on the emitter', () => {
  const store = new TransitionStore();
  const machine = build();
  store.attach(machine);
  driveWholeLife(machine, 'sess-1');

  const all = store.all();
  // Positive control on the selector: a zero-violation result over an empty set proves nothing.
  assert.ok(all.length >= 15, `the store looks empty: ${all.length} transitions`);

  const uncaused = all.filter(
    (transition) =>
      transition.cause === undefined ||
      typeof transition.cause.event !== 'string' ||
      transition.cause.event.length === 0 ||
      typeof transition.cause.kind !== 'string',
  );
  assert.deepEqual(uncaused, [], 'a transition with no cause is a state nobody can explain');
});

test('every state in the model is reachable, and every activity kind is entered', () => {
  const store = new TransitionStore();
  const machine = build();
  store.attach(machine);
  driveWholeLife(machine, 'sess-1');

  const states = new Set<SessionState>(store.all().map((transition) => transition.to));
  const missingStates = SESSION_STATES.filter((state) => !states.has(state));
  assert.deepEqual(missingStates, [], 'an unreachable state is either dead code or a lying trace');

  const activities = new Set<ActivityKind>(
    store
      .all()
      .map((transition) => transition.activity?.kind)
      .filter((kind): kind is ActivityKind => kind !== undefined),
  );
  const missingActivities = ACTIVITY_KINDS.filter((kind) => !activities.has(kind));
  assert.deepEqual(missingActivities, [], 'an activity nothing can enter is a word, not a state');
});

test('a clean turn end is recorded for the session — the record a single status word loses', () => {
  const store = new TransitionStore();
  const machine = build();
  store.attach(machine);
  driveWholeLife(machine, 'sess-1');

  const cleanEnds = store
    .forSession('sess-1')
    .filter((transition) => transition.to === 'idle' && transition.cause.event === 'Stop');
  assert.equal(cleanEnds.length, 1, 'a session that finished a turn must say so');
});

test('regression: every session produces the same trace, however it was made and whoever is watching', () => {
  // The regression this model exists to prevent: one class of session having its state record
  // suppressed by a guard that was correct about something else, silently. So: sessions that
  // differ in every way this host can differ, driven by one script that cannot see the
  // difference, must produce byte-identical traces once ids and timestamps are set aside.
  const variants: { name: string; machine: SessionStateMachine; observers: number }[] = [
    { name: 'no observers at all', machine: build(), observers: 0 },
    { name: 'one observer', machine: build(), observers: 1 },
    { name: 'many observers', machine: build(), observers: 5 },
    { name: 'a controller correlation id', machine: build('corr-x'), observers: 0 },
    {
      name: 'a different worktree and branch',
      machine: build(null, { cwd: '/other', worktree: '/other', branch: 'topic', unknownReason: null }),
      observers: 2,
    },
    {
      name: 'not in a repository at all',
      machine: build(null, {
        cwd: '/plain',
        worktree: null,
        branch: null,
        unknownReason: 'not inside a git repository',
      }),
      observers: 0,
    },
  ];

  const shapes = variants.map((variant) => {
    const store = new TransitionStore();
    store.attach(variant.machine);
    for (let index = 0; index < variant.observers; index += 1) variant.machine.onTransition(() => undefined);
    driveWholeLife(variant.machine, `sess-${variant.name}`);

    return {
      name: variant.name,
      shape: store.all().map((transition) => ({
        seq: transition.seq,
        from: transition.from,
        to: transition.to,
        activity: transition.activity,
        entryId: transition.entryId,
        kind: transition.cause.kind,
        event: transition.cause.event,
      })),
    };
  });

  // Positive control on the selector: identical empty traces would satisfy the comparison below.
  assert.ok(shapes[0] !== undefined && shapes[0].shape.length >= 15, 'the reference trace is empty');

  for (const other of shapes.slice(1)) {
    assert.deepEqual(
      other.shape,
      shapes[0]?.shape,
      `"${other.name}" produced a different trace — some session class is being treated as exempt`,
    );
  }
});

test('a zero-observer session is retained in full — the class a listener-count guard would exempt', () => {
  const store = new TransitionStore();
  const machine = build();
  store.attach(machine);
  // No onTransition listener beyond the store's own. Nothing is watching this session.
  driveWholeLife(machine, 'unwatched');

  assert.ok(
    store.forSession('unwatched').length >= 15,
    'a session nobody is watching still has to say what it did',
  );
  assert.equal(
    store.forSession('unwatched').filter((transition) => transition.cause.event === 'Stop').length,
    1,
  );
});

test('transitions recorded before the agent named itself are re-keyed under the id it reports', () => {
  const store = new TransitionStore();
  const machine = build('corr-adopt');
  store.attach(machine);

  machine.record({ to: 'spawning', cause: control('asked for a process') });
  machine.record({ to: 'spawning', cause: control('a turn was queued') });
  assert.equal(store.unidentified().length, 2, 'there really is a window with no id — that is honest');

  machine.record({
    to: 'ready',
    sessionId: 'sess-late',
    cause: { kind: 'sdk-message', event: 'system/init', detail: 'named itself' },
  });

  assert.equal(store.unidentified().length, 0);
  assert.deepEqual(
    store.forSession('sess-late').map((transition) => transition.seq),
    [1, 2, 3],
    "a session's own start must be readable by its own id",
  );
});

test('refused transitions are retained too, so "all caused" cannot be earned by discarding the counter-examples', () => {
  const store = new TransitionStore();
  const machine = build();
  store.attach(machine);

  machine.record({ to: 'working', cause: { kind: 'hook', event: 'NopeNotReal' as never, detail: 'x' } });

  assert.equal(store.all().length, 0);
  assert.equal(store.rejected().length, 1);
  assert.equal(store.rejected()[0]?.refusal.reason, 'transition-cause-unnamed');
});

test('a full window says how many it dropped rather than reading as a quiet session', () => {
  const store = new TransitionStore({ windowPerSession: 3 });
  const machine = build();
  store.attach(machine);

  for (let index = 0; index < 6; index += 1) {
    machine.record({ to: 'working', sessionId: 'sess-busy', cause: control(`turn ${index}`) });
  }

  assert.equal(store.forSession('sess-busy').length, 3);
  assert.equal(store.droppedCount, 3, 'a bounded window that hides its losses is a lying store');
});

test('two machines in one store stay separate sessions', () => {
  const store = new TransitionStore();
  const first = build();
  const second = build();
  store.attach(first);
  store.attach(second);

  driveWholeLife(first, 'sess-a');
  driveWholeLife(second, 'sess-b');

  assert.deepEqual(store.sessionIds().sort(), ['sess-a', 'sess-b']);
  assert.equal(store.forSession('sess-a').length, store.forSession('sess-b').length);
});

// ---------------------------------------------------------------------------
// The rejections are bounded on the same terms as the transitions.
// ---------------------------------------------------------------------------

// The asymmetry that would make this a defect: transitions in a per-session window with a drop
// count beside rejections in an uncapped array — so under a source that refuses steadily, the
// counter-examples would be the collection that grows without limit. Only tests feeding `record()`
// keeps that latent; a wire path feeding it makes the rate a stranger's to set.
test('regression: rejections are bounded, and the ones that fall out are counted rather than forgotten', () => {
  const store = new TransitionStore({ windowPerSession: 3 });
  const machine = build();
  store.attach(machine);

  for (let index = 0; index < 10; index += 1) {
    machine.record({
      to: 'working',
      cause: { kind: 'hook', event: 'NopeNotReal' as never, detail: `x${index}` },
    });
  }

  assert.equal(store.rejected().length, 3, 'the window holds, rather than growing with the refusals');
  assert.equal(store.droppedRejectionCount, 7, 'and a full window does not read as a quiet one');
  assert.equal(
    store.rejected().at(-1)?.attempted.cause.detail,
    'x9',
    'the newest are kept — the oldest refusal is the least useful one',
  );
});

// Counted separately on purpose: transitions falling out is an ordinary busy session, rejections
// falling out means something is refusing faster than anyone is reading. One number would hide it.
test('the two drop counters are independent, so a busy session cannot mask a refusing one', () => {
  const store = new TransitionStore({ windowPerSession: 2 });
  const machine = build();
  store.attach(machine);

  for (let index = 0; index < 5; index += 1) {
    machine.record({ to: 'working', sessionId: 'sess-1', cause: control(`turn ${index}`) });
  }
  assert.ok(store.droppedCount > 0);
  assert.equal(store.droppedRejectionCount, 0, 'nothing was refused, and the counter says so');
});
