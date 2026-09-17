/**
 * The authorization request and the callback check that makes the loopback listener safe to open
 * on a machine the agent also runs on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CALLBACK_PAGE,
  buildAuthorizationUrl,
  readAuthorizationCallback,
  redirectUriFor,
} from './authorize.js';
import type { IdentityConfig } from './config.js';
import { createPkce, createState } from './pkce.js';

const CONFIG: IdentityConfig = {
  authority: 'https://example.ciamlogin.com/tenant',
  clientId: 'client-abc',
  scopes: ['openid', 'offline_access'],
  endpoints: null,
  redirectPort: 0,
  deviceCodeEnabled: false,
};

const ENDPOINT = 'https://example.ciamlogin.com/tenant/oauth2/v2.0/authorize';

function build() {
  const pkce = createPkce();
  const state = createState();
  return { pkce, state, request: buildAuthorizationUrl(CONFIG, ENDPOINT, pkce, state, redirectUriFor(5000)) };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

test('the authorization URL carries the code challenge, its method, and the state', () => {
  const { pkce, state, request } = build();
  const params = new URL(request.url).searchParams;

  assert.equal(params.get('code_challenge'), pkce.challenge);
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('state'), state);
  assert.equal(params.get('response_type'), 'code');
});

test('regression: the verifier is never in the authorization URL — only its hash is', () => {
  // Putting the verifier in the URL is exactly what `plain` does, and it hands the property to
  // anything that can read a browser history, a proxy log or the provider's own request record.
  const { pkce, request } = build();

  assert.equal(request.url.includes(pkce.verifier), false, request.url);
});

test('scopes are joined with spaces, which is what the standard asks for', () => {
  const { request } = build();

  assert.equal(new URL(request.url).searchParams.get('scope'), 'openid offline_access');
});

test('regression: the redirect URI is 127.0.0.1, never the name "localhost"', () => {
  // `localhost` can resolve to ::1 or be redefined in a hosts file, and providers match the
  // redirect URI as a literal string — so the registered value and the listener must agree on the
  // exact spelling rather than on a name that resolves.
  assert.equal(redirectUriFor(5000), 'http://127.0.0.1:5000/callback');
  assert.equal(redirectUriFor(5000).includes('localhost'), false);
});

test('the redirect URI in the request is the one that was passed, port and all', () => {
  const { request } = build();

  assert.equal(new URL(request.url).searchParams.get('redirect_uri'), 'http://127.0.0.1:5000/callback');
});

// ---------------------------------------------------------------------------
// The callback
// ---------------------------------------------------------------------------

test("a callback carrying this host's state and a code yields the code", () => {
  const state = createState();
  const result = readAuthorizationCallback(`code=the-code&state=${state}`, state);

  assert.ok(result.ok);
  assert.equal(result.value.code, 'the-code');
});

test("regression: a callback with somebody else's state is refused, and its code is not redeemed", () => {
  // The attack this closes: the agent shares this host's OS user, so any local process can reach
  // the loopback listener and hand it an authorization code it obtained itself.
  const result = readAuthorizationCallback(`code=attacker-code&state=${createState()}`, createState());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.refusal.reason : null, 'auth-state-mismatch');
});

test('regression: a callback with no state at all is refused', () => {
  const result = readAuthorizationCallback('code=the-code', createState());

  assert.equal(result.ok === false ? result.refusal.reason : null, 'auth-state-mismatch');
});

test('regression: the state is checked before the code is read — a good code cannot get in first', () => {
  // Ordering is the property. A callback carrying a perfectly good code and a wrong state must be
  // refused for the state, not accepted for the code. Reading the code first would behave
  // identically in every other test here.
  const result = readAuthorizationCallback('code=perfectly-good-code&state=wrong', createState());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.refusal.reason : null, 'auth-state-mismatch');
});

test('regression: a provider error with the wrong state is a state mismatch, not a provider error', () => {
  // Otherwise an attacker could steer the host's diagnosis by sending an error it did not cause.
  const result = readAuthorizationCallback('error=access_denied&state=wrong', createState());

  assert.equal(result.ok === false ? result.refusal.reason : null, 'auth-state-mismatch');
});

test('regression: no authorization code appears in any refusal detail', () => {
  // A code is redeemable credential material for as long as it lives, and a refusal detail is
  // written to a log by definition.
  const code = 'REDEEMABLE-CODE-VALUE';
  const result = readAuthorizationCallback(`code=${code}&state=wrong-state`, createState());

  // Assert the refusal first. Without this line the test passes vacuously the moment the state
  // check stops refusing — `result.ok === false ? detail : ''` is an empty string that contains no
  // code, so a callback being wrongly accepted would read as "the code did not leak".
  assert.equal(result.ok, false, 'a callback with the wrong state was accepted');
  assert.equal(result.ok === false && result.refusal.detail.includes(code), false);
});

test("a user who declines gets a named refusal carrying the provider's reason", () => {
  const state = createState();
  const result = readAuthorizationCallback(
    `error=access_denied&error_description=user+cancelled&state=${state}`,
    state,
  );

  assert.equal(result.ok === false ? result.refusal.reason : null, 'auth-callback-refused');
  assert.match(result.ok === false ? result.refusal.detail : '', /access_denied/);
});

test('a callback with the right state but neither code nor error is refused, not treated as success', () => {
  const state = createState();
  const result = readAuthorizationCallback(`state=${state}`, state);

  assert.equal(result.ok === false ? result.refusal.reason : null, 'auth-callback-refused');
});

test('an empty code is refused the same as a missing one', () => {
  const state = createState();

  assert.equal(readAuthorizationCallback(`code=&state=${state}`, state).ok, false);
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

test('regression: the callback page reflects nothing and runs nothing', () => {
  // It renders in the user's real, signed-in browser. Anything derived from the query string here
  // would be cross-site scripting in the worst possible context.
  assert.equal(CALLBACK_PAGE.includes('<script'), false);
  assert.equal(/\$\{/.test(CALLBACK_PAGE), false);
});

// Guards the selector: if `readAuthorizationCallback` refused everything, the refusals above prove
// nothing.
test('control: a correct callback really is accepted', () => {
  const state = createState();

  assert.ok(readAuthorizationCallback(`state=${state}&code=c`, state).ok);
});
