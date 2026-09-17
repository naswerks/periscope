import test from 'node:test';
import assert from 'node:assert/strict';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { readRateLimit, readTaskSpend, readTurnSpend } from './telemetry.js';

const result = (over: Record<string, unknown>): SDKMessage =>
  ({ type: 'result', total_cost_usd: 0, modelUsage: {}, ...over }) as unknown as SDKMessage;

const usage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  inputTokens: 100,
  outputTokens: 50,
  cacheReadInputTokens: 10,
  cacheCreationInputTokens: 5,
  webSearchRequests: 0,
  costUSD: 0.25,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  ...over,
});

// ---------------------------------------------------------------------------
// per-model cost is read, not computed from a price table
// ---------------------------------------------------------------------------

test('regression: the cost is the one the agent reported, not one this host derived', () => {
  // A figure no price table could produce, from token counts that do not imply it. Any
  // reimplementation that started computing would have to reproduce an arbitrary number to pass.
  const spend = readTurnSpend(
    result({
      total_cost_usd: 13.579,
      modelUsage: { 'claude-opus-5': usage({ costUSD: 13.579, inputTokens: 1, outputTokens: 1 }) },
    }),
  );

  assert.equal(spend?.totalCostUsd, 13.579);
  assert.equal(spend?.byModel[0]?.costUsd, 13.579, 'carried through unchanged from the report');
  assert.equal(spend?.byModel[0]?.inputTokens, 1, 'and the tokens are not what produced it');
});

test('regression: a mixed-model turn is costed per model, which a session-level price table cannot do', () => {
  const spend = readTurnSpend(
    result({
      total_cost_usd: 0.75,
      modelUsage: {
        'claude-opus-5': usage({ costUSD: 0.6 }),
        'claude-haiku-4-5-20251001': usage({ costUSD: 0.15 }),
      },
    }),
  );

  assert.equal(spend?.byModel.length, 2);
  const byModel = Object.fromEntries((spend?.byModel ?? []).map((one) => [one.model, one.costUsd]));
  assert.deepEqual(byModel, { 'claude-opus-5': 0.6, 'claude-haiku-4-5-20251001': 0.15 });
});

test('the provider and canonical id are carried, so a figure can be traced to what priced it', () => {
  const spend = readTurnSpend(
    result({
      modelUsage: { 'some-alias': usage({ canonicalModel: 'claude-opus-5', provider: 'bedrock' }) },
    }),
  );
  assert.equal(spend?.byModel[0]?.canonicalModel, 'claude-opus-5');
  assert.equal(spend?.byModel[0]?.provider, 'bedrock');
  assert.equal(spend?.byModel[0]?.model, 'some-alias', 'keyed by what the agent keyed it by');
});

test('regression: an absent context window is null, never zero; zero reads as a real, tiny limit', () => {
  const spend = readTurnSpend(result({ modelUsage: { m: usage({ contextWindow: undefined }) } }));
  assert.equal(spend?.byModel[0]?.contextWindow, null);
});

test('an absent provider and canonical id are null rather than empty strings', () => {
  const spend = readTurnSpend(result({ modelUsage: { m: usage() } }));
  assert.equal(spend?.byModel[0]?.provider, null);
  assert.equal(spend?.byModel[0]?.canonicalModel, null);
});

test('a result with no per-model breakdown still reports the total', () => {
  const spend = readTurnSpend(result({ total_cost_usd: 0.4, modelUsage: {} }));
  assert.equal(spend?.totalCostUsd, 0.4);
  assert.deepEqual(spend?.byModel, []);
});

test('every token counter is carried through', () => {
  const spend = readTurnSpend(result({ modelUsage: { m: usage() } }));
  assert.equal(spend?.byModel[0]?.inputTokens, 100);
  assert.equal(spend?.byModel[0]?.outputTokens, 50);
  assert.equal(spend?.byModel[0]?.cacheReadInputTokens, 10);
  assert.equal(spend?.byModel[0]?.cacheCreationInputTokens, 5);
});

test('every message that is not a result reads as no spend', () => {
  for (const message of [{ type: 'user' }, { type: 'assistant' }, { type: 'system', subtype: 'init' }]) {
    assert.equal(readTurnSpend(message as unknown as SDKMessage), null);
  }
});

// ---------------------------------------------------------------------------
// rate limits — in-stream, not polled
// ---------------------------------------------------------------------------

test('a rate-limit event is read from the stream, with no endpoint polled', () => {
  const standing = readRateLimit({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      resetsAt: 1_800_000,
      rateLimitType: 'five_hour',
      utilization: 0.82,
    },
  } as unknown as SDKMessage);

  assert.equal(standing?.status, 'allowed_warning');
  assert.equal(standing?.resetsAt, 1_800_000);
  assert.equal(standing?.limitType, 'five_hour');
  assert.equal(standing?.utilization, 0.82);
});

test('regression: an unreported utilization is null, never 0; zero reads as "plenty left"', () => {
  const standing = readRateLimit({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed' },
  } as unknown as SDKMessage);
  assert.equal(standing?.utilization, null);
  assert.equal(standing?.resetsAt, null);
  assert.equal(standing?.limitType, null);
});

test('a rejected status is carried as itself', () => {
  const standing = readRateLimit({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected' },
  } as unknown as SDKMessage);
  assert.equal(standing?.status, 'rejected');
});

test('an ordinary message is not a rate-limit event', () => {
  assert.equal(readRateLimit({ type: 'result' } as unknown as SDKMessage), null);
});

// ---------------------------------------------------------------------------
// subagent spend
// ---------------------------------------------------------------------------

test("regression: a subagent's spend is attributable to its agent id", () => {
  const taskSpend = readTaskSpend({
    type: 'system',
    subtype: 'task_notification',
    agent_id: 'agent-7',
    total_cost_usd: 0.31,
    model_usage: { 'claude-opus-5': usage({ costUSD: 0.31 }) },
  } as unknown as SDKMessage);

  assert.equal(taskSpend?.agentId, 'agent-7');
  assert.equal(taskSpend?.spend.totalCostUsd, 0.31);
  assert.equal(taskSpend?.spend.byModel[0]?.costUsd, 0.31);
});

test('a task notification carrying no usage reads as no spend rather than as zero spend', () => {
  // Zero would be a claim; null is the absence of one. A subagent reported at zero cost that in fact
  // cost something is exactly the accounting error this closes.
  const taskSpend = readTaskSpend({
    type: 'system',
    subtype: 'task_notification',
    agent_id: 'agent-7',
  } as unknown as SDKMessage);
  assert.equal(taskSpend, null);
});

test('a task notification with no agent id reads as no spend — spend without an owner is not usable', () => {
  const taskSpend = readTaskSpend({
    type: 'system',
    subtype: 'task_notification',
    total_cost_usd: 0.1,
    model_usage: {},
  } as unknown as SDKMessage);
  assert.equal(taskSpend, null);
});

test('a plain result is not a task spend', () => {
  assert.equal(readTaskSpend(result({})), null);
});
