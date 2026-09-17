/**
 * Presenting the user's own token to the controller.
 *
 * What this replaces: a host reaching its controller with a shared secret that authenticates it as
 * any user, which every agent on the box can read. What it presents instead is one user's own
 * access token: scoped to them, expiring by itself, and revocable from the identity provider
 * without anyone touching this machine. That is a different order of exposure, not a smaller
 * amount of the same one.
 *
 * `authorize()` never starts an interactive sign-in. It reads what is cached, refreshes silently
 * when it can, and otherwise refuses by name. Opening a browser from inside a reconnect would mean
 * an unattended host at 3am trying to render a login page nobody is looking at, retrying forever —
 * and on a headless box it would simply hang. Signing in is a deliberate act somebody performs;
 * this is the part that runs on its own.
 *
 * And it never reads `apiKeySource` to decide anything. That field names which key source an
 * agent session used, and it reads `none` on a session that is fully authenticated and billing real
 * money — ambient and subscription auth are not keys. It looks exactly like an "is this
 * authenticated" answer and is not one. Authentication state here comes from the cache and the
 * token's own expiry; for an agent session, a completed turn is the proof.
 */
import type { Authorization, ControllerCredential } from '../control/credential.js';
import type { Ticker } from '../core/time.js';
import type { RefusalReason } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { IdentityConfig } from './config.js';
import type { AuthProtocol } from './device-code.js';
import { discardOnProtocolMismatch } from './device-code.js';
import type { CachedTokens, TokenStore } from './store.js';
import type { TokenSet } from './token.js';
import { authorizationValue, isFresh } from './token.js';

/**
 * Exchanges a refresh token for a fresh set.
 *
 * Injected so the credential's whole decision surface is testable without a network, and so the
 * transport stays in one place.
 */
export type TokenRefresher = (cached: CachedTokens) => Promise<Result<TokenSet>>;

/**
 * Which of the three things `authorize()` did — because from the outside they are identical.
 *
 * Nothing under `identity/` emits anything, and `control/link.ts` swallows a credential refusal
 * and connects with no header rather than pretending to hold a scheme — which is deliberate.
 * Without a report, a cache hit, a silent refresh and "nobody has ever signed in on this machine"
 * produce byte-identical output, and the first thing that distinguishes them is a 401 arriving
 * from the controller minutes later. On a binary running on the user's own laptop that reads as a
 * server problem, and the user is never told the one thing they can act on.
 *
 * It carries no token material, and that is a contract rather than an oversight — an outcome name,
 * a refusal reason and the refusal's own already-human detail. Pinned by this package's own suite.
 */
export type CredentialOutcome =
  | { readonly kind: 'cache-hit' }
  | { readonly kind: 'refreshed' }
  | { readonly kind: 'refused'; readonly reason: RefusalReason; readonly detail: string };

/**
 * Where an outcome is reported.
 *
 * Data, not a log line. `identity/` returns `Result`s and formats nothing, on the same split every
 * other seam in this package uses: the embedder decides what a line looks like and where it goes.
 */
export type CredentialReporter = (outcome: CredentialOutcome) => void;

export interface TokenCredentialOptions {
  readonly store: TokenStore;
  readonly config: IdentityConfig;
  /** Which flow this host is configured to use — the protocol-mismatch guard compares against it. */
  readonly protocol: AuthProtocol;
  /** The package's own millisecond ticker, injected like every other clock here. */
  readonly nowMs: Ticker;
  /** Omit to refuse rather than refresh — useful for a host that only ever reads. */
  readonly refresh?: TokenRefresher;
  /** Omit for a credential that decides in silence, which is what this was before it could say. */
  readonly report?: CredentialReporter;
}

/** The header the controller link puts on its connect request. */
export const AUTHORIZATION_HEADER = 'Authorization';

export class TokenCredential implements ControllerCredential {
  readonly #options: TokenCredentialOptions;

  constructor(options: TokenCredentialOptions) {
    this.#options = options;
  }

  /**
   * One report, at one place, derived from the decision rather than repeated alongside it.
   *
   * `#decide` holds every branch and this holds the only call to `report`, so a path added later
   * cannot forget to say what it did — which is precisely how a silent path arises.
   */
  async authorize(): Promise<Result<Authorization>> {
    const decided = await this.#decide();
    const report = this.#options.report;

    if (report !== undefined) {
      report(
        decided.ok
          ? { kind: decided.value.via }
          : { kind: 'refused', reason: decided.refusal.reason, detail: decided.refusal.detail },
      );
    }

    if (!decided.ok) return refuse(decided.refusal.reason, decided.refusal.detail);
    return ok(decided.value.authorization);
  }

  async #decide(): Promise<Result<{ authorization: Authorization; via: 'cache-hit' | 'refreshed' }>> {
    const { store, config, protocol, nowMs, refresh } = this.#options;

    const cached = store.read();
    if (!cached.ok) return refuse(cached.refusal.reason, cached.refusal.detail);

    // A cache minted for a different provider or client is not a token this host may present. It is
    // discarded rather than kept, because leaving it means every later read re-derives the same
    // refusal from material that will never become valid.
    if (cached.value.authority !== config.authority || cached.value.clientId !== config.clientId) {
      store.clear();
      return refuse(
        'token-unavailable',
        'the cached token was minted for a different authority or client than this host is now configured for; it has been discarded — sign in again',
      );
    }

    // The protocol-mismatch guard. Material minted by one flow is discarded when the host is now
    // configured for the other: a refresh across flows fails for a reason nobody would connect to a
    // sign-in weeks earlier. Discarding now turns an unexplainable future failure into one sign-in
    // today. This is not the blocked-flow policy case — see `device-code.ts` for that one.
    if (discardOnProtocolMismatch(cached.value.protocol, protocol)) {
      store.clear();
      return refuse(
        'token-unavailable',
        `the cached token was obtained by the ${cached.value.protocol} flow and this host is configured for ${protocol}; it cannot be refreshed across flows and has been discarded — sign in again`,
      );
    }

    if (isFresh(cached.value.tokens, nowMs())) {
      return ok({ authorization: present(cached.value.tokens), via: 'cache-hit' });
    }

    if (cached.value.tokens.refreshToken === null || refresh === undefined) {
      return refuse(
        'token-unavailable',
        'the cached token has expired and there is no refresh token to renew it with — sign in again',
      );
    }

    const refreshed = await refresh(cached.value);
    if (!refreshed.ok) return refuse(refreshed.refusal.reason, refreshed.refusal.detail);

    // A provider that issues no new refresh token on a refresh means the old one keeps working;
    // dropping it would turn the next expiry into an interactive sign-in for no reason.
    const tokens: TokenSet = {
      ...refreshed.value,
      refreshToken: refreshed.value.refreshToken ?? cached.value.tokens.refreshToken,
    };

    const written = store.write({ ...cached.value, tokens });
    // A cache that could not be written is not a reason to refuse a token already held. The
    // refresh succeeded; failing here would take a working host down over a disk problem, and the
    // only cost of continuing is signing in again after a restart. The refusal is still surfaced by
    // the write path's own return value for anyone who wants it.
    void written;

    return ok({ authorization: present(tokens), via: 'refreshed' });
  }
}

function present(tokens: TokenSet): Authorization {
  return { header: AUTHORIZATION_HEADER, value: authorizationValue(tokens) };
}
