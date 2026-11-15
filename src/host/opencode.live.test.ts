/**
 * opencode under the gate against the SDK the operator installed, on a real model behind an OpenAI-compatible
 * endpoint: what only a real run settles. The release runs it; nothing else does.
 *
 * It runs only with `PERISCOPE_LIVE=1`, `PERISCOPE_OPENCODE_SDK` (the directory the SDK was installed into at
 * the pinned version), `PERISCOPE_OPENCODE_BASE_URL` (an OpenAI-compatible chat endpoint's base URL, one that
 * serves the model below), `PERISCOPE_OPENCODE_KEY_FILE` (a file holding that endpoint's key) and
 * `PERISCOPE_OPENCODE_MODEL` (the model's id on that endpoint). The key is read from its file when a session
 * opens, and never sits in a variable. Without them each property is NOT exercised, and the skip says so.
 * Every run spends the endpoint's credit, so each prompt is short. Each test prints its receipts as JSON
 * lines, which are the record of what was measured; the assertions hold only what the gate depends on.
 * opencode needs Node 24 or later.
 *
 * Run it from a plain terminal, not from inside an agent session, which would lend it that session's tools:
 *
 *   npm install --prefix <sdk directory> @opencode/sdk@2.3.0
 *   npm run build
 *   PERISCOPE_LIVE=1 PERISCOPE_OPENCODE_SDK=<sdk directory> PERISCOPE_OPENCODE_BASE_URL=<base url> PERISCOPE_OPENCODE_KEY_FILE=<key file> PERISCOPE_OPENCODE_MODEL=<model> node --test dist/host/opencode.live.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RefusalReason } from '../core/refusal.js';
import type { Decider, DecisionRequest } from '../gate/decision.js';
import { OPENCODE_TOOL_FAMILIES, localGate } from '../gate/local.js';
import { composeSpawnEnv } from '../sessions/spawn-env.js';
import { fakeMcpHttp } from '../test-support/fake-mcp-http.js';
import { LiveStream, closeAndWait, removeScratch } from '../test-support/live-session.js';
import type { AgentProcessRequest } from './agent-process.js';
import type { OpencodeEndpointRoute } from './opencode-endpoints.js';
import { OpencodeFactLift } from './opencode-facts.js';
import { createOpencodeSessionGate } from './opencode-gate.js';
import { startOpencodeProcess } from './opencode-process.js';
import { nodeCanRunOpencode } from './opencode-sdk.js';
import type { OpencodeMessage } from './opencode-wire.js';
import { nodePathResolver } from './paths.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const SDK = process.env['PERISCOPE_OPENCODE_SDK'] ?? '';
const BASE_URL = process.env['PERISCOPE_OPENCODE_BASE_URL'] ?? '';
const KEY_FILE = process.env['PERISCOPE_OPENCODE_KEY_FILE'] ?? '';
const MODEL = process.env['PERISCOPE_OPENCODE_MODEL'] ?? '';
const NODE = nodeCanRunOpencode();
const skip = !LIVE
  ? 'PERISCOPE_LIVE is not set — this property is NOT exercised'
  : SDK === '' || BASE_URL === '' || KEY_FILE === '' || MODEL === ''
    ? 'PERISCOPE_OPENCODE_SDK, PERISCOPE_OPENCODE_BASE_URL, PERISCOPE_OPENCODE_KEY_FILE and PERISCOPE_OPENCODE_MODEL are not all set — this property is NOT exercised'
    : NODE !== null
      ? `${NODE} — this property is NOT exercised`
      : false;

/** A word no real command carries, so the process listing after close finds only what this run started. */
const MARKER = `periscope-opencode-live-${process.pid}`;

