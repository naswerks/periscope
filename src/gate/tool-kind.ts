/**
 * Each runtime's tool names, read as tool kinds: Claude's, then Codex's, then Qwen Code's, then pi's, then
 * Copilot's.
 *
 * Claude's names are the agent SDK's own, as a `PreToolUse` input's `tool_name` carries them: the tools its
 * input schemas describe, and the gate's own families (`DEFAULT_TOOL_FAMILIES`). A tool the table does
 * not name is `other`, stated on the request rather than left out, so every gated call carries a kind.
 * Every MCP tool reaches the model as `mcp__{server}__{tool}` and is `mcp` by that prefix.
 */
import type { ShellDialect, ToolKind } from './decision.js';

/**
 * The kind of each Claude tool this table names. Every other name is `other`. `Monitor` runs the shell
 * command its input names and reports each line it prints, so it is a shell tool; a `Monitor` call that
 * watches a socket instead names no command and is `other` (`watchesSocketOnly`).
 */
export const CLAUDE_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  Bash: 'shell',
  PowerShell: 'shell',
  Monitor: 'shell',
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

/**
 * The grammar each Claude shell tool runs its command in: `Bash` a POSIX shell, `PowerShell` PowerShell,
 * and `Monitor` the grammar `Bash` runs. Which shell `Monitor` runs on a Windows host whose shell tool is
 * PowerShell is not measured.
 */
export const CLAUDE_SHELL_DIALECTS: Readonly<Record<string, ShellDialect>> = {
  Bash: 'posix',
  PowerShell: 'powershell',
  Monitor: 'posix',
};

/**
 * Whether a tool's input watches a socket and runs no command: it names a `ws` object and no `command`.
 * A `Monitor` call takes one or the other, never both.
 */
export function watchesSocketOnly(toolInput: unknown): boolean {
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return false;
  const input = toolInput as Record<string, unknown>;
  const ws = input['ws'];
  return input['command'] === undefined && typeof ws === 'object' && ws !== null && !Array.isArray(ws);
}

/**
 * The dialect of the Claude shell tool named `toolName`, or null for a tool that runs no command. A call
 * whose input (`toolInput`, where it is known) watches a socket runs none.
 */
export function claudeShellDialect(toolName: string, toolInput?: unknown): ShellDialect | null {
  if (toolInput !== undefined && watchesSocketOnly(toolInput)) return null;
  return Object.hasOwn(CLAUDE_SHELL_DIALECTS, toolName) ? (CLAUDE_SHELL_DIALECTS[toolName] ?? null) : null;
}

/** The prefix every MCP tool name carries. */
const MCP_TOOL_PREFIX = 'mcp__';

/**
 * The kind of the Claude tool named `toolName`: its row in the table, `mcp` by prefix, else `other`. A
 * shell tool's call whose input (`toolInput`, where it is known) watches a socket runs no command, and
 * is `other`.
 */
export function claudeToolKind(toolName: string, toolInput?: unknown): ToolKind {
  if (Object.hasOwn(CLAUDE_TOOL_KINDS, toolName)) {
    const kind = CLAUDE_TOOL_KINDS[toolName] ?? 'other';
    return kind === 'shell' && toolInput !== undefined && watchesSocketOnly(toolInput) ? 'other' : kind;
  }
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

/**
 * pi's tool names, read as tool kinds: the built-in tools its `tool_call` event names. `bash` and
 * `powershell` run a command; `read`, `grep`, `find` and `ls` read under a path; `write` writes one and
 * `edit` edits one. Every MCP tool is `mcp__{server}__{tool}` and is `mcp` by that prefix. Every other
 * name (a tool an extension registers) is `other`.
 */
export const PI_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  bash: 'shell',
  powershell: 'shell',
  read: 'file_read',
  grep: 'file_read',
  find: 'file_read',
  ls: 'file_read',
  write: 'file_write',
  edit: 'file_edit',
};

/** The kind of the pi tool named `toolName`: its row in the table, `mcp` by prefix, else `other`. */
export function piToolKind(toolName: string): ToolKind {
  if (Object.hasOwn(PI_TOOL_KINDS, toolName)) return PI_TOOL_KINDS[toolName] ?? 'other';
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return 'mcp';
  return 'other';
}

