/**
 * The token exchange, and the proof that no token reaches a diagnostic.
 *
 * The redaction tests are the point of this file. Everything else here is ordinary parsing. The
 * leak they guard is not hypothetical: the natural way to write an error mapper is to put the
 * provider's body into the message so an operator can see what happened, and a token-endpoint body
 * is where tokens live. A refusal `detail` is written to logs by definition, so that one convenience
 * turns a credential into a log line — permanently, and somewhere nobody thinks to look.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { IdentityConfig } from './config.js';
import {
  EXPIRY_SKEW_MS,
  authorizationValue,
  codeExchangeBody,
  isFresh,
  readTokenResponse,
  redactSecrets,
  refreshBody,
  secretsIn,
} from './token.js';

const CONFIG: IdentityConfig = {
  authority: 'https://example.ciamlogin.com/tenant',
  clientId: 'client-abc',
  scopes: ['openid', 'offline_access'],
  endpoints: null,
  redirectPort: 0,
  deviceCodeEnabled: false,
};

const NOW = 1_800_000_000_000;
const SECRET = 'eyJhbGciOiJSUzI1NiJ9.SUPER-SECRET-TOKEN-VALUE.signature';

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

test('the code-exchange body carries the verifier, the redirect and the grant type', () => {
  const body = new URLSearchParams(
    codeExchangeBody(CONFIG, 'the-code', 'the-verifier', 'http://127.0.0.1:5000/callback'),
  );

  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'the-code');
  assert.equal(body.get('code_verifier'), 'the-verifier');
  assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:5000/callback');
  assert.equal(body.get('client_id'), 'client-abc');
});

test('the code-exchange body carries NO client secret — this is a public client', () => {
  // A public client has no secret to keep, which is why a desktop host can use this flow at all.
  // A secret appearing here would mean one was shipped to every installation.
  const body = new URLSearchParams(codeExchangeBody(CONFIG, 'c', 'v', 'http://127.0.0.1:1/callback'));

  assert.equal(body.get('client_secret'), null);
});

test('the refresh body asks for a refresh grant and carries the refresh token', () => {
  const body = new URLSearchParams(refreshBody(CONFIG, 'the-refresh-token'));

  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'the-refresh-token');
  assert.equal(body.get('scope'), 'openid offline_access');
});

// ---------------------------------------------------------------------------
// Reading responses
// ---------------------------------------------------------------------------

test('a well-formed token response becomes a token set with an absolute expiry', () => {
  const result = readTokenResponse(
    200,
    { access_token: 'at', expires_in: 3600, refresh_token: 'rt', token_type: 'Bearer' },
    NOW,
  );

  assert.ok(result.ok);
  assert.equal(result.value.accessToken, 'at');
  assert.equal(result.value.refreshToken, 'rt');
  assert.equal(result.value.expiresAt, NOW + 3_600_000);
});

test('expires_in arriving as a string still yields a usable expiry', () => {
  // Providers do send it as a string; refusing there would be pedantry that breaks real tenants.
  const result = readTokenResponse(200, { access_token: 'at', expires_in: '3600' }, NOW);

  assert.ok(result.ok);
  assert.equal(result.value.expiresAt, NOW + 3_600_000);
});

test('a missing refresh token is null rather than an error — some providers issue none', () => {
  const result = readTokenResponse(200, { access_token: 'at', expires_in: 60 }, NOW);

  assert.ok(result.ok);
  assert.equal(result.value.refreshToken, null);
});

test('token_type defaults to Bearer when the provider omits it', () => {
  const result = readTokenResponse(200, { access_token: 'at', expires_in: 60 }, NOW);

  assert.ok(result.ok);
  assert.equal(result.value.tokenType, 'Bearer');
});

test('regression: a non-2xx is token-request-failed, and an unusable 2xx is token-response-invalid', () => {
  // The split is the same discipline the permission gate uses: an outage or refusal is the
  // provider's problem, an unusable shape is this host's. Collapsing them merges two investigations.
  //
  // `invalid_grant` is a third answer of its own (see below), so this case is spelled with a
  // transient failure. A non-2xx that a retry might survive is still exactly this reason.
  const refused = readTokenResponse(503, { error: 'temporarily_unavailable' }, NOW);
  const unusable = readTokenResponse(200, { nothing: 'useful' }, NOW);

  assert.equal(refused.ok, false);
  assert.equal(unusable.ok, false);
  assert.equal(refused.ok === false ? refused.refusal.reason : null, 'token-request-failed');
  assert.equal(unusable.ok === false ? unusable.refusal.reason : null, 'token-response-invalid');
});

test('regression: invalid_grant is its own reason, because it is the one no retry survives', () => {
  // RFC 6749 section 5.2: the grant is expired, revoked, or was issued to someone else. Every other
  // non-2xx may come good on the next attempt; this one needs a person. Reported under one shared
  // reason, a host retries a door that cannot open and tells nobody the one thing they could act on.
  const dead = readTokenResponse(400, { error: 'invalid_grant', error_description: 'expired' }, NOW);

  assert.equal(dead.ok, false);
  assert.equal(dead.ok === false ? dead.refusal.reason : null, 'token-grant-rejected');
  assert.match(
    dead.ok === false ? dead.refusal.detail : '',
    /a new sign-in is required/,
    'the detail must name the action, because it is the only one that works',
  );
});

test('the two token failures are DIFFERENT reasons — a control, not a restatement', () => {
  // Without this, both arms above could be edited to the same reason and both would still pass.
  const transient = readTokenResponse(503, { error: 'temporarily_unavailable' }, NOW);
  const terminal = readTokenResponse(400, { error: 'invalid_grant' }, NOW);

  assert.notEqual(
    transient.ok === false ? transient.refusal.reason : 'a',
    terminal.ok === false ? terminal.refusal.reason : 'b',
    'an outage and a dead grant must not collapse back into one word',
  );
});

test('regression: a 2xx with no usable expires_in is refused rather than given a guessed lifetime', () => {
  // Inventing a lifetime would make the host refresh too late (a 401 mid-turn) or forever too early.
  const result = readTokenResponse(200, { access_token: 'at' }, NOW);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.refusal.reason : null, 'token-response-invalid');
  assert.match(result.ok === false ? result.refusal.detail : '', /expires_in/);
});

test('a 2xx body that is not an object at all is refused, not destructured', () => {
  assert.equal(readTokenResponse(200, 'not json', NOW).ok, false);
  assert.equal(readTokenResponse(200, null, NOW).ok, false);
});

test('the provider error code and description reach the operator, because they are the diagnosis', () => {
  const result = readTokenResponse(
    400,
    { error: 'invalid_client', error_description: 'AADSTS7000215: bad secret' },
    NOW,
  );

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.refusal.detail : '', /invalid_client/);
  assert.match(result.ok === false ? result.refusal.detail : '', /AADSTS7000215/);
});

// ---------------------------------------------------------------------------
// No token material in any diagnostic, ever
// ---------------------------------------------------------------------------

test('regression: a token in a failure body never appears in the refusal detail', () => {
  // The shape that leaks: a provider returning non-2xx while still echoing material.
  const body = {
    error: 'invalid_grant',
    error_description: 'expired',
    access_token: SECRET,
    refresh_token: `${SECRET}-refresh`,
  };

  const result = readTokenResponse(400, body, NOW);

  assert.equal(result.ok, false);
  const detail = result.ok === false ? result.refusal.detail : '';
  assert.equal(detail.includes(SECRET), false, `the token leaked into a refusal: ${detail}`);
  assert.equal(detail.includes('SUPER-SECRET-TOKEN-VALUE'), false, detail);
});

test('regression: a token echoed inside the error description is redacted too', () => {
  // The nastier version — the token is not in a token field, it is in the prose.
  const body = {
    error: 'invalid_grant',
    error_description: `the token ${SECRET} has expired`,
    access_token: SECRET,
  };

  const result = readTokenResponse(400, body, NOW);

  const detail = result.ok === false ? result.refusal.detail : '';
  assert.equal(detail.includes(SECRET), false, detail);
  assert.match(detail, /\[redacted\]/);
});

test('regression: a token nested in an error payload is still found and redacted', () => {
  const body = {
    error: 'invalid_grant',
    error_description: `see ${SECRET}`,
    inner: { detail: { access_token: SECRET } },
  };

  const result = readTokenResponse(400, body, NOW);

  assert.equal((result.ok === false ? result.refusal.detail : '').includes(SECRET), false);
});

test('regression: an unusable 2xx body containing a token does not echo the body', () => {
  // There is no error field to quote here, so the tempting implementation is "dump what came back".
  const result = readTokenResponse(200, { access_token: '', refresh_token: SECRET, note: SECRET }, NOW);

  assert.equal(result.ok, false);
  assert.equal((result.ok === false ? result.refusal.detail : '').includes(SECRET), false);
});

test('secretsIn finds credential-shaped values at every depth, and nothing else', () => {
  const found = secretsIn({
    access_token: 'a',
    inner: { refresh_token: 'b', list: [{ id_token: 'c' }] },
    harmless: 'd',
  });

  assert.deepEqual(found.sort(), ['a', 'b', 'c']);
});

test('redactSecrets replaces the longest secret first, so a prefix cannot leave a tail behind', () => {
  // With short-first ordering, redacting "abc" out of "abcdef" leaves "[redacted]def" — the tail is
  // still credential material.
  const text = 'value abcdef and abc';

  assert.equal(redactSecrets(text, ['abc', 'abcdef']), 'value [redacted] and [redacted]');
});

test('redactSecrets ignores an empty secret rather than shredding the whole string', () => {
  assert.equal(redactSecrets('hello', ['']), 'hello');
});

// Guards the SELECTOR: if the fixture token were absent from the body, every leak assertion above
// would pass while proving nothing.
test('control: the fixture token really is in the body being redacted', () => {
  const body = { error: 'x', access_token: SECRET };

  assert.ok(JSON.stringify(body).includes(SECRET));
  assert.deepEqual(secretsIn(body), [SECRET]);
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

test('a token well inside its lifetime is fresh, and an expired one is not', () => {
  const tokens = {
    accessToken: 'a',
    refreshToken: null,
    expiresAt: NOW + 3_600_000,
    tokenType: 'Bearer',
    scope: null,
  };

  assert.equal(isFresh(tokens, NOW), true);
  assert.equal(isFresh({ ...tokens, expiresAt: NOW - 1 }, NOW), false);
});

test('regression: a token expiring inside the skew window is already stale — it would die mid-call', () => {
  const tokens = {
    accessToken: 'a',
    refreshToken: null,
    expiresAt: NOW + EXPIRY_SKEW_MS - 1,
    tokenType: 'Bearer',
    scope: null,
  };

  assert.equal(isFresh(tokens, NOW), false);
});

test('the header value is the token type and the token, in that order', () => {
  assert.equal(
    authorizationValue({
      accessToken: 'at',
      refreshToken: null,
      expiresAt: 0,
      tokenType: 'Bearer',
      scope: null,
    }),
    'Bearer at',
  );
});
