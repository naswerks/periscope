/**
 * Three transport properties, each against a real socket.
 *
 * Every one of these is a failure whose signature is silence: a wedged lane that reports nothing, a
 * retention hold that grows forever, a reconnect loop that looks like a healthy retry. None of them
 * can be observed from a return value, so each test watches what actually crosses the wire or what
 * the link actually reports, and each has a control that fails when the defence is removed.
 */
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ControllerLink } from './link.js';
import type { Refusal } from '../core/refusal.js';
import type { Frame } from './frames.js';
import { PROTOCOL_VERSION, readWireRefusal } from './frames.js';
import { decode, encode } from './codec.js';
import { waitFor } from '../test-support/ws-peer.js';
import { rawText } from '../test-support/raw-text.js';

/** A controller that answers the handshake with whatever version the test tells it to. */
class Peer {
  readonly server: WebSocketServer;
  readonly received: Frame[] = [];
  /** When each inbound connection was accepted: the backoff, measured rather than parsed. */
  readonly connectedAtMs: number[] = [];
  /**
   * The receiver's own dedupe, and leaving it out makes a test lie. The wire is at-least-once and
   * exactly-once only after a `SeqTracker`: never assert exact wire sequences in a test, because
   * the handshake legally re-sends an early written-unacked frame. This peer never acks, so every
   * reconnect replays what it holds, and counting raw arrivals would report a single emission as
   * two. A real controller dedupes exactly this way.
   */
  readonly #seen = new Set<string>();
  #live: ServerSocket | null = null;

