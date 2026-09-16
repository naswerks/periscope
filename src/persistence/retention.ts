/**
 * How long stored entries are kept — and why this file exists at all.
 *
 * The SDK never deletes from your store. Its adapter contract says so in as many words and hands
 * retention to the adapter, naming TTLs and lifecycle policies as the adapter's job. So a compliance
 * window is not something this host inherits — it is something it must implement, and a package that
 * shipped without one would quietly keep every transcript forever.
 *
 * This is a plan, not a deletion. It returns what would go and what would stay; something in
 * `host/` performs it. That is what makes "retention removes what it claims to" measurable before
 * and after by a plain unit test instead of by deleting real files and hoping.
 *
 * It does not contradict the append-only log, and the distinction is exact. Append-only forbids
 * editing or selectively erasing a record — rewriting an abandoned entry to look closed, dropping
 * an inconvenient refusal. Retention drops whole entries once they age out of a stated window,
 * uniformly and by a rule announced in advance. The first destroys a signal while keeping its
 * neighbours, which makes the remaining record misleading; the second removes the record and
 * says so.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { TranscriptEntry } from './entry.js';

export interface RetentionPolicy {
  /** Entries older than this go. Must be a finite, non-negative number of milliseconds. */
  readonly maxAgeMs: number;
}

export interface RetentionPlan {
  readonly keep: readonly TranscriptEntry[];
  readonly remove: readonly TranscriptEntry[];
  /**
   * Entries kept only because they carry no readable timestamp.
   *
   * Surfaced rather than folded into `keep`, because it is the number that says whether this
   * policy is actually doing what its window claims. A store full of undated entries is one where
   * retention is silently a no-op, and that is a thing an operator must be able to see.
   */
  readonly undatedKept: number;
}

/**
 * What this policy would remove, given the time now.
 *
 * An entry that cannot be dated is kept. Deleting on a guess is worse than keeping too much: an
 * unparseable or absent timestamp means the age is unknown, and treating unknown as old would delete
 * exactly the malformed records somebody needs to look at. It errs toward keeping, and reports how
 * often it did.
 */
export function planRetention(
  entries: readonly TranscriptEntry[],
  policy: RetentionPolicy,
  nowMs: number,
): Result<RetentionPlan> {
  if (!Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs < 0) {
    return refuse<RetentionPlan>(
      'retention-window-invalid',
      `maxAgeMs must be a finite, non-negative number of milliseconds, got ${String(policy.maxAgeMs)}`,
    );
  }
  if (!Number.isFinite(nowMs)) {
    return refuse<RetentionPlan>(
      'retention-window-invalid',
      `now must be a finite epoch value, got ${String(nowMs)}`,
    );
  }

  const cutoff = nowMs - policy.maxAgeMs;
  const keep: TranscriptEntry[] = [];
  const remove: TranscriptEntry[] = [];
  let undatedKept = 0;

  for (const entry of entries) {
    const at = entryTimeMs(entry);
    if (at === null) {
      keep.push(entry);
      undatedKept += 1;
      continue;
    }
    if (at < cutoff) remove.push(entry);
    else keep.push(entry);
  }

  return ok({ keep, remove, undatedKept });
}

/**
 * One entry's time, in epoch milliseconds, or null when it has none this can read.
 *
 * Exported because the retention plan's honesty depends on it: a caller that wants to know whether a
 * store is datable at all asks this rather than inferring it from a plan that kept everything.
 */
export function entryTimeMs(entry: TranscriptEntry): number | null {
  const timestamp = entry.timestamp;
  if (typeof timestamp !== 'string' || timestamp.length === 0) return null;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Why an abandonment mark can never be orphaned by this policy, stated because the pairing is the
 * one thing retention could destroy while looking correct.
 *
 * A mark is written strictly after the entry it refers to — it records that an already-open entry
 * was later found abandoned. An age window removes oldest-first, so the only orderings it can
 * produce are "both kept", "both removed", or "the older subject removed while the newer mark
 * stays". The dangerous fourth — the mark removed while the subject stays, leaving an abandoned
 * entry reading as merely still-open — is unreachable, because that requires the mark to be older
 * than its subject.
 *
 * This function is the assertion of that, so the property is checked rather than reasoned about.
 */
export function markOutlivesSubject(subjectAtMs: number, markAtMs: number, cutoffMs: number): boolean {
  if (markAtMs < subjectAtMs) return false;
  const subjectKept = subjectAtMs >= cutoffMs;
  const markKept = markAtMs >= cutoffMs;
  return !(subjectKept && !markKept);
}
