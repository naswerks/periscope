/**
 * The host's own gate — a refusal that does not depend on the controller behaving.
 *
 * This is what makes the package installable by a stranger. A host that executes whatever a
 * remote server sends is, mechanically, a code-execution service on somebody else's machine. An
 * optional callback defaulting to escalate-everything is the opposite of an answer to that. This
 * module refuses locally, offline, by rules that ship with the package — so the property can be
 * demonstrated by somebody who does not trust the controller at all, which is the only audience the
 * claim matters to.
 *
 * The vocabulary is owned locally, not received. A policy the controller can change remotely is a
 * policy that depends on the controller behaving, which defeats the module. At the exact moment this
 * is load-bearing — the controller unreachable — a cached remote policy is the only thing acting, so
 * receiving-and-caching is local ownership plus a remote mutation path, for no benefit when it
 * counts.
 *
 * Owned is not hardcoded, and that is what makes it survivable. The embedder chooses the tool
 * families and the protected-path list at construction, in-process, before any session exists. The
 * wire carries no policy in either direction.
 *
 * It adds refusals and never removes one. A tool this module has no opinion about returns null and
 * the surrounding gate goes on to ask whoever it was going to ask. Two mechanisms, one invariant —
 * the same posture the outer gate takes toward the operator's own settings.
 */
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import type { DecisionRequest } from './decision.js';
import type { JailOptions, PathResolver } from './jail.js';
import {
  checkPath,
  checkReadPath,
  checkSearch,
  checkShellForProtectedPaths,
  commandFromToolInput,
  pathFromToolInput,
} from './jail.js';
import { classifyShellCommand } from './shell.js';
import { parseCommand, readCmdCommand } from './command.js';
import { patchPaths } from './patch.js';
import { isAbsolutePath } from '../core/paths.js';

/**
 * Decides one tool call, locally. Null means no local opinion, never "allowed".
 *
 * Synchronous and total by contract: this runs before anything is asked of anyone, and an
 * asynchronous local policy would be a second place a decision can hang.
 */
export type LocalGate = (request: DecisionRequest) => Refusal | null;

/** The tool families this module recognises. Data, so an embedder can state its own. */
export interface ToolFamilies {
  /** Tools whose input names a path they will write. */
  readonly write: readonly string[];
  /** Tools whose input names a path they will read. Present because of the credential denial. */
  readonly read: readonly string[];
  /** Tools that run a command. */
  readonly shell: readonly string[];
  /**
   * Tools that read every file under a directory (`path`, else the workspace root). Absent: the
   * default family.
   */
  readonly search?: readonly string[];
  /**
   * Tools that apply a patch, whose files are named on the patch's own header lines (`command`) or
   * listed as `changes[].path`. Every file is a write. Absent: the default family.
   */
  readonly patch?: readonly string[];
}

/**
 * The SDK's own tool names.
 *
 * Reads go anywhere except credential material: reading source, packages or the agent's own output is
 * benign, reading the host's token cache is not, and the two arrive through the same tool, so the
 * protected set names what is off-limits wherever it sits. Writes are jailed to the workspace.
 */
export const DEFAULT_TOOL_FAMILIES: ToolFamilies = {
  write: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  read: ['Read', 'NotebookRead'],
  shell: ['Bash', 'PowerShell'],
  search: ['Grep', 'Glob'],
};

/**
 * The names Codex's hook gives its tools: `Bash` runs a command, `view_image` reads a path, and
 * `apply_patch` writes every file its patch names. Every other Codex tool has no local family and is
 * asked about like any call this gate has no opinion on.
 */
export const CODEX_TOOL_FAMILIES: ToolFamilies = {
  write: [],
  read: ['view_image'],
  shell: ['Bash'],
  search: [],
  patch: ['apply_patch'],
};

/**
 * The names Qwen Code gives its tools: `run_shell_command` and `monitor` run a command, the file tools
 * read or write the path they name (`file_path`, `notebook_path` or `path`), and `glob` and
 * `grep_search` search under theirs. Every other Qwen tool has no local family and is asked about like
 * any call this gate has no opinion on.
 */
export const QWEN_TOOL_FAMILIES: ToolFamilies = {
  write: ['write_file', 'edit', 'notebook_edit'],
  read: ['read_file', 'zoom_image', 'display_image', 'list_directory'],
  shell: ['run_shell_command', 'monitor'],
  search: ['glob', 'grep_search'],
};

/**
 * The names pi gives its built-in tools: `bash` and `powershell` run a command, `read` reads the path it
 * names, `write` and `edit` write theirs, and `grep`, `find` and `ls` read under theirs, the session's
 * directory when they name none. Every other pi tool has no local family and is asked about like any
 * call this gate has no opinion on.
 */
export const PI_TOOL_FAMILIES: ToolFamilies = {
  write: ['write', 'edit'],
  read: ['read'],
  shell: ['bash', 'powershell'],
  search: ['grep', 'find', 'ls'],
};

