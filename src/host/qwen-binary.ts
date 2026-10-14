/**
 * The Qwen Code CLI this host runs: the operator's own install of `@qwen-code/qwen-code`, at one pinned
 * version, never a dependency of this package and never installed by it.
 *
 * `PERISCOPE_QWEN_BIN` names it by absolute path: the package's JavaScript entry (`cli-entry.js`), which
 * this host runs with its own Node (`process.execPath`), or a program that runs it, such as the POSIX
 * `qwen` link. A batch file is refused: it runs only through a shell.
 *
 * The version is checked at start from `--version`, which prints the bare version on its first line
 * without reading any configuration or sign-in; any other version makes the runtime unavailable by name.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { RunVersion } from './codex-binary.js';
import { runVersion } from './codex-binary.js';

/** The Qwen Code release this host is built and tested against. A CLI reporting any other is refused. */
export const QWEN_PINNED_VERSION = '0.25.1';

/** How long `--version` may take before the CLI is reported as not answering. */
export const QWEN_VERSION_TIMEOUT_MS = 10_000;

/** A program and its leading arguments: a JavaScript entry runs under this host's Node. */
export interface QwenCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Whether `path` names a JavaScript entry rather than a program. */
export function isQwenScript(path: string): boolean {
  return /\.(?:js|mjs|cjs)$/i.test(path);
}

/** The command that runs `binary` with `args`. */
export function qwenCommand(binary: string, args: readonly string[]): QwenCommand {
  return isQwenScript(binary)
    ? { command: process.execPath, args: [binary, ...args] }
    : { command: binary, args: [...args] };
}

/** The version `--version` printed: the first whitespace token of its first non-empty line. */
export function qwenVersionOf(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim() !== '');
  if (line === undefined) return null;
  const token = line.trim().split(/\s+/)[0];
  return token === undefined || token === '' ? null : token;
}

/** Why `found` is not the pinned version, in words naming where it came from, or null when it is. */
export function qwenVersionProblem(source: string, found: string | null): string | null {
  if (found === QWEN_PINNED_VERSION) return null;
  if (found === null)
    return `${source} reports no version; this host is pinned to Qwen Code ${QWEN_PINNED_VERSION}`;
  return `${source} is Qwen Code ${found}; this host is pinned to Qwen Code ${QWEN_PINNED_VERSION}`;
}

/**
 * Ask the CLI its version and hold it to the pin. Refuses `runtime-unavailable` with the path, the
 * version found and the version pinned, or with what stopped the CLI answering.
 */
export async function readQwenVersion(
  binary: string,
  env: Readonly<Record<string, string>>,
  run: RunVersion = runVersion,
  timeoutMs: number = QWEN_VERSION_TIMEOUT_MS,
): Promise<Result<string>> {
  const answered = await run(qwenCommand(binary, ['--version']), env, timeoutMs);
  if ('error' in answered) {
    return refuse(
      'runtime-unavailable',
      `the Qwen Code CLI ${binary} ${answered.error === 'absent' ? 'is absent' : `could not be run: ${answered.error}`}; this host is pinned to Qwen Code ${QWEN_PINNED_VERSION}`,
    );
  }
  const found = qwenVersionOf(answered.stdout);
  const problem = qwenVersionProblem(`the Qwen Code CLI ${binary}`, found);
  return problem === null ? ok(found ?? QWEN_PINNED_VERSION) : refuse('runtime-unavailable', problem);
}
