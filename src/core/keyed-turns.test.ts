import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedTurns } from './keyed-turns.js';

/** A promise the test resolves by hand, so the interleaving window can be held open on demand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('work under one key runs serially, in submission order', async () => {
  const turns = new KeyedTurns();
  const gate = deferred();
  const log: string[] = [];

  const first = turns.run('k', async () => {
    log.push('first:start');
    await gate.promise;
    log.push('first:done');
  });
  const second = turns.run('k', async () => {
    log.push('second:start');
  });
  await settle();

  // Mid-window, the control on the fixture: if the first turn had already finished here, serial
  // ordering would pass against an executor that serializes nothing.
  assert.deepEqual(log, ['first:start'], 'the second turn started inside the first one’s window');

  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(log, ['first:start', 'first:done', 'second:start'], 'the turns interleaved');
});

test('control: work under different keys interleaves freely', async () => {
  // The discriminator for the test above: one variable changes (the key), and the outcomes must
  // disagree. An executor that serialized everything would pass the serial test while wedging
  // every workspace on this host behind every other.
  const turns = new KeyedTurns();
  const gate = deferred();
  const log: string[] = [];

  const held = turns.run('a', async () => {
    log.push('a:start');
    await gate.promise;
    log.push('a:done');
  });
  const free = turns.run('b', async () => {
    log.push('b:done');
  });
  await settle();

  assert.deepEqual(log, ['a:start', 'b:done'], 'an unrelated key waited on a held one');
  gate.resolve();
  await Promise.all([held, free]);
});

test('a rejection does not poison the key — the next turn still runs, and the rejection stays its caller’s', async () => {
  const turns = new KeyedTurns();
  const failed = turns.run('k', async () => {
    throw new Error('the removal failed');
  });
  const after = turns.run('k', async () => 'ran');

  await assert.rejects(failed, /the removal failed/, 'the rejection must surface to its own caller');
  assert.equal(await after, 'ran', 'a failed turn wedged every future turn at its key');
});

test('the result rides the turn — and settled keys are forgotten rather than accumulated', async () => {
  const turns = new KeyedTurns();
  assert.equal(await turns.run('k', async () => 41 + 1), 42);
  await settle();
  // The map must drain: a host reaps and re-provisions arbitrarily many keys over its life, and a
  // tail entry per key ever seen would be an unbounded leak.
  assert.equal(turns.depth, 0, 'a settled key still holds a tail entry');
});
