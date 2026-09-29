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
 * A result's spend, or null for every message that is not a result.
 *
 * The figures are the agent's running totals as of this result, not the turn's own cost: they
 * accumulate across a session's turns, continue across a resume or a fork, and reset at `/clear`.
 * `deltaSpend` reads one turn's spend from two of them.
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
    // Absent is null rather than zero: a zero reads as a real count, a zero window as a real limit.
    thinkingTokens: usage.thinkingTokens ?? null,
    costBasis: usage.costBasis ?? null,
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
 * Always null.
 *
 * It read `agent_id`, `total_cost_usd` and `model_usage` off a task notification, and no agent SDK
 * version declares any of them: a task's usage is `{ total_tokens, tool_uses, duration_ms }`. A
 * subagent's cost is already inside the parent's results, whose running totals include every model
 * the session's subagents ran, so a second reading here would count it twice.
 *
 * @deprecated Read a session's spend from its results, with `readTurnSpend` and `deltaSpend`. Kept so
 * an import still resolves; it goes at the next major version.
 */
export function readTaskSpend(message: SDKMessage): { agentId: string; spend: TurnSpend } | null {
  void message;
  return null;
}
