/**
 * pi's RPC wire, as far as this host reads and writes it: the message a pi process yields to its
 * session, and the shapes it parses out of pi's events, its records and its answers to this host's
 * commands.
 *
 * pi in RPC mode writes one JSON value per line: an event (`{ type: '<event>', … }`), the answer to a
 * command (`{ id, type: 'response', command, success, data | error }`), an extension's UI request or an
 * extension's error. The shapes below are a hand-written subset of what the pinned release writes, never
 * copied from it. Every object is loose: a member pi adds passes through, and a member this host does not
 * read is never required. What this host sends is built where it is sent (`pi-rpc.ts`).
 */
import { z } from 'zod';

import type { JsonObject } from '../control/frames.js';
import type { PiHello } from './pi-extension.js';

/**
 * One message a pi process yields to its session, in the order its session should see them.
 * - `event`: one of pi's events, as pi wrote it.
 * - `record`: an extension's UI request or error, as pi wrote it.
 * - `response`: pi's answer to a command this host sent, beside the command. These are how a fact pi
 *   reports only when asked (the session id, the commands loaded, the session's spend) reaches the fact
 *   lift as a message.
 * - `hello`: what this host's extension said it can see loaded, when it said hello. It rides nowhere on
 *   the wire.
 */
export type PiMessage =
  | { readonly kind: 'event'; readonly event: JsonObject }
  | { readonly kind: 'record'; readonly record: JsonObject }
  | {
      readonly kind: 'response';
      readonly command: PiHostCommand;
      readonly request: JsonObject;
      readonly response: JsonObject;
    }
  | { readonly kind: 'hello'; readonly hello: PiHello };

/** The commands this host sends pi. */
export const PI_HOST_COMMANDS = [
  'prompt',
  'abort',
  'get_state',
  'set_model',
  'get_available_models',
  'set_thinking_level',
  'get_session_stats',
  'get_commands',
] as const;

export type PiHostCommand = (typeof PI_HOST_COMMANDS)[number];

/** The extension UI requests that wait for an answer; every other method is said and not answered. */
export const PI_DIALOG_METHODS: readonly string[] = ['select', 'confirm', 'input', 'editor'];

// ---------------------------------------------------------------------------
// Received shapes
// ---------------------------------------------------------------------------

const L = z.looseObject;
const text = z.string();
const count = z.number().finite();

/** A model, as pi names one in an answer. */
export const PiModel = L({
  provider: text,
  id: text,
  name: text.optional(),
  contextWindow: count.nullable().optional(),
  reasoning: z.boolean().optional(),
});

/** The answer to `get_state`. */
export const PiState = L({
  sessionId: text,
  sessionFile: text.nullable().optional(),
  model: PiModel.nullable().optional(),
  thinkingLevel: text.nullable().optional(),
  isStreaming: z.boolean().optional(),
});

/** Where a command, a tool or an extension came from. */
export const PiSourceInfo = L({ path: text, source: text, baseDir: text.optional() });

/** The answer to `get_commands`. */
export const PiCommands = L({
  commands: z.array(L({ name: text, source: text, sourceInfo: PiSourceInfo })),
});

/** The answer to `get_session_stats`: the session's totals as pi states them. */
export const PiSessionStats = L({
  sessionId: text,
  tokens: L({ input: count, output: count, cacheRead: count, cacheWrite: count, total: count.optional() }),
  cost: count,
  contextUsage: L({ tokens: count.nullable(), contextWindow: count, percent: count.nullable().optional() })
    .nullable()
    .optional(),
});

/** The answer to `get_available_models`. */
export const PiAvailableModels = L({ models: z.array(PiModel) });

/** A message's usage, as pi reports it per model call. */
export const PiUsage = L({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
});

/** One content block of a message. */
export const PiContentBlock = L({ type: text });

/** A message, as `message_end` carries it: the user's prompt, an assistant answer, or a tool's result. */
export const PiMessageBody = L({
  role: text,
  content: z.union([text, z.array(PiContentBlock)]),
  model: text.optional(),
  provider: text.optional(),
  usage: PiUsage.optional(),
  stopReason: text.optional(),
  errorMessage: text.optional(),
});

