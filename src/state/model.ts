/**
 * The declared state model — what a session is at a moment, and what caused it to become that.
 *
 * This is the one model. There is no second status word anywhere in this package: a layer that
 * finds itself wanting one has found a state missing from here, not a column of its own. A single
 * word such as `running` that covers responding, tool-calling, waiting on a permission decision,
 * compacting, and finished-and-waiting-for-input answers nobody's question, and every reader
 * downstream of it ends up inferring.
 *
 * Two fields, never one composed string, and structured all the way down.
 * `state` is the coarse lifecycle; `activity` is what a working session is blocked on right now. A
 * composed string cannot be queried or aggregated without parsing it back apart, and "show me every
 * session waiting on a permission decision" is the question this model is built to answer. The same
 * argument applies one level in, which is why `activity` is `{kind, name}` rather than `tool:Bash`:
 * `formatActivity` exists for display, and the structure is the truth.
 *
 * The vocabulary is the SDK's wherever the SDK has a word. `requesting` and `compacting` are
 * `SDKStatus` verbatim; `permission`, `tool`, `subagent` are the SDK's nouns. Where the SDK is
 * silent this package is the author, and the table below says which is which — the same separation
 * `core/vocab.ts` draws between SDK_NOUNS and HOST_NOUNS, for the same reason.
 *
 * Nothing here imports the SDK or a runtime, so the model ships on `periscope/protocol` and a
 * controller can read a transition without acquiring a package that can spawn a process.
 */
import type { RefusalReason } from '../core/refusal.js';
import { isRefusalReason } from '../core/refusal.js';

// ---------------------------------------------------------------------------
// state — the coarse lifecycle
// ---------------------------------------------------------------------------

