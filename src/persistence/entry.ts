/**
 * One stored line, and the codec that turns a transcript into lines and back.
 *
 * Entries are pass-through blobs and this file keeps them that way. The concrete entry shape is
 * the on-disk transcript format — a large union the CLI owns and the SDK deliberately does not
 * export, exposing only a structural supertype: a string `type`, usually a `uuid`, usually a
 * `timestamp`, and opaque JSON for the rest. So nothing here parses an entry into a richer model.
 * Round-tripping through JSON is the only invariant the adapter contract requires, and it is
 * therefore the one this file pins.
 *
 * A line that will not round-trip is named, never skipped. Skipping is how a transcript loses
 * entries nobody counted — the reader sees a shorter list and no reason to doubt it, which is the
 * exact silent-loss shape a receipt read must not sit on top of.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';

/** One transcript line. Structurally the adapter contract's entry, under this package's own name. */
export interface TranscriptEntry {
  readonly type: string;
  /** Most entries carry one. Titles, tags and mode markers do not — see `mirror.ts` on dedup. */
  readonly uuid?: string;
  readonly timestamp?: string;
  readonly [key: string]: unknown;
}

/**
 * The discriminators that mark an entry as produced by compaction rather than by a turn.
 *
 * This list is why a receipt cannot report a false positive, and it is the defence whose failure
 * direction is opposite to the other two. Compaction replaces earlier turns with a summary, and a
 * summary is fed back into the conversation as ordinary-looking content. A receipt asking only "is
 * there a user entry after my anchor?" would match the summary and report a delivery that never
 * happened — the controller then believes text landed that the agent never saw.
 *
 * Kept as data, because the entry union is CLI-internal and this is a structural read of it. If
 * the format grows another marker, one constant changes and every reader that matters is already
 * looking at it. `subtype` is the SDK's own word: `SDKCompactBoundaryMessage` carries
 * `subtype: 'compact_boundary'` alongside its `compact_metadata`.
 */
export const COMPACTION_SUBTYPES: readonly string[] = ['compact_boundary'];

/** Entry `type` values that exist only because a compaction ran. */
export const COMPACTION_TYPES: readonly string[] = ['summary', 'compact_boundary'];

/** The key the boundary's own metadata rides on, named once. */
export const COMPACT_METADATA_KEY = 'compact_metadata';

/**
 * Whether this entry is the compaction boundary itself — the marker that says a compaction ran here.
 *
 * Three independent tells, because the boundary is the one entry a receipt read must never miss:
 * the SDK's own subtype, the entry type, and the presence of the metadata block the boundary is the
 * only thing that carries.
 */
export function isCompactBoundary(entry: TranscriptEntry): boolean {
  const subtype = entry['subtype'];
  if (typeof subtype === 'string' && COMPACTION_SUBTYPES.includes(subtype)) return true;
  if (entry.type === 'compact_boundary') return true;
  return Object.prototype.hasOwnProperty.call(entry, COMPACT_METADATA_KEY);
}

/**
 * Whether this entry exists because a compaction ran — the boundary, or the summary it produced.
 *
 * Broader than `isCompactBoundary` on purpose: the boundary is what a reader counts, and this is
 * what a reader must not mistake for a turn.
 */
export function isCompactionProduced(entry: TranscriptEntry): boolean {
  if (isCompactBoundary(entry)) return true;
  if (COMPACTION_TYPES.includes(entry.type)) return true;
  return entry['isCompactSummary'] === true;
}

/** Whether this entry is a user turn — the thing a delivery receipt is looking for. */
export function isUserEntry(entry: TranscriptEntry): boolean {
  return entry.type === 'user';
}

/** One entry as one JSONL line. No trailing newline — the writer joins. */
export function encodeEntry(entry: TranscriptEntry): string {
  return JSON.stringify(entry);
}

/** One JSONL line back to an entry, or a named refusal. */
export function decodeEntry(line: string): Result<TranscriptEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return refuse<TranscriptEntry>('transcript-entry-malformed', `line is not JSON: ${preview(line)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse<TranscriptEntry>(
      'transcript-entry-malformed',
      `line is not a JSON object: ${preview(line)}`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record['type'] !== 'string') {
    return refuse<TranscriptEntry>(
      'transcript-entry-malformed',
      `entry has no string "type" discriminant: ${preview(line)}`,
    );
  }
  return ok(record as TranscriptEntry);
}

/** A whole transcript as JSONL text. */
export function encodeTranscript(entries: readonly TranscriptEntry[]): string {
  return entries.map(encodeEntry).join('\n');
}

/**
 * JSONL text back to entries.
 *
 * Blank lines are skipped because a trailing newline is ordinary and produces one; a line with
 * content that will not decode is refused, and the refusal names which line so the file can be
 * looked at. Those are different situations and only one of them is a problem.
 */
export function decodeTranscript(text: string): Result<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line.length === 0) continue;
    const decoded = decodeEntry(line);
    if (!decoded.ok) {
      return refuse<TranscriptEntry[]>(
        decoded.refusal.reason,
        `line ${index + 1}: ${decoded.refusal.detail}`,
      );
    }
    entries.push(decoded.value);
  }
  return ok(entries);
}

function preview(line: string): string {
  const trimmed = line.trim();
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 80)}…`;
}
