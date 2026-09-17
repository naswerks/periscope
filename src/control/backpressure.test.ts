/**
 * The property: above the high-water mark the link stops writing and queues, and what it queued
 * is delivered by the drain, in order, without a reconnect anywhere in the story.
 *
 * The mark is set to one byte so any unflushed write holds the flow, which makes the hold
 * observable (`pendingDepth`) instead of a timing accident; delivery then proves the drain, and the
 * transition log proves no reconnect was involved.
 */
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ControllerLink } from './link.js';
import type { LinkTransition } from './link-state.js';
import { decode, encode } from './codec.js';
import { PROTOCOL_VERSION } from './frames.js';
import { SeqTracker } from './seq.js';
import { rawText } from '../test-support/raw-text.js';

class TestController {
  readonly server: WebSocketServer;
  readonly accepted: string[] = [];
  /** The producer's own ordering, read out of the payload — seq order alone cannot see a swap. */
  readonly acceptedIndexes: number[] = [];
  readonly gaps: string[] = [];
  readonly wireSeqs: number[] = [];
  readonly #cursors = new SeqTracker();
  #live: ServerSocket | null = null;

  constructor(server: WebSocketServer) {
    this.server = server;
    server.on('connection', (socket) => {
      this.#live = socket;
      socket.on('message', (data) => this.#onMessage(socket, rawText(data)));
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** A slow controller, made literal: stop reading, and the sender's buffers genuinely fill. */
  stopReading(): void {
    this.#live?.pause();
  }

  resumeReading(): void {
    this.#live?.resume();
  }

  /** Confirm everything received so far, the way a durable controller periodically would. */
  ackAll(): void {
    const ack = encode({
      frame: 'control',
      at: new Date().toISOString(),
      payload: { kind: 'link_ack', cursors: this.#cursors.cursors() },
    });
    if (ack.ok) this.#live?.send(ack.value);
  }

  #onMessage(socket: ServerSocket, raw: string): void {
    const decoded = decode(raw);
    if (!decoded.ok) return;
    const frame = decoded.value;

    if (frame.frame === 'control') {
      if (frame.payload.kind === 'link_hello') {
        const welcome = encode({
          frame: 'control',
          at: new Date().toISOString(),
          payload: {
            kind: 'link_welcome',
            protocolVersion: PROTOCOL_VERSION,
            capabilities: [],
            cursors: this.#cursors.cursors(),
          },
        });
        if (welcome.ok) socket.send(welcome.value);
      }
      return;
    }

    this.wireSeqs.push(frame.seq);
    const check = this.#cursors.accept(frame.sessionId, frame.seq);
    if (check.disposition === 'accept') {
      this.accepted.push(`${frame.sessionId}/${frame.seq}`);
      const body = (frame.payload as { body?: { index?: number } }).body;
      if (typeof body?.index === 'number') this.acceptedIndexes.push(body.index);
    } else if (check.disposition === 'gap') {
      this.gaps.push(`${frame.sessionId}/${frame.seq}`);
    }
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Teardown that actually completes; without it a failure here is invisible.
 *
 * `WebSocketServer.close(cb)` does not call back until every client connection has gone. `ws` does
 * not hang up live sockets on close, so a test that leaves one connected waits forever, and the
 * `await` sits in a `finally`, so it swallows whatever the test was actually failing on. On Linux
 * that shape shows as `server.close()` never calling back, node reporting "Promise resolution is
 * still pending but the event loop has already resolved", and the real assertion failures
 * underneath reported as `cancelledByParent` instead. A hang in teardown converts a legible red
 * into an illegible one.
 */
async function shutDown(link: { stop: (why: string) => void }, server: WebSocketServer): Promise<void> {
  link.stop('test finished');
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
}

/** Big enough that a write cannot fully flush inside the tick that issued it. */
const bulkyUpdate = (index: number) =>
  ({ kind: 'session_update', body: { index, text: 'x'.repeat(30_000) } }) as const;

test('frames held above the high-water mark are delivered in order with no reconnect', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const controller = new TestController(server);

  const transitions: LinkTransition[] = [];
  const link = new ControllerLink({
    url: `ws://127.0.0.1:${controller.port}`,
    hostId: 'test-host',
    heartbeatIntervalMs: 10_000,
    highWaterMarkBytes: 1,
    handlers: {
      onTransition: (transition) => transitions.push(transition),
      onSessionFrame: () => {},
      onGap: () => {},
      onRefusal: () => {},
    },
  });

  try {
    link.start();
    await waitFor(() => link.state === 'accepted', 'the link to open');
    // One frame through first, so the handshake is settled before the controller slows down.
    assert.ok(link.send('s-1', bulkyUpdate(1)).ok);
    await waitFor(() => controller.accepted.length === 1, 'the first frame to land');

    controller.stopReading();

    // How much a stopped reader can swallow is a kernel fact, not a constant, and guessing it
    // makes this test platform-specific. A fixed volume (24 frames, ~690 KB) is enough on Windows
    // loopback and not on Linux, where socket-buffer autotuning absorbs the lot, `bufferedAmount`
    // never crosses the one-byte mark, and the wait for the hold times out.
    //
    // So the volume is discovered rather than assumed: keep sending until the hold is observed,
    // then keep that number and assert every property against it. The cap is a bound on the test,
    // not a prediction about the platform, and it fails with a message that says which it hit.
    const CAP = 2_000;
    let sent = 1;
    while (link.queueStats.pendingDepth === 0 && sent < CAP) {
      sent += 1;
      assert.ok(link.send('s-1', bulkyUpdate(sent)).ok);
    }
    const COUNT = sent;

    // The receipt that the hold actually happened: once the kernel buffers fill, `bufferedAmount`
    // crosses the one-byte mark and the drain stops stamping; frames wait as pending, not
    // written and not dropped. Without this observation the rest of the test could pass on a
    // link that never held at all.
    await waitFor(() => link.queueStats.pendingDepth >= 1, 'backpressure to engage');
    assert.ok(
      COUNT < CAP,
      `sent ${CAP} frames (~${Math.round((CAP * 30) / 1024)} MB) to a stopped reader and the link never held — ` +
        `either backpressure is not engaging or this platform buffers without bound`,
    );
    assert.equal(link.queueStats.droppedDroppable, 0, 'backpressure holds; it does not drop');

    controller.resumeReading();
    await waitFor(() => controller.accepted.length === COUNT, 'the drain to deliver every held frame');
    assert.deepEqual(
      controller.accepted,
      Array.from({ length: COUNT }, (_, index) => `s-1/${index + 1}`),
      'delivery order is arrival order — a later send can never overtake a held one',
    );
    // Seq order alone cannot see a swap: numbers mint at write, in write order, whatever payload
    // gets them. The producer's own index is what proves no send overtook an earlier one.
    assert.deepEqual(
      controller.acceptedIndexes,
      Array.from({ length: COUNT }, (_, index) => index + 1),
      'payload order is send order',
    );
    assert.deepEqual(controller.gaps, [], 'no gap may be observed');
    // The wire is at-least-once by contract — the hello/welcome handshake can legally re-send an
    // early frame, so the pin is on order, not on write counts: first appearances must be dense
    // ascending, which a held frame overtaken by a later send would break.
    const firstAppearances = controller.wireSeqs.filter(
      (seq, index) => controller.wireSeqs.indexOf(seq) === index,
    );
    assert.deepEqual(
      firstAppearances,
      Array.from({ length: COUNT }, (_, index) => index + 1),
      'the drain writes in arrival order',
    );
    assert.equal(link.queueStats.pendingDepth, 0, 'nothing is left held');

    // The whole story happened on one socket: a reconnect would show up as a backoff transition.
    assert.ok(
      transitions.every((transition) => transition.to !== 'backoff'),
      `delivery must not depend on a reconnect; transitions: ${transitions.map((t) => `${t.from}->${t.to}`).join(', ')}`,
    );
  } finally {
    await shutDown(link, server);
  }
});

test('at capacity under backpressure the producer is refused, not silently held — and flow resumes', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const controller = new TestController(server);

  const link = new ControllerLink({
    url: `ws://127.0.0.1:${controller.port}`,
    hostId: 'test-host',
    heartbeatIntervalMs: 10_000,
    highWaterMarkBytes: 1,
    queueCapacity: 3,
    handlers: { onTransition: () => {}, onSessionFrame: () => {}, onGap: () => {}, onRefusal: () => {} },
  });

  try {
    link.start();
    await waitFor(() => link.state === 'accepted', 'the link to open');

    assert.ok(link.send('s-1', bulkyUpdate(1)).ok);
    assert.ok(link.send('s-1', bulkyUpdate(2)).ok);
    assert.ok(link.send('s-1', bulkyUpdate(3)).ok);

    const refused = link.send('s-1', bulkyUpdate(4));
    assert.equal(
      refused.ok,
      false,
      'a full retention window refuses — `ok` for an unheld frame would be a lie',
    );
    if (!refused.ok) assert.equal(refused.refusal.reason, 'queue-overflow-undroppable');

    await waitFor(() => controller.accepted.length === 3, 'the held frames to deliver');
    // Delivered is not released: the retention window frees on the controller's ack, and then the
    // producer's retry finds room. Refusal, then delivery, then ack, then retry is the whole
    // pressure loop.
    controller.ackAll();
    await waitFor(() => link.queueStats.depth === 0, 'the ack to release the retention window');
    assert.ok(link.send('s-1', bulkyUpdate(4)).ok, 'room exists once the controller has confirmed');
    await waitFor(() => controller.accepted.length === 4, 'the retried frame to deliver');
    assert.deepEqual(
      controller.accepted,
      ['s-1/1', 's-1/2', 's-1/3', 's-1/4'],
      'dense through refusal and retry',
    );
    assert.deepEqual(controller.gaps, []);
  } finally {
    await shutDown(link, server);
  }
});
