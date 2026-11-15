/**
 * opencode itself, in the adapter's configuration, with no credential and no model but a stub on loopback.
 *
 * Every session these tests open runs the pinned SDK this checkout installs as a development dependency,
 * through the adapter's own host process, from a fresh home under a scratch directory, with an environment
 * written whole: no key, no variable of this host's but the further worktrees' paths, every proxy pointed at a
 * dead loopback port. The only model is a stub answering on loopback from a script (`stub-model-http.ts`),
 * reached through an endpoint whose key is a placeholder. What they pin, each against the runtime rather than
 * a stand-in:
 * - the open proves itself on the server, and the model is offered only tools this host names, none it turns
 *   off; a planted allow rule or a second provider refuses the open by name;
 * - a refused write does not land and the model reads why; a shell call asks in its dialect; a subagent's call
 *   and a forked session's call each ask; an MCP server whose name has an underscore is told apart;
 * - a write outside the session's roots is refused before it runs, and one inside a further worktree lands;
 *   a decision nobody gives ends at its deadline;
 * - the environment a command runs in, and the host process's, hold a marker and no credential or variable of
 *   this host's; neither the host process nor anything it starts listens on a port; the close ends every
 *   process the session started, a background command included;
 * - a resume continues the session; a model set mid-run applies from the next model call; a handed skill is
 *   offered; an endpoint refusing the key fails the run in the provider's words;
 * - spend is filed per model call, its input uncached.
 * Each skips, saying why, on a Node that cannot load the SDK (`nodeCanRunOpencode`): opencode needs Node 24.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RefusalReason } from '../core/refusal.js';
import type { Decider, DecisionRequest } from '../gate/decision.js';
import { OPENCODE_TOOL_FAMILIES, localGate } from '../gate/local.js';
import type { LocalGate } from '../gate/local.js';
import { OPENCODE_DENIED_TOOLS, OPENCODE_OTHER_TOOLS, OPENCODE_TOOL_KINDS } from '../gate/tool-kind.js';
import { HOOK_TIMEOUT_EVENT } from '../state/model.js';
import { fakeMcpHttp } from '../test-support/fake-mcp-http.js';
import { stubModel, stubRequestText } from '../test-support/stub-model-http.js';
import type { StubModel, StubModelReply, StubModelRequest } from '../test-support/stub-model-http.js';
import { tempDir } from '../test-support/temp-dir.js';
import type { AgentProcess, AgentProcessRequest } from './agent-process.js';
import type { OpencodeEndpointRoute } from './opencode-endpoints.js';
import { OpencodeFactLift } from './opencode-facts.js';
import { createOpencodeSessionGate } from './opencode-gate.js';
import { startOpencodeProcess } from './opencode-process.js';
import { connectOpencodeHost } from './opencode-relay.js';
import type { OpencodeConnectOptions } from './opencode-relay.js';
import { nodeCanRunOpencode, readOpencodeInstall } from './opencode-sdk.js';
import type { OpencodeEvent } from './opencode-sdk.js';
import type { OpencodeMessage } from './opencode-wire.js';
import { descendantsOf, readProcTable } from './stdio-rpc.js';
import { nodePathResolver } from './paths.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NODE = nodeCanRunOpencode();
const INSTALL = readOpencodeInstall(PACKAGE_ROOT);
const skip =
  NODE !== null
    ? `opencode cannot load on this Node: ${NODE}`
    : INSTALL.ok
      ? false
      : `no opencode SDK in the development install: ${INSTALL.refusal.detail}`;
const WINDOWS = process.platform === 'win32';
const MARKER = 'periscope-opencode-marker';
const PLACEHOLDER_KEY = 'placeholder-endpoint-key-not-a-credential';
const PLANTED = 'planted-copy';

/** A scratch layout: a profile, a temp folder, the session's directory, a further worktree, the base, a plugin. */
interface Scratch {
  readonly root: string;
  readonly profile: string;
  readonly tmp: string;
  readonly work: string;
  readonly worktree: string;
  readonly base: string;
  readonly plugin: string;
}

async function scratch(): Promise<Scratch> {
  const root = await tempDir('opencode-local');
  const layout = {
    root,
    profile: join(root, 'profile'),
    tmp: join(root, 'tmp'),
    work: join(root, 'work'),
    worktree: join(root, 'worktree'),
    base: join(root, 'base'),
    plugin: join(root, 'plugin'),
  };
  for (const dir of Object.values(layout)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(layout.work, 'notes.txt'), 'scratch\n');
  mkdirSync(join(layout.plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(layout.plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'probe-plugin', version: '1.0.0' }),
  );
  mkdirSync(join(layout.plugin, 'skills', 'probe-skill'), { recursive: true });
  writeFileSync(
    join(layout.plugin, 'skills', 'probe-skill', 'SKILL.md'),
    '---\nname: probe-skill\ndescription: A scratch skill, PROBE-SKILL-MARKER.\n---\nSay hello.\n',
  );
  return layout;
}

