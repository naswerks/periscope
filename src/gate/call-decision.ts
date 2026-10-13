/**
 * One tool call, decided: the host's own gate first, then the decider under the host's deadline, then
 * the outcome emitted exactly once. Every runtime's gate asks through this — Claude's `PreToolUse`
 * callback, the hook channel a runtime's own hook process asks over, and a runtime's approval channel —
 * so a call is decided by the same local rules, the same decider, the same deadlines and the same
 * outcome record wherever it came from.
 *
 * It never rejects. A decision that cannot be obtained is a refusal, a decision that does not arrive is
 * an expiry, and a decision this build cannot read is a refusal: each is a terminal outcome the caller
 * renders as a block. A caller that awaited a rejection would have to choose what to tell its runtime,
 * and every runtime this package drives treats a missing answer as permission somewhere.
 */
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import type { Decider, DecisionRequest } from './decision.js';
import { readDecision } from './decision.js';
import type { GateOutcome, TerminalOutcome } from './outcome.js';
import { EscalationUnavailable } from './escalate.js';
import type { LocalGate } from './local.js';

/** Decides one call. Null is a call whose input could not be read, which is refused. Never rejects. */
export type CallDecision = (request: DecisionRequest | null, signal: AbortSignal) => Promise<TerminalOutcome>;

export interface CallDecisionOptions {
  readonly decide: Decider;
  /** Told about every outcome, the hold included, exactly once each. A listener that throws loses that record only. */
  readonly onOutcome: (outcome: GateOutcome) => void;
  /** The controller's handle, carried by the placeholder request for an unreadable call. */
  readonly sessionKey: string;
  /** The session's runtime, carried by the placeholder request for an unreadable call. */
  readonly runtime: string;
  /** The host's own gate, consulted before anything is asked of anyone. */
  readonly localGate?: LocalGate;
  /** How long the host waits for a decision before blocking and saying so. Milliseconds. */
  readonly decisionTimeoutMs: number;
  /** After this long with no answer, the call is reported as held. Milliseconds. */
  readonly holdAfterMs: number;
  /**
   * Whether the runtime can run a call with the arguments an allow rewrote. Defaults to true. False for
   * a runtime whose hook can only proceed or block: an allow that rewrites the input is then refused,
   * because carrying out the half of it the runtime can carry out would run the call with arguments
   * nobody approved.
   */
  readonly canRewriteInput?: boolean;
}

/** Build the per-call decision for one session. */
export function createCallDecision(options: CallDecisionOptions): CallDecision {
  const canRewriteInput = options.canRewriteInput ?? true;

  const emit = (outcome: GateOutcome): void => {
    try {
      options.onOutcome(outcome);
    } catch {
      // A listener that throws must not reach the runtime as a thrown decision: every runtime this
      // package drives reads a missing answer as permission somewhere. Losing one record is bad; losing
      // the refusal is worse.
    }
  };

  return async (request, signal) => {
    // The hold flag lives here, outside the decision, so the recovery below can tell the truth about
    // whether a hold entry was opened. A hardcoded `held: false` in the catch would leave any opened
    // entry with no close — the invariant would hold while the trace showed a session eternally
    // waiting on a decision that was in fact refused.
    const held = { value: false };
    let outcome: TerminalOutcome;
    try {
      outcome = await decide(
        request,
        options.decide,
        emit,
        signal,
        options.decisionTimeoutMs,
        options.holdAfterMs,
        held,
        options.localGate,
        options.sessionKey,
        options.runtime,
      );
    } catch (error) {
      // The fail-open hole, closed. Anything at all that escaped above — a bug in this file, a decider
      // that threw synchronously — becomes an explicit refusal rather than an absent answer.
      outcome = {
        kind: 'refused',
        request: request ?? unreadableRequest(options.sessionKey, options.runtime),
        held: held.value,
        refusal: refusal('permission-decision-unavailable', `the gate itself failed: ${String(error)}`),
      };
    }

    if (!canRewriteInput && outcome.kind === 'allow' && outcome.updatedInput !== undefined) {
      outcome = {
        kind: 'refused',
        request: outcome.request,
        held: outcome.held,
        refusal: refusal(
          'permission-decision-unrecognised',
          `the decision for ${outcome.request.toolName} allows it with rewritten input, which this runtime ` +
            'cannot apply: its hook can only let a call proceed as asked or block it, so the call is refused ' +
            'rather than run with arguments nobody approved',
        ),
      };
    }

    emit(outcome);
    return outcome;
  };
}

