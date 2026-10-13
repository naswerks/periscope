/**
 * The runner-owned Codex home and the settings every Codex session is pinned to.
 *
 * The home is `PERISCOPE_CODEX_HOME`, set as `CODEX_HOME` in every app-server this host starts, never
 * left unset: unset, Codex falls back to the operator's own `~/.codex`, and a value naming a missing
 * directory is a hard error in Codex, so this host creates it first. Its sign-in is the operator's
 * one-time act (`codex login` with `CODEX_HOME` set to it); its two credential files join the
 * protected read set (`credentialPaths`).
 *
 * The security settings are pinned as session flags, twice: as `-c` overrides on the app-server's own
 * command line, and again in every `thread/start`'s `config`. Session flags outrank a project's own
 * configuration layer, so a repository a session works in cannot undo them. `--strict-config` makes a
 * misspelt key fail the start loudly; the version pin is checked first, so a key a newer release
 * renamed is caught as the wrong version rather than as a strange refusal.
 *
 * Never set: the switch that bypasses hook trust.
 */
import { mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { JsonValue } from '../control/frames.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { CodexPermissionMode } from './wire-request.js';
import { CODEX_APPROVALS_REVIEWER, CODEX_MODE_MAP } from './wire-request.js';

/** The files of a Codex home that hold its sign-in. */
export const CODEX_CREDENTIAL_FILES = ['auth.json', '.credentials.json'] as const;

/** Create the home when it is absent. Refuses `runtime-unavailable` when it cannot be, or is a file. */
export function ensureCodexHome(home: string): Result<string> {
  try {
    mkdirSync(home, { recursive: true });
    if (!statSync(home).isDirectory()) {
      return refuse('runtime-unavailable', `the Codex home ${home} is not a directory`);
    }
  } catch (error) {
    return refuse(
      'runtime-unavailable',
      `the Codex home ${home} could not be created: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ok(home);
}

/**
 * The session flags for one permission mode: each a dotted config key and its value.
 *
 * - `approvals_reviewer` is the client, so an approval is never handed to a reviewing agent.
 * - `approval_policy` and `sandbox_mode` are the mode's row of `CODEX_MODE_MAP`.
 * - `web_search` is off: hosted search runs at the provider, where no hook can see it.
 * - `features.hooks` is on, so nothing can switch the hook layer off.
 * - `shell_environment_policy.exclude` names every credential variable this host puts in the
 *   app-server's environment, each by its exact name: the agent's shell inherits that environment
 *   otherwise. Codex matches each entry as a glob, without regard to case, and a name holds no `*` or
 *   `?`, so each entry removes that one variable and nothing else. Its own default exclusions are off
 *   unless asked for, so nothing else removes them.
 */
export function codexSessionFlags(
  mode: CodexPermissionMode,
  credentialVariables: readonly string[] = [],
): Readonly<Record<string, JsonValue>> {
  const row = CODEX_MODE_MAP[mode];
  return {
    approvals_reviewer: CODEX_APPROVALS_REVIEWER,
    approval_policy: row.approvalPolicy,
    sandbox_mode: row.sandbox,
    web_search: 'disabled',
    'features.hooks': true,
    'shell_environment_policy.exclude': [...credentialVariables],
  };
}

/** The flags as `-c key=value` overrides; each value is written as TOML, which these values share with JSON. */
export function codexOverrideArgs(flags: Readonly<Record<string, JsonValue>>): string[] {
  return Object.entries(flags).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
}

/**
 * The command line that starts an app-server: the session flags as root overrides, ahead of the
 * subcommand, then stdio and strict config.
 */
export function codexAppServerArgs(flags: Readonly<Record<string, JsonValue>>): string[] {
  return [...codexOverrideArgs(flags), 'app-server', '--listen', 'stdio://', '--strict-config'];
}

/** Whether two paths name one directory: resolved, and compared without case on Windows, as it does. */
export function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
