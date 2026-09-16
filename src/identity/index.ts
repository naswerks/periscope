/**
 * Identity — signing a real user in, holding what that produced, and presenting it.
 *
 * Every module behind this barrel is pure. The two impure halves live in `host/`
 * (`token-cache.ts` writes the file, `loopback.ts` opens the port), which is where this package
 * confines anything that touches the machine. That split is the same one the gate uses, and it is
 * what makes the awkward branches — a malformed cache, a callback with the wrong `state`, a
 * filesystem that ignores modes — drivable without a machine in that state.
 *
 * Nothing here names a provider. The authority, client and endpoints are configuration, and the
 * flows are RFC 6749 / 7636 / 8628 as written. Any one commercial provider is a configuration of
 * this, not the shape of it — which is what lets somebody point this at their own provider and
 * have it work.
 */
export type { IdentityConfig, IdentityEndpoints, IdentityPosture } from './config.js';
export {
  DEFAULT_SCOPES,
  discoveryUrl,
  identityPosture,
  readDiscoveryDocument,
  readIdentityConfig,
} from './config.js';

export type { Pkce } from './pkce.js';
export {
  CODE_CHALLENGE_METHOD,
  challengeFor,
  createPkce,
  createState,
  randomUrlSafe,
  requireS256,
  stateMatches,
} from './pkce.js';

export type { AuthorizationCallback, AuthorizationRequest } from './authorize.js';
export {
  CALLBACK_PAGE,
  buildAuthorizationUrl,
  readAuthorizationCallback,
  redirectUriFor,
} from './authorize.js';

export type { TokenSet } from './token.js';
export {
  EXPIRY_SKEW_MS,
  authorizationValue,
  codeExchangeBody,
  isFresh,
  readTokenResponse,
  redactSecrets,
  refreshBody,
  secretsIn,
} from './token.js';

export type { CredentialModeOutcome, ModeEnforcement } from './mode.js';
export {
  CREDENTIAL_MODE,
  classifyCredentialMode,
  classifyProbeReadings,
  isWiderThan,
  toOctal,
} from './mode.js';

export type { AuthProtocol, DeviceAuthorization, DevicePollOutcome } from './device-code.js';
export {
  AUTH_FLOW_BLOCKED_CODES,
  AUTH_FLOW_BLOCKED_ERROR,
  deviceAuthorizationBody,
  devicePollBody,
  discardOnProtocolMismatch,
  isAuthFlowBlocked,
  readDeviceAuthorization,
  readDevicePoll,
  requireDeviceCodeEnabled,
} from './device-code.js';

export type { CachedTokens, TokenStore } from './store.js';
export { readCachedTokens } from './store.js';

export type { TokenCredentialOptions, TokenRefresher } from './credential.js';
export { AUTHORIZATION_HEADER, TokenCredential } from './credential.js';

export type { PairedCredentialFile, PairedCredentialStore } from './paired-credential.js';
export { PairedHostCredential, readPairedCredentialFile } from './paired-credential.js';
