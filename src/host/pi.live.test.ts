/**
 * pi under the gate against the CLI the operator installed, on a model endpoint: what only a real run
 * settles.
 *
 * It runs only with `PERISCOPE_LIVE=1`, `PERISCOPE_PI_BIN` (the installed package's `dist/bundle/cli.js`),
 * `PERISCOPE_PI_ENDPOINT_URL`, `PERISCOPE_PI_ENDPOINT_KEY` and `PERISCOPE_PI_MODEL`;
 * `PERISCOPE_PI_ENDPOINT_API` names the endpoint's wire API (`openai-chat`, the default,
 * `openai-responses` or `anthropic-messages`). Without them each property is NOT exercised, and the skip
 * says so. Every run spends the endpoint's usage, so each prompt is short. Each test prints its receipts
 * as JSON lines, which are the record of what was measured; the assertions hold only what the gate
 * depends on.
 *
 * On Windows pi runs its `bash` tool through Git for Windows at its default path. A host without it
 * finds whatever `bash.exe` comes first on PATH, which can be WSL's; the shell's receipt names which ran.
 *
 * Run it from a plain terminal, not from inside an agent session, which would lend it that session's
 * tools:
 *
 *   npm run build
 *   PERISCOPE_LIVE=1 PERISCOPE_PI_BIN=<dist/bundle/cli.js> PERISCOPE_PI_ENDPOINT_URL=<url> PERISCOPE_PI_ENDPOINT_KEY=<key> PERISCOPE_PI_MODEL=<model> node --test dist/host/pi.live.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EndpointWireApi, JsonObject } from '../control/frames.js';
import type { RefusalReason } from '../core/refusal.js';
import type { DecisionRequest } from '../gate/decision.js';
import { localGate, PI_TOOL_FAMILIES } from '../gate/local.js';
import { composeSpawnEnv } from '../sessions/spawn-env.js';
import { fakeMcpHttp } from '../test-support/fake-mcp-http.js';
import { LiveStream, closeAndWait, removeScratch } from '../test-support/live-session.js';
import type { AgentProcessRequest } from './agent-process.js';
import { credentialPaths, nodePathResolver } from './paths.js';
import { piCommand, piExtensionPath } from './pi-binary.js';
import type { PiEndpointRoute } from './pi-endpoints.js';
import type { PiExtensionConfig } from './pi-extension.js';
import type { PiSessionGate } from './pi-gate.js';
import { createPiSessionGate } from './pi-gate.js';
import { createPiSessionRun, piBaseOf, writePiAgentFiles } from './pi-home.js';
import { piArgs, startPiProcess } from './pi-process.js';
import { PiRpc } from './pi-rpc.js';
import type { PiMessage } from './pi-wire.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const BINARY = process.env['PERISCOPE_PI_BIN'] ?? '';
const URL = process.env['PERISCOPE_PI_ENDPOINT_URL'] ?? '';
const KEY = process.env['PERISCOPE_PI_ENDPOINT_KEY'] ?? '';
const MODEL = process.env['PERISCOPE_PI_MODEL'] ?? '';
const API = (process.env['PERISCOPE_PI_ENDPOINT_API'] ?? 'openai-chat') as EndpointWireApi;
const skip = !LIVE
  ? 'PERISCOPE_LIVE is not set — this property is NOT exercised'
  : BINARY === '' || URL === '' || KEY === '' || MODEL === ''
    ? 'PERISCOPE_PI_BIN, PERISCOPE_PI_ENDPOINT_URL, PERISCOPE_PI_ENDPOINT_KEY and PERISCOPE_PI_MODEL are not all set — this property is NOT exercised'
    : false;

/** A word no real command carries, so the process listing after close finds only what this run started. */
const MARKER = `periscope-pi-live-${process.pid}`;

const ROUTE: PiEndpointRoute = {
  name: 'live',
  wireApi: API,
  baseUrl: URL,
  models: [MODEL],
  env: {},
  authToken: () => KEY,
};

