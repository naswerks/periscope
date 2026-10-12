/**
 * A controller can choose a model endpoint and can never write one. Driven over a real host with a
 * fake process and a fake link: a `session_new` naming a declared endpoint spawns with the variables
 * this host composed from its operator's configuration, a session naming none spawns with none of
 * them, a model the endpoint must not be sent is refused at the open and on a later switch, the hello
 * lists the endpoint and carries nothing secret, and the files behind it are in the protected set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';

import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import { encode } from '../control/codec.js';
import type { HostConfiguration, JsonObject, SessionFrame, SessionPayload } from '../control/frames.js';
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MIN,
  readStateTransition,
  sessionNew,
  sessionNewRequest,
} from '../control/frames.js';
import type { LinkHandlers } from '../control/link.js';
import type { DecisionRequest } from '../gate/decision.js';
import type { PathResolver } from '../gate/jail.js';
import { localGate } from '../gate/local.js';
import { SessionRegistry } from '../sessions/registry.js';
import type { SessionTransition } from '../state/model.js';
import type { FakeAgents } from '../test-support/fake-agent.js';
import { fakeAgents, settle } from '../test-support/fake-agent.js';
import type { AgentCatalog } from './agent-process.js';
import type { HostLink, PeriscopeHostOptions } from './host.js';
import { PeriscopeHost } from './host.js';
import type { ModelEndpoint } from './model-endpoints.js';
import { credentialPaths } from './paths.js';

const TOKEN = 'example-endpoint-secret';
const BASE_URL = 'https://api.deepseek.example/anthropic';

const DEEPSEEK: ModelEndpoint = {
  name: 'deepseek',
  wireApi: 'anthropic-messages',
  runtimes: ['claude'],
  baseUrl: BASE_URL,
  models: ['deepseek-flash[1m]', 'deepseek-flash'],
  modelAliases: { opus: 'deepseek-flash[1m]', sonnet: 'deepseek-flash[1m]', haiku: 'deepseek-flash' },
  contextWindow: { autoCompactWindow: 786432 },
  env: { API_TIMEOUT_MS: '3000000' },
  firstParty: false,
  authToken: () => TOKEN,
};

/** The variables a session on DEEPSEEK carries, each to the value this host set. */
const DEEPSEEK_VARIABLES: Readonly<Record<string, string>> = {
  ANTHROPIC_BASE_URL: BASE_URL,
  ANTHROPIC_AUTH_TOKEN: TOKEN,
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  API_TIMEOUT_MS: '3000000',
};

class FakeLink implements HostLink {
  readonly sent: SessionPayload[] = [];
  handlers: LinkHandlers | null = null;
  announced: HostConfiguration | null = null;

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

  deliver(sessionId: string, payload: SessionPayload, seq = 1): void {
    const frame: SessionFrame = { frame: 'session', sessionId, seq, at: '2026-10-11T00:00:00.000Z', payload };
    this.handlers?.onSessionFrame(frame);
  }

  transitions(): SessionTransition[] {
    return this.sent.flatMap((payload) => {
      if (payload.kind !== 'session_update') return [];
      return readStateTransition((payload as unknown as { body: JsonObject }).body) ?? [];
    });
  }

  refusals(): string[] {
    return this.transitions()
      .filter((transition) => transition.cause.kind === 'refusal')
      .map((transition) => `${transition.cause.event}: ${transition.cause.detail}`);
  }
}

function hostOver(options: Partial<PeriscopeHostOptions> = {}): {
  host: PeriscopeHost;
  link: FakeLink;
  processes: FakeAgents;
} {
  const processes = fakeAgents();
  const link = new FakeLink();
  const host = new PeriscopeHost({
    controllerUrl: 'ws://unused',
    hostId: 'test-host',
    decide: async () => ({ behavior: 'allow' }),
    protectedPaths: [],
    endpoints: [DEEPSEEK],
    registry: new SessionRegistry({
      baseEnv: { PATH: 'p' },
      homeDir: 'C:/nonexistent-home-for-tests',
      startProcess: processes.start,
    }),
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
    ...options,
  });
  return { host, link, processes };
}

const opening = (request: Parameters<typeof sessionNewRequest>[0]): ReturnType<typeof sessionNew> =>
  sessionNew('C:/work', { request: sessionNewRequest(request) });

test('regression: a session naming a declared endpoint spawns with the variables this host composed for it', async () => {
  const { link, processes } = hostOver();
  link.deliver('handle-1', opening({ endpoint: 'deepseek', model: 'opus' }));
  await settle();

  assert.equal(processes.started.length, 1, `refused: ${link.refusals().join('; ')}`);
  const env = processes.started[0]?.request.env ?? {};
  for (const [key, value] of Object.entries(DEEPSEEK_VARIABLES)) {
    assert.equal(env[key], value, `${key} is not what this host set`);
  }
  assert.equal(env['PATH'], 'p', 'the inherited environment is untouched');
  assert.equal(
    'endpoint' in (processes.started[0]?.request ?? {}),
    false,
    'the name reached the agent process',
  );
});

