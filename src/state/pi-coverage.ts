/**
 * Every event, RPC record, RPC command, extension UI method and message delta of the pinned pi release,
 * wired or declined, each with its reason: pi's counterpart of `MESSAGE_COVERAGE`, `CODEX_COVERAGE` and
 * `QWEN_COVERAGE`.
 *
 * - Every event is received: pi writes each one, and each rides the session's update or delta lane as the
 *   native message (`runtime: 'pi'`). A row is `wired` when it also moves the machine, feeds a fact or
 *   fills a conversation item, and the note says which; `declined` when the native message is all there
 *   is.
 * - A record row is a line pi writes beside the events: `wired` when the adapter acts on it.
 * - A command row is a command pi reads: `wired` when this host sends it and its answer feeds something,
 *   `declined` when this host never sends it.
 * - A UI-method row is an extension UI request's method: `wired` when it fills a notice, `declined` when
 *   it is answered, or said, and nothing more.
 * - A delta row is one kind of `message_update`'s delta.
 *
 * Kept honest by `pins/pi-coverage.test.ts`: the keys of each table equal the names the release declares
 * (`contracts/pi-names.json`), in both directions, and the cause events pi can name a transition with are
 * exactly the wired event and command rows. A record causes nothing of its own: an answer moves the
 * machine under its command's name.
 */
import type { CoverageRow } from './coverage.js';

/** Received and riding alone: the native message is all there is. */
const NATIVE_ONLY = 'rides the native message only; it moves nothing and feeds no fact';

/** Never sent by this host, so never answered. */
const NEVER_SENT = 'this host never sends it';

