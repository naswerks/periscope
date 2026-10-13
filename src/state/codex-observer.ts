/**
 * Codex's events as this package's transitions: the translation for a session on the Codex runtime,
 * beside `observer.ts`'s for Claude. `SessionObserver.observeCodexMessage` records what this returns,
 * so the first `ready` still carries the tier and a compaction is still reported once.
 *
 * What is consumed is decided by `codex-coverage.ts`, as `coverage.ts` decides it for Claude; this
 * file implements the wired rows that move the machine. Every cause is `{ kind: 'agent-event',
 * event: 'codex:{method}' }`, and an item's kind rides the detail, never the event name.
 *
 * Only the session's own thread moves its state. A sub-agent runs on a thread of its own, and its
 * turns and items ride the native messages without moving the session.
 */
import type { CodexMessage } from '../host/codex-wire.js';
import { codexItemToolName } from '../gate/tool-kind.js';
import type { AgentEventName, ControlTier, SessionState, TransitionCause } from './model.js';
import type { TransitionRequest } from './machine.js';

/** The compaction entry's id, shared with the Claude lane: one compaction at a time per session. */
export const CODEX_COMPACTION_ENTRY = 'compaction';
/** The entry a pending approval holds the session under. */
export const CODEX_APPROVAL_ENTRY = 'permission:approval';
/** The entry a pending request for user input holds the session under. */
export const CODEX_INPUT_ENTRY = 'elicitation:input';

/** What the Codex lane remembers across messages, per session. */
export class CodexArmState {
  /** The session's own thread, from the answer that opened it. Null until then. */
  thread: string | null = null;
  /** Whether the thread has reported itself; only the first report records `ready`. */
  reported = false;
  /** The tool entries this lane opened and has not closed, by item id. */
  readonly openTools = new Set<string>();
}

/** What the lane reads from the machine and the observer at the moment a message arrives. */
export interface CodexArmView {
  readonly state: SessionState;
  readonly controlTier: ControlTier | null;
  isOpen(entryId: string): boolean;
}

/** The records one message asks for, and whether it moved the compaction entry. */
export interface CodexArmOutcome {
  readonly requests: readonly TransitionRequest[];
  /** Set when the message moved the compaction entry: which way, and the item that moved it. */
  readonly compaction: { readonly status: 'started' | 'ended'; readonly itemId: string } | null;
}

const NOTHING: CodexArmOutcome = { requests: [], compaction: null };

type JsonRecord = Readonly<Record<string, unknown>>;

const record = (value: unknown): JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};

const word = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function cause(method: string, detail: string): TransitionCause {
  // The wired notifications are exactly the agent events (the coverage pin); a name outside them is
  // refused by the machine as unnamed rather than recorded under a guess.
  return { kind: 'agent-event', event: `codex:${method}` as AgentEventName, detail };
}

/** The error a turn or an error notification carries, in words: its message, its class, its details. */
function errorDetail(error: JsonRecord): string {
  const parts = [word(error['message']) ?? 'no message'];
  const info = error['codexErrorInfo'];
  if (typeof info === 'string') parts.push(`(${info})`);
  else if (info !== null && info !== undefined) parts.push(`(${JSON.stringify(info)})`);
  const details = word(error['additionalDetails']);
  if (details !== null) parts.push(`- ${details}`);
  return parts.join(' ');
}

