/**
 * The plugin directories a Qwen Code session takes, as Qwen Code takes them: each directory's `skills/`
 * folder, listed in the session's settings as one of its skill directories (`skills.directories`). The
 * CLI reads each one level deep for `<skill>/SKILL.md` and names every skill by its own `name`, bare
 * (`review`, not `plugin:review`), at the user level.
 *
 * Each directory is read here first: a plugin directory this host can use, with a `skills/` folder, is
 * handed over; one it cannot use, or one with no skills, is left out and reported in the session's
 * receipt among its plugin errors, by path.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ReceiptPluginError } from '../control/frames.js';
import { UNDELIVERED_PLUGIN } from './codex-pack.js';
import { pluginDirsProblem } from './plugin-dirs.js';

/** What the plugin directories of one session come to: the skill directories handed over, and the rest. */
export interface QwenSkillDirectories {
  readonly directories: readonly string[];
  readonly problems: readonly ReceiptPluginError[];
}

/** Split `paths` into the skill directories the CLI is handed and the problems reported for the rest. */
export function qwenSkillDirectories(paths: readonly string[]): QwenSkillDirectories {
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
        message: `${path} has no skills directory, so Qwen Code would find no skill in it`,
        path,
      });
      continue;
    }
    if (!directories.includes(skills)) directories.push(skills);
  }
  return { directories, problems };
}

/** The most skills a hand-over reports, the receipt's own bound. */
const MAX_HANDED_OVER_SKILLS = 256;

/**
 * The names the CLI will list the skills of `directories` under: each `<skill>/SKILL.md`'s own `name`, as
 * its front matter states it, else its folder's name. What this host handed over, reported as such; the
 * CLI's own list arrives later, from its context usage.
 */
export function qwenHandedOverSkills(directories: readonly string[]): string[] {
  const names: string[] = [];
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(directory, entry, 'SKILL.md');
      if (!existsSync(file)) continue;
      let named: string | null;
      try {
        const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, 'utf8'));
        named =
          head === null ? null : (/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(head[1] ?? '')?.[1] ?? null);
      } catch {
        named = null;
      }
      const name = named ?? entry;
      if (!names.includes(name)) names.push(name);
      if (names.length >= MAX_HANDED_OVER_SKILLS) return names;
    }
  }
  return names;
}
