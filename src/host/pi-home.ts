/**
 * The runner's pi home: one base directory the operator names (`PERISCOPE_PI_HOME`), with pi's agent
 * home, the sessions store and one run directory per session beneath it.
 *
 * Layout under the base, all of it in the protected set, so no session's tools read any of it:
 * - `agent/`: pi's agent home (`PI_CODING_AGENT_DIR`), shared by every session. It holds the operator's
 *   own sign-in (`auth.json`), and two files this host owns and writes at start: `models.json`, one
 *   provider per model endpoint pi may open on, with its key; and `mcp.json`, which declares no server,
 *   so the only servers a session has are the ones it attaches. The operator's own `~/.pi/agent` is never
 *   what a session runs from.
 * - `sessions/`: where pi keeps every session's file (`--session-dir`), flat; a resume reads its file
 *   there.
 * - `run/<id>/`: one session's run directory, written before pi starts and removed when the session
 *   ends. It holds the extension's configuration (the channel, its token and the session's MCP servers,
 *   their headers included), removed as soon as the extension has said hello, and the system prompt
 *   file pi reads at start, so no controller text rides pi's command line.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { JsonObject } from '../control/frames.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { PiEndpointRoute } from './pi-endpoints.js';
import { piModelsDocument } from './pi-endpoints.js';
import type { PiExtensionConfig } from './pi-extension.js';
import { PI_EXTENSION_CONFIG_VARIABLE } from './pi-extension.js';
import { PiSessionHeader, parsed } from './pi-wire.js';

/** The variable naming pi's agent home. */
export const PI_AGENT_DIR_VARIABLE = 'PI_CODING_AGENT_DIR';

/** The base's three directories. */
export interface PiBase {
  readonly agent: string;
  readonly sessions: string;
  readonly run: string;
}

/** The base's directories, by path, whether or not they exist. */
export function piBaseOf(base: string): PiBase {
  return { agent: join(base, 'agent'), sessions: join(base, 'sessions'), run: join(base, 'run') };
}

