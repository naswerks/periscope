/**
 * The outbound link: one WebSocket the host dials OUT to the controller.
 *
 * Outbound is the defining constraint — there is no listening port anywhere in this package, which
 * is what lets a host run behind a firewall that would never allow an inbound one. It also means
 * this file has no routing surface and therefore no route that could be added later without an
 * auth check in front of it.
 *
 * A raw WebSocket pins the host to one controller instance. Accepted for this version, stated here
 * rather than discovered in production.
 */
import { WebSocket } from 'ws';

import type { Clock, Ticker } from '../core/time.js';
import { systemClock, systemTicker } from '../core/time.js';
import type { Refusal } from '../core/refusal.js';
import { certificateRemedy, describeFailure, isCertificateRefusal } from '../core/failure.js';
import { needsHumanReauthentication, refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import type { ControllerCredential } from './credential.js';
import { UnconfiguredCredential } from './credential.js';
import type {
  ControlPayload,
  Frame,
  HostConfiguration,
  SessionCursor,
  SessionFrame,
  SessionPayload,
} from './frames.js';
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MIN,
  unsetHostConfiguration,
  wireRefusalUpdate,
} from './frames.js';
import { decode, encode } from './codec.js';
import type { BackoffOptions } from './backoff.js';
import { DEFAULT_BACKOFF, nextDelayMs } from './backoff.js';
import { BoundedFrameQueue } from './queue.js';
import { SeqTracker } from './seq.js';
import type { LinkTransition } from './link-state.js';
import { LinkStateMachine } from './link-state.js';

export interface LinkHandlers {
  /** Every state change, with its cause. */
  onTransition(transition: LinkTransition): void;
  /** An in-order session frame from the controller. Duplicates never reach here. */
  onSessionFrame(frame: SessionFrame): void;
  /** Frames were lost between the two ends. Loud by design; replay exists to make this not happen. */
  onGap(sessionId: string, expected: number, received: number): void;
  /** Anything the link declined to do, named. */
  onRefusal(refused: Refusal): void;
}

export interface LinkOptions {
  readonly url: string;
  readonly hostId: string;
  readonly handlers: LinkHandlers;
  readonly credential?: ControllerCredential;
  readonly backoff?: BackoffOptions;
  readonly clock?: Clock;
  readonly ticker?: Ticker;
  readonly random?: () => number;
  /** Frames held while the link is down. */
  readonly queueCapacity?: number;
  /**
   * Extra capability markers for the `link_hello`, beside the built-in `bulk-post`.
   * Values in an open string list: a peer that does not know one ignores it, so declaring a new
   * marker is not a protocol change. The list is declarative: the controller is not obliged to act
   * on any of it (see `LinkWelcome`; negotiation is declared on both sides, honoured by neither).
   */
  readonly capabilities?: readonly string[];
  /**
   * The values this host runs with, reported on every `link_hello`. Omitted, the hello
   * reports every member as null: a link composed without one has nothing to say, and says so
   * rather than guessing.
   */
  readonly configuration?: HostConfiguration;
  /** The keys whose file value is not in effect. Omitted, the hello reports none. */
  readonly pendingRestart?: readonly string[];
  readonly heartbeatIntervalMs?: number;
  /** No pong inside this window and the socket is declared dead, however alive TCP thinks it is. */
  readonly heartbeatTimeoutMs?: number;
  /** Above this many buffered bytes the link stops writing and queues instead. */
  readonly highWaterMarkBytes?: number;
  /**
   * How long an ended session's written-but-unacked frames are held. See `ENDED_RETENTION_MS`.
   *
   * An option for the same reason the heartbeat's two timings are: the default is the decision, and
   * a test that had to wait a real minute to observe a bound would be a test nobody runs.
   */
  readonly endedRetentionMs?: number;
  /**
   * How long a dial may sit in `connecting` before it is abandoned and retried. Without it a
   * controller that accepts the TCP handshake but never completes the upgrade (an API mid-restart)
   * holds this link in `connecting` for minutes, until the OS gives up, while sessions wait.
   */
  readonly connectTimeoutMs?: number;
}

const DEFAULTS = {
  queueCapacity: 1000,
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 45_000,
  highWaterMarkBytes: 1024 * 1024,
  connectTimeoutMs: 15_000,
} as const;

/**
 * How soon a stalled drain retries while frames wait on a backed-up socket. Short, because a delta
 * held past the buffer's recovery is latency for nothing; unref'd and armed only while something
 * is actually pending, so an idle link holds no handle and spins on nothing.
 */
