/**
 * `periscope config` — read or write the config file the daemon falls back to.
 *
 * Why this is a command: the binary reads its configuration from the environment first and the
 * file second (every consuming verb: `serve`, `login`, `pair`), and nothing else in this package
 * ever writes that file. Without it, a user installing the host on a machine with no UI has
 * exactly one configuration surface, env vars at process start, which is a supervisor's surface,
 * not a person's. This verb is the person's.
 *
 * It orchestrates only. The filesystem work lives in `host/config-file.ts`, because `src/host/`
 * is the one directory allowed to touch the machine; this module composes that seam and formats
 * lines, exactly the split `login` and `pair` use.
 *
 * The output says what wins. Every listing line marks a value the environment currently
 * overrides, because "set it and nothing changed" with a stale env var standing in front of the
 * file is otherwise confusing; the rule is env-wins and the listing repeats it where the operator
 * is looking.
 */
import {
  CONFIG_KEYS,
  configFilePath,
  readConfigFile,
  writeConfigEntries,
  writeConfigEntry,
} from '../host/config-file.js';
import { configValueProblem } from './reconfigure.js';

/** What one invocation produced: the lines to print, and whether it succeeded. */
export interface ConfigOutcome {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

export function runConfig(
  key: string | null,
  value: string | null,
  env: NodeJS.ProcessEnv,
  unset = false,
): ConfigOutcome {
  const path = configFilePath(env);
  if (path === null) {
    return {
      ok: false,
      lines: ['there is nowhere to keep a config file — no home directory and no PERISCOPE_CONFIG_DIR'],
    };
  }

  if (unset) {
    if (key === null) return { ok: false, lines: ['usage: periscope config --unset <key>'] };
    const reading = readConfigFile(env);
    if (reading.problem !== null) return { ok: false, lines: [reading.problem] };
    if (reading.values[key] === undefined) return { ok: true, lines: [`${key} is not set in ${path}`] };
    const problem = writeConfigEntries(env, [{ key, value: null }]);
    if (problem !== null) return { ok: false, lines: [problem] };
    return { ok: true, lines: [`${key} removed from ${path}`] };
  }

  if (key === null) {
    const reading = readConfigFile(env);
    if (reading.problem !== null) return { ok: false, lines: [reading.problem] };
    const entries = Object.entries(reading.values);
    const lines = [
      `config file: ${path}`,
      ...(entries.length === 0 ? ['(empty — set a value with: periscope config <key> <value>)'] : []),
      ...entries.map(([name, stored]) => {
        const fromEnv = env[name];
        const overridden =
          fromEnv !== undefined && fromEnv !== '' ? '  (currently overridden by the environment)' : '';
        return `  ${name} = ${stored}${overridden}`;
      }),
      `keys this host reads: ${CONFIG_KEYS.join(', ')}`,
    ];
    return { ok: true, lines };
  }

  if (value === null) {
    const reading = readConfigFile(env);
    if (reading.problem !== null) return { ok: false, lines: [reading.problem] };
    const stored = reading.values[key];
    if (stored === undefined) {
      return { ok: false, lines: [`${key} is not set in ${path}`] };
    }
    return { ok: true, lines: [stored] };
  }

  // The same screen the wire runs on `host_configure`, before anything is written: a value the
  // daemon would refuse at its next start is refused here, where the person typing it is looking.
  const screened = configValueProblem(key, value);
  if (screened !== null) return { ok: false, lines: [screened] };
  const problem = writeConfigEntry(env, key, value);
  if (problem !== null) return { ok: false, lines: [problem] };
  const fromEnv = env[key];
  return {
    ok: true,
    lines: [
      `${key} written to ${path}`,
      ...(fromEnv !== undefined && fromEnv !== ''
        ? [
            `note: ${key} is currently set in the environment, and the environment wins — the file value is a fallback`,
          ]
        : []),
    ],
  };
}
