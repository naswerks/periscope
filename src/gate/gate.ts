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
import type { RefusalReason } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import { DEFAULT_RUNTIME } from '../control/frames.js';
import { HOOK_TIMEOUT_EVENT } from '../state/model.js';
import type { Decider, DecisionRequest, ShellDialect } from './decision.js';
import { describeRaw } from './decision.js';
import type { GateOutcome, TerminalOutcome } from './outcome.js';
import { createCallDecision, unreadableRequest } from './call-decision.js';
import type { LocalGate } from './local.js';
import { claudeShellDialect, claudeToolKind } from './tool-kind.js';

/** Told about every outcome — allows, denials, outages, expiries. Never only the interesting ones. */
export type OutcomeListener = (outcome: GateOutcome) => void;

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
   * The runtime the session runs on, carried onto every decision request beside `sessionKey`.
   * Absent is `DEFAULT_RUNTIME`.
   */
  readonly runtime?: string;
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

export const DEFAULT_MATCHER_TIMEOUT_SECONDS = 60;
export const DEFAULT_DECISION_TIMEOUT_MS = 50_000;

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
export const DEFAULT_HOLD_AFTER_MS = 250;

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
  const runtime = options.runtime ?? DEFAULT_RUNTIME;

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

  // The decision itself is the one every runtime's gate asks through: the local gate, the decider under
  // the host's deadline, the hold report and the single emission of the outcome.
  const decideCall = createCallDecision({
    decide: options.decide,
    onOutcome: emit,
    sessionKey: options.sessionKey,
    runtime,
    ...(options.localGate === undefined ? {} : { localGate: options.localGate }),
    decisionTimeoutMs,
    holdAfterMs,
  });

  const handler = async (
    input: HookInput,
    _toolUseId: string | undefined,
    hookOptions: { signal: AbortSignal },
  ) => {
    let outcome: TerminalOutcome;
    try {
      if (input.hook_event_name !== 'PreToolUse') return {};
      // Emits its outcome, the hold included, and never rejects.
      outcome = await decideCall(readRequest(input, options.sessionKey, runtime), hookOptions.signal);
    } catch (error) {
      // The fail-open hole, closed. The decision never rejects, so what reaches here is reading the
      // input itself throwing — and that becomes an explicit refusal rather than an absent hook. No hold
      // was armed: the decision never started.
      outcome = {
        kind: 'refused',
        request:
          readRequest(input, options.sessionKey, runtime) ?? unreadableRequest(options.sessionKey, runtime),
        held: false,
        refusal: refusal('permission-decision-unavailable', `the gate itself failed: ${String(error)}`),
      };
      emit(outcome);
    }

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
function readRequest(input: HookInput, sessionKey: string, runtime: string): DecisionRequest | null {
  try {
    const anyInput = input as Partial<Record<string, unknown>>;
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    const toolName = text(anyInput['tool_name']) ?? '(unnamed tool)';
    return {
      toolName,
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
      // Read from the name by Claude's map, the tool names this hook carries; never left out.
      toolKind: claudeToolKind(toolName),
      // Supplied by the composer, like `sessionKey`: the session's runtime, not the agent's input.
      runtime,
      // The grammar the shell tool runs its command in, stated for the decider; absent for every other
      // tool. Data only: this host's own gate reads Claude's commands as it always has.
      ...dialectOf(toolName),
    };
  } catch {
    return null;
  }
}

/** `shellDialect` for a Claude shell tool, as a spread: absent, never null, for every other tool. */
function dialectOf(toolName: string): { readonly shellDialect?: ShellDialect } {
  const dialect = claudeShellDialect(toolName);
  return dialect === null ? {} : { shellDialect: dialect };
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
