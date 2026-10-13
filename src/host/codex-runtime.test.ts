import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fakeCodex } from '../test-support/fake-codex.js';
import type { FakeCodexOptions } from '../test-support/fake-codex.js';
import {
  CODEX_PINNED_VERSION,
  codexCommand,
  codexVersionOf,
  codexVersionProblem,
  isCodexLauncher,
  readCodexVersion,
  userAgentVersion,
} from './codex-binary.js';
import type { RunVersion } from './codex-binary.js';
import {
  codexAppServerArgs,
  codexOverrideArgs,
  codexSessionFlags,
  ensureCodexHome,
  samePath,
} from './codex-home.js';
import type { ReadCodexRuntimeOptions } from './codex-runtime.js';
import { readCodexRuntime } from './codex-runtime.js';

const FAKE_SERVER = fileURLToPath(new URL('../test-support/fake-codex-server.js', import.meta.url));

function home(): { path: string; done: () => void } {
  const path = mkdtempSync(`${tmpdir()}${sep}periscope-codex-home-`);
  return { path, done: () => rmSync(path, { recursive: true, force: true }) };
}

const answering =
  (stdout: string): RunVersion =>
  () =>
    Promise.resolve({ stdout });

// ---------------------------------------------------------------------------
// The version, from both sources
// ---------------------------------------------------------------------------

test('the version is the second token of the first line, never the first', () => {
  assert.equal(codexVersionOf('codex-cli 0.162.1\n'), '0.162.1');
  assert.equal(codexVersionOf('\r\ncodex 0.162.1\r\nmore\r\n'), '0.162.1');
  assert.equal(codexVersionOf('0.162.1'), null, 'a lone token is the name, and there is no version');
  assert.equal(codexVersionOf(''), null);
});

test('control: a line that leads with the version reads its second token, which fails the pin', () => {
  assert.equal(codexVersionOf('0.162.1 codex-cli'), 'codex-cli');
  assert.match(
    codexVersionProblem('the binary', codexVersionOf('0.162.1 codex-cli')) ?? '',
    /is Codex codex-cli; this host is pinned/,
  );
  assert.equal(codexVersionProblem('the binary', '0.162.1'), null);
  assert.match(codexVersionProblem('the binary', '0.0.0') ?? '', /an unreleased build \(0\.0\.0\)/);
  assert.match(codexVersionProblem('the binary', null) ?? '', /reports no version/);
});

test("the userAgent's version is what follows the originator's slash", () => {
  assert.equal(
    userAgentVersion('periscope/0.162.1 (Windows 10; x86_64) vscode (periscope; 1.7.0)'),
    '0.162.1',
  );
  assert.equal(userAgentVersion('no slash here'), null);
});

test('the launcher runs under this Node; the binary runs itself', () => {
  assert.equal(isCodexLauncher('C:/npm/node_modules/@openai/codex/bin/codex.js'), true);
  assert.deepEqual(codexCommand('C:/npm/codex.js', ['--version']), {
    command: process.execPath,
    args: ['C:/npm/codex.js', '--version'],
  });
  assert.deepEqual(codexCommand('C:/tools/codex.exe', ['--version']), {
    command: 'C:/tools/codex.exe',
    args: ['--version'],
  });
});

test('an absent binary and an off-version one are each refused runtime-unavailable, naming the path and both versions', async () => {
  const absent = await readCodexVersion('C:/missing/codex.exe', {}, () =>
    Promise.resolve({ error: 'absent' }),
  );
  assert.equal(absent.ok ? '' : absent.refusal.reason, 'runtime-unavailable');
  assert.match(
    absent.ok ? '' : absent.refusal.detail,
    /C:\/missing\/codex\.exe is absent; this host is pinned to Codex 0\.162\.1/,
  );
  const newer = await readCodexVersion('C:/tools/codex.exe', {}, answering('codex-cli 0.163.0\n'));
  assert.match(
    newer.ok ? '' : newer.refusal.detail,
    /C:\/tools\/codex\.exe is Codex 0\.163\.0; this host is pinned to Codex 0\.162\.1/,
  );
  const pinned = await readCodexVersion(
    'C:/tools/codex.exe',
    {},
    answering(`codex-cli ${CODEX_PINNED_VERSION}\n`),
  );
  assert.deepEqual(pinned, { ok: true, value: CODEX_PINNED_VERSION });
});

// ---------------------------------------------------------------------------
// The home and the flags
// ---------------------------------------------------------------------------

test('the home is created when absent, and a file where it should be is refused', () => {
  const root = home();
  try {
    const created = ensureCodexHome(join(root.path, 'codex-home'));
    assert.equal(created.ok, true);
    const file = join(root.path, 'a-file');
    writeFileSync(file, 'x');
    const refused = ensureCodexHome(file);
    assert.equal(refused.ok ? '' : refused.refusal.reason, 'runtime-unavailable');
  } finally {
    root.done();
  }
});

