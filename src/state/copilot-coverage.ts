/**
 * Every session event of the pinned Copilot SDK, wired or declined, each with its reason: Copilot's
 * counterpart of `MESSAGE_COVERAGE`, `CODEX_COVERAGE`, `QWEN_COVERAGE` and `PI_COVERAGE`.
 *
 * Every event is received: the runtime hands each one to the session (`onEvent`), and each rides the
 * session's update lane as the native message (`runtime: 'copilot'`), a streamed delta on the delta lane.
 * A row is `wired` when it also moves the machine, feeds a fact, fills a conversation item or is read by the
 * session's gate, and the note says which; `declined` when the native message is all there is. An event of
 * the open's own probe call never rides at all. A kind the runtime sends outside the SDK's declared union
 * rides the native message only.
 *
 * Kept honest by `pins/copilot-coverage.test.ts`: the keys equal the events the release declares
 * (`contracts/copilot-names.json`), in both directions, and the cause events Copilot can name a transition
 * with are exactly the wired rows.
 */
import type { CoverageRow } from './coverage.js';

/** Received and riding alone: the native message is all there is. */
const NATIVE_ONLY = 'rides the native message only; it moves nothing and feeds no fact';

/** An event of a surface this host never attaches. */
const NO_SURFACE = `${NATIVE_ONLY}: this host attaches no IDE, canvas or extension to a session`;

/** An event of a mode this host never admits. */
const NOT_ADMITTED = `${NATIVE_ONLY}: it follows from autopilot or a schedule, neither of which a session through this host runs`;

/** An event of the runtime's own routing between models. */
const ROUTING = `${NATIVE_ONLY}: the runtime's own routing between models; each model call still reports its usage`;

/** An event of a request this host never answers: the session registers no handler for it. */
const UNANSWERED = `${NATIVE_ONLY}: the session registers no handler for this request, so the runtime answers it itself`;

/** An event of a permission flow other than the pre-tool hook's, which this host's gate never takes. */
const OTHER_FLOW = `${NATIVE_ONLY}: a permission flow other than the pre-tool hook's; the gate refuses every request that is not the hook's (gate-hook-missing)`;