const DRAIN_RETRY_MS = 25;

/**
 * How long an ended session's written-but-unacked frames are held before they are released.
 *
 * This bounds a hold, and the hold itself is right. A session's last frames are its most important
 * and are exactly the ones in flight if the link is down when it ends, so `forgetSession`
 * deliberately does not discard them; see its own note. What needs a bound is the other side of
 * that decision: nothing in the protocol obliges a controller to ack, and one that never does would
 * leave every ended session's frames retained forever. Written frames are never eviction
 * candidates, so the queue would fill with the dead and eventually refuse live traffic
 * (`queue-overflow-undroppable`), while the outbound counter and the ended-session set grow without
 * limit. A host built to run many sessions would die of the ones that finished.
 *
 * The trade, stated so the next reader can see it was chosen. A link down longer than this loses
 * that session's final frames: they are released and replay can no longer produce them. That is a
 * real cost and it is accepted deliberately: an unbounded hold trades a certainty (this host dies)
 * for a possibility (a controller offline past the bound misses a few closing transitions), and the
 * bound is the cheaper side. Sixty seconds sits past the 45 s heartbeat timeout on purpose, so a
 * link that is merely slow is never punished; by the time this fires, the link has already been
 * declared dead once.
 *
 * Swept on the existing heartbeat tick, never on a timer of its own. Guarantees armed on
 * `unref()`d timers can be dropped when the event loop drains, and the cheapest way to avoid that
 * is to add no timer at all: the heartbeat is already running whenever a socket is open, and a link
 * with no socket cannot be acked anyway.
 */
const ENDED_RETENTION_MS = 60_000;

export class ControllerLink {
  readonly #options: LinkOptions;
  readonly #handlers: LinkHandlers;
  readonly #credential: ControllerCredential;
  readonly #clock: Clock;
  readonly #ticker: Ticker;
  readonly #random: () => number;
  readonly #backoff: BackoffOptions;
  readonly #machine = new LinkStateMachine();
  readonly #queue: BoundedFrameQueue;
  /** Numbers this side hands out. */
  readonly #outbound = new SeqTracker();
  /** Numbers this side judges. */
  readonly #inbound = new SeqTracker();
  /** Ended sessions whose counter is held only until their last retained frame is acked. */
  readonly #forgotten = new Set<string>();
  /** When each of those ended, so the hold can be bounded. See `ENDED_RETENTION_MS`. */
  readonly #forgottenAtMs = new Map<string, number>();
  /**
   * Sessions whose inbound lane is wedged and has already been reported.
   *
   * One emission per wedge, not per gapped frame: once `last` stops advancing every later frame on
   * that session is also a gap, so reporting each one would turn a single lost frame into a frame
   * storm aimed at the peer that is already in trouble. Cleared the moment a frame is accepted,
   * which is what makes a healed lane reportable again.
   */
  readonly #wedged = new Set<string>();

  /** What the next hello declares. Replaced by `announce` when the host reconfigures itself. */
  #capabilities: readonly string[];
  #configuration: HostConfiguration;
  #pendingRestart: readonly string[];
  #socket: WebSocket | null = null;
  #attempt = 0;
  /** The version the controller chose at the last accepted handshake; null before one. */
  #negotiatedVersion: number | null = null;
  #stopping = false;
  #retryTimer: NodeJS.Timeout | null = null;
  #connectTimer: NodeJS.Timeout | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #drainTimer: NodeJS.Timeout | null = null;
  #lastPongAtMs = 0;

  constructor(options: LinkOptions) {
    this.#options = options;
    this.#handlers = options.handlers;
    this.#credential = options.credential ?? new UnconfiguredCredential();
    this.#clock = options.clock ?? systemClock;
    this.#ticker = options.ticker ?? systemTicker;
    this.#random = options.random ?? Math.random;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#queue = new BoundedFrameQueue(options.queueCapacity ?? DEFAULTS.queueCapacity);
    this.#capabilities = options.capabilities ?? [];
    this.#configuration = options.configuration ?? unsetHostConfiguration();
    this.#pendingRestart = options.pendingRestart ?? [];
  }

