/**
 * The Codex app-server's wire, as far as this host reads and writes it: the message a Codex process
 * yields to its session, the shapes it parses out of the server's answers and notifications, and the
 * client methods it calls. The permission-mode map lives with the mode vocabulary, in `wire-request.ts`.
 *
 * The received shapes are a hand-written subset of the protocol the pinned release declares, read
 * from its generated TypeScript exports and never copied from them. Every object is loose: a member
 * the server adds passes through, and a member this host does not read is never required. What this
 * host sends is built by hand where it is sent.
 *
 * Experimental API is never used: no method below carries the protocol's experimental marker at the
 * pinned release (`pins/codex-coverage.test.ts` holds that), and no experimental field is ever sent.
 */
import { z } from 'zod';

import type { JsonObject } from '../control/frames.js';
import { codexWireKey } from './codex-names.js';
import type { RpcId } from './stdio-rpc.js';

export { CODEX_RUNTIME } from '../sessions/runtimes.js';

/**
 * One message a Codex process yields to its session, in the order its session should see them.
 * - `notification`: a notification from the server, as it arrived.
 * - `server_request`: a request from the server, already answered by the adapter; `answer` is what it
 *   was answered with.
 * - `answer`: the answer to a request the adapter made, beside the params it sent. These are how a
 *   fact the server reports only when asked (the version, the resolved model, the skills, the MCP
 *   servers) reaches the fact lift as a message.
 */
export type CodexMessage =
  | { readonly kind: 'notification'; readonly method: string; readonly params: JsonObject }
  | {
      readonly kind: 'server_request';
      readonly id: RpcId;
      readonly method: string;
      readonly params: JsonObject;
      readonly answer: JsonObject;
    }
  | {
      readonly kind: 'answer';
      readonly method: string;
      readonly params: JsonObject;
      readonly result: JsonObject;
    };

/** The client methods this adapter calls. Each is stable at the pinned release. */
export const CODEX_CLIENT_METHODS = [
  'initialize',
  'account/read',
  'model/list',
  'thread/start',
  'thread/resume',
  'thread/fork',
  'skills/extraRoots/set',
  'skills/list',
  'mcpServerStatus/list',
  'turn/start',
  'turn/interrupt',
  'hooks/list',
  'config/batchWrite',
  'config/read',
  'windowsSandbox/readiness',
] as const;

export type CodexClientMethod = (typeof CODEX_CLIENT_METHODS)[number];

// ---------------------------------------------------------------------------
// Received shapes
// ---------------------------------------------------------------------------

const L = z.looseObject;
const text = z.string();
const nullableText = z.string().nullable().optional();

export const InitializeResponse = L({ userAgent: text, codexHome: text });

export const AccountReadResponse = L({
  account: L({ type: text }).nullable(),
  requiresOpenaiAuth: z.boolean(),
});

export const CodexModel = L({
  id: text,
  displayName: text,
  description: nullableText,
  hidden: z.boolean().optional(),
  supportedReasoningEfforts: z.array(L({ reasoningEffort: text })).optional(),
});

export const ModelListResponse = L({ data: z.array(CodexModel), nextCursor: nullableText });

export const CodexThread = L({
  id: text,
  cliVersion: text.optional(),
  parentThreadId: nullableText,
});

/** The answer to `thread/start`, `thread/resume` and `thread/fork`. */
export const ThreadOpenResponse = L({
  thread: CodexThread,
  model: text,
  cwd: text.optional(),
  approvalPolicy: z.unknown().optional(),
  reasoningEffort: nullableText,
});

export const CodexTurnError = L({
  message: text,
  codexErrorInfo: z.unknown().optional(),
  additionalDetails: nullableText,
});

export const CodexTurn = L({
  id: text,
  status: text,
  error: CodexTurnError.nullable().optional(),
  durationMs: z.number().nullable().optional(),
});

export const TurnStartResponse = L({ turn: CodexTurn });

export const SkillsListResponse = L({
  data: z.array(
    L({
      cwd: text,
      skills: z.array(L({ name: text })),
      errors: z.array(L({ path: text, message: text })),
    }),
  ),
});

export const McpServerStatusListResponse = L({
  data: z.array(L({ name: text, runtimeStatus: nullableText })),
  nextCursor: nullableText,
});

export const TokenUsageBreakdown = L({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteInputTokens: z.number().optional(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});

export const ThreadTokenUsageUpdated = L({
  threadId: text,
  turnId: text,
  tokenUsage: L({
    total: TokenUsageBreakdown,
    last: TokenUsageBreakdown,
    modelContextWindow: z.number().nullable().optional(),
  }),
});

export const TurnNotification = L({ threadId: text, turn: CodexTurn });

export const ThreadStartedNotification = L({ thread: CodexThread });

export const CodexThreadItem = L({ type: text, id: text });

export const ItemNotification = L({ item: CodexThreadItem, threadId: text, turnId: text });

export const ContentDelta = L({ threadId: text, turnId: text, itemId: text, delta: text });

export const ModelRerouted = L({ threadId: text, turnId: text, toModel: text });

export const McpServerStartupStatus = L({ name: text, status: text });

export const ErrorNotification = L({
  error: CodexTurnError,
  willRetry: z.boolean(),
  threadId: text,
  turnId: text,
});

/** Parse with a loose schema; null when the value does not have the shape. */
export function parsed<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/** The stage of an agent message item (its final answer, or interim), read through the key table. */
export function agentMessageStage(item: JsonObject): string | null {
  const stage = item[codexWireKey('agentMessage', 'stage')];
  return typeof stage === 'string' ? stage : null;
}
