import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { JsonObject } from '../control/frames.js';
import type { RefusalReason } from '../core/refusal.js';
import type { Decider } from '../gate/decision.js';
import { localGate } from '../gate/local.js';
import { QWEN_TOOL_FAMILIES } from '../gate/local.js';
import { fakeQwen } from '../test-support/fake-qwen.js';
import type { FakeQwen, FakeQwenOptions } from '../test-support/fake-qwen.js';
import { tempDir } from '../test-support/temp-dir.js';
import { waitFor } from '../test-support/ws-peer.js';
import type { AgentProcess, AgentProcessRequest } from './agent-process.js';
import { nodePathResolver } from './paths.js';
import type { QwenEndpointRoute } from './qwen-endpoints.js';
import type { QwenSessionGate } from './qwen-gate.js';
import { createQwenSessionGate } from './qwen-gate.js';
import { qwenAskRules } from './qwen-home.js';
import { QWEN_NAMES } from './qwen-names.js';
import type { QwenRuntimeConfig } from './qwen-process.js';
import { QWEN_NO_SERVER, qwenRequestProblem, startQwenProcess } from './qwen-process.js';
import type { QwenMessage } from './qwen-wire.js';

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

const BINARY = 'C:/tools/qwen/cli-entry.js';
/** Absolute on this platform, so the jail and the protected set read them as a real run would. */
const ROOT = process.platform === 'win32' ? 'C:/work/session-1' : '/work/session-1';
const CREDS =
  process.platform === 'win32' ? 'C:/Users/op/.qwen/oauth_creds.json' : '/home/op/.qwen/oauth_creds.json';

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
  readonly process: AgentProcess<QwenMessage>;
  readonly fake: FakeQwen;
  readonly messages: QwenMessage[];
  readonly degrades: string[];
  readonly raised: { name: RefusalReason; detail: string }[];
  readonly tier: RefusalReason[];
  readonly base: string;
  /** Settles with the error the stream ended with, or null for a clean end. */
  readonly ended: Promise<Error | null>;
}

interface Setup {
  readonly request?: Partial<AgentProcessRequest>;
  readonly fake?: FakeQwenOptions;
  readonly runtime?: Partial<QwenRuntimeConfig>;
  readonly decide?: Decider;
  readonly protectedPaths?: readonly string[];
  readonly endpoint?: string | null;
  readonly noGate?: boolean;
}

const allowAll: Decider = () => Promise.resolve({ behavior: 'allow' });

