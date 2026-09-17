/**
 * Presenting the token — every branch of the decision the controller link depends on.
 *
 * The store is a double here, which is why the ugly cases are reachable at all. A re-pointed
 * host, a cache minted by the wrong flow, an expired token with no refresh — each is a state that
 * takes real effort to produce on a real filesystem and one line to state here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { IdentityConfig } from './config.js';
import type { CredentialOutcome } from './credential.js';
import { AUTHORIZATION_HEADER, TokenCredential } from './credential.js';
import type { CachedTokens, TokenStore } from './store.js';
import type { TokenSet } from './token.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';

const NOW = 1_800_000_000_000;

const CONFIG: IdentityConfig = {
  authority: 'https://example.ciamlogin.com/tenant',
  clientId: 'client-abc',
  scopes: ['openid', 'offline_access'],
  endpoints: null,
  redirectPort: 0,
  deviceCodeEnabled: false,
};

function tokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: 'the-access-token',
    refreshToken: 'the-refresh-token',
    expiresAt: NOW + 3_600_000,
    tokenType: 'Bearer',
    scope: null,
    ...overrides,
  };
}

function cached(overrides: Partial<CachedTokens> = {}): CachedTokens {
  return {
    tokens: tokens(),
    protocol: 'loopback',
    authority: CONFIG.authority,
    clientId: CONFIG.clientId,
    ...overrides,
  };
}

/** An in-memory store that records whether it was cleared — the discard branches assert on it. */
function storeOf(initial: Result<CachedTokens>) {
  let current = initial;
  const written: CachedTokens[] = [];
  let cleared = 0;
  const store: TokenStore = {
    read: () => current,
    write: (value) => {
      written.push(value);
      current = ok(value);
      return ok(value);
    },
    clear: () => {
      cleared += 1;
      current = refuse('token-unavailable', 'cleared');
    },
  };
  return { store, written, clearedCount: () => cleared };
}

function credentialFor(store: TokenStore, refresh?: (c: CachedTokens) => Promise<Result<TokenSet>>) {
  const base = { store, config: CONFIG, protocol: 'loopback' as const, nowMs: () => NOW };
  // `exactOptionalPropertyTypes` is on, so an absent refresher is an absent KEY, never `undefined`.
  return new TokenCredential(refresh === undefined ? base : { ...base, refresh });
}

test('a fresh cached token is presented as a Bearer authorization header', async () => {
  const { store } = storeOf(ok(cached()));

  const result = await credentialFor(store).authorize();

  assert.ok(result.ok);
  assert.equal(result.value.header, AUTHORIZATION_HEADER);
  assert.equal(result.value.value, 'Bearer the-access-token');
});

test('an empty cache refuses as token-unavailable — nobody has signed in', async () => {
  const { store } = storeOf(
    refuse('token-unavailable', 'no token cache exists on this host yet — sign in first'),
  );

  const result = await credentialFor(store).authorize();

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.refusal.reason : null, 'token-unavailable');
});

test('a corrupt cache keeps its OWN reason rather than reading as "not signed in"', async () => {
  // Collapsing these would make a broken cache look like a fresh install forever, and the operator
  // would sign in repeatedly while the same unparseable file sat on disk.
  const { store } = storeOf(refuse('credential-cache-unreadable', 'not valid JSON'));

  const result = await credentialFor(store).authorize();

  assert.equal(result.ok === false ? result.refusal.reason : null, 'credential-cache-unreadable');
});

test('regression: a token minted for a different authority is discarded, not presented', async () => {
  // Presenting it would send a token to an audience it was not issued for.
  const { store, clearedCount } = storeOf(ok(cached({ authority: 'https://other.example.com/tenant' })));

  const result = await credentialFor(store).authorize();

  assert.equal(result.ok, false);
  assert.equal(clearedCount(), 1, 'the foreign token was left in the cache');
});

test('a token minted for a different CLIENT is discarded too', async () => {
  const { store, clearedCount } = storeOf(ok(cached({ clientId: 'someone-elses-client' })));

  await credentialFor(store).authorize();

  assert.equal(clearedCount(), 1);
});