/**
 * Remove a scratch layout. A process the session ran in it may still be exiting when the session has closed
 * (Windows refuses to remove a directory a process is in), so the removal is retried for a while; one that
 * still fails names the directory, and never hides what the test itself found.
 */
async function removeScratch(dirs: Scratch): Promise<void> {
  await rm(dirs.root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }).catch(
    (error: unknown) => {
      process.stderr.write(`scratch ${dirs.root} was not removed: ${String(error)}\n`);
    },
  );
}

/** The environment written whole: the OS's own, a scratch profile and temp folder, every proxy dead. */
function scratchEnv(dirs: Scratch, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const node = dirname(process.execPath);
  const proxies = {
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
  };
  if (WINDOWS) {
    const system = process.env['SystemRoot'] ?? 'C:\\Windows';
    return {
      SystemRoot: system,
      windir: system,
      ComSpec: process.env['ComSpec'] ?? join(system, 'System32', 'cmd.exe'),
      PATHEXT: process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD',
      PATH: [
        node,
        join(system, 'System32'),
        system,
        join(system, 'System32', 'WindowsPowerShell', 'v1.0'),
      ].join(';'),
      USERPROFILE: dirs.profile,
      APPDATA: join(dirs.profile, 'roaming'),
      LOCALAPPDATA: join(dirs.profile, 'local'),
      TEMP: dirs.tmp,
      TMP: dirs.tmp,
      MARKER,
      ...proxies,
      ...extra,
    };
  }
  return {
    PATH: `${node}:/usr/local/bin:/usr/bin:/bin`,
    HOME: dirs.profile,
    TMPDIR: dirs.tmp,
    SHELL: '/bin/bash',
    MARKER,
    ...proxies,
    ...extra,
  };
}

function processRequest(dirs: Scratch, overrides: Partial<AgentProcessRequest> = {}): AgentProcessRequest {
  return {
    cwd: dirs.work,
    env: scratchEnv(dirs),
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

/** The last user message of a request: what a script tells a session's own turn from a subagent's by. */
function lastUser(request: StubModelRequest): string {
  const user = request.messages.filter((message) => message.role === 'user').at(-1);
  return user === undefined
    ? ''
    : typeof user.content === 'string'
      ? user.content
      : JSON.stringify(user.content);
}

/** A stub whose script answers by marker, and says `finished` once a tool's result is back. */
function scripted(
  steps: Readonly<Record<string, StubModelReply>>,
  fallback: StubModelReply = { text: 'plain' },
) {
  return stubModel(
    (request) => {
      if (request.messages.at(-1)?.role === 'tool') return { text: 'finished' };
      const user = lastUser(request);
      for (const [marker, reply] of Object.entries(steps)) if (user.includes(marker)) return reply;
      return fallback;
    },
    { usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } } },
  );
}

const allow: Decider = () => Promise.resolve({ behavior: 'allow' });

/** One session through the adapter, on the real SDK, with what it saw recorded. */
interface Real {
  readonly proc: AgentProcess<OpencodeMessage>;
  readonly messages: OpencodeMessage[];
  readonly requests: DecisionRequest[];
  readonly raised: { name: RefusalReason; detail: string }[];
  readonly degrades: string[];
  readonly connected: OpencodeConnectOptions[];
  readonly ended: Promise<Error | null>;
  hostPid(): number | null;
  events(type: string): OpencodeEvent[];
  /** The session's own runs that have ended. */
  runs(): number;
  sessionId(): string;
}

interface Open {
  readonly decide?: Decider;
  readonly localGate?: LocalGate;
  readonly request?: Partial<AgentProcessRequest>;
  readonly endpoint?: string;
  readonly endpoints?: readonly OpencodeEndpointRoute[];
  readonly decisionTimeoutMs?: number;
  /** Rewrites the configuration on its way to the host process, to plant what the read-back must catch. */
  readonly rewrite?: (config: Record<string, unknown>) => Record<string, unknown>;
}

function stubRoute(stub: StubModel): OpencodeEndpointRoute {
  return {
    name: 'stub',
    wireApi: 'openai-chat',
    baseUrl: `${stub.url}/v1`,
    models: ['stub-model', 'stub-other'],
    authToken: () => PLACEHOLDER_KEY,
  };
}

