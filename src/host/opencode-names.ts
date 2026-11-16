/**
 * The names `@opencode/sdk` declares at the pinned release, read from the snapshot under
 * `contracts/opencode-names.json` when this module loads.
 *
 * The snapshot is regenerated from an install of the release by `scripts/derive-opencode-names.mjs`; it holds
 * identifiers only. The coverage pin holds every event of the release to one row of `OPENCODE_COVERAGE`, in
 * both directions. The tools are held to the server's own list on each host that runs it
 * (`opencode-local.test.ts`).
 *
 * The file ships with the package (`files`), so the read works installed as well as in a checkout. A
 * snapshot that is missing, unreadable, or holds an empty list fails here, loudly, at load.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface OpencodeNames {
  /** The SDK's package name. */
  readonly package: string;
  /** The SDK release the names were read at. */
  readonly version: string;
  /** Every event the server's stream declares, in the order its union names them; a template as `prefix.*`. */
  readonly events: readonly string[];
}

const SNAPSHOT = fileURLToPath(new URL('../../contracts/opencode-names.json', import.meta.url));

/** Check a parsed snapshot; the problem in words, or null. Exported for the pin's controls. */
export function opencodeNamesProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'the snapshot is not an object';
  const names = value as Partial<Record<keyof OpencodeNames, unknown>>;
  for (const key of ['package', 'version'] as const) {
    if (typeof names[key] !== 'string' || names[key] === '') return `the snapshot has no ${key}`;
  }
  const list = names.events;
  if (!Array.isArray(list) || list.length === 0) return "the snapshot's events list is empty";
  if (!list.every((name) => typeof name === 'string' && /^[a-z][a-z0-9-]*(\.([a-z0-9-]+|\*))*$/.test(name))) {
    return "the snapshot's events list holds an entry that is not an event name";
  }
  if (new Set(list).size !== list.length) return "the snapshot's events list names an entry twice";
  return null;
}

function load(): OpencodeNames {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  } catch (error) {
    throw new Error(
      `the opencode names could not be read from ${SNAPSHOT}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const problem = opencodeNamesProblem(parsed);
  if (problem !== null) throw new Error(`the opencode names at ${SNAPSHOT} are unusable: ${problem}`);
  return parsed as OpencodeNames;
}

/** The pinned release's names. */
export const OPENCODE_NAMES: OpencodeNames = load();