async function started(setup: Setup = {}): Promise<Started> {
  const base = await tempDir('qwen-base');
  const operatorHome = await tempDir('qwen-operator');
  const fake = fakeQwen(setup.fake);
  const degrades: string[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const tier: RefusalReason[] = [];
  const request = processRequest(setup.request);
  const gate: QwenSessionGate | null =
    setup.noGate === true
      ? null
      : createQwenSessionGate({
          sessionKey: 'session-1',
          cwd: request.cwd,
          decide: setup.decide ?? allowAll,
          localGate: localGate({
            workspaceRoot: request.cwd,
            resolve: nodePathResolver,
            protectedPaths: setup.protectedPaths ?? [],
            home: operatorHome,
            toolFamilies: QWEN_TOOL_FAMILIES,
            readsShellDialect: true,
            checksShellDirectory: true,
            resolvesAgainstCallCwd: true,
          }),
          decisionTimeoutMs: 1_000,
          holdAfterMs: 10_000,
          askRules: qwenAskRules(Object.keys(request.mcpServers ?? {})),
          onOutcome: () => undefined,
          onDegrade: (name, detail) => raised.push({ name, detail }),
          onSpawnDegrades: (names) => tier.push(...names),
        });
  const process = startQwenProcess(
    request,
    {
      binary: BINARY,
      base,
      operatorHome,
      spawn: fake.spawn,
      killTree: () => Promise.resolve(),
      closeGraceMs: 30,
      ...setup.runtime,
    },
    (detail) => degrades.push(detail),
    setup.endpoint ?? null,
    gate,
  );
  const messages: QwenMessage[] = [];
  const ended = (async (): Promise<Error | null> => {
    try {
      for await (const message of process.messages) messages.push(message);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(operatorHome, { recursive: true, force: true });
    }
  })();
  return { process, fake, messages, degrades, raised, tier, base, ended };
}

const results = (messages: readonly QwenMessage[]): JsonObject[] =>
  messages.flatMap((message) =>
    message.kind === 'message' && message.message['type'] === 'result' ? [message.message] : [],
  );

async function closed(run: Started): Promise<Error | null> {
  run.process.close();
  return run.ended;
}

test('the CLI is started with stream-json both ways, its approval mode and model, the session home in its environment, and never a variable that would drop its rules', async () => {
  const run = await started({
    request: { model: 'qwen3-coder-plus', env: { PATH: 'p', QWEN_CODE_SAFE_MODE: '1' } },
  });
  await waitFor(() => run.fake.child.spawned !== null, 'the CLI to be spawned');
  const spawned = run.fake.child.spawned;
  assert.ok(spawned !== null);
  assert.equal(spawned.command, process.execPath);
  assert.deepEqual(spawned.args.slice(0, 8), [
    BINARY,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--channel=SDK',
    '--approval-mode',
    'default',
  ]);
  assert.ok(spawned.args.includes('--model') && spawned.args.includes('qwen3-coder-plus'));
  assert.ok(spawned.args.includes('--include-partial-messages'));
  assert.equal(spawned.env['QWEN_CODE_NO_RELAUNCH'], '1');
  assert.equal(spawned.env['QWEN_USAGE_STATISTICS_ENABLED'], 'false');
  assert.equal(spawned.env['QWEN_CODE_SAFE_MODE'], undefined);
  const home = spawned.env['QWEN_HOME'];
  assert.ok(home !== undefined && home.startsWith(join(run.base, 'sessions')));
  assert.equal(spawned.env['QWEN_RUNTIME_DIR'], join(run.base, 'runtime'));
  assert.equal(spawned.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'], join(home, 'system-settings.json'));
  assert.equal(await closed(run), null);
});

test('initialize is the first line the CLI reads, with the permission timeout above the decision deadline, the effort and the MCP servers as httpUrl', async () => {
  const run = await started({
    request: {
      effort: 'high',
      mcpServers: { nas: { type: 'http', url: 'https://plane/mcp', headers: { 'X-Job-Ticket': 't' } } },
    },
  });
  await waitFor(() => run.fake.child.received.length > 0, 'a line to the CLI');
  const first = run.fake.child.received[0];
  assert.equal(first?.['type'], 'control_request');
  const request = first?.['request'] as JsonObject;
  assert.equal(request['subtype'], 'initialize');
  assert.deepEqual(request['timeout'], { canUseTool: 6_000 });
  assert.equal(request['effort'], 'high');
  assert.deepEqual(request['mcpServers'], {
    nas: { httpUrl: 'https://plane/mcp', headers: { 'X-Job-Ticket': 't' } },
  });
  // The header rides the CLI's input only: its command line names the server, never its ticket.
  assert.equal(run.fake.child.spawned?.args.join(' ').includes('X-Job-Ticket'), false);
  assert.equal(await closed(run), null);
});

test('a prompt sent before initialize is answered is held, then written after it, so the CLI never runs without control requests', async () => {
  const run = await started();
  assert.equal(run.process.prompt('first'), true);
  await waitFor(() => results(run.messages).length === 1, 'the first result');
  assert.equal(run.fake.cli.directMode, false);
  assert.deepEqual(run.fake.cli.prompts, ['first']);
  assert.equal(await closed(run), null);
});

test('every call the CLI allows by default reaches the shared decision: a read of a credential file and a read-only cat of it are refused there', async () => {
  const run = await started({
    protectedPaths: [CREDS],
    fake: {
      calls: () => [
        { name: 'read_file', input: { file_path: CREDS }, defaultAllowed: true },
        { name: 'run_shell_command', input: { command: `cat ${CREDS}` }, defaultAllowed: true },
        { name: 'glob', input: { pattern: '*.ts' }, defaultAllowed: true },
      ],
    },
  });
  run.process.prompt('read it');
  await waitFor(() => results(run.messages).length === 1, 'the result');
  // Every call asked: none ran on the CLI's own say.
  assert.deepEqual(
    run.fake.cli.decided.map((one) => one.request['tool_name']),
    ['read_file', 'run_shell_command', 'glob'],
  );
  assert.deepEqual(
    run.fake.cli.decided.map((one) => one.answer['behavior']),
    ['deny', 'deny', 'allow'],
  );
  assert.match(textOf(run.fake.cli.decided[0]?.answer['message']), /^credential-path-denied:/);
  assert.deepEqual(
    run.fake.cli.ran.map((one) => [one.toolName, one.asked]),
    [['glob', true]],
  );
  assert.equal(await closed(run), null);
});

test('the settings are read back before the CLI starts: a file missing one rule refuses the open qwen-ask-rules-not-active and starts nothing', async () => {
  const run = await started({
    runtime: {
      readSettings: (path) => {
        const read = JSON.parse(readFileSync(path, 'utf8')) as { permissions: { ask: string[] } };
        read.permissions.ask = read.permissions.ask.filter((rule) => rule !== 'read_file');
        return JSON.stringify(read);
      },
    },
  });
  run.process.prompt('never sent');
  const error = await run.ended;
  assert.match(
    String(error?.message),
    /^qwen-ask-rules-not-active: .*no ask rule for 1 name\(s\): read_file/,
  );
  assert.equal(run.fake.child.spawned, null);
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['qwen-ask-rules-not-active'],
  );
});

test('the settings name every built-in tool and every attached server as one to ask about, and turn every hook off', async () => {
  const run = await started({
    request: { mcpServers: { nas: { type: 'http', url: 'https://plane/mcp' } } },
  });
  await waitFor(() => run.fake.child.spawned !== null, 'the CLI to be spawned');
  const rules = run.fake.cli.askRules;
  assert.equal(rules.size, QWEN_NAMES.tools.length + 1);
  for (const tool of QWEN_NAMES.tools) assert.ok(rules.has(tool), `${tool} has no ask rule`);
  assert.ok(rules.has('mcp__nas'));
  const path = run.fake.cli.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] ?? '';
  const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.equal(written['disableAllHooks'], true);
  assert.deepEqual(written['privacy'], { usageStatisticsEnabled: false });
  assert.equal(await closed(run), null);
});

