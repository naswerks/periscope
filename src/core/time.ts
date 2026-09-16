/**
 * Time as an injected capability, so anything that stamps a frame is testable without waiting.
 * The one real clock is built in the composition root and threaded down.
 */

/** Returns the current instant as an ISO-8601 UTC string — the `at` on every frame. */
export type Clock = () => string;

/** Milliseconds since the epoch, for elapsed-time arithmetic (deadlines, backoff, heartbeat). */
export type Ticker = () => number;

export const systemClock: Clock = () => new Date().toISOString();

export const systemTicker: Ticker = () => Date.now();

/** A clock that advances only when told to. */
export function fixedClock(startMs: number): Clock & { advance: (ms: number) => void } {
  let now = startMs;
  const clock = (() => new Date(now).toISOString()) as Clock & { advance: (ms: number) => void };
  clock.advance = (ms: number) => {
    now += ms;
  };
  return clock;
}

/** A ticker that advances only when told to. Pairs with `fixedClock` for deadline tests. */
export function fixedTicker(startMs: number): Ticker & { advance: (ms: number) => void } {
  let now = startMs;
  const ticker = (() => now) as Ticker & { advance: (ms: number) => void };
  ticker.advance = (ms: number) => {
    now += ms;
  };
  return ticker;
}
