import test from 'node:test';
import assert from 'node:assert/strict';

import type { OpenEntry, SessionTransition } from '../state/model.js';
import type { TranscriptEntry } from './entry.js';
import {
  ABANDONED_ENTRY_TYPE,
  TRANSITION_ENTRY_TYPE,
  abandonmentsIn,
  decodeTransition,
  encodeTransition,
  markAbandoned,
  transitionUuid,
  transitionsIn,
} from './transition-log.js';

const transition = (over: Partial<SessionTransition> = {}): SessionTransition => ({
  sessionId: 'sess-1',
  seq: 3,
  at: '2026-08-04T10:00:00Z',
  from: 'working',
  to: 'working',
  activity: { kind: 'tool', name: 'Bash' },
  entryId: 'toolu_01',
  cause: { kind: 'hook', event: 'PreToolUse', detail: 'Bash' },
  where: { cwd: '/w', worktree: '/w', branch: 'main', unknownReason: null },
  correlationId: 'corr-1',
  ...over,
});

const openEntry = (over: Partial<OpenEntry> = {}): OpenEntry => ({
  entryId: 'toolu_01',
  activity: { kind: 'tool', name: 'Bash' },
  lane: 'foreground',
  openedAt: '2026-08-04T10:00:00Z',
  backgroundedAt: null,
  abandonedAt: null,
  abandonReason: null,
  cause: { kind: 'hook', event: 'PreToolUse', detail: 'Bash' },
  agentId: null,
  ...over,
});

// ---------------------------------------------------------------------------
// cause survives the round trip: the property the declared state model exists for
// ---------------------------------------------------------------------------

test('regression: a transition survives the round trip with its cause intact', () => {
  const original = transition();
  const decoded = decodeTransition(encodeTransition(original));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.ok && decoded.value.cause, original.cause);
});

test('regression: every field a reader branches on survives the round trip', () => {
  const original = transition();
  const decoded = decodeTransition(encodeTransition(original));
  assert.deepEqual(decoded.ok && decoded.value, original);
});

test('a refusal-caused transition round-trips — the local gate lane', () => {
  // Every refusal reason is a legal cause event, so a locally-decided denial is storable as itself
  // rather than as free text. This log is the only place such a decision is stored durably.
  const original = transition({
    cause: { kind: 'refusal', event: 'shell-boundary-command', detail: 'the publish rule fired' },
    to: 'working',
  });
  const decoded = decodeTransition(encodeTransition(original));
  assert.equal(decoded.ok && decoded.value.cause.event, 'shell-boundary-command');
  assert.equal(decoded.ok && decoded.value.cause.kind, 'refusal');
});

test('a transition recorded before the agent named itself round-trips with a null session id', () => {
  const original = transition({ sessionId: null, from: 'spawning', to: 'spawning' });
  const decoded = decodeTransition(encodeTransition(original));
  assert.equal(decoded.ok && decoded.value.sessionId, null);
});

test('a null activity survives rather than becoming an absent field', () => {
  const original = transition({ activity: null, entryId: null });
  const decoded = decodeTransition(encodeTransition(original));
  assert.equal(decoded.ok && decoded.value.activity, null);
  assert.equal(decoded.ok && decoded.value.entryId, null);
});

// ---------------------------------------------------------------------------
// a lost cause refuses rather than decoding into an uncaused transition
// ---------------------------------------------------------------------------

test('regression: an entry whose cause was lost is refused, never decoded as an uncaused transition', () => {
  // A state change nobody can explain reads as fact — worse than no record at all.
  const wrecked = { ...encodeTransition(transition()) };
  delete (wrecked as Record<string, unknown>)['cause'];
  const decoded = decodeTransition(wrecked);
  assert.equal(decoded.ok, false);
  assert.match((!decoded.ok && decoded.refusal.detail) || '', /no cause/);
});

test('regression: a cause kind that is not a declared kind is refused', () => {
  const wrecked = encodeTransition(transition()) as Record<string, unknown>;
  wrecked['cause'] = { kind: 'vibes', event: 'PreToolUse', detail: '' };
  const decoded = decodeTransition(wrecked as TranscriptEntry);
  assert.equal(decoded.ok, false);
  assert.match((!decoded.ok && decoded.refusal.detail) || '', /declared kind/);
});

test('regression: a cause event that is not a declared event is refused', () => {
  const wrecked = encodeTransition(transition()) as Record<string, unknown>;
  wrecked['cause'] = { kind: 'hook', event: 'SomethingNobodyDeclared', detail: '' };
  const decoded = decodeTransition(wrecked as TranscriptEntry);
  assert.equal(decoded.ok, false);
  assert.match((!decoded.ok && decoded.refusal.detail) || '', /declared event/);
});

test('the two cause halves are checked independently, matching the machine', () => {
  // An incoherent but individually-declared pair decodes, exactly as the machine admits it. Pairing
  // is the author's job; this read must not invent a stricter rule than the writer enforces.
  const entry = encodeTransition(transition()) as Record<string, unknown>;
  entry['cause'] = { kind: 'hook', event: 'permission_denied', detail: '' };
  assert.equal(decodeTransition(entry as TranscriptEntry).ok, true);
});

test('an entry that is not a transition at all is refused by type', () => {
  const decoded = decodeTransition({ type: 'user', uuid: 'u-1' });
  assert.equal(decoded.ok, false);
});

test('a transition with no seq is refused — a gap is detected by arithmetic, so seq is load-bearing', () => {
  const wrecked = encodeTransition(transition()) as Record<string, unknown>;
  delete wrecked['seq'];
  assert.equal(decodeTransition(wrecked as TranscriptEntry).ok, false);
});

