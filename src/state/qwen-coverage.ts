/**
 * Every message type, system subtype, stream event, content block and control request of the pinned
 * Qwen Code release, wired or declined, each with its reason: Qwen Code's counterpart of
 * `MESSAGE_COVERAGE` and `CODEX_COVERAGE`. Its messages are shaped like Claude's, and that is why the
 * table is its own: the same names arrive with members missing or differently timed, and a Claude row
 * would claim a fact Qwen never reports.
 *
 * - Every stream message is received: the CLI writes each one, and each rides the session's update or
 *   delta lane as the native message (`runtime: 'qwen-code'`). A row is `wired` when it also moves the
 *   machine, feeds a fact or fills a conversation item, and the note says which; `declined` when the
 *   native message is all there is.
 * - A control-request row (`controlRequests`) is a request the CLI sends this host: `wired` when the
 *   adapter decides it, `declined` when it is answered with an error.
 * - An answer row (`answers`) is the answer to a request this host sends: `wired` when the host sends it
 *   and its answer feeds something, `declined` when the host never sends it.
 *
 * Kept honest by `pins/qwen-coverage.test.ts`: the keys of each table equal the names the release
 * declares (`contracts/qwen-code-names.json`), in both directions, and the cause events Qwen Code can
 * name a transition with are exactly the wired message and answer rows.
 */
import type { CoverageRow } from './coverage.js';

/** Received and riding alone: the native message is all there is. */
const NATIVE_ONLY = 'rides the native message only; it moves nothing and feeds no fact';

/** Never sent by this host, so never answered. */
const NEVER_SENT = 'this host never sends it';

/**
 * Each stream message, keyed as the cause names it: its `type`, and `system/{subtype}` for the system
 * family.
 */
export const QWEN_MESSAGE_COVERAGE = {
  user: {
    handling: 'wired',
    note: "each tool_result block closes its tool entry and fills a tool_result item (blocked when this host refused the call, failed on is_error, else completed); the prompt itself is never echoed, so the user_text item is this host's own prompt",
  },
  assistant: {
    handling: 'wired',
    note: "text, thinking and tool_use blocks fill agent_text, thinking and tool_call items; a tool_use block opens a tool entry; message.model moves the model register; one model call's usage rides on one of the call's messages and is not summed",
  },
  result: {
    handling: 'wired',
    note: "state -> idle, or errored with error.message in the detail, or interrupted on \"Operation cancelled.\"; closes any tool entry left open; turn_record with totals = usage, the session's running total (a resumed or forked session's includes the source session's tokens), turn and turnScope null, cost null and unreported, inputTokens = input_tokens - cache_read_input_tokens, Qwen's own split; a turn item; then get_context_usage. Sign-in marker: an is_error result with num_turns 0 whose error.message names the auth type or the API key, written before the session loop",
  },
  stream_event: {
    handling: 'wired',
    note: 'rides the delta lane; a content_block_delta is a fragment (stream events table)',
  },
  'system/init': {
    handling: 'wired',
    note: "written once per processed user message: state -> working; the receipt refreshed from model, permission_mode (Qwen's own mode word), mcp_servers and qwen_code_version; the first one's tools checked against the ask rules (gate-tool-unruled); a mode outside default and plan raises gate-mode-widened; a changed session_id is a new session handle. Its uuid is the session id, so no fact names it as a source",
  },
  'system/task_started': {
    handling: 'wired',
    note: "data { task_id, tool_use_id, description }: the task joins the tasks fact's running list",
  },
  'system/task_notification': {
    handling: 'wired',
    note: 'data { task_id, status }: completed, failed or cancelled settles the task in the tasks fact (cancelled reads as stopped); running keeps it running',
  },
  'system/retry': {
    handling: 'wired',
    note: 'a warning notice item: the CLI retries the model call on its own',
  },
  'system/model_fallback': {
    handling: 'wired',
    note: 'a warning notice item; data.toModel moves the model register and the receipt',
  },
  'system/continue_turn_failed': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: written only after continue_last_turn, which this host never sends`,
  },
  'system/worktree_started': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: this host never asks the CLI for a worktree; the session runs in its own`,
  },
  'system/worktree_restored': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: this host never asks the CLI for a worktree`,
  },
  'system/vision_routing': { handling: 'declined', note: NATIVE_ONLY },
  'system/vision_bridge': { handling: 'declined', note: NATIVE_ONLY },
  'system/vision_bridge_failed': { handling: 'declined', note: NATIVE_ONLY },
  'system/session_recording_degraded': {
    handling: 'wired',
    note: 'a warning notice item: the CLI could not record the session, so a later resume may find nothing',
  },
  'system/ui_log': { handling: 'declined', note: `${NATIVE_ONLY}: a mod's log line; this host loads none` },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** Each event a `stream_event` carries, when the session asked for partial messages. */
