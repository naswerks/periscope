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

function integerMembers(text: string): Set<string> {
  return new Set([...text.matchAll(INTEGER_MEMBER)].map((match) => match[1] ?? ''));
}

const codec = sourceFiles().find((file) => file.path === 'control/codec.ts')?.text ?? '';

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
