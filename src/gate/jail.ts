/**
 * The path jail, and the credential denial.
 *
 * The jail bounds where an agent can write at all. It is self-contained: a call whose target
 * resolves outside every declared root (the workspace root and any further root the embedder names)
 * is refused without asking anything, so it holds
 * with the controller unreachable, unresponsive, or wrong. Reads are not jailed: an agent reads
 * whatever its OS user can read, its own tool output and installed packages included, except
 * credential material.
 *
 * The credential denial is what keeps reads open. The agent runs as the same OS user as the host,
 * so file permissions are not a boundary against it: an 0600 credential is readable by the agent
 * exactly as it is by the host. This denial is the local control, and it covers the declared read,
 * write and search tools (`Read`, `NotebookRead`, the write tools, `Grep`, `Glob` by default) and
 * shell commands naming a protected path literally, through a home-directory form (`~`, `$HOME`,
 * `${HOME}`, `$env:HOME`, `$env:USERPROFILE`, `${env:...}` of either, `%USERPROFILE%`), or through a
 * variable of the session's spawn environment whose value is a path (`$NAME`, `${NAME}`, `$env:NAME`,
 * `${env:NAME}`, `%NAME%`), each with a named refusal and with case folded. A search is refused when
 * its root is at or beneath a protected path and also when a protected path sits beneath its root,
 * since the search would read it. Every path a tool names is placed first where the operating system
 * puts it (`placement.ts`), and the protected set is compared with what Windows ignores folded away and,
 * for a path with a short-name segment, with the path as the file system names it. What stays outside: a
 * link, a short name with no generated shape, a share that reaches this machine by a name it was not
 * told, and a shell command that reaches a protected path without naming it (a recursive search of an
 * ancestor, a path built at run time, a variable the command or the runtime sets itself, a variable read
 * through a command or an expansion operator); those are not refused here.
 *
 * Every unknown resolves toward refusing. No path in the input: refuse. A resolver that throws:
 * refuse. Not absolute: refuse. No declared root: refuse, because a jail with no walls is not a
 * jail. A false refusal costs one human click; a false allow costs the invariant.
 */
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import { isContainedBy, isContainedByIgnoringCase, isAbsolutePath, normalizePath } from '../core/paths.js';
import { driveLetterReading, isWindowsDirectory, placePath } from './placement.js';

/**
 * Turns a path into its canonical absolute form.
 *
 * Injected rather than imported, and `core/paths.ts` says why in its own header: its resolution is
 * textual and deliberately never consults the filesystem, so a caller enforcing a real jail supplies
 * a real resolver. `host/` holds the one built on `node:path`; a test supplies one that throws, which
 * is the only way to exercise the normalization-failure path at all.
 *
 * It may throw. A throw is a refusal, never a fall-through.
 */
export type PathResolver = (candidate: string) => string;

export interface JailOptions {
  /**
   * The session's own directory: a write may land inside it, a search with no `path` reads under it,
   * and a relative path is placed against it.
   */
  readonly workspaceRoot: string | null;
  /**
   * Further absolute roots a write may land inside, beside `workspaceRoot`: the session's temp folder,
   * its own worktree of another repository. They widen where a write may land and nothing else; the
   * protected set is still checked first. A root that cannot be resolved admits nothing.
   */
  readonly writeRoots?: readonly string[];
  readonly resolve: PathResolver;
  /**
   * Absolute paths the agent may not read, write, search or name in a shell command.
   *
   * Supplied by the embedder at construction — `host/paths.ts` computes the default set. It is a
   * list rather than a predicate so an embedder can read back exactly what is protected.
   */
  readonly protectedPaths: readonly string[];
  /** The home directory a shell command's `~` and `$HOME` forms name. Absent: the forms stay as written. */
  readonly home?: string | null;
  /**
   * The names this machine answers to as a file server, beside `localhost` and the loopback addresses. A
   * share that names one of them and a drive (`\\name\C$\...`) is read as that drive's path. Absent: only
   * `localhost` and the loopback addresses are this machine.
   */
  readonly localNames?: readonly string[];
  /**
   * A path as the file system names it: each existing folder on the way by its long name. Called only for
   * a path with a segment shaped like a Windows short name (`PROGRA~1`), and the protected set is then
   * compared with the path as written and with what this returns. It may throw; a throw, or its absence,
   * leaves the path checked as written. `host/canonical-path.ts` holds the one built on the file system.
   */
  readonly realPath?: PathResolver;
  /**
   * The session's spawn environment, as far as the host knows it. Each variable whose value is one
   * absolute path is spelled out where a shell command names it, before the protected-path scan, so a
   * protected path written through a variable the host placed is matched as if written in full.
   * Absent: only the home-directory forms are.
   * @internal
   */
  readonly variables?: Readonly<Record<string, string | undefined>>;
  /**
   * The directory the call runs in. A path a tool names is placed against it the way the operating
   * system places it for a tool running there (`placement.ts`): a rooted path at its drive's root, a
   * drive-relative one beneath it. Absent or not absolute: the workspace root.
   * @internal
   */
  readonly callDirectory?: string | null;
  /**
   * Place a plain relative path under the call's directory, rather than leave it for the resolver, which
   * resolves it against this process's own. Defaults to false.
   * @internal
   */
  readonly placesRelative?: boolean;
}

