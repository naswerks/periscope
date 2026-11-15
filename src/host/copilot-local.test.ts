/**
 * The Copilot runtime itself, in the adapter's configuration, with no model call and no credential.
 *
 * Every runtime these tests start runs from the pinned development install in `empty` mode, signed in as
 * nobody, in a fresh home under a scratch directory, with an environment written whole: no GitHub token,
 * no `COPILOT_` variable, every proxy pointed at a dead loopback port. No prompt is ever sent, so no model
 * is called; every call is one the host runs through the session (`tools.execute`), which the runtime puts
 * through the same pre-tool hook and permission request a model's call takes. What they pin, each against
 * the runtime rather than a stand-in:
 * - the hook fires for a shell, a file read, a file write, an MCP tool and a skill, and answers `ask`; the
 *   request that raises is `hook`, and this host decides it;
 * - in `allow-all` a call still asks while the hook answers `ask`, and the gate names the mode;
 * - the session-start hook is not called when a session is created;
 * - a directory the runtime has never seen is untrusted, and tools still run in it;
 * - the adapter's open proves itself on the runtime (the read-back and the probe), and its close leaves no
 *   process of the session's alive, a command the agent started included;
 * - every built-in the runtime names is one this host has a kind for, names as `other`, or turns off,
 *   and none it turns off is offered;
 * - the environment a command runs in is the one this host composed: a marker reaches it, no credential
 *   name does;
 * - a write outside the session's roots is refused before it runs, and one inside a further worktree lands;
 * - before any session, the runtime says which hooks it finds and what the machine's managed settings hold,
 *   in the shape this host reads its policy hooks from.
 * Each skips, saying why, on a host with no runtime for its platform.
 */
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Decider, DecisionRequest } from '../gate/decision.js';
import { COPILOT_TOOL_FAMILIES, localGate } from '../gate/local.js';
import type { LocalGate } from '../gate/local.js';
import { COPILOT_EXCLUDED_TOOLS, COPILOT_OTHER_TOOLS, COPILOT_TOOL_KINDS } from '../gate/tool-kind.js';
import type { RefusalReason } from '../core/refusal.js';
import { fakeMcpHttp } from '../test-support/fake-mcp-http.js';
import { stubModel, stubRequestText } from '../test-support/stub-model-http.js';
import { tempDir } from '../test-support/temp-dir.js';
import type { AgentProcessRequest } from './agent-process.js';
import { COPILOT_HOOK_REASON, createCopilotSessionGate } from './copilot-gate.js';
import type { CopilotSessionGate } from './copilot-gate.js';
import { copilotRuntimeEnv, copilotRuntimePolicyLook, createCopilotSessionHome } from './copilot-home.js';
import { copilotMcpServers } from './copilot-mcp.js';
import { copilotSessionConfig, startCopilotProcess } from './copilot-process.js';
import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotEvent,
  CopilotMcpServer,
  CopilotProvider,
  CopilotSdk,
  CopilotSession,
  CopilotSessionStartInput,
} from './copilot-sdk.js';
import { copilotRuntimePid, loadCopilotSdk, readCopilotInstall } from './copilot-sdk.js';
import type { CopilotMessage } from './copilot-wire.js';
import { nodePathResolver } from './paths.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INSTALL = readCopilotInstall(PACKAGE_ROOT);
const skip = INSTALL.ok
  ? false
  : `no Copilot runtime for this platform in the development install: ${INSTALL.refusal.detail}`;
const WINDOWS = process.platform === 'win32';
const SHELL = WINDOWS ? 'powershell' : 'bash';
const MARKER = 'periscope-copilot-marker';

/** A scratch layout: a profile, a temp folder, the session's directory, a further worktree and the base. */
interface Scratch {
  readonly root: string;
  readonly profile: string;
  readonly tmp: string;
  readonly work: string;
  readonly worktree: string;
  readonly base: string;
  readonly skills: string;
}

/**
 * Remove a scratch layout. A process the session ran in it may still be exiting when the session has closed
 * (Windows refuses to remove a directory a process is in), so the removal is retried for a while; one that
 * still fails names the directory, and never hides what the test itself found.
 */
async function removeScratch(dirs: Scratch): Promise<void> {
  await rm(dirs.root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }).catch(
    (error: unknown) => {
      process.stderr.write(`scratch ${dirs.root} was not removed: ${String(error)}
`);
    },
  );
}