test('only default and plan are ever sent: bypassPermissions starts in default, plan is configured as plan, and acceptEdits is refused by name', async () => {
  const run = await started({ request: { permissionMode: 'bypassPermissions' } });
  await waitFor(() => run.fake.child.spawned !== null, 'the CLI to be spawned');
  const args = run.fake.child.spawned?.args ?? [];
  assert.equal(args[args.indexOf('--approval-mode') + 1], 'default');
  run.process.prompt('go');
  await waitFor(() => results(run.messages).length === 1, 'the result');
  await run.process.setPermissionMode('plan');
  await assert.rejects(
    run.process.setPermissionMode('acceptEdits'),
    /Qwen Code takes bypassPermissions, default, plan/,
  );
  const modes = run.fake.cli.requests
    .filter((request) => request['subtype'] === 'set_permission_mode')
    .map((request) => request['mode']);
  assert.deepEqual(modes, ['plan']);
  assert.deepEqual(
    qwenRequestProblem(processRequest({ permissionMode: 'acceptEdits' })),
    'permissionMode acceptEdits: Qwen Code takes bypassPermissions, default, plan',
  );
  assert.equal(await closed(run), null);
});

test('an init that reports a mode other than default or plan raises gate-mode-widened, once per mode', async () => {
  const run = await started({ fake: { mode: 'yolo' } });
  run.process.prompt('one');
  run.process.prompt('two');
  await waitFor(() => results(run.messages).length === 2, 'two results');
  assert.deepEqual(
    run.raised.filter((one) => one.name === 'gate-mode-widened').map((one) => one.detail),
    ['Qwen Code reports permission mode yolo, which approves calls itself'],
  );
  assert.equal(await closed(run), null);
});

test('a tool the first init lists that no ask rule names raises gate-tool-unruled, once, and a later init raises nothing more', async () => {
  const run = await started({
    fake: { tools: [...QWEN_NAMES.tools, 'brand_new_tool', 'mcp__elsewhere__x'] },
  });
  run.process.prompt('one');
  run.process.prompt('two');
  await waitFor(() => results(run.messages).length === 2, 'two results');
  const unruled = run.raised.filter((one) => one.name === 'gate-tool-unruled').map((one) => one.detail);
  assert.equal(unruled.length, 2);
  assert.match(unruled[0] ?? '', /brand_new_tool/);
  assert.match(unruled[1] ?? '', /mcp__elsewhere__x/);
  assert.equal(await closed(run), null);
});

