/**
 * A text or a word a fact carries is cut to the wire's bound with the cut that never splits a surrogate
 * pair (`cutText`). A plain slice at the bound can end on half a character, which the fact then carries.
 * No module that fills a fact or an item cuts at a wire bound with a plain slice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sourceFiles } from './walk.js';

/** A plain slice to one of the wire's text bounds. */
const PLAIN_CUT = /\.slice\(\s*0\s*,\s*MAX_(FACT|ITEM)_[A-Z_]*LENGTH\s*\)/;

test('no module cuts a text to a wire bound with a plain slice', () => {
  const found: string[] = [];
  for (const file of sourceFiles()) {
    file.text.split('\n').forEach((line, index) => {
      if (PLAIN_CUT.test(line)) found.push(`${file.path}:${index + 1}`);
    });
  }
  assert.deepEqual(found, [], `a text is cut where a character pair can be split:\n  ${found.join('\n  ')}`);
});

test('control: the pattern finds a plain cut at a bound, and not the cut that keeps a pair whole', () => {
  assert.match('  return value.slice(0, MAX_FACT_TEXT_LENGTH);', PLAIN_CUT);
  assert.match(
    'value.length <= MAX_FACT_WORD_LENGTH ? value : value.slice(0, MAX_FACT_WORD_LENGTH)',
    PLAIN_CUT,
  );
  assert.doesNotMatch('  return cutText(value, MAX_FACT_TEXT_LENGTH);', PLAIN_CUT);
  assert.doesNotMatch('  return list.slice(0, MAX_FACT_LIST_ENTRIES);', PLAIN_CUT);
});