/** Wait, a bounded while, until a process is gone. */
async function untilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function scratch(): Promise<Scratch> {
  const root = await tempDir('copilot-local');
  const layout = {
    root,
    profile: join(root, 'profile'),
    tmp: join(root, 'tmp'),
    work: join(root, 'work'),
    worktree: join(root, 'worktree'),
    base: join(root, 'base'),
    skills: join(root, 'skills'),
  };
  for (const dir of Object.values(layout)) mkdirSync(dir, { recursive: true });
  mkdirSync(join(layout.skills, 'probe-skill'), { recursive: true });
  writeFileSync(
    join(layout.skills, 'probe-skill', 'SKILL.md'),
    '---\nname: probe-skill\ndescription: A scratch skill.\n---\nSay hello.\n',
  );
  writeFileSync(join(layout.work, 'readme.txt'), 'scratch\n');
  return layout;
}

/** The environment written whole: the OS's own, a scratch profile and temp folder, every proxy dead. */
function scratchEnv(dirs: Scratch): Record<string, string> {
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
    };
  }
  return {
    PATH: `${node}:/usr/local/bin:/usr/bin:/bin`,
    HOME: dirs.profile,
    TMPDIR: dirs.tmp,
    SHELL: '/bin/bash',
    MARKER,
    ...proxies,
  };
}

function processRequest(cwd: string, overrides: Partial<AgentProcessRequest> = {}): AgentProcessRequest {
  return {
    cwd,
    env: {},
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
    model: null,
    systemPrompt: null,
    effort: null,
    permissionMode: null,
    ...overrides,
  };
}

let loaded: CopilotSdk | null = null;
async function sdk(): Promise<CopilotSdk> {
  if (loaded !== null) return loaded;
  assert.ok(INSTALL.ok);
  const read = await loadCopilotSdk(INSTALL.value);
  assert.ok(read.ok, read.ok ? '' : read.refusal.detail);
  loaded = read.value;
  return loaded;
}

const allow: Decider = () => Promise.resolve({ behavior: 'allow' });

/** One session on the real runtime, in the adapter's configuration, with what it saw recorded. */
interface Real {
  readonly client: CopilotClient;
  readonly session: CopilotSession;
  readonly gate: CopilotSessionGate;
  readonly events: CopilotEvent[];
  readonly requests: DecisionRequest[];
  readonly raised: { name: RefusalReason; detail: string }[];
  readonly started: CopilotSessionStartInput[];
  readonly home: string;
  run(name: string, args: unknown, id: string): Promise<{ resultType: unknown; text: string }>;
  close(): Promise<void>;
}

