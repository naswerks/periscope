import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { JsonObject } from '../control/frames.js';
import type { RefusalReason } from '../core/refusal.js';
import type { Decider } from '../gate/decision.js';
import { PI_TOOL_FAMILIES, localGate } from '../gate/local.js';
import type { ControlTierLevel } from '../state/model.js';
import { fakePi } from '../test-support/fake-pi.js';
import type { FakePi, FakePiOptions } from '../test-support/fake-pi.js';
import { tempDir } from '../test-support/temp-dir.js';
import { waitFor } from '../test-support/ws-peer.js';
import type { AgentProcess, AgentProcessRequest } from './agent-process.js';
import { nodePathResolver } from './paths.js';
import { piExtensionPath } from './pi-binary.js';
import type { PiEndpointRoute } from './pi-endpoints.js';
import { PI_EXTENSION_CONFIG_VARIABLE } from './pi-extension.js';
import type { PiSessionGate } from './pi-gate.js';
import { createPiSessionGate } from './pi-gate.js';
import type { PiRuntimeConfig } from './pi-process.js';
import { piRequestProblem, startPiProcess } from './pi-process.js';
import type { PiMessage } from './pi-wire.js';

const BINARY = 'C:/tools/pi/dist/bundle/cli.js';
/** Absolute on this platform, so the jail and the protected set read them as a real run would. */
const ROOT = process.platform === 'win32' ? 'C:/work/session-1' : '/work/session-1';

