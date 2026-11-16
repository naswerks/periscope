/**
 * opencode's messages as this package's transitions: the translation for a session on the opencode runtime,
 * beside `codex-observer.ts`'s, `qwen-observer.ts`'s, `pi-observer.ts`'s and `copilot-observer.ts`'s.
 * `SessionObserver.observeOpencodeMessage` records what this returns, so the first `ready` still carries the
 * tier and a compaction is still reported once.
 *
 * What is consumed is decided by `opencode-coverage.ts`; this file implements the wired rows that move the
 * machine. Every cause is `{ kind: 'agent-event', event: 'opencode:{type}' }`. The session is `ready` once its
 * open is proven (the process's `opened`, named by the `session.created` it follows); a run is `working` from
 * `session.execution.started` to the execution's end.
 *
 * Only the session's own events move its state: a subagent's session's events, and the server's own, ride
 * their native message alone.
 */
import type { OpencodeMessage } from '../host/opencode-wire.js';
import { opencodeData, opencodeErrorWords, opencodeWord } from '../host/opencode-wire.js';
import type { AgentEventName, ControlTier, SessionState, TransitionCause } from './model.js';
import type { TransitionRequest } from './machine.js';

/** The compaction entry's id, shared with the other lanes: one compaction at a time per session. */
export const OPENCODE_COMPACTION_ENTRY = 'compaction';

/** What the opencode lane remembers across messages, per session. */
export class OpencodeArmState {
  /** Whether the open was reported; only the first records `ready`. */
  reported = false;
  /** The tool entries this lane opened and has not closed, by call id. */
  readonly openTools = new Set<string>();
  /** Each call's tool name, from its input's start, by call id. */
  readonly toolNames = new Map<string, string>();
}

/** What the lane reads from the machine at the moment a message arrives. */
export interface OpencodeArmView {
  readonly state: SessionState;
  readonly controlTier: ControlTier | null;
  isOpen(entryId: string): boolean;
}

/** The records one message asks for, and the compaction it moved, if it moved one. */
export interface OpencodeArmOutcome {
  readonly requests: readonly TransitionRequest[];
  /** Set when the message moved the compaction entry: which way, and why. */
  readonly compaction: {
    readonly status: 'started' | 'ended';
    readonly trigger: 'manual' | 'auto';
    /** On `ended`: which of the runtime's two end events closed it. */
    readonly outcome?: 'completed' | 'failed';
  } | null;
}

const NOTHING: OpencodeArmOutcome = { requests: [], compaction: null };

/** How many call names one session keeps while their calls are open. */
const MAX_TOOL_NAMES = 2048;

function cause(name: string, detail: string): TransitionCause {
  // The wired rows are exactly the agent events (the coverage pin); a name outside them is refused by the
  // machine as unnamed rather than recorded under a guess.
  return { kind: 'agent-event', event: `opencode:${name}` as AgentEventName, detail };
}

/** How a compaction was asked for: the runtime names `manual` for one asked of it, and the rest are its own. */
function triggerOf(reason: unknown): 'manual' | 'auto' {
  return reason === 'manual' ? 'manual' : 'auto';
}

/** The records closing every tool entry still open, as the run's end. */
function closeOpenTools(arm: OpencodeArmState, view: OpencodeArmView, name: string): TransitionRequest[] {
  const requests: TransitionRequest[] = [];
  for (const entryId of arm.openTools) {
    if (view.isOpen(entryId)) {
      requests.push({
        to: view.state,
        entry: { op: 'close', entryId },
        cause: cause(name, `tool entry ${entryId} closed by the end of its run`),
      });
    }
  }
  arm.openTools.clear();
  return requests;
}

