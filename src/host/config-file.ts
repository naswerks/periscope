/**
 * The config file: the CLI as a first-class writer, so a library user with no UI is not env-only.
 *
 * It lives beside the credential files on purpose. `periscopeCredentialDir(env)` is the single
 * source both the token cache's location and the gate's protected set derive from, so a config file
 * written under it is protected from the sessions this host runs by having been put there — not by
 * somebody remembering to add a line. (Nothing in it is secret today; the property costs nothing
 * and the alternative is a second directory with a second protection question.)
 *
 * The environment still wins, per key. The file is a fallback for an absence: a value here is
 * consulted only when the same variable is unset or empty in the process environment, so a
 * deployment that sets env vars is configured by them alone — and there is
 * never a precedence question to look up, because a stated env var makes the file's value
 * unreachable. `withConfigFallback` is the one place that rule is implemented.
 *
 * The key set is closed, on both the write and the read. An unknown key written is refused naming
 * the legal set (a typo'd key that "worked" would configure nothing, silently). An unknown key
 * read is a problem too, for the same reason from the other side: this host wrote none, so one in
 * the file is a hand-edit that does nothing, the misconfiguration nobody finds. And
 * `PERISCOPE_CONFIG_DIR` is deliberately not settable here: it is what says where this file is,
 * and a file that could move itself is a bootstrap circle.
 *
 * Sync I/O throughout, deliberately: `serve()` stays synchronous (its own docblock says why), and a
 * one-shot read at boot plus a one-shot write per `config` invocation need no event loop.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { join, periscopeCredentialDir } from './paths.js';

/**
 * Every key the config file may carry — the environment variables the composition root reads,
 * minus `PERISCOPE_CONFIG_DIR` (the bootstrap exclusion above).
 */
export const CONFIG_KEYS = [
  'PERISCOPE_CONTROLLER_URL',
  'PERISCOPE_DECISION_URL',
  'PERISCOPE_HOST_ID',
  'PERISCOPE_WORKSPACE_ROOT',
  'PERISCOPE_REPOSITORY_ROOT',
  'PERISCOPE_BRANCH_SCHEME',
  'PERISCOPE_WORKSPACE_KEY',
  'PERISCOPE_AGENT_HOME',
  'PERISCOPE_PLUGIN_DIRS',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

/**
 * The keys a controller may set over the wire (`host_configure`): where this machine's things are,
 * and where its control plane is. The two URLs are written to the file and never applied to
 * the live link: the host dials what it dialled until its next start, and names the keys as pending
 * in its answer and in every hello until then. Never the host id (a paired credential outranks it
 * anyway) or the default workspace key (a start-up posture, screened at boot).
 */
export const WIRE_CONFIGURABLE_KEYS = [
  'PERISCOPE_WORKSPACE_ROOT',
  'PERISCOPE_REPOSITORY_ROOT',
  'PERISCOPE_BRANCH_SCHEME',
  'PERISCOPE_AGENT_HOME',
  'PERISCOPE_PLUGIN_DIRS',
  'PERISCOPE_CONTROLLER_URL',
  'PERISCOPE_DECISION_URL',
] as const satisfies readonly ConfigKey[];

export type WireConfigurableKey = (typeof WIRE_CONFIGURABLE_KEYS)[number];

/** The wire-settable keys that take effect only at the next start: the control-plane addresses. */
export const RESTART_KEYS = [
  'PERISCOPE_CONTROLLER_URL',
  'PERISCOPE_DECISION_URL',
] as const satisfies readonly WireConfigurableKey[];

export function isWireConfigurableKey(value: string): value is WireConfigurableKey {
  return (WIRE_CONFIGURABLE_KEYS as readonly string[]).includes(value);
}

export function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value);
}

/** Where the config file lives, or null when there is nowhere to keep one (no home, no override). */
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = periscopeCredentialDir(env);
  return dir === null ? null : join(dir, 'config.json');
}

/** What a read found: the values, or the named problem that makes them unusable. */
export interface ConfigFileReading {
  readonly values: Readonly<Record<string, string>>;
  /** Null when the file is usable (a missing file is usable: it reads as empty). */
  readonly problem: string | null;
}

/**
 * Read the config file. A MISSING file is `{}` — the ordinary state of every machine that has
 * never run `periscope config`. A file that exists and cannot be used is a PROBLEM, never a silent
 * empty: falling back would make a corrupt file behave like a deliberate absence, which is the
 * exact ambiguity the paired credential's fatal-on-corrupt posture exists to end.
 */
