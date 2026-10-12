/**
 * Forwarding with a fact lift: where the facts and fragments ride relative to the message they came
 * from and the transitions it caused. Against a real `HostedSession` and a recording sink, as
 * `stream.test.ts` is; that file holds the forwarding properties with no lift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { HookInput, SDKMessage } from '../host/agent-process.js';
import { fixedClock, fixedTicker } from '../core/time.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import { factLiftFor } from '../sessions/fact-lift.js';
import { SessionRegistry } from '../sessions/registry.js';
import { SessionStateMachine } from '../state/machine.js';
import { SessionObserver } from '../state/observer.js';
import { decode, encode } from './codec.js';
import type { JsonObject, SessionPayload } from './frames.js';
import { readAgentFacts, readAgentFragment } from './frames.js';
import type { FrameSink } from './stream.js';
import { forwardSession } from './stream.js';
import { fakeAgents, initMessage, settle } from '../test-support/fake-agent.js';

const AT = '2026-08-04T00:00:00.000Z';
const WHERE = { cwd: 'C:/work', worktree: null, branch: null, unknownReason: 'a test machine' };

class RecordingSink implements FrameSink {
  readonly sent: SessionPayload[] = [];
  send(_sessionId: string, payload: SessionPayload): Result<void> {
    this.sent.push(payload);
    return ok(undefined);
  }

  /** Each frame named by lane and body: `update/agent_facts:turn_record`, `delta/agent_fragment:text`. */
  lanes(): string[] {
    return this.sent.map((payload) => {
      const lane = payload.kind === 'session_update' ? 'update' : 'delta';
      const body = (payload as { body: JsonObject }).body;
      const facts = readAgentFacts(body);
      if (facts !== null) return `${lane}/agent_facts:${facts.fact.kind}`;
      const fragment = readAgentFragment(body);
      if (fragment !== null) return `${lane}/agent_fragment:${fragment.channel}`;
      const update = body['update'];
      if (update === 'agent_message') {
        return `${lane}/agent_message:${JSON.stringify((body['message'] as JsonObject)['type'])}`;
      }
      if (update === 'state_transition') {
        const cause = (body['transition'] as { cause: { event: string } }).cause;
        return `${lane}/state_transition:${cause.event}`;
      }
      return `${lane}/${JSON.stringify(update)}`;
    });
  }
}

function wire(withLift: boolean): {
  sink: RecordingSink;
  emit: (message: SDKMessage) => void;
  observer: SessionObserver;
} {
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
  const observer = new SessionObserver(machine);
  const sink = new RecordingSink();
  const lift = factLiftFor('claude');
  assert.ok(lift !== null);
  forwardSession({
    sessionKey: 'handle-1',
    session: created.value,
    observer,
    sink,
    clock: () => AT,
    ...(withLift ? { lift } : {}),
  });
  const process = fake.started[0];
  assert.ok(process);
  return { sink, emit: (message) => process.emit(message), observer };
}

const result = (): SDKMessage =>
  ({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    session_id: 'agent-1',
    num_turns: 1,
    duration_ms: 10,
    total_cost_usd: 0.5,
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    modelUsage: {},
  }) as unknown as SDKMessage;

const textDelta = (): SDKMessage =>
  ({
    type: 'stream_event',
    uuid: 'delta-1',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
  }) as unknown as SDKMessage;

test('the message rides first, then its facts, then its fragments, then what it caused', async () => {
  const wired = wire(true);
  wired.emit(initMessage('agent-1'));
  wired.emit(textDelta());
  wired.emit(result());
  await settle();

  assert.deepEqual(wired.sink.lanes(), [
    'update/agent_message:"system"',
    'update/agent_facts:session_handle',
    'update/agent_facts:agent_receipt',
    'update/state_transition:system/init',
    'delta/agent_message:"stream_event"',
    'delta/agent_fragment:text',
    'update/agent_message:"result"',
    'update/agent_facts:turn_record',
    'update/state_transition:result',
  ]);
});

test('control: with no lift, the same messages put nothing but messages and transitions on the wire', async () => {
  const wired = wire(false);
  wired.emit(initMessage('agent-1'));
  wired.emit(textDelta());
  wired.emit(result());
  await settle();

  assert.deepEqual(wired.sink.lanes(), [
    'update/agent_message:"system"',
    'update/state_transition:system/init',
    'delta/agent_message:"stream_event"',
    'update/agent_message:"result"',
    'update/state_transition:result',
  ]);
});

test("each fact names its message by the message's own uuid, stamped with the message's instant", async () => {
  const wired = wire(true);
  wired.emit(initMessage('agent-1'));
  wired.emit(result());
  await settle();

  const facts = wired.sink.sent
    .map((payload) => readAgentFacts((payload as { body: JsonObject }).body))
    .filter((body) => body !== null);
  assert.deepEqual(
    facts.map((body) => [body.fact.kind, body.sourceId, body.observedAt]),
    [
      ['session_handle', 'agent-1-init', AT],
      ['agent_receipt', 'agent-1-init', AT],
      ['turn_record', 'result-1', AT],
    ],
  );
});

test("a compaction's fact follows the transition that recorded it, and names no message", async () => {
  const wired = wire(true);
  wired.observer.observeHook({
    hook_event_name: 'PreCompact',
    trigger: 'auto',
    custom_instructions: null,
  } as unknown as HookInput);
  wired.emit({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'boundary-1',
    compact_metadata: { trigger: 'auto', pre_tokens: 100, post_tokens: 10 },
  } as unknown as SDKMessage);
  await settle();

  assert.deepEqual(wired.sink.lanes(), [
    'update/state_transition:PreCompact',
    'update/agent_facts:compaction',
    'update/agent_message:"system"',
    'update/state_transition:system/compact_boundary',
    'update/agent_facts:compaction',
  ]);
  const ended = readAgentFacts((wired.sink.sent[4] as { body: JsonObject }).body);
  assert.equal(ended?.sourceId, null, 'a fact the observer yields names no message');
  assert.deepEqual(ended?.fact, {
    kind: 'compaction',
    runtime: 'claude',
    status: 'ended',
    trigger: 'auto',
    tokensBefore: 100,
    tokensAfter: 10,
  });
});

test('every frame the lift adds encodes and decodes back unchanged', async () => {
  const wired = wire(true);
  wired.emit(initMessage('agent-1'));
  wired.emit(textDelta());
  wired.emit(result());
  await settle();

  let seq = 0;
  for (const payload of wired.sink.sent) {
    seq += 1;
    const frame = { frame: 'session' as const, sessionId: 'handle-1', seq, at: AT, payload };
    const encoded = encode(frame);
    assert.ok(encoded.ok, encoded.ok ? '' : encoded.refusal.detail);
    const decoded = decode(encoded.value);
    assert.ok(decoded.ok, decoded.ok ? '' : decoded.refusal.detail);
    assert.deepEqual(decoded.value, frame);
  }
});
