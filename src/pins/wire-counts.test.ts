/**
 * THE INTEGER SPELLING: every count the wire carries is spelled `<member>: z.number().int()` in the codec.
 *
 * A consumer that generates its readers from this package's source finds the members that are whole
 * numbers by that spelling in `control/codec.ts`, and nowhere else: a count written through a shared
 * schema constant (`exitCode: COUNT`) reads to it as a plain number, silently. The codec's own fact
 * comment states the rule; this pin holds the members the item stream and the facts added to it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sourceFiles } from './walk.js';

/** How a reader of the codec's text finds an integer member: its name, a colon, then the integer schema. */
const INTEGER_MEMBER = /(\w+)\s*:\s*z\.number\(\)\.int\(\)/g;

/** The integer members of the item stream and of the facts protocol 16 added. */
const COUNTS = ['exitCode', 'durationMs', 'cacheReadTokens'] as const;

/**
 * The paging members protocol 18 added, each with the kind that carries it. `offset` and `nextOffset`
 * are spelled elsewhere in the codec already (the workspace read), so each is looked for in its own
 * kind's schema, where a reader generating that kind's type finds it.
 */
const PAGING = [
  ['repository_read', 'offset'],
  ['repository_read_result', 'nextOffset'],
] as const;

function integerMembers(text: string): Set<string> {
  return new Set([...text.matchAll(INTEGER_MEMBER)].map((match) => match[1] ?? ''));
}

const codec = sourceFiles().find((file) => file.path === 'control/codec.ts')?.text ?? '';

/** The text of the codec's schema for one payload kind: from its literal to the next object the codec opens. */
function schemaOf(text: string, kind: string): string {
  const start = text.indexOf(`kind: z.literal('${kind}'),`);
  if (start < 0) return '';
  const end = text.indexOf('z.looseObject({', start);
  return text.slice(start, end < 0 ? undefined : end);
}

test('the codec spells every count of the item stream and the added facts as an integer member', () => {
  assert.ok(codec.length > 0, 'the codec was not read');
  const found = integerMembers(codec);
  assert.ok(found.has('seq'), 'the reading finds the codec counts it always had: the walk is real');
  for (const member of COUNTS) assert.ok(found.has(member), `${member} is not spelled as an integer member`);
});

test('control: a count written through a shared schema is not found as an integer member', () => {
  const shared = 'const COUNT = z.number().int().nullable();\nconst s = z.looseObject({ exitCode: COUNT });';
  assert.equal(integerMembers(shared).has('exitCode'), false);
  assert.equal(integerMembers('exitCode: z.number().int().nullable()').has('exitCode'), true);
});

test('the paging protocol 18 added is spelled as an integer member in the schema of the kind that carries it', () => {
  for (const [kind, member] of PAGING) {
    const schema = schemaOf(codec, kind);
    assert.ok(schema.length > 0, `the codec has no ${kind} schema`);
    assert.ok(integerMembers(schema).has(member), `${kind}.${member} is not spelled as an integer member`);
  }
});

test('control: a paging member spelled only in another kind, or through a shared schema, is not found in its own', () => {
  const elsewhere = [
    "kind: z.literal('repository_read'),\n  maxBytes: z.number().int(),\n}),",
    "z.looseObject({\n  kind: z.literal('workspace_read'),\n  offset: z.number().int().nonnegative(),",
  ].join('\n');
  assert.equal(integerMembers(schemaOf(elsewhere, 'repository_read')).has('offset'), false);
  const shared = "kind: z.literal('repository_read_result'),\n  nextOffset: OFFSET,\n}),";
  assert.equal(integerMembers(schemaOf(shared, 'repository_read_result')).has('nextOffset'), false);
  assert.equal(
    schemaOf(elsewhere, 'repository_read_result'),
    '',
    'a kind the text does not hold has no schema',
  );
});
