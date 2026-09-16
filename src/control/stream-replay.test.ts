/**
 * What a reconnect mid-turn actually delivers, measured.
 *
 * The rule is that high-frequency deltas are broadcast-only (never in a replay ring, never in the
 * durable store) because ~20 fragments per turn would evict real events from a bounded history.
 * This file measures the shipped transport against that, rather than asserting it, because the two
 * halves of "replay" are not the same thing and only one of them is this transport's:
 *
 *   retransmission: the host re-sends what the controller has not acked, from its retention
 *                   window. A frame that has been stamped has a seq, and the receiver's expected
 *                   next is `last + 1`, so a stamped frame that is never re-sent is a hole the
 *                   receiver can never fill. This lane cannot skip anything.
 *   history:        what a consumer reads back later, out of a bounded ring or a durable store.
 *                   This is what deltas must stay out of, and `MESSAGE_ROUTING` is the declaration
 *                   that keeps them out.
 *
 * A test that conflated them would either prove nothing or demand a hole. So both are measured
 * separately and stated separately.
 *
 * Its own harness, deliberately: `reconnect.test.ts` proves the basic reconnect and is not touched
 * by anything here.
 */
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ControllerLink } from './link.js';
import { decode, encode } from './codec.js';
import type { SessionPayload } from './frames.js';
import { PROTOCOL_VERSION, agentMessageDelta, agentMessageUpdate } from './frames.js';
import { SeqTracker } from './seq.js';
import { rawText } from '../test-support/raw-text.js';

const SESSION = 'controller-handle-1';

/** A controller that records what it received, in order, across connections. */
class TestController {
  readonly server: WebSocketServer;
  /** `kind/seq` for every session frame accepted as new. */
  readonly accepted: string[] = [];
  /** Every session frame that arrived at all, including duplicates a replay re-sent. */
  readonly arrived: string[] = [];
  readonly gaps: string[] = [];
  readonly #cursors = new SeqTracker();
  /** Frozen at the moment of the kill, so a cursor can be replayed from a mid-turn point. */
  #ackTo = 0;
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

  /** What this controller will claim to hold when the host says hello. */
  ackUpTo(seq: number): void {
    this.#ackTo = seq;
  }

  killConnection(): void {
    this.#live?.terminate();
    this.#live = null;
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
            cursors: this.#ackTo > 0 ? [{ sessionId: SESSION, seq: this.#ackTo }] : [],
          },
        });
        if (welcome.ok) socket.send(welcome.value);
      }
      return;
    }

    this.arrived.push(`${frame.payload.kind}/${frame.seq}`);
    const check = this.#cursors.accept(frame.sessionId, frame.seq);
    if (check.disposition === 'accept') this.accepted.push(`${frame.payload.kind}/${frame.seq}`);
    else if (check.disposition === 'gap') this.gaps.push(`${frame.payload.kind}/${frame.seq}`);
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

const update = (n: number): SessionPayload =>
  agentMessageUpdate({ type: 'assistant', uuid: `u-${n}`, message: { n } });
const delta = (n: number): SessionPayload =>
  agentMessageDelta({ type: 'stream_event', uuid: `d-${n}`, event: { delta: { text: `${n}` } } });

async function withLink(
  run: (link: ControllerLink, controller: TestController) => Promise<void>,
): Promise<void> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const controller = new TestController(server);
  const link = new ControllerLink({
    url: `ws://127.0.0.1:${controller.port}`,
    hostId: 'test-host',
    backoff: { baseMs: 10, maxMs: 40, factor: 2 },
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 10_000,
    handlers: {
      onTransition: () => {},
      onSessionFrame: () => {},
      onGap: () => {},
      onRefusal: () => {},
    },
  });
  try {
    await run(link, controller);
  } finally {
    link.stop();
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------

test('regression: a mid-turn reconnect delivers every event, and seq continuity holds with the stream lane added', async () => {
  await withLink(async (link, controller) => {
    link.start();
    await waitFor(() => link.state === 'accepted', 'the link to open');

    // A turn in flight: an event, then fragments, then the event that settles them.
    link.send(SESSION, update(1));
    link.send(SESSION, delta(1));
    link.send(SESSION, delta(2));
    await waitFor(() => controller.accepted.length === 3, 'the opening frames');

    // The controller has processed the first three and says so at the next hello.
    controller.ackUpTo(3);
    controller.killConnection();

    // Written into a socket the host still believes is open; these reach nobody.
    link.send(SESSION, delta(3));
    link.send(SESSION, update(2));
    link.send(SESSION, update(3));

    await waitFor(() => link.state === 'accepted', 'the link to come back');
    await waitFor(() => controller.accepted.length >= 6, 'the rest of the turn to arrive');

    // Every event is present exactly once, and the numbering has no hole in it.
    const seqs = controller.accepted.map((entry) => Number(entry.split('/')[1]));
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6], 'dense from 1 across the drop — no gap, no duplicate');
    assert.deepEqual(controller.gaps, [], 'the receiver never saw a hole it could not fill');

    const events = controller.accepted.filter((entry) => entry.startsWith('session_update'));
    assert.deepEqual(
      events,
      ['session_update/1', 'session_update/5', 'session_update/6'],
      'no event was lost to the drop — a stamped frame is retained until acked',
    );
  });
});

