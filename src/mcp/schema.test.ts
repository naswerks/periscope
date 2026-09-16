/**
 * The JSON-Schema to Zod conversion, and the refusal that keeps validation honest.
 *
 * The tests that matter most here are the refusals. A converter that widened an unrecognised
 * construct instead of refusing it would register the tool, validate nothing, and pass every
 * positive test in this file — so the negative half is not the edge cases, it is the property.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { toRawShape, toZod } from './schema.js';
import type { JsonSchemaObject } from './descriptor.js';

/** Round-trip a value through the converted shape, the way the SDK will. */
function parse(schema: JsonSchemaObject, value: unknown): { ok: boolean; data?: unknown } {
  const shape = toRawShape(schema);
  assert.equal(shape.ok, true, shape.ok ? '' : shape.refusal.detail);
  if (!shape.ok) return { ok: false };
  const result = z.object(shape.value).safeParse(value);
  return { ok: result.success, ...(result.success ? { data: result.data } : {}) };
}

// ---------------------------------------------------------------------------
// The supported subset.
// ---------------------------------------------------------------------------

test('a string property converts and accepts a string', () => {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: { note: { type: 'string' } },
    required: ['note'],
  };
  assert.equal(parse(schema, { note: 'hello' }).ok, true);
  assert.equal(parse(schema, { note: 42 }).ok, false);
});

test('boolean, number and integer each convert to their own type', () => {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: { flag: { type: 'boolean' }, ratio: { type: 'number' }, count: { type: 'integer' } },
    required: ['flag', 'ratio', 'count'],
  };
  assert.equal(parse(schema, { flag: true, ratio: 1.5, count: 3 }).ok, true);
  assert.equal(parse(schema, { flag: 'yes', ratio: 1.5, count: 3 }).ok, false);
});

// `integer` is not `number` — an emitter that says integer means it, and a converter that collapsed
// the two would silently accept 1.5 where a count was required.
test('regression: integer rejects a fractional value, so it is not merely number under another name', () => {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: { count: { type: 'integer' } },
    required: ['count'],
  };
  assert.equal(parse(schema, { count: 3 }).ok, true);
  assert.equal(
    parse(schema, { count: 3.5 }).ok,
    false,
    'integer accepted a fraction — it was converted as a number',
  );
});

test('an array converts with its item schema enforced', () => {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: { tags: { type: 'array', items: { type: 'string' } } },
    required: ['tags'],
  };
  assert.equal(parse(schema, { tags: ['a', 'b'] }).ok, true);
  assert.equal(parse(schema, { tags: ['a', 2] }).ok, false, 'the item schema was not applied');
  assert.equal(parse(schema, { tags: 'a' }).ok, false);
});

test('a nested object converts, with its own required set', () => {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: {
      target: {
        type: 'object',
        properties: { id: { type: 'string' }, depth: { type: 'integer' } },
        required: ['id'],
      },
    },
    required: ['target'],
  };
  assert.equal(parse(schema, { target: { id: 'x' } }).ok, true);
  assert.equal(
    parse(schema, { target: { depth: 1 } }).ok,
    false,
    'a nested required property was not enforced',
  );
});

test('an enum accepts only its members', () => {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: { mode: { enum: ['fast', 'slow'] } },
    required: ['mode'],
  };
  assert.equal(parse(schema, { mode: 'fast' }).ok, true);
  assert.equal(parse(schema, { mode: 'sideways' }).ok, false);
});

test('a mixed-primitive enum converts, including null', () => {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: { level: { enum: [1, 'high', true, null] } },
    required: ['level'],
  };
  for (const value of [1, 'high', true, null]) {
    assert.equal(parse(schema, { level: value }).ok, true, `${JSON.stringify(value)} was rejected`);
  }
  assert.equal(parse(schema, { level: 'low' }).ok, false);
});

test('a single-member enum converts to that literal', () => {
  const schema: JsonSchemaObject = { type: 'object', properties: { v: { enum: ['only'] } }, required: ['v'] };
  assert.equal(parse(schema, { v: 'only' }).ok, true);
  assert.equal(parse(schema, { v: 'other' }).ok, false);
});

// ---------------------------------------------------------------------------
// Optionality — the direction of this default decides whether ordinary calls work at all.
// ---------------------------------------------------------------------------

test('regression: a property is optional unless required names it, as JSON Schema says', () => {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: { must: { type: 'string' }, may: { type: 'string' } },
    required: ['must'],
  };

  assert.equal(
    parse(schema, { must: 'here' }).ok,
    true,
    'an omitted optional property was treated as required',
  );
  assert.equal(parse(schema, { may: 'here' }).ok, false, 'an omitted REQUIRED property was accepted');
  assert.equal(parse(schema, { must: 'a', may: 'b' }).ok, true);
});

