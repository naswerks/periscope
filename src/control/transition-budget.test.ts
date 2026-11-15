import test from 'node:test';
import assert from 'node:assert/strict';

import type { SessionTransition } from '../state/model.js';
import { encode } from './codec.js';
import { MAX_FRAME_BYTES, stateTransitionUpdate } from './frames.js';
import { agentItemBytes } from './item-budget.js';
import { MAX_TRANSITION_BYTES, TRANSITION_DETAIL_CUT, fitTransition } from './transition-budget.js';

const errored = (detail: string): SessionTransition => ({
  sessionId: 'agent-1',
  correlationId: 'handle-1',
  seq: 7,
  at: '2000-01-01T00:00:00.000Z',
  from: 'working',
  to: 'errored',
  activity: null,
  entryId: null,
  cause: { kind: 'process', event: 'process_failed', detail },
  where: { cwd: 'C:/work', worktree: 'C:/work', branch: 'main', unknownReason: null },
});

const framed = (transition: SessionTransition) =>
  encode({
    frame: 'session',
    sessionId: 'handle-1',
    seq: 1,
    at: '2000-01-01T00:00:00.000Z',
    payload: stateTransitionUpdate(transition),
  });

test('a transition that fits is sent as it is', () => {
  const small = errored('the agent exited with code 1');
  assert.equal(fitTransition(small), small);
  const nearly = errored('x'.repeat(40_000));
  assert.equal(fitTransition(nearly), nearly, 'a long detail that fits a frame is not cut');
  assert.ok(framed(nearly).ok);
});

test('a transition whose detail is larger than a frame still arrives: the detail is cut by as much as it is over, and says so', () => {
  const words = `the agent exited: ${'stack line\n'.repeat(30_000)}`;
  const whole = errored(words);
  const unsent = framed(whole);
  assert.equal(unsent.ok, false, 'control: the whole transition is one no frame carries');
  assert.equal(unsent.ok ? null : unsent.refusal.reason, 'frame-too-large');

  const fitted = fitTransition(whole);
  assert.ok(agentItemBytes(fitted) <= MAX_TRANSITION_BYTES);
  const sent = framed(fitted);
  assert.ok(sent.ok, sent.ok ? '' : sent.refusal.detail);
  assert.ok(Buffer.byteLength(sent.ok ? sent.value : '', 'utf8') <= MAX_FRAME_BYTES);
  // Everything but the detail is what it was, and the detail is the beginning of the original.
  assert.deepEqual({ ...fitted, cause: null }, { ...whole, cause: null });
  assert.equal(fitted.cause.kind, 'process');
  assert.equal(fitted.cause.event, 'process_failed');
  assert.ok(fitted.cause.detail.endsWith(TRANSITION_DETAIL_CUT));
  const kept = fitted.cause.detail.slice(0, -TRANSITION_DETAIL_CUT.length);
  assert.ok(words.startsWith(kept), 'the kept words are not the beginning of the original');
  // No more is cut than the budget asks: one more character would not fit.
  const oneMore = {
    ...whole,
    cause: { ...whole.cause, detail: words.slice(0, kept.length + 1) + TRANSITION_DETAIL_CUT },
  };
  assert.ok(agentItemBytes(oneMore) > MAX_TRANSITION_BYTES);
});

test('the cut never ends the detail on half a character', () => {
  // Characters of two code units and four bytes each: the cut lands among them.
  const fitted = fitTransition(errored('\u{1F600}'.repeat(40_000)));
  assert.ok(agentItemBytes(fitted) <= MAX_TRANSITION_BYTES);
  const kept = fitted.cause.detail.slice(0, -TRANSITION_DETAIL_CUT.length);
  assert.equal(kept.length % 2, 0, 'the kept words end inside a pair');
  assert.equal(kept, '\u{1F600}'.repeat(kept.length / 2));
});
