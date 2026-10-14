/**
 * The runner's Qwen Code home: one base directory the operator names (`PERISCOPE_QWEN_HOME`), a home of
 * its own for each session beneath it, and the settings this host writes there for the CLI to load.
 *
 * Layout under the base:
 * - `runtime/`: the CLI's runtime directory (`QWEN_RUNTIME_DIR`), shared by every session, where it
 *   keeps each project's chats; a resume finds its chat there.
 * - `sessions/<id>/`: one session's home (`QWEN_HOME`), written before the CLI starts and removed when
 *   the session ends. It holds the session's settings, which carry the endpoint's key, so the whole
 *   `sessions/` directory is in the protected set.
 *
 * The settings are written as the CLI's system scope (`QWEN_CODE_SYSTEM_SETTINGS_PATH`), the scope it
 * merges last, so a repository's own `.qwen/settings.json` cannot override them: its hooks stay off,
 * its endpoint and providers give way to the session's, and its allow rules cannot outrank an ask rule,
 * because the CLI ranks deny, then ask, then allow, across every scope. The system defaults file the CLI
 * would read is replaced by an empty one beside it. What the session's settings hold:
 * - `permissions.ask`: every built-in tool of the pinned release (`QWEN_NAMES.tools`) and `mcp__{server}`
 *   for each MCP server this host attaches, so every call the CLI would allow by default asks this host
 *   instead. The CLI has no rule that names every tool at once (`*` matches no tool), so the list is
 *   the rule.
 * - `disableAllHooks`, so no settings hook can decide a call or rewrite one;
 * - usage statistics off, the code-mode tool off, and the skill directories the session takes;
 * - the endpoint's auth (`security.auth`) and providers, when the session names one.
 *
 * Before the first prompt the file is read back and held to the list (`readBackQwenSettings`); a file
 * that does not read back whole refuses the open.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JsonObject } from '../control/frames.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { QWEN_NAMES } from './qwen-names.js';

/** The variables a Qwen session's CLI is started with to find its home and its settings. */
export const QWEN_HOME_VARIABLES = [
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
  'QWEN_CODE_SYSTEM_SETTINGS_PATH',
  'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
  'QWEN_CODE_TRUSTED_FOLDERS_PATH',
  'QWEN_CODE_MCP_APPROVALS_PATH',
  'QWEN_CODE_NO_RELAUNCH',
  'QWEN_USAGE_STATISTICS_ENABLED',
] as const;

/** A variable that would make the CLI drop every permission rule, the ask rules included. */
export const QWEN_SAFE_MODE_VARIABLE = 'QWEN_CODE_SAFE_MODE';

/** The base's two directories. */
export interface QwenBase {
  readonly sessions: string;
  readonly runtime: string;
}

/** How a session reaches its model, as its settings state it. */
export interface QwenSettingsAuth {
  /** The CLI's auth type: `openai`, `openai-responses` or `anthropic`. */
  readonly selectedType: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  /** The endpoint's models, each listed as a provider for an Anthropic endpoint, which needs one. */
  readonly anthropicModels: readonly string[];
}

/** What one session's settings carry beside the fixed members. */
export interface QwenSettingsInput {
  /** The names of the MCP servers this host attaches. */
  readonly servers: readonly string[];
  /** The `skills/` directories of the plugin directories the session takes. */
  readonly skillDirectories: readonly string[];
  readonly auth: QwenSettingsAuth | null;
}

/** One session's home, written. */
export interface QwenSessionHome {
  readonly home: string;
  /** The system-scope settings file the CLI reads. */
  readonly settingsFile: string;
  /** The ask rules the file was written with. */
  readonly askRules: readonly string[];
  /** The variables the CLI is started with. */
  readonly env: Readonly<Record<string, string>>;
  /** Removes the home. Idempotent; a failure is the caller's to report. */
  remove(): Result<void>;
}

/** The ask rules a session's settings carry: every built-in tool, then each attached server. */
export function qwenAskRules(servers: readonly string[]): string[] {
  return [...QWEN_NAMES.tools, ...servers.map((server) => `mcp__${server}`)];
}

/** The settings a session's CLI loads as its system scope. Pure. */
export function qwenSystemSettings(input: QwenSettingsInput): JsonObject {
  const auth = input.auth;
  return {
    permissions: { ask: qwenAskRules(input.servers) },
    disableAllHooks: true,
    privacy: { usageStatisticsEnabled: false },
    tools: { codeModeOnly: false },
    security: {
      folderTrust: { enabled: false },
      ...(auth === null
        ? {}
        : { auth: { selectedType: auth.selectedType, apiKey: auth.apiKey, baseUrl: auth.baseUrl } }),
    },
    skills: { directories: [...input.skillDirectories] },
    modelProviders:
      auth === null || auth.anthropicModels.length === 0
        ? {}
        : { anthropic: auth.anthropicModels.map((id) => ({ id, baseUrl: auth.baseUrl })) },
  };
}

