/**
 * Turns the coverage table into the `options.hooks` object the SDK actually takes.
 *
 * Registration is derived from the table, not written beside it. The list of events registered
 * here is the list `coverage.ts` marks `wired`, so the table cannot claim an event is wired while
 * the wiring quietly lacks it. A table that can disagree with the code is a document that will.
 *
 * Every handler is wrapped, because a throwing hook is fail-open. A hook that throws is treated
 * by the CLI as absent rather than as a refusal (observed behaviour, not an assumption). For an
 * observer that would mean a lost transition and nothing else, which is precisely the silent loss
 * this model exists to prevent, so the wrapper is here and not left to the caller.
 *
 * This handler never decides anything. It returns an empty output on every path, including the
 * failure path. `HookCallbackMatcher.hooks` is an array and the SDK runs every entry, so a
 * permission-decision handler registers on the same event alongside this one; neither has to know
 * about the other, and observation cannot accidentally become authorization.
 */
import type { HookCallbackMatcher, HookInput, HookJSONOutput, HookRegistrations } from './agent-process.js';
import type { SessionObserver } from '../state/observer.js';
import { HOOK_COVERAGE } from '../state/coverage.js';
import { HOOK_EVENTS } from '../state/model.js';

/** Told about a handler that threw, so a fail-open hook is never a silent one. */
export type HookFailureListener = (failure: { event: string; error: unknown }) => void;

export interface ObservationHookOptions {
  readonly observer: SessionObserver;
  readonly onHandlerFailure?: HookFailureListener;
}

/** Every event the table marks `wired`, in the SDK's own order. */
export function wiredHookEvents(): readonly string[] {
  return HOOK_EVENTS.filter((event) => HOOK_COVERAGE[event].handling === 'wired');
}

/**
 * The `hooks` object for a session, registering exactly the wired events.
 *
 * No matcher is set: a matcher filters by tool name, and this observes every tool. The absence is
 * deliberate rather than an omission.
 */
export function observationHooks(options: ObservationHookOptions): HookRegistrations {
  const handler = (input: HookInput): Promise<HookJSONOutput> => {
    try {
      // The results are not read here. A transition the machine refuses is reported on
      // `machine.onRejected` and counted in `rejectedCount`, the one channel every refused record
      // takes whatever lane produced it; reporting it again from this handler would count one
      // refusal twice. The observer builds a request only for an event it names, so an event this
      // package does not know records nothing rather than producing a refusal to route.
      options.observer.observeHook(input);
    } catch (error) {
      // A throw here would make the CLI treat the hook as absent, which is the fail-open hole. It
      // is caught, reported, and never rethrown; losing one observation loudly beats losing the
      // handler entirely and silently. The listener is guarded too: a reporter that throws must
      // not reopen the hole it exists to report.
      try {
        options.onHandlerFailure?.({ event: input.hook_event_name, error });
      } catch {
        // Nothing further can be reported; the handler still answers.
      }
    }
    return Promise.resolve({});
  };

  // One matcher object per event. A shared instance would let a `timeout` or `matcher` set on one
  // event's entry apply to every event.
  const registrations: HookRegistrations = {};
  for (const event of HOOK_EVENTS) {
    if (HOOK_COVERAGE[event].handling !== 'wired') continue;
    const matcher: HookCallbackMatcher = { hooks: [handler] };
    registrations[event] = [matcher];
  }
  return registrations;
}

/**
 * Combine independent hook registrations, concatenating the matchers per event.
 *
 * This is the seam that keeps observation and authorization apart. A permission decision and a
 * state record answer different questions, have different consumers and fail differently, and the
 * failure this package is built against is exactly what happens when they share a guard: the
 * control concern wins, and the observability loss is silent. Two matchers on one event, merged
 * here, means neither can suppress the other because neither knows the other exists.
 *
 * "Earlier arguments run first" is true of dispatch and false of completion. Handlers on one
 * event have their synchronous prologues run in array order, and are then awaited concurrently
 * (observed behaviour, not an assumption). So a handler may rely on an earlier one having started
 * and must never rely on it having finished: anything order-dependent belongs before the first
 * `await`. (The
 * gate's permission entry opens from its hold timer, not in its prologue, so it depends on no
 * registration order; it registers second by convention.)
 */
export function mergeHooks(...registrations: readonly HookRegistrations[]): HookRegistrations {
  const merged: HookRegistrations = {};
  for (const registration of registrations) {
    for (const [event, matchers] of Object.entries(registration)) {
      const key = event as keyof HookRegistrations;
      merged[key] = [...(merged[key] ?? []), ...(matchers ?? [])];
    }
  }
  return merged;
}
