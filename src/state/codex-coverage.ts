/**
 * Every notification, server request and item kind of the pinned Codex release, wired or declined,
 * each with its reason: Codex's counterpart of `HOOK_COVERAGE` and `MESSAGE_COVERAGE`.
 *
 * - A notification row is `wired` when this host receives it: it rides the session's update or delta
 *   lane as the native message (`runtime: 'codex'`), and the note names the transition or fact it
 *   feeds, or says it rides alone. A row is `declined` when this host never receives it: a stable
 *   notification it opts out of at `initialize` (`optOutNotificationMethods`), or an experimental one,
 *   which reaches only a connection that opted into experimental API, and this host never does.
 * - A server-request row is `wired` when the adapter answers it, and the note says with what: the
 *   session's gate decides an approval, and nothing is ever granted wider than the one call. Every
 *   request is answered, because silence would hold the turn forever. A `declined` request is answered
 *   `-32601`.
 * - An item-kind row is `wired` when the kind moves the machine, feeds a fact or fills a conversation
 *   item (`CODEX_ITEM_FILLS`, `host/codex-items.ts`), and `declined` when it only rides inside the native
 *   `item/started` and `item/completed`. Only the session's own thread fills items: a sub-agent's thread
 *   rides its native messages, because an item has no member naming the call that started it.
 *
 * Kept honest by `pins/codex-coverage.test.ts`: the keys of each table equal the names the release
 * declares (`contracts/codex-protocol-names.json`), in both directions; every experimental name is
 * declined; and the cause events Codex can name a transition with are exactly the wired notifications.
 */
import type { CoverageRow } from './coverage.js';

/** Received but feeding nothing on this host: the native message is all there is. */
const NATIVE_ONLY = 'rides the native message only; it moves nothing and feeds no fact';

/** Never received: the stable notifications this host opts out of at initialize. */
const OPTED_OUT = 'opted out at initialize, so never received';

/** Never received: experimental notifications reach only a connection that opted into experimental API. */
const EXPERIMENTAL = 'experimental: not received without the opt-in, which this host never sends';

