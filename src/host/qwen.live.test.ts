/**
 * Qwen Code under the gate against the CLI the operator installed, on a model endpoint: what only a real
 * run settles.
 *
 * It runs only with `PERISCOPE_LIVE=1`, `PERISCOPE_QWEN_BIN` (the installed package's `cli-entry.js`),
 * `PERISCOPE_QWEN_ENDPOINT_URL`, `PERISCOPE_QWEN_ENDPOINT_KEY` and `PERISCOPE_QWEN_MODEL`;
 * `PERISCOPE_QWEN_ENDPOINT_API` names the endpoint's wire API (`openai-chat`, the default,
 * `openai-responses` or `anthropic-messages`). Without them each property is NOT exercised, and the skip
 * says so. Every run spends the endpoint's usage, so each prompt is short. Each test prints its receipts
 * as JSON lines, which are the record of what was measured; the assertions hold only what the gate
 * depends on.
 *
 * Run it from a plain terminal, not from inside an agent session, which would lend it that session's
 * tools:
 *
 *   npm run build
 *   PERISCOPE_LIVE=1 PERISCOPE_QWEN_BIN=<cli-entry.js> PERISCOPE_QWEN_ENDPOINT_URL=<url> PERISCOPE_QWEN_ENDPOINT_KEY=<key> PERISCOPE_QWEN_MODEL=<model> node --test dist/host/qwen.live.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EndpointWireApi, JsonObject } from '../control/frames.js';
import type { RefusalReason } from '../core/refusal.js';
import type { DecisionRequest } from '../gate/decision.js';
import { localGate, QWEN_TOOL_FAMILIES } from '../gate/local.js';
import { composeSpawnEnv } from '../sessions/spawn-env.js';
import { fakeMcpHttp } from '../test-support/fake-mcp-http.js';
import { LiveStream, closeAndWait, removeScratch } from '../test-support/live-session.js';
import type { AgentProcessRequest } from './agent-process.js';
import { nodePathResolver } from './paths.js';
import type { QwenEndpointRoute } from './qwen-endpoints.js';
import { createQwenSessionGate } from './qwen-gate.js';
import { qwenAskRules } from './qwen-home.js';
import { QWEN_NAMES } from './qwen-names.js';
import { startQwenProcess } from './qwen-process.js';
import type { QwenMessage } from './qwen-wire.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const BINARY = process.env['PERISCOPE_QWEN_BIN'] ?? '';
const URL = process.env['PERISCOPE_QWEN_ENDPOINT_URL'] ?? '';
const KEY = process.env['PERISCOPE_QWEN_ENDPOINT_KEY'] ?? '';
const MODEL = process.env['PERISCOPE_QWEN_MODEL'] ?? '';
const API = (process.env['PERISCOPE_QWEN_ENDPOINT_API'] ?? 'openai-chat') as EndpointWireApi;
const skip = !LIVE
  ? 'PERISCOPE_LIVE is not set — this property is NOT exercised'
  : BINARY === '' || URL === '' || KEY === '' || MODEL === ''
    ? 'PERISCOPE_QWEN_BIN, PERISCOPE_QWEN_ENDPOINT_URL, PERISCOPE_QWEN_ENDPOINT_KEY and PERISCOPE_QWEN_MODEL are not all set — this property is NOT exercised'
    : false;

/** A word no real command carries, so the process listing after close finds only what this run started. */
const MARKER = `periscope-qwen-live-${process.pid}`;

