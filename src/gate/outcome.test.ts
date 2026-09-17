import test from 'node:test';
import assert from 'node:assert/strict';

import { refusal } from '../core/refusal.js';
import type { HookInput } from '../host/agent-process.js';
import { SessionStateMachine } from '../state/machine.js';
import type { TransitionWhere } from '../state/model.js';
import { SessionObserver } from '../state/observer.js';
import type { DecisionRequest } from './decision.js';
import type { GateOutcome } from './outcome.js';
import { gateTransitions, recordGateOutcome } from './outcome.js';

const request: DecisionRequest = {
  toolName: 'Write',
  toolUseId: 'toolu_1',
  toolInput: { file_path: '/tmp/x' },
  sessionId: 'session-1',
  sessionKey: 'handle-1',
  cwd: '/tmp',
  agentId: null,
  agentType: null,
};

const where: TransitionWhere = {
  cwd: '/tmp',
  worktree: null,
  branch: null,
  unknownReason: 'not a repository',
};

const machine = (): SessionStateMachine =>
  new SessionStateMachine({ where, clock: () => '2026-08-04T00:00:00.000Z', ticker: () => 0 });

// The key is the tool_use_id, not the observer's name key: the observer closes name-keyed
// permission entries on the next PreToolUse for the same tool, and a hold must survive that.
test("a hold opens a permission entry keyed by tool_use_id, disjoint from the observer's name key", () => {
  const [transition] = gateTransitions({ kind: 'holding', request });
  assert.deepEqual(transition?.entry, {
    op: 'open',
    entryId: 'permission:toolu_1',
    activity: { kind: 'permission', name: 'Write' },
    agentId: null,
  });
  assert.deepEqual(transition?.cause.kind, 'hook');
  assert.deepEqual(transition?.cause.event, 'PreToolUse');
});

test('an ordinary allow emits nothing — the observer already recorded that the tool started', () => {
  assert.deepEqual(gateTransitions({ kind: 'allow', request, held: false }), []);
});

test('a held allow closes its entry, because an entry that was opened has to be closed', () => {
  const [transition] = gateTransitions({ kind: 'allow', request, held: true });
  assert.deepEqual(transition?.entry, { op: 'close', entryId: 'permission:toolu_1' });
});

// The separation this whole file exists for. A denial, an outage, an unrecognised answer and an
// expiry all block the tool identically — so the only thing that tells them apart downstream is the
// cause, and it has to do it in a field code can branch on rather than in prose.
test('a denial, an outage, an unrecognised answer and an expiry differ in cause kind, not in prose', () => {
  const outcomes: GateOutcome[] = [
    { kind: 'deny', request, held: false, message: 'the operator said no' },
    {
      kind: 'refused',
      request,
      held: false,
      refusal: refusal('permission-decision-unavailable', 'the controller answered 500'),
    },
    {
      kind: 'refused',
      request,
      held: false,
      refusal: refusal('permission-decision-unrecognised', 'behavior "escalate"'),
    },
    { kind: 'expired', request, held: false, detail: 'no decision within 50000ms' },
  ];

  const causes = outcomes
    .flatMap((outcome) => gateTransitions(outcome))
    .map((t) => `${t.cause.kind}/${t.cause.event}`);

  assert.deepEqual(causes, [
    'control/permission_denied',
    'refusal/permission-decision-unavailable',
    'refusal/permission-decision-unrecognised',
    'timeout/hook_timed_out',
  ]);

  // And every one of them is a distinct pair, so no two are distinguishable only by `detail` —
  // which model.ts documents as never branched on.
  assert.equal(new Set(causes).size, causes.length);
});

test('a denial is never a refusal, and an outage is never a denial', () => {
  const [denial] = gateTransitions({ kind: 'deny', request, held: false, message: 'no' });
  assert.notEqual(denial?.cause.kind, 'refusal', 'a deliberate "no" must not wear an outage\'s clothes');

  const [outage] = gateTransitions({
    kind: 'refused',
    request,
    held: false,
    refusal: refusal('permission-decision-unavailable', 'nobody answered'),
  });
  assert.notEqual(outage?.cause.kind, 'control', "an outage must not wear a decision's clothes");
});

