/**
 * pi's messages as this package's transitions: the translation for a session on the pi runtime, beside
 * `codex-observer.ts`'s and `qwen-observer.ts`'s. `SessionObserver.observePiMessage` records what this
 * returns, so the first `ready` still carries the tier and a compaction is still reported once.
 *
 * What is consumed is decided by `pi-coverage.ts`; this file implements the wired rows that move the
 * machine. Every cause is `{ kind: 'agent-event', event: 'pi:{name}' }`. The session is `ready` once
 * pi's state is read, which this host does only after its extension has said hello and pi's commands
 * have been held to this host's own; a run is `working` from `agent_start` to `agent_settled`.
 *
 * Only the main thread moves the session's state: a call another tool made carries the id of that call
 * (`parentToolCallId`) and rides its native message alone.
 */
import type { PiMessage } from '../host/pi-wire.js';
import type { AgentEventName, ControlTier, SessionState, TransitionCause } from './model.js';
import type { TransitionRequest } from './machine.js';

/** The compaction entry's id, shared with the other lanes: one compaction at a time per session. */
export const PI_COMPACTION_ENTRY = 'compaction';

/** What the pi lane remembers across messages, per session. */
export class PiArmState {
  /** Whether pi's state was read; only the first read records `ready`. */
  reported = false;
  /** The tool entries this lane opened and has not closed, by call id. */
  readonly openTools = new Set<string>();
  /** The error the run's last answer stopped on, or null while it has none. */
  runFailure: string | null = null;
}

/** What the lane reads from the machine at the moment a message arrives. */
export interface PiArmView {
  readonly state: SessionState;
  readonly controlTier: ControlTier | null;
  isOpen(entryId: string): boolean;
}

/** The records one message asks for, and the compaction it moved, if it moved one. */
export interface PiArmOutcome {
  readonly requests: readonly TransitionRequest[];
  /** Set when the message moved the compaction entry: which way, why, and what pi counted before it. */
  readonly compaction: {
    readonly status: 'started' | 'ended';
    readonly trigger: 'manual' | 'auto';
    readonly tokensBefore: number | null;
  } | null;
}

const NOTHING: PiArmOutcome = { requests: [], compaction: null };

type JsonRecord = Readonly<Record<string, unknown>>;

const record = (value: unknown): JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};

const word = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function cause(name: string, detail: string): TransitionCause {
  // The wired rows are exactly the agent events (the coverage pin); a name outside them is refused by
  // the machine as unnamed rather than recorded under a guess.
  return { kind: 'agent-event', event: `pi:${name}` as AgentEventName, detail };
}

/** How a compaction was asked for: pi names `manual` for its own command, and the rest are its own. */
function triggerOf(reason: unknown): 'manual' | 'auto' {
  return reason === 'manual' ? 'manual' : 'auto';
}

