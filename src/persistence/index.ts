/**
 * Transcript durability, the receipt read path, and the durable transition log.
 *
 * The one rule a consumer must not get wrong: a receipt, an audit, or any "what actually
 * happened?" question is answered from raw stored entries — `store.load(key)` or the local JSONL —
 * and never from the SDK's conversation reader, which returns the post-compaction view. "What would
 * the agent see?" is the other question and the other read. `receipt.ts` carries the reasoning.
 */
export type { TranscriptKey } from './key.js';
export { sameTranscript, transcriptKey, transcriptToken } from './key.js';

export type { TranscriptEntry } from './entry.js';
export {
  COMPACTION_SUBTYPES,
  COMPACTION_TYPES,
  COMPACT_METADATA_KEY,
  decodeEntry,
  decodeTranscript,
  encodeEntry,
  encodeTranscript,
  isCompactBoundary,
  isCompactionProduced,
  isUserEntry,
} from './entry.js';

export type { ReceiptOutcome, ReceiptQuery } from './receipt.js';
export { baselineAnchor, compactionCount, resolveReceipt } from './receipt.js';

export {
  ABANDONED_ENTRY_TYPE,
  TRANSITION_ENTRY_TYPE,
  abandonmentsIn,
  decodeTransition,
  encodeTransition,
  markAbandoned,
  transitionUuid,
  transitionsIn,
} from './transition-log.js';

export type { RetentionPlan, RetentionPolicy } from './retention.js';
export { entryTimeMs, markOutlivesSubject, planRetention } from './retention.js';

export type { DedupedBatch, MirrorDrop, MirrorFailureKind } from './mirror.js';
export { MIRROR_ATTEMPTS, dedupeBatch, describeMirrorDrop, uuidsIn } from './mirror.js';

export type { JsonlStoreOptions, StoreEffects, StoredSession, TranscriptStore } from './store.js';
export { createJsonlStore } from './store.js';
