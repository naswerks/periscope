/**
 * The discovery door: read-only enumeration and tail-probing of the agent CLI's own transcript
 * directory, `~/.claude/projects`.
 *
 * The posture, stated once because it is the whole design. This host names `~/.claude` in one
 * other place, `host/paths.ts`, to protect it from the sessions it runs. That protection is about
 * the agent's hands; this module is the host's own eyes, a deliberate read-only capability over a
 * directory every Claude session on the machine writes into (a VS Code session and a session this
 * host started land side by side). The two postures do not touch: nothing here weakens the gate,
 * and nothing here can write.
 *
 * Read-only is a property, not a promise. The module's filesystem surface is exactly
 * `createReadStream`, `readdir` and `stat`; no write-capable API is imported, and
 * `src/pins/transcript-readonly.test.ts` holds the import surface to that allowlist.
 *
 * The jail: three layers, all three always, for every caller-supplied name:
 *   1. the strict name allowlist (`NAME_ALLOWLIST`);
 *   2. an explicit `'.'` / `'..'` reject — dot-names PASS the regex, so this layer is load-bearing;
 *   3. resolve-then-containment — the real resolver first, then `isContainedBy` against the root,
 *      so a name the first two layers somehow admitted still cannot shape a path outside it.
 * A violation refuses `transcript-path-escape`, naming the layer. An ABSENT transcript is a value,
 * never a refusal: a missing projects directory is a fresh machine and lists as empty.
 *
 * The rewrite hazard: the CLI rewrites a transcript on compaction,
 * so a byte-offset resume across a rewrite is invalid. Every answer that carries an offset also
 * carries the file's current (size, mtime) pair; a caller that sees either move under it re-reads
 * whole rather than resuming. A file SHORTER than the asked offset is treated as rewritten and
 * scanned from 0.
 *
 * Project slugs are OPAQUE NAMES, never decoded: the CLI flattens every non-alphanumeric character
 * of a directory path to `-` (on win32 `C:\src\x\.y` becomes `C--src-x--y`), so the
 * mapping is not invertible and nothing here tries.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { isContainedBy, normalizePath } from '../core/paths.js';
import { TRANSCRIPT_PAGE_SIZE, TRANSCRIPT_WHAT_PREFIX } from '../control/frames.js';
import { nodePathResolver } from './paths.js';

/**
 * The strict name allowlist — drive/path characters only. `'.'` and `'..'` PASS this regex, which
 * is exactly why the dot-name reject below is its own layer rather than a tightening of this one.
 */
export const NAME_ALLOWLIST = /^[A-Za-z0-9._-]+$/;

/**
 * The agent's home when nothing configures one: the folder the agent CLI keeps its state in, under
 * the user's home directory. Null when there is no home to derive it from — a refusable state,
 * never a fallback: inventing one would turn "this machine has no home directory" into a silent
 * empty listing that reads as a fresh machine.
 */
export function defaultAgentHome(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env['USERPROFILE'] ?? env['HOME'];
  if (typeof home === 'string' && home.trim() !== '') {
    // Spelled as the home is spelled: a Windows profile keeps its backslashes, so the value the
    // hello reports and a controller displays reads like every other path on that machine. The
    // transcript locator normalises for itself when it resolves.
    return beneath(home, '.claude');
  }
  return null;
}

/** Where the agent CLI keeps transcripts under its home: derived, never configured on its own. */
export function transcriptsRootUnder(agentHome: string): string {
  return beneath(agentHome, 'projects');
}

/** One segment beneath a base, in the base's own separator. */
function beneath(base: string, segment: string): string {
  const trimmed = base.replace(/[\\/]+$/, '');
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  return `${trimmed}${separator}${segment}`;
}

/** The transcripts root under the default agent home, or null when there is no home. */
export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = defaultAgentHome(env);
  return home === null ? null : transcriptsRootUnder(home);
}

/** One transcript on disk. `mtimeMs` is a floored integer so equality against a stamp holds. */
export interface DiscoveredTranscript {
  readonly projectSlug: string;
  readonly sessionId: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  /**
   * The working directory the CLI recorded on its entries, read off the file's own head, never
   * decoded from the slug (the flattening is not invertible). The resume handle's other half: the
   * CLI keeps transcripts per cwd, so a resume that does not run there finds nothing. Null when the
   * head carries none.
   */
  readonly cwd: string | null;
}

/** How much of a transcript's head is read for its `cwd` — the first entries, never the file. */
const CWD_HEAD_BYTES = 64 * 1024;

/**
 * The first `cwd` string on the file's first entries, or null. A summary line carries none; the first
 * user or assistant entry does. Every failure is null — the listing describes files, it does not refuse
 * over one of them.
 */
