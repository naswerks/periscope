/**
 * The device-code fallback — for a box with no browser on it, which for this package is not an edge
 * case but a deployment target.
 *
 * It is off unless explicitly configured, and it is never reached by falling back. Microsoft's
 * guidance classes device code as a high-risk flow that phishing campaigns exploit and recommends
 * that organisations block it (the Conditional Access authentication-flows documentation,
 * https://learn.microsoft.com/entra/identity/conditional-access/concept-authentication-flows#device-code-flow);
 * it is also exactly what workplace Conditional Access
 * policies block, so a tenant refusing it outright is an expected outcome rather than a bug. A flow
 * with that standing must be asked for by name — silently falling back to it when the loopback
 * listener cannot bind would be the host quietly choosing the riskier option on the operator's
 * behalf, at the moment they are least able to notice.
 *
 * And the trap that is invisible for weeks. A provider that tracks which protocol issued a token
 * marks a refresh token obtained through device code as such, and a later non-device-code refresh
 * against it fails with `AADSTS530036`; the provider's guidance is that such a token is unusable
 * for good and should be deleted.
 * The failure does not appear at sign-in; it appears the first time the token is refreshed, which
 * for an unattended host is hours or weeks later and nowhere near the cause. So a device-code
 * sign-in poisons the cache for any other flow: if this
 * host ever switches a deployment back to loopback, the cached material must be discarded, not
 * refreshed. `discardOnProtocolMismatch` is how that is decided rather than discovered.
 */
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { IdentityConfig } from './config.js';
import { redactSecrets, secretsIn } from './token.js';

/** Which flow minted the material this host holds. Recorded so the trap above is decidable. */
export type AuthProtocol = 'loopback' | 'device-code';

/**
 * The error code the provider returns when a Conditional Access authentication-flows policy
 * rejects a refresh. Named so a reader can search for it.
 *
 * It is not a cross-protocol error, and naming it as one names the wrong cause. `AADSTS530036` is
 * not "you refreshed device-code material with a different flow". Microsoft's documentation
 * describes it as a Conditional Access authentication-flows check refusing the refresh token, and
 * because such a policy applies to every application the token is unusable for good and should be
 * deleted. The mechanism is protocol tracking: a session established with device code stays marked
 * through every later refresh, and the tenant's policy then rejects it, so the trigger is an
 * administrator enabling a policy, not this host being reconfigured. Source:
 * https://learn.microsoft.com/entra/identity/conditional-access/concept-authentication-flows#device-code-flow
 *
 * A cross-protocol name would be dangerous rather than merely inaccurate: it would imply the fix
 * is to sign in again, which re-runs the same flow into the same policy, forever. And it is the
 * policy Microsoft actively recommends: allow device code only where a documented case needs it
 * and block it everywhere else
 * (https://learn.microsoft.com/entra/identity/conditional-access/policy-block-authentication-flows).
 * See `host/sign-in.ts` for the recovery
 * this routes to.
 */
export const AUTH_FLOW_BLOCKED_ERROR = 'AADSTS530036';

/**
 * Every provider code known to mean "a policy has blocked the flow this material was minted by".
 * One today; a provider that reports the same condition under another code is added here, and
 * only here: this file is the one place in the package that may know a provider's error codes.
 */
export const AUTH_FLOW_BLOCKED_CODES: readonly string[] = [AUTH_FLOW_BLOCKED_ERROR];

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  readonly intervalMs: number;
}

/** The provider's answer to one poll. */
export type DevicePollOutcome =
  | { readonly kind: 'pending' }
  /** The provider asked the caller to back off; the caller widens its interval by this much. */
  | { readonly kind: 'slow-down'; readonly intervalMs: number }
  | { readonly kind: 'ready' }
  | { readonly kind: 'declined'; readonly refusal: Refusal };

/**
 * Refuse the device-code flow unless it was turned on.
 *
 * Exported and total so the refusal is reachable in a test rather than being a branch nobody drives.
 */
export function requireDeviceCodeEnabled(config: IdentityConfig): Result<true> {
  if (!config.deviceCodeEnabled) {
    return refuse(
      'device-code-not-enabled',
      'the device-code flow is not enabled on this host; set PERISCOPE_IDENTITY_DEVICE_CODE=1 to allow it, and expect some tenants to refuse it by policy',
    );
  }
  return ok(true);
}