/**
 * The tool-input fields that carry a path, in precedence order. `pathFromToolInput` takes the first one
 * present; the local gate checks every one present (`pathsFromToolInput`), since tools differ in which
 * one they open (Claude's `file_path`, Copilot's and pi's `path`).
 */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;

/**
 * The path this tool call is about, or null when the input carries none.
 *
 * Null is a refusable state, not a missing value — see `checkPath`. A call whose target cannot be
 * found is not a call that can be bounded, and guessing one would authorize something nobody named.
 */
export function pathFromToolInput(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null) return null;
  const record = toolInput as Record<string, unknown>;
  for (const field of PATH_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/**
 * Every path this tool call's input names in a path field, in precedence order; empty when it names none.
 * A tool opens the field its own schema reads and an input may carry the others beside it, so each one is
 * checked, and a field the tool does not read can never stand in for the one it opens.
 */
export function pathsFromToolInput(toolInput: unknown): string[] {
  if (typeof toolInput !== 'object' || toolInput === null) return [];
  const record = toolInput as Record<string, unknown>;
  const paths: string[] = [];
  for (const field of PATH_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.trim() !== '') paths.push(value);
  }
  return paths;
}

/** The command this shell call is about, or null when the input carries none. */
export function commandFromToolInput(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null) return null;
  const value = (toolInput as Record<string, unknown>)['command'];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Resolve, or say why it could not be done. Never throws — a throwing resolver becomes a refusal. */
function resolveOrRefuse(
  candidate: string,
  resolve: PathResolver,
): { resolved: string } | { refusal: Refusal } {
  let resolved: string;
  try {
    resolved = resolve(candidate);
  } catch (error) {
    return {
      refusal: refusal(
        'path-unresolvable',
        `${candidate} could not be normalized (${String(error)}), so it is not provably inside the workspace`,
      ),
    };
  }
  if (typeof resolved !== 'string' || resolved === '') {
    return { refusal: refusal('path-unresolvable', `normalizing ${candidate} produced no path at all`) };
  }
  if (!isAbsolutePath(resolved)) {
    return {
      refusal: refusal(
        'path-not-absolute',
        `${candidate} does not resolve to an absolute path (${resolved})`,
      ),
    };
  }
  return { resolved };
}

/** The directory a call's paths are placed against: the call's own when absolute, else the workspace root. */
function callDirectoryOf(options: JailOptions): string | null {
  for (const directory of [options.callDirectory, options.workspaceRoot]) {
    if (typeof directory === 'string' && directory.trim() !== '' && isAbsolutePath(directory))
      return directory;
  }
  return null;
}

/**
 * A path a tool named, placed where the operating system puts it for a tool running in the call's
 * directory and then resolved; or why neither could be done. The checks read the result, so the file
 * they judge is the file the tool opens.
 */
function placeAndResolve(
  candidate: string,
  options: JailOptions,
): { resolved: string; also: readonly string[] } | { refusal: Refusal } {
  const directory = callDirectoryOf(options);
  const placed = placePath(candidate, {
    directory,
    home: options.home,
    localNames: options.localNames,
    placesRelative: options.placesRelative ?? false,
  });
  if (typeof placed !== 'string') return { refusal: placed };
  const outcome = resolveOrRefuse(placed, options.resolve);
  if ('refusal' in outcome) return outcome;
  // Under Windows rules a rooted path whose first segment is one letter has a second reading, the drive
  // that letter names. Which of the two a tool opens is the tool's own choice, so the protected set is
  // compared with both; the write limits read the system's own, above.
  const also: string[] = [];
  const drive = directory !== null && isWindowsDirectory(directory) ? driveLetterReading(candidate) : null;
  if (drive !== null) {
    const second = resolveOrRefuse(drive, options.resolve);
    if ('resolved' in second) also.push(second.resolved);
  }
  return { resolved: outcome.resolved, also };
}

