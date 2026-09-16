/**
 * The retention buffer between producers and the wire.
 *
 * Bounded, because an unbounded buffer is an out-of-memory kill in a process whose whole job is to
 * still be running when the controller comes back. Bounded means something gets dropped, and which
 * thing is a decision rather than an accident: see DROPPABLE_KINDS in frames.ts.
 *
 * Entries live in one of two states, and the split is what keeps the wire's numbering dense:
 *   - pending: accepted for delivery, not yet written. It has no `seq` and never had one, so
 *     discarding it costs the content and nothing else.
 *   - written: stamped with its `seq` at the moment of its first socket write, and held until the
 *     controller acknowledges it. A written frame is never discarded here: it may already be at the
 *     receiver, so forgetting it would break replay's completeness. Only an ack (`pruneUpTo`) or
 *     session end (`forget`) releases it.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { SessionFrame, SessionPayload, SessionPayloadKind } from './frames.js';
import { isDroppable } from './frames.js';

export interface QueueStats {
  readonly depth: number;
  /** Of `depth`, how many entries are still waiting for their first write. */
  readonly pendingDepth: number;
  readonly capacity: number;
  /** Deltas discarded under pressure. Expected under load; worth watching, not alarming. */
  readonly droppedDroppable: number;
  /** Frames that could not be held and could not be dropped. Always a real problem. */
  readonly refusedUndroppable: number;
}

/** What an admission displaced, when it displaced anything. Named so the caller can say it out loud. */
export interface EvictedPending {
  readonly sessionId: string;
  readonly kind: SessionPayloadKind;
}

export interface QueueAdmission {
  /** The pending droppable discarded to make room, or null when nothing was displaced. */
  readonly evicted: EvictedPending | null;
}

/** Builds the frame for a pending entry at the moment it is written. The caller supplies the seq. */
export type StampFrame = (sessionId: string, at: string, payload: SessionPayload) => SessionFrame;

interface PendingEntry {
  readonly written: false;
  readonly sessionId: string;
  readonly at: string;
  readonly payload: SessionPayload;
}

interface WrittenEntry {
  readonly written: true;
  readonly frame: SessionFrame;
}

type HeldEntry = PendingEntry | WrittenEntry;

