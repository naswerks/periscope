/**
 * One pi session's gate: what counts as this host's own code at the open and what is named as foreign,
 * the extension's hello and how long the open waits for it, and the decision the extension is answered
 * with, a rewrite included.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { join } from 'node:path';

import { HOOK_EXCHANGE_VERSION, readHookAnswer } from '../gate/hook-exchange.js';
import type { RefusalReason } from '../core/refusal.js';
import type { PiHello, PiHelloEntry } from './pi-extension.js';
import { createPiSessionGate, piForeignSources, readPiHello } from './pi-gate.js';
import { PI_NAMES } from './pi-names.js';

const ROOT = process.platform === 'win32' ? 'C:\\work' : '/work';
const EXTENSION = join(ROOT, 'periscope', 'dist', 'host', 'pi-extension.js');
const SKILLS = join(ROOT, 'pack', 'skills');
const own = { extensionPath: EXTENSION, skillDirectories: [SKILLS] };

const builtinTools: PiHelloEntry[] = PI_NAMES.tools.map((tool) => ({
  name: tool,
  source: 'builtin',
  path: `builtin:${tool}`,
}));

const clean: PiHello = {
  reason: 'startup',
  tools: [...builtinTools, { name: 'mcp__nas__seat_read', source: 'builtin', path: 'builtin:mcp' }],
  commands: [{ name: 'periscope', kind: 'extension', source: 'cli', path: EXTENSION }],
  servers: [{ name: 'nas', extensionPath: EXTENSION }],
  truncated: false,
};

const listed: PiHelloEntry[] = [
  { name: 'periscope', kind: 'extension', source: 'cli', path: EXTENSION },
  { name: 'mcp', kind: 'extension', source: 'builtin', path: 'builtin:mcp' },
  {
    name: 'skill:review',
    kind: 'skill',
    source: 'local',
    path: join(SKILLS, 'review', 'SKILL.md'),
    baseDir: join(SKILLS, 'review'),
  },
  { name: 'standup', kind: 'prompt', source: 'local', path: join(ROOT, 'agent', 'prompts', 'standup.md') },
];

test("this host's own code is named nothing: its extension, pi's built-in tools, pi's MCP extension and its tools, the skills handed over, and prompts", () => {
  assert.deepEqual(piForeignSources(clean, listed, own), []);
});

test('control: anything else is named, by what and where: a tool, a command, a server, a skill from elsewhere, and what could not be listed', () => {
  const foreign = piForeignSources(
    {
      ...clean,
      tools: [...(clean.tools ?? []), { name: 'exfiltrate', source: 'cli', path: join(ROOT, 'other.js') }],
      servers: [...(clean.servers ?? []), { name: 'side', extensionPath: join(ROOT, 'other.js') }],
    },
    [
      ...listed,
      {
        name: 'deploy',
        kind: 'extension',
        source: 'local',
        path: join(ROOT, 'repo', '.pi', 'extensions', 'deploy.ts'),
      },
      {
        name: 'skill:leak',
        kind: 'skill',
        source: 'local',
        path: join(ROOT, 'repo', '.agents', 'skills', 'leak', 'SKILL.md'),
        baseDir: join(ROOT, 'repo', '.agents', 'skills', 'leak'),
      },
    ],
    own,
  );
  assert.deepEqual(foreign, [
    `the tool exfiltrate from ${join(ROOT, 'other.js')}`,
    `the command deploy from ${join(ROOT, 'repo', '.pi', 'extensions', 'deploy.ts')}`,
    `the skill skill:leak from ${join(ROOT, 'repo', '.agents', 'skills', 'leak')}`,
    `the MCP server side registered by ${join(ROOT, 'other.js')}`,
  ]);
  assert.deepEqual(piForeignSources({ ...clean, tools: null, truncated: true }, listed, own), [
    'the tools pi offers, which the extension could not list',
    'more than the extension could list in one hello',
  ]);
  // A built-in extension other than MCP is not this host's either.
  assert.deepEqual(
    piForeignSources(
      {
        ...clean,
        tools: [...builtinTools, { name: 'codemode', source: 'builtin', path: 'builtin:codemode' }],
      },
      listed,
      own,
    ),
    ['the tool codemode from builtin:codemode'],
  );
});

test("on Windows a path is compared as Windows compares it: the extension's own path in other letters is still its own", () => {
  const upper = {
    ...clean,
    commands: [{ name: 'periscope', kind: 'extension', source: 'cli', path: EXTENSION.toUpperCase() }],
  };
  assert.deepEqual(piForeignSources(upper, null, { ...own, platform: 'win32' }), []);
  assert.equal(piForeignSources(upper, null, { ...own, platform: 'linux' }).length, 1);
});

test('a hello is read whole when it can be, and what it does not carry reads as nothing known', () => {
  assert.deepEqual(readPiHello(clean), clean);
  assert.deepEqual(readPiHello(null), {
    reason: 'startup',
    tools: null,
    commands: null,
    servers: null,
    truncated: false,
  });
  assert.deepEqual(
    readPiHello({ tools: [{ name: 1 }, { name: 'read', source: 'builtin', path: 'builtin:read' }] }).tools,
    [{ name: 'read', source: 'builtin', path: 'builtin:read' }],
  );
});

function gate(
  decide = () => Promise.resolve({ behavior: 'allow' as const }),
  onSpawn?: (names: readonly RefusalReason[]) => void,
) {
  return createPiSessionGate({
    sessionKey: 'session-1',
    cwd: ROOT,
    decide,
    decisionTimeoutMs: 1_000,
    holdAfterMs: 10_000,
    version: 'test',
    onOutcome: () => undefined,
    onDegrade: () => undefined,
    onSpawnDegrades: (names) => onSpawn?.(names),
  });
}

function send(address: string, line: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(address);
    let answer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(line)}\n`));
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('utf8');
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(answer.trim()));
  });
}

test('the open waits for the hello: one already said is taken at once, one never said is null at the deadline, and a closed gate waits for nothing', async () => {
  const waiting = gate();
  try {
    await waiting.ready();
    assert.equal(await waiting.hello(50), null, 'a hello nobody said was taken');
    const pending = waiting.hello(5_000);
    await send(waiting.address, {
      v: HOOK_EXCHANGE_VERSION,
      kind: 'hello',
      token: waiting.token,
      nonce: 'n1',
      runtime: 'pi',
      event: clean,
    });
    assert.deepEqual(await pending, clean);
    assert.deepEqual(await waiting.hello(1), clean, 'a hello said before is taken at once');
  } finally {
    waiting.close();
  }
  const closed = gate();
  const waited = closed.hello(5_000);
  closed.close();
  assert.equal(await waited, null);
});

test('an allow that rewrites the input is answered with the rewrite: pi runs the object its handler holds', async () => {
  const rewriting = gate(
    () => Promise.resolve({ behavior: 'allow', updatedInput: { command: 'git status --short' } }) as never,
  );
  try {
    await rewriting.ready();
    const answer = await send(rewriting.address, {
      v: HOOK_EXCHANGE_VERSION,
      kind: 'decide',
      token: rewriting.token,
      nonce: 'n2',
      runtime: 'pi',
      event: { toolName: 'bash', toolCallId: 'call_1', input: { command: 'git status' }, cwd: ROOT },
    });
    assert.deepEqual(readHookAnswer(answer, rewriting.token, 'n2'), {
      allow: true,
      updatedInput: { command: 'git status --short' },
    });
  } finally {
    rewriting.close();
  }
});

test('a call the extension sent that does not read whole is refused by the shared decision, never decided as something else', async () => {
  let asked = 0;
  const strict = gate(() => {
    asked += 1;
    return Promise.resolve({ behavior: 'allow' });
  });
  try {
    await strict.ready();
    const answer = await send(strict.address, {
      v: HOOK_EXCHANGE_VERSION,
      kind: 'decide',
      token: strict.token,
      nonce: 'n3',
      runtime: 'pi',
      event: { toolName: 'bash' },
    });
    assert.equal((readHookAnswer(answer, strict.token, 'n3') as { allow: boolean }).allow, false);
    assert.equal(asked, 0);
  } finally {
    strict.close();
  }
});