function processRequest(overrides: Partial<AgentProcessRequest> = {}): AgentProcessRequest {
  return {
    cwd: ROOT,
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
  readonly process: AgentProcess<PiMessage>;
  readonly fake: FakePi;
  readonly gate: PiSessionGate | null;
  readonly messages: PiMessage[];
  readonly degrades: string[];
  readonly raised: { name: RefusalReason; detail: string }[];
  readonly tier: { names: RefusalReason[]; level: ControlTierLevel | null };
  readonly base: string;
  /** Settles with the error the stream ended with, or null for a clean end. */
  readonly ended: Promise<Error | null>;
}

interface Setup {
  readonly request?: Partial<AgentProcessRequest>;
  readonly fake?: FakePiOptions;
  readonly runtime?: Partial<PiRuntimeConfig>;
  readonly decide?: Decider;
  readonly protectedPaths?: readonly string[];
  readonly endpoint?: string | null;
  readonly noGate?: boolean;
  readonly decisionTimeoutMs?: number;
  readonly prepare?: (base: string) => void;
}

const allowAll: Decider = () => Promise.resolve({ behavior: 'allow' });

async function started(setup: Setup = {}): Promise<Started> {
  const base = await tempDir('pi-base');
  setup.prepare?.(base);
  const fake = fakePi(setup.fake);
  const degrades: string[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const tier: { names: RefusalReason[]; level: ControlTierLevel | null } = { names: [], level: null };
  const request = processRequest(setup.request);
  const gate: PiSessionGate | null =
    setup.noGate === true
      ? null
      : createPiSessionGate({
          sessionKey: 'session-1',
          cwd: request.cwd,
          decide: setup.decide ?? allowAll,
          localGate: localGate({
            workspaceRoot: request.cwd,
            resolve: nodePathResolver,
            protectedPaths: setup.protectedPaths ?? [],
            toolFamilies: PI_TOOL_FAMILIES,
            readsShellDialect: true,
            resolvesAgainstCallCwd: true,
            resolvesWritesAgainstCallCwd: true,
          }),
          decisionTimeoutMs: setup.decisionTimeoutMs ?? 2_000,
          holdAfterMs: 10_000,
          version: 'test',
          onOutcome: () => undefined,
          onDegrade: (name, detail) => raised.push({ name, detail }),
          onSpawnDegrades: (names, level) => {
            tier.names.push(...names);
            tier.level = level;
          },
        });
  const process = startPiProcess(
    request,
    {
      binary: BINARY,
      base,
      spawn: fake.spawn,
      killTree: () => Promise.resolve(),
      closeGraceMs: 30,
      helloDeadlineMs: 3_000,
      ...setup.runtime,
    },
    (detail) => degrades.push(detail),
    setup.endpoint ?? null,
    gate,
  );
  const messages: PiMessage[] = [];
  const ended = (async (): Promise<Error | null> => {
    try {
      for await (const message of process.messages) messages.push(message);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      gate?.close();
      await rm(base, { recursive: true, force: true });
    }
  })();
  return { process, fake, gate, messages, degrades, raised, tier, base, ended };
}

/** The session is open: the extension said hello and pi's state was read. */
async function opened(run: Started): Promise<void> {
  await waitFor(
    () => run.messages.some((message) => message.kind === 'response' && message.command === 'get_state'),
    'the session to open',
  );
}

async function closed(run: Started): Promise<Error | null> {
  run.process.close();
  return run.ended;
}

const events = (messages: readonly PiMessage[], type: string): JsonObject[] =>
  messages.flatMap((message) =>
    message.kind === 'event' && message.event['type'] === type ? [message.event] : [],
  );

const settledRuns = (run: Started): number => events(run.messages, 'agent_settled').length;

test("pi is launched with everything named: RPC mode, nothing of its own finding, pi's MCP extension and then this host's, the skills, the store, and the prompt in a file", async () => {
  const plugin = await tempDir('pi-plugin');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"pack"}');
  mkdirSync(join(plugin, 'skills', 'review'), { recursive: true });
  writeFileSync(join(plugin, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: x\n---\n');
  const append = 'You are the build session. Follow the rules.';
  const run = await started({
    request: {
      model: 'openrouter/example/model-1',
      effort: 'high',
      plugins: [{ type: 'local', path: plugin }],
      systemPrompt: { type: 'preset', preset: 'runtime-default', append },
    },
  });
  try {
    await opened(run);
    const spawned = run.fake.child.spawned;
    assert.ok(spawned !== null);
    assert.equal(spawned.command, process.execPath);
    const promptFile = run.fake.cli.argAfter('--append-system-prompt');
    assert.ok(
      promptFile !== null && promptFile.startsWith(join(run.base, 'run')),
      'the prompt rides a file in the run directory',
    );
    assert.deepEqual(spawned.args, [
      BINARY,
      '--mode',
      'rpc',
      '--no-extensions',
      '--no-skills',
      '--no-approve',
      '-e',
      'builtin:mcp',
      '-e',
      piExtensionPath(),
      '--skill',
      join(plugin, 'skills'),
      '--session-dir',
      join(run.base, 'sessions'),
      '--model',
      'openrouter/example/model-1',
      '--thinking',
      'high',
      '--append-system-prompt',
      promptFile,
    ]);
    assert.equal(readFileSync(promptFile, 'utf8'), append);
    assert.ok(
      !spawned.args.some((arg) => arg.includes(append)),
      "the controller's text is on pi's command line",
    );
    for (const flag of ['--no-mcp', '--approve', '--offline', '--no-context-files']) {
      assert.ok(!spawned.args.includes(flag), `${flag} must never be passed`);
    }
  } finally {
    await closed(run);
    await rm(plugin, { recursive: true, force: true });
  }
});

test("pi's environment names its agent home and the extension's configuration file, and holds neither the channel's token nor a ticket", async () => {
  const ticket = 'j1.abc.def';
  const run = await started({
    request: {
      mcpServers: { nas: { type: 'http', url: 'https://plane/mcp', headers: { 'X-Job-Ticket': ticket } } },
    },
  });
  try {
    await opened(run);
    const env = run.fake.child.spawned?.env ?? {};
    assert.equal(env['PI_CODING_AGENT_DIR'], join(run.base, 'agent'));
    assert.equal(env['PI_TELEMETRY'], '0');
    assert.equal(env['PI_SKIP_VERSION_CHECK'], '1');
    assert.equal(env['PATH'], 'p');
    const configFile = env[PI_EXTENSION_CONFIG_VARIABLE];
    assert.ok(configFile !== undefined && configFile.startsWith(join(run.base, 'run')));
    const token = run.gate?.token ?? '';
    assert.ok(token.length > 0);
    for (const value of Object.values(env)) {
      assert.ok(!value.includes(token), "the channel's token is in pi's environment");
      assert.ok(!value.includes(ticket), "the session's ticket is in pi's environment");
    }
    assert.ok(
      !run.fake.child.spawned?.args.some((arg) => arg.includes(ticket)),
      'the ticket is on the command line',
    );
    // Read once the extension has said hello, the configuration is gone.
    assert.equal(existsSync(configFile), false, "the extension's configuration outlived the hello");
  } finally {
    await closed(run);
  }
});

test("no prompt is written before the extension says hello; then pi's commands and state are read, in that order, and the session opens", async () => {
  const run = await started({ fake: { calls: () => [] } });
  try {
    assert.equal(run.process.prompt('first'), true, 'a prompt before the open is held');
    await opened(run);
    await waitFor(() => run.fake.cli.commandsOf('prompt').length === 1, 'the held prompt to be written');
    const order = run.fake.cli.received.map((line) => (typeof line['type'] === 'string' ? line['type'] : ''));
    assert.deepEqual(order.slice(0, 3), ['get_commands', 'get_state', 'prompt']);
    const kinds = run.messages
      .slice(0, 3)
      .map((message) => (message.kind === 'response' ? `response/${message.command}` : message.kind));
    assert.deepEqual(kinds, ['hello', 'response/get_commands', 'response/get_state']);
  } finally {
    await closed(run);
  }
});

test('control: an extension that never says hello refuses the open pi-extension-not-active, and no prompt is ever written', async () => {
  const run = await started({ fake: { loadNoExtension: true }, runtime: { helloDeadlineMs: 200 } });
  run.process.prompt('never sent');
  const error = await run.ended;
  assert.match(
    String(error?.message),
    /^pi-extension-not-active: .*did not say hello over its channel within 200ms/,
  );
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['pi-extension-not-active'],
  );
  assert.equal(run.fake.cli.commandsOf('prompt').length, 0, 'a prompt reached a pi with no gate');
});

test('pi refusing to load the extension refuses the open pi-extension-not-active, naming what pi said', async () => {
  const run = await started({ runtime: { extensionPath: join(ROOT, 'no-such-extension.js') } });
  run.process.prompt('never sent');
  const error = await run.ended;
  assert.match(
    String(error?.message),
    /^pi-extension-not-active: pi would not load this host's extension: Failed to load extension/,
  );
  assert.equal(run.fake.cli.commandsOf('prompt').length, 0);
});

test("pi ending before the hello for any other reason ends the session with pi's own words, never the refusal: the no-sign-in shape", async () => {
  const run = await started({
    fake: { startFailure: { stderr: 'No models available. Use /login to log into a provider', code: 1 } },
  });
  const error = await run.ended;
  assert.match(String(error?.message), /^the pi CLI exited \(exit code 1\): No models available/);
  assert.deepEqual(run.raised, []);
});

test('the open is refused before pi starts when no gate was composed for it', async () => {
  const run = await started({ noGate: true });
  const error = await run.ended;
  assert.match(String(error?.message), /^pi-extension-not-active:/);
  assert.equal(run.fake.spawned, false, 'pi was started with no gate');
});

test("every call is decided: a deny blocks with the host's reason, an allow runs it, and an allow that rewrites it runs the rewrite in place", async () => {
  const decide: Decider = (request) => {
    const input = request.toolInput as Record<string, unknown>;
    if (request.toolName === 'bash' && input['command'] === 'echo deny-me') {
      return Promise.resolve({ behavior: 'deny', message: 'not that' });
    }
    if (request.toolName === 'write') {
      return Promise.resolve({ behavior: 'allow', updatedInput: { path: 'safe.txt', content: 'rewritten' } });
    }
    return Promise.resolve({ behavior: 'allow' });
  };
  const run = await started({
    decide,
    fake: {
      calls: () => [
        { toolName: 'bash', input: { command: 'echo deny-me' } },
        { toolName: 'bash', input: { command: 'git status' } },
        { toolName: 'write', input: { path: 'out.txt', content: 'original' } },
      ],
    },
  });
  try {
    await opened(run);
    run.process.prompt('go');
    await waitFor(() => settledRuns(run) === 1, 'the run to settle');
    assert.deepEqual(
      run.fake.cli.blocked.map((one) => [one.toolName, one.reason]),
      [['bash', 'not that']],
    );
    assert.deepEqual(
      run.fake.cli.ran.map((one) => [one.toolName, one.input]),
      [
        ['bash', { command: 'git status' }],
        ['write', { path: 'safe.txt', content: 'rewritten' }],
      ],
    );
  } finally {
    await closed(run);
  }
});

test("the host's deadline blocks a call no decision reached in time", async () => {
  const run = await started({
    decide: (_request, signal) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve({ behavior: 'allow' }))),
    decisionTimeoutMs: 150,
    fake: { calls: () => [{ toolName: 'bash', input: { command: 'git status' } }] },
  });
  try {
    await opened(run);
    run.process.prompt('go');
    await waitFor(() => settledRuns(run) === 1, 'the run to settle');
    assert.equal(run.fake.cli.ran.length, 0, 'a call ran with no decision');
    assert.match(run.fake.cli.blocked[0]?.reason ?? '', /^hook_timed_out:/);
  } finally {
    await closed(run);
  }
});

