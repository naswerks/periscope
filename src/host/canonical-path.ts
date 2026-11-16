/**
 * A path as the file system names it, for a read-back that holds a runtime's own report of a place to a root
 * this host was handed in another spelling of the same place (a Windows short name such as `RUNNER~1`, a
 * link, a junction).
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isContainedByIgnoringCase, normalizePath } from '../core/paths.js';

/**
 * `path` as the file system names it: its deepest existing ancestor resolved (a link followed, a Windows
 * short name spelled out), and the rest of the path after it as written.
 */
export function canonicalPath(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const resolved = realpathSync.native(current);
      return rest.length === 0 ? resolved : join(resolved, ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
  return path;
}

/** Whether `inner` is `outer` or beneath it: as written, or else as the file system names both. */
export function withinCanonically(inner: string, outer: string): boolean {
  if (isContainedByIgnoringCase(normalizePath(inner), normalizePath(outer))) return true;
  return isContainedByIgnoringCase(normalizePath(canonicalPath(inner)), normalizePath(canonicalPath(outer)));
}