async function openReal(
  dirs: Scratch,
  options: {
    readonly decide?: Decider;
    readonly localGate?: LocalGate;
    readonly servers?: Readonly<Record<string, CopilotMcpServer>>;
    readonly skills?: readonly string[];
    readonly provider?: CopilotProvider;
    readonly model?: string;
  } = {},
): Promise<Real> {
  assert.ok(INSTALL.ok);
  const loadedSdk = await sdk();
  const made = createCopilotSessionHome(dirs.base);
  assert.ok(made.ok);
  const env = copilotRuntimeEnv(scratchEnv(dirs), made.value.env);
  const events: CopilotEvent[] = [];
  const requests: DecisionRequest[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const started: CopilotSessionStartInput[] = [];
  const servers = options.servers ?? {};
  const gate = createCopilotSessionGate({
    sessionKey: 'pin',
    cwd: dirs.work,
    decide: (request, signal) => {
      requests.push(request);
      return (options.decide ?? allow)(request, signal);
    },
    ...(options.localGate === undefined ? {} : { localGate: options.localGate }),
    decisionTimeoutMs: 30_000,
    holdAfterMs: 60_000,
    servers: Object.keys(servers),
    onOutcome: () => undefined,
    onDegrade: (name, detail) => raised.push({ name, detail }),
    onSpawnDegrades: () => undefined,
  });
  const client = new loadedSdk.CopilotClient({
    mode: 'empty',
    useLoggedInUser: false,
    baseDirectory: made.value.home,
    workingDirectory: dirs.work,
    logLevel: 'error',
    connection: loadedSdk.RuntimeConnection.forStdio({ path: INSTALL.value.runtime, env }),
  });
  await client.start();
  const signals = new AbortController();
  const config = copilotSessionConfig(processRequest(dirs.work), {
    gate,
    servers,
    skillDirectories: options.skills ?? [],
    model: options.model ?? null,
    provider: options.provider ?? null,
    tokenProvider: null,
    onEvent: (event) => {
      gate.observe(event);
      events.push(event);
    },
    signal: signals.signal,
  });
  const session = await client.createSession({
    ...config,
    hooks: { ...config.hooks, onSessionStart: (input) => void started.push(input) },
  });
  gate.identify(session.sessionId);
  gate.useToolLister(async (server) =>
    (await session.rpc.mcp.listTools({ serverName: server })).tools.map((tool) => tool.name),
  );
  return {
    client,
    session,
    gate,
    events,
    requests,
    raised,
    started,
    home: made.value.home,
    async run(name, args, id) {
      const result = (await session.rpc.tools.execute({
        name,
        arguments: args as never,
        toolCallId: id,
      })) as Record<string, unknown>;
      const text = result['textResultForLlm'];
      return { resultType: result['resultType'], text: typeof text === 'string' ? text : '' };
    },
    async close() {
      signals.abort();
      await session.disconnect().catch(() => undefined);
      await client.forceStop().catch(() => undefined);
      made.value.remove();
    },
  };
}

/** The hook's answer and the request's kind for the call `id`, read from the session's own events. */
function routeOf(real: Real, id: string): { hooked: boolean; kinds: string[] } {
  const hooked = real.events.some(
    (event) =>
      event.type === 'hook.start' &&
      JSON.stringify((event.data as { input?: unknown }).input ?? {}).includes(id),
  );
  const kinds = real.events
    .filter((event) => event.type === 'permission.requested')
    .map(
      (event) =>
        (event.data as { permissionRequest?: { kind?: string; toolCallId?: string } }).permissionRequest,
    )
    .filter((request) => request?.toolCallId === id)
    .map((request) => request?.kind ?? '(none)');
  return { hooked, kinds };
}

test(
  "Q1 and Q2: the hook fires and asks for a shell, a read, a write, an MCP tool and a skill, and the request is the hook's, decided here",
  { skip, timeout: 120_000 },
  async () => {
    const dirs = await scratch();
    const mcp = await fakeMcpHttp();
    const servers = copilotMcpServers({ 'probe-srv': { type: 'http', url: mcp.url } });
    assert.ok(servers.ok);
    const real = await openReal(dirs, { servers: servers.value, skills: [dirs.skills] });
    try {
      // The runtime's own list names the server each of its tools comes from, and the tool's name there:
      // what the adapter's open learns a server's tools from.
      let listed = await real.session.rpc.tools.getCurrentMetadata();
      if (listed.tools === null) {
        await real.session.rpc.tools.initializeAndValidate();
        listed = await real.session.rpc.tools.getCurrentMetadata();
      }
      const echo = (listed.tools ?? []).find((tool) => tool.name === 'probe-srv-echo');
      assert.equal(echo?.mcpServerName, 'probe-srv', JSON.stringify(listed.tools));
      assert.equal(echo?.mcpToolName, 'echo');
      const calls: [string, unknown][] = [
        [SHELL, { command: 'echo hello', description: 'scratch', initial_wait: 120 }],
        ['view', { path: join(dirs.work, 'readme.txt') }],
        ['create', { path: join(dirs.work, 'made.txt'), file_text: 'made\n' }],
        ['probe-srv-echo', { text: 'hi' }],
        ['skill', { skill: 'probe-skill' }],
      ];
      for (const [index, [name, args]] of calls.entries()) {
        const id = `pin-q2-${index}`;
        const before = real.requests.length;
        const done = await real.run(name, args, id);
        assert.deepEqual(routeOf(real, id), { hooked: true, kinds: ['hook'] }, `${name}'s route`);
        assert.equal(real.requests.length, before + 1, `${name} was decided by this host`);
        assert.equal(real.requests.at(-1)?.toolUseId, id);
        assert.equal(done.resultType, 'success', `${name} ran once approved: ${done.text}`);
      }
      assert.equal(
        real.requests[3]?.toolName,
        'mcp__probe-srv__echo',
        "the MCP call is spelled by the server's own list",
      );
      assert.equal(real.requests[3]?.toolKind, 'mcp');
      assert.equal(real.requests[0]?.toolKind, 'shell');
      assert.equal(real.requests[0]?.shellDialect, WINDOWS ? 'powershell' : 'posix');
      // The runtime writes a file with the platform's line endings.
      assert.equal(readFileSync(join(dirs.work, 'made.txt'), 'utf8').replace(/\r\n/g, '\n'), 'made\n');
      const hookMessage = real.events
        .filter((event) => event.type === 'permission.requested')
        .map(
          (event) =>
            (event.data as { permissionRequest?: { hookMessage?: string } }).permissionRequest?.hookMessage,
        );
      assert.ok(hookMessage.every((message) => message === COPILOT_HOOK_REASON));
      assert.deepEqual(real.raised, []);
    } finally {
      await real.close();
      await mcp.close();
      await removeScratch(dirs);
    }
  },
);

test(
  "a refused call does not run, and the model is told the gate's words",
  { skip, timeout: 120_000 },
  async () => {
    const dirs = await scratch();
    const real = await openReal(dirs, {
      decide: () => Promise.resolve({ behavior: 'deny', message: 'not here' }),
    });
    try {
      const done = await real.run(
        'create',
        { path: join(dirs.work, 'refused.txt'), file_text: 'x' },
        'pin-deny',
      );
      assert.equal(done.resultType, 'denied');
      assert.match(done.text, /not here/);
      assert.equal(existsSync(join(dirs.work, 'refused.txt')), false);
    } finally {
      await real.close();
      await removeScratch(dirs);
    }
  },
);

test(
  'Q3: in allow-all a call still asks while the hook answers ask, and the gate names the mode',
  { skip, timeout: 120_000 },
  async () => {
    const dirs = await scratch();
    const real = await openReal(dirs);
    try {
      const set = await real.session.rpc.permissions.setMode({ mode: 'allow-all' as 'manual' });
      assert.equal(set.success, true);
      const before = real.requests.length;
      await real.run('view', { path: join(dirs.work, 'readme.txt') }, 'pin-q3');
      assert.deepEqual(routeOf(real, 'pin-q3'), { hooked: true, kinds: ['hook'] });
      assert.equal(real.requests.length, before + 1, 'allow-all approved nothing by itself');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(
        real.raised.some((one) => one.name === 'gate-mode-widened'),
        'the widened mode was named',
      );
    } finally {
      await real.close();
      await removeScratch(dirs);
    }
  },
);

test(
  'control: a hook that answers allow lets a read run with no request at all, so the ask is what puts every call before this host',
  { skip, timeout: 120_000 },
  async () => {
    const dirs = await scratch();
    const real = await openReal(dirs);
    try {
      // The same session, its hook replaced for one call by one that allows.
      const allowing = {
        ...real.gate,
        preToolUse: () => ({ permissionDecision: 'allow', permissionDecisionReason: 'x' }),
      };
      const sdkSession = await real.client.createSession({
        ...copilotSessionConfig(processRequest(dirs.work), {
          gate: allowing as unknown as CopilotSessionGate,
          servers: {},
          skillDirectories: [],
          model: null,
          provider: null,
          tokenProvider: null,
          onEvent: (event) => real.events.push(event),
          signal: new AbortController().signal,
        }),
      });
      const before = real.requests.length;
      const result = (await sdkSession.rpc.tools.execute({
        name: 'view',
        arguments: { path: join(dirs.work, 'readme.txt') },
        toolCallId: 'pin-allow',
      })) as { resultType?: unknown };
      assert.equal(result.resultType, 'success', 'the read ran');
      assert.deepEqual(routeOf(real, 'pin-allow').kinds, [], 'no request was raised');
      assert.equal(real.requests.length, before, 'this host was never asked');
      await sdkSession.disconnect();
    } finally {
      await real.close();
      await removeScratch(dirs);
    }
  },
);

test(
  'Q4 and the untrusted directory: no session-start hook at create, and tools run in a directory the runtime has never seen',
  { skip, timeout: 120_000 },
  async () => {
    const dirs = await scratch();
    const real = await openReal(dirs);
    try {
      assert.deepEqual(real.started, [], 'the session-start hook was called at create');
      const trust = (
        real.session.rpc.permissions as unknown as {
          folderTrust?: { isTrusted(params: { path: string }): Promise<{ trusted: boolean }> };
        }
      ).folderTrust;
      assert.ok(trust !== undefined, "the runtime's trust read moved");
      assert.equal((await trust.isTrusted({ path: dirs.work })).trusted, false);
      const done = await real.run('view', { path: join(dirs.work, 'readme.txt') }, 'pin-untrusted');
      assert.equal(done.resultType, 'success');
    } finally {
      await real.close();
      await removeScratch(dirs);
    }
  },
);

test(
  'the census: every built-in the runtime names has a kind, is named other, or is turned off; none turned off is offered (R3)',
  { skip, timeout: 120_000 },
  async () => {
    const dirs = await scratch();
    const real = await openReal(dirs);
    try {
      const names = (await real.session.rpc.tools.getBuiltinDescriptors({})).tools.map((tool) => tool.name);
      assert.ok(names.length >= 20, `the runtime named ${names.length} built-ins; the read is broken`);
      const known = (name: string): boolean =>
        Object.hasOwn(COPILOT_TOOL_KINDS, name) ||
        COPILOT_OTHER_TOOLS.includes(name) ||
        COPILOT_EXCLUDED_TOOLS.includes(name);
      assert.deepEqual(
        names.filter((name) => !known(name)),
        [],
        'built-ins this host has no word for',
      );
      // Control: one dropped from the list of others is named.
      const dropped = COPILOT_OTHER_TOOLS.find((name) => names.includes(name));
      assert.ok(dropped !== undefined);
      assert.deepEqual(
        names.filter((name) => !known(name) || name === dropped),
        [dropped],
      );
      // R3: the tools turned off are the runtime's own, and the session offers none of them.
      // The shell's input tool is the runtime's own name for it, whether or not it describes it for a session.
      const excludedHere = COPILOT_EXCLUDED_TOOLS.filter((name) => names.includes(name));
      assert.ok(
        excludedHere.includes('manage_schedule'),
        'the scheduler is no longer a built-in: the list is stale',
      );
      const listed = (await real.session.rpc.tools.getCurrentMetadata()).tools ?? [];
      const offered = listed.map((tool) => tool.name);
      assert.ok(offered.includes('view'));
      assert.deepEqual(
        offered.filter((name) => COPILOT_EXCLUDED_TOOLS.includes(name)),
        [],
      );
      // What the open reads: every tool the session is offered that no server brings is one the tables
      // name, so an open on the pinned runtime names no stranger.
      assert.deepEqual(
        listed
          .filter((tool) => tool.mcpServerName === undefined && !known(tool.name))
          .map((tool) => tool.name),
        [],
        'the session is offered built-ins this host has no word for',
      );
    } finally {
      await real.close();
      await removeScratch(dirs);
    }
  },
);

test(
  "a command runs in the environment this host composed: the marker reaches it, and no credential's name does",
  { skip, timeout: 120_000 },
  async () => {
    const dirs = await scratch();
    const real = await openReal(dirs);
    try {
      const command = WINDOWS ? 'Get-ChildItem env: | ForEach-Object { $_.Name }' : 'env | cut -d= -f1';
      // A cold shell on a loaded host can take longer than the tool's own 30-second wait to answer.
      const done = await real.run(SHELL, { command, description: 'scratch', initial_wait: 120 }, 'pin-env');
      assert.equal(done.resultType, 'success', done.text);
      const names = done.text
        .split(/\r?\n/)
        .map((line) => line.trim().toUpperCase())
        .filter((line) => line !== '');
      assert.ok(names.includes('MARKER'), 'the marker did not reach the shell, so the read proves nothing');
      const credentials = names.filter((name) =>
        [
          'GH_TOKEN',
          'GITHUB_TOKEN',
          'GH_ENTERPRISE_TOKEN',
          'GITHUB_ENTERPRISE_TOKEN',
          'COPILOT_GITHUB_TOKEN',
          'COPILOT_SDK_AUTH_TOKEN',
          'COPILOT_CONNECTION_TOKEN',
        ].includes(name),
      );
      assert.deepEqual(credentials, []);
      assert.ok(
        names.includes('COPILOT_HOME'),
        "the SDK's own home variable, which the local gate reads as the protected path it is",
      );
    } finally {
      await real.close();
      await removeScratch(dirs);
    }
  },
);

test(
  "a write outside the session's roots is refused before it runs; one inside a further worktree lands",
  { skip, timeout: 120_000 },
  async () => {
    const dirs = await scratch();
    const gate = localGate({
      workspaceRoot: dirs.work,
      writeRoots: [dirs.worktree],
      resolve: nodePathResolver,
      protectedPaths: [],
      home: dirs.profile,
      toolFamilies: COPILOT_TOOL_FAMILIES,
      readsShellDialect: true,
      resolvesAgainstCallCwd: true,
      resolvesWritesAgainstCallCwd: true,
    });
    const real = await openReal(dirs, { localGate: gate });
    try {
      const outside = join(dirs.profile, 'outside.txt');
      const refused = await real.run('create', { path: outside, file_text: 'x' }, 'pin-escape');
      assert.equal(refused.resultType, 'denied');
      assert.match(refused.text, /path-escapes-root/);
      assert.equal(existsSync(outside), false);
      const inside = join(dirs.worktree, 'landed.txt');
      const landed = await real.run('create', { path: inside, file_text: 'landed\n' }, 'pin-worktree');
      assert.equal(landed.resultType, 'success', landed.text);
      assert.equal(readFileSync(inside, 'utf8').replace(/\r\n/g, '\n'), 'landed\n');
      // How the runtime hands this host a patch tool's input, for the local gate's reading of it.
      const patch = `*** Begin Patch\n*** Add File: ${join(dirs.profile, 'patched.txt')}\n+x\n*** End Patch\n`;
      const patched = await real.run('apply_patch', patch, 'pin-patch');
      assert.equal(patched.resultType, 'denied', `apply_patch outside the roots ran: ${patched.text}`);
      assert.match(patched.text, /path-escapes-root/, "the patch's own file was read and held to the roots");
      assert.equal(existsSync(join(dirs.profile, 'patched.txt')), false);
    } finally {
      await real.close();
      await removeScratch(dirs);
    }
  },
);

test(
  "H3-24: a sub-agent's call asks this host through the hook, as the session's own calls do; driven by a stub model, not a model",
  { skip, timeout: 180_000 },
  async () => {
    const dirs = await scratch();
    const readme = join(dirs.work, 'readme.txt');
    // The stub's script: the session spawns one sub-agent; the sub-agent reads one file, then answers.
    const stub = await stubModel(
      (request) => {
        const text = stubRequestText(request);
        const last = request.messages.at(-1);
        if (text.includes('SUB-AGENT-MARKER')) {
          return last?.role === 'tool'
            ? { text: 'sub done' }
            : { toolCalls: [{ id: 'call_sub_view', name: 'view', arguments: { path: readme } }] };
        }
        if (last?.role === 'tool') return { text: 'main done' };
        if (text.includes('SPAWN-ONE')) {
          return {
            toolCalls: [
              {
                id: 'call_task',
                name: 'task',
                arguments: {
                  name: 'probe',
                  description: 'read the readme',
                  agent_type: 'task',
                  prompt: 'SUB-AGENT-MARKER read the readme',
                  mode: 'sync',
                },
              },
            ],
          };
        }
        return { text: 'ok' };
      },
      { usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } } },
    );
    const real = await openReal(dirs, {
      model: 'stub-model',
      // No key: a literal placeholder, since the provider takes a string.
      provider: { type: 'openai', wireApi: 'completions', baseUrl: stub.url, apiKey: 'placeholder' },
    });
    try {
      await real.session.send({ prompt: 'SPAWN-ONE', mode: 'enqueue' });
      const deadline = Date.now() + 120_000;
      const idle = (): boolean =>
        real.events.some((event) => event.type === 'session.idle' && event.agentId === undefined);
      while (!idle() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(idle(), `the run did not end; the stub saw ${stub.requests.length} request(s)`);
      const decided = (id: string): DecisionRequest | undefined =>
        real.requests.find((request) => request.toolUseId === id);
      assert.ok(decided('call_task') !== undefined, "the session's own spawn was decided here");
      const sub = decided('call_sub_view');
      assert.ok(sub !== undefined, "the sub-agent's call was never put to this host");
      assert.deepEqual(
        routeOf(real, 'call_sub_view'),
        { hooked: true, kinds: ['hook'] },
        "the sub-agent's call took the joined route",
      );
      assert.equal(sub.toolKind, 'file_read');
      assert.ok(sub.agentId !== null || sub.agentType !== null, 'the decision request names the sub-agent');
      const started = real.events.find(
        (event) =>
          event.type === 'tool.execution_start' &&
          (event.data as { toolCallId?: string }).toolCallId === 'call_sub_view',
      );
      assert.equal(
        (started?.data as { parentToolCallId?: string } | undefined)?.parentToolCallId,
        'call_task',
        "the sub-agent's call names the call that spawned it",
      );
      assert.ok(real.events.some((event) => event.type === 'subagent.started'));
      assert.ok(real.events.some((event) => event.type === 'subagent.completed'));
      // The usage the runtime reports for a stub call: the cached input counted inside the input.
      const usage = real.events.find((event) => event.type === 'assistant.usage')?.data as
        { inputTokens?: number; cacheReadTokens?: number } | undefined;
      assert.equal(usage?.inputTokens, 100);
      assert.equal(usage?.cacheReadTokens, 40);
      assert.deepEqual(real.raised, []);
    } finally {
      await real.close();
      await stub.close();
      await removeScratch(dirs);
    }
  },
);

