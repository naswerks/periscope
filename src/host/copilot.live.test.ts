/**
 * Copilot under the gate against the SDK the operator installed, signed in, with a real model: what only a
 * real run settles. The release runs it; nothing else does.
 *
 * It runs only with `PERISCOPE_LIVE=1`, `PERISCOPE_COPILOT_SDK` (the directory the SDK was installed into
 * at the pinned version), `PERISCOPE_COPILOT_TOKEN_FILE` (a file holding a GitHub token with Copilot
 * access) and `PERISCOPE_COPILOT_MODEL` (a model that token may use). Without them each property is NOT
 * exercised, and the skip says so. Every run spends the account's requests, so each prompt is short. Each
 * test prints its receipts as JSON lines, which are the record of what was measured; the assertions hold
 * only what the gate depends on.
 *
 * Run it from a plain terminal, not from inside an agent session, which would lend it that session's tools:
 *
 *   npm install --prefix <sdk directory> @github/copilot-sdk@1.0.34
 *   npm run build
 *   PERISCOPE_LIVE=1 PERISCOPE_COPILOT_SDK=<sdk directory> PERISCOPE_COPILOT_TOKEN_FILE=<token file> PERISCOPE_COPILOT_MODEL=<model> node --test dist/host/copilot.live.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RefusalReason } from '../core/refusal.js';
import type { Decider, DecisionRequest } from '../gate/decision.js';
import { COPILOT_TOOL_FAMILIES, localGate } from '../gate/local.js';
import { composeSpawnEnv } from '../sessions/spawn-env.js';
import { fakeMcpHttp } from '../test-support/fake-mcp-http.js';
import { LiveStream, closeAndWait, endListed, removeScratch } from '../test-support/live-session.js';
import type { AgentProcessRequest } from './agent-process.js';
import { createCopilotSessionGate } from './copilot-gate.js';
import { startCopilotProcess } from './copilot-process.js';
import type { CopilotMessage } from './copilot-wire.js';
import { nodePathResolver } from './paths.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const SDK = process.env['PERISCOPE_COPILOT_SDK'] ?? '';
const TOKEN_FILE = process.env['PERISCOPE_COPILOT_TOKEN_FILE'] ?? '';
const MODEL = process.env['PERISCOPE_COPILOT_MODEL'] ?? '';
const skip = !LIVE
  ? 'PERISCOPE_LIVE is not set — this property is NOT exercised'
  : SDK === '' || TOKEN_FILE === '' || MODEL === ''
    ? 'PERISCOPE_COPILOT_SDK, PERISCOPE_COPILOT_TOKEN_FILE and PERISCOPE_COPILOT_MODEL are not all set — this property is NOT exercised'
    : false;

/** A word no real command carries, so the process listing after close finds only what this run started. */
const MARKER = `periscopecopilotlive${process.pid}`;

