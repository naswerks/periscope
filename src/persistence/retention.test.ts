import test from 'node:test';
import assert from 'node:assert/strict';

import type { TranscriptEntry } from './entry.js';
import { entryTimeMs, markOutlivesSubject, planRetention } from './retention.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-04T12:00:00Z');

const at = (uuid: string, daysAgo: number): TranscriptEntry => ({
  type: 'user',
  uuid,
  timestamp: new Date(NOW - daysAgo * DAY).toISOString(),
});

// ---------------------------------------------------------------------------
// retention removes what it claims to, measured before and after
// ---------------------------------------------------------------------------

test('regression: a 30-day window removes what is older and keeps what is not — measured both sides', () => {
  const entries = [at('old-40', 40), at('old-31', 31), at('fresh-29', 29), at('fresh-1', 1)];

  const before = entries.length;
  const plan = planRetention(entries, { maxAgeMs: 30 * DAY }, NOW);

  assert.equal(plan.ok, true);
  assert.equal(before, 4, 'measured before');
  assert.equal(plan.ok && plan.value.keep.length, 2, 'measured after');
  assert.equal(plan.ok && plan.value.remove.length, 2);
  assert.deepEqual(
    plan.ok && plan.value.remove.map((one) => one.uuid),
    ['old-40', 'old-31'],
    'and it removed exactly the ones it claimed',
  );
  assert.deepEqual(plan.ok && plan.value.keep.map((one) => one.uuid), ['fresh-29', 'fresh-1']);
});

test('an entry exactly at the cutoff is kept — the boundary is inclusive on the keep side', () => {
  const plan = planRetention([at('exact', 30)], { maxAgeMs: 30 * DAY }, NOW);
  assert.equal(plan.ok && plan.value.keep.length, 1);
  assert.equal(plan.ok && plan.value.remove.length, 0);
});

test('a zero window removes everything datable — a stated policy, not an error', () => {
  const plan = planRetention([at('a', 1), at('b', 0.001)], { maxAgeMs: 0 }, NOW);
  assert.equal(plan.ok && plan.value.remove.length, 2);
});

test('nothing to remove is an ordinary outcome, not an empty plan', () => {
  const plan = planRetention([at('a', 1)], { maxAgeMs: 30 * DAY }, NOW);
  assert.equal(plan.ok && plan.value.remove.length, 0);
  assert.equal(plan.ok && plan.value.keep.length, 1);
});

test('an empty store plans nothing and refuses nothing', () => {
  const plan = planRetention([], { maxAgeMs: 30 * DAY }, NOW);
  assert.equal(plan.ok && plan.value.keep.length, 0);
  assert.equal(plan.ok && plan.value.remove.length, 0);
});

test('the plan does not mutate what it was given', () => {
  const entries = [at('a', 40), at('b', 1)];
  planRetention(entries, { maxAgeMs: 30 * DAY }, NOW);
  assert.equal(entries.length, 2, 'planning is not performing');
});

// ---------------------------------------------------------------------------
// an entry that cannot be dated is kept, and the count is surfaced
// ---------------------------------------------------------------------------

test('regression: an entry with no timestamp is kept — deleting on a guess is worse than keeping', () => {
  const entries: TranscriptEntry[] = [at('dated', 90), { type: 'title', title: 'a session' }];
  const plan = planRetention(entries, { maxAgeMs: 30 * DAY }, NOW);
  assert.equal(plan.ok && plan.value.remove.length, 1, 'only the datable old one goes');
  assert.equal(plan.ok && plan.value.keep.length, 1);
  assert.equal(plan.ok && plan.value.undatedKept, 1);
});

test('regression: an unparseable timestamp is kept, not treated as ancient', () => {
  // Treating unknown as old would delete exactly the malformed records somebody needs to look at.
  const entries: TranscriptEntry[] = [{ type: 'user', uuid: 'u', timestamp: 'not a date' }];
  const plan = planRetention(entries, { maxAgeMs: 0 }, NOW);
  assert.equal(plan.ok && plan.value.keep.length, 1);
  assert.equal(plan.ok && plan.value.undatedKept, 1);
});