/** The credential refusal for any reading of a placed path, or null when no protected path covers one. */
function credentialRefusalOfAny(
  placed: { readonly resolved: string; readonly also: readonly string[] },
  options: JailOptions,
): Refusal | null {
  for (const reading of [placed.resolved, ...placed.also]) {
    const refused = credentialRefusal(reading, options);
    if (refused !== null) return refused;
  }
  return null;
}

/**
 * A Windows path with what Windows ignores folded away: the dots and spaces that end a segment, and a
 * stream named after a colon (`id_rsa::$DATA`, `id_rsa.`, and `id_rsa` open one file). A path that is not
 * spelled the Windows way is returned normalized and otherwise as written, since there each of those is
 * part of the name.
 */
function foldedForWindows(path: string): string {
  const normalized = normalizePath(path);
  const prefix = /^[A-Za-z]:\//.exec(normalized)?.[0] ?? (path.startsWith('\\\\') ? '//' : '');
  if (prefix === '') return normalized;
  const segments: string[] = [];
  for (const segment of normalized.slice(prefix.length).split('/')) {
    const colon = segment.indexOf(':');
    const named = (colon === -1 ? segment : segment.slice(0, colon)).replace(/[. ]+$/, '');
    if (named !== '') segments.push(named);
  }
  return prefix + segments.join('/');
}

/** A segment shaped like a short name Windows generates: `PROGRA~1`, `CREDEN~1.JSO`. */
const SHORT_NAME_SEGMENT = /(^|[\\/])[^\\/]*~\d+(\.[^\\/.]{0,3})?(?=[\\/]|$)/;

/**
 * The spellings of a path the protected set is compared with: the path as written, with what Windows
 * ignores folded away, and, where a segment has the shape of a short name and the file system can be
 * asked, what the file system says the path names. A short name is never refused for its shape: it is
 * expanded, and where it cannot be the path is compared as written.
 */
function comparedSpellings(path: string, options: JailOptions): string[] {
  const spellings = [foldedForWindows(path)];
  if (options.realPath === undefined || !SHORT_NAME_SEGMENT.test(path)) return spellings;
  try {
    const real = options.realPath(path);
    if (typeof real === 'string' && real !== '') spellings.push(foldedForWindows(real));
  } catch {
    // Not expandable: the path is compared as written.
  }
  return spellings;
}

/** Whether `inner` is `outer` or beneath it, in any spelling the protected set is compared with. */
function withinProtection(inner: string, outer: string, options: JailOptions): boolean {
  const outers = comparedSpellings(outer, options);
  return comparedSpellings(inner, options).some((one) =>
    outers.some((other) => isContainedByIgnoringCase(one, other)),
  );
}

/**
 * Is this resolved path at or beneath one of the protected paths?
 *
 * The comparison is segment-wise after normalizing both sides, so a protected `C:\Users\x\.ssh` does
 * not also protect `C:\Users\x\.ssh-notes`, and the protected path itself counts as protected. Case is
 * folded, and so is what Windows ignores at the end of a name: on a filesystem that ignores it, another
 * spelling names the same file.
 */
function protectedPathCovering(resolved: string, options: JailOptions): string | null {
  for (const candidate of options.protectedPaths) {
    if (withinProtection(resolved, candidate, options)) return candidate;
  }
  return null;
}

/** The credential refusal for a resolved path, or null when no protected path covers it. */
function credentialRefusal(resolved: string, options: JailOptions): Refusal | null {
  const covering = protectedPathCovering(resolved, options);
  if (covering === null) return null;
  return refusal(
    'credential-path-denied',
    `${resolved} is at or beneath ${covering}, which holds credential material; the agent shares the host's OS user, so this gate is the only control over it`,
  );
}

const MISSING_PATH_DETAIL =
  'this tool takes a path and the input carries none, so there is nothing to bound — refused rather than guessed';