  /**
   * Replace what the next `link_hello` declares. A host that reconfigured itself dials the same
   * controller with the same identity; only the description moves, and it moves at the next
   * hello rather than on a frame of its own, because the hello is where a controller reads it.
   */
  announce(
    capabilities: readonly string[],
    configuration: HostConfiguration,
    pendingRestart: readonly string[] = [],
  ): void {
    this.#capabilities = capabilities;
    this.#configuration = configuration;
    this.#pendingRestart = pendingRestart;
  }

  get state() {
    return this.#machine.state;
  }

  /** The version the controller chose at the last accepted handshake; null before one. */
  get negotiatedVersion(): number | null {
    return this.#negotiatedVersion;
  }

  get queueStats() {
    return this.#queue.stats;
  }

  /** Cursors of what this side has received: sent to the controller so it replays the right frames. */
  cursors(): SessionCursor[] {
    return this.#inbound.cursors();
  }

  start(): void {
    this.#stopping = false;
    this.#transition('connecting', 'start_requested');
    this.#openSocket();
  }

  /** Graceful close. Idempotent, and clears every timer: a stopped link holds no handles. */
  stop(detail = 'stop requested'): void {
    this.#stopping = true;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      // Best effort; the socket is going away either way.
      const encoded = encode(this.#controlFrame({ kind: 'link_bye', cause: detail }));
      if (encoded.ok) {
        try {
          socket.send(encoded.value);
        } catch {
          // A send failure on the way out changes nothing.
        }
      }
    }
    socket?.close();
    this.#transition('closed', 'shutdown_requested', detail);
  }

  /**
   * Accept a payload for delivery: retained until acked, written as soon as the link allows.
   *
   * A `seq` is minted only when the frame is first written to the wire, so nothing refused or
   * discarded before that point ever had one — the wire's numbering stays dense whatever happens
   * here. `ok` means accepted and retained; a refusal names why nothing was accepted, and it is
   * the caller's pressure signal — a dropped delta and a refused transition are different events
   * and only the caller knows which one it can live with.
   */
  send(sessionId: string, payload: SessionPayload): Result<void> {
    const at = this.#clock();

    // Admission gate: if this payload cannot encode inside the frame limit with the widest seq a
    // frame can ever carry, no real seq can save it later — refuse now, while the caller is still
    // here to be told. Admission therefore guarantees the eventual write cannot fail to encode.
    //
    // The probe is conservative by at most 15 bytes of 65,536, and that is the honest direction.
    // `Number.MAX_SAFE_INTEGER` serializes to 16 digits while a real seq is 1 to 16, so a payload
    // sitting within 15 bytes of the limit is refused although its actual frame would have fitted.
    // The refusal is truthful (it names the size and the bulk lane) and the alternative is not:
    // admitting on the real seq would let a frame pass admission and then fail to encode at write
    // time, with the caller long gone and a retained entry that can never be written. A rejection
    // someone can act on beats a hole nobody can see.
    const probe = encode({ frame: 'session', sessionId, seq: Number.MAX_SAFE_INTEGER, at, payload });
    if (!probe.ok) {
      this.#handlers.onRefusal(probe.refusal);
      return { ok: false, refusal: probe.refusal };
    }

    // Retained before any write attempt, and kept after a successful one. A frame that has been
    // written is not yet safe to forget: if the socket dies before the controller processes it,
    // that frame is precisely the one replay has to produce. Only an ack releases it.
    const held = this.#queue.push(sessionId, at, payload);
    if (!held.ok) {
      this.#handlers.onRefusal(held.refusal);
      return { ok: false, refusal: held.refusal };
    }
    if (held.value.evicted !== null) {
      // The discarded entry's producer was told `ok` when it was accepted, so this is the only
      // place its loss can be named. It had no seq, so the wire never misses it.
      this.#handlers.onRefusal(
        refusal(
          'queue-dropped-droppable',
          `discarded a pending ${held.value.evicted.kind} for session ` +
            `${held.value.evicted.sessionId} to hold a ${payload.kind}`,
        ),
      );
    }