function start(dirs: Scratch, stub: StubModel, options: Open = {}): Real {
  const requests: DecisionRequest[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const degrades: string[] = [];
  const connected: OpencodeConnectOptions[] = [];
  let pid: number | null = null;
  const request = processRequest(dirs, options.request);
  const gate = createOpencodeSessionGate({
    sessionKey: 'pin',
    cwd: request.cwd,
    decide: (asked, signal) => {
      requests.push(asked);
      return (options.decide ?? allow)(asked, signal);
    },
    ...(options.localGate === undefined ? {} : { localGate: options.localGate }),
    decisionTimeoutMs: options.decisionTimeoutMs ?? 60_000,
    holdAfterMs: 50_000,
    servers: Object.keys(request.mcpServers ?? {}),
    onOutcome: () => undefined,
    onDegrade: (name, detail) => raised.push({ name, detail }),
    onSpawnDegrades: () => undefined,
  });
  const proc = startOpencodeProcess(
    request,
    {
      sdk: PACKAGE_ROOT,
      base: dirs.base,
      endpoints: options.endpoints ?? [stubRoute(stub)],
      connect: async (opened) => {
        const rewritten =
          options.rewrite === undefined
            ? opened
            : {
                ...opened,
                config: JSON.stringify(options.rewrite(JSON.parse(opened.config) as Record<string, unknown>)),
              };
        connected.push(rewritten);
        const connection = await connectOpencodeHost(rewritten);
        if (connection.ok) pid = connection.value.pid;
        return connection;
      },
    },
    (detail) => degrades.push(detail),
    options.endpoint ?? 'stub',
    gate,
  );
  const messages: OpencodeMessage[] = [];
  const ended = (async (): Promise<Error | null> => {
    try {
      for await (const message of proc.messages) messages.push(message);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();
  const events = (type: string): OpencodeEvent[] =>
    messages.flatMap((message) =>
      message.kind === 'event' && message.event.type === type ? [message.event] : [],
    );
  return {
    proc,
    messages,
    requests,
    raised,
    degrades,
    connected,
    ended,
    hostPid: () => pid,
    events,
    runs: () =>
      messages.filter(
        (message) =>
          message.kind === 'event' &&
          message.main &&
          /^session\.execution\.(succeeded|failed|interrupted)$/.test(message.event.type),
      ).length,
    sessionId: () => {
      const open = messages.find((message) => message.kind === 'opened');
      return open?.kind === 'opened' ? open.sessionId : '';
    },
  };
}

async function until(check: () => boolean, what: string, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Wait for the open, or fail with why it did not happen. */
async function opened(real: Real): Promise<void> {
  const state: { settled: Error | null | 'running' } = { settled: 'running' };
  void real.ended.then((value) => {
    state.settled = value;
  });
  await until(
    () => real.messages.some((message) => message.kind === 'opened') || state.settled !== 'running',
    'the open',
  );
  const settled = state.settled;
  assert.ok(
    real.messages.some((message) => message.kind === 'opened'),
    `the open was not proven: ${settled === 'running' ? 'still running' : String(settled?.message)}; ${real.degrades.join('; ')}`,
  );
}

/** Send `text` and wait for the run it starts to end. */
async function ran(real: Real, text: string): Promise<void> {
  const before = real.runs();
  assert.equal(real.proc.prompt(text), true);
  await until(() => real.runs() > before, `the run of ${text}`);
}

async function closed(real: Real): Promise<Error | null> {
  real.proc.close();
  return real.ended;
}

/** Whether a process is still running. */
function alive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

/** `root` and every process under it. */
async function treeOf(root: number): Promise<number[]> {
  if (WINDOWS) {
    const read = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    const table = read
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((pair): pair is [number, number] => pair.length === 2 && pair.every(Number.isInteger))
      .map(([pid, ppid]) => ({ pid, ppid }));
    return [root, ...descendantsOf(root, table)];
  }
  const table = await readProcTable();
  assert.ok(table !== null, 'no process table to read');
  return [root, ...descendantsOf(root, table)];
}

/** Every TCP port listened on and UDP port bound by one of `pids`, as `proto:port:pid`. */
function listenersOf(pids: readonly number[]): string[] {
  if (WINDOWS) {
    const ids = pids.join(',');
    const read = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ids = @(${ids}); ` +
          'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object { "tcp:$($_.LocalPort):$($_.OwningProcess)" }; ' +
          'Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object { "udp:$($_.LocalPort):$($_.OwningProcess)" }',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return read
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }
  // Each process's socket inodes, then the kernel's listening TCP and bound UDP sockets by inode.
  const owner = new Map<string, number>();
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
        const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
        if (inode !== undefined) owner.set(inode, pid);
      } catch {
        // Closed while read.
      }
    }
  }
  const found: string[] = [];
  for (const [proto, file] of [
    ['tcp', '/proc/net/tcp'],
    ['tcp', '/proc/net/tcp6'],
    ['udp', '/proc/net/udp'],
    ['udp', '/proc/net/udp6'],
  ] as const) {
    let lines: string[];
    try {
      lines = readFileSync(file, 'utf8').split('\n').slice(1);
    } catch {
      continue;
    }
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const port = parseInt((fields[1] ?? '').split(':')[1] ?? '0', 16);
      const state = fields[3];
      const inode = fields[9] ?? '';
      const pid = owner.get(inode);
      if (pid === undefined) continue;
      if (proto === 'tcp' && state !== '0A') continue;
      found.push(`${proto}:${port}:${pid}`);
    }
  }
  return found;
}

/** What a command run by the session's shell writes its environment as, read back as names and values. */
function envCommand(file: string): string {
  return WINDOWS
    ? `Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" } | Set-Content -Encoding utf8 -Path '${file}'`
    : `env > '${file}'`;
}

function readEnvFile(file: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

test(
  'the open proves itself on the server; the model is offered only tools this host names and none it turns off; spend is filed per call, its input uncached; no call is made outside a run',
  { skip, timeout: 180_000 },
  async () => {
    const dirs = await scratch();
    const stub = await scripted({});
    const real = start(dirs, stub, { request: { plugins: [{ type: 'local', path: dirs.plugin }] } });
    try {
      await opened(real);
      const open = real.messages.find((message) => message.kind === 'opened');
      assert.ok(open?.kind === 'opened');
      assert.equal(open.agent, 'build');
      assert.equal(open.model, 'endpoint-stub/stub-model');
      await ran(real, 'say hello');
      assert.equal(stub.requests.length, 1, 'one run, one model call: no title or any other call outside it');
      const offered = [...new Set(stub.requests.flatMap((request) => request.tools))].sort();
      const named = new Set([
        ...Object.keys(OPENCODE_TOOL_KINDS),
        ...OPENCODE_OTHER_TOOLS,
        ...OPENCODE_DENIED_TOOLS,
      ]);
      assert.deepEqual(
        offered.filter((tool) => !named.has(tool)),
        [],
        `tools no table names: ${offered.join(', ')}`,
      );
      assert.deepEqual(
        offered.filter((tool) => OPENCODE_DENIED_TOOLS.includes(tool)),
        [],
        'a tool this host turns off is offered',
      );
      for (const tool of ['shell', 'read', 'edit', 'subagent'])
        assert.ok(offered.includes(tool), `${tool} is not offered`);
      assert.ok(
        stub.requests.some(
          (request) =>
            stubRequestText(request).includes('PROBE-SKILL-MARKER') ||
            JSON.stringify(request).includes('probe-skill'),
        ),
        'the handed skill was not offered to the model',
      );
      const lift = new OpencodeFactLift();
      const spend = real.messages
        .flatMap((message) => lift.fromMessage(message).facts)
        .filter((fact) => fact.kind === 'turn_record');
      assert.equal(spend.length, 1);
      const [step] = spend;
      assert.ok(step?.kind === 'turn_record');
      assert.equal(step.turnScope, 'step');
      // The stub reports 100 prompt tokens, 40 of them cached: opencode reports the 60 uncached as input.
      assert.equal(step.turn?.byModel[0]?.inputTokens, 60);
      assert.equal(step.turn?.byModel[0]?.cacheReadTokens, 40);
      assert.equal(step.turn?.byModel[0]?.outputTokens, 5);
      assert.equal(
        step.turn?.costBasis,
        'unreported',
        'an endpoint the catalogue does not price reports no cost',
      );
      assert.deepEqual(real.raised, []);
    } finally {
      await closed(real);
      await stub.close();
      await removeScratch(dirs);
    }
  },
);

test(
  'the read-back refuses the open by name on the server itself: an allow planted in the configuration, and a second provider',
  { skip, timeout: 180_000 },
  async () => {
    const plants: [string, (config: Record<string, unknown>) => Record<string, unknown>, RegExp][] = [
      [
        'an allow rule',
        (config) => ({
          ...config,
          permissions: [
            ...(config['permissions'] as unknown[]),
            { action: 'edit', resource: '*', effect: 'allow' },
          ],
        }),
        /agent \S+'s rules do not end with the ones this host configured/,
      ],
      [
        'a second provider',
        (config) => ({
          ...config,
          providers: {
            ...(config['providers'] as Record<string, unknown>),
            other: {
              name: 'other',
              package: '@opencode/ai/providers/openai-compatible',
              settings: { baseURL: 'http://127.0.0.1:9/v1' },
              models: { x: { name: 'x' } },
            },
          },
          policies: [
            ...(config['policies'] as unknown[]),
            { action: 'provider.use', resource: 'other', effect: 'allow' },
          ],
        }),
        /models of providers other than the session's: other/,
      ],
    ];
    for (const [name, rewrite, pattern] of plants) {
      const dirs = await scratch();
      const stub = await scripted({});
      const real = start(dirs, stub, { rewrite });
      try {
        real.proc.prompt('never sent');
        const ended = await real.ended;
        assert.match(String(ended?.message), /^opencode-gate-not-active: /, name);
        assert.match(String(ended?.message), pattern, name);
        assert.equal(stub.requests.length, 0, `${name}: a prompt reached the model`);
      } finally {
        await closed(real);
        await stub.close();
        await removeScratch(dirs);
      }
    }
  },
);

test(
  "a refused write does not land and the model reads why; a shell call asks in the shell's dialect, and runs with a marker and no credential or variable of this host's; the host process holds none either",
  { skip, timeout: 180_000 },
  async () => {
    const dirs = await scratch();
    const envFile = join(dirs.tmp, 'env.txt');
    const blocked = join(dirs.work, 'blocked.txt');
    const stub = await scripted({
      'WRITE-IT': {
        toolCalls: [{ id: 'call_write', name: 'write', arguments: { path: blocked, content: 'x' } }],
      },
      'SHOW-ENV': {
        toolCalls: [{ id: 'call_env', name: 'shell', arguments: { command: envCommand(envFile) } }],
      },
    });
    const planted = {
      PERISCOPE_CONTROLLER_TOKEN: `${PLANTED}-controller`,
      PERISCOPE_TICKET: `${PLANTED}-ticket`,
      OPENCODE_CONFIG_CONTENT: `{"${PLANTED}":true}`,
      NODE_OPTIONS: `--title=${PLANTED}`,
      PERISCOPE_WORKTREE_PROBE: dirs.worktree,
    };
    const real = start(dirs, stub, {
      request: { env: scratchEnv(dirs, planted) },
      decide: (request) =>
        Promise.resolve(
          request.toolName === 'edit'
            ? { behavior: 'deny', message: 'not that one, scratch' }
            : { behavior: 'allow' },
        ),
    });
    try {
      await opened(real);
      await ran(real, 'WRITE-IT now');
      assert.equal(existsSync(blocked), false, 'the refused write landed');
      const told = stub.requests
        .flatMap((request) => request.messages)
        .filter((message) => message.role === 'tool');
      assert.ok(
        told.some((message) => JSON.stringify(message.content).includes('not that one, scratch')),
        'the model did not read why',
      );
      await ran(real, 'SHOW-ENV now');
      const shell = real.requests.find((request) => request.toolName === 'shell');
      assert.equal(shell?.toolKind, 'shell');
      assert.equal(shell?.shellDialect, WINDOWS ? 'powershell' : 'posix');
      assert.equal(shell?.toolUseId, 'call_env');
      const seen = readEnvFile(envFile);
      // Control: the planted copies were in the spawn environment, and the marker reaches the shell.
      assert.ok(
        Object.values(processRequest(dirs, { env: scratchEnv(dirs, planted) }).env).some((value) =>
          value.includes(PLANTED),
        ),
      );
      assert.equal(seen['MARKER'], MARKER, 'the marker did not reach the shell, so the read proves nothing');
      const hostEnv = real.connected[0]?.env ?? {};
      const linuxHostEnv =
        process.platform === 'linux' && real.hostPid() !== null
          ? Object.fromEntries(
              readFileSync(`/proc/${String(real.hostPid())}/environ`, 'utf8')
                .split('\0')
                .filter((entry) => entry.includes('='))
                .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
            )
          : null;
      for (const [where, env] of [
        ['the shell', seen],
        ['the host process as spawned', hostEnv],
        ...(linuxHostEnv === null
          ? []
          : [['the host process as the kernel holds it', linuxHostEnv] as const]),
      ] as const) {
        const leaked = Object.entries(env).filter(
          ([name, value]) =>
            value.includes(PLANTED) ||
            value.includes(PLACEHOLDER_KEY) ||
            name.toUpperCase() === 'NODE_OPTIONS' ||
            (name.toUpperCase().startsWith('PERISCOPE_') &&
              !name.toUpperCase().startsWith('PERISCOPE_WORKTREE_')),
        );
        assert.deepEqual(
          leaked.map(([name]) => name),
          [],
          `${where}: ${leaked.map(([name]) => name).join(', ')}`,
        );
        assert.equal(
          env['PERISCOPE_WORKTREE_PROBE'],
          dirs.worktree,
          `${where}: the further worktree's path is kept`,
        );
      }
      // opencode names the session and the terminal to each command it runs; no opencode variable of the spawn
      // environment reaches the shell.
      assert.deepEqual(
        Object.keys(seen)
          .filter((name) => name.toUpperCase().startsWith('OPENCODE_'))
          .sort(),
        ['OPENCODE_SESSION_ID', 'OPENCODE_TERMINAL'],
      );
      assert.equal(seen['OPENCODE_SESSION_ID'], real.sessionId());
    } finally {
      await closed(real);
      await stub.close();
      await removeScratch(dirs);
    }
  },
);

test(
  "a subagent's call asks this host, naming the subagent's session; so does a call of a forked session; a resume continues the session",
  { skip, timeout: 240_000 },
  async () => {
    const dirs = await scratch();
    const notes = join(dirs.work, 'notes.txt');
    const stub = await scripted({
      'SUB-MARKER': { toolCalls: [{ id: 'call_sub_read', name: 'read', arguments: { path: notes } }] },
      'SPAWN-ONE': {
        toolCalls: [
          {
            id: 'call_spawn',
            name: 'subagent',
            arguments: { agent: 'general', description: 'probe child', prompt: 'SUB-MARKER read the notes' },
          },
        ],
      },
      'READ-AGAIN': { toolCalls: [{ id: 'call_fork_read', name: 'read', arguments: { path: notes } }] },
    });
    const first = start(dirs, stub);
    try {
      await opened(first);
      await ran(first, 'SPAWN-ONE please');
      const spawnRequest = first.requests.find((request) => request.toolUseId === 'call_spawn');
      assert.equal(spawnRequest?.toolName, 'subagent');
      assert.equal(spawnRequest?.toolKind, 'other');
      const sub = first.requests.find((request) => request.toolUseId === 'call_sub_read');
      assert.ok(sub !== undefined, "the subagent's call was never put to this host");
      assert.equal(sub.toolKind, 'file_read');
      assert.ok(
        sub.agentId !== null && sub.agentId !== first.sessionId(),
        'the decision request names the subagent session',
      );
      const spawned = first.messages.find(
        (message) => message.kind === 'event' && message.event.type === 'permission.asked' && !message.main,
      );
      assert.equal(
        spawned?.kind === 'event' ? spawned.spawnedBy : null,
        'call_spawn',
        "the subagent's request names the call that started it",
      );
    } finally {
      await closed(first);
    }
    const sessionId = first.sessionId();
    assert.ok(existsSync(join(dirs.base, 'state', sessionId)), 'the database was kept for a resume');
    const resumed = start(dirs, stub, { request: { resume: sessionId } });
    try {
      await opened(resumed);
      const open = resumed.messages.find((message) => message.kind === 'opened');
      assert.equal(
        open?.kind === 'opened' ? [open.sessionId, open.origin].join(' ') : '',
        `${sessionId} resume`,
      );
      const seen = stub.requests.length;
      await ran(resumed, 'carry on');
      assert.ok(
        stub.requests.slice(seen).some((request) => stubRequestText(request).includes('SPAWN-ONE please')),
        'the resumed session does not hold the earlier turn',
      );
    } finally {
      await closed(resumed);
    }
    const forked = start(dirs, stub, { request: { resume: sessionId, fork: true } });
    try {
      await opened(forked);
      const open = forked.messages.find((message) => message.kind === 'opened');
      assert.equal(open?.kind === 'opened' ? open.origin : null, 'fork');
      assert.notEqual(forked.sessionId(), sessionId);
      await ran(forked, 'READ-AGAIN now');
      assert.ok(
        forked.requests.some((request) => request.toolUseId === 'call_fork_read'),
        "the forked session's call was never put to this host",
      );
    } finally {
      await closed(forked);
      await stub.close();
      await removeScratch(dirs);
    }
  },
);

test(
  'an MCP server whose name has an underscore is told apart: its tool reaches this host as mcp__{server}__{tool}',
  { skip, timeout: 180_000 },
  async () => {
    const dirs = await scratch();
    const mcp = await fakeMcpHttp();
    const stub = await scripted({
      'MCP-CALL': { toolCalls: [{ id: 'call_mcp', name: 'probe_srv_echo', arguments: { text: 'hello' } }] },
    });
    const real = start(dirs, stub, {
      request: { mcpServers: { probe_srv: { type: 'http', url: mcp.url } } },
    });
    try {
      await opened(real);
      await ran(real, 'MCP-CALL now');
      assert.ok(
        stub.requests[0]?.tools.includes('probe_srv_echo'),
        `the server's tool was not offered: ${stub.requests[0]?.tools.join(', ')}`,
      );
      const asked = real.requests.find((request) => request.toolUseId === 'call_mcp');
      assert.equal(asked?.toolName, 'mcp__probe_srv__echo');
      assert.equal(asked?.toolKind, 'mcp');
      assert.deepEqual(mcp.calls, [{ text: 'hello' }]);
    } finally {
      await closed(real);
      await mcp.close();
      await stub.close();
      await removeScratch(dirs);
    }
  },
);

test(
  "a write outside the session's roots is refused before it runs, its directory asked first; one inside a further worktree lands; a decision nobody gives ends at its deadline",
  { skip, timeout: 180_000 },
  async () => {
    const dirs = await scratch();
    const outside = join(dirs.profile, 'outside.txt');
    const inside = join(dirs.worktree, 'landed.txt');
    const late = join(dirs.work, 'late.txt');
    const stub = await scripted({
      'WRITE-OUT': {
        toolCalls: [{ id: 'call_out', name: 'write', arguments: { path: outside, content: 'x' } }],
      },
      'WRITE-IN': {
        toolCalls: [{ id: 'call_in', name: 'write', arguments: { path: inside, content: 'landed\n' } }],
      },
      'WAIT-ON-IT': {
        toolCalls: [{ id: 'call_late', name: 'write', arguments: { path: late, content: 'x' } }],
      },
    });
    const gate = localGate({
      workspaceRoot: dirs.work,
      writeRoots: [dirs.worktree],
      resolve: nodePathResolver,
      protectedPaths: [],
      home: dirs.profile,
      toolFamilies: OPENCODE_TOOL_FAMILIES,
      readsShellDialect: true,
      resolvesAgainstCallCwd: true,
      resolvesWritesAgainstCallCwd: true,
    });
    const real = start(dirs, stub, {
      localGate: gate,
      decisionTimeoutMs: 3_000,
      decide: (request, signal) =>
        request.toolUseId === 'call_late'
          ? new Promise((resolve) =>
              signal.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'aborted' }), {
                once: true,
              }),
            )
          : Promise.resolve({ behavior: 'allow' }),
    });
    try {
      await opened(real);
      await ran(real, 'WRITE-OUT now');
      assert.equal(existsSync(outside), false);
      const told = (): string =>
        JSON.stringify(
          stub.requests.flatMap((request) => request.messages).filter((message) => message.role === 'tool'),
        );
      assert.match(told(), /path-escapes-root/);
      assert.ok(
        real.requests.some(
          (request) => request.toolUseId === 'call_out' && request.toolName === 'external_directory',
        ),
        'the directory outside the location was asked first',
      );
      assert.equal(
        real.requests.some((request) => request.toolUseId === 'call_out' && request.toolName === 'edit'),
        false,
      );
      await ran(real, 'WRITE-IN now');
      assert.equal(readFileSync(inside, 'utf8').replace(/\r\n/g, '\n'), 'landed\n');
      await ran(real, 'WAIT-ON-IT now');
      assert.equal(existsSync(late), false, 'a call nobody decided ran');
      assert.match(told(), new RegExp(HOOK_TIMEOUT_EVENT));
    } finally {
      await closed(real);
      await stub.close();
      await removeScratch(dirs);
    }
  },
);

test(
  "a model set while a run waits on a decision applies from the run's next model call",
  { skip, timeout: 180_000 },
  async () => {
    const dirs = await scratch();
    const notes = join(dirs.work, 'notes.txt');
    const stub = await scripted({
      'READ-IT': { toolCalls: [{ id: 'call_read', name: 'read', arguments: { path: notes } }] },
    });
    let release: () => void = () => undefined;
    let held = false;
    const real = start(dirs, stub, {
      decide: () =>
        new Promise((resolve) => {
          held = true;
          release = () => resolve({ behavior: 'allow' });
        }),
    });
    try {
      await opened(real);
      const before = real.runs();
      real.proc.prompt('READ-IT now');
      await until(() => held, 'the held decision');
      await real.proc.setModel('stub-other');
      release();
      await until(() => real.runs() > before, 'the run');
      assert.deepEqual(
        stub.requests.map((request) => request.model),
        ['stub-model', 'stub-other'],
      );
    } finally {
      await closed(real);
      await stub.close();
      await removeScratch(dirs);
    }
  },
);

test(
  "an endpoint that refuses the key fails the run in the provider's own words, as provider.auth, with no retry",
  { skip, timeout: 180_000 },
  async () => {
    const dirs = await scratch();
    const stub = await scripted({});
    let calls = 0;
    const refusing = createServer((_request, response) => {
      calls += 1;
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            message: 'Incorrect API key provided: plac****.',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        }),
      );
    });
    await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve));
    const port = (refusing.address() as AddressInfo).port;
    const real = start(dirs, stub, {
      endpoint: 'refusing',
      endpoints: [
        {
          name: 'refusing',
          wireApi: 'openai-chat',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          models: ['stub-model'],
          authToken: () => PLACEHOLDER_KEY,
        },
      ],
    });
    try {
      await opened(real);
      await ran(real, 'hello');
      const [failed] = real.events('session.execution.failed');
      const error = (
        failed?.data as { error?: { type?: string; message?: string; status?: number } } | undefined
      )?.error;
      assert.equal(error?.type, 'provider.auth');
      assert.equal(error?.status, 401);
      assert.equal(error?.message, 'Incorrect API key provided: plac****.');
      assert.equal(calls, 1, 'a refused key was retried');
    } finally {
      await closed(real);
      await new Promise((resolve) => refusing.close(resolve));
      await stub.close();
      await removeScratch(dirs);
    }
  },
);