/** The transitions one pi message asks for. Pure: what it remembers lives in `arm`. */
export function piRequestsFor(message: PiMessage, arm: PiArmState, view: PiArmView): PiArmOutcome {
  if (message.kind === 'response') {
    const response = message.response;
    if (message.command === 'get_state') {
      if (arm.reported || response['success'] !== true) return NOTHING;
      const id = word(record(response['data'])['sessionId']);
      if (id === null) return NOTHING;
      arm.reported = true;
      return {
        requests: [
          {
            to: 'ready',
            sessionId: id,
            cause: cause(
              'get_state',
              "pi's state was read, after this host's extension said hello and pi's commands were read",
            ),
            ...(view.controlTier === null ? {} : { controlTier: view.controlTier }),
          },
        ],
        compaction: null,
      };
    }
    if (message.command === 'prompt' && response['success'] === false) {
      const error = word(response['error']) ?? 'pi gave no reason';
      return {
        requests: [{ to: 'errored', cause: cause('prompt', `pi did not take the prompt: ${error}`) }],
        compaction: null,
      };
    }
    return NOTHING;
  }
  if (message.kind !== 'event') return NOTHING;

  const event = message.event;
  switch (word(event['type'])) {
    case 'agent_start':
      arm.runFailure = null;
      return {
        requests: [{ to: 'working', cause: cause('agent_start', 'pi began a run') }],
        compaction: null,
      };

    case 'tool_execution_start': {
      if (word(event['parentToolCallId']) !== null) return NOTHING;
      const id = word(event['toolCallId']);
      const name = word(event['toolName']);
      if (id === null || name === null || arm.openTools.has(id)) return NOTHING;
      arm.openTools.add(id);
      return {
        requests: [
          {
            to: 'working',
            entry: { op: 'open', entryId: id, activity: { kind: 'tool', name } },
            cause: cause('tool_execution_start', `tool: ${name}`),
          },
        ],
        compaction: null,
      };
    }

    case 'tool_execution_end': {
      if (word(event['parentToolCallId']) !== null) return NOTHING;
      const id = word(event['toolCallId']);
      if (id === null || !arm.openTools.delete(id) || !view.isOpen(id)) return NOTHING;
      return {
        requests: [
          {
            to: view.state,
            entry: { op: 'close', entryId: id },
            cause: cause('tool_execution_end', `tool ended${event['isError'] === true ? ' (error)' : ''}`),
          },
        ],
        compaction: null,
      };
    }

    case 'message_end': {
      const body = record(event['message']);
      if (body['role'] === 'assistant' && body['stopReason'] === 'error') {
        arm.runFailure = word(body['errorMessage']) ?? 'the model call ended on an error';
      }
      return NOTHING;
    }

    case 'agent_settled': {
      const requests: TransitionRequest[] = [];
      // The backstop: a tool entry the run left open is closed by the run's end, never left ageing.
      for (const entryId of arm.openTools) {
        if (view.isOpen(entryId)) {
          requests.push({
            to: view.state,
            entry: { op: 'close', entryId },
            cause: cause('agent_settled', `tool entry ${entryId} closed by the end of its run`),
          });
        }
      }
      arm.openTools.clear();
      const failed = arm.runFailure;
      arm.runFailure = null;
      const to: SessionState =
        event['aborted'] === true ? 'interrupted' : failed !== null ? 'errored' : 'idle';
      const why =
        to === 'idle'
          ? 'the run settled'
          : to === 'interrupted'
            ? 'the run was interrupted'
            : `the run failed: ${failed ?? 'no message'}`;
      requests.push({ to, cause: cause('agent_settled', why) });
      return { requests, compaction: null };
    }

    case 'compaction_start': {
      if (view.isOpen(PI_COMPACTION_ENTRY)) return NOTHING;
      return {
        requests: [
          {
            to: view.state,
            entry: { op: 'open', entryId: PI_COMPACTION_ENTRY, activity: { kind: 'compacting', name: null } },
            cause: cause('compaction_start', `compaction started (${word(event['reason']) ?? 'no reason'})`),
          },
        ],
        compaction: { status: 'started', trigger: triggerOf(event['reason']), tokensBefore: null },
      };
    }

    case 'compaction_end': {
      if (!view.isOpen(PI_COMPACTION_ENTRY)) return NOTHING;
      const before = record(event['result'])['tokensBefore'];
      return {
        requests: [
          {
            to: view.state,
            entry: { op: 'close', entryId: PI_COMPACTION_ENTRY },
            cause: cause(
              'compaction_end',
              `compaction ${event['aborted'] === true ? 'aborted' : 'finished'} (${word(event['reason']) ?? 'no reason'})`,
            ),
          },
        ],
        compaction: {
          status: 'ended',
          trigger: triggerOf(event['reason']),
          tokensBefore:
            typeof before === 'number' && Number.isFinite(before) && before >= 0 ? Math.floor(before) : null,
        },
      };
    }

    default:
      return NOTHING;
  }
}