test('regression: undatedKept makes a silently no-op policy visible', () => {
  // A store full of undated entries is one where retention does nothing, and an operator reading
  // only "removed 0" could not tell that apart from a store that is simply young.
  const entries: TranscriptEntry[] = [
    { type: 'a', uuid: '1' },
    { type: 'b', uuid: '2' },
    { type: 'c', uuid: '3' },
  ];
  const plan = planRetention(entries, { maxAgeMs: 0 }, NOW);
  assert.equal(plan.ok && plan.value.remove.length, 0);
  assert.equal(plan.ok && plan.value.undatedKept, 3, 'the reason nothing was removed is reported');
});

test('an empty-string timestamp counts as undated rather than as epoch zero', () => {
  const plan = planRetention([{ type: 'u', uuid: '1', timestamp: '' }], { maxAgeMs: 0 }, NOW);
  assert.equal(plan.ok && plan.value.undatedKept, 1);
});

// ---------------------------------------------------------------------------
// an invalid window is refused rather than defaulted
// ---------------------------------------------------------------------------

test('regression: a negative window is refused — a default here would delete on a schedule nobody chose', () => {
  const plan = planRetention([at('a', 1)], { maxAgeMs: -1 }, NOW);
  assert.equal(plan.ok, false);
  assert.equal(!plan.ok && plan.refusal.reason, 'retention-window-invalid');
});

test('a non-finite window is refused', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const plan = planRetention([at('a', 1)], { maxAgeMs: bad }, NOW);
    assert.equal(plan.ok, false, `${String(bad)} is not a window`);
  }
});

test('a non-finite now is refused rather than removing everything or nothing', () => {
  const plan = planRetention([at('a', 1)], { maxAgeMs: 30 * DAY }, Number.NaN);
  assert.equal(plan.ok, false);
  assert.equal(!plan.ok && plan.refusal.reason, 'retention-window-invalid');
});

// ---------------------------------------------------------------------------
// entryTimeMs
// ---------------------------------------------------------------------------

test('entryTimeMs reads an ISO timestamp', () => {
  assert.equal(entryTimeMs({ type: 'u', timestamp: '2026-08-04T12:00:00Z' }), NOW);
});

test('entryTimeMs is null for an absent, empty or unparseable timestamp', () => {
  assert.equal(entryTimeMs({ type: 'u' }), null);
  assert.equal(entryTimeMs({ type: 'u', timestamp: '' }), null);
  assert.equal(entryTimeMs({ type: 'u', timestamp: 'yesterday' }), null);
  assert.equal(entryTimeMs({ type: 'u', timestamp: 42 as unknown as string }), null);
});

// ---------------------------------------------------------------------------
// the pairing retention could destroy while looking correct
// ---------------------------------------------------------------------------

test('regression: an abandonment mark can never be dropped while the entry it refers to is kept', () => {
  const cutoff = NOW - 30 * DAY;
  const subject = NOW - 40 * DAY;

  // Both removed: the pair goes together.
  assert.equal(markOutlivesSubject(subject, subject + 1000, cutoff), true);
  // Subject removed, mark kept: an ordinary, truthful outcome.
  assert.equal(markOutlivesSubject(subject, NOW - DAY, cutoff), true);
  // Both kept.
  assert.equal(markOutlivesSubject(NOW - DAY, NOW, cutoff), true);
});

test('regression: the dangerous ordering is unreachable, and this is the assertion of that', () => {
  // A mark older than its subject would let the mark age out while the subject stays — leaving an
  // abandoned entry that reads as merely still-open, which is the signal's opposite. A mark is
  // always written after the entry it marks, so this cannot arise; the check exists so that stays
  // true rather than being reasoned about.
  const cutoff = NOW - 30 * DAY;
  assert.equal(
    markOutlivesSubject(NOW - DAY, NOW - 40 * DAY, cutoff),
    false,
    'a mark cannot predate its subject',
  );
});
