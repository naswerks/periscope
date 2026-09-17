/**
 * Path handling, written without `node:path` because this module is import-free by contract.
 *
 * Absolute always, on the wire and at every boundary — a relative path means "relative to a cwd the
 * other end cannot see", which is a bug waiting for a second machine.
 */
import type { Result } from './result.js';
import { ok, refuse } from './result.js';

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** POSIX `/x`, Windows `C:\x`, or a UNC `\\server\share`. */
export function isAbsolutePath(candidate: string): boolean {
  if (candidate.startsWith('/')) return true;
  if (candidate.startsWith('\\\\')) return true;
  return WINDOWS_DRIVE.test(candidate);
}

/**
 * Separators to `/`, redundant separators collapsed, `.` dropped and `..` resolved textually.
 *
 * Textual resolution deliberately does NOT consult the filesystem, so it cannot follow a symlink.
 * A caller enforcing a real jail must canonicalize through the filesystem first — see
 * `host/`, which is the only module that can.
 */
export function normalizePath(input: string): string {
  const isUnc = input.startsWith('\\\\');
  const unified = input.replace(/\\/g, '/');
  const hasDrive = WINDOWS_DRIVE.test(input);
  const rooted = unified.startsWith('/') || hasDrive || isUnc;

  const segments: string[] = [];
  let prefix = '';

  let body = unified;
  if (hasDrive) {
    prefix = `${unified.slice(0, 2)}/`;
    body = unified.slice(3);
  } else if (isUnc) {
    prefix = '//';
    body = unified.slice(2);
  } else if (rooted) {
    prefix = '/';
    body = unified.slice(1);
  }

  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else if (!rooted) {
        segments.push('..');
      }
      // Rooted paths cannot climb above their root; `/..` is `/`.
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join('/');
  if (prefix === '') return joined === '' ? '.' : joined;
  return prefix + joined;
}

/** Normalizes, and refuses anything not absolute. The shape every boundary should take. */
export function requireAbsolute(candidate: string): Result<string> {
  if (!isAbsolutePath(candidate)) {
    return refuse('path-not-absolute', `not an absolute path: ${candidate}`);
  }
  return ok(normalizePath(candidate));
}

/**
 * Is `candidate` at or beneath `root`? Both are normalized first; the comparison is
 * segment-wise, so `/a/bc` is NOT inside `/a/b`.
 */
export function isContainedBy(candidate: string, root: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedCandidate = normalizePath(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  const boundary = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedCandidate.startsWith(boundary);
}
