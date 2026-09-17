/**
 * The file-backed token cache: one of the two places this package writes credential material to
 * disk (the other is the paired-credential store beside it).
 *
 * What 0600 is and is not, because the honest version is load-bearing here. The agent runs as the
 * same OS user as this host. File permissions are not a boundary against a process running as the
 * same user: an 0600 token file is readable by the agent exactly as it is by the host. What 0600
 * buys is keeping other OS users out. What keeps the agent out is the gate's credential-path
 * denial, and that denial covers this file because `credentialPaths` and `tokenCachePath` are
 * derived from one function in `paths.ts`, not kept equal by hand.
 *
 * The exposure is a different kind, not a smaller amount of the same one. Compared with a shared
 * secret that grants access as every user, what is stored here is one user's own token, expiring
 * on its own and revocable from the identity provider without touching this machine.
 *
 * Enforcement is probed, not assumed. `node` on win32 accepts a mode and ignores it, and reports
 * the same `0o666` for a deliberately world-readable file as for one written `0o600`, so a
 * verify-after-write there is either always-refusing or always-vacuous. This measures which world
 * it is in once, and `identity/mode.ts` turns the answer into a named outcome.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { CredentialModeOutcome, ModeEnforcement } from '../identity/mode.js';
import { CREDENTIAL_MODE, classifyCredentialMode, classifyProbeReadings } from '../identity/mode.js';
import type { CachedTokens, TokenStore } from '../identity/store.js';
import { readCachedTokens } from '../identity/store.js';

/** Directories holding credential material are owner-only too. */
const CREDENTIAL_DIR_MODE = 0o700;

export interface TokenCacheWrite {
  readonly path: string;
  readonly mode: CredentialModeOutcome;
}

/**
 * Measure what this filesystem does with a mode.
 *
 * Measured rather than listed by platform. A `process.platform === 'win32'` test is a guess that
 * ages: WSL, a POSIX filesystem mounted under Windows, and a future runtime mapping modes onto ACLs
 * would each make it wrong in the direction that matters. The probe writes a throwaway file BESIDE
 * the cache — the same filesystem, which is the thing actually in question.
 *
 * It asserts its positive control before it reports the negative, and that ordering is the whole
 * design. Three measurements, in this order:
 *
 *   1. Ask for `0600` and for `0666`. If they read back differently AND `0600` came back as `0600`,
 *      POSIX modes are honoured. Done.
 *   2. They did not differ — so privacy is unconfirmable. **Before saying so, prove the instrument
 *      is alive**: clear the write bit with `0444`. Measured on win32, that DOES read back as
 *      `444`, because the write bit is the one real bit there. If it changes, this is a genuine
 *      finding about a filesystem that records only writability.
 *   3. Even `0444` changed nothing. Then the probe cannot distinguish "this filesystem records
 *      nothing" from "this probe is broken", and it says exactly that.
 *
 * Without step 2, "unenforced" and "the probe never worked" are the same answer — an instrument
 * with no inconclusive state, which is how a dead check gets read as evidence.
 *
 * `0444` is the control, never the target. The cache must stay owner-writable; refreshes are
 * written to it. The probe restores a writable mode on its own throwaway file before removing it,
 * because a read-only file is one `rmSync` can fail on.
 */
export function probeModeEnforcement(directory: string): ModeEnforcement {
  const probe = `${directory}/.mode-probe`;
  const modeOf = (): number => statSync(probe).mode & 0o777;

  try {
    writeFileSync(probe, '', { mode: CREDENTIAL_MODE });
    chmodSync(probe, CREDENTIAL_MODE);
    const narrow = modeOf();

    writeFileSync(probe, '', { mode: 0o666 });
    chmodSync(probe, 0o666);
    const wide = modeOf();

    // The positive control. Taken before anything is concluded, not after.
    chmodSync(probe, 0o444);
    const readOnly = modeOf();
    chmodSync(probe, 0o666);

    // Taking the readings is this function's job; what they MEAN is `identity/mode.ts`'s, so the
    // filesystem shapes this machine cannot produce on demand are still drivable in a test.
    return classifyProbeReadings(narrow, wide, readOnly);
  } catch {
    return 'unobservable';
  } finally {
    try {
      // Restore writability first: a read-only file is one removal can fail on, and a probe that
      // leaves litter behind on the credential directory is its own small defect.
      try {
        chmodSync(probe, 0o666);
      } catch {
        // Already gone, or never created.
      }
      rmSync(probe, { force: true });
    } catch {
      // A probe file that could not be removed is untidy, never a reason to fail a sign-in.
    }
  }
}