export function deviceAuthorizationBody(config: IdentityConfig): string {
  const body = new URLSearchParams();
  body.set('client_id', config.clientId);
  body.set('scope', config.scopes.join(' '));
  return body.toString();
}

export function devicePollBody(config: IdentityConfig, deviceCode: string): string {
  const body = new URLSearchParams();
  // RFC 8628's grant type, urn-namespaced.
  body.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
  body.set('client_id', config.clientId);
  body.set('device_code', deviceCode);
  return body.toString();
}

export function readDeviceAuthorization(
  status: number,
  body: unknown,
  nowMs: number,
): Result<DeviceAuthorization> {
  const secrets = secretsIn(body);
  if (typeof body !== 'object' || body === null) {
    return refuse(
      'device-code-declined',
      `the device authorization endpoint returned HTTP ${status} with no JSON body`,
    );
  }
  const record = body as Record<string, unknown>;

  if (status < 200 || status >= 300) {
    const error = typeof record['error'] === 'string' ? record['error'] : `HTTP ${status}`;
    return refuse(
      'device-code-declined',
      redactSecrets(
        `the device authorization endpoint refused: ${error} — some tenants block this flow by policy`,
        secrets,
      ),
    );
  }

  const deviceCode = record['device_code'];
  const userCode = record['user_code'];
  const verificationUri = record['verification_uri'] ?? record['verification_url'];
  const expiresIn = Number(record['expires_in']);
  const interval = Number(record['interval']);

  if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
    return refuse(
      'device-code-declined',
      'the device authorization response is missing device_code, user_code or verification_uri',
    );
  }
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    return refuse('device-code-declined', 'the device authorization response carries no usable expires_in');
  }

  return ok({
    deviceCode,
    userCode,
    verificationUri,
    expiresAt: nowMs + expiresIn * 1000,
    // RFC 8628 says default to 5 seconds when the provider does not state an interval.
    intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 5) * 1000,
  });
}

/**
 * Read one poll response.
 *
 * `authorization_pending` and `slow_down` are not failures — they are the protocol working. Mapping
 * them onto a refusal would end a sign-in that was proceeding normally.
 */
export function readDevicePoll(status: number, body: unknown, currentIntervalMs: number): DevicePollOutcome {
  if (status >= 200 && status < 300) return { kind: 'ready' };

  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const error = typeof record['error'] === 'string' ? record['error'] : `http_${status}`;

  if (error === 'authorization_pending') return { kind: 'pending' };
  if (error === 'slow_down') return { kind: 'slow-down', intervalMs: currentIntervalMs + 5_000 };

  const description = typeof record['error_description'] === 'string' ? record['error_description'] : null;
  return {
    kind: 'declined',
    refusal: refusal(
      'device-code-declined',
      redactSecrets(
        description === null
          ? `the device-code sign-in ended: ${error}`
          : `the device-code sign-in ended: ${error} — ${description}`,
        secretsIn(body),
      ),
    ),
  };
}

/**
 * Must cached material be discarded rather than refreshed, because this host was reconfigured?
 *
 * This is not the `AADSTS530036` guard. It detects one real but narrow
 * case: the cache was minted by one flow and the host is now configured for the other, so a refresh
 * would fail for a reason nobody would connect to a sign-in that happened weeks ago.
 *
 * It cannot fire on the policy case, which is the common one. When a tenant enables the
 * authentication-flows policy, the host is still configured for device code and the cache was still
 * minted by device code — `cached === configured`, so this returns `false` and nothing is discarded.
 * A guard named for an error it is structurally unable to catch is worse than no guard, because it
 * reads as coverage. The reactive path in `host/sign-in.ts` is what handles the policy case.
 */
export function discardOnProtocolMismatch(cached: AuthProtocol, configured: AuthProtocol): boolean {
  return cached !== configured;
}

/**
 * Does this provider error mean a Conditional Access authentication-flows policy has blocked this
 * material permanently? Microsoft's documentation: "the token will never be usable and should be
 * deleted."
 */
export function isAuthFlowBlocked(errorText: string): boolean {
  return AUTH_FLOW_BLOCKED_CODES.some((code) => errorText.includes(code));
}