/**
 * Check a path-taking tool call against the jail and the protected set.
 *
 * The credential check runs first and applies whatever the workspace root is: a token cache that
 * happens to sit inside the workspace is still a token cache. Order matters for the message the
 * reader gets, not for whether the call is refused — both answers block.
 */
export function checkPath(candidate: string | null, options: JailOptions): Refusal | null {
  if (candidate === null) return refusal('path-input-missing', MISSING_PATH_DETAIL);

  const outcome = placeAndResolve(candidate, options);
  if ('refusal' in outcome) return outcome.refusal;
  const { resolved } = outcome;

  const credential = credentialRefusalOfAny(outcome, options);
  if (credential !== null) return credential;

  const declared = options.workspaceRoot !== null && options.workspaceRoot.trim() !== '';
  const further = furtherRoots(options);
  if (!declared && further.length === 0) {
    return refusal(
      'path-escapes-root',
      'no workspace root is declared, so no path can be shown to be inside one — a jail with no walls is not a jail',
    );
  }

  const roots: string[] = [];
  if (declared) {
    const rootOutcome = resolveOrRefuse(options.workspaceRoot, options.resolve);
    if ('refusal' in rootOutcome) return rootOutcome.refusal;
    roots.push(rootOutcome.resolved);
  }
  roots.push(...further);

  if (roots.some((root) => isContainedBy(resolved, root))) return null;
  // One root keeps the sentence a reader has always been given; several are each named, so an agent that
  // reached for the wrong tree reads where it may write.
  return refusal(
    'path-escapes-root',
    declared && roots.length === 1
      ? `${resolved} is outside the declared workspace root ${roots[0] as string}`
      : `${resolved} is outside every root a write may land in: ${roots.join(', ')}`,
  );
}

/** The further roots, resolved. One that is blank or cannot be resolved is no root and admits nothing. */
function furtherRoots(options: JailOptions): string[] {
  const resolved: string[] = [];
  for (const root of options.writeRoots ?? []) {
    if (root.trim() === '') continue;
    const outcome = resolveOrRefuse(root, options.resolve);
    if ('resolved' in outcome) resolved.push(outcome.resolved);
  }
  return resolved;
}

/**
 * Check a read tool call: the protected set and nothing else. A read goes anywhere the host's user can
 * read except credential material; the workspace bounds where an agent writes, not what it may look at.
 */
export function checkReadPath(candidate: string | null, options: JailOptions): Refusal | null {
  if (candidate === null) return refusal('path-input-missing', MISSING_PATH_DETAIL);
  const outcome = placeAndResolve(candidate, options);
  if ('refusal' in outcome) return outcome.refusal;
  return credentialRefusalOfAny(outcome, options);
}

/** The characters that begin the wildcard part of a glob pattern. */
const GLOB_MAGIC = /[*?[\]{}]/;

/**
 * The directories a search reads under: its `path` (else the workspace root), its `paths` (one string, or
 * each entry of a list), and the literal head of a `pattern` that names a place of its own (absolute, from the home
 * directory, or climbing with `..`), resolved against that root. A pattern with no such head names files,
 * not a place, and adds nothing.
 */
function searchRoots(toolInput: unknown, options: JailOptions): string[] | null {
  const record =
    typeof toolInput === 'object' && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
  const named = record['path'];
  const base = typeof named === 'string' && named.trim() !== '' ? named : options.workspaceRoot;
  if (base === null || base.trim() === '') return null;

  const roots = [expandHome(base, options.home)];
  // A search tool that names several roots (`paths`: Copilot's `grep` and `glob`) reads under each of
  // them, so each is a root beside `path`. It takes one string as well as a list, and one string is a
  // list of one. Any other shape names no root this host can read, and the tool rejects it itself.
  const listed = record['paths'];
  for (const entry of typeof listed === 'string' ? [listed] : Array.isArray(listed) ? listed : []) {
    if (typeof entry === 'string' && entry.trim() !== '') roots.push(expandHome(entry, options.home));
  }
  const pattern = record['pattern'];
  if (typeof pattern === 'string') {
    const expanded = normalizePath(expandHome(pattern, options.home));
    const head: string[] = [];
    for (const segment of expanded.split('/')) {
      if (GLOB_MAGIC.test(segment)) break;
      head.push(segment);
    }
    const literal = head.join('/');
    const placed = isAbsolutePath(literal) || /(^|\/)\.\.(\/|$)/.test(literal);
    if (literal !== '' && placed) roots.push(isAbsolutePath(literal) ? literal : `${roots[0]}/${literal}`);
  }
  return roots;
}