/**
 * Ask, with a hold report and a deadline. Every return is a terminal outcome.
 *
 * The decider is started before either timer, so a fast answer never pays for the hold machinery.
 *
 * `held` is the caller's box, not a local: the caller's own catch reads it, so even a throw this
 * function does not anticipate reports whether a hold entry was opened — and the terminal outcome
 * then closes it instead of orphaning it.
 */
async function decide(
  request: DecisionRequest | null,
  ask: Decider,
  emit: (outcome: GateOutcome) => void,
  signal: AbortSignal,
  decisionTimeoutMs: number,
  holdAfterMs: number,
  held: { value: boolean },
  localGate: LocalGate | undefined,
  sessionKey: string,
  runtime: string,
): Promise<TerminalOutcome> {
  if (request === null) {
    // The gate cannot say which tool this is, so it cannot authorize it. Blocking is the only
    // answer that does not amount to permitting an unidentified call.
    return {
      kind: 'refused',
      request: unreadableRequest(sessionKey, runtime),
      held: false,
      refusal: refusal(
        'permission-decision-unavailable',
        'the hook input could not be read, so the call it describes has no name to decide about',
      ),
    };
  }

  // The host's own gate, before anything is asked of anyone. It is consulted here rather than
  // after the decider because a refusal that waits for an unreachable controller to time out is not
  // a refusal, it is a `decisionTimeoutMs` silence that ends in an outage report — and the property
  // this package states is that a locally refused call is refused immediately, by name.
  const localRefusal = askLocalGate(localGate, request);
  if (localRefusal !== null && localRefusal.reason !== 'shell-boundary-command') {
    // `held: false` is a fact, not a default: nothing has been armed yet, so no entry was opened.
    return { kind: 'refused', request, held: false, refusal: localRefusal };
  }
  // regression: a boundary-shaped shell command (publishing, remote surgery, branch deletion, a PR
  // merge) was refused here, in-process, before the controller was asked, so a controller that
  // holds such a call for a person could never deliver that answer and nothing on this host could
  // publish. A boundary shape is escalated like any other call; when the controller cannot be
  // reached the deadline below refuses it. Every other local refusal (the jail, the credential set,
  // an unrecognised git verb) stays local and immediate.

  // Both timers are armed inside the try whose finally disarms them. Between arming and the
  // `finally` there is no window a throw can cross with a timer left live — that is a structural
  // property of this block, not an audit of what happens to be between the lines.
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  try {
    const answer = (async (): Promise<unknown> => ask(request, signal))();
    // The promise is consumed by the race below; this keeps a rejection from being unhandled in the
    // window before the race attaches, which node reports as a process-level warning.
    answer.catch(() => undefined);

    holdTimer = setTimeout(() => {
      held.value = true;
      emit({ kind: 'holding', request });
    }, holdAfterMs);
    holdTimer.unref?.();

    // The deadline timer is ref'd, and that is the fail-closed guarantee itself.
    //
    // An unref'd timer here is the same bug as a gate that cannot say no. An unref'd timer does
    // not hold the event loop open, so a host with nothing else pending — exactly the state a host
    // is in while it waits for a decision — drains the loop before the deadline fires. The decider
    // never answers, the deadline never fires, and this function never returns: the tool call has no
    // fate at all, which is strictly worse than either answer.
    //
    // Observed on Linux: `gate.test.ts`'s "a decision that never arrives blocks" — the test that
    // proves this exact property — reported "Promise resolution is still pending but the event
    // loop has already resolved" and cancelled, taking its sibling tests with it. It passed on
    // win32 only because something else in that process happened to keep the loop alive; the
    // guarantee was never unconditional, and it is stated as unconditional.
    //
    // Holding the loop open is the correct cost. A tool call is in flight and undecided; a host
    // that exits underneath it has answered nothing. The bound is `decisionTimeoutMs`, and the
    // `finally` below clears the timer on every exit path, so nothing outlives the call. The
    // hold timer stays unref'd — it only emits an observation, and this deadline keeps the loop
    // alive for both.
    const deadline = new Promise<'expired'>((resolve) => {
      deadlineTimer = setTimeout(() => resolve('expired'), decisionTimeoutMs);
    });

    // A missing or hostile signal cannot escape: a throw inside a Promise executor rejects the
    // promise, and the race below carries that rejection into this function's own catch.
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted');
      else {
        // Held so the `finally` can detach it. `{once: true}` self-removes only when the event
        // fires, and the ordinary case is that it never does — so on a signal that outlives one tool
        // call, every call would leave a listener behind on it.
        abortListener = (): void => resolve('aborted');
        signal.addEventListener('abort', abortListener, { once: true });
      }
    });

    const settled = await Promise.race([
      answer.then((value) => ({ answered: value }) as const),
      deadline,
      aborted,
    ]);

    if (settled === 'expired') {
      return {
        kind: 'expired',
        request,
        held: held.value,
        detail: `no decision for ${request.toolName} within ${decisionTimeoutMs}ms; the tool did not run`,
      };
    }

    if (settled === 'aborted') {
      return {
        kind: 'refused',
        request,
        held: held.value,
        refusal: refusal(
          'permission-decision-unavailable',
          `the turn was cancelled while a decision for ${request.toolName} was outstanding`,
        ),
      };
    }

    return terminal(request, held.value, settled.answered);
  } catch (error) {
    // The decider rejected. An outage — nobody decided — and never a denial, which is why it is a
    // refusal reason rather than a deny with a borrowed message.
    const detail =
      error instanceof EscalationUnavailable
        ? error.message
        : `the decision for ${request.toolName} could not be obtained: ${String(error)}`;
    return {
      kind: 'refused',
      request,
      held: held.value,
      refusal: refusal('permission-decision-unavailable', detail),
    };
  } finally {
    // Both timers are cleared however this returned. A decision runs once per tool call, so a timer
    // left armed here is a slow leak that only shows up on a long session. The abort listener is
    // detached for the same reason and in the same place — one exit, three things released.
    if (holdTimer !== undefined) clearTimeout(holdTimer);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (abortListener !== undefined) {
      // A signal that does not implement removal must not turn a resolved decision into a thrown
      // one, which every runtime reads as an absent answer.
      try {
        signal.removeEventListener('abort', abortListener);
      } catch {
        // Nothing to recover: the listener resolves a promise nobody is waiting on any more.
      }
    }
  }
}

