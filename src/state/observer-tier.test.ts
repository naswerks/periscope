/**
 * The control tier is a session fact: stated once, on the session's first transition into `ready`,
 * and left out of every other transition. Unit tests over the observer and the machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixedClock, fixedTicker } from '../core/time.js';
import type { HookInput } from '../host/agent-process.js';
import { initMessage } from '../test-support/fake-agent.js';
import type { ControlTier, SessionTransition, TransitionWhere } from './model.js';
import { CONTROL_TIER_LEVELS } from './model.js';
import { SessionStateMachine } from './machine.js';
import type { SessionObserverOptions } from './observer.js';
import { SessionObserver } from './observer.js';

const START_MS = Date.parse('2026-08-03T12:00:00.000Z');
const WHERE: TransitionWhere = { cwd: '/tmp/w', worktree: '/tmp/w', branch: 'main', unknownReason: null };
const TIER: ControlTier = { level: 'intercepted', degrades: [] };

function recorded(options?: SessionObserverOptions): {
  observer: SessionObserver;
  transitions: SessionTransition[];
} {
  const machine = new SessionStateMachine({
    where: WHERE,
    clock: fixedClock(START_MS),
    ticker: fixedTicker(START_MS),
  });
  const observer = new SessionObserver(machine, options);
  const transitions: SessionTransition[] = [];
  machine.onTransition((transition) => transitions.push(transition));
  return { observer, transitions };
}

const preToolUse = {
  hook_event_name: 'PreToolUse',
  session_id: 'agent-1',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 'toolu_1',
} as unknown as HookInput;

/** A session's opening: asked for, prompted, reported, a tool call, the init re-sent, a turn ended. */
function drive(observer: SessionObserver): void {
  observer.created('opened');
  observer.promptSubmitted('a turn');
  observer.observeMessage(initMessage('agent-1'));
  observer.observeHook(preToolUse);
  observer.observeMessage(initMessage('agent-1'));
  observer.observeMessage({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
    uuid: 'state-1',
  } as never);
}

test('the first transition into ready states the tier, and no other transition carries the member', () => {
  const { observer, transitions } = recorded({ controlTier: TIER });
  drive(observer);

  const withTier = transitions.filter((transition) => 'controlTier' in transition);
  assert.equal(withTier.length, 1, `the tier was stated on ${withTier.length} transitions`);
  const [ready] = withTier;
  assert.equal(ready?.to, 'ready');
  assert.equal(ready?.cause.event, 'system/init');
  assert.deepEqual(ready?.controlTier, TIER);

  // The first `ready` is the first transition with the agent's id; nothing before it states a tier.
  const firstReady = transitions.findIndex((transition) => transition.to === 'ready');
  assert.equal(transitions[firstReady], ready, 'the tier is not on the first transition into ready');
  assert.ok(transitions.length >= 5, `the session looks undriven: ${transitions.length} transitions`);
});

test('an observer told no tier states none, and the ready transition is otherwise the same', () => {
  const told = recorded({ controlTier: TIER });
  const untold = recorded();
  drive(told.observer);
  drive(untold.observer);

  assert.ok(untold.transitions.every((transition) => !('controlTier' in transition)));
  const strip = (transition: SessionTransition): Omit<SessionTransition, 'controlTier'> => {
    const { controlTier: _tier, ...rest } = transition;
    return rest;
  };
  assert.deepEqual(told.transitions.map(strip), untold.transitions);
});

test('the machine records a stated tier on that transition only, and never carries it forward', () => {
  const machine = new SessionStateMachine({
    where: WHERE,
    clock: fixedClock(START_MS),
    ticker: fixedTicker(START_MS),
  });
  const stated = machine.record({
    to: 'ready',
    sessionId: 'agent-1',
    controlTier: TIER,
    cause: { kind: 'sdk-message', event: 'system/init', detail: 'reported' },
  });
  const next = machine.record({
    to: 'working',
    cause: { kind: 'hook', event: 'UserPromptSubmit', detail: 'turn' },
  });

  assert.ok(stated.ok && next.ok);
  assert.deepEqual(stated.value.controlTier, TIER);
  assert.equal('controlTier' in next.value, false, 'the tier was carried onto a later transition');
  assert.equal(next.value.sessionId, 'agent-1', 'the agent id still carries forward');
});

test('the tier levels are the four the wire declares, strongest first', () => {
  assert.deepEqual(
    [...CONTROL_TIER_LEVELS],
    ['intercepted', 'intercepted-with-residual', 'cooperative', 'none'],
  );
});
