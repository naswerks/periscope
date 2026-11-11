/**
 * Where a session may write beside its own directory: the temp folder its environment names, held behind a
 * fence that keeps any such root from covering what the jail exists to keep writes out of.
 *
 * Apart from `paths.ts` because it reads the filesystem's real paths, and the read doors import
 * `paths.ts`, whose closure is pinned to the read doors' own filesystem surface.
 */
import { realpathSync } from 'node:fs';

import { isContainedByIgnoringCase, normalizePath } from '../core/paths.js';
import { nodePathResolver } from './paths.js';

/**
 * The temp folder a session's spawn environment names, as written there: `TEMP`, then `TMP`, on Windows;
 * `TMPDIR` elsewhere, else `/tmp`, where a POSIX tool writes when `TMPDIR` is unset. Null on Windows when
 * neither is named: the system's own fallback there is the user's profile, which holds the agent's
 * configuration, so none is guessed. Read from the session's environment, never this process's, because a
 * session may be handed another.
 */
export function sessionTempFolder(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const named = (name: string): string | null => {
    const value = env[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
  if (platform === 'win32') return named('TEMP') ?? named('TMP');
  return named('TMPDIR') ?? '/tmp';
}

/** What a further write root may never cover, and what it may never sit inside. */
export interface WriteRootFence {
  /**
   * Paths a root may not be at or above: the home directory, every protected path, each workspace root and
   * each served repository's checkout. A root above one would admit writes into it.
   */
  readonly notAbove: readonly string[];
  /**
   * Paths a root may not be at or beneath: each workspace root and each served repository's checkout. A
   * root inside one would admit writes into another session's tree or the operator's checkout.
   */
  readonly notBeneath: readonly string[];
}

/**
 * Whether `candidate`, a resolved absolute path, may stand as a write root beside a session's own
 * directory. Case is folded, so another spelling of a fenced path is still that path: a root the fence
 * refuses is simply not a root, and the session writes where it otherwise may.
 */
export function mayBeWriteRoot(candidate: string, fence: WriteRootFence): boolean {
  const root = normalizePath(candidate);
  if (root === '') return false;
  for (const kept of fence.notAbove) {
    if (kept.trim() !== '' && isContainedByIgnoringCase(normalizePath(kept), root)) return false;
  }
  for (const enclosing of fence.notBeneath) {
    if (enclosing.trim() !== '' && isContainedByIgnoringCase(root, normalizePath(enclosing))) return false;
  }
  return true;
}

/**
 * The write roots a session's temp folder gives it: the folder as its environment names it, and its real
 * path beside when that is spelled otherwise (a Windows short name, a link), each resolved. Empty when the
 * environment names none, or when either spelling is one the fence refuses: a temp folder that is the home
 * directory, holds the agent's configuration, or sits inside a workspace or a checkout is no root at all.
 */
export function sessionTempRoots(
  env: Readonly<Record<string, string | undefined>>,
  fence: WriteRootFence,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly resolve?: (candidate: string) => string;
    readonly realPath?: (candidate: string) => string | null;
  } = {},
): string[] {
  const named = sessionTempFolder(env, options.platform);
  if (named === null) return [];
  const resolve = options.resolve ?? nodePathResolver;
  let spelled: string;
  try {
    spelled = resolve(named);
  } catch {
    return [];
  }
  const real = (options.realPath ?? realPathOrNull)(spelled);
  const roots = [spelled];
  if (real !== null && normalizePath(real) !== normalizePath(spelled)) roots.push(real);
  return roots.every((root) => mayBeWriteRoot(root, fence)) ? roots : [];
}

/** The real path of a directory, with Windows short names expanded; null when it cannot be read. */
function realPathOrNull(candidate: string): string | null {
  try {
    return realpathSync.native(candidate);
  } catch {
    return null;
  }
}
