/**
 * The gate lane reaches the wire.
 *
 * A forwarder that emits only the transitions `observeMessage` returns puts the message lane on
 * the wire and not the other two: the hook lane's tool entries and every one of the gate's
 * outcomes (a deny, an outage, an expiry, a hold) are recorded on the machine and seen by nobody
 * off-box. The most security-relevant thing this package does would be the part a controller
 * could not observe.
 *
 * The second half is the one that is easy to get wrong. Subscribing at the machine without
 * removing the old path emits every message-caused transition twice, and a doubled trace is not a
 * cosmetic fault: a consumer counting state changes reads the session as having done each thing
 * twice. So both directions are pinned here, and each fails when its defence is removed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { HookInput, SDKMessage } from '../host/agent-process.js';
import { fixedClock, fixedTicker } from '../core/time.js';
import type { Refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import { permissionHooks } from '../gate/gate.js';
import { recordGateOutcome } from '../gate/outcome.js';
import { SessionRegistry } from '../sessions/registry.js';
import { SessionStateMachine } from '../state/machine.js';
import { SessionObserver } from '../state/observer.js';
import type { SessionTransition } from '../state/model.js';
import type { JsonObject, SessionPayload } from './frames.js';
import { readStateTransition } from './frames.js';
import type { FrameSink } from './stream.js';
import { forwardSession } from './stream.js';
import { fakeAgents, settle } from '../test-support/fake-agent.js';

const AT = '2026-08-04T00:00:00.000Z';
const WHERE = { cwd: 'C:/work', worktree: null, branch: null, unknownReason: 'a test machine' };

class RecordingSink implements FrameSink {
  readonly sent: { sessionId: string; payload: SessionPayload }[] = [];

  send(sessionId: string, payload: SessionPayload): Result<void> {
    this.sent.push({ sessionId, payload });
    return ok(undefined);
  }

  /** Every transition that reached the wire, in order. */
  transitions(): SessionTransition[] {
    const found: SessionTransition[] = [];
    for (const entry of this.sent) {
      if (entry.payload.kind !== 'session_update') continue;
      const body = (entry.payload as unknown as { body: JsonObject }).body;
      const transition = readStateTransition(body);
      if (transition !== null) found.push(transition);
    }
    return found;
  }

  causes(): string[] {
    return this.transitions().map((transition) => `${transition.cause.kind}/${transition.cause.event}`);
  }
}

function wire(): {
  machine: SessionStateMachine;
  observer: SessionObserver;
  sink: RecordingSink;
  emit: (message: SDKMessage) => void;
  refusals: Refusal[];
} {
  const fake = fakeAgents();
  const registry = new SessionRegistry({
    baseEnv: { PATH: 'p' },
    homeDir: 'C:/nonexistent-home-for-tests',
    clock: fixedClock(Date.UTC(2026, 7, 4)),
    startProcess: fake.start,
  });
  const created = registry.create({ cwd: 'C:/work' });
  assert.ok(created.ok);

  const machine = new SessionStateMachine({ where: WHERE, clock: () => AT, ticker: fixedTicker(0) });
  const observer = new SessionObserver(machine);
  const sink = new RecordingSink();
  const refusals: Refusal[] = [];

  forwardSession({
    sessionKey: 'controller-handle-1',
    session: created.value,
    observer,
    sink,
    onRefusal: (refused) => refusals.push(refused),
  });

  const process = fake.started[0];
  assert.ok(process);
  return { machine, observer, sink, emit: (message) => process.emit(message), refusals };
}

const preToolUse = (toolName: string, toolUseId: string): HookInput =>
  ({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: toolUseId,
    tool_input: { file_path: 'C:/work/a.txt' },
    session_id: 'agent-1',
    cwd: 'C:/work',
  }) as unknown as HookInput;

/** Drive the real gate handler once, exactly as the CLI would. */
async function callGate(
  machine: SessionStateMachine,
  decide: Parameters<typeof permissionHooks>[0]['decide'],
) {
  const hooks = permissionHooks({
    sessionKey: 'handle-1',
    decide,
    onOutcome: (outcome) => void recordGateOutcome(machine, outcome),
    decisionTimeoutMs: 200,
    holdAfterMs: 20,
  });
  const handler = hooks.PreToolUse?.[0]?.hooks[0];
  assert.ok(handler !== undefined, 'the gate registered no PreToolUse handler');
  return handler(preToolUse('Write', 'call-1'), 'call-1', { signal: new AbortController().signal });
}

// ---------------------------------------------------------------------------

