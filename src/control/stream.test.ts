/**
 * Forwarding: the properties, against a real `HostedSession` and a recording sink.
 *
 * The SDK's own behaviour is not asserted here; that is what `stream.live.test.ts` is for. What
 * this file pins is what the host does with what it is given: which lane a message rides, that a
 * transition never precedes the message that caused it, that a delta never becomes retained
 * history, and that the sink's refusals reach someone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { SDKMessage } from '../host/agent-process.js';
import { fixedClock, fixedTicker } from '../core/time.js';
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import { SessionRegistry } from '../sessions/registry.js';
import type { HostedSession } from '../sessions/session.js';
import { SessionStateMachine } from '../state/machine.js';
import { SessionObserver } from '../state/observer.js';
import type { JsonObject, SessionPayload } from './frames.js';
import { readAgentMessage, readStateTransition } from './frames.js';
import type { FrameSink } from './stream.js';
import { forwardSession } from './stream.js';
import { fakeAgents, initMessage, settle } from '../test-support/fake-agent.js';

const AT = '2026-08-04T00:00:00.000Z';
const WHERE = { cwd: 'C:/work', worktree: null, branch: null, unknownReason: 'a test machine' };

/** The body of an update or a delta. Both lanes carry the same shape; see `agentMessageDelta`. */
const bodyOf = (payload: SessionPayload): JsonObject => (payload as unknown as { body: JsonObject }).body;

// --- fixtures ---------------------------------------------------------------

const assistantMessage = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    uuid: `uuid-a-${text}`,
    message: { content: [{ type: 'text', text }] },
  }) as unknown as SDKMessage;

const textDelta = (text: string): SDKMessage =>
  ({
    type: 'stream_event',
    uuid: `uuid-d-${text}`,
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  }) as unknown as SDKMessage;

const statusMessage = (status: string | null): SDKMessage =>
  ({ type: 'system', subtype: 'status', uuid: `uuid-s-${status}`, status }) as unknown as SDKMessage;

const sessionStateChanged = (state: string): SDKMessage =>
  ({
    type: 'system',
    subtype: 'session_state_changed',
    uuid: `uuid-ssc-${state}`,
    state,
  }) as unknown as SDKMessage;

const hookStarted = (): SDKMessage =>
  ({ type: 'system', subtype: 'hook_started', uuid: 'uuid-hook' }) as unknown as SDKMessage;

/** Records everything sent, and can be told to refuse. */
class RecordingSink implements FrameSink {
  readonly sent: { sessionId: string; payload: SessionPayload }[] = [];
  refuseWith: Refusal | null = null;

  send(sessionId: string, payload: SessionPayload): Result<void> {
    if (this.refuseWith !== null) return { ok: false, refusal: this.refuseWith };
    this.sent.push({ sessionId, payload });
    return ok(undefined);
  }

  kinds(): string[] {
    return this.sent.map((entry) => entry.payload.kind);
  }

  /** The `update` string inside each body, so a reader can see the lanes at a glance. */
  bodies(): string[] {
    return this.sent.map((entry) => {
      const payload = entry.payload as { kind: string; body?: { update?: string } };
      return `${payload.kind}/${payload.body?.update ?? '?'}`;
    });
  }
}

interface Wired {
  readonly session: HostedSession;
  readonly sink: RecordingSink;
  readonly refusals: Refusal[];
  readonly emit: (message: SDKMessage) => void;
  readonly finish: () => void;
  readonly stop: () => void;
}

function wire(sessionKey = 'controller-handle-1'): Wired {
  const fake = fakeAgents();
  const registry = new SessionRegistry({
    baseEnv: { PATH: 'p' },
    homeDir: 'C:/nonexistent-home-for-tests',
    clock: fixedClock(Date.UTC(2026, 7, 4)),
    startTimeoutMs: 2_000,
    startProcess: fake.start,
  });
  const created = registry.create({ cwd: 'C:/work' });
  assert.ok(created.ok);

  const machine = new SessionStateMachine({
    where: WHERE,
    clock: () => AT,
    ticker: fixedTicker(0),
  });
  const observer = new SessionObserver(machine);
  const sink = new RecordingSink();
  const refusals: Refusal[] = [];

  const unsubscribe = forwardSession({
    sessionKey,
    session: created.value,
    observer,
    sink,
    onRefusal: (refused) => refusals.push(refused),
  });

  const process = fake.started[0];
  assert.ok(process);
  return {
    session: created.value,
    sink,
    refusals,
    emit: (message) => process.emit(message),
    finish: () => process.finish(),
    stop: unsubscribe,
  };
}

// --- the properties ---------------------------------------------------------

