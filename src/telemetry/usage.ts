/**
 * What a turn cost — consumed from what the agent reports, never computed from a price table.
 *
 * The whole point is that nothing here multiplies tokens by a rate. A host that keeps a per-model
 * price table and does the arithmetic itself has two failure modes, and both are silent: a price
 * changes and every historical figure is quietly wrong, and a mixed-model turn is costed at one
 * model's rate because the table is keyed by "the session's model". The agent already reports a
 * per-model cost, with the provider and the canonical id it priced against. So this reads.
 *
 * How that is actually proven, because "it only reads" is easy to claim and easy to regress: the
 * tests feed a cost no price table could ever produce and assert it comes out unchanged. A
 * reimplementation that started computing would have to reproduce an arbitrary number to stay green.
 *
 * No SDK types here. This is the model the layer above works in; `host/telemetry.ts` lifts it off
 * the agent's own result message, the same way `readInitFacts` lifts the version receipt.
 */

/** What one model cost. Every number is reported, none derived. */
export interface ModelSpend {
  /** The model string the agent was keyed by — provider-specific ids and aliases included. */
  readonly model: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  /**
   * Thinking tokens, already counted inside `outputTokens`. Null when the agent did not report them,
   * never zero.
   *
   * Optional in the type, and so is `costBasis`, because a consumer builds these too (a seed for
   * `deltaSpend`, a fixture) and a member added in a minor release must not break that code. A value
   * this package produces always carries both.
   */
  readonly thinkingTokens?: number | null;
  /**
   * Which prices `costUsd` came from: the agent's built-in list prices (`list`), an organization's
   * managed pricing (`managed`), or neither (`unknown`: no price matched the model, so the figure is
   * a guess at the default model's rate). Null when the agent did not say, which its own contract
   * reads as `list`. A consumer quoting money checks this before it trusts `costUsd`.
   */
  readonly costBasis?: 'list' | 'managed' | 'unknown' | null;
  /** The window this model was serving with. Absent is null, never zero. */
  readonly contextWindow: number | null;
  /** The id the agent priced against, when it differs from `model`. */
  readonly canonicalModel: string | null;
  /** Which API served it, when reported. */
  readonly provider: string | null;
}

/**
 * The spend a result reports: a running total, not one turn's cost.
 *
 * The agent's accounting fields accumulate across the turns of a session, and across a resume or a
 * fork, which continues from the totals its transcript saved; a `/clear` resets them. Two results are
 * two readings of one meter, and `deltaSpend` turns a pair of them into the spend between them.
 * Folding results' own figures sums running totals and multiplies the spend.
 */
export interface TurnSpend {
  /** The agent's own total. Not the sum of `byModel` — see `spendReconciles`. */
  readonly totalCostUsd: number;
  readonly byModel: readonly ModelSpend[];
}

/** Spend accumulated across turns. */
export interface SpendTotal {
  readonly totalCostUsd: number;
  readonly turnCount: number;
  /** Per model, summed across every turn folded in. */
  readonly byModel: readonly ModelSpend[];
}

export const NO_SPEND: SpendTotal = { totalCostUsd: 0, turnCount: 0, byModel: [] };

/**
 * Add one turn's spend to a running total.
 *
 * Fold deltas, as `deltaSpend` produces them, never a result's own figures: a result already
 * reports a running total, and summing those multiplies the spend.
 *
 * Models are merged by their reported key, not by the canonical id. Two entries keyed differently
 * that price against one canonical model are genuinely two things the agent distinguished — an alias
 * and a provider-specific id can bill differently — and collapsing them here would throw away the
 * distinction the report was making.
 */
export function foldSpend(prev: SpendTotal, turn: TurnSpend): SpendTotal {
  const byModel = new Map<string, ModelSpend>();
  for (const spend of prev.byModel) byModel.set(spend.model, spend);

  for (const spend of turn.byModel) {
    const existing = byModel.get(spend.model);
    byModel.set(
      spend.model,
      existing === undefined
        ? spend
        : {
            ...existing,
            costUsd: existing.costUsd + spend.costUsd,
            inputTokens: existing.inputTokens + spend.inputTokens,
            outputTokens: existing.outputTokens + spend.outputTokens,
            cacheReadInputTokens: existing.cacheReadInputTokens + spend.cacheReadInputTokens,
            cacheCreationInputTokens: existing.cacheCreationInputTokens + spend.cacheCreationInputTokens,
            thinkingTokens: sumOrNull(existing.thinkingTokens, spend.thinkingTokens),
            // Last report wins: these describe the model, not the usage, and the newest is truest.
            // The price basis is per request too, so the newest says what the latest spend used.
            costBasis: spend.costBasis ?? existing.costBasis ?? null,
            contextWindow: spend.contextWindow ?? existing.contextWindow,
            canonicalModel: spend.canonicalModel ?? existing.canonicalModel,
            provider: spend.provider ?? existing.provider,
          },
    );
  }

  return {
    totalCostUsd: prev.totalCostUsd + turn.totalCostUsd,
    turnCount: prev.turnCount + 1,
    byModel: [...byModel.values()],
  };
}

