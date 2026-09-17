/**
 * The path jail, and the credential denial.
 *
 * The jail bounds where an agent can write at all. It is self-contained: a call whose target
 * resolves outside the declared workspace root is refused without asking anything, so it holds
 * with the controller unreachable, unresponsive, or wrong.
 *
 * The credential denial covers what a default-open read policy misses. Default-open reads are
 * correct for source files and wrong for the host's own token cache. The agent runs as the same
 * OS user as the host, so file permissions are not a boundary against it: an 0600 credential is
 * readable by the agent exactly as it is by the host. This denial is the local control, and it is
 * scoped, not total: it refuses reads through the declared read tools (`Read`, `NotebookRead` by
 * default), writes, and shell commands naming a protected path literally — each by absolute path,
 * with a named refusal. Built-in tools outside the declared families (`Grep`, `Glob`), shell
 * expansion forms (`~`, `$HOME`, `%USERPROFILE%`) and symlink indirection get no opinion here —
 * those calls escalate to the controller, and with it unreachable they are refused as outages
 * rather than by name. Widening the local denial to cover them is a known open question,
 * deliberately not taken in passing: every widening is an over-refusal risk that deserves its own
 * decision.
 *
 * Every unknown resolves toward refusing. No path in the input: refuse. A resolver that throws:
 * refuse. Not absolute: refuse. No declared root: refuse, because a jail with no walls is not a
 * jail. A false refusal costs one human click; a false allow costs the invariant.
 */
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import { isContainedBy, isAbsolutePath, normalizePath } from '../core/paths.js';

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
   * Absolute paths the agent may not read, write or name in a shell command.
   *
   * Supplied by the embedder at construction — `host/paths.ts` computes the default set. It is a
   * list rather than a predicate so an embedder can read back exactly what is protected.
   */
  readonly protectedPaths: readonly string[];
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
 * `isContainedBy` compares segment-wise after normalizing both sides, so a protected `C:\Users\x\.claude`
 * does not also protect `C:\Users\x\.claude-notes`, and the protected path itself counts as protected.
 */
function protectedPathCovering(resolved: string, protectedPaths: readonly string[]): string | null {
  for (const candidate of protectedPaths) {
    if (isContainedBy(resolved, candidate)) return candidate;
  }
  return null;
}

/**
 * Check a path-taking tool call against the jail and the protected set.
 *
 * The credential check runs first and applies whatever the workspace root is: a token cache that
 * happens to sit inside the workspace is still a token cache. Order matters for the message the
 * reader gets, not for whether the call is refused — both answers block.
 */
export function checkPath(candidate: string | null, options: JailOptions): Refusal | null {
  if (candidate === null) {
    return refusal(
      'path-input-missing',
      'this tool takes a path and the input carries none, so there is nothing to bound — refused rather than guessed',
    );
  }

  const outcome = resolveOrRefuse(candidate, options.resolve);
  if ('refusal' in outcome) return outcome.refusal;
  const { resolved } = outcome;

  const covering = protectedPathCovering(resolved, options.protectedPaths);
  if (covering !== null) {
    return refusal(
      'credential-path-denied',
      `${resolved} is at or beneath ${covering}, which holds credential material; the agent shares the host's OS user, so this gate is the only control over it`,
    );
  }

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
 * The comparison is on the resolved protected paths and on the raw command text, case-insensitively,
 * because Windows paths reach here in both slash styles and either case.
 */
export function checkShellForProtectedPaths(command: string, options: JailOptions): Refusal | null {
  const haystack = normalizePath(command).toLowerCase();
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
