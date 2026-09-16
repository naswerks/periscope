/**
 * Forwarding: one session's live output becomes frames on the outbound link.
 *
 * This module subscribes; it does not read the stream itself. `HostedSession` already reads the
 * agent's stream once and fans it out, because the SDK hands back a single-consumer iterator and
 * two readers would each silently see half of it. If a second read loop ever appears in this
 * package, one of the two consumers is losing messages and nobody is being told.
 *
 * A throw here is deliberately not caught. The pump already contains a subscriber that throws,
 * reports it as `subscriber_failed` (its own kind, so a forwarder's bug cannot impersonate the
 * process dying) and keeps reading. Catching here would name the same failure twice and leave that
 * mechanism with nothing to catch. Ordinary failure is not a throw anyway: `send` returns a
 * refusal, which is reported through `onRefusal` and is the caller's pressure signal.
 *
 * Transitions are taken from the machine, not from the message handler's return value, and that
 * is what puts the gate on the wire. Messages are only one of three things that move a session: the
 * hook lane records tool entries, and the gate records denials, outages, expiries and holds
 * directly. Forwarding only what `observeMessage` returns would carry the message lane and nothing
 * else, so every refusal this package exists to produce (the offline boundary refusal, the
 * credential-path denial, an unreachable controller) would be visible on-box and invisible to the
 * controller that needs it. Subscribing where they are all recorded is the only place that sees
 * all three. The naive version of this double-emits: adding the subscription while still forwarding
 * `observeMessage`'s results sends every message-caused transition twice, which a consumer counting
 * state changes reads as the session having done each thing twice. The results are still read here
 * for their refusals, which the machine never sees, and never re-emitted.
 *
 * The message comes before the transition it caused, always. A transition is the settled
 * conclusion of a message, so a consumer must never see a state change that refers to a message it
 * has not been given; it would have to render a session that "started a tool" with no tool call in
 * hand. Ordering survives the subscription because `record` fans out to its listeners
 * synchronously: the message is emitted, then `observeMessage` records, then the listener emits.
 * Every payload then goes through the link's one queue, so arrival order is delivery order.
 * A hook- or gate-caused transition has no message, and that is not a violation of the rule
 * above; it is a fact about where it came from. A consumer must not assume every transition is
 * preceded by the message that explains it; `cause.kind` says which lane produced it.
 *
 * Which lane a message rides is not decided here. `stream-routing.ts` declares it per
 * discriminator, `satisfies Record<MessageDiscriminator, …>` against the SDK's own union. This file
 * reads the table; it holds no judgement of its own about what matters.
 */
import type { SDKMessage } from '../host/agent-process.js';
import type { HostedSession, SessionEnded, Unsubscribe } from '../sessions/session.js';
import type { SessionObserver } from '../state/observer.js';
import type { SessionTransition } from '../state/model.js';
import type { Refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import type { JsonObject, SessionPayload } from './frames.js';
import { agentMessageDelta, agentMessageUpdate, stateTransitionUpdate } from './frames.js';
import { laneFor } from './stream-routing.js';

/**
 * Where frames go. Structural rather than `ControllerLink` so the forwarder can be exercised with
 * no socket — and so this module pulls no WebSocket dependency into a path that does not need one.
 */
export interface FrameSink {
  send(sessionId: string, payload: SessionPayload): Result<void>;
}

export interface ForwardSessionOptions {
  /**
   * The frame's routing key: the controller's handle for this session, not the agent's own id.
   *
   * See `SessionFrame` in frames.ts for the three ids and why they are not interchangeable. The
   * short version: a session's first transitions are recorded before the agent has named itself,
   * and a session that dies in start-up never names itself at all, so keying frames by the agent's
   * id would make exactly the frames that explain a failure unsendable.
   */
  readonly sessionKey: string;
  readonly session: HostedSession;
  /** The session's own observer. Already attached to its machine; this does not create one. */
  readonly observer: SessionObserver;
  readonly sink: FrameSink;
  /**
   * Every refusal the sink returned, and every transition the machine would not record.
   *
   * Wired by callers that want to know; a refusal that nobody listens to is still a refusal and is
   * never a silent success — `send` has already declined by the time this is called.
   */
  readonly onRefusal?: (refusal: Refusal) => void;
}

/**
 * Start forwarding. Returns the unsubscribe, which is idempotent.
 *
 * The end transition is emitted from the session's own end listener rather than from the message
 * stream, because a session can end without its stream ending (a start timeout, a stop request)
 * and a trace whose last row is whatever happened to arrive last is not a trace of an ending.
 */
export function forwardSession(options: ForwardSessionOptions): Unsubscribe {
  const { sessionKey, session, observer, sink } = options;

  const refused = (refusal: Refusal): void => options.onRefusal?.(refusal);

  const emit = (payload: SessionPayload): void => {
    const sent = sink.send(sessionKey, payload);
    if (!sent.ok) refused(sent.refusal);
  };

  // Every transition this session records, whichever lane produced it. See this file's header.
  const dropTransitions = observer.machine.onTransition((transition) =>
    emit(stateTransitionUpdate(transition)),
  );

  /**
   * A transition the machine refused is not on the wire and never will be, so this is the only
   * place it can be named. The recorded ones are already gone out through the subscription above,
   * which is why nothing here emits.
   */
  const reportRejected = (recorded: readonly Result<SessionTransition>[]): void => {
    for (const result of recorded) if (!result.ok) refused(result.refusal);
  };

  const dropMessages = session.onMessage((message: SDKMessage) => {
    // The message first, then what it caused. See this file's header.
    forwardMessage(message, emit);
    reportRejected(observer.observeMessage(message));
  });

  const dropEnd = session.onEnd((ended: SessionEnded) => {
    reportRejected([observer.ended({ kind: 'process', event: ended.cause, detail: ended.detail })]);
    dropMessages();
  });

  return () => {
    dropMessages();
    dropEnd();
    dropTransitions();
  };
}

/**
 * One message onto its declared lane, or nowhere.
 *
 * A large message is refused, not truncated, and it will happen: a tool result carrying a big
 * file exceeds the frame limit, `send` declines with `frame-too-large`, and the refusal names the
 * bulk lane. That is the "commands only, never payloads" rule doing its job rather than a defect,
 * but a consumer will see a turn whose largest tool result never arrived, so the refusal has to
 * reach someone. It does, through `onRefusal`.
 */
function forwardMessage(message: SDKMessage, emit: (payload: SessionPayload) => void): void {
  const lane = laneFor(message);
  if (lane === 'declined') return;

  // Cast rather than copy: the message arrived as JSON and the codec is where bytes and types meet,
  // so re-validating it here would be a second wire edge. A message that genuinely cannot serialize
  // is refused by `encode` under its own name and reaches `onRefusal` like any other refusal.
  const body = message as unknown as JsonObject;
  emit(lane === 'delta' ? agentMessageDelta(body) : agentMessageUpdate(body));
}
