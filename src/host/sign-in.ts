/**
 * The assembly: the one place the identity parts become a working sign-in.
 *
 * Why this file exists at all: a set of individually correct parts with nothing composing them is a
 * failure mode (a gate, an observer and a session each proven, with nothing wiring them together,
 * so a default session runs ungated). Identity has exactly the same shape: a config reader, a PKCE
 * generator, a listener, a token parser and a cache are five green modules and zero working
 * sign-ins. This is the sixth thing, and without it the other five are a claim rather than a
 * capability.
 *
 * The transport is injected. `fetch` and the browser-opener are parameters, so the whole flow
 * (discovery, redemption, refresh, and every failure in them) is exercised against a real local HTTP
 * server in the tests rather than against a mock of one. What is not exercised is a real identity
 * provider; that needs an app registration, which is a human act and deliberately not this code's.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { Ticker } from '../core/time.js';
import { systemTicker } from '../core/time.js';
import type { IdentityConfig, IdentityEndpoints } from '../identity/config.js';
import { discoveryUrl, readDiscoveryDocument } from '../identity/config.js';
import { buildAuthorizationUrl, readAuthorizationCallback } from '../identity/authorize.js';
import { createPkce, createState } from '../identity/pkce.js';
import type { AuthProtocol } from '../identity/device-code.js';
import {
  deviceAuthorizationBody,
  devicePollBody,
  AUTH_FLOW_BLOCKED_ERROR,
  isAuthFlowBlocked,
  readDeviceAuthorization,
  readDevicePoll,
  requireDeviceCodeEnabled,
} from '../identity/device-code.js';
import type { CachedTokens, TokenStore } from '../identity/store.js';
import type { TokenRefresher } from '../identity/credential.js';
import type { TokenSet } from '../identity/token.js';
import { codeExchangeBody, readTokenResponse, refreshBody } from '../identity/token.js';
import { DEFAULT_SIGN_IN_TIMEOUT_MS, openLoopbackListener } from './loopback.js';

/** The injectable edges. Every one has a real default; the tests replace the transport. */
export interface SignInDeps {
  readonly fetch?: typeof globalThis.fetch;
  /** Told where to send the user. Defaults to printing the URL, which works on a headless box. */
  readonly present?: (url: string) => void;
  readonly timeoutMs?: number;
  readonly nowMs?: Ticker;
  /** Injected so a device-code poll loop is testable without real waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** A `fetch` that never throws: a transport error becomes a named refusal like any other outcome. */
async function post(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: string,
): Promise<Result<{ status: number; body: unknown }>> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers: FORM, body });
  } catch (error) {
    // A transport failure is an outage, not a refusal by the provider. Reading them as the same
    // thing is how a network blip gets diagnosed as a bad credential.
    return refuse('token-request-failed', `the token endpoint could not be reached: ${String(error)}`);
  }
  return ok({ status: response.status, body: await readJson(response) });
}

/** A body that is not JSON is `null`, and the reader above decides what that means. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The endpoints, from configuration or from the provider's discovery document.
 *
 * Stated endpoints win and skip the network entirely — an operator who pinned them gets no
 * surprise round trip, and an air-gapped or proxied deployment can work without discovery at all.
 */
