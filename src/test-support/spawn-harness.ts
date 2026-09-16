/**
 * Runs the built binary (`dist/bin/periscope.js`) as a child process and captures what it printed
 * and how it exited. The dispatch (`bin/main.ts`) and the daemon (`bin/serve.ts`) are importable;
 * the process-level properties (exit codes, signals, draining) are proven only by spawning the
 * shipped entry point.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The compiled binary, resolved from this module's own compiled location. */
export const BINARY = fileURLToPath(new URL('../bin/periscope.js', import.meta.url));

/** How long a spawned binary may run before the harness kills it. */
export const PROCESS_TIMEOUT_MS = 20_000;

/**
 * Stop the child deliberately once its stdout matches `on`. Without a settle rule the harness waits
 * for the process to exit on its own, which is the shape for every terminal case.
 */
export interface Settle {
  readonly on: RegExp;
  readonly signal?: NodeJS.Signals;
}

export interface Run {
  /** The exit code, or null when the process was killed by a signal. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Whether the process was still alive when the settle rule fired. Always false without one. */
  readonly alive: boolean;
}

export async function runBinary(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  settle?: Settle,
): Promise<Run> {
  const child = spawn(process.execPath, [BINARY, ...args], {
    env: { ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let exited = false;
  let alive = false;
  let settled = false;

  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    if (settle !== undefined && !settled && settle.on.test(stdout)) {
      settled = true;
      alive = !exited;
      child.kill(settle.signal ?? 'SIGKILL');
    }
  });
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));

  const timer = setTimeout(() => child.kill('SIGKILL'), PROCESS_TIMEOUT_MS);

  const code = await new Promise<number | null>((resolve) => {
    child.on('exit', (exitCode) => {
      exited = true;
      resolve(exitCode);
    });
  });
  clearTimeout(timer);

  return { code, stdout, stderr, alive };
}