test("an interrupt blocks a call still being decided at once: the run's abort does not wait on the decision", async () => {
  let asked = false;
  const run = await started({
    decide: () => {
      asked = true;
      return new Promise(() => undefined);
    },
    decisionTimeoutMs: 30_000,
    fake: { calls: () => [{ toolName: 'bash', input: { command: 'sleep 100' } }] },
  });
  try {
    await opened(run);
    run.process.prompt('go');
    await waitFor(() => asked, 'the call to be asked about');
    const began = Date.now();
    await run.process.interrupt();
    assert.ok(Date.now() - began < 5_000, 'the interrupt waited on the decision');
    await waitFor(() => settledRuns(run) === 1, 'the run to settle');
    assert.equal(events(run.messages, 'agent_settled')[0]?.['aborted'], true);
    assert.equal(run.fake.cli.ran.length, 0);
    assert.match(run.fake.cli.blocked[0]?.reason ?? '', /interrupted before this call was decided/);
  } finally {
    await closed(run);
  }
});

test('a shell command sent beside the tool calls (the bash command) is refused by the extension, and nothing runs', async () => {
  const run = await started();
  try {
    await opened(run);
    run.fake.cli.receive({ type: 'bash', id: 'outside-1', command: 'echo MARKER' });
    await waitFor(
      () =>
        run.messages.some(
          (message) => message.kind === 'record' && message.record['type'] === 'extension_error',
        ),
      'the refusal to be reported',
    );
    assert.deepEqual(run.fake.cli.bashRan, [], 'the bash command ran');
  } finally {
    await closed(run);
  }
});