export async function resolveEndpoints(
  config: IdentityConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result<IdentityEndpoints>> {
  if (config.endpoints !== null) return ok(config.endpoints);

  let response: Response;
  try {
    response = await fetchImpl(discoveryUrl(config.authority));
  } catch (error) {
    return refuse(
      'identity-config-invalid',
      `the provider's discovery document could not be fetched: ${String(error)}`,
    );
  }
  if (!response.ok) {
    return refuse(
      'identity-config-invalid',
      `the provider's discovery document returned HTTP ${response.status}`,
    );
  }
  return readDiscoveryDocument(await readJson(response));
}

/**
 * Sign a user in through the loopback redirect, and persist what comes back.
 *
 * The listener is opened before the authorization URL is built, because the redirect URI has to
 * carry the port the OS actually gave. Building the URL first would mean either guessing a port
 * or fixing one, and a fixed port collides with whatever else is running on a developer's machine.
 *
 * And the listener is closed on every path. It is a socket accepting callbacks; leaving it open
 * after a failed exchange would leave the thing this flow exists to bound still bound.
 */
export async function signIn(
  config: IdentityConfig,
  store: TokenStore,
  deps: SignInDeps = {},
): Promise<Result<CachedTokens>> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const nowMs = deps.nowMs ?? systemTicker;
  const present = deps.present ?? ((url: string) => process.stdout.write(`open this to sign in:\n${url}\n`));

  const endpoints = await resolveEndpoints(config, fetchImpl);
  if (!endpoints.ok) return refuse(endpoints.refusal.reason, endpoints.refusal.detail);

  const opened = await openLoopbackListener(
    config.redirectPort,
    deps.timeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS,
  );
  if (!opened.ok) return refuse(opened.refusal.reason, opened.refusal.detail);
  const listener = opened.value;

  try {
    const pkce = createPkce();
    const state = createState();
    const request = buildAuthorizationUrl(
      config,
      endpoints.value.authorizationEndpoint,
      pkce,
      state,
      listener.redirectUri,
    );

    present(request.url);

    const arrived = await listener.callback;
    if (!arrived.ok) return refuse(arrived.refusal.reason, arrived.refusal.detail);

    // The `state` check lives here, in the pure reader, and it runs before the code is touched.
    const callback = readAuthorizationCallback(arrived.value, state);
    if (!callback.ok) return refuse(callback.refusal.reason, callback.refusal.detail);

    const exchanged = await post(
      fetchImpl,
      endpoints.value.tokenEndpoint,
      codeExchangeBody(config, callback.value.code, pkce.verifier, listener.redirectUri),
    );
    if (!exchanged.ok) return refuse(exchanged.refusal.reason, exchanged.refusal.detail);

    const tokens = readTokenResponse(exchanged.value.status, exchanged.value.body, nowMs());
    if (!tokens.ok) return refuse(tokens.refusal.reason, tokens.refusal.detail);

    const cached: CachedTokens = {
      tokens: tokens.value,
      protocol: 'loopback',
      authority: config.authority,
      clientId: config.clientId,
    };

    // A cache that would not write is a failed sign-in, and that is the opposite of the rule in
    // `credential.ts`. There, a refresh had already succeeded and the token was in hand. Here the
    // whole point was to persist it: returning success would tell the operator they are signed in
    // while the next start finds nothing.
    const written = store.write(cached);
    if (!written.ok) return refuse(written.refusal.reason, written.refusal.detail);

    return ok(cached);
  } finally {
    listener.close();
  }
}

/** What a device-code sign-in tells the operator to do, before it starts waiting. */
export interface DeviceCodeInstruction {
  readonly verificationUri: string;
  readonly userCode: string;
}

/**
 * Sign in through the device-code flow, for a box with no browser on it.
 *
 * It refuses unless it was explicitly enabled, and that check is the first thing here. The
 * provider calls this a high-risk method and recommends blocking it; a tenant refusing it outright
 * is an expected outcome. It must be asked for by name, never arrived at by falling back — see
 * `identity/device-code.ts` for the policy-blocked-flow trap it also carries.
 *
 * The poll interval is the provider's, not this package's, and `slow_down` widens it. Polling faster than
 * asked is how a client gets rate-limited into failing a sign-in that would have worked.
 */
export async function signInWithDeviceCode(
  config: IdentityConfig,
  store: TokenStore,
  instruct: (instruction: DeviceCodeInstruction) => void,
  deps: SignInDeps = {},
): Promise<Result<CachedTokens>> {
  const enabled = requireDeviceCodeEnabled(config);
  if (!enabled.ok) return refuse(enabled.refusal.reason, enabled.refusal.detail);

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const nowMs = deps.nowMs ?? systemTicker;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const endpoints = await resolveEndpoints(config, fetchImpl);
  if (!endpoints.ok) return refuse(endpoints.refusal.reason, endpoints.refusal.detail);

  const deviceEndpoint = endpoints.value.deviceAuthorizationEndpoint;
  if (deviceEndpoint === null) {
    return refuse('device-code-declined', 'this provider does not advertise a device authorization endpoint');
  }

  const started = await post(fetchImpl, deviceEndpoint, deviceAuthorizationBody(config));
  if (!started.ok) return refuse(started.refusal.reason, started.refusal.detail);

  const authorization = readDeviceAuthorization(started.value.status, started.value.body, nowMs());
  if (!authorization.ok) return refuse(authorization.refusal.reason, authorization.refusal.detail);

  instruct({ verificationUri: authorization.value.verificationUri, userCode: authorization.value.userCode });

  let intervalMs = authorization.value.intervalMs;
  const body = devicePollBody(config, authorization.value.deviceCode);

  while (nowMs() < authorization.value.expiresAt) {
    await sleep(intervalMs);

    const polled = await post(fetchImpl, endpoints.value.tokenEndpoint, body);
    if (!polled.ok) return refuse(polled.refusal.reason, polled.refusal.detail);

    const outcome = readDevicePoll(polled.value.status, polled.value.body, intervalMs);
    if (outcome.kind === 'pending') continue;
    if (outcome.kind === 'slow-down') {
      intervalMs = outcome.intervalMs;
      continue;
    }
    if (outcome.kind === 'declined') return refuse(outcome.refusal.reason, outcome.refusal.detail);

    const tokens = readTokenResponse(polled.value.status, polled.value.body, nowMs());
    if (!tokens.ok) return refuse(tokens.refusal.reason, tokens.refusal.detail);

    const cached: CachedTokens = {
      tokens: tokens.value,
      // Stamped `device-code`, and that stamp is what makes the blocked-flow guard possible. A
      // cache that does not record which flow minted it cannot be refreshed safely by either.
      protocol: 'device-code',
      authority: config.authority,
      clientId: config.clientId,
    };

    const written = store.write(cached);
    if (!written.ok) return refuse(written.refusal.reason, written.refusal.detail);
    return ok(cached);
  }

  return refuse('device-code-declined', 'the device code expired before the sign-in was completed');
}

