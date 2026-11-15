/**
 * What a Copilot session's process yields, and the readings every Copilot reader shares.
 *
 * The runtime hands the session its events through the SDK (`onEvent`): one object per event, with its
 * `id`, `parentId`, `timestamp`, `type`, an `agentId` when a sub-agent's, and its `data`. Every reading
 * here is loose: a member the runtime adds passes through, and a member this host does not read is never
 * required. What this host sends is built where it is sent (`copilot-process.ts`).
 */
import type { CopilotEvent } from './copilot-sdk.js';

/**
 * One message a Copilot process yields to its session, in the order its session should see them.
 * - `opened`: the session is open and proven: the runtime's posture was read back and a probe call reached
 *   this host through the pre-tool hook and the permission request both. It names the session's id and
 *   what the runtime said it runs with. Nothing rides the wire for it; the session goes live on it.
 * - `event`: one session event, as the SDK handed it over. The open's own probe call is never one.
 */
export type CopilotMessage =
  | {
      readonly kind: 'opened';
      readonly sessionId: string;
      /** The model the runtime selected, as `session.start` or `session.resume` named it. */
      readonly model: string | null;
      /** The agent mode the runtime reports: `interactive` or `plan`. */
      readonly agentMode: string;
      /** The built-in tools the runtime offers the session, by name. */
      readonly tools: readonly string[];
      /** How the session came to be: a new session, a resumed one, or a fork of another. */
      readonly origin: 'new' | 'resume' | 'fork';
    }
  | { readonly kind: 'event'; readonly event: CopilotEvent };

type JsonRecord = Readonly<Record<string, unknown>>;

/** An event's `data`, or an empty record. */
export function copilotData(event: CopilotEvent): JsonRecord {
  const data = event.data;
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as JsonRecord) : {};
}

/** A record of `value`, or an empty one. */
export function copilotRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** `value` when a non-empty string, else null. */
export function copilotWord(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** `value` as a count the wire carries: a non-negative whole number, or null. */
export function copilotCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * The call that spawned the agent an event belongs to, by its id: the event's `parentToolCallId`. Null on
 * the session's own thread.
 */
export function copilotSpawnedBy(event: CopilotEvent): string | null {
  return copilotWord(copilotData(event)['parentToolCallId']);
}

/**
 * Whether an event is the session's own: no sub-agent named in its envelope (`agentId`) and no spawning call
 * named in its data. Only the session's own events move its state.
 */
export function isCopilotMainThread(event: CopilotEvent): boolean {
  return copilotWord(event.agentId) === null && copilotSpawnedBy(event) === null;
}

/** The deltas a Copilot session streams, which ride the delta lane rather than the update lane. */
export const COPILOT_DELTA_EVENTS: readonly string[] = [
  'assistant.message_delta',
  'assistant.reasoning_delta',
  'assistant.streaming_delta',
  'assistant.tool_call_delta',
];
