/**
 * The repository read: a controller listing one directory or reading one text file of the
 * operator's checkout through this host, jailed to the repository root.
 *
 * The posture is the discovery door's, over a different root. The transcripts door reads the agent
 * CLI's own directory; this reads the repository the host provisions workspaces from, so a
 * controller can show a checkout's shape and the text of a file in it without a session, a clone or
 * a bulk lane. Read-only is a property here too: the filesystem surface is `createReadStream`,
 * `readdir`, `stat` and `realpath`, and `src/pins/transcript-readonly.test.ts` holds this module's
 * closure to that allowlist beside the transcripts door.
 *
 * The jail, for every controller-supplied path:
 *   1. a NUL byte in the text is refused before anything is resolved (it would end the path early
 *      for the filesystem and late for the check);
 *   2. resolve-then-containment, lexically: the path is joined under the root, resolved by the real
 *      resolver, and must stay inside the root, so `..` and an absolute path cannot leave it;
 *   3. resolve-then-containment, physically: the real path (links followed) must stay inside the
 *      root's real path, so a link planted inside the checkout cannot point the read outside it;
 *   4. the protected set: a path at or beneath one of the host's protected paths (the credential
 *      directories the gate keeps from the agent) is refused whatever the root is, on the lexical
 *      resolution and again on the real path.
 * A jail violation refuses `repository-path-escape`; a protected path refuses
 * `credential-path-denied`. A path that is inside the root but is not what was asked for (a file
 * where a directory was asked, nothing at all) refuses `repository-read-failed`; absence is a
 * refusal here, not a value, because the ask named one thing and it is not there.
 *
 * Bounded twice: a listing carries at most `MAX_REPOSITORY_ENTRIES` names and says when it stopped;
 * a read carries at most `maxBytes` (itself capped at `MAX_REPOSITORY_READ_BYTES`), cut on a UTF-8
 * boundary, and says the file's whole size. A file with a NUL byte in its first
 * `BINARY_PROBE_BYTES` is refused as binary: the answer is a string and a string cannot carry it.
 */
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';

import type { RepositoryEntry } from '../control/frames.js';
import { MAX_REPOSITORY_ENTRIES, MAX_REPOSITORY_READ_BYTES } from '../control/frames.js';
import { isContainedBy, normalizePath } from '../core/paths.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { nodePathResolver } from './paths.js';

/** How many bytes of a file's head are checked for a NUL byte before it is served as text. */
export const BINARY_PROBE_BYTES = 8 * 1024;

/** One directory's children, names only, sorted; `truncated` when the cap stopped the listing. */
export interface RepositoryListing {
  readonly entries: readonly RepositoryEntry[];
  readonly truncated: boolean;
}

/** One file's head as text, with the whole size so a caller can see what `truncated` left behind. */
export interface RepositoryText {
  readonly text: string;
  readonly sizeBytes: number;
  readonly truncated: boolean;
}

/**
 * The lexical half of the jail: join `relative` under `root`, resolve, and refuse anything that
 * resolves outside. `''` is the root itself. Pure over the resolver; the physical half needs the
 * filesystem and lives in the two readers.
 */
export function resolveRepositoryPath(root: string, relative: string): Result<string> {
  if (relative.includes('\0')) {
    return refuse('repository-path-escape', 'the path holds a NUL byte, refused before it is resolved');
  }
  const resolvedRoot = normalizePath(nodePathResolver(root));
  const candidate = normalizePath(nodePathResolver(`${resolvedRoot}/${relative}`));
  if (!isContainedBy(candidate, resolvedRoot)) {
    return refuse(
      'repository-path-escape',
      'the path resolves outside the repository root, refused by the containment layer',
    );
  }
  return ok(candidate);
}

/** The physical half: the real path of both, links followed, and the same containment rule. */
async function containedRealPath(root: string, candidate: string): Promise<Result<string>> {
  let realRoot: string;
  try {
    realRoot = normalizePath(await realpath(root));
  } catch (error) {
    return refuse('repository-read-failed', `the repository root could not be resolved: ${describe(error)}`);
  }
  let real: string;
  try {
    real = normalizePath(await realpath(candidate));
  } catch (error) {
    return refuse('repository-read-failed', `nothing is at that path: ${describe(error)}`);
  }
  if (!isContainedBy(real, realRoot)) {
    return refuse(
      'repository-path-escape',
      'the path leads outside the repository root through a link, refused by the containment layer',
    );
  }
  return ok(real);
}

/**
 * The protected set applies to this door as it applies to the agent: a path at or beneath one of
 * the host's protected paths is refused whatever the repository root is, checked on the lexical
 * resolution and again on the real path, so neither a root pointed at the credential directory nor
 * a link into it serves credential material to a controller.
 */
