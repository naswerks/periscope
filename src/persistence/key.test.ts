import test from 'node:test';
import assert from 'node:assert/strict';

import { sameTranscript, transcriptKey, transcriptToken } from './key.js';

test('a key carries the project, the session and no subpath for a main transcript', () => {
  const key = transcriptKey('tenant-a', 'sess-1');
  assert.equal(key.ok, true);
  assert.deepEqual(key.ok && key.value, { projectKey: 'tenant-a', sessionId: 'sess-1' });
});

test('the main transcript omits subpath rather than carrying an undefined one', () => {
  const key = transcriptKey('tenant-a', 'sess-1');
  assert.equal(key.ok && Object.prototype.hasOwnProperty.call(key.value, 'subpath'), false);
});

test("a subagent's transcript is addressed by subpath", () => {
  const key = transcriptKey('tenant-a', 'sess-1', 'subagents/agent-7');
  assert.deepEqual(key.ok && key.value, {
    projectKey: 'tenant-a',
    sessionId: 'sess-1',
    subpath: 'subagents/agent-7',
  });
});

test('regression: a present but empty subpath is refused, never coerced to the main transcript', () => {
  // Coercing would answer a question about a subagent with the main transcript's contents — a wrong
  // answer wearing a right answer's shape. The adapter contract calls an empty subpath invalid.
  const key = transcriptKey('tenant-a', 'sess-1', '');
  assert.equal(key.ok, false);
  assert.equal(!key.ok && key.refusal.reason, 'transcript-key-invalid');
  assert.match((!key.ok && key.refusal.detail) || '', /omit the field/);
});

test('an empty project key is refused', () => {
  const key = transcriptKey('', 'sess-1');
  assert.equal(!key.ok && key.refusal.reason, 'transcript-key-invalid');
});

test('an empty session id is refused', () => {
  const key = transcriptKey('tenant-a', '');
  assert.equal(!key.ok && key.refusal.reason, 'transcript-key-invalid');
});

test('two keys for the same transcript compare equal', () => {
  const left = transcriptKey('t', 's');
  const right = transcriptKey('t', 's');
  assert.equal(left.ok && right.ok && sameTranscript(left.value, right.value), true);
});

test("a main transcript and a subagent's do not compare equal", () => {
  const main = transcriptKey('t', 's');
  const sub = transcriptKey('t', 's', 'subagents/agent-1');
  assert.equal(main.ok && sub.ok && sameTranscript(main.value, sub.value), false);
});

test('two subagents of one session do not compare equal', () => {
  const one = transcriptKey('t', 's', 'subagents/agent-1');
  const two = transcriptKey('t', 's', 'subagents/agent-2');
  assert.equal(one.ok && two.ok && sameTranscript(one.value, two.value), false);
});

test('a token distinguishes the main transcript from a subagent of the same session', () => {
  const main = transcriptKey('t', 's');
  const sub = transcriptKey('t', 's', 'subagents/agent-1');
  assert.notEqual(main.ok && transcriptToken(main.value), sub.ok && transcriptToken(sub.value));
});

test('regression: a token escapes its parts, so a separator inside a key cannot forge another key', () => {
  // Two different keys whose naive concatenation would collide. The token is used as a map key and
  // in log lines, so a collision here would merge two sessions' records into one.
  const sneaky = transcriptKey('t/s', 'x');
  const plain = transcriptKey('t', 's/x');
  assert.notEqual(sneaky.ok && transcriptToken(sneaky.value), plain.ok && transcriptToken(plain.value));
});

test('the same key always produces the same token', () => {
  const key = transcriptKey('tenant a', 'sess-1', 'subagents/agent-7');
  assert.equal(key.ok && transcriptToken(key.value), key.ok && transcriptToken(key.value));
});