test("the session's MCP servers reach the extension, which registers each with its tools declared by name and every value written as pi reads it", async () => {
  const run = await started({
    request: {
      mcpServers: {
        nas: { type: 'http', url: 'https://plane/mcp', headers: { 'X-Job-Ticket': '!tick$et' } },
        local: { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: '$HOME' } },
      },
    },
  });
  try {
    await opened(run);
    assert.deepEqual(run.fake.cli.servers, [
      {
        name: 'nas',
        config: {
          type: 'http',
          url: 'https://plane/mcp',
          headers: { 'X-Job-Ticket': '$!tick$$et' },
          exposure: 'direct',
        },
      },
      {
        name: 'local',
        config: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { TOKEN: '$$HOME' },
          exposure: 'direct',
        },
      },
    ]);
  } finally {
    await closed(run);
  }
});

test('every prompt rides prompt with followUp, one at a time: the next is written once pi has answered the last', async () => {
  const run = await started({ fake: { calls: () => [] } });
  try {
    await opened(run);
    run.process.prompt('one');
    run.process.prompt('two');
    await waitFor(() => run.fake.cli.commandsOf('prompt').length === 2, 'both prompts to be written');
    for (const line of run.fake.cli.commandsOf('prompt')) {
      assert.equal(line['streamingBehavior'], 'followUp');
    }
    assert.equal(run.fake.cli.commandsOf('follow_up').length, 0, 'a follow_up while idle starts nothing');
    await waitFor(
      () =>
        run.messages.filter((message) => message.kind === 'response' && message.command === 'prompt')
          .length === 2,
      'both answers',
    );
  } finally {
    await closed(run);
  }
});

