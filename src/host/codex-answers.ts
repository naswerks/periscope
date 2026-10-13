/**
 * What this host answers each request the Codex app-server sends, before any decider exists for the
 * runtime: every answer refuses what was asked.
 *
 * - A command or a patch approval: `decline`.
 * - A permission widening: an empty grant, for the turn only. `permissions` here is the profile Codex
 *   is granted, and it is always empty: it widens nothing.
 * - An MCP elicitation (a tool approval, a form, a link): `decline`, with no content.
 * - A question for the user: no answers. Nobody sits on this lane to type one.
 * - Anything else: `-32601`, which Codex reads as a refusal.
 *
 * Never `acceptForSession`, an exec-policy or network-policy amendment, or a `session` scope: each
 * would silence the requests that follow it.
 */
import type { RpcAnswer } from './stdio-rpc.js';
import { RPC_METHOD_NOT_FOUND } from './stdio-rpc.js';

/** The requests this host answers itself, by method: the five Codex can send a client mid-turn. */
export const CODEX_ANSWERED_REQUESTS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
  'item/tool/requestUserInput',
] as const;

export function codexServerRequestAnswer(method: string): RpcAnswer {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'decline' } };
    case 'item/permissions/requestApproval':
      return { result: { permissions: {}, scope: 'turn' } };
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline', content: null, _meta: null } };
    case 'item/tool/requestUserInput':
      return { result: { answers: {} } };
    default:
      return { error: { code: RPC_METHOD_NOT_FOUND, message: `${method} is not answered by this host` } };
  }
}
