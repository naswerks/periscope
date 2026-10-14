/**
 * The pi runtime as the hello states it: the read at start (the pinned version, the agent home's files,
 * the models pi reaches), the entry it yields, and how a pi session's messages ride the wire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { HostModel } from '../control/frames.js';
import { MAX_AGENT_MODELS } from '../control/frames.js';
import { fakePi } from '../test-support/fake-pi.js';
import { withTempDir } from '../test-support/temp-dir.js';
import type { RunVersion } from './codex-binary.js';
import { PI_PINNED_VERSION } from './pi-binary.js';
import {
  PI_MESSAGE_BINDING,
  availablePiEntry,
  piHostModel,
  readPiModelsWith,
  readPiRuntime,
} from './pi-runtime.js';

const BINARY = 'C:/tools/pi/dist/bundle/cli.js';
const answering =
  (stdout: string): RunVersion =>
  () =>
    Promise.resolve({ stdout });
const model = (index: number): HostModel =>
  piHostModel({ provider: 'openrouter', id: `vendor/model-${index}` });

test("pi's entry offers no permission mode, the thinking ladder as its efforts, a thinking switch, and the intercepted tier", () => {
  assert.deepEqual(availablePiEntry('1.2.0'), {
    runtime: 'pi',
    version: '1.2.0',
    sdkVersion: null,
    models: [],
    vocabularies: {
      permissionModes: [],
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      thinking: true,
    },
    controlTier: { level: 'intercepted', degrades: [] },
    available: true,
    unavailableReason: null,
  });
});

test('the read at start holds the version to the pin, writes the agent home, and lists the models pi reaches as provider/id', async () => {
  await withTempDir('pi-read', async (base) => {
    const read = await readPiRuntime({
      binary: BINARY,
      base,
      env: {},
      runVersion: answering(`${PI_PINNED_VERSION}\n`),
      readModels: (_binary, env) => {
        assert.equal(
          env['PI_CODING_AGENT_DIR'],
          join(base, 'agent'),
          'the models were read from another home',
        );
        return Promise.resolve({
          models: [
            model(1),
            piHostModel({ provider: 'google', id: 'gemini-x', name: 'Gemini X', reasoning: true }),
          ],
        });
      },
    });
    assert.equal(read.detail, null);
    assert.equal(read.entry.available, true);
    assert.deepEqual(
      read.entry.models.map((one) => [one.value, one.displayName, one.supportedEffortLevels.length]),
      [
        ['openrouter/vendor/model-1', 'vendor/model-1', 0],
        ['google/gemini-x', 'Gemini X', 6],
      ],
    );
    assert.equal(existsSync(join(base, 'agent', 'models.json')), true);
    assert.equal(existsSync(join(base, 'agent', 'mcp.json')), true);
  });
});

test('another version, or none, is unavailable by name; a model list that cannot be read, or is past the bound, is no list and says why', async () => {
  await withTempDir('pi-read', async (base) => {
    const off = await readPiRuntime({ binary: BINARY, base, env: {}, runVersion: answering('1.1.0\n') });
    assert.equal(off.entry.available, false);
    assert.match(off.entry.unavailableReason ?? '', /is pi 1\.1\.0; this host is pinned to pi 1\.2\.0/);
    const absent = await readPiRuntime({
      binary: BINARY,
      base,
      env: {},
      runVersion: () => Promise.resolve({ error: 'absent' }),
    });
    assert.match(absent.entry.unavailableReason ?? '', /is absent/);
    const unread = await readPiRuntime({
      binary: BINARY,
      base,
      env: {},
      runVersion: answering('1.2.0'),
      readModels: () => Promise.resolve({ error: 'No models available. Use /login' }),
    });
    assert.equal(unread.entry.available, true, 'a model list that could not be read made pi unavailable');
    assert.deepEqual(unread.entry.models, []);
    assert.match(unread.detail ?? '', /they could not be read \(No models available/);
    const many = await readPiRuntime({
      binary: BINARY,
      base,
      env: {},
      runVersion: answering('1.2.0'),
      readModels: () =>
        Promise.resolve({
          models: Array.from({ length: MAX_AGENT_MODELS + 1 }, (_one, index) => model(index)),
        }),
    });
    assert.deepEqual(many.entry.models, []);
    assert.match(
      many.detail ?? '',
      new RegExp(`pi reaches ${MAX_AGENT_MODELS + 1}, past the ${MAX_AGENT_MODELS}`),
    );
  });
});

test('the models are read from a pi started with nothing of its own and no session, and closed without a prompt', async () => {
  const fake = fakePi({ models: [{ provider: 'openrouter', id: 'vendor/m' }] });
  const read = readPiModelsWith({
    cwd: '.',
    spawn: fake.spawn,
    killTree: () => Promise.resolve(),
    closeGraceMs: 20,
  });
  const models = await read(BINARY, { PI_CODING_AGENT_DIR: '/base/agent' });
  assert.deepEqual('models' in models ? models.models.map((one) => one.value) : models, [
    'openrouter/vendor/m',
  ]);
  assert.deepEqual(fake.child.spawned?.args, [
    BINARY,
    '--mode',
    'rpc',
    '--no-extensions',
    '--no-skills',
    '--no-approve',
    '--no-session',
  ]);
  assert.equal(fake.cli.commandsOf('prompt').length, 0);
  assert.equal(fake.child.stdinEnded, true, 'the reading pi was left running');
});

test("a pi session's events ride as pi wrote them, a streamed delta on the delta lane; its records and answers on the update lane; the hello nowhere", () => {
  assert.deepEqual(PI_MESSAGE_BINDING.route({ kind: 'event', event: { type: 'message_update' } }), {
    lane: 'delta',
    body: { type: 'message_update' },
  });
  assert.deepEqual(PI_MESSAGE_BINDING.route({ kind: 'event', event: { type: 'agent_start' } }), {
    lane: 'update',
    body: { type: 'agent_start' },
  });
  assert.equal(
    PI_MESSAGE_BINDING.route({ kind: 'record', record: { type: 'extension_error' } })?.lane,
    'update',
  );
  assert.equal(
    PI_MESSAGE_BINDING.route({
      kind: 'response',
      command: 'prompt',
      request: {},
      response: { type: 'response', success: false },
    })?.lane,
    'update',
  );
  assert.equal(
    PI_MESSAGE_BINDING.route({
      kind: 'hello',
      hello: { reason: 'startup', tools: [], commands: [], servers: [], truncated: false },
    }),
    null,
  );
  assert.equal(PI_MESSAGE_BINDING.runtime, 'pi');
});