  constructor(
    server: WebSocketServer,
    private readonly welcomeVersion: number,
  ) {
    this.server = server;
    server.on('connection', (socket) => {
      this.#live = socket;
      this.connectedAtMs.push(Date.now());
      socket.on('message', (data) => this.#onMessage(socket, rawText(data)));
    });
  }

  /** The gaps between successive connection attempts: what the backoff actually produced. */
  reconnectGapsMs(): number[] {
    return this.connectedAtMs.slice(1).map((at, index) => at - this.connectedAtMs[index]!);
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** Push a raw session frame at the host, at whatever seq the test wants. */
  send(sessionId: string, seq: number): void {
    const encoded = encode({
      frame: 'session',
      sessionId,
      seq,
      at: new Date().toISOString(),
      payload: { kind: 'session_prompt', text: `turn-${seq}` },
    });
    if (encoded.ok) this.#live?.send(encoded.value);
  }

  /** Every `wire_refusal` update the host sent back, deduped by seq the way a receiver must. */
  wireRefusals(): { reason: string; expected: number; received: number }[] {
    return this.received.flatMap((frame) => {
      if (frame.frame !== 'session' || frame.payload.kind !== 'session_update') return [];
      const read = readWireRefusal(frame.payload.body);
      return read === null
        ? []
        : [{ reason: read.refusal.reason, expected: read.expected, received: read.received }];
    });
  }

  #onMessage(socket: ServerSocket, raw: string): void {
    const decoded = decode(raw);
    if (!decoded.ok) return;
    const frame = decoded.value;
    if (frame.frame === 'session') {
      // Exactly-once, after the receiver's own filter. A replayed frame costs nothing and must not
      // be counted twice; see `#seen`.
      const id = `${frame.sessionId}/${frame.seq}`;
      if (this.#seen.has(id)) return;
      this.#seen.add(id);
    }
    this.received.push(frame);
    if (decoded.value.frame === 'control' && decoded.value.payload.kind === 'link_hello') {
      const welcome = encode({
        frame: 'control',
        at: new Date().toISOString(),
        payload: {
          kind: 'link_welcome',
          protocolVersion: this.welcomeVersion,
          protocolRange: null,
          capabilities: [],
          cursors: [],
        },
      });
      if (welcome.ok) socket.send(welcome.value);
    }
  }
}

async function peerOn(welcomeVersion: number): Promise<Peer> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  return new Peer(server, welcomeVersion);
}

// ---------------------------------------------------------------------------
// 1. A gap emits, and the emission carries the number that heals it.
// ---------------------------------------------------------------------------

test('regression: a gapped inbound frame puts a seq-gap refusal on the wire, carrying the seq to re-send from', async () => {
  const peer = await peerOn(PROTOCOL_VERSION);
  const gaps: string[] = [];
  const link = new ControllerLink({
    url: `ws://127.0.0.1:${peer.port}`,
    hostId: 'test-host',
    backoff: { baseMs: 10, maxMs: 40, factor: 2 },
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 60_000,
    handlers: {
      onTransition: () => {},
      onSessionFrame: () => {},
      onGap: (sessionId, expected, received) => gaps.push(`${sessionId} ${expected} ${received}`),
      onRefusal: () => {},
    },
  });

  try {
    link.start();
    await waitFor(() => link.state === 'accepted', 'the link to open');

    // seq 1 lands. seq 3 is a hole: 2 never arrived, and nothing in this protocol can ask for it.
    peer.send('s-1', 1);
    peer.send('s-1', 3);
    await waitFor(() => peer.wireRefusals().length > 0, 'the wedge to be reported back');

    const reported = peer.wireRefusals();
    assert.equal(reported.length, 1, 'the wedge was reported more than once, or not at all');
    assert.equal(reported[0]?.reason, 'seq-gap');
    assert.equal(reported[0]?.expected, 2, 'the emission must carry the seq the sender should resume from');
    assert.equal(reported[0]?.received, 3);

    // The host-local event still fires: the wire refusal adds a lane, it does not replace one.
    assert.deepEqual(gaps, ['s-1 2 3'], 'the host-local onGap stopped firing');
  } finally {
    link.stop();
    peer.server.close();
  }
});

test('regression: the wedge is reported once, not once per later frame — a lost frame must not become a storm', async () => {
  const peer = await peerOn(PROTOCOL_VERSION);
  const link = new ControllerLink({
    url: `ws://127.0.0.1:${peer.port}`,
    hostId: 'test-host',
    backoff: { baseMs: 10, maxMs: 40, factor: 2 },
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 60_000,
    handlers: { onTransition: () => {}, onSessionFrame: () => {}, onGap: () => {}, onRefusal: () => {} },
  });

  try {
    link.start();
    await waitFor(() => link.state === 'accepted', 'the link to open');

    peer.send('s-1', 1);
    // Once `last` stops advancing, every later frame is also a gap. Reporting each one would aim a
    // frame storm at the peer that is already in trouble.
    for (const seq of [3, 4, 5, 6]) peer.send('s-1', seq);
    await waitFor(() => peer.wireRefusals().length > 0, 'the first wedge report');
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(peer.wireRefusals().length, 1, 'the wedge was reported once per gapped frame');
  } finally {
    link.stop();
    peer.server.close();
  }
});

test('regression: a healed lane can be reported again — the suppression is per wedge, not per session forever', async () => {
  const peer = await peerOn(PROTOCOL_VERSION);
  const link = new ControllerLink({
    url: `ws://127.0.0.1:${peer.port}`,
    hostId: 'test-host',
    backoff: { baseMs: 10, maxMs: 40, factor: 2 },
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 60_000,
    handlers: { onTransition: () => {}, onSessionFrame: () => {}, onGap: () => {}, onRefusal: () => {} },
  });

  try {
    link.start();
    await waitFor(() => link.state === 'accepted', 'the link to open');

    peer.send('s-1', 1);
    peer.send('s-1', 3);
    await waitFor(() => peer.wireRefusals().length === 1, 'the first wedge report');

    // The peer does what the emission told it to: re-send from `expected`. The lane heals.
    peer.send('s-1', 2);
    peer.send('s-1', 3);
    // ...and then gaps again later. A session that wedges twice must be reportable twice, or the
    // second outage is invisible for the life of the session.
    peer.send('s-1', 9);
    await waitFor(() => peer.wireRefusals().length === 2, 'the second wedge report after healing');

    const reported = peer.wireRefusals();
    assert.equal(
      reported[1]?.expected,
      4,
      'the second report must carry the position the healed lane reached',
    );
  } finally {
    link.stop();
    peer.server.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Ended-session retention is bounded, and the release is named.
// ---------------------------------------------------------------------------

test('regression: an ended session whose frames are never acked is released, and the release says so', async () => {
  const peer = await peerOn(PROTOCOL_VERSION);
  const refusals: Refusal[] = [];
  const link = new ControllerLink({
    url: `ws://127.0.0.1:${peer.port}`,
    hostId: 'test-host',
    backoff: { baseMs: 10, maxMs: 40, factor: 2 },
    // The sweep rides this tick. Fast here so the test does not wait a minute for a property that
    // has nothing to do with wall-clock time.
    heartbeatIntervalMs: 20,
    heartbeatTimeoutMs: 60_000,
    // The bound is the decision; the number is a knob so this test measures the mechanism rather
    // than waiting out a real minute. The shipped default stays 60_000; see ENDED_RETENTION_MS.
    endedRetentionMs: 40,
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

    link.send('s-dead', { kind: 'session_update', body: { update: 'state_transition' } });
    await waitFor(() => link.queueStats.depth === 1, 'the frame to be retained');

    // The session ends. This peer never sends `link_ack` — nothing in the protocol obliges it to,
    // and that is the whole failure: written frames are never eviction candidates, so without a
    // bound this entry is held for the life of the host, on every ended session.
    link.forgetSession('s-dead');
    assert.equal(
      link.queueStats.depth,
      1,
      'the frame must be held first — the bound is a delay, not a discard',
    );

    await waitFor(
      () => refusals.some((one) => one.reason === 'retention-released-unacked'),
      'the bounded release',
    );

    assert.equal(link.queueStats.depth, 0, 'the retention was never actually released');
    const released = refusals.find((one) => one.reason === 'retention-released-unacked');
    assert.match(released?.detail ?? '', /s-dead/, 'the release must name the session whose frames went');
    assert.match(released?.detail ?? '', /no longer be replayed/, 'the release must say what was lost');
  } finally {
    link.stop();
    peer.server.close();
  }
});

test('an acked ended session is released immediately and never raises the bounded-release refusal', async () => {
  // The negative half: the bound exists for the unacked case only. A controller doing its job must
  // never see a refusal telling it frames were dropped, or the signal becomes noise and gets muted.
  const peer = await peerOn(PROTOCOL_VERSION);
  const refusals: Refusal[] = [];
  const link = new ControllerLink({
    url: `ws://127.0.0.1:${peer.port}`,
    hostId: 'test-host',
    backoff: { baseMs: 10, maxMs: 40, factor: 2 },
    heartbeatIntervalMs: 20,
    heartbeatTimeoutMs: 60_000,
    // Same knob as above: the bound is the decision, the number keeps the test fast.
    endedRetentionMs: 40,
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
    link.send('s-tidy', { kind: 'session_update', body: { update: 'state_transition' } });
    await waitFor(() => link.queueStats.depth === 1, 'the frame to be retained');
    link.forgetSession('s-tidy');

    // The controller acks, which is the path the retention window was designed around.
    const ack = encode({
      frame: 'control',
      at: new Date().toISOString(),
      payload: { kind: 'link_ack', cursors: [{ sessionId: 's-tidy', seq: 1 }] },
    });
    assert.equal(ack.ok, true);
    peer.server.clients.forEach((socket) => socket.send(ack.ok ? ack.value : ''));

    await waitFor(() => link.queueStats.depth === 0, 'the ack to release the retention');
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(
      refusals.some((one) => one.reason === 'retention-released-unacked'),
      false,
      'an acked release reported frames as lost — the two paths must never look alike',
    );
  } finally {
    link.stop();
    peer.server.close();
  }
});

// ---------------------------------------------------------------------------
// 3. A rejected handshake backs off. It does not spin.
// ---------------------------------------------------------------------------

test('regression: a version the peer will never accept produces growing backoff, not a 2 Hz reconnect loop', async () => {
  // The failure this prevents: resetting `#attempt` on socket open sends every rejected handshake
  // back to attempt 0, which has zero jitter span, so the host hammers a controller that is never
  // going to accept it, forever. A version mismatch is the single most likely first-contact
  // failure the moment PROTOCOL_VERSION moves.
  //
  // Measured at the socket, not read off a transition detail. Watching the transition stream for
  // `retry in Nms` sees nothing: `LinkStateMachine.to()` returns null on a self-transition, and
  // `retry_scheduled` is backoff -> backoff, so that instrument is structurally incapable of
  // observing the thing it is pointed at. Counting connection attempts at the peer cannot be
  // blind that way: a reconnect either happened or it did not.
  const peer = await peerOn(PROTOCOL_VERSION + 1);
  const link = new ControllerLink({
    url: `ws://127.0.0.1:${peer.port}`,
    hostId: 'test-host',
    backoff: { baseMs: 30, maxMs: 10_000, factor: 2 },
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 60_000,
    // Jitter pinned to the ceiling so the sequence under test is the backoff, not the spread on it.
    random: () => 1,
    handlers: { onTransition: () => {}, onSessionFrame: () => {}, onGap: () => {}, onRefusal: () => {} },
  });

  try {
    link.start();
    await waitFor(() => peer.connectedAtMs.length >= 4, 'four rejected handshakes');
    link.stop();

    const gaps = peer.reconnectGapsMs();
    assert.ok(gaps.length >= 3, `too few reconnects to judge growth: ${gaps.join(', ')}`);
    assert.ok(
      gaps[gaps.length - 1]! > gaps[0]!,
      `backoff did not grow across rejected handshakes (${gaps.join(', ')}ms) — the socket opens every ` +
        `time, so resetting on open makes every retry attempt 0 and this becomes a flat hot loop`,
    );
  } finally {
    link.stop();
    peer.server.close();
  }
});

test('a handshake the peer accepts still resets the backoff — the reset lives on the accepted branch', async () => {
  // The other half. Without this, "backoff grows" could be satisfied by never resetting at all,
  // which would punish a link that recovers normally.
  const peer = await peerOn(PROTOCOL_VERSION);
  const link = new ControllerLink({
    url: `ws://127.0.0.1:${peer.port}`,
    hostId: 'test-host',
    backoff: { baseMs: 30, maxMs: 10_000, factor: 2 },
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 60_000,
    random: () => 1,
    handlers: { onTransition: () => {}, onSessionFrame: () => {}, onGap: () => {}, onRefusal: () => {} },
  });

  try {
    link.start();
    await waitFor(() => link.state === 'accepted', 'the first accepted handshake');

    // Three good handshakes, each killed. Every reconnect follows an accepted one, so every wait
    // must be attempt 0: flat, never growing.
    for (let round = 0; round < 3; round += 1) {
      const before = peer.connectedAtMs.length;
      peer.server.clients.forEach((socket) => socket.terminate());
      await waitFor(() => peer.connectedAtMs.length > before, 'the link to come back');
      await waitFor(() => link.state === 'accepted', 'the handshake to complete again');
    }

    const gaps = peer.reconnectGapsMs();
    assert.ok(gaps.length >= 3, `too few reconnects to judge: ${gaps.join(', ')}`);
    assert.ok(
      gaps.every((gap) => gap < 400),
      `the backoff did not reset after good handshakes — it grew instead: ${gaps.join(', ')}ms`,
    );
  } finally {
    link.stop();
    peer.server.close();
  }
});
