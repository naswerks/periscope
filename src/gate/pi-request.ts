/**
 * pi's tool call, as this host's extension sends it over the hook channel, read as a decision request.
 *
 * The extension sends the call's tool name, its id, its input (the object pi will run it with) and the
 * session's directory. What the request states beside them is this host's own: the session's id and key,
 * the session's directory, the tool's kind by pi's map and, for a shell call, the grammar its tool runs.
 * A call that does not read whole is null, which the shared decision refuses.
 */
import type { DecisionRequest } from './decision.js';
import { piShellDialect, piToolKind } from './tool-kind.js';

/** What this host states about the session a call belongs to. */
export interface PiRequestContext {
  /** pi's own session id, once known; empty before. */
  readonly sessionId: string;
  readonly sessionKey: string;
  /** The session's directory: where pi runs every call. */
  readonly cwd: string;
  readonly runtime: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The decision request for one call the extension sent, or null for one that does not read whole. */
export function readPiToolCall(event: unknown, context: PiRequestContext): DecisionRequest | null {
  if (!isRecord(event)) return null;
  const toolName = event['toolName'];
  const toolCallId = event['toolCallId'];
  const input = event['input'];
  if (typeof toolName !== 'string' || toolName === '') return null;
  if (typeof toolCallId !== 'string' || toolCallId === '') return null;
  if (!isRecord(input)) return null;
  const toolKind = piToolKind(toolName);
  const shellDialect = piShellDialect(toolName);
  return {
    toolName,
    toolUseId: toolCallId,
    toolInput: input,
    sessionId: context.sessionId,
    sessionKey: context.sessionKey,
    cwd: context.cwd,
    agentId: null,
    agentType: null,
    toolKind,
    runtime: context.runtime,
    ...(toolKind === 'shell' && shellDialect !== null ? { shellDialect } : {}),
  };
}