test('a turn can be rendered as it happens: text arrives incrementally, before the message that settles it', async () => {
  const wired = wire();
  wired.emit(initMessage('agent-1'));
  wired.emit(textDelta('Hel'));
  wired.emit(textDelta('lo'));
  wired.emit(assistantMessage('Hello'));
  await settle();

  const deltas = wired.sink.sent.filter((entry) => entry.payload.kind === 'session_delta');
  assert.equal(deltas.length, 2, 'both fragments reached the wire as deltas');

  const fragments = deltas.map((entry) => {
    const body = readAgentMessage(bodyOf(entry.payload));
    return (body as unknown as { event: { delta: { text: string } } }).event.delta.text;
  });
  assert.deepEqual(fragments, ['Hel', 'lo'], 'the fragments arrive in order and unaltered');

  // The ordering is the property, so the indices are compared, not merely checked for `>= 0`
  // (existence is already covered above).
  //
  // The settle is discriminated on the SDK message's own `type`, not on the body label:
  // `bodies().indexOf('session_update/agent_message')` would point at the init message (index 0),
  // because `system/init` forwards under that same label, and an existence-only assertion would
  // never notice the index was aimed at the wrong thing.
  const indexOfAssistantUpdate = (from: 'first' | 'last'): number => {
    const matches = wired.sink.sent
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => {
        if (entry.payload.kind !== 'session_update') return false;
        const body = readAgentMessage(bodyOf(entry.payload));
        return (body as unknown as { type?: string } | null)?.type === 'assistant';
      });
    const chosen = from === 'first' ? matches[0] : matches.at(-1);
    return chosen?.index ?? -1;
  };

  const bodies = wired.sink.bodies();
  const settledAt = indexOfAssistantUpdate('last');
  const firstDeltaAt = bodies.indexOf('session_delta/agent_message');
  const lastDeltaAt = bodies.lastIndexOf('session_delta/agent_message');

  assert.ok(settledAt >= 0, 'the assistant message that settles the fragments never reached the wire');
  assert.ok(firstDeltaAt >= 0, 'no fragment reached the wire');
  assert.ok(
    lastDeltaAt < settledAt,
    `a fragment arrived after the message that settles it (last delta ${lastDeltaAt}, settled ${settledAt}) — ` +
      `a consumer would repaint text the turn had already finalised`,
  );

  // And "incrementally" means more than one fragment before the settle. A single delta followed by
  // a settle is a turn that could not be rendered as it happened, and satisfies every assertion
  // above.
  const deltasBeforeSettle = bodies
    .slice(0, settledAt)
    .filter((body) => body === 'session_delta/agent_message');
  assert.ok(
    deltasBeforeSettle.length >= 2,
    `only ${deltasBeforeSettle.length} fragment(s) arrived before the settle — that is not incremental`,
  );
});

test('the message is forwarded verbatim — a consumer reads the SDK shape it already knows', async () => {
  const wired = wire();
  const message = textDelta('x');
  wired.emit(message);
  await settle();

  const first = wired.sink.sent[0];
  assert.ok(first);
  const body = readAgentMessage(bodyOf(first.payload));
  assert.deepEqual(body, message, 'nothing was renamed, unwrapped or dropped');
});

test('regression: a transition never precedes the message that caused it', async () => {
  const wired = wire();
  wired.emit(initMessage('agent-1'));
  await settle();

  const messageAt = wired.sink.bodies().indexOf('session_update/agent_message');
  const transitionAt = wired.sink.bodies().indexOf('session_update/state_transition');
  assert.ok(messageAt >= 0, 'the init message was forwarded');
  assert.ok(transitionAt >= 0, 'the transition it caused was forwarded');
  assert.ok(
    messageAt < transitionAt,
    'a consumer would have had to render a state change referring to a message it never received',
  );
});

test('a transition rides the durable lane, never the droppable one', async () => {
  const wired = wire();
  wired.emit(initMessage('agent-1'));
  await settle();

  const transitions = wired.sink.sent.filter((entry) => readStateTransition(bodyOf(entry.payload)) !== null);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.payload.kind, 'session_update', 'a transition is a fact, not a repaint');
});

test('the routing table decides the lane, and every lane is exercised here', async () => {
  const wired = wire();
  wired.emit(assistantMessage('settled')); // update
  wired.emit(textDelta('frag')); //            delta
  wired.emit(statusMessage('requesting')); //  delta
  wired.emit(sessionStateChanged('idle')); //  declined (its transition carries the fact)
  wired.emit(hookStarted()); //                declined (this host's own hook)
  await settle();

  const forwarded = wired.sink.sent.filter((entry) => readStateTransition(bodyOf(entry.payload)) === null);
  assert.deepEqual(
    forwarded.map((entry) => entry.payload.kind),
    ['session_update', 'session_delta', 'session_delta'],
    'the two declined messages produced no frame of their own',
  );
});

