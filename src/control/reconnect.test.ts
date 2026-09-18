/**
 * Reconnect, against a real socket that is really killed.
 *
 * A mocked transport would prove the mock reconnects. The property here — that a link drop costs
 * neither a lost frame nor a duplicated one — only exists end to end, so the test stands up a
 * WebSocket server on loopback, terminates the connection mid-stream, and checks what the receiver
 * actually ended up holding.
 */
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ControllerLink } from './link.js';
import type { LinkTransition } from './link-state.js';
import { LINK_CAUSES } from './link-state.js';
import { decode, encode } from './codec.js';
import { PROTOCOL_VERSION } from './frames.js';
import { SeqTracker } from './seq.js';
import { rawText } from '../test-support/raw-text.js';

/** A controller that behaves like a real receiver: it dedupes and it reports gaps. */
class TestController {
  readonly server: WebSocketServer;
  readonly accepted: string[] = [];
  readonly gaps: string[] = [];
  readonly wireSeqs: number[] = [];
  /** Every hello's capabilities list, in arrival order. */
  readonly hellos: (readonly string[])[] = [];
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

  #onMessage(socket: ServerSocket, raw: string): void {
    const decoded = decode(raw);
    if (!decoded.ok) return;
    const frame = decoded.value;

    if (frame.frame === 'control') {
      if (frame.payload.kind === 'link_hello') {
        this.hellos.push(frame.payload.capabilities);
        // Tell the host exactly what has been received, so it replays from there and no further.
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

    this.wireSeqs.push(frame.seq);
    const check = this.#cursors.accept(frame.sessionId, frame.seq);
    if (check.disposition === 'accept') this.accepted.push(`${frame.sessionId}/${frame.seq}`);
    else if (check.disposition === 'gap') this.gaps.push(`${frame.sessionId}/${frame.seq}`);
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

test('a link drop mid-stream loses no frame and duplicates none', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const controller = new TestController(server);

  const transitions: LinkTransition[] = [];
  const link = new ControllerLink({
    url: `ws://127.0.0.1:${controller.port}`,
    hostId: 'test-host',
    backoff: { baseMs: 10, maxMs: 40, factor: 2 },
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 10_000,
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

    for (let index = 0; index < 2; index += 1) {
      link.send('s-1', { kind: 'session_update', body: { index } });
    }
    await waitFor(() => controller.accepted.length === 2, 'the first two frames to land');

    // The controller dies. The host cannot know yet — a socket close is asynchronous, so for the
    // next few ticks it still believes it has an open connection.
    controller.killConnection();
    assert.equal(link.state, 'accepted', 'the host must not have noticed yet; the loss window depends on it');

    // Written into a dead socket by a host that thinks it is alive. This is in-flight loss, and it
    // is the case a host that discards on write can never recover: these frames reach nobody and,
    // without retention, are gone. Sending them synchronously is what keeps that window open.
    for (let index = 2; index < 5; index += 1) {
      link.send('s-1', { kind: 'session_update', body: { index } });
    }

    await waitFor(() => link.state !== 'accepted', 'the link to notice the drop');
    assert.deepEqual(controller.accepted, ['s-1/1', 's-1/2'], 'frames 3..5 must genuinely be lost');

    // And more produced while it is down, so both loss modes are covered at once.
    for (let index = 5; index < 10; index += 1) {
      link.send('s-1', { kind: 'session_update', body: { index } });
    }

    await waitFor(() => controller.accepted.length >= 10, 'every frame to arrive after reconnect');

    assert.deepEqual(
      controller.accepted,
      Array.from({ length: 10 }, (_, index) => `s-1/${index + 1}`),
      'the accepted sequence must be continuous 1..10',
    );
    assert.deepEqual(controller.gaps, [], 'no gap may be observed');

    // Duplicates on the wire are legal and expected; replay is at-least-once. What must never
    // happen is a duplicate reaching the receiver's accepted set, and that is asserted above.
    assert.ok(
      controller.wireSeqs.length >= controller.accepted.length,
      'the wire carries at least what was accepted',
    );

    // Every state change explains itself. A reconnect nobody can attribute is the thing that makes
    // an unattended night unreadable afterwards.
    assert.ok(transitions.length >= 3, `expected real transitions, got ${transitions.length}`);
    for (const transition of transitions) {
      assert.ok(
        (LINK_CAUSES as readonly string[]).includes(transition.cause),
        `transition ${transition.from}->${transition.to} carried an unknown cause ${transition.cause}`,
      );
      assert.notEqual(transition.from, transition.to, 'a self-loop is not a transition');
    }
    assert.ok(
      transitions.some((transition) => transition.to === 'backoff'),
      'the drop must be visible as a caused transition, not inferred from silence',
    );
  } finally {
    link.stop('test finished');
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an acked frame is released, so the retention window does not grow without bound', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));

  const sockets: ServerSocket[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (data) => {
      const decoded = decode(rawText(data));
      if (!decoded.ok || decoded.value.frame !== 'control') return;
      if (decoded.value.payload.kind !== 'link_hello') return;
      const welcome = encode({
        frame: 'control',
        at: new Date().toISOString(),
        payload: {
          kind: 'link_welcome',
          protocolVersion: PROTOCOL_VERSION,
          protocolRange: null,
          capabilities: [],
          cursors: [],
        },
      });
      if (welcome.ok) socket.send(welcome.value);
    });
  });

  const link = new ControllerLink({
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hostId: 'test-host',
    heartbeatIntervalMs: 10_000,
    handlers: { onTransition: () => {}, onSessionFrame: () => {}, onGap: () => {}, onRefusal: () => {} },
  });

  try {
    link.start();
    await waitFor(() => link.state === 'accepted', 'the link to open');

    for (let index = 0; index < 4; index += 1) {
      link.send('s-1', { kind: 'session_update', body: { index } });
    }
    assert.equal(link.queueStats.depth, 4, 'written frames stay retained until acked');

    const ack = encode({
      frame: 'control',
      at: new Date().toISOString(),
      payload: { kind: 'link_ack', cursors: [{ sessionId: 's-1', seq: 3 }] },
    });
    assert.ok(ack.ok);
    sockets[0]?.send(ack.value);

    await waitFor(() => link.queueStats.depth === 1, 'the ack to release the confirmed frames');
  } finally {
    link.stop('test finished');
    await new Promise((resolve) => server.close(resolve));
  }
});

test('configured capability markers ride the hello beside bulk-post; unconfigured sends bulk-post alone', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const controller = new TestController(server);

  const quiet = { onTransition: () => {}, onSessionFrame: () => {}, onGap: () => {}, onRefusal: () => {} };
  const configured = new ControllerLink({
    url: `ws://127.0.0.1:${controller.port}`,
    hostId: 'test-host',
    backoff: { baseMs: 10, maxMs: 40, factor: 2 },
    capabilities: ['workspace:git-worktree', 'workspace:branch-scheme'],
    handlers: quiet,
  });

  try {
    configured.start();
    await waitFor(() => controller.hellos.length === 1, 'the configured hello');
    assert.deepEqual(
      controller.hellos[0],
      ['bulk-post', 'workspace:git-worktree', 'workspace:branch-scheme'],
      'the markers must ride beside the structural bulk-post, never replace it, and in a stable order',
    );
  } finally {
    configured.stop('test finished');
  }

  // The control: the same link with no capabilities option sends exactly the hello it sent before
  // markers existed, which is what makes the marker's absence mean "does not report".
  const bare = new ControllerLink({
    url: `ws://127.0.0.1:${controller.port}`,
    hostId: 'test-host',
    backoff: { baseMs: 10, maxMs: 40, factor: 2 },
    handlers: quiet,
  });
  try {
    bare.start();
    await waitFor(() => controller.hellos.length === 2, 'the bare hello');
    assert.deepEqual(
      controller.hellos[1],
      ['bulk-post'],
      'an unconfigured link must send the bare hello unchanged',
    );
  } finally {
    bare.stop('test finished');
    await new Promise((resolve) => server.close(resolve));
  }
});
