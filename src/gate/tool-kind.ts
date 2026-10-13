/**
 * Each runtime's tool names, read as tool kinds: Claude's, then Codex's.
 *
 * Claude's names are the agent SDK's own, as a `PreToolUse` input's `tool_name` carries them: the tools its
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

/**
 * Codex's tool names, read as tool kinds: the names its `PreToolUse` hook input carries and the name
 * this host gives each tool item (`codexItemToolName`). A shell command is `Bash` on every platform,
 * whatever shell runs it; a patch is `apply_patch`. Every MCP tool is `mcp__{server}__{tool}` and is
 * `mcp` by that prefix. Every other name (`spawn_agent`, `update_plan`, `request_user_input`, a
 * collaboration tool word, `image_generation`, ...) is `other`.
 */
export const CODEX_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  Bash: 'shell',
  apply_patch: 'file_edit',
  view_image: 'file_read',
  web_search: 'web',
};

/** The kind of the Codex tool named `toolName`: its row in the table, `mcp` by prefix, else `other`. */
export function codexToolKind(toolName: string): ToolKind {
  if (Object.hasOwn(CODEX_TOOL_KINDS, toolName)) return CODEX_TOOL_KINDS[toolName] ?? 'other';
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return 'mcp';
  return 'other';
}

/**
 * The tool a Codex thread item is a call of, by name, or null for an item that is no tool call. The
 * names are the ones `CODEX_TOOL_KINDS` reads; a collaboration call is named by its own tool word
 * (`spawnAgent`, `wait`, ...).
 */
export function codexItemToolName(item: {
  readonly type?: unknown;
  readonly [key: string]: unknown;
}): string | null {
  switch (item.type) {
    case 'commandExecution':
      return 'Bash';
    case 'fileChange':
      return 'apply_patch';
    case 'mcpToolCall':
      return typeof item['server'] === 'string' && typeof item['tool'] === 'string'
        ? `${MCP_TOOL_PREFIX}${item['server']}__${item['tool']}`
        : null;
    case 'webSearch':
      return 'web_search';
    case 'imageView':
      return 'view_image';
    case 'imageGeneration':
      return 'image_generation';
    case 'collabAgentToolCall':
      return typeof item['tool'] === 'string' && item['tool'] !== '' ? item['tool'] : null;
    default:
      return null;
  }
}
