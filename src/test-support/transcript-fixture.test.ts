/**
 * The committed recording is in scrubbed shape, and stays so: every string in it is a placeholder or
 * a kept value, and no kept value or member name holds a path. A line added by hand from a raw
 * transcript fails here before it can ship a prompt, a path or a secret into the repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { scrubViolations } from './transcript-scrub.js';

const RECORDING = fileURLToPath(
  new URL('../../src/test-support/fixtures/session.34.frames.jsonl', import.meta.url),
);

/** What no kept value or member name may read like: a drive, or a user's home. */
const PATH_LIKE = /^[A-Za-z]:|\b(?:home|Users)\b/i;

type Json = Parameters<typeof scrubViolations>[0];

function violationsIn(lines: readonly string[]): string[] {
  return lines.flatMap((line, index) =>
    scrubViolations(JSON.parse(line) as Json, PATH_LIKE).map((found) => `line ${index + 1}: ${found}`),
  );
}

const lines = readFileSync(RECORDING, 'utf8')
  .split('\n')
  .filter((line) => line !== '');

test('every line of the committed recording is in scrubbed shape', () => {
  assert.equal(lines.length, 703, 'the recording is whole');
  assert.deepEqual(violationsIn(lines), []);
});

test('control: a line carrying a raw path, a prompt or a tool-defined name fails the shape check', () => {
  const planted = [
    ...lines,
    JSON.stringify({ type: 'system', subtype: 'init', cwd: 'C:\\work\\repository', uuid: 'planted-1' }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'planted-2',
      message: { content: [{ type: 'tool_use', id: 't', input: { command: 'cat /etc/hosts' } }] },
    }),
  ];
  const found = violationsIn(planted);
  assert.ok(
    found.some((one) => one.startsWith('line 704:') && one.includes('C:\\work')),
    found.join('\n'),
  );
  assert.ok(
    found.some((one) => one.startsWith('line 705:') && one.includes('command')),
    found.join('\n'),
  );
});