test("a prompt pi will not take is a response on the wire with pi's words: the sign-in shape", async () => {
  const run = await started({ fake: { promptError: 'No API key found for openrouter.' } });
  try {
    await opened(run);
    run.process.prompt('hello');
    await waitFor(
      () =>
        run.messages.some(
          (message) =>
            message.kind === 'response' &&
            message.command === 'prompt' &&
            message.response['success'] === false,
        ),
      'the refused prompt',
    );
  } finally {
    await closed(run);
  }
});

test('after each run pi is asked its totals', async () => {
  const run = await started({ fake: { calls: () => [] } });
  try {
    await opened(run);
    run.process.prompt('hello');
    await waitFor(
      () =>
        run.messages.some(
          (message) => message.kind === 'response' && message.command === 'get_session_stats',
        ),
      'the totals',
    );
  } finally {
    await closed(run);
  }
});

test("a session that did not ask for partial messages is sent none of pi's streamed deltas", async () => {
  const run = await started({ request: { includePartialMessages: false } });
  try {
    await opened(run);
    run.fake.cli.write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
    run.fake.cli.write({ type: 'queue_update', steering: [], followUp: [] });
    await waitFor(() => events(run.messages, 'queue_update').length === 1, 'the event behind it');
    assert.equal(events(run.messages, 'message_update').length, 0);
  } finally {
    await closed(run);
  }
});

test("an extension's dialog is answered cancelled at once, and its notification rides as a record", async () => {
  const run = await started();
  try {
    await opened(run);
    run.fake.cli.write({
      type: 'extension_ui_request',
      id: 'ask-1',
      method: 'confirm',
      title: 'Sign in?',
      message: 'x',
    });
    run.fake.cli.write({
      type: 'extension_ui_request',
      id: 'say-1',
      method: 'notify',
      message: 'needs sign-in',
      notifyType: 'warning',
    });
    await waitFor(
      () => run.fake.cli.commandsOf('extension_ui_response').length === 1,
      'the dialog to be answered',
    );
    assert.deepEqual(run.fake.cli.commandsOf('extension_ui_response')[0], {
      type: 'extension_ui_response',
      id: 'ask-1',
      cancelled: true,
    });
    await waitFor(
      () => run.messages.filter((message) => message.kind === 'record').length === 2,
      'both records to ride',
    );
  } finally {
    await closed(run);
  }
});

