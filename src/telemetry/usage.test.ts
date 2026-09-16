import test from 'node:test';
import assert from 'node:assert/strict';

import type { ModelSpend, TurnSpend } from './usage.js';
import { NO_SPEND, foldSpend, spendReconciles } from './usage.js';

const spend = (model: string, costUsd: number, over: Partial<ModelSpend> = {}): ModelSpend => ({
  model,
  costUsd,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadInputTokens: 10,
  cacheCreationInputTokens: 5,
  contextWindow: 200_000,
  canonicalModel: null,
  provider: null,
  ...over,
});

const turn = (totalCostUsd: number, byModel: ModelSpend[]): TurnSpend => ({ totalCostUsd, byModel });

test('folding one turn into nothing gives that turn', () => {
  const total = foldSpend(NO_SPEND, turn(0.5, [spend('opus', 0.5)]));
  assert.equal(total.totalCostUsd, 0.5);
  assert.equal(total.turnCount, 1);
  assert.equal(total.byModel.length, 1);
});

test('regression: two turns on one model accumulate cost and tokens rather than replacing them', () => {
  let total = foldSpend(NO_SPEND, turn(0.5, [spend('opus', 0.5)]));
  total = foldSpend(total, turn(0.25, [spend('opus', 0.25)]));

  assert.equal(total.totalCostUsd, 0.75);
  assert.equal(total.turnCount, 2);
  assert.equal(total.byModel.length, 1);
  assert.equal(total.byModel[0]?.costUsd, 0.75);
  assert.equal(total.byModel[0]?.inputTokens, 200);
  assert.equal(total.byModel[0]?.outputTokens, 100);
  assert.equal(total.byModel[0]?.cacheReadInputTokens, 20);
  assert.equal(total.byModel[0]?.cacheCreationInputTokens, 10);
});

test('two models across two turns are kept apart', () => {
  let total = foldSpend(NO_SPEND, turn(0.5, [spend('opus', 0.5)]));
  total = foldSpend(total, turn(0.1, [spend('haiku', 0.1)]));

  assert.equal(total.byModel.length, 2);
  assert.equal(total.totalCostUsd, 0.6);
});

test('a mixed-model turn folds both models at once', () => {
  const total = foldSpend(NO_SPEND, turn(0.6, [spend('opus', 0.5), spend('haiku', 0.1)]));
  assert.equal(total.byModel.length, 2);
  assert.equal(total.turnCount, 1);
});

test('regression: models are merged by their reported key, not by the canonical id they priced against', () => {
  // An alias and a provider-specific id can bill differently, so collapsing them would throw away a
  // distinction the agent was making.
  const total = foldSpend(
    NO_SPEND,
    turn(0.6, [
      spend('bedrock/claude-opus-5', 0.4, { canonicalModel: 'claude-opus-5' }),
      spend('claude-opus-5', 0.2, { canonicalModel: 'claude-opus-5' }),
    ]),
  );
  assert.equal(total.byModel.length, 2, 'two billing identities, kept apart');
});

test('the newest report of a model descriptor wins — it describes the model, not the usage', () => {
  let total = foldSpend(NO_SPEND, turn(0.1, [spend('m', 0.1, { contextWindow: 200_000, provider: null })]));
  total = foldSpend(total, turn(0.1, [spend('m', 0.1, { contextWindow: 500_000, provider: 'bedrock' })]));

  assert.equal(total.byModel[0]?.contextWindow, 500_000);
  assert.equal(total.byModel[0]?.provider, 'bedrock');
});

test('a later report that omits a descriptor does not erase the one already known', () => {
  let total = foldSpend(NO_SPEND, turn(0.1, [spend('m', 0.1, { provider: 'bedrock' })]));
  total = foldSpend(total, turn(0.1, [spend('m', 0.1, { provider: null })]));
  assert.equal(total.byModel[0]?.provider, 'bedrock');
});

test('folding does not mutate the total it was given', () => {
  const first = foldSpend(NO_SPEND, turn(0.5, [spend('opus', 0.5)]));
  foldSpend(first, turn(0.5, [spend('opus', 0.5)]));
  assert.equal(first.totalCostUsd, 0.5, 'the earlier total is still what it was');
  assert.equal(first.turnCount, 1);
});

test('NO_SPEND is a genuine zero and is not mutated by folding', () => {
  foldSpend(NO_SPEND, turn(1, [spend('m', 1)]));
  assert.equal(NO_SPEND.totalCostUsd, 0);
  assert.equal(NO_SPEND.turnCount, 0);
  assert.deepEqual(NO_SPEND.byModel, []);
});

test('a turn that cost nothing still counts as a turn', () => {
  const total = foldSpend(NO_SPEND, turn(0, []));
  assert.equal(total.turnCount, 1);
  assert.equal(total.totalCostUsd, 0);
});

// ---------------------------------------------------------------------------
// reconciliation: an observation, never a validation
// ---------------------------------------------------------------------------

test('a turn whose per-model costs sum to its total reconciles', () => {
  assert.equal(spendReconciles(turn(0.6, [spend('opus', 0.5), spend('haiku', 0.1)])), true);
});

test('regression: float arithmetic does not make an honest turn fail to reconcile', () => {
  // 0.1 + 0.2 is famously not 0.3. An exact comparison here would report a defect in arithmetic that
  // is otherwise perfectly correct.
  assert.equal(spendReconciles(turn(0.3, [spend('a', 0.1), spend('b', 0.2)])), true);
});

test('a turn whose total exceeds its breakdown does not reconcile, and that is reported not refused', () => {
  // Both numbers come from the agent, so a mismatch is the agent itemising less than it charged —
  // its business, and a fact a caller quoting a figure wants to know.
  assert.equal(spendReconciles(turn(1.0, [spend('opus', 0.5)])), false);
});

test('an empty breakdown with a non-zero total does not reconcile', () => {
  assert.equal(spendReconciles(turn(0.4, [])), false);
});

test('an empty turn reconciles trivially', () => {
  assert.equal(spendReconciles(turn(0, [])), true);
});

test('the tolerance is adjustable for a caller that rounds to cents', () => {
  assert.equal(spendReconciles(turn(0.5, [spend('opus', 0.504)])), false);
  assert.equal(spendReconciles(turn(0.5, [spend('opus', 0.504)]), 0.01), true);
});
