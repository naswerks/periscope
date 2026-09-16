/**
 * Where transcripts are kept — the seam, and the JSONL implementation that ships.
 *
 * The store is the embedder's, the same way the workspace provider is. One implementation ships
 * because everyone needs a local one; the interesting ones — S3, Postgres, a blob container behind
 * a tenant boundary — are the embedder's and are written against this interface without ever
 * learning what a session means. The effects are injected for the same reason they are there: the
 * rules worth testing are which key becomes which record and what a missing transcript returns, and
 * none of that needs a disk.
 *
 * This is not the sole record, by the SDK's design and not by this package's. The subprocess
 * writes to local disk first and the mirror runs after that write succeeds, so local disk is
 * authoritative and a store can legitimately lag it. The adapter contract also forbids turning
 * local persistence off while a store is set. Anything reasoning about "what the store has" must
 * hold that the local copy may be ahead — see `mirror.ts` on dropped batches, which is how it gets
 * ahead and stays there.
 *
 * `listSessionSummaries` is deliberately not part of this interface — a decision, not an omission.
 * The SDK offers a summary side-file a store can maintain inside `append()`, and it is declined
 * here for three reasons. Its payload is documented as opaque SDK-owned state a store must persist
 * verbatim and must not interpret, so it yields nothing this host could put on the wire;
 * maintaining it requires serialising side-file writes behind a per-session lock on a path that
 * receives batches at roughly ten a second; and it optimises a read path this host does not use.
 * The underlying requirement — parse at the edge, ship summaries rather than transcripts — is met
 * instead by `receipt.ts` and `transition-log.ts`, which answer the questions a controller actually
 * asks without sending it a transcript. The adapter contract marks the method optional, so
 * declining it is a supported posture rather than a gap.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { TranscriptEntry } from './entry.js';
import { decodeTranscript, encodeTranscript } from './entry.js';
import type { TranscriptKey } from './key.js';
import { transcriptToken } from './key.js';
import { dedupeBatch, uuidsIn } from './mirror.js';

/** One stored session, as a listing reports it. */
export interface StoredSession {
  readonly sessionId: string;
  /** Storage write time, epoch milliseconds. The store's own clock, never an entry's timestamp. */
  readonly mtime: number;
}

/**
 * Where transcripts go.
 *
 * `load` returns `null` for a transcript that was never written, and that is distinct from an
 * empty list. "Never written" and "written and then emptied" are different facts, and a store that
 * cannot tell them apart is allowed to say `null` for both — but it may not report either as an
 * empty transcript, because a resume reading an empty list would start a session claiming it had
 * checked and found no history.
 */
export interface TranscriptStore {
  /** Mirror a batch. Idempotent on `uuid` — see mirror.ts. */
  append(key: TranscriptKey, entries: readonly TranscriptEntry[]): Promise<Result<void>>;
  /** Everything stored for this key, or null when nothing ever was. */
  load(key: TranscriptKey): Promise<Result<TranscriptEntry[] | null>>;
  /** Sessions under one project scope. Optional — a store may not be able to enumerate. */
  listSessions?(projectKey: string): Promise<Result<StoredSession[]>>;
  /**
   * Remove a transcript.
   *
   * Optional, and absent means "deletion is a no-op" rather than "deletion fails". That is the
   * adapter contract's own shape and it is the right one for append-only backends: a write-once
   * bucket cannot delete, and pretending otherwise would make retention look like it ran.
   */
  delete?(key: TranscriptKey): Promise<Result<void>>;
  /** Subagent transcripts under one session, so a resume can materialise them too. */
  listSubkeys?(key: TranscriptKey): Promise<Result<string[]>>;
}

/**
 * The storage effects a JSONL store needs, injected.
 *
 * Same rule as everywhere else: `src/host/` is the only directory that may touch a filesystem, so
 * the logic lives here and the real implementation is host-side.
 */