async function readTranscriptCwd(path: string): Promise<string | null> {
  let head = '';
  try {
    for await (const chunk of createReadStream(path, {
      start: 0,
      end: CWD_HEAD_BYTES - 1,
      encoding: 'utf8',
    })) {
      head += chunk as string;
    }
  } catch {
    return null;
  }
  for (const line of head.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const entry: unknown = JSON.parse(trimmed);
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { cwd?: unknown }).cwd === 'string'
      ) {
        const cwd = (entry as { cwd: string }).cwd;
        if (cwd.length > 0) return cwd;
      }
    } catch {
      // a partial last line inside the window, or a non-JSON line — keep looking
    }
  }
  return null;
}

export interface TranscriptPage {
  readonly entries: readonly DiscoveredTranscript[];
  readonly totalCount: number;
  /** Ask again from here for the next page; null when this page ends the listing. */
  readonly nextIndex: number | null;
}

/** What a tail probe answers. `absent` true means the transcript does not exist — a real negative. */
export interface TranscriptTailAnswer {
  readonly absent: boolean;
  readonly found: boolean;
  readonly newOffset: number;
  readonly sizeBytes: number | null;
  readonly mtimeMs: number | null;
}

/**
 * THE JAIL. Resolve `{root}/{projectSlug}/{sessionId}.jsonl` with all three layers applied to both
 * caller-supplied names. The one path-shaping function in this module — list, tail and the bulk
 * resolver all come through here, so there is no second door to keep honest.
 */
export function resolveTranscriptPath(root: string, projectSlug: string, sessionId: string): Result<string> {
  for (const [value, what] of [
    [projectSlug, 'projectSlug'],
    [sessionId, 'sessionId'],
  ] as const) {
    if (value === '.' || value === '..') {
      return refuse('transcript-path-escape', `${what} is a dot-name — refused by the dot-name layer`);
    }
    if (!NAME_ALLOWLIST.test(value)) {
      return refuse(
        'transcript-path-escape',
        `${what} fails the name allowlist — refused by the allowlist layer`,
      );
    }
  }

  const resolvedRoot = normalizePath(nodePathResolver(root));
  const candidate = normalizePath(nodePathResolver(`${resolvedRoot}/${projectSlug}/${sessionId}.jsonl`));
  if (!isContainedBy(candidate, resolvedRoot)) {
    return refuse(
      'transcript-path-escape',
      `the resolved path leaves the projects root — refused by the containment layer`,
    );
  }
  return ok(candidate);
}

/**
 * Enumerate every session transcript: direct-child `*.jsonl` per slug directory (nested files are
 * the CLI's subagent transcripts and are not part of this listing). Newest first by mtime, paged.
 * A missing root is a fresh machine and answers an empty listing, never an error; a file deleted
 * between readdir and stat is skipped for the same reason.
 */
