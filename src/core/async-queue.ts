/**
 * A single-consumer async queue: push values in, iterate them out, close when there are no more.
 *
 * It exists because a session's input has to be an `AsyncIterable` before the first turn is known —
 * the agent process is started with a stream it will read from later, and the control surface
 * (interrupt, model change, permission mode) is only available to a session driven that way. A
 * plain string prompt would ship a session that cannot be interrupted.
 *
 * Pure and generic on purpose: nothing here knows what a message is, so it is testable without a
 * process and reusable by anything else that needs the same shape.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiting: ((result: IteratorResult<T>) => void)[] = [];
  readonly #capacity: number;
  #ended = false;

  /**
   * `capacity` bounds what waits for the consumer; `Infinity` is the unbounded queue. A value a
   * peer can grow must have one: an unbounded per-handle buffer is the shape this package refuses
   * everywhere else, and the live prompt queue was the one place it had none.
   */
  constructor(capacity: number = Number.POSITIVE_INFINITY) {
    this.#capacity = capacity;
  }

  /**
   * Hand a value to the consumer, or hold it until one asks. False when the queue has ended or
   * holds `capacity` items already — the item was not taken, and the caller says so.
   */
  push(item: T): boolean {
    if (this.#ended) return false;
    const waiter = this.#waiting.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return true;
    }
    if (this.#items.length >= this.#capacity) return false;
    this.#items.push(item);
    return true;
  }

  /**
   * No more values. Idempotent, and it releases every waiting consumer rather than leaving them
   * hanging — an iterator that never returns is indistinguishable from a session that never ends.
   */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    while (this.#waiting.length > 0) {
      this.#waiting.shift()?.({ value: undefined, done: true });
    }
  }

  /** Values pushed but not yet taken. */
  get depth(): number {
    return this.#items.length;
  }

  get ended(): boolean {
    return this.#ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.#waiting.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
