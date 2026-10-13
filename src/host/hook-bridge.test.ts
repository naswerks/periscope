/**
 * `periscope hook codex`, run as the process Codex runs: it always exits 0, never writes to standard
 * error, and writes either nothing (a verified allow) or the deny. Every way it can fail to get a verified
 * allow — no channel, a channel it cannot reach, an answer it cannot verify, input it cannot read, its
 * own deadline, an error thrown inside it — ends in the deny, because Codex would let the call proceed on
 * anything else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { HookDecision } from '../gate/hook-exchange.js';
import {
  HOOK_CHANNEL_VARIABLE,
  HOOK_DEADLINE_VARIABLE,
  HOOK_EXPIRY_EVENT,
  HOOK_TOKEN_VARIABLE,
  MAX_HOOK_INPUT_BYTES,
  hookAnswerLine,
  hookDenyOutput,
} from '../gate/hook-exchange.js';
import { closureFrom, importsOf } from '../pins/walk.js';
import { runHook, type HookIo } from '../bin/hook.js';
import { codexHookLines, codexHookPowerShell, ensureCodexHookShim } from './codex-hook.js';
import { createCodexSessionGate } from './codex-gate.js';
import { openHookChannel } from './hook-channel.js';

const ENTRY = fileURLToPath(new URL('../bin/periscope.js', import.meta.url));
const EVENT = JSON.stringify({
  session_id: 'codex-session',
  turn_id: 'turn-one',
  cwd: process.cwd(),
  hook_event_name: 'PreToolUse',
  model: 'gpt-test',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 'call_one',
});

interface Ran {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/** Run the built hook command with `input` on its standard input. */
function runBridge(input: string, env: Readonly<Record<string, string>>): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, 'hook', 'codex'], {
      env: { ...env, SystemRoot: process.env['SystemRoot'] ?? '' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/** The deny the hook wrote, its reason; fails on anything that is not exactly the deny. */
function denyReason(ran: Ran): string {
  assert.equal(ran.code, 0, `exit ${String(ran.code)}`);
  assert.equal(ran.stderr, '', 'the hook wrote to standard error');
  const parsed = JSON.parse(ran.stdout) as { hookSpecificOutput: Record<string, unknown> };
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.deepEqual(parsed.hookSpecificOutput['permissionDecision'], 'deny');
  const reason = parsed.hookSpecificOutput['permissionDecisionReason'];
  assert.ok(typeof reason === 'string' && reason.trim() !== '');
  assert.equal(ran.stdout, hookDenyOutput(reason), 'the deny is not the one shape the hook writes');
  return reason;
}

/** A listening address no channel answers on. */
function nowhere(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\periscope-hook-none-${randomBytes(8).toString('hex')}`
    : join(mkdtempSync(`${tmpdir()}${sep}periscope-none-`), 's');
}

/** A server on its own address that answers every request with `reply`. */
async function impostor(reply: (line: string) => string): Promise<{ address: string; close: () => void }> {
  const address = nowhere();
  const server = createServer((socket: Socket) => {
    let buffer = '';
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\n')) socket.end(reply(buffer.trim()));
    });
  });
  await new Promise<void>((resolve) => server.listen(address, resolve));
  return { address, close: () => server.close() };
}

test('a verified allow is an empty output, exit 0, nothing on standard error', async () => {
  const channel = openHookChannel({
    runtime: 'codex',
    version: 'test',
    decide: () => Promise.resolve({ allow: true }),
  });
  try {
    await channel.ready();
    const ran = await runBridge(EVENT, {
      [HOOK_CHANNEL_VARIABLE]: channel.address,
      [HOOK_TOKEN_VARIABLE]: channel.token,
    });
    assert.deepEqual(ran, { stdout: '', stderr: '', code: 0 });
  } finally {
    channel.close();
  }
});

test("a deny carries the host's reason, exactly the one deny shape", async () => {
  const channel = openHookChannel({
    runtime: 'codex',
    version: 'test',
    decide: () =>
      Promise.resolve({ allow: false, reason: 'credential-path-denied: the command names a token cache' }),
  });
  try {
    await channel.ready();
    const ran = await runBridge(EVENT, {
      [HOOK_CHANNEL_VARIABLE]: channel.address,
      [HOOK_TOKEN_VARIABLE]: channel.token,
    });
    assert.equal(ran.stdout, hookDenyOutput('credential-path-denied: the command names a token cache'));
    assert.equal(denyReason(ran), 'credential-path-denied: the command names a token cache');
  } finally {
    channel.close();
  }
});

test('with no channel in its environment it denies', async () => {
  const ran = await runBridge(EVENT, {});
  assert.equal(
    ran.stdout,
    hookDenyOutput(
      "the hook channel is not set in this process's environment, so no decision can be asked for",
    ),
  );
  denyReason(ran);
});

test('a channel it cannot reach is a deny', async () => {
  const reason = denyReason(
    await runBridge(EVENT, { [HOOK_CHANNEL_VARIABLE]: nowhere(), [HOOK_TOKEN_VARIABLE]: 'token' }),
  );
  assert.match(reason, /could not be reached|closed before/);
});

test('an answer that is not one, and an answer authenticated by another token, are each a deny', async () => {
  const garbage = await impostor(() => 'garbage\n');
  const forged = await impostor((line) => {
    const nonce = (JSON.parse(line) as { nonce: string }).nonce;
    return hookAnswerLine('another-token', nonce, { allow: true });
  });
  try {
    const env = (address: string): Record<string, string> => ({
      [HOOK_CHANNEL_VARIABLE]: address,
      [HOOK_TOKEN_VARIABLE]: 'the-token',
    });
    assert.match(denyReason(await runBridge(EVENT, env(garbage.address))), /did not verify/);
    assert.match(
      denyReason(await runBridge(EVENT, env(forged.address))),
      /did not verify/,
      'an impostor answered allow',
    );
  } finally {
    garbage.close();
    forged.close();
  }
});

test('input that is not JSON, and input past the bound, are each a deny', async () => {
  const env = { [HOOK_CHANNEL_VARIABLE]: nowhere(), [HOOK_TOKEN_VARIABLE]: 'token' };
  assert.match(denyReason(await runBridge('not json', env)), /not one JSON value/);
  assert.match(denyReason(await runBridge(`{"x":"${'y'.repeat(MAX_HOOK_INPUT_BYTES)}"}`, env)), /exceeded/);
});

test('its own deadline is a deny named as an expiry, and the call does not run', async () => {
  const channel = openHookChannel({
    runtime: 'codex',
    version: 'test',
    decide: () => new Promise<HookDecision>(() => undefined),
  });
  try {
    await channel.ready();
    const ran = await runBridge(EVENT, {
      [HOOK_CHANNEL_VARIABLE]: channel.address,
      [HOOK_TOKEN_VARIABLE]: channel.token,
      [HOOK_DEADLINE_VARIABLE]: '300',
    });
    assert.equal(
      ran.stdout,
      hookDenyOutput(`${HOOK_EXPIRY_EVENT}: no decision from the host within 300ms; the call did not run`),
    );
  } finally {
    channel.close();
  }
});

test("an event that is not a readable PreToolUse call is refused by the session's gate, never allowed", async () => {
  let asked = 0;
  const gate = createCodexSessionGate({
    sessionKey: 'handle-one',
    cwd: process.cwd(),
    decide: () => {
      asked += 1;
      return Promise.resolve({ behavior: 'allow' });
    },
    decisionTimeoutMs: 1_000,
    holdAfterMs: 500,
    hooksPath: '',
    version: 'test',
    onOutcome: () => undefined,
    onDegrade: () => undefined,
    onSpawnDegrades: () => undefined,
  });
  try {
    await gate.ready();
    const event = JSON.stringify({ ...(JSON.parse(EVENT) as object), hook_event_name: 'PostToolUse' });
    const reason = denyReason(await runBridge(event, gate.env));
    assert.match(reason, /^permission-decision-unavailable: /);
    assert.equal(asked, 0, 'an unreadable call was asked about');
  } finally {
    gate.close();
  }
});

/** In-process edges for the hook, recording what it writes. */
function recordingIo(overrides: Partial<HookIo> = {}): {
  io: HookIo;
  written: string[];
  fatal: ((error: unknown) => void)[];
} {
  const written: string[] = [];
  const fatal: ((error: unknown) => void)[] = [];
  const stdin = new PassThrough();
  stdin.end(EVENT);
  return {
    written,
    fatal,
    io: {
      stdin,
      write: (text, done) => {
        written.push(text);
        done();
      },
      setExitCode: () => undefined,
      onFatal: (handler) => fatal.push(handler),
      ...overrides,
    },
  };
}

test('an error thrown opening the channel is a deny', async () => {
  const { io, written } = recordingIo({
    connect: () => {
      throw new Error('boom');
    },
  });
  await runHook(
    ['hook', 'codex'],
    { [HOOK_CHANNEL_VARIABLE]: 'somewhere', [HOOK_TOKEN_VARIABLE]: 'token' },
    io,
  );
  assert.equal(written.length, 1);
  assert.match(written[0] ?? '', /could not be opened: Error: boom/);
});

test('an error nothing else caught is a deny, written once', async () => {
  const { io, written, fatal } = recordingIo({ connect: () => new PassThrough() as unknown as Socket });
  const ran = runHook(
    ['hook', 'codex'],
    { [HOOK_CHANNEL_VARIABLE]: 'somewhere', [HOOK_TOKEN_VARIABLE]: 'token' },
    io,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const handler of fatal) handler(new Error('escaped'));
  for (const handler of fatal) handler(new Error('escaped twice'));
  await ran;
  assert.equal(written.length, 1);
  assert.match(written[0] ?? '', /the hook failed while deciding this call: Error: escaped/);
});

test('the hook command loads nothing of this package but itself and the exchange; the entry loads the composition root only for other commands', () => {
  assert.deepEqual([...closureFrom('bin/hook.ts')].sort(), [
    'bin/hook.ts',
    'gate/hook-exchange.ts',
    'host/package-facts.ts',
  ]);
  const exchange = closureFrom('gate/hook-exchange.ts');
  assert.deepEqual([...exchange], ['gate/hook-exchange.ts']);
  // `package-facts.ts` is reached only by `--probe`'s dynamic import; the decide path never loads it.
  const shim = readEntrySource();
  const staticImports = [...shim.matchAll(/^import [^(].* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(staticImports, ['./command.js'], 'the entry statically imports more than the parser');
  assert.ok(importsOf(shim).includes('./main.js'));
});

/** The entry's own source, as the walker reads sources: from src/. */
function readEntrySource(): string {
  return readFileSync(fileURLToPath(new URL('../../src/bin/periscope.ts', import.meta.url)), 'utf8');
}

test('measured: a hook call through the written shim and the shell Codex uses, start to answer, ten times', async () => {
  const home = mkdtempSync(`${tmpdir()}${sep}periscope-bridge-`);
  const channel = openHookChannel({
    runtime: 'codex',
    version: 'test',
    decide: () => Promise.resolve({ allow: true }),
  });
  try {
    await channel.ready();
    const lines = codexHookLines(home);
    ensureCodexHookShim(lines);
    const env = {
      ...process.env,
      [HOOK_CHANNEL_VARIABLE]: channel.address,
      [HOOK_TOKEN_VARIABLE]: channel.token,
    } as Record<string, string>;
    const powershell = process.platform === 'win32' ? codexHookPowerShell(env) : null;
    const [program, args]: [string, string[]] =
      process.platform !== 'win32'
        ? ['/bin/sh', ['-c', lines.posix]]
        : powershell !== null
          ? [powershell, ['-NoProfile', '-Command', lines.windows]]
          : [env['COMSPEC'] ?? 'cmd.exe', ['/C', lines.windows]];
    const times: number[] = [];
    for (let run = 0; run < 10; run += 1) {
      const started = process.hrtime.bigint();
      const ran = await new Promise<Ran>((resolve) => {
        const child = spawn(program, args, { env, windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        child.on('close', (code) => resolve({ stdout, stderr, code }));
        child.stdin.end(EVENT);
      });
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
      assert.deepEqual(ran, { stdout: '', stderr: '', code: 0 }, `run ${run} through ${program}`);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const median = ((sorted[4] ?? 0) + (sorted[5] ?? 0)) / 2;
    console.log(
      `hook round trip through ${program}: median ${median.toFixed(1)} ms over ${times.length} runs (${sorted.map((t) => t.toFixed(0)).join(', ')})`,
    );
  } finally {
    channel.close();
    rmSync(home, { recursive: true, force: true });
  }
});