export const SESSION_STATES = [
  /** The process is up; the agent has not reported itself. It has no id yet. */
  'spawning',
  /**
   * The agent reported itself: id, model, tool inventory, version receipt all known.
   *
   * It arrives mid-turn, and the trace goes `working -> ready -> working`. That reads like a
   * step backwards and it is not: it is literally what happens. Observed on a real session:
   *
   *     1 spawning -> spawning   control/create_requested
   *     2 spawning -> spawning   control/prompt_submitted
   *     3 spawning -> working    hook/UserPromptSubmit
   *     4 working  -> ready      sdk-message/system/init      <- here
   *     5 ready    -> working    hook/PreToolUse
   *
   * The agent emits nothing at all until a turn is queued, and `UserPromptSubmit` fires ahead of
   * `init`, so the session is genuinely already working when it says what it is. Ordering this
   * state earlier would mean recording it before the event that causes it.
   *
   * It is kept rather than collapsed for two reasons. It is the only row where the session's
   * identity becomes known — collapse it and "what is this session" needs the transcript. And a
   * session created but never prompted never reaches it: it sits in `spawning` until the start
   * timeout, so the state being missing is what makes that failure legible instead of a hang.
   */
  'ready',
  /** A turn is in flight. `activity` says what it is blocked on. */
  'working',
  /** A turn ended cleanly and the session is waiting for input. */
  'idle',
  /** A turn ended abnormally. The cause names which way. */
  'errored',
  /** An interrupt landed mid-turn. Distinct from `idle`: nobody chose to stop here. */
  'interrupted',
  /** Over. The cause says why, and it is never inferred from silence. */
  'ended',
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

// ---------------------------------------------------------------------------
// activity — what a working session is blocked on in the foreground
// ---------------------------------------------------------------------------

/**
 * Where each activity kind's name comes from. Two are the SDK's own words; four extend it.
 *
 * `requesting` and `compacting` are `SDKStatus` verbatim — two values and a null. The SDK has no
 * word for the other four situations, so this package names them, and this table is where that is
 * recorded rather than left for a reader to guess.
 */
export const ACTIVITY_KINDS = [
  /** SDK: `SDKStatus`. A model request is in flight. */
  'requesting',
  /** SDK: `SDKStatus`. Context compaction is running. */
  'compacting',
  /** This package's own. A tool call is in flight — `name` is the SDK's `tool_name`. */
  'tool',
  /** This package's own. A subagent is running — `name` is the SDK's `agent_type`. */
  'subagent',
  /** This package's own. A permission decision is outstanding — `name` is the tool it is about. */
  'permission',
  /** This package's own. An MCP server is asking for input — `name` is `mcp_server_name`. */
  'elicitation',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Which activity kinds this package named itself, kept visible the way HOST_NOUNS is. */
export const HOST_ACTIVITY_KINDS: readonly ActivityKind[] = ['tool', 'subagent', 'permission', 'elicitation'];

/** SDK: `SDKStatus`'s two non-null values, adopted verbatim. */
export const SDK_ACTIVITY_KINDS: readonly ActivityKind[] = ['requesting', 'compacting'];

export interface SessionActivity {
  readonly kind: ActivityKind;
  /** The tool, subagent type or server this is about. Null where the kind carries no name. */
  readonly name: string | null;
}

/** The display form — `tool:Bash`, `requesting`. For logs and humans; never parsed back. */
export function formatActivity(activity: SessionActivity | null): string {
  if (activity === null) return 'none';
  return activity.name === null ? activity.kind : `${activity.kind}:${activity.name}`;
}

export function sameActivity(left: SessionActivity | null, right: SessionActivity | null): boolean {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind && left.name === right.name;
}

// ---------------------------------------------------------------------------
// cause — required, and closed at compile time
// ---------------------------------------------------------------------------

/**
 * Where a transition came from. A transition that cannot name its cause is not recorded.
 *
 * `refusal` is the sixth and it is load-bearing: a permission denial is a hook event, but a
 * permission-path outage has no hook at all, and with five kinds the difference would have to ride
 * `detail` — free text a reader greps instead of a fact code branches on. Conflating an outage with
 * a deliberate "no" is the most expensive confusion a controller can make, so the two differ in
 * `kind` and in `event`, twice over, neither of them prose.
 */
export const CAUSE_KINDS = ['hook', 'sdk-message', 'control', 'timeout', 'process', 'refusal'] as const;

export type CauseKind = (typeof CAUSE_KINDS)[number];

/**
 * The SDK's hook events, mirrored as values so they can be validated at runtime.
 *
 * Kept in step by two checks, because a list copied out of a type rots silently: `coverage.ts`
 * declares its table `satisfies Record<HookEvent, …>` so a new SDK event breaks the build, and
 * `pins/hook-coverage.test.ts` parses the union straight out of the shipped `sdk.d.ts` and fails
 * when this list disagrees with it.
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'DirectoryAdded',
  'MessageDisplay',
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

/**
 * The SDK message discriminators this model names as causes — `type` for the plain kinds,
 * `type/subtype` for the `system` family. Only the ones that can move a session appear here;
 * `coverage.ts` accounts for all 39 members of the union, wired or declined.
 */
export const MESSAGE_EVENTS = [
  'system/init',
  'system/status',
  'system/session_state_changed',
  'system/compact_boundary',
  'system/task_started',
  'system/task_updated',
  'system/task_notification',
  'system/permission_denied',
  'system/elicitation_complete',
  'system/worker_shutting_down',
  'assistant',
  'result',
] as const;

export type MessageEventName = (typeof MESSAGE_EVENTS)[number];

/**
 * Calls the host makes on itself or is asked to make. Not SDK events — decisions.
 *
 * `kind` and `event` are validated independently and never as a pair. `machine.ts`'s `nameable()`
 * checks that the kind is a declared kind and that the event is a declared event, in two separate
 * guards — so `{kind:'hook', event:'permission_denied'}` passes while being incoherent. Pairing a
 * cause with the right kind is the author's job, not the machine's.
 *
 * `permission_denied` sits here rather than in HOOK_EVENTS because a gate's deny is a call the host
 * makes on itself: it is decided by this package, not reported to it. The SDK's `PermissionDenied`
 * hook is a different thing that belongs to the SDK's own prompt path and does not fire for a
 * hook-authored deny — measured — so naming it here would put an event in the trace that never
 * happened, and would make a reader grepping traces conclude the hook fires.
 */
export const CONTROL_EVENTS = [
  'create_requested',
  'prompt_submitted',
  'interrupt_requested',
  'stop_requested',
  'permission_denied',
] as const;

export type ControlEventName = (typeof CONTROL_EVENTS)[number];

/**
 * The agent process's own lifecycle, as causes.
 *
 * These subsume `SESSION_END_CAUSES` deliberately. `sessions/session.ts` states four end causes
 * local to the handle, and its own comment says the layer owning the declared state model maps them
 * onto its causes. This is that layer, and this is that mapping — one cause vocabulary, not two.
 * `state/reconciliation.test.ts` asserts the containment so it cannot drift.
 */
export const PROCESS_EVENTS = [
  'process_started',
  'stop_requested',
  'process_ended',
  'process_failed',
  'start_timed_out',
] as const;

export type ProcessEventName = (typeof PROCESS_EVENTS)[number];

export const TIMEOUT_EVENTS = ['start_timed_out', 'hook_timed_out'] as const;

export type TimeoutEventName = (typeof TIMEOUT_EVENTS)[number];

/**
 * The gate's expiry, named once.
 *
 * One concept with two spellings — `hook_timed_out` on the transition, and `hook-timed-out` as
 * the prefix of the deny reason handed to the model — looks exactly like a declared refusal reason
 * (its sibling branch really is one) while resolving to nothing, so a reader who looks it up finds
 * no such name. `satisfies` ties it to the closed vocabulary above, so the two cannot drift apart
 * without breaking the build.
 */
export const HOOK_TIMEOUT_EVENT = 'hook_timed_out' satisfies TimeoutEventName;

/**
 * Every name a cause may carry. Closed, so a transition that cannot name its cause does not
 * compile — the strongest available form of "cause is not nullable".
 */
export type CauseEvent =
  HookEventName | MessageEventName | ControlEventName | ProcessEventName | TimeoutEventName | RefusalReason;

const CAUSE_EVENT_SET: ReadonlySet<string> = new Set<string>([
  ...HOOK_EVENTS,
  ...MESSAGE_EVENTS,
  ...CONTROL_EVENTS,
  ...PROCESS_EVENTS,
  ...TIMEOUT_EVENTS,
]);

/** The runtime half. A frame decoded from the wire was never seen by the compiler. */
export function isCauseEvent(value: string): value is CauseEvent {
  return CAUSE_EVENT_SET.has(value) || isRefusalReason(value);
}

export function isCauseKind(value: string): value is CauseKind {
  return (CAUSE_KINDS as readonly string[]).includes(value);
}

export interface TransitionCause {
  readonly kind: CauseKind;
  /** The literal hook, message or control event that fired. Never free text. */
  readonly event: CauseEvent;
  /** For a human reading a log. Never branched on — that is what `kind` and `event` are for. */
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// where
// ---------------------------------------------------------------------------

/**
 * Which session, which worktree, which branch — so the trace answers "where" without a transcript.
 *
 * A null `worktree` or `branch` is a named outcome: `unknownReason` says which of the ordinary
 * situations produced it (not a repository, detached HEAD, unreadable HEAD). An empty string would
 * make "not in a repository" and "in a repository whose HEAD could not be read" the same value.
 */
export interface TransitionWhere {
  readonly cwd: string;
  readonly worktree: string | null;
  readonly branch: string | null;
  readonly unknownReason: string | null;
}

// ---------------------------------------------------------------------------
// the transition record
// ---------------------------------------------------------------------------

/**
 * One recorded transition. The shape follows `control/link-state.ts`'s `LinkTransition` on purpose
 * — `{from, to, cause, at, detail}` with a required cause is this package's established shape for a
 * state machine, and two shapes for one idea is how vocabularies drift apart.
 */
export interface SessionTransition {
  /**
   * The agent's own session id — null until it has reported itself, and never null again after.
   *
   * The host does not mint one. An agent emits nothing until a turn is queued, so there is a
   * real window with a live process and no id, and inventing a name for it would be exactly the
   * "coin a word by observation" failure this package is written against. A controller that needs
   * to correlate its request with the session it became supplies `correlationId`.
   */
  readonly sessionId: string | null;
  /** Dense from 1, per session-machine. A gap is detectable by arithmetic alone. */
  readonly seq: number;
  readonly at: string;
  readonly from: SessionState;
  readonly to: SessionState;
  /** What the session is blocked on after this transition. Null when nothing holds it. */
  readonly activity: SessionActivity | null;
  /** The open entry this transition opened, closed or backgrounded. Null when it touched none. */
  readonly entryId: string | null;
  readonly cause: TransitionCause;
  readonly where: TransitionWhere;
  /**
   * Opaque, controller-supplied, and never interpreted here.
   *
   * It exists so a controller can tie a session back to whatever it means on its side. The host
   * does not parse it, branch on it, or derive anything from it — the moment it did, this package
   * would know something about one product's conventions and stop being general.
   */
  readonly correlationId: string | null;
}

// ---------------------------------------------------------------------------
// open entries
// ---------------------------------------------------------------------------

/**
 * Foreground work holds the session; background work does not.
 *
 * A backgrounded task produces an entry that never exits while the turn moves on — without this
 * split, a session that starts a long build reads as blocked on it forever. The move happens at the
 * moment the SDK reports the task backgrounded, with that as the cause; never on a timer and never
 * by inference. A backgrounded entry is not a finished one: it stays open, it keeps ageing, and it
 * still gets an exit.
 */
export type EntryLane = 'foreground' | 'background';

export interface OpenEntry {
  /** The SDK's own id for the thing — `tool_use_id`, `agent_id`, `task_id`. Never minted here. */
  readonly entryId: string;
  readonly activity: SessionActivity;
  readonly lane: EntryLane;
  readonly openedAt: string;
  /** When it stopped holding the session. Null while it still does. */
  readonly backgroundedAt: string | null;
  /**
   * When cleanup marked it abandoned. Cleanup may mark; it may never erase.
   *
   * A session sitting in one tool call for forty minutes is the most useful thing this model can
   * report, and a reconciler that quietly closes the entry destroys exactly that signal. So an
   * unpaired entry is surfaced with its age and a reason, and the fact that it happened survives.
   */
  readonly abandonedAt: string | null;
  readonly abandonReason: string | null;
  /** Why it opened. Carried so an entry read weeks later still says what started it. */
  readonly cause: TransitionCause;
  /** Set when the entry belongs to a subagent rather than the main thread. */
  readonly agentId: string | null;
}

/** An open entry with the number a human actually wants. */
export interface AgedEntry extends OpenEntry {
  readonly ageMs: number;
}

// ---------------------------------------------------------------------------
// what this host can say about its own sessions
// ---------------------------------------------------------------------------

/**
 * One session, as this host sees it.
 *
 * This is not a roster and must not grow into one. A roster spans every session everywhere, and
 * sessions live on different hosts — an agent runs where its host runs, so no single host can
 * produce one. This enumerates the sessions this host holds, which is the raw material a controller
 * aggregates into a roster on its side. If this grows a filter, a search or a notion of what a
 * session means, the boundary has been crossed.
 */
export interface SessionSnapshot {
  readonly sessionId: string | null;
  readonly correlationId: string | null;
  readonly state: SessionState;
  readonly activity: SessionActivity | null;
  readonly where: TransitionWhere;
  readonly openEntries: readonly AgedEntry[];
  readonly lastTransitionAt: string | null;
  readonly transitionCount: number;
}
