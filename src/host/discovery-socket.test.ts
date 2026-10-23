/**
 * The discovery channel on a real socket: the whole path, no substitutes. A real `WebSocketServer`
 * playing the controller, the real `ControllerLink`, the real `PeriscopeHost`, a resolver of the
 * test's own over a real fixture file, and a real HTTP sink for the bulk pull.
 *
 * The frame COUNT is the assertion: five asks produce exactly five answers, and a decodable
 * non-command produces none, so a handler quietly dropping a kind, or the closed set quietly
 * widening, both move a number this test reads off the wire itself. The transcript asks ride the
 * channel first, so every answer after them also shows that the channel kept its sequence.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Frame, SessionPayload } from '../control/frames.js';
import { PROTOCOL_VERSION, sessionList, transcriptList, transcriptTail } from '../control/frames.js';
import { decode, encode } from '../control/codec.js';
import { ok } from '../core/result.js';
import { SessionRegistry } from '../sessions/registry.js';
import { PeriscopeHost } from './host.js';
import { TRANSCRIPT_WHAT_PREFIX } from '../control/frames.js';
import { tempDir } from '../test-support/temp-dir.js';
import { waitFor } from '../test-support/ws-peer.js';
import { rawText } from '../test-support/raw-text.js';

const allow = async (): Promise<unknown> => ({ behavior: 'allow' });

/** The controller side, at the socket: answers the handshake at v4 and records every frame. */
class Peer {
  readonly received: Frame[] = [];
  readonly #seen = new Set<string>();
  #live: ServerSocket | null = null;
  #nextSeq = 1;

