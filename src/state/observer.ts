/**
 * The one translation site: the SDK's events become this package's transitions here and nowhere
 * else.
 *
 * What is consumed and what is not is decided by `coverage.ts`, not by this file. Every hook
 * event and every message shape has a row there saying wired or declined, with a reason. This file
 * implements the wired half; reading it alone will not tell you what was skipped, which is exactly
 * why the table exists separately.
 *
 * It translates; it does not interpret. Nothing here knows what a session is for. It knows a
 * tool call started and stopped, that a turn ended cleanly or badly, and that a task stopped
 * holding the session. What any of that means is a controller's question.
 *
 * It never throws and never decides a permission. Every handler returns an empty hook output —
 * the decision path is a separate handler on the same event, and the SDK runs both.
 */
import type { HookInput, SDKMessage } from '../host/agent-process.js';
import { discriminatorOf } from '../host/agent-process.js';
import type { Result } from '../core/result.js';
import type { SessionTransition, TransitionCause, TransitionWhere } from './model.js';
import type { EntryOp, SessionStateMachine, TransitionRequest } from './machine.js';

/**
 * How this observer keys a permission entry. `PermissionRequest` carries no tool_use_id — see below.
 *
 * The name key belongs to this file's own lane — `PermissionRequest` opens it,
 * `PermissionDenied` or the `PreToolUse` close below exits it — and to nobody else. The gate keys
 * its hold entry by tool_use_id (`gate/outcome.ts`) precisely so the close below can never touch a
 * hold whose decision is still outstanding: a second `PreToolUse` for the same tool would
 * otherwise close the first call's live hold and record a resolution that never happened.
 */
const permissionEntry = (toolName: string): string => `permission:${toolName}`;
/** One compaction at a time per session, from either of the two sources that report it. */
const COMPACTION_ENTRY = 'compaction';
/** The model-request lane, driven by SDKStatus. */
const REQUEST_ENTRY = 'request';

/**
 * Translates one session's SDK events into transitions on its machine.
 *
 * Per session because it holds the one correlation the SDK does not give for free: a background
 * task is reported by `task_id`, while the entry it belongs to was opened under the tool's
 * `tool_use_id`, and only `task_started` carries both.
 */
export class SessionObserver {
  readonly #machine: SessionStateMachine;
  /** task_id -> the entryId that task's work is recorded under. */
  readonly #taskEntries = new Map<string, string>();

  constructor(machine: SessionStateMachine) {
    this.#machine = machine;
  }

  get machine(): SessionStateMachine {
    return this.#machine;
  }