/** One receipt line, as the measurement's record. */
function receipt(what: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ receipt: what, ...data })}\n`);
}

/** A scratch git repository with a context file that keeps the model to the asked tools. */
function scratchRepository(): string {
  const dir = mkdtempSync(`${tmpdir()}/periscope-qwen-live-`);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(
    join(dir, 'QWEN.md'),
    'Answer in one short line. Run exactly the tools you are asked to run.\n',
  );
  return dir;
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
    permissionMode: 'bypassPermissions',
    ...overrides,
  };
}

interface LiveRun {
  readonly stream: LiveStream<QwenMessage>;
  readonly process: ReturnType<typeof startQwenProcess>;
  readonly decided: DecisionRequest[];
  readonly raised: { name: RefusalReason; detail: string }[];
  readonly base: string;
}

function start(
  cwd: string,
  protectedPaths: readonly string[],
  overrides: Partial<AgentProcessRequest> = {},
): LiveRun {
  const base = mkdtempSync(`${tmpdir()}/periscope-qwen-base-`);
  const decided: DecisionRequest[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const route: QwenEndpointRoute = {
    name: 'live',
    wireApi: API,
    baseUrl: URL,
    models: [MODEL],
    env: {},
    authToken: () => KEY,
  };
  const sessionRequest = request(cwd, overrides);
  const gate = createQwenSessionGate({
    sessionKey: 'live',
    cwd,
    decide: (asked) => {
      decided.push(asked);
      receipt('decision request', { request: asked });
      return Promise.resolve({ behavior: 'allow' });
    },
    localGate: localGate({
      workspaceRoot: cwd,
      resolve: nodePathResolver,
      protectedPaths,
      toolFamilies: QWEN_TOOL_FAMILIES,
      readsShellDialect: true,
      checksShellDirectory: true,
      resolvesAgainstCallCwd: true,
    }),
    decisionTimeoutMs: 50_000,
    holdAfterMs: 250,
    askRules: qwenAskRules(Object.keys(sessionRequest.mcpServers ?? {})),
    onOutcome: (outcome) => receipt('outcome', { kind: outcome.kind, tool: outcome.request.toolName }),
    onDegrade: (name, detail) => {
      raised.push({ name, detail });
      receipt('degrade', { name, detail });
    },
    onSpawnDegrades: (names) => receipt('opening tier degrades', { names }),
  });
  const process = startQwenProcess(
    sessionRequest,
    { binary: BINARY, base, operatorHome: tmpdir(), endpoints: [route] },
    (detail) => receipt('runtime degraded', { detail }),
    'live',
    gate,
  );
  return { stream: new LiveStream(process.messages), process, decided, raised, base };
}

const results = (stream: LiveStream<QwenMessage>): JsonObject[] =>
  stream.seen.flatMap((message) =>
    message.kind === 'message' && message.message['type'] === 'result' ? [message.message] : [],
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
  "one shell call, one edit and one MCP call each reach the host's decision; the tools against the snapshot; the shell; the MCP version negotiated",
  { skip },
  async () => {
    const dir = scratchRepository();
    const mcp = await fakeMcpHttp('2024-11-05');
    const run = start(dir, [], {
      mcpServers: { fake: { type: 'http', url: mcp.url, headers: { 'X-Job-Ticket': 'live' } } },
    });
    try {
      run.process.prompt(
        'Do these three things, one tool each: run the shell command `echo %ComSpec% $0`; write a file named note.txt containing hi; call the echo tool of the fake server with the text ping.',
      );
      await run.stream.until(() => results(run.stream).length > 0, 300_000);
      const init = run.stream.seen.find(
        (message) =>
          message.kind === 'message' &&
          message.message['type'] === 'system' &&
          message.message['subtype'] === 'init',
      );
      const tools =
        init?.kind === 'message' && Array.isArray(init.message['tools'])
          ? (init.message['tools'] as string[])
          : [];
      const snapshot = new Set(QWEN_NAMES.tools);
      receipt('first init tools against the snapshot', {
        listed: tools.length,
        notInSnapshot: tools.filter((tool) => !snapshot.has(tool) && !tool.startsWith('mcp__')),
        inSnapshotNotListed: QWEN_NAMES.tools.filter((tool) => !tools.includes(tool)),
      });
      const shell = run.stream.seen.flatMap((message) =>
        message.kind === 'message' && message.message['type'] === 'user' ? [message.message] : [],
      );
      receipt('shell result', { results: shell });
      receipt('mcp negotiated', {
        initialized: mcp.initialized,
        versionHeaders: mcp.versionHeaders,
        calls: mcp.calls,
      });
      const names = run.decided.map((asked) => asked.toolName);
      assert.ok(
        names.includes('run_shell_command'),
        `no shell call reached the decision: ${names.join(', ')}`,
      );
      assert.ok(
        names.includes('write_file') || names.includes('edit'),
        `no edit reached the decision: ${names.join(', ')}`,
      );
      assert.ok(names.includes('mcp__fake__echo'), `no MCP call reached the decision: ${names.join(', ')}`);
      assert.deepEqual(
        run.raised.filter((one) => one.name === 'gate-tool-unruled'),
        [],
        'a listed tool has no ask rule',
      );
    } finally {
      await closeAndWait(run.process, run.stream, receipt);
      await mcp.close();
      removeScratch(dir, receipt);
      removeScratch(run.base, receipt);
    }
  },
);

test(
  'a read the CLI allows by default asks, and a read of a protected file is refused by the protected set',
  { skip },
  async () => {
    const dir = scratchRepository();
    const secret = join(mkdtempSync(`${tmpdir()}/periscope-qwen-secret-`), 'oauth_creds.json');
    writeFileSync(secret, '{"token":"not-a-real-token"}\n');
    const run = start(dir, [secret]);
    try {
      run.process.prompt(
        `Read the file ${secret} with your file-reading tool and say how many characters it has.`,
      );
      await run.stream.until(() => results(run.stream).length > 0, 300_000);
      const reads = run.decided.filter((asked) => asked.toolName === 'read_file');
      receipt('read decisions', { reads });
      assert.ok(reads.length > 0, "the read never reached the decision: it ran on the CLI's own say");
      const answered = run.stream.seen.flatMap((message) =>
        message.kind === 'control_request' ? [message.answer] : [],
      );
      receipt('answers', { answered });
      assert.ok(
        answered.some((answer) => JSON.stringify(answer).includes('credential-path-denied')),
        'the read of the protected file was not refused by the protected set',
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
    const run = start(dir, []);
    try {
      const command =
        process.platform === 'win32' ? `ping -n 120 127.0.0.1 & rem ${MARKER}` : `sleep 120 # ${MARKER}`;
      run.process.prompt(`Start this shell command in the background and do not wait for it: ${command}`);
      await run.stream.until(() => results(run.stream).length > 0, 300_000);
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
