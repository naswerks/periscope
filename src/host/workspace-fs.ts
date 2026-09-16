/**
 * The real effects the workspace providers run on: the filesystem, and `git`.
 *
 * Why they live here and the providers do not: `src/host/` is the only directory allowed to touch
 * the machine, pinned by pins/host-boundary.test.ts, and a provider is mostly DECISIONS: which argv
 * a git call gets, whether a directory is reused or made, what a release does. Splitting them puts
 * the decisions where they can be tested with no disk and no repository — which is what turns "never
 * hard-reset an existing branch" into a unit test instead of a rule only a lost branch could prove.
 *
 * `execFile`, never `exec`. `exec` runs its argument through a shell, so every branch name and
 * path in it becomes an injection site — and branch names arrive from a caller this package does not
 * control. `execFile` takes an argv array and spawns the program directly, with no shell to quote
 * for and nothing to escape.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';

import type { CommandEffects, WorkspaceEffects } from '../workspace/provider.js';

/** The filesystem half, on `node:fs/promises`. */
export const nodeWorkspaceEffects: WorkspaceEffects = {
  async makeDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      // Any failure to stat is treated as absent. The caller's next act either creates it — which
      // reports its own error — or attaches to it, so a stat that failed for a different reason
      // surfaces as a named provisioning refusal rather than being swallowed here.
      return false;
    }
  },
  async removeDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
  async listDirectories(path: string): Promise<string[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      // A root that does not exist yet has no workspaces in it; anything else is the caller's refusal.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  },
};

/**
 * 60 seconds. Long enough for a cold worktree creation on a loaded machine; short enough that a git
 * call which will never return does not hold a session's provisioning open indefinitely.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Running a program with an argv array.
 *
 * It rejects on a non-zero exit, and that is load-bearing rather than conventional. The worktree
 * provider probes for a branch by running `rev-parse --verify` and reading the FAILURE as "this
 * branch does not exist" — so an implementation that resolved with an empty string on a non-zero
 * exit would report every branch as existing, and the provider would attach where it should create.
 * The safe direction, but silently wrong, and it would look like it worked.
 */
export function nodeCommandEffects(timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): CommandEffects {
  return {
    run(program: string, args: readonly string[], cwd: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        execFile(
          program,
          [...args],
          { cwd, timeout: timeoutMs, windowsHide: true },
          (error, stdout, stderr) => {
            if (error !== null) {
              // stderr carries git's own message, which is the only text that says WHY. Dropping it
              // leaves a refusal reading "command failed" with nothing to act on.
              reject(new Error(`${program} ${args.join(' ')} failed: ${stderr.trim() || error.message}`));
              return;
            }
            resolve(stdout.trim());
          },
        );
      });
    },
  };
}
