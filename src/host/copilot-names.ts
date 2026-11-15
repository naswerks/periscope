/**
 * The names `@github/copilot-sdk` declares at the pinned release, read from the snapshot under
 * `contracts/copilot-names.json` when this module loads.
 *
 * The snapshot is regenerated from an install of the release by `scripts/derive-copilot-names.mjs`; it holds
 * identifiers only. The coverage pin holds every session event of the release to one row of
 * `COPILOT_COVERAGE`, in both directions. The built-in tools are held to the runtime's own list on each host
 * that runs it (the census in `copilot-local.test.ts`), since the list differs by platform.
 *
 * The file ships with the package (`files`), so the read works installed as well as in a checkout. A
 * snapshot that is missing, unreadable, or holds an empty list fails here, loudly, at load.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface CopilotNames {
  /** The SDK's package name. */
  readonly package: string;
  /** The SDK release the names were read at. */
  readonly version: string;
  /** The runtime that release pins. */
  readonly runtimeVersion: string;
  /** Every `SessionEvent` type, in the order the union names them. */
  readonly sessionEvents: readonly string[];
}

const SNAPSHOT = fileURLToPath(new URL('../../contracts/copilot-names.json', import.meta.url));

/** Check a parsed snapshot; the problem in words, or null. Exported for the pin's controls. */
export function copilotNamesProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'the snapshot is not an object';
  const names = value as Partial<Record<keyof CopilotNames, unknown>>;
  for (const key of ['package', 'version', 'runtimeVersion'] as const) {
    if (typeof names[key] !== 'string' || names[key] === '') return `the snapshot has no ${key}`;
  }
  const list = names.sessionEvents;
  if (!Array.isArray(list) || list.length === 0) return "the snapshot's sessionEvents list is empty";
  if (
    !list.every((name) => typeof name === 'string' && /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(name))
  ) {
    return "the snapshot's sessionEvents list holds an entry that is not an event name";
  }
  if (new Set(list).size !== list.length) return "the snapshot's sessionEvents list names an entry twice";
  return null;
}

function load(): CopilotNames {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  } catch (error) {
    throw new Error(
      `the Copilot names could not be read from ${SNAPSHOT}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const problem = copilotNamesProblem(parsed);
  if (problem !== null) throw new Error(`the Copilot names at ${SNAPSHOT} are unusable: ${problem}`);
  return parsed as CopilotNames;
}

/** The pinned release's names. */
export const COPILOT_NAMES: CopilotNames = load();