    this.#drain();
    return ok(undefined);
  }

  /**
   * Release what this session holds. Called at session end, always.
   *
   * It does not discard frames the controller has not acked; see `BoundedFrameQueue.forget`.
   * A session's last frames are its most important ones and are exactly the ones still unacked if
   * the link is down when it ends. What is released here is everything that cannot still be owed:
   * pending entries, which never had a seq, and the inbound cursor, which is about what the
   * controller sent this side rather than what this side owes it.
   *
   * The outbound counter outlives the call while anything is still retained, and that is not an
   * oversight. Resetting it while stamped frames for the same key are awaiting replay would let a
   * later frame on that key be numbered below one already on the wire: a seq regression, which the
   * receiver reads as a hole it can never fill. The counter is released by the ack that empties the
   * retention instead, so the bound this method exists to keep is kept a moment later rather than
   * abandoned.
   */
  forgetSession(sessionId: string): void {
    this.#inbound.forget(sessionId);
    this.#queue.forget(sessionId);
    this.#wedged.delete(sessionId);
    this.#forgotten.add(sessionId);
    // Stamped so the hold can be bounded. See `ENDED_RETENTION_MS` for what is being traded.
    this.#forgottenAtMs.set(sessionId, this.#ticker());
    this.#releaseIfDrained(sessionId);
  }

  // -------------------------------------------------------------------------

  #writeFrame(socket: WebSocket, frame: SessionFrame): Result<SessionFrame> {
    const encoded = encode(frame);
    if (!encoded.ok) {
      this.#handlers.onRefusal(encoded.refusal);
      return { ok: false, refusal: encoded.refusal };
    }
    try {
      socket.send(encoded.value);
      return ok(frame);
    } catch (error) {
      const refused = refusal('link-send-failed', describe(error));
      this.#handlers.onRefusal(refused);
      return { ok: false, refusal: refused };
    }
  }

  /**
   * Write pending frames in arrival order while the socket is open and under the high-water mark.
   *
   * Every frame passes through the queue, so a new send can never overtake a waiting one — delivery
   * order is arrival order, which is what keeps the receiver's arithmetic a straight `last + 1`.
   * Above the mark the link stops writing and queues; the bounded queue and its refusals are what
   * slow a producer down, and the retry timer resumes the flow the moment the buffer empties —
   * a reconnect is not part of this path. A frame is stamped as it is written and never before,
   * and a stamped frame is retained until acked, so a write that fails mid-drain is replay's
   * problem, not a hole.
   */
  #drain(): void {
    const socket = this.#socket;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      const highWater = this.#options.highWaterMarkBytes ?? DEFAULTS.highWaterMarkBytes;
      while (socket.bufferedAmount < highWater) {
        const frame = this.#queue.stampNext((sessionId, at, payload) => ({
          frame: 'session',
          sessionId,
          seq: this.#outbound.next(sessionId),
          at,
          payload,
        }));
        if (frame === null) break;
        const written = this.#writeFrame(socket, frame);
        if (!written.ok) break; // the socket is dying; the frame is retained and replay covers it
      }
    }
    this.#armDrainTimer();
  }

  #armDrainTimer(): void {
    const socket = this.#socket;
    const useful =
      !this.#stopping && this.#queue.hasPending && socket !== null && socket.readyState === WebSocket.OPEN;
    if (!useful) {
      // Nothing to poll for: an empty queue drains on the next send, a dead socket drains on the
      // reconnect's replay. Holding a timer here would be a handle that can only spin.
      this.#clearDrainTimer();
      return;
    }
    if (this.#drainTimer !== null) return; // one at a time
    this.#drainTimer = setTimeout(() => {
      this.#drainTimer = null;
      this.#drain();
    }, DRAIN_RETRY_MS);
    this.#drainTimer.unref?.();
  }

  #openSocket(): void {
    // The credential is resolved before the socket is opened, so an unauthorized link never
    // reaches a state where it could carry a frame. It is the only async step in the connect path
    // and its rejection cannot escape: every branch below ends in a transition.
    //
    // The precondition, the same one `EscalationOptions.credential` states, and it is easier to
    // misread here because this side is fail-open. Connecting with no headers is not the same as
    // connecting successfully: what this package can present is a delegated user token, a paired
    // credential, or nothing (there is no client-credentials grant in `identity/`), so a controller
    // that admits only a machine app role refuses the upgrade either way, and the retry loop below
    // will keep dialling a door that cannot open for it. That reads in the transitions as an
    // unreachable controller rather than as an identity this host was never able to hold.
    void this.#credential
      .authorize()
      .then((authorized) => {
        if (this.#stopping) return;

        const headers: Record<string, string> = {};
        if (authorized.ok) {
          headers[authorized.value.header] = authorized.value.value;
        } else {
          // The refusal is surfaced before anything is decided about it. Dropping it here (no
          // handler, no transition, no counter) would leave the one fact an operator could act on
          // as the one thing that never left this function.
          this.#handlers.onRefusal(authorized.refusal);

          if (needsHumanReauthentication(authorized.refusal.reason)) {
            // And this one does not dial. Connecting headerless against a controller that has
            // already refused the identity is not a degraded connection, it is a retry loop against
            // a door that structurally cannot open, which reads in the transitions as an
            // unreachable controller rather than as an identity this host is no longer able to hold.
            this.#failCredential(authorized.refusal);
            return;
          }
          // Every other refusal still dials, deliberately: a host with no identity configured is
          // supposed to connect without a header rather than pretend to have a scheme.
        }

        this.#attachSocket(new WebSocket(this.#options.url, { headers }));
      })
      .catch((error: unknown) => {
        this.#handlers.onRefusal(refusal('credential-unavailable', describe(error)));
        this.#scheduleRetry('credential_unavailable', describe(error));
      });
  }

  #attachSocket(socket: WebSocket): void {
    this.#socket = socket;

    // The dial's own clock: a socket that has not opened by the deadline is abandoned and the retry
    // ladder takes over, never a `connecting` that outlives the controller's whole restart.
    const connectTimeoutMs = this.#options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
    this.#clearConnectTimer();
    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = null;
      if (this.#socket !== socket || socket.readyState === WebSocket.OPEN) return;
      socket.once('error', () => {});
      socket.terminate();
      this.#scheduleRetry('connect_timeout', `no open within ${connectTimeoutMs}ms`);
    }, connectTimeoutMs);
    this.#connectTimer.unref?.();

    socket.on('open', () => {
      this.#clearConnectTimer();
      // `#attempt` is not reset here. A socket that opens has proven TCP and TLS work; it has
      // proven nothing about whether the peer will accept this host at all. The one failure that
      // survives a successful open is a protocol-version mismatch: the peer answers `link_welcome`
      // with a version this host does not speak, the link retries, the socket opens again, and
      // resetting the counter here would put every retry back at attempt 0. Attempt 0 has zero
      // jitter span, so that would be a hard 500 ms reconnect loop, forever, against a controller
      // that will never accept this version: a self-inflicted denial of service, and the single
      // most likely first-contact failure the moment PROTOCOL_VERSION moves. The reset lives on the
      // handshake's accepted branch, where acceptance is actually known.
      this.#lastPongAtMs = this.#ticker();
      this.#transition('open', 'socket_connected');
      this.#sendControl({
        kind: 'link_hello',
        protocolVersion: PROTOCOL_VERSION,
        protocolRange: { min: PROTOCOL_VERSION_MIN, max: PROTOCOL_VERSION },
        hostId: this.#options.hostId,
        // `bulk-post` is structural (this link can take a bulk_request) and never displaced by
        // configuration; the configured markers (the workspace mode) ride beside it.
        capabilities: ['bulk-post', ...this.#capabilities],
        cursors: this.#inbound.cursors(),
        configuration: this.#configuration,
        pendingRestart: this.#pendingRestart,
      });
      this.#startHeartbeat();
    });

    socket.on('message', (data: unknown) => {
      // Handler is sync throughout: there is no promise here to leave unhandled.
      this.#onMessage(String(data));
    });

    // A refused upgrade is not a broken transport, and only this event can tell them apart.
    // Without a listener here, `ws` folds every non-101 handshake into the generic error event as
    // "Unexpected server response: NNN", so a controller refusing this host's identity would read
    // as a socket fault and go round the backoff loop forever, dialling a door that refuses the
    // same way every time. The status code is the discriminator: 401/403 is the peer judging who
    // is asking (terminal, the same predicate the token layer's refusals use, one home), while any
    // other status is the peer misbehaving or mid-deploy, which stays a retry.
    socket.on('unexpected-response', (request, response) => {
      const status = response.statusCode ?? 0;
      request.destroy();
      if (status === 401 || status === 403) {
        const refused = refusal(
          'link-unauthorized',
          `the controller refused this host's identity at the WebSocket upgrade (HTTP ${status}) — ` +
            `the same identity will be refused on every redial, so sign in again`,
        );
        this.#handlers.onRefusal(refused);
        if (needsHumanReauthentication(refused.reason)) {
          this.#failCredential(refused);
          return;
        }
      }
      const detail = `unexpected server response: ${status}`;
      this.#handlers.onRefusal(refusal('link-send-failed', detail));
      this.#scheduleRetry('socket_error', detail);
    });

    socket.on('error', (error: Error) => {
      // A certificate the runtime refuses is named as such, with the remedy: retried like any other
      // socket fault (a certificate can be rotated), but never reported as the controller being away.
      const detail = isCertificateRefusal(error)
        ? `${describeFailure(error)}. ${certificateRemedy('the controller')}`
        : describe(error);
      this.#handlers.onRefusal(refusal('link-send-failed', detail));
      this.#scheduleRetry('socket_error', detail);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      // A controller refuses a version window it cannot overlap by closing with 1002 (protocol
      // error) and naming both windows in the reason; read it as the refusal it is, not as a drop.
      if (code === 1002) {
        const named =
          reason.length > 0
            ? reason.toString('utf8')
            : 'the controller closed the socket as a protocol error';
        // A seq-gap close is a replay request: the controller names the position it holds and the
        // next dial replays from it. Naming it as a version rejection sent six of these to the log
        // in nine seconds while a session's turn-end frames were lost behind the backoff.
        this.#scheduleRetry(
          named.startsWith('seq gap') ? 'replay_requested' : 'protocol_version_rejected',
          named,
        );
        return;
      }
      this.#scheduleRetry('socket_closed', 'socket closed');
    });
  }

  #onMessage(raw: string): void {
    const decoded = decode(raw);
    if (!decoded.ok) {
      // A stranger's malformed or unknown frame does not take the link down.
      this.#handlers.onRefusal(decoded.refusal);
      return;
    }

    const frame: Frame = decoded.value;
    if (frame.frame === 'control') {
      this.#onControl(frame.payload);
      return;
    }

    const check = this.#inbound.accept(frame.sessionId, frame.seq);
    if (check.disposition === 'duplicate') return; // replay after reconnect; expected
    if (check.disposition === 'gap') {
      this.#handlers.onGap(frame.sessionId, check.expected, check.received);
      this.#reportWedge(frame.sessionId, check.expected, check.received);
      return;
    }
    // The lane moved, so a wedge reported earlier is over and a later one is worth reporting again.
    this.#wedged.delete(frame.sessionId);
    this.#handlers.onSessionFrame(frame);
  }

  #onControl(payload: ControlPayload): void {
    switch (payload.kind) {
      case 'link_welcome': {
        if (payload.protocolVersion < PROTOCOL_VERSION_MIN || payload.protocolVersion > PROTOCOL_VERSION) {
          this.#scheduleRetry(
            'protocol_version_rejected',
            `controller chose v${payload.protocolVersion}, this host speaks v${PROTOCOL_VERSION_MIN} to v${PROTOCOL_VERSION}`,
          );
          return;
        }
        this.#negotiatedVersion = payload.protocolVersion;
        // Here, and only here. The peer answered with a version this host speaks, so the
        // connection is established in the sense that matters; see the note on the `open` handler
        // for the loop this placement prevents. Backoff grows across a rejected handshake and
        // resets only when one succeeds.
        this.#attempt = 0;
        // The controller said what it already has; replay from there.
        this.#replay(payload.cursors);
        this.#transition('accepted', 'hello_completed', `protocol v${payload.protocolVersion}`);
        return;
      }
      case 'link_ack':
        this.#prune(payload.cursors);
        return;
      case 'link_ping':
        this.#sendControl({ kind: 'link_pong', nonce: payload.nonce });
        return;
      case 'link_pong':
        this.#lastPongAtMs = this.#ticker();
        return;
      case 'link_bye':
        this.#scheduleRetry('socket_closed', `controller said bye: ${payload.cause}`);
        return;
      case 'link_hello':
        // A controller dialling this host would be an inbound link; this package has none.
        return;
      default:
        return;
    }
  }

  /**
   * Re-send what the controller is missing, then resume the pending flow.
   *
   * Every written frame still retained is by definition unconfirmed, so it all goes back out in
   * order. Re-sending something the controller already had is harmless — its own seq filter drops
   * it, while failing to re-send is a permanent hole. That asymmetry is what dense `seq` is for.
   * Pending entries drain after, so their stamps land above every replayed number.
   */
  #replay(cursors: readonly SessionCursor[]): void {
    this.#prune(cursors);

    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;

    for (const frame of this.#queue.writtenFrames()) {
      this.#writeFrame(socket, frame);
    }
    this.#drain();
  }

  #prune(cursors: readonly SessionCursor[]): void {
    for (const cursor of cursors) {
      this.#queue.pruneUpTo(cursor.sessionId, cursor.seq);
      this.#releaseIfDrained(cursor.sessionId);
    }
  }

  /** An ended session's counter goes when its last retained frame does, and not before. */
  #releaseIfDrained(sessionId: string): void {
    if (!this.#forgotten.has(sessionId)) return;
    if (this.#queue.retainedFor(sessionId) > 0) return;
    this.#outbound.forget(sessionId);
    this.#forgotten.delete(sessionId);
    this.#forgottenAtMs.delete(sessionId);
  }

  /**
   * Release ended sessions whose retention has outlived the bound. Never silent.
   *
   * The emission matters as much as the release. Dropping frames quietly is the shape this package
   * refuses everywhere else: a controller that later notices a session's closing transitions never
   * arrived would have nothing to read, and "the host discarded them after a minute" and "they were
   * never sent" are indistinguishable from the outside. So the release is a named refusal carrying
   * the session and the count, on the same lane every other refusal uses.
   */
  #sweepEndedRetention(): void {
    const bound = this.#options.endedRetentionMs ?? ENDED_RETENTION_MS;
    const now = this.#ticker();
    for (const sessionId of [...this.#forgotten]) {
      const endedAtMs = this.#forgottenAtMs.get(sessionId);
      if (endedAtMs === undefined || now - endedAtMs < bound) continue;

      const dropped = this.#queue.releaseSession(sessionId);
      this.#outbound.forget(sessionId);
      this.#forgotten.delete(sessionId);
      this.#forgottenAtMs.delete(sessionId);

      if (dropped > 0) {
        this.#handlers.onRefusal(
          refusal(
            'retention-released-unacked',
            `released ${dropped} written frame(s) for ended session ${sessionId}: they went unacked ` +
              `for ${bound}ms, and holding an ended session's frames forever fills this ` +
              `host's queue with the dead. Those frames can no longer be replayed`,
          ),
        );
      }
    }
  }

  /**
   * Tell the peer its lane is wedged, once, with the number that heals it.
   *
   * This is the only signal that reaches the party who can fix it. `onGap` is host-local: it tells
   * the embedder, and the embedder is not the one holding the frame that was lost. The sender is,
   * and without this it is told nothing at all; the lane simply stops, forever, in silence.
   *
   * `expected` makes this a resync request rather than a complaint. It is the exact seq this side
   * will accept next, so a peer that re-sends from there heals the lane with no new protocol, no
   * NACK vocabulary and no negotiation. The wire already guarantees dense numbering; this hands back
   * the one number that lets a sender restore it.
   */
  #reportWedge(sessionId: string, expected: number, received: number): void {
    if (this.#wedged.has(sessionId)) return;
    this.#wedged.add(sessionId);
    this.send(
      sessionId,
      wireRefusalUpdate(
        {
          reason: 'seq-gap',
          detail:
            `this side expected seq ${expected} and received ${received}, so the frame was dropped ` +
            `and this lane will refuse every later frame until it is re-sent from ${expected}. There ` +
            `is no retransmit request in this protocol: re-send from ${expected} to heal it`,
        },
        expected,
        received,
      ),
    );
  }

  /**
   * Write a control frame immediately, without consulting the high-water mark. Deliberate.
   *
   * Control frames bypass backpressure by construction, and the reason is that they are how the
   * link's own health is judged. A heartbeat queued behind a backed-up session lane does not arrive
   * late — it arrives after the peer has already concluded the socket is dead, so a controller
   * under load would declare a perfectly healthy host gone precisely when it is busiest. The same
   * holds for `link_pong` (an unanswered ping IS the death signal) and `link_bye` (a deliberate
   * close that queues is a silent one).
   *
   * What makes it safe rather than a hole: these frames are small, bounded in number, and not
   * sequenced or replayed, so they cannot displace a session frame or leave a gap. Never route a
   * session payload through here to skip the queue; that would break both the ordering and the
   * dense-seq guarantee in one move.
   */
  #sendControl(payload: ControlPayload): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    const encoded = encode(this.#controlFrame(payload));
    if (!encoded.ok) {
      this.#handlers.onRefusal(encoded.refusal);
      return;
    }
    try {
      socket.send(encoded.value);
    } catch (error) {
      this.#handlers.onRefusal(refusal('link-send-failed', describe(error)));
    }
  }

  #controlFrame(payload: ControlPayload): Frame {
    return { frame: 'control', at: this.#clock(), payload };
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    const interval = this.#options.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;
    const timeout = this.#options.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs;

    this.#heartbeatTimer = setInterval(() => {
      // Rides this tick rather than a timer of its own; see `ENDED_RETENTION_MS`. It runs before
      // the liveness check so a link about to be declared dead still sweeps once on the way out.
      this.#sweepEndedRetention();

      // A half-open socket looks alive to TCP and reads as a hung session to a human. The only way
      // to tell is to ask and require an answer.
      if (this.#ticker() - this.#lastPongAtMs > timeout) {
        this.#scheduleRetry('heartbeat_timeout', `no pong within ${timeout}ms`);
        return;
      }
      this.#sendControl({ kind: 'link_ping', nonce: String(this.#ticker()) });
    }, interval);
    this.#heartbeatTimer.unref?.();
  }

  /**
   * The one path out of this link that is not a retry and not a shutdown.
   *
   * It is separate from `#scheduleRetry` because every other failure this link meets is worth
   * another attempt, so the retry is the default and that is right. This one is not: the identity
   * provider has refused the material outright, and the next dial refuses identically. Sending it
   * round the backoff loop produces a host that looks busy reconnecting, is accomplishing nothing,
   * and whose process eventually drains and exits zero, so a supervisor and a dashboard both read a
   * clean run.
   *
   * It sets `#stopping`, which is what makes the state honest rather than merely reported. Without
   * it an in-flight socket callback could schedule a retry after this transition and the link would
   * quietly resume dialling behind a `closed` it had already announced.
   */
  #failCredential(refused: Refusal): void {
    this.#stopping = true;
    this.#clearTimers();

    const socket = this.#socket;
    this.#socket = null;
    socket?.removeAllListeners();
    // A socket still mid-handshake aborts by emitting an error ("closed before the connection was
    // established") — and the line above just removed every listener, so without this mute the
    // abort becomes an unhandled throw inside the teardown. The error carries no information this
    // method does not already have: it is the close it itself asked for.
    socket?.once('error', () => {});
    socket?.close();

    this.#transition('closed', 'credential_rejected', refused.detail);
  }

  #scheduleRetry(cause: Parameters<LinkStateMachine['to']>[1], detail: string): void {
    if (this.#stopping) return;

    this.#clearHeartbeat();
    this.#clearDrainTimer(); // nothing to poll without a socket; the reconnect's replay resumes it
    const socket = this.#socket;
    this.#socket = null;
    socket?.removeAllListeners();
    // Same mute as `#failCredential`, for the same reason: a refused upgrade arrives here with the
    // handshake still open, and closing it emits an error at a socket that no longer has listeners.
    socket?.once('error', () => {});
    socket?.close();

    this.#clearConnectTimer();
    this.#transition('backoff', cause, detail);

    if (this.#retryTimer !== null) return; // one retry in flight at a time
    const delay = nextDelayMs(this.#attempt, this.#random, this.#backoff);
    this.#attempt += 1;
    this.#transition('backoff', 'retry_scheduled', `retry in ${delay}ms`);

    // This timer holds the process open, deliberately. With no sessions running it is often the
    // only handle left; unref'd, a host in the middle of an ordinary outage would drain and exit
    // 0, and a supervisor would read a clean finish out of a network blip. A retry that is
    // scheduled is work this process has promised to do; the handle stays ref'd so the promise
    // outlives an empty event loop. Only the retryable class ever gets here (a terminal refusal
    // takes `#failCredential`, which clears this timer and never schedules another), and the
    // heartbeat and drain timers stay unref'd deliberately: they exist to serve an open socket,
    // not to keep a dead one's process alive.
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#stopping) return;
      this.#transition('connecting', 'start_requested');
      this.#openSocket();
    }, delay);
  }

  #clearConnectTimer(): void {
    if (this.#connectTimer !== null) {
      clearTimeout(this.#connectTimer);
      this.#connectTimer = null;
    }
  }

  #transition(
    to: Parameters<LinkStateMachine['to']>[0],
    cause: Parameters<LinkStateMachine['to']>[1],
    detail: string | null = null,
  ): void {
    const transition = this.#machine.to(to, cause, this.#clock(), detail);
    if (transition !== null) this.#handlers.onTransition(transition);
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #clearDrainTimer(): void {
    if (this.#drainTimer !== null) {
      clearTimeout(this.#drainTimer);
      this.#drainTimer = null;
    }
  }

  #clearTimers(): void {
    this.#clearHeartbeat();
    this.#clearDrainTimer();
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#clearConnectTimer();
      this.#retryTimer = null;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