/**
 * Check a search tool call (`Grep`, `Glob` by default) against the protected set.
 *
 * A search reads every file under its root, so it is refused when a root is at or beneath a protected
 * path and also when a protected path sits beneath a root: searching the home directory reads the token
 * cache as surely as reading the cache does. With no root to judge (no `path` and no workspace root)
 * there is no local opinion and the call is asked about like any other.
 */
export function checkSearch(toolInput: unknown, options: JailOptions): Refusal | null {
  const roots = searchRoots(toolInput, options);
  if (roots === null) return null;
  for (const root of roots) {
    const outcome = placeAndResolve(root, options);
    if ('refusal' in outcome) return outcome.refusal;
    const covering = credentialRefusalOfAny(outcome, options);
    if (covering !== null) return covering;
    for (const resolved of [outcome.resolved, ...outcome.also]) {
      for (const candidate of options.protectedPaths) {
        if (withinProtection(candidate, resolved, options)) {
          return refusal(
            'credential-path-denied',
            `a search under ${resolved} reads ${candidate}, which holds credential material; search a directory that does not contain it`,
          );
        }
      }
    }
  }
  return null;
}

/**
 * The command with its home-directory forms spelled out, so a protected path written through one of
 * them is matched as if written in full: `~` at the start of a word, `$HOME`, `${HOME}`, `$env:HOME`,
 * `$env:USERPROFILE`, their braced `${env:...}` spellings and `%USERPROFILE%`. With no home known the
 * text is returned as written.
 */
