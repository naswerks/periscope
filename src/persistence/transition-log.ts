/**
 * The durable transition log — the only place a gate decision is stored durably.
 *
 * Read this before adding any cleanup, prune or tidy-up. `state/store.ts` retains transitions in
 * a bounded in-memory ring that actively drops its oldest once a session outruns the window, and
 * its own header says durability belongs here. Every recorded transition also reaches the link —
 * `forwardSession` in `control/stream.ts` subscribes to the machine and forwards whichever lane
 * produced it — but the link is a stream, not a record: once a frame has been sent, nothing in
 * this package can read it back. So every local refusal this host decides — a path-jail denial, a
 * boundary command, a credential-path read, an unconvertible tool descriptor — is held in-process
 * only by a ring that will eventually overwrite it. This file is what makes such a decision
 * readable afterwards. A tidy-up here does not lose a log line; it loses the only stored evidence
 * that the package's headline feature ever ran.
 *
 * Append-only, and an abandoned entry is marked rather than erased. "This session sat in
 * `tool:Bash` for forty minutes" is the most useful sentence this system can produce, and a
 * reconciler that quietly closed the entry would destroy exactly that. So `markAbandoned` writes a
 * new record carrying the reason; it never rewrites or removes the one that is already stored.
 *
 * `cause` survives the round trip or the read refuses. A transition read back without the event
 * that produced it would leave a reader with a state change and no way to know what caused it,
 * which is exactly the inference the declared model exists to eliminate. So the encoder writes all
 * three parts of a cause and the decoder refuses an entry that lost any of them, rather than
 * substituting a plausible default.
 */
import type { OpenEntry, SessionTransition } from '../state/model.js';
import { isCauseEvent, isCauseKind } from '../state/model.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { TranscriptEntry } from './entry.js';

/**
 * The entry `type` a stored transition carries.
 *
 * Namespaced so it cannot collide with a transcript entry. These records may share a store with
 * mirrored transcript lines, whose `type` values are the CLI's. A prefix nothing in that vocabulary
 * uses keeps the two readable side by side and keeps a reader of either from mistaking one for the
 * other.
 */
export const TRANSITION_ENTRY_TYPE = 'periscope.transition';

/** The entry `type` an abandonment mark carries. A record in its own right, never an edit. */
export const ABANDONED_ENTRY_TYPE = 'periscope.entry_abandoned';

/** Encode one transition as a storable entry. Lossless for everything a reader branches on. */
export function encodeTransition(transition: SessionTransition): TranscriptEntry {
  return {
    type: TRANSITION_ENTRY_TYPE,
    uuid: transitionUuid(transition),
    timestamp: transition.at,
    sessionId: transition.sessionId,
    seq: transition.seq,
    from: transition.from,
    to: transition.to,
    activity: transition.activity,
    entryId: transition.entryId,
    cause: { kind: transition.cause.kind, event: transition.cause.event, detail: transition.cause.detail },
    where: transition.where,
    correlationId: transition.correlationId,
  };
}

/**
 * Read a stored transition back.
 *
 * A lost or unrecognised cause is a refusal. Both halves are checked independently — the same way
 * the machine validates them — because a cause that survived as a shape but not as a declared value
 * is a record a reader would branch on wrongly.
 */
