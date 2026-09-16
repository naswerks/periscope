/**
 * The paired-host credential — the durable identity a machine holds after `periscope pair`.
 *
 * The shape and its validation live here, not with the filesystem — the same split `store.ts`
 * states for the token cache, for the same reason: `host/` may import this, and this may never
 * import `host/`.
 *
 * This is not the OIDC token and not the RFC 8628 `device-code` flow, and the noun is chosen to
 * keep the three apart. A paired credential is an opaque controller-minted bearer
 * (`p1.<hostId>.<secret>`): it never expires on a clock, never refreshes, and dies only when the
 * controller revokes it — at which point the upgrade answers 401 and the host's terminal path
 * names it. That is what makes it survive the idle window after which a provider may let an OIDC
 * refresh token lapse.
 *
 * It carries no user, and cannot. The controller derives the acting user from its own registry
 * row; a host presenting this credential asserts nothing about who it acts for, which is the whole
 * design — nothing in this file could smuggle an identity claim even by mistake, because there is
 * no field to put one in.
 */
import type { Authorization, ControllerCredential } from '../control/credential.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { AUTHORIZATION_HEADER } from './credential.js';

/** The persisted record — what `periscope pair` writes and the daemon reads. */
export interface PairedCredentialFile {
  /** The host id the credential names. The daemon announces this id in `link_hello` — the
   * controller refuses a hello naming anything else, so the file's copy is load-bearing. */
  readonly hostId: string;
  /** The full opaque credential, exactly as the controller minted it. */
  readonly credential: string;
}

/** The port the pair verb writes through and the daemon reads through — an interface for the same
 * reason `TokenStore` is one: every malformed-file branch is drivable without a disk. */
export interface PairedCredentialStore {
  read(): Result<PairedCredentialFile>;
  write(file: PairedCredentialFile): Result<unknown>;
}

/** Validate a parsed file into the shape the daemon relies on. */
export function readPairedCredentialFile(parsed: unknown): Result<PairedCredentialFile> {
  if (typeof parsed !== 'object' || parsed === null) {
    return refuse('credential-cache-unreadable', 'the paired credential file is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const hostId = record['hostId'];
  const credential = record['credential'];

  if (typeof hostId !== 'string' || hostId === '') {
    return refuse('credential-cache-unreadable', 'the paired credential file names no hostId');
  }
  if (typeof credential !== 'string' || credential === '') {
    return refuse('credential-cache-unreadable', 'the paired credential file carries no credential');
  }

  // The credential embeds the host id it speaks for; a file whose two copies disagree would make
  // this host announce one identity and authenticate as another — the exact mismatch the
  // controller's hello binding exists to refuse. Caught here, where the fix (re-pair) is printable.
  if (!credential.startsWith(`p1.${hostId}.`)) {
    return refuse(
      'credential-cache-unreadable',
      'the paired credential does not match the hostId beside it — the file is corrupt; run: periscope pair <code>',
    );
  }

  return ok({ hostId, credential });
}

/**
 * The `ControllerCredential` a paired host presents — on the link, the decision POST and the bulk
 * POST alike, through the one spread point in the composition root.
 *
 * No refresh, no expiry, no reporter, and each absence is the design: the credential is a stable
 * secret whose validity lives server-side, so there is exactly one outcome here and nothing to
 * distinguish. Revocation surfaces as the controller's 401, which the link already classifies as
 * terminal `link-unauthorized` — this class cannot see it coming and must not pretend to.
 */
export class PairedHostCredential implements ControllerCredential {
  readonly #value: string;

  constructor(file: PairedCredentialFile) {
    this.#value = `Bearer ${file.credential}`;
  }

  authorize(): Promise<Result<Authorization>> {
    return Promise.resolve(ok({ header: AUTHORIZATION_HEADER, value: this.#value }));
  }
}
