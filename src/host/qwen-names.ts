/**
 * The names Qwen Code declares at the pinned release, read from the snapshot under
 * `contracts/qwen-code-names.json` when this module loads.
 *
 * The snapshot is regenerated from a Qwen Code clone at the release's tag by
 * `scripts/derive-qwen-names.mjs`; it holds identifiers only. Two things read it:
 * - the session's settings, whose ask rules name every tool of the release (`tools`), so that every
 *   built-in tool asks this host before it runs;
 * - the coverage pin, which holds every message type, system subtype, stream event and control request
 *   of the release to one row of `QWEN_COVERAGE`, in both directions.
 *
 * The file ships with the package (`files`), so the read works installed as well as in a checkout. A
 * snapshot that is missing, unreadable, or holds an empty list fails here, loudly, at load: an ask list
 * read from an empty snapshot would name no tool and leave every default-allowed one undecided.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface QwenNames {
  /** The release tag the names were read at. */
  readonly release: string;
  /** The version the CLI at that release reports. */
  readonly version: string;
  /** Every built-in tool name, in declaration order: the ask list. */
  readonly tools: readonly string[];
  /** The `type` of every message on the stream. */
  readonly messageTypes: readonly string[];
  readonly resultSubtypes: readonly string[];
  readonly contentBlocks: readonly string[];
  /** Every subtype the CLI writes on a `system` message. */
  readonly systemSubtypes: readonly string[];
  /** Every event a `stream_event` carries, and every delta inside a content block delta. */
  readonly streamEvents: readonly string[];
  readonly streamDeltas: readonly string[];
  /** The control requests the CLI routes, and the ones it sends this host. */
  readonly hostControlRequests: readonly string[];
  readonly cliControlRequests: readonly string[];
}

const LISTS = [
  'tools',
  'messageTypes',
  'resultSubtypes',
  'contentBlocks',
  'systemSubtypes',
  'streamEvents',
  'streamDeltas',
  'hostControlRequests',
  'cliControlRequests',
] as const;

const SNAPSHOT = fileURLToPath(new URL('../../contracts/qwen-code-names.json', import.meta.url));

/** Check a parsed snapshot; the problem in words, or null. Exported for the pin's controls. */
export function qwenNamesProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'the snapshot is not an object';
  const names = value as Partial<Record<keyof QwenNames, unknown>>;
  for (const key of ['release', 'version'] as const) {
    if (typeof names[key] !== 'string' || names[key] === '') return `the snapshot has no ${key}`;
  }
  for (const key of LISTS) {
    const list = names[key];
    if (!Array.isArray(list) || list.length === 0) return `the snapshot's ${key} list is empty`;
    if (!list.every((name) => typeof name === 'string' && /^[a-z][a-z0-9_]*$/.test(name))) {
      return `the snapshot's ${key} list holds an entry that is not a name`;
    }
    if (new Set(list).size !== list.length) return `the snapshot's ${key} list names an entry twice`;
  }
  return null;
}

function load(): QwenNames {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  } catch (error) {
    throw new Error(
      `the Qwen Code names could not be read from ${SNAPSHOT}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const problem = qwenNamesProblem(parsed);
  if (problem !== null) throw new Error(`the Qwen Code names at ${SNAPSHOT} are unusable: ${problem}`);
  return parsed as QwenNames;
}

/** The pinned release's names. */
export const QWEN_NAMES: QwenNames = load();
