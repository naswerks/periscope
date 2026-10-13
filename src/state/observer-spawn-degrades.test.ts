/**
 * The degrades a session is known to carry when it opens join the tier its first `ready` states, once
 * each; after that transition the tier is stated, and a later degrade rides the state lane alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ControlTier, SessionTransition } from './model.js';
import { SessionStateMachine } from './machine.js';
import { SessionObserver } from './observer.js';

const observerAt = (controlTier: ControlTier): SessionObserver =>
  new SessionObserver(
    new SessionStateMachine({
      where: { cwd: 'C:/work', worktree: null, branch: null, unknownReason: 'not read' },
      clock: () => '2026-10-13T00:00:00.000Z',
      ticker: () => 0,
      correlationId: null,
    }),
    { controlTier },
  );

/** Open the session on its thread and return the tier its first `ready` stated. */
function opened(observer: SessionObserver): ControlTier | null | undefined {
  observer.created('opened');
  observer.observeCodexMessage({
    kind: 'answer',
    method: 'thread/start',
    params: {},
    result: { thread: { id: 'thread-1' } },
  });
  const recorded = observer.observeCodexMessage({
    kind: 'notification',
    method: 'thread/started',
    params: { thread: { id: 'thread-1', cliVersion: '0.162.1' } },
  });
  const ready = recorded
    .flatMap((result) => (result.ok ? [result.value] : []))
    .find((one: SessionTransition) => one.to === 'ready');
  assert.ok(ready !== undefined, 'the session never reached ready');
  return ready.controlTier;
}

test('degrades stated before the first ready join its tier, each once, in order', () => {
  const observer = observerAt({ level: 'intercepted-with-residual', degrades: [] });
  observer.stateSpawnDegrades(['gate-hook-foreign', 'gate-sandbox-absent']);
  observer.stateSpawnDegrades(['gate-sandbox-absent']);
  assert.deepEqual(opened(observer), {
    level: 'intercepted-with-residual',
    degrades: ['gate-hook-foreign', 'gate-sandbox-absent'],
  });
});

test('control: with nothing stated the first ready states the runtime tier as it is', () => {
  assert.deepEqual(opened(observerAt({ level: 'intercepted-with-residual', degrades: [] })), {
    level: 'intercepted-with-residual',
    degrades: [],
  });
});
