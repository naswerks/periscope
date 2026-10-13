/**
 * The names the Codex app-server protocol declares at the pinned release, read from the snapshot under
 * `contracts/codex-protocol-names.json` when this module loads.
 *
 * The snapshot is regenerated from a Codex clone at the release's tag by
 * `scripts/derive-codex-names.mjs`; it holds identifiers only. Two things read it:
 * - the coverage pin, which holds every notification, server request and item kind of the release to
 *   one row of `CODEX_COVERAGE`, in both directions;
 * - the wire module, which reads a field whose key the package's own text never spells through the
 *   snapshot's key table (`wireKeys`), here as `codexWireKey`.
 *
 * The file ships with the package (`files`), so the read works installed as well as in a checkout. A
 * snapshot that is missing, unreadable, or whose key table does not map exactly one wire key to each
 * member fails here, loudly, at load: a key read from an empty table would read nothing and say
 * nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** One method of the protocol, and whether it reaches a connection that did not opt into experimental API. */
export interface CodexMethodName {
  readonly method: string;
  readonly experimental: boolean;
}

export interface CodexNames {
  /** The release tag the names were read at. */
  readonly release: string;
  /** The version the binary at that release reports. */
  readonly version: string;
  readonly notifications: readonly CodexMethodName[];
  readonly serverRequests: readonly CodexMethodName[];
  readonly itemKinds: readonly string[];
  readonly clientMethods: readonly CodexMethodName[];
  /** Per message shape, the wire key read into each adapter member. */
  readonly wireKeys: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The members the adapter reads through the key table, by the shape that carries them. */
export const CODEX_KEYED_MEMBERS = { agentMessage: ['stage'] } as const;

export type CodexKeyedShape = keyof typeof CODEX_KEYED_MEMBERS;

const SNAPSHOT = fileURLToPath(new URL('../../contracts/codex-protocol-names.json', import.meta.url));

/** Check a parsed snapshot; the problem in words, or null. Exported for the pin's controls. */
export function codexNamesProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'the snapshot is not an object';
  const names = value as Partial<Record<keyof CodexNames, unknown>>;
  for (const key of ['release', 'version'] as const) {
    if (typeof names[key] !== 'string' || names[key] === '') return `the snapshot has no ${key}`;
  }
  for (const key of ['notifications', 'serverRequests', 'clientMethods'] as const) {
    const list = names[key];
    if (!Array.isArray(list) || list.length === 0) return `the snapshot's ${key} list is empty`;
    for (const entry of list as unknown[]) {
      const method = (entry as { method?: unknown }).method;
      const experimental = (entry as { experimental?: unknown }).experimental;
      if (typeof method !== 'string' || method === '' || typeof experimental !== 'boolean') {
        return `the snapshot's ${key} holds an entry that is not { method, experimental }`;
      }
    }
  }
  const kinds = names.itemKinds;
  if (
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    !kinds.every((kind) => typeof kind === 'string' && kind !== '')
  ) {
    return "the snapshot's itemKinds list is empty or holds a non-name";
  }
  const table = names.wireKeys;
  if (typeof table !== 'object' || table === null) return 'the snapshot has no wireKeys table';
  for (const [shape, members] of Object.entries(CODEX_KEYED_MEMBERS)) {
    const keys = (table as Record<string, unknown>)[shape];
    if (typeof keys !== 'object' || keys === null) return `the wireKeys table has no ${shape} row`;
    for (const member of members) {
      const mapped = Object.entries(keys as Record<string, unknown>).filter(
        ([, target]) => target === member,
      );
      if (mapped.length !== 1) {
        return `the wireKeys table maps ${mapped.length} wire keys of ${shape} to ${member}, not exactly one`;
      }
      if (mapped[0]?.[0] === '') return `the wireKeys table maps an empty wire key of ${shape} to ${member}`;
    }
  }
  return null;
}

function load(): CodexNames {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  } catch (error) {
    throw new Error(
      `the Codex protocol names could not be read from ${SNAPSHOT}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const problem = codexNamesProblem(parsed);
  if (problem !== null) throw new Error(`the Codex protocol names at ${SNAPSHOT} are unusable: ${problem}`);
  return parsed as CodexNames;
}

/** The pinned release's names. */
export const CODEX_NAMES: CodexNames = load();

/** The wire key a message shape carries an adapter member under. */
export function codexWireKey<S extends CodexKeyedShape>(
  shape: S,
  member: (typeof CODEX_KEYED_MEMBERS)[S][number],
): string {
  const keys = CODEX_NAMES.wireKeys[shape] ?? {};
  const found = Object.entries(keys).find(([, target]) => target === member);
  // `codexNamesProblem` held this at load; reaching here without it is a defect, said by name.
  if (found === undefined) throw new Error(`no wire key of ${shape} maps to ${member}`);
  return found[0];
}

/** The notification names a stable connection receives. */
export function codexStableNotifications(): readonly string[] {
  return CODEX_NAMES.notifications.filter((entry) => !entry.experimental).map((entry) => entry.method);
}
