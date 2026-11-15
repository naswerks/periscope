import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { RefusalReason } from '../core/refusal.js';
import { ok, refuse } from '../core/result.js';
import type { Decider, DecisionRequest } from '../gate/decision.js';
import { OPENCODE_DENIED_TOOLS } from '../gate/tool-kind.js';
import { MAX_PENDING_PROMPTS } from './agent-process.js';
import type { AgentProcess, AgentProcessRequest } from './agent-process.js';
import { fakeOpencode } from '../test-support/fake-opencode.js';
import type { FakeOpencodeOptions, FakeOpencodeRecord } from '../test-support/fake-opencode.js';
import { tempDir } from '../test-support/temp-dir.js';
import { waitFor } from '../test-support/ws-peer.js';
import type { OpencodeEndpointRoute } from './opencode-endpoints.js';
import { OPENCODE_OPENAI_COMPATIBLE_PACKAGE } from './opencode-endpoints.js';
import { createOpencodeSessionGate } from './opencode-gate.js';
import { OPENCODE_OFF_PLUGINS, OPENCODE_SWITCHES, opencodeRuleset } from './opencode-home.js';
import type { OpencodeRuntimeConfig } from './opencode-process.js';
import {
  OPENCODE_AGENTS,
  opencodeInitFacts,
  opencodeRequestProblem,
  opencodeShellPath,
  startOpencodeProcess,
} from './opencode-process.js';
import type { OpencodeEvent, OpencodeInstall } from './opencode-sdk.js';
import type { OpencodeMessage } from './opencode-wire.js';

const ROOT = process.platform === 'win32' ? 'C:/work/session-1' : '/work/session-1';
const KEY = 'sk-endpoint-key-never-in-an-environment';
const SHELL =
  process.platform === 'win32' ? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : '/bin/bash';

