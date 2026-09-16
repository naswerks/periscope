/**
 * `periscope login` — acquire a token interactively and write it to the cache the daemon reads.
 *
 * Why this is a command rather than something the daemon does: `bin/serve.ts` presents a
 * token that is already there; there is no interactive flow in the shipped daemon, deliberately,
 * because a host meant to run unattended must not block on a browser at start-up. So the
 * interactive half is a separate act, run once by a person, and the daemon is unchanged by this
 * file existing.
 *
 * It writes the same cache the daemon reads, derived from the same call. `tokenCachePath(env)` is
 * the one source for the location, and `credentialPaths(env)`, which the gate uses to build its
 * protected set, derives from it too. Nothing here may compute a path of its own, or the thing the
 * gate refuses to let an agent read and the thing this writes could drift apart.
 *
 * The flow is derived from config, never chosen here. `protocolFor(config)` picks loopback or
 * device-code, and the daemon's credential calls the same function to decide what it expects, so a
 * cache written under one protocol can never be read under the other. (`TokenCredential` discards a
 * cache whose protocol does not match, so getting this wrong would look like "signing in did
 * nothing".) Setting `PERISCOPE_IDENTITY_DEVICE_CODE=1` moves both ends together, which is the
 * property that makes it safe to expose as one environment variable.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { CachedTokens, TokenStore } from '../identity/index.js';
import { isAuthFlowBlocked, readIdentityConfig } from '../identity/index.js';
import type { DeviceCodeInstruction } from '../host/index.js';
import {
  FilePairedCredential,
  FileTokenCache,
  pairedCredentialPath,
  protocolFor,
  signIn,
  signInWithDeviceCode,
  tokenCachePath,
} from '../host/index.js';

/** The edges, injected so the whole command is testable without a browser, a socket or a clock. */
export interface LoginDeps {
  /** Where operator-facing instructions go. Defaults to stdout. */
  readonly write?: (line: string) => void;
  /** Replaced in tests; the real ones talk to the provider. */
  readonly signIn?: typeof signIn;
  readonly signInWithDeviceCode?: typeof signInWithDeviceCode;
  /** Replaced in tests so nothing touches the real cache path. Defaults to the file cache at `path`. */
  readonly store?: (path: string) => TokenStore;
  /**
   * Whether a paired credential is present at `path`. Replaced in tests. The daemon prefers a
   * paired credential over the token this verb writes, so a signed-in operator on a paired box is
   * told the token will not be the one presented.
   */
  readonly pairedCredentialPresent?: (path: string) => boolean;
}

/**
 * Run the login command.
 *
 * Returns a `Result` rather than exiting, so the caller owns the process and this stays callable
 * from a test. Every failure is a named refusal, the same posture the rest of the package holds.
 */
export async function runLogin(env: NodeJS.ProcessEnv, deps: LoginDeps = {}): Promise<Result<CachedTokens>> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  // Said once, on success: the daemon prefers a paired credential over the token this verb writes,
  // so an operator signing in on a paired box is told the token will not be the one presented.
  const pairedPath = pairedCredentialPath(env);
  const pairedPresent =
    deps.pairedCredentialPresent ?? ((path: string) => new FilePairedCredential(path).read().ok);
  const pairedNotice =
    pairedPath !== null && pairedPresent(pairedPath)
      ? `note: this machine holds a paired credential at ${pairedPath}, and the daemon presents that on ` +
        'every dial in preference to this token'
      : null;

  // The config module's own read and its own refusal, restated nowhere.
  //
  // Two reasons, and the second is enforced. (1) "Configured" must mean the identical thing here and
  // in the daemon; an operator who can sign in but whose host then refuses to start is the worst
  // outcome available. (2) `pins/identity-generic.test.ts` asserts that exactly one shipped file
  // names the authority environment variable, because a second mention is a second answer to "which
  // provider is this host talking to". Naming those variables here, even in a comment or a message
  // string, since the pin reads source text, trips it, and it is right to: the fix is to carry the
  // one refusal that already exists rather than write a second copy that can drift.
  //
  // Not a default, a refusal. There is no fallback issuer and no implicit tenant: signing in
  // "somewhere" would mint a token this controller cannot validate, and the failure would surface
  // much later as a 401 on the upgrade with nothing naming the cause.
  const read = readIdentityConfig(env);
  if (!read.ok) return refuse(read.refusal.reason, read.refusal.detail);

  const config = read.value;

  const cachePath = tokenCachePath(env);
  if (cachePath === null) {
    return refuse(
      'identity-config-invalid',
      'identity is configured but there is nowhere to keep the token cache — set PERISCOPE_CONFIG_DIR',
    );
  }

  const store = (deps.store ?? ((path: string) => new FileTokenCache(path)))(cachePath);
  const protocol = protocolFor(config);

  if (protocol === 'device-code') {
    // The headless flow, and it must stay reachable without a redirect port. This is the flow for
    // a box with no browser, such as a server or a container. It takes no listener and binds
    // nothing.
    const run = deps.signInWithDeviceCode ?? signInWithDeviceCode;
    const result = await run(config, store, (instruction: DeviceCodeInstruction) => {
      write(`open ${instruction.verificationUri} and enter the code: ${instruction.userCode}`);
    });
    return finish(result, cachePath, write, pairedNotice);
  }

  // Loopback + PKCE: the primary flow. `signIn` binds an ephemeral port and closes it on every path;
  // its default `present` prints the URL, which is what works over SSH.
  const run = deps.signIn ?? signIn;
  const result = await run(config, store, {
    present: (url: string) => write(`open this to sign in:\n${url}`),
  });
  return finish(result, cachePath, write, pairedNotice);
}

/**
 * Report the outcome once, in the operator's words.
 *
 * A policy-blocked flow is surfaced with its do-not-retry rule attached. A provider policy blocking
 * the device-code flow refuses identically every time, so an operator who reads a bare failure will
 * re-run it, and the second attempt costs the same and fails the same way.
 */
function finish(
  result: Result<CachedTokens>,
  cachePath: string,
  write: (line: string) => void,
  pairedNotice: string | null,
): Result<CachedTokens> {
  if (!result.ok) {
    write(`sign-in failed: ${result.refusal.reason} — ${result.refusal.detail}`);
    if (isAuthFlowBlocked(result.refusal.detail)) {
      write(
        'do not re-run the device code flow: the same policy will block it, every time. ' +
          'Use the loopback flow (unset PERISCOPE_IDENTITY_DEVICE_CODE) or have the policy changed.',
      );
    }
    return result;
  }

  write(`signed in; token cache written to ${cachePath}`);
  if (pairedNotice !== null) write(pairedNotice);
  return ok(result.value);
}
