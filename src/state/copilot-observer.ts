/**
 * Copilot's messages as this package's transitions: the translation for a session on the Copilot runtime,
 * beside `codex-observer.ts`'s, `qwen-observer.ts`'s and `pi-observer.ts`'s.
 * `SessionObserver.observeCopilotMessage` records what this returns, so the first `ready` still carries the
 * tier and a compaction is still reported once.
 *
 * What is consumed is decided by `copilot-coverage.ts`; this file implements the wired rows that move the
 * machine. Every cause is `{ kind: 'agent-event', event: 'copilot:{type}' }`. The session is `ready` once its
 * open is proven (the process's `opened`, named by the `session.start` or `session.resume` it followed); a
 * run is `working` from the prompt the runtime takes (`user.message`) to `session.idle`.
 *
 * Only the session's own thread moves its state: an event a sub-agent sent names its agent, or the call that
 * spawned it, and rides its native message alone.
 */
import type { CopilotMessage } from '../host/copilot-wire.js';
import { copilotCount, copilotData, copilotWord, isCopilotMainThread } from '../host/copilot-wire.js';
import type { AgentEventName, ControlTier, SessionState, TransitionCause } from './model.js';
import type { TransitionRequest } from './machine.js';

/** The compaction entry's id, shared with the other lanes: one compaction at a time per session. */
export const COPILOT_COMPACTION_ENTRY = 'compaction';

/** What the Copilot lane remembers across messages, per session. */
export class CopilotArmState {
  /** Whether the open was reported; only the first records `ready`. */
  reported = false;
  /** The tool entries this lane opened and has not closed, by call id. */
  readonly openTools = new Set<string>();
  /** The error the run failed on, or null while it has none. */
  runFailure: string | null = null;
}

/** What the lane reads from the machine at the moment a message arrives. */
export interface CopilotArmView {
  readonly state: SessionState;
  readonly controlTier: ControlTier | null;
  isOpen(entryId: string): boolean;
}

/** The records one message asks for, and the compaction it moved, if it moved one. */
export interface CopilotArmOutcome {
  readonly requests: readonly TransitionRequest[];
  /** Set when the message moved the compaction entry: which way, why, and the tokens before and after. */
  readonly compaction: {
    readonly status: 'started' | 'ended';
    readonly trigger: 'manual' | 'auto';
    readonly tokensBefore: number | null;
    readonly tokensAfter: number | null;
    /** On `ended`, where the runtime states whether the compaction succeeded. */
    readonly outcome?: 'completed' | 'failed';
  } | null;
}

const NOTHING: CopilotArmOutcome = { requests: [], compaction: null };

function cause(name: string, detail: string): TransitionCause {
  // The wired rows are exactly the agent events (the coverage pin); a name outside them is refused by the
  // machine as unnamed rather than recorded under a guess.
  return { kind: 'agent-event', event: `copilot:${name}` as AgentEventName, detail };
}

/** How a compaction was asked for: the runtime names `manual` for one asked of it, and the rest are its own. */
function triggerOf(trigger: unknown): 'manual' | 'auto' {
  return trigger === 'manual' ? 'manual' : 'auto';
}

/** The words of a `session.error`: its type and its message. */
export function copilotErrorWords(data: Readonly<Record<string, unknown>>): string {
  const type = copilotWord(data['errorType']);
  const message = copilotWord(data['message']) ?? 'no message';
  return type === null ? message : `${type}: ${message}`;
}