test(
  "a model's call to a server's tool starts with the server and the tool stated, which is what its item is named from; driven by a stub model",
  { skip, timeout: 180_000 },
  async () => {
    const dirs = await scratch();
    const mcp = await fakeMcpHttp();
    const servers = copilotMcpServers({ 'probe-srv': { type: 'http', url: mcp.url } });
    assert.ok(servers.ok);
    const stub = await stubModel((request) =>
      request.messages.at(-1)?.role === 'tool'
        ? { text: 'done' }
        : { toolCalls: [{ id: 'call_mcp', name: 'probe-srv-echo', arguments: { text: 'hi' } }] },
    );
    const real = await openReal(dirs, {
      servers: servers.value,
      model: 'stub-model',
      provider: { type: 'openai', wireApi: 'completions', baseUrl: stub.url, apiKey: 'placeholder' },
    });
    try {
      await real.session.send({ prompt: 'call the server', mode: 'enqueue' });
      const deadline = Date.now() + 120_000;
      const idle = (): boolean =>
        real.events.some((event) => event.type === 'session.idle' && event.agentId === undefined);
      while (!idle() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(idle(), `the run did not end; the stub saw ${stub.requests.length} request(s)`);
      const begun = real.events.find(
        (event) =>
          event.type === 'tool.execution_start' &&
          (event.data as { toolCallId?: string }).toolCallId === 'call_mcp',
      )?.data as { toolName?: string; mcpServerName?: string; mcpToolName?: string } | undefined;
      assert.ok(begun !== undefined, 'the call never started');
      assert.equal(begun.toolName, 'probe-srv-echo');
      assert.equal(begun.mcpServerName, 'probe-srv', JSON.stringify(begun));
      assert.equal(begun.mcpToolName, 'echo', JSON.stringify(begun));
      assert.equal(real.requests.find((request) => request.toolUseId === 'call_mcp')?.toolKind, 'mcp');
    } finally {
      await real.close();
      await stub.close();
      await mcp.close();
      await removeScratch(dirs);
    }
  },
);

/** Whether a process is still running. */
function alive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start the adapter on the real runtime, reading back its client and session as it makes them. */
async function adapterOn(dirs: Scratch): Promise<{
  readonly proc: ReturnType<typeof startCopilotProcess>;
  readonly messages: CopilotMessage[];
  readonly ended: Promise<unknown>;
  readonly client: () => CopilotClient | null;
  readonly session: () => CopilotSession | null;
}> {
  let client: CopilotClient | null = null;
  let session: CopilotSession | null = null;
  const loadedSdk = await sdk();
  // The real client, made as the adapter asks, with its session read back as the adapter creates it.
  const Watched = function (options: CopilotClientOptions): CopilotClient {
    const made = new loadedSdk.CopilotClient(options);
    const create = made.createSession.bind(made);
    made.createSession = async (config) => {
      const created = await create(config);
      session = created;
      return created;
    };
    client = made;
    return made;
  };
  const gate = createCopilotSessionGate({
    sessionKey: 'pin',
    cwd: dirs.work,
    decide: allow,
    decisionTimeoutMs: 30_000,
    holdAfterMs: 60_000,
    servers: [],
    onOutcome: () => undefined,
    onDegrade: () => undefined,
    onSpawnDegrades: () => undefined,
  });
  const proc = startCopilotProcess(
    processRequest(dirs.work, { env: scratchEnv(dirs) }),
    {
      sdk: PACKAGE_ROOT,
      base: dirs.base,
      loadSdk: () =>
        Promise.resolve({
          ok: true,
          value: {
            RuntimeConnection: loadedSdk.RuntimeConnection,
            // A plain function returns the client it made when called with `new`, as the adapter calls it.
            CopilotClient: Watched as unknown as CopilotSdk['CopilotClient'],
          },
        }),
      policyHooks: () => Promise.resolve({ found: [], unread: [] }),
    },
    () => undefined,
    null,
    gate,
    [dirs.tmp],
  );
  const messages: CopilotMessage[] = [];
  let settled: unknown = 'running';
  const ended = (async (): Promise<unknown> => {
    try {
      for await (const message of proc.messages) messages.push(message);
      return null;
    } catch (error) {
      return error;
    }
  })();
  void ended.then((value) => {
    settled = value;
  });
  const deadline = Date.now() + 60_000;
  while (
    !messages.some((message) => message.kind === 'opened') &&
    settled === 'running' &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(
    messages.some((message) => message.kind === 'opened'),
    `the open was not proven: ${String(settled)}`,
  );
  return { proc, messages, ended, client: () => client, session: () => session };
}

/** Start `command` in the session's shell, in the background, and read back the pid it writes. */
async function startedIn(
  session: CopilotSession,
  dirs: Scratch,
  command: (pidFile: string) => string,
  id: string,
): Promise<number> {
  const pidFile = join(dirs.work, `${id}.pid`);
  await session.rpc.tools.execute({
    name: SHELL,
    arguments: { command: command(pidFile), description: 'scratch', mode: 'async' },
    toolCallId: id,
  });
  // A cold shell on a loaded host can take most of a minute to run its first command.
  const written = (): string => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '');
  const deadline = Date.now() + 90_000;
  while (!/^\d+$/.test(written()) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const pid = Number(written());
  assert.ok(Number.isInteger(pid) && pid > 0, `no pid was written to ${pidFile}`);
  return pid;
}

test(
  'before any session, signed in as nobody, the runtime says which hooks it finds and what the managed settings hold, in the shape this host reads',
  { skip, timeout: 120_000 },
  async () => {
    assert.ok(INSTALL.ok);
    const dirs = await scratch();
    const loadedSdk = await sdk();
    const made = createCopilotSessionHome(dirs.base);
    assert.ok(made.ok);
    const client = new loadedSdk.CopilotClient({
      mode: 'empty',
      useLoggedInUser: false,
      baseDirectory: made.value.home,
      workingDirectory: dirs.work,
      logLevel: 'error',
      connection: loadedSdk.RuntimeConnection.forStdio({
        path: INSTALL.value.runtime,
        env: copilotRuntimeEnv(scratchEnv(dirs), made.value.env),
      }),
    });
    await client.start();
    try {
      const discovered = await client.rpc.hooks.discover({ excludeHostHooks: true });
      const managed = await client.rpc.managedSettings.read();
      const answered: { hooks: unknown; errors: unknown } = discovered;
      assert.ok(Array.isArray(answered.hooks), JSON.stringify(discovered));
      assert.ok(Array.isArray(answered.errors), JSON.stringify(discovered));
      for (const hook of discovered.hooks) {
        assert.equal(typeof hook.hookType, 'string', JSON.stringify(hook));
        assert.equal(typeof hook.origin, 'string', JSON.stringify(hook));
        assert.equal(typeof hook.enabled, 'boolean', JSON.stringify(hook));
      }
      assert.ok(typeof managed === 'object' && managed !== null, JSON.stringify(managed));
      // Whatever this machine's policy holds, neither answer is one the look gives up on.
      const look = copilotRuntimePolicyLook({ answer: discovered }, { answer: managed });
      assert.deepEqual(
        look.unread.filter((one) => /this host cannot read/.test(one)),
        [],
      );
    } finally {
      await client.forceStop().catch(() => undefined);
      made.value.remove();
      await removeScratch(dirs);
    }
  },
);

test(
  "the adapter's open proves itself on the runtime, and its close leaves nothing of the session alive, a command its shell still runs included",
  { skip, timeout: 180_000 },
  async () => {
    const dirs = await scratch();
    const run = await adapterOn(dirs);
    try {
      const open = run.messages.find((message) => message.kind === 'opened');
      assert.ok(open?.kind === 'opened');
      assert.deepEqual(
        open.tools.filter((name) => COPILOT_EXCLUDED_TOOLS.includes(name)),
        [],
      );
      assert.equal(open.agentMode, 'interactive');
      const client = run.client();
      const session = run.session();
      assert.ok(client !== null && session !== null);
      const runtime = copilotRuntimePid(client);
      assert.ok(runtime !== null, "the SDK's runtime process member moved; the close could not end the tree");
      assert.equal(alive(runtime), true, 'control: the runtime reads as alive while the session is open');
      // A command the shell started and still waits on: a grandchild of the runtime.
      const command = await startedIn(
        session,
        dirs,
        (pidFile) =>
          WINDOWS
            ? `$p = Start-Process -FilePath ping -ArgumentList '-n','120','127.0.0.1' -NoNewWindow -PassThru; Set-Content -Path '${pidFile}' -Value $p.Id; $p.WaitForExit()`
            : `sleep 120 & echo $! > '${pidFile}'; wait`,
        'pin-in-tree',
      );
      assert.equal(alive(command), true, 'control: the command reads as alive before the close');
      run.proc.close();
      assert.equal(await run.ended, null);
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.equal(alive(runtime), false, 'the runtime outlived the close');
      assert.equal(alive(command), false, 'a command the shell still ran outlived the close');
      assert.deepEqual(readdirSync(join(dirs.base, 'sessions')), [], "the session's home was removed");
      assert.ok(
        existsSync(join(dirs.base, 'state', open.sessionId)),
        "the session's state was kept for a resume",
      );
    } finally {
      run.proc.close();
      await removeScratch(dirs);
    }
  },
);

test(
  'the residual: a command detached from its shell on purpose is in no process tree of the session, and outlives the close',
  {
    skip: skip || (WINDOWS ? false : 'pinned where a detached start leaves its parent at once: Windows'),
    timeout: 180_000,
  },
  async () => {
    const dirs = await scratch();
    const run = await adapterOn(dirs);
    let detached: number | null = null;
    try {
      const session = run.session();
      assert.ok(session !== null);
      // Detached the way an agent detaches one: started by a shell that then exits, so its parent is gone
      // and no walk of the session's tree reaches it. The launching shell is its own short-lived process,
      // so whether the session's shell has exited by the close does not decide the result.
      detached = await startedIn(
        session,
        dirs,
        (pidFile) => {
          const launch = `$p = Start-Process -FilePath ping -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden -PassThru; Set-Content -Path '${pidFile}' -Value $p.Id`;
          return `powershell -NoProfile -EncodedCommand ${Buffer.from(launch, 'utf16le').toString('base64')}`;
        },
        'pin-detached',
      );
      // The precondition the residual names: the command's own parent has exited before the close.
      const parentOf = (pid: number): number | null => {
        const read = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
          ],
          { encoding: 'utf8', windowsHide: true },
        ).trim();
        return /^\d+$/.test(read) ? Number(read) : null;
      };
      const parent = parentOf(detached);
      const deadline = Date.now() + 60_000;
      while (parent !== null && alive(parent) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(parent === null || !alive(parent), "the detached command's launching shell did not exit");
      run.proc.close();
      await run.ended;
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.equal(
        alive(detached),
        true,
        'a detached command now ends with the session: the residual the docs name is gone',
      );
    } finally {
      if (detached !== null && alive(detached)) {
        process.kill(detached);
        await untilGone(detached);
      }
      run.proc.close();
      await removeScratch(dirs);
    }
  },
);
