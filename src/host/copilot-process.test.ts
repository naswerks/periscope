import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { RefusalReason } from '../core/refusal.js';
import { ok } from '../core/result.js';
import type { Decider } from '../gate/decision.js';
import { COPILOT_EXCLUDED_TOOLS } from '../gate/tool-kind.js';
import { fakeCopilot } from '../test-support/fake-copilot.js';
import type { FakeCopilotOptions, FakeCopilotRecord } from '../test-support/fake-copilot.js';
import { tempDir } from '../test-support/temp-dir.js';
import { waitFor } from '../test-support/ws-peer.js';
import type { AgentProcess, AgentProcessRequest } from './agent-process.js';
import type { CopilotEndpointRoute } from './copilot-endpoints.js';
import { COPILOT_PROBE_ID_PREFIX, createCopilotSessionGate } from './copilot-gate.js';
import type { CopilotRuntimeConfig } from './copilot-process.js';
import { copilotRequestProblem, startCopilotProcess } from './copilot-process.js';
import type { CopilotInstall } from './copilot-sdk.js';
import type { CopilotMessage } from './copilot-wire.js';

const ROOT = process.platform === 'win32' ? 'C:/work/session-1' : '/work/session-1';
const RUNTIME = process.platform === 'win32' ? 'C:/sdk/runtime.exe' : '/sdk/runtime';
const TOKEN = 'gho_token_value_never_in_the_environment';
const KEY = 'sk-endpoint-key-never-in-the-environment';

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
  readonly process: AgentProcess<CopilotMessage>;
  readonly record: FakeCopilotRecord;
  readonly messages: CopilotMessage[];
  readonly degrades: string[];
  readonly raised: { name: RefusalReason; detail: string }[];
  readonly tier: RefusalReason[];
  readonly killed: number[];
  readonly base: string;
  readonly ended: Promise<Error | null>;
}

interface Setup {
  readonly request?: Partial<AgentProcessRequest>;
  readonly fake?: FakeCopilotOptions;
  readonly runtime?: Partial<CopilotRuntimeConfig>;
  readonly decide?: Decider;
  readonly endpoint?: string | null;
  readonly writeRoots?: readonly string[];
  readonly noGate?: boolean;
  /** Prepares the base before the session starts. */
  readonly before?: (base: string) => void;
}

const allowAll: Decider = () => Promise.resolve({ behavior: 'allow' });

