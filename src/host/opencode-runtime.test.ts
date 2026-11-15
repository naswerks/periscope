import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';

import { ok, refuse } from '../core/result.js';
import { tempDir } from '../test-support/temp-dir.js';
import {
  opencodeEndpointEnv,
  opencodeEndpointRoutes,
  opencodeProvider,
  opencodeProviderId,
} from './opencode-endpoints.js';
import type { ModelEndpoint } from './model-endpoints.js';
import { opencodeMcpServers } from './opencode-mcp.js';
import { opencodeSkillDirectories } from './opencode-pack.js';
import { OPENCODE_MESSAGE_BINDING, readOpencodeRuntime } from './opencode-runtime.js';
import {
  OPENCODE_RELEASE_PACKAGES,
  OPENCODE_SDK_PINNED_VERSION,
  loadOpencodeSdk,
  nodeCanRunOpencode,
  readOpencodeInstall,
} from './opencode-sdk.js';
import type { OpencodeMessage } from './opencode-wire.js';

/** An install laid out as npm lays it out: the SDK, and its release's packages beside it or under it. */
function layInstall(
  directory: string,
  versions: Readonly<Record<string, string | null>> = {},
  nested: readonly string[] = [],
): void {
  for (const name of OPENCODE_RELEASE_PACKAGES) {
    const version = Object.hasOwn(versions, name) ? versions[name] : OPENCODE_SDK_PINNED_VERSION;
    if (version === null || version === undefined) continue;
    const place = nested.includes(name)
      ? join(directory, 'node_modules', '@opencode', 'sdk', 'node_modules', ...name.split('/'))
      : join(directory, 'node_modules', ...name.split('/'));
    mkdirSync(place, { recursive: true });
    writeFileSync(join(place, 'package.json'), JSON.stringify({ name, version }));
  }
  const dist = join(directory, 'node_modules', '@opencode', 'sdk', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.js'), 'export const OpenCode = {};\n');
}

test("an install at the pin is read, its release's packages where the SDK resolves them: its own folder first, else beside it", async () => {
  const dir = await tempDir('opencode-install');
  try {
    layInstall(dir, {}, ['@opencode/core']);
    const read = readOpencodeInstall(dir);
    assert.ok(read.ok, read.ok ? '' : read.refusal.detail);
    assert.equal(read.value.sdkVersion, OPENCODE_SDK_PINNED_VERSION);
    assert.equal(read.value.entry, join(dir, 'node_modules', '@opencode', 'sdk', 'dist', 'index.js'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an install off the pin, incomplete or absent is refused runtime-unavailable, saying what it found and what is pinned', async () => {
  const cases: [Readonly<Record<string, string | null>>, RegExp][] = [
    [
      { '@opencode/sdk': '2.2.5' },
      /holds @opencode\/sdk 2\.2\.5; this host is pinned to @opencode\/sdk 2\.3\.0/,
    ],
    [{ '@opencode/server': '2.2.5' }, /holds @opencode\/server 2\.2\.5/],
    [{ '@opencode/client': null }, /no @opencode\/client is installed/],
  ];
  for (const [versions, pattern] of cases) {
    const dir = await tempDir('opencode-install-off');
    try {
      layInstall(dir, versions);
      const read = readOpencodeInstall(dir);
      assert.ok(!read.ok);
      assert.equal(read.refusal.reason, 'runtime-unavailable');
      assert.match(read.refusal.detail, pattern);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const relative = readOpencodeInstall('relative/dir');
  assert.ok(!relative.ok);
  assert.match(relative.refusal.detail, /not an absolute path/);
  const empty = await tempDir('opencode-install-empty');
  try {
    const read = readOpencodeInstall(empty);
    assert.ok(!read.ok);
    assert.match(read.refusal.detail, /no @opencode\/sdk is installed/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('whether this Node can load the SDK is a test of the syntax its tree uses, never of a version string', () => {
  const refused = nodeCanRunOpencode(() => {
    throw new SyntaxError('Unexpected identifier');
  });
  assert.match(
    refused ?? '',
    new RegExp(`this host runs Node ${process.versions.node.replaceAll('.', '\\.')}`),
  );
  assert.match(refused ?? '', /cannot parse explicit resource management \(`await using`\)/);
  assert.match(refused ?? '', /opencode needs Node 24 or later/);
  let compiled = '';
  assert.equal(
    nodeCanRunOpencode((source) => {
      compiled = source;
    }),
    null,
  );
  assert.match(compiled, /await using/);
  // This Node's own answer agrees with whether it compiles the syntax.
  let parses: boolean;
  try {
    new Script('(async () => { await using held = null; return held; });');
    parses = true;
  } catch {
    parses = false;
  }
  assert.equal(nodeCanRunOpencode() === null, parses);
});

test('an SDK that does not load, or lacks what this host calls, is refused by name', async () => {
  const dir = await tempDir('opencode-load');
  try {
    const entry = join(dir, 'index.js');
    writeFileSync(entry, 'export const Nothing = 1;\n');
    const lacking = await loadOpencodeSdk({ directory: dir, entry, sdkVersion: OPENCODE_SDK_PINNED_VERSION });
    assert.ok(!lacking.ok);
    assert.match(lacking.refusal.detail, /exports no OpenCode\.create/);
    const missing = await loadOpencodeSdk({
      directory: dir,
      entry: join(dir, 'absent.js'),
      sdkVersion: '2.3.0',
    });
    assert.ok(!missing.ok);
    assert.match(missing.refusal.detail, /could not be loaded/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the read at start lists opencode available at its tier with its vocabularies, or unavailable with why, and starts nothing', async () => {
  const base = await tempDir('opencode-runtime');
  try {
    const available = await readOpencodeRuntime({
      sdk: 'C:/sdk',
      base,
      readInstall: () => ok({ directory: 'C:/sdk', entry: 'C:/sdk/index.js', sdkVersion: '2.3.0' }),
      nodeProblem: () => null,
    });
    assert.equal(available.detail, null);
    assert.equal(available.entry.available, true);
    assert.equal(available.entry.runtime, 'opencode');
    assert.equal(available.entry.version, OPENCODE_SDK_PINNED_VERSION);
    assert.deepEqual(available.entry.vocabularies, {
      permissionModes: ['default', 'plan'],
      efforts: [],
      thinking: false,
    });
    assert.deepEqual(available.entry.controlTier, { level: 'intercepted-with-residual', degrades: [] });
    const node = await readOpencodeRuntime({
      sdk: 'C:/sdk',
      base,
      readInstall: () => ok({ directory: 'C:/sdk', entry: 'C:/sdk/index.js', sdkVersion: '2.3.0' }),
      nodeProblem: () => 'this host runs Node 22.0.0; opencode needs Node 24 or later',
    });
    assert.equal(node.entry.available, false);
    assert.match(node.entry.unavailableReason ?? '', /Node 22\.0\.0; opencode needs Node 24 or later/);
    const install = await readOpencodeRuntime({
      sdk: 'C:/sdk',
      base,
      readInstall: () => refuse('runtime-unavailable', 'no @opencode/sdk is installed under C:/sdk'),
      nodeProblem: () => null,
    });
    assert.equal(install.entry.available, false);
    assert.match(install.detail ?? '', /no @opencode\/sdk is installed/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a session's events ride as the server sent them, a delta on the delta lane; the open rides nowhere", () => {
  const message = (type: string): OpencodeMessage => ({
    kind: 'event',
    event: { id: 'evt_1', type, data: { sessionID: 's' } },
    session: 's',
    main: true,
    spawnedBy: null,
  });
  assert.deepEqual(OPENCODE_MESSAGE_BINDING.route(message('session.text.delta')), {
    lane: 'delta',
    body: { id: 'evt_1', type: 'session.text.delta', data: { sessionID: 's' } },
  });
  assert.equal(OPENCODE_MESSAGE_BINDING.route(message('session.tool.called'))?.lane, 'update');
  assert.equal(
    OPENCODE_MESSAGE_BINDING.route({
      kind: 'opened',
      sessionId: 's',
      model: null,
      agent: 'build',
      origin: 'new',
    }),
    null,
  );
  assert.equal(OPENCODE_MESSAGE_BINDING.sourceIdOf(message('session.tool.called'), {} as never), 'evt_1');
});

test('MCP servers take their opencode forms: a streamable HTTP server is remote with no OAuth, a stdio one local; every tool offered directly', () => {
  const read = opencodeMcpServers({
    docs: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { authorization: 'Bearer t' } },
    probe_srv: { command: 'node', args: ['server.js'], env: { A: '1' } },
  });
  assert.ok(read.ok);
  assert.deepEqual(read.value, {
    docs: {
      type: 'remote',
      url: 'http://127.0.0.1:9/mcp',
      headers: { authorization: 'Bearer t' },
      oauth: false,
      codemode: false,
    },
    probe_srv: { type: 'local', command: ['node', 'server.js'], environment: { A: '1' }, codemode: false },
  });
  assert.deepEqual(opencodeMcpServers(null), ok({}));
});

test('what has no opencode form, or names a server opencode could not tell apart, is refused by name: mcp-descriptor-invalid', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ 'has space': { command: 'x' } }, /"has space" has a name opencode would rewrite/],
    [
      { probe: { command: 'x' }, probe_srv: { command: 'y' } },
      /"probe" and "probe_srv" could not be told apart/,
    ],
    [{ old: { type: 'sse', url: 'http://x' } }, /is an SSE server/],
    [{ inproc: { type: 'sdk', name: 'x' } }, /is a sdk server, which has no form opencode can start/],
    [{ extra: { command: 'x', cwd: '/tmp' } }, /sets cwd, which opencode has no setting for/],
    [{ nourl: { type: 'http' } }, /has no url/],
    [{ badargs: { command: 'x', args: [1] } }, /args that are not a list of strings/],
  ];
  for (const [servers, pattern] of cases) {
    const read = opencodeMcpServers(servers as never);
    assert.ok(!read.ok, JSON.stringify(servers));
    assert.equal(read.refusal.reason, 'mcp-descriptor-invalid');
    assert.match(read.refusal.detail, pattern);
  }
  // Control: an underscore that begins no other server's name is fine.
  assert.ok(opencodeMcpServers({ probe_srv: { command: 'x' }, other: { command: 'y' } }).ok);
});

test("an endpoint is offered to opencode only where the operator named it, as a provider of the session's own; its key is read at the open and rides no environment", () => {
  let reads = 0;
  const endpoint = (name: string, runtimes: readonly string[]): ModelEndpoint =>
    ({
      name,
      wireApi: 'openai-chat',
      baseUrl: 'https://example.invalid/v1',
      models: ['m1', 'm2'],
      runtimes,
      authToken: () => {
        reads += 1;
        return 'sk-key';
      },
    }) as unknown as ModelEndpoint;
  const routes = opencodeEndpointRoutes([endpoint('a', ['opencode']), endpoint('b', ['copilot'])]);
  assert.deepEqual(
    routes.map((route) => route.name),
    ['a'],
  );
  assert.equal(reads, 0, 'no key is read before a session opens');
  const route = routes[0];
  assert.ok(route !== undefined);
  assert.equal(opencodeProviderId(route), 'endpoint-a');
  const provider = opencodeProvider(route);
  assert.equal(reads, 1);
  assert.deepEqual(provider.settings, { baseURL: 'https://example.invalid/v1', apiKey: 'sk-key' });
  assert.deepEqual(Object.keys(provider.models), ['m1', 'm2']);
  assert.deepEqual(opencodeEndpointEnv(), {});
  const keyless = opencodeProvider({ ...route, authToken: () => '' });
  assert.equal('apiKey' in keyless.settings, false);
});

test('a plugin directory is handed over by its skills folder; one with none, or one this host cannot use, is reported by path', async () => {
  const dir = await tempDir('opencode-pack');
  try {
    const withSkills = join(dir, 'with');
    mkdirSync(join(withSkills, 'skills', 'review'), { recursive: true });
    writeFileSync(
      join(withSkills, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: d\n---\n',
    );
    const without = join(dir, 'without');
    for (const plugin of [withSkills, without]) {
      mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(plugin, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'p', version: '1.0.0' }),
      );
    }
    const read = opencodeSkillDirectories([withSkills, without, withSkills, join(dir, 'absent')]);
    assert.deepEqual(read.directories, [join(withSkills, 'skills')]);
    assert.deepEqual(
      read.problems.map((problem) => problem.path),
      [without, join(dir, 'absent')],
    );
    assert.match(read.problems[0]?.message ?? '', /no skills directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
