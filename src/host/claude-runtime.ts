/**
 * Claude as the hello states it: the one runtime this host spawns sessions on.
 *
 * The entry is built from the same catalog read the hello's `agent` carries, so the two say the same
 * thing by construction: the versions and the models are that read's, the vocabularies are the words
 * this host narrows a request to, and the tier is the one the runtime lookup holds for Claude, the
 * value a session's first `ready` carries too.
 */
import type { HostAgent, HostAgentEntry } from '../control/frames.js';
import { DEFAULT_RUNTIME } from '../control/frames.js';
import { CONTROL_TIERS } from '../sessions/runtimes.js';
import { EFFORT_LEVELS, PERMISSION_MODES } from './wire-request.js';

/**
 * The hello's entry for Claude, from a catalog read. Claude is always available: the catalog was read
 * from the agent SDK this host runs every session through.
 */
export function claudeAgentEntry(agent: HostAgent): HostAgentEntry {
  return {
    runtime: DEFAULT_RUNTIME,
    version: agent.claudeCodeVersion,
    sdkVersion: agent.sdkVersion,
    models: agent.models,
    vocabularies: {
      permissionModes: [...PERMISSION_MODES],
      efforts: [...EFFORT_LEVELS],
      thinking: true,
    },
    controlTier: CONTROL_TIERS[DEFAULT_RUNTIME],
    available: true,
    unavailableReason: null,
  };
}

/** The runtimes this host can spawn, as the hello lists them, from a catalog read: Claude alone. */
export function hostAgentEntries(agent: HostAgent): HostAgentEntry[] {
  return [claudeAgentEntry(agent)];
}