/** The transitions one Codex message asks for. Pure: what it remembers lives in `arm`. */
export function codexRequestsFor(
  message: CodexMessage,
  arm: CodexArmState,
  view: CodexArmView,
): CodexArmOutcome {
  if (message.kind === 'answer') {
    if (
      message.method === 'thread/start' ||
      message.method === 'thread/resume' ||
      message.method === 'thread/fork'
    ) {
      arm.thread ??= word(record(message.result['thread'])['id']);
    }
    return NOTHING;
  }
  if (message.kind !== 'notification') return NOTHING;

  const { method, params } = message;
  const onThread = (threadId: unknown): boolean => arm.thread !== null && threadId === arm.thread;

  switch (method) {
    case 'thread/started': {
      const thread = record(params['thread']);
      const id = word(thread['id']);
      if (arm.reported || id === null) return NOTHING;
      if (arm.thread !== null && id !== arm.thread) return NOTHING;
      arm.thread = id;
      arm.reported = true;
      return {
        requests: [
          {
            to: 'ready',
            sessionId: id,
            cause: cause(
              method,
              `the thread reported itself on Codex ${word(thread['cliVersion']) ?? 'of unknown version'}`,
            ),
            ...(view.controlTier === null ? {} : { controlTier: view.controlTier }),
          },
        ],
        compaction: null,
      };
    }

    case 'turn/started': {
      if (!onThread(params['threadId'])) return NOTHING;
      const turn = record(params['turn']);
      return {
        requests: [{ to: 'working', cause: cause(method, `turn ${word(turn['id']) ?? '?'} started`) }],
        compaction: null,
      };
    }

    case 'turn/completed': {
      if (!onThread(params['threadId'])) return NOTHING;
      const turn = record(params['turn']);
      const status = word(turn['status']);
      const to: SessionState | null =
        status === 'completed'
          ? 'idle'
          : status === 'interrupted'
            ? 'interrupted'
            : status === 'failed'
              ? 'errored'
              : null;
      // A turn reported complete while still in progress, or with a status this release did not
      // declare, moves nothing: its native message rides, and the next report says where it is.
      if (to === null) return NOTHING;
      const requests: TransitionRequest[] = [];
      // The backstop: a tool item the turn left open is closed by the turn's end, never left ageing.
      for (const entryId of arm.openTools) {
        if (view.isOpen(entryId)) {
          requests.push({
            to: view.state,
            entry: { op: 'close', entryId },
            cause: cause(method, `tool item ${entryId} closed by the end of its turn`),
          });
        }
      }
      arm.openTools.clear();
      const error = turn['error'];
      const why =
        status === 'failed' && error !== null && error !== undefined
          ? `the turn failed: ${errorDetail(record(error))}`
          : `the turn ${status}${typeof turn['durationMs'] === 'number' ? ` in ${turn['durationMs']}ms` : ''}`;
      requests.push({ to, cause: cause(method, why) });
      return { requests, compaction: null };
    }

    case 'thread/status/changed': {
      if (!onThread(params['threadId'])) return NOTHING;
      const status = record(params['status']);
      const type = word(status['type']);
      if (type === 'systemError') {
        return {
          requests: [{ to: 'errored', cause: cause(method, 'the thread reported a system error') }],
          compaction: null,
        };
      }
      const flags = type === 'active' && Array.isArray(status['activeFlags']) ? status['activeFlags'] : [];
      const requests: TransitionRequest[] = [];
      for (const [flag, entryId, kind, name] of [
        ['waitingOnApproval', CODEX_APPROVAL_ENTRY, 'permission', 'approval'],
        ['waitingOnUserInput', CODEX_INPUT_ENTRY, 'elicitation', 'input'],
      ] as const) {
        const waiting = flags.includes(flag);
        const open = view.isOpen(entryId);
        if (waiting && !open) {
          requests.push({
            to: view.state,
            entry: { op: 'open', entryId, activity: { kind, name } },
            cause: cause(
              method,
              `the thread is waiting on ${name === 'approval' ? 'an approval' : 'user input'}`,
            ),
          });
        } else if (!waiting && open) {
          requests.push({
            to: view.state,
            entry: { op: 'close', entryId },
            cause: cause(
              method,
              `the thread is no longer waiting on ${name === 'approval' ? 'an approval' : 'user input'}`,
            ),
          });
        }
      }
      return { requests, compaction: null };
    }

    case 'thread/closed': {
      if (!onThread(params['threadId'])) return NOTHING;
      return {
        requests: [
          {
            to: 'ended',
            entry: { op: 'abandon-open', reason: 'the thread closed with this entry still open' },
            cause: cause(method, 'the thread closed'),
          },
        ],
        compaction: null,
      };
    }

    case 'error': {
      if (!onThread(params['threadId']) || params['willRetry'] !== false) return NOTHING;
      return {
        requests: [
          { to: 'errored', cause: cause(method, `the turn failed: ${errorDetail(record(params['error']))}`) },
        ],
        compaction: null,
      };
    }

    case 'item/started':
    case 'item/completed': {
      if (!onThread(params['threadId'])) return NOTHING;
      const item = record(params['item']);
      const id = word(item['id']);
      const type = word(item['type']);
      if (id === null || type === null) return NOTHING;
      const started = method === 'item/started';

      if (type === 'contextCompaction') {
        const open = view.isOpen(CODEX_COMPACTION_ENTRY);
        if (started === open) return NOTHING;
        return {
          requests: [
            {
              to: view.state,
              entry: started
                ? {
                    op: 'open',
                    entryId: CODEX_COMPACTION_ENTRY,
                    activity: { kind: 'compacting', name: null },
                  }
                : { op: 'close', entryId: CODEX_COMPACTION_ENTRY },
              cause: cause(method, `contextCompaction ${started ? 'started' : 'completed'}`),
            },
          ],
          compaction: { status: started ? 'started' : 'ended', itemId: id },
        };
      }

      const tool = codexItemToolName(item);
      if (tool === null) return NOTHING;
      if (started) {
        arm.openTools.add(id);
        return {
          requests: [
            {
              to: 'working',
              entry: { op: 'open', entryId: id, activity: { kind: 'tool', name: tool } },
              cause: cause(method, `${type} started: ${tool}`),
            },
          ],
          compaction: null,
        };
      }
      if (!arm.openTools.delete(id) || !view.isOpen(id)) return NOTHING;
      const status = word(item['status']);
      return {
        requests: [
          {
            to: view.state,
            entry: { op: 'close', entryId: id },
            cause: cause(method, `${type} ${status ?? 'completed'}: ${tool}`),
          },
        ],
        compaction: null,
      };
    }

    default:
      return NOTHING;
  }
}