/** One receipt line, as the measurement's record. */
function receipt(what: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ receipt: what, ...data })}\n`);
}

function scratch(): string {
  const dir = mkdtempSync(`${tmpdir()}/periscope-opencode-live-`);
  writeFileSync(join(dir, 'notes.txt'), 'the notes say hello\n');
  return dir;
}

/** A plugin directory with one skill, to read whether the skills handed over reach the model. */
function skillPlugin(): string {
  const dir = mkdtempSync(`${tmpdir()}/periscope-opencode-plugin-`);
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'live-plugin', version: '1.0.0' }),
  );
  mkdirSync(join(dir, 'skills', 'greet'), { recursive: true });
  writeFileSync(
    join(dir, 'skills', 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: How to greet. Load it when asked to greet.\n---\nGreet with the word periscope-skill-loaded.\n',
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
    systemPrompt: {
      type: 'preset',
      preset: 'runtime-default',
      append: 'Answer in one short line. Run exactly the tools you are asked to run.',
    },
    effort: null,
    permissionMode: null,
    ...overrides,
  };
}

interface LiveRun {
  readonly stream: LiveStream<OpencodeMessage>;
  readonly process: ReturnType<typeof startOpencodeProcess>;
  readonly decided: DecisionRequest[];
  readonly raised: { name: RefusalReason; detail: string }[];
  readonly base: string;
}

function route(key: () => string): OpencodeEndpointRoute {
  return { name: 'live', wireApi: 'openai-chat', baseUrl: BASE_URL, models: [MODEL], authToken: key };
}

const KEY = (): string => readFileSync(KEY_FILE, 'utf8').trim();

function start(
  cwd: string,
  decide: Decider,
  overrides: Partial<AgentProcessRequest> = {},
  options: { readonly decisionTimeoutMs?: number; readonly key?: () => string } = {},
): LiveRun {
  const base = mkdtempSync(`${tmpdir()}/periscope-opencode-base-`);
  const decided: DecisionRequest[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const sessionRequest = request(cwd, overrides);
  const gate = createOpencodeSessionGate({
    sessionKey: 'live',
    cwd,
    decide: (asked, signal) => {
      decided.push(asked);
      receipt('decision request', { request: asked });
      return decide(asked, signal);
    },
    localGate: localGate({
      workspaceRoot: cwd,
      resolve: nodePathResolver,
      protectedPaths: [KEY_FILE, base, SDK],
      toolFamilies: OPENCODE_TOOL_FAMILIES,
      readsShellDialect: true,
      resolvesAgainstCallCwd: true,
      resolvesWritesAgainstCallCwd: true,
    }),
    decisionTimeoutMs: options.decisionTimeoutMs ?? 60_000,
    holdAfterMs: 250,
    servers: Object.keys(sessionRequest.mcpServers ?? {}),
    onOutcome: (outcome) => receipt('outcome', { kind: outcome.kind, tool: outcome.request.toolName }),
    onDegrade: (name, detail) => {
      raised.push({ name, detail });
      receipt('degrade', { name, detail });
    },
    onSpawnDegrades: (names) => receipt('opening tier degrades', { names }),
  });
  const process = startOpencodeProcess(
    sessionRequest,
    { sdk: SDK, base, endpoints: [route(options.key ?? KEY)] },
    (detail) => receipt('runtime degraded', { detail }),
    'live',
    gate,
  );
  return { stream: new LiveStream(process.messages), process, decided, raised, base };
}

const allow: Decider = () => Promise.resolve({ behavior: 'allow' });

/** The session's own events of `type`. */
const events = (stream: LiveStream<OpencodeMessage>, type: string) =>
  stream.seen.flatMap((message) =>
    message.kind === 'event' && message.main && message.event.type === type ? [message.event] : [],
  );

/** Whether the session's own run has ended, by any of its ends. */
const settled = (stream: LiveStream<OpencodeMessage>): boolean =>
  ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].some(
    (type) => events(stream, type).length > 0,
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
  "every call of an opencode session asks this host, its subagents' included: a read, a refused write that does not run, an MCP call and a subagent's read; the skill handed over is offered; spend is filed per model call",
  { skip },
  async () => {
    const dir = scratch();
    const plugin = skillPlugin();
    const mcp = await fakeMcpHttp('2024-11-05');
    const run = start(
      dir,
      (asked) =>
        Promise.resolve(
          asked.toolName === 'edit'
            ? { behavior: 'deny', message: 'periscope-denied-the-write' }
            : { behavior: 'allow' },
        ),
      {
        mcpServers: { fake: { type: 'http', url: mcp.url, headers: { 'X-Job-Ticket': 'live' } } },
        plugins: [{ type: 'local', path: plugin }],
      },
    );
    try {
      run.process.prompt(
        'Do these things in order, one tool each: read notes.txt with the read tool; write a file named blocked.txt containing hi with the write tool; call the echo tool of the fake server with the text ping; use the subagent tool with agent general to have a subagent read notes.txt with the read tool; load the greet skill. Then say what the write tool told you.',
      );
      await run.stream.until(() => settled(run.stream), 600_000);
      const failure = events(run.stream, 'session.execution.failed');
      receipt('errors', { failure: failure.map((event) => event.data) });
      assert.deepEqual(
        failure,
        [],
        'the run failed: the endpoint refused the key, or the model could not run',
      );
      const names = run.decided.map((asked) => asked.toolName);
      assert.ok(names.includes('read'), `no read reached the decision: ${names.join(', ')}`);
      assert.ok(names.includes('edit'), `no write reached the decision: ${names.join(', ')}`);
      assert.ok(names.includes('mcp__fake__echo'), `no MCP call reached the decision: ${names.join(', ')}`);
      assert.equal(existsSync(join(dir, 'blocked.txt')), false, 'the refused write ran');
      const sub = run.decided.filter((asked) => asked.agentId !== null);
      receipt('subagent decisions', { sub });
      assert.ok(sub.length > 0, "no subagent's call reached the decision");
      receipt('skill', {
        asked: names.includes('skill'),
        loaded: run.stream.seen.some(
          (message) => message.kind === 'event' && message.event.type === 'session.skill.activated',
        ),
      });
      const lift = new OpencodeFactLift();
      const spend = run.stream.seen
        .flatMap((message) => lift.fromMessage(message).facts)
        .filter((fact) => fact.kind === 'turn_record');
      receipt('spend', { steps: spend });
      assert.ok(spend.length > 0, 'no model call was filed');
      const types = run.stream.seen.flatMap((message) =>
        message.kind === 'event' && message.main ? [message.event.type] : [],
      );
      receipt('event order', { first: types[0], last: types.at(-1) });
      assert.deepEqual(
        run.raised.filter((one) => one.name !== 'gate-mode-widened'),
        [],
        'a degrade was named',
      );
    } finally {
      await closeAndWait(run.process, run.stream, receipt);
      await mcp.close();
      removeScratch(dir, receipt);
      removeScratch(plugin, receipt);
      removeScratch(run.base, receipt);
    }
  },
);

test(
  "a key the endpoint refuses fails the run in the provider's own words, the sign-in failure a controller sees",
  { skip },
  async () => {
    const dir = scratch();
    const run = start(dir, allow, {}, { key: () => `refused-${process.pid}` });
    try {
      run.process.prompt('Say hello.');
      await run.stream.until(() => settled(run.stream), 300_000);
      const failure = events(run.stream, 'session.execution.failed');
      receipt('sign-in failure', { failure: failure.map((event) => event.data) });
      assert.ok(failure.length > 0, 'a refused key did not fail the run');
    } finally {
      await closeAndWait(run.process, run.stream, receipt);
      removeScratch(dir, receipt);
      removeScratch(run.base, receipt);
    }
  },
);

test(
  "silence holds to this host's deadline: a call nobody answers expires and does not run",
  { skip },
  async () => {
    const dir = scratch();
    const run = start(
      dir,
      (_asked, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      {},
      { decisionTimeoutMs: 20_000 },
    );
    try {
      run.process.prompt('Write a file named silent.txt containing hi, with the write tool.');
      await run.stream.until(() => settled(run.stream), 600_000);
      assert.ok(
        run.decided.some((asked) => asked.toolName === 'edit'),
        'the write never asked',
      );
      assert.equal(existsSync(join(dir, 'silent.txt')), false, 'a call nobody answered ran');
    } finally {
      await closeAndWait(run.process, run.stream, receipt);
      removeScratch(dir, receipt);
      removeScratch(run.base, receipt);
    }
  },
);

test(
  "an approved command's environment names no credential, and holds no copy of the key",
  { skip },
  async () => {
    const dir = scratch();
    const run = start(dir, allow);
    try {
      const command =
        process.platform === 'win32'
          ? 'Get-ChildItem env: | ForEach-Object { $_.Name + "=" + $_.Value }'
          : 'env';
      run.process.prompt(`Run exactly this shell command with the shell tool and reply done: ${command}`);
      await run.stream.until(() => settled(run.stream), 600_000);
      const outputs = events(run.stream, 'session.tool.success').map((event) => JSON.stringify(event.data));
      const text = outputs.join('\n');
      receipt('environment names', {
        names: text.split(/\\r?\\n|\r?\n/).map((line) => line.split('=')[0]),
      });
      assert.ok(text.length > 0, 'the command printed nothing, so its environment was not read');
      assert.equal(text.includes(KEY()), false, "the key reached the agent's shell");
      assert.equal(
        /PERISCOPE_OPENCODE_/.test(text),
        false,
        "this host's own variables reached the agent's shell",
      );
    } finally {
      await closeAndWait(run.process, run.stream, receipt);
      removeScratch(dir, receipt);
      removeScratch(run.base, receipt);
    }
  },
);

test(
  "a command the agent's shell runs in the background does not outlive the session's close",
  { skip },
  async () => {
    const dir = scratch();
    const run = start(dir, allow);
    try {
      const command =
        process.platform === 'win32' ? `ping -n 120 127.0.0.1 # ${MARKER}` : `sleep 120 # ${MARKER}`;
      run.process.prompt(
        `Run this command with the shell tool in the background, and do not wait for it: ${command}`,
      );
      await run.stream.until(() => settled(run.stream), 600_000);
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
