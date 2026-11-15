/**
 * The runner's Copilot home: one base directory the operator names (`PERISCOPE_COPILOT_HOME`), a fresh home
 * for each session beneath it, and the session states a resume needs, kept between sessions.
 *
 * Layout under the base:
 * - `sessions/<id>/`: one session's home (`COPILOT_HOME`), made before the runtime starts and removed when the
 *   session ends. The runtime keeps the session's state, its settings and any file credential there, and
 *   the runtime's own caches leave with it: this host names `cache/` here as the runtime's cache directory
 *   (`COPILOT_CACHE_HOME`) on every platform, and points `%LOCALAPPDATA%` and `%APPDATA%`, which the runtime
 *   writes beneath on Windows, into `local/` and `roaming/`.
 * - `state/<session id>/`: a session's `session-state/<session id>`, moved out when the session closes and
 *   copied into a resumed session's fresh home before the runtime starts, so a resume continues where the
 *   session left off.
 *
 * The whole base is in the protected set, and `state/` is an agent's session record.
 *
 * Before the first prompt the runtime itself is read back (`copilotReadBackProblem`): the posture this host
 * started it in, or a refusal naming what differs.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { COPILOT_EXCLUDED_TOOLS } from '../gate/tool-kind.js';
import { canonicalPath, withinCanonically } from './canonical-path.js';
import { COPILOT_ADMITTED_AGENT_MODES, COPILOT_ADMITTED_PERMISSION_MODE } from './copilot-gate.js';
import type { CopilotTokenAnswer, CopilotTokenRequest } from './copilot-sdk.js';

/** The base's two directories. */
export interface CopilotBase {
  readonly sessions: string;
  readonly state: string;
}

/** One session's home, made. */
export interface CopilotSessionHome {
  readonly home: string;
  /** The variables the runtime is started with to keep its caches inside the home. */
  readonly env: Readonly<Record<string, string>>;
  /** Removes the home. Idempotent; a failure is the caller's to report. */
  remove(): Result<void>;
}

