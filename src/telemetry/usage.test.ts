import test from 'node:test';
import assert from 'node:assert/strict';

import type { ModelSpend, TurnSpend } from './usage.js';
import { NO_SPEND, deltaSpend, foldSpend, spendReconciles } from './usage.js';

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

// ---------------------------------------------------------------------------
// deltaSpend: a result is a running total, and one turn is the difference of two
// ---------------------------------------------------------------------------

/** One reading of the meter: every counter given, so a difference has something to subtract. */
const reading = (
  costUsd: number,
  tokens: { input: number; output: number; read: number; created: number; thinking?: number | null },
  model = 'opus',
): ModelSpend =>
  spend(model, costUsd, {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadInputTokens: tokens.read,
    cacheCreationInputTokens: tokens.created,
    thinkingTokens: tokens.thinking ?? null,
  });

test('regression: two results of one session give the spend between them, not the running total', () => {
  const first = turn(1.0, [
    reading(1.0, { input: 1000, output: 200, read: 5000, created: 800, thinking: 50 }),
  ]);
  const second = turn(1.75, [
    reading(1.75, { input: 1600, output: 350, read: 9000, created: 900, thinking: 90 }),
  ]);

  const delta = deltaSpend(first, second);
  assert.ok(Math.abs(delta.totalCostUsd - 0.75) < 1e-9, `the turn cost 0.75, got ${delta.totalCostUsd}`);
  const [opus] = delta.byModel;
  assert.ok(Math.abs((opus?.costUsd ?? 0) - 0.75) < 1e-9);
  assert.equal(opus?.inputTokens, 600);
  assert.equal(opus?.outputTokens, 150);
  assert.equal(opus?.cacheReadInputTokens, 4000);
  assert.equal(opus?.cacheCreationInputTokens, 100);
  assert.equal(opus?.thinkingTokens, 40);
});

test('regression: folding the deltas of a session gives its last running total; folding the results multiplies it', () => {
  const results = [
    turn(0.5, [reading(0.5, { input: 100, output: 10, read: 0, created: 50 })]),
    turn(0.8, [reading(0.8, { input: 180, output: 25, read: 40, created: 60 })]),
    turn(1.4, [reading(1.4, { input: 300, output: 40, read: 120, created: 70 })]),
  ];

  let folded = NO_SPEND;
  let previous: TurnSpend | null = null;
  for (const result of results) {
    folded = foldSpend(folded, deltaSpend(previous, result));
    previous = result;
  }
  assert.ok(Math.abs(folded.totalCostUsd - 1.4) < 1e-9, `the session cost 1.40, got ${folded.totalCostUsd}`);
  assert.equal(folded.byModel[0]?.inputTokens, 300);
  assert.equal(folded.turnCount, 3);

  // The defect this replaces: each result folded as if it were one turn's spend.
  const summed = results.reduce(foldSpend, NO_SPEND);
  assert.ok(summed.totalCostUsd > 2.6, 'summing running totals counts early turns again and again');
});

test('a drop in a counter is a reset, and the new series is read whole', () => {
  // A `/clear` resets the meter. Subtracting across it would give negative spend.
  const before = turn(1.75, [reading(1.75, { input: 1600, output: 350, read: 9000, created: 900 })]);
  const after = turn(0.2, [reading(0.2, { input: 150, output: 20, read: 0, created: 400 })]);

  assert.deepEqual(deltaSpend(before, after), after);
});

test('a model the previous result reported and the next one does not also starts a new series', () => {
  const before = turn(1.0, [
    reading(0.9, { input: 900, output: 90, read: 0, created: 0 }),
    spend('haiku', 0.1),
  ]);
  const after = turn(1.2, [reading(1.2, { input: 1200, output: 120, read: 0, created: 0 })]);

  assert.deepEqual(deltaSpend(before, after), after);
});

test('a model new in the next result counts at its full figures; the others by difference', () => {
  const before = turn(1.0, [reading(1.0, { input: 1000, output: 100, read: 0, created: 0 })]);
  const after = turn(1.3, [
    reading(1.2, { input: 1200, output: 130, read: 0, created: 0 }),
    reading(0.1, { input: 70, output: 7, read: 0, created: 0 }, 'haiku'),
  ]);

  const delta = deltaSpend(before, after);
  const byModel = Object.fromEntries(delta.byModel.map((one) => [one.model, one]));
  assert.equal(byModel['opus']?.inputTokens, 200);
  assert.equal(byModel['haiku']?.inputTokens, 70, 'a first appearance is all new spend');
});

test('float noise in a cost is not a reset', () => {
  const before = turn(0.1 + 0.2, [reading(0.1 + 0.2, { input: 10, output: 1, read: 0, created: 0 })]);
  const after = turn(0.3, [reading(0.3, { input: 10, output: 1, read: 0, created: 0 })]);

  const delta = deltaSpend(before, after);
  assert.notDeepEqual(delta, after, 'a difference of 5.5e-17 is not a /clear');
  assert.equal(delta.totalCostUsd, 0);
  assert.equal(delta.byModel[0]?.inputTokens, 0);
});

test('regression: a resumed session seeded with its parent last totals yields only the new spend; unseeded, the carried total', () => {
  // A resumed or forked session continues from the totals its transcript saved, so its first result
  // carries the parent's spend. Seeded with the parent's last result, the delta is the new spend;
  // read from nothing, it is the whole carried total, which is the parent counted a second time.
  const parentLast = turn(2.0, [reading(2.0, { input: 2000, output: 300, read: 7000, created: 900 })]);
  const resumedFirst = turn(2.5, [reading(2.5, { input: 2600, output: 380, read: 9500, created: 950 })]);

  const seeded = deltaSpend(parentLast, resumedFirst);
  assert.ok(
    Math.abs(seeded.totalCostUsd - 0.5) < 1e-9,
    `seeded: only the new 0.50, got ${seeded.totalCostUsd}`,
  );
  assert.equal(seeded.byModel[0]?.inputTokens, 600);

  const unseeded = deltaSpend(null, resumedFirst);
  assert.equal(unseeded.totalCostUsd, 2.5, 'unseeded: the carried total');
  assert.equal(unseeded.byModel[0]?.inputTokens, 2600);
});

test('thinking tokens add and the newest price basis wins; neither reported stays null', () => {
  let total = foldSpend(NO_SPEND, turn(0.1, [spend('m', 0.1, { thinkingTokens: 10, costBasis: 'list' })]));
  total = foldSpend(total, turn(0.1, [spend('m', 0.1, { thinkingTokens: 5, costBasis: 'unknown' })]));
  assert.equal(total.byModel[0]?.thinkingTokens, 15);
  assert.equal(total.byModel[0]?.costBasis, 'unknown');

  let silent = foldSpend(NO_SPEND, turn(0.1, [spend('m', 0.1, { thinkingTokens: null, costBasis: null })]));
  silent = foldSpend(silent, turn(0.1, [spend('m', 0.1, { thinkingTokens: null, costBasis: null })]));
  assert.equal(silent.byModel[0]?.thinkingTokens, null, 'unreported is not zero');
  assert.equal(silent.byModel[0]?.costBasis, null);
});