test('a tool of an attached server is named by its server rule, and raises nothing', async () => {
  const run = await started({
    request: { mcpServers: { nas: { type: 'http', url: 'https://plane/mcp' } } },
    fake: { tools: [...QWEN_NAMES.tools, 'mcp__nas__seat_read'] },
  });
  run.process.prompt('one');
  await waitFor(() => results(run.messages).length === 1, 'the result');
  assert.deepEqual(
    run.raised.filter((one) => one.name === 'gate-tool-unruled'),
    [],
  );
  assert.equal(await closed(run), null);
});

test('an allow is answered with no input of its own, and an allow that rewrites the input is refused, so the call never runs on arguments nobody approved', async () => {
  const run = await started({
    decide: (request) =>
      Promise.resolve(
        request.toolName === 'edit'
          ? { behavior: 'allow', updatedInput: { file_path: `${ROOT}/other.ts` } }
          : { behavior: 'allow' },
      ),
    fake: {
      calls: () => [
        { name: 'write_file', input: { file_path: `${ROOT}/a.ts`, content: 'x' } },
        { name: 'edit', input: { file_path: `${ROOT}/b.ts`, old_string: 'a', new_string: 'b' } },
      ],
    },
  });
  run.process.prompt('edit');
  await waitFor(() => results(run.messages).length === 1, 'the result');
  assert.deepEqual(run.fake.cli.decided[0]?.answer, { behavior: 'allow' });
  assert.equal(run.fake.cli.decided[1]?.answer['behavior'], 'deny');
  assert.match(textOf(run.fake.cli.decided[1]?.answer['message']), /^permission-decision-unrecognised:/);
  assert.deepEqual(
    run.fake.cli.ran.map((one) => one.toolName),
    ['write_file'],
  );
  assert.equal(await closed(run), null);
});

test('with no gate a permission request is denied, and any other request from the CLI is answered with an error', async () => {
  const run = await started({
    noGate: true,
    fake: { calls: () => [{ name: 'write_file', input: { file_path: `${ROOT}/a.ts`, content: 'x' } }] },
  });
  run.process.prompt('write');
  await waitFor(() => results(run.messages).length === 1, 'the result');
  assert.deepEqual(run.fake.cli.decided[0]?.answer, {
    behavior: 'deny',
    message: 'this host has no gate for this session',
  });
  assert.deepEqual(run.fake.cli.ran, []);
  assert.equal(await closed(run), null);
});

test('the setters apply at once: the model, re-sent as the start model for null, and the effort; thinking off is refused by name and adaptive changes nothing', async () => {
  const run = await started({ request: { model: 'qwen3-coder-plus' } });
  run.process.prompt('go');
  await waitFor(() => results(run.messages).length === 1, 'the result');
  await run.process.setModel('qwen3-max');
  await run.process.setModel(null);
  await run.process.setEffort('xhigh');
  await run.process.setThinking({ type: 'adaptive' });
  await assert.rejects(run.process.setThinking({ type: 'disabled' }), /no thinking switch/);
  const sent = run.fake.cli.requests
    .filter((request) => request['subtype'] !== 'get_context_usage' && request['subtype'] !== 'initialize')
    .map((request) => [request['subtype'], request['model'] ?? request['effort']]);
  assert.deepEqual(sent, [
    ['set_model', 'qwen3-max'],
    ['set_model', 'qwen3-coder-plus'],
    ['set_effort', 'xhigh'],
  ]);
  assert.equal(await closed(run), null);
});

test('an interrupt aborts the running turn only: its result says Operation cancelled., and the next prompt runs', async () => {
  const run = await started({
    fake: {
      holdDecisions: true,
      calls: (prompt) =>
        prompt === 'long' ? [{ name: 'run_shell_command', input: { command: 'sleep 100' } }] : [],
    },
  });
  run.process.prompt('long');
  await waitFor(
    () =>
      run.fake.cli.decided.length === 0 && run.messages.some((message) => message.kind === 'control_request'),
    'the call to be asked about',
  );
  await run.process.interrupt();
  run.fake.cli.release();
  run.process.prompt('next');
  await waitFor(() => results(run.messages).length === 2, 'two results');
  const [first, second] = results(run.messages);
  assert.equal(first?.['is_error'], true);
  assert.deepEqual(first?.['error'], { message: 'Operation cancelled.' });
  assert.equal(second?.['is_error'], false);
  assert.equal(await closed(run), null);
});

