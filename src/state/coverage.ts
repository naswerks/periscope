/**
 * The coverage table. Every hook the SDK exposes and every message it can send is wired or
 * declined here, in writing.
 *
 * An absent row is a gap, not a default — which is the entire reason this is a table rather than
 * a wiring pass. "Every hook is handled" is unfalsifiable; "every hook has a row, and here are the
 * ones deliberately not used and why" can be audited by someone who was not here.
 *
 * It cannot rot silently, and that is enforced twice.
 *   1. `satisfies Record<HookEvent, …>` and `satisfies Record<MessageDiscriminator, …>` — both keyed
 *      off the SDK's own unions, so an event added by an SDK upgrade breaks the build.
 *   2. `pins/hook-coverage.test.ts` parses those unions straight out of the shipped `sdk.d.ts` and
 *      fails when a literal has no row — which catches the case (1) cannot: someone widening the
 *      local mirror instead of the table.
 * A document that claims coverage is exactly the artifact that decays into a lie, so the claim is
 * made checkable rather than merely careful.
 *
 * The rule for `wired`: an event is wired when it changes the session's state or activity, or
 * when it names a why the trace would otherwise be missing. Everything else is declined — and the
 * commonest honest reason is that the fact belongs to a neighbouring layer (content to streaming,
 * cost to telemetry, transcripts to persistence), not that it is uninteresting.
 */
import type { HookEvent, MessageDiscriminator } from '../host/agent-process.js';

export type CoverageHandling = 'wired' | 'declined';

export interface CoverageRow {
  readonly handling: CoverageHandling;
  /** What it produces when wired; why it is not consumed when declined. Required either way. */
  readonly note: string;
}

/**
 * All 31 hook events. 18 wired, 13 declined.
 *
 * `PreToolUse` appears here as an observation only. The permission decision is a separate
 * concern with a separate handler; `HookCallbackMatcher.hooks` is an array and the SDK runs every
 * entry, so a decision handler registers alongside this one without either editing the other.
 */