test('a schema with no required list makes everything optional', () => {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'integer' } },
  };
  assert.equal(parse(schema, {}).ok, true);
  assert.equal(parse(schema, { a: 'x' }).ok, true);
  assert.equal(parse(schema, { a: 1 }).ok, false, 'a present optional property skipped its type check');
});

test('nullable admits null without making the property optional', () => {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: { note: { type: 'string', nullable: true } },
    required: ['note'],
  };
  assert.equal(parse(schema, { note: null }).ok, true);
  assert.equal(parse(schema, { note: 'x' }).ok, true);
  assert.equal(parse(schema, {}).ok, false, 'nullable was read as optional — they are different claims');
});

test('a tool that takes no arguments converts to an empty shape rather than being refused', () => {
  for (const schema of [
    { type: 'object' } as JsonSchemaObject,
    { type: 'object', properties: {} } as JsonSchemaObject,
  ]) {
    const shape = toRawShape(schema);
    assert.equal(shape.ok, true);
    assert.deepEqual(shape.ok ? Object.keys(shape.value) : null, []);
  }
});

test('a description is carried onto the converted schema, because the model reads it', () => {
  const converted = toZod({ type: 'string', description: 'the note to record' }, 'x');
  assert.equal(converted.ok, true);
  assert.equal(converted.ok ? converted.value.description : null, 'the note to record');
});

// ---------------------------------------------------------------------------
// The refusals. Each one is a hole a permissive fallback would have left open silently.
// ---------------------------------------------------------------------------

test('regression: an unknown type is refused, never widened to accept anything', () => {
  const result = toRawShape({ type: 'object', properties: { odd: { type: 'quaternion' } } });

  assert.equal(result.ok, false, 'an unrecognised type was converted — that tool now validates nothing');
  assert.equal(!result.ok && result.refusal.reason, 'mcp-schema-unsupported');
  assert.match(!result.ok ? result.refusal.detail : '', /quaternion/);
  // The message names where it was, so a controller author can find it in their own descriptor.
  assert.match(!result.ok ? result.refusal.detail : '', /properties\.odd/);
});

test('regression: a property with no type is refused — "anything" is the hole, not a convenience', () => {
  const result = toRawShape({ type: 'object', properties: { free: { description: 'whatever' } } });

  assert.equal(result.ok, false, 'a typeless property was accepted, so any value satisfies it');
  assert.equal(!result.ok && result.refusal.reason, 'mcp-schema-unsupported');
});

test('regression: an array with no items schema is refused — its elements would go unchecked', () => {
  const result = toRawShape({ type: 'object', properties: { list: { type: 'array' } } });

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.reason, 'mcp-schema-unsupported');
  assert.match(!result.ok ? result.refusal.detail : '', /items/);
});

test('regression: an object with no properties is refused — any object would satisfy it', () => {
  const result = toRawShape({ type: 'object', properties: { blob: { type: 'object' } } });

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.reason, 'mcp-schema-unsupported');
});

test('an unsupported type NESTED inside an array or object is still refused', () => {
  const inArray = toRawShape({
    type: 'object',
    properties: { xs: { type: 'array', items: { type: 'date' } } },
  });
  assert.equal(inArray.ok, false, 'the refusal did not recurse into array items');
  assert.match(!inArray.ok ? inArray.refusal.detail : '', /items/);

  const inObject = toRawShape({
    type: 'object',
    properties: { o: { type: 'object', properties: { when: { type: 'date' } } } },
  });
  assert.equal(inObject.ok, false, 'the refusal did not recurse into object properties');
  assert.match(!inObject.ok ? inObject.refusal.detail : '', /properties\.o\.properties\.when/);
});

test('a required name with no matching property is refused rather than silently dropped', () => {
  const result = toRawShape({
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a', 'ghost'],
  });

  assert.equal(result.ok, false, 'a required property that does not exist was ignored — nothing enforces it');
  assert.match(!result.ok ? result.refusal.detail : '', /ghost/);
});

test('a non-object top-level schema is refused, because arguments are always named', () => {
  for (const type of ['string', 'array', 'integer']) {
    const result = toRawShape({ type } as unknown as JsonSchemaObject);
    assert.equal(result.ok, false, `a top-level ${type} was accepted`);
    assert.equal(!result.ok && result.refusal.reason, 'mcp-schema-unsupported');
  }
});

test('an empty enum is refused — no value could satisfy it', () => {
  const result = toRawShape({ type: 'object', properties: { v: { enum: [] } } });
  assert.equal(result.ok, false);
});

test('an enum carrying a non-primitive is refused rather than half-converted', () => {
  const result = toRawShape({
    type: 'object',
    properties: { v: { enum: ['ok', { nested: true }] as never } },
  });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.refusal.detail : '', /non-primitive/);
});

