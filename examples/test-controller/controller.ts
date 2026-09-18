/**
 * The reference controller: the smallest complete other end of a Periscope host, and the proof that
 * this package is usable by somebody who did not write it.
 *
 * It accepts the outbound connection, negotiates the version, answers the heartbeat, acks every
 * frame, answers permission escalations over HTTP, serves a couple of tools, receives bulk posts,
 * mints and redeems pair codes and checks the paired bearer at the upgrade, and sends every
 * host-scoped ask the wire has through an HTTP door with a requestId rendezvous. What it keeps is
 * one host row and the frames it saw, in memory. There is no orchestration in it and none belongs
 * in it: what a session means is the embedder's, and this file only carries what happened.
 *
 * It is also the genericness proof, which is why it imports the way it does. Everything below
 * comes through the published `@naswerks/periscope/protocol` subpath, by package name, the same resolution a
 * consumer gets from `npm install`. Not one deep relative import, because a deep import would prove
 * the files exist rather than that the package's own entry points are sufficient.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import type {
  ControlPayload,
  Decision,
  DecisionRequest,
  Frame,
  SessionCursor,
  SessionFrame,
  SessionPayload,
  SessionTransition,
} from '@naswerks/periscope/protocol';
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MIN,
  decode,
  encode,
  readAgentMessage,
  readStateTransition,
} from '@naswerks/periscope/protocol';

/**
 * How this controller decides. Returning a promise that resolves late IS a hold.
 *
 * A permission escalation does not ride the link: the host asks over an ordinary HTTP POST whose
 * body is a `DecisionRequest`, and the answer is a `Decision`, both exported from the
 * `@naswerks/periscope/protocol` subpath so a controller types its second transport without the
 * privileged entry point. `sessionKey` on the request is the controller's own handle for the
 * session; correlate on it, never on the agent's `sessionId`.
 */
export type Policy = (ask: DecisionRequest) => Decision | Promise<Decision>;

/** A tool this controller offers. The host validates arguments; this only answers. */
export type ToolHandler = (args: Record<string, unknown>, sessionId: string | null) => string;

/**
 * The host-scoped asks, as the wire spells them. Each is an HTTP door at `POST /asks/<kind>` whose
 * JSON body is the ask's members without `requestId`; the answer is the result payload, whole.
 */
export const ASK_KINDS = [
  'session_list',
  'transcript_list',
  'transcript_tail',
  'workspace_list',
  'workspace_release',
  'workspace_release_bulk',
  'host_configure',
  'repository_list',
  'repository_read',
] as const;
export type AskKind = (typeof ASK_KINDS)[number];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An ask without its `requestId`: this controller mints that, and matches the answer on it. */
export type Ask = DistributiveOmit<Extract<SessionPayload, { readonly kind: AskKind }>, 'requestId'>;

/** A machine that redeemed a pair code. The credential is the key it is looked up by at the upgrade. */
export interface PairedHost {
  readonly hostId: string;
  readonly label: string;
  readonly pairedAt: string;
}

export interface TestControllerOptions {
  /** Default: allow everything. Supply one that denies and holds to exercise the gate. */
  readonly policy?: Policy;
  readonly tools?: Readonly<Record<string, ToolHandler>>;
  /** Every rendered line. Default: stdout. */
  readonly render?: (line: string) => void;
  /** How long an ask waits for its answer before the door reports the host did not answer. */
  readonly askTimeoutMs?: number;
  /** How long a minted pair code stays redeemable. */
  readonly codeTtlMs?: number;
}

/** One thing this controller saw. The proof reads these instead of parsing the log back. */
export interface Seen {
  readonly at: string;
  readonly kind: 'frame' | 'ask' | 'answer' | 'tool' | 'bulk' | 'link' | 'door' | 'pair';
  readonly sessionKey: string | null;
  readonly text: string;
  readonly transition?: SessionTransition;
  readonly seq?: number;
  /** The whole payload, kept only for a frame that is neither a transition nor an agent message. */
  readonly payload?: SessionFrame['payload'];
}

