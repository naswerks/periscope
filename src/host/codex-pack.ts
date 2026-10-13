/**
 * The plugin directories a Codex session takes, as Codex takes them: each directory a plugin root
 * (the parent of `.claude-plugin/plugin.json`), handed to the app-server as one of its skill roots
 * (`skills/extraRoots/set`). Codex then names every skill under a root by the manifest's own name,
 * `plugin:skill`, the way the agent CLI does.
 *
 * Codex takes a directory that does not exist without a word and finds no skills in it, and refuses
 * the whole call for a path that is not absolute. So each directory is read here first: one this host
 * can use is handed over, and one it cannot is left out and reported in the session's receipt among
 * its plugin errors, by path, so a session opened with a missing plugin says so rather than running
 * quietly without it. The host's own configured directories were already held to the same check when
 * the session was opened.
 */
import type { ReceiptPluginError } from '../control/frames.js';
import { pluginDirsProblem } from './plugin-dirs.js';

/** What the plugin directories of one session come to: the roots handed over, and the ones left out. */
export interface CodexSkillRoots {
  readonly roots: readonly string[];
  readonly problems: readonly ReceiptPluginError[];
}

/** The plugin error type a directory this host could not hand over is reported under. */
export const UNDELIVERED_PLUGIN = 'plugin-directory';

/** Split `paths` into the roots Codex is handed and the problems reported for the rest, in order. */
export function codexSkillRoots(paths: readonly string[]): CodexSkillRoots {
  const roots: string[] = [];
  const problems: ReceiptPluginError[] = [];
  for (const path of paths) {
    const problem = pluginDirsProblem([path]);
    if (problem === null) {
      if (!roots.includes(path)) roots.push(path);
    } else {
      problems.push({ plugin: path, type: UNDELIVERED_PLUGIN, message: problem, path });
    }
  }
  return { roots, problems };
}