export class FileTokenCache implements TokenStore {
  readonly #path: string;
  readonly #directory: string;
  #enforcement: ModeEnforcement | null = null;

  constructor(path: string) {
    this.#path = path;
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    this.#directory = cut > 0 ? path.slice(0, cut) : path;
  }

  get path(): string {
    return this.#path;
  }

  /** Memoised: the filesystem does not change its mind mid-process. */
  modeEnforcement(): ModeEnforcement {
    if (this.#enforcement === null) {
      try {
        mkdirSync(this.#directory, { recursive: true, mode: CREDENTIAL_DIR_MODE });
      } catch {
        // The write path reports the real failure; a probe must not be the thing that raises it.
      }
      this.#enforcement = probeModeEnforcement(this.#directory);
    }
    return this.#enforcement;
  }

  /**
   * Read the cache.
   *
   * A missing file is `token-unavailable` — nobody has signed in — and that is deliberately NOT the
   * same reason as a file that exists and cannot be parsed, which is a real problem with a real
   * fix. Collapsing them would make a corrupted cache look like a fresh install forever.
   */
  read(): Result<CachedTokens> {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch {
      return refuse('token-unavailable', 'no token cache exists on this host yet — sign in first');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return refuse(
        'credential-cache-unreadable',
        `the token cache at ${this.#path} exists and is not valid JSON; remove it and sign in again`,
      );
    }

    return readCachedTokens(parsed);
  }

  /**
   * Write the cache, then verify what actually landed.
   *
   * A file that came out wider than asked is removed, not left and reported. Leaving a
   * world-readable token on disk while returning a refusal would mean the caller sees a failure and
   * the credential is exposed anyway — the worst of both. No cache at all is strictly safer than a
   * readable one, and the sign-in can simply be repeated.
   */
  write(cached: CachedTokens): Result<TokenCacheWrite> {
    const enforcement = this.modeEnforcement();

    try {
      mkdirSync(this.#directory, { recursive: true, mode: CREDENTIAL_DIR_MODE });
      writeFileSync(this.#path, `${JSON.stringify(cached, null, 2)}\n`, { mode: CREDENTIAL_MODE });
      // `writeFileSync`'s mode applies only when it CREATES the file — an existing file keeps the
      // mode it already had. Re-stating it is what makes an overwrite as private as a first write.
      chmodSync(this.#path, CREDENTIAL_MODE);
    } catch (error) {
      return refuse(
        'credential-cache-write-failed',
        `the token cache could not be written to ${this.#path}: ${String(error)}`,
      );
    }

    let observed: number;
    try {
      observed = statSync(this.#path).mode;
    } catch (error) {
      return refuse(
        'credential-cache-write-failed',
        `the token cache was written and could not be read back from ${this.#path}: ${String(error)}`,
      );
    }

    const mode = classifyCredentialMode(observed, enforcement);
    if (mode.kind === 'too-wide') {
      this.clear();
      return refuse(
        mode.refusal.reason,
        `${mode.refusal.detail}; the file has been removed rather than left readable`,
      );
    }

    return ok({ path: this.#path, mode });
  }

  /** Remove the cache. Idempotent — clearing a cache that is not there is success, not an error. */
  clear(): void {
    try {
      rmSync(this.#path, { force: true });
    } catch {
      // Nothing here can act on the failure, and throwing would turn "sign out" into an error path.
    }
  }
}
