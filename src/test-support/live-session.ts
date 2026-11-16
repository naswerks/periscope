/**
 * What every live test of a runtime driven by a process of its own needs: a reader of the process's
 * messages that never drops one, a close that waits for the process to let go of its directory, and a
 * scratch directory's removal that never throws over the test's own result.
 */
import { execFileSync } from 'node:child_process';
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

/** How often a scratch directory's removal is tried, and how long it waits between tries. */
const SCRATCH_TRIES = 40;
const SCRATCH_WAIT_MS = 250;

/** Wait without yielding: a removal is a step of a test's own clean-up, in the order the test wrote it. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove a scratch directory, waiting while a process that ran in it lets go. A command a close has just
 * ended holds its working directory for a moment more, and on Windows a directory cannot be removed while
 * it is a process's working directory: the removal fails there at once, and the retry `rmSync` offers
 * does not wait that failure out. So the removal is tried again here, for up to ten seconds, and says in a
 * receipt when it had to wait and for how long. One that still fails then was held by something that
 * stayed, which is worth knowing: it is a receipt, never a throw, so it cannot stand in for the test's
 * own result.
 */
export function removeScratch(dir: string, receipt: Receipt): void {
  const began = Date.now();
  let failure: unknown = null;
  for (let tries = 1; tries <= SCRATCH_TRIES; tries += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      if (tries > 1)
        receipt('scratch directory removed after a wait', { dir, tries, ms: Date.now() - began });
      return;
    } catch (error) {
      failure = error;
      if (tries < SCRATCH_TRIES) pause(SCRATCH_WAIT_MS);
    }
  }
  receipt('scratch directory left behind', { dir, error: String(failure), ms: Date.now() - began });
}

/**
 * End each process a listing named, by the pid its line starts with, and on Windows what runs under it.
 * A probe that found a command still running after its session's close leaves none of it behind.
 */
export function endListed(lines: readonly string[]): void {
  for (const line of lines) {
    const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // Already gone.
    }
  }
}
