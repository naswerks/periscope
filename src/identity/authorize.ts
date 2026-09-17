/**
 * The authorization request, and the callback that answers it — pure, so the whole decision surface
 * can be exercised without opening a port or a browser.
 *
 * The loopback redirect is what `az`, `gh` and `kubectl` do, and it is the primary flow here for
 * the reason those tools chose it: the authorization code comes back to a listener only this
 * machine can reach, and the browser doing the sign-in is the user's real one, with their real
 * session, their real conditional-access evaluation and their real second factor.
 *
 * Nothing in this module puts an authorization code into a refusal. A code is redeemable
 * credential material for as long as it lives, and a refusal `detail` is written to logs by
 * definition — that is the exact path by which a credential ends up in a diagnostic. Refusals here
 * say which field was wrong, never what it contained.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { IdentityConfig } from './config.js';
import type { Pkce } from './pkce.js';
import { stateMatches } from './pkce.js';

/** Everything one sign-in attempt must remember between the request and the callback. */
export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
  readonly pkce: Pkce;
  readonly redirectUri: string;
}

/** The loopback redirect URI for a port the OS has already assigned. */
export function redirectUriFor(port: number): string {
  // 127.0.0.1, never `localhost`. `localhost` can resolve to ::1 or be redefined in a hosts
  // file, and the provider matches the redirect URI as a literal string — so the registered value
  // and the listener must agree on the exact spelling, not on a name that resolves.
  return `http://127.0.0.1:${port}/callback`;
}

/**
 * Build the URL the user's browser is sent to.
 *
 * `redirectUri` is passed rather than derived because the port is not known until the listener is
 * bound — asking the OS for a free port and then telling the provider about it is the ordinary
 * loopback shape.
 */
export function buildAuthorizationUrl(
  config: IdentityConfig,
  authorizationEndpoint: string,
  pkce: Pkce,
  state: string,
  redirectUri: string,
): AuthorizationRequest {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method);
  return { url: url.toString(), state, pkce, redirectUri };
}

/** What the provider sent back, once it has been proven to answer this host's request. */
export interface AuthorizationCallback {
  readonly code: string;
}

/**
 * Read a callback and decide whether it is the answer to this host's request.
 *
 * The `state` check runs before the code is even looked at, and that ordering is the point. A
 * callback carrying a perfectly good authorization code from somebody else's authorization request
 * is exactly the attack: any local process can reach this host's loopback listener, because the
 * agent shares this host's OS user. Reading the code first and validating afterwards would work
 * identically in every test and leave the window open.
 *
 * `rawQuery` is the callback request's query string, taken from the listener verbatim.
 */
export function readAuthorizationCallback(
  rawQuery: string,
  expectedState: string,
): Result<AuthorizationCallback> {
  const params = new URLSearchParams(rawQuery);

  const receivedState = params.get('state');
  if (receivedState === null || !stateMatches(expectedState, receivedState)) {
    return refuse(
      'auth-state-mismatch',
      receivedState === null
        ? "the callback carried no state value, so it cannot be shown to answer this host's request"
        : "the callback's state is not the one this host minted — this callback answers somebody else's authorization request and its code is not redeemed",
    );
  }

  // Only now is anything else in the callback worth reading.
  const error = params.get('error');
  if (error !== null) {
    const description = params.get('error_description');
    return refuse(
      'auth-callback-refused',
      `the provider returned ${error}${description === null ? '' : `: ${description}`}`,
    );
  }

  const code = params.get('code');
  if (code === null || code === '') {
    return refuse(
      'auth-callback-refused',
      'the callback carried neither an authorization code nor an error, so there is nothing to redeem',
    );
  }

  return ok({ code });
}

/**
 * The page the browser lands on after the callback.
 *
 * Deliberately static and self-contained — no script, no external asset, and nothing derived from
 * the query string. Reflecting any part of the callback into this HTML would be a cross-site
 * scripting hole in a page that renders in the user's real, signed-in browser.
 */
export const CALLBACK_PAGE = [
  '<!doctype html><meta charset="utf-8"><title>Signed in</title>',
  '<body style="font-family:system-ui;padding:2rem">',
  '<h1>Signed in</h1><p>You can close this tab and return to the terminal.</p>',
  '</body>',
].join('');