export const CODEX_NOTIFICATION_COVERAGE = {
  error: {
    handling: 'wired',
    note: 'willRetry false: the turn failed, state -> errored with the error in the detail, and an error notice item. willRetry true: the runtime retries on its own, and a warning notice item rides with the native message',
  },
  'thread/started': {
    handling: 'wired',
    note: 'state -> ready, the first one carrying the control tier; the thread id is the session handle',
  },
  'thread/status/changed': {
    handling: 'wired',
    note: 'systemError -> errored; active with waitingOnApproval opens a permission entry and waitingOnUserInput an elicitation entry; any other status closes both',
  },
  'thread/archived': { handling: 'declined', note: `${OPTED_OUT}: this host never archives a thread` },
  'thread/deleted': { handling: 'declined', note: `${OPTED_OUT}: this host never deletes a thread` },
  'thread/unarchived': { handling: 'declined', note: `${OPTED_OUT}: this host never archives a thread` },
  'thread/closed': { handling: 'wired', note: 'state -> ended: the thread is unloaded and takes no turn' },
  'thread/reverted': { handling: 'declined', note: `${OPTED_OUT}: revert needs experimental API` },
  'skills/changed': {
    handling: 'wired',
    note: 'the adapter reads skills/list again, and a changed answer is a fresh receipt',
  },
  'thread/name/updated': {
    handling: 'declined',
    note: `${OPTED_OUT}: a display name, not a fact a controller acts on`,
  },
  'thread/attachment/updated': {
    handling: 'declined',
    note: `${OPTED_OUT}: this host attaches nothing to a thread`,
  },
  'thread/goal/updated': { handling: 'declined', note: `${OPTED_OUT}: this host sets no thread goal` },
  'thread/prediction/updated': { handling: 'declined', note: EXPERIMENTAL },
  'thread/goal/cleared': { handling: 'declined', note: `${OPTED_OUT}: this host sets no thread goal` },
  'thread/queue/changed': { handling: 'declined', note: EXPERIMENTAL },
  'project/changed': { handling: 'declined', note: EXPERIMENTAL },
  'thread/project/updated': { handling: 'declined', note: EXPERIMENTAL },
  'thread/environment/connected': { handling: 'declined', note: EXPERIMENTAL },
  'thread/environment/disconnected': { handling: 'declined', note: EXPERIMENTAL },
  'thread/settings/updated': { handling: 'declined', note: EXPERIMENTAL },
  'thread/tokenUsage/updated': {
    handling: 'wired',
    note: 'a usage sample (context tokens are the last call total, Codex own rule); the newest one for a turn is that turn record totals, the thread running total: a resumed or forked thread includes the source thread tokens, which Codex restores from the rollout. It names no model, so the model is the session model register. inputTokens is input minus cached input, floored at zero: Codex own split, so it counts uncached input only',
  },
  'turn/started': {
    handling: 'wired',
    note: 'state -> working: a turn this host started is running; a turn item, started; the sub-agents settled in the turn before are cleared from the tasks fact',
  },
  'hook/started': {
    handling: 'wired',
    note: `${NATIVE_ONLY}; the gate's watch reads periscope's own hook runs from hook/completed`,
  },
  'turn/completed': {
    handling: 'wired',
    note: 'turn.status completed -> idle, interrupted -> interrupted, failed -> errored with the error in the detail; a turn record; a turn item with the same status and the error as its detail (inProgress, or a status this host does not know, fills none); the next held prompt starts',
  },
  'hook/completed': {
    handling: 'wired',
    note: "the gate's watch reads periscope's own runs: failed raises gate-hook-timed-out, gate-hook-output-rejected or gate-hook-unspawnable by the run's error; completed for a call the host never decided raises gate-hook-missing; blocked with no host decision is recorded as a refused or expired outcome",
  },
  'turn/diff/updated': {
    handling: 'declined',
    note: `${OPTED_OUT}: the aggregate diff; each fileChange item carries its own`,
  },
  'turn/plan/updated': {
    handling: 'wired',
    note: 'a plan item: the explanation, then one line per step with its status; each update is a whole plan of its own',
  },
  'item/started': {
    handling: 'wired',
    note: "a tool item opens a tool entry (state -> working) and fills its tool_call item; a contextCompaction item opens the compaction entry; the item kind rides the cause detail. The gate's watch raises gate-hook-missing for a command, patch or MCP item the host never decided, and gate-unhooked-call for a web search or an image generation",
  },
  'item/autoApprovalReview/started': {
    handling: 'wired',
    note: `${NATIVE_ONLY}: the reviewer is pinned to the client, so it is not expected; its completion is what raises the degrade`,
  },
  'item/autoApprovalReview/completed': {
    handling: 'wired',
    note: "raises gate-approval-auto-reviewed: an approval Codex's own reviewer decided. The reviewer is pinned to the client, so it is not expected",
  },
  'autoApprovalReview/strictReviewRequired': { handling: 'declined', note: EXPERIMENTAL },
  'item/completed': {
    handling: 'wired',
    note: 'closes the tool entry or the compaction entry the item opened; a collab tool call or sub-agent activity changes the running tasks; the completed item fills its conversation items (CODEX_ITEM_FILLS)',
  },
  'rawResponseItem/completed': {
    handling: 'declined',
    note: `${OPTED_OUT}: sent only for experimentalRawEvents, which this host never asks for`,
  },
  'rawResponse/completed': {
    handling: 'declined',
    note: `${OPTED_OUT}: sent only for experimentalRawEvents, which this host never asks for`,
  },
  'item/agentMessage/delta': {
    handling: 'wired',
    note: 'a text fragment; rides the delta lane, droppable, since the completed item restates it',
  },
  'item/plan/delta': { handling: 'declined', note: `${OPTED_OUT}: the plan completes into its own item` },
  'command/exec/outputDelta': {
    handling: 'declined',
    note: `${OPTED_OUT}: command/exec runs a string with full access, and this host never calls it`,
  },
  'process/outputDelta': { handling: 'declined', note: EXPERIMENTAL },
  'process/exited': { handling: 'declined', note: EXPERIMENTAL },
  'item/commandExecution/outputDelta': {
    handling: 'declined',
    note: `${OPTED_OUT}: the output completes into the item's aggregatedOutput`,
  },
  'item/commandExecution/terminalInteraction': {
    handling: 'wired',
    note: 'raises gate-unhooked-call, once per command: input written to a running command, which no hook sees, unless an approval this host decided covered it',
  },
  'item/fileChange/outputDelta': {
    handling: 'declined',
    note: `${OPTED_OUT}: deprecated upstream; the fileChange item carries the change`,
  },
  'item/fileChange/patchUpdated': {
    handling: 'declined',
    note: `${OPTED_OUT}: the fileChange item carries the final change`,
  },
  'serverRequest/resolved': {
    handling: 'wired',
    note: `${NATIVE_ONLY}: the close of a request this host answered; a decision still outstanding for it is abandoned`,
  },
  'item/mcpToolCall/progress': {
    handling: 'declined',
    note: `${OPTED_OUT}: progress of a call whose item completes`,
  },
  'mcpServer/oauthLogin/completed': {
    handling: 'declined',
    note: `${OPTED_OUT}: this host starts no MCP sign-in`,
  },
  'mcpServer/startupStatus/updated': {
    handling: 'wired',
    note: "a server's status changes the receipt's mcpServers, and a changed receipt is sent fresh",
  },
  'mcpServer/event/stream/notification': { handling: 'declined', note: EXPERIMENTAL },
  'account/updated': { handling: 'wired', note: NATIVE_ONLY },
  'account/gatewayOAuth/changed': {
    handling: 'declined',
    note: `${OPTED_OUT}: this host starts no gateway sign-in`,
  },
  'account/rateLimits/updated': { handling: 'wired', note: NATIVE_ONLY },
  'app/list/updated': { handling: 'declined', note: `${OPTED_OUT}: this host lists no apps` },
  'remoteControl/status/changed': {
    handling: 'declined',
    note: `${OPTED_OUT}: this host enables no remote control`,
  },
  'externalAgentConfig/import/progress': {
    handling: 'declined',
    note: `${OPTED_OUT}: this host imports no other agent configuration`,
  },
  'externalAgentConfig/import/completed': {
    handling: 'declined',
    note: `${OPTED_OUT}: this host imports no other agent configuration`,
  },
  'fs/changed': { handling: 'declined', note: `${OPTED_OUT}: this host watches no path through the server` },
  'item/reasoning/summaryTextDelta': {
    handling: 'wired',
    note: 'a thinking fragment; rides the delta lane, droppable, since the completed item restates it',
  },
  'item/reasoning/summaryPartAdded': {
    handling: 'declined',
    note: `${OPTED_OUT}: a part boundary; the text arrives as its own deltas`,
  },
  'item/reasoning/textDelta': {
    handling: 'wired',
    note: 'a thinking fragment; rides the delta lane, droppable, since the completed item restates it',
  },
  'thread/compacted': {
    handling: 'declined',
    note: `${OPTED_OUT}: deprecated upstream; the contextCompaction item reports a compaction`,
  },
  'model/rerouted': {
    handling: 'wired',
    note: 'the model register takes the model actually used, and the receipt is sent fresh with it',
  },
  'model/verification': { handling: 'declined', note: `${OPTED_OUT}: not a fact a controller acts on` },
  'modelProvider/authRecoveryStarted': { handling: 'wired', note: NATIVE_ONLY },
  'modelProvider/authRecoveryCompleted': { handling: 'wired', note: NATIVE_ONLY },
  'turn/moderationMetadata': { handling: 'declined', note: EXPERIMENTAL },
  'model/safetyBuffering/updated': {
    handling: 'declined',
    note: `${OPTED_OUT}: not a fact a controller acts on`,
  },
  warning: {
    handling: 'wired',
    note: "a warning notice item, when it names no thread or the session's own; it moves nothing and feeds no fact",
  },
  guardianWarning: {
    handling: 'wired',
    note: "a warning notice item, on the session's own thread; it moves nothing and feeds no fact",
  },
  deprecationNotice: {
    handling: 'wired',
    note: 'an info notice item: the summary and its details; it moves nothing and feeds no fact',
  },
  configWarning: {
    handling: 'wired',
    note: 'a warning notice item: the summary and its details; it moves nothing and feeds no fact',
  },
  'fuzzyFileSearch/sessionUpdated': {
    handling: 'declined',
    note: `${OPTED_OUT}: this host starts no file search session`,
  },
  'fuzzyFileSearch/sessionCompleted': {
    handling: 'declined',
    note: `${OPTED_OUT}: this host starts no file search session`,
  },
  'thread/realtime/started': { handling: 'declined', note: EXPERIMENTAL },
  'thread/realtime/itemAdded': { handling: 'declined', note: EXPERIMENTAL },
  'thread/realtime/item/started': { handling: 'declined', note: EXPERIMENTAL },
  'thread/realtime/item/transcript/delta': { handling: 'declined', note: EXPERIMENTAL },
  'thread/realtime/item/completed': { handling: 'declined', note: EXPERIMENTAL },
  'thread/realtime/transcript/delta': { handling: 'declined', note: EXPERIMENTAL },
  'thread/realtime/transcript/done': { handling: 'declined', note: EXPERIMENTAL },
  'thread/realtime/outputAudio/delta': { handling: 'declined', note: EXPERIMENTAL },
  'thread/realtime/sdp': { handling: 'declined', note: EXPERIMENTAL },
  'thread/realtime/error': { handling: 'declined', note: EXPERIMENTAL },
  'thread/realtime/closed': { handling: 'declined', note: EXPERIMENTAL },
  'windows/worldWritableWarning': { handling: 'wired', note: NATIVE_ONLY },
  'windowsSandbox/setupCompleted': {
    handling: 'declined',
    note: `${OPTED_OUT}: this host starts no sandbox setup`,
  },
  'account/login/completed': {
    handling: 'declined',
    note: `${OPTED_OUT}: sign-in is the operator's own act, never this host's`,
  },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** Declined: answered `-32601`, never left waiting. */
const NOT_HANDLED = 'answered -32601';

export const CODEX_SERVER_REQUEST_COVERAGE = {
  'item/commandExecution/requestApproval': {
    handling: 'wired',
    note: "decided by the session's gate: from the hook's decision for the same call when there is one, fresh otherwise; input for a running command always fresh; accept, decline or cancel only, decline at the host's deadline with gate-approval-unanswered",
  },
  'item/fileChange/requestApproval': {
    handling: 'wired',
    note: "decided by the session's gate: from the hook's decision when it names every file the change lists, fresh as apply_patch over those files otherwise; accept, decline or cancel only, never the root it offers",
  },
  'item/permissions/requestApproval': {
    handling: 'wired',
    note: 'answered with an empty grant for the turn: the widening asked for is never given',
  },
  'mcpServer/elicitation/request': {
    handling: 'wired',
    note: "an MCP tool approval (every MCP server this host attaches asks here before each tool call) is decided by the session's gate for the call pending on that server, from the hook's decision or fresh; with several pending, accept only if every one is allowed, else decline with gate-approval-ambiguous. A form or a link is declined, with no content",
  },
  'item/tool/requestUserInput': {
    handling: 'wired',
    note: 'answered with no answers: nobody sits on this lane to type one',
  },
  'item/tool/call': {
    handling: 'declined',
    note: `${NOT_HANDLED}: sent only for dynamic tools, which this host never registers`,
  },
  'account/chatgptAuthTokens/refresh': {
    handling: 'declined',
    note: `${NOT_HANDLED}: sent only after a sign-in with client-held tokens, which this host never starts`,
  },
  'attestation/generate': {
    handling: 'declined',
    note: `${NOT_HANDLED}: sent only when initialize asked for attestation, which this host never does`,
  },
  'currentTime/read': {
    handling: 'declined',
    note: `experimental: not sent without the opt-in, which this host never sends; ${NOT_HANDLED} if it arrives`,
  },
  applyPatchApproval: {
    handling: 'declined',
    note: `${NOT_HANDLED}: the first protocol's approval, which the server no longer sends`,
  },
  execCommandApproval: {
    handling: 'declined',
    note: `${NOT_HANDLED}: the first protocol's approval, which the server no longer sends`,
  },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** Rides inside the native item notifications; moves nothing and feeds no fact. */
const ITEM_NATIVE_ONLY =
  'rides inside the native item/started and item/completed; it moves nothing and feeds no fact';

export const CODEX_ITEM_COVERAGE = {
  userMessage: {
    handling: 'wired',
    note: 'a user_text item: the prompt as Codex took it, its text inputs joined; other inputs fill nothing',
  },
  hookPrompt: {
    handling: 'wired',
    note: 'an info notice item: the context a hook added, its fragments joined',
  },
  agentMessage: {
    handling: 'wired',
    note: "an agent_text item, final read from the message stage: final_answer true, commentary and partial_answer false, and no stage or any other word null (never guessed). The turn's answer is the last agent_text with final true, else the last with final null: the consumer's reading, never this host's. The text also rode as fragments",
  },
  functionCallOutput: {
    handling: 'declined',
    note: `${ITEM_NATIVE_ONLY}: the output of a tool this host would have answered, and it answers none`,
  },
  plan: { handling: 'wired', note: 'a plan item: the plan text' },
  reasoning: {
    handling: 'wired',
    note: 'thinking items: the summary (summary true) and the reasoning text (summary false, its id with :raw), each where non-empty; one empty item where both are. The text also rode as fragments',
  },
  commandExecution: {
    handling: 'wired',
    note: 'opens and closes a tool entry, tool:Bash, keyed by the item id; a tool_call (shell, input command and cwd) and a tool_result (status, aggregatedOutput, exitCode and durationMs as reported, null where not)',
  },
  fileChange: {
    handling: 'wired',
    note: 'opens and closes a tool entry, tool:apply_patch, keyed by the item id; a tool_call (file_edit, input paths) and a tool_result with each change (path, change, movePath, diff as reported)',
  },
  mcpToolCall: {
    handling: 'wired',
    note: 'opens and closes a tool entry, tool:mcp__{server}__{tool}, keyed by the item id; a tool_call (mcp, input its arguments) and a tool_result (the error message, else the result content as JSON)',
  },
  dynamicToolCall: { handling: 'declined', note: `${ITEM_NATIVE_ONLY}: this host registers no dynamic tool` },
  collabAgentToolCall: {
    handling: 'wired',
    note: 'opens and closes a tool entry named by its tool word; spawnAgent adds each receiver thread to the running tasks, and closeAgent or a settled agent state removes it and states how it settled; a tool_call (other) and a tool_result (interrupted reads failed)',
  },
  subAgentActivity: {
    handling: 'wired',
    note: 'started adds the agent thread to the running tasks; completed or interrupted removes it and states how it settled; an info notice item',
  },
  webSearch: {
    handling: 'wired',
    note: 'opens and closes a tool entry, tool:web_search, keyed by the item id; a tool_call (web) and a tool_result; hosted search runs at the provider and is disabled in the session flags',
  },
  imageView: {
    handling: 'wired',
    note: 'opens and closes a tool entry, tool:view_image, keyed by the item id; a tool_call (file_read, input path) and a tool_result',
  },
  sleep: { handling: 'declined', note: `${ITEM_NATIVE_ONLY}: a wait the runtime chose` },
  imageGeneration: {
    handling: 'wired',
    note: 'opens and closes a tool entry, tool:image_generation, keyed by the item id; a tool_call (other) and a tool_result (failed when it reports a failure)',
  },
  enteredReviewMode: { handling: 'declined', note: `${ITEM_NATIVE_ONLY}: this host starts no review` },
  exitedReviewMode: { handling: 'declined', note: `${ITEM_NATIVE_ONLY}: this host starts no review` },
  contextCompaction: {
    handling: 'wired',
    note: 'opens and closes the compaction entry, and its compaction fact (trigger auto; no token counts, since the item reports none); an info notice item',
  },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** The three tables, by what they cover. */
export const CODEX_COVERAGE = {
  notifications: CODEX_NOTIFICATION_COVERAGE,
  serverRequests: CODEX_SERVER_REQUEST_COVERAGE,
  itemKinds: CODEX_ITEM_COVERAGE,
} as const;

export type CodexNotificationMethod = keyof typeof CODEX_NOTIFICATION_COVERAGE;

type WiredOf<T> = { [K in keyof T]: T[K] extends { readonly handling: 'wired' } ? K : never }[keyof T];

/** The notifications this host receives. */
export type CodexWiredNotification = WiredOf<typeof CODEX_NOTIFICATION_COVERAGE>;

/** The notification names whose row is `wired`, in table order. */
export function codexWiredNotifications(): readonly CodexWiredNotification[] {
  return (Object.keys(CODEX_NOTIFICATION_COVERAGE) as CodexNotificationMethod[]).filter(
    (method): method is CodexWiredNotification => CODEX_NOTIFICATION_COVERAGE[method].handling === 'wired',
  );
}