/** One receipt line, as the measurement's record. */
function receipt(what: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ receipt: what, ...data })}\n`);
}

/** A scratch git repository with a context file that keeps the model to the asked tools. */
function scratchRepository(): string {
  const dir = mkdtempSync(`${tmpdir()}/periscope-pi-live-`);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(
    join(dir, 'AGENTS.md'),
    'Answer in one short line. Run exactly the tools you are asked to run.\n',
  );
  return dir;
}

/** A base with its agent home written, as the read at start leaves it. */
function scratchBase(): string {
  const base = mkdtempSync(`${tmpdir()}/periscope-pi-base-`);
  const written = writePiAgentFiles(base, [ROUTE]);
  assert.ok(written.ok, written.ok ? '' : written.refusal.detail);
  return base;
}

function request(cwd: string, overrides: Partial<AgentProcessRequest> = {}): AgentProcessRequest {
  return {
    cwd,
    env: composeSpawnEnv(process.env),
    settingSources: [],
    plugins: null,
    hooks: null,
    resume: null,
    fork: false,
    includePartialMessages: false,
    thinking: null,
    forwardSubagentText: false,
    onStderr: null,
    mcpServers: null,
    strictMcpConfig: true,
    sessionStore: null,
    sessionStoreFlush: null,
    spawn: null,
    model: MODEL,
    systemPrompt: null,
    effort: null,
    permissionMode: null,
    ...overrides,
  };
}

interface Gate {
  readonly gate: PiSessionGate;
  readonly decided: DecisionRequest[];
  readonly raised: { name: RefusalReason; detail: string }[];
}

function gateFor(
  cwd: string,
  protectedPaths: readonly string[],
  deny: (asked: DecisionRequest) => boolean,
): Gate {
  const decided: DecisionRequest[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const gate = createPiSessionGate({
    sessionKey: 'live',
    cwd,
    decide: (asked) => {
      decided.push(asked);
      receipt('decision request', { request: asked });
      return Promise.resolve(
        deny(asked) ? { behavior: 'deny', message: 'denied by the live test' } : { behavior: 'allow' },
      );
    },
    localGate: localGate({
      workspaceRoot: cwd,
      resolve: nodePathResolver,
      protectedPaths,
      toolFamilies: PI_TOOL_FAMILIES,
      readsShellDialect: true,
      resolvesAgainstCallCwd: true,
      resolvesWritesAgainstCallCwd: true,
    }),
    decisionTimeoutMs: 50_000,
    holdAfterMs: 250,
    version: 'live',
    onOutcome: (outcome) => receipt('outcome', { kind: outcome.kind, tool: outcome.request.toolName }),
    onDegrade: (name, detail) => {
      raised.push({ name, detail });
      receipt('degrade', { name, detail });
    },
    onSpawnDegrades: (names, level) => receipt('opening tier', { names, level }),
  });
  return { gate, decided, raised };
}

interface LiveRun extends Gate {
  readonly stream: LiveStream<PiMessage>;
  readonly process: ReturnType<typeof startPiProcess>;
  readonly base: string;
}

function start(
  cwd: string,
  options: {
    readonly protectedPaths?: (base: string) => readonly string[];
    readonly deny?: (asked: DecisionRequest) => boolean;
    readonly overrides?: Partial<AgentProcessRequest>;
  } = {},
): LiveRun {
  const base = scratchBase();
  const gated = gateFor(cwd, options.protectedPaths?.(base) ?? [], options.deny ?? (() => false));
  const process = startPiProcess(
    request(cwd, options.overrides),
    { binary: BINARY, base, endpoints: [ROUTE] },
    (detail) => receipt('runtime degraded', { detail }),
    'live',
    gated.gate,
  );
  return { ...gated, stream: new LiveStream(process.messages), process, base };
}

const indexOf = (stream: LiveStream<PiMessage>, found: (message: PiMessage) => boolean): number =>
  stream.seen.findIndex(found);
const isEvent = (type: string) => (message: PiMessage) =>
  message.kind === 'event' && message.event['type'] === type;
const settled = (stream: LiveStream<PiMessage>): boolean => indexOf(stream, isEvent('agent_settled')) >= 0;

/** Every `tool_execution_end` of the run: the tool, whether it failed, and what it said. */
const toolEnds = (stream: LiveStream<PiMessage>): JsonObject[] =>
  stream.seen.flatMap((message) =>
    message.kind === 'event' && message.event['type'] === 'tool_execution_end' ? [message.event] : [],
  );

/** Processes whose command line carries the marker, after close: what outlived the session. */
function survivors(): string[] {
  try {
    if (process.platform === 'win32') {
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${MARKER}*' } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`;
      return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '' && !line.includes('Get-CimInstance'));
    }
    return execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes(MARKER) && !line.includes('ps -eo'));
  } catch (error) {
    return [`the process listing failed: ${String(error)}`];
  }
}

