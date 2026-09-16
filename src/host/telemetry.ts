/**
 * Lifting cost and rate-limit facts off the agent's own stream.
 *
 * In `src/host/` because it names the SDK's message union, the same reason `readInitFacts` is there.
 * The layer above branches on plain records and never learns the SDK's shapes.
 *
 * What is deliberately absent, and it is not an oversight: two facts a dashboard wants,
 * `getContextUsage()` for the context ring and `accountInfo()` for the account's own limits, are
 * methods on the query object, and this package does not hand that object out: it is the narrowing
 * that keeps four mid-session permission mutators unreachable, and it is pinned. Reaching them means
 * either widening that narrowing or adding a named method beside `prompt` and `interrupt`, and both
 * are decisions above this file. Everything below arrives on the message stream, which this host
 * already has, so none of it costs that trade.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ModelSpend, RateLimitStanding, TurnSpend } from '../telemetry/usage.js';

/**
 * A turn's spend, or null for every message that is not a result.
 *
 * Every figure is copied, none computed. No token count is multiplied by anything here; the
 * agent priced the turn and this carries what it said. That is what makes a mixed-model turn correct
 * without this package holding a price table that would rot.
 */
export function readTurnSpend(message: SDKMessage): TurnSpend | null {
  if (message.type !== 'result') return null;

  const byModel: ModelSpend[] = Object.entries(message.modelUsage ?? {}).map(([model, usage]) => ({
    model,
    costUsd: usage.costUSD,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    // Absent is null rather than zero: a zero window reads as a real, tiny limit.
    contextWindow: usage.contextWindow ?? null,
    canonicalModel: usage.canonicalModel ?? null,
    provider: usage.provider ?? null,
  }));

  return { totalCostUsd: message.total_cost_usd, byModel };
}

/**
 * Where a rate limit stands, or null for every other message.
 *
 * It arrives in-stream, which is the part worth noticing: no unofficial endpoint has to be polled
 * to learn this. Nothing here polls anything.
 */
export function readRateLimit(message: SDKMessage): RateLimitStanding | null {
  if (message.type !== 'rate_limit_event') return null;
  const info = message.rate_limit_info;
  return {
    status: info.status,
    resetsAt: info.resetsAt ?? null,
    limitType: info.rateLimitType ?? null,
    utilization: info.utilization ?? null,
  };
}

/**
 * A subagent's own usage, off the task notification that reports it.
 *
 * This is what makes a subagent's cost attributable: the agent reports per-task usage, and hooks
 * carry an agent id, so spend has an owner without anything being inferred.
 */
export function readTaskSpend(message: SDKMessage): { agentId: string; spend: TurnSpend } | null {
  if (message.type !== 'system' || message.subtype !== 'task_notification') return null;

  const usage = (message as unknown as { model_usage?: Record<string, ModelUsageShape> }).model_usage;
  const totalCost = (message as unknown as { total_cost_usd?: number }).total_cost_usd;
  const agentId = (message as unknown as { agent_id?: string }).agent_id;
  if (usage === undefined || totalCost === undefined || agentId === undefined) return null;

  return {
    agentId,
    spend: {
      totalCostUsd: totalCost,
      byModel: Object.entries(usage).map(([model, one]) => ({
        model,
        costUsd: one.costUSD,
        inputTokens: one.inputTokens,
        outputTokens: one.outputTokens,
        cacheReadInputTokens: one.cacheReadInputTokens,
        cacheCreationInputTokens: one.cacheCreationInputTokens,
        contextWindow: one.contextWindow ?? null,
        canonicalModel: one.canonicalModel ?? null,
        provider: one.provider ?? null,
      })),
    },
  };
}

/** The per-model shape a task notification carries, named so the read above stays readable. */
interface ModelUsageShape {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly costUSD: number;
  readonly contextWindow?: number;
  readonly canonicalModel?: string;
  readonly provider?: string;
}
