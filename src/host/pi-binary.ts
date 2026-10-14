/**
 * The pi CLI this host runs: the operator's own install of `@earendil-works/pi-coding-agent`, at one
 * pinned version, never a dependency of this package and never installed by it, and this package's own
 * extension, which every pi session loads.
 *
 * `PERISCOPE_PI_BIN` names the CLI by absolute path: the package's JavaScript entry
 * (`dist/bundle/cli.js`), which this host runs with its own Node (`process.execPath`), or a program that
 * runs it. A batch file is refused: it runs only through a shell.
 *
 * The version is checked at start from `--version`, which prints the bare version on its own line; any
 * other version makes the runtime unavailable by name.
 */
import { fileURLToPath } from 'node:url';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { RunVersion } from './codex-binary.js';
import { runVersion } from './codex-binary.js';

/** The pi release this host is built and tested against. A CLI reporting any other is refused. */
export const PI_PINNED_VERSION = '1.2.0';

/** How long `--version` may take before the CLI is reported as not answering. */
export const PI_VERSION_TIMEOUT_MS = 10_000;

/** A program and its leading arguments: a JavaScript entry runs under this host's Node. */
export interface PiCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Whether `path` names a JavaScript entry rather than a program. */
export function isPiScript(path: string): boolean {
  return /\.(?:js|mjs|cjs)$/i.test(path);
}

/** The command that runs `binary` with `args`. */
export function piCommand(binary: string, args: readonly string[]): PiCommand {
  return isPiScript(binary)
    ? { command: process.execPath, args: [binary, ...args] }
    : { command: binary, args: [...args] };
}

/**
 * The absolute path of this package's pi extension: the built file beside this module, found from this
 * module's own location, never from how the process was started.
 */
export function piExtensionPath(): string {
  return fileURLToPath(new URL('./pi-extension.js', import.meta.url));
}

/** The version `--version` printed: the first whitespace token of its first non-empty line. */
export function piVersionOf(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim() !== '');
  if (line === undefined) return null;
  const token = line.trim().split(/\s+/)[0];
  return token === undefined || token === '' ? null : token;
}

/** Why `found` is not the pinned version, in words naming where it came from, or null when it is. */
export function piVersionProblem(source: string, found: string | null): string | null {
  if (found === PI_PINNED_VERSION) return null;
  if (found === null) return `${source} reports no version; this host is pinned to pi ${PI_PINNED_VERSION}`;
  return `${source} is pi ${found}; this host is pinned to pi ${PI_PINNED_VERSION}`;
}

/**
 * Ask the CLI its version and hold it to the pin. Refuses `runtime-unavailable` with the path, the
 * version found and the version pinned, or with what stopped the CLI answering.
 */
export async function readPiVersion(
  binary: string,
  env: Readonly<Record<string, string>>,
  run: RunVersion = runVersion,
  timeoutMs: number = PI_VERSION_TIMEOUT_MS,
): Promise<Result<string>> {
  const answered = await run(piCommand(binary, ['--version']), env, timeoutMs);
  if ('error' in answered) {
    return refuse(
      'runtime-unavailable',
      `the pi CLI ${binary} ${answered.error === 'absent' ? 'is absent' : `could not be run: ${answered.error}`}; this host is pinned to pi ${PI_PINNED_VERSION}`,
    );
  }
  const found = piVersionOf(answered.stdout);
  const problem = piVersionProblem(`the pi CLI ${binary}`, found);
  return problem === null ? ok(found ?? PI_PINNED_VERSION) : refuse('runtime-unavailable', problem);
}
