/**
 * Configuration, and the named refusal when there is none.
 *
 * The refusal is the feature here. A host that quietly ran unauthenticated, or fell back to a
 * built-in tenant, would be a host whose identity nobody could state. Absence has a name and a
 * message that says which two settings are missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SCOPES,
  discoveryUrl,
  identityPosture,
  readDiscoveryDocument,
  readIdentityConfig,
} from './config.js';

const MINIMAL: NodeJS.ProcessEnv = {
  PERISCOPE_IDENTITY_AUTHORITY: 'https://example.ciamlogin.com/tenant',
  PERISCOPE_IDENTITY_CLIENT_ID: 'client-abc',
};

test('regression: an unconfigured host refuses by name rather than defaulting to anything', () => {
  const result = readIdentityConfig({});

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.refusal.reason : null, 'identity-not-configured');
});

test('the refusal names both settings, so the fix does not need the source', () => {
  const result = readIdentityConfig({});

  const detail = result.ok === false ? result.refusal.detail : '';
  assert.match(detail, /PERISCOPE_IDENTITY_AUTHORITY/);
  assert.match(detail, /PERISCOPE_IDENTITY_CLIENT_ID/);
});

test('an authority with no client id is still "not configured", not half-configured', () => {
  const result = readIdentityConfig({ PERISCOPE_IDENTITY_AUTHORITY: 'https://example.com/t' });

  assert.equal(result.ok === false ? result.refusal.reason : null, 'identity-not-configured');
});

test('a whitespace-only value counts as absent', () => {
  const result = readIdentityConfig({ ...MINIMAL, PERISCOPE_IDENTITY_CLIENT_ID: '   ' });

  assert.equal(result.ok === false ? result.refusal.reason : null, 'identity-not-configured');
});

test('regression: not-configured and configured-wrong are different reasons — different fixes', () => {
  const absent = readIdentityConfig({});
  const wrong = readIdentityConfig({ ...MINIMAL, PERISCOPE_IDENTITY_AUTHORITY: 'not-a-url' });

  assert.equal(absent.ok === false ? absent.refusal.reason : null, 'identity-not-configured');
  assert.equal(wrong.ok === false ? wrong.refusal.reason : null, 'identity-config-invalid');
});

test('regression: a plaintext authority is refused — localhost included, deliberately', () => {
  // "It is only the test environment" is how a cleartext token exchange reaches production.
  for (const authority of ['http://example.com/t', 'http://localhost:8080/t', 'http://127.0.0.1/t']) {
    const result = readIdentityConfig({ ...MINIMAL, PERISCOPE_IDENTITY_AUTHORITY: authority });
    assert.equal(result.ok, false, `${authority} was accepted`);
    assert.equal(result.ok === false ? result.refusal.reason : null, 'identity-config-invalid');
  }
});

test('a minimal valid configuration yields the default scopes', () => {
  const result = readIdentityConfig(MINIMAL);

  assert.ok(result.ok);
  assert.deepEqual(result.value.scopes, DEFAULT_SCOPES);
});

test('regression: offline_access is in the default scopes — without it every expiry is a sign-in', () => {
  assert.ok(DEFAULT_SCOPES.includes('offline_access'));
});

test('scopes may be given space- or comma-separated, because both spellings are in the wild', () => {
  const spaced = readIdentityConfig({ ...MINIMAL, PERISCOPE_IDENTITY_SCOPES: 'openid api://x/y' });
  const commas = readIdentityConfig({ ...MINIMAL, PERISCOPE_IDENTITY_SCOPES: 'openid,api://x/y' });

  assert.ok(spaced.ok && commas.ok);
  assert.deepEqual(spaced.value.scopes, ['openid', 'api://x/y']);
  assert.deepEqual(commas.value.scopes, ['openid', 'api://x/y']);
});

test('an explicitly empty scope list is refused rather than silently defaulted', () => {
  const result = readIdentityConfig({ ...MINIMAL, PERISCOPE_IDENTITY_SCOPES: '  ,  ' });

  assert.equal(result.ok === false ? result.refusal.reason : null, 'identity-config-invalid');
});

test('regression: the device-code flow is off unless it is turned on by name', () => {
  const off = readIdentityConfig(MINIMAL);
  const alsoOff = readIdentityConfig({ ...MINIMAL, PERISCOPE_IDENTITY_DEVICE_CODE: 'true' });
  const on = readIdentityConfig({ ...MINIMAL, PERISCOPE_IDENTITY_DEVICE_CODE: '1' });

  assert.equal(off.ok && off.value.deviceCodeEnabled, false);
  // Only the exact opt-in counts: a flow the provider recommends blocking must not be enabled by a
  // value somebody typed hoping it would mean yes.
  assert.equal(alsoOff.ok && alsoOff.value.deviceCodeEnabled, false);
  assert.equal(on.ok && on.value.deviceCodeEnabled, true);
});

test('the redirect port defaults to 0, which asks the OS for a free one', () => {
  const result = readIdentityConfig(MINIMAL);

  assert.ok(result.ok);
  assert.equal(result.value.redirectPort, 0);
});

test('a nonsense redirect port is refused rather than coerced to zero', () => {
  for (const port of ['abc', '-1', '70000', '80.5']) {
    const result = readIdentityConfig({ ...MINIMAL, PERISCOPE_IDENTITY_REDIRECT_PORT: port });
    assert.equal(result.ok, false, `${port} was accepted`);
  }
});

test('regression: half-stated endpoints are refused — the other half would come from elsewhere', () => {
  const result = readIdentityConfig({ ...MINIMAL, PERISCOPE_IDENTITY_AUTHORIZE_URL: 'https://x/authorize' });

  assert.equal(result.ok === false ? result.refusal.reason : null, 'identity-config-invalid');
});

test('stated endpoints are used as given, and unstated ones mean discovery', () => {
  const stated = readIdentityConfig({
    ...MINIMAL,
    PERISCOPE_IDENTITY_AUTHORIZE_URL: 'https://x/authorize',
    PERISCOPE_IDENTITY_TOKEN_URL: 'https://x/token',
  });
  const discovered = readIdentityConfig(MINIMAL);

  assert.ok(stated.ok && discovered.ok);
  assert.equal(stated.value.endpoints?.authorizationEndpoint, 'https://x/authorize');
  assert.equal(discovered.value.endpoints, null);
});

// ---------------------------------------------------------------------------
// The composition root's decision
// ---------------------------------------------------------------------------

test('nothing configured means the host starts without identity, as it did before identity existed', () => {
  assert.equal(identityPosture({}).kind, 'absent');
});

test('a full configuration means the host builds the real credential', () => {
  const posture = identityPosture(MINIMAL);

  assert.equal(posture.kind, 'configured');
  assert.equal(posture.kind === 'configured' ? posture.config.clientId : null, 'client-abc');
});

test('regression: configured-wrong refuses to start; it must never degrade to configured-not-at-all', () => {
  // An operator who set an authority and mistyped it has stated an intention. Starting without
  // identity would honour the typo instead of the intention, and the host would come up looking
  // healthy while authenticating as nobody.
  const posture = identityPosture({
    ...MINIMAL,
    PERISCOPE_IDENTITY_AUTHORITY: 'http://plaintext.example.com/t',
  });

  assert.equal(posture.kind, 'invalid');
  assert.notEqual(posture.kind, 'absent');
});

test('every invalid posture carries a detail an operator can act on', () => {
  const posture = identityPosture({ ...MINIMAL, PERISCOPE_IDENTITY_REDIRECT_PORT: 'not-a-port' });

  assert.equal(posture.kind, 'invalid');
  assert.match(posture.kind === 'invalid' ? posture.detail : '', /PERISCOPE_IDENTITY_REDIRECT_PORT/);
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('regression: the discovery URL keeps the tenant path — a naive join would drop it', () => {
  // `new URL('.well-known/…', 'https://host/tenant')` resolves against the directory, so without the
  // trailing slash the tenant segment disappears and every request goes to the wrong tenant.
  assert.equal(
    discoveryUrl('https://example.ciamlogin.com/tenant'),
    'https://example.ciamlogin.com/tenant/.well-known/openid-configuration',
  );
});

test('an authority already ending in a slash does not produce a doubled one', () => {
  assert.equal(
    discoveryUrl('https://example.com/tenant/'),
    'https://example.com/tenant/.well-known/openid-configuration',
  );
});

test('a discovery document yields the endpoints it advertises', () => {
  const result = readDiscoveryDocument({
    authorization_endpoint: 'https://x/authorize',
    token_endpoint: 'https://x/token',
    device_authorization_endpoint: 'https://x/devicecode',
  });

  assert.ok(result.ok);
  assert.equal(result.value.tokenEndpoint, 'https://x/token');
  assert.equal(result.value.deviceAuthorizationEndpoint, 'https://x/devicecode');
});

test('a provider that advertises no device endpoint yields null rather than a guessed URL', () => {
  const result = readDiscoveryDocument({
    authorization_endpoint: 'https://x/a',
    token_endpoint: 'https://x/t',
  });

  assert.ok(result.ok);
  assert.equal(result.value.deviceAuthorizationEndpoint, null);
});

test('a discovery document missing a required endpoint is refused', () => {
  assert.equal(readDiscoveryDocument({ token_endpoint: 'https://x/t' }).ok, false);
  assert.equal(readDiscoveryDocument('not an object').ok, false);
  assert.equal(readDiscoveryDocument(null).ok, false);
});

// Guards the selector: if `readIdentityConfig` refused everything, most assertions above would pass.
test('control: a realistic configuration is actually accepted', () => {
  const result = readIdentityConfig({
    ...MINIMAL,
    PERISCOPE_IDENTITY_SCOPES: 'openid offline_access api://f67d40c6/general_access',
    PERISCOPE_IDENTITY_REDIRECT_PORT: '0',
  });

  assert.ok(result.ok, result.ok === false ? result.refusal.detail : '');
  assert.equal(result.value.clientId, 'client-abc');
});
