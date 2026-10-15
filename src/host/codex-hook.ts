/**
 * Periscope's own hook in the runner's Codex home: written at host start, probed, and trusted over the
 * wire at every session's open.
 *
 * Codex runs a command hook through a shell, and which shell is not configurable: PowerShell
 * (`-NoProfile -Command <line>`) on Windows whenever one exists, `cmd.exe /C` otherwise, a POSIX shell
 * elsewhere. No quoted line runs under both Windows shells, so the Windows line is the bare path of a
 * `.cmd` shim this host writes into the home, which runs this package's own entry under this Node. The
 * home's path therefore must hold no space and no shell metacharacter; a home that does makes Codex
 * unavailable on this host, with the character named, rather than run with a hook that cannot start.
 *
 * Codex runs a hook in the user layer only once its hash is recorded as trusted. The hash covers the
 * hook's definition (on Windows, the shim's path) and not the shim's bytes, so the shim is rewritten
 * whenever its bytes differ, and the home's hook files join the protected set.
 */
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { JsonObject } from '../control/frames.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { CODEX_HOOK_TIMEOUT_SECONDS } from '../gate/hook-exchange.js';
import { samePath } from './codex-home.js';

/** The shim's file name, in the home's `hooks` directory. */
export const CODEX_HOOK_SHIM = 'periscope-hook.cmd';

/** The hook definitions file Codex reads from the home's user layer. */
export const CODEX_HOOKS_FILE = 'hooks.json';

/** How long the start-up probe of the hook command may take, its shell's own start included. */
export const CODEX_HOOK_PROBE_DEADLINE_MS = 15_000;

/** The characters a home path may not hold: each breaks the bare line under PowerShell or `cmd.exe`. */
export const CODEX_HOME_PATH_CHARACTERS = [
  ' ',
  '&',
  '|',
  '<',
  '>',
  '^',
  '%',
  '!',
  '(',
  ')',
  ';',
  ',',
  '=',
  "'",
  '"',
  '`',
] as const;

/** Why `home` cannot carry the hook's bare Windows line, naming the character; null when it can. */
export function codexHomePathProblem(home: string): string | null {
  const found = CODEX_HOME_PATH_CHARACTERS.find((character) => home.includes(character));
  if (found === undefined) return null;
  const named = found === ' ' ? 'a space' : `the character ${found}`;
  return (
    `the Codex home ${home} holds ${named}: Codex runs its hook through PowerShell or cmd.exe, which ` +
    'need a bare path with no space or shell metacharacter, so periscope cannot install its hook there. ' +
    'Set PERISCOPE_CODEX_HOME to a path without one'
  );
}

/** The hook's lines and files for one home. */
export interface CodexHookLines {
  /** The POSIX line Codex runs on Linux and macOS. */
  readonly posix: string;
  /** The line Codex runs on Windows: the shim's bare path. */
  readonly windows: string;
  /** The line Codex lists and runs on this host's platform. */
  readonly listed: string;
  readonly shimPath: string;
  readonly shimText: string;
  readonly hooksPath: string;
}

/** The package's own entry, located from this module, never from `PATH` or the invoking argv. */
export function codexHookEntry(): string {
  return fileURLToPath(new URL('../bin/periscope.js', import.meta.url));
}

/** A single-quoted POSIX word. */
function posixWord(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** The hook's lines for `home`, running `entry` under `execPath`. */
export function codexHookLines(
  home: string,
  execPath: string = process.execPath,
  entry: string = codexHookEntry(),
  platform: string = process.platform,
): CodexHookLines {
  const shimPath = join(home, 'hooks', CODEX_HOOK_SHIM);
  // `%` is expanded inside a batch file even within quotes, so it is doubled to stay a literal.
  const batch = (text: string): string => text.replace(/%/g, '%%');
  const shimText = [
    // A NODE_OPTIONS in the runtime's environment could make Node write to standard error, which a
    // shell can turn into a failed exit; the hook's own Node runs without it.
    '@set NODE_OPTIONS=',
    `@"${batch(execPath)}" --no-warnings "${batch(entry)}" hook codex %*`,
    '@exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
  const posix = `NODE_OPTIONS= ${posixWord(execPath)} --no-warnings ${posixWord(entry)} hook codex`;
  return {
    posix,
    windows: shimPath,
    listed: platform === 'win32' ? shimPath : posix,
    shimPath,
    shimText,
    hooksPath: join(home, CODEX_HOOKS_FILE),
  };
}

/**
 * Periscope's POSIX hook line for any Node binary and any install of this package, whole, as
 * `codexHookLines` writes it: two single-quoted words, the second this package's entry.
 */
const POSIX_HOOK_LINE =
  /^NODE_OPTIONS= '(?:[^']|'\\'')*' --no-warnings '(?:[^']|'\\'')*[\\/]periscope\.js' hook codex$/;