/** Create the base's directories when absent. Refuses with why it could not. */
export function ensurePiBase(base: string): Result<PiBase> {
  const paths = piBaseOf(base);
  try {
    for (const directory of [paths.agent, paths.sessions, paths.run]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  } catch (error) {
    return refuse(
      'runtime-unavailable',
      `the pi home ${base} could not be created: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ok(paths);
}

/** Write `document` to `path` by a temporary file and a rename, unless it already holds exactly that. */
function writeIfChanged(path: string, document: JsonObject): void {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Write the two files this host owns in pi's agent home: `models.json`, one provider per endpoint in
 * `routes` with its key, and `mcp.json`, which declares no server. Refuses with why it could not.
 */
export function writePiAgentFiles(base: string, routes: readonly PiEndpointRoute[]): Result<void> {
  const ensured = ensurePiBase(base);
  if (!ensured.ok) return ensured;
  try {
    writeIfChanged(join(ensured.value.agent, 'models.json'), piModelsDocument(routes));
    writeIfChanged(join(ensured.value.agent, 'mcp.json'), { mcpServers: {} });
  } catch (error) {
    return refuse(
      'runtime-unavailable',
      `the pi agent home ${ensured.value.agent} could not be written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ok(undefined);
}

/** How a session's system prompt reaches pi: added to pi's own, or in place of it. */
export interface PiPromptFile {
  readonly flag: '--append-system-prompt' | '--system-prompt';
  readonly text: string;
}

/** One session's run directory, written. */
export interface PiSessionRun {
  readonly dir: string;
  /** The extension's configuration file, until it is removed. */
  readonly configFile: string;
  /** The system prompt file and the flag that names it, or null for none. */
  readonly prompt: { readonly flag: PiPromptFile['flag']; readonly file: string } | null;
  /** The variables pi is started with. */
  readonly env: Readonly<Record<string, string>>;
  /** Removes the extension's configuration. Idempotent; a failure is the caller's to report. */
  removeConfig(): Result<void>;
  /** Removes the whole run directory. Idempotent; a failure is the caller's to report. */
  remove(): Result<void>;
}

/** Remove `path`, whatever it is; a failure in words. */
function removed(path: string, what: string): Result<void> {
  try {
    rmSync(path, { recursive: true, force: true });
    return ok(undefined);
  } catch (error) {
    return refuse(
      'runtime-unavailable',
      `${what} ${path} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Write one session's run directory: the extension's configuration (0600) and the system prompt file.
 * Refuses `pi-extension-not-active` when it could not, leaving nothing behind: without the configuration
 * the extension has no channel to this host, and pi would run with no gate.
 */
export function createPiSessionRun(
  base: string,
  config: PiExtensionConfig,
  prompt: PiPromptFile | null,
): Result<PiSessionRun> {
  const ensured = ensurePiBase(base);
  if (!ensured.ok) return refuse('pi-extension-not-active', ensured.refusal.detail);
  const dir = join(ensured.value.run, randomUUID());
  const configFile = join(dir, 'extension.json');
  const promptFile = join(dir, 'system-prompt.md');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(configFile, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    if (prompt !== null) writeFileSync(promptFile, prompt.text, { mode: 0o600 });
  } catch (error) {
    removed(dir, 'the run directory');
    return refuse(
      'pi-extension-not-active',
      `the extension's configuration could not be written under ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ok({
    dir,
    configFile,
    prompt: prompt === null ? null : { flag: prompt.flag, file: promptFile },
    env: {
      [PI_AGENT_DIR_VARIABLE]: ensured.value.agent,
      [PI_EXTENSION_CONFIG_VARIABLE]: configFile,
      // pi's install telemetry and its start-up version check, both off: a session reports nothing to
      // anyone but this host.
      PI_TELEMETRY: '0',
      PI_SKIP_VERSION_CHECK: '1',
    },
    removeConfig: () => removed(configFile, "the extension's configuration"),
    remove: () => removed(dir, 'the run directory'),
  });
}

/** Two paths compared as the platform compares them: case-insensitively on Windows. */
function samePath(left: string, right: string, platform: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Why a resume cannot run, by name: a resume pi cannot carry out as asked is refused, never bent. */
const resumeRefused = (detail: string): Result<string> =>
  refuse('request-key-unsupported', `resume: ${detail}`);

/**
 * The file of the session `resume` names, in the sessions store: a session id, or the path of a file in
 * the store. A session continued in place must have run in `cwd`: pi runs a resumed session where it
 * first ran, so a session from another directory cannot be resumed here as asked, and is refused by
 * name. A fork starts a new session in `cwd` from the old one's file, wherever that one ran.
 */
export function resolvePiSession(
  sessions: string,
  resume: string,
  cwd: string,
  options: { readonly fork?: boolean; readonly platform?: string } = {},
): Result<string> {
  const platform = options.platform ?? process.platform;
  let path: string;
  if (resume.endsWith('.jsonl') || resume.includes('/') || resume.includes('\\')) {
    path = resolve(resume);
    if (!samePath(join(path, '..'), sessions, platform)) {
      return resumeRefused(`${resume} is not a session file in this host's sessions store ${sessions}`);
    }
  } else {
    let files: string[];
    try {
      files = readdirSync(sessions).filter((file) => file.endsWith(`_${resume}.jsonl`));
    } catch (error) {
      return resumeRefused(
        `the sessions store ${sessions} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (files.length === 0) return resumeRefused(`no session ${resume} is in this host's sessions store`);
    if (files.length > 1) return resumeRefused(`${files.length} session files carry the id ${resume}`);
    path = join(sessions, files[0] ?? '');
  }
  let header: ReturnType<typeof parsed<typeof PiSessionHeader>>;
  try {
    const first = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
    header = parsed(PiSessionHeader, JSON.parse(first));
  } catch (error) {
    return resumeRefused(
      `the session file ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (header === null) return resumeRefused(`${path} does not begin with a session header`);
  if (options.fork !== true && !samePath(header.cwd, cwd, platform)) {
    return resumeRefused(
      `session ${header.id} ran in ${header.cwd}, and pi resumes a session where it ran, not in ${cwd}`,
    );
  }
  return ok(path);
}