test('every gate transition is accepted by the machine — a cause it refuses is a cause nobody records', () => {
  const outcomes: GateOutcome[] = [
    { kind: 'holding', request },
    { kind: 'deny', request, held: true, message: 'no' },
    { kind: 'allow', request, held: true },
    {
      kind: 'refused',
      request,
      held: true,
      refusal: refusal('permission-decision-unrecognised', 'behavior "escalate"'),
    },
    { kind: 'expired', request, held: true, detail: 'expired' },
  ];

  for (const outcome of outcomes) {
    const recorded = recordGateOutcome(machine(), outcome);
    // The count guard: a kind that returned [] would pass the loop below vacuously and silently
    // stop being covered. Every kind above produces exactly one transition.
    assert.equal(
      recorded.length,
      1,
      `${outcome.kind} produced no transition — this kind left the coverage silently`,
    );
    for (const result of recorded) {
      assert.equal(result.ok, true, `${outcome.kind} produced a transition the machine refused`);
    }
  }
});

// The cross-event window. The gate's same-event reasoning (hold opens only after every
// synchronous prologue) says nothing about a second PreToolUse for the same tool arriving while
// the first call's decision is still outstanding. The invariant holds either way — the tool is
// blocked — so the assertions here are on the emitted transitions: a trace that closes a live hold
// and says the permission "resolved" is lying about the one condition the hold entry exists to show.
test("regression: a second PreToolUse for the same tool cannot close the gate's live hold", () => {
  const live = machine();
  const observer = new SessionObserver(live);

  // Call A (toolu_1) is held: the gate opened its hold entry and the decision is still outstanding.
  recordGateOutcome(live, { kind: 'holding', request });
  assert.equal(
    live.openEntries().some((entry) => entry.activity.kind === 'permission'),
    true,
  );

  // Call B for the same tool arrives before A's decision resolves.
  const recorded = observer.observeHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_use_id: 'toolu_2',
    tool_input: { file_path: '/tmp/y' },
    session_id: 'session-1',
    cwd: '/tmp',
  } as unknown as HookInput);

  const stories = recorded.map((result) => (result.ok ? result.value.cause.detail : ''));
  assert.equal(
    stories.some((detail) => detail.includes('resolved and the tool is running')),
    false,
    'the trace recorded a resolution that has not happened — the decision is still outstanding',
  );
  assert.equal(
    live.openEntries().some((entry) => entry.activity.kind === 'permission'),
    true,
    'the observer closed a hold whose decision is still outstanding — the session no longer reads as held',
  );

  // And when A's decider finally answers, the close it emits is the entry's first exit, not a
  // second exit for an entry the observer already deleted.
  recordGateOutcome(live, { kind: 'deny', request, held: true, message: 'the operator said no' });
  assert.equal(
    live.openEntries().some((entry) => entry.activity.kind === 'permission'),
    false,
  );
});

test('a hold followed by a denial leaves no open entry behind', () => {
  const live = machine();
  recordGateOutcome(live, { kind: 'holding', request });
  assert.deepEqual(
    live.openEntries().map((entry) => entry.entryId),
    ['permission:toolu_1'],
  );
  assert.deepEqual(live.activity, { kind: 'permission', name: 'Write' });

  recordGateOutcome(live, { kind: 'deny', request, held: true, message: 'the operator said no' });
  assert.deepEqual(live.openEntries(), []);
});

test('the raw payload of an unrecognised decision reaches the emitted transition', () => {
  const [transition] = gateTransitions({
    kind: 'refused',
    request,
    held: false,
    refusal: refusal('permission-decision-unrecognised', 'not understood: {"behavior":"escalate","tier":3}'),
  });
  assert.match(transition?.cause.detail ?? '', /"behavior":"escalate"/);
  assert.match(transition?.cause.detail ?? '', /"tier":3/);
});

test('a subagent hold carries the agent id, so the entry says which thread is waiting', () => {
  const [transition] = gateTransitions({
    kind: 'holding',
    request: { ...request, agentId: 'agent-7', agentType: 'general-purpose' },
  });
  assert.equal(transition?.entry?.op, 'open');
  assert.equal(
    transition?.entry !== null && transition.entry.op === 'open' ? transition.entry.agentId : null,
    'agent-7',
  );
});
