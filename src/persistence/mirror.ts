/**
 * The mirror's own rules — deduplication on the way in, and what a dropped batch means.
 *
 * Two mirrors exist and they are not the same thing. The SDK dual-writes: the subprocess writes
 * locally first, then hands a batch to the adapter. Its retry and its drop are the SDK's behaviour —
 * this host cannot change them and must not pretend to. What belongs here is what an adapter does
 * with a batch it receives, and what the host does when the SDK tells it a batch was lost.
 *
 * A dropped batch is the one failure that looks exactly like nothing happening. The store simply
 * has fewer entries than local disk, with no error at the read and no gap anything can compute — the
 * durable copy is silently behind local truth. So the host surfaces the SDK's own report as a named
 * degrade rather than logging it and moving on. Silence here is indistinguishable from health.
 */
import type { TranscriptEntry } from './entry.js';
import type { TranscriptKey } from './key.js';

/**
 * How a mirror write failed, as the SDK distinguishes them.
 *
 * The two are not one failure with two names, and a test that covers only the first measures the
 * retry loop rather than the drop. A rejection is retried — three attempts in total, with short
 * backoff. A timeout is not retried at all, because the in-flight call may still land, so a timeout
 * drops on its first failure. An operator reasoning from "it retries three times" will therefore
 * mis-predict every timeout-shaped outage, and a slow store is the likeliest way to lose data here.
 */
export type MirrorFailureKind = 'rejected' | 'timed-out';

/**
 * Attempts each failure kind receives before the batch is dropped. Data, so the asymmetry above is
 * checkable rather than remembered.
 */
export const MIRROR_ATTEMPTS: Readonly<Record<MirrorFailureKind, number>> = {
  rejected: 3,
  'timed-out': 1,
};

/** What was lost, and enough to say which session lost it. */
export interface MirrorDrop {
  readonly key: TranscriptKey;
  readonly kind: MirrorFailureKind;
  readonly attempts: number;
  /** The store's own error text. Never parsed — carried so a human can read it. */
  readonly error: string;
  /**
   * The uuids in the lost batch, where the entries carried them.
   *
   * This is what makes a drop recoverable rather than merely reported. With the ids, a consumer
   * can re-drive those entries from local disk, which is still authoritative. Without them a drop is
   * only an alarm.
   */
  readonly entryUuids: readonly string[];
}

/** A dropped batch as one line a human reads. Never parsed back. */
export function describeMirrorDrop(drop: MirrorDrop): string {
  const attemptWord = drop.attempts === 1 ? 'attempt' : 'attempts';
  const scope =
    drop.key.subpath === undefined ? drop.key.sessionId : `${drop.key.sessionId}/${drop.key.subpath}`;
  return (
    `mirror batch DROPPED for ${scope} after ${drop.attempts} ${attemptWord} (${drop.kind}): ${drop.error} — ` +
    `${drop.entryUuids.length} entr${drop.entryUuids.length === 1 ? 'y is' : 'ies are'} in the store's ` +
    'copy no longer, though local disk still holds them'
  );
}

/** What a batch splits into once the store's existing ids are known. */
export interface DedupedBatch {
  /** Entries to write. */
  readonly append: readonly TranscriptEntry[];
  /** Entries already present, identified by uuid. */
  readonly skipped: readonly TranscriptEntry[];
}

/**
 * Split a batch into what to write and what is already there.
 *
 * An entry with no `uuid` is always appended, never deduplicated. The adapter contract is explicit
 * that most entries carry a stable uuid and that the ones that do not — titles, tags, mode markers —
 * should be appended without dedup. Treating "no uuid" as a duplicate would silently drop every one
 * of them; treating them as distinct is the contract, and the cost is at worst a repeated marker.
 *
 * Why dedup at all: the contract says retries and transcript imports replay batches, and asks
 * adapters to treat the uuid as an idempotency key so a replay does not create duplicate rows. A
 * store without this grows a second copy of a session every time a batch is retried.
 */
export function dedupeBatch(
  knownUuids: ReadonlySet<string>,
  batch: readonly TranscriptEntry[],
): DedupedBatch {
  const append: TranscriptEntry[] = [];
  const skipped: TranscriptEntry[] = [];
  const seenInBatch = new Set<string>();

  for (const entry of batch) {
    const uuid = entry.uuid;
    if (typeof uuid !== 'string' || uuid.length === 0) {
      append.push(entry);
      continue;
    }
    if (knownUuids.has(uuid) || seenInBatch.has(uuid)) {
      skipped.push(entry);
      continue;
    }
    seenInBatch.add(uuid);
    append.push(entry);
  }

  return { append, skipped };
}

/** Every uuid in a stored transcript, for the dedup above. */
export function uuidsIn(entries: readonly TranscriptEntry[]): Set<string> {
  const uuids = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.uuid === 'string' && entry.uuid.length > 0) uuids.add(entry.uuid);
  }
  return uuids;
}
