/**
 * What an opencode session's process yields, and the readings every opencode reader shares.
 *
 * The session's host process forwards every event of opencode's stream: one object per event, with its `id`,
 * its `type` and its `data`. The stream is the whole server's, so it carries the session's own events, those
 * of the sessions a subagent call starts under it, and events of the server itself (its plugins, its models,
 * its configuration). The process says, for each event, which of these it is: `main` for the session's own,
 * and `spawnedBy` for a subagent's session, naming the call that started it. Every reading here is loose: a
 * member the runtime adds passes through, and a member this host does not read is never required.
 */
import type { OpencodeEvent } from './opencode-sdk.js';

/**
 * One message an opencode process yields to its session, in the order its session should see them.
 * - `opened`: the session is open and proven: the server's posture was read back before the first prompt.
 *   It names the session's id and what the server said it runs with. Nothing rides the wire for it; the
 *   session goes live on it.
 * - `event`: one event of the server's stream, with whose it is.
 */
export type OpencodeMessage =
  | {
      readonly kind: 'opened';
      readonly sessionId: string;
      /** The session's model as `providerID/id`, or null when it names none. */
      readonly model: string | null;
      /** The agent the session runs as: `build`, or `plan`. */
      readonly agent: string;
      /** How the session came to be: a new session, a resumed one, or a fork of another. */
      readonly origin: 'new' | 'resume' | 'fork';
    }
  | {
      readonly kind: 'event';
      readonly event: OpencodeEvent;
      /** The session the event names (`data.sessionID`), or null for an event of the server itself. */
      readonly session: string | null;
      /** Whether the event is the session's own. */
      readonly main: boolean;
      /** The call that started the subagent's session the event belongs to, or null. */
      readonly spawnedBy: string | null;
    };

type JsonRecord = Readonly<Record<string, unknown>>;

/** An event's `data`, or an empty record. */
export function opencodeData(event: OpencodeEvent): JsonRecord {
  const data = event.data;
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as JsonRecord) : {};
}

/** A record of `value`, or an empty one. */
export function opencodeRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** `value` when a non-empty string, else null. */
export function opencodeWord(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** `value` as a count the wire carries: a non-negative whole number, or null. */
export function opencodeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** A model reference (`{ id, providerID }`) as `providerID/id`, or null. */
export function opencodeModelName(value: unknown): string | null {
  const model = opencodeRecord(value);
  const id = opencodeWord(model['id']);
  const provider = opencodeWord(model['providerID']);
  return id === null ? null : provider === null ? id : `${provider}/${id}`;
}

/** The words of a structured error: its type and its message. */
export function opencodeErrorWords(value: unknown): string {
  const error = opencodeRecord(value);
  const type = opencodeWord(error['type']);
  const message = opencodeWord(error['message']) ?? 'no message';
  return type === null ? message : `${type}: ${message}`;
}

/** The deltas an opencode session streams, which ride the delta lane rather than the update lane. */
export const OPENCODE_DELTA_EVENTS: readonly string[] = [
  'session.text.delta',
  'session.reasoning.delta',
  'session.tool.input.delta',
  'session.compaction.delta',
];
