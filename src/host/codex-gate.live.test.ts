/**
 * The Codex gate against the binary the operator installed, signed in: what only a real run settles.
 *
 * It runs only with `PERISCOPE_LIVE=1`, `PERISCOPE_CODEX_BIN` and `PERISCOPE_CODEX_HOME` (a home signed
 * in with `codex login`). Without all three each property is NOT exercised, and the skip says so. Every
 * run spends plan or API usage, so each prompt is short. Each test prints its receipts as JSON lines,
 * which are the record of what was measured; the assertions hold only what the gate depends on.
 *
 * Run it from a plain terminal, not from inside an agent session, which would lend it that session's
 * tools:
 *
 *   npm run build
 *   PERISCOPE_LIVE=1 PERISCOPE_CODEX_BIN=<binary> PERISCOPE_CODEX_HOME=<home> node --test dist/host/codex-gate.live.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonObject } from '../control/frames.js';
import type { RefusalReason } from '../core/refusal.js';
import type { DecisionRequest } from '../gate/decision.js';
import { HOOK_CHANNEL_VARIABLE, HOOK_DEADLINE_VARIABLE, HOOK_TOKEN_VARIABLE } from '../gate/hook-exchange.js';
import { composeSpawnEnv } from '../sessions/spawn-env.js';
import type { AgentProcessRequest } from './agent-process.js';
import { codexCommand } from './codex-binary.js';
import { createCodexSessionGate } from './codex-gate.js';
import { CodexGateWatch } from './codex-gate-watch.js';
import { codexAppServerArgs, codexSessionFlags } from './codex-home.js';
import {
  codexHookLines,
  codexHookPowerShell,
  hookTrustWrite,
  installCodexHook,
  listedHooks,
  pendingCodexHookState,
  probeCodexHook,
} from './codex-hook.js';
import { startCodexProcess } from './codex-process.js';
import type { CodexMessage } from './codex-wire.js';
import { packageVersion } from './package-facts.js';
import { startStdioRpc } from './stdio-rpc.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const BINARY = process.env['PERISCOPE_CODEX_BIN'] ?? '';
const HOME = process.env['PERISCOPE_CODEX_HOME'] ?? '';
const skip = !LIVE
  ? 'PERISCOPE_LIVE is not set — this property is NOT exercised'
  : BINARY === '' || HOME === ''
    ? 'PERISCOPE_CODEX_BIN and PERISCOPE_CODEX_HOME are not both set — this property is NOT exercised'
    : false;

const ENV_LISTING = process.platform === 'win32' ? 'Get-ChildItem env: | ForEach-Object Name' : 'env';

/** One receipt line, as the measurement's record. */
const receipt = (name: string, value: unknown): void => {
  console.log(JSON.stringify({ receipt: name, value }));
};

/** A member read as text, or empty when it is not one. */
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

/** A scratch git repository with an `AGENTS.md` and a one-tool stdio MCP server. */
function scratchRepository(): { dir: string; mcpServer: string } {
  const dir = mkdtempSync(`${tmpdir()}/periscope-codex-live-`);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(
    join(dir, 'AGENTS.md'),
    'Answer in one short line. Run exactly the tools you are asked to run.\n',
  );
  const mcpServer = join(dir, 'fake-mcp.mjs');
  writeFileSync(
    mcpServer,
    [
      "import { createInterface } from 'node:readline';",
      'const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);',
      'createInterface({ input: process.stdin }).on("line", (line) => {',
      '  const message = JSON.parse(line);',
      '  if (message.id === undefined) return;',
      '  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });',
      '  else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echoes text.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });',
      '  else if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(message.params.arguments?.text ?? "") }] } });',
      '  else send({ jsonrpc: "2.0", id: message.id, result: {} });',
      '});',
      '',
    ].join('\n'),
  );
  return { dir, mcpServer };
}

