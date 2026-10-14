/**
 * What every live test of a runtime driven by a process of its own needs: a reader of the process's
 * messages that never drops one, a close that waits for the process to let go of its directory, and a
 * scratch directory's removal that never throws over the test's own result.
 */
import { rmSync } from 'node:fs';

/** A receipt line's writer, the test's own record of what was measured. */
export type Receipt = (what: string, data: Record<string, unknown>) => void;

/**
 * One process's messages, read in order. A read that outlives a wait is kept for the next wait, never
 * abandoned: an async generator hands its next message to the oldest read asked of it, so a read dropped
 * at a timeout would swallow a message.
 */
export class LiveStream<M> {
  readonly seen: M[] = [];
  ended = false;
  error: string | null = null;
  readonly #iterator: AsyncIterator<M>;
  #pending: Promise<IteratorResult<M> | 'failed'> | null = null;

  constructor(messages: AsyncIterable<M>) {
    this.#iterator = messages[Symbol.asyncIterator]();
  }

  /** Read until `done` holds, the stream ends, or `ms` passes; whether `done` holds. */
  async until(done: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!done() && !this.ended && Date.now() < deadline) {
      this.#pending ??= this.#iterator.next().catch((error: unknown) => {
        this.error = String(error);
        return 'failed' as const;
      });
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const next = await Promise.race([
        this.#pending,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), Math.max(1, Math.min(1000, deadline - Date.now())));
        }),
      ]);
      clearTimeout(timer);
      if (next === null) continue;
      this.#pending = null;
      if (next === 'failed' || next.done === true) {
        this.ended = true;
        break;
      }
      this.seen.push(next.value);
    }
    return done();
  }
}

/**
 * Close a process and wait for its stream to end, which it does once the process has exited: a
 * directory it ran in is not removed while it still holds it.
 */
export async function closeAndWait<M>(
  process: { close(): void },
  stream: LiveStream<M>,
  receipt: Receipt,
): Promise<void> {
  process.close();
  await stream.until(() => false, 30_000);
  receipt('closed', { ended: stream.ended, error: stream.error });
}

/**
 * Remove a scratch directory, retrying while a process that ran in it lets go. A removal that still
 * fails is a receipt, never a throw: it must not stand in for the test's own result.
 */
export function removeScratch(dir: string, receipt: Receipt): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    receipt('scratch directory left behind', { dir, error: String(error) });
  }
}