export interface LocalGateOptions {
  /** The absolute root every path-taking call must resolve inside. */
  readonly workspaceRoot: string | null;
  /** The real resolver. `host/paths.ts` holds the one built on `node:path`. */
  readonly resolve: PathResolver;
  /** Absolute paths holding credential material. `host/paths.ts` computes the default set. */
  readonly protectedPaths: readonly string[];
  /** The home directory a shell command's `~` and `$HOME` forms name. */
  readonly home?: string | null;
  /** Defaults to `DEFAULT_TOOL_FAMILIES`. */
  readonly toolFamilies?: ToolFamilies;
  /**
   * Read a shell command in the grammar its request names (`shellDialect`). Defaults to false, and
   * then every command is read as a POSIX shell reads it. When set, a `powershell` or `cmd` command is
   * read both ways and refused when either reading refuses: a command read in the wrong grammar is read
   * as different text from the one that runs, and reading both never scans less than the POSIX reading
   * alone. Set for a runtime whose shell tool runs a non-POSIX shell under a tool name that does not say
   * so.
   */
  readonly readsShellDialect?: boolean;
  /**
   * Check the directory a shell call runs in (its input's `directory`) against the protected set, as a
   * read of that directory. Defaults to false. Set for a runtime whose shell tool takes the directory
   * beside the command: a relative path in the command is a path under it.
   */
  readonly checksShellDirectory?: boolean;
  /**
   * Resolve a relative path a read tool names against the call's own working directory (`cwd`), else
   * the workspace root, rather than this process's. Defaults to false. Set for a runtime whose file
   * tools take paths relative to where the call runs; a patch's paths are always resolved this way.
   */
  readonly resolvesAgainstCallCwd?: boolean;
  /**
   * Resolve a relative path a write tool names against the call's own working directory (`cwd`), else
   * the workspace root, rather than this process's. Defaults to false. Set for a runtime whose file tools
   * write paths relative to where the session runs; the path is then jailed where it lands.
   */
  readonly resolvesWritesAgainstCallCwd?: boolean;
}

/**
 * Build the local gate.
 *
 * The returned function is pure, synchronous and total — so it composes into whatever assembles a
 * session later, and needs no composition root to exist first.
 */
export function localGate(options: LocalGateOptions): LocalGate {
  const families = options.toolFamilies ?? DEFAULT_TOOL_FAMILIES;
  const jail: JailOptions = {
    workspaceRoot: options.workspaceRoot,
    resolve: options.resolve,
    protectedPaths: options.protectedPaths,
    home: options.home ?? null,
  };

  const writeTools = new Set(families.write);
  const readTools = new Set(families.read);
  const shellTools = new Set(families.shell);
  const searchTools = new Set(families.search ?? DEFAULT_TOOL_FAMILIES.search);
  const patchTools = new Set(families.patch ?? []);
  const readsShellDialect = options.readsShellDialect ?? false;
  const checksShellDirectory = options.checksShellDirectory ?? false;
  const resolvesAgainstCallCwd = options.resolvesAgainstCallCwd ?? false;
  const resolvesWritesAgainstCallCwd = options.resolvesWritesAgainstCallCwd ?? false;

  return (request: DecisionRequest): Refusal | null => {
    if (shellTools.has(request.toolName)) {
      const command = commandFromToolInput(request.toolInput);
      if (command === null) {
        return refusal(
          'shell-command-missing',
          'this tool runs a command and the input carries none, so there is nothing to classify — refused rather than guessed',
        );
      }
      if (checksShellDirectory) {
        const directory = shellDirectoryOf(request.toolInput);
        const inside = directory === null ? null : checkReadPath(directory, jail);
        if (inside !== null) return inside;
      }
      // One parse, both consumers. The credential check runs first because a command naming the
      // token cache is the more serious of the two answers and should be the one the reader gets.
      const parsed = parseCommand(command);
      const posix = checkShellForProtectedPaths(command, jail) ?? classifyShellCommand(command, parsed);
      if (!readsShellDialect) return posix;
      if (request.shellDialect === 'powershell') {
        return strongerRefusal(posix, classifyShellCommand(command, parseCommand(command, 'powershell')));
      }
      if (request.shellDialect === 'cmd') {
        // `cmd.exe` reads carets and quotes its own way, so a protected path can hide from the raw text.
        const read = readCmdCommand(command);
        return strongerRefusal(
          posix,
          checkShellForProtectedPaths(read, jail) ?? classifyShellCommand(read, parseCommand(command, 'cmd')),
        );
      }
      return posix;
    }

    if (patchTools.has(request.toolName)) {
      return checkPatch(request, jail);
    }

    if (writeTools.has(request.toolName)) {
      const named = pathFromToolInput(request.toolInput);
      if (!resolvesWritesAgainstCallCwd || named === null) return checkPath(named, jail);
      const placed = againstCallCwd(named, request.cwd, jail.workspaceRoot);
      return typeof placed === 'string' ? checkPath(placed, jail) : placed;
    }

    if (readTools.has(request.toolName)) {
      const named = pathFromToolInput(request.toolInput);
      if (!resolvesAgainstCallCwd || named === null) return checkReadPath(named, jail);
      const placed = againstCallCwd(named, request.cwd, jail.workspaceRoot);
      return typeof placed === 'string' ? checkReadPath(placed, jail) : placed;
    }

    if (searchTools.has(request.toolName)) {
      if (!resolvesAgainstCallCwd) return checkSearch(request.toolInput, jail);
      const placed = placedSearchInput(request, jail.workspaceRoot);
      return 'refused' in placed ? placed.refused : checkSearch(placed.input, jail);
    }

    // No opinion. The surrounding gate asks whoever it was going to ask.
    return null;
  };
}