function processRequest(
  cwd: string,
  env: Record<string, string>,
  overrides: Partial<AgentProcessRequest> = {},
): AgentProcessRequest {
  return {
    cwd,
    env,
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

/** The shell a running hook process was started under, read from its parent; null when none is found. */
function hookShell(): string | null {
  try {
    if (process.platform === 'win32') {
      const script =
        "$hook = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*hook codex*' } | Select-Object -First 1; " +
        'if ($hook) { $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($hook.ParentProcessId)"; ' +
        '$grand = Get-CimInstance Win32_Process -Filter "ProcessId=$($parent.ParentProcessId)"; "$($parent.CommandLine) <- $($grand.CommandLine)" }';
      return (
        execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim() ||
        null
      );
    }
    const listing = execFileSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8' }).split('\n');
    const hook = listing.find((line) => line.includes('hook codex'));
    const parent = hook?.trim().split(/\s+/)[1];
    return parent === undefined
      ? null
      : (listing.find((line) => line.trim().startsWith(`${parent} `)) ?? null);
  } catch {
    return null;
  }
}

/** Collect a process's messages until `done` holds or the bound passes. */
async function collect(
  messages: AsyncIterable<CodexMessage>,
  sink: CodexMessage[],
  done: () => boolean,
  ms: number,
): Promise<void> {
  const deadline = Date.now() + ms;
  const iterator = messages[Symbol.asyncIterator]();
  while (!done() && Date.now() < deadline) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    if (next === null) continue;
    if (next.done === true) return;
    sink.push(next.value);
  }
}

const turnCompleted = (sink: readonly CodexMessage[]): boolean =>
  sink.some((message) => message.kind === 'notification' && message.method === 'turn/completed');

test(
  'live: a gated session on the installed Codex: the hook decides every call it sees, and what Codex does around it is recorded',
  { skip, timeout: 600_000 },
  async () => {
    const { dir, mcpServer } = scratchRepository();
    const configBefore = existsSync(join(HOME, 'config.toml'))
      ? readFileSync(join(HOME, 'config.toml'), 'utf8')
      : '';
    const baseEnv = composeSpawnEnv(process.env);
    const lines = codexHookLines(HOME);
    const installed = installCodexHook(HOME, lines);
    assert.ok(installed.ok, installed.ok ? '' : installed.refusal.detail);
    const probeEnv = { ...baseEnv, CODEX_HOME: HOME };
    const probed = await probeCodexHook(lines, { env: probeEnv, version: packageVersion() });
    receipt('probe', {
      ok: probed.ok,
      shell: process.platform === 'win32' ? (codexHookPowerShell(probeEnv) ?? 'cmd.exe') : '/bin/sh',
      detail: probed.ok ? null : probed.refusal.detail,
    });
    const hook = pendingCodexHookState(lines, () =>
      probeCodexHook(lines, { env: probeEnv, version: packageVersion() }),
    );
    hook.report({ installed: { ok: true, value: undefined }, probed });

    const asked: DecisionRequest[] = [];
    const events: unknown[] = [];
    const degrades: string[] = [];
    const spawnDegrades: string[] = [];
    let shellOfHook: string | null = null;
    const gate = createCodexSessionGate({
      sessionKey: 'live-session',
      cwd: dir,
      decide: (request) => {
        asked.push(request);
        shellOfHook ??= hookShell();
        const command =
          typeof (request.toolInput as JsonObject | null)?.['command'] === 'string'
            ? textOf((request.toolInput as JsonObject)['command'])
            : '';
        const allowed = request.toolName === 'Bash' && command.trim() === ENV_LISTING;
        return Promise.resolve(
          allowed
            ? { behavior: 'allow' }
            : {
                behavior: 'deny',
                message: 'periscope live probe: every call but the environment listing is denied',
              },
        );
      },
      decisionTimeoutMs: 50_000,
      holdAfterMs: 250,
      hooksPath: lines.hooksPath,
      version: packageVersion(),
      onOutcome: () => undefined,
      onDegrade: (name: RefusalReason, detail: string) => degrades.push(`${name}: ${detail}`),
      onSpawnDegrades: (names) => spawnDegrades.push(...names),
      onHookEvent: (event) => events.push(event),
    });
    const sink: CodexMessage[] = [];
    const started = startCodexProcess(
      processRequest(
        dir,
        { ...baseEnv, ...gate.env },
        {
          mcpServers: { fake: { type: 'stdio', command: process.execPath, args: [mcpServer] } },
        },
      ),
      { binary: BINARY, home: HOME, clientVersion: packageVersion(), hook },
      (detail) => degrades.push(`process: ${detail}`),
      null,
      gate,
    );
    try {
      await collect(
        started.messages,
        sink,
        () => sink.some((message) => message.kind === 'answer' && message.method === 'mcpServerStatus/list'),
        120_000,
      );
      started.prompt(
        `Do exactly these four steps and nothing else, then stop. 1) Run the shell command: ${ENV_LISTING} ` +
          '2) Run the shell command: echo periscope-live 3) Create a file named live.txt containing ok 4) Call the tool echo on the MCP server fake with text hi',
      );
      await collect(started.messages, sink, () => turnCompleted(sink), 300_000);
    } finally {
      started.close();
    }

    const notifications = sink.flatMap((message) => (message.kind === 'notification' ? [message] : []));
    const requests = sink.flatMap((message) => (message.kind === 'server_request' ? [message] : []));
    const answers = sink.flatMap((message) => (message.kind === 'answer' ? [message] : []));
    const runs = notifications
      .filter((message) => message.method === 'hook/completed')
      .map((message) => message.params['run'] as JsonObject);
    const started_ = notifications
      .filter((message) => message.method === 'item/started')
      .map((message) => message.params['item'] as JsonObject);
    const completed = notifications
      .filter((message) => message.method === 'item/completed')
      .map((message) => message.params['item'] as JsonObject);
    const decidedIds = asked.map((request) => request.toolUseId);
    const deniedIds = asked
      .filter(
        (request) =>
          !(
            request.toolName === 'Bash' &&
            textOf((request.toolInput as JsonObject)['command']).trim() === ENV_LISTING
          ),
      )
      .map((request) => request.toolUseId);
    const envItem = completed.find(
      (item) => item['type'] === 'commandExecution' && textOf(item['aggregatedOutput']).includes('PATH'),
    );
    const envOutput = textOf(envItem?.['aggregatedOutput']);
    const threadAnswer = answers.find((message) => message.method === 'thread/start')?.result ?? {};
    const configAfter = existsSync(join(HOME, 'config.toml'))
      ? readFileSync(join(HOME, 'config.toml'), 'utf8')
      : '';

    receipt(
      'stdin keys and casing',
      events.map((event) => Object.keys(event as JsonObject)),
    );
    receipt(
      'hook_event_name',
      events.map((event) => (event as JsonObject)['hook_event_name']),
    );
    receipt('the shell the hook ran under (its parent, then its parent)', shellOfHook);
    receipt(
      'hook runs',
      runs.map((run) => ({
        id: run['id'],
        status: run['status'],
        durationMs: run['durationMs'],
        entries: run['entries'],
      })),
    );
    receipt(
      'run-id suffixes against decided call ids',
      runs.map((run) => ({
        suffixMatches: decidedIds.some((id) => textOf(run['id']).endsWith(`:${id}`)),
        id: run['id'],
      })),
    );
    receipt(
      'items started',
      started_.map((item) => ({
        type: item['type'],
        id: item['id'],
        command: item['command'] ?? null,
        server: item['server'] ?? null,
      })),
    );
    receipt(
      'item ids against decided call ids',
      started_.map((item) => ({ id: item['id'], decided: decidedIds.includes(textOf(item['id'])) })),
    );
    receipt(
      'an item started for a blocked call',
      started_.filter((item) => deniedIds.includes(textOf(item['id']))).map((item) => item['id']),
    );
    receipt('the shell the Bash tool ran under (the command item)', envItem?.['command'] ?? null);
    receipt(
      'approval requests',
      requests.map((message) => ({
        method: message.method,
        itemId: message.params['itemId'] ?? null,
        kind: message.params['kind'] ?? null,
        answer: message.answer,
      })),
    );
    receipt(
      'approval itemId equals a decided call id',
      requests.map((message) => decidedIds.includes(textOf(message.params['itemId']))),
    );
    const resolved = notifications
      .filter((message) => message.method === 'serverRequest/resolved')
      .map((message) => message.params['requestId']);
    receipt('serverRequest/resolved after each answer', {
      answered: requests.map((message) => message.id),
      resolved,
    });
    receipt(
      'tokenUsage cadence (methods in order)',
      notifications
        .map((message) => message.method)
        .filter(
          (method) =>
            method === 'thread/tokenUsage/updated' ||
            method === 'item/completed' ||
            method === 'turn/completed',
        ),
    );
    const turnDone = notifications.find((message) => message.method === 'turn/completed');
    receipt(
      'turn/completed.turn.items length',
      Array.isArray((turnDone?.params['turn'] as JsonObject | undefined)?.['items'])
        ? ((turnDone?.params['turn'] as JsonObject)['items'] as unknown[]).length
        : null,
    );
    receipt(
      'the model-facing block message',
      completed
        .map((item) => item['aggregatedOutput'] ?? item['error'] ?? null)
        .filter((text) => typeof text === 'string' && /blocked/i.test(text)),
    );
    receipt(
      'agent text',
      completed.filter((item) => item['type'] === 'agentMessage').map((item) => item['text']),
    );
    receipt(
      'hook latency median (ms) from the runs Codex reported',
      median(runs.map((run) => Number(run['durationMs'])).filter((value) => Number.isFinite(value))),
    );
    receipt(
      'the MCP surface',
      answers.find((message) => message.method === 'mcpServerStatus/list')?.result ?? null,
    );
    receipt('instructionSources (AGENTS.md loaded)', threadAnswer['instructionSources'] ?? null);
    receipt(
      'config.toml gained a projects entry',
      /\[projects/.test(configAfter) && !/\[projects/.test(configBefore),
    );
    receipt('spawn-known degrades', spawnDegrades);
    receipt('degrades raised', degrades);
    const leaked = [
      HOOK_CHANNEL_VARIABLE,
      HOOK_TOKEN_VARIABLE,
      HOOK_DEADLINE_VARIABLE,
      'PERISCOPE_CODEX_ENDPOINT_KEY',
    ].filter((name) => envOutput.includes(name));
    receipt("the agent's shell sees the hook's variables", {
      listed: envItem !== undefined,
      leaked,
      tokenValueSeen: envOutput.includes(gate.env[HOOK_TOKEN_VARIABLE] ?? '\u0000'),
    });

    assert.deepEqual(leaked, [], "the agent's shell saw a variable the exclusion names");
    assert.ok(asked.length > 0, 'no tool call reached the gate');
    for (const id of deniedIds) {
      assert.equal(
        completed.some(
          (item) => item['id'] === id && item['status'] === 'completed' && item['type'] !== 'agentMessage',
        ),
        false,
        `the denied call ${id} completed`,
      );
    }
    rmSync(dir, { recursive: true, force: true });
  },
);

test(
  'live: model/list on a custom provider, granular refused on a stable connection, two app-servers on one home',
  { skip, timeout: 300_000 },
  async () => {
    const env = { ...composeSpawnEnv(process.env), CODEX_HOME: HOME };
    const command = codexCommand(BINARY, codexAppServerArgs(codexSessionFlags('default')));
    const { dir } = scratchRepository();
    const peers = [0, 1].map(() =>
      startStdioRpc({
        command: command.command,
        args: command.args,
        cwd: dir,
        env,
        onNotification: () => undefined,
      }),
    );
    try {
      const opened = await Promise.all(
        peers.map(async (started) => {
          if (!started.ok) return { error: started.refusal.detail };
          const peer = started.value;
          const init = await peer.request(
            'initialize',
            {
              clientInfo: { name: 'periscope', title: null, version: packageVersion() },
              capabilities: { experimentalApi: false },
            },
            30_000,
          );
          peer.notify('initialized', {});
          return { init: init.ok, error: init.ok ? null : init.refusal.detail };
        }),
      );
      receipt('two app-servers on one home', opened);
      const first = peers[0];
      assert.ok(first?.ok);
      const peer = first.value;
      const before = await peer.request('model/list', {}, 30_000);
      const provider = {
        model_providers: {
          'periscope-live-probe': {
            name: 'live probe',
            base_url: 'http://127.0.0.1:9/v1',
            wire_api: 'responses',
            env_key: 'PERISCOPE_CODEX_ENDPOINT_KEY',
          },
        },
      };
      const opened_ = await peer.request(
        'thread/start',
        {
          modelProvider: 'periscope-live-probe',
          config: provider,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          ephemeral: true,
        },
        60_000,
      );
      const after = await peer.request('model/list', {}, 30_000);
      const ids = (result: typeof before): unknown =>
        result.ok
          ? ((result.value as JsonObject)['data'] as JsonObject[] | undefined)?.map((model) => model['id'])
          : result.refusal.detail;
      receipt('model/list before and after a thread opens on a custom provider', {
        before: ids(before),
        threadOpened: opened_.ok ? true : opened_.refusal.detail,
        after: ids(after),
      });
      const granular = await peer.request(
        'thread/start',
        {
          approvalPolicy: { granular: { sandbox_approval: true, rules: true, mcp_elicitations: true } },
          ephemeral: true,
        },
        30_000,
      );
      receipt(
        'granular on thread/start over a stable connection',
        granular.ok ? 'accepted' : granular.refusal.detail,
      );
    } finally {
      for (const started of peers) if (started.ok) await started.value.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'live: a hook that sleeps past its timeout lets the call run, Codex reports the run failed, and the watch names gate-hook-timed-out',
  { skip, timeout: 600_000 },
  async () => {
    const lines = codexHookLines(HOME);
    const original = existsSync(lines.hooksPath) ? readFileSync(lines.hooksPath, 'utf8') : null;
    const sleeper = join(HOME, 'hooks', 'periscope-sleep-probe.cmd');
    writeFileSync(sleeper, `@"${process.execPath}" -e "setTimeout(() => {}, 20000)"\r\n`);
    const posixSleep = `'${process.execPath}' -e 'setTimeout(() => {}, 20000)'`;
    writeFileSync(
      lines.hooksPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { hooks: [{ type: 'command', command: posixSleep, commandWindows: sleeper, timeout: 3 }] },
            ],
          },
        },
        null,
        2,
      ),
    );
    const env = { ...composeSpawnEnv(process.env), CODEX_HOME: HOME };
    const { dir } = scratchRepository();
    try {
      // Trust the sleeping hook as Codex's own interface would.
      const command = codexCommand(BINARY, codexAppServerArgs(codexSessionFlags('default')));
      const started = startStdioRpc({
        command: command.command,
        args: command.args,
        cwd: dir,
        env,
        onNotification: () => undefined,
      });
      assert.ok(started.ok);
      await started.value.request(
        'initialize',
        {
          clientInfo: { name: 'periscope', title: null, version: packageVersion() },
          capabilities: { experimentalApi: false },
        },
        30_000,
      );
      started.value.notify('initialized', {});
      const listed = await started.value.request('hooks/list', { cwds: [dir] }, 30_000);
      const sleeping = listed.ok
        ? listedHooks(listed.value as JsonObject).find(
            (one) => one.command === (process.platform === 'win32' ? sleeper : posixSleep),
          )
        : undefined;
      assert.ok(sleeping !== undefined, 'the sleeping hook is not listed');
      await started.value.request('config/batchWrite', hookTrustWrite(sleeping), 30_000);
      await started.value.close();

      const raised: string[] = [];
      const watch = new CodexGateWatch({
        hooksPath: lines.hooksPath,
        decided: () => false,
        raise: (name, detail) => raised.push(`${name}: ${detail}`),
        blockedByHook: () => undefined,
        takeWrittenInput: () => false,
      });
      const sink: CodexMessage[] = [];
      const ungated = startCodexProcess(processRequest(dir, env), {
        binary: BINARY,
        home: HOME,
        clientVersion: packageVersion(),
      });
      try {
        await collect(
          ungated.messages,
          sink,
          () =>
            sink.some((message) => message.kind === 'answer' && message.method === 'mcpServerStatus/list'),
          120_000,
        );
        ungated.prompt('Run the shell command: echo periscope-timeout-probe. Then stop.');
        await collect(ungated.messages, sink, () => turnCompleted(sink), 300_000);
      } finally {
        ungated.close();
      }
      for (const message of sink)
        if (message.kind === 'notification') watch.observe(message.method, message.params);
      const runs = sink.flatMap((message) =>
        message.kind === 'notification' && message.method === 'hook/completed'
          ? [message.params['run'] as JsonObject]
          : [],
      );
      const ran = sink.some(
        (message) =>
          message.kind === 'notification' &&
          message.method === 'item/completed' &&
          textOf((message.params['item'] as JsonObject)['aggregatedOutput']).includes(
            'periscope-timeout-probe',
          ),
      );
      receipt(
        'timed-out hook runs',
        runs.map((run) => ({ status: run['status'], entries: run['entries'] })),
      );
      receipt('the call ran despite the hook', ran);
      receipt('degrades the watch raised', raised);
      assert.ok(
        raised.some((line) => line.startsWith('gate-hook-timed-out: ')),
        'the timeout was not named',
      );
    } finally {
      if (original === null) rmSync(lines.hooksPath, { force: true });
      else writeFileSync(lines.hooksPath, original);
      rmSync(sleeper, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'live: a hook call through the written shim and the shell Codex uses, start to answer, ten times',
  { skip, timeout: 300_000 },
  async () => {
    const lines = codexHookLines(HOME);
    const probeEnv: Record<string, string> = {
      ...composeSpawnEnv(process.env),
      CODEX_HOME: HOME,
    };
    const [program, args]: [string, string[]] =
      process.platform !== 'win32'
        ? ['/bin/sh', ['-c', `${lines.posix} --probe`]]
        : [
            codexHookPowerShell(probeEnv) ?? probeEnv['COMSPEC'] ?? 'cmd.exe',
            codexHookPowerShell(probeEnv) === null
              ? ['/C', `${lines.windows} --probe`]
              : ['-NoProfile', '-Command', `${lines.windows} --probe`],
          ];
    const times: number[] = [];
    for (let run = 0; run < 10; run += 1) {
      const startedAt = process.hrtime.bigint();
      await new Promise<void>((resolve) => {
        const child = spawn(program, args, { env: probeEnv, windowsHide: true });
        child.on('close', () => resolve());
        child.stdin.end('{"probe":"periscope"}');
      });
      times.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
    }
    receipt('hook start-to-answer through the shell, median of ten (ms)', {
      program,
      median: median(times),
      times,
    });
  },
);
