import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_BACKOFF, nextDelayMs } from './backoff.js';

const options = { baseMs: 100, maxMs: 5_000, factor: 2 };

test('the ceiling grows exponentially and then stops at the cap', () => {
  const ceilings = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => nextDelayMs(attempt, () => 1, options));
  assert.deepEqual(ceilings.slice(0, 6), [100, 200, 400, 800, 1600, 3200]);
  for (const capped of ceilings.slice(6)) assert.equal(capped, options.maxMs);
});

test('the delay never drops below the floor', () => {
  for (const attempt of [0, 1, 5, 50]) {
    assert.ok(nextDelayMs(attempt, () => 0, options) >= options.baseMs);
  }
});

// The jitter is the point. Without it a controller restart brings every host back at the same
// instant, and the reconnect storm knocks it over again — harder each round, because the hosts
// stay in step. This is the assertion that would fail if someone "simplified" the jitter away.
test('two hosts drawing from different streams do not retry in lockstep', () => {
  const attempt = 6; // deep enough that the un-jittered delay would be pinned at the cap
  const hostA = [0.11, 0.42, 0.73];
  const hostB = [0.87, 0.05, 0.31];

  const delaysA = hostA.map((value) => nextDelayMs(attempt, () => value, options));
  const delaysB = hostB.map((value) => nextDelayMs(attempt, () => value, options));

  for (let index = 0; index < delaysA.length; index += 1) {
    assert.notEqual(delaysA[index], delaysB[index], 'jitter must separate two hosts');
  }
});

test('the spread genuinely covers the window rather than hugging one end', () => {
  const samples = Array.from({ length: 1000 }, (_, index) => nextDelayMs(8, () => index / 1000, options));
  assert.ok(Math.min(...samples) <= options.baseMs + 50);
  assert.ok(Math.max(...samples) >= options.maxMs - 50);
});

test('a nonsense attempt number cannot produce a nonsense delay', () => {
  for (const attempt of [-5, -1, 1.7]) {
    const delay = nextDelayMs(attempt, () => 0.5, options);
    assert.ok(delay >= options.baseMs && delay <= options.maxMs, `attempt ${attempt} gave ${delay}`);
  }
});

test('the shipped defaults are sane', () => {
  assert.ok(DEFAULT_BACKOFF.baseMs > 0);
  assert.ok(DEFAULT_BACKOFF.maxMs > DEFAULT_BACKOFF.baseMs);
  assert.ok(DEFAULT_BACKOFF.factor > 1);
});
