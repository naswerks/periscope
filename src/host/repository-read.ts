/**
 * The repository read: a controller listing one directory or reading one text file of the
 * operator's checkout through this host, jailed to the repository root. The workspace read is the
 * same door over a workspace's directory: one jail, with its own two refusal reasons, and pages.
 *
 * It reads the repository the host provisions workspaces from, so a controller can show a
 * checkout's shape and the text of a file in it without a session, a clone or a bulk lane.
 * Read-only is a property, not a promise: the filesystem surface is `createReadStream`, `readdir`,
 * `stat` and `realpath`, and `src/pins/read-door-readonly.test.ts` holds this module's closure to
 * that allowlist.
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
 *      resolution and again on the real path;
 *   5. the agent's transcript folders: a path at or beneath one (`agentTranscriptPaths`) is refused
 *      the same way, whatever the root is, and a listing leaves such a folder out.
 * A jail violation refuses `repository-path-escape`; a protected path refuses
 * `credential-path-denied`; a transcript folder refuses `transcripts-not-served`. A path that is
 * inside the root but is not what was asked for (a file where a directory was asked, nothing at all)
 * refuses `repository-read-failed`; absence is a refusal here, not a value, because the ask named one
 * thing and it is not there.
 *
 * Bounded twice: a listing carries at most `MAX_REPOSITORY_ENTRIES` names and says when it stopped;
 * a read carries one page, at most `maxBytes` (itself capped at `MAX_REPOSITORY_READ_BYTES`), cut on
 * a UTF-8 boundary, and says the file's whole size. Offset 0 is the head of a file of any size; the
 * pages after it reach no further than `MAX_REPOSITORY_FILE_BYTES`. Both doors read a page the same
 * way (`readTextPage`). A file with a NUL byte in its first `BINARY_PROBE_BYTES` is refused as
 * binary: the answer is a string and a string cannot carry it.
 */
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';

import type { RepositoryEntry } from '../control/frames.js';
import {
  MAX_REPOSITORY_ENTRIES,
  MAX_REPOSITORY_FILE_BYTES,
  MAX_REPOSITORY_READ_BYTES,
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_READ_BYTES,
} from '../control/frames.js';
import { isContainedBy, isContainedByIgnoringCase, normalizePath } from '../core/paths.js';
import type { RefusalReason } from '../core/refusal.js';
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

/** One page of a file as text, with the whole size so a caller can see what `truncated` left behind. */
export interface RepositoryText {
  readonly text: string;
  readonly sizeBytes: number;
  /** True when bytes of the file remain past this page. */
  readonly truncated: boolean;
  /**
   * Where the next page starts, or null when this page reached the end of the file or
   * `MAX_REPOSITORY_FILE_BYTES`.
   */
  readonly nextOffset: number | null;
}

/** One page of a workspace file as text: the file's whole size, and where the next page starts. */
export interface WorkspaceText {
  readonly text: string;
  readonly sizeBytes: number;
  /** Null when this page reached the end of the file. */
  readonly nextOffset: number | null;
}

/** What a jailed read reads under: the root's name for details, and the two reasons it refuses with. */
interface ReadDoor {
  readonly root: string;
  readonly escape: RefusalReason;
  readonly failed: RefusalReason;
}

const REPOSITORY_DOOR: ReadDoor = {
  root: 'the repository root',
  escape: 'repository-path-escape',
  failed: 'repository-read-failed',
};

const WORKSPACE_DOOR: ReadDoor = {
  root: "the workspace's directory",
  escape: 'workspace-path-escape',
  failed: 'workspace-read-failed',
};

/**
 * The lexical half of the jail: join `relative` under `root`, resolve, and refuse anything that
 * resolves outside. `''` is the root itself. Pure over the resolver; the physical half needs the
 * filesystem and lives in the readers.
 */
export function resolveRepositoryPath(root: string, relative: string): Result<string> {
  return resolveUnder(root, relative, REPOSITORY_DOOR);
}

function resolveUnder(root: string, relative: string, door: ReadDoor): Result<string> {
  if (relative.includes('\0')) {
    return refuse(door.escape, 'the path holds a NUL byte, refused before it is resolved');
  }
  const resolvedRoot = normalizePath(nodePathResolver(root));
  const candidate = normalizePath(nodePathResolver(`${resolvedRoot}/${relative}`));
  if (!isContainedBy(candidate, resolvedRoot)) {
    return refuse(door.escape, `the path resolves outside ${door.root}, refused by the containment layer`);
  }
  return ok(candidate);
}

