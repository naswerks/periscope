/**
 * Validating what came off the disk.
 *
 * Every branch here is a cache somebody could actually have — hand-edited, half-written by a
 * process that died, or produced by an older build of this package. A validator that trusted the
 * shape would turn each of those into a confusing failure much further along, at the point the
 * token is presented.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readCachedTokens } from './store.js';

const VALID = {
  tokens: {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 1_800_000_000_000,
    tokenType: 'Bearer',
    scope: 'openid',
  },
  protocol: 'loopback',
  authority: 'https://example.ciamlogin.com/tenant',
  clientId: 'client-abc',
};

test('a well-formed cache reads back exactly what was stored', () => {
  const result = readCachedTokens(VALID);

  assert.ok(result.ok);
  assert.equal(result.value.tokens.accessToken, 'at');
  assert.equal(result.value.protocol, 'loopback');
  assert.equal(result.value.authority, VALID.authority);
});

test('a cache that is not an object at all is refused', () => {
  for (const value of [null, 'string', 42, []]) {
    assert.equal(readCachedTokens(value).ok, false, JSON.stringify(value));
  }
});

test('a cache with no tokens object is refused', () => {
  assert.equal(readCachedTokens({ ...VALID, tokens: undefined }).ok, false);
});

test('a cache whose token has no access token or no numeric expiry is refused', () => {
  assert.equal(readCachedTokens({ ...VALID, tokens: { ...VALID.tokens, accessToken: '' } }).ok, false);
  assert.equal(readCachedTokens({ ...VALID, tokens: { ...VALID.tokens, expiresAt: 'soon' } }).ok, false);
});

test('regression: a cache that does not say which flow minted it is refused, not defaulted', () => {
  // Defaulting would silently pick a side of the AADSTS530036 guard, which is the one decision that
  // must never be guessed — a wrong guess produces a refresh failure weeks later.
  assert.equal(readCachedTokens({ ...VALID, protocol: undefined }).ok, false);
  assert.equal(readCachedTokens({ ...VALID, protocol: 'something-else' }).ok, false);
});

test('regression: a cache that does not record its authority and client is refused', () => {
  // Without them a token could be presented to a provider it was not issued for.
  assert.equal(readCachedTokens({ ...VALID, authority: undefined }).ok, false);
  assert.equal(readCachedTokens({ ...VALID, clientId: '' }).ok, false);
});

test('a missing refresh token reads as null rather than failing the whole cache', () => {
  const result = readCachedTokens({ ...VALID, tokens: { ...VALID.tokens, refreshToken: undefined } });

  assert.ok(result.ok);
  assert.equal(result.value.tokens.refreshToken, null);
});

test('a missing token type defaults to Bearer', () => {
  const result = readCachedTokens({ ...VALID, tokens: { ...VALID.tokens, tokenType: undefined } });

  assert.ok(result.ok);
  assert.equal(result.value.tokens.tokenType, 'Bearer');
});

test('every refusal from this validator is credential-cache-unreadable', () => {
  // One reason, because there is one fix: remove the file and sign in again.
  const result = readCachedTokens({ ...VALID, protocol: 'nonsense' });

  assert.equal(result.ok === false ? result.refusal.reason : null, 'credential-cache-unreadable');
});