export class BoundedFrameQueue {
  /**
   * Written entries are a prefix and pending entries the suffix: a push appends, a stamp converts the
   * first pending entry in place, and every removal keeps the two runs contiguous. `#writtenCount` is
   * the boundary, so the next entry to stamp is found without a scan and a prune reads only the
   * written run.
   */
  readonly #entries: HeldEntry[] = [];
  #writtenCount = 0;
  readonly #capacity: number;
  #droppedDroppable = 0;
  #refusedUndroppable = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`queue capacity must be a positive integer, got ${capacity}`);
    }
    this.#capacity = capacity;
  }

  /**
   * Admit a payload for delivery. It enters pending, with no `seq`.
   *
   * At capacity the order of preference is: discard the incoming payload if it is droppable; else
   * discard the oldest pending droppable to make room; else refuse, loudly. Refusing is the honest
   * end of the ladder, because the alternative is discarding a transition or a receipt and
   * reporting success, which is a lie about what the session did. Written frames are never
   * candidates: a frame that has touched the wire may already be at the receiver, and the numbering
   * stays dense only because nothing numbered is ever quietly withdrawn.
   */
  push(sessionId: string, at: string, payload: SessionPayload): Result<QueueAdmission> {
    if (this.#entries.length < this.#capacity) {
      this.#entries.push({ written: false, sessionId, at, payload });
      return ok({ evicted: null });
    }

    if (isDroppable(payload.kind)) {
      this.#droppedDroppable += 1;
      return refuse(
        'queue-dropped-droppable',
        `queue full at ${this.#capacity}; discarded an incoming ${payload.kind}`,
      );
    }

    let victim = -1;
    for (let index = this.#writtenCount; index < this.#entries.length; index += 1) {
      const entry = this.#entries[index] as PendingEntry;
      if (isDroppable(entry.payload.kind)) {
        victim = index;
        break;
      }
    }
    if (victim >= 0) {
      const evicted = this.#entries[victim] as PendingEntry;
      this.#entries.splice(victim, 1);
      this.#droppedDroppable += 1;
      this.#entries.push({ written: false, sessionId, at, payload });
      return ok({ evicted: { sessionId: evicted.sessionId, kind: evicted.payload.kind } });
    }

    this.#refusedUndroppable += 1;
    return refuse(
      'queue-overflow-undroppable',
      `queue full at ${this.#capacity} with nothing droppable to discard; cannot hold ` +
        `${payload.kind} for session ${sessionId}`,
    );
  }

  /**
   * Stamp the oldest pending entry and hand back its frame for the write.
   *
   * Stamping and writing are one act: the entry becomes written before the caller touches the
   * socket, so however the write itself goes, a stamped frame is retained and replayable — a seq,
   * once minted, is always accounted for. Returns null when nothing is pending.
   */
  stampNext(stamp: StampFrame): SessionFrame | null {
    const index = this.#writtenCount;
    const pending = this.#entries[index];
    if (pending === undefined || pending.written) return null;
    const frame = stamp(pending.sessionId, pending.at, pending.payload);
    this.#entries[index] = { written: true, frame };
    this.#writtenCount += 1;
    return frame;
  }

  /** Every written frame still held, oldest first — what replay re-sends after a reconnect. */
  writtenFrames(): readonly SessionFrame[] {
    return this.#entries.filter((entry): entry is WrittenEntry => entry.written).map((entry) => entry.frame);
  }

  get hasPending(): boolean {
    return this.#writtenCount < this.#entries.length;
  }

  /**
   * Forget frames the controller has confirmed, per session.
   *
   * This is what bounds the retention window. Frames are held after being written, because a frame
   * in flight when the socket dies is exactly the one replay has to produce — so "sent" is not
   * "safe to forget"; only an ack is.
   */
  pruneUpTo(sessionId: string, seq: number): number {
    return this.#removeWritten((frame) => frame.sessionId === sessionId && frame.seq <= seq);
  }

  /** One pass over the written run, keeping what the predicate does not name; the pending run is untouched. */
  #removeWritten(remove: (frame: SessionFrame) => boolean): number {
    const kept: HeldEntry[] = [];
    for (let index = 0; index < this.#writtenCount; index += 1) {
      const held = this.#entries[index] as WrittenEntry;
      if (!remove(held.frame)) kept.push(held);
    }
    const removed = this.#writtenCount - kept.length;
    if (removed > 0) {
      this.#entries.splice(0, this.#writtenCount, ...kept);
      this.#writtenCount = kept.length;
    }
    return removed;
  }

  /** One pass over the pending run, keeping what the predicate does not name; the written run is untouched. */
  #removePending(remove: (entry: PendingEntry) => boolean): number {
    const kept: HeldEntry[] = [];
    for (let index = this.#writtenCount; index < this.#entries.length; index += 1) {
      const held = this.#entries[index] as PendingEntry;
      if (!remove(held)) kept.push(held);
    }
    const removed = this.#entries.length - this.#writtenCount - kept.length;
    if (removed > 0)
      this.#entries.splice(this.#writtenCount, this.#entries.length - this.#writtenCount, ...kept);
    return removed;
  }

  /**
   * Drop a session's pending entries at session end. Written-and-unacked frames are kept.
   *
   * Two rules collide here and this is which one wins. "Nothing keyed by a session outlives it"
   * bounds a long-running host; "a transition is never dropped" is what makes the trace true. At
   * session end they meet, because the last frames a session produces (its `-> ended` transition,
   * the result that preceded it) are exactly the ones still unacked if the link happens to be
   * down. Dropping them would lose the record of how a session ended, silently, in precisely the
   * case somebody is going to ask about. So the never-drop rule wins for anything stamped.
   *
   * This does not reopen the unbounded problem: a written frame is retained only until the
   * controller acks it, and an ended session produces no more frames — so what is kept is a fixed,
   * already-bounded set that the next `link_ack` prunes to nothing. Pending entries are dropped
   * because they never touched the wire and never had a seq: nothing on the other side is waiting
   * for them, and there is no hole for them to leave.
   *
   * Returns how many entries were dropped.
   */
  forget(sessionId: string): number {
    return this.#removePending((entry) => entry.sessionId === sessionId);
  }

  /**
   * Drop everything this session holds, written frames included. Returns how many were written.
   *
   * This is the one method here that discards a stamped frame, and it exists for a bound rather
   * than for convenience. `forget` deliberately keeps written-and-unacked frames because a
   * session's last frames are the ones replay has to produce; `pruneUpTo` releases them on an ack.
   * Neither has a bound, and nothing in the protocol obliges a peer to ack, so an ended session
   * nobody acks is held forever, and written frames are never eviction candidates, so those holds
   * accumulate until the queue refuses live traffic.
   *
   * Call this only for an ended session past its retention bound, and never as a tidy-up: for a
   * live session this reintroduces the permanent-hole defect the whole retention window exists to
   * prevent. `link.ts`'s sweep is the only caller, and it names what it dropped on the refusal lane.
   */
  releaseSession(sessionId: string): number {
    this.#removePending((entry) => entry.sessionId === sessionId);
    return this.#removeWritten((frame) => frame.sessionId === sessionId);
  }

  /** How many written-but-unacked frames this session still holds. Zero once the controller acks. */
  retainedFor(sessionId: string): number {
    return this.#entries.filter((entry) => entry.written && entry.frame.sessionId === sessionId).length;
  }

  get stats(): QueueStats {
    return {
      depth: this.#entries.length,
      pendingDepth: this.#entries.length - this.#writtenCount,
      capacity: this.#capacity,
      droppedDroppable: this.#droppedDroppable,
      refusedUndroppable: this.#refusedUndroppable,
    };
  }
}