export const QWEN_STREAM_EVENT_COVERAGE = {
  message_start: { handling: 'declined', note: NATIVE_ONLY },
  content_block_start: { handling: 'declined', note: NATIVE_ONLY },
  content_block_delta: {
    handling: 'wired',
    note: 'text_delta, thinking_delta and input_json_delta are text, thinking and tool_input fragments; input_json_delta carries the whole input at once',
  },
  content_block_stop: { handling: 'declined', note: NATIVE_ONLY },
  message_stop: { handling: 'declined', note: NATIVE_ONLY },
  tool_progress: { handling: 'declined', note: NATIVE_ONLY },
  goal_state: { handling: 'declined', note: `${NATIVE_ONLY}; written even without partial messages` },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** Each content block an assistant or user message carries. */
export const QWEN_CONTENT_BLOCK_COVERAGE = {
  text: { handling: 'wired', note: 'an agent_text item, final null: Qwen marks no answer' },
  thinking: { handling: 'wired', note: 'a thinking item, summary false' },
  tool_use: { handling: 'wired', note: 'a tool_call item and a tool entry, named by the block id' },
  tool_result: { handling: 'wired', note: 'a tool_result item, closing the tool_call of the same id' },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** Each control request the CLI sends this host. */
export const QWEN_CONTROL_REQUEST_COVERAGE = {
  can_use_tool: {
    handling: 'wired',
    note: "decided by the session's gate through the per-call decision every runtime shares: allow with the input as asked, or deny with the reason. tool_use_id is the tool_use block's id. A rewritten input is refused: the CLI runs the call it built from the original arguments",
  },
  mcp_message: {
    handling: 'declined',
    note: 'answered with an error: this host registers no in-process MCP server with the CLI',
  },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** Each control request the CLI answers, by what this host does with the answer. */
export const QWEN_ANSWER_COVERAGE = {
  initialize: {
    handling: 'wired',
    note: "sent first, with the permission timeout above the host's decision deadline, the effort and the MCP servers: state -> ready, the first one carrying the control tier; session_id is the session handle; effort_status is the receipt's effort",
  },
  interrupt: {
    handling: 'wired',
    note: 'aborts the running turn only; its result says Operation cancelled. and the state moves to interrupted',
  },
  set_model: { handling: 'wired', note: 'a receipt composed by this host (source host) with the model' },
  set_permission_mode: {
    handling: 'wired',
    note: 'default or plan only; a receipt composed by this host (source host) with the mode',
  },
  set_effort: { handling: 'wired', note: 'a receipt composed by this host (source host) with the effort' },
  get_context_usage: {
    handling: 'wired',
    note: "sent after each result: a usage_sample (totalTokens, contextWindowSize, mainThread true); its skills list is the runtime's receipt of the skills it found (source runtime)",
  },
  continue_last_turn: { handling: 'declined', note: NEVER_SENT },
  supported_commands: { handling: 'declined', note: NEVER_SENT },
  get_available_models: {
    handling: 'declined',
    note: `${NEVER_SENT}: a session's models are its endpoint's`,
  },
  get_usage_info: { handling: 'declined', note: NEVER_SENT },
  can_use_tool: { handling: 'declined', note: `${NEVER_SENT}: the CLI asks it of this host` },
  mcp_server_status: {
    handling: 'declined',
    note: `${NEVER_SENT}: it lists in-process servers only, and the init lists every server`,
  },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** The five tables, by what they cover. */
export const QWEN_COVERAGE = {
  messages: QWEN_MESSAGE_COVERAGE,
  streamEvents: QWEN_STREAM_EVENT_COVERAGE,
  contentBlocks: QWEN_CONTENT_BLOCK_COVERAGE,
  controlRequests: QWEN_CONTROL_REQUEST_COVERAGE,
  answers: QWEN_ANSWER_COVERAGE,
} as const;

type WiredOf<T> = { [K in keyof T]: T[K] extends { readonly handling: 'wired' } ? K : never }[keyof T];

/** The message and answer rows whose handling is `wired`: what a Qwen cause can name. */
export type QwenWiredEvent = WiredOf<typeof QWEN_MESSAGE_COVERAGE> | WiredOf<typeof QWEN_ANSWER_COVERAGE>;

/** The wired message and answer rows, in table order: the names after `qwen-code:` in a cause event. */
export function qwenWiredEvents(): readonly QwenWiredEvent[] {
  const wired = <T extends Readonly<Record<string, CoverageRow>>>(table: T): string[] =>
    Object.keys(table).filter((key) => table[key]?.handling === 'wired');
  return [...wired(QWEN_MESSAGE_COVERAGE), ...wired(QWEN_ANSWER_COVERAGE)] as QwenWiredEvent[];
}
