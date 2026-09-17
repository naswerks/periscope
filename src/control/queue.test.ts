import test from 'node:test';
import assert from 'node:assert/strict';

import { BoundedFrameQueue } from './queue.js';
import type { SessionFrame, SessionPayload } from './frames.js';

const AT = '2026-08-03T00:00:00.000Z';

const delta: SessionPayload = { kind: 'session_delta', body: {} };
const update: SessionPayload = { kind: 'session_update', body: {} };
const receipt: SessionPayload = {
  kind: 'bulk_delivered',
  deliveryId: 'd-1',
  byteCount: 1,
  sizeBytes: null,
  mtimeMs: null,
};

/** Stamps with a per-session dense counter, the way the link does at write time. */
function stamper(): (sessionId: string, at: string, payload: SessionPayload) => SessionFrame {
  const last = new Map<string, number>();
  return (sessionId, at, payload) => {
    const seq = (last.get(sessionId) ?? 0) + 1;
    last.set(sessionId, seq);
    return { frame: 'session', sessionId, seq, at, payload };
  };
}

test('a full queue discards an incoming delta rather than a transition', () => {
  const queue = new BoundedFrameQueue(2);
  assert.ok(queue.push('s-1', AT, update).ok);
  assert.ok(queue.push('s-1', AT, update).ok);

  const pushed = queue.push('s-1', AT, delta);
  assert.equal(pushed.ok, false);
  if (!pushed.ok) assert.equal(pushed.refusal.reason, 'queue-dropped-droppable');
  assert.equal(queue.stats.depth, 2);
  assert.equal(queue.stats.droppedDroppable, 1);
});

test('a transition displaces the oldest pending delta rather than being dropped itself', () => {
  const queue = new BoundedFrameQueue(2);
  assert.ok(queue.push('s-1', AT, delta).ok);
  assert.ok(queue.push('s-1', AT, update).ok);

  const admitted = queue.push('s-1', AT, update);
  assert.ok(admitted.ok, 'a transition must find room');
  assert.deepEqual(
    admitted.ok ? admitted.value.evicted : null,
    { sessionId: 's-1', kind: 'session_delta' },
    'what was displaced is named, so the caller can say it out loud',
  );

  const stamp = stamper();
  const kinds: string[] = [];
  for (let frame = queue.stampNext(stamp); frame !== null; frame = queue.stampNext(stamp)) {
    kinds.push(frame.payload.kind);
  }
  assert.deepEqual(kinds, ['session_update', 'session_update'], 'the delta went, the transitions survived');
});

test('a receipt is not droppable either', () => {
  const queue = new BoundedFrameQueue(1);
  assert.ok(queue.push('s-1', AT, delta).ok);
  assert.ok(queue.push('s-1', AT, receipt).ok);

  const stamp = stamper();
  const frame = queue.stampNext(stamp);
  assert.equal(frame?.payload.kind, 'bulk_delivered');
  assert.equal(queue.stampNext(stamp), null);
});

test('when nothing droppable remains the queue refuses, loudly, rather than losing a fact', () => {
  const queue = new BoundedFrameQueue(2);
  assert.ok(queue.push('s-1', AT, update).ok);
  assert.ok(queue.push('s-1', AT, receipt).ok);

  const pushed = queue.push('s-1', AT, update);
  assert.equal(pushed.ok, false, 'silently dropping a transition would be a lie about the session');
  if (!pushed.ok) assert.equal(pushed.refusal.reason, 'queue-overflow-undroppable');
  assert.equal(queue.stats.refusedUndroppable, 1);
  assert.equal(queue.stats.depth, 2);
});

test('stamping happens oldest first, and a stamped entry is stamped exactly once', () => {
  const queue = new BoundedFrameQueue(10);
  queue.push('s-1', AT, update);
  queue.push('s-1', AT, delta);
  queue.push('s-2', AT, update);

  const stamp = stamper();
  const first = queue.stampNext(stamp);
  const second = queue.stampNext(stamp);
  const third = queue.stampNext(stamp);
  assert.deepEqual(
    [first, second, third].map((frame) => `${frame?.sessionId}/${frame?.seq}/${frame?.payload.kind}`),
    ['s-1/1/session_update', 's-1/2/session_delta', 's-2/1/session_update'],
    'arrival order, dense per session',
  );
  assert.equal(queue.stampNext(stamp), null, 'nothing pending is left to stamp');
  assert.equal(queue.hasPending, false);
  assert.equal(queue.stats.depth, 3, 'stamped frames stay retained until acked');
});