test('every frame is keyed by the controller handle, not by the id the agent reports', async () => {
  const wired = wire('controller-handle-9');
  wired.emit(initMessage('agent-mints-this-one'));
  await settle();

  assert.ok(wired.sink.sent.length > 0);
  for (const entry of wired.sink.sent) {
    assert.equal(entry.sessionId, 'controller-handle-9');
  }

  // And the agent's own id is not lost: it rides inside the transition, as a fact.
  const transition = wired.sink.sent
    .map((entry) => readStateTransition(bodyOf(entry.payload)))
    .find((value) => value !== null);
  assert.equal(transition?.sessionId, 'agent-mints-this-one');
});

test('regression: frames flow before the agent has named itself — the window that has no agent id at all', async () => {
  const wired = wire('controller-handle-2');
  // A turn is submitted before init; the agent has no id yet and may never get one.
  wired.emit({ type: 'assistant', uuid: 'u', message: { content: [] } } as unknown as SDKMessage);
  await settle();

  assert.equal(wired.sink.sent.length, 1, 'the frame was sendable with no agent id in existence');
  assert.equal(wired.sink.sent[0]?.sessionId, 'controller-handle-2');
});

test('a session end emits its ending transition, and it is the last thing said', async () => {
  const wired = wire();
  wired.emit(initMessage('agent-1'));
  await settle();
  wired.finish();
  await settle();

  const last = wired.sink.sent.at(-1);
  assert.ok(last);
  const ending = readStateTransition(bodyOf(last.payload));
  assert.equal(ending?.to, 'ended');
  assert.equal(ending?.cause.kind, 'process');
  assert.equal(ending?.cause.event, 'process_ended', 'the ending names what the stream did');
  assert.equal(last.payload.kind, 'session_update', 'an ending is never droppable');
});

test('a refusal from the sink is reported, never swallowed as a successful send', async () => {
  const wired = wire();
  wired.sink.refuseWith = refusal('frame-too-large', 'a tool result carried a file');
  wired.emit(assistantMessage('enormous'));
  await settle();

  assert.equal(wired.sink.sent.length, 0);
  assert.deepEqual(
    wired.refusals.map((refused) => refused.reason),
    ['frame-too-large'],
    'the caller learns its frame did not go',
  );
});

test('unsubscribing stops the forwarding, and doing it twice is harmless', async () => {
  const wired = wire();
  wired.emit(assistantMessage('before'));
  await settle();
  const before = wired.sink.sent.length;

  wired.stop();
  wired.stop();
  wired.emit(assistantMessage('after'));
  await settle();

  assert.equal(wired.sink.sent.length, before, 'nothing was forwarded after the unsubscribe');
});

// The containment is the session's, not this module's, and that is deliberate. A forwarder that
// caught its own bugs would leave `subscriber_failed` with nothing to catch and would name the same
// failure twice. This asserts the division holds: a throwing sink surfaces as a degrade of its own
// kind, the session is not blamed, and the pump keeps reading.
test('regression: a forwarder bug is a subscriber_failed degrade — it never impersonates the process dying', async () => {
  const fake = fakeAgents();
  const registry = new SessionRegistry({
    baseEnv: { PATH: 'p' },
    homeDir: 'C:/nonexistent-home-for-tests',
    clock: fixedClock(Date.UTC(2026, 7, 4)),
    startTimeoutMs: 2_000,
    startProcess: fake.start,
  });
  const created = registry.create({ cwd: 'C:/work' });
  assert.ok(created.ok);

  const machine = new SessionStateMachine({ where: WHERE, clock: () => AT, ticker: fixedTicker(0) });
  const degrades: string[] = [];
  created.value.onDegrade((degrade) => degrades.push(degrade.kind));

  forwardSession({
    sessionKey: 'k',
    session: created.value,
    observer: new SessionObserver(machine),
    sink: {
      send(): Result<void> {
        throw new Error('the sink exploded');
      },
    },
  });

  const process = fake.started[0];
  assert.ok(process);
  process.emit(initMessage('agent-1'));
  process.emit(assistantMessage('one'));
  await settle();

  assert.deepEqual(degrades, ['subscriber_failed', 'subscriber_failed'], 'named, and named twice');
  // The pump kept reading past the first throw, so init was still adopted: the session became live
  // while its forwarder was failing, which is what containing the two separately buys.
  assert.equal(created.value.state, 'live', 'the session is fine; only a subscriber was not');
  assert.equal(created.value.ended, null, 'the process was never blamed for a subscriber bug');
});
