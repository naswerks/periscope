/**
 * `seq` accounting, used identically on both ends and in both directions.
 *
 * Outbound it hands out numbers; inbound it judges them. Symmetric on purpose: the controller's
 * commands get the same duplicate-suppression and gap-detection the host's events do, from one
 * implementation rather than two that can disagree.
 */
import type { SessionCursor } from './frames.js';

export type InboundCheck =
  /** In order. Deliver it. */
  | { readonly disposition: 'accept' }
  /** Already seen. Replay after a reconnect is expected, so this is normal and silent. */
  | { readonly disposition: 'duplicate'; readonly seq: number }
  /** Something was lost between the two ends. Loud: this is the condition replay exists to prevent. */
  | { readonly disposition: 'gap'; readonly expected: number; readonly received: number };

export class SeqTracker {
  readonly #lastBySession = new Map<string, number>();

  /** The next number to stamp on an outbound frame for this session. First is 1. */
  next(sessionId: string): number {
    const next = (this.#lastBySession.get(sessionId) ?? 0) + 1;
    this.#lastBySession.set(sessionId, next);
    return next;
  }

  /** The highest number issued or accepted so far, or 0 when the session is new. */
  last(sessionId: string): number {
    return this.#lastBySession.get(sessionId) ?? 0;
  }

  /**
   * Judge an inbound frame. Dense sequencing is what makes this arithmetic rather than a guess:
   * expected is always `last + 1`, so a gap needs no timestamps and no heuristics.
   */
  accept(sessionId: string, seq: number): InboundCheck {
    const last = this.last(sessionId);
    const expected = last + 1;

    if (seq === expected) {
      this.#lastBySession.set(sessionId, seq);
      return { disposition: 'accept' };
    }
    if (seq <= last) {
      return { disposition: 'duplicate', seq };
    }
    return { disposition: 'gap', expected, received: seq };
  }

  /** What this side holds, for the hello handshake and for resume after a drop. */
  cursors(): SessionCursor[] {
    return [...this.#lastBySession].map(([sessionId, seq]) => ({ sessionId, seq }));
  }

  /** Adopt a peer's cursors on reconnect, so replay starts from what it actually has. */
  adopt(cursors: readonly SessionCursor[]): void {
    for (const cursor of cursors) {
      this.#lastBySession.set(cursor.sessionId, cursor.seq);
    }
  }

  /**
   * Drop a session's counter at session end.
   *
   * Nothing keyed by session may outlive the session — an unbounded map is how a long-running host
   * dies of something nobody can attribute to any one session.
   */
  forget(sessionId: string): void {
    this.#lastBySession.delete(sessionId);
  }

  get trackedSessions(): number {
    return this.#lastBySession.size;
  }
}
