/**
 * A configuration change asked over the wire (`host_configure`, protocol v7): validate, write,
 * rebuild.
 *
 * Split out of the composition root for the reason `workspaces.ts` gives: everything below the
 * composition root takes its configuration as arguments, and this is the one function that
 * reads the config file, screens a candidate posture and builds the pieces the host swaps in. It
 * is called with the RAW environment because the file fills absences in it (`withConfigFallback`),
 * and the same rule that governs `serve` governs a change made while serving: the environment
 * wins per key, so a value this writes that the environment shadows is reported as overridden,
 * never silently inert.
 *
 * Nothing is written until the whole candidate posture has passed the same screen start-up runs,
 * so a half-applied set never lands on disk; and a change to a workspace root is refused while the
 * host is busy, because a session releases through the provider that provisioned it.
 */
import type { HostConfigureEntry } from '../control/frames.js';
import { isAbsolutePath, normalizePath } from '../core/paths.js';
import { parsePluginDirs, pluginDirsProblem, readPluginManifests } from '../host/plugin-dirs.js';
import { isBatchFile } from '../host/stdio-rpc.js';
import { MAX_PLUGIN_DIRS } from '../control/frames.js';
import { EXTRA_ENV_FLOOR, envFloorEntryCovers } from '../sessions/spawn-env.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { defaultAgentHome } from '../host/paths.js';
import {
  RESTART_KEYS,
  WIRE_CONFIGURABLE_KEYS,
  isWireConfigurableKey,
  readConfigFile,
  withConfigFallback,
  writeConfigEntries,
} from '../host/config-file.js';
import type { HostReconfigured } from '../host/host.js';
import {
  hostConfigurationOf,
  workspaceCapabilitiesOf,
  workspacePostureProblem,
  workspacesFor,
} from './workspaces.js';

/** The effective posture a merged environment describes, with absence as null. */
interface EffectivePosture {
  readonly workspaceRoot: string | null;
  readonly repositoryRoot: string | null;
  readonly branchScheme: string | null;
  readonly workspaceKey: string | null;
  readonly agentHome: string | null;
  readonly controllerUrl: string | null;
  readonly decisionUrl: string | null;
  readonly pluginDirs: string | null;
}

/**
 * What the running host took at start and keeps until the next: the control-plane addresses it
 * dialled, and the agent home its protected set and transcript folders were built from (null = the
 * default under the home directory). A file value that differs is written and reported as pending,
 * never applied live: a session's gate holds the protected set it opened with, so a home changed
 * under it would be reported before its credential files were protected.
 */
export interface LiveSettings {
  readonly controllerUrl: string | null;
  readonly decisionUrl: string | null;
  /** Absent = the merged view before the ask, as for a caller that states no addresses. */
  readonly agentHome?: string | null;
}

function setOrNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

function postureOf(merged: NodeJS.ProcessEnv): EffectivePosture {
  return {
    workspaceRoot: setOrNull(merged['PERISCOPE_WORKSPACE_ROOT']),
    repositoryRoot: setOrNull(merged['PERISCOPE_REPOSITORY_ROOT']),
    branchScheme: setOrNull(merged['PERISCOPE_BRANCH_SCHEME']),
    workspaceKey: setOrNull(merged['PERISCOPE_WORKSPACE_KEY']),
    agentHome: setOrNull(merged['PERISCOPE_AGENT_HOME']),
    controllerUrl: setOrNull(merged['PERISCOPE_CONTROLLER_URL']),
    decisionUrl: setOrNull(merged['PERISCOPE_DECISION_URL']),
    pluginDirs: setOrNull(merged['PERISCOPE_PLUGIN_DIRS']),
  };
}

/**
 * Why a control-plane address cannot be written, or null. The link is dialled as a WebSocket and
 * the decision endpoint is POSTed to, so each key takes the schemes its act can use and nothing
 * else: a value that fits the other key would fail at the first act after the restart it waits for.
 */
/**
 * The first thing wrong with ONE value for ONE key, or null: the per-key half of `candidateProblem`,
 * shared with `periscope config` and the daemon's start-up read so a value the wire would refuse is
 * refused wherever it is typed. A key this screen does not know passes; the closed key set is
 * checked by the writer.
 */