/** Create the base's directories when absent. Refuses with why it could not. */
export function ensureQwenBase(base: string): Result<QwenBase> {
  const sessions = join(base, 'sessions');
  const runtime = join(base, 'runtime');
  try {
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
  } catch (error) {
    return refuse(
      'runtime-unavailable',
      `the Qwen Code home ${base} could not be created: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ok({ sessions, runtime });
}

/** Write one session's home and settings. Refuses with why it could not; nothing is left behind then. */
export function createQwenSessionHome(base: string, input: QwenSettingsInput): Result<QwenSessionHome> {
  const ensured = ensureQwenBase(base);
  if (!ensured.ok) return ensured;
  const home = join(ensured.value.sessions, randomUUID());
  const settingsFile = join(home, 'system-settings.json');
  const defaultsFile = join(home, 'system-defaults.json');
  const written = qwenSystemSettings(input);
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
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(settingsFile, `${JSON.stringify(written, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(defaultsFile, '{}\n', { mode: 0o600 });
  } catch (error) {
    remove();
    return refuse(
      'qwen-ask-rules-not-active',
      `the session's settings could not be written under ${home}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ok({
    home,
    settingsFile,
    askRules: qwenAskRules(input.servers),
    env: {
      QWEN_HOME: home,
      QWEN_RUNTIME_DIR: ensured.value.runtime,
      QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsFile,
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaultsFile,
      QWEN_CODE_TRUSTED_FOLDERS_PATH: join(home, 'trustedFolders.json'),
      QWEN_CODE_MCP_APPROVALS_PATH: join(home, 'mcp-approvals.json'),
      QWEN_CODE_NO_RELAUNCH: '1',
      QWEN_USAGE_STATISTICS_ENABLED: 'false',
    },
    remove,
  });
}

/**
 * Why the session's settings would not send every built-in call to ask, or null when they would: the
 * file reads as JSON, its ask rules name every rule the home was written with, its hooks are off, and
 * the environment the CLI starts with names that file as its system scope.
 */
export function readBackQwenSettings(
  session: Pick<QwenSessionHome, 'settingsFile' | 'askRules'>,
  env: Readonly<Record<string, string>>,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | null {
  if (env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] !== session.settingsFile) {
    return `the CLI's environment does not name ${session.settingsFile} as its system settings`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(session.settingsFile));
  } catch (error) {
    return `${session.settingsFile} could not be read back: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return `${session.settingsFile} does not hold a settings object`;
  }
  const document = parsed as Record<string, unknown>;
  const rules = document['permissions'];
  const ask =
    typeof rules === 'object' && rules !== null ? (rules as Record<string, unknown>)['ask'] : undefined;
  if (!Array.isArray(ask)) return `${session.settingsFile} carries no ask rules`;
  const named = new Set(ask.filter((rule): rule is string => typeof rule === 'string'));
  const missing = session.askRules.filter((rule) => !named.has(rule));
  if (missing.length > 0) {
    return `${session.settingsFile} has no ask rule for ${missing.length} name(s): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}`;
  }
  if (document['disableAllHooks'] !== true) return `${session.settingsFile} does not turn every hook off`;
  return null;
}

/** A file of variables the CLI loads into its own environment, and the variables it would add. */
export interface InheritedEnvFile {
  readonly file: string;
  readonly names: readonly string[];
}

/**
 * The `.env` files under the operator's home that the CLI loads whatever its own home is (`~/.env`, and
 * the legacy `~/.qwen/.env` it reads when its home is elsewhere), with the variables each would add to
 * an environment that does not already set them. Names only: a value is never read into this host's
 * memory beyond the line it sits on.
 */
export function inheritedEnvFiles(
  home: string,
  launchEnv: Readonly<Record<string, string>>,
): InheritedEnvFile[] {
  const set = new Set(Object.keys(launchEnv).map((name) => name.toUpperCase()));
  const found: InheritedEnvFile[] = [];
  for (const file of [join(home, '.env'), join(home, '.qwen', '.env')]) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      found.push({ file, names: [] });
      continue;
    }
    const names = [
      ...new Set(
        text
          .split(/\r?\n/)
          .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line)?.[1] ?? null)
          .filter((name): name is string => name !== null && !set.has(name.toUpperCase())),
      ),
    ];
    found.push({ file, names });
  }
  return found;
}
