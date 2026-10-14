/**
 * Qwen Code's messages as this package's transitions: the translation for a session on the Qwen Code
 * runtime, beside `codex-observer.ts`'s for Codex. `SessionObserver.observeQwenMessage` records what this
 * returns, so the first `ready` still carries the tier.
 *
 * What is consumed is decided by `qwen-coverage.ts`; this file implements the wired rows that move the
 * machine. Every cause is `{ kind: 'agent-event', event: 'qwen-code:{name}' }`. The CLI writes a
 * `system/init` at the start of every user message it processes, never before the first, so the session
 * is `ready` once the CLI answers `initialize` with its session id, and each init marks a turn
 * `working`.
 *
 * Only the main thread moves the session's state: a message a sub-agent's call produced carries the id
 * of that call (`parent_tool_use_id`) and rides its native message alone.
 */
import type { QwenMessage } from '../host/qwen-wire.js';
import type { AgentEventName, ControlTier, SessionState, TransitionCause } from './model.js';
import type { TransitionRequest } from './machine.js';

/** What the Qwen Code lane remembers across messages, per session. */
export class QwenArmState {
  /** Whether the CLI has answered `initialize`; only the first answer records `ready`. */
  reported = false;
  /** The tool entries this lane opened and has not closed, by tool_use id. */
  readonly openTools = new Set<string>();
}

/** What the lane reads from the machine at the moment a message arrives. */
export interface QwenArmView {
  readonly state: SessionState;
  readonly controlTier: ControlTier | null;
  isOpen(entryId: string): boolean;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const record = (value: unknown): JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};

const word = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The message an interrupted turn's result carries as its error. */
export const QWEN_INTERRUPTED_MESSAGE = 'Operation cancelled.';

function cause(name: string, detail: string): TransitionCause {
  // The wired rows are exactly the agent events (the coverage pin); a name outside them is refused by
  // the machine as unnamed rather than recorded under a guess.
  return { kind: 'agent-event', event: `qwen-code:${name}` as AgentEventName, detail };
}

/** The content blocks of a stream message's `message.content`, or none. */
function blocks(message: JsonRecord): JsonRecord[] {
  const content = record(message['message'])['content'];
  return Array.isArray(content) ? content.map(record) : [];
}

/** Whether a stream message belongs to the main thread rather than a sub-agent's call. */
function mainThread(message: JsonRecord): boolean {
  const parent = message['parent_tool_use_id'];
  return parent === undefined || parent === null;
}

/** The transitions one Qwen Code message asks for. Pure: what it remembers lives in `arm`. */
export function qwenRequestsFor(
  message: QwenMessage,
  arm: QwenArmState,
  view: QwenArmView,
): readonly TransitionRequest[] {
  if (message.kind === 'answer') {
    if (message.subtype !== 'initialize' || arm.reported) return [];
    const id = word(message.response['session_id']);
    if (id === null) return [];
    arm.reported = true;
    return [
      {
        to: 'ready',
        sessionId: id,
        cause: cause('initialize', 'the CLI answered initialize with its session id'),
        ...(view.controlTier === null ? {} : { controlTier: view.controlTier }),
      },
    ];
  }
  if (message.kind !== 'message') return [];

  const body = message.message;
  const type = word(body['type']);
  switch (type) {
    case 'system': {
      if (word(body['subtype']) !== 'init') return [];
      return [{ to: 'working', cause: cause('system/init', 'the CLI took the next prompt') }];
    }

    case 'assistant': {
      if (!mainThread(body)) return [];
      const requests: TransitionRequest[] = [];
      for (const block of blocks(body)) {
        if (block['type'] !== 'tool_use') continue;
        const id = word(block['id']);
        const name = word(block['name']);
        if (id === null || name === null || arm.openTools.has(id)) continue;
        arm.openTools.add(id);
        requests.push({
          to: 'working',
          entry: { op: 'open', entryId: id, activity: { kind: 'tool', name } },
          cause: cause('assistant', `tool_use: ${name}`),
        });
      }
      return requests;
    }

    case 'user': {
      if (!mainThread(body)) return [];
      const requests: TransitionRequest[] = [];
      for (const block of blocks(body)) {
        if (block['type'] !== 'tool_result') continue;
        const id = word(block['tool_use_id']);
        if (id === null || !arm.openTools.delete(id) || !view.isOpen(id)) continue;
        requests.push({
          to: view.state,
          entry: { op: 'close', entryId: id },
          cause: cause('user', `tool_result${block['is_error'] === true ? ' (error)' : ''}`),
        });
      }
      return requests;
    }

    case 'result': {
      const requests: TransitionRequest[] = [];
      // The backstop: a tool entry the turn left open is closed by the turn's end, never left ageing.
      for (const entryId of arm.openTools) {
        if (view.isOpen(entryId)) {
          requests.push({
            to: view.state,
            entry: { op: 'close', entryId },
            cause: cause('result', `tool entry ${entryId} closed by the end of its turn`),
          });
        }
      }
      arm.openTools.clear();
      const failed = body['is_error'] === true;
      const error = word(record(body['error'])['message']);
      const to: SessionState = !failed
        ? 'idle'
        : error !== null && error.startsWith(QWEN_INTERRUPTED_MESSAGE)
          ? 'interrupted'
          : 'errored';
      const duration = typeof body['duration_ms'] === 'number' ? ` in ${body['duration_ms']}ms` : '';
      const why =
        to === 'idle'
          ? `the turn completed${duration}`
          : to === 'interrupted'
            ? 'the turn was interrupted'
            : `the turn failed: ${error ?? word(body['subtype']) ?? 'no message'}`;
      requests.push({ to, cause: cause('result', why) });
      return requests;
    }

    default:
      return [];
  }
}
