/**
 * This host's pi extension, driven alone: its configuration, how it registers the session's servers,
 * and every way one of its exchanges with the host can end. A call it lets run is one the host allowed,
 * verified by the session's token; every other end is a block with a reason. Its own shape is pinned
 * here too: it loads nothing of this package but itself, its type declarations and the channel's
 * exchange, and nothing but pi and this host's tests loads it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hookAnswerLine } from '../gate/hook-exchange.js';
import type { HookDecision } from '../gate/hook-exchange.js';
import { closureFrom, importsOf } from '../pins/walk.js';
import { openHookChannel } from './hook-channel.js';
import type {
  PiExtensionApi,
  PiExtensionContext,
  PiMcpHttpServer,
  PiMcpStdioServer,
  PiToolCallEvent,
  PiToolCallResult,
} from './pi-extension-api.js';
import type { PiExtensionConfig, PiHello } from './pi-extension.js';
import {
  PI_ABORTED_REASON,
  PI_EXTENSION_COMMAND,
  PI_EXTENSION_CONFIG_VARIABLE,
  PI_USER_BASH_REFUSAL,
  activatePiExtension,
  escapePiConfigValue,
  piExtensionConfigProblem,
  MAX_PI_HELLO_ENTRIES,
  piHelloOf,
} from './pi-extension.js';

type Handler = (event: never, ctx: PiExtensionContext) => unknown;

/** A fake extension API that records what the extension registers. */
function fakeApi(lists: { tools?: () => never[]; commands?: () => never[] } = {}) {
  const handlers = new Map<string, Handler>();
  const commands: string[] = [];
  const servers: { name: string; config: PiMcpHttpServer | PiMcpStdioServer }[] = [];
  const api: PiExtensionApi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => undefined;
    },
    registerCommand: (name) => commands.push(name),
    registerMcpServer: (name, config) => servers.push({ name, config }),
    getAllTools:
      lists.tools ??
      (() => [{ name: 'read', sourceInfo: { path: 'builtin:read', source: 'builtin' } }] as never[]),
    getCommands: lists.commands ?? (() => []),
    getMcpServers: () =>
      servers.map((server) => ({ name: server.name, extensionPath: '/x/pi-extension.js' })),
  };
  return {
    api,
    handlers,
    commands,
    servers,
    async toolCall(event: PiToolCallEvent, signal?: AbortSignal): Promise<PiToolCallResult | undefined> {
      const handler = handlers.get('tool_call');
      assert.ok(handler !== undefined, 'no tool_call handler was registered');
      return (await handler(event as never, { cwd: '/w', signal })) as PiToolCallResult | undefined;
    },
  };
}

/** A configuration file in a fresh directory, and the environment naming it. */
function configured(config: Partial<PiExtensionConfig> & Pick<PiExtensionConfig, 'channel' | 'token'>) {
  const dir = mkdtempSync(join(tmpdir(), 'periscope-pi-extension-'));
  const file = join(dir, 'extension.json');
  writeFileSync(file, JSON.stringify({ v: 1, runtime: 'pi', deadlineMs: 2_000, servers: [], ...config }));
  return {
    env: { [PI_EXTENSION_CONFIG_VARIABLE]: file, PATH: 'p' } as Record<string, string | undefined>,
    dir,
  };
}

/** A local listener on a fresh pipe or socket that answers each connection as `answer` says. */
async function rawChannel(
  answer: (line: string, socket: Socket) => void,
): Promise<{ address: string; server: Server; close: () => void }> {
  let address: string;
  let dir: string | null = null;
  if (process.platform === 'win32') address = `\\\\.\\pipe\\periscope-test-${randomBytes(8).toString('hex')}`;
  else {
    dir = mkdtempSync(join(tmpdir(), 'periscope-raw-'));
    address = join(dir, 's');
  }
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline >= 0) answer(buffer.slice(0, newline), socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(address, resolve));
  return {
    address,
    server,
    close: () => {
      server.close();
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
    },
  };
}

