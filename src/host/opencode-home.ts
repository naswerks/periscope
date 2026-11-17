/**
 * The runner's opencode home: one base directory the operator names (`PERISCOPE_OPENCODE_HOME`), a fresh home
 * for each session beneath it, and the session databases a resume needs, kept between sessions.
 *
 * Layout under the base:
 * - `sessions/<id>/`: one session's home, made before its host process starts and removed when the session
 *   ends. opencode keeps its database, its configuration, its caches, its logs and its state there: the host
 *   process runs with its home directory and its data, configuration, cache and state directories inside it,
 *   so nothing of the operator's own (`~/.agents`, `~/.claude`, a global configuration) is read, and nothing
 *   is written outside it.
 * - `state/<session id>/`: a session's database, moved out when the session closes and copied into a resumed
 *   session's fresh home before its host process starts, so a resume continues where the session left off.
 *
 * The whole base is in the protected set, and `state/` is an agent's session record.
 *
 * Two environments are composed here, neither holding a credential:
 * - the host process's (`opencodeHostEnv`): the session's spawn environment less every opencode variable and
 *   every other of this host's, its home's directories, and the switches that keep opencode from reaching
 *   for anything this host did not hand it;
 * - the agent's shell's (`opencodeShellEnv`), set as the session's own environment once it exists: the spawn
 *   environment less the same names, as every runtime's agent sees it, so the operator's tools find their
 *   own home.
 *
 * The configuration the server loads (`opencodeConfig`) is composed here too: the session's permission rules
 * (`opencodeRuleset`), the plugins turned off, the one model provider allowed, its servers, its skills and
 * instructions, the title agent off, and the shell. Before the first prompt the server is read back (`opencodeReadBackProblem`):
 * the posture this host created it in, or a refusal naming what differs.
 */
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { OPENCODE_DENIED_TOOLS } from '../gate/tool-kind.js';
import { withinCanonically } from './canonical-path.js';
import type { OpencodeProviderEntry } from './opencode-endpoints.js';
import type { OpencodeMcpServer } from './opencode-mcp.js';
import type { OpencodeRule } from './opencode-sdk.js';

/** The base's two directories. */
export interface OpencodeBase {
  readonly sessions: string;
  readonly state: string;
}

/** One session's home, made. */
export interface OpencodeSessionHome {
  readonly home: string;
  /** The directory the server reads its configuration from: empty, and this host's alone. */
  readonly configDirectory: string;
  /** The session's database. */
  readonly database: string;
  /** The variables that keep the host process inside the home: its home and its data directories. */
  readonly env: Readonly<Record<string, string>>;
  /** Removes the home. Idempotent; a failure is the caller's to report. */
  remove(): Result<void>;
  /** Told the session the home's database holds, once the server has named it, for a later sweep. */
  holds(sessionId: string): void;
}

/**
 * The file in a session's home that says whose it is: the process that made it and, once known, the session
 * its database holds. A home whose process is gone was left by a host that did not close it.
 */
export const OPENCODE_HOME_OWNER_FILE = 'owner.json';

/** The files a session's database is, as SQLite keeps it: the database and its write-ahead log. */
export const OPENCODE_DATABASE_FILES: readonly string[] = ['session.db', 'session.db-wal', 'session.db-shm'];

