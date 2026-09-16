import test from 'node:test';
import assert from 'node:assert/strict';

import type { TranscriptEntry } from './entry.js';
import type { MirrorDrop } from './mirror.js';
import { MIRROR_ATTEMPTS, dedupeBatch, describeMirrorDrop, uuidsIn } from './mirror.js';

const entry = (uuid: string | undefined, type = 'user'): TranscriptEntry =>
  uuid === undefined ? { type } : { type, uuid };

// ---------------------------------------------------------------------------
// the two drop paths, which are not one failure with two names
// ---------------------------------------------------------------------------

test('regression: a rejected batch gets three attempts; a timed-out batch gets one', () => {
  // The asymmetry is the trap: an operator reasoning from "it retries three times" mis-predicts
  // every timeout-shaped outage, and a slow store is the likeliest way to lose data here.
  assert.equal(MIRROR_ATTEMPTS.rejected, 3);
  assert.equal(MIRROR_ATTEMPTS['timed-out'], 1, 'a timeout is not retried — it drops on the first failure');
});

test('regression: a dropped batch describes itself as a drop, never as a retry or a warning', () => {
  const drop: MirrorDrop = {
    key: { projectKey: 'tenant-a', sessionId: 'sess-1' },
    kind: 'rejected',
    attempts: 3,
    error: 'HTTP 503 from the store',
    entryUuids: ['u-1', 'u-2'],
  };
  const line = describeMirrorDrop(drop);
  assert.match(line, /DROPPED/, 'the word a human scans for');
  assert.match(line, /sess-1/, 'and which session lost it');
  assert.match(line, /HTTP 503 from the store/, "and the store's own reason");
  assert.match(line, /3 attempts/);
});

test('regression: a timeout drop says one attempt, so the record cannot imply a retry that never ran', () => {
  const line = describeMirrorDrop({
    key: { projectKey: 't', sessionId: 'sess-9' },
    kind: 'timed-out',
    attempts: MIRROR_ATTEMPTS['timed-out'],
    error: 'no response in 60s',
    entryUuids: ['u-1'],
  });
  assert.match(line, /1 attempt \(timed-out\)/);
  assert.doesNotMatch(line, /attempts/, 'singular, because exactly one attempt happened');
});

test('regression: the drop names the entries that were lost, so it is recoverable and not just an alarm', () => {
  const line = describeMirrorDrop({
    key: { projectKey: 't', sessionId: 's' },
    kind: 'rejected',
    attempts: 3,
    error: 'boom',
    entryUuids: ['u-1', 'u-2', 'u-3'],
  });
  assert.match(line, /3 entries/);
  assert.match(line, /local disk still holds them/, 'and says where the entries can still be read');
});

test('a drop of one entry reads as one entry', () => {
  const line = describeMirrorDrop({
    key: { projectKey: 't', sessionId: 's' },
    kind: 'rejected',
    attempts: 3,
    error: 'boom',
    entryUuids: ['only-one'],
  });
  assert.match(line, /1 entry is/);
});

test("a subagent's dropped batch names the subpath, not just the session", () => {
  const line = describeMirrorDrop({
    key: { projectKey: 't', sessionId: 'sess-1', subpath: 'subagents/agent-7' },
    kind: 'rejected',
    attempts: 3,
    error: 'boom',
    entryUuids: [],
  });
  assert.match(line, /sess-1\/subagents\/agent-7/);
});

// ---------------------------------------------------------------------------
// idempotency: a retried batch must not double the transcript
// ---------------------------------------------------------------------------

test('regression: an entry whose uuid the store already holds is skipped, so a retry does not duplicate', () => {
  const known = new Set(['u-1']);
  const split = dedupeBatch(known, [entry('u-1'), entry('u-2')]);
  assert.deepEqual(
    split.append.map((one) => one.uuid),
    ['u-2'],
  );
  assert.deepEqual(
    split.skipped.map((one) => one.uuid),
    ['u-1'],
  );
});

test('regression: a batch replayed in full appends nothing at all', () => {
  const batch = [entry('u-1'), entry('u-2'), entry('u-3')];
  const split = dedupeBatch(uuidsIn(batch), batch);
  assert.equal(split.append.length, 0);
  assert.equal(split.skipped.length, 3);
});

test('regression: a duplicate within one batch is caught too, not only against the store', () => {
  const split = dedupeBatch(new Set(), [entry('u-1'), entry('u-1'), entry('u-2')]);
  assert.equal(split.append.length, 2);
  assert.equal(split.skipped.length, 1);
});

test('regression: an entry with no uuid is always appended — titles, tags and mode markers have none', () => {
  // Treating "no uuid" as a duplicate would silently drop every one of them.
  const split = dedupeBatch(new Set(['u-1']), [entry(undefined, 'title'), entry(undefined, 'tag')]);
  assert.equal(split.append.length, 2);
  assert.equal(split.skipped.length, 0);
});

test('regression: two uuid-less entries in one batch are both appended — they are not duplicates of each other', () => {
  const split = dedupeBatch(new Set(), [entry(undefined, 'title'), entry(undefined, 'title')]);
  assert.equal(split.append.length, 2, 'the contract says append these without dedup');
});

test('an empty-string uuid is treated as absent rather than as an id', () => {
  const split = dedupeBatch(new Set(['']), [entry('', 'title')]);
  assert.equal(split.append.length, 1);
});

test('a fresh batch against an empty store appends everything, in order', () => {
  const split = dedupeBatch(new Set(), [entry('u-1'), entry('u-2')]);
  assert.deepEqual(
    split.append.map((one) => one.uuid),
    ['u-1', 'u-2'],
  );
});

test('deduplication preserves the order of what it does append', () => {
  const split = dedupeBatch(new Set(['u-2']), [entry('u-1'), entry('u-2'), entry('u-3')]);
  assert.deepEqual(
    split.append.map((one) => one.uuid),
    ['u-1', 'u-3'],
  );
});

test('an empty batch splits into nothing', () => {
  const split = dedupeBatch(new Set(['u-1']), []);
  assert.equal(split.append.length, 0);
  assert.equal(split.skipped.length, 0);
});

// ---------------------------------------------------------------------------
// uuidsIn
// ---------------------------------------------------------------------------

test('uuidsIn collects every id present and ignores entries carrying none', () => {
  const found = uuidsIn([entry('u-1'), entry(undefined, 'title'), entry('u-2')]);
  assert.deepEqual([...found].sort(), ['u-1', 'u-2']);
});

test('uuidsIn ignores an empty-string uuid, matching the dedup rule', () => {
  assert.equal(uuidsIn([entry('')]).size, 0);
});

test('uuidsIn on an empty transcript is empty', () => {
  assert.equal(uuidsIn([]).size, 0);
});