test(
  'no port: while a session is open, neither its host process nor anything it started listens on one; control: a planted listener is found',
  {
    skip:
      skip ||
      (process.platform === 'darwin'
        ? 'the listener read covers Windows and Linux, the legs this package runs on'
        : false),
    timeout: 180_000,
  },
  async () => {
    const planted = spawn(
      process.execPath,
      ['-e', "require('net').createServer().listen(0, '127.0.0.1', () => console.log('up'))"],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    try {
      await new Promise<void>((resolve) => planted.stdout.once('data', () => resolve()));
      assert.ok(planted.pid !== undefined);
      assert.equal(
        listenersOf([planted.pid]).length,
        1,
        'control: the planted listener was not found, so the read proves nothing',
      );
    } finally {
      planted.kill();
    }
    const dirs = await scratch();
    const stub = await scripted({
      'RUN-ONE': {
        toolCalls: [
          {
            id: 'call_shell',
            name: 'shell',
            arguments: { command: WINDOWS ? "Write-Output 'ran'" : 'echo ran' },
          },
        ],
      },
    });
    const real = start(dirs, stub);
    try {
      await opened(real);
      await ran(real, 'RUN-ONE now');
      const host = real.hostPid();
      assert.ok(host !== null);
      const tree = await treeOf(host);
      assert.ok(tree.length >= 1);
      assert.deepEqual(listenersOf(tree), [], `the session's processes listen: ${tree.join(', ')}`);
    } finally {
      await closed(real);
      await stub.close();
      await removeScratch(dirs);
    }
  },
);

test(
  'the close ends every process the session started, a command its shell runs in the background included',
  { skip, timeout: 180_000 },
  async () => {
    const dirs = await scratch();
    const pidFile = join(dirs.tmp, 'background.pid');
    const command = WINDOWS
      ? `Set-Content -Path '${pidFile}' -Value $PID; Start-Sleep -Seconds 120`
      : `echo $$ > '${pidFile}'; exec sleep 120`;
    const stub = await scripted({
      'IN-BACKGROUND': {
        toolCalls: [{ id: 'call_bg', name: 'shell', arguments: { command, background: true } }],
      },
    });
    const real = start(dirs, stub);
    let background: number | null = null;
    try {
      await opened(real);
      await ran(real, 'IN-BACKGROUND now');
      const written = (): string => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '');
      await until(() => /^\d+$/.test(written()), 'the background command to write its pid');
      background = Number(written());
      assert.equal(
        alive(background),
        true,
        'control: the background command reads as alive before the close',
      );
      const host = real.hostPid();
      assert.ok(host !== null);
      const tree = await treeOf(host);
      assert.ok(
        tree.includes(background),
        `the background command is not under the host process: ${tree.join(', ')}`,
      );
      assert.equal(await closed(real), null);
      const deadline = Date.now() + 15_000;
      while (tree.some(alive) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(tree.filter(alive), [], 'a process of the session outlived the close');
      assert.deepEqual(readdirSync(join(dirs.base, 'sessions')), [], "the session's home was removed");
    } finally {
      if (background !== null && alive(background)) process.kill(background);
      await closed(real);
      await stub.close();
      await removeScratch(dirs);
    }
  },
);