test("close ends the CLI's input and removes the session's home, and the stream ends", async () => {
  const run = await started();
  await waitFor(() => run.fake.child.spawned !== null, 'the CLI to be spawned');
  const home = run.fake.cli.env['QWEN_HOME'] ?? '';
  assert.ok(existsSync(home));
  assert.equal(await closed(run), null);
  assert.equal(run.fake.child.stdinEnded, true);
  assert.equal(existsSync(home), false);
});

test("an auth failure's result rides the stream before the CLI exits, naming what to fix", async () => {
  const run = await started({
    fake: {
      authFailure:
        'No auth type is selected. Please configure an auth type (e.g. via settings or `--auth-type`) before running in non-interactive mode.',
    },
  });
  const error = await run.ended;
  const [result] = results(run.messages);
  assert.equal(result?.['is_error'], true);
  assert.equal(result?.['num_turns'], 0);
  assert.match(
    textOf((result?.['error'] as JsonObject | undefined)?.['message']),
    /^No auth type is selected/,
  );
  assert.match(String(error?.message), /the Qwen Code CLI exited \(exit code 1\)/);
});

test("on an endpoint the key is in the session's settings only: never in the CLI's environment, never on its command line", async () => {
  const key = 'sk-the-endpoint-key-value';
  const route: QwenEndpointRoute = {
    name: 'router',
    wireApi: 'openai-chat',
    baseUrl: 'https://router.example/v1',
    models: ['qwen3-coder-plus'],
    env: { QWEN_CODE_MAX_OUTPUT_TOKENS: '8000' },
    authToken: () => key,
  };
  const run = await started({ runtime: { endpoints: [route] }, endpoint: 'router' });
  await waitFor(() => run.fake.child.spawned !== null, 'the CLI to be spawned');
  const spawned = run.fake.child.spawned;
  assert.ok(spawned !== null);
  assert.equal(Object.values(spawned.env).includes(key), false);
  assert.equal(spawned.args.includes(key), false);
  assert.deepEqual(spawned.args.slice(-4), [
    '--auth-type',
    'openai',
    '--openai-base-url',
    'https://router.example/v1',
  ]);
  const written = JSON.parse(readFileSync(spawned.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] ?? '', 'utf8')) as {
    security: { auth: JsonObject };
  };
  assert.deepEqual(written.security.auth, {
    selectedType: 'openai',
    apiKey: key,
    baseUrl: 'https://router.example/v1',
  });
  assert.equal(await closed(run), null);
});

test('an endpoint this runtime does not route ends the open by name, before anything is written', async () => {
  const run = await started({ endpoint: 'nowhere' });
  const error = await run.ended;
  assert.match(String(error?.message), /^endpoint-unknown: nowhere is not one this Qwen Code runtime routes/);
  assert.equal(run.fake.child.spawned, null);
  assert.equal(existsSync(join(run.base, 'sessions')), false);
});

test('a variables file the CLI loads into its environment is named in the opening tier as gate-credential-in-shell, by its variables and never their values', async () => {
  const operatorHome = await tempDir('qwen-env');
  try {
    writeFileSync(join(operatorHome, '.env'), 'OPENAI_API_KEY=sk-secret-value\nPATH=ignored\n# comment\n');
    mkdirSync(join(operatorHome, '.qwen'));
    const run = await started({ runtime: { operatorHome } });
    await waitFor(() => run.tier.length > 0, 'the opening tier');
    assert.deepEqual(run.tier, ['gate-credential-in-shell']);
    const [degrade] = run.raised;
    assert.equal(degrade?.name, 'gate-credential-in-shell');
    assert.match(degrade?.detail ?? '', /\.env \(OPENAI_API_KEY\)/);
    assert.equal((degrade?.detail ?? '').includes('sk-secret-value'), false);
    assert.equal(await closed(run), null);
  } finally {
    await rm(operatorHome, { recursive: true, force: true });
  }
});

test('with the server list strict and no server attached, the CLI admits only a name no server carries', async () => {
  const run = await started();
  await waitFor(() => run.fake.child.spawned !== null, 'the CLI to be spawned');
  const args = run.fake.child.spawned?.args ?? [];
  assert.equal(args[args.indexOf('--allowed-mcp-server-names') + 1], QWEN_NO_SERVER);
  assert.equal(await closed(run), null);
});