/** Create the base's directories when absent. Refuses with why it could not. */
export function ensureOpencodeBase(base: string): Result<OpencodeBase> {
  const sessions = join(base, 'sessions');
  const state = join(base, 'state');
  try {
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    mkdirSync(state, { recursive: true, mode: 0o700 });
  } catch (error) {
    return refuse(
      'runtime-unavailable',
      `the opencode home ${base} could not be created: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ok({ sessions, state });
}

/** Make one session's fresh home. Refuses with why it could not; nothing is left behind then. */
export function createOpencodeSessionHome(base: string): Result<OpencodeSessionHome> {
  const ensured = ensureOpencodeBase(base);
  if (!ensured.ok) return ensured;
  const home = join(ensured.value.sessions, randomUUID());
  const directories = {
    profile: join(home, 'profile'),
    data: join(home, 'data'),
    config: join(home, 'config'),
    cache: join(home, 'cache'),
    state: join(home, 'state'),
    roaming: join(home, 'roaming'),
    local: join(home, 'local'),
    configDirectory: join(home, 'opencode-config'),
  };
  const remove = (): Result<void> => {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return ok(undefined);
    } catch (error) {
      return refuse(
        'runtime-unavailable',
        `the session home ${home} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const own = (session: string | null): void => {
    writeFileSync(
      join(home, OPENCODE_HOME_OWNER_FILE),
      JSON.stringify({ pid: process.pid, ...(session === null ? {} : { session }) }),
      { mode: 0o600 },
    );
  };
  try {
    for (const directory of Object.values(directories))
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    own(null);
  } catch (error) {
    remove();
    return refuse(
      'runtime-unavailable',
      `the session home ${home} could not be made: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ok({
    home,
    configDirectory: directories.configDirectory,
    database: join(directories.data, OPENCODE_DATABASE_FILES[0] ?? 'session.db'),
    env: {
      USERPROFILE: directories.profile,
      HOME: directories.profile,
      APPDATA: directories.roaming,
      LOCALAPPDATA: directories.local,
      XDG_DATA_HOME: directories.data,
      XDG_CONFIG_HOME: directories.config,
      XDG_CACHE_HOME: directories.cache,
      XDG_STATE_HOME: directories.state,
    },
    remove,
    holds: (sessionId) => {
      try {
        own(sessionId);
      } catch {
        // A home that could not be marked is swept as one that holds no session.
      }
    },
  });
}

/** Whether a process is still there. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Not permitted to signal it is still a process that exists.
    return (error as { code?: unknown }).code === 'EPERM';
  }
}

/**
 * Clear the session homes a host left behind when it did not close them (it crashed, or was killed): each
 * home whose owner file names a process that is gone. Its database is kept for a resume first, where the
 * file names the session it holds; then the home is removed. A home whose process is still there is another
 * live session's and is left alone, and so is a directory with no owner file this host can read. Returns
 * what could not be done, in words.
 */
export function sweepOpencodeHomes(
  base: string,
  alive: (pid: number) => boolean = processAlive,
): {
  readonly kept: readonly string[];
  readonly removed: readonly string[];
  readonly problems: readonly string[];
} {
  const kept: string[] = [];
  const removed: string[] = [];
  const problems: string[] = [];
  const sessions = join(base, 'sessions');
  let entries: string[];
  try {
    entries = readdirSync(sessions);
  } catch {
    return { kept, removed, problems };
  }
  for (const entry of entries) {
    const home = join(sessions, entry);
    let owner: { pid?: unknown; session?: unknown };
    try {
      owner = JSON.parse(readFileSync(join(home, OPENCODE_HOME_OWNER_FILE), 'utf8')) as typeof owner;
    } catch {
      continue;
    }
    if (typeof owner.pid !== 'number' || alive(owner.pid)) continue;
    if (typeof owner.session === 'string') {
      const carried = carryOpencodeStateOut(
        base,
        join(home, 'data', OPENCODE_DATABASE_FILES[0] ?? 'session.db'),
        owner.session,
      );
      if (carried.ok) kept.push(owner.session);
      else {
        // The database could not be kept: the home is left, so nothing of the session is lost to the sweep.
        problems.push(`a session home a host left behind was not cleared: ${carried.refusal.detail}`);
        continue;
      }
    }
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed.push(home);
    } catch (error) {
      problems.push(
        `the session home ${home}, which a host left behind, could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { kept, removed, problems };
}

/** Whether `id` can name a directory: no separator, no parent step, nothing a path could read twice. */
function isPlainId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== '.' && id !== '..';
}

/** How a kept database is copied, renamed and removed; the file system's own by default. */
export interface OpencodeStateFiles {
  copy(from: string, to: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

const NODE_STATE_FILES: OpencodeStateFiles = {
  copy: copyFileSync,
  rename: renameSync,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

/**
 * Copy a closing session's database out of its home into the base, replacing an older copy. A session that
 * left none moves nothing. Refuses with why it could not.
 *
 * The older copy is replaced, never deleted first: the new database is copied beside it under a name no
 * session id can spell, the older copy is stepped aside, the new one takes its name, and only then is the
 * older one removed. A step that fails leaves the older copy where a resume reads it.
 */
export function carryOpencodeStateOut(
  base: string,
  database: string,
  sessionId: string,
  files: OpencodeStateFiles = NODE_STATE_FILES,
): Result<void> {
  if (!isPlainId(sessionId)) {
    return refuse('runtime-unavailable', `the session id ${sessionId} names no directory`);
  }
  if (!existsSync(database)) return ok(undefined);
  const ensured = ensureOpencodeBase(base);
  if (!ensured.ok) return ensured;
  const to = join(ensured.value.state, sessionId);
  // `~` is in no session id (`isPlainId`), so neither name can be one a resume asks for.
  const arriving = `${to}~arriving`;
  const leaving = `${to}~leaving`;
  try {
    // What an earlier close left half done: an older copy stepped aside and never replaced goes back.
    if (existsSync(leaving) && !existsSync(to)) files.rename(leaving, to);
    files.remove(arriving);
    mkdirSync(arriving, { recursive: true, mode: 0o700 });
    for (const name of OPENCODE_DATABASE_FILES) {
      const from = join(database, '..', name);
      if (existsSync(from)) files.copy(from, join(arriving, name));
    }
    const replaces = existsSync(to);
    if (replaces) {
      files.remove(leaving);
      files.rename(to, leaving);
    }
    try {
      files.rename(arriving, to);
    } catch (error) {
      if (replaces) files.rename(leaving, to);
      throw error;
    }
  } catch (error) {
    try {
      files.remove(arriving);
    } catch {
      // What could not be brought in is left for the next close to clear.
    }
    return refuse(
      'runtime-unavailable',
      `session ${sessionId}'s database could not be kept: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    files.remove(leaving);
  } catch {
    // The new database is in place; the older copy is cleared by the next close.
  }
  return ok(undefined);
}

/**
 * Copy a kept session's database into a fresh home before a resume. Refuses `request-key-unsupported` when the
 * base keeps none for that session, so a resume never starts a different conversation in its place.
 */
export function carryOpencodeStateIn(base: string, database: string, sessionId: string): Result<void> {
  if (!isPlainId(sessionId)) {
    return refuse('request-key-unsupported', `resume names ${sessionId}, which names no opencode session`);
  }
  const from = join(base, 'state', sessionId);
  if (!existsSync(join(from, OPENCODE_DATABASE_FILES[0] ?? 'session.db'))) {
    return refuse(
      'request-key-unsupported',
      `resume names opencode session ${sessionId}, whose database this host does not keep`,
    );
  }
  try {
    for (const name of OPENCODE_DATABASE_FILES) {
      const file = join(from, name);
      if (existsSync(file)) copyFileSync(file, join(database, '..', name));
    }
    return ok(undefined);
  } catch (error) {
    return refuse(
      'runtime-unavailable',
      `session ${sessionId}'s database could not be restored: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Whether `name` is one this host never hands an opencode session: an opencode variable (its feature flags,
 * the program its terminals run through, its own keys; this host sets the ones it means), what Node loads
 * before any code runs, and every variable of this host's own but the further worktrees' paths, which every
 * runtime's agent is given. Matched without regard to case, as Windows matches names.
 */
export function isStrippedOpencodeVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper.startsWith('OPENCODE_') ||
    upper === 'NODE_OPTIONS' ||
    (upper.startsWith('PERISCOPE_') && !upper.startsWith('PERISCOPE_WORKTREE_'))
  );
}

/**
 * The one switch the host process starts with: none of opencode's own free hosted models offered. It is the
 * only variable of its kind the pinned SDK reads. The rest of the posture is not the environment's: the
 * catalogue is not fetched, and a project's configuration and a `.claude` folder are not read, by the options
 * the server is created with (`opencode-host.ts`), and no update is looked for by the configuration
 * (`opencodeConfig`).
 */
export const OPENCODE_SWITCHES: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_FREE_MODELS: '1',
};

/** `env` less every name `isStrippedOpencodeVariable` names, and less every name `over` sets, then `over`. */
function composed(
  env: Readonly<Record<string, string>>,
  over: Readonly<Record<string, string>>,
): Record<string, string> {
  const set = new Set(Object.keys(over).map((name) => name.toUpperCase()));
  return Object.fromEntries([
    ...Object.entries(env).filter(
      ([name]) => !isStrippedOpencodeVariable(name) && !set.has(name.toUpperCase()),
    ),
    ...Object.entries(over),
  ]);
}

/** The host process's environment: the spawn environment, stripped, with the home's variables and the switches. */
export function opencodeHostEnv(
  spawnEnv: Readonly<Record<string, string>>,
  home: Readonly<Record<string, string>>,
): Record<string, string> {
  return composed(spawnEnv, { ...home, ...OPENCODE_SWITCHES });
}

/** The agent's shell's environment: the spawn environment, stripped, as every runtime's agent sees it. */
export function opencodeShellEnv(spawnEnv: Readonly<Record<string, string>>): Record<string, string> {
  return composed(spawnEnv, {});
}

/**
 * The permission rules every session is created with, and every agent is given through the configuration:
 * every action asks, and each tool this host turns off is denied. A tool is turned off only when the last
 * rule matching its action denies it, so the denials follow the rule that asks.
 */
export function opencodeRuleset(): OpencodeRule[] {
  return [
    { action: '*', resource: '*', effect: 'ask' },
    ...OPENCODE_DENIED_TOOLS.map((action): OpencodeRule => ({ action, resource: '*', effect: 'deny' })),
  ];
}

/**
 * The built-in plugins every session runs without: the browser's (its attach writes allow rules into a
 * session), and the image, schedule, artifact and MCP-event tools'. Each one's tools are denied by the rules
 * as well; turning the plugin off keeps its code from running at all.
 */
export const OPENCODE_OFF_PLUGINS: readonly string[] = [
  'opencode.browser',
  'opencode.tool.image-generate',
  'opencode.tool.schedule',
  'opencode.tool.artifact',
  'opencode.tools.mcp-events',
];

/** What a session's configuration is composed from. */
export interface OpencodeConfigParts {
  /** The session's one model provider, by id, with its entry; null for a session with no endpoint. */
  readonly provider: { readonly id: string; readonly entry: OpencodeProviderEntry } | null;
  /** The model the session starts on, on that provider; null when it names none. */
  readonly model: string | null;
  readonly servers: Readonly<Record<string, OpencodeMcpServer>>;
  /** The skill directories handed over. */
  readonly skills: readonly string[];
  /** Files of instructions appended to the runtime's own. */
  readonly instructions: readonly string[];
  /** The shell the `shell` tool runs, by absolute path. */
  readonly shell: string;
}

/** The configuration the session's server loads, as JSON. */
export function opencodeConfig(parts: OpencodeConfigParts): Record<string, unknown> {
  const provider = parts.provider;
  return {
    permissions: opencodeRuleset(),
    plugins: OPENCODE_OFF_PLUGINS.map((id) => `-${id}`),
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      ...(provider === null ? [] : [{ action: 'provider.use', resource: provider.id, effect: 'allow' }]),
    ],
    ...(provider === null ? {} : { providers: { [provider.id]: provider.entry } }),
    ...(provider === null || parts.model === null
      ? {}
      : { model: { providerID: provider.id, model: parts.model } }),
    ...(Object.keys(parts.servers).length === 0 ? {} : { mcp: { servers: { ...parts.servers } } }),
    ...(parts.skills.length === 0 ? {} : { skills: [...parts.skills] }),
    ...(parts.instructions.length === 0 ? {} : { instructions: [...parts.instructions] }),
    // The title agent names a session with a model call of its own, outside any run and any step: no
    // controller asked for it, and no step reports its spend.
    agents: { title: { disabled: true } },
    shell: parts.shell,
    formatter: false,
    lsp: false,
    snapshots: false,
    update: 'disable',
    share: 'disabled',
  };
}

/** The one plugin of this host's a session's server is created with: the pre-call gate (`opencode-host.ts`). */
export const OPENCODE_GATE_PLUGIN = 'periscope.gate';

/** The source the server states for a plugin handed to it at its creation, as an object. */
export const OPENCODE_GATE_PLUGIN_SOURCE = 'sdk';

/** Whether a listed plugin is this host's own pre-call gate: by its id and its source, both. */
export function isOpencodeGatePlugin(plugin: {
  readonly id?: string;
  readonly source: { readonly type: string };
}): boolean {
  return plugin.id === OPENCODE_GATE_PLUGIN && plugin.source.type === OPENCODE_GATE_PLUGIN_SOURCE;
}

/**
 * Why this host's pre-call gate is not running in the server whose plugins these are, or null when it is: it
 * is listed by its id and its source, and the server states it `active`. A gate listed `failed`, or with no
 * state, did not load as far as the server says, and its hook decides nothing.
 */
export function opencodeGateNotActive(plugins: OpencodePostureRead['plugins']): string | null {
  const listed = plugins.find(isOpencodeGatePlugin);
  if (listed === undefined) return "this host's pre-call gate is not among the server's plugins";
  if (listed.state?.status === 'active') return null;
  const stated =
    listed.state === undefined
      ? 'the server states no state for it'
      : `the server states it ${listed.state.status}${listed.state.error === undefined ? '' : `: ${listed.state.error}`}`;
  return `this host's pre-call gate is among the server's plugins but is not active (${stated})`;
}

/**
 * The configuration as the text the server loads. The server follows two references in that text itself,
 * before it parses it and wherever they stand: `{env:NAME}` becomes a variable of the host process's and
 * `{file:path}` the content of any file the host process can read. A value a controller supplied (an MCP
 * server's URL, a header, an argument, a variable) is in that text, so a reference in it would put a file's
 * content into what the server is sent. Nothing this host writes is meant to be followed, so the brace that
 * opens either reference is written as its JSON escape: the text holds no such reference, and the parse
 * gives every value back exactly as it was.
 */
export function opencodeConfigText(config: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(config).replace(/\{(?=(?:env|file):)/g, '\\u007b');
}

/** What the server said about its posture, read before the first prompt. */
export interface OpencodePostureRead {
  /** The session's own rules. */
  readonly rules: readonly OpencodeRule[];
  readonly agents: readonly { readonly id: string; readonly rules: readonly OpencodeRule[] }[];
  readonly saved: readonly { readonly action: string; readonly resource: string }[];
  /** Each plugin by its id, its source and the state the server states it in (`active`, or `failed` and why). */
  readonly plugins: readonly {
    readonly id?: string;
    readonly source: { readonly type: string };
    readonly state?: { readonly status: string; readonly error?: string };
  }[];
  readonly servers: readonly string[];
  readonly config: readonly { readonly type: string; readonly path?: string }[];
  readonly models: readonly { readonly id: string; readonly providerID: string }[];
}

/** What the posture is held to. */
export interface OpencodePostureExpected {
  /** The names of the servers the session attached. */
  readonly servers: readonly string[];
  /** The session's home: every configuration place the server reads lies inside it. */
  readonly home: string;
  /** The session's one provider's id, or null when it has none. */
  readonly providerId: string | null;
}

/** Whether two rule lists are the same rules in the same order. */
function sameRules(read: readonly OpencodeRule[], expected: readonly OpencodeRule[]): boolean {
  return (
    read.length === expected.length &&
    read.every(
      (rule, index) =>
        rule.action === expected[index]?.action &&
        rule.resource === expected[index]?.resource &&
        rule.effect === expected[index]?.effect,
    )
  );
}

/** A rule in words. */
function ruleWords(rule: OpencodeRule): string {
  return `${rule.action} ${rule.resource} ${rule.effect}`;
}

/**
 * Why the server is not in the posture this host created it in, or null when it is: the session's rules are
 * this host's rules exactly; every agent's rules end with them; no approval is saved; every plugin is one of
 * the runtime's own or this host's pre-call gate, and none of those turned off runs; the servers are the
 * session's; no configuration but
 * this host's is loaded; and no model but the session's provider's is offered.
 */
export function opencodeReadBackProblem(
  read: OpencodePostureRead,
  expected: OpencodePostureExpected,
): string | null {
  const rules = opencodeRuleset();
  if (!sameRules(read.rules, rules)) {
    return `the session's rules are not the ones this host wrote: ${read.rules.map(ruleWords).join(', ') || 'none'}`;
  }
  for (const agent of read.agents) {
    if (!sameRules(agent.rules.slice(-rules.length), rules)) {
      return `agent ${agent.id}'s rules do not end with the ones this host configured`;
    }
  }
  if (read.agents.length === 0) return 'the server lists no agent';
  if (read.saved.length > 0) {
    return `the server holds saved approvals: ${read.saved.map((one) => `${one.action} ${one.resource}`).join(', ')}`;
  }
  const foreign = read.plugins.filter(
    (plugin) => plugin.source.type !== 'builtin' && !isOpencodeGatePlugin(plugin),
  );
  if (foreign.length > 0) {
    return `plugins other than the runtime's own are loaded: ${foreign.map((plugin) => plugin.id ?? plugin.source.type).join(', ')}`;
  }
  const off = read.plugins.filter(
    (plugin) => plugin.id !== undefined && OPENCODE_OFF_PLUGINS.includes(plugin.id),
  );
  if (off.length > 0)
    return `plugins this host turns off are loaded: ${off.map((plugin) => plugin.id).join(', ')}`;
  const servers = [...read.servers].sort();
  const attached = [...expected.servers].sort();
  if (servers.length !== attached.length || servers.some((name, index) => name !== attached[index])) {
    return `the server's MCP servers are ${servers.join(', ') || 'none'}, not the session's ${attached.join(', ') || 'none'}`;
  }
  for (const entry of read.config) {
    if (entry.path === undefined) continue;
    if (!withinCanonically(entry.path, expected.home)) {
      return `the server loaded configuration this host did not write: ${entry.path}`;
    }
  }
  const strangers = read.models.filter((model) => model.providerID !== expected.providerId);
  if (strangers.length > 0) {
    return `the server offers models of providers other than the session's: ${[...new Set(strangers.map((model) => model.providerID))].join(', ')}`;
  }
  return null;
}
