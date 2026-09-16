/**
 * Whether a working directory is one the agent CLI considers trusted. Read, never written.
 *
 * The trap this exists for: in an untrusted workspace the CLI silently voids the permission rules
 * in `.claude/settings.json` — *"Ignoring 1 permissions.allow entry … this workspace has not been
 * trusted"* — and that sentence is a STDERR LINE, not an error. Nothing in the SDK's type surface
 * models trust at all. A host that provisions working directories programmatically will therefore
 * create untrusted ones by default and never be told.
 *
 * Why this module reads and does not write: granting trust
 * means writing `hasTrustDialogAccepted: true` into the user's own `~/.claude.json`, a file every
 * running CLI rewrites, so a host that grants is racing them for user-global state it does not own.
 * It would also remove the SYMPTOM rather than the SILENCE, and silence is the actual failure: a
 * host that reports the condition works on a machine where granting is impossible — a read-only
 * home, a container, another user's account — and one that grants does not.
 *
 * What replaces it: this package depends on no settings file (`settingSources: []` reads none, so
 * there are no rules for an untrusted workspace to void), and where a caller opts back in, the
 * condition is REPORTED. The permission authority is the in-process hook, which the evidence shows
 * fires regardless of allow rules — depending on the rules instead would mean depending on the one
 * mechanism proven to be silently voidable.
 */
import { readFileSync } from 'node:fs';

import { normalizePath } from '../core/paths.js';

export type WorkspaceTrust =
  /** The config records this directory as trusted. */
  | 'trusted'
  /** The config was read and this directory is either absent from it or recorded as untrusted. */
  | 'untrusted'
  /** No config, or one that could not be read. NOT the same as untrusted — see below. */
  | 'unknown';

/**
 * The stderr line the CLI emits when it drops rules for this reason, as a matcher.
 *
 * Deliberately loose: it matches the stable part of a message whose wording the CLI owns, so a
 * reworded prefix or a different rule count still trips it. A matcher that is too precise here fails
 * open, which is the direction that reproduces the original silence.
 */
const UNTRUSTED_STDERR = /has not been trusted/i;

export function isUntrustedWorkspaceWarning(line: string): boolean {
  return UNTRUSTED_STDERR.test(line);
}

/** Where the CLI keeps per-directory trust. Separate from the settings files. */
export function trustConfigPath(homeDir: string): string {
  return `${normalizePath(homeDir)}/.claude.json`;
}

/**
 * Read the recorded trust for `cwd`.
 *
 * Comparison is normalized and case-insensitive because the recorded keys are whatever absolute
 * path the CLI was started with — `C:\x` and `c:/x` are the same directory on Windows and would
 * otherwise read as two.
 *
 * `unknown` is a third answer and not a synonym for untrusted. A config that cannot be read
 * supports no claim, and reporting "untrusted" for it would state a fact about the user's machine
 * that was never observed.
 */
export function readWorkspaceTrust(configPath: string, cwd: string): WorkspaceTrust {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return 'unknown';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unknown';
  }

  const projects = (parsed as { projects?: unknown }).projects;
  if (typeof projects !== 'object' || projects === null) return 'unknown';

  const wanted = normalizePath(cwd).toLowerCase();
  for (const [recordedPath, entry] of Object.entries(projects as Record<string, unknown>)) {
    if (normalizePath(recordedPath).toLowerCase() !== wanted) continue;
    const accepted = (entry as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted;
    return accepted === true ? 'trusted' : 'untrusted';
  }

  // The file exists and lists projects; this one is simply not among them. That IS an observation:
  // a directory the CLI has never been trusted in.
  return 'untrusted';
}
