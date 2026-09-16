/**
 * A bounded soak of the retention path: the queue on its own, then the link against a real peer.
 *
 * The claim is that nothing keyed by a session outlives the session's last ack, at a volume where
 * a leak would be visible. Each test is bounded by its timeout, so a retention that stops
 * releasing shows up as a stall, never as a hang.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { BoundedFrameQueue } from './queue.js';
import { ControllerLink } from './link.js';
import type { Refusal } from '../core/refusal.js';
import type { SessionFrame, SessionPayload } from './frames.js';
import { fixedClock, fixedTicker } from '../core/time.js';
import { peerOn, waitFor } from '../test-support/ws-peer.js';

const CAPACITY = 10_000;
/**
 * Frames per cycle, at the queue's capacity: `stampNext` reads the written-prefix cursor and a
 * prune is one pass over the written run, so draining and acking a full queue is linear in its
 * depth and fits the budget below.
 * A full 10 000 costs about two seconds to stamp and three to ack one frame at a time on a laptop,
 * which is the bound this file measures against, not the retention it exists to prove.
 */
const VOLUME = 10_000;
/** Frames the link soak sends: the same cost again on the wire, and the acks come back one at a time. */
const LINK_VOLUME = 1_000;
const SESSIONS = 100;
const AT = '2026-01-01T00:00:00.000Z';
const HEAP_CEILING_BYTES = 64 * 1024 * 1024;

/** The link with no credential says so on every dial; it is not a retention refusal. */
const retentionRefusals = (refusals: readonly Refusal[]): Refusal[] =>
  refusals.filter((refused) => refused.reason !== 'credential-unavailable');

const sessionOf = (index: number): string => `s-${index % SESSIONS}`;
const updateOf = (index: number): SessionPayload => ({ kind: 'session_update', body: { index } });

/** Push, stamp and ack a full capacity of updates spread over every session. */
function cycle(queue: BoundedFrameQueue): void {
  const last = new Map<string, number>();
  const stamp = (sessionId: string, at: string, payload: SessionPayload): SessionFrame => {
    const seq = (last.get(sessionId) ?? 0) + 1;
    last.set(sessionId, seq);
    return { frame: 'session', sessionId, seq, at, payload };
  };

  for (let index = 0; index < VOLUME; index += 1) {
    assert.ok(queue.push(sessionOf(index), AT, updateOf(index)).ok, `push ${index} refused`);
  }
  assert.equal(queue.stats.depth, VOLUME);
  assert.ok(queue.stats.depth <= queue.stats.capacity);

  while (queue.stampNext(stamp) !== null) {
    // stamp everything, as a fully drained link would
  }
  assert.equal(queue.stats.pendingDepth, 0);
  assert.equal(queue.stats.depth, VOLUME, 'stamped frames stay retained until acked');

  for (const [sessionId, seq] of last) queue.pruneUpTo(sessionId, seq);
  assert.equal(queue.stats.depth, 0, "an ack at every session's last seq must release everything");
  for (const [sessionId] of last) assert.equal(queue.retainedFor(sessionId), 0);
  assert.deepEqual(queue.writtenFrames(), []);
}

test(
  'a volume of updates across a hundred sessions is fully released by acks, three cycles running',
  { timeout: 10_000 },
  () => {
    const queue = new BoundedFrameQueue(CAPACITY);
    const heapBefore = process.memoryUsage().heapUsed;

    for (let round = 0; round < 3; round += 1) cycle(queue);

    const heapDelta = process.memoryUsage().heapUsed - heapBefore;
    assert.equal(queue.stats.droppedDroppable, 0);
    assert.equal(queue.stats.refusedUndroppable, 0);
    assert.ok(heapDelta < HEAP_CEILING_BYTES, `heap grew by ${heapDelta} bytes across three cycles`);
  },
);