test('regression: a device-code cache is discarded when this host is configured for loopback', async () => {
  // Refreshing it would fail with an error nobody could connect to a sign-in weeks earlier.
  const { store, clearedCount } = storeOf(ok(cached({ protocol: 'device-code' })));

  const result = await credentialFor(store).authorize();

  assert.equal(result.ok, false);
  assert.equal(clearedCount(), 1);
  assert.match(result.ok === false ? result.refusal.detail : '', /device-code/);
});

test('an expired token with no refresh token refuses rather than presenting a dead one', async () => {
  const { store } = storeOf(ok(cached({ tokens: tokens({ expiresAt: NOW - 1, refreshToken: null }) })));

  const result = await credentialFor(store).authorize();

  assert.equal(result.ok === false ? result.refusal.reason : null, 'token-unavailable');
});

test('an expired token with no refresher configured refuses rather than hanging', async () => {
  const { store } = storeOf(ok(cached({ tokens: tokens({ expiresAt: NOW - 1 }) })));

  const result = await credentialFor(store).authorize();

  assert.equal(result.ok === false ? result.refusal.reason : null, 'token-unavailable');
});

test('an expired token IS refreshed when a refresher is available, and the new one is presented', async () => {
  const { store, written } = storeOf(ok(cached({ tokens: tokens({ expiresAt: NOW - 1 }) })));

  const result = await credentialFor(store, async () =>
    ok(tokens({ accessToken: 'the-new-token', expiresAt: NOW + 3_600_000 })),
  ).authorize();

  assert.ok(result.ok);
  assert.equal(result.value.value, 'Bearer the-new-token');
  assert.equal(written.length, 1, 'the refreshed token was not persisted');
});

test('regression: a provider that returns no new refresh token keeps the old one working', async () => {
  // Dropping it would turn the next expiry into an interactive sign-in for no reason — and on an
  // unattended host that means the host simply stops.
  const { store, written } = storeOf(ok(cached({ tokens: tokens({ expiresAt: NOW - 1 }) })));

  await credentialFor(store, async () => ok(tokens({ accessToken: 'new', refreshToken: null }))).authorize();

  assert.equal(written[0]?.tokens.refreshToken, 'the-refresh-token');
});

test("a failed refresh surfaces the provider's own refusal reason", async () => {
  const { store } = storeOf(ok(cached({ tokens: tokens({ expiresAt: NOW - 1 }) })));

  const result = await credentialFor(store, async () =>
    refuse('token-request-failed', 'invalid_grant'),
  ).authorize();

  assert.equal(result.ok === false ? result.refusal.reason : null, 'token-request-failed');
});

test('regression: a refresh that succeeds but cannot be cached still returns the token', async () => {
  // The refresh worked. Failing here would take a working host down over a disk problem, and the
  // only cost of continuing is signing in again after a restart.
  let current: Result<CachedTokens> = ok(cached({ tokens: tokens({ expiresAt: NOW - 1 }) }));
  const store: TokenStore = {
    read: () => current,
    write: () => refuse('credential-cache-write-failed', 'disk full'),
    clear: () => {
      current = refuse('token-unavailable', 'cleared');
    },
  };

  const result = await credentialFor(store, async () => ok(tokens({ accessToken: 'new' }))).authorize();

  assert.ok(result.ok, 'a cache write failure took down a successful refresh');
  assert.equal(result.value.value, 'Bearer new');
});

test('regression: no token value appears in any refusal this credential produces', async () => {
  const secret = 'SECRET-ACCESS-TOKEN-VALUE';
  const cases: Array<Promise<Result<unknown>>> = [
    credentialFor(
      storeOf(ok(cached({ authority: 'https://elsewhere/t', tokens: tokens({ accessToken: secret }) })))
        .store,
    ).authorize(),
    credentialFor(
      storeOf(ok(cached({ protocol: 'device-code', tokens: tokens({ accessToken: secret }) }))).store,
    ).authorize(),
    credentialFor(
      storeOf(ok(cached({ tokens: tokens({ accessToken: secret, expiresAt: NOW - 1, refreshToken: null }) })))
        .store,
    ).authorize(),
  ];

  for (const pending of cases) {
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false ? result.refusal.detail.includes(secret) : true,
      false,
      result.ok === false ? result.refusal.detail : '',
    );
  }
});