export const HOOK_COVERAGE = {
  // --- wired: the tool lane -------------------------------------------------
  PreToolUse: {
    handling: 'wired',
    note: 'opens a `tool` entry keyed by tool_use_id; state -> working. Observation only — the permission decision is a separate handler on the same event.',
  },
  PostToolUse: {
    handling: 'wired',
    note: 'closes the `tool` entry for its tool_use_id. The ordinary exit.',
  },
  PostToolUseFailure: {
    handling: 'wired',
    note: 'closes the `tool` entry naming the failure — the failure exit, distinct from the success one because "it stopped" and "it broke" are different answers.',
  },
  PostToolBatch: {
    handling: 'wired',
    note: "fires exactly once after every call in a batch resolves, so it closes any tool entry still open. The backstop for a PostToolUse that never arrived — measured on two live sessions, including an all-denied batch: it fires on a hook-authored deny and its tool_calls includes the denied tool_use_id, so a denied call's entry does not leak. It closes the entry at end of batch and says only that; the denial itself is a separate transition the gate emits.",
  },

  // --- wired: the turn lane -------------------------------------------------
  UserPromptSubmit: {
    handling: 'wired',
    note: 'state -> working. The turn boundary opening; the counterpart to Stop.',
  },
  Stop: {
    handling: 'wired',
    note: 'state -> idle. The clean turn end, recorded for every session with no exemption — a turn boundary that is missing for any class of session leaves every reader inferring.',
  },
  StopFailure: {
    handling: 'wired',
    note: 'state -> errored, carrying the SDKAssistantMessageError. Never collapsed into Stop: a turn that broke is not a turn that finished.',
  },

  // --- wired: session lifecycle --------------------------------------------
  SessionStart: {
    handling: 'wired',
    note: 'records how the session began (startup | resume | clear | compact | fork). No state change — it names a why the trace would otherwise have to infer. Measured not to fire on an SDK-hosted start: a real session running every wired hook saw PreToolUse, PostToolUse, PostToolBatch, UserPromptSubmit and Stop, and no SessionStart. The likely reason is ordering — `options.hooks` reach the CLI after it has already started — but that was not isolated. Wired and not observed, which is a different row from declined.',
  },
  SessionEnd: {
    handling: 'wired',
    note: 'state -> ended, carrying the ExitReason. Never inferred from silence.',
  },
  CwdChanged: {
    handling: 'wired',
    note: 'updates `where.cwd` for every later transition. Declining it would leave every subsequent record carrying a stale directory — a trace that lies quietly.',
  },

  // --- wired: subagents -----------------------------------------------------
  SubagentStart: {
    handling: 'wired',
    note: 'opens a `subagent` entry keyed by agent_id, carrying agent_type.',
  },
  SubagentStop: {
    handling: 'wired',
    note: 'closes the `subagent` entry for its agent_id.',
  },

  // --- wired: compaction ----------------------------------------------------
  PreCompact: {
    handling: 'wired',
    note: 'opens a `compacting` entry, carrying trigger (manual | auto).',
  },
  PostCompact: {
    handling: 'wired',
    note: 'closes the `compacting` entry.',
  },

  // --- wired: the permission lane -------------------------------------------
  PermissionRequest: {
    handling: 'wired',
    note: "opens a `permission` entry for the tool. Measured not to fire for a hook-authored decision — `gate/outcome.ts` records the measurement — so the held-visibility this model buys is delivered by the gate's own hold entry (keyed by tool_use_id), not by this hook. Do not wait on this hook for entries the gate opens elsewhere; re-measure before relying on it for any other decision path.",
  },
  PermissionDenied: {
    handling: 'wired',
    note: 'closes the `permission` entry, cause kind `hook`, carrying the deny reason. A denial and a permission-path outage must not read alike: an outage arrives as cause kind `refusal` with a refusal reason, so the two differ in kind and event. Measured not to fire for a hook-authored deny: a real session whose PreToolUse returned `permissionDecision: deny` blocked the tool (no PostToolUse) but emitted no PermissionDenied — so this hook appears to belong to a decision path other than the hook lane. Whoever builds the decision path must not rely on it as the deny receipt without re-measuring.',
  },

  // --- wired: elicitation ---------------------------------------------------
  Elicitation: {
    handling: 'wired',
    note: 'opens an `elicitation` entry for the MCP server. The session is genuinely blocked on an answer.',
  },
  ElicitationResult: {
    handling: 'wired',
    note: 'closes the `elicitation` entry, carrying the action (accept | decline | cancel).',
  },

  // --- declined -------------------------------------------------------------
  Notification: {
    handling: 'declined',
    note: 'a display notification (message, title, notification_type). Nothing about it moves the session; it is content, and content belongs to the streaming layer.',
  },
  UserPromptExpansion: {
    handling: 'declined',
    note: 'a slash-command or MCP-prompt expansion of a prompt already submitted. The turn boundary was UserPromptSubmit; recording this too would add a transition carrying no new fact.',
  },
  Setup: {
    handling: 'declined',
    note: 'environment housekeeping (trigger: init | maintenance). It runs beside the session rather than in it, and produces no condition the session can be blocked on.',
  },
  TeammateIdle: {
    handling: 'declined',
    note: "reports that another session is idle. Recording it here would attribute a different session's state to this one — precisely the cross-session aggregation that belongs to the controller, not a host.",
  },
  TaskCreated: {
    handling: 'declined',
    note: 'the task-list surface (task_subject, teammate_name). Its overlap with the task_started/task_updated message lane has not been resolved against a live session, and wiring both would double-count one entry. Declined on the unresolved overlap, not on irrelevance.',
  },
  TaskCompleted: {
    handling: 'declined',
    note: 'the closing half of TaskCreated, declined for the same unresolved overlap. system/task_notification is the completion signal that is wired.',
  },
  ConfigChange: {
    handling: 'declined',
    note: "settings or skills changed on disk. It changes what the session can do, not what it is doing — a capability fact, and capability is the workspace layer's.",
  },
  InstructionsLoaded: {
    handling: 'declined',
    note: 'memory/CLAUDE.md loading. Context composition, which is what a turn is made of rather than a condition it is in.',
  },
  WorktreeCreate: {
    handling: 'declined',
    note: 'the agent created a worktree. It does not move the session — `where` still describes where the session runs. Relevant to whichever layer provisions workspaces.',
  },
  WorktreeRemove: {
    handling: 'declined',
    note: 'as WorktreeCreate. Note that removing the worktree a session is in would be visible through CwdChanged, which is wired.',
  },
  DirectoryAdded: {
    handling: 'declined',
    note: 'widens the set of directories the session may touch. A permission-surface fact, not a state one; it belongs with whatever enforces the path boundary.',
  },
  FileChanged: {
    handling: 'declined',
    note: 'a watched file changed (change | add | unlink). High volume, driven by the filesystem rather than by the session, and it holds nothing.',
  },
  MessageDisplay: {
    handling: 'declined',
    note: "one flush of an assistant message, indexed per delta. The highest-volume event in the set and pure content — the streaming layer's lane, not the state model's.",
  },
} as const satisfies Record<HookEvent, CoverageRow>;

