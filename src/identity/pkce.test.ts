/**
 * PKCE and `state` — the two random values, and the fact that they are not the same value twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  CODE_CHALLENGE_METHOD,
  challengeFor,
  createPkce,
  createState,
  randomUrlSafe,
  requireS256,
  stateMatches,
} from './pkce.js';

test('the challenge is the base64url SHA-256 of the verifier, computed independently here', () => {
  // Recomputed from the RFC's definition rather than from this module's own helper — otherwise the
  // test would prove the function agrees with itself.
  const verifier = 'a-known-verifier-value';
  const expected = createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  assert.equal(challengeFor(verifier), expected);
});

test('the challenge is base64url — no padding, and none of the characters a URL would re-encode', () => {
  // A `+`, `/` or `=` surviving here would be mangled in the query string and the exchange would
  // fail at the provider with a message about a mismatched verifier.
  for (let i = 0; i < 50; i += 1) {
    assert.doesNotMatch(createPkce().challenge, /[+/=]/);
  }
});

test('a verifier is at least the 43 characters RFC 7636 requires', () => {
  assert.ok(createPkce().verifier.length >= 43);
});

test('regression: the method is S256 and this host refuses "plain" rather than merely not using it', () => {
  // RFC 7636 permits `plain`, where the challenge is the verifier — which gives the whole property
  // away to anyone who can see the authorization request. An unused branch is one a later reader
  // restores on a compatibility report, so the refusal has to be reachable.
  assert.equal(CODE_CHALLENGE_METHOD, 'S256');
  assert.equal(createPkce().method, 'S256');

  const refused = requireS256('plain');
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false ? refused.refusal.reason : null, 'pkce-method-unsupported');
});

test('requireS256 accepts S256 — the refusal above is not simply refusing everything', () => {
  assert.ok(requireS256('S256').ok);
});

test('regression: two sign-ins never share a verifier or a state', () => {
  // Reuse would let one flow's callback satisfy another's, which is the whole thing `state` exists
  // to prevent. Generated in bulk because a broken generator often repeats only occasionally.
  const verifiers = new Set<string>();
  const states = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    verifiers.add(createPkce().verifier);
    states.add(createState());
  }

  assert.equal(verifiers.size, 500);
  assert.equal(states.size, 500);
});

test('regression: the state is a separate value from the verifier — the verifier never enters a URL', () => {
  // Reusing the verifier as state would put it in a URL the browser history, the provider and any
  // proxy all record; the verifier is the one value that must not leave this process until the
  // exchange.
  const pkce = createPkce();

  assert.notEqual(createState(), pkce.verifier);
});

test('randomUrlSafe produces URL-safe output at the requested entropy', () => {
  const value = randomUrlSafe(16);

  assert.doesNotMatch(value, /[+/=]/);
  assert.ok(value.length >= 21);
});

// ---------------------------------------------------------------------------
// state comparison
// ---------------------------------------------------------------------------

test('state comparison accepts the value this host minted', () => {
  const state = createState();

  assert.equal(stateMatches(state, state), true);
});

test('regression: state comparison rejects a different value, a prefix, and an empty one', () => {
  const state = createState();

  assert.equal(stateMatches(state, createState()), false);
  assert.equal(stateMatches(state, state.slice(0, -1)), false, 'a truncated state was accepted');
  assert.equal(stateMatches(state, ''), false);
  assert.equal(
    stateMatches('', ''),
    false,
    'two empty states must not compare equal — that is the unset case',
  );
});

test('state comparison does not throw on mismatched lengths', () => {
  // `timingSafeEqual` throws when the buffers differ in length, so the length check ahead of it is
  // required rather than an optimisation — without it a wrong-length callback would crash the host
  // instead of being refused.
  assert.doesNotThrow(() => stateMatches('short', 'a-much-longer-state-value'));
});