/** Each event pi writes, by its `type`: the agent's events and those the session adds. */
export const PI_EVENT_COVERAGE = {
  agent_start: {
    handling: 'wired',
    note: 'a run began: state -> working; a turn item, started. pi has no turn id, so the turn is named by the session and its count',
  },
  agent_end: {
    handling: 'declined',
    note: `${NATIVE_ONLY}: agent_settled ends the run, after any retry; each message it lists already rode its own message_end`,
  },
  turn_start: {
    handling: 'declined',
    note: `${NATIVE_ONLY}: a pi turn is one model call and its tools, so the conversation's turn is the run (agent_start to agent_settled)`,
  },
  turn_end: {
    handling: 'declined',
    note: `${NATIVE_ONLY}: one model call's end; its message and tool results each rode their own events`,
  },
  message_start: {
    handling: 'declined',
    note: `${NATIVE_ONLY}: message_end carries the whole message`,
  },
  message_update: {
    handling: 'wired',
    note: 'forwarded only when the session asked for partial messages; rides the delta lane, and its text, thinking and tool-call deltas are text, thinking and tool_input fragments (deltas table)',
  },
  message_end: {
    handling: 'wired',
    note: "a user message is the user_text item; an assistant message's text, thinking and toolCall blocks are agent_text (final null: pi marks no answer), thinking (summary false) and tool_call items, its model the model register, its usage's cacheRead the next usage sample's, and a stopReason of error the run's failure. The message carries no id of its own, so no fact names it as a source",
  },
  tool_execution_start: {
    handling: 'wired',
    note: "opens a tool entry, state -> working. pi writes it before the tool_call handlers run, so a call this host's gate blocks still starts and ends: never read as the call having run",
  },
  tool_execution_update: { handling: 'declined', note: NATIVE_ONLY },
  tool_execution_end: {
    handling: 'wired',
    note: "closes the tool entry; a tool_result item: blocked when this host's gate refused the call, failed on isError, otherwise completed, with durationMs as reported (absent when the tool did not run)",
  },
  agent_settled: {
    handling: 'wired',
    note: "the run is over: state -> idle, interrupted when aborted, or errored when the run's last answer stopped on an error; closes any tool entry left open; a turn item, ended; then get_session_stats",
  },
  queue_update: { handling: 'declined', note: NATIVE_ONLY },
  compaction_start: {
    handling: 'wired',
    note: 'opens the compaction entry; a compaction fact, started, its trigger manual when pi was asked (reason manual) and auto otherwise (threshold, overflow)',
  },
  entry_appended: {
    handling: 'declined',
    note: `${NATIVE_ONLY}: the session file's entries restate the messages and events above`,
  },
  session_info_changed: { handling: 'declined', note: NATIVE_ONLY },
  thinking_level_changed: {
    handling: 'wired',
    note: "the receipt's effort moves to the level pi now uses (source runtime); pi writes it only when the level in force changes",
  },
  compaction_end: {
    handling: 'wired',
    note: 'closes the compaction entry; a compaction fact, ended, with tokensBefore from its result and tokensAfter null: pi reports only an estimate of what is left; an errorMessage is a warning notice',
  },
  auto_retry_start: {
    handling: 'wired',
    note: 'a warning notice item: pi retries the model call on its own, with the attempt and the error',
  },
  auto_retry_end: {
    handling: 'wired',
    note: 'a notice item: info when the retry succeeded, error with the final error when the retries ran out',
  },
  summarization_retry_scheduled: {
    handling: 'wired',
    note: "a warning notice item: pi retries a summary's model call on its own",
  },
  summarization_retry_attempt_start: { handling: 'declined', note: NATIVE_ONLY },
  summarization_retry_finished: { handling: 'declined', note: NATIVE_ONLY },
  bash_execution_update: {
    handling: 'declined',
    note: `${NATIVE_ONLY}: written only for the bash command, which this host never sends and this host's extension refuses`,
  },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** Each record RPC mode writes beside the events. */
export const PI_RECORD_COVERAGE = {
  response: {
    handling: 'wired',
    note: "the answer to a command this host sent, beside the command: its row in the commands table says what it feeds. A prompt answered with success false is the turn's failure (state -> errored) and an error notice; its error naming a missing key or a failed sign-in is the sign-in marker",
  },
  extension_ui_request: {
    handling: 'wired',
    note: 'a dialog (select, confirm, input, editor) is answered cancelled at once, since nobody here answers one; a notify is a notice item at its level; the rest are said and nothing more (UI methods table)',
  },
  extension_error: {
    handling: 'wired',
    note: "an error notice item naming the extension and the event; this host's own extension never throws from tool_call, so its blocks carry their reasons rather than surfacing here",
  },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** Each command pi reads, by what this host does with its answer. */
export const PI_COMMAND_COVERAGE = {
  prompt: {
    handling: 'wired',
    note: "every prompt is sent as prompt with streamingBehavior followUp, one at a time: it starts a run when none runs and queues behind the run otherwise. Its answer says it was taken, not that it ran; an answer with success false is the turn's failure",
  },
  steer: { handling: 'declined', note: `${NEVER_SENT}: a prompt queues behind the run and never steers it` },
  follow_up: {
    handling: 'declined',
    note: `${NEVER_SENT}: sent while no run runs it only queues and starts nothing, so prompt with followUp is sent instead`,
  },
  abort: {
    handling: 'wired',
    note: "an interrupt: pi stops retries, compaction and the run, then answers; this host's extension blocks any call still being decided at once, and the run's agent_settled says aborted",
  },
  clear_queue: { handling: 'declined', note: NEVER_SENT },
  new_session: { handling: 'declined', note: `${NEVER_SENT}: one pi process is one session` },
  get_state: {
    handling: 'wired',
    note: 'sent once the extension has said hello: state -> ready, the first one carrying the control tier; sessionId is the session handle; the model and thinkingLevel open the receipt; sessionFile is where pi keeps the session',
  },
  set_model: {
    handling: 'wired',
    note: 'a receipt composed by this host (source host) with the model pi answered with: pi writes no event when its model changes',
  },
  cycle_model: { handling: 'declined', note: NEVER_SENT },
  get_available_models: {
    handling: 'wired',
    note: 'sent once, by the read at start, to a pi started for nothing else: the models the hello lists, as provider/id',
  },
  set_thinking_level: {
    handling: 'wired',
    note: "thinking and effort, one ladder: off, or a level pi clamps to the model's own; the last one set wins; thinking_level_changed carries what pi uses",
  },
  cycle_thinking_level: { handling: 'declined', note: NEVER_SENT },
  get_available_thinking_levels: { handling: 'declined', note: NEVER_SENT },
  set_steering_mode: { handling: 'declined', note: NEVER_SENT },
  set_follow_up_mode: { handling: 'declined', note: NEVER_SENT },
  compact: { handling: 'declined', note: `${NEVER_SENT}: a compaction pi runs on its own is reported` },
  set_auto_compaction: { handling: 'declined', note: NEVER_SENT },
  set_auto_retry: { handling: 'declined', note: NEVER_SENT },
  abort_retry: { handling: 'declined', note: NEVER_SENT },
  bash: {
    handling: 'declined',
    note: `${NEVER_SENT}: it runs a command outside the agent's tool calls, and this host's extension refuses every such command`,
  },
  abort_bash: { handling: 'declined', note: NEVER_SENT },
  get_session_stats: {
    handling: 'wired',
    note: "sent after each run settles: turn_record with totals = the session's tokens and cost as pi states them, costBasis catalogue-estimated (pi prices each call from its model catalogue, never a bill), currency USD, turn and turnScope null, never summed. The totals span every entry of the session file: compacted history, abandoned branches, failed retries and compaction calls, so they can exceed what the visible conversation used, and a resumed or forked session's include the source session's. inputTokens = tokens.input, which pi counts without the cached input (cacheRead and cacheWrite are its own members). reasoningTokens null: the totals carry none. contextUsage is the usage sample (mainThread true)",
  },
  export_html: { handling: 'declined', note: NEVER_SENT },
  switch_session: {
    handling: 'declined',
    note: `${NEVER_SENT}: a resume opens the session's file when pi starts (--session)`,
  },
  fork: { handling: 'declined', note: `${NEVER_SENT}: a fork starts pi from the session's file (--fork)` },
  clone: { handling: 'declined', note: `${NEVER_SENT}: a fork starts pi from the session's file (--fork)` },
  get_fork_messages: { handling: 'declined', note: NEVER_SENT },
  get_entries: { handling: 'declined', note: NEVER_SENT },
  get_tree: { handling: 'declined', note: NEVER_SENT },
  get_last_assistant_text: { handling: 'declined', note: NEVER_SENT },
  set_session_name: { handling: 'declined', note: NEVER_SENT },
  get_messages: { handling: 'declined', note: NEVER_SENT },
  get_commands: {
    handling: 'wired',
    note: "sent once the extension has said hello: every command's source is held to this host's own (its extension, pi's MCP extension, the skill directories it handed over), any other raising gate-foreign-extension; the skill:<name> entries are the receipt's skills (source runtime)",
  },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** Each method an extension UI request names. */
export const PI_UI_METHOD_COVERAGE = {
  select: { handling: 'declined', note: 'a dialog: answered cancelled at once' },
  confirm: { handling: 'declined', note: 'a dialog: answered cancelled at once' },
  input: { handling: 'declined', note: 'a dialog: answered cancelled at once' },
  editor: { handling: 'declined', note: 'a dialog: answered cancelled at once' },
  notify: {
    handling: 'wired',
    note: "a notice item at its notifyType's level (info, warning, error): how pi's MCP extension says a server needs a sign-in, which RPC mode cannot give",
  },
  setStatus: { handling: 'declined', note: NATIVE_ONLY },
  setWidget: { handling: 'declined', note: NATIVE_ONLY },
  setTitle: { handling: 'declined', note: NATIVE_ONLY },
  set_editor_text: { handling: 'declined', note: NATIVE_ONLY },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** Each delta a `message_update` carries. */
export const PI_DELTA_COVERAGE = {
  start: { handling: 'declined', note: NATIVE_ONLY },
  text_start: { handling: 'declined', note: NATIVE_ONLY },
  text_delta: { handling: 'wired', note: 'a text fragment' },
  text_end: { handling: 'declined', note: NATIVE_ONLY },
  thinking_start: { handling: 'declined', note: NATIVE_ONLY },
  thinking_delta: { handling: 'wired', note: 'a thinking fragment' },
  thinking_end: { handling: 'declined', note: NATIVE_ONLY },
  toolcall_start: { handling: 'declined', note: NATIVE_ONLY },
  toolcall_delta: {
    handling: 'wired',
    note: "a tool_input fragment: a piece of the call's input as the model writes it",
  },
  toolcall_end: { handling: 'declined', note: NATIVE_ONLY },
  done: { handling: 'declined', note: `${NATIVE_ONLY}: message_end carries the whole message` },
  error: { handling: 'declined', note: `${NATIVE_ONLY}: message_end carries the stopReason and the error` },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** The five tables, by what they cover. */
export const PI_COVERAGE = {
  events: PI_EVENT_COVERAGE,
  records: PI_RECORD_COVERAGE,
  commands: PI_COMMAND_COVERAGE,
  uiMethods: PI_UI_METHOD_COVERAGE,
  deltas: PI_DELTA_COVERAGE,
} as const;

type WiredOf<T> = { [K in keyof T]: T[K] extends { readonly handling: 'wired' } ? K : never }[keyof T];

/** The event and command rows whose handling is `wired`: what a pi cause can name. */
export type PiWiredEvent = WiredOf<typeof PI_EVENT_COVERAGE> | WiredOf<typeof PI_COMMAND_COVERAGE>;

/** The wired event and command rows, in table order: the names after `pi:` in a cause event. */
export function piWiredEvents(): readonly PiWiredEvent[] {
  const wired = <T extends Readonly<Record<string, CoverageRow>>>(table: T): string[] =>
    Object.keys(table).filter((key) => table[key]?.handling === 'wired');
  return [...wired(PI_EVENT_COVERAGE), ...wired(PI_COMMAND_COVERAGE)] as PiWiredEvent[];
}