/** The transitions one opencode message asks for. Pure: what it remembers lives in `arm`. */
export function opencodeRequestsFor(
  message: OpencodeMessage,
  arm: OpencodeArmState,
  view: OpencodeArmView,
): OpencodeArmOutcome {
  if (message.kind === 'opened') {
    if (arm.reported) return NOTHING;
    arm.reported = true;
    return {
      requests: [
        {
          to: 'ready',
          sessionId: message.sessionId,
          cause: cause(
            'session.created',
            `the ${message.origin === 'new' ? 'new' : message.origin === 'fork' ? 'forked' : 'resumed'} session's rules, agents, plugins, servers, configuration and models were read back`,
          ),
          ...(view.controlTier === null ? {} : { controlTier: view.controlTier }),
        },
      ],
      compaction: null,
    };
  }

  if (!message.main) return NOTHING;
  const event = message.event;
  const data = opencodeData(event);
  switch (event.type) {
    case 'session.execution.started':
      return {
        requests: [{ to: 'working', cause: cause('session.execution.started', 'a run started') }],
        compaction: null,
      };

    case 'session.tool.input.started': {
      const id = opencodeWord(data['id']);
      const name = opencodeWord(data['name']);
      if (id !== null && name !== null) {
        if (arm.toolNames.size >= MAX_TOOL_NAMES) {
          const oldest = arm.toolNames.keys().next().value;
          if (oldest !== undefined) arm.toolNames.delete(oldest);
        }
        arm.toolNames.set(id, name);
      }
      return NOTHING;
    }

    case 'session.tool.called': {
      const id = opencodeWord(data['id']);
      // A call the model's provider ran itself is not run here, so it opens no entry.
      if (id === null || data['executed'] === true || arm.openTools.has(id)) return NOTHING;
      const name = arm.toolNames.get(id) ?? 'tool';
      arm.openTools.add(id);
      return {
        requests: [
          {
            to: 'working',
            entry: { op: 'open', entryId: id, activity: { kind: 'tool', name } },
            cause: cause('session.tool.called', `tool: ${name}`),
          },
        ],
        compaction: null,
      };
    }

    case 'session.tool.success':
    case 'session.tool.failed': {
      const id = opencodeWord(data['id']);
      if (id === null) return NOTHING;
      arm.toolNames.delete(id);
      if (!arm.openTools.delete(id) || !view.isOpen(id)) return NOTHING;
      return {
        requests: [
          {
            to: view.state,
            entry: { op: 'close', entryId: id },
            cause: cause(event.type, `tool ended${event.type === 'session.tool.failed' ? ' (failed)' : ''}`),
          },
        ],
        compaction: null,
      };
    }

    case 'session.execution.succeeded':
      return {
        requests: [
          ...closeOpenTools(arm, view, 'session.execution.succeeded'),
          { to: 'idle', cause: cause('session.execution.succeeded', 'the run is over') },
        ],
        compaction: null,
      };

    case 'session.execution.failed':
      return {
        requests: [
          ...closeOpenTools(arm, view, 'session.execution.failed'),
          {
            to: 'errored',
            cause: cause('session.execution.failed', `the run failed: ${opencodeErrorWords(data['error'])}`),
          },
        ],
        compaction: null,
      };

    case 'session.execution.interrupted':
      return {
        requests: [
          ...closeOpenTools(arm, view, 'session.execution.interrupted'),
          {
            to: 'interrupted',
            cause: cause(
              'session.execution.interrupted',
              `the run was interrupted (${opencodeWord(data['reason']) ?? 'no reason named'})`,
            ),
          },
        ],
        compaction: null,
      };

    case 'session.compaction.started': {
      if (view.isOpen(OPENCODE_COMPACTION_ENTRY)) return NOTHING;
      return {
        requests: [
          {
            to: view.state,
            entry: {
              op: 'open',
              entryId: OPENCODE_COMPACTION_ENTRY,
              activity: { kind: 'compacting', name: null },
            },
            cause: cause(
              'session.compaction.started',
              `compaction started (${opencodeWord(data['reason']) ?? 'no reason named'})`,
            ),
          },
        ],
        compaction: { status: 'started', trigger: triggerOf(data['reason']) },
      };
    }

    case 'session.compaction.ended':
    case 'session.compaction.failed': {
      if (!view.isOpen(OPENCODE_COMPACTION_ENTRY)) return NOTHING;
      return {
        requests: [
          {
            to: view.state,
            entry: { op: 'close', entryId: OPENCODE_COMPACTION_ENTRY },
            cause: cause(
              event.type,
              `compaction ${event.type === 'session.compaction.failed' ? `failed: ${opencodeErrorWords(data['error'])}` : 'finished'}`,
            ),
          },
        ],
        compaction: {
          status: 'ended',
          trigger: triggerOf(data['reason']),
          outcome: event.type === 'session.compaction.failed' ? 'failed' : 'completed',
        },
      };
    }

    default:
      return NOTHING;
  }
}
