/**
 * The gate: `options.hooks.PreToolUse` as the permission mechanism.
 *
 * Why the hook and not `canUseTool`, settled by execution rather than by reading. The hook fires
 * for every tool call — MCP tools and calls inside spawned subagents included, carrying
 * `agent_id`/`agent_type`. `canUseTool` is shadowed by a settings-file allow rule, by
 * `allowedTools`, and by `bypassPermissions` (which additionally emits
 * `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` on stderr and does not call it). Those are configurations an
 * embedder chooses, so a gate built on `canUseTool` would silently not run on somebody else's setup
 * — and a refusal that does not happen leaves no trace saying so.
 *
 * A hook that throws is fail-open. The CLI treats a throwing handler as absent rather than as a
 * denial, so under `bypassPermissions` — where nothing else is left to say no — a bug in this file
 * would be an open door. Every path here is inside a `try/catch` that returns an explicit
 * `permissionDecision: 'deny'`. This is not defensive style; it is the difference between
 * fail-closed and fail-open, and `gate.test.ts` pins it by throwing on purpose.
 *
 * The emission is unconditional and sits outside the deny path. A gate that fails closed must
 * still say that it did — otherwise the invariant holds while the trace goes silent, and a denial
 * becomes indistinguishable from an outage. So the outcome is computed on both paths, emitted once,
 * and only then converted to a hook output; and the emission has its own guard, because a listener
 * that throws must not be able to convert a deny back into an absent hook.
 *
 * An allow returns no opinion by default, never an explicit `permissionDecision: 'allow'`. This
 * gate exists to add a refusal, never to remove one — two mechanisms, one invariant.
 *
 * What an explicit allow actually skips. The Claude Code permissions documentation states that a
 * PreToolUse hook's decision does not bypass permission rules: deny and ask rules are evaluated
 * whatever the hook returned. So an allow from this gate leaves the operator's deny and ask rules
 * standing and skips only the permission mode, the allow rules and `canUseTool`. Source:
 * https://code.claude.com/docs/en/permissions#extend-permissions-with-hooks
 *
 * That order is documented, not measured, and this package treats the two differently: the runtime
 * beats the docs, and this module exists because executing something found what the documentation
 * denied. The probe that would settle it is written in `gate.live.test.ts` ("does a hook allow
 * override an operator deny rule?") and is not exercised: attempts to run it from inside an agent
 * session were contaminated by the enclosing tool surface, so the denied tool was never the one
 * called. Do not restate this paragraph as a measured claim without that receipt.
 *
 * Without `grantOnAllow` the gate is a veto rather than a gate, which was observed rather than
 * inferred. Saying nothing leaves the agent's own permission mode as the decider, and an embedder
 * who loads no settings files — the default, and the only posture under which this host can state
 * what an agent's permissions are — has left nobody who can say yes. On a real session the gate
 * allowed a `Write`, the tool did not run, and the result read "Claude requested permissions to
 * write to …, but you haven't granted it yet" — in a host with no user to grant anything.
 * `grantOnAllow` does not weaken this gate; it makes the decision this gate already made take
 * effect, one call at a time, for exactly the calls it approved.
 *
 * Two deadlines, and the inner one belongs to this host. `HookCallbackMatcher.timeout` is
 * per-matcher, in seconds, and expires fail-closed on CLI 2.1.210 and later — but the CLI enforces
 * it, so this handler never learns it happened and the trace would show nothing at all. So the
 * host runs its own shorter deadline: it fires first, blocks, and names the expiry; the matcher's
 * remains as the backstop for the case where this code is the thing that hung.
 */
import type {
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  HookRegistrations,
} from '../host/agent-process.js';
import type { Refusal, RefusalReason } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import { HOOK_TIMEOUT_EVENT } from '../state/model.js';
import type { Decider, DecisionRequest } from './decision.js';
import { describeRaw, readDecision } from './decision.js';
import type { GateOutcome } from './outcome.js';
import { EscalationUnavailable } from './escalate.js';
import type { LocalGate } from './local.js';

/** Told about every outcome — allows, denials, outages, expiries. Never only the interesting ones. */
export type OutcomeListener = (outcome: GateOutcome) => void;