export function configValueProblem(key: string, value: string): string | null {
  switch (key) {
    case 'PERISCOPE_CONTROLLER_URL':
      return addressProblem(key, value, ['ws:', 'wss:']);
    case 'PERISCOPE_DECISION_URL':
      return addressProblem(key, value, ['http:', 'https:']);
    case 'PERISCOPE_WORKSPACE_ROOT':
    case 'PERISCOPE_REPOSITORY_ROOT':
    case 'PERISCOPE_AGENT_HOME':
    case 'PERISCOPE_MODEL_ENDPOINTS':
    case 'PERISCOPE_CODEX_HOME':
    case 'PERISCOPE_QWEN_HOME':
    case 'PERISCOPE_PI_HOME':
      return isAbsolutePath(value) ? null : `${key} must be an absolute path — got '${value}'`;
    case 'PERISCOPE_CODEX_BIN':
      if (!isAbsolutePath(value)) return `${key} must be an absolute path — got '${value}'`;
      return isBatchFile(value)
        ? `${key} names a batch file, which runs only through a shell; name codex.exe, or the npm launcher codex.js — got '${value}'`
        : null;
    case 'PERISCOPE_QWEN_BIN':
      if (!isAbsolutePath(value)) return `${key} must be an absolute path — got '${value}'`;
      return isBatchFile(value)
        ? `${key} names a batch file, which runs only through a shell; name the package's cli-entry.js — got '${value}'`
        : null;
    case 'PERISCOPE_PI_BIN':
      if (!isAbsolutePath(value)) return `${key} must be an absolute path — got '${value}'`;
      return isBatchFile(value)
        ? `${key} names a batch file, which runs only through a shell; name the package's dist/bundle/cli.js — got '${value}'`
        : null;
    case 'PERISCOPE_BRANCH_SCHEME':
      return value.includes('{key}')
        ? null
        : `PERISCOPE_BRANCH_SCHEME '${value}' has no {key} placeholder — every workspace would render the same branch`;
    case 'PERISCOPE_CONTROLLER_ENV_KEYS':
      return controllerEnvKeysProblem(value);
    default:
      return null;
  }
}

/**
 * The names a `PERISCOPE_CONTROLLER_ENV_KEYS` value declares: comma-separated, each trimmed, empty
 * entries dropped. Unset declares nothing.
 */
