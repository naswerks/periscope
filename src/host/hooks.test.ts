/**
 * The observation hooks: registration is derived from the coverage table, every handler observes
 * and never decides, and a throwing observer is reported rather than allowed to make the hook
 * fail-open. `mergeHooks` is the seam that keeps observation and authorization on one event
 * without either knowing the other exists, so its order and its non-mutation are pinned too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixedClock, fixedTicker } from '../core/time.js';
import { HOOK_COVERAGE } from '../state/coverage.js';
import { SessionStateMachine } from '../state/machine.js';
import type { TransitionWhere } from '../state/model.js';
import { HOOK_EVENTS } from '../state/model.js';
import { SessionObserver } from '../state/observer.js';
import type { HookCallbackMatcher, HookInput, HookRegistrations } from './agent-process.js';
import { mergeHooks, observationHooks, wiredHookEvents } from './hooks.js';

const WHERE: TransitionWhere = {
  cwd: '/tmp/work',
  worktree: null,
  branch: null,
  unknownReason: 'not a repository',
};
const START_MS = Date.parse('2026-08-03T12:00:00.000Z');

function machine(): SessionStateMachine {
  return new SessionStateMachine({
    where: WHERE,
    clock: fixedClock(START_MS),
    ticker: fixedTicker(START_MS),
  });
}

const preToolUse = (toolName: string, toolUseId = 'call-1'): HookInput =>
  ({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: toolUseId,
    tool_input: { command: 'ls' },
    session_id: 'agent-1',
    cwd: '/tmp/work',
  }) as unknown as HookInput;

/** Run every handler on one event's matchers in array order, as the SDK dispatches them. */
async function dispatch(matchers: readonly HookCallbackMatcher[], input: HookInput): Promise<unknown[]> {
  const outputs: unknown[] = [];
  for (const matcher of matchers) {
    for (const handler of matcher.hooks) {
      outputs.push(await handler(input, 'call-1', { signal: new AbortController().signal }));
    }
  }
  return outputs;
}

const failing = new Error('the observer broke');

/** `SessionObserver` holds private fields, so a throwing observer has to be a subclass, not a literal. */
class ThrowingObserver extends SessionObserver {
  override observeHook(): never {
    throw failing;
  }
}

// --- observationHooks --------------------------------------------------------

test('the handler on a wired event observes the input and resolves empty; a PreToolUse puts the machine to work on the tool', async () => {
  const m = machine();
  const hooks = observationHooks({ observer: new SessionObserver(m) });
  const matchers = hooks.PreToolUse;
  assert.ok(matchers !== undefined, 'PreToolUse is wired, so it must be registered');

  const outputs = await dispatch(matchers, preToolUse('Bash'));

  assert.deepEqual(outputs, [{}], 'observation decides nothing, so the output is empty');
  assert.equal(m.state, 'working');
  assert.deepEqual(m.activity, { kind: 'tool', name: 'Bash' });
  assert.equal(m.openEntries()[0]?.entryId, 'call-1');
});

test('regression: a throwing observer still resolves empty, never rejects, and the failure listener hears the event and the error', async () => {
  const failures: { event: string; error: unknown }[] = [];
  const hooks = observationHooks({
    observer: new ThrowingObserver(machine()),
    onHandlerFailure: (failure) => failures.push(failure),
  });
  const matchers = hooks.PreToolUse;
  assert.ok(matchers !== undefined);

  const outputs = await dispatch(matchers, preToolUse('Bash'));

  assert.deepEqual(outputs, [{}], 'a throw must not reach the CLI, where it would read as an absent hook');
  assert.deepEqual(failures, [{ event: 'PreToolUse', error: failing }], 'contained is not silent');
});

test('a transition the machine refuses reaches machine.onRejected, the channel the handler does not duplicate', async () => {
  const state = machine();
  const rejected: unknown[] = [];
  state.onRejected((one) => rejected.push(one));
  const registrations = observationHooks({ observer: new SessionObserver(state) });

  // A wired event records, and nothing is refused: the results the handler discards were all ok.
  const outputs = await dispatch(registrations.PreToolUse ?? [], preToolUse('Bash'));
  assert.deepEqual(outputs, [{}]);
  assert.equal(rejected.length, 0);
  assert.equal(state.rejectedCount, 0);

  // An event this package does not name records nothing, so there is no refusal to route.
  const observer = new SessionObserver(state);
  assert.deepEqual(observer.observeHook({ hook_event_name: 'NotAnEvent' } as unknown as HookInput), []);
  assert.equal(rejected.length, 0);

  // The control: the one way a record is refused, an unnameable cause, is reported on the machine's
  // own channel and counted there, which is what makes discarding the handler's copy lossless.
  const refused = state.record({
    to: 'working',
    cause: { kind: 'hook', event: 'NotAnEvent', detail: 'planted' } as never,
  });
  assert.equal(refused.ok, false);
  assert.equal(rejected.length, 1, 'the refusal must reach onRejected');
  assert.equal(state.rejectedCount, 1);
});

test('without a failure listener a throwing observer still resolves empty', async () => {
  const hooks = observationHooks({ observer: new ThrowingObserver(machine()) });
  const matchers = hooks.PreToolUse;
  assert.ok(matchers !== undefined);

  await assert.doesNotReject(async () => {
    assert.deepEqual(await dispatch(matchers, preToolUse('Bash')), [{}]);
  });
});