test('a non-object where a schema node belongs is refused, not coerced', () => {
  for (const bad of [null, 'string', 42, ['a']]) {
    const result = toRawShape({ type: 'object', properties: { x: bad as never } });
    assert.equal(result.ok, false, `${JSON.stringify(bad)} was accepted as a schema node`);
  }
});

// The refusal must beat the conversion on the FIRST bad property, not report only the last — a
// converter that kept going would produce a shape and a refusal, and callers read one of them.
test('the first unconvertible property decides, and no shape is returned alongside a refusal', () => {
  const result = toRawShape({
    type: 'object',
    properties: { good: { type: 'string' }, bad: { type: 'nonsense' }, alsoBad: { type: 'rubbish' } },
  });

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.refusal.detail : '', /nonsense/);
  assert.doesNotMatch(!result.ok ? result.refusal.detail : '', /rubbish/);
});

// ---------------------------------------------------------------------------
// The consequence, asserted directly. Removing all four refusals at once turns the refusal tests
// above red, but every one of them asserts the refusal: that `toRawShape` returns `ok: false`. None
// asserts the thing the refusal is for — that no tool ends up with a schema which accepts anything
// at all. A test set that only checks the guard, never the property behind it, would let a later
// "simplification" swap a refusal for a permissive fallback and re-word the four tests to match.
// ---------------------------------------------------------------------------

/** Values spanning every JSON kind. A schema accepting all of these validates nothing. */
const PROBES: unknown[] = ['text', 42, true, null, { nested: 1 }, ['a'], 3.5, ''];

test('regression: no descriptor can yield a property schema that accepts every kind of value', () => {
  // Each of these is a construct whose literal JSON-Schema meaning is "anything", which is exactly
  // what a permissive fallback would produce. The host may refuse them — that is the shipped
  // behaviour — but it may never convert one into a schema that checks nothing.
  const holes = [
    { description: 'no type at all' },
    { type: 'quaternion' },
    { type: 'array' },
    { type: 'object' },
    { type: 'object', properties: {} },
  ];

  let converted = 0;
  for (const hole of holes) {
    const shape = toRawShape({ type: 'object', properties: { v: hole }, required: ['v'] });
    if (!shape.ok) continue; // refused outright — the strongest possible answer
    converted += 1;

    const schema = z.object(shape.value);
    const accepted = PROBES.filter((probe) => schema.safeParse({ v: probe }).success);
    assert.notEqual(
      accepted.length,
      PROBES.length,
      `${JSON.stringify(hole)} converted to a schema that accepts every value — that tool validates nothing, ` +
        'and a malformed call would reach the controller unchecked',
    );
  }

  // Reported rather than asserted: today every hole is refused, so this is zero. If a later change
  // makes one convertible, the assertion above is what has to hold for it.
  assert.ok(converted >= 0);
});

// The same property one level in. A probe at the outer position (`{v: probe}`) is vacuous: under a
// permissive fallback it still passes, because `z.array(z.unknown())` rejects a string for being
// not-an-array and `z.object({inner: unknown})` rejects one for being not-an-object. The wrapper
// keeps the test green while the thing it claims to guard — the element, the inner property — goes
// completely unvalidated. So the probe goes where the hole actually is.
test('regression: a permissive fallback inside an array or object is caught where the hole is', () => {
  const cases = [
    { schema: { type: 'array', items: { type: 'mystery' } }, wrap: (probe: unknown) => [probe] },
    {
      schema: { type: 'object', properties: { inner: {} }, required: ['inner'] },
      wrap: (probe: unknown) => ({ inner: probe }),
    },
  ];

  for (const { schema: nested, wrap } of cases) {
    const shape = toRawShape({ type: 'object', properties: { v: nested }, required: ['v'] });
    if (!shape.ok) continue; // refused outright — the strongest possible answer

    const built = z.object(shape.value);
    const accepted = PROBES.filter((probe) => built.safeParse({ v: wrap(probe) }).success);
    assert.notEqual(
      accepted.length,
      PROBES.length,
      `${JSON.stringify(nested)} accepts every value in its inner position — the elements go unchecked`,
    );
  }
});

// ---------------------------------------------------------------------------
// The control: this file's own helper must be able to report a failure.
// ---------------------------------------------------------------------------

test('the parse helper actually reports rejection, so the negative cases are not vacuous', () => {
  const schema: JsonSchemaObject = { type: 'object', properties: { n: { type: 'string' } }, required: ['n'] };
  assert.equal(parse(schema, { n: 'x' }).ok, true);
  assert.equal(parse(schema, { n: 1 }).ok, false);
  assert.equal(parse(schema, {}).ok, false);
});
