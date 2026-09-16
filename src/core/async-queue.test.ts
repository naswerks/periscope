import test from 'node:test';
import assert from 'node:assert/strict';

import { AsyncQueue } from './async-queue.js';

test('values pushed before anyone reads are delivered in order', async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.push(2);
  queue.end();

  const seen: number[] = [];
  for await (const value of queue) seen.push(value);
  assert.deepEqual(seen, [1, 2]);
});

test('a consumer waiting on an empty queue is handed the next value', async () => {
  const queue = new AsyncQueue<string>();
  const iterator = queue[Symbol.asyncIterator]();

  const pending = iterator.next();
  assert.equal(queue.depth, 0, 'nothing is buffered while a consumer is waiting');
  queue.push('turn');

  assert.deepEqual(await pending, { value: 'turn', done: false });
});

test('end() releases a waiting consumer — an iterator that never returns looks like a live session', async () => {
  const queue = new AsyncQueue<string>();
  const iterator = queue[Symbol.asyncIterator]();
  const pending = iterator.next();

  queue.end();

  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.equal(queue.ended, true);
});

test('end() is idempotent and pushing after it is ignored rather than throwing', async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.end();
  queue.end();
  queue.push(2);

  const seen: number[] = [];
  for await (const value of queue) seen.push(value);
  assert.deepEqual(seen, [1], 'a value pushed after the end must not appear');
});

test('breaking out of a for-await ends the queue rather than leaving it open', async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.push(2);

  for await (const value of queue) {
    assert.equal(value, 1);
    break;
  }
  assert.equal(queue.ended, true, 'an abandoned consumer must not leave a producer writing forever');
});
