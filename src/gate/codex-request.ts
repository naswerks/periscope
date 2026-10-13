/**
 * What Codex's `PreToolUse` hook hands its command, read as a decision request.
 *
 * Codex writes one JSON object to the hook's standard input, in the snake_case shape Claude Code's hook
 * input uses: `session_id`, `turn_id`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `tool_name`,
 * `tool_input` and `tool_use_id`, with `agent_id` and `agent_type` present only for a sub-agent's call.
 * `permission_mode` is Codex's own word and is never read as this host's mode.
 *
 * Anything that is not a readable `PreToolUse` call is null, which the decision refuses. This host only
 * ever registers the hook for `PreToolUse`, so another event name, a missing tool name or a missing call
 * id is an input nobody can authorize: answering it with no opinion would let the call proceed.
 */
import type { DecisionRequest, ShellDialect } from './decision.js';
import { codexToolKind } from './tool-kind.js';

/** The session facts the hook's input does not carry: the controller's handle and the shell's grammar. */
export interface CodexRequestContext {
  /** The controller's handle for the session. Never read from the hook's input. */
  readonly sessionKey: string;
  /** The session's runtime name, as the decision request carries it. */
  readonly runtime: string;
  /** The grammar the runtime's shell tool runs its command in. Stated on shell calls only. */
  readonly shellDialect: ShellDialect;
}

/** The Codex hook event as a decision request, or null when it is not a readable `PreToolUse` call. */
export function readCodexHookRequest(event: unknown, context: CodexRequestContext): DecisionRequest | null {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return null;
  const input = event as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  if (input['hook_event_name'] !== 'PreToolUse') return null;
  const toolName = text(input['tool_name']);
  const toolUseId = text(input['tool_use_id']);
  if (toolName === null || toolName === '' || toolUseId === null || toolUseId === '') return null;
  const toolKind = codexToolKind(toolName);
  return {
    toolName,
    toolUseId,
    toolInput: input['tool_input'],
    sessionId: text(input['session_id']) ?? '',
    sessionKey: context.sessionKey,
    cwd: text(input['cwd']) ?? '',
    // Present only for a sub-agent's call; `agent_id` is the discriminator.
    agentId: text(input['agent_id']),
    agentType: text(input['agent_type']),
    toolKind,
    runtime: context.runtime,
    ...(toolKind === 'shell' ? { shellDialect: context.shellDialect } : {}),
  };
}

/** The turn a Codex hook event belongs to, or null when it names none. */
export function codexHookTurn(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return null;
  const turn = (event as Record<string, unknown>)['turn_id'];
  return typeof turn === 'string' && turn !== '' ? turn : null;
}