/**
 * A cost difference smaller than this is float noise, not a drop. Costs are sums of fractions of a
 * cent, and the meter the agent keeps never runs backwards on its own.
 */
const COST_NOISE_USD = 1e-9;

/**
 * The spend between two results of one session: `next` minus `previous`, per model.
 *
 * A result reports running totals, so this is how one turn's spend is read. A drop in any counter
 * means the meter was reset (a `/clear`, or a new process): a new series began, and the delta is
 * `next` whole, because everything it reports was spent since the reset. A model that `previous`
 * reported and `next` does not is read the same way. A model new in `next` is its full figures.
 *
 * `previous` is null for a session's first result. Resumed and forked sessions are the case to get
 * right: their first result continues from the totals the parent's transcript saved. Seed
 * `previous` with the parent session's last result and the delta is only the new spend. Seed it
 * with null and the delta is the carried total, which counts the parent's spend a second time for
 * any consumer that has already folded the parent.
 *
 * The descriptors (`contextWindow`, `canonicalModel`, `provider`, `costBasis`) are `next`'s: they are
 * overwritten per request, so the newest describes the spend being read.
 */
export function deltaSpend(previous: TurnSpend | null, next: TurnSpend): TurnSpend {
  if (previous === null || startsNewSeries(previous, next)) return next;
  const before = new Map(previous.byModel.map((spend) => [spend.model, spend] as const));
  return {
    totalCostUsd: Math.max(0, next.totalCostUsd - previous.totalCostUsd),
    byModel: next.byModel.map((spend) => {
      const prior = before.get(spend.model);
      return prior === undefined ? spend : subtract(spend, prior);
    }),
  };
}

/** Whether `next` is a reading of a meter that was reset after `previous`. */
function startsNewSeries(previous: TurnSpend, next: TurnSpend): boolean {
  if (next.totalCostUsd < previous.totalCostUsd - COST_NOISE_USD) return true;
  const after = new Map(next.byModel.map((spend) => [spend.model, spend] as const));
  return previous.byModel.some((prior) => {
    const now = after.get(prior.model);
    if (now === undefined) return true;
    return (
      now.costUsd < prior.costUsd - COST_NOISE_USD ||
      now.inputTokens < prior.inputTokens ||
      now.outputTokens < prior.outputTokens ||
      now.cacheReadInputTokens < prior.cacheReadInputTokens ||
      now.cacheCreationInputTokens < prior.cacheCreationInputTokens ||
      (typeof now.thinkingTokens === 'number' &&
        typeof prior.thinkingTokens === 'number' &&
        now.thinkingTokens < prior.thinkingTokens)
    );
  });
}

/** One model's reading minus its earlier reading, the descriptors taken from the newer one. */
function subtract(next: ModelSpend, prior: ModelSpend): ModelSpend {
  return {
    ...next,
    costUsd: Math.max(0, next.costUsd - prior.costUsd),
    inputTokens: next.inputTokens - prior.inputTokens,
    outputTokens: next.outputTokens - prior.outputTokens,
    cacheReadInputTokens: next.cacheReadInputTokens - prior.cacheReadInputTokens,
    cacheCreationInputTokens: next.cacheCreationInputTokens - prior.cacheCreationInputTokens,
    thinkingTokens:
      typeof next.thinkingTokens !== 'number'
        ? null
        : next.thinkingTokens - (typeof prior.thinkingTokens === 'number' ? prior.thinkingTokens : 0),
  };
}

/** A sum where an unreported side is unknown rather than zero: null only when neither was reported. */
function sumOrNull(left: number | null | undefined, right: number | null | undefined): number | null {
  if (typeof left !== 'number' && typeof right !== 'number') return null;
  return (typeof left === 'number' ? left : 0) + (typeof right === 'number' ? right : 0);
}

/**
 * Whether a turn's per-model costs add up to the total the agent reported.
 *
 * It is an observation, not a validation, and must not become one. Both numbers come from the
 * agent; a mismatch means the agent counted something the per-model breakdown does not itemise, and
 * that is the agent's business rather than a defect this host should refuse over. The reason to
 * expose it is that a caller charging money wants to know which of the two it is quoting, and
 * whether they agree.
 *
 * @param toleranceUsd absolute, because these are floats and an exact comparison would fail on
 *                     arithmetic that is otherwise perfectly correct.
 */
export function spendReconciles(turn: TurnSpend, toleranceUsd = 1e-9): boolean {
  const summed = turn.byModel.reduce((total, spend) => total + spend.costUsd, 0);
  return Math.abs(summed - turn.totalCostUsd) <= toleranceUsd;
}

/** How a rate limit currently stands, as the agent reports it. */
export interface RateLimitStanding {
  readonly status: 'allowed' | 'allowed_warning' | 'rejected';
  /** Epoch seconds, as reported. Null when the agent did not say. */
  readonly resetsAt: number | null;
  readonly limitType: string | null;
  /** 0–1 where reported, else null. Never defaulted to 0 — that would read as "plenty left". */
  readonly utilization: number | null;
}