/**
 * Of two readings' answers, the one that blocks soonest: a local refusal before a boundary shape, which
 * is escalated rather than refused here, and either before no opinion.
 */
function strongerRefusal(first: Refusal | null, second: Refusal | null): Refusal | null {
  if (first !== null && first.reason !== 'shell-boundary-command') return first;
  if (second !== null && second.reason !== 'shell-boundary-command') return second;
  return first ?? second;
}

/**
 * `path` placed under the call's working directory when it is relative: the call's `cwd`, else the
 * workspace root. A relative path with neither to stand on is refused, because resolving it against this
 * process's own directory would check a file the call never named.
 */
function againstCallCwd(path: string, callCwd: string, workspaceRoot: string | null): string | Refusal {
  if (isAbsolutePath(path)) return path;
  const base = isAbsolutePath(callCwd)
    ? callCwd
    : workspaceRoot !== null && isAbsolutePath(workspaceRoot)
      ? workspaceRoot
      : null;
  if (base === null) {
    return refusal(
      'path-not-absolute',
      `${path} is relative and the call states no absolute working directory to resolve it against`,
    );
  }
  return `${base}/${path}`;
}

/**
 * Every file a patch call names goes through the jail and the protected set, as a write. The files come
 * from the patch's own header lines (`command`) or from `changes[].path` and `changes[].movePath`. A
 * patch that names no file this host can read is refused: there is nothing to bound.
 */
function checkPatch(request: DecisionRequest, jail: JailOptions): Refusal | null {
  const paths = patchInputPaths(request.toolInput);
  if (paths === null) {
    return refusal(
      'path-input-missing',
      'this patch names no file on a header this host can read, so there is nothing to bound — refused rather than guessed',
    );
  }
  for (const path of paths) {
    const placed = againstCallCwd(path, request.cwd, jail.workspaceRoot);
    const refused = typeof placed === 'string' ? checkPath(placed, jail) : placed;
    if (refused !== null) return refused;
  }
  return null;
}

/** The files a patch call's input names, or null when it names none. */
export function patchInputPaths(toolInput: unknown): string[] | null {
  if (typeof toolInput !== 'object' || toolInput === null) return null;
  const record = toolInput as Record<string, unknown>;
  const command = record['command'];
  if (typeof command === 'string') return patchPaths(command);
  const changes = record['changes'];
  if (!Array.isArray(changes)) return null;
  const paths: string[] = [];
  for (const change of changes as unknown[]) {
    if (typeof change !== 'object' || change === null) return null;
    const entry = change as Record<string, unknown>;
    if (typeof entry['path'] !== 'string' || entry['path'].trim() === '') return null;
    paths.push(entry['path']);
    if (typeof entry['movePath'] === 'string' && entry['movePath'].trim() !== '')
      paths.push(entry['movePath']);
  }
  return paths.length === 0 ? null : paths;
}

/** The directory a shell call names to run in (its input's `directory`), or null when it names none. */
export function shellDirectoryOf(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null) return null;
  const directory = (toolInput as Record<string, unknown>)['directory'];
  return typeof directory === 'string' && directory.trim() !== '' ? directory : null;
}

/**
 * A search call's input with a relative `path` placed under where the call runs, as a runtime that
 * resolves it there reads it; an absolute path, a home-relative one or none is left as it is.
 */
function placedSearchInput(
  request: DecisionRequest,
  workspaceRoot: string | null,
): { readonly input: unknown } | { readonly refused: Refusal } {
  const input = request.toolInput;
  if (typeof input !== 'object' || input === null) return { input };
  const path = (input as Record<string, unknown>)['path'];
  if (typeof path !== 'string' || path.trim() === '' || path.startsWith('~') || isAbsolutePath(path)) {
    return { input };
  }
  const placed = againstCallCwd(path, request.cwd, workspaceRoot);
  return typeof placed === 'string' ? { input: { ...input, path: placed } } : { refused: placed };
}