test('exactly the wired events are registered, one matcher each, and no matcher property is set', () => {
  const hooks = observationHooks({ observer: new SessionObserver(machine()) });
  const fromTable = HOOK_EVENTS.filter((event) => HOOK_COVERAGE[event].handling === 'wired');

  assert.deepEqual(Object.keys(hooks), fromTable, 'registration is derived from the table, in its order');
  assert.deepEqual([...wiredHookEvents()], fromTable);
  assert.ok(fromTable.length > 0, 'an empty wired set would make the assertions above vacuous');

  for (const event of fromTable) {
    const matchers = hooks[event];
    assert.ok(matchers !== undefined);
    assert.equal(matchers.length, 1, `${event} registered ${matchers.length} matchers`);
    assert.equal('matcher' in matchers[0]!, false, `${event} carries a matcher, so it would filter by tool`);
    assert.equal(matchers[0]?.hooks.length, 1, `${event} registered ${matchers[0]?.hooks.length} handlers`);
  }

  const declined = HOOK_EVENTS.filter((event) => HOOK_COVERAGE[event].handling === 'declined');
  assert.ok(declined.length > 0);
  for (const event of declined) assert.equal(event in hooks, false, `${event} is declined but registered`);
});

// --- mergeHooks --------------------------------------------------------------

const matcherNamed = (label: string, order?: string[]): HookCallbackMatcher => ({
  hooks: [
    async () => {
      order?.push(label);
      return {};
    },
  ],
});

test('mergeHooks concatenates the matchers per event in argument order and unions disjoint events', () => {
  const first = matcherNamed('first');
  const second = matcherNamed('second');
  const stop = matcherNamed('stop');
  const end = matcherNamed('end');
  const observation: HookRegistrations = { PreToolUse: [first], Stop: [stop] };
  const authorization: HookRegistrations = { PreToolUse: [second], SessionEnd: [end] };

  const merged = mergeHooks(observation, authorization);

  assert.deepEqual(Object.keys(merged).sort(), ['PreToolUse', 'SessionEnd', 'Stop']);
  assert.equal(merged.PreToolUse?.[0], first, 'the earlier argument comes first');
  assert.equal(merged.PreToolUse?.[1], second);
  assert.equal(merged.PreToolUse?.length, 2);
  assert.deepEqual(merged.Stop, [stop]);
  assert.deepEqual(merged.SessionEnd, [end]);
});

test('mergeHooks ignores empty registrations and leaves its inputs untouched', () => {
  const first = matcherNamed('first');
  const second = matcherNamed('second');
  const left: HookRegistrations = { PreToolUse: [first] };
  const right: HookRegistrations = { PreToolUse: [second] };
  const leftMatchers = left.PreToolUse;

  const merged = mergeHooks({}, left, {}, right, {});

  assert.equal(merged.PreToolUse?.length, 2);
  assert.deepEqual(Object.keys(merged), ['PreToolUse'], 'an empty registration adds no event');
  assert.equal(left.PreToolUse, leftMatchers, 'the input array is the same object it was');
  assert.deepEqual(left, { PreToolUse: [first] });
  assert.deepEqual(right, { PreToolUse: [second] });
  assert.notEqual(
    merged.PreToolUse,
    left.PreToolUse,
    'the merged array is a new one, so a later push cannot leak back',
  );
  assert.deepEqual(mergeHooks(), {}, 'no registrations merge to none');
});

test("dispatch follows the merged array: the earlier argument's handler runs first", async () => {
  const order: string[] = [];
  const merged = mergeHooks(
    { PreToolUse: [matcherNamed('observation', order)] },
    { PreToolUse: [matcherNamed('authorization', order)] },
  );
  const matchers = merged.PreToolUse;
  assert.ok(matchers !== undefined);

  await dispatch(matchers, preToolUse('Bash'));

  assert.deepEqual(order, ['observation', 'authorization']);
});

test("control: merging in the other order reverses the dispatch, so the order above is the merge's and not the test's", async () => {
  const order: string[] = [];
  const merged = mergeHooks(
    { PreToolUse: [matcherNamed('authorization', order)] },
    { PreToolUse: [matcherNamed('observation', order)] },
  );
  const matchers = merged.PreToolUse;
  assert.ok(matchers !== undefined);

  await dispatch(matchers, preToolUse('Bash'));

  assert.deepEqual(order, ['authorization', 'observation']);
});

test('regression: a failure listener that throws does not escape the handler, so the hook never reads as absent', async () => {
  const hooks = observationHooks({
    observer: new ThrowingObserver(machine()),
    onHandlerFailure: () => {
      throw new Error('the reporter failed too');
    },
  });
  const output = await hooks.PreToolUse![0]!.hooks[0]!(preToolUse('Bash'), undefined, {
    signal: new AbortController().signal,
  });
  assert.deepEqual(output, {});
});

test('regression: every wired event gets its own matcher object, so a field set on one does not reach the others', () => {
  const hooks = observationHooks({ observer: new SessionObserver(machine()) });
  const matchers = wiredHookEvents().map((event) => hooks[event as keyof HookRegistrations]![0]!);
  assert.equal(new Set(matchers).size, matchers.length, 'two events share one matcher instance');
  (matchers[0] as HookCallbackMatcher & { timeout?: number }).timeout = 1;
  assert.equal((matchers[1] as HookCallbackMatcher & { timeout?: number }).timeout, undefined);
});
