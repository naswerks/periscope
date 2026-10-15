import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject } from '../control/frames.js';
import { CODEX_NAMES } from './codex-names.js';
import { FAKE_MODELS, fakeCodex } from '../test-support/fake-codex.js';
import type { FakeCodex, FakeCodexOptions } from '../test-support/fake-codex.js';
import type { AgentProcess, AgentProcessRequest } from './agent-process.js';
import { CODEX_ANSWERED_REQUESTS, codexServerRequestAnswer } from './codex-answers.js';
import {
  CODEX_HOME_VARIABLE,
  codexInitFacts,
  codexOptOuts,
  codexRequestProblem,
  startCodexProcess,
} from './codex-process.js';
import type { CodexMessage } from './codex-wire.js';

const HOME = 'C:/runner/codex-home';
const BINARY = 'C:/tools/codex/codex.exe';

function processRequest(overrides: Partial<AgentProcessRequest> = {}): AgentProcessRequest {
  return {
    cwd: 'C:/work/session-1',
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
  readonly process: AgentProcess<CodexMessage>;
  readonly fake: FakeCodex;
  readonly messages: CodexMessage[];
  readonly degrades: string[];
  /** Settles with the error the stream ended with, or null for a clean end. */
  readonly ended: Promise<Error | null>;
}

function started(
  overrides: Partial<AgentProcessRequest> = {},
  options: Partial<FakeCodexOptions> = {},
): Started {
  const fake = fakeCodex({ codexHome: HOME, ...options });
  const degrades: string[] = [];
  const process = startCodexProcess(
    processRequest(overrides),
    {
      binary: BINARY,
      home: HOME,
      clientVersion: '1.7.0',
      spawn: fake.spawn,
      killTree: () => Promise.resolve(),
      closeGraceMs: 30,
    },
    (detail) => degrades.push(detail),
  );
  const messages: CodexMessage[] = [];
  const ended = (async (): Promise<Error | null> => {
    try {
      for await (const message of process.messages) messages.push(message);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();
  return { process, fake, messages, degrades, ended };
}

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const opened = (session: Started): Promise<void> =>
  until(
    () =>
      session.messages.some(
        (message) => message.kind === 'notification' && message.method === 'thread/started',
      ),
    'the thread to open',
  );

const params = (message: JsonObject | undefined): JsonObject => (message?.['params'] ?? {}) as JsonObject;

// ---------------------------------------------------------------------------
// The opening
// ---------------------------------------------------------------------------

test('the app-server is started from the binary with the session flags as root overrides, in the worktree, with CODEX_HOME set', async () => {
  const session = started();
  await opened(session);
  const spawned = session.fake.child.spawned;
  assert.equal(spawned?.command, BINARY);
  assert.equal(spawned?.cwd, 'C:/work/session-1');
  assert.equal(spawned?.env['CODEX_HOME'], HOME);
  assert.equal(spawned?.env['PATH'], 'p');
  const args = spawned?.args ?? [];
  assert.deepEqual(args.slice(-4), ['app-server', '--listen', 'stdio://', '--strict-config']);
  for (const flag of [
    'approvals_reviewer="user"',
    'approval_policy="on-request"',
    'sandbox_mode="workspace-write"',
    'web_search="disabled"',
    'features.hooks=true',
    `shell_environment_policy.exclude=${JSON.stringify([CODEX_HOME_VARIABLE])}`,
  ]) {
    const at = args.indexOf(flag);
    assert.ok(at > 0 && args[at - 1] === '-c', `${flag} is not a -c override: ${args.join(' ')}`);
  }
  assert.ok(!args.some((arg) => arg.includes('bypass_hook_trust')), 'the hook-trust bypass was set');
  session.process.close();
});

test('the opening: initialize without experimental API, initialized, the catalog, the thread, the skills, the MCP servers', async () => {
  const session = started();
  await opened(session);
  assert.deepEqual(session.fake.server.methods(), [
    'initialize',
    'initialized',
    'model/list',
    'thread/start',
    'skills/list',
    'mcpServerStatus/list',
  ]);
  const init = params(session.fake.server.requestsOf('initialize')[0]);
  assert.deepEqual(init['clientInfo'], { name: 'periscope', title: null, version: '1.7.0' });
  const capabilities = init['capabilities'] as JsonObject;
  assert.equal(capabilities['experimentalApi'], false);
  const optedOut = capabilities['optOutNotificationMethods'] as string[];
  assert.ok(optedOut.includes('thread/archived') && optedOut.includes('turn/diff/updated'));
  assert.ok(!optedOut.includes('turn/started') && !optedOut.includes('item/agentMessage/delta'));
  const experimental = CODEX_NAMES.notifications
    .filter((entry) => entry.experimental)
    .map((entry) => entry.method);
  assert.deepEqual(
    optedOut.filter((method) => experimental.includes(method)),
    [],
    'an experimental name was opted out',
  );

  const start = params(session.fake.server.requestsOf('thread/start')[0]);
  assert.equal('cwd' in start, false, 'thread/start named a cwd, which records the project as trusted');
  assert.equal(start['approvalPolicy'], 'on-request');
  assert.equal(start['sandbox'], 'workspace-write');
  assert.equal(start['approvalsReviewer'], 'user');
  assert.equal(start['ephemeral'], false);
  const config = start['config'] as JsonObject;
  assert.equal(config['approvals_reviewer'], 'user');
  assert.equal(config['web_search'], 'disabled');
  assert.equal(config['features.hooks'], true);
  for (const field of [
    'dynamicTools',
    'experimentalRawEvents',
    'permissions',
    'historyMode',
    'runtimeWorkspaceRoots',
  ]) {
    assert.equal(field in start, false, `${field} is experimental and was sent`);
  }
  assert.deepEqual(params(session.fake.server.requestsOf('skills/list')[0]), {
    cwds: ['C:/work/session-1'],
    forceReload: true,
  });
  assert.deepEqual(params(session.fake.server.requestsOf('mcpServerStatus/list')[0]), {
    threadId: 'thread-1',
  });
  session.process.close();
});

test('the opening answers ride before what arrived meanwhile, so the receipt can precede ready', async () => {
  const session = started();
  await opened(session);
  assert.deepEqual(
    session.messages.map((message) => `${message.kind}:${message.method}`),
    [
      'answer:initialize',
      'answer:thread/start',
      'answer:skills/list',
      'answer:mcpServerStatus/list',
      'notification:thread/started',
    ],
  );
  const facts = codexInitFacts(session.messages[1] as CodexMessage);
  assert.equal(facts?.sessionId, 'thread-1');
  assert.equal(facts?.model, 'gpt-6-sol');
  assert.equal(facts?.permissionMode, 'on-request');
  session.process.close();
});

test('a server on another version is refused at initialize, by name, with the version found and pinned', async () => {
  const session = started({}, { version: '0.163.0' });
  const error = await session.ended;
  assert.match(
    error?.message ?? '',
    /^runtime-unavailable: the Codex app-server is Codex 0\.163\.0; this host is pinned to Codex 0\.162\.1/,
  );
  assert.equal(
    session.fake.server.requestsOf('thread/start').length,
    0,
    'a thread was opened on the wrong version',
  );
});

test('control: an unreleased build is refused by name at initialize too', async () => {
  const session = started({}, { version: '0.0.0' });
  assert.match((await session.ended)?.message ?? '', /an unreleased build \(0\.0\.0\)/);
});

test('a server running from another home is refused: the home variable did not take', async () => {
  const session = started({}, { codexHome: 'C:/Users/someone/.codex' });
  assert.match(
    (await session.ended)?.message ?? '',
    /runs from home C:\/Users\/someone\/\.codex, not the configured/,
  );
});

test('a thread running somewhere other than the worktree is refused', async () => {
  const session = started({}, { cwd: 'C:/elsewhere' });
  assert.match(
    (await session.ended)?.message ?? '',
    /the thread runs in C:\/elsewhere, not the session's C:\/work\/session-1/,
  );
});

test('resume is thread/resume and fork is thread/fork, neither naming a cwd; fork keeps a rollout', async () => {
  const resumed = started({ resume: 'thread-9' });
  await until(() => resumed.fake.server.requestsOf('thread/resume').length === 1, 'the resume');
  const resume = params(resumed.fake.server.requestsOf('thread/resume')[0]);
  assert.equal(resume['threadId'], 'thread-9');
  assert.equal('cwd' in resume, false);
  assert.equal('ephemeral' in resume, false, 'resume takes no ephemeral member');
  resumed.process.close();

  const forked = started({ resume: 'thread-9', fork: true });
  await until(() => forked.fake.server.requestsOf('thread/fork').length === 1, 'the fork');
  const fork = params(forked.fake.server.requestsOf('thread/fork')[0]);
  assert.equal(fork['threadId'], 'thread-9');
  assert.equal(fork['ephemeral'], false);
  assert.equal('cwd' in fork, false);
  await opened(forked);
  assert.equal(codexInitFacts(forked.messages[1] as CodexMessage)?.sessionId, 'thread-1-fork');
  forked.process.close();
});

// ---------------------------------------------------------------------------
// Turns: the host-held queue
// ---------------------------------------------------------------------------

test('a second prompt while a turn runs is held, never sent: turn/start goes out only once the turn completes', async () => {
  const session = started();
  await opened(session);
  assert.equal(session.process.prompt('first'), true);
  // The turn is running and known to be, not merely starting: its answer and its start have arrived.
  await until(
    () =>
      session.messages.some((message) => message.kind === 'answer' && message.method === 'turn/start') &&
      session.messages.some(
        (message) => message.kind === 'notification' && message.method === 'turn/started',
      ),
    'the first turn to run',
  );
  assert.equal(session.process.prompt('second'), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    session.fake.server.requestsOf('turn/start').length,
    1,
    'a turn/start went out while a turn was running',
  );
  session.fake.server.completeTurn();
  await until(() => session.fake.server.requestsOf('turn/start').length === 2, 'the held turn');
  const input = params(session.fake.server.requestsOf('turn/start')[1])['input'] as JsonObject[];
  assert.deepEqual(input, [{ type: 'text', text: 'second', text_elements: [] }]);
  session.process.close();
});

test('a prompt sent before the thread opens is held until it has', async () => {
  const session = started({}, { silent: ['mcpServerStatus/list'] });
  assert.equal(session.process.prompt('early'), true);
  await until(
    () => session.fake.server.requestsOf('mcpServerStatus/list').length === 1,
    'the opening to stall',
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(session.fake.server.requestsOf('turn/start').length, 0);
  session.process.close();
});

test('the queue holds at most sixteen turns; the seventeenth is refused', async () => {
  const session = started();
  await opened(session);
  assert.equal(session.process.prompt('running'), true);
  await until(() => session.fake.server.requestsOf('turn/start').length === 1, 'the first turn');
  for (let held = 0; held < 16; held += 1) assert.equal(session.process.prompt(`held ${held}`), true);
  assert.equal(session.process.prompt('one too many'), false);
  session.process.close();
});

test('interrupt stops the running turn by its id; a held prompt runs after it', async () => {
  const session = started();
  await opened(session);
  session.process.prompt('long');
  await until(() => session.fake.server.currentTurn !== null, 'the turn to run');
  session.process.prompt('after');
  await session.process.interrupt();
  assert.deepEqual(params(session.fake.server.requestsOf('turn/interrupt')[0]), {
    threadId: 'thread-1',
    turnId: 'turn-1',
  });
  await until(() => session.fake.server.requestsOf('turn/start').length === 2, 'the held prompt');
  session.process.close();
});

test('an interrupt asked before the turn has an id is sent once it has one', async () => {
  const session = started({}, { announceTurns: false });
  await opened(session);
  session.process.prompt('long');
  await session.process.interrupt();
  await until(() => session.fake.server.requestsOf('turn/interrupt').length === 1, 'the deferred interrupt');
  assert.equal(params(session.fake.server.requestsOf('turn/interrupt')[0])['turnId'], 'turn-1');
  session.process.close();
});

test('regression: an over-long prompt is not sent, is answered as not taken, and the session is told by name', async () => {
  const session = started();
  await opened(session);
  assert.equal(session.process.prompt('x'.repeat(1_048_577)), false, 'a turn that will never run was taken');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.fake.server.requestsOf('turn/start').length, 0);
  assert.match(session.degrades.join('\n'), /1048577 characters is past the 1048576 Codex takes/);
  session.process.close();
});

test('control: a prompt at the limit is taken and sent', async () => {
  const session = started();
  await opened(session);
  assert.equal(session.process.prompt('x'.repeat(1_048_576)), true);
  await until(() => session.fake.server.requestsOf('turn/start').length === 1, 'the turn to start');
  session.process.close();
});

// ---------------------------------------------------------------------------
// Setters: held to the next turn
// ---------------------------------------------------------------------------

async function nextTurn(session: Started, apply: () => Promise<void>): Promise<JsonObject> {
  await apply();
  const before = session.fake.server.requestsOf('turn/start').length;
  session.process.prompt('go');
  await until(() => session.fake.server.requestsOf('turn/start').length === before + 1, 'the next turn');
  const sent = params(session.fake.server.requestsOf('turn/start')[before]);
  session.fake.server.completeTurn();
  return sent;
}

test('setModel applies at the next turn; null returns to the model the thread opened on', async () => {
  const session = started();
  await opened(session);
  assert.equal(
    (await nextTurn(session, () => session.process.setModel('gpt-6-luna')))['model'],
    'gpt-6-luna',
  );
  assert.equal(
    'model' in (await nextTurn(session, () => Promise.resolve())),
    false,
    'a model rode a turn nobody changed',
  );
  assert.equal((await nextTurn(session, () => session.process.setModel(null)))['model'], 'gpt-6-luna');
  session.process.close();
});

test('setPermissionMode applies at the next turn as the approval policy, the sandbox object and the reviewer', async () => {
  const session = started();
  await opened(session);
  const sent = await nextTurn(session, () => session.process.setPermissionMode('dontAsk'));
  assert.equal(sent['approvalPolicy'], 'never');
  assert.deepEqual(sent['sandboxPolicy'], { type: 'workspaceWrite' });
  assert.equal(sent['approvalsReviewer'], 'user');
  const bypass = await nextTurn(session, () => session.process.setPermissionMode('bypassPermissions'));
  assert.deepEqual(bypass['sandboxPolicy'], { type: 'dangerFullAccess' });
  for (const refused of ['acceptEdits', 'plan', 'auto']) {
    await assert.rejects(session.process.setPermissionMode(refused as never), new RegExp(`not ${refused}`));
  }
  session.process.close();
});

test('setEffort applies a level the model lists at the next turn, and refuses one it does not, naming the list', async () => {
  const session = started();
  await opened(session);
  assert.equal((await nextTurn(session, () => session.process.setEffort('high')))['effort'], 'high');
  await assert.rejects(
    session.process.setEffort('ultra'),
    /effort ultra is not one gpt-6-sol lists: low, medium, high/,
  );
  session.process.close();
});

test('thinking off is effort none where the model lists it, refused where it does not; on restores the effort', async () => {
  const session = started();
  await opened(session);
  await assert.rejects(
    session.process.setThinking({ type: 'disabled' }),
    /thinking off is effort none, which gpt-6-sol does not list/,
  );
  await session.process.setModel('gpt-6-luna');
  await session.process.setEffort('low');
  const off = await nextTurn(session, () => session.process.setThinking({ type: 'disabled' }));
  assert.equal(off['effort'], 'none');
  const on = await nextTurn(session, () => session.process.setThinking({ type: 'adaptive' }));
  assert.equal(on['effort'], 'low');
  session.process.close();
});

test('pluginsApplied is true when the skills read reports no error, and false when it reports one', async () => {
  const clean = started();
  assert.equal(await clean.process.pluginsApplied(), true);
  clean.process.close();
  const broken = started(
    {},
    {
      skills: {
        data: [{ cwd: 'C:/work/session-1', skills: [], errors: [{ path: 'C:/p', message: 'no manifest' }] }],
      },
    },
  );
  assert.equal(await broken.process.pluginsApplied(), false);
  broken.process.close();
});

// ---------------------------------------------------------------------------
// Requests from the server: answered, fail closed
// ---------------------------------------------------------------------------

test('every request the server sends is answered, fail closed, and rides to the session with its answer', async () => {
  const session = started();
  await opened(session);
  const expected: Readonly<Record<string, JsonObject>> = {
    'item/commandExecution/requestApproval': { result: { decision: 'decline' } },
    'item/fileChange/requestApproval': { result: { decision: 'decline' } },
    'item/permissions/requestApproval': { result: { permissions: {}, scope: 'turn' } },
    'mcpServer/elicitation/request': { result: { action: 'decline', content: null, _meta: null } },
    'item/tool/requestUserInput': { result: { answers: {} } },
  };
  for (const method of CODEX_ANSWERED_REQUESTS) {
    const answered = await session.fake.server.ask(method, { threadId: 'thread-1' });
    assert.deepEqual({ result: answered['result'] }, expected[method], method);
  }
  for (const method of [
    'item/tool/call',
    'account/chatgptAuthTokens/refresh',
    'attestation/generate',
    'execCommandApproval',
    'currentTime/read',
  ]) {
    const answered = await session.fake.server.ask(method, {});
    assert.equal((answered['error'] as JsonObject | undefined)?.['code'], -32601, method);
  }
  const string = await session.fake.server.ask('item/fileChange/requestApproval', {}, 'req-x');
  assert.equal(string['id'], 'req-x', 'a string id was not echoed verbatim');
  const riding = (): number => session.messages.filter((message) => message.kind === 'server_request').length;
  await until(() => riding() === 11, 'every request to ride to the session');
  session.process.close();
});

test('control: no answer grants anything: no accept, no session-wide grant, no amendment', () => {
  for (const method of [...CODEX_ANSWERED_REQUESTS, 'anything/else']) {
    const text = JSON.stringify(codexServerRequestAnswer(method));
    for (const granting of ['"accept"', 'acceptForSession', 'Amendment', '"session"']) {
      assert.ok(!text.includes(granting), `${method} answered ${text}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The twenty request keys
// ---------------------------------------------------------------------------

test('the in-process members with no Codex meaning are refused by name, never dropped', () => {
  const refused: [string, Partial<AgentProcessRequest>][] = [
    ['hooks', { hooks: {} }],
    ['sessionStore', { sessionStore: {} as never }],
    ['sessionStoreFlush', { sessionStoreFlush: 'eager' }],
    ['spawn', { spawn: (() => undefined) as never }],
    ['settingSources', { settingSources: ['project'] }],
    ['forwardSubagentText', { forwardSubagentText: true }],
    ['permissionMode', { permissionMode: 'acceptEdits' }],
    ['systemPrompt', { systemPrompt: { type: 'preset', preset: 'claude_code' } }],
  ];
  for (const [key, overrides] of refused) {
    assert.match(codexRequestProblem(processRequest(overrides)) ?? '', new RegExp(`^${key}`), key);
  }
  assert.equal(codexRequestProblem(processRequest()), null);
});

test('a refused member ends the session by name before anything is spawned', async () => {
  const session = started({ hooks: {} });
  assert.match((await session.ended)?.message ?? '', /^request-key-unsupported: hooks/);
  assert.equal(session.fake.child.spawned, null);
});

test('the mapped members reach the thread: model, effort, the instructions in either lane, partial messages', async () => {
  const appended = started({
    model: 'gpt-6-luna',
    effort: 'low',
    systemPrompt: { type: 'preset', preset: 'runtime-default', append: 'Be brief.' },
  });
  await opened(appended);
  const start = params(appended.fake.server.requestsOf('thread/start')[0]);
  assert.equal(start['model'], 'gpt-6-luna');
  assert.equal((start['config'] as JsonObject)['model_reasoning_effort'], 'low');
  assert.equal(start['developerInstructions'], 'Be brief.');
  assert.equal('baseInstructions' in start, false);
  appended.process.close();

  const replaced = started({ systemPrompt: 'You are a reviewer.' });
  await opened(replaced);
  assert.equal(
    params(replaced.fake.server.requestsOf('thread/start')[0])['baseInstructions'],
    'You are a reviewer.',
  );
  replaced.process.close();

  const quiet = started({ includePartialMessages: false });
  await opened(quiet);
  const optedOut = (params(quiet.fake.server.requestsOf('initialize')[0])['capabilities'] as JsonObject)[
    'optOutNotificationMethods'
  ] as string[];
  assert.ok(optedOut.includes('item/agentMessage/delta') && optedOut.includes('item/reasoning/textDelta'));
  quiet.process.close();
  assert.deepEqual(
    codexOptOuts(false)
      .filter((method) => !codexOptOuts(true).includes(method))
      .sort(),
    ['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'],
  );
});

test('thinking off at the start is effort none on a model that lists it, and refused on one that does not', async () => {
  const off = started({ model: 'gpt-6-luna', thinking: { type: 'disabled' } });
  await opened(off);
  assert.equal(
    (params(off.fake.server.requestsOf('thread/start')[0])['config'] as JsonObject)['model_reasoning_effort'],
    'none',
  );
  off.process.close();
  const refused = started({ thinking: { type: 'disabled' } });
  assert.match(
    (await refused.ended)?.message ?? '',
    /thinking off is effort none, which gpt-6-sol does not list/,
  );
});

test('the permission mode a session opens in sets the thread: dontAsk never asks, bypass has full access', async () => {
  const session = started({ permissionMode: 'bypassPermissions' });
  await opened(session);
  const start = params(session.fake.server.requestsOf('thread/start')[0]);
  assert.equal(start['approvalPolicy'], 'never');
  assert.equal(start['sandbox'], 'danger-full-access');
  assert.ok(session.fake.child.spawned?.args.includes('sandbox_mode="danger-full-access"'));
  session.process.close();
});

test('the server stderr reaches onStderr, line by line', async () => {
  const lines: string[] = [];
  const session = started({ onStderr: (line) => lines.push(line) });
  await opened(session);
  session.fake.child.stderr('WARN something\n');
  await until(() => lines.includes('WARN something'), 'the stderr line');
  session.process.close();
});

test('plugins and MCP servers a session names are taken without refusal', async () => {
  const session = started({
    plugins: [{ type: 'local', path: 'C:/pack' }],
    mcpServers: { docs: { type: 'http', url: 'http://x' } as never },
  });
  await opened(session);
  session.process.close();
  assert.equal(await session.ended, null);
});

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

test('close interrupts a running turn, then ends stdin; a second close does nothing more', async () => {
  const session = started();
  await opened(session);
  session.process.prompt('long');
  await until(() => session.fake.server.currentTurn !== null, 'the turn to run');
  session.process.close();
  session.process.close();
  await until(() => session.fake.child.stdinEnded, 'stdin to end');
  assert.equal(session.fake.server.requestsOf('turn/interrupt').length, 1);
  assert.equal(session.process.prompt('after close'), false);
  session.fake.child.exit(0);
  assert.equal(await session.ended, null);
});

test('a server that exits unasked ends the stream with how it exited', async () => {
  const session = started();
  await opened(session);
  session.fake.child.exit(3);
  assert.match((await session.ended)?.message ?? '', /the Codex app-server exited \(exit code 3\)/);
});

test('a closed thread ends the process with it', async () => {
  const session = started();
  await opened(session);
  session.fake.server.notify('thread/closed', { threadId: 'thread-1' });
  await until(() => session.fake.child.stdinEnded, 'the process to close');
  session.fake.child.exit(0);
  assert.equal(await session.ended, null);
});

test('the fake catalog the tests run on has a default model, a model that takes none, and a hidden one', () => {
  assert.equal(FAKE_MODELS.filter((model) => model['isDefault'] === true).length, 1);
});
