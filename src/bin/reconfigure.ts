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
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import {
  claudeTranscriptResolver,
  defaultAgentHome,
  transcriptsRootUnder,
} from '../host/claude-transcripts.js';
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
}

/**
 * The control-plane addresses the running host actually uses: what it dialled at start. A file
 * value that differs is written and reported as pending, never applied to the live link.
 */
export interface LiveAddresses {
  readonly controllerUrl: string | null;
  readonly decisionUrl: string | null;
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
      return isAbsolutePath(value) ? null : `${key} must be an absolute path — got '${value}'`;
    case 'PERISCOPE_BRANCH_SCHEME':
      return value.includes('{key}')
        ? null
        : `PERISCOPE_BRANCH_SCHEME '${value}' has no {key} placeholder — every workspace would render the same branch`;
    default:
      return null;
  }
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
  live?: LiveAddresses,
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
  const transcriptsRoot = agentHome === null ? null : transcriptsRootUnder(agentHome);
  // The addresses in effect are what the host dialled at start; absent a caller's word, the merged
  // view before this ask is the closest thing to it. A key whose file value differs is pending.
  const dialled: LiveAddresses = live ?? {
    controllerUrl: before.controllerUrl,
    decisionUrl: before.decisionUrl,
  };
  const pendingRestart = RESTART_KEYS.filter((key) =>
    key === 'PERISCOPE_CONTROLLER_URL'
      ? after.controllerUrl !== dialled.controllerUrl
      : after.decisionUrl !== dialled.decisionUrl,
  );
  return ok({
    workspaces: workspacesFor(workspaceConfig) ?? undefined,
    transcriptsRoot: transcriptsRoot ?? undefined,
    bulk: transcriptsRoot === null ? undefined : claudeTranscriptResolver(transcriptsRoot),
    linkCapabilities: workspaceCapabilitiesOf(workspaceConfig),
    configuration: hostConfigurationOf(workspaceConfig, {
      transcriptsRoot,
      controllerUrl: after.controllerUrl,
      decisionUrl: after.decisionUrl,
      agentHome,
    }),
    overriddenByEnvironment: overriddenByEnvironment(raw),
    pendingRestart,
  });
}