export function parseControllerEnvKeys(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/**
 * A declaration that could never take effect, by name. A name that is not a variable name, or one the
 * floor covers, declares nothing: no controller could set it, and a declaration that silently does
 * nothing is a misconfiguration nobody finds. The binary's floor is `EXTRA_ENV_FLOOR`, never widened.
 */
function controllerEnvKeysProblem(value: string): string | null {
  for (const name of parseControllerEnvKeys(value)) {
    if (/[\s=*]/.test(name)) {
      return (
        `PERISCOPE_CONTROLLER_ENV_KEYS names '${name}', which is not an environment variable name — ` +
        'declare exact names, comma-separated'
      );
    }
    const covering = EXTRA_ENV_FLOOR.find((entry) => envFloorEntryCovers(entry, name));
    if (covering !== undefined) {
      return (
        `PERISCOPE_CONTROLLER_ENV_KEYS declares ${name}, which is beneath the floor (${covering}): no ` +
        'declaration lets a controller set it, so this one would do nothing'
      );
    }
  }
  return null;
}

function addressProblem(key: string, value: string | null, schemes: readonly string[]): string | null {
  if (value === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${key} must be an absolute URL — got '${value}'`;
  }
  if (!schemes.includes(parsed.protocol)) {
    return `${key} must use ${schemes.map((scheme) => scheme.slice(0, -1)).join(' or ')} — got '${value}'`;
  }
  return null;
}

function sameRoot(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

/** The wire-settable keys the environment sets: their file values are unreachable. */
export function overriddenByEnvironment(raw: NodeJS.ProcessEnv): readonly string[] {
  return WIRE_CONFIGURABLE_KEYS.filter((key) => {
    const value = raw[key];
    return value !== undefined && value !== '';
  });
}

/**
 * The first thing wrong with a candidate posture, or null. The same screen start-up runs
 * (`workspacePostureProblem`) plus the rules the wire needs that start-up gets from the shell: a
 * root must be absolute, and a scheme must render distinct branches (contain `{key}`).
 */
export function candidateProblem(posture: EffectivePosture): string | null {
  for (const [key, value] of [
    ['PERISCOPE_WORKSPACE_ROOT', posture.workspaceRoot],
    ['PERISCOPE_REPOSITORY_ROOT', posture.repositoryRoot],
    ['PERISCOPE_AGENT_HOME', posture.agentHome],
  ] as const) {
    if (value !== null && !isAbsolutePath(value)) return `${key} must be an absolute path — got '${value}'`;
  }
  if (posture.branchScheme !== null && !posture.branchScheme.includes('{key}')) {
    return `PERISCOPE_BRANCH_SCHEME '${posture.branchScheme}' has no {key} placeholder — every workspace would render the same branch`;
  }
  const pluginDirs = parsePluginDirs(posture.pluginDirs);
  if (pluginDirs.length > MAX_PLUGIN_DIRS) {
    return `PERISCOPE_PLUGIN_DIRS names ${pluginDirs.length} directories; at most ${MAX_PLUGIN_DIRS}`;
  }
  const pluginProblem = pluginDirsProblem(pluginDirs);
  if (pluginProblem !== null) return `PERISCOPE_PLUGIN_DIRS: ${pluginProblem}`;
  const controller = addressProblem('PERISCOPE_CONTROLLER_URL', posture.controllerUrl, ['ws:', 'wss:']);
  if (controller !== null) return controller;
  const decision = addressProblem('PERISCOPE_DECISION_URL', posture.decisionUrl, ['http:', 'https:']);
  if (decision !== null) return decision;
  return workspacePostureProblem({
    workspaceRoot: posture.workspaceRoot,
    repositoryRoot: posture.repositoryRoot,
    branchScheme: posture.branchScheme,
    workspaceKey: posture.workspaceKey,
  });
}

/**
 * Apply the entries: screen every key, screen the candidate posture as a whole, refuse a roots
 * change while busy, write the file once, and rebuild what the host swaps in.
 */
export function reconfigureHost(
  raw: NodeJS.ProcessEnv,
  entries: readonly HostConfigureEntry[],
  hostBusy: boolean,
  live?: LiveSettings,
): Result<HostReconfigured> {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isWireConfigurableKey(entry.key)) {
      return refuse(
        'config-key-unknown',
        `'${entry.key}' is not a key this host takes over the wire — the settable keys are ${WIRE_CONFIGURABLE_KEYS.join(', ')}`,
      );
    }
    if (seen.has(entry.key)) {
      return refuse('config-value-invalid', `'${entry.key}' is named twice in one ask`);
    }
    seen.add(entry.key);
  }

  const file = readConfigFile(raw);
  if (file.problem !== null) {
    return refuse('config-write-failed', `${file.problem} — fix or remove it before writing`);
  }
  const before = postureOf(withConfigFallback(raw, file.values));

  // The candidate: the file with the entries applied, under the environment. An empty value is the
  // documented twin of unset everywhere this package reads, so it removes the key like null does.
  const nextValues: Record<string, string> = { ...file.values };
  const writes: { key: string; value: string | null }[] = [];
  for (const entry of entries) {
    const value = entry.value === null || entry.value === '' ? null : entry.value;
    if (value === null) delete nextValues[entry.key];
    else nextValues[entry.key] = value;
    writes.push({ key: entry.key, value });
  }
  // A written address is screened on its own, before the merge: the environment may shadow it today,
  // and a bad value would still be the one the next start reads once the shadow lifts.
  for (const write of writes) {
    if (write.value === null) continue;
    const problem =
      write.key === 'PERISCOPE_CONTROLLER_URL'
        ? addressProblem(write.key, write.value, ['ws:', 'wss:'])
        : write.key === 'PERISCOPE_DECISION_URL'
          ? addressProblem(write.key, write.value, ['http:', 'https:'])
          : null;
    if (problem !== null) return refuse('config-value-invalid', problem);
  }
  const merged = withConfigFallback(raw, nextValues);
  const after = postureOf(merged);

  const problem = candidateProblem(after);
  if (problem !== null) return refuse('config-value-invalid', problem);

  const rootsChange =
    !sameRoot(before.workspaceRoot, after.workspaceRoot) ||
    !sameRoot(before.repositoryRoot, after.repositoryRoot);
  if (rootsChange && hostBusy) {
    return refuse(
      'config-host-busy',
      'a workspace root cannot change while a session is live or opening on this host — close every session and ask again',
    );
  }

  const written = writeConfigEntries(raw, writes);
  if (written !== null) return refuse('config-write-failed', written);

  const workspaceConfig = {
    workspaceRoot: after.workspaceRoot,
    repositoryRoot: after.repositoryRoot,
    branchScheme: after.branchScheme,
  };
  const agentHome = after.agentHome ?? defaultAgentHome(raw);
  const pluginDirs = parsePluginDirs(after.pluginDirs);
  // What is in effect is what the host took at start; absent a caller's word, the merged view before
  // this ask is the closest thing to it. A key whose file value differs is pending.
  const inEffect: Record<(typeof RESTART_KEYS)[number], string | null> = {
    PERISCOPE_CONTROLLER_URL: live === undefined ? before.controllerUrl : live.controllerUrl,
    PERISCOPE_DECISION_URL: live === undefined ? before.decisionUrl : live.decisionUrl,
    PERISCOPE_AGENT_HOME: live?.agentHome === undefined ? before.agentHome : live.agentHome,
  };
  const asked: Record<(typeof RESTART_KEYS)[number], string | null> = {
    PERISCOPE_CONTROLLER_URL: after.controllerUrl,
    PERISCOPE_DECISION_URL: after.decisionUrl,
    PERISCOPE_AGENT_HOME: after.agentHome,
  };
  const pendingRestart = RESTART_KEYS.filter((key) => asked[key] !== inEffect[key]);
  return ok({
    workspaces: workspacesFor(workspaceConfig) ?? undefined,
    // The binary composes no bulk resolver, and an agent-home change rebuilds none.
    bulk: undefined,
    linkCapabilities: workspaceCapabilitiesOf(workspaceConfig),
    configuration: hostConfigurationOf(workspaceConfig, {
      controllerUrl: after.controllerUrl,
      decisionUrl: after.decisionUrl,
      agentHome,
      plugins: readPluginManifests(pluginDirs),
    }),
    pluginDirs,
    overriddenByEnvironment: overriddenByEnvironment(raw),
    pendingRestart,
  });
}