/**
 * An outcome that ends a decision. A hold is not one: it is emitted while a decision is still
 * outstanding, and something else terminates it later.
 *
 * Naming it rather than leaving it implied is what lets `outputFor` refuse the hold at compile time.
 */
type TerminalOutcome = Exclude<GateOutcome, { kind: 'holding' }>;

export interface PermissionGateOptions {
  readonly decide: Decider;
  readonly onOutcome: OutcomeListener;
  /**
   * The controller's handle for this session — carried onto every decision request.
   *
   * Required rather than optional on purpose: a gate composed without it would send escalations a
   * controller cannot route, and an optional field defaulting to `''` would make that failure
   * silent. Every construction site already has the value. See `DecisionRequest.sessionKey`.
   */
  readonly sessionKey: string;
  /**
   * The host's own gate, consulted before anything is asked of anyone. Optional; absent means the
   * gate behaves exactly as it did without it.
   *
   * The order is the point, not an optimisation. A local policy consulted after the decider would
   * still block a boundary command, but only by waiting out a 50-second deadline and reporting
   * `permission-decision-unavailable` — an outage, which is not what happened. Consulted first, an
   * unreachable controller is never asked at all and the refusal is immediate, local and named.
   * That is the difference between "refused" and "deferred, and eventually nothing", and it is the
   * property somebody deciding whether to install this package actually checks.
   *
   * It returns a refusal rather than a decision, and that is the audit contract. A `deny` decision
   * is recorded `control/permission_denied` — the same cause a controller's deny produces — so a
   * locally-decided refusal expressed that way would be indistinguishable from a remote one except
   * by free text nobody branches on. A `Refusal` becomes `refusal/<reason>` on the transition, which
   * separates the three cases that must never blur: somebody decided, this host decided, nobody
   * decided.
   */
  readonly localGate?: LocalGate;
  /**
   * How long the host waits for a decision before blocking and saying so. Milliseconds.
   *
   * Kept meaningfully below `matcherTimeoutSeconds` so this handler is the one that expires. If the
   * matcher's timeout fired first the tool would still be blocked — the CLI is fail-closed — but
   * nothing would be recorded, and a block nobody can explain reads as a hang. Enforced at
   * construction: `permissionHooks` refuses a pair where this does not expire first.
   */
  readonly decisionTimeoutMs?: number;
  /** After this long with no answer, the call is reported as held. Milliseconds. */
  readonly holdAfterMs?: number;
  /** Handed to the CLI as the matcher's own timeout. Seconds — the SDK's unit, not this package's. */
  readonly matcherTimeoutSeconds?: number;
  /**
   * Make an allow effective, rather than silent. Defaults to false.
   *
   * Off by default, and on is a decision with a named cost. An effective allow skips the
   * permission mode, the allow rules and `canUseTool`. With no settings
   * files loaded, the only one of those with anything to say is the agent's own permission mode,
   * which has nobody to answer it, so skipping it is the whole point.
   *
   * It does not skip operator deny or ask rules; the documentation states those are evaluated
   * whatever a hook returns (see this module's header for the source and for why that is documented
   * rather than measured). The `composeSession` refusal on this flag plus `settingSources` therefore
   * guards two authorities with no stated precedence, not a bypass.
   *
   * An embedder who composes by hand and leaves this off gets a gate that cannot say yes: the tool
   * simply does not run and the agent reports a permission it was never going to be granted. That
   * case raises `gate-cannot-grant` through `onDegrade` on the first allow that does not take
   * effect.
   */
  readonly grantOnAllow?: boolean;
  /**
   * A named degrade, raised at most once per gate.
   *
   * A degrade is a named outcome, not a comment. The `grantOnAllow`-off residual is raised where an
   * embedder hits it — a running session in which every approved tool call silently fails to
   * happen — rather than only documented where an installer reads. Optional: an embedder who does
   * not pass it gets exactly the previous behaviour, so this adds an observation and never a
   * requirement.
   *
   * `name` is a `RefusalReason`, not a free string — so a degrade cannot be invented at the call
   * site. Adding one means declaring it in `core/refusal.ts` beside every other named outcome, which
   * is what keeps the vocabulary a vocabulary.
   */
  readonly onDegrade?: (degrade: { readonly name: RefusalReason; readonly detail: string }) => void;
}