// The measurement that matters, and its answer is not the obvious one. A delta that has already
// been stamped and written is retransmitted after a drop, because it holds a seq and the receiver's
// arithmetic is `last + 1`; withdrawing it would put a hole in the numbering that nothing can
// heal, which is exactly the defect the retention window was built to close. So the droppable rule
// is about what may be discarded before it is numbered, not about what may be skipped afterwards.
//
// Stated as a test rather than a comment because a later reader of "deltas never enter the
// replay path" would otherwise be entitled to make retransmission skip them, and that change looks
// correct and silently reintroduces the hole.
test('regression: an unacked delta is retransmitted — because a minted seq must always be accounted for', async () => {
  await withLink(async (link, controller) => {
    link.start();
    await waitFor(() => link.state === 'accepted', 'the link to open');

    link.send(SESSION, update(1));
    link.send(SESSION, delta(1));
    await waitFor(() => controller.accepted.length === 2, 'the first two frames');

    // The controller acks nothing, so both frames are still owed when the socket dies.
    controller.ackUpTo(0);
    controller.killConnection();
    await waitFor(() => link.state === 'accepted', 'the link to come back');
    await waitFor(() => controller.arrived.length >= 4, 'the retransmission');

    assert.ok(
      controller.arrived.filter((entry) => entry === 'session_delta/2').length >= 2,
      'the delta was re-sent rather than skipped',
    );
    // And re-sending costs nothing: the receiver's own tracker makes it exactly-once.
    assert.deepEqual(controller.accepted, ['session_update/1', 'session_delta/2']);
    assert.deepEqual(controller.gaps, []);
  });
});

// The half of the property this transport does own: a delta is the only thing that may be discarded
// when the offline queue is full, and it is discarded before it is numbered, so the loss costs a
// repaint and leaves the wire's arithmetic intact. An event in the same position is refused loudly
// instead. Together with `MESSAGE_ROUTING` declaring which messages are deltas, this is what keeps
// a bounded history from filling with fragments.
test('under pressure the deltas give way and the events do not — and the numbering survives both', async () => {
  await withLink(async (link, controller) => {
    const refusals: string[] = [];
    const tiny = new ControllerLink({
      url: `ws://127.0.0.1:${controller.port}`,
      hostId: 'test-host-2',
      queueCapacity: 3,
      backoff: { baseMs: 10, maxMs: 40, factor: 2 },
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 10_000,
      handlers: {
        onTransition: () => {},
        onSessionFrame: () => {},
        onGap: () => {},
        onRefusal: (refusal) => refusals.push(refusal.reason),
      },
    });
    // Never started: nothing can drain, so every send stacks up against the capacity.
    try {
      assert.equal(tiny.send(SESSION, delta(1)).ok, true);
      assert.equal(tiny.send(SESSION, delta(2)).ok, true);
      assert.equal(tiny.send(SESSION, delta(3)).ok, true);

      // At capacity: an event displaces the oldest delta rather than being lost itself.
      assert.equal(tiny.send(SESSION, update(1)).ok, true);
      assert.equal(refusals.at(-1), 'queue-dropped-droppable');

      // Each further event costs one more delta, until there are no deltas left to give.
      tiny.send(SESSION, update(2));
      tiny.send(SESSION, update(3));
      assert.equal(tiny.queueStats.droppedDroppable, 3, 'all three fragments gave way to events');

      // Full of undroppables, an event is refused loudly, never silently discarded.
      const refused = tiny.send(SESSION, update(4));
      assert.equal(refused.ok, false);
      assert.equal(refused.ok === false && refused.refusal.reason, 'queue-overflow-undroppable');
      assert.equal(tiny.queueStats.refusedUndroppable, 1);
      assert.equal(tiny.queueStats.depth, 3, 'the three events that displaced them are all still held');
    } finally {
      tiny.stop();
    }
    await Promise.resolve();
  });
});
