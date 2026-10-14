/**
 * The names pi declares at the pinned release, read from the snapshot under `contracts/pi-names.json`
 * when this module loads.
 *
 * The snapshot is regenerated from a pi clone at the release's tag by `scripts/derive-pi-names.mjs`; it
 * holds identifiers only. The coverage pin holds every event, RPC command, RPC record, extension UI
 * method and assistant message event of the release to one row of `PI_COVERAGE`, in both directions,
 * and every built-in tool to one row of the tool-kind map and one local family.
 *
 * The file ships with the package (`files`), so the read works installed as well as in a checkout. A
 * snapshot that is missing, unreadable, or holds an empty list fails here, loudly, at load.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface PiNames {
  /** The release tag the names were read at. */
  readonly release: string;
  /** The version the CLI at that release reports. */
  readonly version: string;
  /** Every `AgentEvent` type. */
  readonly agentEvents: readonly string[];
  /** Every type `AgentSessionEvent` adds to them or restates. */
  readonly sessionEvents: readonly string[];
  /** Every command RPC mode reads on stdin. */
  readonly rpcCommands: readonly string[];
  /** Every record RPC mode writes beside the events. */
  readonly rpcRecords: readonly string[];
  /** Every method an extension UI request names. */
  readonly uiMethods: readonly string[];
  /** Every delta a `message_update` carries. */
  readonly assistantMessageEvents: readonly string[];
  /** Every built-in tool. */
  readonly tools: readonly string[];
}

const LISTS = [
  'agentEvents',
  'sessionEvents',
  'rpcCommands',
  'rpcRecords',
  'uiMethods',
  'assistantMessageEvents',
  'tools',
] as const;

const SNAPSHOT = fileURLToPath(new URL('../../contracts/pi-names.json', import.meta.url));

/** Check a parsed snapshot; the problem in words, or null. Exported for the pin's controls. */
export function piNamesProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'the snapshot is not an object';
  const names = value as Partial<Record<keyof PiNames, unknown>>;
  for (const key of ['release', 'version'] as const) {
    if (typeof names[key] !== 'string' || names[key] === '') return `the snapshot has no ${key}`;
  }
  for (const key of LISTS) {
    const list = names[key];
    if (!Array.isArray(list) || list.length === 0) return `the snapshot's ${key} list is empty`;
    if (!list.every((name) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(name))) {
      return `the snapshot's ${key} list holds an entry that is not a name`;
    }
    if (new Set(list).size !== list.length) return `the snapshot's ${key} list names an entry twice`;
  }
  return null;
}

function load(): PiNames {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  } catch (error) {
    throw new Error(
      `the pi names could not be read from ${SNAPSHOT}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const problem = piNamesProblem(parsed);
  if (problem !== null) throw new Error(`the pi names at ${SNAPSHOT} are unusable: ${problem}`);
  return parsed as PiNames;
}

/** The pinned release's names. */
export const PI_NAMES: PiNames = load();

/** Every event RPC mode writes, once each: the agent's, then those the session adds. */
export function piEventNames(names: PiNames = PI_NAMES): string[] {
  return [...new Set([...names.agentEvents, ...names.sessionEvents])];
}
