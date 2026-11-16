import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withTempDir } from '../test-support/temp-dir.js';
import { COPILOT_MESSAGE_BINDING, readCopilotRuntime } from './copilot-runtime.js';
import {
  COPILOT_RUNTIME_PINNED_VERSION,
  COPILOT_SDK_PINNED_VERSION,
  copilotPlatform,
  loadCopilotSdk,
  readCopilotInstall,
} from './copilot-sdk.js';
import type { CopilotInstall } from './copilot-sdk.js';
import type { CopilotMessage } from './copilot-wire.js';

const PLATFORM = 'win32-x64';

/** An install of the SDK at `version`, its runtime pinned at `runtime`, for `platform`. */
function install(
  directory: string,
  version = COPILOT_SDK_PINNED_VERSION,
  runtime = COPILOT_RUNTIME_PINNED_VERSION,
): void {
  const root = join(directory, 'node_modules', '@github', 'copilot-sdk');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@github/copilot-sdk', version, copilotRuntime: { version: runtime } }),
  );
  writeFileSync(join(root, 'dist', 'index.js'), 'export {};\n');
  const platformRoot = join(directory, 'node_modules', '@github', `copilot-sdk-${PLATFORM}`);
  const prebuilds = join(platformRoot, 'prebuilds', PLATFORM);
  mkdirSync(prebuilds, { recursive: true });
  writeFileSync(join(platformRoot, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(prebuilds, 'copilot-runtime.exe'), 'MZ');
  writeFileSync(join(prebuilds, 'runtime.node'), 'MZ');
}

test("an install at the pin is read: the SDK's version, the runtime it pins, and this platform's runtime present", () =>
  withTempDir('copilot-sdk', (directory) => {
    install(directory);
    const read = readCopilotInstall(directory, PLATFORM);
    assert.ok(read.ok, read.ok ? '' : read.refusal.detail);
    assert.equal(
      read.value.runtime,
      join(
        directory,
        'node_modules',
        '@github',
        `copilot-sdk-${PLATFORM}`,
        'prebuilds',
        PLATFORM,
        'copilot-runtime.exe',
      ),
    );
    assert.equal(
      read.value.entry,
      join(directory, 'node_modules', '@github', 'copilot-sdk', 'dist', 'index.js'),
    );
    return Promise.resolve();
  }));

test('an install off the pin, incomplete or absent is refused runtime-unavailable, saying what it found and what is pinned', () =>
  withTempDir('copilot-sdk-off', (directory) => {
    const refused = (dir: string, platform: string | null = PLATFORM): string => {
      const read = readCopilotInstall(dir, platform);
      assert.equal(read.ok, false);
      return read.ok ? '' : `${read.refusal.reason}: ${read.refusal.detail}`;
    };
    assert.match(
      refused(join(directory, 'absent')),
      /^runtime-unavailable: no @github\/copilot-sdk is installed/,
    );
    assert.match(refused('relative/dir'), /not an absolute path/);
    const older = join(directory, 'older');
    install(older, '1.0.33', '1.0.110');
    assert.match(
      refused(older),
      /holds @github\/copilot-sdk 1\.0\.33 \(runtime 1\.0\.110\); this host is pinned to @github\/copilot-sdk 1\.0\.34 \(runtime 1\.0\.112\)/,
    );
    const runtimeMoved = join(directory, 'runtime-moved');
    install(runtimeMoved, COPILOT_SDK_PINNED_VERSION, '1.0.113');
    assert.match(refused(runtimeMoved), /runtime 1\.0\.113/);
    const noBinary = join(directory, 'no-binary');
    install(noBinary);
    rmSync(
      join(
        noBinary,
        'node_modules',
        '@github',
        `copilot-sdk-${PLATFORM}`,
        'prebuilds',
        PLATFORM,
        'copilot-runtime.exe',
      ),
    );
    assert.match(refused(noBinary), /is incomplete/);
    const pinned = join(directory, 'pinned');
    install(pinned);
    assert.match(refused(pinned, null), /no build for/);
    const otherPlatform = join(directory, 'other-platform');
    install(otherPlatform);
    assert.match(refused(otherPlatform, 'linux-x64'), /the Copilot runtime for linux-x64 is not installed/);
    return Promise.resolve();
  }));