const DEFAULT_MATCHER_TIMEOUT_SECONDS = 60;
const DEFAULT_DECISION_TIMEOUT_MS = 50_000;

/**
 * The two-deadline invariant, as one declaration with two consumers.
 *
 * It is a function rather than a repeated `if` because two enforcement points for one rule drift
 * apart: `permissionHooks` throws on an inverted pair for an embedder, and `composeSession` must
 * refuse on one for a controller. So the rule lives here and both read it.
 *
 * Returns the explanation when the pair is invalid, or null when it is fine. The caller decides
 * whether that becomes a throw or a named refusal — which is the only thing the two sites disagree
 * about, and it is a decision about audience rather than about the rule.
 */
export function deadlineOrderRefusal(
  decisionTimeoutMs: number | undefined,
  matcherTimeoutSeconds: number | undefined,
): string | null {
  const decision = decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  const matcher = matcherTimeoutSeconds ?? DEFAULT_MATCHER_TIMEOUT_SECONDS;
  if (decision < matcher * 1000) return null;
  return (
    `decisionTimeoutMs (${decision}ms) must be below matcherTimeoutSeconds ` +
    `(${matcher}s = ${matcher * 1000}ms). The host's own deadline must expire first: if the matcher ` +
    'expires first the tool is still blocked, but nothing is recorded and the block reads as a hang — ' +
    'the exact failure this gate exists to avoid.'
  );
}
/**
 * 250ms. Below this, opening and closing a permission entry records a session as "waiting" for
 * less time than it takes to read the record — noise in the one signal the entry exists to carry.
 */
const DEFAULT_HOLD_AFTER_MS = 250;

/**
 * The `PreToolUse` registration for a session's gate.
 *
 * Register this after `observationHooks()` — `mergeHooks(observationHooks(…), permissionHooks(…))`.
 * Handlers on one event have their synchronous prologues run in array order and are then awaited
 * concurrently (measured; `mergeHooks`'s own "earlier arguments run first" describes dispatch, not
 * completion). The order is a convention, not a race guard: this gate opens its `permission` entry
 * only from the hold timer (`holdAfterMs`, 250ms by default), after every same-event synchronous
 * prologue has finished — so under either order the observer's `PreToolUse` check runs before any
 * hold entry from this event exists, and cannot close one. Across events the guard is the key, not
 * the timing: the hold entry is keyed by tool_use_id (`gate/outcome.ts`), so a later `PreToolUse`
 * for the same tool — whose observer branch closes name-keyed permission entries — cannot close a
 * hold whose decision is still outstanding.
 *
 * No `matcher` is set. A matcher filters by tool name, and every tool call must reach the gate.
 */
