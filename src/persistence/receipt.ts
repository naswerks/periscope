/**
 * The delivery receipt — did the text a controller injected actually land in the session?
 *
 * Getting this wrong is silent. Read the three defences below before changing anything here.
 *
 * What it is read from, and why that is the whole point. A receipt is answered from raw stored
 * entries — the adapter's `load`, or the local JSONL — and never from the SDK's conversation reader.
 * That reader reconstructs the conversation by following `parentUuid` links, and compaction relinks
 * those links: the shipped types say a loader splices the preserved segment at an anchor uuid and
 * relinks each preserved uuid to its predecessor rather than walking `parentUuid` at all, and that
 * both the preserved-segment and preserved-messages blocks are "unset when compaction summarizes
 * everything". So after a compaction a `parentUuid` walk structurally cannot reach pre-compaction
 * turns. Raw entries are append-only and lose nothing, which is why the receipt reads those.
 *
 * The reader is not banned — it is for a different question. "What would the agent see?" is
 * exactly the post-compaction conversation, and the SDK's reader answers it correctly. "What
 * actually happened?" is this file. Two questions, two reads; using one for the other is the defect.
 *
 * The three defences, each with a different failure direction. They are named because an
 * invariant defended in depth cannot be proven by removing one guard — the test then measures
 * the redundancy instead of the invariant.
 *
 *   Defence 1  Raw entries, never a `parentUuid` walk.   Removing it means a false negative after
 *                                                        a compaction.
 *   Defence 2  A uuid anchor, never a numeric offset.    Removing it means a false negative, or a
 *                                                        mis-anchored scan, the moment the entry
 *                                                        count shrinks.
 *   Defence 3  Compaction-produced entries are not       Removing it means a false positive — the
 *              candidates.                               summary a compaction writes is matched as
 *                                                        if it were the injected turn, so the
 *                                                        controller is told text landed that the
 *                                                        agent never saw.
 *
 * Defences 1 and 2 fail toward "it did not land", which makes a controller paste the text a second
 * time. Defence 3 fails toward "it landed", which makes a controller move on from an inject that
 * never arrived. Both are silent; they are opposite, and no single test can see both.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { TranscriptEntry } from './entry.js';
import { isCompactBoundary, isCompactionProduced, isUserEntry } from './entry.js';

/**
 * What to look for.
 *
 * There is no offset field, and its absence is Defence 2. A count is meaningless across a
 * compaction: the conversation the agent sees can shrink from hundreds of entries to a handful, so
 * "past entry 412" stops addressing anything. A uuid addresses one entry for as long as that entry
 * exists, and in an append-only log it exists forever. If this interface ever grows a numeric
 * baseline, the receipt has been reopened to the exact defect it was written to close.
 */
export interface ReceiptQuery {
  /**
   * The uuid of the last entry seen before the inject. `null` scans the whole transcript.
   *
   * A controller takes this from its own pre-inject read. `null` is for the first inject into a
   * session that had no entries yet — not a fallback for an anchor that could not be found.
   */
  readonly anchorUuid: string | null;
  /**
   * Text the delivered entry must carry.
   *
   * Optional, and stronger than the position alone. Without it the receipt answers "a user turn
   * arrived after my anchor", which is true of any user turn — including one a different writer
   * queued. With it the receipt answers "my text arrived". A controller driving one session at a
   * time can omit it; anything with two writers should not.
   */
  readonly expectText?: string;
}

/** What the transcript says happened. */
export interface ReceiptOutcome {
  /** Whether a qualifying user entry arrived after the anchor. */
  readonly delivered: boolean;
  /** The uuid of the entry that satisfied it, when one did. */
  readonly entryUuid: string | null;
  /** That entry's own timestamp, when it carries one. */
  readonly at: string | null;
  /**
   * Whether a compaction sits between the anchor and now.
   *
   * Reported rather than hidden because it is the fact that makes this receipt trustworthy: a
   * `true` here on a `delivered: true` receipt is the observation that the read survived the
   * boundary. It is also what lets a reader tell a genuinely quiet session apart from one whose
   * history was just rewritten underneath it.
   */
  readonly crossedCompaction: boolean;
  /** How many entries were examined after the anchor. Diagnostic; never a receipt on its own. */
  readonly scannedAfterAnchor: number;
}

/**
 * Resolve a delivery receipt against raw stored entries.
 *
 * An unfindable anchor is a refusal, not a negative receipt — and this is the single most
 * important line in the file. Three situations exist: the text landed, the text did not land, and
 * the question cannot be evaluated. Collapsing the third into the second is what makes the failure
 * invisible: a controller reading a false "no" pastes the text again, and a double-paste is the
 * exact production symptom this read path exists to prevent. So it refuses by name and the caller
 * has to decide what to do about not knowing.
 *
 * @param entries Raw entries in append order — `store.load(key)` or the local JSONL. Not a
 *                reconstructed conversation: see Defence 1 in this file's header.
 */
export function resolveReceipt(
  entries: readonly TranscriptEntry[],
  query: ReceiptQuery,
): Result<ReceiptOutcome> {
  // Defence 2: the anchor is located by identity. Nothing here counts.
  const anchorIndex =
    query.anchorUuid === null ? -1 : entries.findIndex((entry) => entry.uuid === query.anchorUuid);

  if (query.anchorUuid !== null && anchorIndex === -1) {
    return refuse<ReceiptOutcome>(
      'receipt-anchor-unknown',
      `no entry carries the baseline uuid ${query.anchorUuid} in ${entries.length} stored entries — ` +
        'the receipt cannot be evaluated, which is not the same as the text not arriving',
    );
  }

  const after = entries.slice(anchorIndex + 1);
  const crossedCompaction = after.some(isCompactBoundary);

  for (const entry of after) {
    // Defence 3: a compaction's own output is never a candidate, however much it looks like a turn.
    if (isCompactionProduced(entry)) continue;
    if (!isUserEntry(entry)) continue;
    if (query.expectText !== undefined && !entryCarriesText(entry, query.expectText)) continue;

    return ok({
      delivered: true,
      entryUuid: entry.uuid ?? null,
      at: entry.timestamp ?? null,
      crossedCompaction,
      scannedAfterAnchor: after.length,
    });
  }

  return ok({
    delivered: false,
    entryUuid: null,
    at: null,
    crossedCompaction,
    scannedAfterAnchor: after.length,
  });
}

/**
 * The uuid a controller should hold as its next baseline — the last entry currently stored.
 *
 * Null for an empty transcript, which is the one case where a query may honestly carry a null
 * anchor. Entries without a uuid are skipped: an anchor has to be addressable, and the contract
 * says some entry kinds legitimately carry none.
 */
export function baselineAnchor(entries: readonly TranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const uuid = entries[index]?.uuid;
    if (typeof uuid === 'string' && uuid.length > 0) return uuid;
  }
  return null;
}

/** How many compactions this transcript records. For observability, not for the receipt. */
export function compactionCount(entries: readonly TranscriptEntry[]): number {
  return entries.filter(isCompactBoundary).length;
}

/**
 * Whether an entry's payload carries this text anywhere in it.
 *
 * A structural search, not a content model. A user entry's `message` is the CLI's own shape and
 * this package does not model it, so the text is looked for across the serialised payload rather
 * than at a path this file would have to keep in step with a format it does not own.
 */
function entryCarriesText(entry: TranscriptEntry, text: string): boolean {
  if (text.length === 0) return true;
  try {
    return JSON.stringify(entry).includes(text);
  } catch {
    return false;
  }
}
