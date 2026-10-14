import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withTempDir } from '../test-support/temp-dir.js';
import {
  createQwenSessionHome,
  inheritedEnvFiles,
  qwenAskRules,
  qwenSystemSettings,
  readBackQwenSettings,
} from './qwen-home.js';
import { QWEN_NAMES } from './qwen-names.js';

const input = { servers: ['nas'], skillDirectories: ['C:/plugins/pack/skills'], auth: null };

test('the settings ask about every tool and every attached server, turn every hook off, and keep usage statistics off', () => {
  const settings = qwenSystemSettings(input) as Record<string, unknown>;
  assert.deepEqual((settings['permissions'] as { ask: string[] }).ask, [...QWEN_NAMES.tools, 'mcp__nas']);
  assert.equal(settings['disableAllHooks'], true);
  assert.deepEqual(settings['privacy'], { usageStatisticsEnabled: false });
  assert.deepEqual(settings['tools'], { codeModeOnly: false });
  assert.deepEqual(settings['skills'], { directories: ['C:/plugins/pack/skills'] });
  assert.deepEqual(settings['modelProviders'], {});
  assert.deepEqual(settings['security'], { folderTrust: { enabled: false } });
});

test("an endpoint's auth rides the settings, and an Anthropic endpoint lists a provider per model", () => {
  const openai = qwenSystemSettings({
    ...input,
    auth: { selectedType: 'openai', apiKey: 'k', baseUrl: 'https://r/v1', anthropicModels: [] },
  }) as Record<string, unknown>;
  assert.deepEqual((openai['security'] as Record<string, unknown>)['auth'], {
    selectedType: 'openai',
    apiKey: 'k',
    baseUrl: 'https://r/v1',
  });
  assert.deepEqual(openai['modelProviders'], {});
  const anthropic = qwenSystemSettings({
    ...input,
    auth: { selectedType: 'anthropic', apiKey: 'k', baseUrl: 'https://a', anthropicModels: ['m1', 'm2'] },
  }) as Record<string, unknown>;
  assert.deepEqual(anthropic['modelProviders'], {
    anthropic: [
      { id: 'm1', baseUrl: 'https://a' },
      { id: 'm2', baseUrl: 'https://a' },
    ],
  });
});

test('a session home is written under the base, read back whole, and removed', async () => {
  await withTempDir('qwen-home', async (base) => {
    const written = createQwenSessionHome(base, input);
    assert.ok(written.ok);
    const home = written.value;
    assert.ok(home.home.startsWith(join(base, 'sessions')));
    assert.ok(existsSync(join(base, 'runtime')));
    assert.equal(readFileSync(home.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] ?? '', 'utf8'), '{}\n');
    assert.equal(readBackQwenSettings(home, home.env), null);
    assert.deepEqual(home.askRules, qwenAskRules(['nas']));
    assert.ok(home.remove().ok);
    assert.equal(existsSync(home.home), false);
    assert.ok(home.remove().ok, 'a second removal is not an error');
  });
});

test('control: the read-back refuses a missing rule, hooks left on, a file that is not JSON, and an environment that names another file', async () => {
  await withTempDir('qwen-home', async (base) => {
    const written = createQwenSessionHome(base, input);
    assert.ok(written.ok);
    const home = written.value;
    const edited =
      (edit: (settings: Record<string, unknown>) => void) =>
      (path: string): string => {
        const settings = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        edit(settings);
        return JSON.stringify(settings);
      };
    assert.match(
      readBackQwenSettings(
        home,
        home.env,
        edited((settings) => {
          (settings['permissions'] as { ask: string[] }).ask.pop();
        }),
      ) ?? '',
      /no ask rule for 1 name\(s\): mcp__nas/,
    );
    assert.match(
      readBackQwenSettings(
        home,
        home.env,
        edited((settings) => {
          settings['disableAllHooks'] = false;
        }),
      ) ?? '',
      /does not turn every hook off/,
    );
    assert.match(readBackQwenSettings(home, home.env, () => 'not json') ?? '', /could not be read back/);
    assert.match(
      readBackQwenSettings(home, { ...home.env, QWEN_CODE_SYSTEM_SETTINGS_PATH: 'C:/elsewhere.json' }) ?? '',
      /does not name .* as its system settings/,
    );
    home.remove();
  });
});

test('the variables files the CLI loads are named by their variables, never their values, and a variable the launch sets is left out', async () => {
  await withTempDir('qwen-env', async (home) => {
    assert.deepEqual(inheritedEnvFiles(home, {}), []);
    writeFileSync(join(home, '.env'), 'export OPENAI_API_KEY=sk-1\nPATH=x\n  # note\nBAD LINE\n');
    mkdirSync(join(home, '.qwen'));
    writeFileSync(join(home, '.qwen', '.env'), 'DASHSCOPE_API_KEY=d\n');
    const found = inheritedEnvFiles(home, { PATH: 'p' });
    assert.deepEqual(found, [
      { file: join(home, '.env'), names: ['OPENAI_API_KEY'] },
      { file: join(home, '.qwen', '.env'), names: ['DASHSCOPE_API_KEY'] },
    ]);
    assert.equal(JSON.stringify(found).includes('sk-1'), false);
  });
});