test('the setters apply now: the model by provider and id, thinking and effort on one ladder with the last one winning, and no permission mode', async () => {
  const run = await started({ request: { effort: 'low' } });
  try {
    await opened(run);
    await run.process.setModel('anthropic/claude-example');
    assert.deepEqual(run.fake.cli.commandsOf('set_model').at(-1), {
      id: run.fake.cli.commandsOf('set_model').at(-1)?.['id'] ?? '',
      type: 'set_model',
      provider: 'anthropic',
      modelId: 'claude-example',
    });
    await run.process.setThinking({ type: 'disabled' });
    await run.process.setEffort('high');
    await run.process.setThinking({ type: 'disabled' });
    await run.process.setThinking({ type: 'adaptive' });
    assert.deepEqual(
      run.fake.cli.commandsOf('set_thinking_level').map((line) => line['level']),
      ['off', 'high', 'off', 'high'],
    );
    await assert.rejects(run.process.setPermissionMode('plan'), /pi has no permission modes/);
    await assert.rejects(run.process.setEffort('off'), /pi takes minimal, low, medium, high, xhigh, max/);
    assert.ok(
      run.messages.some((message) => message.kind === 'response' && message.command === 'set_model'),
      "the model's answer rides, for the receipt",
    );
  } finally {
    await closed(run);
  }
});

test('the open names code this host did not load, and the session starts below its tier with it: a foreign command, and a foreign tool', async () => {
  for (const fake of [
    { foreignCommands: [{ name: 'deploy', path: join(ROOT, '.pi', 'extensions', 'deploy.ts') }] },
    { foreignTools: [{ name: 'exfiltrate', path: join(ROOT, 'other.js') }] },
  ] satisfies FakePiOptions[]) {
    const run = await started({ fake });
    try {
      await opened(run);
      assert.deepEqual(run.tier.names, ['gate-foreign-extension']);
      assert.equal(run.tier.level, 'intercepted-with-residual');
      assert.match(run.raised[0]?.detail ?? '', /code this host did not load/);
    } finally {
      await closed(run);
    }
  }
});

test("control: a session with nothing foreign states no degrade and keeps the runtime's tier", async () => {
  const run = await started();
  try {
    await opened(run);
    assert.deepEqual(run.tier.names, []);
    assert.equal(run.tier.level, null);
  } finally {
    await closed(run);
  }
});

test("a session on an endpoint opens on it by name, and the endpoint's own variables are named at the open", async () => {
  const route: PiEndpointRoute = {
    name: 'openrouter-main',
    wireApi: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-chat'],
    env: { OPENROUTER_REGION: 'eu' },
    authToken: () => 'sk-or-key',
  };
  const run = await started({ runtime: { endpoints: [route] }, endpoint: 'openrouter-main' });
  try {
    await opened(run);
    assert.equal(run.fake.cli.argAfter('--provider'), 'openrouter-main');
    assert.equal(run.fake.cli.argAfter('--model'), 'deepseek/deepseek-chat');
    assert.ok(!run.fake.child.spawned?.args.includes('sk-or-key'));
    assert.deepEqual(run.tier.names, ['gate-credential-in-shell']);
    assert.equal(run.tier.level, 'intercepted-with-residual');
  } finally {
    await closed(run);
  }
});

