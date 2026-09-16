/**
 * The stream routing table. Every message the agent can emit rides a declared lane, in writing.
 *
 * An absent row is a gap, not a default, and it cannot happen, because this is declared
 * `satisfies Record<MessageDiscriminator, RoutingRow>` against the discriminator set derived from
 * the SDK's own union. A message added by an SDK upgrade breaks the build rather than silently
 * falling through to whichever lane a branch happened to end on.
 *
 * This is not `state/coverage.ts` and must not be merged with it. They answer different
 * questions and disagree in both directions:
 *   - `coverage.ts`: does this message move the state machine?
 *   - this table: does this message go on the wire, and on which lane?
 * `assistant` is declined there (it changes no state) and forwarded here (it is the turn's text).
 * `system/session_state_changed` is wired there and declined here (the transition it causes already
 * carries the fact, and two names for one fact is how a vocabulary drifts apart). A single table
 * would have to pick one question and would silently answer the other one wrongly.
 *
 * The three lanes, and the rule that assigns them.
 *
 *   `delta`     Superseded by something that settles the same fact, and high-frequency with it.
 *               Losing one costs a repaint, never a fact — which is exactly what makes it the one
 *               droppable kind. ~20 per turn, so putting these in a bounded replay ring would evict
 *               real events with token fragments.
 *
 *   `update`    A fact of the turn that nothing later restates. Durable: retained until acked,
 *               replayed after a reconnect.
 *
 *   `declined`  Only where the fact demonstrably reaches the wire another way, or where
 *               forwarding it would echo the host's own decisions back at the controller that made
 *               them. Never "judged uninteresting": this host is deliberately ignorant, and
 *               `state/reporter.ts` states the reason: a host that decides what matters is a host
 *               that must be rebuilt for the next product. So `update` is the default, and a
 *               declined row owes a reason a stranger can check.
 */
import type { MessageDiscriminator, SDKMessage } from '../host/agent-process.js';
import { discriminatorOf } from '../host/agent-process.js';

export type StreamLane = 'delta' | 'update' | 'declined';

export interface RoutingRow {
  readonly lane: StreamLane;
  /** Why this lane. Required on every row, including the declined ones. */
  readonly note: string;
}

