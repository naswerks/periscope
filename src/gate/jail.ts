/**
 * The path jail, and the credential denial.
 *
 * The jail bounds where an agent can write at all. It is self-contained: a call whose target
 * resolves outside the declared workspace root is refused without asking anything, so it holds
 * with the controller unreachable, unresponsive, or wrong. Reads are not jailed: an agent reads
 * whatever its OS user can read, its own tool output and installed packages included, except
 * credential material.
 *
 * The credential denial is what keeps reads open. The agent runs as the same OS user as the host,
 * so file permissions are not a boundary against it: an 0600 credential is readable by the agent
 * exactly as it is by the host. This denial is the local control, and it covers the declared read,
 * write and search tools (`Read`, `NotebookRead`, the write tools, `Grep`, `Glob` by default) and
 * shell commands naming a protected path literally or through a home-directory form (`~`, `$HOME`,
 * `${HOME}`, `$env:HOME`, `$env:USERPROFILE`, `%USERPROFILE%`), each with a named refusal and with
 * case folded. A search is refused when its root is at or beneath a protected path and also when a
 * protected path sits beneath its root, since the search would read it. What stays outside: symlink
 * indirection, and a shell command that reaches a protected path without naming it (a recursive
 * search of an ancestor, a path built at run time); those are not refused here.
 *
 * Every unknown resolves toward refusing. No path in the input: refuse. A resolver that throws:
 * refuse. Not absolute: refuse. No declared root: refuse, because a jail with no walls is not a
 * jail. A false refusal costs one human click; a false allow costs the invariant.
 */
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import { isContainedBy, isContainedByIgnoringCase, isAbsolutePath, normalizePath } from '../core/paths.js';

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
  /** The absolute root every path-taking call must resolve inside. */
  readonly workspaceRoot: string | null;
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
}

/** The tool-input fields that carry a path, in precedence order. First readable one wins. */
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

/**
 * Is this resolved path at or beneath one of the protected paths?
 *
 * The comparison is segment-wise after normalizing both sides, so a protected `C:\Users\x\.ssh` does
 * not also protect `C:\Users\x\.ssh-notes`, and the protected path itself counts as protected. Case is
 * folded: on a filesystem that ignores it, another spelling names the same file.
 */
function protectedPathCovering(resolved: string, protectedPaths: readonly string[]): string | null {
  for (const candidate of protectedPaths) {
    if (isContainedByIgnoringCase(resolved, candidate)) return candidate;
  }
  return null;
}

/** The credential refusal for a resolved path, or null when no protected path covers it. */
function credentialRefusal(resolved: string, protectedPaths: readonly string[]): Refusal | null {
  const covering = protectedPathCovering(resolved, protectedPaths);
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

  const outcome = resolveOrRefuse(candidate, options.resolve);
  if ('refusal' in outcome) return outcome.refusal;
  const { resolved } = outcome;

  const credential = credentialRefusal(resolved, options.protectedPaths);
  if (credential !== null) return credential;

  if (options.workspaceRoot === null || options.workspaceRoot.trim() === '') {
    return refusal(
      'path-escapes-root',
      'no workspace root is declared, so no path can be shown to be inside one — a jail with no walls is not a jail',
    );
  }

  const rootOutcome = resolveOrRefuse(options.workspaceRoot, options.resolve);
  if ('refusal' in rootOutcome) return rootOutcome.refusal;

  if (!isContainedBy(resolved, rootOutcome.resolved)) {
    return refusal(
      'path-escapes-root',
      `${resolved} is outside the declared workspace root ${rootOutcome.resolved}`,
    );
  }

  return null;
}

/**
 * Check a read tool call: the protected set and nothing else. A read goes anywhere the host's user can
 * read except credential material; the workspace bounds where an agent writes, not what it may look at.
 */
export function checkReadPath(candidate: string | null, options: JailOptions): Refusal | null {
  if (candidate === null) return refusal('path-input-missing', MISSING_PATH_DETAIL);
  const outcome = resolveOrRefuse(candidate, options.resolve);
  if ('refusal' in outcome) return outcome.refusal;
  return credentialRefusal(outcome.resolved, options.protectedPaths);
}

/** The characters that begin the wildcard part of a glob pattern. */
const GLOB_MAGIC = /[*?[\]{}]/;

/**
 * The directories a search reads under: its `path` (else the workspace root), and the literal head of
 * a `pattern` that names a place of its own (absolute, from the home directory, or climbing with `..`),
 * resolved against that root. A pattern with no such head names files, not a place, and adds nothing.
 */
function searchRoots(toolInput: unknown, options: JailOptions): string[] | null {
  const record =
    typeof toolInput === 'object' && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
  const named = record['path'];
  const base = typeof named === 'string' && named.trim() !== '' ? named : options.workspaceRoot;
  if (base === null || base.trim() === '') return null;

  const roots = [expandHome(base, options.home)];
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
    const outcome = resolveOrRefuse(root, options.resolve);
    if ('refusal' in outcome) return outcome.refusal;
    const { resolved } = outcome;
    const covering = credentialRefusal(resolved, options.protectedPaths);
    if (covering !== null) return covering;
    for (const candidate of options.protectedPaths) {
      if (isContainedByIgnoringCase(candidate, resolved)) {
        return refusal(
          'credential-path-denied',
          `a search under ${resolved} reads ${candidate}, which holds credential material; search a directory that does not contain it`,
        );
      }
    }
  }
  return null;
}

/**
 * The command with its home-directory forms spelled out, so a protected path written through one of
 * them is matched as if written in full: `~` at the start of a word, `$HOME`, `${HOME}`, `$env:HOME`,
 * `$env:USERPROFILE` and `%USERPROFILE%`. With no home known the text is returned as written.
 */
function expandHome(text: string, home: string | null | undefined): string {
  if (home === null || home === undefined || home.trim() === '') return text;
  return text
    .replace(/\$\{HOME\}|\$HOME\b/g, () => home)
    .replace(/\$env:(?:USERPROFILE|HOME)\b/gi, () => home)
    .replace(/%USERPROFILE%/gi, () => home)
    .replace(/(^|[\s'"=:;(|&<>])~(?=[\\/]|$|[\s'";|&)<>])/g, (_match, lead: string) => `${lead}${home}`);
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
 * forms spelled out, case-insensitively, because Windows paths reach here in both slash styles and
 * either case.
 */
export function checkShellForProtectedPaths(command: string, options: JailOptions): Refusal | null {
  const haystack = normalizePath(expandHome(command, options.home)).toLowerCase();
  for (const candidate of options.protectedPaths) {
    const outcome = resolveOrRefuse(candidate, options.resolve);
    // A protected path this host cannot resolve is still protected — fall back to its literal form
    // rather than dropping it from the set, which would silently shrink the protected surface.
    const needle = normalizePath('refusal' in outcome ? candidate : outcome.resolved).toLowerCase();
    if (needle !== '' && haystack.includes(needle)) {
      return refusal(
        'credential-path-denied',
        `the command names ${needle}, which holds credential material; the agent shares the host's OS user, so this gate is the only control over it`,
      );
    }
  }
  return null;
}
