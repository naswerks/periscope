/**
 * The token exchange — building the requests, reading the responses, and deciding when what the
 * host holds is still usable. Pure: no network here, so every branch including the ugly ones is
 * drivable.
 *
 * The redaction in this file is load-bearing, not hygiene. Mapping a provider's error response
 * into a readable message is the single most likely place a token ends up in a log, because the
 * natural implementation — echo the body so the operator can see what happened — is also the one
 * that writes credential material to disk. Everything a provider says passes through
 * `redactSecrets` before it becomes a refusal `detail`, and `token.test.ts` drives a failure path
 * carrying a token and asserts the token appears nowhere in the output.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { IdentityConfig } from './config.js';

/** What this host holds after a successful exchange. */
export interface TokenSet {
  readonly accessToken: string;
  /** Null when the provider issued none — then expiry means an interactive sign-in. */
  readonly refreshToken: string | null;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly tokenType: string;
  readonly scope: string | null;
}

/**
 * How long before expiry a token is treated as already expired.
 *
 * A token that expires in four seconds is not usable for a request that takes five. The skew also
 * covers clock drift between this host and the provider, which is why it is generous.
 */
export const EXPIRY_SKEW_MS = 60_000;

/** The field names whose values must never reach a log, at any nesting depth. */
const SECRET_FIELDS = ['access_token', 'refresh_token', 'id_token', 'code', 'code_verifier', 'client_secret'];

/**
 * Collect every credential-shaped value in a parsed body.
 *
 * Recursive because providers nest error payloads, and a token one level down is exactly as
 * damaging as one at the top.
 */
export function secretsIn(body: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (SECRET_FIELDS.includes(key) && typeof value === 'string' && value !== '') found.push(value);
      else visit(value, depth + 1);
    }
  };
  visit(body, 0);
  return found;
}

/** Replace every known secret with a marker. Longest first, so a prefix cannot leave a tail behind. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret === '') continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** Bound a provider-supplied string before it becomes a message. */
function bounded(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}… (${value.length} chars)`;
}

function form(pairs: Record<string, string>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(pairs)) body.set(key, value);
  return body.toString();
}

/** The authorization-code redemption body. */
export function codeExchangeBody(
  config: IdentityConfig,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): string {
  return form({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    scope: config.scopes.join(' '),
  });
}

/** The refresh body. */
export function refreshBody(config: IdentityConfig, refreshToken: string): string {
  return form({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: refreshToken,
    scope: config.scopes.join(' '),
  });
}

/**
 * Turn a token-endpoint response into a `TokenSet`, or into the right kind of refusal.
 *
 * Two failure reasons, and they must not be collapsed — the same discipline the permission gate
 * uses. A non-2xx is the provider refusing or an outage: the fix is a credential, a tenant policy,
 * or a retry. A 2xx whose body cannot be used is version skew or a misconfigured endpoint: the fix
 * is code or configuration. One is the provider's problem and one is this host's.
 */
export function readTokenResponse(status: number, body: unknown, nowMs: number): Result<TokenSet> {
  const secrets = secretsIn(body);

  if (status < 200 || status >= 300) {
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const error = typeof record['error'] === 'string' ? record['error'] : `HTTP ${status}`;
    const description = typeof record['error_description'] === 'string' ? record['error_description'] : null;
    // Only the two named fields are quoted — the body is never dumped. That is the first of two
    // defences here, and it is the one that is easy to lose: "echo what the provider said so the
    // operator can see it" is the natural implementation and it writes tokens to a log.
    const message = description === null ? error : `${error}: ${description}`;

    // `invalid_grant` is a different answer from every other non-2xx, and conflating them hides a
    // dead grant behind retries. RFC 6749 section 5.2 defines it as the grant being expired, revoked,
    // or issued to another client - none of which the next attempt improves. Everything else here is
    // something a retry may well survive: a gateway hiccup, a throttle, a provider blip.
    //
    // This reader serves both grant exchanges, and the conclusion holds for each. On a refresh the
    // refresh token has lapsed; on the initial code exchange the authorization code has expired or
    // been replayed. Either way the material presented is spent and the next attempt with the same
    // material fails identically - what differs is only which sign-in a person has to redo.
    //
    // The name is the RFC's, not a provider's. Providers append their own diagnostic codes to
    // `error_description` and no one provider's is canonical; branching on the standard name is
    // what keeps the rule true for a host pointed somewhere else.
    if (error === 'invalid_grant') {
      return refuse(
        'token-grant-rejected',
        redactSecrets(
          bounded(`${message} - this grant is no longer valid; a new sign-in is required`),
          secrets,
        ),
      );
    }

    return refuse('token-request-failed', redactSecrets(bounded(message), secrets));
  }

  if (typeof body !== 'object' || body === null) {
    return refuse(
      'token-response-invalid',
      'the token endpoint returned 2xx with a body that is not a JSON object',
    );
  }
  const record = body as Record<string, unknown>;

  const accessToken = record['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    return refuse('token-response-invalid', 'the token endpoint returned 2xx with no access_token');
  }

  // `expires_in` is only recommended by RFC 6749, and this host refuses without it anyway. An
  // unattended host that does not know when its token dies cannot decide when to refresh — it would
  // either refresh on every single call or discover expiry as a 401 in the middle of doing
  // something. Neither is acceptable, and guessing a lifetime would be inventing a fact.
  const expiresIn = record['expires_in'];
  const seconds = typeof expiresIn === 'number' ? expiresIn : Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return refuse(
      'token-response-invalid',
      'the token endpoint returned 2xx with no usable expires_in; an unattended host cannot decide when to refresh a token whose lifetime it does not know',
    );
  }

  const refreshToken = record['refresh_token'];
  const scope = record['scope'];
  const tokenType = record['token_type'];

  return ok({
    accessToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken !== '' ? refreshToken : null,
    expiresAt: nowMs + seconds * 1000,
    tokenType: typeof tokenType === 'string' && tokenType !== '' ? tokenType : 'Bearer',
    scope: typeof scope === 'string' ? scope : null,
  });
}

/** Is this token still usable, allowing for the skew? */
export function isFresh(tokens: TokenSet, nowMs: number): boolean {
  return tokens.expiresAt - EXPIRY_SKEW_MS > nowMs;
}

/** The header a fresh token is presented as. */
export function authorizationValue(tokens: TokenSet): string {
  return `${tokens.tokenType} ${tokens.accessToken}`;
}
