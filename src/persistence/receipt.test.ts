import test from 'node:test';
import assert from 'node:assert/strict';

import type { TranscriptEntry } from './entry.js';
import { baselineAnchor, compactionCount, resolveReceipt } from './receipt.js';

// ---------------------------------------------------------------------------
// fixtures: a transcript as it is actually stored, append-only, boundary in line
// ---------------------------------------------------------------------------

const user = (uuid: string, text: string): TranscriptEntry => ({
  type: 'user',
  uuid,
  timestamp: `2026-08-04T00:00:0${uuid.slice(-1)}Z`,
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const assistant = (uuid: string, text: string): TranscriptEntry => ({
  type: 'assistant',
  uuid,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

/** The boundary entry a compaction writes, shaped as the SDK's own message carries it. */
const compactBoundary = (uuid: string): TranscriptEntry => ({
  type: 'system',
  subtype: 'compact_boundary',
  uuid,
  compact_metadata: { trigger: 'auto', pre_tokens: 148_000 },
});

/**
 * The summary a compaction produces.
 *
 * It is typed `user`, and that is the entire reason the third defence in `receipt.ts` exists. A
 * compaction feeds its summary back into the conversation as a user turn, so a receipt asking only
 * "a user entry after my anchor?" matches this and reports a delivery that never happened.
 */
const compactSummary = (uuid: string): TranscriptEntry => ({
  type: 'user',
  uuid,
  isCompactSummary: true,
  message: { role: 'user', content: [{ type: 'text', text: 'This session is being continued…' }] },
});

// ---------------------------------------------------------------------------
// the property this whole file exists for: a receipt resolves across a compaction
// ---------------------------------------------------------------------------

test('regression: a receipt resolves across a compaction boundary', () => {
  // A long session: the anchor is taken, then a compaction runs, then the text is injected.
  const entries = [
    user('u-1', 'first turn'),
    assistant('a-1', 'reply'),
    user('u-2', 'second turn'),
    assistant('a-2', 'reply'),
    compactBoundary('cb-1'),
    compactSummary('cs-1'),
    user('u-3', 'THE INJECTED TEXT'),
  ];

  const outcome = resolveReceipt(entries, { anchorUuid: 'a-2', expectText: 'THE INJECTED TEXT' });

  assert.equal(outcome.ok, true, 'the anchor is still in the raw log after a compaction');
  assert.equal(outcome.ok && outcome.value.delivered, true);
  assert.equal(outcome.ok && outcome.value.entryUuid, 'u-3');
  assert.equal(
    outcome.ok && outcome.value.crossedCompaction,
    true,
    'the receipt reports that it crossed a boundary — that fact is what makes it trustworthy',
  );
});

test('regression: the anchor survives a compaction that summarizes everything', () => {
  // The worst case in the shipped types: no preserved segment at all, so a parentUuid walk from the
  // tail reaches the summary and stops. The raw log still holds every entry.
  const entries = [
    user('u-1', 'ancient turn'),
    assistant('a-1', 'ancient reply'),
    compactBoundary('cb-1'),
    compactSummary('cs-1'),
    user('u-2', 'injected after a total compaction'),
  ];

  const outcome = resolveReceipt(entries, {
    anchorUuid: 'a-1',
    expectText: 'injected after a total compaction',
  });

  assert.equal(outcome.ok && outcome.value.delivered, true);
  assert.equal(outcome.ok && outcome.value.entryUuid, 'u-2');

  // These two assertions are what make the test unsatisfiable by a broken read; the assertions
  // above are not, and a control run proved it. A reader that had been handed the post-compaction
  // view instead of the raw log still finds `u-2` by its text — so `delivered` and `entryUuid` go
  // green while the receipt is wrong. Only a read of the whole raw log sees three entries past the
  // anchor and a boundary among them.
  assert.equal(outcome.ok && outcome.value.scannedAfterAnchor, 3, 'the anchor was located in the raw log');
  assert.equal(outcome.ok && outcome.value.crossedCompaction, true, 'and the boundary was still in view');
});

test('regression: two compactions between the anchor and the inject still resolve', () => {
  const entries = [
    user('u-1', 'turn'),
    compactBoundary('cb-1'),
    compactSummary('cs-1'),
    user('u-2', 'turn'),
    compactBoundary('cb-2'),
    compactSummary('cs-2'),
    user('u-3', 'the text'),
  ];

  const outcome = resolveReceipt(entries, { anchorUuid: 'u-1', expectText: 'the text' });

  assert.equal(outcome.ok && outcome.value.delivered, true);
  assert.equal(outcome.ok && outcome.value.entryUuid, 'u-3');
  assert.equal(compactionCount(entries), 2);

  // Same reason as the test above: the text match alone survives a broken read, the span does not.
  assert.equal(outcome.ok && outcome.value.scannedAfterAnchor, 6, 'every entry past the anchor was in view');
  assert.equal(outcome.ok && outcome.value.crossedCompaction, true);
});

// ---------------------------------------------------------------------------
// the third defence: the false-positive guard, the direction the other two defences cannot see
// ---------------------------------------------------------------------------

test("regression: a compaction's own summary is not reported as a delivery", () => {
  // The inject never happened. Only the compaction ran. A receipt that counts the summary as a user
  // turn tells the controller its text landed, and the controller moves on having delivered nothing.
  const entries = [
    user('u-1', 'first turn'),
    assistant('a-1', 'reply'),
    compactBoundary('cb-1'),
    compactSummary('cs-1'),
  ];

  const outcome = resolveReceipt(entries, { anchorUuid: 'a-1' });

  assert.equal(outcome.ok, true);
  assert.equal(
    outcome.ok && outcome.value.delivered,
    false,
    'the summary is compaction output, not a turn — reporting it as delivered is a false positive',
  );
  assert.equal(outcome.ok && outcome.value.crossedCompaction, true, 'and the boundary is still reported');
});

test('regression: the boundary entry itself is never reported as a delivery', () => {
  const entries = [user('u-1', 'turn'), compactBoundary('cb-1')];
  const outcome = resolveReceipt(entries, { anchorUuid: 'u-1' });
  assert.equal(outcome.ok && outcome.value.delivered, false);
});

// ---------------------------------------------------------------------------
// the unfindable anchor: a refusal, never a negative receipt
// ---------------------------------------------------------------------------

test('regression: an anchor that is not in the transcript refuses — it does not report "not delivered"', () => {
  const entries = [user('u-1', 'turn'), user('u-2', 'the text')];

  const outcome = resolveReceipt(entries, { anchorUuid: 'nobody-has-this-uuid' });

  assert.equal(outcome.ok, false, 'the question cannot be evaluated, and that is a third answer');
  assert.equal(!outcome.ok && outcome.refusal.reason, 'receipt-anchor-unknown');
  assert.match(
    (!outcome.ok && outcome.refusal.detail) || '',
    /not the same as the text not arriving/,
    'the refusal says why it is not a negative receipt',
  );
});

test('a null anchor scans the whole transcript rather than refusing', () => {
  const entries = [user('u-1', 'the very first turn')];
  const outcome = resolveReceipt(entries, { anchorUuid: null, expectText: 'the very first turn' });
  assert.equal(outcome.ok && outcome.value.delivered, true);
  assert.equal(outcome.ok && outcome.value.entryUuid, 'u-1');
});

test('a null anchor on an empty transcript is an honest "not delivered", not a refusal', () => {
  const outcome = resolveReceipt([], { anchorUuid: null });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.value.delivered, false);
  assert.equal(outcome.ok && outcome.value.scannedAfterAnchor, 0);
});

// ---------------------------------------------------------------------------
// ordinary behaviour
// ---------------------------------------------------------------------------

test('a user entry after the anchor is a delivery', () => {
  const entries = [user('u-1', 'before'), user('u-2', 'after')];
  const outcome = resolveReceipt(entries, { anchorUuid: 'u-1' });
  assert.equal(outcome.ok && outcome.value.delivered, true);
  assert.equal(outcome.ok && outcome.value.entryUuid, 'u-2');
});

test('a user entry before the anchor is not a delivery', () => {
  const entries = [user('u-1', 'the text'), assistant('a-1', 'reply')];
  const outcome = resolveReceipt(entries, { anchorUuid: 'a-1', expectText: 'the text' });
  assert.equal(outcome.ok && outcome.value.delivered, false, 'the anchor is what makes this a new entry');
});

test('the anchor entry itself is excluded — a receipt is about what came after it', () => {
  const entries = [user('u-1', 'the text')];
  const outcome = resolveReceipt(entries, { anchorUuid: 'u-1', expectText: 'the text' });
  assert.equal(outcome.ok && outcome.value.delivered, false);
  assert.equal(outcome.ok && outcome.value.scannedAfterAnchor, 0);
});

test('an assistant reply after the anchor is not a delivery', () => {
  const entries = [user('u-1', 'turn'), assistant('a-1', 'the text')];
  const outcome = resolveReceipt(entries, { anchorUuid: 'u-1', expectText: 'the text' });
  assert.equal(outcome.ok && outcome.value.delivered, false, 'only a user entry is a delivery');
});

test('expectText discriminates between two writers injecting into one session', () => {
  const entries = [user('u-1', 'anchor'), user('u-2', 'somebody ELSE text'), user('u-3', 'MY text')];

  const mine = resolveReceipt(entries, { anchorUuid: 'u-1', expectText: 'MY text' });
  assert.equal(mine.ok && mine.value.entryUuid, 'u-3', 'it matched my text, not the first user entry it saw');

  const withoutText = resolveReceipt(entries, { anchorUuid: 'u-1' });
  assert.equal(
    withoutText.ok && withoutText.value.entryUuid,
    'u-2',
    'without expectText any user turn qualifies — which is why two writers need it',
  );
});

test('a delivery reports the entry timestamp when the entry carries one', () => {
  const entries = [user('u-1', 'anchor'), user('u-2', 'the text')];
  const outcome = resolveReceipt(entries, { anchorUuid: 'u-1' });
  assert.equal(outcome.ok && outcome.value.at, '2026-08-04T00:00:02Z');
});

test('scannedAfterAnchor counts what was examined, boundary entries included', () => {
  const entries = [
    user('u-1', 'anchor'),
    compactBoundary('cb-1'),
    compactSummary('cs-1'),
    user('u-2', 'text'),
  ];
  const outcome = resolveReceipt(entries, { anchorUuid: 'u-1' });
  assert.equal(outcome.ok && outcome.value.scannedAfterAnchor, 3);
});

test('crossedCompaction is false on a session that never compacted', () => {
  const entries = [user('u-1', 'anchor'), user('u-2', 'text')];
  const outcome = resolveReceipt(entries, { anchorUuid: 'u-1' });
  assert.equal(outcome.ok && outcome.value.crossedCompaction, false);
});

test('a compaction before the anchor is not reported as crossed', () => {
  const entries = [compactBoundary('cb-1'), user('u-1', 'anchor'), user('u-2', 'text')];
  const outcome = resolveReceipt(entries, { anchorUuid: 'u-1' });
  assert.equal(
    outcome.ok && outcome.value.crossedCompaction,
    false,
    'the reader asked what happened since its own anchor',
  );
});

// ---------------------------------------------------------------------------
// baselineAnchor: what a controller holds between reads
// ---------------------------------------------------------------------------

test('baselineAnchor is the last entry carrying a uuid', () => {
  assert.equal(baselineAnchor([user('u-1', 'a'), user('u-2', 'b')]), 'u-2');
});

test('baselineAnchor skips trailing entries that carry no uuid', () => {
  // Titles, tags and mode markers legitimately have none, and an anchor must be addressable.
  const entries: TranscriptEntry[] = [user('u-1', 'a'), { type: 'title', title: 'a session' }];
  assert.equal(baselineAnchor(entries), 'u-1');
});

test('baselineAnchor on an empty transcript is null, and null is a legal query anchor', () => {
  assert.equal(baselineAnchor([]), null);
});

test('baselineAnchor ignores an empty-string uuid rather than returning one nothing can find', () => {
  const entries: TranscriptEntry[] = [user('u-1', 'a'), { type: 'user', uuid: '' }];
  assert.equal(baselineAnchor(entries), 'u-1');
});

// ---------------------------------------------------------------------------
// the round trip a controller actually performs
// ---------------------------------------------------------------------------

test('the full controller loop: take a baseline, compact, inject, resolve', () => {
  const before = [user('u-1', 'turn one'), assistant('a-1', 'reply')];
  const anchor = baselineAnchor(before);
  assert.equal(anchor, 'a-1');

  // Time passes. The session compacts, then the controller's text is delivered.
  const after = [...before, compactBoundary('cb-1'), compactSummary('cs-1'), user('u-2', 'do the thing')];

  const outcome = resolveReceipt(after, { anchorUuid: anchor, expectText: 'do the thing' });
  assert.equal(outcome.ok && outcome.value.delivered, true);
  assert.equal(outcome.ok && outcome.value.crossedCompaction, true);
});
