/**
 * Every event of the pinned opencode release's stream, wired or declined, each with its reason: opencode's
 * counterpart of `MESSAGE_COVERAGE`, `CODEX_COVERAGE`, `QWEN_COVERAGE`, `PI_COVERAGE` and `COPILOT_COVERAGE`.
 *
 * Every event is received: the session's host process forwards each one, and each rides the session's update
 * lane as the native message (`runtime: 'opencode'`), a streamed delta on the delta lane. A row is `wired` when
 * it also moves the machine, feeds a fact, fills a conversation item or is read by the session's gate or
 * process, and the note says which; `declined` when the native message is all there is. Only the session's own
 * events move its state; a subagent's session's events fill its items, under the call that started it.
 *
 * Kept honest by `pins/opencode-coverage.test.ts`: the keys equal the events the release declares
 * (`contracts/opencode-names.json`), in both directions, and the cause events opencode can name a transition
 * with are exactly the wired rows.
 */
import type { CoverageRow } from './coverage.js';

/** Received and riding alone: the native message is all there is. */
const NATIVE_ONLY = 'rides the native message only; it moves nothing and feeds no fact';

/** An event of a surface this host never attaches. */
const NO_SURFACE = `${NATIVE_ONLY}: this host attaches no terminal, editor, interface or browser to a session`;

/** An event of the server's own catalogues and settings, which every session reads at its open. */
const SERVER_STATE = `${NATIVE_ONLY}: the server's own catalogues and settings, read back before the first prompt`;

/** An event of a tool this host turns off in every session. */
const TURNED_OFF = `${NATIVE_ONLY}: it follows from a tool or plugin this host turns off in every session`;