/** The physical half: the real path of both, links followed, and the same containment rule. */
async function containedRealPath(root: string, candidate: string, door: ReadDoor): Promise<Result<string>> {
  let realRoot: string;
  try {
    realRoot = normalizePath(await realpath(root));
  } catch (error) {
    return refuse(door.failed, `${door.root} could not be resolved: ${describe(error)}`);
  }
  let real: string;
  try {
    real = normalizePath(await realpath(candidate));
  } catch (error) {
    return refuse(door.failed, `nothing is at that path: ${describe(error)}`);
  }
  if (!isContainedBy(real, realRoot)) {
    return refuse(
      door.escape,
      `the path leads outside ${door.root} through a link, refused by the containment layer`,
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
    if (isContainedByIgnoringCase(resolved, candidate)) {
      return refuse(
        'credential-path-denied',
        `the path is at or beneath ${candidate}, which holds credential material; the read doors honour the same protected set as the gate`,
      );
    }
  }
  return ok(null);
}

/**
 * The agent's transcript folders apply to this door the way the protected set does: a path at or
 * beneath one is refused whatever the root is, on the lexical resolution and again on the real path,
 * so neither a root pointed at the agent's home (or the user's) nor a link into a transcript folder
 * serves the agent's transcript files to a controller.
 */
function transcriptPathRefusal(resolved: string, transcriptPaths: readonly string[]): Result<null> {
  for (const candidate of transcriptPaths) {
    if (isContainedByIgnoringCase(resolved, candidate)) {
      return refuse(
        'transcripts-not-served',
        `the path is at or beneath ${candidate}, where the agent keeps its transcript files; the read doors do not serve them`,
      );
    }
  }
  return ok(null);
}

/**
 * Each path as the filesystem names it, so a component `realpath` rewrites (a short name, a linked
 * directory) cannot make a target and a fenced directory disagree about a prefix that names one
 * place. A path that does not exist is kept as spelled; absence fences nothing.
 */
async function realPathsOf(paths: readonly string[]): Promise<string[]> {
  return Promise.all(
    paths.map(async (candidate) => {
      try {
        return normalizePath(await realpath(candidate));
      } catch {
        return candidate;
      }
    }),
  );
}

/** The two fences on one spelling of a path: the protected set first, then the transcript folders. */
function fencesRefusal(
  path: string,
  protectedPaths: readonly string[],
  transcriptPaths: readonly string[],
): Result<null> {
  const credential = protectedPathRefusal(path, protectedPaths);
  if (!credential.ok) return credential;
  return transcriptPathRefusal(path, transcriptPaths);
}

/** The real path is compared against each fence's real paths, not its spellings. */
async function realFencesRefusal(
  real: string,
  protectedPaths: readonly string[],
  transcriptPaths: readonly string[],
): Promise<Result<null>> {
  return fencesRefusal(real, await realPathsOf(protectedPaths), await realPathsOf(transcriptPaths));
}

/**
 * The two fences on a file that is about to leave for a controller by another door than these: the
 * bulk lane runs it on the file its resolver names, so whatever the namespace, the lane posts neither
 * credential material (`credential-path-denied`) nor the agent's transcript files
 * (`transcripts-not-served`). Checked on the lexical resolution and again on the real path, as the
 * read doors check. A path with nothing at it passes the real check: the delivery then fails by name
 * when it reads the file.
 */
export async function fencedFileRefusal(
  path: string,
  protectedPaths: readonly string[],
  transcriptPaths: readonly string[],
): Promise<Result<null>> {
  const lexical = fencesRefusal(normalizePath(nodePathResolver(path)), protectedPaths, transcriptPaths);
  if (!lexical.ok) return lexical;
  let real: string;
  try {
    real = normalizePath(await realpath(path));
  } catch {
    return ok(null);
  }
  return realFencesRefusal(real, protectedPaths, transcriptPaths);
}

/** The jail, the protected set and the transcript folders together; the real path of the target on success. */
async function admittedRealPath(
  root: string,
  relative: string,
  protectedPaths: readonly string[],
  door: ReadDoor = REPOSITORY_DOOR,
  transcriptPaths: readonly string[] = [],
): Promise<Result<string>> {
  const resolved = resolveUnder(root, relative, door);
  if (!resolved.ok) return resolved;
  const lexical = fencesRefusal(resolved.value, protectedPaths, transcriptPaths);
  if (!lexical.ok) return lexical;
  const real = await containedRealPath(root, resolved.value, door);
  if (!real.ok) return real;
  const physical = await realFencesRefusal(real.value, protectedPaths, transcriptPaths);
  if (!physical.ok) return physical;
  return real;
}

/**
 * List one directory under the root: files and directories by name, sorted, at most `cap` of
 * them. Anything that is neither (a link, a socket) is left out rather than followed, and so is a
 * transcript folder: a listing of the directory that holds one (an agent home) names everything
 * else in it, as before, and not the folder. A protected path inside a listed directory is still
 * named; its contents are what the protected set refuses.
 */
export async function listRepositoryDirectory(
  root: string,
  relative: string,
  cap = MAX_REPOSITORY_ENTRIES,
  protectedPaths: readonly string[] = [],
  transcriptPaths: readonly string[] = [],
): Promise<Result<RepositoryListing>> {
  const real = await admittedRealPath(root, relative, protectedPaths, REPOSITORY_DOOR, transcriptPaths);
  if (!real.ok) return real;
  const fenced = [...transcriptPaths, ...(await realPathsOf(transcriptPaths))];

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
    .filter(
      (child) =>
        !fenced.some((candidate) => isContainedByIgnoringCase(`${real.value}/${child.name}`, candidate)),
    )
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
 * Read one page of a text file under the root: from byte `offset`, at most `maxBytes` (capped at the
 * wire's bound), cut back to a character boundary. Offset 0 is the head of a file of any size, the
 * read a controller one release behind makes. A page after it starts no further than
 * `MAX_REPOSITORY_FILE_BYTES` and ends there, or at the end of the file, whichever is first:
 * `nextOffset` is null at either. Binary is refused by the NUL probe; a directory, an absent path,
 * and an offset past the end, past that bound or inside a character are refused by name.
 */
export async function readRepositoryFile(
  root: string,
  relative: string,
  maxBytes = MAX_REPOSITORY_READ_BYTES,
  protectedPaths: readonly string[] = [],
  offset = 0,
  transcriptPaths: readonly string[] = [],
): Promise<Result<RepositoryText>> {
  const door = REPOSITORY_DOOR;
  const real = await admittedRealPath(root, relative, protectedPaths, door, transcriptPaths);
  if (!real.ok) return real;

  let stats;
  try {
    stats = await stat(real.value);
  } catch (error) {
    return refuse(door.failed, `the file could not be read: ${describe(error)}`);
  }
  if (!stats.isFile()) return refuse(door.failed, 'the path is not a file');

  const start = Math.max(0, Math.floor(offset));
  if (start > stats.size) {
    return refuse(door.failed, `the offset ${start} is past the end of the file (${stats.size} bytes)`);
  }
  // How far pages reach: the end of the file, or the bound, whichever is first.
  const reach = Math.min(stats.size, MAX_REPOSITORY_FILE_BYTES);
  if (start > reach) {
    return refuse(
      door.failed,
      `the offset ${start} is past the ${MAX_REPOSITORY_FILE_BYTES} bytes the repository read pages through; the head of any file is read at offset 0`,
    );
  }

  const wanted = Math.min(Math.max(1, Math.floor(maxBytes)), MAX_REPOSITORY_READ_BYTES, reach - start);
  const page = await readTextPage(real.value, stats.size, start, wanted, door);
  if (!page.ok) return page;
  const end = page.value.end;
  return ok({
    text: page.value.text,
    sizeBytes: stats.size,
    truncated: end < stats.size,
    nextOffset: end < reach ? end : null,
  });
}

/**
 * Read one page of a text file inside a workspace's directory: from byte `offset`, at most `maxBytes`
 * (capped at the wire's bound), cut back to a character boundary. The file must be at most
 * `MAX_WORKSPACE_FILE_BYTES` and text by the repository read's rule; an offset past the end or inside
 * a character is refused.
 */
export async function readWorkspaceFile(
  root: string,
  relative: string,
  offset = 0,
  maxBytes = MAX_WORKSPACE_READ_BYTES,
  protectedPaths: readonly string[] = [],
  transcriptPaths: readonly string[] = [],
): Promise<Result<WorkspaceText>> {
  const door = WORKSPACE_DOOR;
  const real = await admittedRealPath(root, relative, protectedPaths, door, transcriptPaths);
  if (!real.ok) return real;

  let stats;
  try {
    stats = await stat(real.value);
  } catch (error) {
    return refuse(door.failed, `the file could not be read: ${describe(error)}`);
  }
  if (!stats.isFile()) return refuse(door.failed, 'the path is not a file');
  if (stats.size > MAX_WORKSPACE_FILE_BYTES) {
    return refuse(
      door.failed,
      `the file is ${stats.size} bytes; the workspace read serves files up to ${MAX_WORKSPACE_FILE_BYTES}`,
    );
  }
  const start = Math.max(0, Math.floor(offset));
  if (start > stats.size) {
    return refuse(door.failed, `the offset ${start} is past the end of the file (${stats.size} bytes)`);
  }

  const wanted = Math.min(Math.max(1, Math.floor(maxBytes)), MAX_WORKSPACE_READ_BYTES);
  const page = await readTextPage(real.value, stats.size, start, wanted, door);
  if (!page.ok) return page;
  const end = page.value.end;
  return ok({ text: page.value.text, sizeBytes: stats.size, nextOffset: end < stats.size ? end : null });
}

/**
 * One page of a text file, the read both doors share: from `start`, at most `wanted` bytes, cut back
 * to a character boundary. A page that would end inside its first character carries that whole
 * character, so every page makes progress; a page asked for no bytes is empty. The file is text by
 * one rule wherever the page starts: no NUL byte in its first `BINARY_PROBE_BYTES`.
 *
 * A character is what a UTF-8 lead byte claims: a byte is inside one only when a lead byte at most
 * three bytes before it declares a length that reaches it, across continuation bytes. A later start
 * inside a character is refused, because a page from there would begin with half of one; offset 0
 * never is. A byte no lead claims (text in another encoding) is a character of its own, so a file
 * that is not UTF-8 is served from offset 0 and walked to its end, and no answer's `nextOffset` is a
 * start the next ask refuses.
 */
async function readTextPage(
  path: string,
  size: number,
  start: number,
  wanted: number,
  door: ReadDoor,
): Promise<Result<{ readonly text: string; readonly end: number }>> {
  let head: Buffer;
  let before: Buffer;
  let page: Buffer;
  try {
    head = await readRange(path, 0, Math.min(size, BINARY_PROBE_BYTES));
    // Up to three bytes before the start: enough to see whether a lead byte claims it.
    before =
      start === 0 ? Buffer.alloc(0) : await readRange(path, Math.max(0, start - 3), Math.min(3, start));
    // Three bytes past the page: enough to see whether a character straddles the cut.
    page = await readRange(path, start, Math.min(size - start, wanted + 3));
  } catch (error) {
    return refuse(door.failed, `the file could not be read: ${describe(error)}`);
  }
  if (head.includes(0)) {
    return refuse(door.failed, 'the file holds a NUL byte in its head and is not served as text');
  }
  if (page.length > 0 && claimingLead(Buffer.concat([before, page]), before.length) !== null) {
    return refuse(
      door.failed,
      `the offset ${start} falls inside a character; start at 0 or at the nextOffset an answer gave`,
    );
  }

  let cut = Math.min(page.length, wanted);
  // A byte at the cut that a lead byte before it claims means a character straddles the cut: step
  // back to that lead.
  if (cut > 0 && cut < page.length) cut = claimingLead(page, cut) ?? cut;
  if (cut === 0 && page.length > 0 && wanted > 0) {
    // The first character is longer than `wanted`: the page carries it whole rather than nothing.
    cut = 1;
    while (cut < page.length && claimingLead(page, cut) === 0) cut += 1;
  }
  return ok({ text: page.subarray(0, cut).toString('utf8'), end: start + cut });
}

/** The length a UTF-8 lead byte declares, or null for a byte that leads no multi-byte character. */
function declaredLength(byte: number): number | null {
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return null;
}

/**
 * The index of the lead byte whose character covers `bytes[index]`, or null when none does: `index`
 * is a continuation byte, the bytes between it and the lead are continuation bytes, the lead is at
 * most three bytes back, and the length it declares reaches `index`.
 */
function claimingLead(bytes: Buffer, index: number): number | null {
  if (index >= bytes.length || (bytes[index]! & 0xc0) !== 0x80) return null;
  for (let back = 1; back <= 3 && index - back >= 0; back += 1) {
    const byte = bytes[index - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const length = declaredLength(byte);
    return length !== null && length > back ? index - back : null;
  }
  return null;
}

/** `length` bytes of a file from `start`; fewer when the file ends first. */
async function readRange(path: string, start: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path, { start, end: start + length - 1 })) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