/** Each event a session is handed, by its `type`, in the order the SDK's union names them. */
export const COPILOT_EVENT_COVERAGE = {
  'ide.connection_changed': { handling: 'declined', note: NO_SURFACE },
  'ide.selection_changed': { handling: 'declined', note: NO_SURFACE },
  'ide.add_file_reference': { handling: 'declined', note: NO_SURFACE },
  'ide.elicitation_complete': { handling: 'declined', note: NO_SURFACE },
  'session.journal_link': { handling: 'declined', note: NATIVE_ONLY },
  'session.start': {
    handling: 'wired',
    note: "the session's id (session_handle), the model it selected (the model register) and its effort; a new or forked session's open is proven after it",
  },
  'session.resume': {
    handling: 'wired',
    note: "a resumed session's id (session_handle), the model it selected and its effort; its open is proven after it",
  },
  'session.remote_steerable_changed': { handling: 'declined', note: NATIVE_ONLY },
  'session.error': {
    handling: 'wired',
    note: "the session's own thread: state -> errored, the run's failure for its turn item, and an error notice naming the error's type and words. A sub-agent's rides alone",
  },
  'session.idle': {
    handling: 'wired',
    note: 'the run is over: state -> idle, interrupted when aborted, or errored when the run failed; closes any tool entry left open; a turn item, ended; the settled tasks start over with the next run',
  },
  'session.autopilot_stopped': { handling: 'declined', note: NOT_ADMITTED },
  'session.title_changed': { handling: 'declined', note: NATIVE_ONLY },
  'session.schedule_created': { handling: 'declined', note: NOT_ADMITTED },
  'session.schedule_cancelled': { handling: 'declined', note: NOT_ADMITTED },
  'session.schedule_rearmed': { handling: 'declined', note: NOT_ADMITTED },
  'session.autopilot_objective_changed': { handling: 'declined', note: NOT_ADMITTED },
  'session.info': { handling: 'declined', note: NATIVE_ONLY },
  'session.indexed_search': { handling: 'declined', note: NATIVE_ONLY },
  'session.warning': { handling: 'wired', note: "a warning notice, in the runtime's own words" },
  'session.model_change': {
    handling: 'wired',
    note: 'the model register and the effort; a receipt of its own',
  },
  'session.model_deselected': { handling: 'declined', note: NATIVE_ONLY },
  'session.auto_tier_recommendation': { handling: 'declined', note: ROUTING },
  'session.auto_tier_switch_failed': { handling: 'declined', note: ROUTING },
  'session.mode_changed': {
    handling: 'wired',
    note: 'the agent mode the receipt states; read by the gate, which names any mode but interactive and plan (gate-mode-widened)',
  },
  'session.mode_notice_delivered': { handling: 'declined', note: NATIVE_ONLY },
  'session.session_limits_changed': { handling: 'declined', note: NATIVE_ONLY },
  'session.permissions_changed': {
    handling: 'wired',
    note: 'read by the gate, which names any permission mode but manual (gate-mode-widened)',
  },
  'session.plan_changed': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: it names an operation on the plan file and carries no plan text`,
  },
  'session.todos_changed': { handling: 'declined', note: `${NATIVE_ONLY}: it carries no list` },
  'session.workspace_file_changed': { handling: 'declined', note: NATIVE_ONLY },
  'session.handoff': { handling: 'declined', note: NATIVE_ONLY },
  'session.truncation': { handling: 'declined', note: NATIVE_ONLY },
  'session.snapshot_rewind': { handling: 'declined', note: NATIVE_ONLY },
  'session.shutdown': {
    handling: 'wired',
    note: "a turn_record whose totals are the session's figures per model as the runtime states them at its end, unpriced",
  },
  'session.usage_checkpoint': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: its total is in the runtime's own credit unit, never a cost`,
  },
  'session.quota_observation': { handling: 'declined', note: NATIVE_ONLY },
  'session.context_changed': { handling: 'declined', note: NATIVE_ONLY },
  'session.usage_info': {
    handling: 'wired',
    note: "a usage_sample: the context's tokens and the model's window, as the runtime counts them",
  },
  'session.context_cleared': { handling: 'declined', note: NATIVE_ONLY },
  'session.compaction_start': {
    handling: 'wired',
    note: 'opens the compaction entry; a compaction fact, started, its trigger manual when asked for and auto otherwise',
  },
  'session.compaction_summarized': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: session.compaction_complete ends the compaction`,
  },
  'session.compaction_complete': {
    handling: 'wired',
    note: 'closes the compaction entry; a compaction fact, ended, with the tokens before and after as reported',
  },
  'session.task_complete': { handling: 'declined', note: NATIVE_ONLY },
  'session.completion_receipt': { handling: 'declined', note: NATIVE_ONLY },
  'session.fusion_route_started': { handling: 'declined', note: ROUTING },
  'session.fusion_route_failed': { handling: 'declined', note: ROUTING },
  'session.fusion_resolved': { handling: 'declined', note: ROUTING },
  'session.fusion_completed': { handling: 'declined', note: ROUTING },
  'session.permission_recovery': { handling: 'declined', note: OTHER_FLOW },
  'user.message': {
    handling: 'wired',
    note: "the session's own thread: state -> working; a turn item, started, when no run is running; the user_text item; the runtime took one prompt",
  },
  'pending_messages.modified': { handling: 'declined', note: NATIVE_ONLY },
  'assistant.turn_start': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: one model call; the conversation's turn is the run, from the prompt taken to session.idle`,
  },
  'assistant.intent': { handling: 'declined', note: NATIVE_ONLY },
  'assistant.fusion_phase_started': { handling: 'declined', note: ROUTING },
  'assistant.fusion_phase_activity': { handling: 'declined', note: ROUTING },
  'assistant.fusion_phase_completed': { handling: 'declined', note: ROUTING },
  'assistant.fusion_phase_failed': { handling: 'declined', note: ROUTING },
  'assistant.server_tool_progress': {
    handling: 'wired',
    note: "read by the gate: a tool the model's provider ran itself, which no hook sees (gate-unhooked-call)",
  },
  'assistant.reasoning': {
    handling: 'wired',
    note: 'a thinking item, the reasoning text as the runtime reports it',
  },
  'assistant.reasoning_delta': {
    handling: 'wired',
    note: 'forwarded only when the session asked for partial messages; a thinking fragment',
  },
  'assistant.tool_call_delta': {
    handling: 'wired',
    note: "forwarded only when the session asked for partial messages; a tool_input fragment: a piece of the call's input as the model writes it",
  },
  'assistant.streaming_delta': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: it counts the bytes of the reply so far and carries none of them`,
  },
  'assistant.message': {
    handling: 'wired',
    note: "an agent_text item when it carries text (final null: the runtime marks no answer); a sub-agent's carries the call that spawned it",
  },
  'assistant.message_start': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: assistant.message carries the whole message`,
  },
  'assistant.message_delta': {
    handling: 'wired',
    note: 'forwarded only when the session asked for partial messages; a text fragment',
  },
  'assistant.turn_end': { handling: 'declined', note: `${NATIVE_ONLY}: one model call's end` },
  'assistant.idle': { handling: 'declined', note: `${NATIVE_ONLY}: session.idle ends the run` },
  'assistant.usage': {
    handling: 'wired',
    note: "a turn_record for one model call (turnScope step), its tokens as reported and unpriced: the runtime's cost is a multiplier, not money",
  },
  'model.call_failure': {
    handling: 'wired',
    note: "a warning notice naming the failed model call's error, in the runtime's words; session.error reports a failure that ends the run",
  },
  'model.call_finished': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: assistant.usage reports each call's figures`,
  },
  abort: { handling: 'declined', note: `${NATIVE_ONLY}: session.idle says the run was aborted` },
  'tool.user_requested': { handling: 'declined', note: NATIVE_ONLY },
  'tool.execution_start': {
    handling: 'wired',
    note: "the session's own thread: opens a tool entry, state -> working; a tool_call item, its name as the gate spells it and its kind by copilotToolKind",
  },
  'tool.execution_partial_result': { handling: 'declined', note: NATIVE_ONLY },
  'tool.shell_output': { handling: 'declined', note: NATIVE_ONLY },
  'tool.execution_progress': { handling: 'declined', note: NATIVE_ONLY },
  'tool.execution_complete': {
    handling: 'wired',
    note: "closes the tool entry; a tool_result item: blocked when this host's gate refused the call, failed when it did not succeed, completed otherwise, with its output, its shell's exit code and the files it changed as reported; read by the gate, which names a call that ran with no decision (gate-hook-missing)",
  },
  'tool_search.activated': { handling: 'declined', note: NATIVE_ONLY },
  'skill.invoked': { handling: 'declined', note: NATIVE_ONLY },
  'subagent.started': {
    handling: 'wired',
    note: 'a running task in the tasks fact: the spawning call is its id and its toolUseId, the agent its type, its description',
  },
  'subagent.configured': { handling: 'declined', note: NATIVE_ONLY },
  'subagent.completed': {
    handling: 'wired',
    note: 'a settled task, completed, or stopped when cancelled, with its tokens, tool calls and time as reported',
  },
  'subagent.failed': {
    handling: 'wired',
    note: 'a settled task, failed, with its tokens, tool calls and time as reported',
  },
  'subagent.selected': { handling: 'declined', note: NATIVE_ONLY },
  'subagent.deselected': { handling: 'declined', note: NATIVE_ONLY },
  'hook.start': { handling: 'declined', note: `${NATIVE_ONLY}: hook.end reports how the hook ran` },
  'hook.end': {
    handling: 'wired',
    note: "read by the gate: this host's pre-tool hook reported failed, after which the runtime lets the call proceed (gate-hook-missing)",
  },
  'hook.progress': { handling: 'declined', note: NATIVE_ONLY },
  'session.binary_asset': { handling: 'declined', note: NATIVE_ONLY },
  'system.message': { handling: 'declined', note: NATIVE_ONLY },
  'instruction.update': { handling: 'declined', note: NATIVE_ONLY },
  'system.notification': { handling: 'declined', note: NATIVE_ONLY },
  'permission.requested': {
    handling: 'wired',
    note: 'read by the gate: a request a hook this host did not install answered (gate-hook-foreign)',
  },
  'permission.completed': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: the gate's own outcome is the record of the decision`,
  },
  'permission.carriedForward': { handling: 'declined', note: OTHER_FLOW },
  'permission.messageAuthorization': { handling: 'declined', note: OTHER_FLOW },
  'permission.messageAuthorizationRead': { handling: 'declined', note: OTHER_FLOW },
  'permission.messageAuthorizationDegraded': { handling: 'declined', note: OTHER_FLOW },
  'permission.assentDetected': { handling: 'declined', note: OTHER_FLOW },
  'permission.contextualAuthorization': { handling: 'declined', note: OTHER_FLOW },
  'user_input.requested': { handling: 'declined', note: UNANSWERED },
  'user_input.completed': { handling: 'declined', note: UNANSWERED },
  'elicitation.requested': { handling: 'declined', note: UNANSWERED },
  'elicitation.completed': { handling: 'declined', note: UNANSWERED },
  'sampling.requested': { handling: 'declined', note: UNANSWERED },
  'sampling.completed': { handling: 'declined', note: UNANSWERED },
  'mcp.oauth_required': { handling: 'declined', note: UNANSWERED },
  'mcp.oauth_completed': { handling: 'declined', note: UNANSWERED },
  'mcp.oauth_recovery_completed': { handling: 'declined', note: UNANSWERED },
  'mcp.headers_refresh_required': { handling: 'declined', note: UNANSWERED },
  'mcp.headers_refresh_completed': { handling: 'declined', note: UNANSWERED },
  'session.custom_notification': { handling: 'declined', note: NATIVE_ONLY },
  'ui.ephemeral_query': { handling: 'declined', note: NO_SURFACE },
  'external_tool.requested': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: the session registers no tool of its own for the runtime to call back`,
  },
  'external_tool.completed': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: the session registers no tool of its own for the runtime to call back`,
  },
  'command.queued': { handling: 'declined', note: `${NATIVE_ONLY}: the session registers no command` },
  'command.execute': { handling: 'declined', note: `${NATIVE_ONLY}: the session registers no command` },
  'command.completed': { handling: 'declined', note: `${NATIVE_ONLY}: the session registers no command` },
  'auto_mode_switch.requested': { handling: 'declined', note: ROUTING },
  'auto_mode_switch.completed': { handling: 'declined', note: ROUTING },
  'auto_mode_recovery_consent.requested': { handling: 'declined', note: ROUTING },
  'auto_mode_recovery_consent.completed': { handling: 'declined', note: ROUTING },
  'auto_mode_recovery.outcome': { handling: 'declined', note: ROUTING },
  'session_limits_exhausted.requested': { handling: 'declined', note: UNANSWERED },
  'session_limits_exhausted.completed': { handling: 'declined', note: UNANSWERED },
  'session.auto_mode_resolved': { handling: 'declined', note: ROUTING },
  'session.managed_plugin_progress': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: the open refuses a session the runtime reports any plugin installed in`,
  },
  'session.managed_settings_resolved': { handling: 'declined', note: NATIVE_ONLY },
  'session.managed_settings_enforced': { handling: 'declined', note: NATIVE_ONLY },
  'commands.changed': { handling: 'declined', note: NATIVE_ONLY },
  'capabilities.changed': { handling: 'declined', note: NATIVE_ONLY },
  'exit_plan_mode.requested': { handling: 'declined', note: UNANSWERED },
  'exit_plan_mode.completed': { handling: 'declined', note: UNANSWERED },
  'human_response.recorded': { handling: 'declined', note: NATIVE_ONLY },
  'session.tools_updated': { handling: 'declined', note: NATIVE_ONLY },
  'session.background_tasks_changed': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: subagent.started, subagent.completed and subagent.failed report each task`,
  },
  'workflow.run_updated': { handling: 'declined', note: NATIVE_ONLY },
  'workflow.run_started': { handling: 'declined', note: NATIVE_ONLY },
  'workflow.run_settled': { handling: 'declined', note: NATIVE_ONLY },
  'session.skills_loaded': {
    handling: 'wired',
    note: "the skills the receipt states, by name; a receipt of its own, the runtime's from then on (source runtime): until it arrives the receipt states the skills handed over and is the host's (source host)",
  },
  'session.custom_agents_updated': { handling: 'declined', note: NATIVE_ONLY },
  'session.mcp_servers_loaded': {
    handling: 'wired',
    note: "the servers the receipt states, each with its status in the runtime's word; a receipt of its own",
  },
  'session.mcp_server_status_changed': {
    handling: 'wired',
    note: "one server's status in the receipt; a receipt of its own",
  },
  'session.mcp_server_tools_loaded': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: it counts a server's tools and names none; the gate asks the runtime for a server's tools by name`,
  },
  'session.mcp_server_removed': { handling: 'declined', note: NATIVE_ONLY },
  'session.mcp_server_needs_reconnect': { handling: 'declined', note: NATIVE_ONLY },
  'mcp.tools.list_changed': { handling: 'declined', note: NATIVE_ONLY },
  'mcp.resources.list_changed': { handling: 'declined', note: NATIVE_ONLY },
  'mcp.prompts.list_changed': { handling: 'declined', note: NATIVE_ONLY },
  'session.extensions_loaded': { handling: 'declined', note: NO_SURFACE },
  'session.canvas.opened': { handling: 'declined', note: NO_SURFACE },
  'session.canvas.registry_changed': { handling: 'declined', note: NO_SURFACE },
  'session.canvas.closed': { handling: 'declined', note: NO_SURFACE },
  'session.canvas.unavailable': { handling: 'declined', note: NO_SURFACE },
  'session.canvas.recorded': { handling: 'declined', note: NO_SURFACE },
  'session.canvas.removed': { handling: 'declined', note: NO_SURFACE },
  'session.extensions.attachments_pushed': { handling: 'declined', note: NO_SURFACE },
  'mcp_app.tool_call_complete': { handling: 'declined', note: NO_SURFACE },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** The one table, by what it covers. */
export const COPILOT_COVERAGE = { events: COPILOT_EVENT_COVERAGE } as const;

type WiredOf<T> = { [K in keyof T]: T[K] extends { readonly handling: 'wired' } ? K : never }[keyof T];

/** The event rows whose handling is `wired`: what a Copilot cause can name. */
export type CopilotWiredEvent = WiredOf<typeof COPILOT_EVENT_COVERAGE>;

/** The wired event rows, in table order: the names after `copilot:` in a cause event. */
export function copilotWiredEvents(): readonly CopilotWiredEvent[] {
  return Object.keys(COPILOT_EVENT_COVERAGE).filter(
    (key) => (COPILOT_EVENT_COVERAGE as Readonly<Record<string, CoverageRow>>)[key]?.handling === 'wired',
  ) as CopilotWiredEvent[];
}