test('the session flags pin the reviewer, web search and hooks, and exclude every credential variable by an anchored pattern', () => {
  const flags = codexSessionFlags('dontAsk', ['OPENAI_API_KEY', 'MY.KEY']);
  assert.deepEqual(flags, {
    approvals_reviewer: 'user',
    approval_policy: 'never',
    sandbox_mode: 'workspace-write',
    web_search: 'disabled',
    'features.hooks': true,
    'shell_environment_policy.exclude': ['^OPENAI_API_KEY$', '^MY\\.KEY$'],
  });
  assert.deepEqual(codexOverrideArgs({ web_search: 'disabled', 'features.hooks': true }), [
    '-c',
    'web_search="disabled"',
    '-c',
    'features.hooks=true',
  ]);
  const args = codexAppServerArgs(flags);
  assert.deepEqual(args.slice(-4), ['app-server', '--listen', 'stdio://', '--strict-config']);
  assert.equal(args[0], '-c', 'the session flags are root overrides, ahead of the subcommand');
  assert.equal(samePath('C:/A/b', 'C:/A/b/'), true);
});

// ---------------------------------------------------------------------------
// The read at start
// ---------------------------------------------------------------------------

async function read(options: Partial<FakeCodexOptions> = {}, extra: Partial<ReadCodexRuntimeOptions> = {}) {
  const root = home();
  const fake = fakeCodex({ codexHome: root.path, ...options });
  try {
    return await readCodexRuntime({
      binary: 'C:/tools/codex.exe',
      home: root.path,
      env: { PATH: 'p' },
      clientVersion: '1.7.0',
      runVersion: answering('codex-cli 0.162.1\n'),
      spawn: fake.spawn,
      killTree: () => {
        fake.child.exit(null, 'SIGKILL');
        return Promise.resolve();
      },
      closeGraceMs: 10,
      ...extra,
    });
  } finally {
    root.done();
  }
}

test('a signed-in home on the pinned binary is available with its listed models, hidden ones left out', async () => {
  const found = await read();
  assert.equal(found.detail, null);
  assert.equal(found.entry.available, true);
  assert.equal(found.entry.version, '0.162.1');
  assert.deepEqual(
    found.entry.models.map((model) => model.value),
    ['gpt-6-sol', 'gpt-6-luna'],
  );
  assert.deepEqual(found.entry.models[0]?.supportedEffortLevels, ['low', 'medium', 'high']);
});

test('a home with no sign-in is unavailable, naming the sign-in step', async () => {
  const found = await read({ account: null, requiresOpenaiAuth: true });
  assert.equal(found.entry.available, false);
  assert.match(
    found.entry.unavailableReason ?? '',
    /has no sign-in: run codex login with CODEX_HOME set to it/,
  );
});

test('a provider that needs no sign-in is available with no account', async () => {
  const found = await read({ account: null, requiresOpenaiAuth: false });
  assert.equal(found.entry.available, true);
});

test('a server that answers from another home, or on another version, is unavailable by name', async () => {
  const elsewhere = await read({ codexHome: 'C:/Users/someone/.codex' });
  assert.match(elsewhere.entry.unavailableReason ?? '', /runs from home C:\/Users\/someone\/\.codex/);
  const newer = await read({ version: '0.163.0' });
  assert.match(newer.entry.unavailableReason ?? '', /the Codex app-server is Codex 0\.163\.0/);
});

test('an off-version binary is unavailable before any server is started', async () => {
  const found = await read({}, { runVersion: answering('codex-cli 0.161.0\n') });
  assert.equal(found.entry.available, false);
  assert.match(
    found.entry.unavailableReason ?? '',
    /is Codex 0\.161\.0; this host is pinned to Codex 0\.162\.1/,
  );
});

test('a catalog that cannot be read leaves the runtime available with no models, the reason named once', async () => {
  const found = await read({ fail: { 'model/list': { code: -32600, message: 'catalog provider refused' } } });
  assert.equal(found.entry.available, true);
  assert.deepEqual(found.entry.models, []);
  assert.equal(found.entry.vocabularies.thinking, false);
  assert.match(found.detail ?? '', /the Codex model catalog could not be read: .*catalog provider refused/);
});

test('a read that never finishes is unavailable within its bound', async () => {
  const found = await read({ silent: ['initialize'] }, { timeoutMs: 50 });
  assert.equal(found.entry.available, false);
  assert.match(found.entry.unavailableReason ?? '', /did not answer its start-up read within 50 ms/);
});

test('the npm launcher, run by this Node, answers --version and serves the read: a real child, end to end', async () => {
  const root = home();
  try {
    const found = await readCodexRuntime({
      binary: FAKE_SERVER,
      home: root.path,
      env: {
        PATH: process.env['PATH'] ?? '',
        SystemRoot: process.env['SystemRoot'] ?? '',
        PERISCOPE_FAKE_CODEX: JSON.stringify({}),
      },
      clientVersion: '1.7.0',
      closeGraceMs: 2000,
    });
    assert.equal(found.detail, null, found.detail ?? '');
    assert.equal(found.entry.available, true);
    assert.equal(found.entry.version, '0.162.1');
    assert.equal(found.entry.models.length, 2);
  } finally {
    root.done();
  }
});
