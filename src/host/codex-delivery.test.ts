/**
 * What a Codex session is handed, and how: its plugin directories as skill roots, its MCP servers in
 * the thread's own config, and a named model endpoint as a provider of the session's own, its key kept
 * from the agent's shell.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HostConfiguration, JsonObject, SessionFrame, SessionPayload } from '../control/frames.js';
import {
  readAgentFacts,
  readAgentItem,
  readStateTransition,
  sessionNew,
  sessionNewRequest,
} from '../control/frames.js';
import type { LinkHandlers } from '../control/link.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import { FAKE_MODELS, fakeCodex } from '../test-support/fake-codex.js';
import type { FakeCodex, FakeCodexOptions } from '../test-support/fake-codex.js';
import type { AgentProcess, AgentProcessRequest } from './agent-process.js';
import type { CodexEndpointRoute } from './codex-endpoints.js';
import {
  CODEX_ENDPOINT_KEY_VARIABLE,
  codexEndpointEnv,
  codexEndpointRoutes,
  codexProviderConfig,
  codexProviderKey,
} from './codex-endpoints.js';
import { CodexFactLift } from './codex-facts.js';
import { codexSessionFlags } from './codex-home.js';
import { codexMcpConfig } from './codex-mcp.js';
import { UNDELIVERED_PLUGIN, codexSkillRoots } from './codex-pack.js';
import { CODEX_HOME_VARIABLE, startCodexProcess } from './codex-process.js';
import { availableCodexEntry, codexHostModel } from './codex-runtime.js';
import type { CodexMessage } from './codex-wire.js';
import type { HostLink } from './host.js';
import { PeriscopeHost } from './host.js';
import type { ModelEndpoint } from './model-endpoints.js';
import { readSessionRequest } from './wire-request.js';

const HOME = 'C:/runner/codex-home';
const BINARY = 'C:/tools/codex/codex.exe';
const CWD = 'C:/work/session-1';
const TICKET = 'ticket-0123456789';
const KEY = 'endpoint-key-0123456789';

function request(overrides: Partial<AgentProcessRequest> = {}): AgentProcessRequest {
  return {
    cwd: CWD,
    env: { PATH: 'p' },
    settingSources: [],
    plugins: null,
    hooks: null,
    resume: null,
    fork: false,
    includePartialMessages: true,
    thinking: null,
    forwardSubagentText: false,
    onStderr: null,
    mcpServers: null,
    strictMcpConfig: true,
    sessionStore: null,
    sessionStoreFlush: null,
    spawn: null,
    model: null,
    systemPrompt: null,
    effort: null,
    permissionMode: null,
    ...overrides,
  };
}

interface Started {
  readonly process: AgentProcess<CodexMessage>;
  readonly fake: FakeCodex;
  readonly messages: CodexMessage[];
  readonly ended: Promise<Error | null>;
}

function started(
  overrides: Partial<AgentProcessRequest> = {},
  options: {
    readonly fake?: Partial<FakeCodexOptions>;
    readonly endpoint?: string;
    readonly routes?: CodexEndpointRoute[];
  } = {},
): Started {
  const fake = fakeCodex({ codexHome: HOME, ...options.fake });
  const process = startCodexProcess(
    request(overrides),
    {
      binary: BINARY,
      home: HOME,
      clientVersion: '1.7.0',
      spawn: fake.spawn,
      killTree: () => Promise.resolve(),
      closeGraceMs: 20,
      ...(options.routes === undefined ? {} : { endpoints: options.routes }),
    },
    () => undefined,
    options.endpoint ?? null,
  );
  const messages: CodexMessage[] = [];
  const ended = (async (): Promise<Error | null> => {
    try {
      for await (const message of process.messages) messages.push(message);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();
  return { process, fake, messages, ended };
}

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const opened = (session: Started): Promise<void> =>
  until(
    () =>
      session.messages.some(
        (message) => message.kind === 'notification' && message.method === 'thread/started',
      ),
    'the thread to open',
  );

const threadStart = (session: Started): JsonObject =>
  (session.fake.server.requestsOf('thread/start')[0]?.['params'] ?? {}) as JsonObject;

/** A plugin root on disk: its manifest names `name`, and each skill has a SKILL.md under skills/. */
function pluginRoot(name: string, skills: readonly string[]): { readonly path: string; done(): void } {
  const path = mkdtempSync(join(tmpdir(), 'codex-pack-'));
  mkdirSync(join(path, '.claude-plugin'));
  writeFileSync(join(path, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  for (const skill of skills) {
    mkdirSync(join(path, 'skills', skill), { recursive: true });
    writeFileSync(join(path, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
  }
  return { path, done: () => rmSync(path, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// The plugin directories
// ---------------------------------------------------------------------------

test("the plugin directories reach Codex as skill roots before the thread opens, each root the manifest's own directory", async () => {
  const pack = pluginRoot('sample', ['summarize', 'outline']);
  try {
    const session = started({ plugins: [{ type: 'local', path: pack.path }] });
    await opened(session);
    const methods = session.fake.server.methods();
    assert.ok(
      methods.indexOf('skills/extraRoots/set') < methods.indexOf('thread/start'),
      'the roots are set before the thread opens',
    );
    assert.deepEqual(
      session.fake.server.extraRoots,
      [pack.path],
      'the root is the plugin root, never its skills/',
    );
    const lift = new CodexFactLift();
    const receipts = session.messages.flatMap((message) =>
      lift.fromMessage(message).facts.flatMap((fact) => (fact.kind === 'agent_receipt' ? [fact] : [])),
    );
    assert.deepEqual(
      [...(receipts.at(-1)?.skills ?? [])].sort(),
      ['sample:outline', 'sample:summarize'],
      "the receipt's skills are named under the plugin, as Codex lists them, never stripped",
    );
    assert.equal(await session.process.pluginsApplied(), true);
    session.process.close();
    await session.ended;
  } finally {
    pack.done();
  }
});

test('control: a session with no plugin directories hands Codex no skill roots at all', async () => {
  const session = started();
  await opened(session);
  assert.equal(session.fake.server.methods().includes('skills/extraRoots/set'), false);
  session.process.close();
  await session.ended;
});

test("a plugin directory that is not there is left out and reported among the receipt's plugin errors, never refused", async () => {
  const pack = pluginRoot('sample', ['summarize']);
  const missing = join(tmpdir(), 'no-such-plugin-root-for-a-test');
  try {
    const plugins = [
      { type: 'local' as const, path: pack.path },
      { type: 'local' as const, path: missing },
    ];
    const session = started({ plugins });
    await opened(session);
    assert.deepEqual(
      session.fake.server.extraRoots,
      [pack.path],
      'only the directory this host could use is handed over',
    );
    assert.equal(
      await session.process.pluginsApplied(),
      false,
      'a directory left out is a plugin not applied',
    );

    const { problems } = codexSkillRoots(plugins.map((plugin) => plugin.path));
    assert.deepEqual(
      problems.map((problem) => [problem.plugin, problem.type]),
      [[missing, UNDELIVERED_PLUGIN]],
    );
    const lift = new CodexFactLift({ undeliveredPlugins: problems });
    const receipts = session.messages.flatMap((message) =>
      lift.fromMessage(message).facts.flatMap((fact) => (fact.kind === 'agent_receipt' ? [fact] : [])),
    );
    assert.deepEqual(
      receipts.at(-1)?.pluginErrors?.map((error) => error.path),
      [missing],
    );
    session.process.close();
    await session.ended;
  } finally {
    pack.done();
  }
});

test('a Codex refusal of the skill roots ends the open before the thread, plugins-undeliverable by name', async () => {
  const pack = pluginRoot('sample', ['summarize']);
  try {
    const session = started(
      { plugins: [{ type: 'local', path: pack.path }] },
      {
        fake: {
          fail: {
            'skills/extraRoots/set': { code: -32600, message: 'Invalid request: a path without a base' },
          },
        },
      },
    );
    const error = await session.ended;
    assert.match(
      error?.message ?? '',
      /^plugins-undeliverable: Codex refused the session's plugin directories/,
    );
    assert.equal(
      session.fake.server.methods().includes('thread/start'),
      false,
      'no thread opened without its plugins',
    );
  } finally {
    pack.done();
  }
});

// ---------------------------------------------------------------------------
// The MCP servers
// ---------------------------------------------------------------------------

test("an HTTP server's ticket rides the thread's config as a static header, never the process's environment or command line", async () => {
  const session = started({
    mcpServers: {
      nas: { type: 'http', url: 'http://controller/agent-surface/mcp', headers: { 'X-Job-Ticket': TICKET } },
    },
  });
  await opened(session);
  const config = threadStart(session)['config'] as JsonObject;
  assert.deepEqual(config['mcp_servers.nas'], {
    default_tools_approval_mode: 'prompt',
    startup_timeout_sec: 20,
    url: 'http://controller/agent-surface/mcp',
    http_headers: { 'X-Job-Ticket': TICKET },
  });
  const spawned = session.fake.child.spawned;
  assert.ok(spawned !== undefined && spawned !== null);
  assert.equal(
    JSON.stringify(spawned.env).includes(TICKET),
    false,
    'the ticket is in the process environment',
  );
  assert.equal(spawned.args.join(' ').includes(TICKET), false, 'the ticket is on the command line');
  assert.equal(
    JSON.stringify(config).includes('env_http_headers'),
    false,
    'the ticket is read from the environment',
  );
  session.process.close();
  await session.ended;
});

test('control: a server Codex has no form for is refused by name, never dropped', () => {
  const refused = (servers: Record<string, unknown>): string => {
    const read = codexMcpConfig(servers as never);
    return read.ok ? 'taken' : `${read.refusal.reason}: ${read.refusal.detail}`;
  };
  assert.match(
    refused({ docs: { type: 'sse', url: 'http://x' } }),
    /^mcp-descriptor-invalid: .*"docs" is an SSE server/,
  );
  assert.match(
    refused({ 'docs.v2': { type: 'http', url: 'http://x' } }),
    /"docs.v2" has a name Codex would not read as one config key/,
  );
  assert.match(
    refused({ docs: { type: 'http', url: 'http://x', tools: [] } }),
    /"docs" sets tools, which Codex has no setting for/,
  );
  assert.match(refused({ docs: { type: 'sdk', name: 'docs', instance: {} } }), /"docs" is a sdk server/);
  const stdio = codexMcpConfig({
    local: { command: 'node', args: ['server.js'], env: { MODE: 'x' }, timeout: 5000 },
  });
  assert.deepEqual(stdio.ok ? stdio.value : null, {
    'mcp_servers.local': {
      default_tools_approval_mode: 'prompt',
      startup_timeout_sec: 20,
      tool_timeout_sec: 5,
      command: 'node',
      args: ['server.js'],
      env: { MODE: 'x' },
    },
  });
});

// ---------------------------------------------------------------------------
// The model endpoint
// ---------------------------------------------------------------------------

const ENDPOINT: ModelEndpoint = {
  name: 'deepseek.v3',
  wireApi: 'openai-responses',
  runtimes: ['codex'],
  baseUrl: 'https://api.example/v1',
  models: ['deepseek-v3'],
  modelAliases: {},
  contextWindow: { maxContextTokens: 128000 },
  env: { EXAMPLE_FLAG: '1' },
  firstParty: false,
  authToken: () => KEY,
};

test('the provider id is derived: two names alike once slugged derive distinct ids, each one Codex reads as one key', () => {
  const dotted = codexProviderKey('deepseek.v3');
  const dashed = codexProviderKey('deepseek-v3');
  assert.notEqual(dotted, dashed);
  for (const key of [dotted, dashed, codexProviderKey('openai'), codexProviderKey('Ollama')]) {
    assert.match(key, /^periscope-[a-z0-9-]+$/);
  }
  assert.notEqual(codexProviderKey('openai'), 'openai', 'a reserved id is never the provider id');
  assert.equal(codexProviderKey('deepseek.v3'), dotted, 'one name, one id, every time');
});

test('control: without its hash, the slug alone would give two names one provider', () => {
  const slug = (name: string): string => codexProviderKey(name).replace(/-[0-9a-f]{8}$/, '');
  assert.equal(slug('deepseek.v3'), slug('deepseek-v3'));
});

/** Codex's rule for an exclude entry: a glob of `*` and `?`, matched whole, without regard to case. */
function codexExcludes(pattern: string, name: string): boolean {
  const source = [...pattern]
    .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, 'i').test(name);
}

const remaining = (environment: Record<string, string>, excludes: readonly string[]): string[] =>
  Object.keys(environment).filter((name) => !excludes.some((pattern) => codexExcludes(pattern, name)));

test("the endpoint's key and its own variables are excluded from the agent's shell by exact name, and nothing else is", () => {
  const route = codexEndpointRoutes([ENDPOINT])[0];
  assert.ok(route !== undefined);
  const flags = codexSessionFlags('default', [CODEX_ENDPOINT_KEY_VARIABLE, ...route.envNames]);
  const excludes = flags['shell_environment_policy.exclude'] as string[];
  const environment = {
    PATH: 'p',
    OPENAI_API_KEY_ROTATION: 'x',
    [CODEX_ENDPOINT_KEY_VARIABLE]: KEY,
    EXAMPLE_FLAG: '1',
    EXAMPLE_FLAG_TWO: '2',
  };
  assert.deepEqual(remaining(environment, excludes), ['PATH', 'OPENAI_API_KEY_ROTATION', 'EXAMPLE_FLAG_TWO']);
});

test('control: an anchored pattern, read as Codex reads it, excludes nothing and the key reaches the shell', () => {
  const environment = { PATH: 'p', [CODEX_ENDPOINT_KEY_VARIABLE]: KEY };
  assert.deepEqual(remaining(environment, [`^${CODEX_ENDPOINT_KEY_VARIABLE}$`]), [
    'PATH',
    CODEX_ENDPOINT_KEY_VARIABLE,
  ]);
});

test("a session on a Codex endpoint opens on a provider of its own, its window stated, its key in the app-server's environment only", async () => {
  const routes = codexEndpointRoutes([ENDPOINT]);
  const session = started(
    { env: { PATH: 'p', ...codexEndpointEnv(ENDPOINT) }, resume: null },
    { endpoint: 'deepseek.v3', routes },
  );
  await opened(session);
  const params = threadStart(session);
  const key = codexProviderKey('deepseek.v3');
  assert.equal(params['modelProvider'], key);
  const config = params['config'] as JsonObject;
  assert.deepEqual(config[`model_providers.${key}`], {
    name: 'deepseek.v3',
    base_url: 'https://api.example/v1',
    wire_api: 'responses',
    env_key: CODEX_ENDPOINT_KEY_VARIABLE,
  });
  assert.equal(config['model_context_window'], 128000);
  assert.deepEqual(config['shell_environment_policy.exclude'], [
    CODEX_ENDPOINT_KEY_VARIABLE,
    'EXAMPLE_FLAG',
    CODEX_HOME_VARIABLE,
  ]);
  const spawned = session.fake.child.spawned;
  assert.equal(
    spawned?.env[CODEX_ENDPOINT_KEY_VARIABLE],
    KEY,
    'the app-server reads the key from its environment',
  );
  assert.equal(spawned?.args.join(' ').includes(KEY), false, 'the key is on the command line');
  assert.ok(
    spawned?.args.includes(
      `shell_environment_policy.exclude=${JSON.stringify([CODEX_ENDPOINT_KEY_VARIABLE, 'EXAMPLE_FLAG', CODEX_HOME_VARIABLE])}`,
    ),
    'the exclusion is a session flag on the command line too',
  );
  session.process.close();
  await session.ended;
});

test('a resumed Codex session on an endpoint reopens on the same provider', async () => {
  const session = started(
    { env: { PATH: 'p', ...codexEndpointEnv(ENDPOINT) }, resume: 'thread-1' },
    { endpoint: 'deepseek.v3', routes: codexEndpointRoutes([ENDPOINT]) },
  );
  await opened(session);
  const resumed = (session.fake.server.requestsOf('thread/resume')[0]?.['params'] ?? {}) as JsonObject;
  assert.equal(resumed['modelProvider'], codexProviderKey('deepseek.v3'));
  assert.ok(`model_providers.${codexProviderKey('deepseek.v3')}` in (resumed['config'] as JsonObject));
  session.process.close();
  await session.ended;
});

test('control: an endpoint the Codex runtime does not route ends the open by name; one with an auto-compact window states it', async () => {
  const session = started({}, { endpoint: 'nowhere', routes: [] });
  assert.match(
    (await session.ended)?.message ?? '',
    /^endpoint-unknown: nowhere is not one this Codex runtime routes/,
  );
  const route = codexEndpointRoutes([{ ...ENDPOINT, contextWindow: { autoCompactWindow: 200000 } }])[0];
  assert.ok(route !== undefined);
  assert.equal(codexProviderConfig(route, null)['model_auto_compact_token_limit'], 200000);
  assert.equal('model_context_window' in codexProviderConfig(route, null), false);
});

/** An endpoint listing two models, one with a window of its own, beside the endpoint's. */
const WINDOWED: ModelEndpoint = {
  ...ENDPOINT,
  models: ['qwen/qwen3-coder', 'deepseek-v3'],
  contextWindow: { maxContextTokens: 128000 },
  modelWindows: { 'qwen/qwen3-coder': { maxContextTokens: 262144, autoCompactWindow: 180000 } },
};

const windowKeys = (config: JsonObject): JsonObject =>
  Object.fromEntries(
    Object.entries(config).filter(
      ([key]) => key === 'model_context_window' || key === 'model_auto_compact_token_limit',
    ),
  );

test("a model's own window beats the endpoint's, and both its keys are stated", () => {
  const route = codexEndpointRoutes([WINDOWED])[0];
  assert.ok(route !== undefined);
  assert.deepEqual(windowKeys(codexProviderConfig(route, 'qwen/qwen3-coder')), {
    model_context_window: 262144,
    model_auto_compact_token_limit: 180000,
  });
});

test("a model with no window of its own, or no model named, opens on the endpoint's", () => {
  const route = codexEndpointRoutes([WINDOWED])[0];
  assert.ok(route !== undefined);
  assert.deepEqual(windowKeys(codexProviderConfig(route, 'deepseek-v3')), { model_context_window: 128000 });
  assert.deepEqual(windowKeys(codexProviderConfig(route, null)), { model_context_window: 128000 });
  assert.deepEqual(
    windowKeys(codexProviderConfig(route, 'constructor')),
    { model_context_window: 128000 },
    'a name the object inherits is no window of its own',
  );
});

test('no window anywhere states neither key, and Codex assumes its own', () => {
  const route = codexEndpointRoutes([{ ...WINDOWED, contextWindow: null, modelWindows: {} }])[0];
  assert.ok(route !== undefined);
  assert.deepEqual(windowKeys(codexProviderConfig(route, 'qwen/qwen3-coder')), {});
  const bare = codexEndpointRoutes([{ ...ENDPOINT, contextWindow: null }])[0];
  assert.ok(bare !== undefined);
  assert.deepEqual(
    windowKeys(codexProviderConfig(bare, 'deepseek-v3')),
    {},
    'an endpoint with no modelWindows',
  );
});

test('an endpoint window of both forms states both keys', () => {
  const route = codexEndpointRoutes([
    { ...ENDPOINT, contextWindow: { maxContextTokens: 262144, autoCompactWindow: 180000 } },
  ])[0];
  assert.ok(route !== undefined);
  assert.deepEqual(windowKeys(codexProviderConfig(route, 'deepseek-v3')), {
    model_context_window: 262144,
    model_auto_compact_token_limit: 180000,
  });
});

test("a thread opens with the window of the model the session names, or of the catalog's default when it names none", async () => {
  const windowAt = async (endpoint: ModelEndpoint, model: string | null): Promise<JsonObject> => {
    const session = started(
      { env: { PATH: 'p', ...codexEndpointEnv(endpoint) }, model },
      { endpoint: 'deepseek.v3', routes: codexEndpointRoutes([endpoint]) },
    );
    await opened(session);
    const keys = windowKeys(threadStart(session)['config'] as JsonObject);
    session.process.close();
    await session.ended;
    return keys;
  };
  assert.deepEqual(await windowAt(WINDOWED, 'qwen/qwen3-coder'), {
    model_context_window: 262144,
    model_auto_compact_token_limit: 180000,
  });
  assert.deepEqual(await windowAt(WINDOWED, null), { model_context_window: 128000 }, 'the default has none');
  const forTheDefault: ModelEndpoint = {
    ...WINDOWED,
    models: [...WINDOWED.models, 'gpt-6-sol'],
    modelWindows: { 'gpt-6-sol': { maxContextTokens: 400000 } },
  };
  assert.deepEqual(await windowAt(forTheDefault, null), { model_context_window: 400000 });
});

// ---------------------------------------------------------------------------
// Through a whole host
// ---------------------------------------------------------------------------

class RecordingLink implements HostLink {
  readonly sent: SessionPayload[] = [];
  handlers: LinkHandlers | null = null;
  announced: HostConfiguration | null = null;
  /** The protocol the link reports it negotiated; null, as before any handshake. */
  negotiatedVersion: number | null = null;
  send(_sessionId: string, payload: SessionPayload): Result<void> {
    this.sent.push(payload);
    return ok(undefined);
  }
  start(): void {}
  stop(): void {}
  forgetSession(): void {}
  announce(_capabilities: readonly string[], configuration: HostConfiguration): void {
    this.announced = configuration;
  }
  deliver(sessionId: string, payload: SessionPayload): void {
    const frame: SessionFrame = {
      frame: 'session',
      sessionId,
      seq: 1,
      at: '2026-10-12T00:00:00.000Z',
      payload,
    };
    this.handlers?.onSessionFrame(frame);
  }
  bodies(): JsonObject[] {
    return this.sent.map((payload) => (payload as unknown as { body: JsonObject }).body);
  }
}

async function host(
  fake: FakeCodex,
  endpoints: readonly ModelEndpoint[] = [],
): Promise<{ host: PeriscopeHost; link: RecordingLink }> {
  const link = new RecordingLink();
  const periscope = new PeriscopeHost({
    controllerUrl: 'ws://unused',
    hostId: 'test-host',
    decide: async () => ({ behavior: 'allow' }),
    protectedPaths: [],
    baseEnv: { PATH: 'p' },
    homeDir: 'C:/nonexistent-home-for-tests',
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
    agentCatalog: async () => ({
      ok: true,
      agent: { claudeCodeVersion: '2.1.284', sdkVersion: '0.3.284', models: [] },
    }),
    codex: {
      runtime: {
        binary: BINARY,
        home: HOME,
        clientVersion: '1.7.0',
        spawn: fake.spawn,
        killTree: () => Promise.resolve(),
        closeGraceMs: 20,
      },
      read: async () => ({
        entry: availableCodexEntry(
          '0.162.1',
          FAKE_MODELS.filter((model) => model['hidden'] !== true).map((model) =>
            codexHostModel(model as never),
          ),
        ),
        detail: null,
      }),
    },
    endpoints,
  });
  periscope.start();
  await until(() => link.announced !== null, 'the hello');
  return { host: periscope, link };
}

test('the hello says how each runtime takes plugin directories: Claude with each session, Codex at its process', async () => {
  const { host: periscope, link } = await host(fakeCodex({ codexHome: HOME }));
  assert.deepEqual(link.announced?.agentSkills, [
    { runtime: 'claude', naming: 'namespaced', delivery: 'per-session' },
    { runtime: 'codex', naming: 'namespaced', delivery: 'per-process' },
  ]);
  periscope.stop();
});

test('a Codex endpoint is offered to Codex in the hello, and a session naming it opens on it with its key set by the host', async () => {
  const fake = fakeCodex({ codexHome: HOME });
  const { host: periscope, link } = await host(fake, [ENDPOINT]);
  assert.deepEqual(link.announced?.endpoints, [
    { name: 'deepseek.v3', wireApi: 'openai-responses', runtimes: ['codex'], models: ['deepseek-v3'] },
  ]);
  link.deliver(
    'session-1',
    sessionNew(CWD, { request: sessionNewRequest({ runtime: 'codex', endpoint: 'deepseek.v3' }) }),
  );
  await until(() => link.bodies().some((body) => readStateTransition(body)?.to === 'ready'), 'ready');
  const params = (fake.server.requestsOf('thread/start')[0]?.['params'] ?? {}) as JsonObject;
  assert.equal(params['modelProvider'], codexProviderKey('deepseek.v3'));
  assert.equal(fake.child.spawned?.env[CODEX_ENDPOINT_KEY_VARIABLE], KEY);
  assert.equal(fake.child.spawned?.env['EXAMPLE_FLAG'], '1');
  periscope.stop();
});

test("a Codex session's conversation reaches the wire as items naming codex, beside its native messages", async () => {
  const fake = fakeCodex({ codexHome: HOME });
  const { host: periscope, link } = await host(fake);
  link.deliver('session-1', sessionNew(CWD, { request: sessionNewRequest({ runtime: 'codex' }) }));
  await until(() => link.bodies().some((body) => readStateTransition(body)?.to === 'ready'), 'ready');
  link.deliver('session-1', { kind: 'session_prompt', text: 'hello' });
  await until(() => fake.server.currentTurn !== null, 'the turn');
  fake.server.notify('item/completed', {
    threadId: 'thread-1',
    turnId: fake.server.currentTurn ?? '',
    item: { type: 'agentMessage', id: 'msg-1', text: 'Hi.' },
    completedAtMs: 1,
  });
  fake.server.completeTurn();
  await until(
    () =>
      link
        .bodies()
        .some(
          (body) =>
            readAgentItem(body)?.item.kind === 'turn' &&
            readAgentItem(body)?.item.itemId.endsWith(':completed') === true,
        ),
    'the turn item',
  );
  const items = link.bodies().flatMap((body) => {
    const read = readAgentItem(body);
    return read === null ? [] : [[read.runtime, read.item.kind]];
  });
  assert.deepEqual(items, [
    ['codex', 'turn'],
    ['codex', 'agent_text'],
    ['codex', 'turn'],
  ]);
  assert.ok(
    link.bodies().some((body) => readAgentFacts(body) !== null),
    'the facts still ride',
  );
  periscope.stop();
});

/** A Codex sub-agent's turn on a link at `version`: each item the link was sent, as `[itemId, parentId]`. */
async function subAgentItemsAt(version: number): Promise<[string, string | null][]> {
  const fake = fakeCodex({ codexHome: HOME });
  const { host: periscope, link } = await host(fake);
  link.negotiatedVersion = version;
  try {
    link.deliver('session-1', sessionNew(CWD, { request: sessionNewRequest({ runtime: 'codex' }) }));
    await until(() => link.bodies().some((body) => readStateTransition(body)?.to === 'ready'), 'ready');
    link.deliver('session-1', { kind: 'session_prompt', text: 'hello' });
    await until(() => fake.server.currentTurn !== null, 'the turn');
    const own = fake.server.currentTurn ?? '';
    // The shapes are the app-server protocol's at rust-v0.169.0: a v1 spawn names its agent's thread.
    fake.server.notify('item/completed', {
      threadId: 'thread-1',
      turnId: own,
      item: {
        type: 'collabAgentToolCall',
        id: 'call-spawn',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: 'thread-1',
        receiverThreadIds: ['agent-1'],
        prompt: 'Review it.',
        agentsStates: {},
      },
    });
    fake.server.notify('turn/started', {
      threadId: 'agent-1',
      turn: { id: 'sub-turn', status: 'inProgress' },
    });
    fake.server.notify('item/completed', {
      threadId: 'agent-1',
      turnId: 'sub-turn',
      item: { type: 'agentMessage', id: 'msg-sub', text: 'inside' },
    });
    fake.server.notify('item/completed', {
      threadId: 'thread-1',
      turnId: own,
      item: { type: 'agentMessage', id: 'msg-own', text: 'outside' },
    });
    fake.server.completeTurn();
    await until(
      () => link.bodies().some((body) => readAgentItem(body)?.item.itemId === `${own}:completed`),
      'the turn item',
    );
    return link.bodies().flatMap((body) => {
      const read = readAgentItem(body);
      return read === null ? [] : [[read.item.itemId.replace(own, 'own'), read.item.parentId ?? null]];
    });
  } finally {
    periscope.stop();
  }
}

test("a controller on protocol 19 is sent no Codex sub-agent's item, which it would read as the session's own; one on 20 is sent each naming its spawn", async () => {
  const at19 = await subAgentItemsAt(19);
  assert.deepEqual(at19, [
    ['own:started', null],
    ['call-spawn', null],
    ['call-spawn:result', null],
    ['msg-own', null],
    ['own:completed', null],
  ]);
  const at20 = await subAgentItemsAt(20);
  assert.deepEqual(at20, [
    ['own:started', null],
    ['call-spawn', null],
    ['call-spawn:result', null],
    ['sub-turn:started', 'call-spawn'],
    ['msg-sub', 'call-spawn'],
    ['msg-own', null],
    ['own:completed', null],
  ]);
});

test('a Codex session asking for a server Codex has no form for is refused at the door, before anything starts', () => {
  const entry = availableCodexEntry(
    '0.162.1',
    FAKE_MODELS.filter((model) => model['hidden'] !== true).map((model) => codexHostModel(model as never)),
  );
  const asked = (mcpServers: JsonObject): Result<unknown> =>
    readSessionRequest(sessionNewRequest({ runtime: 'codex', mcpServers }), undefined, [], [], [entry]);
  const sse = asked({ docs: { type: 'sse', url: 'http://docs' } });
  assert.equal(sse.ok ? 'taken' : sse.refusal.reason, 'mcp-descriptor-invalid');
  assert.match(sse.ok ? '' : sse.refusal.detail, /"docs" is an SSE server/);
  const http = asked({ docs: { type: 'http', url: 'http://docs', headers: { 'X-Job-Ticket': TICKET } } });
  assert.equal(http.ok, true, 'an HTTP server with its headers is one Codex takes');
  const claude = readSessionRequest(
    sessionNewRequest({ mcpServers: { docs: { type: 'sse', url: 'http://docs' } } }),
  );
  assert.equal(claude.ok, true, "a Claude session's servers are the agent SDK's to read, as before");
});