export const MESSAGE_ROUTING = {
  // --- delta: superseded, high-frequency, broadcast-only ---------------------
  stream_event: {
    lane: 'delta',
    note: 'the incremental lane — text_delta, thinking_delta, input_json_delta, and the block start/stop markers around them. Every fragment is superseded by the assistant message that settles it, so a lost one costs a repaint. Exists at all only under includePartialMessages.',
  },
  'system/thinking_tokens': {
    lane: 'delta',
    note: 'a running thinking-token estimate, emitted per thinking delta. Its own docs call it approximate progress for spinners rather than the billed count, and the next one supersedes it.',
  },
  'system/status': {
    lane: 'delta',
    note: 'the requesting/compacting ticker. Each value supersedes the last and the transition it causes is the durable record; this lane exists so a view can show the spinner without waiting for one.',
  },
  tool_progress: {
    lane: 'delta',
    note: 'elapsed seconds for a running tool call, re-emitted while it runs. Superseded by the next tick and finally by the tool closing.',
  },
  'system/task_progress': {
    lane: 'delta',
    note: 'progress for a background task, re-emitted while it runs. Same shape as tool_progress and superseded the same way.',
  },
  'system/hook_progress': {
    lane: 'delta',
    note: 'progress while a hook handler runs — a ticker, superseded by the hook resolving.',
  },

  // --- update: facts of the turn that nothing later restates -----------------
  'system/init': {
    lane: 'update',
    note: 'the per-spawn receipt — session id, CLI version, model, tool/skill/plugin inventory, apiKeySource. It arrives once and nothing restates it.',
  },
  assistant: {
    lane: 'update',
    note: 'the settled assistant message. The fact the deltas were fragments of; a consumer with no delta lane still renders a turn from these.',
  },
  user: {
    lane: 'update',
    note: "tool results — that is what this row carries in practice. Observed on a live session: the queued prompt does not come back on the output stream for this host's input lane, so no SDKUserMessageReplay arrives to deduplicate against. This host still synthesizes no user echo of its own, because the controller queued the prompt and already holds the operator's turn — a synthesized event would be a second name for it.",
  },
  result: {
    lane: 'update',
    note: "the turn's outcome, and the telemetry that arrives with it: total_cost_usd, modelUsage[].costUSD per model, permission_denials, ttft_ms, user_message_uuid and terminal_reason (19 values). Forwarded whole so the layer that owns cost consumes these rather than re-deriving them.",
  },
  rate_limit_event: {
    lane: 'update',
    note: 'rate-limit state with resetsAt and utilization, in-stream. Losing one loses a reset time nothing else carries.',
  },
  'system/compact_boundary': {
    lane: 'update',
    note: 'compaction happened and this is where. A durable fact about the transcript, and the boundary anything reading history has to know about.',
  },
  'system/api_retry': {
    lane: 'update',
    note: 'a request failed and is being retried. Nothing else carries it, and an unattended run that is quietly retrying looks identical to one that is thinking.',
  },
  'system/model_refusal_fallback': {
    lane: 'update',
    note: 'the model refused and a fallback ran. The counterpart of model_refusal_no_fallback, which moves the machine; this one does not, so forwarding is the only way the fact travels.',
  },
  'system/model_refusal_no_fallback': {
    lane: 'update',
    note: 'the model refused and nothing ran. It also causes a transition, but the message names the original model, which the transition does not.',
  },
  'system/local_command_output': {
    lane: 'update',
    note: 'output of a local command, which is content a consumer renders. Not restated anywhere.',
  },
  'system/session_state_changed': {
    lane: 'declined',
    note: 'its entire content is state: idle|running|requires_action, and the transition it causes carries exactly that in `to`. Forwarding it too would put two names for one fact on the wire — the reason session_started and session_ended were removed from the payload kinds.',
  },
  'system/task_started': {
    lane: 'update',
    note: 'the only message carrying task_id AND tool_use_id together — the join a consumer needs to attribute later task reports. The transition lane deliberately records nothing here.',
  },
  'system/task_updated': {
    lane: 'update',
    note: 'a task changed status or was backgrounded. It causes a transition, and it also carries the patch itself, which the transition does not.',
  },
  'system/task_notification': {
    lane: 'update',
    note: 'a background task finished and says how. Causes a transition; the message carries the status text.',
  },
  'system/background_tasks_changed': {
    lane: 'update',
    note: 'the set of background tasks changed. Nothing else enumerates them, and a session whose work moved to the background is the case this whole split exists for.',
  },
  'system/worker_shutting_down': {
    lane: 'update',
    note: 'the worker is going away, with its reason. Causes a transition; the reason is worth carrying verbatim.',
  },
  'system/permission_denied': {
    lane: 'update',
    note: "the SDK's own auto-deny short-circuit — a different path from this host's gate, which the SDK's docs say explicitly does not produce this message. Nothing this package emits restates it.",
  },
  'system/elicitation_complete': {
    lane: 'update',
    note: 'an MCP elicitation resolved, with what it resolved to. The transition records the exit; the answer rides here.',
  },
  'system/plugin_install': {
    lane: 'update',
    note: 'a plugin was installed mid-session, so the inventory init reported is now stale. Nothing else says so.',
  },
  'system/commands_changed': {
    lane: 'update',
    note: 'the available command set changed. init carries the opening inventory and this carries the change; a consumer showing commands has no other source.',
  },
  'system/notification': {
    lane: 'update',
    note: 'a notification aimed at whoever is watching. Withholding it would be this host deciding what a controller finds worth showing.',
  },
  'system/memory_recall': {
    lane: 'update',
    note: 'what the agent recalled and used. Content, and part of explaining a turn a reader is trying to understand.',
  },
  'system/mirror_error': {
    lane: 'update',
    note: 'a mirror write failed. A degrade is a named outcome and never a silent pass, so it goes on the wire even though this host takes no action on it.',
  },
  'system/informational': {
    lane: 'update',
    note: "an informational message from the agent. Forwarded for the same reason as notification: the judgement is the controller's.",
  },
  tool_use_summary: {
    lane: 'update',
    note: 'a settled summary of a tool call — what a cold reader sees instead of raw arguments.',
  },
  auth_status: {
    lane: 'update',
    note: 'the credential state changed under a running session. An unattended run whose auth lapsed must not look like one that went quiet.',
  },
  prompt_suggestion: {
    lane: 'update',
    note: "a suggested next turn. Product surface, and whether to show it is the controller's call rather than this host's.",
  },
  conversation_reset: {
    lane: 'update',
    note: 'the conversation was reset, so everything a consumer has accumulated for this session is now history rather than context.',
  },

  // --- declined: the fact reaches the wire another way, or it is the host's own ---
  'system/control_request_progress': {
    lane: 'declined',
    note: "progress on the SDK's internal control protocol between this host and its own CLI subprocess. It describes the host's transport, not the session, and a controller can do nothing with it.",
  },
  'system/hook_started': {
    lane: 'declined',
    note: "reports one of this host's own hooks starting. Forwarding it would echo the observer and the gate back at the controller that configured them. The gate's outcomes are recorded as transitions in the machine, and forwardSession's machine subscription carries every recorded transition to the wire whatever caused it — so this message would arrive as a second copy of a fact the transition already states.",
  },
  'system/hook_response': {
    lane: 'declined',
    note: "the answer this host's own hook just returned. Same echo reason as hook_started — and the decision's transition already rides the wire via the machine subscription, so re-reporting the answer here would invite a consumer to count one decision twice.",
  },
  'system/files_persisted': {
    lane: 'declined',
    note: 'a checkpointing receipt. It belongs to the layer that owns the receipt read path, which reads local records rather than the live stream.',
  },
} as const satisfies Record<MessageDiscriminator, RoutingRow>;

/** The lane one message rides. Total by construction — every discriminator has a row. */
export function laneFor(message: SDKMessage): StreamLane {
  return MESSAGE_ROUTING[discriminatorOf(message)].lane;
}

/** Every discriminator on one lane, in declaration order. The subject of the routing pin. */
export function discriminatorsOn(lane: StreamLane): MessageDiscriminator[] {
  return (Object.keys(MESSAGE_ROUTING) as MessageDiscriminator[]).filter(
    (key) => MESSAGE_ROUTING[key].lane === lane,
  );
}