function expandHome(text: string, home: string | null | undefined): string {
  if (home === null || home === undefined || home.trim() === '') return text;
  return text
    .replace(/\$\{HOME\}|\$HOME\b/g, () => home)
    .replace(/\$env:(?:USERPROFILE|HOME)\b|\$\{env:(?:USERPROFILE|HOME)\}/gi, () => home)
    .replace(/%USERPROFILE%/gi, () => home)
    .replace(/(^|[\s'"=:;(|&<>])~(?=[\\/]|$|[\s'";|&)<>])/g, (_match, lead: string) => `${lead}${home}`);
}

/**
 * Is this value one path a command could name by its variable? An absolute path, and not a list: `PATH`
 * and its kin join several places with `;` (or `:` after a POSIX root), and spelling one out would set
 * every directory on it against the protected set, which none of them is by being listed.
 */
function isOnePath(value: string): boolean {
  if (!isAbsolutePath(value)) return false;
  return !value.includes(';') && !value.slice(2).includes(':');
}

/**
 * Every spelling of a variable this scan reads, in one pass so a value spelled out is never read again:
 * PowerShell's `${env:NAME}` and `$env:NAME`, `cmd`'s `%NAME%`, and the POSIX `${NAME}` and `$NAME`.
 */
const VARIABLE_FORMS =
  /\$\{env:([^}]+)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)|%([^%\s]+)%|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gi;

/**
 * The command with each variable of `variables` whose value is one path spelled out, so a protected path
 * written through it is matched as if written in full. Names are read as each shell reads them:
 * PowerShell and `cmd` without regard to case, a POSIX shell exactly. A name that is not one of these
 * paths stays as written.
 */
function expandVariables(
  text: string,
  variables: Readonly<Record<string, string | undefined>> | undefined,
): string {
  if (variables === undefined) return text;
  const exact = new Map<string, string>();
  const folded = new Map<string, string>();
  for (const [name, value] of Object.entries(variables)) {
    if (typeof value !== 'string' || !isOnePath(value)) continue;
    exact.set(name, value);
    if (!folded.has(name.toLowerCase())) folded.set(name.toLowerCase(), value);
  }
  if (exact.size === 0) return text;
  return text.replace(
    VARIABLE_FORMS,
    (
      match: string,
      braced: string | undefined,
      bare: string | undefined,
      cmd: string | undefined,
      posixBraced: string | undefined,
      posix: string | undefined,
    ) => {
      const foldedName = braced ?? bare ?? cmd;
      if (foldedName !== undefined) return folded.get(foldedName.toLowerCase()) ?? match;
      const exactName = posixBraced ?? posix;
      return exactName === undefined ? match : (exact.get(exactName) ?? match);
    },
  );
}

/**
 * What ends a word of a shell line outside a quote: a blank, and the separators, operators and expansion
 * marks of the shells a session runs (POSIX, PowerShell, `cmd.exe`). Ending a word early only splits a
 * path in two, which the line's literal reading still sees whole.
 */
const WORD_END = /[\s;&|<>()`,{}$^]/;

/**
 * The line's words, each with `.` and `..` resolved within it alone, joined by a blank. A quoted span is
 * part of its word, quotes dropped, so a quoted path with a blank in it stays one word.
 */
function wordsResolved(text: string): string {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  const end = (): void => {
    if (word !== '') words.push(normalizePath(word));
    word = '';
  };
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (WORD_END.test(char)) {
      end();
    } else {
      word += char;
    }
  }
  end();
  return words.join(' ');
}

/**
 * Check a shell command for credential material named anywhere in it.
 *
 * This one scans the whole command, and that is deliberately unlike the rest of the local gate.
 * Everything else here parses precisely so that a mention of a boundary word does not refuse a
 * benign call, so a reader who notices this function will reasonably wonder whether it was missed.
 *
 * It was not. The two cases are not the same shape. A boundary verb is only dangerous at a command
 * position, so parsing tells you whether it is one. A credential path is dangerous wherever it
 * appears: as an argument to any reader, inside a redirect, in a substitution, or handed to a program
 * this parser has no model of. There is no position at which naming the host's token cache in a shell
 * command is routine, so there is nothing to gain by locating it precisely — and every parser gap
 * would become a way to read the credential. The cost of the choice is bounded and stated: a command
 * that merely mentions the path — an `echo` of a diagnostic, say — is refused, which costs one human
 * click. The alternative costs the credential.
 *
 * So do not narrow this to match the rest of the file. Both credential defences — this one and
 * `checkPath`'s — are covered by tests that fail when either is removed. Reproduce that before
 * changing anything here: make `protectedPathCovering` return null and make this function's
 * haystack empty, then run the suite. The over-refusal is the price of those tests, not an
 * oversight in them.
 *
 * The comparison is on the resolved protected paths and on the command text with its home-directory
 * forms and its path variables spelled out, case-insensitively, because Windows paths reach here in both
 * slash styles and either case. The text is read three ways, and a protected path found in any of them
 * refuses: as written, with no `.` or `..` resolved, so a path written literally is found wherever it
 * stands and no `..` anywhere on the line can hide it; word by word, each word's `.` and `..` resolved
 * within it alone, so a path that climbs to a protected one is found and a `..` in another word cannot
 * reach it; and as one path, resolved whole, as this scan has always read it, so no line refused that
 * way is let through. A word that names a protected path and climbs out of it (`.ssh/../x`) names the
 * path literally, and refuses.
 */
export function checkShellForProtectedPaths(command: string, options: JailOptions): Refusal | null {
  const expanded = expandVariables(expandHome(command, options.home), options.variables);
  const readings = [
    expanded.replace(/\\/g, '/').toLowerCase(),
    wordsResolved(expanded).toLowerCase(),
    normalizePath(expanded).toLowerCase(),
  ];
  for (const candidate of options.protectedPaths) {
    const outcome = resolveOrRefuse(candidate, options.resolve);
    // A protected path this host cannot resolve is still protected — fall back to its literal form
    // rather than dropping it from the set, which would silently shrink the protected surface.
    const needle = normalizePath('refusal' in outcome ? candidate : outcome.resolved).toLowerCase();
    if (needle === '') continue;
    // A protected path on a drive is also written from the root by a POSIX shell on Windows: Git Bash's
    // `/c/Users/x`, Cygwin's `/cygdrive/c/Users/x`, and `/mnt/c/Users/x` under the Linux subsystem.
    const drive = /^([a-z]):\/(.*)$/.exec(needle);
    const spellings =
      drive === null
        ? [needle]
        : [
            needle,
            ...['/', '/cygdrive/', '/mnt/'].map((root) => `${root}${drive[1] ?? ''}/${drive[2] ?? ''}`),
          ];
    if (spellings.some((spelling) => readings.some((reading) => reading.includes(spelling)))) {
      return refusal(
        'credential-path-denied',
        `the command names ${needle}, which holds credential material; the agent shares the host's OS user, so this gate is the only control over it`,
      );
    }
  }
  return null;
}
