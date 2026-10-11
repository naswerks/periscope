/**
 * The transcript scrubber: what it keeps, what it drops, and that its check sees what it dropped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TranscriptScrubber, scrubViolations } from './transcript-scrub.js';

/** A word list standing in for a repository's own vocabulary, which no scrubbed line may carry. */
const FORBIDDEN = /\b(alpha|bravo)\b/i;

type Json = Parameters<TranscriptScrubber['scrub']>[0];

const SECRET = 'sk-test-abcdef0123456789';

const assistant: Json = {
  type: 'assistant',
  uuid: 'uuid-1',
  session_id: 'session-1',
  parent_tool_use_id: null,
  message: {
    id: 'msg_1',
    model: 'model-id-1',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Reading /home/someone/project/notes.md now.' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: `curl -H "Authorization: Bearer ${SECRET}"`, alphaId: 7, timeout: 120000 },
      },
    ],
    usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 9 },
  },
};

const toolResult: Json = {
  type: 'user',
  uuid: 'uuid-2',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: SECRET }] }],
  },
  tool_use_result: { stdout: 'C:\\Users\\someone\\secret.txt', bravoVerdict: 'kept', exitCode: 0 },
};

function strings(value: Json): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
}

function numbers(value: Json): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbers);
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(numbers);
}

test('control: no path, secret, prose or tool-defined name survives, and every SDK name and number does', () => {
  const scrubber = new TranscriptScrubber();
  const scrubbed = [scrubber.scrub(assistant), scrubber.scrub(toolResult)];
  const text = strings(scrubbed).join('\n');

  for (const planted of [
    '/home/someone',
    'notes.md',
    SECRET,
    'C:\\Users',
    'Reading',
    'alphaId',
    'bravoVerdict',
    'Bash',
  ]) {
    assert.ok(!text.includes(planted), `"${planted}" survived the scrub`);
  }
  assert.deepEqual(
    numbers(scrubbed),
    [...numbers(assistant), ...numbers(toolResult)],
    'every number, in order',
  );

  const message = (scrubbed[0] as { message: Record<string, unknown> }).message;
  assert.deepEqual(Object.keys(message), ['id', 'model', 'role', 'content', 'usage'], 'the SDK names stay');
  assert.equal(message['model'], 'model-id-1', 'a kept member keeps its value');
  assert.equal(message['id'], 'msg_1');
  assert.deepEqual(message['usage'], (assistant as { message: { usage: unknown } }).message.usage);

  const input = ((message['content'] as Record<string, unknown>[])[1] as { input: Record<string, unknown> })
    .input;
  assert.deepEqual(Object.keys(input), ['key-1', 'key-2', 'key-3'], "a tool's own names are placeholders");
  assert.deepEqual(Object.values(input).slice(1), [7, 120000], 'and its numbers survive');
});

test('one string at one member is one placeholder across the whole transcript, and two strings are two', () => {
  const scrubber = new TranscriptScrubber();
  const first = scrubber.scrub({ skills: ['one', 'two'], cwd: '/work' }) as Record<string, unknown>;
  const second = scrubber.scrub({ skills: ['two', 'three'], cwd: '/work' }) as Record<string, unknown>;
  assert.deepEqual(first['skills'], ['skills-1', 'skills-2']);
  assert.deepEqual(second['skills'], ['skills-2', 'skills-3']);
  assert.equal(first['cwd'], second['cwd'], 'equal stays equal, so a comparison answers the same');
});

test('control: the shape check passes a scrubbed line and names every raw value in an unscrubbed one', () => {
  const scrubber = new TranscriptScrubber();
  assert.deepEqual(scrubViolations(scrubber.scrub(assistant), FORBIDDEN), []);
  assert.deepEqual(scrubViolations(scrubber.scrub(toolResult), FORBIDDEN), []);

  const raw = scrubViolations(assistant, FORBIDDEN);
  assert.ok(
    raw.some((one) => one.includes('/home/someone')),
    raw.join('\n'),
  );
  assert.ok(
    raw.some((one) => one.includes('alphaId')),
    'a payload name that is not a placeholder',
  );

  const pathInKept = scrubViolations({ type: 'system', model: '/opt/models/one' }, FORBIDDEN);
  assert.equal(pathInKept.length, 1, 'a kept member may not carry a path');
  const forbiddenName = scrubViolations({ type: 'system', bravoCount: 1 }, FORBIDDEN);
  assert.equal(forbiddenName.length, 1, 'a member name may not carry a forbidden word');
});