function protectedPathRefusal(resolved: string, protectedPaths: readonly string[]): Result<null> {
  for (const candidate of protectedPaths) {
    if (isContainedBy(resolved, candidate)) {
      return refuse(
        'credential-path-denied',
        `the path is at or beneath ${candidate}, which holds credential material; the repository doors honour the same protected set as the gate`,
      );
    }
  }
  return ok(null);
}

/** The jail and the protected set together; the real path of the target on success. */
async function admittedRealPath(
  root: string,
  relative: string,
  protectedPaths: readonly string[],
): Promise<Result<string>> {
  const resolved = resolveRepositoryPath(root, relative);
  if (!resolved.ok) return resolved;
  const lexical = protectedPathRefusal(resolved.value, protectedPaths);
  if (!lexical.ok) return lexical;
  const real = await containedRealPath(root, resolved.value);
  if (!real.ok) return real;
  // The real path is compared against the protected set's real paths, not its spellings: a
  // component `realpath` rewrites (a short name, a linked directory) would otherwise make the
  // resolved target and the protected directory disagree about a prefix that names one place. A
  // protected path that does not exist is compared as spelled; absence protects nothing.
  const realProtected = await Promise.all(
    protectedPaths.map(async (candidate) => {
      try {
        return normalizePath(await realpath(candidate));
      } catch {
        return candidate;
      }
    }),
  );
  const physical = protectedPathRefusal(real.value, realProtected);
  if (!physical.ok) return physical;
  return real;
}

/**
 * List one directory under the root: files and directories by name, sorted, at most `cap` of
 * them. Anything that is neither (a link, a socket) is left out rather than followed.
 */
export async function listRepositoryDirectory(
  root: string,
  relative: string,
  cap = MAX_REPOSITORY_ENTRIES,
  protectedPaths: readonly string[] = [],
): Promise<Result<RepositoryListing>> {
  const real = await admittedRealPath(root, relative, protectedPaths);
  if (!real.ok) return real;

  let children;
  try {
    children = await readdir(real.value, { withFileTypes: true });
  } catch (error) {
    return refuse(
      'repository-read-failed',
      `the path could not be listed as a directory: ${describe(error)}`,
    );
  }
  const named = children
    .filter((child) => child.isDirectory() || child.isFile())
    .map((child) => ({ name: child.name, directory: child.isDirectory() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const limit = Math.max(1, cap);

  const entries: RepositoryEntry[] = [];
  for (const child of named.slice(0, limit)) {
    try {
      const stats = await stat(`${real.value}/${child.name}`);
      entries.push({
        name: child.name,
        directory: child.directory,
        sizeBytes: child.directory ? 0 : stats.size,
        mtimeMs: Math.floor(stats.mtimeMs),
      });
    } catch {
      // Removed between readdir and stat: the listing describes what exists, not what did.
    }
  }
  return ok({ entries, truncated: named.length > limit });
}

/**
 * Read the head of one text file under the root: at most `maxBytes` (capped at the wire's bound),
 * cut back to a UTF-8 boundary so the text never ends mid-character. Binary is refused by the NUL
 * probe; a directory or an absent path is refused by name.
 */
export async function readRepositoryFile(
  root: string,
  relative: string,
  maxBytes = MAX_REPOSITORY_READ_BYTES,
  protectedPaths: readonly string[] = [],
): Promise<Result<RepositoryText>> {
  const real = await admittedRealPath(root, relative, protectedPaths);
  if (!real.ok) return real;

  let stats;
  try {
    stats = await stat(real.value);
  } catch (error) {
    return refuse('repository-read-failed', `the file could not be read: ${describe(error)}`);
  }
  if (!stats.isFile()) return refuse('repository-read-failed', 'the path is not a file');

  const wanted = Math.min(Math.max(1, Math.floor(maxBytes)), MAX_REPOSITORY_READ_BYTES);
  const probe = Math.max(wanted, BINARY_PROBE_BYTES);
  const chunks: Buffer[] = [];
  try {
    if (stats.size > 0) {
      for await (const chunk of createReadStream(real.value, { start: 0, end: probe - 1 })) {
        chunks.push(chunk as Buffer);
      }
    }
  } catch (error) {
    return refuse('repository-read-failed', `the file could not be read: ${describe(error)}`);
  }
  const head = Buffer.concat(chunks);
  if (head.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return refuse(
      'repository-read-failed',
      'the file holds a NUL byte in its head and is not served as text',
    );
  }

  let cut = Math.min(head.length, wanted);
  // A continuation byte at the cut means a character straddles it: step back to its first byte.
  while (cut > 0 && cut < head.length && (head[cut]! & 0xc0) === 0x80) cut -= 1;
  const text = head.subarray(0, cut).toString('utf8');
  return ok({ text, sizeBytes: stats.size, truncated: cut < stats.size });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