async function started(setup: Setup = {}): Promise<Started> {
  const base = await tempDir('copilot-base');
  setup.before?.(base);
  const { sdk, record } = fakeCopilot(setup.fake);
  const degrades: string[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const tier: RefusalReason[] = [];
  const killed: number[] = [];
  const request = processRequest(setup.request);
  const gate =
    setup.noGate === true
      ? null
      : createCopilotSessionGate({
          sessionKey: 'session-1',
          cwd: request.cwd,
          decide: setup.decide ?? allowAll,
          decisionTimeoutMs: 1_000,
          holdAfterMs: 10_000,
          servers: Object.keys(request.mcpServers ?? {}),
          onOutcome: () => undefined,
          onDegrade: (name, detail) => raised.push({ name, detail }),
          onSpawnDegrades: (names) => tier.push(...names),
        });
  const install: CopilotInstall = {
    directory: 'C:/sdk',
    entry: 'C:/sdk/index.js',
    runtime: RUNTIME,
    sdkVersion: '1.0.34',
    runtimeVersion: '1.0.112',
  };
  const process = startCopilotProcess(
    request,
    {
      sdk: 'C:/sdk',
      base,
      readInstall: () => ok(install),
      loadSdk: () => Promise.resolve(ok(sdk)),
      policyHooks: () => Promise.resolve([]),
      killTree: (pid) => {
        killed.push(pid);
        return Promise.resolve();
      },
      closeGraceMs: 200,
      ...setup.runtime,
    },
    (detail) => degrades.push(detail),
    setup.endpoint ?? null,
    gate,
    setup.writeRoots ?? [],
  );
  const messages: CopilotMessage[] = [];
  const ended = (async (): Promise<Error | null> => {
    try {
      for await (const message of process.messages) messages.push(message);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();
  return { process, record, messages, degrades, raised, tier, killed, base, ended };
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

/** Each value in `secrets` that appears in `env`, by the variable that holds it. */
function credentialsIn(env: Readonly<Record<string, string>>, secrets: readonly string[]): string[] {
  return Object.entries(env)
    .filter(([, value]) => secrets.some((secret) => value.includes(secret)))
    .map(([name]) => name);
}

test('members with no Copilot meaning are refused by name, never dropped', () => {
  const refused: [Partial<AgentProcessRequest>, RegExp][] = [
    [{ hooks: {} }, /^hooks:/],
    [{ settingSources: ['project'] }, /^settingSources:/],
    [{ strictMcpConfig: false }, /^strictMcpConfig:/],
    [{ systemPrompt: 'You are a pirate.' }, /^systemPrompt:/],
    [{ systemPrompt: { type: 'preset', preset: 'claude_code' } }, /^systemPrompt:/],
    [
      { permissionMode: 'bypassPermissions' },
      /^permissionMode bypassPermissions: Copilot takes default, plan/,
    ],
    [{ permissionMode: 'acceptEdits' }, /^permissionMode acceptEdits/],
    [{ thinking: { type: 'disabled' } }, /^thinking:/],
    [{ effort: 'turbo' }, /^effort turbo/],
    [{ fork: true }, /^fork:/],
  ];
  for (const [overrides, words] of refused) {
    assert.match(copilotRequestProblem(processRequest(overrides)) ?? '', words);
  }
  assert.equal(copilotRequestProblem(processRequest()), null);
  assert.equal(
    copilotRequestProblem(
      processRequest({
        permissionMode: 'plan',
        effort: 'high',
        thinking: { type: 'adaptive' },
        systemPrompt: { type: 'preset', preset: 'runtime-default', append: 'Be brief.' },
      }),
    ),
    null,
  );
});

test("the runtime starts from the operator's install, in empty mode, signed in as nobody, in a fresh home, and the session is created in the manual mode with nothing discovered", async () => {
  const run = await started({
    request: {
      model: 'gpt-5-mini',
      effort: 'medium',
      systemPrompt: { type: 'preset', preset: 'runtime-default', append: 'Be brief.' },
      mcpServers: {
        nas: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { authorization: 'Bearer t' } },
      },
    },
  });
  await waitFor(() => opened(run), 'the open');
  const [client] = run.record.clients;
  assert.equal(client?.mode, 'empty');
  assert.equal(client?.useLoggedInUser, false);
  assert.equal(client?.logLevel, 'error');
  assert.equal(client?.workingDirectory, ROOT);
  assert.ok(client?.baseDirectory.startsWith(join(run.base, 'sessions')), 'the home is under the base');
  assert.equal(run.record.connections[0]?.path, RUNTIME);
  const [config] = run.record.configs;
  assert.deepEqual(config?.availableTools, ['builtin:*', 'mcp:*']);
  assert.deepEqual(
    config?.excludedTools,
    COPILOT_EXCLUDED_TOOLS.map((tool) => `builtin:${tool}`),
  );
  assert.equal(config?.permissionMode, 'manual');
  assert.equal(config?.enableConfigDiscovery, false);
  assert.equal(config?.skipCustomInstructions, true);
  assert.equal(config?.enableSessionTelemetry, false);
  assert.equal(config?.enableSkills, false);
  assert.deepEqual(config?.systemMessage, { mode: 'append', content: 'Be brief.' });
  assert.equal(config?.model, 'gpt-5-mini');
  assert.equal(config?.reasoningEffort, 'medium');
  assert.deepEqual(config?.mcpServers, {
    nas: {
      type: 'http',
      url: 'http://127.0.0.1:9/mcp',
      headers: { authorization: 'Bearer t' },
      tools: ['*'],
    },
  });
  assert.equal(config?.gitHubTokenProvider, undefined, 'no token file configured, no provider');
  assert.equal(config?.provider, undefined);
  await closed(run);
});

test('the open is proven before it is reported: the read-back, then one probe call through the hook and the request, refused and never run', async () => {
  const run = await started();
  await waitFor(() => opened(run), 'the open');
  const [probe] = run.record.executed;
  assert.equal(probe?.name, 'view');
  assert.ok(probe?.toolCallId?.startsWith(COPILOT_PROBE_ID_PREFIX));
  assert.equal(run.record.answers[0]?.kind, 'hook');
  assert.equal(run.record.answers[0]?.answer.kind, 'reject');
  // None of the probe's events reach the session.
  for (const message of run.messages) {
    if (message.kind !== 'event') continue;
    assert.ok(
      !JSON.stringify(message.event).includes(COPILOT_PROBE_ID_PREFIX),
      `${message.event.type} carried the probe`,
    );
  }
  const open = run.messages.find((message) => message.kind === 'opened');
  assert.deepEqual(open, {
    kind: 'opened',
    sessionId: 'copilot-session-1',
    model: 'fake-model',
    agentMode: 'interactive',
    tools: ['powershell', 'view', 'create', 'edit', 'grep', 'glob'],
    origin: 'new',
  });
  assert.deepEqual(run.raised, []);
  assert.deepEqual(run.tier, []);
  await closed(run);
});

test('control: a hook that never fires refuses the open, and no prompt is ever sent', async () => {
  const run = await started({ fake: { hook: 'skip' } });
  run.process.prompt('held until the open');
  const ended = await run.ended;
  assert.match(
    ended?.message ?? '',
    /^copilot-gate-not-active: the probe call reached this host as a read request/,
  );
  assert.deepEqual(run.record.prompts, []);
  assert.equal(opened(run), false);
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['copilot-gate-not-active'],
  );
  await rm(run.base, { recursive: true, force: true });
});

test('control: a probe call the runtime runs although this host refused it refuses the open', async () => {
  const run = await started({ fake: { executeIgnoresAnswer: true } });
  const ended = await run.ended;
  assert.match(
    ended?.message ?? '',
    /^copilot-gate-not-active: the probe call this host refused ended success, not denied/,
  );
  await rm(run.base, { recursive: true, force: true });
});

test('control: each posture the read-back refuses ends the open by name, before any prompt', async () => {
  const postures: [FakeCopilotOptions, RegExp][] = [
    [{ permissionMode: 'allow-all' }, /permission mode is allow-all/],
    [{ agentMode: 'autopilot' }, /agent mode is autopilot/],
    [{ allowAll: { active: true } }, /approve-all grant/],
    [{ plugins: [{ name: 'p' }] }, /plugin/],
    [{ directories: [ROOT, 'C:/Users/someone/elsewhere'] }, /outside the session's roots/],
    [{ offeredTools: ['powershell', 'manage_schedule'] }, /offers manage_schedule/],
    [{ permissionModeResult: null }, /did not apply the manual permission mode/],
  ];
  for (const [fake, words] of postures) {
    const run = await started({ fake });
    run.process.prompt('never sent');
    const ended = await run.ended;
    assert.match(ended?.message ?? '', /^copilot-gate-not-active: /);
    assert.match(ended?.message ?? '', words);
    assert.deepEqual(run.record.prompts, []);
    assert.deepEqual(run.record.executed, [], 'no probe runs on a posture already refused');
    assert.ok(run.record.lifecycle.includes('forceStop'), 'the runtime is stopped');
    assert.deepEqual(readdirSync(join(run.base, 'sessions')), [], 'the home is removed');
    await rm(run.base, { recursive: true, force: true });
  }
});

test("a built-in the tables do not name does not refuse the open: it is named once, a server's tool is not taken for one, and its call is asked about like any other", async () => {
  const asked: string[] = [];
  const run = await started({
    request: { mcpServers: { docs: { type: 'http', url: 'http://127.0.0.1:9/mcp' } } },
    fake: {
      offeredTools: ['powershell', 'view', 'workspace_snapshot', 'telemetry_probe'],
      offeredServerTools: { docs: ['search', 'workspace_snapshot_of_docs'] },
      serverTools: { docs: ['search', 'workspace_snapshot_of_docs'] },
      calls: () => [{ toolName: 'workspace_snapshot', toolArgs: { depth: 1 }, toolCallId: 'call_unnamed' }],
    },
    decide: (request) => {
      asked.push(`${request.toolName}:${request.toolKind ?? ''}`);
      return Promise.resolve({ behavior: 'allow' });
    },
  });
  await waitFor(() => opened(run), 'the open');
  const named = run.raised.filter((one) => one.name === 'gate-tool-unnamed');
  assert.deepEqual(
    named.map((one) => /the tool (\S+),/.exec(one.detail)?.[1]),
    ['workspace_snapshot', 'telemetry_probe'],
    'each built-in the tables do not hold, and neither a table row nor a server tool',
  );
  assert.ok(
    named.every((one) => /Copilot offers the tool/.test(one.detail)),
    named.map((one) => one.detail).join(' | '),
  );
  // The session is open and takes a prompt; the unnamed tool's call goes for a decision and runs on an allow.
  run.process.prompt('go');
  await waitFor(() => types(run).includes('session.idle'), 'the run');
  assert.deepEqual(asked, ['workspace_snapshot:other']);
  assert.equal(
    run.record.answers.find((one) => one.toolCallId === 'call_unnamed')?.answer.kind,
    'approve-once',
  );
  assert.equal(
    run.raised.filter((one) => one.name === 'gate-tool-unnamed').length,
    2,
    'a tool already named is not named again when it is called',
  );
  assert.equal(await closed(run), null);
});

test('a directory the session writes to beside its own is admitted by the read-back', async () => {
  const run = await started({
    fake: { directories: [ROOT, 'C:/tmp/periscope'] },
    writeRoots: ['C:/tmp/periscope'],
  });
  await waitFor(() => opened(run), 'the open');
  await closed(run);
});

test('a runtime that builds its tool list lazily is asked to build it before the read-back', async () => {
  const run = await started({ fake: { lazyTools: true } });
  await waitFor(() => opened(run), 'the open');
  const open = run.messages.find((message) => message.kind === 'opened');
  assert.ok(open?.kind === 'opened' && open.tools.includes('view'));
  await closed(run);
});

test('a plan open sets the agent mode before the read-back, and reads plan back', async () => {
  const run = await started({ request: { permissionMode: 'plan' } });
  await waitFor(() => opened(run), 'the open');
  assert.deepEqual(run.record.modes, ['plan']);
  const open = run.messages.find((message) => message.kind === 'opened');
  assert.equal(open?.kind === 'opened' ? open.agentMode : null, 'plan');
  await closed(run);
});

test('prompts held before the open are sent after it, in order, each queued behind a running turn', async () => {
  const run = await started({ fake: { answer: 'hello' } });
  assert.equal(run.process.prompt('first'), true);
  assert.equal(run.process.prompt('second'), true);
  await waitFor(() => run.record.prompts.length === 2, 'both prompts');
  assert.deepEqual(run.record.prompts, ['first', 'second']);
  await waitFor(() => types(run).filter((type) => type === 'session.idle').length === 2, 'both runs');
  await closed(run);
  assert.equal(run.process.prompt('after close'), false);
});

test('a run that fails before the runtime takes its prompt does not hold a place in the queue', async () => {
  const run = await started({
    fake: {
      dropPrompt: {
        errorType: 'query',
        message: 'Execution failed: InvalidArg, No GitHub OAuth token or Copilot HMAC key provided',
      },
    },
  });
  await waitFor(() => opened(run), 'the open');
  for (let index = 0; index < 20; index += 1) {
    assert.equal(run.process.prompt(`prompt ${index}`), true, `prompt ${index} was refused`);
    await waitFor(
      () => types(run).filter((type) => type === 'session.idle').length === index + 1,
      `run ${index}`,
    );
  }
  await closed(run);
});

test("a call is decided by this host's gate: an approved one runs, a refused one fails with the gate's words", async () => {
  const run = await started({
    decide: (request) =>
      Promise.resolve(
        request.toolName === 'create'
          ? { behavior: 'deny', message: 'no writes today' }
          : { behavior: 'allow' },
      ),
    fake: {
      calls: () => [
        { toolName: 'view', toolArgs: { path: 'a.ts' }, toolCallId: 'call_read' },
        { toolName: 'create', toolArgs: { path: 'b.ts', file_text: 'x' }, toolCallId: 'call_write' },
      ],
    },
  });
  await waitFor(() => opened(run), 'the open');
  run.process.prompt('go');
  await waitFor(() => types(run).includes('session.idle'), 'the run');
  const answers = Object.fromEntries(run.record.answers.map((one) => [one.toolCallId, one.answer]));
  assert.deepEqual(answers['call_read'], { kind: 'approve-once' });
  assert.deepEqual(answers['call_write'], { kind: 'reject', feedback: 'no writes today' });
  await closed(run);
});

test("the setters: the agent mode, the effort and the model are the runtime's own calls, and what Copilot has no form for is refused", async () => {
  const run = await started({ request: { model: 'gpt-5-mini' } });
  await waitFor(() => opened(run), 'the open');
  await run.process.setPermissionMode('plan');
  await run.process.setPermissionMode('default');
  assert.deepEqual(run.record.modes, ['plan', 'interactive']);
  await assert.rejects(run.process.setPermissionMode('bypassPermissions'), /Copilot takes default, plan/);
  await run.process.setEffort('high');
  assert.deepEqual(run.record.efforts, ['high']);
  await assert.rejects(run.process.setEffort('turbo'), /Copilot takes low, medium, high, xhigh, max/);
  await run.process.setThinking({ type: 'adaptive' });
  await assert.rejects(run.process.setThinking({ type: 'disabled' }), /no thinking switch/);
  await run.process.setModel('claude-sonnet-4.6');
  await run.process.setModel(null);
  assert.deepEqual(run.record.models, ['claude-sonnet-4.6', 'gpt-5-mini']);
  await run.process.interrupt();
  assert.ok(run.record.lifecycle.includes('abort'));
  assert.equal(await run.process.pluginsApplied(), null);
  await closed(run);
});

test("close disconnects the session, ends the runtime's tree by its pid, stops the client, keeps the session's state and removes the home", async () => {
  const run = await started();
  await waitFor(() => opened(run), 'the open');
  const home = run.record.clients[0]?.baseDirectory ?? '';
  const state = join(home, 'session-state', 'copilot-session-1');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'events.jsonl'), '{}\n');
  run.process.close();
  assert.equal(await run.ended, null);
  assert.deepEqual(run.record.lifecycle.slice(-2), ['disconnect', 'forceStop']);
  assert.deepEqual(run.killed, [4242]);
  assert.equal(existsSync(home), false);
  assert.ok(existsSync(join(run.base, 'state', 'copilot-session-1', 'events.jsonl')));
  await rm(run.base, { recursive: true, force: true });
});

test('a runtime that exits under a live session ends it, named', async () => {
  const run = await started();
  await waitFor(() => opened(run), 'the open');
  run.record.exit(3);
  const ended = await run.ended;
  assert.match(ended?.message ?? '', /the Copilot runtime exited \(exit code 3\)/);
  await rm(run.base, { recursive: true, force: true });
});

test('a resume copies the kept state into the fresh home first; a fork forks it and resumes the fork; one with none kept is refused', async () => {
  const keep = (base: string): void => {
    mkdirSync(join(base, 'state', 'kept-1'), { recursive: true });
    writeFileSync(join(base, 'state', 'kept-1', 'events.jsonl'), '{}\n');
  };
  const resumed = await started({ request: { resume: 'kept-1' }, before: keep });
  await waitFor(() => opened(resumed), 'the resume');
  assert.deepEqual(resumed.record.resumed, ['kept-1']);
  const home = resumed.record.clients[0]?.baseDirectory ?? '';
  assert.ok(existsSync(join(home, 'session-state', 'kept-1', 'events.jsonl')));
  const open = resumed.messages.find((message) => message.kind === 'opened');
  assert.equal(open?.kind === 'opened' ? open.origin : null, 'resume');
  await closed(resumed);

  const forked = await started({ request: { resume: 'kept-1', fork: true }, before: keep });
  await waitFor(() => opened(forked), 'the fork');
  assert.deepEqual(forked.record.forked, ['kept-1']);
  assert.deepEqual(forked.record.resumed, ['kept-1-fork']);
  await closed(forked);

  const missing = await started({ request: { resume: 'never-kept' } });
  assert.match(
    (await missing.ended)?.message ?? '',
    /^request-key-unsupported: resume names Copilot session never-kept/,
  );
  await rm(missing.base, { recursive: true, force: true });
});

test("a machine-wide policy hook is named at the open, and lowers the session's tier", async () => {
  const run = await started({
    runtime: { policyHooks: () => Promise.resolve(['C:/ProgramData/GitHub/Copilot/policy.d/hooks.json']) },
  });
  await waitFor(() => opened(run), 'the open');
  assert.deepEqual(run.tier, ['gate-hook-foreign']);
  assert.match(run.raised[0]?.detail ?? '', /policy\.d\/hooks\.json/);
  await closed(run);
});

test("R2: with a token file and an endpoint key configured, neither value is in the runtime's environment; both ride the SDK's pipe", async () => {
  const route: CopilotEndpointRoute = {
    name: 'byok',
    wireApi: 'openai-chat',
    baseUrl: 'http://127.0.0.1:9/v1',
    models: ['local-model'],
    authToken: () => KEY,
  };
  const dir = await tempDir('copilot-token');
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, TOKEN);
  for (const endpoint of [null, 'byok']) {
    const run = await started({
      request: { env: { PATH: 'p', GH_TOKEN: TOKEN, COPILOT_GITHUB_TOKEN: TOKEN, MARKER: 'kept' } },
      runtime: { tokenFile, endpoints: [route] },
      endpoint,
    });
    await waitFor(() => opened(run), 'the open');
    const env = run.record.connections[0]?.env ?? {};
    assert.deepEqual(credentialsIn(env, [TOKEN, KEY]), [], "a credential reached the runtime's environment");
    assert.equal(env['MARKER'], 'kept', 'the environment is otherwise whole');
    const config = run.record.configs[0];
    if (endpoint === null) {
      assert.deepEqual(
        await config?.gitHubTokenProvider?.({ host: 'https://github.com', reason: 'startup' }),
        {
          kind: 'token',
          accessToken: TOKEN,
          expiresIn: 28_800,
        },
      );
    } else {
      assert.deepEqual(config?.provider, {
        type: 'openai',
        wireApi: 'completions',
        baseUrl: route.baseUrl,
        apiKey: KEY,
      });
      assert.equal(config?.gitHubTokenProvider, undefined, 'an endpoint session signs in to no GitHub');
      assert.equal(config?.model, 'local-model');
    }
    await closed(run);
  }
  // Control: the detector names a planted copy of the token under any name.
  assert.deepEqual(credentialsIn({ PATH: 'p', ANYTHING: `x${TOKEN}y` }, [TOKEN, KEY]), ['ANYTHING']);
  await rm(dir, { recursive: true, force: true });
});

test('an endpoint this runtime does not route, and a model the endpoint does not list, are refused', async () => {
  const unknown = await started({ endpoint: 'nowhere' });
  assert.match((await unknown.ended)?.message ?? '', /^endpoint-unknown: nowhere/);
  const route: CopilotEndpointRoute = {
    name: 'byok',
    wireApi: 'anthropic-messages',
    baseUrl: 'http://127.0.0.1:9',
    models: ['m1'],
    authToken: () => '',
  };
  const wrong = await started({
    endpoint: 'byok',
    runtime: { endpoints: [route] },
    request: { model: 'm2' },
  });
  assert.match((await wrong.ended)?.message ?? '', /model m2 is not one the endpoint byok lists/);
  await rm(unknown.base, { recursive: true, force: true });
  await rm(wrong.base, { recursive: true, force: true });
});

test('a session with no gate is refused: no call could be decided', async () => {
  const run = await started({ noGate: true });
  assert.match((await run.ended)?.message ?? '', /^copilot-gate-not-active: this session has no gate/);
  assert.deepEqual(run.record.clients, [], 'nothing was started');
  await rm(run.base, { recursive: true, force: true });
});

test('an install off the pin is refused before anything starts', async () => {
  const run = await started({
    runtime: {
      readInstall: () => ({ ok: false, refusal: { reason: 'runtime-unavailable', detail: 'off the pin' } }),
    },
  });
  assert.match((await run.ended)?.message ?? '', /^runtime-unavailable: off the pin/);
  assert.deepEqual(run.record.clients, []);
  await rm(run.base, { recursive: true, force: true });
});
