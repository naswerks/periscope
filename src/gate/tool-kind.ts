/**
 * Claude's tool names, read as tool kinds.
 *
 * The names are the agent SDK's own, as a `PreToolUse` input's `tool_name` carries them: the tools its
 * input schemas describe, and the gate's own families (`DEFAULT_TOOL_FAMILIES`). A tool the table does
 * not name is `other`, stated on the request rather than left out, so every gated call carries a kind.
 * Every MCP tool reaches the model as `mcp__{server}__{tool}` and is `mcp` by that prefix.
 */
import type { ToolKind } from './decision.js';

/** The kind of each Claude tool this table names. Every other name is `other`. */
export const CLAUDE_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  Bash: 'shell',
  PowerShell: 'shell',
  Read: 'file_read',
  Grep: 'file_read',
  Glob: 'file_read',
  NotebookRead: 'file_read',
  Write: 'file_write',
  Edit: 'file_edit',
  MultiEdit: 'file_edit',
  NotebookEdit: 'file_edit',
  WebFetch: 'web',
  WebSearch: 'web',
};

/** The prefix every MCP tool name carries. */
const MCP_TOOL_PREFIX = 'mcp__';

/** The kind of the Claude tool named `toolName`: its row in the table, `mcp` by prefix, else `other`. */
export function claudeToolKind(toolName: string): ToolKind {
  if (Object.hasOwn(CLAUDE_TOOL_KINDS, toolName)) return CLAUDE_TOOL_KINDS[toolName] ?? 'other';
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return 'mcp';
  return 'other';
}