/**
 * Whether a hook handler is periscope's, from any start: one of its lines is, whole, a line this package
 * writes, its POSIX line or its shim in this home. A foreign hook that only contains those words, or a
 * shim of the same name elsewhere, is someone else's, and the merge keeps it.
 */
function isPeriscopeHandler(handler: unknown, lines: CodexHookLines): boolean {
  if (typeof handler !== 'object' || handler === null) return false;
  const fields = handler as Record<string, unknown>;
  return [fields['command'], fields['commandWindows'], fields['command_windows']].some(
    (line) => typeof line === 'string' && (POSIX_HOOK_LINE.test(line) || samePath(line, lines.windows)),
  );
}

/**
 * The hooks file with periscope's group in place: every group that is not periscope's kept as it was,
 * every earlier periscope group replaced by the current one. Null when `existing` is not a hooks file
 * this host can merge into without losing anything.
 */
export function codexHooksFile(existing: unknown, lines: CodexHookLines): JsonObject | null {
  const file = existing === undefined ? {} : existing;
  if (typeof file !== 'object' || file === null || Array.isArray(file)) return null;
  const fields = file as Record<string, unknown>;
  const hooks = fields['hooks'] === undefined ? {} : fields['hooks'];
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return null;
  const events = hooks as Record<string, unknown>;
  const current = events['PreToolUse'] === undefined ? [] : events['PreToolUse'];
  if (!Array.isArray(current)) return null;
  const kept = (current as unknown[]).filter((group) => {
    const handlers =
      typeof group === 'object' && group !== null ? (group as { hooks?: unknown }).hooks : undefined;
    return !(Array.isArray(handlers) && handlers.some((handler) => isPeriscopeHandler(handler, lines)));
  });
  const ours: JsonObject = {
    hooks: [
      {
        type: 'command',
        command: lines.posix,
        commandWindows: lines.windows,
        timeout: CODEX_HOOK_TIMEOUT_SECONDS,
        async: false,
      },
    ],
  };
  return {
    ...(fields as JsonObject),
    hooks: { ...(events as JsonObject), PreToolUse: [...(kept as JsonObject[]), ours] },
  };
}

/** Write `text` to `path` through a sibling and a rename, and only when it differs from what is there. */
function writeWhenChanged(path: string, text: string): boolean {
  try {
    if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  } catch {
    // An unreadable file is rewritten.
  }
  const sibling = `${path}.${process.pid}.tmp`;
  writeFileSync(sibling, text);
  renameSync(sibling, path);
  return true;
}

/** Write the shim when its bytes differ. Returns whether it was rewritten. */
export function ensureCodexHookShim(lines: CodexHookLines): boolean {
  mkdirSync(join(lines.shimPath, '..'), { recursive: true });
  return writeWhenChanged(lines.shimPath, lines.shimText);
}

/**
 * Write periscope's hook into `home`: the shim, and its group in the hooks file. Refused, with why, when
 * the home's path cannot carry the hook or its hooks file is not one this host can merge into.
 */
export function installCodexHook(
  home: string,
  lines: CodexHookLines = codexHookLines(home),
): Result<CodexHookLines> {
  const pathProblem = codexHomePathProblem(home);
  if (pathProblem !== null) return refuse('codex-hook-not-active', pathProblem);
  try {
    ensureCodexHookShim(lines);
    let existing: unknown;
    if (existsSync(lines.hooksPath)) {
      try {
        existing = JSON.parse(readFileSync(lines.hooksPath, 'utf8')) as unknown;
      } catch (error) {
        return refuse(
          'codex-hook-not-active',
          `${lines.hooksPath} is not JSON (${String(error)}), so periscope's hook was not written into it; fix or remove the file`,
        );
      }
    }
    const merged = codexHooksFile(existing, lines);
    if (merged === null) {
      return refuse(
        'codex-hook-not-active',
        `${lines.hooksPath} is not a hooks file periscope can add its hook to without losing what it holds; fix or remove the file`,
      );
    }
    writeWhenChanged(lines.hooksPath, `${JSON.stringify(merged, null, 2)}\n`);
  } catch (error) {
    return refuse(
      'codex-hook-not-active',
      `periscope's hook could not be written into ${home}: ${String(error)}`,
    );
  }
  return ok(lines);
}

/** How the probe starts a shell, injectable so the probe can be checked without one. */
export type ProbeSpawn = typeof spawnChild;