test('regression: the credential never consults apiKeySource, which looks like the answer', async () => {
  // `apiKeySource` names which key source a session used and reads `none` on a fully authenticated,
  // billing session. A host that treated it as an authentication predicate would report every
  // healthy session as broken. Freshness here comes from the token's own expiry.
  const { store } = storeOf(ok(cached()));

  const result = await new TokenCredential({
    store,
    config: CONFIG,
    protocol: 'loopback',
    // A clock past the expiry proves the decision is made on the expiry and nothing else.
    nowMs: () => NOW + 4_000_000,
  }).authorize();

  assert.equal(result.ok, false, 'an expired token was presented, so expiry is not what decided');
});

// ---------------------------------------------------------------------------
// What the credential says it did
// ---------------------------------------------------------------------------
//
// Without a report these three outcomes are indistinguishable from outside this class: a host
// whose refresh failed connects with no header (`control/link.ts` swallows the refusal
// deliberately), takes a 401, and the user is never told the one thing they can act on.

/** The reporter as a recorder — what a real embedder does with the data, minus the formatting. */
function reporterOf(): { report: (outcome: CredentialOutcome) => void; seen: CredentialOutcome[] } {
  const seen: CredentialOutcome[] = [];
  return { report: (outcome) => seen.push(outcome), seen };
}

test('regression: a cache hit says so, exactly once', async () => {
  const { store } = storeOf(ok(cached()));
  const { report, seen } = reporterOf();

  await new TokenCredential({
    store,
    config: CONFIG,
    protocol: 'loopback',
    nowMs: () => NOW,
    report,
  }).authorize();

  assert.deepEqual(seen, [{ kind: 'cache-hit' }]);
});

test('regression: a silent refresh says so — otherwise indistinguishable from a cache hit', async () => {
  const { store } = storeOf(ok(cached({ tokens: tokens({ expiresAt: NOW - 1 }) })));
  const { report, seen } = reporterOf();

  await new TokenCredential({
    store,
    config: CONFIG,
    protocol: 'loopback',
    nowMs: () => NOW,
    refresh: async () => ok(tokens({ accessToken: 'a-new-access-token' })),
    report,
  }).authorize();

  assert.deepEqual(
    seen,
    [{ kind: 'refreshed' }],
    'a refresh reported as a cache hit is the false green this exists to end',
  );
});

test('regression: a refusal carries its reason — the one an operator can act on', async () => {
  const { store } = storeOf(
    refuse('token-unavailable', 'no token cache exists on this host yet — sign in first'),
  );
  const { report, seen } = reporterOf();

  await new TokenCredential({
    store,
    config: CONFIG,
    protocol: 'loopback',
    nowMs: () => NOW,
    report,
  }).authorize();

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.kind, 'refused');
  assert.equal(seen[0]?.kind === 'refused' ? seen[0].reason : null, 'token-unavailable');
});

test('regression: no emitted outcome carries token material, on any branch', async () => {
  // The same shape as the refusal-detail pin above, applied to the new lane. A reporter is wired to
  // stdout by the binary, so anything that reaches it is one `cat` away from a shoulder-surfer.
  const secret = 'sh-h-h-secret-token-material';
  const cases: { label: string; credential: TokenCredential; seen: CredentialOutcome[] }[] = [];

  for (const [label, options] of [
    [
      'cache hit',
      {
        store: storeOf(ok(cached({ tokens: tokens({ accessToken: secret, refreshToken: secret }) }))).store,
        nowMs: () => NOW,
      },
    ],
    [
      'refreshed',
      {
        store: storeOf(ok(cached({ tokens: tokens({ expiresAt: NOW - 1, refreshToken: secret }) }))).store,
        nowMs: () => NOW,
        refresh: async () => ok(tokens({ accessToken: secret, refreshToken: secret })),
      },
    ],
    [
      'refused',
      { store: storeOf(refuse('token-unavailable', 'nobody has signed in')).store, nowMs: () => NOW },
    ],
  ] as const) {
    const { report, seen } = reporterOf();
    cases.push({
      label,
      credential: new TokenCredential({ ...options, config: CONFIG, protocol: 'loopback', report }),
      seen,
    });
  }

  for (const one of cases) {
    await one.credential.authorize();
    assert.equal(one.seen.length, 1, `${one.label} reported ${one.seen.length} times, not once`);
    assert.equal(
      JSON.stringify(one.seen).includes(secret),
      false,
      `the ${one.label} outcome carries token material: ${JSON.stringify(one.seen)}`,
    );
  }
});
