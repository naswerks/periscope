/**
 * The plugin directories a host loads into every session: the agent CLI's `--plugin-dir`, held in
 * the host's configuration (`PERISCOPE_PLUGIN_DIRS`) so a controller need not know this machine's
 * disk to have its sessions load a plugin. Each directory is a plugin root, the parent of
 * `.claude-plugin/plugin.json` and `skills/`; the manifest's name and version are reported in the
 * hello so a controller can say what this host carries before it opens a session.
 *
 * A directory is checked twice: when the value is written (over the wire or at start), and again
 * at every open, because a directory that existed when it was configured can be gone by the time a
 * session needs it. The agent SDK skips a missing plugin path silently, so the open refuses instead.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import type { HostPlugin } from '../control/frames.js';

/** A plugin the SDK loads from a local directory: the one plugin shape it accepts. */
export interface LocalPlugin {
  readonly type: 'local';
  readonly path: string;
  readonly skipMcpDiscovery?: boolean;
}

/**
 * The directories a `PERISCOPE_PLUGIN_DIRS` value names: split on the platform's path-list
 * delimiter, trimmed, empties dropped, in the operator's order. Null or empty is no directories.
 */
export function parsePluginDirs(value: string | null | undefined): readonly string[] {
  if (value === undefined || value === null) return [];
  return value
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The manifest file every plugin root carries. */
export function pluginManifestPath(dir: string): string {
  return join(dir, '.claude-plugin', 'plugin.json');
}

/**
 * The first thing wrong with a list of plugin directories, or null: each must be absolute, exist as
 * a directory, and carry a readable manifest naming the plugin. Named by directory so the operator
 * can act on it.
 */
export function pluginDirsProblem(dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    if (!isAbsolute(dir)) return `plugin directory '${dir}' is not an absolute path`;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return `plugin directory '${dir}' does not exist on this host`;
    }
    const manifest = readManifest(dir);
    if (typeof manifest === 'string') return manifest;
  }
  return null;
}

/**
 * What each directory's manifest says: the name, the version when it declares one, and the path as
 * configured. A directory whose manifest cannot be read reports its problem in place of a name so a
 * hello never claims a plugin the host cannot load; `pluginDirsProblem` refuses it earlier where the
 * value is written.
 */
export function readPluginManifests(dirs: readonly string[]): readonly HostPlugin[] {
  const out: HostPlugin[] = [];
  for (const dir of dirs) {
    const manifest = readManifest(dir);
    if (typeof manifest === 'string') continue;
    out.push({ name: manifest.name, version: manifest.version, path: dir });
  }
  return out;
}

/**
 * The host's configured directories first, then the controller's own plugins, one entry per path.
 * A path both name is one plugin, kept once in the host's position; a controller may add to what the
 * host loads and cannot remove any of it.
 */
export function mergePlugins(
  fromHost: readonly string[],
  fromController: readonly LocalPlugin[] | undefined,
): readonly LocalPlugin[] | undefined {
  if (fromHost.length === 0) return fromController;
  const seen = new Set<string>();
  const merged: LocalPlugin[] = [];
  const add = (plugin: LocalPlugin): void => {
    const key = resolve(plugin.path);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(plugin);
  };
  for (const dir of fromHost) add({ type: 'local', path: dir });
  for (const plugin of fromController ?? []) add(plugin);
  return merged;
}

function readManifest(dir: string): { name: string; version: string | null } | string {
  const file = pluginManifestPath(dir);
  if (!existsSync(file)) return `plugin directory '${dir}' has no .claude-plugin/plugin.json`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return `plugin manifest '${file}' is not valid JSON`;
  }
  if (typeof parsed !== 'object' || parsed === null) return `plugin manifest '${file}' is not an object`;
  const record = parsed as Record<string, unknown>;
  const name = record['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    return `plugin manifest '${file}' names no plugin`;
  }
  const version = record['version'];
  return { name: name.trim(), version: typeof version === 'string' && version.length > 0 ? version : null };
}