test("a resume and a fork reach the CLI as --resume and --fork-session, and the system prompt's append rides --append-system-prompt", async () => {
  const run = await started({
    request: {
      resume: 'previous-session',
      fork: true,
      systemPrompt: { type: 'preset', preset: 'runtime-default', append: 'the policy text' },
    },
  });
  await waitFor(() => run.fake.child.spawned !== null, 'the CLI to be spawned');
  const args = run.fake.child.spawned?.args ?? [];
  assert.equal(args[args.indexOf('--resume') + 1], 'previous-session');
  assert.ok(args.includes('--fork-session'));
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'the policy text');
  assert.equal(args.includes('--system-prompt'), false);
  assert.equal(await closed(run), null);
});

test('the request keys Qwen Code cannot honour are refused by name, and the ones it can are not', () => {
  const refused: [Partial<AgentProcessRequest>, RegExp][] = [
    [{ hooks: {} }, /^hooks:/],
    [{ sessionStore: {} as never }, /^sessionStore:/],
    [{ sessionStoreFlush: 'eager' }, /^sessionStoreFlush:/],
    [{ spawn: (() => undefined) as never }, /^spawn:/],
    [{ settingSources: ['project'] }, /^settingSources:/],
    [{ forwardSubagentText: true }, /^forwardSubagentText:/],
    [{ permissionMode: 'dontAsk' }, /^permissionMode dontAsk:/],
    [{ thinking: { type: 'disabled' } }, /^thinking:/],
    [{ systemPrompt: { type: 'preset', preset: 'claude_code', append: 'x' } as never }, /^systemPrompt:/],
    [{ systemPrompt: 'x'.repeat(16_385) }, /^systemPrompt: 16385 characters/],
  ];
  for (const [overrides, pattern] of refused) {
    assert.match(String(qwenRequestProblem(processRequest(overrides))), pattern);
  }
  const honoured: Partial<AgentProcessRequest>[] = [
    {},
    { model: 'm', effort: 'max', resume: 'r', fork: true, includePartialMessages: false },
    { permissionMode: 'plan', thinking: { type: 'adaptive' }, strictMcpConfig: false },
    { systemPrompt: 'replace the base' },
    { systemPrompt: { type: 'preset', preset: 'runtime-default', append: 'x' } },
    { plugins: [{ type: 'local', path: 'C:/plugins/pack' }] },
  ];
  for (const overrides of honoured) assert.equal(qwenRequestProblem(processRequest(overrides)), null);
});

test('a plugin directory is handed over as its skills directory, and one with none is reported, not handed over', async () => {
  const pack = await tempDir('qwen-pack');
  const empty = await tempDir('qwen-empty');
  try {
    mkdirSync(join(pack, '.claude-plugin'));
    writeFileSync(join(pack, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pack' }));
    mkdirSync(join(pack, 'skills', 'review'), { recursive: true });
    writeFileSync(join(pack, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: d\n---\nbody');
    mkdirSync(join(empty, '.claude-plugin'));
    writeFileSync(join(empty, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'empty' }));
    const run = await started({
      request: {
        plugins: [
          { type: 'local', path: pack },
          { type: 'local', path: empty },
        ],
      },
    });
    await waitFor(() => run.fake.child.spawned !== null, 'the CLI to be spawned');
    const written = JSON.parse(
      readFileSync(run.fake.cli.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] ?? '', 'utf8'),
    ) as {
      skills: { directories: string[] };
    };
    assert.deepEqual(written.skills.directories, [join(pack, 'skills')]);
    run.process.prompt('go');
    await waitFor(() => results(run.messages).length === 1, 'the result');
    assert.equal(await run.process.pluginsApplied(), false);
    assert.equal(await closed(run), null);
  } finally {
    await rm(pack, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});

test('the prompts waiting for an answer are bounded: past the bound a prompt is not taken', async () => {
  const run = await started({
    fake: { holdDecisions: true, calls: () => [{ name: 'edit', input: { file_path: `${ROOT}/a` } }] },
  });
  let taken = 0;
  for (let index = 0; index < 20; index += 1) if (run.process.prompt(`p${index}`)) taken += 1;
  assert.equal(taken, 16);
  run.fake.cli.release();
  assert.equal(await closed(run), null);
});
