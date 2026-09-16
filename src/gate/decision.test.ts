import test from 'node:test';
import assert from 'node:assert/strict';

import { describeRaw, readDecision } from './decision.js';

test('an allow is read as an allow, with and without rewritten arguments', () => {
  assert.deepEqual(readDecision({ behavior: 'allow' }), {
    recognised: true,
    decision: { behavior: 'allow' },
  });
  assert.deepEqual(readDecision({ behavior: 'allow', updatedInput: { file_path: '/tmp/x' } }), {
    recognised: true,
    decision: { behavior: 'allow', updatedInput: { file_path: '/tmp/x' } },
  });
});

test('a deny is read as a deny and keeps the message the model will be shown', () => {
  assert.deepEqual(readDecision({ behavior: 'deny', message: 'writes are not permitted here' }), {
    recognised: true,
    decision: { behavior: 'deny', message: 'writes are not permitted here' },
  });
  assert.deepEqual(readDecision({ behavior: 'deny', message: 'stop', interrupt: true }), {
    recognised: true,
    decision: { behavior: 'deny', message: 'stop', interrupt: true },
  });
});

// The unknown-decision rule. A value this build has never seen is never an allow, whatever it
// looks like — a controller running ahead of a host, a decision tier added later, a rolled-back
// deploy. Every one of these must come back unrecognised, and each is a shape someone could
// plausibly send.
test('a decision this build has never seen is never read as an allow', () => {
  const strangers: unknown[] = [
    { behavior: 'escalate' },
    { behavior: 'ask' },
    { behavior: 'defer' },
    { behavior: 'allow_once' },
    { behavior: 'ALLOW' },
    { outcome: 'allow' },
    { allow: true },
    { allow: true, reason: 'the docs page shape, which does not exist' },
    { behavior: 'deny' },
    { behavior: 'deny', message: '' },
    { behavior: 'deny', message: 42 },
    { behavior: 'deny', message: 'no', interrupt: 'yes' },
    { behavior: 'allow', updatedInput: 'not an object' },
    { behavior: 'allow', updatedInput: ['not', 'an', 'object'] },
    {},
    [],
    null,
    undefined,
    'allow',
    true,
    7,
  ];

  for (const stranger of strangers) {
    const reading = readDecision(stranger);
    assert.equal(reading.recognised, false, `${describeRaw(stranger)} was read as a decision`);
  }
});

// The reading is only useful if the payload survives it: a host that drops what it did not
// understand makes a controller-side bug invisible on the only side that could have seen it.
test('an unrecognised decision carries its raw payload out intact', () => {
  const reading = readDecision({ behavior: 'escalate', tier: 3, requestId: 'abc-123' });
  assert.equal(reading.recognised, false);
  assert.ok(reading.recognised === false && reading.raw.includes('escalate'));
  assert.ok(reading.recognised === false && reading.raw.includes('abc-123'));
});

test('a raw payload is bounded and marked, so a huge one cannot ride into the trace whole', () => {
  const huge = readDecision({ behavior: 'escalate', pad: 'x'.repeat(5000) });
  assert.equal(huge.recognised, false);
  assert.ok(huge.recognised === false && huge.raw.endsWith('…[truncated]'));
  assert.ok(huge.recognised === false && huge.raw.length < 600);
});

test('describing a raw payload never throws, because evidence about a broken value is still evidence', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;

  // A cycle makes JSON.stringify throw, so the type is all that survives — and it is still more
  // than a dropped field.
  assert.equal(describeRaw(cyclic), '[unserialisable object]');

  // A function makes JSON.stringify return `undefined` rather than throw, so the String() fallback
  // carries the source text. Different mechanism, same rule: nothing is silently dropped.
  assert.equal(describeRaw(undefined), 'undefined');
  assert.match(
    describeRaw(() => undefined),
    /undefined/,
  );
  assert.equal(describeRaw(Symbol('odd')).length > 0, true);
  assert.equal(describeRaw(123n).length > 0, true);
});

// Guards the selector, not the rule: if `readDecision` returned `recognised: false` for everything
// — a typo in the behavior literal, an early return — the assertion above would pass while proving
// only that the function is broken.
test('the reader actually recognises the two decisions it is supposed to', () => {
  assert.equal(readDecision({ behavior: 'allow' }).recognised, true);
  assert.equal(readDecision({ behavior: 'deny', message: 'x' }).recognised, true);
});
