/**
 * Whether the token file on disk is actually as private as requested — decided here, purely, so
 * every branch can be driven on any platform.
 *
 * The defect, observed on win32 rather than reasoned. On win32, `node` accepts a `0o600` mode and
 * does nothing with it: writing with `{mode: 0o600}` and then `chmod`ing to `0o600` both leave
 * `statSync().mode & 0o777` reading `0o666`, and a deliberately world-readable `0o666` file reads
 * exactly the same. So on Windows a restricted token file and an unrestricted one are
 * indistinguishable through the only API available.
 *
 * That makes the obvious implementation wrong in both directions, which is why this is a module and
 * not an `if`:
 *
 *   - Verify literally (`observed === 0o600`) and the host refuses every write on Windows — it
 *     would be unusable there.
 *   - Relax it to "not world-writable" and the check passes vacuously on Windows while proving
 *     nothing at all — a green that reads as evidence.
 *
 * So the third answer is the only honest one: where modes are enforced, verify and refuse if the
 * file came out wider than asked. Where they are not, say so by name as a degrade. A degrade is
 * a named outcome, never a silent pass — and "this could not be confirmed" is a fact an operator
 * can act on, while a checkmark that means nothing is not.
 *
 * Enforcement is measured, not assumed from `process.platform`. The caller probes it (see
 * `host/token-cache.ts`) and passes the answer in. A platform list would be a guess that ages;
 * WSL, a POSIX filesystem mounted on Windows, or a future runtime that maps modes onto ACLs would
 * each make the guess wrong in the direction that matters.
 *
 * And the measurement has an inconclusive state, which is why this is a three-way enum and not a
 * boolean. A probe that reports "not enforced" is only worth anything if it could have reported
 * something else. On win32, `chmod 0444` does read back as `444`, so the write bit is real even
 * though the read/group/other bits are fabricated as `6`. That gives the probe a positive control
 * — it can demonstrate it observes something before it claims it cannot observe privacy.
 * Without that, "unenforced" and "my probe is broken" are the same answer, and an instrument with
 * no inconclusive state reports confidence it has not earned.
 */
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';

/** The mode credential material is written with, everywhere. */
export const CREDENTIAL_MODE = 0o600;

const PERMISSION_BITS = 0o777;

/** What the filesystem was measured to do with a mode. */
export type ModeEnforcement =
  /** POSIX modes are honoured: what was asked for is what came back, and wide differs from narrow. */
  | 'enforced'
  /**
   * Measured, and the answer is that only the write bit survives — the win32 shape. `0600` and
   * `0666` are indistinguishable, so privacy cannot be confirmed; but `0444` reads back as `444`,
   * so the instrument is live and this is a real finding rather than a dead probe.
   */
  | 'write-bit-only'
  /**
   * Inconclusive. No mode change was observable at all, not even clearing the write bit. The
   * probe cannot distinguish "this filesystem records nothing" from "this probe is broken", and
   * saying so is the only honest option.
   */
  | 'unobservable';

export type CredentialModeOutcome =
  /** Modes are enforced here and the file is exactly as private as requested. */
  | { readonly kind: 'verified'; readonly observed: number }
  /** Modes are enforced here and the file is readable or writable by more than its owner. */
  | { readonly kind: 'too-wide'; readonly observed: number; readonly refusal: Refusal }
  /** Not a failure: privacy is unconfirmable here, and that was measured rather than assumed. */
  | { readonly kind: 'unenforced'; readonly observed: number; readonly refusal: Refusal }
  /** Not even a measurement: the instrument could observe nothing. Worth investigating. */
  | { readonly kind: 'unobservable'; readonly observed: number; readonly refusal: Refusal };

/** Is any permission bit set that was not requested? */
export function isWiderThan(observed: number, requested: number): boolean {
  return (observed & ~requested & PERMISSION_BITS) !== 0;
}

/**
 * Decide what three probe readings mean. Pure, so the shapes this machine cannot produce are still
 * drivable.
 *
 * This function exists because the obvious control is vacuous. Without the `0444` reading, on
 * win32 a probe that runs the control and a probe that merely assumes its answer both report
 * `write-bit-only`, so nothing on that machine can tell them apart. What is uniquely lost is the
 * ability to distinguish a filesystem that records only the write bit from one that records
 * nothing — and that difference only shows up on a filesystem a win32 machine cannot produce on
 * demand. Stating the readings as data is what makes it testable at all.
 *
 *   narrow    what `stat` reported after asking for `requested` (0600)
 *   wide      what it reported after asking for 0666
 *   readOnly  what it reported after clearing the write bit (0444) — the positive control
 */
export function classifyProbeReadings(
  narrow: number,
  wide: number,
  readOnly: number,
  requested: number = CREDENTIAL_MODE,
): ModeEnforcement {
  const n = narrow & PERMISSION_BITS;
  const w = wide & PERMISSION_BITS;
  const r = readOnly & PERMISSION_BITS;

  // Full POSIX: what was asked for came back, and asking for something wider changed the answer.
  if (n === (requested & PERMISSION_BITS) && n !== w) return 'enforced';

  // Privacy is unconfirmable. Before saying so, the instrument must have shown it observes
  // something — otherwise "unenforced" is indistinguishable from a dead probe.
  return r !== w ? 'write-bit-only' : 'unobservable';
}

/**
 * Classify what a verify-after-write actually found.
 *
 * `enforcement` is the measured answer to "what does this filesystem do with a mode at all".
 */
export function classifyCredentialMode(
  observed: number,
  enforcement: ModeEnforcement,
  requested: number = CREDENTIAL_MODE,
): CredentialModeOutcome {
  const bits = observed & PERMISSION_BITS;

  if (enforcement === 'unobservable') {
    return {
      kind: 'unobservable',
      observed: bits,
      refusal: refusal(
        'credential-mode-unobservable',
        `mode ${toOctal(requested)} was requested and this filesystem reported no observable mode change of any kind — not even clearing the write bit — so nothing at all can be said about the token file's permissions here; this is an inconclusive instrument rather than a finding about privacy`,
      ),
    };
  }

  if (enforcement === 'write-bit-only') {
    return {
      kind: 'unenforced',
      observed: bits,
      refusal: refusal(
        'credential-mode-unenforced',
        `mode ${toOctal(requested)} was requested and this filesystem records only the write bit (it reports ${toOctal(bits)} here, and cannot distinguish owner-only from world-readable), so the token file's privacy cannot be confirmed — it is protected by the gate's credential-path denial and by the OS account, not by this mode. The probe did observe a mode change when the write bit was cleared, so this is a measurement rather than a dead check`,
      ),
    };
  }

  if (isWiderThan(bits, requested)) {
    return {
      kind: 'too-wide',
      observed: bits,
      refusal: refusal(
        'credential-mode-too-wide',
        `the token file was written with mode ${toOctal(bits)} after ${toOctal(requested)} was requested, so it is readable or writable by more than its owner`,
      ),
    };
  }

  return { kind: 'verified', observed: bits };
}

/** `0o600`, for a message a human reads. */
export function toOctal(mode: number): string {
  return `0${(mode & PERMISSION_BITS).toString(8)}`;
}
