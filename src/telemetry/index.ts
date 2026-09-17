/**
 * Usage, cost and rate-limit facts — consumed from what the agent reports, never recomputed.
 *
 * There is no price table in this package and there must not be one. The agent reports a cost per
 * model, with the provider and the id it priced against, so a mixed-model turn is correct without
 * this host knowing any rate. A table would be wrong twice over and silently: stale the moment a
 * price moves, and blind to a turn that used more than one model.
 */
export type { ModelSpend, RateLimitStanding, SpendTotal, TurnSpend } from './usage.js';
export { NO_SPEND, foldSpend, spendReconciles } from './usage.js';