test('a transition with no where is refused', () => {
  const wrecked = encodeTransition(transition()) as Record<string, unknown>;
  delete wrecked['where'];
  assert.equal(decodeTransition(wrecked as TranscriptEntry).ok, false);
});

// ---------------------------------------------------------------------------
// append-only: an abandoned entry is marked, never erased
// ---------------------------------------------------------------------------

test('regression: marking an entry abandoned produces a new record and leaves the original untouched', () => {
  const entry = openEntry();
  const before = JSON.stringify(entry);
  const mark = markAbandoned(entry, '2026-08-04T10:40:00Z', 'the session ended with this entry still open');

  assert.equal(JSON.stringify(entry), before, 'the entry object is not mutated');
  assert.equal(mark.type, ABANDONED_ENTRY_TYPE);
  assert.notEqual(mark.type, TRANSITION_ENTRY_TYPE);
});

test('regression: the mark carries the original open time, so the age survives the record', () => {
  // "This session sat in tool:Bash for forty minutes" is the sentence the whole design protects.
  const mark = markAbandoned(openEntry(), '2026-08-04T10:40:00Z', 'ended with the entry open');
  assert.equal(mark['openedAt'], '2026-08-04T10:00:00Z');
  assert.equal(mark.timestamp, '2026-08-04T10:40:00Z');
  const openedAt = Date.parse(String(mark['openedAt']));
  const markedAt = Date.parse(String(mark.timestamp));
  assert.equal(markedAt - openedAt, 40 * 60 * 1000, 'forty minutes is recoverable from the record alone');
});

test('regression: the mark carries the reason and the cause that opened the entry', () => {
  const mark = markAbandoned(openEntry(), '2026-08-04T10:40:00Z', 'the session ended (stop_requested)');
  assert.equal(mark['reason'], 'the session ended (stop_requested)');
  assert.deepEqual(mark['cause'], { kind: 'hook', event: 'PreToolUse', detail: 'Bash' });
});

test('the mark names which entry it is about, and what that entry was doing', () => {
  const mark = markAbandoned(
    openEntry({ entryId: 'toolu_99', agentId: 'agent-3' }),
    '2026-08-04T11:00:00Z',
    'why',
  );
  assert.equal(mark['entryId'], 'toolu_99');
  assert.equal(mark['agentId'], 'agent-3');
  assert.deepEqual(mark['activity'], { kind: 'tool', name: 'Bash' });
});

test('regression: a marked entry and its mark are both readable — the pair is the signal', () => {
  const entries: TranscriptEntry[] = [
    encodeTransition(transition({ entryId: 'toolu_01' })),
    markAbandoned(openEntry(), '2026-08-04T10:40:00Z', 'ended with the entry open'),
  ];

  const marks = abandonmentsIn(entries);
  assert.equal(marks.size, 1);
  assert.equal(marks.get('toolu_01')?.['reason'], 'ended with the entry open');

  const found = transitionsIn(entries);
  assert.equal(found.ok && found.value.length, 1, 'the original transition is still there, unchanged');
});

test('two marks for two entries are both retained', () => {
  const entries = [
    markAbandoned(openEntry({ entryId: 'a' }), '2026-08-04T11:00:00Z', 'one'),
    markAbandoned(openEntry({ entryId: 'b' }), '2026-08-04T11:00:00Z', 'two'),
  ];
  assert.equal(abandonmentsIn(entries).size, 2);
});

// ---------------------------------------------------------------------------
// reading a mixed store
// ---------------------------------------------------------------------------

test('transitions are found among mirrored transcript entries without confusing the two', () => {
  const entries: TranscriptEntry[] = [
    { type: 'user', uuid: 'u-1' },
    encodeTransition(transition({ seq: 1 })),
    { type: 'assistant', uuid: 'a-1' },
    encodeTransition(transition({ seq: 2 })),
  ];
  const found = transitionsIn(entries);
  assert.equal(found.ok && found.value.length, 2);
  assert.deepEqual(found.ok && found.value.map((one) => one.seq), [1, 2]);
});

test('regression: one unreadable transition refuses the whole read rather than returning a short list', () => {
  const wrecked = encodeTransition(transition()) as Record<string, unknown>;
  delete wrecked['cause'];
  const found = transitionsIn([encodeTransition(transition({ seq: 1 })), wrecked as TranscriptEntry]);
  assert.equal(found.ok, false, 'a short list with no error is the silent-loss shape');
});

test('a store with no transitions reads as none rather than refusing', () => {
  const found = transitionsIn([{ type: 'user', uuid: 'u-1' }]);
  assert.equal(found.ok && found.value.length, 0);
});

// ---------------------------------------------------------------------------
// the derived uuid: idempotency for a retried mirror
// ---------------------------------------------------------------------------

test('regression: the same transition always derives the same uuid, so a retry deduplicates', () => {
  assert.equal(transitionUuid(transition()), transitionUuid(transition()));
});

test('two transitions of one session differ by seq', () => {
  assert.notEqual(transitionUuid(transition({ seq: 1 })), transitionUuid(transition({ seq: 2 })));
});

test('the same seq in two different sessions does not collide', () => {
  assert.notEqual(
    transitionUuid(transition({ sessionId: 'a' })),
    transitionUuid(transition({ sessionId: 'b' })),
  );
});

test('two id-less sessions are told apart by correlation id', () => {
  // Before an agent names itself there is no session id, and two concurrent starts would otherwise
  // derive identical uuids and deduplicate each other away.
  assert.notEqual(
    transitionUuid(transition({ sessionId: null, correlationId: 'one' })),
    transitionUuid(transition({ sessionId: null, correlationId: 'two' })),
  );
});

test('the encoded entry carries the derived uuid, so the store dedupes on it', () => {
  const original = transition();
  assert.equal(encodeTransition(original).uuid, transitionUuid(original));
});