/** The transitions one Copilot message asks for. Pure: what it remembers lives in `arm`. */
export function copilotRequestsFor(
  message: CopilotMessage,
  arm: CopilotArmState,
  view: CopilotArmView,
): CopilotArmOutcome {
  if (message.kind === 'opened') {
    if (arm.reported) return NOTHING;
    arm.reported = true;
    const opener = message.origin === 'resume' ? 'session.resume' : 'session.start';
    return {
      requests: [
        {
          to: 'ready',
          sessionId: message.sessionId,
          cause: cause(
            opener,
            "the runtime's posture was read back, and a probe call reached this host through the pre-tool hook and the permission request",
          ),
          ...(view.controlTier === null ? {} : { controlTier: view.controlTier }),
        },
      ],
      compaction: null,
    };
  }

  const event = message.event;
  if (!isCopilotMainThread(event)) return NOTHING;
  const data = copilotData(event);
  switch (event.type) {
    case 'user.message':
      if (view.state !== 'working') arm.runFailure = null;
      return {
        requests: [{ to: 'working', cause: cause('user.message', 'the runtime took a prompt') }],
        compaction: null,
      };

    case 'tool.execution_start': {
      const id = copilotWord(data['toolCallId']);
      const name = copilotWord(data['toolName']);
      if (id === null || name === null || arm.openTools.has(id)) return NOTHING;
      arm.openTools.add(id);
      return {
        requests: [
          {
            to: 'working',
            entry: { op: 'open', entryId: id, activity: { kind: 'tool', name } },
            cause: cause('tool.execution_start', `tool: ${name}`),
          },
        ],
        compaction: null,
      };
    }

    case 'tool.execution_complete': {
      const id = copilotWord(data['toolCallId']);
      if (id === null || !arm.openTools.delete(id) || !view.isOpen(id)) return NOTHING;
      return {
        requests: [
          {
            to: view.state,
            entry: { op: 'close', entryId: id },
            cause: cause(
              'tool.execution_complete',
              `tool ended${data['success'] === false ? ' (failed)' : ''}`,
            ),
          },
        ],
        compaction: null,
      };
    }

    case 'session.error': {
      const words = copilotErrorWords(data);
      arm.runFailure = words;
      return {
        requests: [{ to: 'errored', cause: cause('session.error', `the run failed: ${words}`) }],
        compaction: null,
      };
    }

    case 'session.idle': {
      const requests: TransitionRequest[] = [];
      // The backstop: a tool entry the run left open is closed by the run's end, never left ageing.
      for (const entryId of arm.openTools) {
        if (view.isOpen(entryId)) {
          requests.push({
            to: view.state,
            entry: { op: 'close', entryId },
            cause: cause('session.idle', `tool entry ${entryId} closed by the end of its run`),
          });
        }
      }
      arm.openTools.clear();
      const failed = arm.runFailure;
      arm.runFailure = null;
      const to: SessionState =
        data['aborted'] === true ? 'interrupted' : failed !== null ? 'errored' : 'idle';
      const why =
        to === 'idle'
          ? 'the run is over'
          : to === 'interrupted'
            ? 'the run was aborted'
            : `the run failed: ${failed ?? 'no message'}`;
      requests.push({ to, cause: cause('session.idle', why) });
      return { requests, compaction: null };
    }

    case 'session.compaction_start': {
      if (view.isOpen(COPILOT_COMPACTION_ENTRY)) return NOTHING;
      return {
        requests: [
          {
            to: view.state,
            entry: {
              op: 'open',
              entryId: COPILOT_COMPACTION_ENTRY,
              activity: { kind: 'compacting', name: null },
            },
            cause: cause(
              'session.compaction_start',
              `compaction started (${copilotWord(data['trigger']) ?? 'no trigger named'})`,
            ),
          },
        ],
        compaction: {
          status: 'started',
          trigger: triggerOf(data['trigger']),
          tokensBefore: copilotCount(data['currentTokens']),
          tokensAfter: null,
        },
      };
    }

    case 'session.compaction_complete': {
      if (!view.isOpen(COPILOT_COMPACTION_ENTRY)) return NOTHING;
      return {
        requests: [
          {
            to: view.state,
            entry: { op: 'close', entryId: COPILOT_COMPACTION_ENTRY },
            cause: cause(
              'session.compaction_complete',
              `compaction ${data['success'] === false ? 'failed' : 'finished'} (${copilotWord(data['trigger']) ?? 'no trigger named'})`,
            ),
          },
        ],
        compaction: {
          status: 'ended',
          trigger: triggerOf(data['trigger']),
          tokensBefore: copilotCount(data['preCompactionTokens']),
          tokensAfter: copilotCount(data['postCompactionTokens']),
          ...(data['success'] === false
            ? { outcome: 'failed' as const }
            : data['success'] === true
              ? { outcome: 'completed' as const }
              : {}),
        },
      };
    }

    default:
      return NOTHING;
  }
}