/** `message_end`. */
export const PiMessageEnd = L({ type: z.literal('message_end'), message: PiMessageBody });

/** `message_update`, as RPC mode writes it: the delta, with the running usage. */
export const PiMessageUpdate = L({
  type: z.literal('message_update'),
  assistantMessageEvent: L({ type: text, delta: text.optional(), contentIndex: count.optional() }),
});

/** `tool_execution_start`. */
export const PiToolStart = L({
  type: z.literal('tool_execution_start'),
  toolCallId: text,
  toolName: text,
  parentToolCallId: text.optional(),
});

/** `tool_execution_end`. */
export const PiToolEnd = L({
  type: z.literal('tool_execution_end'),
  toolCallId: text,
  toolName: text,
  result: z.unknown(),
  isError: z.boolean(),
  durationMs: count.optional(),
  parentToolCallId: text.optional(),
});

/** `agent_settled`: the run is over and the session idle. */
export const PiAgentSettled = L({ type: z.literal('agent_settled'), aborted: z.boolean() });

/** `compaction_start`. */
export const PiCompactionStart = L({ type: z.literal('compaction_start'), reason: text });

/** `compaction_end`. */
export const PiCompactionEnd = L({
  type: z.literal('compaction_end'),
  reason: text,
  result: L({ tokensBefore: count.optional() }).nullable().optional(),
  aborted: z.boolean().optional(),
  errorMessage: text.optional(),
});

/** `thinking_level_changed`. */
export const PiThinkingLevelChanged = L({ type: z.literal('thinking_level_changed'), level: text });

/** `auto_retry_start` and `summarization_retry_scheduled`. */
export const PiRetryScheduled = L({
  attempt: count,
  maxAttempts: count,
  errorMessage: text.optional(),
});

/** `auto_retry_end`. */
export const PiRetryEnd = L({
  type: z.literal('auto_retry_end'),
  success: z.boolean(),
  attempt: count,
  finalError: text.optional(),
});

/** An extension's UI request. */
export const PiUiRequest = L({
  type: z.literal('extension_ui_request'),
  id: text,
  method: text,
  message: text.optional(),
  notifyType: text.optional(),
  title: text.optional(),
});

/** An extension's error. */
export const PiExtensionError = L({
  type: z.literal('extension_error'),
  extensionPath: text.optional(),
  event: text.optional(),
  error: text.optional(),
});

/** A response's members: whether it succeeded, its data, and its error. */
export const PiResponse = L({
  type: z.literal('response'),
  command: text,
  success: z.boolean(),
  data: z.unknown().optional(),
  error: text.optional(),
});

/** The first line of a session file. */
export const PiSessionHeader = L({ type: z.literal('session'), id: text, cwd: text });

/** `value` read as `schema`, or null. */
export function parsed<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/** The type of an event or record, or null for a value with no string `type`. */
export function piTypeOf(value: JsonObject): string | null {
  const type = value['type'];
  return typeof type === 'string' && type !== '' ? type : null;
}

/** A response's data, when it succeeded and carries an object. */
export function responseData(message: Extract<PiMessage, { kind: 'response' }>): JsonObject | null {
  if (message.response['success'] !== true) return null;
  const data = message.response['data'];
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? data : null;
}

/** A response's error text, when it failed. */
export function responseError(message: Extract<PiMessage, { kind: 'response' }>): string | null {
  if (message.response['success'] !== false) return null;
  const error = message.response['error'];
  return typeof error === 'string' && error !== '' ? error : 'pi gave no reason';
}

/** The text of a message's content: a string as it is, else its text blocks joined. */
export function piContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block: unknown) => {
      if (typeof block !== 'object' || block === null) return [];
      const read = block as Record<string, unknown>;
      return read['type'] === 'text' && typeof read['text'] === 'string' ? [read['text']] : [];
    })
    .join('');
}
