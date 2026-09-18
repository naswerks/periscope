/**
 * The property: designed loss cannot put a hole in the wire's numbering.
 *
 * A `seq` is minted only when a frame is first written, so anything refused or discarded before
 * that point never had one — and the receiver's `last + 1` arithmetic keeps working through every
 * loss path the sender owns: an oversized payload, a discard at capacity, a displacement under
 * pressure. Each test here drops something on purpose and then proves the stream still delivers,
 * against a real socket, because the original defect was invisible to anything less end-to-end.
 */
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Refusal } from '../core/refusal.js';
import { ControllerLink } from './link.js';
import { decode, encode } from './codec.js';
import { PROTOCOL_VERSION } from './frames.js';
import { SeqTracker } from './seq.js';
import { rawText } from '../test-support/raw-text.js';

/** A controller that behaves like a real receiver: it dedupes, reports gaps, and can ack. */
class TestController {
  readonly server: WebSocketServer;
  readonly accepted: string[] = [];
  readonly acceptedKinds: string[] = [];
  readonly gaps: string[] = [];
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

  /** Kill the connection the way a crashed controller does — no close handshake. */
  killConnection(): void {
    this.#live?.terminate();
    this.#live = null;
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
            protocolRange: null,
            capabilities: [],
            cursors: this.#cursors.cursors(),
          },
        });
        if (welcome.ok) socket.send(welcome.value);
      }
      return;
    }

    const check = this.#cursors.accept(frame.sessionId, frame.seq);
    if (check.disposition === 'accept') {
      this.accepted.push(`${frame.sessionId}/${frame.seq}`);
      this.acceptedKinds.push(frame.payload.kind);
    } else if (check.disposition === 'gap') {
      this.gaps.push(`${frame.sessionId}/${frame.seq}`);
    }
  }
}

async function withController(
  run: (controller: TestController, makeLink: (options?: LinkTestOptions) => ControllerLink) => Promise<void>,
): Promise<void> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const controller = new TestController(server);

  const links: ControllerLink[] = [];
  const makeLink = (options: LinkTestOptions = {}): ControllerLink => {
    const link = new ControllerLink({
      url: `ws://127.0.0.1:${controller.port}`,
      hostId: 'test-host',
      backoff: { baseMs: 10, maxMs: 40, factor: 2 },
      heartbeatIntervalMs: 10_000,
      queueCapacity: options.queueCapacity ?? 100,
      handlers: {
        onTransition: () => {},
        onSessionFrame: () => {},
        onGap: () => {},
        onRefusal: (refused) => options.refusals?.push(refused),
      },
    });
    links.push(link);
    return link;
  };

  try {
    await run(controller, makeLink);
  } finally {
    for (const link of links) link.stop('test finished');
    await new Promise((resolve) => server.close(resolve));
  }
}

