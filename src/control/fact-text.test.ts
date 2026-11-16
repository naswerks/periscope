import test from 'node:test';
import assert from 'node:assert/strict';

import { decode } from './codec.js';
import { cutText, factText } from './fact-text.js';
import { MAX_FACT_TEXT_LENGTH } from './frames.js';

/** Whether `text` holds a surrogate with no partner beside it. */
function loneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

test('a text within the bound is returned as it is, and one past it is cut to the bound', () => {
  const within = 'x'.repeat(MAX_FACT_TEXT_LENGTH);
  assert.equal(factText(within), within);
  const cut = factText('x'.repeat(MAX_FACT_TEXT_LENGTH + 5));
  assert.equal(cut.length, MAX_FACT_TEXT_LENGTH);
});

test('control: a cut that would split a surrogate pair stops before it, where a plain slice leaves half of one', () => {
  // The bound's last unit opens a pair: a plain slice keeps that half alone.
  const text = `${'x'.repeat(MAX_FACT_TEXT_LENGTH - 1)}\u{20000}tail`;
  const sliced = text.slice(0, MAX_FACT_TEXT_LENGTH);
  assert.equal(loneSurrogate(sliced), true, 'the plain slice this helper replaces splits the pair');
  const cut = factText(text);
  assert.equal(cut.length, MAX_FACT_TEXT_LENGTH - 1);
  assert.equal(loneSurrogate(cut), false);
});

test('what the helper cuts decodes: a fact carrying it is within the bound the codec reads', () => {
  const summary = factText(`${'x'.repeat(MAX_FACT_TEXT_LENGTH - 1)}\u{20000}${'y'.repeat(50)}`);
  const wire = JSON.stringify({
    frame: 'session',
    sessionId: 's-1',
    seq: 1,
    at: '2000-01-01T00:00:00.000Z',
    payload: {
      kind: 'session_update',
      body: {
        update: 'agent_facts',
        fact: {
          kind: 'tasks',
          runtime: 'claude',
          running: [{ taskId: 't-1', type: 'local_agent', summary }],
        },
        sourceId: null,
      },
    },
  });
  const decoded = decode(wire);
  assert.ok(decoded.ok, decoded.ok ? '' : decoded.refusal.detail);
});

test('a text is cut to any length asked, on a code point, and a length of none leaves nothing', () => {
  assert.equal(cutText('abcdef', 4), 'abcd');
  assert.equal(cutText('abc', 4), 'abc');
  assert.equal(cutText('ab\u{20000}cd', 3), 'ab', 'the pair that would be split is left out whole');
  assert.equal(cutText('ab\u{20000}cd', 4), 'ab\u{20000}');
  assert.equal(cutText('abc', 0), '');
});
