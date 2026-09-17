/**
 * The version window at the handshake: the hello advertises the versions this host speaks, the
 * controller answers with its choice, and the host accepts any version inside its own window. A
 * refusal names both windows, whether it arrives as a welcome outside the window or as a protocol
 * close from a controller that found no overlap.
 */
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ControllerLink } from './link.js';
import type { LinkTransition } from './link-state.js';
import { PROTOCOL_VERSION, PROTOCOL_VERSION_MIN } from './frames.js';
import { decode, encode } from './codec.js';
import { waitFor } from '../test-support/ws-peer.js';
import { rawText } from '../test-support/raw-text.js';

type Answer = { readonly welcome: number } | { readonly close: [code: number, reason: string] };

/** A controller that reads the hello's window and answers as told; the hello it saw is kept for assertions. */
class Peer {
  readonly server: WebSocketServer;
  hello: {
    readonly protocolVersion: number;
    readonly protocolRange: { readonly min: number; readonly max: number };
  } | null = null;

  constructor(
    server: WebSocketServer,
    private readonly answer: Answer,
  ) {
    this.server = server;
    server.on('connection', (socket) => {
      socket.on('message', (data) => this.#onMessage(socket, rawText(data)));
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  #onMessage(socket: ServerSocket, raw: string): void {
    const decoded = decode(raw);
    if (!decoded.ok || decoded.value.frame !== 'control' || decoded.value.payload.kind !== 'link_hello')
      return;
    const { protocolVersion, protocolRange } = decoded.value.payload;
    this.hello = { protocolVersion, protocolRange };
    if ('close' in this.answer) {
      socket.close(...this.answer.close);
      return;
    }
    const welcome = encode({
      frame: 'control',
      at: new Date().toISOString(),
      payload: { kind: 'link_welcome', protocolVersion: this.answer.welcome, capabilities: [], cursors: [] },
    });
    if (welcome.ok) socket.send(welcome.value);
  }
}

async function peerThat(answer: Answer): Promise<Peer> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  return new Peer(server, answer);
}

function linkTo(peer: Peer, transitions: LinkTransition[]): ControllerLink {
  return new ControllerLink({
    url: `ws://127.0.0.1:${peer.port}`,
    hostId: 'test-host',
    backoff: { baseMs: 10, maxMs: 40, factor: 2 },
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 60_000,
    handlers: {
      onTransition: (transition) => transitions.push(transition),
      onSessionFrame: () => {},
      onGap: () => {},
      onRefusal: () => {},
    },
  });
}

const rejection = (transitions: readonly LinkTransition[]): LinkTransition | undefined =>
  transitions.find((one) => one.cause === 'protocol_version_rejected');

test('the hello advertises the window beside the newest version', async () => {
  const peer = await peerThat({ welcome: PROTOCOL_VERSION });
  const transitions: LinkTransition[] = [];
  const link = linkTo(peer, transitions);
  try {
    link.start();
    await waitFor(() => link.state === 'accepted', 'the handshake to complete');
    assert.deepEqual(peer.hello, {
      protocolVersion: PROTOCOL_VERSION,
      protocolRange: { min: PROTOCOL_VERSION_MIN, max: PROTOCOL_VERSION },
    });
  } finally {
    link.stop();
    peer.server.close();
  }
});

for (const chosen of [PROTOCOL_VERSION_MIN, PROTOCOL_VERSION]) {
  test(`a welcome at v${chosen}, inside the window, is accepted and recorded as the negotiated version`, async () => {
    const peer = await peerThat({ welcome: chosen });
    const transitions: LinkTransition[] = [];
    const link = linkTo(peer, transitions);
    try {
      link.start();
      await waitFor(() => link.state === 'accepted', 'the handshake to complete');
      assert.equal(link.negotiatedVersion, chosen);
      const accepted = transitions.find((one) => one.cause === 'hello_completed');
      assert.equal(accepted?.from, 'open');
      assert.equal(accepted?.to, 'accepted');
      assert.equal(accepted?.detail, `protocol v${chosen}`);
      assert.equal(rejection(transitions), undefined, 'nothing was refused');
    } finally {
      link.stop();
      peer.server.close();
    }
  });
}

for (const outside of [PROTOCOL_VERSION_MIN - 1, PROTOCOL_VERSION + 1]) {
  test(`control: a welcome at v${outside}, outside the window, is refused naming both windows`, async () => {
    const peer = await peerThat({ welcome: outside });
    const transitions: LinkTransition[] = [];
    const link = linkTo(peer, transitions);
    try {
      link.start();
      await waitFor(() => rejection(transitions) !== undefined, 'the refusal');
      const refused = rejection(transitions);
      assert.match(refused?.detail ?? '', new RegExp(`controller chose v${outside}`));
      assert.match(refused?.detail ?? '', new RegExp(`v${PROTOCOL_VERSION_MIN} to v${PROTOCOL_VERSION}`));
      assert.equal(link.negotiatedVersion, null, 'a refused welcome negotiates nothing');
      assert.notEqual(link.state, 'accepted');
    } finally {
      link.stop();
      peer.server.close();
    }
  });
}

test('a protocol close (1002) from the controller is read as the version refusal, carrying its reason', async () => {
  const reason = 'host speaks v8-v9; this controller speaks v12-v13';
  const peer = await peerThat({ close: [1002, reason] });
  const transitions: LinkTransition[] = [];
  const link = linkTo(peer, transitions);
  try {
    link.start();
    await waitFor(() => rejection(transitions) !== undefined, 'the refusal');
    assert.equal(rejection(transitions)?.detail, reason);
    assert.equal(link.negotiatedVersion, null);
  } finally {
    link.stop();
    peer.server.close();
  }
});

test('control: an ordinary close (1000) is a dropped socket, not a version refusal', async () => {
  const peer = await peerThat({ close: [1000, 'bye'] });
  const transitions: LinkTransition[] = [];
  const link = linkTo(peer, transitions);
  try {
    link.start();
    await waitFor(() => transitions.some((one) => one.cause === 'socket_closed'), 'the drop');
    assert.equal(rejection(transitions), undefined, 'a plain close must not read as a version refusal');
  } finally {
    link.stop();
    peer.server.close();
  }
});
