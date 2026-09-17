/**
 * The state-record pin: no session can be made exempt from emitting its transitions.
 *
 * The regression it exists against is specific. One early return skipped a wake publish and a
 * state stamp together (the publish correctly, the stamp not), and the session a reader most
 * needed to follow became the only one with no turn boundary at all. Nothing failed. No error, no
 * null: a state that stayed `running` while every reader inferred.
 *
 * The property test in `state/store.test.ts` proves sessions that differ in every available way
 * produce the same trace. This pin is the structural half, and it is the one that survives someone
 * DELIBERATELY adding the guard back, because it says the information that guard would need is not
 * in scope:
 *
 *   1. the machine imports nothing that could tell it which session it is or who is watching;
 *   2. the state fields are derived, not assigned — there is exactly one assignment in the module;
 *   3. the single commit path is straight-line, with no branch and no early return.
 *
 * What this pin does not claim, stated because a pin whose name outruns its assertion is worse
 * than no pin: it does not prove the observer records every event it sees. Which events produce a
 * record is `state/coverage.ts`'s to declare and `pins/hook-coverage.test.ts`'s to check. This is
 * about the machine, which is where suppression would be invisible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { importsOf, sourceFiles } from './walk.js';

const MACHINE = 'state/machine.ts';

function machineSource(): string {
  const file = sourceFiles().find((candidate) => candidate.path === MACHINE);
  assert.ok(file !== undefined, `${MACHINE} is missing — has the machine moved?`);
  return file.text;
}

/** The body of one method or function, by brace matching from its opening line. */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `could not find ${signature} — this pin is reading the wrong thing`);

  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`could not find the end of ${signature}`);
}

test('the state machine cannot see anything it could treat one session differently by', () => {
  const specifiers = importsOf(machineSource()).filter((specifier) => specifier.startsWith('.'));

  // Positive control on the SELECTOR: a file whose imports failed to parse would pass the filter
  // below over an empty set, and that green is indistinguishable from the honest one.
  assert.ok(specifiers.length >= 3, `imports look unparsed: ${specifiers.join(', ')}`);

  const reachable = specifiers.filter(
    (specifier) => !specifier.startsWith('../core/') && !specifier.startsWith('./'),
  );
  assert.deepEqual(
    reachable,
    [],
    'the machine reached beyond the pure core and its own model — an observer count, a registry or ' +
      'a link would give a later editor something to condition emission on',
  );
});

test('the current state is ASSIGNED in exactly one place — everything else derives from it', () => {
  const source = machineSource();

  const assignments = [...source.matchAll(/this\.#current\s*=/g)];
  assert.equal(
    assignments.length,
    1,
    'a second assignment means the state can move without a transition being recorded',
  );

  // ...and that one place is the commit path, not somewhere a guard could sit in front of.
  const commit = bodyOf(source, '#commit(request: TransitionRequest): SessionTransition');
  assert.ok(commit.includes('this.#current = transition'), 'the assignment left the commit path');

  // The derived accessors must not have grown backing fields.
  for (const accessor of ['get state()', 'get activity()', 'get sessionId()', 'get where()']) {
    const body = bodyOf(source, accessor);
    assert.match(body, /return /, `${accessor} should derive and return`);
    assert.doesNotMatch(body, /=\s*[^=>]/, `${accessor} assigns something — it is no longer derived`);
  }
});

test('the commit path is straight-line: no branch, no early return, nothing to suppress with', () => {
  const commit = bodyOf(machineSource(), '#commit(request: TransitionRequest): SessionTransition');

  // Positive control: a body that failed to extract would pass every check below trivially.
  assert.ok(commit.length > 200, `#commit looks unextracted: ${commit.length} chars`);
  assert.ok(commit.includes('seq'), 'the extracted body is not #commit');

  // Strip the doc comment: the prose above the method legitimately says "if" and "return".
  const code = commit.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  assert.doesNotMatch(code, /\bif\b/, '#commit branches — the suppressing guard now has somewhere to live');
  assert.doesNotMatch(code, /\bswitch\b/, '#commit branches');
  assert.doesNotMatch(code, /\?\s*[^.]/, '#commit carries a conditional expression');
  assert.equal(
    [...code.matchAll(/\breturn\b/g)].length,
    1,
    '#commit has more than one exit — one of them does not record',
  );
});

test('control: the guard being impossible is the point, so this pin fires when it becomes possible', () => {
  // Proves the reader above discriminates rather than passing over anything: the same checks run
  // against a body that DOES contain the suppressing branch, and they must fail it.
  const suppressing = `
    #commit(request: TransitionRequest): SessionTransition {
      if (this.#listeners.size === 0) return this.#current!;
      const transition = build(request);
      this.#current = transition;
      return transition;
    }`;
  const code = suppressing.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  assert.match(code, /\bif\b/, 'the detector cannot see a branch — it would pass anything');
  assert.equal([...code.matchAll(/\breturn\b/g)].length, 2, 'the detector cannot count exits');
});
