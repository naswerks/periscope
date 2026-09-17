/**
 * A per-key serial executor: work submitted under one key runs one piece at a time, in arrival
 * order; work under different keys interleaves freely.
 *
 * It exists because the host's workspace verbs are fire-and-forget concurrent (`#dispatch` never
 * awaits a handler) while the work they do takes seconds and is mutually destructive on one key:
 * a `git worktree add` and a `git worktree remove --force` each take many seconds, and the
 * reachable interleavings are real — a provision landing inside a removal, a removal landing inside
 * a close's release. Serializing per key closes every one of those windows without making
 * unrelated workspaces wait on each other.
 *
 * Pure and generic on purpose: nothing here knows what a workspace is, so it is testable without
 * a provider and reusable by anything else that needs the same shape.
 */
export class KeyedTurns {
  /** The tail of each key's queue — the promise the next submission must wait behind. */
  readonly #tails = new Map<string, Promise<unknown>>();

  /**
   * Run `work` after everything previously submitted under `key` has settled.
   *
   * The returned promise carries `work`'s own result or rejection. A rejection does not poison the
   * key: the next submission runs regardless, because a failed removal must not wedge every future
   * provision at that key behind an error nobody can clear.
   */
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const turn = previous.then(work, work);
    // The tail entry is removed when this turn settles with nothing queued behind it. The map
    // identity check is what makes the cleanup safe under concurrent submission: a newer tail
    // means a later submission queued behind this one, and the entry is now that one's to clean up.
    const tail = turn.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return turn;
  }

  /** Keys with unsettled work — an observability convenience, never a guard. */
  get depth(): number {
    return this.#tails.size;
  }
}