test('a frame that has been written is never displaced — the queue refuses instead', () => {
  const queue = new BoundedFrameQueue(2);
  queue.push('s-1', AT, delta);
  const stamp = stamper();
  const written = queue.stampNext(stamp);
  assert.equal(written?.payload.kind, 'session_delta', 'the delta is on the wire with seq 1');
  queue.push('s-1', AT, update);

  // The only droppable held is written: it may already be at the receiver, and its number is on
  // the wire. Displacing it would put a hole in the numbering, so the undroppable is refused.
  const pushed = queue.push('s-1', AT, update);
  assert.equal(pushed.ok, false);
  if (!pushed.ok) assert.equal(pushed.refusal.reason, 'queue-overflow-undroppable');
  assert.deepEqual(
    queue.writtenFrames().map((frame) => `${frame.sessionId}/${frame.seq}`),
    ['s-1/1'],
    'the written delta is still retained for replay',
  );
});

test('an ack releases confirmed written frames, per session', () => {
  const queue = new BoundedFrameQueue(10);
  queue.push('s-1', AT, update);
  queue.push('s-1', AT, update);
  queue.push('s-1', AT, update);
  queue.push('s-2', AT, update);
  const stamp = stamper();
  while (queue.stampNext(stamp) !== null) {
    // stamp everything, as a fully drained link would
  }

  assert.equal(queue.pruneUpTo('s-1', 2), 2);
  assert.deepEqual(
    queue.writtenFrames().map((frame) => `${frame.sessionId}/${frame.seq}`),
    ['s-1/3', 's-2/1'],
  );
});

test('an ack can never release a pending entry, because a pending entry has no number to confirm', () => {
  const queue = new BoundedFrameQueue(10);
  queue.push('s-1', AT, update);
  assert.equal(queue.pruneUpTo('s-1', 999), 0);
  assert.equal(queue.hasPending, true, 'the entry is still waiting for its first write');
});

// Dropping a session's entries "pending and written alike" at session end is a data-loss path: a
// session ending while the link is down would discard its own final transitions, the frames that
// say how it ended. The rule that nothing keyed by a session outlives it holds for pending entries;
// for stamped ones the never-drop-a-transition rule wins. See `BoundedFrameQueue.forget`.
test('a session end releases its pending entries and keeps what the controller has not acked', () => {
  const queue = new BoundedFrameQueue(10);
  queue.push('s-1', AT, update);
  queue.push('s-1', AT, update);
  queue.push('s-2', AT, update);
  const stamp = stamper();
  queue.stampNext(stamp); // s-1's first entry is written; its second stays pending

  assert.equal(queue.forget('s-1'), 1, 'only the pending entry is released');
  assert.equal(queue.retainedFor('s-1'), 1, 'the written, un-acked frame is still owed');

  const stragglers = queue.stampNext(stamp);
  assert.equal(stragglers?.sessionId, 's-2', 'nothing of s-1 is left waiting to be written');
});

// The property stated as the failure rather than the mechanism: the last thing a session says is
// what a reader needs most, and it is precisely the frame still unacked when a session ends on a
// link that is down.
test('regression: a session that ends while the link is down keeps its final transition for replay', () => {
  const queue = new BoundedFrameQueue(10);
  queue.push('s-1', AT, update);
  const written = queue.stampNext(stamper());
  assert.ok(written, 'the ending transition reached the wire');

  queue.forget('s-1'); // the session ended; the controller has acked nothing

  assert.deepEqual(
    queue.writtenFrames().map((frame) => frame.seq),
    [written.seq],
    'the ending transition survives session end and is still replayable',
  );
});

// And the bound this does not abandon: an ack empties it, so the retention is finite rather than
// forever. Nothing new is produced for an ended session, so this is the whole of what it can hold.
test('an ack after the end releases the last of an ended session', () => {
  const queue = new BoundedFrameQueue(10);
  queue.push('s-1', AT, update);
  const written = queue.stampNext(stamper());
  queue.forget('s-1');

  assert.equal(queue.pruneUpTo('s-1', written?.seq ?? 0), 1);
  assert.equal(queue.retainedFor('s-1'), 0, 'the retention window closes on the ack');
  assert.equal(queue.stats.depth, 0);
});

test('a queue must be given a usable capacity', () => {
  assert.throws(() => new BoundedFrameQueue(0), RangeError);
  assert.throws(() => new BoundedFrameQueue(-1), RangeError);
});
