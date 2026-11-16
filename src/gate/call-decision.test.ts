import test from 'node:test';
import assert from 'node:assert/strict';

import { createCallDecision } from './call-decision.js';
import type { DecisionRequest } from './decision.js';
import type { GateOutcome } from './outcome.js';

const request: DecisionRequest = {
  toolName: 'edit',
  toolUseId: 'call_one',
  toolInput: { filePath: 'a.ts' },
  sessionId: 'session-one',
  sessionKey: 'handle-one',
  cwd: process.platform === 'win32' ? 'C:/work' : '/work',
  agentId: null,
  agentType: null,
  toolKind: 'file_edit',
  runtime: 'opencode',
};

/** A decision nobody answers, aborted once asked with `reason`; the outcome it ends with. */
async function abortedWith(reason?: unknown): Promise<GateOutcome> {
  const outcomes: GateOutcome[] = [];
  let asked: () => void = () => undefined;
  const wasAsked = new Promise<void>((resolve) => {
    asked = resolve;
  });
  const decide = createCallDecision({
    decide: () => {
      asked();
      return new Promise(() => undefined);
    },
    onOutcome: (outcome) => outcomes.push(outcome),
    sessionKey: 'handle-one',
    runtime: 'opencode',
    decisionTimeoutMs: 5_000,
    holdAfterMs: 5_000,
  });
  const controller = new AbortController();
  const decided = decide(request, controller.signal);
  await wasAsked;
  controller.abort(reason);
  const outcome = await decided;
  assert.deepEqual(outcomes, [outcome], 'the outcome is told once');
  return outcome;
}

test('a decision ended with words of its caller is refused with those words', async () => {
  const outcome = await abortedWith(
    'the runtime refused this request together with another of the same session',
  );
  assert.equal(outcome.kind, 'refused');
  assert.equal(outcome.kind === 'refused' ? outcome.refusal.reason : null, 'permission-decision-unavailable');
  assert.equal(
    outcome.kind === 'refused' ? outcome.refusal.detail : null,
    'the runtime refused this request together with another of the same session',
  );
});

test("control: a decision ended with no words, or with a reason that is not words, is refused as the turn's cancellation", async () => {
  for (const reason of [undefined, new Error('an error is not words'), '', 42]) {
    const outcome = await abortedWith(reason);
    assert.equal(
      outcome.kind === 'refused' ? outcome.refusal.reason : null,
      'permission-decision-unavailable',
    );
    assert.equal(
      outcome.kind === 'refused' ? outcome.refusal.detail : null,
      'the turn was cancelled while a decision for edit was outstanding',
      `reason ${String(reason)}`,
    );
  }
});
