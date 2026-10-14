/**
 * The runner's pi home: the agent home's two files this host owns, a session's run directory and what it
 * holds, and the sessions store a resume reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withTempDir } from '../test-support/temp-dir.js';
import type { PiEndpointRoute } from './pi-endpoints.js';
import { PI_ENDPOINT_APIS, piEndpointArgs, piEndpointRoutes } from './pi-endpoints.js';
import type { PiExtensionConfig } from './pi-extension.js';
import { PI_EXTENSION_CONFIG_VARIABLE } from './pi-extension.js';
import { createPiSessionRun, ensurePiBase, resolvePiSession, writePiAgentFiles } from './pi-home.js';

const route = (overrides: Partial<PiEndpointRoute> = {}): PiEndpointRoute => ({
  name: 'openrouter-main',
  wireApi: 'openai-chat',
  baseUrl: 'https://openrouter.ai/api/v1',
  models: ['deepseek/deepseek-chat', 'qwen/qwen3-coder'],
  env: {},
  authToken: () => '!sk-or-$key',
  ...overrides,
});

const CONFIG: PiExtensionConfig = {
  v: 1,
  runtime: 'pi',
  channel: 'c',
  token: 'the-token',
  deadlineMs: 55_000,
  servers: [],
};

test("the agent home's models file has one provider per endpoint, its key written as pi reads it as written, and its MCP file declares no server", async () => {
  await withTempDir('pi-home', async (base) => {
    assert.equal(
      writePiAgentFiles(base, [
        route(),
        route({ name: 'claude-direct', wireApi: 'anthropic-messages', models: ['claude-x'] }),
      ]).ok,
      true,
    );
    const models = JSON.parse(readFileSync(join(base, 'agent', 'models.json'), 'utf8')) as unknown;
    assert.deepEqual(models, {
      providers: {
        'openrouter-main': {
          baseUrl: 'https://openrouter.ai/api/v1',
          api: 'openai-completions',
          apiKey: '$!sk-or-$$key',
          models: [{ id: 'deepseek/deepseek-chat' }, { id: 'qwen/qwen3-coder' }],
        },
        'claude-direct': {
          baseUrl: 'https://openrouter.ai/api/v1',
          api: 'anthropic-messages',
          apiKey: '$!sk-or-$$key',
          models: [{ id: 'claude-x' }],
        },
      },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(base, 'agent', 'mcp.json'), 'utf8')), { mcpServers: {} });
    assert.deepEqual(Object.values(PI_ENDPOINT_APIS), [
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
    ]);
  });
});

test('the files are rewritten only when what they hold changes, and an operator file in their place is replaced', async () => {
  await withTempDir('pi-home', async (base) => {
    mkdirSync(join(base, 'agent'), { recursive: true });
    writeFileSync(join(base, 'agent', 'mcp.json'), '{"mcpServers":{"rogue":{"command":"x"}}}');
    assert.equal(writePiAgentFiles(base, []).ok, true);
    const written = statSync(join(base, 'agent', 'models.json')).mtimeMs;
    assert.deepEqual(JSON.parse(readFileSync(join(base, 'agent', 'mcp.json'), 'utf8')), { mcpServers: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    writePiAgentFiles(base, []);
    assert.equal(
      statSync(join(base, 'agent', 'models.json')).mtimeMs,
      written,
      'an unchanged file was rewritten',
    );
  });
});

test("a session's run directory holds the extension's configuration and the prompt, names both in pi's environment, and is removed whole", async () => {
  await withTempDir('pi-home', async (base) => {
    const written = createPiSessionRun(base, CONFIG, { flag: '--append-system-prompt', text: 'be brief' });
    assert.ok(written.ok);
    const run = written.value;
    assert.equal(run.env['PI_CODING_AGENT_DIR'], join(base, 'agent'));
    assert.equal(run.env[PI_EXTENSION_CONFIG_VARIABLE], run.configFile);
    assert.deepEqual(JSON.parse(readFileSync(run.configFile, 'utf8')), CONFIG);
    assert.equal(readFileSync(run.prompt?.file ?? '', 'utf8'), 'be brief');
    if (process.platform !== 'win32') assert.equal(statSync(run.configFile).mode & 0o777, 0o600);
    assert.equal(run.removeConfig().ok, true);
    assert.equal(existsSync(run.configFile), false);
    assert.equal(
      existsSync(run.prompt?.file ?? ''),
      true,
      'the prompt pi reads at start went with the configuration',
    );
    assert.equal(run.remove().ok, true);
    assert.equal(existsSync(run.dir), false);
  });
});

test('a resume names a session in the store that ran here; anything else is refused by name, and a fork takes one that ran anywhere', async () => {
  await withTempDir('pi-home', async (base) => {
    const sessions = ensurePiBase(base);
    assert.ok(sessions.ok);
    const store = sessions.value.sessions;
    const here = process.platform === 'win32' ? 'C:\\work\\a' : '/work/a';
    const id = '01999999-0000-7000-8000-0000000000bb';
    const file = join(store, `2026-10-14T00-00-00-000Z_${id}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({ type: 'session', version: 3, id, timestamp: 't', cwd: here })}\n{"type":"message"}\n`,
    );
    assert.deepEqual(resolvePiSession(store, id, here), { ok: true, value: file });
    assert.deepEqual(resolvePiSession(store, file, here), { ok: true, value: file });
    const elsewhere = resolvePiSession(store, id, process.platform === 'win32' ? 'C:\\work\\b' : '/work/b');
    assert.equal(elsewhere.ok ? '' : elsewhere.refusal.reason, 'request-key-unsupported');
    assert.equal(
      resolvePiSession(store, id, process.platform === 'win32' ? 'C:\\work\\b' : '/work/b', { fork: true })
        .ok,
      true,
    );
    const missing = resolvePiSession(store, 'no-such-id', here);
    assert.match(missing.ok ? '' : missing.refusal.detail, /^resume: no session no-such-id/);
    const outside = resolvePiSession(store, join(base, 'other.jsonl'), here);
    assert.match(
      outside.ok ? '' : outside.refusal.detail,
      /is not a session file in this host's sessions store/,
    );
    if (process.platform === 'win32') {
      assert.equal(
        resolvePiSession(store, id, here.toUpperCase()).ok,
        true,
        'Windows compares paths without case',
      );
    }
  });
});

test('the endpoints a pi session may open on are those the operator named pi on, and a session opens on one by name', () => {
  const declared = [
    { ...route(), runtimes: ['pi', 'qwen-code'], modelAliases: {}, contextWindow: null, firstParty: false },
    {
      ...route({ name: 'codex-only', wireApi: 'openai-responses' }),
      runtimes: ['codex'],
      modelAliases: {},
      contextWindow: null,
      firstParty: false,
    },
  ];
  assert.deepEqual(
    piEndpointRoutes(declared).map((one) => one.name),
    ['openrouter-main'],
  );
  assert.deepEqual(piEndpointArgs(route(), 'deepseek/deepseek-chat'), [
    '--provider',
    'openrouter-main',
    '--model',
    'deepseek/deepseek-chat',
  ]);
});