/**
 * The refresher `TokenCredential` calls when its cached token has expired.
 *
 * An authentication-flows block discards the cache and names the flow to stop using. It does
 * not say "sign in again".
 *
 * Why not: a blocked-flow refusal is the provider's policy refusing the flow (see
 * `identity/device-code.ts`), so the trigger is a tenant admin enabling a policy, not a
 * reconfiguration here. A refresher that cleared the cache and told the operator to sign in again
 * would loop: `protocolFor` derives the flow from static config, so "again" would mean the same
 * device-code flow, into the same policy. Unattended, that is refresh, blocked, clear, device code,
 * blocked, repeat, never holding a usable token. A recovery path that returns to the failing state
 * is not a recovery path.
 *
 * So it routes to the flow that is not blocked. The policy targets device code; loopback
 * authorization-code plus PKCE is implemented here (`identity/authorize.ts`, `identity/pkce.ts`).
 * When loopback is available the refusal says to use it; when it is not, the refusal refuses by
 * name and tells the operator which setting to change, rather than inviting a retry that cannot
 * succeed.
 */
export function refresherFor(
  config: IdentityConfig,
  endpoints: IdentityEndpoints,
  store: TokenStore,
  deps: SignInDeps = {},
): TokenRefresher {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const nowMs = deps.nowMs ?? systemTicker;

  return async (cached: CachedTokens): Promise<Result<TokenSet>> => {
    const refreshToken = cached.tokens.refreshToken;
    if (refreshToken === null) {
      return refuse(
        'token-unavailable',
        'the cached token has no refresh token, so it cannot be renewed without signing in',
      );
    }

    const response = await post(fetchImpl, endpoints.tokenEndpoint, refreshBody(config, refreshToken));
    if (!response.ok) return refuse(response.refusal.reason, response.refusal.detail);

    const tokens = readTokenResponse(response.value.status, response.value.body, nowMs());
    if (!tokens.ok) {
      if (isAuthFlowBlocked(tokens.refusal.detail)) {
        // Cleared either way: the provider's own guidance is that such material is unusable for good
        // and should be deleted. What differs is what the operator is told to do next.
        store.clear();

        // The fallback is only a fallback if it is a different flow. Naming loopback while the
        // host is configured for loopback would be the same loop with a new label.
        const blockedFlow = protocolFor(config);
        if (blockedFlow === 'device-code') {
          return refuse(
            'token-unavailable',
            `the identity provider's policy has blocked the DEVICE CODE flow this material was minted by ` +
              `(provider code ${AUTH_FLOW_BLOCKED_ERROR}); the token can never be refreshed and the cache has been ` +
              `discarded. Do not re-run the device code flow: the same policy will block it, every time. Set ` +
              `deviceCodeEnabled: false (for the binary, unset PERISCOPE_IDENTITY_DEVICE_CODE) to use the loopback ` +
              `authorization-code (PKCE) flow, which such a policy does not target, or have the provider's ` +
              `administrator exempt this application.`,
          );
        }

        return refuse(
          'token-unavailable',
          `the identity provider's policy has blocked this material (provider code ${AUTH_FLOW_BLOCKED_ERROR}) ` +
            `and the cache has been discarded. This host is ALREADY configured for the loopback flow, so there is ` +
            `no unblocked flow left to fall back to: the policy must be changed by the provider's administrator. ` +
            `Retrying will not help.`,
        );
      }
      return refuse(tokens.refusal.reason, tokens.refusal.detail);
    }

    return tokens;
  };
}

/** Which flow a host configured this way will use. One place, so the cache is stamped consistently. */
export function protocolFor(config: IdentityConfig): AuthProtocol {
  return config.deviceCodeEnabled ? 'device-code' : 'loopback';
}