/** One receipt line, as the measurement's record. */
function receipt(what: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ receipt: what, ...data })}\n`);
}

function scratch(): string {
  const dir = mkdtempSync(`${tmpdir()}/periscope-copilot-live-`);
  writeFileSync(join(dir, 'notes.txt'), 'the notes say hello\n');
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
  readonly stream: LiveStream<CopilotMessage>;
  readonly process: ReturnType<typeof startCopilotProcess>;
  readonly decided: DecisionRequest[];
  readonly raised: { name: RefusalReason; detail: string }[];
  readonly base: string;
}

function start(
  cwd: string,
  decide: Decider,
  overrides: Partial<AgentProcessRequest> = {},
  decisionTimeoutMs = 60_000,
): LiveRun {
  const base = mkdtempSync(`${tmpdir()}/periscope-copilot-base-`);
  const decided: DecisionRequest[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const sessionRequest = request(cwd, overrides);
  const gate = createCopilotSessionGate({
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
      protectedPaths: [TOKEN_FILE, base],
      toolFamilies: COPILOT_TOOL_FAMILIES,
      readsShellDialect: true,
      resolvesAgainstCallCwd: true,
      resolvesWritesAgainstCallCwd: true,
    }),
    decisionTimeoutMs,
    holdAfterMs: 250,
    servers: Object.keys(sessionRequest.mcpServers ?? {}),
    onOutcome: (outcome) => receipt('outcome', { kind: outcome.kind, tool: outcome.request.toolName }),
    onDegrade: (name, detail) => {
      raised.push({ name, detail });
      receipt('degrade', { name, detail });
    },
    onSpawnDegrades: (names) => receipt('opening tier degrades', { names }),
  });
  const process = startCopilotProcess(
    sessionRequest,
    { sdk: SDK, base, tokenFile: TOKEN_FILE },
    (detail) => receipt('runtime degraded', { detail }),
    null,
    gate,
  );
  return { stream: new LiveStream(process.messages), process, decided, raised, base };
}

const allow: Decider = () => Promise.resolve({ behavior: 'allow' });

/** The session's own events of `type`. */
const events = (stream: LiveStream<CopilotMessage>, type: string) =>
  stream.seen.flatMap((message) =>
    message.kind === 'event' && message.event.type === type && message.event.agentId === undefined
      ? [message.event]
      : [],
  );

const idle = (stream: LiveStream<CopilotMessage>): boolean => events(stream, 'session.idle').length > 0;

/**
 * Why a run measured nothing, or null. A session that opened and was handed its token, and whose account
 * is offered no such model, ran no turn: nothing of the gate was exercised. That is the token's account
 * and the model named for the probe, never this host, so the run is skipped with the runtime's own words.
 */
function ranNoTurn(stream: LiveStream<CopilotMessage>): string | null {
  const said = events(stream, 'session.error').map((event) => {
    const message = (event.data as { message?: unknown }).message;
    return typeof message === 'string' ? message : '';
  });
  const unavailable = said.find((message) => /Model "[^"]*" is not available/.test(message));
  return unavailable === undefined
    ? null
    : `the session opened and ran no turn: ${unavailable} Name a model the token's account may use in PERISCOPE_COPILOT_MODEL`;
}

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
  "every call of a Copilot session asks this host, its sub-agents' included: a read, a refused write that does not run, an MCP call and a sub-agent's read; signed in by the token file over the SDK's pipe",
  { skip },
  async (t) => {
    const dir = scratch();
    const mcp = await fakeMcpHttp('2024-11-05');
    const run = start(
      dir,
      (asked) =>
        Promise.resolve(
          asked.toolName === 'create'
            ? { behavior: 'deny', message: 'periscope-denied-the-write' }
            : { behavior: 'allow' },
        ),
      { mcpServers: { fake: { type: 'http', url: mcp.url, headers: { 'X-Job-Ticket': 'live' } } } },
    );
    try {
      run.process.prompt(
        'Do these four things in order, one tool each: read notes.txt with the view tool; create a file named blocked.txt containing hi; call the echo tool of the fake server with the text ping; use the task tool with agent_type general-purpose to have a sub-agent read notes.txt with the view tool. Then say what the create tool told you.',
      );
      await run.stream.until(() => idle(run.stream), 600_000);
      const nothing = ranNoTurn(run.stream);
      if (nothing !== null) return t.skip(nothing);
      const failure = events(run.stream, 'session.error');
      receipt('errors', { failure: failure.map((event) => event.data) });
      assert.deepEqual(failure, [], 'the session did not sign in or failed its run');
      const names = run.decided.map((asked) => asked.toolName);
      assert.ok(names.includes('view'), `no read reached the decision: ${names.join(', ')}`);
      assert.ok(names.includes('create'), `no write reached the decision: ${names.join(', ')}`);
      assert.ok(names.includes('mcp__fake__echo'), `no MCP call reached the decision: ${names.join(', ')}`);
      assert.equal(existsSync(join(dir, 'blocked.txt')), false, 'the refused write ran');
      const sub = run.decided.filter((asked) => asked.agentId !== null || asked.agentType !== null);
      receipt('sub-agent decisions', { sub });
      assert.ok(sub.length > 0, "no sub-agent's call reached the decision");
      const replies = events(run.stream, 'assistant.message').map(
        (event) => (event.data as { content?: string }).content,
      );
      receipt('replies', { replies });
      const causes = run.stream.seen
        .filter((message) => message.kind === 'event')
        .map((message) => (message.kind === 'event' ? message.event.type : ''));
      receipt('event order', { first: causes.find((type) => type === 'user.message'), last: causes.at(-1) });
      receipt('usage', { usage: events(run.stream, 'assistant.usage').map((event) => event.data) });
      assert.deepEqual(
        run.raised.filter((one) => one.name !== 'gate-mode-widened'),
        [],
        'a degrade was named',
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
  "silence holds to this host's deadline: a call nobody answers expires and does not run",
  { skip },
  async (t) => {
    const dir = scratch();
    const run = start(
      dir,
      (_asked, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      {},
      20_000,
    );
    try {
      run.process.prompt('Create a file named silent.txt containing hi, with the create tool.');
      await run.stream.until(() => idle(run.stream), 600_000);
      const nothing = ranNoTurn(run.stream);
      if (nothing !== null) return t.skip(nothing);
      assert.ok(
        run.decided.some((asked) => asked.toolName === 'create'),
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
  "an approved command's environment names no credential, and holds no copy of the token",
  { skip },
  async (t) => {
    const dir = scratch();
    const run = start(dir, allow);
    try {
      const command =
        process.platform === 'win32'
          ? 'Get-ChildItem env: | ForEach-Object { $_.Name + "=" + $_.Value }'
          : 'env';
      run.process.prompt(`Run exactly this shell command and reply done: ${command}`);
      await run.stream.until(() => idle(run.stream), 600_000);
      const nothing = ranNoTurn(run.stream);
      if (nothing !== null) return t.skip(nothing);
      const outputs = events(run.stream, 'tool.execution_complete').map((event) =>
        String((event.data as { result?: { content?: string } }).result?.content ?? ''),
      );
      const token = readFileSync(TOKEN_FILE, 'utf8').trim();
      const text = outputs.join('\n');
      receipt('environment names', { names: text.split(/\r?\n/).map((line) => line.split('=')[0]) });
      assert.ok(text.length > 0, 'the command printed nothing, so its environment was not read');
      assert.equal(text.includes(token), false, "the token reached the agent's shell");
      for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_SDK_AUTH_TOKEN']) {
        assert.equal(new RegExp(`^${name}=`, 'mi').test(text), false, `${name} reached the agent's shell`);
      }
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
  async (t) => {
    const dir = scratch();
    const run = start(dir, allow);
    const before: string[] = [];
    try {
      // The marker is a word of the command itself, on Windows the name of the signal it waits for, so a
      // model that tidies the line cannot drop it and the listing finds the command.
      const command =
        process.platform === 'win32' ? `waitfor /t 120 ${MARKER}` : `sh -c "sleep 120; true ${MARKER}"`;
      run.process.prompt(
        `Run this command with the shell tool in its async mode, and do not wait for it: ${command}`,
      );
      await run.stream.until(() => idle(run.stream), 600_000);
      const nothing = ranNoTurn(run.stream);
      if (nothing !== null) return t.skip(nothing);
      before.push(...survivors());
      receipt('running before close', { survivors: before });
    } finally {
      await closeAndWait(run.process, run.stream, receipt);
      removeScratch(dir, receipt);
      removeScratch(run.base, receipt);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const left = survivors();
    receipt('after close', { survivors: left });
    endListed(left);
    assert.deepEqual(left, [], 'a command the session started outlived its close');
    // A close that ended nothing proves nothing: the command has to have been running when it came.
    if (before.length === 0) {
      t.skip(
        'the command was not running when the session closed, so this run says nothing of what a close ends',
      );
    }
  },
);