test(
  "a shell call the host denies is blocked and one it allows runs, each asked first; the extension said hello before the first run; pi's commands name only this host's code; a planted workspace extension and settings file are not loaded; the MCP server's tools are exposed by name at the version negotiated",
  { skip },
  async () => {
    const dir = scratchRepository();
    // Code and settings a workspace could carry: an extension that leaves a mark when it loads and
    // registers a command, and a settings file naming it and a shell that does not exist.
    const mark = join(mkdtempSync(`${tmpdir()}/periscope-pi-mark-`), 'loaded.txt');
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    writeFileSync(
      join(dir, '.pi', 'extensions', 'planted.ts'),
      `import { writeFileSync } from 'node:fs';\nexport default function (pi) {\n  writeFileSync(${JSON.stringify(mark)}, 'loaded');\n  pi.registerCommand('planted', { description: 'planted', handler: async () => {} });\n}\n`,
    );
    writeFileSync(
      join(dir, '.pi', 'settings.json'),
      JSON.stringify({ extensions: ['./extensions/planted.ts'], shellPath: join(dir, 'no-such-shell') }),
    );
    const mcp = await fakeMcpHttp('2024-11-05');
    const started = Date.now();
    // A ticket pi must neither expand (`$`) nor run (`!`): the server reads it back as written.
    const ticket = '!echo $NOT_A_VARIABLE';
    const run = start(dir, {
      deny: (asked) => JSON.stringify(asked.toolInput).includes('deny-me'),
      overrides: {
        mcpServers: {
          nas: { type: 'http', url: mcp.url, headers: { 'X-Job-Ticket': ticket } },
        },
      },
    });
    try {
      run.process.prompt(
        'Do these three things, one tool call each, in order: run the bash command `echo deny-me`; run the bash command `echo allow-me && echo $0`; call the echo tool of the nas server with the text ping.',
      );
      await run.stream.until(() => settled(run.stream), 300_000);
      const hello = indexOf(run.stream, (message) => message.kind === 'hello');
      const firstRun = indexOf(run.stream, isEvent('agent_start'));
      receipt('hello against the first run', {
        helloIndex: hello,
        firstRunIndex: firstRun,
        elapsedMs: Date.now() - started,
      });
      const commands = run.stream.seen.find(
        (message) => message.kind === 'response' && message.command === 'get_commands',
      );
      receipt('get_commands', { commands: commands?.kind === 'response' ? commands.response : null });
      receipt('hello', { hello: run.stream.seen.find((message) => message.kind === 'hello') ?? null });
      receipt('tool ends', { ends: toolEnds(run.stream) });
      receipt('mcp negotiated', {
        initialized: mcp.initialized,
        versionHeaders: mcp.versionHeaders,
        calls: mcp.calls,
        tickets: mcp.requests.map((request) => ({
          method: request.method,
          ticket: request.headers['x-job-ticket'] ?? null,
        })),
      });
      const tickets = mcp.requests.map((request) => request.headers['x-job-ticket']);
      assert.equal(
        mcp.requests.find((request) => request.method === 'initialize')?.headers['x-job-ticket'],
        ticket,
        'the server was opened without the ticket, or with it changed',
      );
      assert.deepEqual(
        tickets.filter((one) => one !== undefined && one !== ticket),
        [],
        'a request carried the ticket changed',
      );

      assert.ok(hello >= 0 && firstRun > hello, 'a run began before the extension said hello');
      const shell = run.decided.filter((asked) => asked.toolName === 'bash');
      const shellInputs = shell.map((asked) => JSON.stringify(asked.toolInput));
      assert.ok(
        shellInputs.some((input) => input.includes('deny-me')),
        `the denied call was not asked about: ${shellInputs.join(', ')}`,
      );
      assert.ok(
        shellInputs.some((input) => input.includes('allow-me')),
        `the allowed call was not asked about: ${shellInputs.join(', ')}`,
      );
      const ends = toolEnds(run.stream).filter((end) => end['toolName'] === 'bash');
      assert.ok(
        ends.some((end) => end['isError'] === true),
        'the denied call was not blocked',
      );
      assert.ok(
        ends.some((end) => end['isError'] !== true && JSON.stringify(end['result']).includes('allow-me')),
        'the allowed call did not run',
      );
      assert.ok(
        run.decided.some((asked) => asked.toolName === 'mcp__nas__echo'),
        'no MCP call reached the decision',
      );
      assert.equal(existsSync(mark), false, 'the planted extension was loaded');
      assert.ok(
        !JSON.stringify(commands?.kind === 'response' ? commands.response : null).includes('planted'),
        "pi lists the planted extension's command",
      );
      assert.deepEqual(
        run.raised.filter((one) => one.name === 'gate-foreign-extension'),
        [],
        'code this host did not load was found',
      );
    } finally {
      await closeAndWait(run.process, run.stream, receipt);
      await mcp.close();
      removeScratch(dir, receipt);
      removeScratch(run.base, receipt);
      removeScratch(join(mark, '..'), receipt);
    }
  },
);