  constructor(readonly server: WebSocketServer) {
    server.on('connection', (socket) => {
      this.#live = socket;
      socket.on('message', (data) => this.#onMessage(socket, rawText(data)));
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** Send one payload on the discovery channel, seq minted densely the way a real sender must. */
  ask(payload: SessionPayload): void {
    const encoded = encode({
      frame: 'session',
      sessionId: 'discovery-channel',
      seq: this.#nextSeq,
      at: new Date().toISOString(),
      payload,
    });
    this.#nextSeq += 1;
    if (encoded.ok) this.#live?.send(encoded.value);
  }

  /** Send raw JSON at the host — for shapes `encode` would have to be complicit in. */
  askRaw(payloadJson: object): void {
    this.#live?.send(
      JSON.stringify({
        frame: 'session',
        sessionId: 'discovery-channel',
        seq: this.#nextSeq,
        at: new Date().toISOString(),
        payload: payloadJson,
      }),
    );
    this.#nextSeq += 1;
  }

  answers(): SessionPayload[] {
    return this.received.flatMap((frame) => (frame.frame === 'session' ? [frame.payload] : []));
  }

  #onMessage(socket: ServerSocket, raw: string): void {
    const decoded = decode(raw);
    if (!decoded.ok) return;
    const frame = decoded.value;
    if (frame.frame === 'session') {
      const id = `${frame.sessionId}/${frame.seq}`;
      if (this.#seen.has(id)) return;
      this.#seen.add(id);
    }
    this.received.push(frame);
    if (frame.frame === 'control' && frame.payload.kind === 'link_hello') {
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
    }
  }
}

test('regression: the discovery round trip on a real socket: the transcript asks answered by name, a resolver of the embedder delivers, none extra', async () => {
  const root = await tempDir('socket-discovery');
  const file = join(root, 'notes.txt');
  await writeFile(file, 'the fixture bytes\n', 'utf8');

  // One origin serves both the link and the bulk receiver, and that is a property rather than a
  // convenience. The host binds `postUrl`'s origin to its configured controller, so a bulk receiver
  // on a second port is, correctly, a foreign origin it refuses to feed. This fixture matches a
  // real deployment, where the wss link and the https bulk POST share one host:port.
  const pulled: Buffer[] = [];
  const sink = createServer((request, response) => {
    request.on('data', (chunk: Buffer) => pulled.push(chunk));
    request.on('end', () => {
      response.statusCode = 200;
      response.end();
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const sinkPort = (sink.address() as AddressInfo).port;

  const server = new WebSocketServer({ server: sink });
  const peer = new Peer(server);
  const resolved: string[] = [];

  const host = new PeriscopeHost({
    controllerUrl: `ws://127.0.0.1:${peer.port}`,
    hostId: 'discovery-socket-test',
    decide: allow,
    protectedPaths: [],
    registry: new SessionRegistry({ baseEnv: {}, homeDir: root }),
    // A resolver that would serve any locator at all, the transcript namespace included: the host
    // answers that namespace before it asks.
    bulk: (what) => {
      resolved.push(what);
      return ok(file);
    },
  });

  try {
    host.start();
    await waitFor(
      () => peer.received.some((frame) => frame.frame === 'control' && frame.payload.kind === 'link_hello'),
      'the handshake',
    );

    peer.ask(transcriptList('req-page'));
    peer.ask(transcriptTail('req-probe', 'C--Dev-fixture', 'session-1', 0, 'the live entry'));
    peer.ask({
      kind: 'bulk_request',
      deliveryId: 'req-transcript',
      what: `${TRANSCRIPT_WHAT_PREFIX}C--Dev-fixture/session-1`,
      fromOffset: 0,
      postUrl: `http://127.0.0.1:${sinkPort}/bulk/req-transcript`,
    });
    peer.ask(sessionList('req-sessions'));
    peer.ask({
      kind: 'bulk_request',
      deliveryId: 'req-pull',
      what: 'fixture:notes.txt',
      fromOffset: 0,
      postUrl: `http://127.0.0.1:${sinkPort}/bulk/req-pull`,
    });
    // The closed-set control: a decodable kind that is NOT a command must produce NO answer frame.
    peer.askRaw({
      kind: 'transcript_failed',
      requestId: 'req-bogus',
      refusal: { reason: 'transcript-read-failed', detail: 'x' },
    });

    await waitFor(
      () =>
        peer
          .answers()
          .filter((payload) => payload.kind !== 'session_update' && payload.kind !== 'session_delta')
          .length >= 5,
      'the five answers',
    );
    // Let anything extra arrive before counting — an over-answering host must not pass on a race.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const answers = peer
      .answers()
      .filter((payload) => payload.kind !== 'session_update' && payload.kind !== 'session_delta');
    assert.equal(
      answers.length,
      5,
      `five asks must produce exactly five answers, saw: ${answers.map((a) => a.kind).join(', ')}`,
    );

    const refusedByName = answers.flatMap((payload) =>
      payload.kind === 'transcript_failed'
        ? [`${payload.requestId}: ${payload.refusal.reason}`]
        : payload.kind === 'bulk_failed'
          ? [`${payload.deliveryId}: ${payload.refusal.reason}`]
          : [],
    );
    assert.deepEqual(refusedByName, [
      'req-page: transcripts-not-served',
      'req-probe: transcripts-not-served',
      'req-transcript: transcripts-not-served',
    ]);
    assert.deepEqual(resolved, ['fixture:notes.txt'], 'the transcript locator reached the resolver');

    const sessions = answers.find((payload) => payload.kind === 'session_list_result');
    assert.ok(sessions !== undefined, 'no session_list_result arrived');
    assert.equal(sessions.requestId, 'req-sessions');
    assert.deepEqual([sessions.liveCount, sessions.provisioningCount, sessions.sessions.length], [0, 0, 0]);

    const receipt = answers.find((payload) => payload.kind === 'bulk_delivered');
    assert.ok(receipt !== undefined, 'no bulk_delivered arrived — the pull went unreceipted');
    assert.equal(receipt.deliveryId, 'req-pull');
    assert.ok((receipt.sizeBytes ?? 0) > 0, 'the receipt must carry the stat pair');
    assert.equal(
      Buffer.concat(pulled).toString('utf8'),
      'the fixture bytes\n',
      'the sink must hold the bytes the resolver named',
    );
  } finally {
    host.stop('test over');
    server.close();
    sink.close();
    await rm(root, { recursive: true, force: true });
  }
});
