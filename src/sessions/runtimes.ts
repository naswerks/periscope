/**
 * What this host states about each runtime it composes sessions for, beside its fact lift: the
 * control tier a session on it starts at, the wire APIs it speaks, and which runtime a session
 * request names.
 *
 * Each lookup has two readers. The tier: the hello's entry for the runtime and the composer that puts
 * the tier on a session's first `ready`, so the tier a hello states and the tier a session carries are
 * the same value by construction. The wire APIs: the check an operator's endpoints meet at start and
 * the check a session's endpoint meets at open, so an endpoint the hello offers a runtime is one that
 * runtime can open on.
 */
import type { EndpointWireApi } from '../control/frames.js';
import { DEFAULT_RUNTIME } from '../control/frames.js';
import type { ControlTier } from '../state/model.js';

/** The control tier a session starts at, per runtime, keyed by the runtime's name. */
export const CONTROL_TIERS = {
  // Every tool call reaches the `PreToolUse` gate before it runs, under every permission mode, and
  // the gate's answer holds: no path falls below it.
  [DEFAULT_RUNTIME]: { level: 'intercepted', degrades: [] },
} as const satisfies Readonly<Record<string, ControlTier>>;

/**
 * The wire APIs each runtime speaks, keyed by the runtime's name, with the same keys as the tiers: a
 * model endpoint is reachable by a runtime only when the runtime speaks the endpoint's API.
 */
export const RUNTIME_WIRE_APIS = {
  // Claude Code calls its model through Anthropic's Messages API, whichever server answers it.
  [DEFAULT_RUNTIME]: ['anthropic-messages'],
} as const satisfies Readonly<Record<keyof typeof CONTROL_TIERS, readonly EndpointWireApi[]>>;

/** The wire APIs `runtime` speaks; empty for a runtime this host does not spawn. */
export function wireApisFor(runtime: string): readonly EndpointWireApi[] {
  if (!Object.hasOwn(RUNTIME_WIRE_APIS, runtime)) return [];
  return (RUNTIME_WIRE_APIS as Readonly<Record<string, readonly EndpointWireApi[]>>)[runtime] ?? [];
}

/** The runtimes this host spawns sessions on, by name. */
export function spawnableRuntimes(): readonly string[] {
  return Object.keys(RUNTIME_WIRE_APIS);
}

/** The control tier a session on `runtime` starts at, or null for a runtime with none declared. */
export function controlTierFor(runtime: string): ControlTier | null {
  if (!Object.hasOwn(CONTROL_TIERS, runtime)) return null;
  return (CONTROL_TIERS as Readonly<Record<string, ControlTier>>)[runtime] ?? null;
}

/** The runtime a session request names: its own `runtime`, or `DEFAULT_RUNTIME` when it names none. */
export function runtimeOf(request: { readonly runtime?: string } | null | undefined): string {
  return request?.runtime ?? DEFAULT_RUNTIME;
}