/** Each event the server's stream carries, by its `type`, in the order the release's union names them. */
export const OPENCODE_EVENT_COVERAGE = {
  'location.shutdown': { handling: 'declined', note: NATIVE_ONLY },
  'models-dev.refreshed': { handling: 'declined', note: SERVER_STATE },
  'credential.updated': { handling: 'declined', note: SERVER_STATE },
  'credential.switched': { handling: 'declined', note: SERVER_STATE },
  'integration.updated': { handling: 'declined', note: SERVER_STATE },
  'provider.updated': { handling: 'declined', note: SERVER_STATE },
  'model.updated': { handling: 'declined', note: SERVER_STATE },
  'agent.updated': { handling: 'declined', note: SERVER_STATE },
  'session.created': {
    handling: 'wired',
    note: "the open (state -> ready); a subagent's session: its agent for the gate's requests, and the shell environment the process sets for it",
  },
  'session.agent.selected': {
    handling: 'wired',
    note: 'the agent the receipt states as its permission mode',
  },
  'session.model.selected': { handling: 'wired', note: 'the model register; a receipt of its own' },
  'session.moved': { handling: 'declined', note: TURNED_OFF },
  'session.renamed': { handling: 'declined', note: NATIVE_ONLY },
  'session.metadata.updated': { handling: 'declined', note: NATIVE_ONLY },
  'session.permissions': {
    handling: 'wired',
    note: "read by the gate: rules that are no longer this host's are named (gate-mode-widened)",
  },
  'session.viewed': { handling: 'declined', note: NO_SURFACE },
  'session.archived': { handling: 'declined', note: NATIVE_ONLY },
  'session.unarchived': { handling: 'declined', note: NATIVE_ONLY },
  'session.usage.updated': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: a session's running totals; spend is filed per model call from session.step.ended, so a subagent's figures never mix with the session's own`,
  },
  'session.deleted': { handling: 'declined', note: NATIVE_ONLY },
  'session.forked': { handling: 'declined', note: `${NATIVE_ONLY}: a fork's open names its own session` },
  'session.inbox.delivered': {
    handling: 'wired',
    note: 'a prompt the server took: one fewer pending in the queue',
  },
  'session.inbox.enqueued': { handling: 'wired', note: 'a prompt as the server queued it: a user_text item' },
  'session.inbox.cancelled': { handling: 'declined', note: NATIVE_ONLY },
  'session.inbox.delivery.changed': { handling: 'declined', note: NATIVE_ONLY },
  'session.execution.started': {
    handling: 'wired',
    note: "the session's own run starts: state -> working; a turn item, started; a subagent's session's run is a running task",
  },
  'session.execution.succeeded': {
    handling: 'wired',
    note: "the run is over: state -> idle; closes any tool entry left open; a turn item, ended; a subagent's task settles completed",
  },
  'session.execution.failed': {
    handling: 'wired',
    note: "the run failed: state -> errored, its error's type and words; a turn item, failed, and an error notice; a subagent's task settles failed",
  },
  'session.execution.interrupted': {
    handling: 'wired',
    note: "the run was interrupted: state -> interrupted; the gate ends its pending decisions; a turn item, interrupted; a subagent's task settles stopped",
  },
  'session.instructions.updated': { handling: 'declined', note: NATIVE_ONLY },
  'session.synthetic': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: a notice the server writes to the session itself, such as a background command's end; the run it wakes is reported by its own execution events`,
  },
  'session.skill.activated': { handling: 'declined', note: NATIVE_ONLY },
  'session.shell.started': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: a command a person runs, which no session through this host does`,
  },
  'session.shell.ended': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: a command a person runs, which no session through this host does`,
  },
  'session.step.started': {
    handling: 'wired',
    note: 'the model one call runs on, which its spend is filed under when the step ends',
  },
  'session.step.first-token': { handling: 'declined', note: NATIVE_ONLY },
  'session.step.streamed': { handling: 'declined', note: NATIVE_ONLY },
  'session.step.ended': {
    handling: 'wired',
    note: "one model call's spend: a turn_record filed as that step's figure, priced only where the provider reported a cost",
  },
  'session.step.failed': {
    handling: 'wired',
    note: "a warning notice in the error's words, and the call's spend where it reports one",
  },
  'session.text.started': { handling: 'declined', note: NATIVE_ONLY },
  'session.text.delta': { handling: 'wired', note: 'a text fragment' },
  'session.text.ended': { handling: 'wired', note: 'an agent_text item' },
  'session.reasoning.started': { handling: 'declined', note: NATIVE_ONLY },
  'session.reasoning.delta': { handling: 'wired', note: 'a thinking fragment' },
  'session.reasoning.ended': { handling: 'wired', note: 'a thinking item' },
  'session.tool.input.started': {
    handling: 'wired',
    note: "the call's tool name, for the gate's requests, the tool entry and the items",
  },
  'session.tool.input.delta': { handling: 'wired', note: 'a tool input fragment' },
  'session.tool.input.ended': { handling: 'declined', note: NATIVE_ONLY },
  'session.tool.called': {
    handling: 'wired',
    note: "the call's input, joined to its permission requests by the gate; a tool_call item; the tool entry opened; a call the model's provider ran itself is named (gate-unhooked-call)",
  },
  'session.tool.progress': {
    handling: 'wired',
    note: 'read by the process: a subagent call names the session it started, whose events then carry the call as their parent',
  },
  'session.tool.success': {
    handling: 'wired',
    note: 'a tool_result item, completed or blocked; the tool entry closed; a call that ran with no permission request is named (gate-hook-missing)',
  },
  'session.tool.failed': {
    handling: 'wired',
    note: 'a tool_result item, failed or blocked; the tool entry closed',
  },
  'session.retry.scheduled': {
    handling: 'wired',
    note: "a warning notice: a model call is retried, in its error's words",
  },
  'session.compaction.started': {
    handling: 'wired',
    note: 'the compaction entry opened and a compaction fact, started',
  },
  'session.compaction.delta': { handling: 'declined', note: NATIVE_ONLY },
  'session.compaction.ended': {
    handling: 'wired',
    note: 'the compaction entry closed and a compaction fact, ended',
  },
  'session.compaction.failed': {
    handling: 'wired',
    note: 'the compaction entry closed and a compaction fact, ended',
  },
  'session.revert.staged': { handling: 'declined', note: NATIVE_ONLY },
  'session.revert.cleared': { handling: 'declined', note: NATIVE_ONLY },
  'session.revert.committed': { handling: 'declined', note: NATIVE_ONLY },
  'filesystem.changed': { handling: 'declined', note: NATIVE_ONLY },
  'reference.updated': { handling: 'declined', note: SERVER_STATE },
  'permission.asked': {
    handling: 'wired',
    note: "a permission request: decided by this host's gate and answered once, or refused with words",
  },
  'permission.replied': {
    handling: 'wired',
    note: 'read by the gate: a request refused with another ends its pending decision; an answer this host never gave is named (gate-mode-widened)',
  },
  'plugin.updated': {
    handling: 'wired',
    note: "the process reads the plugins again: one that is not the runtime's own is named (gate-foreign-extension)",
  },
  'project.updated': { handling: 'declined', note: NATIVE_ONLY },
  'worktree.updated': { handling: 'declined', note: TURNED_OFF },
  'worktree.resolved': { handling: 'declined', note: TURNED_OFF },
  'command.updated': { handling: 'declined', note: SERVER_STATE },
  'config.updated': { handling: 'declined', note: SERVER_STATE },
  'skill.updated': { handling: 'declined', note: SERVER_STATE },
  'pty.created': { handling: 'declined', note: NO_SURFACE },
  'pty.updated': { handling: 'declined', note: NO_SURFACE },
  'pty.exited': { handling: 'declined', note: NO_SURFACE },
  'pty.deleted': { handling: 'declined', note: NO_SURFACE },
  'persistent-pty.added': { handling: 'declined', note: NO_SURFACE },
  'persistent-pty.removed': { handling: 'declined', note: NO_SURFACE },
  'persistent-pty.updated': { handling: 'declined', note: NO_SURFACE },
  'shell.created': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: every command a call runs, in the foreground or the background alike; the stream says which only through the call's own result, and a background command's end reaches the session as a notice`,
  },
  'shell.exited': { handling: 'declined', note: NATIVE_ONLY },
  'shell.deleted': { handling: 'declined', note: NATIVE_ONLY },
  'form.created': {
    handling: 'wired',
    note: 'cancelled at once by the process: a form waits on an answer with no timeout, and this host attaches no interface to give one',
  },
  'form.replied': { handling: 'declined', note: NATIVE_ONLY },
  'form.cancelled': {
    handling: 'declined',
    note: `${NATIVE_ONLY}: the process's own cancel, and what asked fails with its words`,
  },
  'websearch.updated': { handling: 'declined', note: SERVER_STATE },
  'artifact.updated': { handling: 'declined', note: TURNED_OFF },
  'session.status': { handling: 'declined', note: `${NATIVE_ONLY}: the execution events report the run` },
  'session.idle': { handling: 'declined', note: `${NATIVE_ONLY}: the execution events report the run's end` },
  'tui.prompt.append': { handling: 'declined', note: NO_SURFACE },
  'tui.command.execute': { handling: 'declined', note: NO_SURFACE },
  'tui.toast.show': { handling: 'declined', note: NO_SURFACE },
  'tui.session.select': { handling: 'declined', note: NO_SURFACE },
  'installation.updated': { handling: 'declined', note: NATIVE_ONLY },
  'installation.update-available': { handling: 'declined', note: NATIVE_ONLY },
  'vcs.branch.updated': { handling: 'declined', note: NATIVE_ONLY },
  'mcp.status.changed': { handling: 'declined', note: NATIVE_ONLY },
  'mcp.resources.changed': { handling: 'declined', note: NATIVE_ONLY },
  'experimental.mcp.event': { handling: 'declined', note: TURNED_OFF },
  'rpc.*': { handling: 'declined', note: `${NATIVE_ONLY}: a plugin's own calls` },
  'server.connected': { handling: 'declined', note: NATIVE_ONLY },
} as const satisfies Readonly<Record<string, CoverageRow>>;

/** The one table, by what it covers. */
export const OPENCODE_COVERAGE = { events: OPENCODE_EVENT_COVERAGE } as const;

type WiredOf<T> = { [K in keyof T]: T[K] extends { readonly handling: 'wired' } ? K : never }[keyof T];

/** The event rows whose handling is `wired`: what an opencode cause can name. */
export type OpencodeWiredEvent = WiredOf<typeof OPENCODE_EVENT_COVERAGE>;

/** The wired event rows, in table order: the names after `opencode:` in a cause event. */
export function opencodeWiredEvents(): readonly OpencodeWiredEvent[] {
  return Object.keys(OPENCODE_EVENT_COVERAGE).filter(
    (key) => (OPENCODE_EVENT_COVERAGE as Readonly<Record<string, CoverageRow>>)[key]?.handling === 'wired',
  ) as OpencodeWiredEvent[];
}