/**
 * All 39 members of the SDKMessage union, keyed by discriminator.
 *
 * Fewer keys than members: several shapes share one discriminator (`user` covers the ordinary and
 * the replayed user message; `result` covers success and every error subtype). The pin walks the
 * union member by member and checks each one's discriminator has a row, so the many-to-one is
 * accounted for rather than hidden by the shorter key list.
 */
export const MESSAGE_COVERAGE = {
  // --- wired ----------------------------------------------------------------
  'system/init': {
    handling: 'wired',
    note: 'state -> ready, and the only place the session id, CLI version receipt, model, tool/skill/plugin inventory and apiKeySource arrive. Everything downstream keys off the id it carries.',
  },
  'system/status': {
    handling: 'wired',
    note: "SDKStatus — sets activity `requesting` or `compacting`, and closes it on null. The SDK's own word for what a session is doing, adopted verbatim.",
  },
  'system/session_state_changed': {
    handling: 'wired',
    note: 'documented as the authoritative turn-over signal — measured not to fire: never observed on any of the 3 real turns measured; `Stop` and `result` are the observed turn boundaries. When it does arrive: idle -> state idle, running -> state working. `requires_action` deliberately does not set state: what the session requires is already carried by the open permission or elicitation entry, and a second representation would be a second vocabulary.',
  },
  'system/compact_boundary': {
    handling: 'wired',
    note: 'compaction actually happened, with trigger and token counts. Closes the compacting entry as a backstop for a PostCompact that never arrived.',
  },
  'system/task_started': {
    handling: 'wired',
    note: 'no transition of its own — it supplies the task_id -> tool_use_id join, without which task_updated could not name the entry it backgrounds. Wired as correlation, and saying so is the point of this column.',
  },
  'system/task_updated': {
    handling: 'wired',
    note: '`patch.is_backgrounded` is the caused moment a task stops holding the session — the entry moves to the background lane there, never on a timer and never by inference. `patch.status` in completed | failed | killed closes it.',
  },
  'system/task_notification': {
    handling: 'wired',
    note: 'a background task finished (completed | failed | stopped) carrying tool_use_id. The exit for backgrounded work: backgrounding is not completion, so the entry stays open and ages until this arrives.',
  },
  'system/worker_shutting_down': {
    handling: 'wired',
    note: 'a named reason for a teardown that would otherwise present as the process simply ending. Its own type warns that absence is not a dead-host signal — handoffs and fatal paths emit nothing — so it is a why when present, never a liveness check.',
  },
  'system/model_refusal_no_fallback': {
    handling: 'wired',
    note: 'the turn ends with no retry. Records the why; the state change itself rides result/StopFailure, so the turn end is not recorded twice.',
  },
  result: {
    handling: 'wired',
    note: 'subtype success -> idle (the backstop for a missed Stop); every error subtype -> errored, carrying terminal_reason. This is where a turn that ended without any hook firing still gets a boundary.',
  },

  // --- declined -------------------------------------------------------------
  assistant: {
    handling: 'declined',
    note: 'model output. Content, owned by the streaming layer; the state it implies is already carried by system/status and system/session_state_changed.',
  },
  user: {
    handling: 'declined',
    note: 'the turn input, including the replayed echo. UserPromptSubmit is the wired boundary; this is the payload that crossed it.',
  },
  stream_event: {
    handling: 'declined',
    note: "partial assistant deltas. The highest-volume message in the union and pure content — the streaming layer's.",
  },
  tool_progress: {
    handling: 'declined',
    note: "carries elapsed_time_seconds for a running tool. Declined deliberately: the open entry's age is computed from its own openedAt, and a second elapsed-time source is a number that can disagree with the trace.",
  },
  tool_use_summary: {
    handling: 'declined',
    note: 'a prose summary of preceding tool calls. Content.',
  },
  auth_status: {
    handling: 'declined',
    note: 'isAuthenticating plus provider output. An identity-plane fact; the session is not blocked on it in a way this model can name.',
  },
  rate_limit_event: {
    handling: 'declined',
    note: 'rate-limit windows. Usage and cost belong to the telemetry lane, which reads the same stream.',
  },
  prompt_suggestion: {
    handling: 'declined',
    note: 'a predicted next prompt. A suggestion for a human; nothing has happened.',
  },
  conversation_reset: {
    handling: 'declined',
    note: "/clear, plan-mode exit and fresh-session flows mint a new conversation id. The session continues — what changed is which transcript later reads attach to, which is the persistence layer's question.",
  },
  'system/api_retry': {
    handling: 'declined',
    note: "a retryable API failure being retried. The session stays in `requesting`, and a session stuck in retries is already visible as that entry's growing age rather than needing a state of its own.",
  },
  'system/control_request_progress': {
    handling: 'declined',
    note: 'progress for a client-originated control request. It belongs to whoever made that request, correlated by its own request_id.',
  },
  'system/model_refusal_fallback': {
    handling: 'declined',
    note: 'the turn was retried on a fallback model and continues. Nothing ended; the no-fallback counterpart is the one that is wired.',
  },
  'system/local_command_output': {
    handling: 'declined',
    note: 'output from a local slash command. Content.',
  },
  'system/hook_started': {
    handling: 'declined',
    note: 'the lifecycle of a command hook (hook_id, hook_name, stdout/stderr). This host installs in-process callbacks and runs no command hooks, so these describe a mechanism it does not use.',
  },
  'system/hook_progress': {
    handling: 'declined',
    note: 'as system/hook_started — the command-hook mechanism, unused here.',
  },
  'system/hook_response': {
    handling: 'declined',
    note: 'as system/hook_started. Worth revisiting by whoever builds the permission decision path if command hooks are ever installed alongside the in-process ones.',
  },
  'system/plugin_install': {
    handling: 'declined',
    note: 'headless plugin installation progress. A provisioning fact that precedes work rather than being work.',
  },
  'system/task_progress': {
    handling: 'declined',
    note: "periodic progress for a running task. High volume, and the entry's own age is the number that matters.",
  },
  'system/background_tasks_changed': {
    handling: 'declined',
    note: "declined on the type's own instruction. It is a level signal with replace semantics whose docs say the payload carries ids only and must not be correlated with the edge stream — so consuming it would mean rebuilding the entry set from ids, losing every entry's age and opening cause. The edges (task_started / task_updated / task_notification) are wired instead, and an edge that goes missing surfaces as an open entry with an age, which is the useful signal rather than the one a rebuild would erase.",
  },
  'system/thinking_tokens': {
    handling: 'declined',
    note: "a live thinking-token estimate for spinners. Explicitly approximate in its own docs, and telemetry's if anyone wants it.",
  },
  'system/commands_changed': {
    handling: 'declined',
    note: 'the slash-command list changed mid-session. A capability fact — what the session can do.',
  },
  'system/notification': {
    handling: 'declined',
    note: 'a loop-side text notification with a priority. Display.',
  },
  'system/files_persisted': {
    handling: 'declined',
    note: "file persistence results. The persistence layer's.",
  },
  'system/memory_recall': {
    handling: 'declined',
    note: 'memories surfaced into the turn. Context composition.',
  },
  'system/elicitation_complete': {
    handling: 'declined',
    note: 'a URL-mode elicitation confirmed complete by the MCP server. The ElicitationResult hook already closes the entry; consuming both would close it twice.',
  },
  'system/permission_denied': {
    handling: 'declined',
    note: 'mirrors the PermissionDenied hook, which is wired and additionally carries the deny reason. Consuming both would record one denial as two.',
  },
  'system/mirror_error': {
    handling: 'declined',
    note: "a real degrade — a transcript-mirror batch was dropped after retries. Declined here because it changes what can be read later, not what the session is doing; it is the persistence layer's to surface, and it must not be lost there.",
  },
  'system/informational': {
    handling: 'declined',
    note: 'a generic text banner, including hook feedback. Content.',
  },
} as const satisfies Record<MessageDiscriminator, CoverageRow>;

/** Counts for the table's own summary line, computed rather than typed in — one less thing to rot. */
export function coverageTally(table: Record<string, CoverageRow>): {
  total: number;
  wired: number;
  declined: number;
} {
  const rows = Object.values(table);
  return {
    total: rows.length,
    wired: rows.filter((row) => row.handling === 'wired').length,
    declined: rows.filter((row) => row.handling === 'declined').length,
  };
}