export interface StoreEffects {
  /** Append text to a record, creating it and any container it needs. */
  appendTo(token: string, text: string): Promise<void>;
  /** The whole record's text, or null when it does not exist. */
  readAll(token: string): Promise<string | null>;
  /** Tokens under one project scope, with their storage write times. */
  list(projectKey: string): Promise<readonly { token: string; sessionId: string; mtime: number }[]>;
  /** Remove one record. Succeeds when it is already gone. */
  remove(token: string): Promise<void>;
  /** Subpath tokens under one session. */
  subkeys(projectKey: string, sessionId: string): Promise<readonly string[]>;
}

/**
 * A store that keeps each transcript as JSONL, one line per entry.
 *
 * Append is a real append, not a read-modify-write of the whole file. A transcript reaches
 * megabytes and batches arrive throughout a turn, so rewriting it per batch would make cost grow
 * with the square of the session's length. The one place that does read first is deduplication,
 * which is why `dedupeOnAppend` can be turned off for a caller that knows its batches are unique.
 */
export function createJsonlStore(effects: StoreEffects, options: JsonlStoreOptions = {}): TranscriptStore {
  const dedupe = options.dedupeOnAppend ?? true;

  return {
    async append(key, entries) {
      if (entries.length === 0) return ok(undefined);
      const token = transcriptToken(key);

      let toWrite = entries;
      if (dedupe) {
        const existing = await readEntries(effects, token);
        if (!existing.ok) return refuse<void>(existing.refusal.reason, existing.refusal.detail);
        toWrite = dedupeBatch(uuidsIn(existing.value ?? []), entries).append;
        if (toWrite.length === 0) return ok(undefined);
      }

      try {
        await effects.appendTo(token, `${encodeTranscript(toWrite)}\n`);
        return ok(undefined);
      } catch (error) {
        return refuse<void>('transcript-write-failed', `${token}: ${messageOf(error)}`);
      }
    },

    async load(key) {
      return readEntries(effects, transcriptToken(key));
    },

    async listSessions(projectKey) {
      try {
        const found = await effects.list(projectKey);
        return ok(found.map((one) => ({ sessionId: one.sessionId, mtime: one.mtime })));
      } catch (error) {
        return refuse<StoredSession[]>('transcript-read-failed', `${projectKey}: ${messageOf(error)}`);
      }
    },

    async delete(key) {
      try {
        await effects.remove(transcriptToken(key));
        return ok(undefined);
      } catch (error) {
        return refuse<void>('transcript-write-failed', `${transcriptToken(key)}: ${messageOf(error)}`);
      }
    },

    async listSubkeys(key) {
      try {
        return ok([...(await effects.subkeys(key.projectKey, key.sessionId))]);
      } catch (error) {
        return refuse<string[]>('transcript-read-failed', `${transcriptToken(key)}: ${messageOf(error)}`);
      }
    },
  };
}

export interface JsonlStoreOptions {
  /**
   * Read before appending so a replayed batch does not duplicate. Defaults to true.
   *
   * Turning it off is a real choice with a named cost. It removes a full read per batch, which
   * matters on a long transcript; what it costs is that a retried or re-imported batch lands twice,
   * and nothing downstream can tell a duplicated entry from a repeated one.
   */
  readonly dedupeOnAppend?: boolean;
}

async function readEntries(effects: StoreEffects, token: string): Promise<Result<TranscriptEntry[] | null>> {
  let text: string | null;
  try {
    text = await effects.readAll(token);
  } catch (error) {
    return refuse<TranscriptEntry[] | null>('transcript-read-failed', `${token}: ${messageOf(error)}`);
  }
  if (text === null) return ok(null);

  const decoded = decodeTranscript(text);
  if (!decoded.ok)
    return refuse<TranscriptEntry[] | null>(decoded.refusal.reason, `${token}: ${decoded.refusal.detail}`);
  return ok(decoded.value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
