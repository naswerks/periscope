import test from 'node:test';
import assert from 'node:assert/strict';

import { SeqTracker } from './seq.js';

test('outbound numbers are dense and start at 1, per session', () => {
  const tracker = new SeqTracker();
  assert.deepEqual([tracker.next('a'), tracker.next('a'), tracker.next('a')], [1, 2, 3]);
  // A second session counts independently — seq is per session, never per link.
  assert.equal(tracker.next('b'), 1);
  assert.equal(tracker.next('a'), 4);
});

test('an in-order frame is accepted', () => {
  const tracker = new SeqTracker();
  assert.deepEqual(tracker.accept('a', 1), { disposition: 'accept' });
  assert.deepEqual(tracker.accept('a', 2), { disposition: 'accept' });
});

test('a re-delivered frame is a duplicate, which is expected after a reconnect', () => {
  const tracker = new SeqTracker();
  tracker.accept('a', 1);
  tracker.accept('a', 2);
  assert.deepEqual(tracker.accept('a', 2), { disposition: 'duplicate', seq: 2 });
  assert.deepEqual(tracker.accept('a', 1), { disposition: 'duplicate', seq: 1 });
  // A duplicate must not move the cursor, or the next real frame reads as a gap.
  assert.deepEqual(tracker.accept('a', 3), { disposition: 'accept' });
});

test('a missing frame is a gap, detectable by arithmetic alone', () => {
  const tracker = new SeqTracker();
  tracker.accept('a', 1);
  assert.deepEqual(tracker.accept('a', 5), { disposition: 'gap', expected: 2, received: 5 });
});

test('cursors report what has been seen, and adopt sets them', () => {
  const tracker = new SeqTracker();
  tracker.accept('a', 1);
  tracker.accept('b', 1);
  tracker.accept('b', 2);
  assert.deepEqual(
    tracker.cursors().sort((x, y) => x.sessionId.localeCompare(y.sessionId)),
    [
      { sessionId: 'a', seq: 1 },
      { sessionId: 'b', seq: 2 },
    ],
  );

  tracker.adopt([{ sessionId: 'a', seq: 9 }]);
  assert.equal(tracker.last('a'), 9);
});

test('a session is forgotten at session end, so nothing keyed by session leaks', () => {
  const tracker = new SeqTracker();
  tracker.next('a');
  tracker.next('b');
  assert.equal(tracker.trackedSessions, 2);

  tracker.forget('a');
  assert.equal(tracker.trackedSessions, 1);
  // And the counter genuinely restarts rather than resuming a stale value.
  assert.equal(tracker.next('a'), 1);
});
