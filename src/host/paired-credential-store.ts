/**
 * The file-backed paired-credential store: `token-cache.ts`'s discipline, applied to the second
 * credential this package persists.
 *
 * Same directory, same modes, same verify-after-write, and none of it restated by hand. The file
 * lives beside the token cache under `periscopeCredentialDir`, which is what puts it inside the
 * gate's protected set for free: `credentialPaths` names the directory, precisely so anything the
 * host later keeps beside the token cache is protected by having been put there.
 *
 * What 0600 is and is not: see `token-cache.ts`'s header. The agent runs as the same OS user;
 * what keeps the AGENT away from this file is the gate's credential-path denial, and the
 * composition test in `identity/paired-credential.test.ts` proves the containment.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { CredentialModeOutcome, ModeEnforcement } from '../identity/mode.js';
import { CREDENTIAL_MODE, classifyCredentialMode } from '../identity/mode.js';
import type { PairedCredentialFile, PairedCredentialStore } from '../identity/paired-credential.js';
import { readPairedCredentialFile } from '../identity/paired-credential.js';
import { probeModeEnforcement } from './token-cache.js';

/** Directories holding credential material are owner-only too — `token-cache.ts`'s constant. */
const CREDENTIAL_DIR_MODE = 0o700;

export interface PairedCredentialWrite {
  readonly path: string;
  readonly mode: CredentialModeOutcome;
}

export class FilePairedCredential implements PairedCredentialStore {
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
   * Read the paired credential.
   *
   * A missing file is `token-unavailable` — this machine has never been paired, the NORMAL state
   * every unpaired host is in — and that is deliberately not the same reason as a file that exists
   * and cannot be parsed. The composition root falls through to the OIDC posture on the first and
   * refuses to start on the second: a corrupt paired credential silently degrading to a maybe-dead
   * refresh token would put the host in exactly the ambiguous posture pairing exists to end.
   */
  read(): Result<PairedCredentialFile> {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch {
      return refuse('token-unavailable', 'this machine holds no paired credential');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return refuse(
        'credential-cache-unreadable',
        `the paired credential at ${this.#path} exists and is not valid JSON; remove it or run: periscope pair <code>`,
      );
    }

    return readPairedCredentialFile(parsed);
  }

  /**
   * Write the credential, then verify what actually landed — a file that came out wider than asked
   * is removed, not left and reported (`token-cache.ts`'s rule, same words, same reason).
   */
  write(file: PairedCredentialFile): Result<PairedCredentialWrite> {
    const enforcement = this.modeEnforcement();

    try {
      mkdirSync(this.#directory, { recursive: true, mode: CREDENTIAL_DIR_MODE });
      writeFileSync(this.#path, `${JSON.stringify(file, null, 2)}\n`, { mode: CREDENTIAL_MODE });
      // `writeFileSync`'s mode applies only when it CREATES the file — re-stating it is what makes
      // an overwrite (a re-pair) as private as a first write.
      chmodSync(this.#path, CREDENTIAL_MODE);
    } catch (error) {
      return refuse(
        'credential-cache-write-failed',
        `the paired credential could not be written to ${this.#path}: ${String(error)}`,
      );
    }

    let observed: number;
    try {
      observed = statSync(this.#path).mode;
    } catch (error) {
      return refuse(
        'credential-cache-write-failed',
        `the paired credential was written and could not be read back from ${this.#path}: ${String(error)}`,
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

  /** Remove the credential. Idempotent — clearing what is not there is success, not an error. */
  clear(): void {
    try {
      rmSync(this.#path, { force: true });
    } catch {
      // Nothing here can act on the failure.
    }
  }
}
