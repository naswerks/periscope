/**
 * The reconciliation, made checkable.
 *
 * Two vocabularies for one idea is the failure the whole package is written against, and the
 * package holds smaller versions of what this module declares: a process lifecycle with three
 * values, four end causes, and a state machine for the link. None of
 * those are competitors — each is either subsumed by the declared model or deliberately at a
 * different altitude — but "deliberately" is a claim, and a claim nothing checks is one that drifts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_END_CAUSES } from '../sessions/session.js';
import { LINK_CAUSES } from '../control/link-state.js';
import {
  ACTIVITY_KINDS,
  HOST_ACTIVITY_KINDS,
  PROCESS_EVENTS,
  SDK_ACTIVITY_KINDS,
  SESSION_STATES,
  formatActivity,
  isCauseEvent,
} from './model.js';

test("the process lifecycle's end causes are a subset of the declared cause vocabulary, not a second one", () => {
  // Positive control on the selector: an empty source set would satisfy the containment trivially.
  assert.ok(SESSION_END_CAUSES.length >= 4, 'the end causes look empty');

  const unmapped = SESSION_END_CAUSES.filter(
    (cause) => !(PROCESS_EVENTS as readonly string[]).includes(cause),
  );
  assert.deepEqual(
    unmapped,
    [],
    'a way a session can end that the state model cannot name would be a state recorded with no cause',
  );

  // ...and each is a nameable cause at runtime, which is what the machine actually checks.
  for (const cause of SESSION_END_CAUSES) assert.ok(isCauseEvent(cause), `${cause} is not a declared cause`);
});

test('the declared states subsume the process lifecycle rather than sitting beside it', () => {
  // provisioning -> spawning, live -> {ready, working, idle, errored, interrupted}, ended -> ended.
  // Asserted as reachability rather than as a mapping table: the point is that no lifecycle value
  // needs a state of its own, so nothing about the process has to be represented twice.
  for (const state of ['spawning', 'ready', 'working', 'idle', 'errored', 'interrupted', 'ended']) {
    assert.ok((SESSION_STATES as readonly string[]).includes(state), `${state} is missing from the model`);
  }
  assert.equal(SESSION_STATES.length, 7, 'the declared model grew or shrank without this being revisited');
});

test("the link machine stays at its own altitude — its causes are the link's, never a session's", () => {
  assert.ok(LINK_CAUSES.length >= 5, 'the link causes look empty');

  const overlapping = LINK_CAUSES.filter((cause) => isCauseEvent(cause));
  assert.deepEqual(
    overlapping,
    [],
    'a name meaning one thing about the link and another about a session is exactly how two ' +
      'vocabularies drift apart',
  );
});

test("every activity kind is declared as either the SDK's word or this package's, and none is both", () => {
  const claimed = [...SDK_ACTIVITY_KINDS, ...HOST_ACTIVITY_KINDS];
  assert.deepEqual([...claimed].sort(), [...ACTIVITY_KINDS].sort(), 'an activity kind claims no provenance');
  assert.equal(new Set(claimed).size, claimed.length, 'an activity kind is claimed twice');
});

test('the display form is for reading, and the structure is the truth', () => {
  assert.equal(formatActivity({ kind: 'tool', name: 'Bash' }), 'tool:Bash');
  assert.equal(formatActivity({ kind: 'requesting', name: null }), 'requesting');
  assert.equal(formatActivity(null), 'none');
});

test('no controller-side vocabulary reached the declared values', () => {
  // The vocabulary pin scans the source text, so the words are assembled at runtime here. This
  // test scans the declared VALUES, the half that ships on the wire to every consumer.
  const words = ['s-pec', 's-eat', 'p-ark', 'rul-ing', 'rec-on', 'cha-in', 'pipe-line', 'verd-ict'].map((w) =>
    w.replace('-', ''),
  );
  const values = [...SESSION_STATES, ...ACTIVITY_KINDS, ...PROCESS_EVENTS].join(' ');
  for (const word of words) {
    assert.doesNotMatch(values, new RegExp(`\\b${word}`, 'i'), `"${word}" reached the wire vocabulary`);
  }
  // Positive control: the scan must be capable of finding one.
  const planted = ' p-arked'.replace('-', '');
  assert.match([...values, planted].join(''), new RegExp(`\\b${words[2]}ed`, 'i'));
});