test('control: a session naming no endpoint spawns with none of the endpoint variables', async () => {
  const { link, processes } = hostOver();
  link.deliver('handle-1', opening({ model: 'opus' }));
  await settle();

  assert.equal(processes.started.length, 1, `refused: ${link.refusals().join('; ')}`);
  const env = processes.started[0]?.request.env ?? {};
  for (const key of Object.keys(DEEPSEEK_VARIABLES))
    assert.equal(key in env, false, `${key} reached the spawn`);
});

test("a controller's declared literal never overrides the value the host sets for the endpoint", async () => {
  const { link, processes } = hostOver({ controllerEnvKeys: ['CLAUDE_CODE_AUTO_COMPACT_WINDOW'] });
  link.deliver(
    'handle-1',
    opening({
      endpoint: 'deepseek',
      env: {
        extraAllowedKeys: null,
        extraDeniedKeys: null,
        extraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' },
      },
    }),
  );
  await settle();

  assert.equal(processes.started.length, 1, `refused: ${link.refusals().join('; ')}`);
  assert.equal(processes.started[0]?.request.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'], '786432');
});

test('an endpoint this host does not declare is refused endpoint-unknown before any process exists', async () => {
  const { link, processes } = hostOver();
  link.deliver('handle-1', opening({ endpoint: 'elsewhere' }));
  await settle();

  assert.equal(processes.started.length, 0);
  assert.match(
    link.refusals().join('; '),
    /^endpoint-unknown: endpoint "elsewhere" is not one this host declares; the endpoints its hello lists are deepseek/,
  );
});

test('a Claude model id or an unmapped alias on the endpoint is refused model-endpoint-mismatch at the open', async () => {
  for (const model of ['claude-opus-5-5', 'opusplan', 'default[1m]']) {
    const { link, processes } = hostOver();
    link.deliver('handle-1', opening({ endpoint: 'deepseek', model }));
    await settle();
    assert.equal(processes.started.length, 0, `${model} started a process`);
    assert.match(
      link.refusals().join('; '),
      new RegExp(
        `^model-endpoint-mismatch: model ${model.replace(/[[\]]/g, '\\$&')} named for endpoint "deepseek"`,
      ),
    );
  }
  const { link, processes } = hostOver();
  link.deliver('handle-1', opening({ endpoint: 'deepseek', model: 'haiku' }));
  await settle();
  assert.equal(processes.started.length, 1, `a mapped alias was refused: ${link.refusals().join('; ')}`);
});

test('a switch to a Claude model id or an unmapped alias on an endpoint session is refused, and reaches no setter', async () => {
  const { link, processes } = hostOver();
  link.deliver('handle-1', opening({ endpoint: 'deepseek', model: 'opus' }));
  await settle();

  link.deliver(
    'handle-1',
    { kind: 'session_configure', model: 'claude-opus-5-5', permissionMode: null, thinking: null },
    2,
  );
  link.deliver(
    'handle-1',
    { kind: 'session_configure', model: 'fable', permissionMode: null, thinking: null },
    3,
  );
  await settle();
  assert.equal(processes.started[0]?.configured.length, 0, 'a refused model reached the agent');
  const refused = link.refusals();
  assert.equal(refused.length, 2, refused.join('; '));
  assert.match(
    refused[0] ?? '',
    /^model-endpoint-mismatch: model claude-opus-5-5 named for endpoint "deepseek"/,
  );
  assert.match(
    refused[1] ?? '',
    /^model-endpoint-mismatch: model fable named for endpoint "deepseek", which maps no fable and is not marked as Anthropic's own route/,
  );

  // Control: the endpoint's own model and a mapped alias go through.
  link.deliver(
    'handle-1',
    { kind: 'session_configure', model: 'deepseek-flash', permissionMode: null, thinking: null },
    4,
  );
  link.deliver(
    'handle-1',
    { kind: 'session_configure', model: 'sonnet', permissionMode: null, thinking: null },
    5,
  );
  await settle();
  assert.deepEqual(
    processes.started[0]?.configured.map((call) => call.value),
    ['deepseek-flash', 'sonnet'],
  );
});

test('control: a session on no endpoint switches to a Claude model id as before', async () => {
  const { link, processes } = hostOver();
  link.deliver('handle-1', opening({ model: 'opus' }));
  await settle();
  link.deliver(
    'handle-1',
    { kind: 'session_configure', model: 'claude-opus-5-5', permissionMode: null, thinking: null },
    2,
  );
  await settle();
  assert.deepEqual(
    processes.started[0]?.configured.map((call) => call.value),
    ['claude-opus-5-5'],
  );
  assert.deepEqual(link.refusals(), []);
});

const FAILED_CATALOG: AgentCatalog = { ok: false, detail: 'no agent in this test' };

/** The hello a link built from this configuration would send. */
function helloText(configuration: HostConfiguration): string {
  const encoded = encode({
    frame: 'control',
    at: '2026-10-11T00:00:00.000Z',
    payload: {
      kind: 'link_hello',
      protocolVersion: PROTOCOL_VERSION,
      hostId: 'test-host',
      capabilities: [],
      cursors: [],
      configuration,
      pendingRestart: [],
      protocolRange: { min: PROTOCOL_VERSION_MIN, max: PROTOCOL_VERSION },
    },
  });
  assert.ok(encoded.ok, encoded.ok ? '' : encoded.refusal.detail);
  return encoded.value;
}

test('the hello lists the endpoint by name, wire API, runtimes and models, and carries no URL, secret or first-party marker', async () => {
  const { host, link } = hostOver({ agentCatalog: async () => FAILED_CATALOG });
  host.start();
  await settle();

  const configuration = link.announced;
  assert.ok(configuration !== null, 'nothing was announced');
  assert.deepEqual(configuration.endpoints, [
    {
      name: 'deepseek',
      wireApi: 'anthropic-messages',
      runtimes: ['claude'],
      models: ['deepseek-flash[1m]', 'deepseek-flash', 'opus', 'sonnet', 'haiku'],
    },
  ]);
  assert.equal(configuration.agent, null, 'the endpoints ride whatever the catalog read did');

  const hello = helloText(configuration);
  for (const secret of [BASE_URL, TOKEN, 'firstParty']) {
    assert.ok(!hello.includes(secret), `the hello carries ${secret}`);
  }

  // Control: the same grep over the endpoint record itself, with its credential read, finds all three,
  // so the grep can fire.
  const raw = JSON.stringify({ ...DEEPSEEK, credential: DEEPSEEK.authToken() });
  for (const secret of [BASE_URL, TOKEN, 'firstParty'])
    assert.ok(raw.includes(secret), `the control lacks ${secret}`);
});

test('an endpoints list the hello cannot carry is a construction error, and so is a name declared twice', () => {
  const many = Array.from({ length: 9 }, (_, index) => ({ ...DEEPSEEK, name: `endpoint-${index}` }));
  assert.throws(() => hostOver({ endpoints: many }), /PeriscopeHostOptions\.endpoints: .*/);
  assert.throws(
    () => hostOver({ endpoints: [DEEPSEEK, { ...DEEPSEEK, name: 'DeepSeek' }] }),
    /declared twice/,
  );
});

/** `nodePathResolver`'s contract over a stated path flavour, so both flavours run on every platform. */
function resolverFor(flavour: typeof posix): PathResolver {
  return (candidate: string): string => flavour.resolve(candidate);
}

const FLAVOURS = [
  {
    name: 'windows paths',
    env: { USERPROFILE: 'C:/Users/agent' },
    workspaceRoot: 'C:/work/repo',
    endpointsFile: 'D:/operator/endpoints.json',
    credentialFile: 'D:/operator/keys/deepseek.txt',
    resolve: resolverFor(win32),
  },
  {
    name: 'posix paths',
    env: { HOME: '/home/agent' },
    workspaceRoot: '/work/repo',
    endpointsFile: '/etc/operator/endpoints.json',
    credentialFile: '/etc/operator/keys/deepseek.txt',
    resolve: resolverFor(posix),
  },
] as const;

for (const flavour of FLAVOURS) {
  test(`regression: the endpoints file and a credential file are refused to the agent — ${flavour.name}`, () => {
    const protectedPaths = credentialPaths(flavour.env, {
      modelEndpointFiles: [flavour.endpointsFile, flavour.credentialFile],
    });
    const gate = localGate({
      workspaceRoot: flavour.workspaceRoot,
      resolve: flavour.resolve,
      protectedPaths,
    });
    const read = (path: string): DecisionRequest => ({
      toolName: 'Read',
      toolUseId: 'toolu_test',
      toolInput: { file_path: path },
      sessionId: 'session-test',
      sessionKey: 'handle-1',
      cwd: flavour.workspaceRoot,
      agentId: null,
      agentType: null,
    });
    assert.equal(gate(read(flavour.endpointsFile))?.reason, 'credential-path-denied');
    assert.equal(gate(read(flavour.credentialFile))?.reason, 'credential-path-denied');

    // Control: the same gate without the endpoint files has no opinion about them.
    const bare = localGate({
      workspaceRoot: flavour.workspaceRoot,
      resolve: flavour.resolve,
      protectedPaths: credentialPaths(flavour.env, { modelEndpointFiles: [] }),
    });
    assert.equal(bare(read(flavour.endpointsFile)), null);
  });
}

test('with no files passed, the protected set takes the endpoints file the environment names', () => {
  const paths = credentialPaths({
    HOME: '/home/agent',
    PERISCOPE_MODEL_ENDPOINTS: '/etc/operator/endpoints.json',
  });
  assert.ok(paths.includes('/etc/operator/endpoints.json'), paths.join(', '));
  assert.ok(
    !credentialPaths(
      { HOME: '/home/agent', PERISCOPE_MODEL_ENDPOINTS: '/x.json' },
      { modelEndpointFiles: [] },
    ).includes('/x.json'),
    'the files passed replace the environment fallback',
  );
});
