/**
 * Qwen Code's stream-json wire, as far as this host reads and writes it: the message a Qwen process
 * yields to its session, and the shapes it parses out of the CLI's messages, its control requests and
 * its answers to this host's own control requests.
 *
 * The CLI writes one JSON value per line: a stream message (`user`, `assistant`, `system`, `result`,
 * `stream_event`), a control request it sends this host, or the answer to one this host sent. The
 * shapes below are a hand-written subset of what the pinned release writes, never copied from it.
 * Every object is loose: a member the CLI adds passes through, and a member this host does not read is
 * never required. What this host sends is built where it is sent (`qwen-control.ts`).
 */
import { z } from 'zod';

import type { JsonObject } from '../control/frames.js';

/**
 * One message a Qwen process yields to its session, in the order its session should see them.
 * - `message`: a stream message, as the CLI wrote it.
 * - `control_request`: a control request the CLI sent this host, already answered; `answer` is the
 *   response it was given.
 * - `answer`: the answer to a control request this host sent, beside the request it sent. These are
 *   how a fact the CLI reports only when asked (the session id, the context usage, the skills) reaches
 *   the fact lift as a message.
 * - `prompt`: a prompt this host wrote to the CLI, which never echoes one back; it rides nowhere on the
 *   wire, and the conversation's `user_text` item is read from it.
 */
export type QwenMessage =
  | { readonly kind: 'message'; readonly message: JsonObject }
  | { readonly kind: 'prompt'; readonly text: string }
  | {
      readonly kind: 'control_request';
      readonly requestId: string;
      readonly subtype: string;
      readonly request: JsonObject;
      readonly answer: JsonObject;
    }
  | {
      readonly kind: 'answer';
      readonly subtype: string;
      readonly request: JsonObject;
      readonly response: JsonObject;
    };

/** The control requests this host sends the CLI. */
export const QWEN_HOST_REQUESTS = [
  'initialize',
  'interrupt',
  'set_model',
  'set_permission_mode',
  'set_effort',
  'get_context_usage',
] as const;

export type QwenHostRequest = (typeof QWEN_HOST_REQUESTS)[number];

// ---------------------------------------------------------------------------
// Received shapes
// ---------------------------------------------------------------------------

const L = z.looseObject;
const text = z.string();
const count = z.number().finite();

/** The answer to `initialize`: the session's id, and the effort it took. */
export const InitializeAnswer = L({
  session_id: text,
  effort_status: L({ effort: text.nullable().optional() }).nullable().optional(),
});

/** The per-turn `system/init`. */
export const SystemInit = L({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: text,
  model: text.nullable().optional(),
  permission_mode: text.nullable().optional(),
  tools: z.array(text).optional(),
  mcp_servers: z.array(L({ name: text, status: text })).optional(),
  qwen_code_version: text.nullable().optional(),
  cwd: text.nullable().optional(),
});

/** A `system` message other than `init`: its payload rides under `data`. */
export const SystemMessage = L({
  type: z.literal('system'),
  subtype: text,
  uuid: text.optional(),
  data: z.unknown().optional(),
});

/** The usage a result or an assistant message carries. */
export const Usage = L({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count.nullable().optional(),
  cache_creation_input_tokens: count.nullable().optional(),
  total_tokens: count.nullable().optional(),
});

/** A `result`: one per processed user message. */
export const ResultMessage = L({
  type: z.literal('result'),
  subtype: text,
  uuid: text.optional(),
  session_id: text.optional(),
  is_error: z.boolean(),
  duration_ms: count.optional(),
  num_turns: count.optional(),
  result: text.optional(),
  usage: Usage.optional(),
  error: L({ message: text }).nullable().optional(),
});

/** One content block of an assistant or user message. */
export const ContentBlock = L({ type: text });

/** An `assistant` message: one model call's content, possibly split by block kind. */
export const AssistantMessage = L({
  type: z.literal('assistant'),
  uuid: text.optional(),
  parent_tool_use_id: text.nullable().optional(),
  message: L({
    id: text.optional(),
    model: text.nullable().optional(),
    content: z.array(ContentBlock),
    usage: Usage.optional(),
  }),
});

/** A `user` message: tool results, or a notification the CLI echoes. */
export const UserMessage = L({
  type: z.literal('user'),
  uuid: text.optional(),
  parent_tool_use_id: text.nullable().optional(),
  message: L({ content: z.union([text, z.array(ContentBlock)]) }),
});

/** A `stream_event`: one Anthropic-style event, or a tool's progress, or the goal's state. */
export const StreamEventMessage = L({
  type: z.literal('stream_event'),
  parent_tool_use_id: text.nullable().optional(),
  event: L({ type: text }),
});

/** The `can_use_tool` request the CLI sends for a call that resolves to ask. */
export const CanUseToolRequest = L({
  subtype: z.literal('can_use_tool'),
  tool_name: text,
  tool_use_id: text,
  input: z.unknown(),
});

/** The answer to `get_context_usage`. */
export const ContextUsageAnswer = L({
  modelName: text.nullable().optional(),
  totalTokens: count.nullable().optional(),
  contextWindowSize: count.nullable().optional(),
  skills: z.array(L({ name: text })).optional(),
});

/** A task the CLI reports started (`system/task_started`'s data). */
export const TaskStarted = L({
  task_id: text,
  tool_use_id: text.nullable().optional(),
  description: text.nullable().optional(),
});

/** A task the CLI reports on (`system/task_notification`'s data). */
export const TaskNotification = L({
  task_id: text,
  tool_use_id: text.nullable().optional(),
  status: text,
});

/** `value` read as `schema`, or null. */
export function parsed<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/** The stream message a Qwen message carries, or null for a control request or an answer. */
export function streamMessage(message: QwenMessage): JsonObject | null {
  return message.kind === 'message' ? message.message : null;
}

/**
 * The discriminator a stream message is accounted under: its `type`, and `system/{subtype}` for the
 * `system` family. Null for a value with no string `type`.
 */
export function qwenMessageKey(message: JsonObject): string | null {
  const type = message['type'];
  if (typeof type !== 'string' || type === '') return null;
  if (type !== 'system') return type;
  const subtype = message['subtype'];
  return typeof subtype === 'string' && subtype !== '' ? `system/${subtype}` : null;
}
