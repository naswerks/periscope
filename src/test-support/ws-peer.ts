/**
 * An in-process controller for link tests: a WebSocket server that completes the handshake, records
 * every frame it receives (deduplicated by seq, as a real receiver must), and optionally acks.
 * The wire is at-least-once; a reconnect legally replays a written-unacked frame, so a peer that
 * counted raw arrivals would report one emission as two.
 */
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

import type { Frame, SessionCursor, SessionPayload } from '../control/frames.js';
import { PROTOCOL_VERSION, readWireRefusal } from '../control/frames.js';
import { decode, encode } from '../control/codec.js';
import { rawText } from './raw-text.js';

export interface PeerOptions {
  /** The protocol version the welcome answers with. Defaults to the package's own. */
  readonly welcomeVersion?: number;
  /** Whether to ack every session frame at its seq, which releases the host's retention. */
  readonly ack?: boolean;
}

export class Peer {
  readonly received: Frame[] = [];
  /** When each inbound connection was accepted, so a backoff can be measured rather than parsed. */
  readonly connectedAtMs: number[] = [];
  /** Gaps and duplicates the peer observed on session lanes, keyed `sessionId/seq`. */
  readonly faults: { duplicates: string[]; gaps: string[] } = { duplicates: [], gaps: [] };
  readonly #seen = new Set<string>();
  readonly #last = new Map<string, number>();
  #live: ServerSocket | null = null;
  #server: WebSocketServer;

  constructor(
    server: WebSocketServer,
    private readonly options: Required<PeerOptions>,
  ) {
    this.#server = server;
    this.#attach(server);
  }

  #attach(server: WebSocketServer): void {
    server.on('connection', (socket) => {
      this.#live = socket;
      this.connectedAtMs.push(Date.now());
      socket.on('message', (data) => this.#onMessage(socket, rawText(data)));
    });
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/link`;
  }

  /** The gaps between successive connection attempts. */
  reconnectGapsMs(): number[] {
    return this.connectedAtMs.slice(1).map((at, index) => at - this.connectedAtMs[index]!);
  }

  /** Push a session frame at the host at the given seq. Defaults to a `session_prompt`. */
  send(sessionId: string, seq: number, payload?: SessionPayload): void {
    const encoded = encode({
      frame: 'session',
      sessionId,
      seq,
      at: new Date().toISOString(),
      payload: payload ?? { kind: 'session_prompt', text: `turn-${seq}` },
    });
    if (encoded.ok) this.#live?.send(encoded.value);
  }

  /** Session frames received for one session, in arrival order. */
  sessionFrames(sessionId: string): Frame[] {
    return this.received.filter((frame) => frame.frame === 'session' && frame.sessionId === sessionId);
  }

  /** Every `wire_refusal` update the host sent back. */
  wireRefusals(): { reason: string; expected: number; received: number }[] {
    return this.received.flatMap((frame) => {
      if (frame.frame !== 'session' || frame.payload.kind !== 'session_update') return [];
      const read = readWireRefusal(frame.payload.body);
      return read === null
        ? []
        : [{ reason: read.refusal.reason, expected: read.expected, received: read.received }];
    });
  }

  /** Close the live socket without stopping the server, so the host sees a drop and reconnects. */
  dropConnection(): void {
    this.#live?.terminate();
    this.#live = null;
  }

  /** Stop listening and close every socket. */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #onMessage(socket: ServerSocket, raw: string): void {
    const decoded = decode(raw);
    if (!decoded.ok) return;
    const frame = decoded.value;
    if (frame.frame === 'session') {
      const id = `${frame.sessionId}/${frame.seq}`;
      const last = this.#last.get(frame.sessionId) ?? 0;
      if (this.#seen.has(id)) {
        this.faults.duplicates.push(id);
        return;
      }
      if (frame.seq > last + 1) this.faults.gaps.push(id);
      this.#seen.add(id);
      this.#last.set(frame.sessionId, Math.max(last, frame.seq));
      this.received.push(frame);
      if (this.options.ack) {
        const cursors: SessionCursor[] = [{ sessionId: frame.sessionId, seq: frame.seq }];
        const ack = encode({
          frame: 'control',
          at: new Date().toISOString(),
          payload: { kind: 'link_ack', cursors },
        });
        if (ack.ok) socket.send(ack.value);
      }
      return;
    }
    this.received.push(frame);
    if (frame.payload.kind === 'link_hello') {
      const welcome = encode({
        frame: 'control',
        at: new Date().toISOString(),
        payload: {
          kind: 'link_welcome',
          protocolVersion: this.options.welcomeVersion,
          protocolRange: null,
          capabilities: [],
          cursors: [],
        },
      });
      if (welcome.ok) socket.send(welcome.value);
    } else if (frame.payload.kind === 'link_ping') {
      const pong = encode({
        frame: 'control',
        at: new Date().toISOString(),
        payload: { kind: 'link_pong', nonce: frame.payload.nonce },
      });
      if (pong.ok) socket.send(pong.value);
    }
  }
}

/** Start a peer on a free loopback port. */
export async function peerOn(options: PeerOptions = {}): Promise<Peer> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  return new Peer(server, {
    welcomeVersion: options.welcomeVersion ?? PROTOCOL_VERSION,
    ack: options.ack ?? false,
  });
}

/** Poll until `condition` holds or `timeoutMs` passes. */
export async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
