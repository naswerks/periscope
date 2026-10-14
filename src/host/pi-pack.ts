/**
 * The plugin directories a pi session takes, as pi takes them: each directory's `skills/` folder, named
 * on pi's command line with `--skill`, which pi searches for `<skill>/SKILL.md` and which it loads even
 * though every other skill source is turned off (`--no-skills`). pi names every skill by its own `name`,
 * bare (`review`, not `plugin:review`), and lists it as the command `skill:<name>`.
 *
 * Each directory is read here first: a plugin directory this host can use, with a `skills/` folder, is
 * handed over; one it cannot use, or one with no skills, is left out and reported in the session's
 * receipt among its plugin errors, by path.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ReceiptPluginError } from '../control/frames.js';
import { UNDELIVERED_PLUGIN } from './codex-pack.js';
import { pluginDirsProblem } from './plugin-dirs.js';

/** What the plugin directories of one session come to: the skill directories handed over, and the rest. */
export interface PiSkillDirectories {
  readonly directories: readonly string[];
  readonly problems: readonly ReceiptPluginError[];
}

/** Split `paths` into the skill directories pi is handed and the problems reported for the rest. */
export function piSkillDirectories(paths: readonly string[]): PiSkillDirectories {
  const directories: string[] = [];
  const problems: ReceiptPluginError[] = [];
  for (const path of paths) {
    const problem = pluginDirsProblem([path]);
    if (problem !== null) {
      problems.push({ plugin: path, type: UNDELIVERED_PLUGIN, message: problem, path });
      continue;
    }
    const skills = join(path, 'skills');
    let isDirectory: boolean;
    try {
      isDirectory = existsSync(skills) && statSync(skills).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      problems.push({
        plugin: path,
        type: UNDELIVERED_PLUGIN,
        message: `${path} has no skills directory, so pi would find no skill in it`,
        path,
      });
      continue;
    }
    if (!directories.includes(skills)) directories.push(skills);
  }
  return { directories, problems };
}

/** The command-line flags that hand pi `directories`: one `--skill` each. */
export function piSkillArgs(directories: readonly string[]): string[] {
  return directories.flatMap((directory) => ['--skill', directory]);
}
