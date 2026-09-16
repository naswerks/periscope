/**
 * What this host can say about the sessions it is holding.
 *
 * This is not a roster, and the distinction is not pedantry. A roster spans every session
 * everywhere — and sessions run on different hosts, because an agent runs where its host runs. No
 * single host can produce one; it can only produce its own row. A controller aggregates these into
 * the thing people actually want.
 *
 * So this offers enumeration and nothing else: no filtering, no search, no notion of which sessions
 * are interesting, no "who is stuck". Every one of those is a judgement, and a host that makes
 * judgements is a host that has to be rebuilt for the next product. If this file grows a predicate,
 * the line has been crossed.
 *
 * What it does owe: the open-entry age. A session that has been in one tool call for forty
 * minutes is the single most useful thing this layer can report, and the age is what says so.
 */
import type { AgedEntry, SessionSnapshot } from './model.js';
import type { SessionStateMachine } from './machine.js';

export class SessionStateReporter {
  readonly #machines = new Set<SessionStateMachine>();

  /** Start reporting a session. Idempotent. */
  add(machine: SessionStateMachine): void {
    this.#machines.add(machine);
  }

  /**
   * Stop reporting a session.
   *
   * A caller that removes an ended session loses its open-entry evidence from this view. That is
   * the caller's decision to make and it is not made here: nothing self-evicts, because a session
   * that ended holding work is exactly the one somebody will want to look at.
   */
  remove(machine: SessionStateMachine): void {
    this.#machines.delete(machine);
  }

  get count(): number {
    return this.#machines.size;
  }

  /** Every session this host holds. Raw material — see this file's header. */
  list(): SessionSnapshot[] {
    return [...this.#machines].map((machine) => machine.snapshot());
  }

  /**
   * Every entry that has not exited, across this host's sessions, with its age and its session.
   *
   * Reported, never reconciled: an unpaired entry is surfaced with how long it has been open and
   * whether it was marked abandoned, and nothing here closes one. Cleanup may mark; it may not
   * erase, because erasing destroys the only evidence that the thing happened at all.
   */
  openEntries(): (AgedEntry & { readonly sessionId: string | null })[] {
    return [...this.#machines].flatMap((machine) =>
      machine.openEntries().map((entry) => ({ ...entry, sessionId: machine.sessionId })),
    );
  }
}
