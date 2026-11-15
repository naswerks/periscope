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
import { isSocketWatch } from './tool-kind.js';
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
  /**
   * Tools that hand local files to a service, or save what a service returns, by the paths their input
   * names: `file_path`, each of `file_paths`, each source in `files`, `root` and `out_dir`. Each path is
   * held to the protected set and to nothing else, as a read is: such a tool may read and save anywhere
   * but in credential material. A call that names no path has no local opinion. Absent: none.
   */
  readonly publish?: readonly string[];
}

/**
 * The SDK's own tool names.
 *
 * Reads go anywhere except credential material: reading source, packages or the agent's own output is
 * benign, reading the host's token cache is not, and the two arrive through the same tool, so the
 * protected set names what is off-limits wherever it sits. Writes are jailed to the workspace and the
 * further roots the embedder names.
 */
export const DEFAULT_TOOL_FAMILIES: ToolFamilies = {
  write: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  read: ['Read', 'NotebookRead'],
  // `Monitor` runs the command its input names, as `Bash` does; a `Monitor` call that watches a socket
  // instead names no command and is not a shell call (`isSocketWatch`).
  shell: ['Bash', 'PowerShell', 'Monitor'],
  search: ['Grep', 'Glob'],
  // `Artifact` publishes the local files its input names and saves the files it fetches.
  publish: ['Artifact'],
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

/**
 * The names Copilot gives its built-in tools: `powershell` and `bash` run a command; `view` reads the path it
 * names; `create`, `edit` and `str_replace_editor` write theirs (every command of the last, its `view`
 * included, is held as a write: stricter, and the model has `view` for a read); `grep` and `glob` read under
 * the paths they name (`paths`, one string or a list); `apply_patch` writes every file its patch names. Every other Copilot
 * tool has no local family and is asked about like any call this gate has no opinion on.
 */
export const COPILOT_TOOL_FAMILIES: ToolFamilies = {
  write: ['create', 'edit', 'str_replace_editor'],
  read: ['view'],
  shell: ['powershell', 'bash'],
  search: ['grep', 'glob'],
  patch: ['apply_patch'],
};

/**
 * The actions opencode's permission requests name: `shell` runs a command; `edit` writes the path it names
 * (the tools that ask it are named beside it, so a request by either spelling is jailed as a write);
 * `read` reads the path it names, and `external_directory` reads where a call outside the session's location
 * goes (the directory it names); `glob` and `grep` read under theirs. The opencode gate checks each path a
 * request names (`opencode-gate.ts`), so one request about several files is checked file by file. Every
 * other opencode action has no local family and is asked about like any call this gate has no opinion on.
 */
export const OPENCODE_TOOL_FAMILIES: ToolFamilies = {
  write: ['edit', 'write', 'patch', 'opencode_worktree_remove'],
  read: ['read', 'external_directory'],
  shell: ['shell'],
  search: ['glob', 'grep'],
};

export interface LocalGateOptions {
  /** The session's own directory: writes may land inside it, and a relative path is placed against it. */
  readonly workspaceRoot: string | null;
  /**
   * Further absolute roots a write may land inside: the session's temp folder, its own worktree of another
   * repository. Reads, searches and relative paths are unchanged by them. Absent: the workspace root alone.
   */
  readonly writeRoots?: readonly string[];
  /** The real resolver. `host/paths.ts` holds the one built on `node:path`. */
  readonly resolve: PathResolver;
  /** Absolute paths holding credential material. `host/paths.ts` computes the default set. */
  readonly protectedPaths: readonly string[];
  /** The home directory a shell command's `~` and `$HOME` forms name. */
  readonly home?: string | null;
  /**
   * The names this machine answers to as a file server, beside `localhost` and the loopback addresses: a
   * share that names one of them and a drive (`\\name\C$\...`) is checked as that drive's path.
   * `host/paths.ts` reads the machine's own (`machineNames`). Absent: `localhost` and the loopback
   * addresses alone.
   */
  readonly localNames?: readonly string[];
  /**
   * A path as the file system names it. Called only for a path with a segment shaped like a Windows short
   * name (`PROGRA~1`); the protected set is then compared with the path as written and with what this
   * returns. `host/canonical-path.ts` holds the one built on the file system. Absent: such a path is
   * compared as written.
   */
  readonly realPath?: PathResolver;
  /**
   * The session's spawn environment as far as the host knows it, read at every decision: a runtime's own
   * variables exist only once its process starts, after this gate is built. Each variable whose value is
   * one absolute path is spelled out where a shell command names it, before the protected-path scan.
   * Absent: only the home-directory forms are.
   * @internal
   */
  readonly spawnEnv?: () => Readonly<Record<string, string | undefined>>;
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
   * beside the command: a relative path in the command is a path under it. A relative directory is placed
   * under the session's.
   */
  readonly checksShellDirectory?: boolean;
  /**
   * Check the working directory a shell call runs in (the request's `cwd`) against the protected set, as a
   * read of that directory. Defaults to false. Set for a runtime that reports a shell call's own working
   * directory as the call's `cwd` and keeps it out of the input: a relative path in the command is a path
   * under it. A relative `cwd` is placed under the session's directory, and an absent one is read as the
   * session's directory.
   */
  readonly checksShellCwd?: boolean;
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
    ...(options.writeRoots === undefined ? {} : { writeRoots: options.writeRoots }),
    resolve: options.resolve,
    protectedPaths: options.protectedPaths,
    home: options.home ?? null,
    ...(options.localNames === undefined ? {} : { localNames: options.localNames }),
    ...(options.realPath === undefined ? {} : { realPath: options.realPath }),
  };

  const writeTools = new Set(families.write);
  const readTools = new Set(families.read);
  const shellTools = new Set(families.shell);
  const searchTools = new Set(families.search ?? DEFAULT_TOOL_FAMILIES.search);
  const patchTools = new Set(families.patch ?? []);
  const publishTools = new Set(families.publish ?? []);
  const readsShellDialect = options.readsShellDialect ?? false;
  const checksShellDirectory = options.checksShellDirectory ?? false;
  const checksShellCwd = options.checksShellCwd ?? false;
  const resolvesAgainstCallCwd = options.resolvesAgainstCallCwd ?? false;
  const resolvesWritesAgainstCallCwd = options.resolvesWritesAgainstCallCwd ?? false;
  const spawnEnv = options.spawnEnv;
  // Each call's paths are placed against the directory that call runs in.
  const at = (request: DecisionRequest, placesRelative: boolean): JailOptions => ({
    ...jail,
    callDirectory: request.cwd,
    placesRelative,
  });
  // The directory a command runs in, held to the protected set as a read of it. An absolute one is
  // checked as it is. A relative one is a directory under the session's, and one the call does not state
  // is the session's own; neither is refused for being unstated, only for where it lands.
  const runsIn = (directory: string): Refusal | null => {
    if (isAbsolutePath(directory)) return checkReadPath(directory, jail);
    const session = jail.workspaceRoot;
    if (session === null || !isAbsolutePath(session)) return null;
    const refused = checkReadPath(directory.trim() === '' ? session : directory, {
      ...jail,
      callDirectory: session,
      placesRelative: true,
    });
    return refused?.reason === 'credential-path-denied' ? refused : null;
  };

  return (request: DecisionRequest): Refusal | null => {
    // A `Monitor` call that watches a socket and names no command runs nothing a shell reads, so it is no
    // shell call. Any other shell tool's call with no command is refused below, whatever else it carries.
    if (shellTools.has(request.toolName) && !isSocketWatch(request.toolName, request.toolInput)) {
      // The shell scan reads the session's variables as they stand now, not as they stood at construction.
      const shellJail: JailOptions = spawnEnv === undefined ? jail : { ...jail, variables: spawnEnv() };
      const command = commandFromToolInput(request.toolInput);
      if (command === null) {
        return refusal(
          'shell-command-missing',
          'this tool runs a command and the input carries none, so there is nothing to classify — refused rather than guessed',
        );
      }
      if (checksShellDirectory) {
        const directory = shellDirectoryOf(request.toolInput);
        const inside = directory === null ? null : runsIn(directory);
        if (inside !== null) return inside;
      }
      if (checksShellCwd) {
        const inside = runsIn(request.cwd);
        if (inside !== null) return inside;
      }
      // One parse, both consumers. The credential check runs first because a command naming the
      // token cache is the more serious of the two answers and should be the one the reader gets.
      const parsed = parseCommand(command);
      const posix = checkShellForProtectedPaths(command, shellJail) ?? classifyShellCommand(command, parsed);
      if (!readsShellDialect) return posix;
      if (request.shellDialect === 'powershell') {
        return strongerRefusal(posix, classifyShellCommand(command, parseCommand(command, 'powershell')));
      }
      if (request.shellDialect === 'cmd') {
        // `cmd.exe` reads carets and quotes its own way, so a protected path can hide from the raw text.
        const read = readCmdCommand(command);
        return strongerRefusal(
          posix,
          checkShellForProtectedPaths(read, shellJail) ??
            classifyShellCommand(read, parseCommand(command, 'cmd')),
        );
      }
      return posix;
    }

    if (patchTools.has(request.toolName)) {
      // A patch's paths are always placed where the call runs.
      return checkPatch(request, at(request, true));
    }

    if (writeTools.has(request.toolName)) {
      return checkPath(pathFromToolInput(request.toolInput), at(request, resolvesWritesAgainstCallCwd));
    }

    if (readTools.has(request.toolName)) {
      return checkReadPath(pathFromToolInput(request.toolInput), at(request, resolvesAgainstCallCwd));
    }

    if (searchTools.has(request.toolName)) {
      return checkSearch(request.toolInput, at(request, resolvesAgainstCallCwd));
    }

    if (publishTools.has(request.toolName)) {
      // Each path is placed where the call runs, and only the protected set can refuse it.
      const placed = at(request, true);
      for (const path of publishedPaths(request.toolInput)) {
        const refused = checkReadPath(path, placed);
        if (refused?.reason === 'credential-path-denied') return refused;
      }
      return null;
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
 * Every file a patch call names goes through the jail and the protected set, as a write, each placed
 * where the call runs (`jail` carries the call's directory). The files come from the patch's own header
 * lines (`command`) or from `changes[].path` and `changes[].movePath`. A patch that names no file this
 * host can read is refused: there is nothing to bound.
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
    const refused = checkPath(path, jail);
    if (refused !== null) return refused;
  }
  return null;
}

/**
 * The local paths a publishing call's input names: the page or file it sends (`file_path`), each further
 * file (`file_paths`), each source in `files` (a list of `{ path }`, or a map whose values are a path or
 * `{ from }`), the directory relative sources are read from (`root`) and the directory a fetched file is
 * saved into (`out_dir`). A relative source is read under `root` where the input names one. A source that
 * is another published file, and a member of any other shape, names no local path.
 */
export function publishedPaths(toolInput: unknown): string[] {
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return [];
  const input = toolInput as Record<string, unknown>;
  const named = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
  const paths: string[] = [];
  for (const key of ['file_path', 'out_dir', 'root']) if (named(input[key])) paths.push(input[key]);
  const further = input['file_paths'];
  if (Array.isArray(further)) for (const one of further as unknown[]) if (named(one)) paths.push(one);
  const root = named(input['root']) ? input['root'] : null;
  const underRoot = (source: string): string =>
    root === null || isAbsolutePath(source) || /^[~\\/]|^[A-Za-z]:/.test(source)
      ? source
      : `${root.replace(/[\\/]+$/, '')}/${source}`;
  const files = input['files'];
  const sources: unknown[] = Array.isArray(files)
    ? (files as unknown[]).map((entry) =>
        typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['path'] : entry,
      )
    : typeof files === 'object' && files !== null
      ? Object.values(files as Record<string, unknown>).map((entry) =>
          typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['from'] : entry,
        )
      : [];
  for (const source of sources) if (named(source)) paths.push(underRoot(source));
  return paths;
}

/** The files a patch call's input names, or null when it names none. */
export function patchInputPaths(toolInput: unknown): string[] | null {
  // A patch tool that takes its patch as the whole input (Copilot's `apply_patch`) names its files on the
  // patch's own header lines, as a `command` does.
  if (typeof toolInput === 'string') return patchPaths(toolInput);
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