export function decodeTransition(entry: TranscriptEntry): Result<SessionTransition> {
  if (entry.type !== TRANSITION_ENTRY_TYPE) {
    return refuse<SessionTransition>(
      'transcript-entry-malformed',
      `not a transition entry: type ${entry.type}`,
    );
  }

  const cause = entry['cause'];
  if (cause === null || typeof cause !== 'object' || Array.isArray(cause)) {
    return refuse<SessionTransition>('transcript-entry-malformed', 'the transition carries no cause');
  }
  const { kind, event, detail } = cause as Record<string, unknown>;
  if (typeof kind !== 'string' || !isCauseKind(kind)) {
    return refuse<SessionTransition>(
      'transcript-entry-malformed',
      `the cause kind is not a declared kind: ${String(kind)}`,
    );
  }
  if (typeof event !== 'string' || !isCauseEvent(event)) {
    return refuse<SessionTransition>(
      'transcript-entry-malformed',
      `the cause event is not a declared event: ${String(event)}`,
    );
  }

  const seq = entry['seq'];
  if (typeof seq !== 'number' || !Number.isFinite(seq)) {
    return refuse<SessionTransition>('transcript-entry-malformed', 'the transition carries no seq');
  }
  const where = entry['where'];
  if (where === null || typeof where !== 'object') {
    return refuse<SessionTransition>('transcript-entry-malformed', 'the transition carries no where');
  }

  return ok({
    sessionId: (entry['sessionId'] as string | null) ?? null,
    seq,
    at: typeof entry.timestamp === 'string' ? entry.timestamp : '',
    from: entry['from'] as SessionTransition['from'],
    to: entry['to'] as SessionTransition['to'],
    activity: (entry['activity'] as SessionTransition['activity']) ?? null,
    entryId: (entry['entryId'] as string | null) ?? null,
    cause: { kind, event, detail: typeof detail === 'string' ? detail : '' },
    where: where as SessionTransition['where'],
    correlationId: (entry['correlationId'] as string | null) ?? null,
  });
}

/**
 * A record that an open entry was abandoned.
 *
 * This is an append, not an edit, and that is the whole design. The entry it refers to stays
 * exactly as it was written, with the time it opened and the cause that opened it. A reader
 * assembling the two sees "opened at X, still open at Y, marked abandoned because Z" — which is the
 * signal. Rewriting the original would leave "closed", which is the signal's opposite and is
 * indistinguishable from an ordinary completion.
 */
export function markAbandoned(entry: OpenEntry, at: string, reason: string): TranscriptEntry {
  return {
    type: ABANDONED_ENTRY_TYPE,
    uuid: `abandoned:${entry.entryId}:${at}`,
    timestamp: at,
    entryId: entry.entryId,
    activity: entry.activity,
    lane: entry.lane,
    openedAt: entry.openedAt,
    agentId: entry.agentId,
    reason,
    cause: { kind: entry.cause.kind, event: entry.cause.event, detail: entry.cause.detail },
  };
}

/** Every stored transition in an entry list, in stored order. Non-transition entries are ignored. */
export function transitionsIn(entries: readonly TranscriptEntry[]): Result<SessionTransition[]> {
  const found: SessionTransition[] = [];
  for (const entry of entries) {
    if (entry.type !== TRANSITION_ENTRY_TYPE) continue;
    const decoded = decodeTransition(entry);
    if (!decoded.ok) return refuse<SessionTransition[]>(decoded.refusal.reason, decoded.refusal.detail);
    found.push(decoded.value);
  }
  return ok(found);
}

/** Every abandonment mark in an entry list, by the entry id it refers to. */
export function abandonmentsIn(entries: readonly TranscriptEntry[]): Map<string, TranscriptEntry> {
  const marks = new Map<string, TranscriptEntry>();
  for (const entry of entries) {
    if (entry.type !== ABANDONED_ENTRY_TYPE) continue;
    const entryId = entry['entryId'];
    if (typeof entryId === 'string') marks.set(entryId, entry);
  }
  return marks;
}

/**
 * A stable uuid for one transition, so a re-append is deduplicated rather than doubled.
 *
 * Derived, not minted. The adapter contract treats `uuid` as an idempotency key, and a mirror
 * retries. A random id would make every retry a new row, so the same transition written twice must
 * carry the same id — and a session's `seq` is dense from 1 per machine, which makes the pair
 * unique without inventing anything.
 */
export function transitionUuid(transition: SessionTransition): string {
  return `transition:${transition.sessionId ?? 'unidentified'}:${transition.correlationId ?? '-'}:${transition.seq}`;
}