/**
 * The grammar each pi shell tool runs its command in. `bash` runs a bash, which on Windows is Git Bash
 * (pi looks for it where Git for Windows installs it before anything on the path), and `powershell` runs
 * PowerShell. Neither depends on the environment, so the tool's name decides it.
 */
export const PI_SHELL_DIALECTS: Readonly<Record<string, ShellDialect>> = {
  bash: 'posix',
  powershell: 'powershell',
};

/** The dialect of the pi shell tool named `toolName`, or null for a tool that runs no command. */
export function piShellDialect(toolName: string): ShellDialect | null {
  return Object.hasOwn(PI_SHELL_DIALECTS, toolName) ? (PI_SHELL_DIALECTS[toolName] ?? null) : null;
}

/**
 * Copilot's built-in tool names, read as tool kinds: the names its pre-tool hook carries. `powershell` runs a
 * command on Windows and `bash` elsewhere; `view` reads a path; `create` writes one; `edit`,
 * `str_replace_editor` and `apply_patch` change one; `grep` and `glob` read under theirs; `web_fetch` fetches
 * a URL. Every MCP tool reaches this host as `mcp__{server}__{tool}` (`copilot-gate.ts` spells it) and is
 * `mcp` by that prefix. Every other built-in is `other`, and is named in `COPILOT_OTHER_TOOLS`.
 */
export const COPILOT_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  powershell: 'shell',
  bash: 'shell',
  view: 'file_read',
  grep: 'file_read',
  glob: 'file_read',
  create: 'file_write',
  edit: 'file_edit',
  str_replace_editor: 'file_edit',
  apply_patch: 'file_edit',
  web_fetch: 'web',
};

/**
 * The built-ins of the pinned Copilot runtime that are `other` by name: each one a tool the runtime offers
 * that runs no command, reads or writes no path by itself and fetches no URL. Together with
 * `COPILOT_TOOL_KINDS` and `COPILOT_EXCLUDED_TOOLS` it names every built-in the runtime lists on Windows and
 * on a POSIX host (`copilot-local.test.ts` holds the three to the runtime's own list).
 */
export const COPILOT_OTHER_TOOLS: readonly string[] = [
  'read_powershell',
  'stop_powershell',
  'list_powershell',
  'read_bash',
  'stop_bash',
  'list_bash',
  'task',
  'skill',
  'ask_user',
  'task_complete',
  'exit_plan_mode',
  'update_todo',
  'context_board',
  'read_inbox',
  'send_inbox',
  'list_agents',
  'read_agent',
  'write_agent',
  'sql',
  'generic_tool_search',
  'tool_search_tool',
  'semantic_code_search',
  'fetch_copilot_cli_documentation',
  'dynamic_workflows_manage',
  'run_dynamic_workflow',
];

/**
 * The built-ins this host turns off in every Copilot session: each is left out of the session's tools and
 * the open is refused if the runtime offers it anyway (`copilot-process.ts`).
 *
 * - `write_powershell` and `write_bash` type input into a shell already running, so a call carries text a
 *   running program reads, never a command any reading of a command can see. A controller cannot govern a
 *   command it cannot see as one.
 * - `manage_schedule` schedules a prompt to run later, outside the queue a controller sends prompts into.
 *
 * Lifting one is a later release's change to this list, once a decision request can say what such a call
 * runs.
 */
export const COPILOT_EXCLUDED_TOOLS: readonly string[] = [
  'write_powershell',
  'write_bash',
  'manage_schedule',
];

/** The kind of the Copilot tool named `toolName`: its row in the table, `mcp` by prefix, else `other`. */
export function copilotToolKind(toolName: string): ToolKind {
  if (Object.hasOwn(COPILOT_TOOL_KINDS, toolName)) return COPILOT_TOOL_KINDS[toolName] ?? 'other';
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return 'mcp';
  return 'other';
}

/** The grammar each Copilot shell tool runs its command in: `powershell` PowerShell, `bash` a POSIX shell. */
export const COPILOT_SHELL_DIALECTS: Readonly<Record<string, ShellDialect>> = {
  powershell: 'powershell',
  bash: 'posix',
};

/** The dialect of the Copilot shell tool named `toolName`, or null for a tool that runs no command. */
export function copilotShellDialect(toolName: string): ShellDialect | null {
  return Object.hasOwn(COPILOT_SHELL_DIALECTS, toolName) ? (COPILOT_SHELL_DIALECTS[toolName] ?? null) : null;
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