export async function listTranscripts(
  root: string,
  page: { fromIndex?: number; pageSize?: number } = {},
): Promise<TranscriptPage> {
  const fromIndex = Math.max(0, page.fromIndex ?? 0);
  const pageSize = Math.max(1, page.pageSize ?? TRANSCRIPT_PAGE_SIZE);
  const resolvedRoot = normalizePath(nodePathResolver(root));

  let slugDirs;
  try {
    slugDirs = (await readdir(resolvedRoot, { withFileTypes: true })).filter(
      (entry) =>
        entry.isDirectory() && NAME_ALLOWLIST.test(entry.name) && entry.name !== '.' && entry.name !== '..',
    );
  } catch {
    return { entries: [], totalCount: 0, nextIndex: null };
  }

  const all: Omit<DiscoveredTranscript, 'cwd'>[] = [];
  for (const slugDir of slugDirs) {
    let files;
    try {
      files = await readdir(`${resolvedRoot}/${slugDir.name}`, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const sessionId = file.name.slice(0, -'.jsonl'.length);
      if (sessionId === '.' || sessionId === '..' || !NAME_ALLOWLIST.test(sessionId)) continue;
      try {
        const stats = await stat(`${resolvedRoot}/${slugDir.name}/${file.name}`);
        all.push({
          projectSlug: slugDir.name,
          sessionId,
          sizeBytes: stats.size,
          mtimeMs: Math.floor(stats.mtimeMs),
        });
      } catch {
        // Deleted between readdir and stat — the listing describes what exists, not what did.
      }
    }
  }

  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // The cwd is read for the PAGE only — one head per listed row, never one per file on the machine.
  const entries: DiscoveredTranscript[] = await Promise.all(
    all.slice(fromIndex, fromIndex + pageSize).map(async (entry) => ({
      ...entry,
      cwd: await readTranscriptCwd(`${resolvedRoot}/${entry.projectSlug}/${entry.sessionId}.jsonl`),
    })),
  );
  const nextIndex = fromIndex + entries.length;
  return {
    entries,
    totalCount: all.length,
    nextIndex: nextIndex < all.length ? nextIndex : null,
  };
}

/**
 * Probe one transcript from `fromOffset` for a user entry matching `needle` (null = any user-text
 * entry). Jail violations refuse; an absent file answers `{absent: true}`; a read that FAILS is a
 * refusal (`transcript-read-failed`), never a false negative — to the asker "no new entry" and
 * "could not look" must not be the same answer.
 */
export async function tailTranscript(
  root: string,
  projectSlug: string,
  sessionId: string,
  probe: { fromOffset?: number; needle?: string | null } = {},
): Promise<Result<TranscriptTailAnswer>> {
  const resolved = resolveTranscriptPath(root, projectSlug, sessionId);
  if (!resolved.ok) return resolved;

  let stats;
  try {
    stats = await stat(resolved.value);
  } catch {
    return ok({ absent: true, found: false, newOffset: 0, sizeBytes: null, mtimeMs: null });
  }
  if (!stats.isFile()) {
    return ok({ absent: true, found: false, newOffset: 0, sizeBytes: null, mtimeMs: null });
  }

  const sizeBytes = stats.size;
  const mtimeMs = Math.floor(stats.mtimeMs);
  const asked = Math.max(0, probe.fromOffset ?? 0);
  // A file shorter than the baseline was rewritten (compaction, or a fork replacing it): scan from
  // the start and let the needle reject stale entries — resuming into a rewritten file would read
  // from the middle of a line that no longer exists.
  const start = sizeBytes < asked ? 0 : asked;
  const needle = probe.needle ?? null;

  if (start >= sizeBytes) {
    return ok({ absent: false, found: false, newOffset: sizeBytes, sizeBytes, mtimeMs });
  }

  try {
    const found = await scanForUserEntry(resolved.value, start, sizeBytes, needle);
    return ok({ absent: false, found, newOffset: sizeBytes, sizeBytes, mtimeMs });
  } catch (error) {
    return refuse(
      'transcript-read-failed',
      `reading ${projectSlug}/${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The bulk-lane resolver for transcript reads: `claude-transcript:{slug}/{sessionId}` to a jailed
 * absolute path. A locator outside the namespace is refused as an invalid bulk target so an
 * embedder composing several resolvers can tell "not mine" from "mine and malformed".
 */
export function claudeTranscriptResolver(root: string): (what: string, sessionKey: string) => Result<string> {
  return (what: string): Result<string> => {
    if (!what.startsWith(TRANSCRIPT_WHAT_PREFIX)) {
      return refuse(
        'bulk-target-invalid',
        `this host resolves "${TRANSCRIPT_WHAT_PREFIX}{projectSlug}/{sessionId}" locators; got "${what}"`,
      );
    }
    const rest = what.slice(TRANSCRIPT_WHAT_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) {
      return refuse(
        'bulk-target-invalid',
        `a transcript locator is "${TRANSCRIPT_WHAT_PREFIX}{projectSlug}/{sessionId}"; got "${what}"`,
      );
    }
    return resolveTranscriptPath(root, rest.slice(0, slash), rest.slice(slash + 1));
  };
}

// ---------------------------------------------------------------------------
// The user-entry predicate: the rule that decides whether a new user entry landed.
// ---------------------------------------------------------------------------

/** Collapse every whitespace run to one space and trim, so needle matching survives reflowing. */
const normalizeForMatch = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A user entry's text: a flat string content, or its concatenated `text` blocks. */
function userTextOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      out += (block as { text: string }).text;
    }
  }
  return out;
}

/**
 * One line: does it count as a matching user entry? Unparseable or foreign lines are skipped,
 * never thrown — a truncated LAST line is the normal state of a file being appended to. A
 * tool-result-only user line has no text block and so never matches.
 */
export function isMatchingUserEntry(line: string, needle: string | null): boolean {
  let root: unknown;
  try {
    root = JSON.parse(line);
  } catch {
    return false;
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return false;
  if ((root as { type?: unknown }).type !== 'user') return false;
  const message = (root as { message?: unknown }).message;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return false;
  const role = (message as { role?: unknown }).role;
  if (role !== undefined && role !== 'user') return false;

  const text = userTextOf(message);
  if (text.trim().length === 0) return false;
  if (needle === null || needle === '') return true;
  return normalizeForMatch(text).includes(needle);
}

/**
 * Read `[start, end)` in chunks with a line carry, so a large transcript never lands in one buffer
 * and a partial final line is simply the last carry. The final carry is tested too — an
 * unterminated tail is still a line.
 */
function scanForUserEntry(file: string, start: number, end: number, needle: string | null): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { start, end: end - 1, encoding: 'utf8' });
    let carry = '';
    let found = false;

    stream.on('data', (chunk) => {
      if (found) return;
      const text = carry + String(chunk);
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.length === 0) continue;
        if (isMatchingUserEntry(line, needle)) {
          found = true;
          stream.destroy();
          return;
        }
      }
    });
    stream.on('error', reject);
    stream.on('close', () => {
      if (!found && carry.length > 0) {
        const line = carry.endsWith('\r') ? carry.slice(0, -1) : carry;
        if (line.length > 0 && isMatchingUserEntry(line, needle)) found = true;
      }
      resolve(found);
    });
  });
}
