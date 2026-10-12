/**
 * The codec over the fact layer's bodies: which members it checks, and that it checks nothing else.
 * The byte-level cases are vectors (`pins/wire-vectors.test.ts`); these state the rules one member at
 * a time, each beside its twin that passes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decode, encode } from './codec.js';
import type { AgentFact, Frame } from './frames.js';
import { agentFactsUpdate } from './frames.js';

const AT = '2000-01-01T00:00:00.000Z';

const wireOf = (body: Record<string, unknown>, kind = 'session_update'): string =>
  JSON.stringify({ frame: 'session', sessionId: 'session-1', seq: 1, at: AT, payload: { kind, body } });

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'm',
  canonicalModel: null,
  provider: null,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 1,
  cacheWriteTokens: 1,
  reasoningTokens: 1,
  cost: 0.5,
  costBasis: 'list',
  contextWindow: 1000,
  ...over,
});

/** A fact body carrying `value` at one count member, for each of the eleven counts. */
const COUNTS: Record<string, (value: number) => Record<string, unknown>> = {
  inputTokens: (value) => turnRecord({ inputTokens: value }),
  outputTokens: (value) => turnRecord({ outputTokens: value }),
  cacheReadTokens: (value) => turnRecord({ cacheReadTokens: value }),
  cacheWriteTokens: (value) => turnRecord({ cacheWriteTokens: value }),
  reasoningTokens: (value) => turnRecord({ reasoningTokens: value }),
  contextWindow: (value) => turnRecord({ contextWindow: value }),
  numTurns: (value) => ({ ...turnRecord(), numTurns: value }),
  durationMs: (value) => ({ ...turnRecord(), durationMs: value }),
  contextTokens: (value) => ({
    kind: 'usage_sample',
    runtime: 'claude',
    contextTokens: value,
    mainThread: true,
  }),
  tokensBefore: (value) => ({ kind: 'compaction', runtime: 'claude', status: 'ended', tokensBefore: value }),
  tokensAfter: (value) => ({ kind: 'compaction', runtime: 'claude', status: 'ended', tokensAfter: value }),
};

function turnRecord(rowOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'turn_record',
    runtime: 'claude',
    totals: { cost: 1, currency: 'USD', costBasis: 'list', byModel: [row(rowOver)] },
    turn: null,
    turnScope: null,
    numTurns: 1,
    durationMs: 1,
    sourceSessionId: 's',
  };
}

const factWire = (fact: Record<string, unknown>): string =>
  wireOf({ update: 'agent_facts', fact, sourceId: 'm-1' });

test('control: every count is a whole number on the wire, refused at 1.5 and at -1, read at 2', () => {
  assert.equal(Object.keys(COUNTS).length, 11);
  for (const [member, carrying] of Object.entries(COUNTS)) {
    assert.ok(decode(factWire(carrying(2))).ok, `${member}: 2 is a count`);
    const fractional = decode(factWire(carrying(1.5)));
    assert.equal(fractional.ok ? 'decoded' : fractional.refusal.reason, 'frame-malformed', `${member}: 1.5`);
    const negative = decode(factWire(carrying(-1)));
    assert.equal(negative.ok ? 'decoded' : negative.refusal.reason, 'frame-malformed', `${member}: -1`);
  }
});

test('a cost is any non-negative number, a fraction included', () => {
  assert.ok(decode(factWire(turnRecord({ cost: 0.034567 }))).ok);
  assert.equal(decode(factWire(turnRecord({ cost: -0.5 }))).ok, false);
});

test('control: a word this host does not declare is read on the way in and refused on the way out', () => {
  const unknownBasis = {
    ...turnRecord(),
    totals: { cost: 1, currency: 'USD', costBasis: 'from-a-newer-peer', byModel: [] },
  };
  assert.ok(decode(factWire(unknownBasis)).ok, 'read: a newer peer may name a basis this build does not');

  const outgoing = (fact: Record<string, unknown>): Frame => ({
    frame: 'session',
    sessionId: 'session-1',
    seq: 1,
    at: AT,
    payload: agentFactsUpdate(fact as unknown as AgentFact, 'm-1'),
  });
  const refused = encode(outgoing(unknownBasis));
  assert.equal(refused.ok ? 'encoded' : refused.refusal.reason, 'frame-malformed');
  assert.match(refused.ok ? '' : refused.refusal.detail, /fact\.totals\.costBasis "from-a-newer-peer"/);
  assert.ok(encode(outgoing(turnRecord())).ok, 'the same fact with a declared basis encodes');
});

test('an older peer that omits every new member is read, and so is a fact whose members are unstated', () => {
  assert.ok(
    decode(wireOf({ update: 'agent_message', message: { type: 'result' } })).ok,
    'no runtime, no instant',
  );
  assert.ok(decode(factWire({ kind: 'tasks' })).ok, 'a fact that states only its kind');
  assert.ok(decode(wireOf({ update: 'agent_facts', fact: { kind: 'session_handle' } })).ok, 'no sourceId');
});

test('only the bodies the fact layer added are checked; every other body stays open JSON', () => {
  assert.ok(decode(wireOf({ update: 'state_transition', transition: 'not even an object' })).ok);
  assert.ok(decode(wireOf({ update: 'a-body-from-a-newer-peer', numTurns: 1.5 })).ok);
  assert.ok(decode(wireOf({ update: 'agent_fragment', text: 5 })).ok, 'a fragment rides the delta lane only');
  assert.equal(decode(wireOf({ update: 'agent_fragment', text: 5 }, 'session_delta')).ok, false);
  assert.equal(
    decode(wireOf({ update: 'agent_message', message: {}, runtime: 7 })).ok,
    false,
    'runtime is text',
  );
});
