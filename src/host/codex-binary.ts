/**
 * The Codex binary this host runs: the operator's own install, at one pinned version, never a
 * dependency of this package and never installed by it.
 *
 * `PERISCOPE_CODEX_BIN` names it by absolute path: the native `codex.exe` (or `codex`), or the npm
 * launcher `codex.js`, which this host runs with its own Node (`process.execPath`) and which runs the
 * native binary from its platform package with the same arguments. A batch file is refused: it runs
 * only through a shell.
 *
 * The version is checked twice, and either check failing makes the runtime unavailable by name:
 * - at start, from `--version`: the second whitespace token of the first line, never the first token
 *   (the binary's own name); `0.0.0` is an unreleased build;
 * - at each session's `initialize`, from the `userAgent` the server answers with, `{name}/{version}`.
 */
import { execFile } from 'node:child_process';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';

/** The Codex release this host is built and tested against. A binary reporting any other is refused. */
export const CODEX_PINNED_VERSION = '0.162.1';

/** How long `--version` may take before the binary is reported as not answering. */
export const CODEX_VERSION_TIMEOUT_MS = 10_000;

/** The version an unreleased build reports. */
const UNRELEASED_VERSION = '0.0.0';

/** A program and its leading arguments: the launcher runs under this host's Node, the binary alone. */
export interface CodexCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Whether `path` names the npm launcher rather than the native binary. */
export function isCodexLauncher(path: string): boolean {
  return /\.(?:js|mjs|cjs)$/i.test(path);
}

/** The command that runs `binary` with `args`. */
export function codexCommand(binary: string, args: readonly string[]): CodexCommand {
  return isCodexLauncher(binary)
    ? { command: process.execPath, args: [binary, ...args] }
    : { command: binary, args: [...args] };
}

/** The version `--version` printed: the second whitespace token of its first non-empty line. */
export function codexVersionOf(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim() !== '');
  if (line === undefined) return null;
  const token = line.trim().split(/\s+/)[1];
  return token === undefined || token === '' ? null : token;
}

/** The version a server's `userAgent` names: what follows the first `/`, up to the first space. */
export function userAgentVersion(userAgent: string): string | null {
  const match = /^[^/\s]+\/(\S+)/.exec(userAgent);
  return match?.[1] ?? null;
}

/** Why `found` is not the pinned version, in words naming where it came from, or null when it is. */
export function codexVersionProblem(source: string, found: string | null): string | null {
  if (found === CODEX_PINNED_VERSION) return null;
  if (found === null)
    return `${source} reports no version; this host is pinned to Codex ${CODEX_PINNED_VERSION}`;
  if (found === UNRELEASED_VERSION) {
    return `${source} is an unreleased build (${UNRELEASED_VERSION}); this host is pinned to Codex ${CODEX_PINNED_VERSION}`;
  }
  return `${source} is Codex ${found}; this host is pinned to Codex ${CODEX_PINNED_VERSION}`;
}

/** The runner for `--version`, a seam for tests. */
export type RunVersion = (
  command: CodexCommand,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
) => Promise<{ readonly stdout: string } | { readonly error: string }>;

export const runVersion: RunVersion = (command, env, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      command.command,
      [...command.args],
      { env: { ...env }, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          const code = (error as NodeJS.ErrnoException).code;
          resolve({
            error: code === 'ENOENT' ? 'absent' : error.killed === true ? 'did not answer' : error.message,
          });
          return;
        }
        resolve({ stdout });
      },
    );
  });

/**
 * Ask the binary its version and hold it to the pin. Refuses `runtime-unavailable` with the path, the
 * version found and the version pinned, or with what stopped the binary answering.
 */
export async function readCodexVersion(
  binary: string,
  env: Readonly<Record<string, string>>,
  run: RunVersion = runVersion,
  timeoutMs: number = CODEX_VERSION_TIMEOUT_MS,
): Promise<Result<string>> {
  const answered = await run(codexCommand(binary, ['--version']), env, timeoutMs);
  if ('error' in answered) {
    return refuse(
      'runtime-unavailable',
      `the Codex binary ${binary} ${answered.error === 'absent' ? 'is absent' : `could not be run: ${answered.error}`}; this host is pinned to Codex ${CODEX_PINNED_VERSION}`,
    );
  }
  const found = codexVersionOf(answered.stdout);
  const problem = codexVersionProblem(`the Codex binary ${binary}`, found);
  return problem === null ? ok(found ?? CODEX_PINNED_VERSION) : refuse('runtime-unavailable', problem);
}
