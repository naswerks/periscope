import test from 'node:test';
import assert from 'node:assert/strict';

import type { TranscriptEntry } from './entry.js';
import {
  decodeEntry,
  decodeTranscript,
  encodeEntry,
  encodeTranscript,
  isCompactBoundary,
  isCompactionProduced,
  isUserEntry,
} from './entry.js';

// ---------------------------------------------------------------------------
// the round trip: the only invariant the adapter contract requires
// ---------------------------------------------------------------------------

test('regression: an entry survives the round trip unchanged, payload and all', () => {
  const entry: TranscriptEntry = {
    type: 'user',
    uuid: 'u-1',
    timestamp: '2026-08-04T00:00:00Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    parentUuid: 'a-0',
  };
  const decoded = decodeEntry(encodeEntry(entry));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.ok && decoded.value, entry);
});

test('a nested payload the host does not model survives untouched', () => {
  const entry: TranscriptEntry = {
    type: 'assistant',
    uuid: 'a-1',
    deeply: { nested: [1, 2, { thing: null }], flag: false },
  };
  const decoded = decodeEntry(encodeEntry(entry));
  assert.deepEqual(decoded.ok && decoded.value, entry);
});

test('unicode and embedded newlines survive the round trip', () => {
  const entry: TranscriptEntry = {
    type: 'user',
    uuid: 'u-1',
    text: 'line one\nline two — ünïcode \u{1F534}',
  };
  const decoded = decodeEntry(encodeEntry(entry));
  assert.deepEqual(decoded.ok && decoded.value, entry);
});

test('an encoded entry is one line, so an embedded newline cannot split the record', () => {
  const entry: TranscriptEntry = { type: 'user', uuid: 'u-1', text: 'a\nb\nc' };
  assert.equal(encodeEntry(entry).includes('\n'), false);
});

test('a whole transcript round-trips in order', () => {
  const entries: TranscriptEntry[] = [
    { type: 'user', uuid: 'u-1' },
    { type: 'assistant', uuid: 'a-1' },
    { type: 'user', uuid: 'u-2' },
  ];
  const decoded = decodeTranscript(encodeTranscript(entries));
  assert.deepEqual(decoded.ok && decoded.value, entries);
});

// ---------------------------------------------------------------------------
// malformed lines are named, never skipped
// ---------------------------------------------------------------------------

test('regression: a line that is not JSON is refused, not skipped', () => {
  const result = decodeEntry('{not json');
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.reason, 'transcript-entry-malformed');
});

test('a JSON value that is not an object is refused', () => {
  for (const line of ['42', '"a string"', 'null', 'true']) {
    const result = decodeEntry(line);
    assert.equal(result.ok, false, `${line} is not an entry`);
    assert.equal(!result.ok && result.refusal.reason, 'transcript-entry-malformed');
  }
});

test('a JSON array is refused — it would otherwise pass a bare typeof object check', () => {
  const result = decodeEntry('[{"type":"user"}]');
  assert.equal(result.ok, false);
});

test('an object with no string type discriminant is refused', () => {
  const result = decodeEntry('{"uuid":"u-1"}');
  assert.equal(result.ok, false);
  assert.match((!result.ok && result.refusal.detail) || '', /type/);
});

test('regression: a malformed line names its line number, so the file can be looked at', () => {
  const text = ['{"type":"user","uuid":"u-1"}', '{"type":"assistant"}', 'wreckage'].join('\n');
  const result = decodeTranscript(text);
  assert.equal(result.ok, false);
  assert.match((!result.ok && result.refusal.detail) || '', /line 3/);
});

test('regression: one bad line refuses the whole read rather than returning a short transcript', () => {
  // A short list with no error is the silent-loss shape: the reader has no reason to doubt it, and a
  // receipt read on top of a transcript missing entries answers the wrong question confidently.
  const text = ['{"type":"user","uuid":"u-1"}', 'wreckage', '{"type":"user","uuid":"u-2"}'].join('\n');
  const result = decodeTranscript(text);
  assert.equal(result.ok, false, 'never a partial success');
});

test('blank lines and a trailing newline are ordinary, not malformed', () => {
  const text = '{"type":"user","uuid":"u-1"}\n\n{"type":"user","uuid":"u-2"}\n';
  const result = decodeTranscript(text);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.length, 2);
});

test('an empty transcript decodes to no entries rather than refusing', () => {
  const result = decodeTranscript('');
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, []);
});

// ---------------------------------------------------------------------------
// compaction detection: the receipt's third defence depends on all of this
// ---------------------------------------------------------------------------

test('regression: the boundary is detected by the SDK subtype', () => {
  assert.equal(isCompactBoundary({ type: 'system', subtype: 'compact_boundary' }), true);
});

test('regression: the boundary is detected by its metadata block even if the subtype is spelled otherwise', () => {
  // Three independent tells, because the boundary is the one entry a receipt must never miss.
  assert.equal(isCompactBoundary({ type: 'system', compact_metadata: { trigger: 'auto' } }), true);
});

test('regression: the boundary is detected by entry type', () => {
  assert.equal(isCompactBoundary({ type: 'compact_boundary' }), true);
});

test('an ordinary turn is not a boundary', () => {
  assert.equal(isCompactBoundary({ type: 'user', uuid: 'u-1' }), false);
  assert.equal(isCompactBoundary({ type: 'assistant', uuid: 'a-1' }), false);
  assert.equal(isCompactBoundary({ type: 'system', subtype: 'init' }), false);
});

test('regression: a compaction summary typed as a user turn is compaction-produced', () => {
  // The false-positive case in one assertion: it looks exactly like a delivery and is not one.
  assert.equal(isCompactionProduced({ type: 'user', uuid: 'cs-1', isCompactSummary: true }), true);
});

test('regression: a summary-typed entry is compaction-produced', () => {
  assert.equal(isCompactionProduced({ type: 'summary', uuid: 's-1' }), true);
});

test('the boundary itself is compaction-produced', () => {
  assert.equal(isCompactionProduced({ type: 'system', subtype: 'compact_boundary' }), true);
});

test('an ordinary user turn is not compaction-produced — the guard does not swallow real deliveries', () => {
  // The other direction of the compaction guard: over-detection would make every receipt a false
  // negative.
  assert.equal(isCompactionProduced({ type: 'user', uuid: 'u-1', message: { role: 'user' } }), false);
});

test('isCompactSummary must be exactly true — a falsy or absent flag is an ordinary turn', () => {
  assert.equal(isCompactionProduced({ type: 'user', uuid: 'u-1', isCompactSummary: false }), false);
  assert.equal(isCompactionProduced({ type: 'user', uuid: 'u-1', isCompactSummary: 'yes' }), false);
});

test('isUserEntry recognises a user turn and nothing else', () => {
  assert.equal(isUserEntry({ type: 'user' }), true);
  assert.equal(isUserEntry({ type: 'assistant' }), false);
  assert.equal(isUserEntry({ type: 'system' }), false);
});
