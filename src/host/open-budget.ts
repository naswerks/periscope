/**
 * One native session's open, bounded as a whole. Each step of the open is given what the open has left, at
 * most the step's own bound, so an open slower than its budget ends naming the step it was on. Every native
 * runtime's budget ends below its own start window (`openBudgetFor` in `sessions/runtimes.ts`), which ends
 * a session that has not reported itself; `sessions/registry.test.ts` holds each one below it.
 */

/** The least time a step is given: a step entered with nothing left still asks once, and ends at once. */
const MIN_STEP_MS = 1;

export class OpenBudget {
  readonly #runtime: string;
  readonly #totalMs: number;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #endsAt: number;
  #step: string | null = null;
  /** Whether the step entered last was given what the open had left rather than its own bound. */
  #cut = false;
  #finished = false;

  /** `runtime` is the runtime as the open's failure names it. The budget starts now. */
  constructor(runtime: string, totalMs: number, now: () => number = Date.now) {
    this.#runtime = runtime;
    this.#totalMs = totalMs;
    this.#now = now;
    this.#startedAt = now();
    this.#endsAt = this.#startedAt + totalMs;
  }

  /** Whether the open is still under way. */
  get open(): boolean {
    return !this.#finished;
  }

  /**
   * Enter `step`, and answer the time it may take: its own bound, or what the open has left when that is
   * less, and at least a millisecond.
   */
  enter(step: string, boundMs: number = this.#totalMs): number {
    this.#step = step;
    const left = this.#endsAt - this.#now();
    this.#cut = left <= boundMs;
    return Math.max(MIN_STEP_MS, Math.min(boundMs, left));
  }

  /**
   * Whether a step that ended unanswered (`timedOut`) ran the open's budget out: it was given what the open
   * had left. A step that met its own, shorter bound did not.
   */
  overran(timedOut: boolean): boolean {
    return timedOut && this.#cut;
  }

  /** The words for an open whose budget ran out on `step`, by default the step it entered last. */
  overrun(step: string | null = this.#step): string {
    return `the ${this.#runtime} open did not finish ${step ?? 'its start'} within ${this.#totalMs}ms`;
  }

  /** What the open is waiting on and how long it has run; null once it is over, or before its first step. */
  describe(): string | null {
    if (this.#finished || this.#step === null) return null;
    const seconds = Math.floor((this.#now() - this.#startedAt) / 1000);
    return `${this.#runtime} open: waiting on ${this.#step}, ${seconds}s in`;
  }

  /** The open is over, opened or not. */
  finish(): void {
    this.#finished = true;
  }

  /**
   * `promise` raced against the time `step` may take: what it settles with, or once that time passes a
   * rejection, an `OpenOverrun` when the open's budget is what ran out.
   */
  within<T>(promise: Promise<T>, step: string, boundMs: number = this.#totalMs): Promise<T> {
    const ms = this.enter(step, boundMs);
    const cut = this.#cut;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(cut ? new OpenOverrun(this.overrun(step)) : new Error(`${step} took longer than ${ms}ms`));
      }, ms);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }
}

/** An open that ran its whole budget out; its message is the words `OpenBudget.overrun` gives. */
export class OpenOverrun extends Error {}
