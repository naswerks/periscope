/**
 * What this host states about each runtime it composes sessions for, beside its fact lift: the
 * control tier a session on it starts at, and which runtime a session request names.
 *
 * One lookup with two readers, the hello's entry for the runtime and the composer that puts the tier
 * on a session's first `ready`, so the tier a hello states and the tier a session carries are the same
 * value by construction.
 */
import { DEFAULT_RUNTIME } from '../control/frames.js';
import type { ControlTier } from '../state/model.js';

/** The control tier a session starts at, per runtime, keyed by the runtime's name. */
export const CONTROL_TIERS = {
  // Every tool call reaches the `PreToolUse` gate before it runs, under every permission mode, and
  // the gate's answer holds: no path falls below it.
  [DEFAULT_RUNTIME]: { level: 'intercepted', degrades: [] },
} as const satisfies Readonly<Record<string, ControlTier>>;

/** The control tier a session on `runtime` starts at, or null for a runtime with none declared. */
export function controlTierFor(runtime: string): ControlTier | null {
  if (!Object.hasOwn(CONTROL_TIERS, runtime)) return null;
  return (CONTROL_TIERS as Readonly<Record<string, ControlTier>>)[runtime] ?? null;
}

/** The runtime a session request names: its own `runtime`, or `DEFAULT_RUNTIME` when it names none. */
export function runtimeOf(request: { readonly runtime?: string } | null | undefined): string {
  return request?.runtime ?? DEFAULT_RUNTIME;
}
