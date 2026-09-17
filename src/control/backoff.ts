/**
 * Reconnect delay: exponential, and jittered.
 *
 * The jitter is the load-bearing half. A controller restart drops every host at the same instant;
 * without jitter they all wait the same exponential delay and reconnect in lockstep, which knocks
 * the controller over again and does it harder on each round.
 */
export interface BackoffOptions {
  /** Floor, and the first attempt's ceiling. */
  readonly baseMs: number;
  /** Ceiling, however many attempts have failed. */
  readonly maxMs: number;
  /** Growth per attempt. */
  readonly factor: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
};

/**
 * The delay before attempt `attempt` (0-based, so 0 is the first retry).
 *
 * Jittered across the whole window above the floor rather than a fixed fraction of it, so two
 * hosts drawing from different streams separate on the first retry instead of converging.
 * `random` is injected: a caller that cannot control it cannot test that the spread exists.
 */
export function nextDelayMs(
  attempt: number,
  random: () => number,
  options: BackoffOptions = DEFAULT_BACKOFF,
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const uncapped = options.baseMs * Math.pow(options.factor, safeAttempt);
  const ceiling = Math.min(options.maxMs, uncapped);
  const span = Math.max(0, ceiling - options.baseMs);
  return Math.round(options.baseMs + random() * span);
}