export function permissionHooks(options: PermissionGateOptions): HookRegistrations {
  const decisionTimeoutMs = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  const holdAfterMs = options.holdAfterMs ?? DEFAULT_HOLD_AFTER_MS;
  const matcherTimeoutSeconds = options.matcherTimeoutSeconds ?? DEFAULT_MATCHER_TIMEOUT_SECONDS;

  // The two-deadline invariant, enforced where it still can be. A pair where the matcher expires
  // first would still block the tool — the CLI is fail-closed — but this handler would never learn
  // it happened: no outcome, no transition, and a trace showing a `tool` and a `permission` entry
  // opened and never closed. Refused rather than clamped: a silent clamp would alter a value the
  // embedder stated, and this happens before any session exists, so failing fast is safe.
  const inverted = deadlineOrderRefusal(decisionTimeoutMs, matcherTimeoutSeconds);
  if (inverted !== null) throw new Error(inverted);

  // Per gate, not per call — see the degrade's own note on why it fires once.
  let grantDegradeRaised = false;

  const emit = (outcome: GateOutcome): void => {
    try {
      options.onOutcome(outcome);
    } catch {
      // A listener that throws must not reach the CLI as a thrown hook, because a thrown hook is an
      // absent hook and the tool would run. Losing one record is bad; losing the refusal is worse.
    }
  };

  const handler = async (
    input: HookInput,
    _toolUseId: string | undefined,
    hookOptions: { signal: AbortSignal },
  ) => {
    // The hold flag lives here, outside decide(), so the recovery below can tell the truth about
    // whether a hold entry was opened. A hardcoded `held: false` in the catch would leave any
    // opened entry with no close — the invariant would hold while the trace showed a session
    // eternally waiting on a decision that was in fact refused.
    const held = { value: false };
    let outcome: TerminalOutcome;
    try {
      if (input.hook_event_name !== 'PreToolUse') return {};
      outcome = await decide(
        input,
        options.decide,
        emit,
        hookOptions.signal,
        decisionTimeoutMs,
        holdAfterMs,
        held,
        options.localGate,
        options.sessionKey,
      );
    } catch (error) {
      // The fail-open hole, closed. Anything at all that escaped above — a bug in this file, a
      // decider that threw synchronously, a request that could not be read — becomes an explicit
      // refusal rather than an absent hook.
      outcome = {
        kind: 'refused',
        request: readRequest(input, options.sessionKey) ?? unreadableRequest(options.sessionKey),
        held: held.value,
        refusal: refusal('permission-decision-unavailable', `the gate itself failed: ${String(error)}`),
      };
    }

    emit(outcome);

    // The silent failure, made audible — once. An allow the CLI will not act on is the shape of
    // this gate's worst outcome: the call is approved, the tool does not run, and the agent is told
    // it lacks a permission nobody was ever going to grant. Raised on the first occurrence only,
    // because a session that hits this hits it on every approved call and a degrade per call would
    // bury the signal it exists to carry.
    if (outcome.kind === 'allow' && !(options.grantOnAllow ?? false) && !grantDegradeRaised) {
      grantDegradeRaised = true;
      try {
        options.onDegrade?.({
          name: 'gate-cannot-grant',
          detail:
            `the gate ALLOWED ${outcome.request.toolName} but grantOnAllow is off, so the allow is silent and the ` +
            `tool will not run — this gate can refuse a call and cannot let one through. Set grantOnAllow, or ` +
            `expect every approved call to fail as an ungranted permission.`,
        });
      } catch {
        // Same reason `emit` swallows: a listener that throws must not reach the CLI as a thrown
        // hook, because a thrown hook is an absent hook and the tool would then run.
      }
    }

    return outputFor(outcome, options.grantOnAllow ?? false);
  };

  const matcher: HookCallbackMatcher = {
    hooks: [handler],
    timeout: matcherTimeoutSeconds,
  };

  return { PreToolUse: [matcher] };
}

// ---------------------------------------------------------------------------

/**
 * Ask, with a hold report and a deadline. Every return is a terminal outcome.
 *
 * The decider is started before either timer, so a fast answer never pays for the hold machinery.
 *
 * `held` is the caller's box, not a local: the handler's own catch reads it, so even a throw this
 * function does not anticipate reports whether a hold entry was opened — and the terminal outcome
 * then closes it instead of orphaning it.
 */