/**
 * Ask the host's own gate, if there is one.
 *
 * A local gate that throws refuses. It must not fall through to the decider, and the wrong
 * implementation here does not look wrong: falling through is not fail-open — the controller is
 * still asked — so nothing would break in a test and nothing would show in a trace. What it would do
 * is silently convert a local refusal into a remote question, which is the offline property
 * evaporating at the exact moment the controller is unreachable. The invariant is absolute: any
 * error, any outage, any timeout means the tool does not run.
 */
function askLocalGate(localGate: LocalGate | undefined, request: DecisionRequest): Refusal | null {
  if (localGate === undefined) return null;
  try {
    return localGate(request) ?? null;
  } catch (error) {
    return refusal(
      'permission-decision-unavailable',
      `the host's own gate failed while deciding ${request.toolName}, so the call is refused rather than escalated: ${String(error)}`,
    );
  }
}

/** A settled answer, read. The unknown-decision rule lands here. */
function terminal(request: DecisionRequest, held: boolean, answered: unknown): TerminalOutcome {
  const reading = readDecision(answered);

  if (!reading.recognised) {
    return {
      kind: 'refused',
      request,
      held,
      refusal: refusal(
        'permission-decision-unrecognised',
        // The raw payload travels. A host that drops what it did not understand makes a
        // controller-side bug invisible on the only side that could have seen it.
        `the decision for ${request.toolName} was not one this build understands: ${reading.raw}`,
      ),
    };
  }

  if (reading.decision.behavior === 'deny') {
    return {
      kind: 'deny',
      request,
      held,
      message: reading.decision.message,
      ...(reading.decision.interrupt === true ? { interrupt: true } : {}),
    };
  }

  const { updatedInput } = reading.decision;
  return { kind: 'allow', request, held, ...(updatedInput === undefined ? {} : { updatedInput }) };
}

/** Everything unknown, for an input that could not be read at all. Never a thrown alternative. */
export function unreadableRequest(sessionKey: string, runtime: string): DecisionRequest {
  return {
    toolName: '(unnamed tool)',
    toolUseId: '(no tool_use_id)',
    toolInput: null,
    sessionId: '',
    // The one field that is still true when nothing else is. Everything above is a placeholder for
    // an input this code could not read; the controller handle comes from the host, not from that
    // input, so an unreadable call is still attributable to the session it happened in. That is the
    // difference between a refusal a controller can file and one it can only count.
    sessionKey,
    cwd: '',
    agentId: null,
    agentType: null,
    // A tool this code cannot name is a kind it cannot name either.
    toolKind: 'other',
    runtime,
  };
}