/** The PowerShell Codex would run its hook under on this Windows host, or null when there is none. */
export function codexHookPowerShell(env: Readonly<Record<string, string | undefined>>): string | null {
  const pathValue = env['PATH'] ?? env['Path'] ?? '';
  for (const name of ['pwsh.exe', 'powershell.exe']) {
    for (const directory of pathValue.split(delimiter)) {
      if (directory === '') continue;
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows';
  for (const candidate of [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The payload the probe hands the hook command on its standard input. */
const PROBE_INPUT = '{"probe":"periscope"}';

/**
 * Run the installed hook the way Codex will, with `--probe`: through PowerShell `-NoProfile -Command`
 * where one exists, else `cmd.exe /C`, on Windows; through `/bin/sh -c` elsewhere. It must exit 0, write
 * nothing to standard error, and print exactly the probe line naming `version` and the bytes it read.
 */
export function probeCodexHook(
  lines: CodexHookLines,
  options: {
    readonly env: Readonly<Record<string, string>>;
    readonly version: string;
    readonly platform?: string;
    readonly spawn?: ProbeSpawn;
    readonly deadlineMs?: number;
  },
): Promise<Result<void>> {
  const platform = options.platform ?? process.platform;
  const start = options.spawn ?? spawnChild;
  let program: string;
  let args: string[];
  let verbatim = false;
  if (platform === 'win32') {
    const powershell = codexHookPowerShell(options.env);
    if (powershell !== null) {
      program = powershell;
      args = ['-NoProfile', '-Command', `${lines.windows} --probe`];
    } else {
      program = options.env['COMSPEC'] ?? 'cmd.exe';
      args = ['/C', `"${lines.windows} --probe"`];
      verbatim = true;
    }
  } else {
    program = '/bin/sh';
    args = ['-c', `${lines.posix} --probe`];
  }
  const expected = `periscope hook probe ${options.version} ${Buffer.byteLength(PROBE_INPUT)}`;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const settle = (result: Result<void>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failed = (why: string): Result<void> =>
      refuse('codex-hook-not-active', `the hook command did not answer its probe through ${program}: ${why}`);
    let child: ReturnType<ProbeSpawn>;
    try {
      child = start(program, args, {
        env: options.env,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      settle(failed(String(error)));
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      settle(failed(`no answer within ${options.deadlineMs ?? CODEX_HOOK_PROBE_DEADLINE_MS}ms`));
    }, options.deadlineMs ?? CODEX_HOOK_PROBE_DEADLINE_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => settle(failed(error.message)));
    child.on('close', (code) => {
      if (code !== 0)
        return settle(failed(`it exited ${String(code)}${stderr === '' ? '' : `: ${stderr.trim()}`}`));
      if (stderr !== '') return settle(failed(`it wrote to standard error: ${stderr.trim()}`));
      const line = stdout.replace(/\r?\n$/, '');
      if (line !== expected)
        return settle(failed(`it printed ${JSON.stringify(stdout)}, not ${JSON.stringify(expected)}`));
      return settle(ok(undefined));
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(PROBE_INPUT);
  });
}

/** One hook in a `hooks/list` answer, as far as this host reads it. */
export interface ListedHook {
  readonly key: string;
  readonly eventName: string;
  readonly handlerType: string;
  readonly command: string | null;
  readonly async: boolean;
  readonly matcher: string | null;
  readonly timeoutSec: number | null;
  readonly sourcePath: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly currentHash: string;
  readonly trustStatus: string;
}

/** Every hook a `hooks/list` answer lists, across its entries; a hook missing a field this reads is skipped. */
export function listedHooks(answer: JsonObject): ListedHook[] {
  const data = answer['data'];
  if (!Array.isArray(data)) return [];
  const found: ListedHook[] = [];
  for (const entry of data) {
    const hooks =
      typeof entry === 'object' && entry !== null ? (entry as { hooks?: unknown }).hooks : undefined;
    if (!Array.isArray(hooks)) continue;
    for (const raw of hooks as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const hook = raw as Record<string, unknown>;
      const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
      const key = text(hook['key']);
      const eventName = text(hook['eventName']);
      const sourcePath = text(hook['sourcePath']);
      const currentHash = text(hook['currentHash']);
      const trustStatus = text(hook['trustStatus']);
      if (
        key === null ||
        eventName === null ||
        sourcePath === null ||
        currentHash === null ||
        trustStatus === null
      )
        continue;
      found.push({
        key,
        eventName,
        handlerType: text(hook['handlerType']) ?? '',
        command: text(hook['command']),
        async: hook['async'] === true,
        matcher: text(hook['matcher']),
        timeoutSec: typeof hook['timeoutSec'] === 'number' ? hook['timeoutSec'] : null,
        sourcePath,
        source: text(hook['source']) ?? '',
        enabled: hook['enabled'] === true,
        currentHash,
        trustStatus,
      });
    }
  }
  return found;
}

/** What a listing says about periscope's hook and every other hook that would run. */
export interface HookListingReading {
  /** Periscope's hook as written at start, or null when the listing has none. */
  readonly ours: ListedHook | null;
  /** Why a hook at periscope's place is not the one it wrote, or null. */
  readonly problem: string | null;
  /** Every other hook that would run: enabled, and trusted or managed. */
  readonly foreign: readonly ListedHook[];
}

/** Read a `hooks/list` answer for periscope's hook and the foreign hooks that would run. */
export function readHookListing(answer: JsonObject, lines: CodexHookLines): HookListingReading {
  const hooks = listedHooks(answer);
  const atOurPlace = hooks.filter(
    (hook) =>
      hook.eventName === 'preToolUse' &&
      samePath(hook.sourcePath, lines.hooksPath) &&
      hook.command === lines.listed,
  );
  const ours = atOurPlace[0] ?? null;
  let problem: string | null = null;
  if (ours === null) {
    problem = `Codex lists no PreToolUse hook running ${lines.listed} from ${lines.hooksPath}`;
  } else if (ours.handlerType !== 'command' || ours.async || ours.matcher !== null) {
    problem = `the hook at ${lines.hooksPath} is not the one periscope wrote: a synchronous command with no matcher`;
  } else if (ours.timeoutSec !== CODEX_HOOK_TIMEOUT_SECONDS) {
    problem = `the hook at ${lines.hooksPath} has a ${String(ours.timeoutSec)}s timeout, not the ${CODEX_HOOK_TIMEOUT_SECONDS}s periscope wrote`;
  }
  const foreign = hooks.filter(
    (hook) =>
      !atOurPlace.includes(hook) &&
      hook.enabled &&
      (hook.trustStatus === 'trusted' || hook.trustStatus === 'managed'),
  );
  return { ours: problem === null ? ours : null, problem, foreign };
}

/** What the start-up read reports about the hook: whether it was written, and whether its probe passed. */
export interface CodexHookReport {
  readonly installed: Result<void>;
  readonly probed: Result<void>;
}

/** What a host knows about its installed hook, as each session's open asks it. */
export interface CodexHookState {
  readonly lines: CodexHookLines;
  /**
   * Whether the hook can run for a session opening now: written at start, its shim's bytes as written,
   * and its probe passed. The probe runs again while it has failed, so a passing retry is believed.
   */
  ensureReady(): Promise<Result<void>>;
}

/**
 * The hook state a host composes before its start-up read, settled by that read's report. A read that
 * reports nothing (one that never installs a hook) leaves every open to the trust check alone.
 */
export function pendingCodexHookState(
  lines: CodexHookLines,
  probe: () => Promise<Result<void>>,
): CodexHookState & { report(found: CodexHookReport | undefined): void } {
  let settle: (found: CodexHookReport | undefined) => void = () => undefined;
  const reported = new Promise<CodexHookReport | undefined>((resolve) => {
    settle = resolve;
  });
  let probed: Result<void> | null = null;
  return {
    lines,
    report: (found) => settle(found),
    async ensureReady() {
      const found = await reported;
      if (found === undefined) return ok(undefined);
      if (!found.installed.ok) return found.installed;
      try {
        ensureCodexHookShim(lines);
      } catch (error) {
        return refuse(
          'codex-hook-not-active',
          `the hook's shim ${lines.shimPath} could not be written: ${String(error)}`,
        );
      }
      probed ??= found.probed;
      if (!probed.ok) probed = await probe();
      return probed;
    },
  };
}

let trustWrites: Promise<unknown> = Promise.resolve();

/** Run `work` after every trust write this host started before it: one write to the home at a time. */
export function serializeHookTrust<T>(work: () => Promise<T>): Promise<T> {
  const next = trustWrites.then(work, work);
  trustWrites = next.catch(() => undefined);
  return next;
}

/** The `config/batchWrite` that records periscope's hook as trusted, as Codex's own interface writes it. */
export function hookTrustWrite(hook: ListedHook): JsonObject {
  return {
    edits: [
      {
        keyPath: 'hooks.state',
        value: { [hook.key]: { trusted_hash: hook.currentHash } },
        mergeStrategy: 'upsert',
      },
    ],
    reloadUserConfig: true,
  };
}
