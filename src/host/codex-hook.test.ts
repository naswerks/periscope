/**
 * Periscope's hook in the Codex home: the lines and the shim it writes, the hooks file it merges into
 * without losing anyone else's hooks, the home paths it cannot run from, the listing it trusts by, and
 * the probe that proves the written hook runs through the shell Codex uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import type { JsonObject } from '../control/frames.js';
import { ok, refuse } from '../core/result.js';
import { CODEX_HOOK_TIMEOUT_SECONDS } from '../gate/hook-exchange.js';
import {
  CODEX_HOME_PATH_CHARACTERS,
  codexHomePathProblem,
  codexHookLines,
  codexHooksFile,
  hookTrustWrite,
  installCodexHook,
  pendingCodexHookState,
  probeCodexHook,
  readHookListing,
} from './codex-hook.js';
import { readCodexRuntime } from './codex-runtime.js';
import { packageVersion } from './package-facts.js';

const scratch = (): string => mkdtempSync(`${tmpdir()}${sep}periscope-hook-home-`);

test("the Windows line is the shim's bare path, and the shim runs this package's entry under this Node, with % doubled", () => {
  const lines = codexHookLines(
    'C:/runner/home',
    'C:/node%20/node.exe',
    'C:/pkg/dist/bin/periscope.js',
    'win32',
  );
  assert.equal(lines.windows, join('C:/runner/home', 'hooks', 'periscope-hook.cmd'));
  assert.equal(lines.listed, lines.windows);
  assert.equal(
    lines.shimText,
    '@set NODE_OPTIONS=\r\n@"C:/node%%20/node.exe" --no-warnings "C:/pkg/dist/bin/periscope.js" hook codex %*\r\n@exit /b %ERRORLEVEL%\r\n',
  );
});

test('the POSIX line quotes each path as one word, a quote inside one included', () => {
  const lines = codexHookLines('/home/runner', "/opt/it's/node", '/pkg/dist/bin/periscope.js', 'linux');
  assert.equal(
    lines.posix,
    "NODE_OPTIONS= '/opt/it'\\''s/node' --no-warnings '/pkg/dist/bin/periscope.js' hook codex",
  );
  assert.equal(lines.listed, lines.posix);
});

test('a home path holding a space or a shell metacharacter cannot carry the hook, and the problem names the character', () => {
  assert.equal(codexHomePathProblem('C:/runner/codex-home'), null);
  assert.match(codexHomePathProblem('C:/Users/John Smith/codex') ?? '', /holds a space/);
  for (const character of CODEX_HOME_PATH_CHARACTERS.filter((one) => one !== ' ')) {
    assert.match(
      codexHomePathProblem(`C:/runner/a${character}b`) ?? '',
      new RegExp(`the character \\${character}`),
      character,
    );
  }
});

test('a home path that cannot carry the hook makes Codex unavailable at the start-up read, naming the character, and starts nothing', async () => {
  let spawned = 0;
  const read = await readCodexRuntime({
    binary: 'C:/tools/codex.exe',
    home: 'C:/Users/John Smith/codex-home',
    env: {},
    clientVersion: '1.7.0',
    runVersion: () => {
      spawned += 1;
      return Promise.resolve({ stdout: 'codex-cli 0.162.1' });
    },
  });
  assert.equal(read.entry.available, false);
  assert.match(read.entry.unavailableReason ?? '', /holds a space/);
  assert.equal(spawned, 0, 'the binary was run for a home the hook cannot use');
});

test("the hooks file keeps every hook that is not periscope's, and replaces an earlier periscope hook with the current one", () => {
  const lines = codexHookLines('C:/runner/home', 'C:/node/node.exe', 'C:/pkg/dist/bin/periscope.js', 'win32');
  const existing = {
    description: 'the operator keeps notes here',
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] },
        {
          hooks: [
            {
              type: 'command',
              command: "'C:/old/node' 'C:/old/periscope.js' hook codex",
              commandWindows: 'C:/runner/home/hooks/periscope-hook.cmd',
            },
          ],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }],
    },
  };
  const merged = codexHooksFile(existing, lines) as {
    description: string;
    hooks: Record<string, JsonObject[]>;
  };
  assert.equal(merged.description, 'the operator keeps notes here');
  assert.deepEqual(merged.hooks['Stop'], existing.hooks.Stop);
  const preToolUse = merged.hooks['PreToolUse'] ?? [];
  assert.equal(preToolUse.length, 2);
  assert.deepEqual(preToolUse[0], existing.hooks.PreToolUse[0]);
  assert.deepEqual(preToolUse[1], {
    hooks: [
      {
        type: 'command',
        command: lines.posix,
        commandWindows: lines.windows,
        timeout: CODEX_HOOK_TIMEOUT_SECONDS,
        async: false,
      },
    ],
  });
  assert.equal(codexHooksFile([], lines), null, 'a file that is not an object was merged into');
  assert.equal(codexHooksFile({ hooks: { PreToolUse: 'x' } }, lines), null);
});

test('install writes the shim and the hooks file, leaves an unreadable hooks file alone, and refuses a home it cannot use', () => {
  const home = scratch();
  try {
    const installed = installCodexHook(home);
    assert.equal(installed.ok, true);
    const lines = codexHookLines(home);
    assert.equal(readFileSync(lines.shimPath, 'utf8'), lines.shimText);
    const file = JSON.parse(readFileSync(lines.hooksPath, 'utf8')) as { hooks: { PreToolUse: unknown[] } };
    assert.equal(file.hooks.PreToolUse.length, 1);
    writeFileSync(lines.hooksPath, '{ not json');
    const refused = installCodexHook(home);
    assert.equal(refused.ok ? null : refused.refusal.reason, 'codex-hook-not-active');
    assert.equal(
      readFileSync(lines.hooksPath, 'utf8'),
      '{ not json',
      'an unreadable hooks file was overwritten',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(installCodexHook('C:/a b/home').ok, false);
  assert.equal(existsSync('C:/a b/home'), false);
});

const listing = (hooks: JsonObject[]): JsonObject => ({
  data: [{ cwd: 'C:/work', hooks, warnings: [], errors: [] }],
});
const ours = (lines: ReturnType<typeof codexHookLines>, overrides: JsonObject = {}): JsonObject => ({
  key: `${lines.hooksPath}:pre_tool_use:0:0`,
  eventName: 'preToolUse',
  handlerType: 'command',
  command: lines.listed,
  async: false,
  matcher: null,
  timeoutSec: CODEX_HOOK_TIMEOUT_SECONDS,
  sourcePath: lines.hooksPath,
  source: 'user',
  enabled: true,
  currentHash: 'sha256:ours',
  trustStatus: 'untrusted',
  ...overrides,
});

test("periscope's hook is found by its source, its event and its line, and checked before it is trusted", () => {
  const lines = codexHookLines('C:/runner/home');
  assert.equal(readHookListing(listing([ours(lines)]), lines).ours?.currentHash, 'sha256:ours');
  assert.match(readHookListing(listing([]), lines).problem ?? '', /lists no PreToolUse hook/);
  assert.match(
    readHookListing(listing([ours(lines, { matcher: 'Bash' })]), lines).problem ?? '',
    /no matcher/,
  );
  assert.match(readHookListing(listing([ours(lines, { async: true })]), lines).problem ?? '', /synchronous/);
  assert.match(
    readHookListing(listing([ours(lines, { timeoutSec: 600 })]), lines).problem ?? '',
    /600s timeout/,
  );
  assert.equal(
    readHookListing(listing([ours(lines, { command: 'C:/evil.cmd' })]), lines).ours,
    null,
    "a hook running another line was taken for periscope's",
  );
});

test('every other hook that would run is foreign, on any event; one that would not run is not', () => {
  const lines = codexHookLines('C:/runner/home');
  const other = (overrides: JsonObject): JsonObject => ({
    ...ours(lines),
    key: 'other',
    sourcePath: 'C:/work/.codex/hooks.json',
    command: 'x',
    ...overrides,
  });
  const reading = readHookListing(
    listing([
      ours(lines),
      other({ eventName: 'permissionRequest', trustStatus: 'trusted' }),
      other({ eventName: 'preToolUse', trustStatus: 'managed' }),
      other({ eventName: 'stop', trustStatus: 'untrusted' }),
      other({ eventName: 'postToolUse', trustStatus: 'trusted', enabled: false }),
    ]),
    lines,
  );
  assert.deepEqual(
    reading.foreign.map((hook) => hook.eventName),
    ['permissionRequest', 'preToolUse'],
  );
});

test("the trust write is Codex's own: an upsert of hooks.state keyed by the hook, its current hash, then a reload", () => {
  const lines = codexHookLines('C:/runner/home');
  const hook = readHookListing(listing([ours(lines)]), lines).ours;
  assert.ok(hook !== null);
  assert.deepEqual(hookTrustWrite(hook), {
    edits: [
      {
        keyPath: 'hooks.state',
        value: { [`${lines.hooksPath}:pre_tool_use:0:0`]: { trusted_hash: 'sha256:ours' } },
        mergeStrategy: 'upsert',
      },
    ],
    reloadUserConfig: true,
  });
});

test('the probe runs the written hook through the shell Codex uses and reads its line; a hook that cannot run fails it', async () => {
  const home = scratch();
  try {
    const installed = installCodexHook(home);
    assert.ok(installed.ok);
    const env = { ...process.env } as Record<string, string>;
    const passed = await probeCodexHook(installed.value, { env, version: packageVersion() });
    assert.deepEqual(passed, ok(undefined));
    const broken = codexHookLines(home, process.execPath, join(home, 'no-such-entry.js'));
    writeFileSync(broken.shimPath, broken.shimText);
    const failed = await probeCodexHook(broken, { env, version: packageVersion() });
    assert.equal(failed.ok ? null : failed.refusal.reason, 'codex-hook-not-active');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a shell that cannot be started fails the probe with the reason, never a rejection', async () => {
  const lines = codexHookLines('/runner/home', '/usr/bin/node', '/pkg/dist/bin/periscope.js', 'linux');
  const failed = await probeCodexHook(lines, {
    env: {},
    version: packageVersion(),
    platform: 'linux',
    spawn: () => {
      throw new Error('spawn EACCES');
    },
  });
  assert.equal(failed.ok ? null : failed.refusal.reason, 'codex-hook-not-active');
  assert.match(failed.ok ? '' : failed.refusal.detail, /spawn EACCES/);
});

test('the hook state is ready once the read reports it written and probed, and probes again while it failed', async () => {
  const lines = codexHookLines(scratch());
  let probes = 0;
  let next = refuse<void>('codex-hook-not-active', 'still failing');
  const state = pendingCodexHookState(lines, () => {
    probes += 1;
    return Promise.resolve(next);
  });
  state.report({ installed: ok(undefined), probed: refuse('codex-hook-not-active', 'failed at start') });
  assert.equal((await state.ensureReady()).ok, false);
  assert.equal(probes, 1);
  next = ok(undefined);
  assert.equal((await state.ensureReady()).ok, true);
  assert.equal((await state.ensureReady()).ok, true);
  assert.equal(probes, 2, 'a passing probe was run again');
  const unreported = pendingCodexHookState(lines, () => Promise.resolve(next));
  unreported.report(undefined);
  assert.equal((await unreported.ensureReady()).ok, true, 'a read that installs nothing blocked every open');
  rmSync(join(lines.shimPath, '..', '..'), { recursive: true, force: true });
});
