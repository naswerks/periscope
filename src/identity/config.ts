/**
 * What this host needs to know before it can sign anyone in — and the named refusal when it does
 * not know it.
 *
 * The authority is config, never a constant. That is the one thing this module exists to
 * guarantee. A hardcoded issuer would make the package work for exactly one tenant and look like it
 * worked for everyone, and it is the difference between something a stranger can point at their own
 * provider and something only its authors can run. `pins/identity-generic.test.ts` scans the source
 * for an embedded authority host, so this cannot regress quietly.
 *
 * Absence is a refusal with a name, not a default. There is no fallback issuer, no implicit
 * tenant, and no "unauthenticated mode" — a host that cannot prove who it is does not connect. The
 * two unset/invalid reasons are kept apart because they are different people's problems: nothing
 * configured is a setup step nobody has done, and a bad value is a setup step done wrong.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';

/**
 * The endpoints an OAuth 2.0 authorization-code exchange needs.
 *
 * Separate from the config because there are two honest ways to get them — the operator states
 * them, or they are read from the provider's discovery document — and the flow should not care
 * which happened.
 */
export interface IdentityEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** Null when the provider does not advertise the device-code grant. */
  readonly deviceAuthorizationEndpoint: string | null;
}

export interface IdentityConfig {
  /**
   * The issuer this host authenticates against.
   *
   * A consumer-identity (CIAM) authority is typically single-tenant — so a workplace's employees
   * cannot sign in to it. The answer to that is a registration in the workplace's own tenant
   * pointed at by this value, which costs no code precisely because this is a setting. See the
   * README's deployment note.
   */
  readonly authority: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  /** Explicitly stated endpoints; null means "read the discovery document". */
  readonly endpoints: IdentityEndpoints | null;
  /** Loopback redirect port. 0 asks the OS for a free one, which is the ordinary case. */
  readonly redirectPort: number;
  /**
   * Off unless the operator turns it on. The device-code grant is never reached by falling back
   * to it — see `device-code.ts` for why the provider itself recommends blocking it.
   */
  readonly deviceCodeEnabled: boolean;
}

/**
 * `offline_access` is in the default set deliberately: without a refresh token every access token
 * expiring means an interactive sign-in, and this host is meant to run unattended.
 */
export const DEFAULT_SCOPES: readonly string[] = ['openid', 'profile', 'offline_access'];

const REQUIRED = 'PERISCOPE_IDENTITY_AUTHORITY and PERISCOPE_IDENTITY_CLIENT_ID';

function trimmed(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Is this a usable issuer URL?
 *
 * HTTPS is required and `localhost` is not exempted. A plaintext authority would put the
 * authorization code and then the token itself on the wire in clear, and "it is only the test
 * environment" is how that reaches production. A provider being tested locally is reached through
 * its real https endpoint like any other.
 */
function invalidAuthority(authority: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(authority);
  } catch {
    return `PERISCOPE_IDENTITY_AUTHORITY is not a URL: ${authority}`;
  }
  if (parsed.protocol !== 'https:') {
    return `PERISCOPE_IDENTITY_AUTHORITY must be https, got ${parsed.protocol}//`;
  }
  return null;
}

/** Endpoints are all-or-nothing: a half-stated set is a config error, never a partial default. */
function readEndpoints(env: NodeJS.ProcessEnv): Result<IdentityEndpoints | null> {
  const authorizationEndpoint = trimmed(env, 'PERISCOPE_IDENTITY_AUTHORIZE_URL');
  const tokenEndpoint = trimmed(env, 'PERISCOPE_IDENTITY_TOKEN_URL');
  const deviceAuthorizationEndpoint = trimmed(env, 'PERISCOPE_IDENTITY_DEVICE_CODE_URL');

  if (authorizationEndpoint === null && tokenEndpoint === null) {
    // Neither stated: discovery will supply both. The device endpoint alone is not enough to act on.
    return ok(null);
  }
  if (authorizationEndpoint === null || tokenEndpoint === null) {
    return refuse(
      'identity-config-invalid',
      'PERISCOPE_IDENTITY_AUTHORIZE_URL and PERISCOPE_IDENTITY_TOKEN_URL must be set together or not at all — a half-stated endpoint set would silently discover the other half and mix two providers',
    );
  }
  return ok({ authorizationEndpoint, tokenEndpoint, deviceAuthorizationEndpoint });
}