export function readConfigFile(env: NodeJS.ProcessEnv = process.env): ConfigFileReading {
  const path = configFilePath(env);
  if (path === null) return { values: {}, problem: null };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { values: {}, problem: null };
    return {
      values: {},
      problem: `the config file at ${path} exists and cannot be read: ${describe(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      values: {},
      problem: `the config file at ${path} is not JSON: ${describe(error)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      values: {},
      problem: `the config file at ${path} must hold one JSON object of string values`,
    };
  }

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isConfigKey(key)) {
      return {
        values: {},
        problem:
          `the config file at ${path} carries an unknown key '${key}' — this host reads only ` +
          `${CONFIG_KEYS.join(', ')}, so the entry would configure nothing`,
      };
    }
    if (typeof value !== 'string') {
      return {
        values: {},
        problem: `the config file at ${path} carries a non-string value for '${key}'`,
      };
    }
    values[key] = value;
  }
  return { values, problem: null };
}

/**
 * Write one entry, creating the directory and file as needed. Returns null, or the named problem.
 * Refuses an unknown key BEFORE touching the disk — see the closed-set rule in the header.
 */
export function writeConfigEntry(env: NodeJS.ProcessEnv, key: string, value: string): string | null {
  if (!isConfigKey(key)) {
    return `'${key}' is not a config key this host reads — the legal keys are ${CONFIG_KEYS.join(', ')}`;
  }
  const path = configFilePath(env);
  if (path === null) {
    return 'there is nowhere to keep a config file — no home directory and no PERISCOPE_CONFIG_DIR';
  }
  const existing = readConfigFile(env);
  if (existing.problem !== null) {
    // Never merged-over: writing "around" a corrupt file destroys whatever the operator hand-wrote.
    return `${existing.problem} — fix or remove it before writing`;
  }
  try {
    const dir = path.slice(0, path.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    const next = { ...existing.values, [key]: value };
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return null;
  } catch (error) {
    return `the config file at ${path} could not be written: ${describe(error)}`;
  }
}

/** One entry of a multi-key write: a value to set, or null to remove the key. */
export interface ConfigEntryWrite {
  readonly key: string;
  readonly value: string | null;
}

/**
 * Write several entries as one read-modify-write, creating the directory and file as needed.
 * Returns null, or the named problem. Every key is screened BEFORE the disk is touched, so a set
 * with one bad key writes nothing; a null value removes its key. The same corrupt-file posture as
 * the single-entry write: never merged over.
 */
export function writeConfigEntries(
  env: NodeJS.ProcessEnv,
  entries: readonly ConfigEntryWrite[],
): string | null {
  for (const entry of entries) {
    if (!isConfigKey(entry.key)) {
      return `'${entry.key}' is not a config key this host reads — the legal keys are ${CONFIG_KEYS.join(', ')}`;
    }
  }
  const path = configFilePath(env);
  if (path === null) {
    return 'there is nowhere to keep a config file — no home directory and no PERISCOPE_CONFIG_DIR';
  }
  const existing = readConfigFile(env);
  if (existing.problem !== null) {
    return `${existing.problem} — fix or remove it before writing`;
  }
  try {
    const dir = path.slice(0, path.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    const next: Record<string, string> = { ...existing.values };
    for (const entry of entries) {
      if (entry.value === null) delete next[entry.key];
      else next[entry.key] = entry.value;
    }
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return null;
  } catch (error) {
    return `the config file at ${path} could not be written: ${describe(error)}`;
  }
}

/**
 * The environment, with file values FILLING ABSENCES — the one implementation of "env wins".
 *
 * Returns a NEW plain object; the process environment is never mutated. Only the closed key set is
 * consulted, so nothing outside it (identity configuration, the config dir itself) can arrive from
 * a file. Empty-string env values count as absent, matching how the composition root reads them.
 */
export function withConfigFallback(
  env: NodeJS.ProcessEnv,
  values: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const key of CONFIG_KEYS) {
    const fromEnv = env[key];
    const fromFile = values[key];
    if ((fromEnv === undefined || fromEnv === '') && fromFile !== undefined && fromFile !== '') {
      merged[key] = fromFile;
    }
  }
  return merged;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