test('the plugins applied once the session lists every skill handed over; a directory with none is not applied', async () => {
  const plugin = await tempDir('pi-plugin');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"pack"}');
  mkdirSync(join(plugin, 'skills', 'code-review'), { recursive: true });
  writeFileSync(
    join(plugin, 'skills', 'code-review', 'SKILL.md'),
    '---\nname: code-review\ndescription: x\n---\n',
  );
  const bare = await tempDir('pi-bare');
  mkdirSync(join(bare, '.claude-plugin'), { recursive: true });
  writeFileSync(join(bare, '.claude-plugin', 'plugin.json'), '{"name":"bare"}');
  try {
    const run = await started({ request: { plugins: [{ type: 'local', path: plugin }] } });
    assert.equal(await run.process.pluginsApplied(), true);
    await closed(run);
    const partly = await started({
      request: {
        plugins: [
          { type: 'local', path: plugin },
          { type: 'local', path: bare },
        ],
      },
    });
    assert.equal(await partly.process.pluginsApplied(), false);
    await closed(partly);
  } finally {
    await rm(plugin, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});

test("a resume opens the session's file by path, when it ran here; one that ran elsewhere is refused by name, and a fork takes it from anywhere", async () => {
  const id = '01999999-0000-7000-8000-0000000000aa';
  const file = `2026-10-14T00-00-00-000Z_${id}.jsonl`;
  const write = (cwd: string) => (base: string) => {
    mkdirSync(join(base, 'sessions'), { recursive: true });
    writeFileSync(
      join(base, 'sessions', file),
      `${JSON.stringify({ type: 'session', version: 3, id, timestamp: 't', cwd })}\n`,
    );
  };
  const here = await started({ request: { resume: id }, prepare: write(ROOT) });
  try {
    await opened(here);
    assert.equal(here.fake.cli.argAfter('--session'), join(here.base, 'sessions', file));
  } finally {
    await closed(here);
  }
  const elsewhere = await started({ request: { resume: id }, prepare: write('/somewhere/else') });
  const error = await elsewhere.ended;
  assert.match(
    String(error?.message),
    /^request-key-unsupported: resume: session .* ran in \/somewhere\/else/,
  );
  assert.equal(elsewhere.fake.spawned, false);
  const forked = await started({ request: { resume: id, fork: true }, prepare: write('/somewhere/else') });
  try {
    await opened(forked);
    assert.equal(forked.fake.cli.argAfter('--fork'), join(forked.base, 'sessions', file));
    assert.equal(forked.fake.cli.argAfter('--session'), null);
  } finally {
    await closed(forked);
  }
});

test('the twenty request keys: each one pi cannot honour is refused by name, and the one it has no use for is named', () => {
  const refused: [Partial<AgentProcessRequest>, RegExp][] = [
    [{ hooks: {} }, /^hooks:/],
    [{ sessionStore: {} as never }, /^sessionStore:/],
    [{ sessionStoreFlush: 'eager' }, /^sessionStoreFlush:/],
    [{ spawn: (() => undefined) as never }, /^spawn:/],
    [{ settingSources: ['project'] }, /^settingSources:/],
    [{ forwardSubagentText: true }, /^forwardSubagentText:/],
    [{ permissionMode: 'default' }, /^permissionMode default: pi has no permission modes/],
    [{ effort: 'ultra' }, /^effort ultra:/],
    [{ systemPrompt: { type: 'preset', preset: 'claude_code' } as never }, /^systemPrompt:/],
  ];
  for (const [overrides, expected] of refused) {
    assert.match(
      piRequestProblem(processRequest(overrides)) ?? '',
      expected,
      JSON.stringify(Object.keys(overrides)),
    );
  }
  for (const honoured of [
    {},
    { model: 'openrouter/x' },
    { effort: 'max' },
    { thinking: { type: 'disabled' } },
    { systemPrompt: 'replace it' },
    { includePartialMessages: false },
    { resume: 'x' },
    { fork: true },
  ] satisfies Partial<AgentProcessRequest>[]) {
    assert.equal(piRequestProblem(processRequest(honoured)), null, JSON.stringify(honoured));
  }
  // Accepted and read by nothing, either way: pi reads no MCP file of the workspace's and its agent home
  // lists none, so a session has only the servers it names whatever this says.
  for (const ignored of [
    { strictMcpConfig: false },
    { strictMcpConfig: true },
  ] satisfies Partial<AgentProcessRequest>[]) {
    assert.equal(piRequestProblem(processRequest(ignored)), null, JSON.stringify(ignored));
  }
});

test('closing ends pi and removes the run directory', async () => {
  const run = await started();
  await opened(run);
  const runs = readdirSync(join(run.base, 'run'));
  assert.equal(runs.length, 1);
  const dir = join(run.base, 'run', runs[0] ?? '');
  run.process.close();
  await waitFor(() => run.fake.child.stdinEnded, "pi's input to end");
  await waitFor(() => !existsSync(dir), 'the run directory to be removed');
  assert.equal(await run.ended, null);
});