function readPort(env: NodeJS.ProcessEnv): Result<number> {
  const raw = trimmed(env, 'PERISCOPE_IDENTITY_REDIRECT_PORT');
  if (raw === null) return ok(0);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return refuse(
      'identity-config-invalid',
      `PERISCOPE_IDENTITY_REDIRECT_PORT must be an integer 0-65535, got ${raw}`,
    );
  }
  return ok(port);
}

/**
 * Read the identity configuration, or say precisely what is missing.
 *
 * The environment is passed in rather than read, matching the rest of the package: the composition
 * root supplies the environment, helpers only default to `process.env` when called bare, and every
 * module below the root is testable without a process.
 */
export function readIdentityConfig(env: NodeJS.ProcessEnv): Result<IdentityConfig> {
  const authority = trimmed(env, 'PERISCOPE_IDENTITY_AUTHORITY');
  const clientId = trimmed(env, 'PERISCOPE_IDENTITY_CLIENT_ID');

  if (authority === null || clientId === null) {
    return refuse(
      'identity-not-configured',
      `${REQUIRED} must both be set; this host does not authenticate without them and has no default issuer`,
    );
  }

  const badAuthority = invalidAuthority(authority);
  if (badAuthority !== null) return refuse('identity-config-invalid', badAuthority);

  const endpoints = readEndpoints(env);
  if (!endpoints.ok) return refuse(endpoints.refusal.reason, endpoints.refusal.detail);

  const port = readPort(env);
  if (!port.ok) return refuse(port.refusal.reason, port.refusal.detail);

  const rawScopes = trimmed(env, 'PERISCOPE_IDENTITY_SCOPES');
  const scopes =
    rawScopes === null ? DEFAULT_SCOPES : rawScopes.split(/[\s,]+/).filter((scope) => scope !== '');

  if (scopes.length === 0) {
    return refuse('identity-config-invalid', 'PERISCOPE_IDENTITY_SCOPES was set but lists no scope');
  }

  return ok({
    authority,
    clientId,
    scopes,
    endpoints: endpoints.value,
    redirectPort: port.value,
    deviceCodeEnabled: trimmed(env, 'PERISCOPE_IDENTITY_DEVICE_CODE') === '1',
  });
}

/**
 * What the composition root should do about identity, decided here so `bin/` stays a wiring file.
 *
 * The three-way split is the point, and the middle one is the easy mistake. "Configured wrong"
 * must not degrade to "not configured": an operator who set an authority and mistyped it has stated
 * an intention, and silently starting without identity would honour the typo instead of the
 * intention — the host would come up looking healthy and authenticate as nobody.
 *
 *   configured    — build the real credential.
 *   absent        — nothing was set. Start without identity; the existing credential refuses by
 *                   name, which is exactly what this host did before identity existed.
 *   invalid       — something was set and cannot be used. Refuse to start.
 */
export type IdentityPosture =
  | { readonly kind: 'configured'; readonly config: IdentityConfig }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly detail: string };

export function identityPosture(env: NodeJS.ProcessEnv): IdentityPosture {
  const result = readIdentityConfig(env);
  if (result.ok) return { kind: 'configured', config: result.value };
  if (result.refusal.reason === 'identity-not-configured') return { kind: 'absent' };
  return { kind: 'invalid', detail: result.refusal.detail };
}

/**
 * The provider's discovery document URL.
 *
 * OpenID Connect Discovery, so this works for any conforming provider rather than one vendor's URL
 * shape. The trailing-slash handling matters: `new URL('.well-known/…', 'https://x/tenant')` would
 * drop `tenant`.
 */
export function discoveryUrl(authority: string): string {
  const base = authority.endsWith('/') ? authority : `${authority}/`;
  return new URL('.well-known/openid-configuration', base).toString();
}

/** Parse a discovery document into the endpoints, refusing anything that is not usable. */
export function readDiscoveryDocument(body: unknown): Result<IdentityEndpoints> {
  if (typeof body !== 'object' || body === null) {
    return refuse('identity-config-invalid', 'the discovery document is not a JSON object');
  }
  const record = body as Record<string, unknown>;
  const authorizationEndpoint = record['authorization_endpoint'];
  const tokenEndpoint = record['token_endpoint'];
  const deviceAuthorizationEndpoint = record['device_authorization_endpoint'];

  if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
    return refuse(
      'identity-config-invalid',
      'the discovery document does not advertise both authorization_endpoint and token_endpoint',
    );
  }

  return ok({
    authorizationEndpoint,
    tokenEndpoint,
    deviceAuthorizationEndpoint:
      typeof deviceAuthorizationEndpoint === 'string' ? deviceAuthorizationEndpoint : null,
  });
}