async function decide(
  input: Extract<HookInput, { hook_event_name: 'PreToolUse' }>,
  ask: Decider,
  emit: (outcome: GateOutcome) => void,
  signal: AbortSignal,
  decisionTimeoutMs: number,
  holdAfterMs: number,
  held: { value: boolean },
  localGate: LocalGate | undefined,
  sessionKey: string,
): Promise<TerminalOutcome> {
  const request = readRequest(input, sessionKey);
  if (request === null) {
    // The gate cannot say which tool this is, so it cannot authorize it. Blocking is the only
    // answer that does not amount to permitting an unidentified call.
    return {
      kind: 'refused',
      request: unreadableRequest(sessionKey),
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
    // never answers, the deadline never fires, and this handler never returns: the tool call has no
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
    // Both timers are cleared however this returned. A hook handler runs once per tool call, so a
    // timer left armed here is a slow leak that only shows up on a long session. The abort listener
    // is detached for the same reason and in the same place — one exit, three things released.
    if (holdTimer !== undefined) clearTimeout(holdTimer);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (abortListener !== undefined) {
      // A signal that does not implement removal must not turn a resolved decision into a thrown
      // hook, which the CLI reads as an absent one.
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
    return { kind: 'deny', request, held, message: reading.decision.message };
  }

  const { updatedInput } = reading.decision;
  return { kind: 'allow', request, held, ...(updatedInput === undefined ? {} : { updatedInput }) };
}

/** Everything unknown, for an input that could not be read at all. Never a thrown alternative. */
function unreadableRequest(sessionKey: string): DecisionRequest {
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
  };
}

/**
 * The hook's input in this package's terms, or null if it could not be read at all.
 *
 * The recovery path must not use the thing that broke. This is called from the handler's own
 * `catch`, so if reading the input is what threw, an unguarded read here throws a second time —
 * inside the catch — and the whole handler escapes as a thrown hook, which the CLI treats as
 * absent. A fail-closed wrapper whose recovery path can fail is fail-open, and it looks completely
 * correct.
 *
 * Null rather than a filled-in default, because the two are not the same answer. An input this
 * code cannot read names a tool it cannot name, and asking a decider to authorize "(unnamed tool)"
 * would get a decision about nothing. An unnameable call is not an authorizable one.
 */
function readRequest(input: HookInput, sessionKey: string): DecisionRequest | null {
  try {
    const anyInput = input as Partial<Record<string, unknown>>;
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    return {
      toolName: text(anyInput['tool_name']) ?? '(unnamed tool)',
      toolUseId: text(anyInput['tool_use_id']) ?? '(no tool_use_id)',
      toolInput: anyInput['tool_input'],
      sessionId: text(anyInput['session_id']) ?? '',
      // Never read from the input: the agent does not know what its controller calls this session.
      sessionKey,
      cwd: text(anyInput['cwd']) ?? '',
      // `agent_id` is the discriminator, not `agent_type`: the type is also present on the main
      // thread of a session started with --agent, so reading it alone calls a main-thread call a
      // subagent one.
      agentId: text(anyInput['agent_id']),
      agentType: text(anyInput['agent_type']),
    };
  } catch {
    return null;
  }
}

/**
 * What the CLI is told.
 *
 * Every blocking outcome carries a reason that names which rule fired — a degrade is a named
 * outcome, and the model receives this string verbatim as an `is_error` tool result, so it is the
 * only explanation anyone downstream gets.
 *
 * `holding` is excluded by the type, not by a branch. A hold is emitted while a decision is
 * outstanding; it is never a terminal outcome, so it can never be what this function renders. A
 * branch returning `{}` for it — no opinion, which the CLI reads as allow — would be the one branch
 * that could open the door while looking most harmless. Narrowing the parameter makes that state
 * unrepresentable: the compiler refuses it, where a safer return value would only have waited to
 * be simplified back.
 */
function outputFor(
  outcome: Exclude<GateOutcome, { kind: 'holding' }>,
  grantOnAllow: boolean,
): HookJSONOutput {
  if (outcome.kind === 'allow') {
    if (grantOnAllow) {
      // The gate's own decision, made effective. It grants this call and nothing else: the decision
      // was already taken above, and this only stops it from being silently discarded.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `the host's gate allowed ${outcome.request.toolName}`,
          ...(outcome.updatedInput === undefined ? {} : { updatedInput: outcome.updatedInput }),
        },
      };
    }

    if (outcome.updatedInput === undefined) return {};
    // No `permissionDecision`. See this file's header: an explicit allow skips permission mode,
    // allow rules and `canUseTool` (steps 4-6; operator deny and ask rules still run), so without
    // `grantOnAllow` this gate only ever adds a refusal.
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: outcome.updatedInput,
      },
    };
  }

  const reason =
    outcome.kind === 'deny'
      ? outcome.message
      : outcome.kind === 'refused'
        ? `${outcome.refusal.reason}: ${outcome.refusal.detail}`
        : // One spelling for one concept: the same name the transition carries, so a reader who
          // looks this prefix up finds it.
          `${HOOK_TIMEOUT_EVENT}: ${outcome.detail}`;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export { describeRaw };