function processRequest(overrides: Partial<AgentProcessRequest> = {}): AgentProcessRequest {
  return {
    cwd: ROOT,
    env: { PATH: 'p', MARKER: 'reaches-the-shell' },
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

const ROUTE: OpencodeEndpointRoute = {
  name: 'stub',
  wireApi: 'openai-chat',
  baseUrl: 'http://127.0.0.1:9/v1',
  models: ['stub-model', 'stub-other'],
  authToken: () => KEY,
};

interface Started {
  readonly process: AgentProcess<OpencodeMessage>;
  readonly record: FakeOpencodeRecord;
  readonly messages: OpencodeMessage[];
  readonly degrades: string[];
  readonly raised: { name: RefusalReason; detail: string }[];
  readonly requests: DecisionRequest[];
  readonly killed: number[];
  readonly base: string;
  readonly ended: Promise<Error | null>;
}

interface Setup {
  readonly request?: Partial<AgentProcessRequest>;
  readonly fake?: FakeOpencodeOptions;
  readonly runtime?: Partial<OpencodeRuntimeConfig>;
  readonly decide?: Decider;
  readonly endpoint?: string | null;
  readonly noGate?: boolean;
  readonly before?: (base: string) => void;
}

const allowAll: Decider = () => Promise.resolve({ behavior: 'allow' });

const INSTALL: OpencodeInstall = { directory: 'C:/sdk', entry: 'C:/sdk/index.js', sdkVersion: '2.3.0' };

async function started(setup: Setup = {}): Promise<Started> {
  const base = await tempDir('opencode-base');
  setup.before?.(base);
  const { connect, record } = fakeOpencode(setup.fake);
  const degrades: string[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const requests: DecisionRequest[] = [];
  const killed: number[] = [];
  const request = processRequest(setup.request);
  const gate =
    setup.noGate === true
      ? null
      : createOpencodeSessionGate({
          sessionKey: 'session-1',
          cwd: request.cwd,
          decide: (asked, signal) => {
            requests.push(asked);
            return (setup.decide ?? allowAll)(asked, signal);
          },
          decisionTimeoutMs: 1_000,
          holdAfterMs: 10_000,
          servers: Object.keys(request.mcpServers ?? {}),
          onOutcome: () => undefined,
          onDegrade: (name, detail) => raised.push({ name, detail }),
          onSpawnDegrades: () => undefined,
        });
  const process = startOpencodeProcess(
    request,
    {
      sdk: 'C:/sdk',
      base,
      endpoints: [ROUTE],
      readInstall: () => ok(INSTALL),
      nodeProblem: () => null,
      connect,
      shell: SHELL,
      killTree: (pid) => {
        killed.push(pid);
        return Promise.resolve();
      },
      closeGraceMs: 200,
      ...setup.runtime,
    },
    (detail) => degrades.push(detail),
    setup.endpoint === undefined ? 'stub' : setup.endpoint,
    gate,
  );
  const messages: OpencodeMessage[] = [];
  const ended = (async (): Promise<Error | null> => {
    try {
      for await (const message of process.messages) messages.push(message);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();
  return { process, record, messages, degrades, raised, requests, killed, base, ended };
}

async function closed(run: Started): Promise<Error | null> {
  run.process.close();
  const ended = await run.ended;
  await rm(run.base, { recursive: true, force: true });
  return ended;
}

const opened = (run: Started): boolean => run.messages.some((message) => message.kind === 'opened');
const types = (run: Started): string[] =>
  run.messages.flatMap((message) => (message.kind === 'event' ? [message.event.type] : []));
const until = (condition: () => boolean, what: string): Promise<void> => waitFor(condition, what, 5_000);

/** The events of `type` the session's process yielded, in order. */
const eventsOf = (run: Started, type: string): OpencodeEvent[] =>
  run.messages.flatMap((message) =>
    message.kind === 'event' && message.event.type === type ? [message.event] : [],
  );

/** Each value in `secrets` that appears in `env`, by the variable that holds it. */
function credentialsIn(env: Readonly<Record<string, string>>, secrets: readonly string[]): string[] {
  return Object.entries(env)
    .filter(([, value]) => secrets.some((secret) => value.includes(secret)))
    .map(([name]) => name);
}

test('members with no opencode meaning are refused by name, never dropped', () => {
  const refused: [Partial<AgentProcessRequest>, RegExp][] = [
    [{ hooks: {} }, /^hooks:/],
    [{ sessionStore: {} as never }, /^sessionStore:/],
    [{ spawn: (() => undefined) as never }, /^spawn:/],
    [{ settingSources: ['project'] }, /^settingSources:/],
    [{ strictMcpConfig: false }, /^strictMcpConfig:/],
    [{ systemPrompt: 'You are a pirate.' }, /^systemPrompt:/],
    [{ systemPrompt: { type: 'preset', preset: 'claude_code' } }, /^systemPrompt:/],
    [
      { permissionMode: 'bypassPermissions' },
      /^permissionMode bypassPermissions: opencode takes default, plan/,
    ],
    [{ permissionMode: 'acceptEdits' }, /^permissionMode acceptEdits:/],
    [{ thinking: { type: 'disabled' } }, /^thinking:/],
    [{ effort: 'high' }, /^effort high: opencode sets reasoning through a model's variants/],
    [{ fork: true }, /^fork: a fork names the session it forks in resume/],
  ];
  for (const [overrides, pattern] of refused) {
    assert.match(opencodeRequestProblem(processRequest(overrides)) ?? 'accepted', pattern);
  }
  assert.equal(opencodeRequestProblem(processRequest()), null);
  assert.equal(opencodeRequestProblem(processRequest({ permissionMode: 'plan' })), null);
  assert.equal(opencodeRequestProblem(processRequest({ thinking: { type: 'adaptive' } })), null);
  assert.equal(
    opencodeRequestProblem(
      processRequest({ systemPrompt: { type: 'preset', preset: 'runtime-default', append: 'Be brief.' } }),
    ),
    null,
  );
});

test('the shell is named by path: Windows PowerShell at its fixed path, else cmd; bash, else sh', () => {
  const windows = opencodeShellPath('win32', { SystemRoot: 'D:\\Win' }, (path) =>
    path.includes('powershell'),
  );
  assert.match(windows, /D:[\\/]Win[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.match(
    opencodeShellPath('win32', { SystemRoot: 'D:\\Win' }, () => false),
    /cmd\.exe$/,
  );
  assert.equal(
    opencodeShellPath('linux', {}, () => true),
    '/bin/bash',
  );
  assert.equal(
    opencodeShellPath('linux', {}, () => false),
    '/bin/sh',
  );
});

test('a session with no gate is refused before anything starts: opencode-gate-not-active', async () => {
  const run = await started({ noGate: true });
  const ended = await closed(run);
  assert.match(String(ended?.message), /^opencode-gate-not-active:/);
  assert.equal(run.record.connects.length, 0, 'no host process was started');
  assert.equal(run.process.prompt('hello'), false);
});

test('an endpoint this runtime does not route, a model the endpoint does not list, and a model with no endpoint are refused before anything starts', async () => {
  const cases: [Setup, RegExp][] = [
    [{ endpoint: 'nowhere' }, /^endpoint-unknown: nowhere/],
    [
      { request: { model: 'not-listed' } },
      /^request-key-unsupported: model not-listed is not one the endpoint stub lists/,
    ],
    [{ endpoint: null, request: { model: 'stub-model' } }, /names no endpoint/],
  ];
  for (const [setup, pattern] of cases) {
    const run = await started(setup);
    const ended = await closed(run);
    assert.match(String(ended?.message), pattern);
    assert.equal(run.record.connects.length, 0);
  }
});

test('a Node that cannot load the SDK, and an install off the pin, end the session by name before a process starts', async () => {
  const node = await started({
    runtime: { nodeProblem: () => 'this host runs Node 22.0.0, which cannot parse `await using`' },
  });
  assert.match(String((await closed(node))?.message), /^runtime-unavailable: this host runs Node 22/);
  assert.equal(node.record.connects.length, 0);
  const install = await started({
    runtime: { readInstall: () => refuse('runtime-unavailable', 'C:/sdk holds @opencode/sdk 2.2.5') },
  });
  assert.match(
    String((await closed(install))?.message),
    /^runtime-unavailable: C:\/sdk holds @opencode\/sdk 2\.2\.5/,
  );
  assert.equal(install.record.connects.length, 0);
});

test("the open hands the host process this host's configuration: every action asks, the turned-off tools and plugins are off, one provider, its key, the shell", async () => {
  const run = await started();
  try {
    await until(() => opened(run), 'the open');
    const config = run.record.configs[0] ?? {};
    assert.deepEqual(config['permissions'], opencodeRuleset());
    assert.deepEqual(
      config['plugins'],
      OPENCODE_OFF_PLUGINS.map((id) => `-${id}`),
    );
    assert.deepEqual(config['policies'], [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'endpoint-stub', effect: 'allow' },
    ]);
    assert.deepEqual(config['providers'], {
      'endpoint-stub': {
        name: 'stub',
        package: OPENCODE_OPENAI_COMPATIBLE_PACKAGE,
        settings: { baseURL: 'http://127.0.0.1:9/v1', apiKey: KEY },
        models: { 'stub-model': { name: 'stub-model' }, 'stub-other': { name: 'stub-other' } },
      },
    });
    assert.deepEqual(config['model'], { providerID: 'endpoint-stub', model: 'stub-model' });
    assert.equal(config['shell'], SHELL);
    assert.deepEqual(config['agents'], { title: { disabled: true } });
    for (const key of ['formatter', 'lsp', 'snapshots']) assert.equal(config[key], false, key);
    assert.equal(config['update'], 'disable');
    assert.equal(config['share'], 'disabled');
    // Created with the same rules, as the build agent, on the endpoint's model.
    const [create] = run.record.of('session.create');
    assert.deepEqual(create?.['permissions'], opencodeRuleset());
    assert.equal(create?.['agent'], OPENCODE_AGENTS.default);
    assert.deepEqual(create?.['model'], { id: 'stub-model', providerID: 'endpoint-stub' });
    // The server's plugins are active (the model list) before the session is created and read back.
    const order = run.record.calls.map((call) => call.method);
    assert.ok(order.indexOf('model.list') < order.indexOf('session.create'));
    for (const read of [
      'session.get',
      'agent.list',
      'permission.saved.list',
      'plugin.list',
      'mcp.list',
      'config.get',
    ]) {
      assert.ok(order.indexOf(read) > order.indexOf('session.create'), `${read} was read after the create`);
    }
    const open = run.messages.find((message) => message.kind === 'opened');
    assert.deepEqual(open, {
      kind: 'opened',
      sessionId: 'ses_main',
      model: 'endpoint-stub/stub-model',
      agent: 'build',
      origin: 'new',
    });
    assert.deepEqual(open === undefined ? null : opencodeInitFacts(open)?.permissionMode, 'build');
  } finally {
    await closed(run);
  }
});

test("no credential reaches an environment: the key rides the configuration alone, this host's own variables are stripped, and the further worktrees' paths are kept", async () => {
  const env = {
    PATH: 'p',
    MARKER: 'reaches-the-shell',
    OPENCODE_SERVER_PASSWORD: 'a-planted-opencode-variable',
    NODE_OPTIONS: '--require ./planted.js',
    PERISCOPE_CONTROLLER_TICKET: 'a-planted-ticket',
    periscope_token: 'a-planted-token-in-lower-case',
    PERISCOPE_WORKTREE_PERISCOPE: 'C:/worktrees/periscope',
  };
  const run = await started({ request: { env } });
  try {
    await until(() => opened(run), 'the open');
    const connected = run.record.connects[0];
    assert.ok(connected !== undefined);
    const hostEnv = connected.env;
    const [shell] = run.record.of('session.environment');
    const shellEnv = (shell?.['variables'] ?? {}) as Record<string, string>;
    // Control: the planted copies were in the spawn environment, so their absence below is the strip.
    assert.ok(Object.values(env).some((value) => value.includes('planted')));
    for (const [name, seen] of [
      ['host process', hostEnv],
      ['shell', shellEnv],
    ] as const) {
      assert.deepEqual(
        credentialsIn(seen, [KEY, 'a-planted']),
        [],
        `${name}: a credential or a planted variable reached it`,
      );
      const leaked = Object.keys(seen).filter(
        (key) =>
          key.toUpperCase() === 'NODE_OPTIONS' ||
          (key.toUpperCase().startsWith('PERISCOPE_') &&
            !key.toUpperCase().startsWith('PERISCOPE_WORKTREE_')),
      );
      assert.deepEqual(leaked, [], `${name}: ${leaked.join(', ')}`);
      assert.equal(
        seen['PERISCOPE_WORKTREE_PERISCOPE'],
        'C:/worktrees/periscope',
        `${name}: the worktree path is kept`,
      );
      assert.equal(
        seen['MARKER'],
        'reaches-the-shell',
        `${name}: the marker is there, so the read proves something`,
      );
    }
    // The host process runs from the session's home, with the switches; the shell keeps the operator's home.
    for (const [name, value] of Object.entries(OPENCODE_SWITCHES)) assert.equal(hostEnv[name], value, name);
    assert.ok(hostEnv['HOME']?.startsWith(join(run.base, 'sessions')));
    assert.ok(hostEnv['XDG_DATA_HOME']?.startsWith(join(run.base, 'sessions')));
    assert.equal(Object.keys(shellEnv).filter((key) => key.toUpperCase().startsWith('OPENCODE_')).length, 0);
    assert.equal(
      shellEnv['HOME'],
      undefined,
      "the shell's home is the operator's own, which this spawn environment does not set",
    );
    assert.equal(shell?.['sessionID'], 'ses_main');
    // The key crosses as configuration text, not as an argument or a variable.
    assert.ok(connected.config.includes(KEY));
  } finally {
    await closed(run);
  }
});

test('prompts sent before the open is proven are held, then sent in order, each queued behind any run', async () => {
  const run = await started();
  try {
    assert.equal(run.process.prompt('first'), true);
    assert.equal(run.process.prompt('second'), true);
    assert.deepEqual(run.record.of('session.prompt'), []);
    await until(() => run.record.of('session.prompt').length === 2, 'the held prompts');
    assert.deepEqual(
      run.record.of('session.prompt').map((input) => [input['text'], input['delivery']]),
      [
        ['first', 'queue'],
        ['second', 'queue'],
      ],
    );
    await until(
      () => types(run).filter((type) => type === 'session.execution.succeeded').length === 2,
      'both runs',
    );
  } finally {
    await closed(run);
  }
});

test('the queue holds at most the pending bound the server has not yet taken', async () => {
  const run = await started();
  try {
    for (let index = 0; index < MAX_PENDING_PROMPTS; index += 1)
      assert.equal(run.process.prompt(`p${index}`), true);
    assert.equal(run.process.prompt('one too many'), false);
  } finally {
    await closed(run);
  }
});

const BREAKS: [string, FakeOpencodeOptions, RegExp][] = [
  [
    "an allow planted in the session's rules",
    { sessionRules: [{ action: '*', resource: '*', effect: 'allow' }, ...opencodeRuleset()] },
    /the session's rules are not the ones this host wrote/,
  ],
  [
    'an agent whose rules end with an allow',
    {
      agents: [
        {
          id: 'build',
          permissions: [...opencodeRuleset(), { action: 'edit', resource: '*', effect: 'allow' }],
        },
      ],
    },
    /agent build's rules do not end with the ones this host configured/,
  ],
  ['a saved approval', { saved: [{ action: 'shell', resource: 'git *' }] }, /saved approvals: shell git \*/],
  [
    'a plugin from a package',
    { plugins: [{ id: 'evil', source: { type: 'npm' } }] },
    /plugins other than the runtime's own are loaded: evil/,
  ],
  [
    'a turned-off plugin running',
    { plugins: [{ id: 'opencode.browser', source: { type: 'builtin' } }] },
    /plugins this host turns off are loaded: opencode\.browser/,
  ],
  [
    'an MCP server the session did not attach',
    { servers: ['stranger'] },
    /MCP servers are stranger, not the session's none/,
  ],
  [
    "configuration from outside the session's home",
    {
      configEntries: [
        {
          type: 'file',
          path:
            process.platform === 'win32'
              ? 'C:/Users/x/.config/opencode/opencode.json'
              : '/home/x/.config/opencode/opencode.json',
        },
      ],
    },
    /loaded configuration this host did not write/,
  ],
  [
    "a second provider's model",
    {
      models: [
        { id: 'stub-model', providerID: 'endpoint-stub' },
        { id: 'gpt', providerID: 'openai' },
      ],
    },
    /models of providers other than the session's: openai/,
  ],
];

for (const [name, fake, pattern] of BREAKS) {
  test(`the read-back refuses the open, and no prompt is sent: ${name}`, async () => {
    const run = await started({ fake });
    run.process.prompt('never sent');
    const ended = await run.ended;
    try {
      assert.match(String(ended?.message), /^opencode-gate-not-active: /);
      assert.match(String(ended?.message), pattern);
      assert.equal(opened(run), false);
      assert.deepEqual(run.record.of('session.prompt'), []);
      assert.ok(run.raised.some((one) => one.name === 'opencode-gate-not-active'));
    } finally {
      await closed(run);
    }
  });
}

test('control: the read-back passes on the posture this host created', async () => {
  const run = await started();
  try {
    await until(() => opened(run), 'the open');
    assert.deepEqual(run.raised, []);
  } finally {
    await closed(run);
  }
});

test('each request is decided by this host and answered once: an approve runs the call, a deny refuses it with words the model reads', async () => {
  const run = await started({
    fake: {
      calls: (prompt) =>
        prompt === 'go'
          ? [
              {
                id: 'call_read',
                name: 'read',
                input: { filePath: 'a.ts' },
                requests: [{ action: 'read', resources: ['a.ts'] }],
              },
              {
                id: 'call_edit',
                name: 'edit',
                input: { filePath: 'b.ts' },
                requests: [{ action: 'edit', resources: ['b.ts'] }],
              },
            ]
          : [],
    },
    decide: (request) =>
      Promise.resolve(
        request.toolName === 'edit' ? { behavior: 'deny', message: 'not that one' } : { behavior: 'allow' },
      ),
  });
  try {
    run.process.prompt('go');
    await until(() => types(run).includes('session.execution.succeeded'), 'the run');
    const replies = Object.fromEntries(run.record.replies.map((reply) => [reply.requestID, reply]));
    assert.deepEqual(replies['per_call_read_1'], { requestID: 'per_call_read_1', decision: 'once' });
    assert.equal(replies['per_call_edit_1']?.decision, 'reject');
    assert.ok((replies['per_call_edit_1']?.message ?? '').length > 0, 'a reject always carries words');
    assert.deepEqual(
      run.requests.map((request) => [request.toolUseId, request.toolName, request.toolKind]),
      [
        ['call_read', 'read', 'file_read'],
        ['call_edit', 'edit', 'file_edit'],
      ],
    );
    assert.ok(run.record.replies.every((reply) => reply.decision === 'once' || reply.decision === 'reject'));
  } finally {
    await closed(run);
  }
});

test("a subagent's session is given the shell's environment, and its requests are decided here, naming it", async () => {
  let child = '';
  const run = await started({
    fake: {
      calls: () => [
        {
          id: 'call_sub_read',
          name: 'read',
          session: child,
          requests: [{ action: 'read', resources: ['a.ts'] }],
        },
      ],
    },
  });
  try {
    await until(() => opened(run), 'the open');
    child = run.record.spawn('call_task', 'general');
    await until(() => run.record.of('session.environment').length === 2, "the subagent's environment");
    const environment = run.record.of('session.environment')[1];
    assert.equal(environment?.['sessionID'], child);
    assert.equal((environment?.['variables'] as Record<string, string>)['MARKER'], 'reaches-the-shell');
    run.process.prompt('go');
    await until(() => run.requests.length === 1, "the subagent's request");
    assert.equal(run.requests[0]?.agentId, child);
    assert.equal(run.requests[0]?.agentType, 'general');
    const fromChild = run.messages.find(
      (message) => message.kind === 'event' && message.event.type === 'permission.asked',
    );
    assert.ok(fromChild?.kind === 'event');
    assert.equal(fromChild.main, false);
    assert.equal(fromChild.spawnedBy, 'call_task');
  } finally {
    await closed(run);
  }
});

test('a turned-off tool asked for is refused without asking anyone', async () => {
  const [tool] = OPENCODE_DENIED_TOOLS;
  assert.ok(tool !== undefined);
  const run = await started({ fake: { calls: () => [{ id: 'call_off', name: tool }] } });
  try {
    run.process.prompt('go');
    await until(() => run.record.replies.length === 1, 'the answer');
    assert.equal(run.record.replies[0]?.decision, 'reject');
    assert.match(run.record.replies[0]?.message ?? '', /turned off/);
    assert.deepEqual(run.requests, []);
  } finally {
    await closed(run);
  }
});

test('the setters apply now: a listed model, the plan agent; an unlisted model, a mode opencode has not, an effort and a thinking switch are refused by name', async () => {
  const run = await started();
  try {
    await until(() => opened(run), 'the open');
    await run.process.setModel('stub-other');
    assert.deepEqual(run.record.of('session.switchModel').at(-1)?.['model'], {
      id: 'stub-other',
      providerID: 'endpoint-stub',
    });
    await assert.rejects(
      run.process.setModel('elsewhere'),
      /model elsewhere is not one the endpoint stub lists/,
    );
    await run.process.setPermissionMode('plan');
    assert.equal(run.record.of('session.switchAgent').at(-1)?.['agent'], 'plan');
    await assert.rejects(run.process.setPermissionMode('bypassPermissions'), /opencode takes default, plan/);
    await assert.rejects(
      run.process.setEffort('high'),
      /effort high: opencode sets reasoning through a model's variants/,
    );
    await assert.rejects(run.process.setThinking({ type: 'disabled' }), /no thinking switch/);
    await run.process.setThinking({ type: 'adaptive' });
    assert.equal(await run.process.pluginsApplied(), null);
  } finally {
    await closed(run);
  }
});

test('an interrupt reaches the server, and a decision still pending for the session ends refused', async () => {
  let release: () => void = () => undefined;
  const run = await started({
    fake: { calls: () => [{ id: 'call_wait', name: 'edit', input: { path: 'a.ts' } }] },
    decide: (_request, signal) =>
      new Promise((resolve) => {
        release = () => resolve({ behavior: 'allow' });
        signal.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'aborted' }), {
          once: true,
        });
      }),
  });
  try {
    run.process.prompt('go');
    await until(() => run.requests.length === 1, 'the pending decision');
    await run.process.interrupt();
    assert.equal(run.record.of('session.interrupt').length, 1);
    await until(() => run.record.replies.length === 1, 'the ended decision');
    assert.equal(run.record.replies[0]?.decision, 'reject');
    // The server dropped the request with the interrupt, so the answer found it gone: nothing failed to
    // arrive, and nothing is said.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      run.degrades,
      [],
      'an answer to a request the runtime had dropped was reported undelivered',
    );
    release();
  } finally {
    await closed(run);
  }
});

test("an interrupt reaches each subagent with a run under way, and ends the decisions the session's subagents wait on", async () => {
  const ended: string[] = [];
  const run = await started({
    decide: (_request, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            ended.push(String(signal.reason));
            resolve({ behavior: 'deny', message: 'ended' });
          },
          { once: true },
        );
      }),
  });
  try {
    await until(() => opened(run), 'the open');
    const child = run.record.spawn('call_spawn');
    const idle = run.record.spawn('call_spawn_idle');
    run.record.emit('session.execution.started', { sessionID: child });
    run.record.emit('session.execution.started', { sessionID: idle });
    run.record.emit('session.execution.succeeded', { sessionID: idle });
    const pending = run.record.ask({
      id: 'per_child',
      sessionID: child,
      action: 'read',
      resources: ['a.ts'],
    });
    await until(() => run.requests.length === 1, "the subagent's pending decision");
    await run.process.interrupt();
    assert.deepEqual(
      run.record
        .of('session.interrupt')
        .map((input) => input['sessionID'])
        .sort(),
      ['ses_main', child].sort(),
      'the interrupt reached the session alone, or a subagent that was not running',
    );
    // The server drops the subagent's request with the interrupt, and this host's decision ends with it.
    assert.equal((await pending).decision, 'interrupted');
    await until(() => ended.length === 1, "the subagent's decision to end");
    assert.match(
      ended[0] ?? '',
      /the turn was interrupted/,
      "the subagent's decision outlived the interrupt",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(run.degrades, []);
    // A subagent whose run has ended is not interrupted again.
    run.record.emit('session.execution.interrupted', { sessionID: child });
    await run.process.interrupt();
    assert.equal(run.record.of('session.interrupt').length, 3);
  } finally {
    await closed(run);
  }
});

test('a shell line the runtime reads no command in is decided before it runs: refused, it fails and never runs; allowed, it runs', async () => {
  const run = await started({
    fake: {
      calls: (prompt) => [
        // A line with no command raises no request of its own.
        { id: prompt, name: 'shell', input: { command: "${C:/work/f.txt} = 'x'" }, requests: [] },
      ],
    },
    decide: (request) =>
      Promise.resolve(
        request.toolUseId === 'refused'
          ? { behavior: 'deny', message: 'not that line' }
          : { behavior: 'allow' },
      ),
  });
  try {
    await until(() => opened(run), 'the open');
    assert.deepEqual(run.record.connects[0]?.gatedTools, ['shell']);
    run.process.prompt('refused');
    await until(() => eventsOf(run, 'session.execution.succeeded').length === 1, 'the first run');
    assert.deepEqual(run.record.held, [{ callId: 'refused', allow: false }]);
    assert.equal(run.requests[0]?.toolName, 'shell');
    assert.deepEqual(run.requests[0]?.toolInput, { command: "${C:/work/f.txt} = 'x'" });
    const failed = eventsOf(run, 'session.tool.failed')[0]?.data as { error?: { message?: string } };
    assert.equal(failed.error?.message, 'not that line');
    assert.equal(eventsOf(run, 'session.tool.success').length, 0, 'a refused line ran');
    run.process.prompt('allowed');
    await until(() => eventsOf(run, 'session.execution.succeeded').length === 2, 'the second run');
    assert.deepEqual(run.record.held[1], { callId: 'allowed', allow: true });
    assert.equal(eventsOf(run, 'session.tool.success').length, 1);
    assert.equal(run.requests.length, 2, 'each line was asked about once');
    assert.deepEqual(
      run.raised.filter((one) => one.name === 'gate-hook-missing'),
      [],
      'a line this host decided was named as one it did not',
    );
  } finally {
    await closed(run);
  }
});

test("a shell call's own requests are answered from the decision made before it ran: the decider is asked once", async () => {
  const run = await started({
    fake: {
      calls: () => [
        {
          id: 'call_1',
          name: 'shell',
          input: { command: 'git status', workdir: 'C:/elsewhere' },
          requests: [
            { action: 'external_directory', resources: ['C:/elsewhere/*'] },
            { action: 'shell', resources: ['git status'] },
          ],
        },
      ],
    },
  });
  try {
    run.process.prompt('go');
    await until(() => eventsOf(run, 'session.execution.succeeded').length === 1, 'the run');
    assert.equal(run.requests.length, 1, 'the same call was asked about more than once');
    assert.deepEqual(
      run.record.replies.map((reply) => reply.decision),
      ['once', 'once'],
    );
    assert.equal(eventsOf(run, 'session.tool.success').length, 1);
  } finally {
    await closed(run);
  }
});

test('a call held before the open is proven waits for the proof and is then decided like any other', async () => {
  const run = await started({
    fake: { heldAtConnect: { id: 'call_early', name: 'shell', input: { command: 'git status' } } },
  });
  try {
    await until(() => run.record.held.length === 1, "the early call's answer");
    assert.deepEqual(run.record.held, [{ callId: 'call_early', allow: true }]);
    assert.equal(run.requests[0]?.toolUseId, 'call_early');
    assert.ok(opened(run), 'the call was decided before the open was proven');
  } finally {
    await closed(run);
  }
});

test('a call held before the open is refused when the open is not proven, and nobody is asked', async () => {
  const run = await started({
    fake: {
      heldAtConnect: { id: 'call_early', name: 'shell', input: { command: 'git status' } },
      plugins: [{ id: 'a-package', source: { type: 'package' } }],
    },
  });
  await until(() => run.record.held.length === 1, "the early call's answer");
  assert.deepEqual(run.record.held, [{ callId: 'call_early', allow: false }]);
  assert.equal(run.requests.length, 0);
  assert.match((await run.ended)?.message ?? '', /opencode-gate-not-active/);
});

test('a call that ran with no request and no decision is named when it ends, and one still running is named at the close', async () => {
  let hold: () => void = () => undefined;
  const run = await started({
    fake: {
      calls: (prompt) =>
        prompt === 'ends'
          ? [{ id: 'call_quiet', name: 'todowrite', input: {}, requests: [] }]
          : [{ id: 'call_stuck', name: 'todowrite', input: {}, requests: [], waits: true }],
      release: (resume) => {
        hold = resume;
      },
    },
  });
  try {
    await until(() => opened(run), 'the open');
    run.process.prompt('ends');
    await until(() => eventsOf(run, 'session.execution.succeeded').length === 1, 'the first run');
    assert.deepEqual(
      run.raised.map((one) => one.name),
      ['gate-hook-missing'],
    );
    assert.match(run.raised[0]?.detail ?? '', /call_quiet \(todowrite\) ran with no decision/);
    run.process.prompt('stays');
    await until(() => eventsOf(run, 'session.tool.called').length === 2, 'the second call');
  } finally {
    await closed(run);
    hold();
  }
  assert.match(
    run.raised[1]?.detail ?? '',
    /call_stuck \(todowrite\) was still running when the session closed/,
  );
});

test('a request from a session this process did not see created is decided, not dropped, and an interrupt of that session ends its decision', async () => {
  const run = await started();
  try {
    await until(() => opened(run), 'the open');
    const answer = await run.record.ask({
      id: 'per_stranger',
      sessionID: 'ses_from_before',
      action: 'read',
      resources: ['a.ts'],
      callId: 'call_stranger',
    });
    assert.equal(answer.decision, 'once', 'the request was never answered');
    assert.equal(run.requests[0]?.toolUseId, 'call_stranger');
    assert.equal(
      run.requests[0]?.agentId,
      'ses_from_before',
      'the decision request names the session that asked',
    );
    assert.deepEqual(run.degrades, []);
  } finally {
    await closed(run);
  }
  const waitingRun = await started({ decide: () => new Promise(() => undefined) });
  try {
    await until(() => opened(waitingRun), 'the open');
    const pending = waitingRun.record.ask({ id: 'per_cut', sessionID: 'ses_from_before', action: 'read' });
    await until(() => waitingRun.requests.length === 1, 'the pending decision');
    waitingRun.record.emit('session.execution.interrupted', { sessionID: 'ses_from_before' });
    assert.equal((await pending).decision, 'reject');
  } finally {
    await closed(waitingRun);
  }
});

test('requests raised before this process read the stream are found at the open and decided, each once', async () => {
  const run = await started({
    request: { resume: 'ses_kept' },
    before: (base) => {
      mkdirSync(join(base, 'state', 'ses_kept'), { recursive: true });
      writeFileSync(join(base, 'state', 'ses_kept', 'session.db'), 'database');
    },
    fake: {
      waitingAtOpen: [
        {
          id: 'per_early',
          sessionID: 'ses_old_child',
          action: 'read',
          resources: ['a.ts'],
          callId: 'call_early',
        },
      ],
    },
  });
  try {
    await until(() => run.record.settled.length === 1, "the early request's answer");
    assert.deepEqual(run.record.settled, [{ requestID: 'per_early', decision: 'once' }]);
    assert.equal(run.requests.length, 1);
    assert.equal(run.requests[0]?.toolUseId, 'call_early');
    // The stream telling of the same request afterwards asks nobody again.
    run.record.emit('permission.asked', {
      id: 'per_early',
      sessionID: 'ses_old_child',
      action: 'read',
      resources: ['a.ts'],
      metadata: {},
      source: { id: 'call_early' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(run.requests.length, 1, 'the same request was decided twice');
    assert.equal(run.record.of('permission.request.list').length, 1);
  } finally {
    await closed(run);
  }
});

test('a request raised before the open is proven waits for the proof: decided once it holds, refused where it does not', async () => {
  const asked = { id: 'per_first', sessionID: 'ses_main', action: 'read' } as const;
  const run = await started({ fake: { askedAtConnect: asked } });
  try {
    await until(() => run.record.settled.length === 1, "the early request's answer");
    assert.equal(run.record.settled[0]?.decision, 'once');
    assert.equal(run.requests.length, 1);
    assert.ok(opened(run), 'the request was decided before the open was proven');
  } finally {
    await closed(run);
  }
  const refused = await started({
    fake: { askedAtConnect: asked, plugins: [{ id: 'a-package', source: { type: 'package' } }] },
  });
  assert.match((await refused.ended)?.message ?? '', /opencode-gate-not-active/);
  assert.equal(refused.requests.length, 0, 'a session that never opened asked its decider');
});

test("a resumed session takes the sessions an earlier process left as its own: each is given the shell's environment, and so is one it starts", async () => {
  const run = await started({
    request: { resume: 'ses_kept', env: { PATH: 'p', MARKER: 'm' } },
    before: (base) => {
      mkdirSync(join(base, 'state', 'ses_kept'), { recursive: true });
      writeFileSync(join(base, 'state', 'ses_kept', 'session.db'), 'database');
    },
    fake: {
      earlierSessions: [
        { id: 'ses_old_child', parentID: 'ses_kept' },
        { id: 'ses_old_grandchild', parentID: 'ses_old_child' },
        { id: 'ses_of_another', parentID: 'ses_not_this_one' },
      ],
    },
  });
  try {
    await until(() => opened(run), 'the open');
    const given = (): string[] =>
      run.record
        .of('session.environment')
        .map((input) => (typeof input['sessionID'] === 'string' ? input['sessionID'] : ''));
    await until(() => given().includes('ses_old_grandchild'), "the earlier sessions' environment");
    assert.deepEqual(given().sort(), ['ses_kept', 'ses_old_child', 'ses_old_grandchild']);
    // A session one of them starts now is the session's own too.
    run.record.emit('session.created', { sessionID: 'ses_new', parentID: 'ses_old_child', agent: 'general' });
    await until(() => given().includes('ses_new'), "the new subagent's environment");
  } finally {
    await closed(run);
  }
  // Control: a session that is not resumed reads no earlier sessions.
  const fresh = await started();
  try {
    await until(() => opened(fresh), 'the open');
    assert.equal(fresh.record.of('session.list').length, 0);
  } finally {
    await closed(fresh);
  }
});

test("a line of the host process's that was dropped is named on the session, once, and in the host's log each time", async () => {
  const run = await started();
  try {
    await until(() => opened(run), 'the open');
    run.record.dropLine('an inbound line passed 8388608 bytes and was dropped whole');
    run.record.dropLine('an inbound line passed 8388608 bytes and was dropped whole');
    assert.deepEqual(
      run.raised.map((one) => one.name),
      ['rpc-line-too-large'],
    );
    assert.equal(run.degrades.filter((detail) => /^rpc-line-too-large: /.test(detail)).length, 2);
  } finally {
    await closed(run);
  }
});

test("control: an answer of this host's own that the server refuses is still reported", async () => {
  const run = await started({ fake: { failing: { 'permission.reply': 'the server is busy' } } });
  try {
    await until(() => opened(run), 'the open');
    void run.record.ask({ id: 'per_1', sessionID: 'ses_main', action: 'read', resources: ['a.ts'] });
    await until(() => run.degrades.length === 1, 'the undelivered answer');
    assert.match(run.degrades[0] ?? '', /a permission answer was not delivered: .*the server is busy/);
  } finally {
    await closed(run);
  }
});

test("the pre-call gate missing from the server's plugins is named at the open, and the session opens", async () => {
  const run = await started({
    fake: { plugins: [{ id: 'opencode.tool.shell', source: { type: 'builtin' } }] },
  });
  try {
    await until(() => opened(run), 'the open');
    assert.deepEqual(
      run.raised.map((one) => one.name),
      ['gate-hook-missing'],
    );
    assert.match(run.raised[0]?.detail ?? '', /pre-call gate is not among the server's plugins/);
  } finally {
    await closed(run);
  }
});

test('the close interrupts the run, ends the host process and its tree, keeps the database for a resume and removes the home', async () => {
  const run = await started();
  await until(() => opened(run), 'the open');
  const home = readdirSync(join(run.base, 'sessions'));
  assert.equal(home.length, 1);
  const sessionHome = join(run.base, 'sessions', home[0] ?? '');
  writeFileSync(join(sessionHome, 'data', 'session.db'), 'database');
  writeFileSync(join(sessionHome, 'data', 'session.db-wal'), 'log');
  run.process.close();
  assert.equal(await run.ended, null);
  assert.deepEqual(run.record.of('session.interrupt'), [{ sessionID: 'ses_main' }]);
  assert.deepEqual(run.record.lifecycle, ['connect', 'close']);
  // The connection's close ends the host process and what it started; the session ends no tree by itself.
  assert.deepEqual(run.killed, []);
  assert.deepEqual(readdirSync(join(run.base, 'sessions')), [], 'the home was removed');
  assert.ok(existsSync(join(run.base, 'state', 'ses_main', 'session.db')));
  assert.ok(existsSync(join(run.base, 'state', 'ses_main', 'session.db-wal')));
  await rm(run.base, { recursive: true, force: true });
});

test('a resume carries the kept database in and reads the session rather than creating one; a fork forks it', async () => {
  const keep = (base: string): void => {
    mkdirSync(join(base, 'state', 'ses_kept'), { recursive: true });
    writeFileSync(join(base, 'state', 'ses_kept', 'session.db'), 'kept');
  };
  const resumed = await started({ request: { resume: 'ses_kept' }, before: keep });
  try {
    await until(() => opened(resumed), 'the resume');
    assert.deepEqual(resumed.record.of('session.create'), []);
    assert.deepEqual(resumed.record.of('session.get')[0], { sessionID: 'ses_kept' });
    const open = resumed.messages.find((message) => message.kind === 'opened');
    assert.equal(open?.kind === 'opened' ? open.origin : null, 'resume');
    const home = readdirSync(join(resumed.base, 'sessions'))[0] ?? '';
    assert.ok(
      existsSync(join(resumed.base, 'sessions', home, 'data', 'session.db')),
      'the database was carried in',
    );
  } finally {
    await closed(resumed);
  }
  const forked = await started({ request: { resume: 'ses_kept', fork: true }, before: keep });
  try {
    await until(() => opened(forked), 'the fork');
    assert.deepEqual(forked.record.of('session.fork'), [{ sessionID: 'ses_kept' }]);
    const open = forked.messages.find((message) => message.kind === 'opened');
    assert.deepEqual(open?.kind === 'opened' ? [open.sessionId, open.origin] : null, [
      'ses_kept-fork',
      'fork',
    ]);
  } finally {
    await closed(forked);
  }
});

test('a resume of a session whose database this host does not keep is refused, and starts nothing', async () => {
  const run = await started({ request: { resume: 'ses_never' } });
  const ended = await closed(run);
  assert.match(String(ended?.message), /^request-key-unsupported: resume names opencode session ses_never/);
  assert.equal(run.record.connects.length, 0);
});

test("a resumed session on the wrong agent is switched to the mode's before it opens", async () => {
  const keep = (base: string): void => {
    mkdirSync(join(base, 'state', 'ses_kept'), { recursive: true });
    writeFileSync(join(base, 'state', 'ses_kept', 'session.db'), 'kept');
  };
  const run = await started({
    request: { resume: 'ses_kept' },
    fake: { resumedAgent: 'plan' },
    before: keep,
  });
  try {
    await until(() => opened(run), 'the resume');
    assert.deepEqual(run.record.of('session.switchAgent'), [{ sessionID: 'ses_kept', agent: 'build' }]);
  } finally {
    await closed(run);
  }
});

test('the host process dying ends the session, naming the exit', async () => {
  const run = await started();
  await until(() => opened(run), 'the open');
  run.record.exit(3);
  const ended = await run.ended;
  assert.match(String(ended?.message), /the opencode host process exited/);
  await closed(run);
});

test("the server's stream ending while the process lives ends the session, naming why", async () => {
  const run = await started();
  await until(() => opened(run), 'the open');
  run.record.streamEnd('the stream broke');
  const ended = await run.ended;
  assert.match(
    String(ended?.message),
    /^runtime-unavailable: the opencode server's event stream ended \(the stream broke\)/,
  );
  await closed(run);
});

test('an open that meets no answer by its deadline ends the session, naming the call', async () => {
  const run = await started({ fake: { hanging: ['model.list'] }, runtime: { openDeadlineMs: 100 } });
  const ended = await run.ended;
  assert.match(
    String(ended?.message),
    /^runtime-unavailable: the opencode session could not open: model\.list met no answer within 100 ms/,
  );
  assert.equal(opened(run), false);
  await closed(run);
});

test('a host process that cannot open ends the session, naming why', async () => {
  const run = await started({ fake: { connectFailure: 'the SDK could not be loaded' } });
  const ended = await run.ended;
  assert.match(
    String(ended?.message),
    /^runtime-unavailable: the opencode host process did not open: the SDK could not be loaded/,
  );
  await closed(run);
});

test("a plugin that is not the runtime's own, loaded after the open, is named: gate-foreign-extension", async () => {
  const plugins: { id?: string; source: { type: string } }[] = [
    { id: 'opencode.tool.shell', source: { type: 'builtin' } },
  ];
  const run = await started({ fake: { plugins } });
  try {
    await until(() => opened(run), 'the open');
    plugins.push({ id: 'late', source: { type: 'file' } });
    run.record.emit('plugin.updated', {});
    await until(() => run.raised.some((one) => one.name === 'gate-foreign-extension'), 'the degrade');
    assert.match(run.raised.find((one) => one.name === 'gate-foreign-extension')?.detail ?? '', /late/);
  } finally {
    await closed(run);
  }
});

test('a form the server raises is cancelled as it is raised, with words, so nothing waits on an answer no one can give', async () => {
  const run = await started();
  try {
    await until(() => opened(run), 'the open');
    run.record.emit('form.created', {
      form: {
        id: 'frm_1',
        sessionID: 'ses_main',
        title: 'Web Search',
        metadata: { kind: 'websearch.provider' },
        fields: [],
      },
    });
    run.record.emit('form.created', {
      form: { id: 'frm_2', sessionID: 'global', title: 'docs is requesting input', fields: [] },
    });
    await until(() => run.record.of('session.form.cancel').length === 2, 'the cancels');
    assert.deepEqual(
      run.record.of('session.form.cancel').map((input) => [input['sessionID'], input['formID']]),
      [
        ['ses_main', 'frm_1'],
        ['global', 'frm_2'],
      ],
    );
    assert.ok(
      run.record
        .of('session.form.cancel')
        .every((input) => typeof input['message'] === 'string' && input['message'] !== ''),
    );
    await until(() => types(run).includes('form.created'), 'the form, riding as the native event it is');
  } finally {
    await closed(run);
  }
});

test("an instruction appended to the runtime's own prompt is handed over as a file inside the session's home", async () => {
  const run = await started({
    request: { systemPrompt: { type: 'preset', preset: 'runtime-default', append: 'Answer in one line.' } },
  });
  try {
    await until(() => opened(run), 'the open');
    const instructions = run.record.configs[0]?.['instructions'] as string[] | undefined;
    assert.equal(instructions?.length, 1);
    assert.ok(instructions?.[0]?.startsWith(join(run.base, 'sessions')));
  } finally {
    await closed(run);
  }
});