test(
  "a command sent to pi's own `bash` RPC is refused by this host's extension and never runs",
  { skip },
  async () => {
    const dir = scratchRepository();
    const base = scratchBase();
    const gated = gateFor(dir, [], () => false);
    const ran = join(dir, 'ran.txt');
    const records: JsonObject[] = [];
    let rpc: PiRpc | null = null;
    try {
      const listening = await gated.gate.ready();
      assert.ok(listening.ok, listening.ok ? '' : listening.refusal.detail);
      const config: PiExtensionConfig = {
        v: 1,
        runtime: 'pi',
        channel: gated.gate.address,
        token: gated.gate.token,
        deadlineMs: gated.gate.extensionDeadlineMs,
        servers: [],
      };
      const written = createPiSessionRun(base, config, null);
      assert.ok(written.ok, written.ok ? '' : written.refusal.detail);
      const sessionRequest = request(dir);
      const command = piCommand(
        BINARY,
        piArgs(sessionRequest, {
          extensionPath: piExtensionPath(),
          skillDirectories: [],
          sessions: piBaseOf(base).sessions,
          session: null,
          route: ROUTE,
          prompt: null,
        }),
      );
      const started = PiRpc.start({
        command: command.command,
        args: command.args,
        cwd: dir,
        env: { ...sessionRequest.env, ...written.value.env },
        onEvent: () => undefined,
        onRecord: (record) => records.push(record),
        onStderr: (line) => receipt('stderr', { line }),
        onRefusal: (refused) => receipt('transport', { refused }),
        onExit: (exit) => receipt('exit', { exit }),
      });
      assert.ok(started.ok, started.ok ? '' : started.refusal.detail);
      rpc = started.value;
      const hello = await gated.gate.hello(30_000);
      assert.ok(hello !== null, 'the extension did not say hello');
      // The adapter never sends `bash`; this sends it, to show the extension refuses it.
      const answered = await rpc.request('bash' as never, { command: `echo ran > "${ran}"` }, 30_000);
      receipt('bash answered', { answered, records });
      assert.ok(answered.ok, answered.ok ? '' : answered.refusal.detail);
      assert.equal(answered.value['success'], false, 'pi ran the command');
      assert.equal(existsSync(ran), false, 'the command ran');
    } finally {
      await rpc?.close();
      gated.gate.close();
      removeScratch(dir, receipt);
      removeScratch(base, receipt);
    }
  },
);

test(
  "a read of the endpoints' keys in pi's own home is refused by the protected set, before anything is asked",
  { skip },
  async () => {
    const dir = scratchRepository();
    const run = start(dir, { protectedPaths: (base) => credentialPaths(process.env, { piHome: base }) });
    const models = join(piBaseOf(run.base).agent, 'models.json');
    try {
      run.process.prompt(`Read the file ${models} with your read tool and say how many characters it has.`);
      await run.stream.until(() => settled(run.stream), 300_000);
      const ends = toolEnds(run.stream);
      receipt('tool ends', { ends });
      assert.deepEqual(
        run.decided.filter((asked) => JSON.stringify(asked.toolInput).includes('models.json')),
        [],
        'the read of the keys reached the decision instead of being refused before it',
      );
      assert.ok(
        ends.some(
          (end) =>
            end['isError'] === true && JSON.stringify(end['result']).includes('credential-path-denied'),
        ),
        'the read of the keys was not refused by the protected set',
      );
    } finally {
      await closeAndWait(run.process, run.stream, receipt);
      removeScratch(dir, receipt);
      removeScratch(run.base, receipt);
    }
  },
);

test(
  "a command the agent starts in the background does not outlive the session's close",
  { skip },
  async () => {
    const dir = scratchRepository();
    const run = start(dir);
    try {
      run.process.prompt(
        `Run this bash command and do not wait for what it starts: bash -c "sleep 120; true ${MARKER}" > /dev/null 2>&1 &`,
      );
      await run.stream.until(() => settled(run.stream), 300_000);
      receipt('running before close', { survivors: survivors() });
    } finally {
      await closeAndWait(run.process, run.stream, receipt);
      removeScratch(dir, receipt);
      removeScratch(run.base, receipt);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const left = survivors();
    receipt('after close', { survivors: left });
    assert.deepEqual(left, [], 'a command the session started outlived its close');
  },
);