/** Create the base's directories when absent. Refuses with why it could not. */
export function ensureCopilotBase(base: string): Result<CopilotBase> {
  const sessions = join(base, 'sessions');
  const state = join(base, 'state');
  try {
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    mkdirSync(state, { recursive: true, mode: 0o700 });
  } catch (error) {
    return refuse(
      'runtime-unavailable',
      `the Copilot home ${base} could not be created: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ok({ sessions, state });
}

/**
 * The variable the runtime reads its cache directory from, before the platform's own (`%LOCALAPPDATA%`, or
 * `XDG_CACHE_HOME` and the home's `.cache`). The platform's own is left alone off Windows: every command the
 * agent runs reads it too.
 */
export const COPILOT_CACHE_VARIABLE = 'COPILOT_CACHE_HOME';

/** Make one session's fresh home. Refuses with why it could not; nothing is left behind then. */
export function createCopilotSessionHome(base: string): Result<CopilotSessionHome> {
  const ensured = ensureCopilotBase(base);
  if (!ensured.ok) return ensured;
  const home = join(ensured.value.sessions, randomUUID());
  const remove = (): Result<void> => {
    try {
      rmSync(home, { recursive: true, force: true });
      return ok(undefined);
    } catch (error) {
      return refuse(
        'runtime-unavailable',
        `the session home ${home} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  try {
    mkdirSync(join(home, 'local'), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'roaming'), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'cache'), { recursive: true, mode: 0o700 });
  } catch (error) {
    remove();
    return refuse(
      'runtime-unavailable',
      `the session home ${home} could not be made: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ok({
    home,
    env: {
      LOCALAPPDATA: join(home, 'local'),
      APPDATA: join(home, 'roaming'),
      [COPILOT_CACHE_VARIABLE]: join(home, 'cache'),
    },
    remove,
  });
}

/** Where a session's state lives under its home. */
function sessionStateOf(home: string, sessionId: string): string {
  return join(home, 'session-state', sessionId);
}

/** Whether `id` can name a directory: no separator, no parent step, nothing a path could read twice. */
function isPlainId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== '.' && id !== '..';
}

/**
 * Move a closing session's state out of its home into the base, replacing an older copy. A session that
 * left none moves nothing. Refuses with why it could not.
 */
export function carryCopilotStateOut(base: string, home: string, sessionId: string): Result<void> {
  if (!isPlainId(sessionId))
    return refuse('runtime-unavailable', `the session id ${sessionId} names no directory`);
  const from = sessionStateOf(home, sessionId);
  if (!existsSync(from)) return ok(undefined);
  const ensured = ensureCopilotBase(base);
  if (!ensured.ok) return ensured;
  const to = join(ensured.value.state, sessionId);
  try {
    rmSync(to, { recursive: true, force: true });
    try {
      renameSync(from, to);
    } catch {
      // Across devices, or held open: a copy carries it as well.
      cpSync(from, to, { recursive: true });
    }
    return ok(undefined);
  } catch (error) {
    return refuse(
      'runtime-unavailable',
      `session ${sessionId}'s state could not be kept: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Copy a kept session's state into a fresh home before a resume. Refuses `request-key-unsupported` when the
 * base keeps no state for that session, so a resume never starts a different conversation in its place.
 */
export function carryCopilotStateIn(base: string, home: string, sessionId: string): Result<void> {
  if (!isPlainId(sessionId)) {
    return refuse('request-key-unsupported', `resume names ${sessionId}, which names no Copilot session`);
  }
  const from = join(base, 'state', sessionId);
  if (!existsSync(from)) {
    return refuse(
      'request-key-unsupported',
      `resume names Copilot session ${sessionId}, whose state this host does not keep`,
    );
  }
  try {
    cpSync(from, sessionStateOf(home, sessionId), { recursive: true });
    return ok(undefined);
  } catch (error) {
    return refuse(
      'runtime-unavailable',
      `session ${sessionId}'s state could not be restored: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The variables never handed to the runtime: each is a GitHub credential the runtime or the agent's shell
 * would read (the runtime hands its whole environment to the agent's shell), the variable that names
 * which GitHub host a sign-in is for, or the variable that would swap the pinned runtime for another.
 * Matched without regard to case, as Windows matches names. Every `COPILOT_` name goes too; the SDK sets
 * the two it needs itself (`COPILOT_HOME`, `COPILOT_DISABLE_KEYTAR`).
 */
export const COPILOT_STRIPPED_VARIABLES: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
];

/** Whether `name` is one this host never hands the runtime. */
export function isStrippedCopilotVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('COPILOT_') || COPILOT_STRIPPED_VARIABLES.includes(upper);
}

/**
 * The runtime's environment: the session's spawn environment less every variable `isStrippedCopilotVariable`
 * names, with the home's own variables beside.
 */
export function copilotRuntimeEnv(
  spawnEnv: Readonly<Record<string, string>>,
  home: Readonly<Record<string, string>>,
): Record<string, string> {
  const kept = Object.entries(spawnEnv).filter(([name]) => !isStrippedCopilotVariable(name));
  const homeNames = new Set(Object.keys(home).map((name) => name.toUpperCase()));
  return Object.fromEntries([
    ...kept.filter(([name]) => !homeNames.has(name.toUpperCase())),
    ...Object.entries(home),
  ]);
}

/**
 * How long a GitHub token this host hands over is said to last, in seconds: eight hours, the lifetime the
 * SDK states production tokens have. The runtime refuses a token with an hour or less left once it has
 * checked it, so the figure must be above that; it asks again before the figure runs out, and the file is
 * read again then.
 */
export const COPILOT_TOKEN_LIFETIME_SECONDS = 8 * 60 * 60;

/** The one GitHub host the operator's token is given for. */
export const COPILOT_TOKEN_HOST = 'github.com';

/** A host as the runtime names it (`https://github.com`, `github.com/`), as its bare name in lower case. */
function hostNameOf(host: unknown): string {
  if (typeof host !== 'string') return '';
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

/**
 * The session-level token provider: the operator's token file, read at each acquisition, so a rotated token
 * is taken without a restart. The token crosses the SDK's own pipe and never the runtime's environment. A
 * missing or empty file answers that there is nothing to give. The token is the operator's sign-in to
 * `github.com`, so it is given for that host alone: asked for any other, the provider gives nothing and
 * tells `onOtherHost` which host asked.
 */
export function copilotTokenProvider(
  file: string,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  onOtherHost: (host: string) => void = () => undefined,
): (request: CopilotTokenRequest) => Promise<CopilotTokenAnswer> {
  return (request): Promise<CopilotTokenAnswer> => {
    if (hostNameOf(request.host) !== COPILOT_TOKEN_HOST) {
      try {
        onOtherHost(typeof request.host === 'string' ? request.host : '');
      } catch {
        // Saying which host asked must not turn a refusal to answer into a thrown one.
      }
      return Promise.resolve({ kind: 'cancelled' });
    }
    let token: string;
    try {
      token = read(file).trim();
    } catch {
      return Promise.resolve({ kind: 'cancelled' });
    }
    return Promise.resolve(
      token === ''
        ? { kind: 'cancelled' }
        : { kind: 'token', accessToken: token, expiresIn: COPILOT_TOKEN_LIFETIME_SECONDS },
    );
  };
}

/** Where a machine-wide policy hook could sit, beside the session's own configuration. */
export interface CopilotPolicyHookSources {
  /** Each directory policy documents are read from; none on a host with no such directory. */
  readonly directories: readonly string[];
  /** Whether the machine's policy key holds anything; null when it cannot be read. Absent on a host with no key. */
  readonly registryHolds?: () => Promise<boolean | null>;
}

/**
 * What a look for machine-wide policy hooks found. A source that could not be read is kept apart from one
 * that holds nothing: it is not known to hold none.
 */
export interface CopilotPolicyLook {
  /** Each source that holds a policy hook: a file, a key, or the runtime's own label for one. */
  readonly found: readonly string[];
  /** Each source that could not be read, with why. */
  readonly unread: readonly string[];
}

/** The machine's Copilot policy key. Policy hooks there run whatever a session's own settings say. */
export const COPILOT_POLICY_KEY = 'HKLM\\Software\\Policies\\GitHub\\Copilot';

/** Where the runtime reads policy documents from when the machine names no ProgramData directory. */
const COPILOT_POLICY_DEFAULT_DIRECTORY = 'C:\\ProgramData\\GitHub\\Copilot\\policy.d';

/**
 * The directories policy documents are read from on this host: under the machine's ProgramData directory
 * as the environment names it, and under the one the runtime itself falls back to. None off Windows.
 */
export function copilotPolicyDirectories(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): string[] {
  if (platform !== 'win32') return [];
  const named = env['ProgramData'] ?? env['PROGRAMDATA'];
  const directories = [COPILOT_POLICY_DEFAULT_DIRECTORY];
  if (named !== undefined && named !== '') {
    const under = `${named.replace(/[\\/]+$/, '')}\\GitHub\\Copilot\\policy.d`;
    if (under.toLowerCase() !== COPILOT_POLICY_DEFAULT_DIRECTORY.toLowerCase()) directories.unshift(under);
  }
  return directories;
}

/** Whether the policy key exists, read with `reg.exe` (no shell, hidden); null when it cannot be read. */
export function readCopilotPolicyKey(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', COPILOT_POLICY_KEY], { windowsHide: true, timeout: 10_000 }, (error) =>
      resolve(error === null ? true : (error as { code?: unknown }).code === 1 ? false : null),
    );
  });
}

/**
 * The machine-wide policy hook sources present: each JSON file in a policy directory, and the policy key
 * when it holds anything. Policy hooks are not turned off by a session's settings. A directory that is not
 * there holds none; one that is there and cannot be listed, and a key that cannot be read, are `unread`.
 */
export async function copilotPolicyHooks(sources: CopilotPolicyHookSources): Promise<CopilotPolicyLook> {
  const found: string[] = [];
  const unread: string[] = [];
  for (const directory of sources.directories) {
    try {
      for (const entry of readdirSync(directory)) {
        if (entry.toLowerCase().endsWith('.json')) found.push(join(directory, entry));
      }
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // No directory: no policy hooks there.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unread.push(`${directory} (${String(code)})`);
    }
  }
  if (sources.registryHolds !== undefined) {
    let holds: boolean | null;
    try {
      holds = await sources.registryHolds();
    } catch {
      holds = null;
    }
    if (holds === true) found.push(COPILOT_POLICY_KEY);
    if (holds === null) unread.push(COPILOT_POLICY_KEY);
  }
  return { found, unread };
}

/** What the runtime answered when asked, or why it gave no answer. */
export type CopilotAsked = { readonly answer: unknown } | { readonly failed: string };

/** The longest a source's own words run in a degrade's detail. */
const POLICY_WORDS = 200;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function words(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, POLICY_WORDS) : null;
}

/**
 * The runtime's own account of the policy hooks it would run, read from what it answered to its hook
 * discovery and its read of the machine's managed settings. Each policy row that is not turned off is a
 * source found. A call that failed, an answer this host cannot read, a source the runtime says it could
 * not load and managed settings it could not read are each `unread`.
 */
export function copilotRuntimePolicyLook(discovered: CopilotAsked, managed: CopilotAsked): CopilotPolicyLook {
  const found: string[] = [];
  const unread: string[] = [];
  const add = (list: string[], one: string): void => {
    if (!list.includes(one)) list.push(one);
  };
  if ('failed' in discovered) {
    add(unread, `the runtime's own hook discovery (${discovered.failed.slice(0, POLICY_WORDS)})`);
  } else {
    const answer = record(discovered.answer);
    const hooks = answer?.['hooks'];
    if (!Array.isArray(hooks)) {
      add(unread, "the runtime's own hook discovery (an answer this host cannot read)");
    } else {
      for (const hook of hooks) {
        const row = record(hook);
        if (row === null) {
          add(unread, "the runtime's own hook discovery (a row this host cannot read)");
          continue;
        }
        if (row['origin'] !== 'policy' || row['enabled'] === false) continue;
        const event = words(row['hookType']) ?? 'a';
        add(found, `${words(row['source']) ?? 'a managed policy the runtime did not name'} (${event} hook)`);
      }
      const errors = answer?.['errors'];
      for (const error of Array.isArray(errors) ? errors : []) {
        add(unread, `a hook source the runtime could not load (${words(error) ?? 'no reason given'})`);
      }
    }
  }
  if ('failed' in managed) {
    add(unread, `the machine's managed Copilot settings (${managed.failed.slice(0, POLICY_WORDS)})`);
  } else {
    const answer = record(managed.answer);
    if (answer === null) {
      add(unread, "the machine's managed Copilot settings (an answer this host cannot read)");
    } else {
      const why = words(answer['errorMessage']);
      if (why !== null) add(unread, `the machine's managed Copilot settings (${why})`);
      const hooks = record(answer['settingsJson'])?.['hooks'];
      if (typeof hooks === 'object' && hooks !== null && Object.keys(hooks).length > 0) {
        add(found, "the machine's managed Copilot settings");
      }
    }
  }
  return { found, unread };
}

/** Several looks as one, each source once. */
export function mergeCopilotPolicyLooks(...looks: readonly CopilotPolicyLook[]): CopilotPolicyLook {
  return {
    found: [...new Set(looks.flatMap((look) => look.found))],
    unread: [...new Set(looks.flatMap((look) => look.unread))],
  };
}

/** What a look says of the session, or null when every source was read and none holds a policy hook. */
export function copilotPolicyDetail(look: CopilotPolicyLook): string | null {
  const found =
    look.found.length === 0
      ? null
      : `machine-wide Copilot policy hooks run in every session whatever its own settings say: ${look.found.join(', ')}`;
  const unread =
    look.unread.length === 0
      ? null
      : `not every place a machine-wide Copilot policy hook can sit could be read, so one that runs in every session is not ruled out: ${look.unread.join(', ')}`;
  if (found === null) return unread;
  return unread === null ? found : `${found}; ${unread}`;
}

/** What the runtime said about its posture, read before the first prompt. */
export interface CopilotPostureRead {
  readonly permissionModeResult: { readonly success: boolean; readonly mode?: string } | null;
  readonly permissionMode: string;
  readonly agentMode: string;
  readonly allowAll: {
    readonly active: boolean;
    readonly autoApproval: boolean;
    readonly storedAutoApproval?: boolean;
    readonly runtimeOverride?: boolean;
    readonly baseline?: { readonly tools?: boolean; readonly paths?: boolean; readonly urls?: boolean };
  };
  readonly paths: {
    readonly directories: readonly string[];
    readonly sessionApprovedPaths?: readonly string[];
  };
  readonly plugins: readonly unknown[];
  /** Every tool the runtime offers the session, by the name the model calls it by. */
  readonly offeredTools: readonly string[];
  /**
   * The offered tools an attached MCP server brings, each with its server and, where the runtime states it,
   * the tool's own name there. Absent: none is known to be.
   */
  readonly offeredServerTools?: readonly {
    readonly name: string;
    readonly server: string;
    readonly tool?: string;
  }[];
}

/** What the posture is held to. */
export interface CopilotPostureExpected {
  /** `plan` for a session opened in plan mode, else `interactive`. */
  readonly agentMode: string;
  readonly cwd: string;
  readonly writeRoots: readonly string[];
  readonly home: string;
}

/**
 * `path` as the file system names it: its deepest existing ancestor resolved (a link followed, a Windows
 * short name such as `RUNNER~1` spelled out), and the rest of the path after it as written. The runtime
 * reports the directories it allows in their long, resolved form, which a root this host was handed in
 * another spelling of the same place would never match lexically.
 */
export function copilotCanonicalPath(path: string): string {
  return canonicalPath(path);
}

/**
 * Whether `inner` is `outer` or beneath it, by the same rule the jail uses: as written, or else as the file
 * system names both.
 */
function within(inner: string, outer: string): boolean {
  return withinCanonically(inner, outer);
}

/**
 * Why the runtime is not in the posture this host started it in, or null when it is: the permission mode
 * applied and `manual`; the agent mode the one asked for; no approve-all grant of any kind; no path approved
 * for the session, and every allowed directory the session's own, a write root or inside its home; no
 * plugin; and none of the tools this host turns off offered.
 */
export function copilotReadBackProblem(
  read: CopilotPostureRead,
  expected: CopilotPostureExpected,
): string | null {
  if (read.permissionModeResult === null || !read.permissionModeResult.success) {
    return 'the runtime did not apply the manual permission mode asked for at create';
  }
  if (read.permissionMode !== COPILOT_ADMITTED_PERMISSION_MODE) {
    return `the runtime's permission mode is ${read.permissionMode}, not ${COPILOT_ADMITTED_PERMISSION_MODE}`;
  }
  if (!COPILOT_ADMITTED_AGENT_MODES.includes(read.agentMode) || read.agentMode !== expected.agentMode) {
    return `the runtime's agent mode is ${read.agentMode}, not ${expected.agentMode}`;
  }
  const grants = read.allowAll;
  const granted = [
    ...(grants.active ? ['active'] : []),
    ...(grants.autoApproval ? ['autoApproval'] : []),
    ...(grants.storedAutoApproval === true ? ['storedAutoApproval'] : []),
    ...(grants.runtimeOverride === true ? ['runtimeOverride'] : []),
    ...(grants.baseline?.tools === true ? ['baseline.tools'] : []),
    ...(grants.baseline?.paths === true ? ['baseline.paths'] : []),
    ...(grants.baseline?.urls === true ? ['baseline.urls'] : []),
  ];
  if (granted.length > 0) return `the runtime holds an approve-all grant: ${granted.join(', ')}`;
  const approved = read.paths.sessionApprovedPaths ?? [];
  if (approved.length > 0) return `the runtime has paths approved for the session: ${approved.join(', ')}`;
  const roots = [expected.cwd, ...expected.writeRoots];
  const outside = read.paths.directories.filter(
    (directory) => !roots.some((root) => within(directory, root)) && !within(directory, expected.home),
  );
  if (outside.length > 0) {
    return `the runtime allows directories outside the session's roots: ${outside.join(', ')}`;
  }
  if (read.plugins.length > 0) return `the runtime has ${read.plugins.length} plugin(s) installed`;
  const offered = COPILOT_EXCLUDED_TOOLS.filter((tool) => read.offeredTools.includes(tool));
  if (offered.length > 0) return `the runtime offers ${offered.join(', ')}, which this host turns off`;
  return null;
}
