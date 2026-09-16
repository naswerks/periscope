/**
 * Where recorded transitions are kept, and where anyone asking "what happened?" reads from.
 *
 * Separate from the machine on purpose. A machine that both emitted and answered questions about
 * itself would let a test prove emission by asking the thing that emitted — the assertion and the
 * subject would be the same object. This subscribes, so "no transition without a cause" is checked
 * against what was actually retained rather than against what a call site claims it passed.
 *
 * Bounded, in memory, and not durable. It holds a window per session so a long-running host does
 * not grow without limit; durability of the transition log belongs to the persistence layer, and
 * this deliberately does not pretend to be it. `dropped` counts what fell out of the window rather
 * than letting a full ring look like a quiet one.
 */
import type { SessionTransition } from './model.js';
import type { RejectedTransition, SessionStateMachine, Unsubscribe } from './machine.js';

/** Per session. A session that outruns this loses its oldest transitions, and says how many. */
const DEFAULT_WINDOW = 500;

export interface TransitionStoreOptions {
  readonly windowPerSession?: number;
}

/** Keyed while a session has no id yet — see SessionTransition.sessionId. */
const UNIDENTIFIED = '(unidentified)';

export class TransitionStore {
  readonly #window: number;
  readonly #bySession = new Map<string, SessionTransition[]>();
  readonly #rejected: RejectedTransition[] = [];
  #dropped = 0;
  #droppedRejections = 0;

  constructor(options: TransitionStoreOptions = {}) {
    this.#window = options.windowPerSession ?? DEFAULT_WINDOW;
  }

  /**
   * Retain everything one machine records, and everything it refuses.
   *
   * Both halves matter: a store that kept only the successes would answer "were all transitions
   * caused?" with a yes it earned by discarding the counter-examples.
   */
  attach(machine: SessionStateMachine): Unsubscribe {
    const dropTransitions = machine.onTransition((transition) => this.#retain(transition));
    const dropRejections = machine.onRejected((rejected) => {
      // Bounded on the same terms as the transitions, and for the same reason: a rejection arrives
      // from whatever drives the machine, and once that is a wire path the rate is a stranger's to
      // set. An uncapped array beside a capped ring would make the counter-examples the thing that
      // grows without limit — the one collection nobody thinks to watch.
      this.#rejected.push(rejected);
      while (this.#rejected.length > this.#window) {
        this.#rejected.shift();
        this.#droppedRejections += 1;
      }
    });
    return () => {
      dropTransitions();
      dropRejections();
    };
  }

  /**
   * One session's transitions, oldest first.
   *
   * Transitions recorded before the agent named itself are re-keyed when it does. They were
   * genuinely recorded without an id — that window is real — but leaving them in a separate bucket
   * would mean the trace of a session's own start could not be read by that session's id, which is
   * the one thing a reader has.
   */
  forSession(sessionId: string): readonly SessionTransition[] {
    return this.#bySession.get(sessionId) ?? [];
  }

  /** Transitions recorded while no session had reported itself yet, across every machine. */
  unidentified(): readonly SessionTransition[] {
    return this.#bySession.get(UNIDENTIFIED) ?? [];
  }

  /** Everything retained, across every session. The subject of the store-level assertions. */
  all(): SessionTransition[] {
    return [...this.#bySession.values()].flat();
  }

  sessionIds(): string[] {
    return [...this.#bySession.keys()].filter((key) => key !== UNIDENTIFIED);
  }

  /** Every refused transition still held, with why. Never summarised into a count alone. */
  rejected(): readonly RejectedTransition[] {
    return this.#rejected;
  }

  /** How many transitions fell out of a window. A full ring must not read as a quiet one. */
  get droppedCount(): number {
    return this.#dropped;
  }

  /**
   * How many rejections fell out of their window.
   *
   * Counted separately from `droppedCount` because the two mean opposite things: transitions
   * falling out is an ordinary busy session, rejections falling out means something is refusing
   * faster than anyone is reading, and collapsing them into one number would hide that.
   */
  get droppedRejectionCount(): number {
    return this.#droppedRejections;
  }

  #retain(transition: SessionTransition): void {
    const key = transition.sessionId ?? UNIDENTIFIED;
    this.#adopt(transition);

    const kept = this.#bySession.get(key) ?? [];
    kept.push(transition);
    while (kept.length > this.#window) {
      kept.shift();
      this.#dropped += 1;
    }
    this.#bySession.set(key, kept);
  }

  /** Move this machine's earlier, id-less transitions under the id it has just reported. */
  #adopt(transition: SessionTransition): void {
    const id = transition.sessionId;
    if (id === null) return;

    const orphans = this.#bySession.get(UNIDENTIFIED);
    if (orphans === undefined) return;

    // Only this machine's own: an id-less transition belongs to whichever machine produced the
    // seq series it sits in, and a machine's seq is dense from 1. Anything at or above this
    // transition's own seq cannot be its predecessor.
    const mine = orphans.filter((orphan) => orphan.seq < transition.seq && sameOrigin(orphan, transition));
    if (mine.length === 0) return;

    this.#bySession.set(
      UNIDENTIFIED,
      orphans.filter((orphan) => !mine.includes(orphan)),
    );
    const kept = this.#bySession.get(id) ?? [];
    this.#bySession.set(id, [...mine, ...kept]);
  }
}

/**
 * Whether two transitions came from the same machine, without either carrying a machine id.
 *
 * `where` is per-machine and fixed for its lifetime, and `correlationId` is whatever the controller
 * supplied for that one session — so together they distinguish two concurrent id-less starts unless
 * a controller starts two sessions in the same directory with no correlation id, in which case
 * their early transitions are genuinely indistinguishable and both are adopted. That is a truthful
 * outcome rather than a wrong one: nothing is lost, and nothing is invented to prevent it.
 */
function sameOrigin(left: SessionTransition, right: SessionTransition): boolean {
  return left.correlationId === right.correlationId && left.where.cwd === right.where.cwd;
}