interface PendingAsk {
  readonly kind: AskKind;
  readonly resolve: (payload: SessionPayload) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const isAskKind = (value: string): value is AskKind => (ASK_KINDS as readonly string[]).includes(value);

export class TestController {
  readonly seen: Seen[] = [];
  readonly #policy: Policy;
  readonly #tools: Readonly<Record<string, ToolHandler>>;
  readonly #render: (line: string) => void;
  readonly #askTimeoutMs: number;
  readonly #codeTtlMs: number;
  /** The last seq accepted per session: this controller's half of the dense-seq contract. */
  readonly #cursors = new Map<string, number>();
  readonly #outbound = new Map<string, number>();
  readonly #duplicates: string[] = [];
  readonly #gaps: string[] = [];
  /** Asks in flight, by the requestId the answer must echo. */
  readonly #pending = new Map<string, PendingAsk>();
  /** Minted pair codes and when each stops being redeemable. */
  readonly #codes = new Map<string, number>();
  /** Paired machines, by credential: the lookup the upgrade makes. */
  readonly #paired = new Map<string, PairedHost>();

  #wss: WebSocketServer | null = null;
  #http: Server | null = null;
  #socket: WebSocket | null = null;
  #hostId: string | null = null;
  #wsPort = 0;
  #httpPort = 0;
  #spendUsd = 0;

  constructor(options: TestControllerOptions = {}) {
    this.#policy = options.policy ?? (() => ({ behavior: 'allow' }));
    this.#tools = options.tools ?? {};
    this.#render = options.render ?? ((line) => process.stdout.write(`${line}\n`));
    this.#askTimeoutMs = options.askTimeoutMs ?? 5_000;
    this.#codeTtlMs = options.codeTtlMs ?? 10 * 60_000;
  }

  get controllerUrl(): string {
    return `ws://127.0.0.1:${this.#wsPort}`;
  }

  /** The HTTP origin: the decision endpoint, the tool and bulk routes, the doors and the pair routes live under it. */
  get origin(): string {
    return `http://127.0.0.1:${this.#httpPort}`;
  }

  get decisionUrl(): string {
    return `${this.origin}/decisions`;
  }

  get toolUrl(): string {
    return `${this.origin}/tools`;
  }

  get connected(): boolean {
    return this.#socket !== null;
  }

  /** The id the linked host announced at its hello, or null before one. */
  get hostId(): string | null {
    return this.#hostId;
  }

  /** What every turn this controller saw actually cost, summed from the agent's own results. */
  get spendUsd(): number {
    return this.#spendUsd;
  }