test('an SDK that could not be loaded is tried again by the next session, and one that loaded is kept', () =>
  withTempDir('copilot-load', async (directory) => {
    const entry = join(directory, 'index.mjs');
    const install: CopilotInstall = {
      directory,
      entry,
      runtime: join(directory, 'copilot-runtime'),
      sdkVersion: '1.0.34',
      runtimeVersion: '1.0.112',
    };
    const absent = await loadCopilotSdk(install);
    assert.equal(absent.ok, false);
    assert.equal(absent.ok ? null : absent.refusal.reason, 'runtime-unavailable');
    // The operator puts the SDK in place under the running host.
    writeFileSync(
      entry,
      'export class CopilotClient {}\nexport const RuntimeConnection = { forStdio: () => ({ kind: "stdio" }) };\n',
    );
    const repaired = await loadCopilotSdk(install);
    assert.ok(repaired.ok, repaired.ok ? '' : `the first failure was kept: ${repaired.refusal.detail}`);
    // Control: the loaded module is the one every later session gets.
    const again = await loadCopilotSdk(install);
    assert.ok(again.ok && again.value === repaired.value);
  }));

test("the platform word is the runtime packages' own", () => {
  assert.equal(copilotPlatform('win32', 'x64', false), 'win32-x64');
  assert.equal(copilotPlatform('darwin', 'arm64', false), 'darwin-arm64');
  assert.equal(copilotPlatform('linux', 'x64', false), 'linux-x64');
  assert.equal(copilotPlatform('linux', 'arm64', true), 'linuxmusl-arm64');
  assert.equal(copilotPlatform('freebsd', 'x64', false), null);
  assert.equal(copilotPlatform('linux', 'ia32', false), null);
});

test('the read at start lists Copilot available with its versions and vocabularies, or unavailable with why, and starts nothing', () =>
  withTempDir('copilot-read', async (directory) => {
    install(join(directory, 'sdk'));
    const base = join(directory, 'home');
    const available = await readCopilotRuntime({
      sdk: join(directory, 'sdk'),
      base,
      readInstall: (dir) => readCopilotInstall(dir, PLATFORM),
    });
    assert.equal(available.detail, null);
    assert.deepEqual(available.entry, {
      runtime: 'copilot',
      version: COPILOT_RUNTIME_PINNED_VERSION,
      sdkVersion: COPILOT_SDK_PINNED_VERSION,
      models: [],
      vocabularies: {
        permissionModes: ['default', 'plan'],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        thinking: false,
      },
      controlTier: { level: 'intercepted-with-residual', degrades: [] },
      available: true,
      unavailableReason: null,
    });
    const missing = await readCopilotRuntime({ sdk: join(directory, 'nothing-here'), base });
    assert.equal(missing.entry.available, false);
    assert.match(missing.entry.unavailableReason ?? '', /no @github\/copilot-sdk is installed under/);
    assert.equal(missing.detail, missing.entry.unavailableReason);
  }));

test("a session's events ride as the runtime sent them, a delta on the delta lane; the open rides nowhere", () => {
  const event = (type: string): CopilotMessage => ({
    kind: 'event',
    event: { id: 'e1', parentId: null, timestamp: '', type, data: { x: 1 } },
  });
  assert.equal(COPILOT_MESSAGE_BINDING.runtime, 'copilot');
  assert.deepEqual(COPILOT_MESSAGE_BINDING.route(event('tool.execution_start')), {
    lane: 'update',
    body: { id: 'e1', parentId: null, timestamp: '', type: 'tool.execution_start', data: { x: 1 } },
  });
  assert.equal(COPILOT_MESSAGE_BINDING.route(event('assistant.message_delta'))?.lane, 'delta');
  assert.equal(COPILOT_MESSAGE_BINDING.route(event('assistant.reasoning_delta'))?.lane, 'delta');
  assert.equal(
    COPILOT_MESSAGE_BINDING.route({
      kind: 'opened',
      sessionId: 's',
      model: null,
      agentMode: 'interactive',
      tools: [],
      origin: 'new',
    }),
    null,
  );
  const fact = { kind: 'session_handle', runtime: 'copilot', handle: 's' } as const;
  assert.equal(COPILOT_MESSAGE_BINDING.sourceIdOf(event('session.idle'), fact), 'e1');
});
