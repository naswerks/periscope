/**
 * The repository's own agent settings, read before a session that loads them starts.
 *
 * A session that names the `project` or `local` settings tier has the agent CLI read
 * `.claude/settings.json` or `.claude/settings.local.json` from its working directory, and the CLI
 * applies a file's `env` to its own process after every screen this host runs. So a repository the
 * session works in could set the model route, its credentials, a proxy or the loader through that
 * block, past the floor that keeps a controller from setting them and past the endpoint the operator
 * declared. This host reads the same two files first and refuses the session by name
 * (`settings-route-refused`) when either names a key beneath the floor.
 *
 * The match runs through the floor's own matcher (`envKeysBeneathFloor`), never a copy of the list,
 * so this screen and the controller's cannot drift apart. The user tier is the operator's own file
 * and is not read.
 *
 * What counts as a file the CLI cannot read decides what passes. A file that neither reads as strict
 * JSON nor as JSON with comments and trailing commas carries nothing the CLI would apply, and
 * passes; anything either reading accepts is checked. A missing or unreadable file passes, and so
 * does one whose `env` is absent or not an object.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import { EXTRA_ENV_FLOOR, envKeysBeneathFloor } from '../sessions/spawn-env.js';

/** The repository settings file each tier loads, as path segments under the working directory. */
export const REPOSITORY_SETTINGS_FILES = {
  project: ['.claude', 'settings.json'],
  local: ['.claude', 'settings.local.json'],
} as const;

/**
 * Why a session that loads these settings tiers in `cwd` is refused, or null. Each file a listed tier
 * loads is read; every key of its `env` beneath `floor` is named, by file.
 */
export function settingsRouteRefusal(
  cwd: string,
  settingSources: readonly string[],
  floor: readonly string[] = EXTRA_ENV_FLOOR,
): Refusal | null {
  const findings: string[] = [];
  for (const tier of ['project', 'local'] as const) {
    if (!settingSources.includes(tier)) continue;
    const file = join(cwd, ...REPOSITORY_SETTINGS_FILES[tier]);
    const keys = envKeysOf(file);
    const beneath = envKeysBeneathFloor(keys, floor);
    if (beneath.length > 0) findings.push(`${file} (the ${tier} tier) names ${beneath.join(', ')}`);
  }
  if (findings.length === 0) return null;
  return refusal(
    'settings-route-refused',
    `${findings.join('; ')} in its env, beneath this host's floor (${floor.join(', ')}): the agent CLI ` +
      `would apply them past every screen this host runs. Remove the keys, or open the session without ` +
      `that settings tier`,
  );
}

/** The keys of a settings file's `env` object; empty when the file, its JSON or its `env` is absent. */
function envKeysOf(file: string): readonly string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const read = readSettingsText(text);
  if (typeof read !== 'object' || read === null || Array.isArray(read)) return [];
  const env = (read as Record<string, unknown>)['env'];
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return [];
  return Object.keys(env);
}

/**
 * A settings file's value, or undefined when neither reading accepts it: strict JSON first, then the
 * same text with its comments and trailing commas removed. A leading byte-order mark is dropped.
 */
export function readSettingsText(text: string): unknown {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // Not strict JSON; the tolerant reading follows.
  }
  try {
    return JSON.parse(withoutTrailingCommas(withoutComments(body))) as unknown;
  } catch {
    return undefined;
  }
}

/** The text with its line and block comments removed, leaving every string literal whole. */
function withoutComments(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 2;
      out += ' ';
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/** The text with every comma that closes nothing but whitespace before a `}` or `]` removed. */
function withoutTrailingCommas(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === ',') {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]!)) next += 1;
      if (text[next] === '}' || text[next] === ']') {
        index += 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/** The index just past the string literal that opens at `start`, escapes included. */
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') index += 2;
    else if (char === '"') return index + 1;
    else index += 1;
  }
  return text.length;
}