interface LinkTestOptions {
  queueCapacity?: number;
  refusals?: Refusal[];
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const update = (index: number) => ({ kind: 'session_update', body: { index } }) as const;
const delta = (index: number) => ({ kind: 'session_delta', body: { index } }) as const;

test('an oversized payload is refused before it has a number — the stream continues with no gap', async () => {
  await withController(async (controller, makeLink) => {
    const refusals: Refusal[] = [];
    const link = makeLink({ refusals });
    link.start();
    await waitFor(() => link.state === 'accepted', 'the link to open');

    assert.ok(link.send('s-1', update(1)).ok);

    const oversized = link.send('s-1', { kind: 'session_delta', body: { text: 'x'.repeat(70_000) } });
    assert.equal(oversized.ok, false, 'a frame over the limit must be refused at send');
    if (!oversized.ok) assert.equal(oversized.refusal.reason, 'frame-too-large');
    assert.ok(refusals.some((refused) => refused.reason === 'frame-too-large'));

    assert.ok(link.send('s-1', update(2)).ok);

    await waitFor(() => controller.accepted.length === 2, 'both surviving frames to land');
    assert.deepEqual(controller.accepted, ['s-1/1', 's-1/2'], 'the refusal must not consume a number');
    assert.deepEqual(controller.gaps, [], 'no gap may be observed');
  });
});

test('a delta discarded at capacity has no number to miss — the stream delivers dense', async () => {
  await withController(async (controller, makeLink) => {
    const refusals: Refusal[] = [];
    // Not started yet: everything queues, which is how capacity pressure builds.
    const link = makeLink({ queueCapacity: 2, refusals });

    assert.ok(link.send('s-1', update(1)).ok);
    assert.ok(link.send('s-1', update(2)).ok);

    const discarded = link.send('s-1', delta(3));
    assert.equal(discarded.ok, false, 'an incoming delta at capacity is discarded, and the caller told');
    if (!discarded.ok) assert.equal(discarded.refusal.reason, 'queue-dropped-droppable');

    link.start();
    await waitFor(() => controller.accepted.length === 2, 'the retained frames to land');
    assert.deepEqual(
      controller.accepted,
      ['s-1/1', 's-1/2'],
      'dense from 1 — the discard never existed on the wire',
    );
    assert.deepEqual(controller.gaps, [], 'no gap may be observed');
  });
});

test('a displaced pending delta is loud and leaves no hole', async () => {
  await withController(async (controller, makeLink) => {
    const refusals: Refusal[] = [];
    const link = makeLink({ queueCapacity: 2, refusals });

    assert.ok(link.send('s-1', delta(1)).ok, 'the delta is accepted while there is room');
    assert.ok(link.send('s-1', update(2)).ok);
    assert.ok(link.send('s-1', update(3)).ok, 'the transition must find room by displacing the delta');

    const loud = refusals.find((refused) => refused.reason === 'queue-dropped-droppable');
    assert.ok(loud !== undefined, 'a displacement fires onRefusal — the loss has a name, not just a counter');
    assert.match(loud.detail, /session_delta/, 'the refusal names what was lost');
    assert.match(loud.detail, /s-1/, 'and whose it was');

    link.start();
    await waitFor(() => controller.accepted.length === 2, 'the surviving frames to land');
    assert.deepEqual(
      controller.accepted,
      ['s-1/1', 's-1/2'],
      'dense — the displaced delta never had a number',
    );
    assert.deepEqual(controller.acceptedKinds, ['session_update', 'session_update']);
    assert.deepEqual(controller.gaps, [], 'no gap may be observed');
  });
});

test('a written frame is never displaced — the refusal is pressure, and an ack releases it', async () => {
  await withController(async (controller, makeLink) => {
    const refusals: Refusal[] = [];
    const link = makeLink({ queueCapacity: 2, refusals });
    link.start();
    await waitFor(() => link.state === 'accepted', 'the link to open');

    // Both frames write straight through and stay retained awaiting an ack: the queue is now full
    // of written frames, one of them a delta whose number is already on the wire.
    assert.ok(link.send('s-1', delta(1)).ok);
    assert.ok(link.send('s-1', update(2)).ok);
    await waitFor(() => controller.accepted.length === 2, 'both frames to land');

    const refused = link.send('s-1', update(3));
    assert.equal(refused.ok, false, 'displacing the written delta would hole the wire; refusing is honest');
    if (!refused.ok) assert.equal(refused.refusal.reason, 'queue-overflow-undroppable');
    assert.equal(link.queueStats.refusedUndroppable, 1);

    // The refusal is backpressure, not a wedge: the moment the controller confirms, flow resumes.
    controller.ackAll();
    await waitFor(() => link.queueStats.depth === 0, 'the ack to release the retention window');
    assert.ok(link.send('s-1', update(3)).ok);
    await waitFor(() => controller.accepted.length === 3, 'the retried frame to land');
    assert.deepEqual(controller.accepted, ['s-1/1', 's-1/2', 's-1/3'], 'dense through refusal and release');
    assert.deepEqual(controller.gaps, []);
  });
});

test('drop-then-deliver: a burst over capacity loses only deltas, and a reconnect changes nothing', async () => {
  await withController(async (controller, makeLink) => {
    const refusals: Refusal[] = [];
    const link = makeLink({ queueCapacity: 4, refusals });

    assert.ok(link.send('s-1', update(1)).ok);
    assert.ok(link.send('s-1', delta(2)).ok);
    assert.ok(link.send('s-1', delta(3)).ok);
    assert.ok(link.send('s-1', update(4)).ok);
    assert.ok(link.send('s-1', update(5)).ok, 'displaces the oldest pending delta');
    assert.equal(link.send('s-1', delta(6)).ok, false, 'discarded at capacity');
    assert.equal(link.queueStats.droppedDroppable, 2, 'one displaced + one discarded');

    link.start();
    await waitFor(() => controller.accepted.length === 4, 'every retained frame to land');
    assert.deepEqual(controller.accepted, ['s-1/1', 's-1/2', 's-1/3', 's-1/4'], 'dense despite two drops');
    assert.deepEqual(
      controller.acceptedKinds,
      ['session_update', 'session_delta', 'session_update', 'session_update'],
      'every fact survived; only a repaint went',
    );

    // The controller confirms what it has, then crashes and comes back. The straggler produced
    // while it was down is delivered on reconnect, numbered right after what was confirmed.
    controller.ackAll();
    await waitFor(() => link.queueStats.depth === 0, 'the ack to release the retention window');
    controller.killConnection();
    await waitFor(() => link.state !== 'accepted', 'the link to notice the drop');
    assert.ok(link.send('s-1', update(7)).ok, 'produced while down');
    await waitFor(() => controller.accepted.length === 5, 'the reconnect to deliver the straggler');
    assert.deepEqual(controller.accepted, ['s-1/1', 's-1/2', 's-1/3', 's-1/4', 's-1/5']);
    assert.deepEqual(controller.gaps, [], 'no gap may ever be observed');
  });
});
