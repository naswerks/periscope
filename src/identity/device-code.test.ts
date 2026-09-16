/**
 * The device-code fallback — off unless asked for, the protocol-mismatch guard, and the policy
 * error it recognises.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { IdentityConfig } from './config.js';
import {
  AUTH_FLOW_BLOCKED_ERROR,
  deviceAuthorizationBody,
  devicePollBody,
  discardOnProtocolMismatch,
  isAuthFlowBlocked,
  readDeviceAuthorization,
  readDevicePoll,
  requireDeviceCodeEnabled,
} from './device-code.js';

const NOW = 1_800_000_000_000;

const OFF: IdentityConfig = {
  authority: 'https://example.ciamlogin.com/tenant',
  clientId: 'client-abc',
  scopes: ['openid', 'offline_access'],
  endpoints: null,
  redirectPort: 0,
  deviceCodeEnabled: false,
};
const ON: IdentityConfig = { ...OFF, deviceCodeEnabled: true };

test('regression: the device-code flow refuses by name when it has not been enabled', () => {
  // The provider calls this a high-risk method and recommends blocking it. It must be asked for,
  // never arrived at — a silent fallback would be the host choosing the riskier flow on the
  // operator's behalf at the moment they are least able to notice.
  const result = requireDeviceCodeEnabled(OFF);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.refusal.reason : null, 'device-code-not-enabled');
});

test('the refusal says how to enable it and warns that tenants refuse it', () => {
  const result = requireDeviceCodeEnabled(OFF);

  const detail = result.ok === false ? result.refusal.detail : '';
  assert.match(detail, /PERISCOPE_IDENTITY_DEVICE_CODE/);
  assert.match(detail, /tenants/);
});

test('control: with it enabled, the flow is permitted', () => {
  assert.ok(requireDeviceCodeEnabled(ON).ok);
});

test('the device authorization request carries the client and the scopes', () => {
  const body = new URLSearchParams(deviceAuthorizationBody(ON));

  assert.equal(body.get('client_id'), 'client-abc');
  assert.equal(body.get('scope'), 'openid offline_access');
});

test('the poll body uses the urn-namespaced device-code grant type', () => {
  const body = new URLSearchParams(devicePollBody(ON, 'the-device-code'));

  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(body.get('device_code'), 'the-device-code');
});

test('a device authorization response yields the user code, the URI and an absolute expiry', () => {
  const result = readDeviceAuthorization(
    200,
    {
      device_code: 'dc',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 900,
      interval: 5,
    },
    NOW,
  );

  assert.ok(result.ok);
  assert.equal(result.value.userCode, 'ABCD-EFGH');
  assert.equal(result.value.expiresAt, NOW + 900_000);
  assert.equal(result.value.intervalMs, 5_000);
});

test('a provider spelling it verification_url instead is still understood', () => {
  const result = readDeviceAuthorization(
    200,
    {
      device_code: 'dc',
      user_code: 'u',
      verification_url: 'https://x/dev',
      expires_in: 900,
    },
    NOW,
  );

  assert.ok(result.ok);
  assert.equal(result.value.verificationUri, 'https://x/dev');
});

test('a missing interval defaults to the 5 seconds RFC 8628 states', () => {
  const result = readDeviceAuthorization(
    200,
    { device_code: 'dc', user_code: 'u', verification_uri: 'https://x', expires_in: 900 },
    NOW,
  );

  assert.ok(result.ok);
  assert.equal(result.value.intervalMs, 5_000);
});

test('regression: a tenant refusing the flow is a named refusal that says tenants refuse it', () => {
  // This is an expected outcome, not a bug — and an operator who does not know that will spend the
  // afternoon looking for one.
  const result = readDeviceAuthorization(400, { error: 'unauthorized_client' }, NOW);

  assert.equal(result.ok === false ? result.refusal.reason : null, 'device-code-declined');
  assert.match(result.ok === false ? result.refusal.detail : '', /policy/);
});

test('an incomplete device authorization response is refused rather than half-used', () => {
  assert.equal(readDeviceAuthorization(200, { device_code: 'dc' }, NOW).ok, false);
  assert.equal(
    readDeviceAuthorization(200, { device_code: 'dc', user_code: 'u', verification_uri: 'https://x' }, NOW)
      .ok,
    false,
  );
  assert.equal(readDeviceAuthorization(200, 'not json', NOW).ok, false);
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

test('regression: authorization_pending is the protocol working, not a failure', () => {
  // Mapping it to a refusal would end a sign-in that is proceeding normally — the user is still
  // typing the code into their browser.
  assert.equal(readDevicePoll(400, { error: 'authorization_pending' }, 5_000).kind, 'pending');
});

test('slow_down widens the interval rather than ending the sign-in', () => {
  const outcome = readDevicePoll(400, { error: 'slow_down' }, 5_000);

  assert.equal(outcome.kind, 'slow-down');
  assert.equal(outcome.kind === 'slow-down' ? outcome.intervalMs : 0, 10_000);
});

test('a 2xx poll means the token is ready', () => {
  assert.equal(readDevicePoll(200, { access_token: 'at' }, 5_000).kind, 'ready');
});

test('expired_token and access_denied end the sign-in with a named refusal', () => {
  for (const error of ['expired_token', 'access_denied']) {
    const outcome = readDevicePoll(400, { error }, 5_000);
    assert.equal(outcome.kind, 'declined', error);
    assert.equal(outcome.kind === 'declined' ? outcome.refusal.reason : null, 'device-code-declined');
  }
});

test('regression: a token echoed in a poll error never reaches the refusal detail', () => {
  const secret = 'SECRET-DEVICE-TOKEN';
  const outcome = readDevicePoll(
    400,
    { error: 'expired_token', error_description: `for ${secret}`, access_token: secret },
    5_000,
  );

  assert.equal(outcome.kind, 'declined');
  assert.equal(outcome.kind === 'declined' ? outcome.refusal.detail.includes(secret) : true, false);
});

// ---------------------------------------------------------------------------
// The protocol-mismatch guard, and the policy error code
// ---------------------------------------------------------------------------

test('regression: material minted by device code is discarded when the host is set to loopback', () => {
  // Material minted by one flow is discarded when the host is configured for the other: a refresh
  // across flows fails for a reason nobody would connect to a sign-in weeks earlier. Deciding it
  // here turns an unexplainable future failure into one sign-in today.
  assert.equal(discardOnProtocolMismatch('device-code', 'loopback'), true);
  assert.equal(discardOnProtocolMismatch('loopback', 'device-code'), true);
});

test('matching protocols keep the cache — the guard is not simply discarding everything', () => {
  assert.equal(discardOnProtocolMismatch('loopback', 'loopback'), false);
  assert.equal(discardOnProtocolMismatch('device-code', 'device-code'), false);
});

test('regression: the authentication-flows policy error code is recognised in a provider message', () => {
  assert.equal(AUTH_FLOW_BLOCKED_ERROR, 'AADSTS530036');
  assert.equal(isAuthFlowBlocked('AADSTS530036: the token will never be usable'), true);
  assert.equal(isAuthFlowBlocked('AADSTS70008: expired'), false);
});