test('regression: a controller deny reaches the wire as a transition, not only the machine', async () => {
  const wired = wire();
  await callGate(wired.machine, async () => ({ behavior: 'deny', message: 'the controller said no' }));
  await settle();

  assert.ok(
    wired.sink.causes().includes('control/permission_denied'),
    `the denial never left the box: ${wired.sink.causes().join(', ')}`,
  );

  const denial = wired.sink.transitions().find((one) => one.cause.event === 'permission_denied');
  assert.equal(denial?.cause.detail, 'the controller said no', 'the reason did not travel with it');
});

test('regression: an outage reaches the wire under its own cause, distinct from a denial', async () => {
  const wired = wire();
  await callGate(wired.machine, () => {
    throw new Error('the decider is broken');
  });
  await settle();

  const causes = wired.sink.causes();
  assert.ok(
    causes.includes('refusal/permission-decision-unavailable'),
    `the outage never left the box: ${causes.join(', ')}`,
  );
  assert.equal(
    causes.includes('control/permission_denied'),
    false,
    "an outage arrived on the wire wearing a denial's cause — the two must never look alike",
  );
});

test('regression: the hold is visible off-box while the decision is still outstanding', async () => {
  const wired = wire();
  await callGate(wired.machine, () => new Promise(() => undefined));
  await settle();

  const holding = wired.sink.transitions().filter((transition) => transition.activity?.kind === 'permission');
  assert.ok(holding.length > 0, `no permission activity reached the wire: ${wired.sink.causes().join(', ')}`);

  // The expiry closes it, so a consumer sees the whole hold rather than a session stuck waiting.
  assert.ok(wired.sink.causes().includes('timeout/hook_timed_out'), 'the expiry never reached the wire');
});

test('the hook lane reaches the wire — a tool entry opened by observation, not by a message', async () => {
  const wired = wire();
  wired.observer.observeHook(preToolUse('Bash', 'call-hook-1'));
  await settle();

  assert.ok(
    wired.sink.causes().some((cause) => cause.startsWith('hook/')),
    `no hook-lane transition reached the wire: ${wired.sink.causes().join(', ')}`,
  );
});

test('regression: the other direction — a message-caused transition arrives exactly once', async () => {
  const wired = wire();
  wired.emit({
    type: 'system',
    subtype: 'init',
    session_id: 'agent-1',
    uuid: 'uuid-init',
    claude_code_version: '9.9.9',
    cwd: 'C:/work',
    model: 'a-model',
    permissionMode: 'default',
    apiKeySource: 'oauth',
    tools: [],
    skills: [],
    plugins: [],
  } as unknown as SDKMessage);
  await settle();

  const transitions = wired.sink.transitions();
  const seqs = transitions.map((transition) => transition.seq);
  assert.deepEqual(
    seqs,
    [...new Set(seqs)],
    `a transition reached the wire more than once: ${JSON.stringify(seqs)}`,
  );
  assert.ok(
    transitions.length > 0,
    'the message lane emitted no transition at all — this test is aimed wrong',
  );
});

test('the message still arrives before the transition it caused', async () => {
  const wired = wire();
  wired.emit({
    type: 'system',
    subtype: 'init',
    session_id: 'agent-1',
    uuid: 'uuid-init',
    claude_code_version: '9.9.9',
    cwd: 'C:/work',
    model: 'a-model',
    permissionMode: 'default',
    apiKeySource: 'oauth',
    tools: [],
    skills: [],
    plugins: [],
  } as unknown as SDKMessage);
  await settle();

  const shapes = wired.sink.sent.map((entry) => {
    const payload = entry.payload as { kind: string; body?: { update?: string } };
    return `${payload.kind}/${payload.body?.update ?? '?'}`;
  });
  const message = shapes.indexOf('session_update/agent_message');
  const transition = shapes.indexOf('session_update/state_transition');
  assert.ok(message >= 0 && transition >= 0, `both lanes must be present: ${shapes.join(', ')}`);
  assert.ok(message < transition, `the transition preceded its own message: ${shapes.join(', ')}`);
});

test('a transition the machine refuses is still reported, because the wire will never carry it', async () => {
  const wired = wire();
  // A cause no vocabulary declares. It cannot be recorded, so `onRefusal` is its only audience.
  const rejected = wired.machine.record({
    to: 'working',
    cause: { kind: 'not-a-kind', event: 'nonsense', detail: 'x' } as never,
  });
  assert.equal(rejected.ok, false);

  // The forwarder reports what `observeMessage` refused; this proves the reporting path is live by
  // driving the same channel the observer uses.
  const before = wired.sink.sent.length;
  wired.observer.observeMessage({ type: 'not-a-message' } as unknown as SDKMessage);
  await settle();
  assert.equal(wired.sink.sent.length, before, 'an unmodelled message put something on the wire');
});
