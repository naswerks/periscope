/**
 * Each runtime's tool names, read as tool kinds: Claude's, then Codex's, then Qwen Code's.
 *
 * Claude's names are the agent SDK's own, as a `PreToolUse` input's `tool_name` carries them: the tools its
 * input schemas describe, and the gate's own families (`DEFAULT_TOOL_FAMILIES`). A tool the table does
 * not name is `other`, stated on the request rather than left out, so every gated call carries a kind.
 * Every MCP tool reaches the model as `mcp__{server}__{tool}` and is `mcp` by that prefix.
 */
import type { ShellDialect, ToolKind } from './decision.js';

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

/** The grammar each Claude shell tool runs its command in: `Bash` a POSIX shell, `PowerShell` PowerShell. */
export const CLAUDE_SHELL_DIALECTS: Readonly<Record<string, ShellDialect>> = {
  Bash: 'posix',
  PowerShell: 'powershell',
};

/** The dialect of the Claude shell tool named `toolName`, or null for a tool that runs no command. */
export function claudeShellDialect(toolName: string): ShellDialect | null {
  return Object.hasOwn(CLAUDE_SHELL_DIALECTS, toolName) ? (CLAUDE_SHELL_DIALECTS[toolName] ?? null) : null;
}

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
 * The grammar Codex's `Bash` tool runs its command in on `platform`: its shell tool runs the user's
 * default shell, which on Windows is PowerShell (`pwsh`, else Windows PowerShell), and a POSIX shell
 * elsewhere. A Windows host with no PowerShell at all would run `cmd.exe`, which no word names.
 */
export function codexShellDialect(platform: string): ShellDialect {
  return platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * Qwen Code's tool names, read as tool kinds: the canonical names its `can_use_tool` request carries.
 * `run_shell_command` and `monitor` run a command; the file tools read, write or edit a path; every MCP
 * tool is `mcp__{server}__{tool}` and is `mcp` by that prefix. Every other name (`exec`, which runs
 * JavaScript whose own tool calls are each asked about, `agent`, `skill`, `todo_write`, ...) is `other`.
 */
export const QWEN_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  run_shell_command: 'shell',
  monitor: 'shell',
  read_file: 'file_read',
  glob: 'file_read',
  grep_search: 'file_read',
  list_directory: 'file_read',
  zoom_image: 'file_read',
  display_image: 'file_read',
  write_file: 'file_write',
  edit: 'file_edit',
  notebook_edit: 'file_edit',
  web_fetch: 'web',
  web_search: 'web',
};

/** The kind of the Qwen Code tool named `toolName`: its row in the table, `mcp` by prefix, else `other`. */
export function qwenToolKind(toolName: string): ToolKind {
  if (Object.hasOwn(QWEN_TOOL_KINDS, toolName)) return QWEN_TOOL_KINDS[toolName] ?? 'other';
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return 'mcp';
  return 'other';
}

/**
 * The grammar Qwen Code's shell tools run their command in, decided the way the CLI decides it from the
 * environment it was started with. On Windows: Git Bash when `MSYSTEM` names a MinGW or MSYS shell or
 * `TERM` names msys or cygwin; PowerShell when `ComSpec` names `powershell.exe` or `pwsh.exe`; `cmd.exe`
 * otherwise, `ComSpec` included when unset. Elsewhere, `bash`. Read from the same environment the CLI is
 * spawned with, so the word says what runs.
 */
export function qwenShellDialect(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): ShellDialect {
  if (platform !== 'win32') return 'posix';
  const msystem = envValue(env, 'MSYSTEM');
  const term = envValue(env, 'TERM') ?? '';
  if (
    msystem?.startsWith('MINGW') === true ||
    msystem?.startsWith('MSYS') === true ||
    term.includes('msys') ||
    term.includes('cygwin')
  ) {
    return 'posix';
  }
  const comSpec = (envValue(env, 'ComSpec') ?? 'cmd.exe').toLowerCase();
  if (comSpec.endsWith('powershell.exe') || comSpec.endsWith('pwsh.exe')) return 'powershell';
  return 'cmd';
}

/** A variable read as Windows reads it, without regard to the case of its name. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
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