test(
  'a link sends a volume of frames to an acking peer, every one arrives once, and the queue empties',
  { timeout: 10_000 },
  async () => {
    const peer = await peerOn({ ack: true });
    const refusals: Refusal[] = [];
    const link = new ControllerLink({
      url: peer.url,
      hostId: 'soak-host',
      clock: fixedClock(Date.parse(AT)),
      ticker: fixedTicker(0),
      queueCapacity: CAPACITY,
      heartbeatIntervalMs: 20,
      endedRetentionMs: 50,
      handlers: {
        onTransition: () => {},
        onSessionFrame: () => {},
        onGap: () => {},
        onRefusal: (refused) => refusals.push(refused),
      },
    });

    try {
      link.start();
      await waitFor(() => link.state === 'accepted', 'the link to open');
      // The welcome replays whatever is retained when it lands, so one warm-up frame absorbs that
      // replay and its ack proves the handshake is over before the soak begins.
      assert.ok(link.send('warm', updateOf(-1)).ok);
      await waitFor(() => link.queueStats.depth === 0, 'the warm-up frame to be acked');

      for (let index = 0; index < LINK_VOLUME; index += 1) {
        assert.ok(link.send(sessionOf(index), updateOf(index)).ok, `send ${index} refused`);
      }
      assert.ok(link.queueStats.depth <= CAPACITY);

      const arrived = (): number =>
        peer.received.filter((frame) => frame.frame === 'session' && frame.sessionId !== 'warm').length;
      await waitFor(() => arrived() === LINK_VOLUME, `all ${LINK_VOLUME} frames to arrive`);
      await waitFor(() => link.queueStats.depth === 0, 'every frame to be acked and released');

      assert.deepEqual(peer.faults.gaps, []);
      assert.deepEqual(
        peer.faults.duplicates.filter((id) => !id.startsWith('warm/')),
        [],
      );
      assert.deepEqual(retentionRefusals(refusals), []);
      assert.equal(link.queueStats.droppedDroppable, 0);
      assert.equal(link.queueStats.refusedUndroppable, 0);
    } finally {
      link.stop('soak finished');
      await peer.close();
    }
  },
);

test(
  'an ended session nobody acks is released once, by name, after the retention bound',
  { timeout: 10_000 },
  async () => {
    const peer = await peerOn({ ack: false });
    const ticker = fixedTicker(0);
    const refusals: Refusal[] = [];
    const link = new ControllerLink({
      url: peer.url,
      hostId: 'soak-host',
      clock: fixedClock(Date.parse(AT)),
      ticker,
      queueCapacity: CAPACITY,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 1_000_000,
      endedRetentionMs: 50,
      handlers: {
        onTransition: () => {},
        onSessionFrame: () => {},
        onGap: () => {},
        onRefusal: (refused) => refusals.push(refused),
      },
    });

    try {
      link.start();
      await waitFor(() => link.state === 'accepted', 'the link to open');
      await waitFor(
        () => peer.received.some((frame) => frame.frame === 'control' && frame.payload.kind === 'link_hello'),
        'the hello',
      );
      // A ping answered is a round trip after the hello, so the welcome has landed and been replayed.
      await waitFor(
        () => peer.received.some((frame) => frame.frame === 'control' && frame.payload.kind === 'link_ping'),
        'the first ping',
      );

      const COUNT = 1_000;
      for (let index = 0; index < COUNT; index += 1) assert.ok(link.send('s-dead', updateOf(index)).ok);
      await waitFor(() => peer.sessionFrames('s-dead').length === COUNT, `all ${COUNT} frames to arrive`);
      assert.equal(link.queueStats.depth, COUNT, 'nothing is acked, so everything is retained');

      link.forgetSession('s-dead');
      assert.equal(link.queueStats.depth, COUNT, 'session end keeps written-unacked frames');

      ticker.advance(50);
      await waitFor(
        () => refusals.some((refused) => refused.reason === 'retention-released-unacked'),
        'the retention release',
      );
      // A further sweep must not report the same session twice.
      await new Promise((resolve) => setTimeout(resolve, 60));

      const released = refusals.filter((refused) => refused.reason === 'retention-released-unacked');
      assert.equal(
        released.length,
        1,
        `expected exactly one release, got ${released.map((refused) => refused.detail).join('; ')}`,
      );
      assert.match(released[0]?.detail ?? '', new RegExp(`released ${COUNT} written frame`));
      assert.equal(link.queueStats.depth, 0);
      assert.deepEqual(
        retentionRefusals(refusals).filter((refused) => refused.reason !== 'retention-released-unacked'),
        [],
      );
    } finally {
      link.stop('soak finished');
      await peer.close();
    }
  },
);