const call = (input: Record<string, unknown> = { command: 'git status' }): PiToolCallEvent => ({
  type: 'tool_call',
  toolName: 'bash',
  toolCallId: 'call_1',
  input,
});

test('the configuration is read from the file its variable names, and the variable is taken out of the environment', () => {
  const { env, dir } = configured({ channel: 'somewhere', token: 'token' });
  try {
    const fake = fakeApi();
    activatePiExtension(fake.api, env);
    assert.equal(
      env[PI_EXTENSION_CONFIG_VARIABLE],
      undefined,
      'the path is still in the environment pi shells inherit',
    );
    assert.equal(env['PATH'], 'p');
    assert.deepEqual(fake.commands, [PI_EXTENSION_COMMAND]);
    assert.deepEqual([...fake.handlers.keys()].sort(), ['session_start', 'tool_call', 'user_bash']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('control: a configuration that is missing, unreadable or unusable throws at load, so pi ends rather than run ungated', () => {
  assert.throws(() => activatePiExtension(fakeApi().api, {}), /is not set/);
  assert.throws(
    () =>
      activatePiExtension(fakeApi().api, {
        [PI_EXTENSION_CONFIG_VARIABLE]: join(tmpdir(), 'no-such-config.json'),
      }),
    /could not be read/,
  );
  const { env, dir } = configured({ channel: '', token: 'token' });
  try {
    assert.throws(() => activatePiExtension(fakeApi().api, env), /names no channel/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(
    piExtensionConfigProblem({ v: 1, runtime: 'pi', channel: 'c', token: 't', deadlineMs: 0, servers: [] }) ??
      '',
    /no deadline/,
  );
  assert.match(
    piExtensionConfigProblem({
      v: 1,
      runtime: 'pi',
      channel: 'c',
      token: 't',
      deadlineMs: 5,
      servers: [{ name: 'a b', type: 'http', url: 'u' }],
    }) ?? '',
    /no usable name/,
  );
  assert.equal(
    piExtensionConfigProblem({ v: 1, runtime: 'pi', channel: 'c', token: 't', deadlineMs: 5, servers: [] }),
    null,
  );
});

/** pi's own reading of a config value: `!` runs a command, `$NAME` expands, `$$` and `$!` are literals. */
function piReads(
  value: string,
  env: Record<string, string>,
): { readonly command: string } | { readonly text: string } {
  if (value.startsWith('!')) return { command: value.slice(1) };
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (character === '$' && (next === '$' || next === '!')) {
      out += next;
      index += 1;
    } else if (character === '$') {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(index + 1))?.[0] ?? '';
      out += env[name] ?? '';
      index += name.length;
    } else out += character;
  }
  return { text: out };
}

test('every value is written so pi reads it as written: a leading ! is no command and a $ expands nothing', () => {
  const env = { HOME: '/home/x' };
  for (const value of ['j1.abc.def', '$HOME', '!rm -rf /', '!a$b', 'a$$b', '$!']) {
    assert.deepEqual(piReads(escapePiConfigValue(value), env), { text: value }, value);
  }
  // The control: written as given, pi would run the first and expand the second.
  assert.deepEqual(piReads('!rm -rf /', env), { command: 'rm -rf /' });
  assert.deepEqual(piReads('$HOME', env), { text: '/home/x' });
});

test("the session's servers are registered with their tools declared to the model by name, every header and variable escaped", () => {
  const { env, dir } = configured({
    channel: 'c',
    token: 't',
    servers: [
      { name: 'nas', type: 'http', url: 'https://plane/mcp', headers: { 'X-Job-Ticket': '!t$k' } },
      { name: 'local', type: 'stdio', command: 'node', args: ['s.js'], env: { K: '$V' } },
    ],
  });
  try {
    const fake = fakeApi();
    activatePiExtension(fake.api, env);
    assert.deepEqual(fake.servers, [
      {
        name: 'nas',
        config: {
          type: 'http',
          url: 'https://plane/mcp',
          headers: { 'X-Job-Ticket': '$!t$$k' },
          exposure: 'direct',
        },
      },
      {
        name: 'local',
        config: { type: 'stdio', command: 'node', args: ['s.js'], env: { K: '$$V' }, exposure: 'direct' },
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a call the host allows runs; one it denies is blocked with the host's reason; and an allow that rewrites puts the rewrite in the very object pi runs", async () => {
  const answers: HookDecision[] = [
    { allow: true },
    { allow: false, reason: 'the operator said no' },
    { allow: true, updatedInput: { command: 'git status --short' } },
  ];
  const channel = openHookChannel({
    runtime: 'pi',
    version: 't',
    decide: () => Promise.resolve(answers.shift() ?? { allow: false, reason: 'none left' }),
  });
  await channel.ready();
  const { env, dir } = configured({ channel: channel.address, token: channel.token });
  try {
    const fake = fakeApi();
    activatePiExtension(fake.api, env);
    assert.equal(await fake.toolCall(call()), undefined);
    assert.deepEqual(await fake.toolCall(call()), { block: true, reason: 'the operator said no' });
    const input: Record<string, unknown> = { command: 'git status', timeout: 5 };
    assert.equal(await fake.toolCall(call(input)), undefined);
    assert.deepEqual(input, { command: 'git status --short' }, 'the rewrite was not put in place, whole');
  } finally {
    channel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('control: an answer that does not verify, an answer that is no decision, and a rewrite that is no object each block', async () => {
  const bodies = [
    (nonce: string) =>
      `${JSON.stringify({ v: 1, body: JSON.stringify({ allow: true }), mac: '00'.repeat(32) })}\n${nonce.slice(0, 0)}`,
    (nonce: string) => hookAnswerLine('the-token', nonce, { ok: true, version: 'x' }),
    (nonce: string) => hookAnswerLine('the-token', nonce, { allow: true, updatedInput: 'rm -rf /' as never }),
  ];
  for (const [index, body] of bodies.entries()) {
    const raw = await rawChannel((line, socket) => {
      const nonce = (JSON.parse(line) as { nonce: string }).nonce;
      socket.end(body(nonce));
    });
    const { env, dir } = configured({ channel: raw.address, token: 'the-token' });
    try {
      const fake = fakeApi();
      activatePiExtension(fake.api, env);
      const result = await fake.toolCall(call());
      assert.equal(result?.block, true, `answer ${index} let the call run`);
      assert.ok((result?.reason ?? '') !== '', 'a block with no reason');
    } finally {
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("the extension's own deadline blocks a call the host never answers, and a channel it cannot reach blocks too", async () => {
  const silent = await rawChannel(() => undefined);
  const { env, dir } = configured({ channel: silent.address, token: 't', deadlineMs: 100 });
  try {
    const fake = fakeApi();
    activatePiExtension(fake.api, env);
    const result = await fake.toolCall(call());
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? '', /^hook_timed_out: no decision from the host within 100ms/);
  } finally {
    silent.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const gone = configured({ channel: join(tmpdir(), 'no-such-channel'), token: 't' });
  try {
    const fake = fakeApi();
    activatePiExtension(fake.api, gone.env);
    const result = await fake.toolCall(call());
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? '', /channel failed|could not be opened/);
  } finally {
    rmSync(gone.dir, { recursive: true, force: true });
  }
});

test("the run's abort blocks a call at once: one already aborted asks nothing, and one being decided is let go and its connection closed", async () => {
  let closedByExtension = false;
  const waiting = await rawChannel((_line, socket) => {
    socket.on('close', () => {
      closedByExtension = true;
    });
  });
  const { env, dir } = configured({ channel: waiting.address, token: 't', deadlineMs: 30_000 });
  try {
    const fake = fakeApi();
    activatePiExtension(fake.api, env);
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await fake.toolCall(call(), aborted.signal), { block: true, reason: PI_ABORTED_REASON });
    const running = new AbortController();
    const pending = fake.toolCall(call(), running.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const began = Date.now();
    running.abort();
    assert.deepEqual(await pending, { block: true, reason: PI_ABORTED_REASON });
    assert.ok(Date.now() - began < 1_000, 'the abort waited');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closedByExtension, true, "the host's decision was left outstanding");
  } finally {
    waiting.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shell command sent beside the tool calls is refused: the handler throws, which is the only way pi has to stop one', () => {
  const { env, dir } = configured({ channel: 'c', token: 't' });
  try {
    const fake = fakeApi();
    activatePiExtension(fake.api, env);
    const handler = fake.handlers.get('user_bash');
    assert.ok(handler !== undefined);
    assert.throws(
      () =>
        handler({ type: 'user_bash', command: 'echo x', cwd: '/w' } as never, {
          cwd: '/w',
          signal: undefined,
        }),
      {
        message: PI_USER_BASH_REFUSAL,
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hello says what the extension can see loaded, and a list pi will not give is null, never empty', async () => {
  const said: unknown[] = [];
  const channel = openHookChannel({
    runtime: 'pi',
    version: 't',
    decide: () => Promise.resolve({ allow: true }),
    onHello: (event) => said.push(event),
  });
  await channel.ready();
  const { env, dir } = configured({ channel: channel.address, token: channel.token });
  try {
    const fake = fakeApi();
    activatePiExtension(fake.api, env);
    await (fake.handlers.get('session_start') as (event: never) => Promise<void>)({
      type: 'session_start',
      reason: 'startup',
    } as never);
    assert.deepEqual(said, [
      {
        reason: 'startup',
        tools: [{ name: 'read', source: 'builtin', path: 'builtin:read' }],
        commands: [],
        servers: [],
        truncated: false,
      },
    ]);
  } finally {
    channel.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const hello: PiHello = piHelloOf(
    fakeApi({
      tools: () => {
        throw new Error('not available during loading');
      },
    }).api,
    'startup',
  );
  assert.equal(hello.tools, null);
  assert.deepEqual(hello.commands, []);
  const crowded = piHelloOf(
    {
      ...fakeApi().api,
      getMcpServers: () =>
        Array.from({ length: MAX_PI_HELLO_ENTRIES + 1 }, (_one, index) => ({
          name: `server${String(index)}`,
          extensionPath: '/x/pi-extension.js',
        })),
    },
    'startup',
  );
  assert.equal(crowded.servers?.length, MAX_PI_HELLO_ENTRIES);
  assert.equal(crowded.truncated, true, 'a server list cut at the bound was not said to be cut');
});

test('the extension loads nothing of this package but itself, its type declarations and the exchange; built, it imports only Node and the exchange', () => {
  assert.deepEqual([...closureFrom('host/pi-extension.ts')].sort(), [
    'gate/hook-exchange.ts',
    'host/pi-extension-api.ts',
    'host/pi-extension.ts',
  ]);
  const built = readFileSync(fileURLToPath(new URL('./pi-extension.js', import.meta.url)), 'utf8');
  assert.deepEqual(importsOf(built).sort(), [
    '../gate/hook-exchange.js',
    'node:crypto',
    'node:fs',
    'node:net',
  ]);
  assert.match(built, /export default function/, 'pi loads the default export, and there is none');
});

test("no entry point of the package exports the extension: none of its names is the package's API", () => {
  const source = fileURLToPath(new URL('../../src/', import.meta.url));
  const barrels = readdirSync(source).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  assert.ok(barrels.includes('index.ts'), 'the entry points were not found; this pin reads nothing');
  for (const barrel of barrels) {
    assert.doesNotMatch(
      readFileSync(join(source, barrel), 'utf8'),
      /pi-extension/,
      `${barrel} exports the extension`,
    );
  }
  const api = readFileSync(fileURLToPath(new URL('../../contracts/public-api.txt', import.meta.url)), 'utf8');
  for (const name of [
    'activatePiExtension',
    'periscopePiExtension',
    'PiExtensionApi',
    'escapePiConfigValue',
  ]) {
    assert.ok(!api.includes(name), `${name} is in the public API`);
  }
});