  /** Seq faults this controller detected. Empty is the assertion; the contents are the diagnosis. */
  get faults(): { duplicates: readonly string[]; gaps: readonly string[] } {
    return { duplicates: this.#duplicates, gaps: this.#gaps };
  }

  /** Every transition it received, in arrival order. */
  transitions(): SessionTransition[] {
    return this.seen.flatMap((one) => (one.transition === undefined ? [] : [one.transition]));
  }

  /** The machines that have redeemed a pair code, in pairing order. */
  hosts(): PairedHost[] {
    return [...this.#paired.values()];
  }

  async start(): Promise<void> {
    await this.#listen(0, 0, 'a host connected');
  }

  /** Close everything. The seq accounting stays, so a host's reconnect is judged against it. */
  async stop(): Promise<void> {
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`the controller stopped before ${pending.kind} ${requestId} was answered`));
    }
    this.#pending.clear();
    this.#socket?.close();
    this.#socket = null;
    await new Promise<void>((resolve) => (this.#wss === null ? resolve() : this.#wss.close(() => resolve())));
    await new Promise<void>((resolve) =>
      this.#http === null ? resolve() : this.#http.close(() => resolve()),
    );
    this.#wss = null;
    this.#http = null;
  }

  /** Bring the sockets back on the SAME ports, so a host's reconnect finds them. */
  async restart(): Promise<void> {
    const wsPort = this.#wsPort;
    const httpPort = this.#httpPort;
    await this.stop();
    await this.#listen(wsPort, httpPort, 'a host reconnected');
  }

  /** Send a command. The controller mints the routing key; the session does not exist yet. */
  send(sessionKey: string, payload: SessionFrame['payload']): void {
    const problem = this.#writeSession(sessionKey, payload);
    if (problem !== null) this.#note('link', sessionKey, `could not encode a ${payload.kind}: ${problem}`);
  }

  /**
   * Send a host-scoped ask on the linked host's discovery channel and resolve with the answer that
   * echoes its requestId. Rejects when no host is linked, when the ask does not encode (the codec
   * refuses a malformed ask here, before a sequence number is spent), and when the host does not
   * answer inside the timeout.
   */
  ask(ask: Ask): Promise<SessionPayload> {
    const hostId = this.#hostId;
    if (this.#socket === null || hostId === null) {
      return Promise.reject(new Error('no host is linked'));
    }
    const requestId = randomUUID();
    const payload = { ...ask, requestId } as SessionPayload;
    const channel = `discovery:${hostId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`the host did not answer ${ask.kind} ${requestId} within ${this.#askTimeoutMs} ms`));
      }, this.#askTimeoutMs);
      this.#pending.set(requestId, { kind: ask.kind, resolve, reject, timer });
      const problem = this.#writeSession(channel, payload);
      if (problem !== null) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(new Error(`the ${ask.kind} does not encode: ${problem}`));
        return;
      }
      this.#note('door', channel, `${ask.kind} ${requestId}`);
    });
  }

  // -------------------------------------------------------------------------

  async #listen(wsPort: number, httpPort: number, onConnection: string): Promise<void> {
    this.#http = createServer((request, response) => void this.#serve(request, response));
    await new Promise<void>((resolve) => this.#http?.listen(httpPort, '127.0.0.1', resolve));
    this.#httpPort = (this.#http.address() as AddressInfo).port;

    this.#wss = new WebSocketServer({
      host: '127.0.0.1',
      port: wsPort,
      verifyClient: (info, done) => this.#verifyUpgrade(info.req, done),
    });
    await new Promise<void>((resolve) => this.#wss?.once('listening', resolve));
    this.#wsPort = (this.#wss.address() as AddressInfo).port;

    this.#wss.on('connection', (socket: WebSocket) => {
      this.#socket = socket;
      this.#note('link', null, onConnection);
      socket.on('message', (data: unknown) => this.#onFrame(String(data)));
      socket.on('close', () => {
        if (this.#socket === socket) this.#socket = null;
        this.#note('link', null, 'the host disconnected');
      });
      socket.on('error', () => undefined);
    });
  }

  /**
   * The bearer at the upgrade. Until a machine has paired, the door is open, so a host on a sign-in
   * token can link to this reference (it cannot validate such a token without an identity provider;
   * a real controller does). Once one has, every upgrade presents a paired credential or is refused
   * at the door with 401, which the host reads as `link-unauthorized` and does not retry.
   */
  #verifyUpgrade(
    request: IncomingMessage,
    done: (ok: boolean, code?: number, message?: string) => void,
  ): void {
    if (this.#paired.size === 0) {
      done(true);
      return;
    }
    const header = request.headers.authorization ?? '';
    const credential = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const host = this.#paired.get(credential);
    if (host === undefined) {
      this.#note('link', null, 'refused an upgrade: no paired credential presented');
      done(false, 401, 'Unauthorized');
      return;
    }
    this.#note('link', host.hostId, `the upgrade presented the paired credential of ${host.label}`);
    done(true);
  }

  /** Encode with the next seq and write; the seq is spent only when the frame is written. */
  #writeSession(sessionKey: string, payload: SessionFrame['payload']): string | null {
    const seq = (this.#outbound.get(sessionKey) ?? 0) + 1;
    const encoded = encode({
      frame: 'session',
      sessionId: sessionKey,
      seq,
      at: new Date().toISOString(),
      payload,
    });
    if (!encoded.ok) return encoded.refusal.detail;
    this.#outbound.set(sessionKey, seq);
    this.#socket?.send(encoded.value);
    return null;
  }

  #control(payload: ControlPayload): void {
    const encoded = encode({ frame: 'control', at: new Date().toISOString(), payload });
    if (encoded.ok) this.#socket?.send(encoded.value);
  }

  #onFrame(raw: string): void {
    const decoded = decode(raw);
    if (!decoded.ok) {
      this.#note('link', null, `undecodable frame: ${decoded.refusal.reason}`);
      return;
    }

    const frame: Frame = decoded.value;
    if (frame.frame === 'control') {
      this.#onControl(frame.payload);
      return;
    }

    // The dense-seq contract, from the receiving side: expected is always last + 1. A duplicate is
    // a replay after a reconnect and is expected; a gap is not, and both are recorded rather than
    // silently tolerated, because "lost nothing and duplicated nothing" is an assertion someone
    // has to be able to check.
    // Keyed off absence, never `== 0`: a channel with no held cursor is seeded from its first frame,
    // which is how a host-scoped channel is picked up again after a hello whatever the host's own
    // counter did across the reconnect.
    const last = this.#cursors.get(frame.sessionId);
    if (last !== undefined) {
      if (frame.seq <= last) {
        this.#duplicates.push(`${frame.sessionId}/${frame.seq} (already had ${last})`);
        return;
      }
      if (frame.seq > last + 1) this.#gaps.push(`${frame.sessionId}: expected ${last + 1}, got ${frame.seq}`);
    }
    this.#cursors.set(frame.sessionId, frame.seq);

    this.#renderSessionFrame(frame);
    this.#control({ kind: 'link_ack', cursors: this.#cursorList() });
  }

  #renderSessionFrame(frame: SessionFrame): void {
    const payload = frame.payload;
    if (payload.kind === 'session_update' || payload.kind === 'session_delta') {
      const body = (payload as unknown as { body: Record<string, unknown> }).body;

      const transition = readStateTransition(body as never);
      if (transition !== null) {
        this.seen.push({
          at: new Date().toISOString(),
          kind: 'frame',
          sessionKey: frame.sessionId,
          seq: frame.seq,
          transition,
          text:
            `${transition.from} -> ${transition.to} ` +
            `(${transition.cause.kind}/${transition.cause.event})` +
            `${transition.activity === null ? '' : ` [${transition.activity.kind}:${transition.activity.name}]`}` +
            ` — ${transition.cause.detail}`,
        });
        this.#render(
          `  ${frame.sessionId}/${frame.seq} STATE ${this.seen[this.seen.length - 1]?.text ?? ''}`,
        );
        return;
      }

      const message = readAgentMessage(body as never);
      if (message !== null) {
        const kind = (message as { type?: unknown }).type;
        const type = typeof kind === 'string' ? kind : '?';
        // A `result` carries what the turn cost. Read off the agent's own message, never computed
        // from a price table: the host does not compute it either, and a controller that did would
        // be guessing at numbers it is being handed.
        if (type === 'result') {
          const cost = (message as { total_cost_usd?: unknown }).total_cost_usd;
          if (typeof cost === 'number') this.#spendUsd += cost;
        }
        this.#note(
          'frame',
          frame.sessionId,
          `${payload.kind === 'session_delta' ? 'delta' : 'message'} ${type}`,
          frame.seq,
        );
        return;
      }
    }

    // Kept whole: a host-scoped answer is checkable only by its body, and a reader of the log still
    // gets the one-line rendering.
    this.seen.push({
      at: new Date().toISOString(),
      kind: 'frame',
      sessionKey: frame.sessionId,
      seq: frame.seq,
      text: payload.kind,
      payload,
    });
    this.#render(`  ${frame.sessionId}/${frame.seq} FRAME ${payload.kind}`);

    // The rendezvous: an answer carries the ask's requestId, and that is the whole key. The kind is
    // not consulted, because the three transcript asks share one failure kind.
    const requestId = (payload as { readonly requestId?: unknown }).requestId;
    const pending = typeof requestId === 'string' ? this.#pending.get(requestId) : undefined;
    if (pending !== undefined && typeof requestId === 'string') {
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.resolve(payload);
    }
  }

  #onControl(payload: ControlPayload): void {
    switch (payload.kind) {
      case 'link_hello': {
        this.#note('link', null, `hello from ${payload.hostId} (v${payload.protocolVersion})`);
        // The highest version both windows contain; a host outside this controller's window gets no
        // welcome and a protocol close naming both windows, which the host reads as the refusal.
        const chosen = Math.min(payload.protocolRange.max, PROTOCOL_VERSION);
        if (chosen < Math.max(payload.protocolRange.min, PROTOCOL_VERSION_MIN)) {
          this.#note('link', null, `refusing v${payload.protocolRange.min}-v${payload.protocolRange.max}`);
          this.#socket?.close(
            1002,
            `host speaks v${payload.protocolRange.min}-v${payload.protocolRange.max}; this controller speaks v${PROTOCOL_VERSION_MIN}-v${PROTOCOL_VERSION}`,
          );
          return;
        }
        this.#hostId = payload.hostId;
        // The host-scoped channel is numbered per link: this side's outbound continues from the
        // cursor the host reports for it in the hello (a fresh host process reports none and is
        // asked from 1), and this side's inbound is seeded from the first frame after the hello,
        // because the host's own counter for the channel is per process and may continue or
        // restart. The welcome's cursors do not name it.
        const channel = `discovery:${payload.hostId}`;
        const reported = payload.cursors.find((cursor) => cursor.sessionId === channel);
        this.#cursors.delete(channel);
        if (reported === undefined) this.#outbound.delete(channel);
        else this.#outbound.set(channel, reported.seq);
        // What it already holds, so the host replays past it.
        this.#control({
          kind: 'link_welcome',
          protocolVersion: chosen,
          protocolRange: { min: PROTOCOL_VERSION_MIN, max: PROTOCOL_VERSION },
          capabilities: ['bulk-post'],
          cursors: this.#cursorList(),
        });
        return;
      }
      case 'link_ping':
        this.#control({ kind: 'link_pong', nonce: payload.nonce });
        return;
      case 'link_bye':
        this.#note('link', null, `the host said bye: ${payload.cause}`);
        return;
      default:
        return;
    }
  }

  #cursorList(): SessionCursor[] {
    return [...this.#cursors.entries()].map(([sessionId, seq]) => ({ sessionId, seq }));
  }

  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/';
    const body = await readBody(request);

    if (url === '/decisions') {
      const ask = JSON.parse(body) as DecisionRequest;
      this.#note('ask', ask.sessionId, `${ask.toolName} ${short(ask.toolInput)}`);
      let answer: Decision;
      try {
        answer = await this.#policy(ask);
      } catch (error) {
        // A controller that fails must answer with a status, never with a body that parses. The
        // host discriminates the status before reading anything, which is what stops an outage
        // from impersonating a human "no".
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(String(error));
        return;
      }
      this.#note('answer', ask.sessionId, `${ask.toolName} -> ${answer.behavior}`);
      json(response, 200, answer);
      return;
    }

    if (url.startsWith('/tools/')) {
      const name = url.slice('/tools/'.length);
      const call = JSON.parse(body) as { arguments: Record<string, unknown>; sessionId: string | null };
      const handler = this.#tools[name];
      this.#note('tool', call.sessionId, `${name}(${short(call.arguments)})`);
      json(
        response,
        200,
        handler === undefined
          ? { text: `no tool named ${name}`, isError: true }
          : { text: handler(call.arguments, call.sessionId) },
      );
      return;
    }

    if (url.startsWith('/bulk/')) {
      this.#note('bulk', null, `${url.slice('/bulk/'.length)} received ${body.length} bytes`);
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.startsWith('/asks/')) {
      await this.#serveDoor(url.slice('/asks/'.length), body, response);
      return;
    }

    if (url === '/api/periscope/pair-codes' && request.method === 'POST') {
      const code = randomBytes(6).toString('base64url');
      const expiresAt = Date.now() + this.#codeTtlMs;
      this.#codes.set(code, expiresAt);
      this.#note('pair', null, `minted a pair code, redeemable until ${new Date(expiresAt).toISOString()}`);
      json(response, 201, {
        code,
        expiresAt: new Date(expiresAt).toISOString(),
        controllerOrigin: this.origin,
      });
      return;
    }

    if (url === '/api/periscope/pair' && request.method === 'POST') {
      this.#redeem(body, response);
      return;
    }

    response.writeHead(404);
    response.end();
  }

  /** `POST /asks/<kind>`: the body is the ask's members; the answer is the result payload, whole. */
  async #serveDoor(kind: string, body: string, response: ServerResponse): Promise<void> {
    if (!isAskKind(kind)) {
      json(response, 404, { error: `no ask named ${kind}; the doors are ${ASK_KINDS.join(', ')}` });
      return;
    }
    let members: Record<string, unknown>;
    try {
      members = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>);
    } catch {
      json(response, 400, { error: 'the body is not JSON' });
      return;
    }
    if (this.#socket === null || this.#hostId === null) {
      json(response, 503, { error: 'no host is linked' });
      return;
    }
    try {
      json(response, 200, await this.ask({ ...members, kind } as Ask));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, message.startsWith('the host did not answer') ? 504 : 400, { error: message });
    }
  }

  /**
   * `POST /api/periscope/pair` with `{ code, machineLabel }`. Unknown, expired and consumed codes
   * answer identically, because the fix is the same for all three: mint a fresh one. The answer
   * names the host id this controller assigns, the credential the host will present, and where
   * to dial; the `pair` verb writes all three.
   */
  #redeem(body: string, response: ServerResponse): void {
    let asked: { code?: unknown; machineLabel?: unknown };
    try {
      asked = JSON.parse(body) as { code?: unknown; machineLabel?: unknown };
    } catch {
      json(response, 400, { error: 'the body is not JSON' });
      return;
    }
    const code = typeof asked.code === 'string' ? asked.code : '';
    const expiresAt = this.#codes.get(code);
    this.#codes.delete(code);
    if (expiresAt === undefined || expiresAt < Date.now()) {
      this.#note('pair', null, 'refused a pair code');
      json(response, 404, { error: 'unknown, expired or consumed pair code' });
      return;
    }
    const hostId = `ph-${randomBytes(4).toString('hex')}`;
    const hostCredential = `p1.${hostId}.${randomBytes(24).toString('base64url')}`;
    const label =
      typeof asked.machineLabel === 'string' && asked.machineLabel !== '' ? asked.machineLabel : hostId;
    this.#paired.set(hostCredential, { hostId, label, pairedAt: new Date().toISOString() });
    this.#note('pair', hostId, `paired ${label}`);
    json(response, 200, {
      hostId,
      hostCredential,
      controllerUrl: this.controllerUrl,
      decisionUrl: this.decisionUrl,
    });
  }

  #note(kind: Seen['kind'], sessionKey: string | null, text: string, seq?: number): void {
    const entry: Seen = {
      at: new Date().toISOString(),
      kind,
      sessionKey,
      text,
      ...(seq === undefined ? {} : { seq }),
    };
    this.seen.push(entry);
    this.#render(`  ${sessionKey ?? '-'} ${kind.toUpperCase()} ${text}`);
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: unknown) => (body += String(chunk)));
    request.on('end', () => resolve(body));
  });
}

function short(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? '?' : text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