  /** The first record of a session's life: someone asked for a process. */
  created(detail: string): Result<SessionTransition> {
    return this.#machine.record({
      to: 'spawning',
      cause: { kind: 'control', event: 'create_requested', detail },
    });
  }

  /** A turn was queued. Distinct from `UserPromptSubmit`, which is the agent confirming it. */
  promptSubmitted(detail: string): Result<SessionTransition> {
    return this.#machine.record({
      to: this.#machine.state === 'spawning' ? 'spawning' : 'working',
      cause: { kind: 'control', event: 'prompt_submitted', detail },
    });
  }

  interrupted(detail: string): Result<SessionTransition> {
    return this.#machine.record({
      to: 'interrupted',
      cause: { kind: 'control', event: 'interrupt_requested', detail },
    });
  }

  /**
   * The process is over, however it ended.
   *
   * Every still-open entry is marked abandoned here, not deleted. A session that died holding a
   * tool call is the most useful thing this model can report, and erasing the entry to tidy up
   * would destroy precisely that. The mark carries the reason and the entry keeps its age.
   */
  ended(cause: TransitionCause): Result<SessionTransition> {
    return this.#machine.record({
      to: 'ended',
      cause,
      entry: { op: 'abandon-open', reason: `the session ended (${cause.event}) with this entry still open` },
    });
  }

  /** A named condition the host itself produced — a decision path that failed rather than denied. */
  refused(cause: TransitionCause): Result<SessionTransition> {
    return this.#machine.record({ to: this.#machine.state, cause });
  }

  /** The working directory moved under the session, so every later transition must carry the new one. */
  relocated(where: TransitionWhere, cause: TransitionCause): Result<SessionTransition> {
    return this.#machine.record({ to: this.#machine.state, cause, where });
  }

  // -------------------------------------------------------------------------
  // The SDK message stream
  // -------------------------------------------------------------------------

  /** Every message the agent emits. Returns what it recorded — often nothing, by the table. */
  observeMessage(message: SDKMessage): Result<SessionTransition>[] {
    return this.#requestsFor(message).map((request) => this.#machine.record(request));
  }

  #requestsFor(message: SDKMessage): TransitionRequest[] {
    const event = discriminatorOf(message);
    const cause = (detail: string): TransitionCause => ({
      kind: 'sdk-message',
      event: event as TransitionCause['event'],
      detail,
    });

    if (message.type === 'system' && message.subtype === 'init') {
      return [
        {
          to: 'ready',
          sessionId: message.session_id,
          cause: cause(`the agent reported itself: ${message.model} on CLI ${message.claude_code_version}`),
        },
      ];
    }

    if (message.type === 'system' && message.subtype === 'status') {
      return statusRequests(message.status, cause);
    }

    if (message.type === 'system' && message.subtype === 'session_state_changed') {
      // `requires_action` maps to `working`, not to a state of its own: what it requires is
      // already carried by the open permission or elicitation entry, and a second representation
      // of one fact is how two vocabularies start.
      const to = message.state === 'idle' ? 'idle' : 'working';
      return [{ to, cause: cause(`the agent reported session state ${message.state}`) }];
    }

    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      return [
        {
          to: this.#machine.state,
          entry: { op: 'close', entryId: COMPACTION_ENTRY },
          cause: cause(`compaction completed (${message.compact_metadata.trigger})`),
        },
      ];
    }

    if (message.type === 'system' && message.subtype === 'task_started') {
      // No transition of its own — this is where the join is learned. The entry itself was opened
      // by PreToolUse under the tool_use_id, which is the id every later report has to resolve to.
      const entryId = message.tool_use_id ?? `task:${message.task_id}`;
      this.#taskEntries.set(message.task_id, entryId);
      return [];
    }

    if (message.type === 'system' && message.subtype === 'task_updated') {
      return this.#taskUpdateRequests(message.task_id, message.patch, cause);
    }

    if (message.type === 'system' && message.subtype === 'task_notification') {
      const entryId = message.tool_use_id ?? this.#taskEntries.get(message.task_id);
      if (entryId === undefined) return [];
      this.#taskEntries.delete(message.task_id);
      return [
        {
          to: this.#machine.state,
          entry: { op: 'close', entryId },
          cause: cause(`background task ${message.task_id} ${message.status}`),
        },
      ];
    }

    if (message.type === 'system' && message.subtype === 'worker_shutting_down') {
      return [{ to: this.#machine.state, cause: cause(`the worker is shutting down: ${message.reason}`) }];
    }

    if (message.type === 'system' && message.subtype === 'model_refusal_no_fallback') {
      return [
        {
          to: this.#machine.state,
          cause: cause(`the model refused and no fallback ran (${message.original_model})`),
        },
      ];
    }

    if (message.type === 'result') {
      const clean = message.subtype === 'success';
      const why = clean
        ? `the turn completed in ${message.duration_ms}ms`
        : `the turn ended ${message.subtype}${'terminal_reason' in message && message.terminal_reason !== undefined ? ` (${message.terminal_reason})` : ''}`;
      return [{ to: clean ? 'idle' : 'errored', cause: cause(why) }];
    }

    return [];
  }

  #taskUpdateRequests(
    taskId: string,
    patch: { readonly status?: string; readonly is_backgrounded?: boolean },
    cause: (detail: string) => TransitionCause,
  ): TransitionRequest[] {
    const entryId = this.#taskEntries.get(taskId);
    if (entryId === undefined) return [];

    // The caused moment. A task stops holding the session exactly here, because the agent said
    // so — never on a timer, never because an entry looked old. Backgrounding is not completion:
    // the entry stays open, keeps ageing, and still gets its exit from task_notification.
    if (patch.is_backgrounded === true) {
      return [
        {
          to: 'idle',
          entry: { op: 'background', entryId },
          cause: cause(`task ${taskId} was backgrounded and no longer holds the session`),
        },
      ];
    }

    if (patch.status === 'completed' || patch.status === 'failed' || patch.status === 'killed') {
      this.#taskEntries.delete(taskId);
      return [
        {
          to: this.#machine.state,
          entry: { op: 'close', entryId },
          cause: cause(`task ${taskId} ${patch.status}`),
        },
      ];
    }

    return [];
  }

  // -------------------------------------------------------------------------
  // The hook lane
  // -------------------------------------------------------------------------

  /** One hook firing. Returns what it recorded, so a caller can assert on it. */
  observeHook(input: HookInput): Result<SessionTransition>[] {
    return this.#hookRequests(input).map((request) => this.#machine.record(request));
  }

  #hookRequests(input: HookInput): TransitionRequest[] {
    const cause = (detail: string): TransitionCause => ({
      kind: 'hook',
      event: input.hook_event_name,
      detail,
    });

    switch (input.hook_event_name) {
      case 'PreToolUse': {
        // Two records, in order: the tool running means any outstanding permission for it
        // resolved, and that resolution is the permission entry's exit on the allow path.
        const requests: TransitionRequest[] = [];
        const held = permissionEntry(input.tool_name);
        if (this.#isOpen(held)) {
          requests.push({
            to: 'working',
            entry: { op: 'close', entryId: held },
            cause: cause(`the permission for ${input.tool_name} resolved and the tool is running`),
          });
        }
        requests.push({
          to: 'working',
          entry: {
            op: 'open',
            entryId: input.tool_use_id,
            activity: { kind: 'tool', name: input.tool_name },
            agentId: input.agent_id ?? null,
          },
          cause: cause(`${input.tool_name} started`),
        });
        return requests;
      }

      case 'PostToolUse':
        return [
          {
            to: 'working',
            entry: { op: 'close', entryId: input.tool_use_id },
            cause: cause(`${input.tool_name} finished`),
          },
        ];

      case 'PostToolUseFailure':
        return [
          {
            to: 'working',
            entry: { op: 'close', entryId: input.tool_use_id },
            cause: cause(`${input.tool_name} failed: ${input.error}`),
          },
        ];

      case 'PostToolBatch':
        // The backstop. Closes only what is still open — emitting a close for an entry that
        // already exited would put an event in the trace that never happened.
        return input.tool_calls
          .filter((call) => this.#isOpen(call.tool_use_id))
          .map((call) => ({
            to: 'working' as const,
            entry: { op: 'close' as const, entryId: call.tool_use_id },
            cause: cause(`${call.tool_name} closed by the end of its batch`),
          }));

      case 'UserPromptSubmit':
        return [{ to: 'working', cause: cause('a turn was submitted') }];

      case 'Stop':
        return [
          {
            to: 'idle',
            cause: cause(
              `the turn ended cleanly${
                input.background_tasks !== undefined && input.background_tasks.length > 0
                  ? ` with ${input.background_tasks.length} background task(s) still in flight`
                  : ''
              }`,
            ),
          },
        ];

      case 'StopFailure':
        return [{ to: 'errored', cause: cause(`the turn ended abnormally: ${input.error}`) }];

      case 'SessionStart':
        return [{ to: this.#machine.state, cause: cause(`the session started (${input.source})`) }];

      case 'SessionEnd':
        return [
          {
            to: 'ended',
            entry: {
              op: 'abandon-open',
              reason: `the session ended (${input.reason}) with this entry still open`,
            },
            cause: cause(`the session ended: ${input.reason}`),
          },
        ];

      case 'CwdChanged':
        return [
          {
            to: this.#machine.state,
            where: { ...this.#machine.where, cwd: input.new_cwd },
            cause: cause(`the working directory moved from ${input.old_cwd}`),
          },
        ];

      case 'SubagentStart':
        return [
          {
            to: 'working',
            entry: {
              op: 'open',
              entryId: input.agent_id,
              activity: { kind: 'subagent', name: input.agent_type },
              agentId: input.agent_id,
            },
            cause: cause(`subagent ${input.agent_type} started`),
          },
        ];

      case 'SubagentStop':
        return [
          {
            to: 'working',
            entry: { op: 'close', entryId: input.agent_id },
            cause: cause(`subagent ${input.agent_type} stopped`),
          },
        ];

      case 'PreCompact':
        return [
          {
            to: 'working',
            entry: { op: 'open', entryId: COMPACTION_ENTRY, activity: { kind: 'compacting', name: null } },
            cause: cause(`compaction started (${input.trigger})`),
          },
        ];

      case 'PostCompact':
        return [
          {
            to: 'working',
            entry: { op: 'close', entryId: COMPACTION_ENTRY },
            cause: cause(`compaction finished (${input.trigger})`),
          },
        ];

      case 'PermissionRequest':
        // Keyed by tool name, because `PermissionRequestHookInput` carries no tool_use_id while
        // `PermissionDeniedHookInput` does — there is no shared id to join on. Two simultaneous
        // requests for the same tool would therefore share one entry; the exit still fires and the
        // trace stays truthful, but the pair is not distinguishable. Stated rather than hidden.
        return [
          {
            to: 'working',
            entry: {
              op: 'open',
              entryId: permissionEntry(input.tool_name),
              activity: { kind: 'permission', name: input.tool_name },
              agentId: input.agent_id ?? null,
            },
            cause: cause(`a permission decision for ${input.tool_name} is outstanding`),
          },
        ];

      case 'PermissionDenied':
        // A denial. An outage in the same path arrives as cause kind `refusal` with a refusal
        // reason — two independent discriminators apart, because an infrastructure failure
        // wearing a denial's clothes impersonates a human "no", and that is the most expensive
        // confusion a controller can make.
        return [
          {
            to: 'working',
            entry: { op: 'close', entryId: permissionEntry(input.tool_name) },
            cause: cause(`${input.tool_name} was denied: ${input.reason}`),
          },
        ];

      case 'Elicitation':
        return [
          {
            to: 'working',
            entry: {
              op: 'open',
              entryId: elicitationEntry(input.elicitation_id, input.mcp_server_name),
              activity: { kind: 'elicitation', name: input.mcp_server_name },
            },
            cause: cause(`${input.mcp_server_name} asked for input`),
          },
        ];

      case 'ElicitationResult':
        return [
          {
            to: 'working',
            entry: { op: 'close', entryId: elicitationEntry(input.elicitation_id, input.mcp_server_name) },
            cause: cause(`${input.mcp_server_name} elicitation ${input.action}`),
          },
        ];

      default:
        // Declined by coverage.ts, every one of them with a stated reason. This is not a silent
        // default: the table is the map, and an event absent from it is the gap.
        return [];
    }
  }

  #isOpen(entryId: string): boolean {
    return this.#machine.openEntries().some((entry) => entry.entryId === entryId);
  }
}

const elicitationEntry = (elicitationId: string | undefined, server: string): string =>
  `elicitation:${elicitationId ?? server}`;

/**
 * `SDKStatus` -> the request/compaction lanes. Null is the exit, not an absence of information.
 */
function statusRequests(
  status: 'compacting' | 'requesting' | null,
  cause: (detail: string) => TransitionCause,
): TransitionRequest[] {
  if (status === 'requesting') {
    return [
      {
        to: 'working',
        entry: { op: 'open', entryId: REQUEST_ENTRY, activity: { kind: 'requesting', name: null } },
        cause: cause('a model request is in flight'),
      },
    ];
  }

  if (status === 'compacting') {
    return [
      {
        to: 'working',
        entry: { op: 'open', entryId: COMPACTION_ENTRY, activity: { kind: 'compacting', name: null } },
        cause: cause('compaction is in flight'),
      },
    ];
  }

  return [
    {
      to: 'working',
      entry: { op: 'close', entryId: REQUEST_ENTRY },
      cause: cause('the model request finished'),
    },
  ];
}

export type { EntryOp };
