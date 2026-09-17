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

/** What one model cost within a turn. Every number is reported, none derived. */
export interface ModelSpend {
  /** The model string the agent was keyed by — provider-specific ids and aliases included. */
  readonly model: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  /** The window this model was serving with. Absent is null, never zero. */
  readonly contextWindow: number | null;
  /** The id the agent priced against, when it differs from `model`. */
  readonly canonicalModel: string | null;
  /** Which API served it, when reported. */
  readonly provider: string | null;
}

/** One turn's spend. */
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
 * Add one turn to a running total.
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
            // Last report wins: these describe the model, not the usage, and the newest is truest.
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
