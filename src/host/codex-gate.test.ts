/**
 * The Codex gate through a whole host and a fake app-server: the hook trusted over the wire or the open
 * refused by name, every approval answered by the decider, its cache or its deadline, and each residual
 * raised on the session's state lane when it happens.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';

import type {
  HostConfiguration,
  JsonObject,
  SessionFrame,
  SessionNewGate,
  SessionPayload,
} from '../control/frames.js';
import { readAgentItem, readStateTransition, sessionNew, sessionNewRequest } from '../control/frames.js';
import type { LinkHandlers } from '../control/link.js';
import { ok } from '../core/result.js';
import type { Result } from '../core/result.js';
import type { Decider, DecisionRequest } from '../gate/decision.js';
import {
  HOOK_CHANNEL_VARIABLE,
  HOOK_DEADLINE_VARIABLE,
  HOOK_EXCHANGE_VERSION,
  HOOK_TOKEN_VARIABLE,
  readHookAnswer,
} from '../gate/hook-exchange.js';
import type { SessionTransition } from '../state/model.js';
import { FAKE_HOOK_HASH, FAKE_MODELS, fakeCodex } from '../test-support/fake-codex.js';
import type { FakeCodex, FakeCodexOptions } from '../test-support/fake-codex.js';
import { availableCodexEntry, codexHostModel } from './codex-runtime.js';
import type { HostLink } from './host.js';
import { PeriscopeHost } from './host.js';

const HOME = 'C:/runner/codex-home';
const CWD = 'C:/work/session-1';

class RecordingLink implements HostLink {
  readonly sent: { sessionId: string; payload: SessionPayload }[] = [];
  handlers: LinkHandlers | null = null;
  announced: HostConfiguration | null = null;
  send(sessionId: string, payload: SessionPayload): Result<void> {
    this.sent.push({ sessionId, payload });
    return ok(undefined);
  }
  start(): void {}
  stop(): void {}
  forgetSession(): void {}
  announce(_capabilities: readonly string[], configuration: HostConfiguration): void {
    this.announced = configuration;
  }
  deliver(sessionId: string, payload: SessionPayload, seq = 1): void {
    const frame: SessionFrame = { frame: 'session', sessionId, seq, at: '2026-10-13T00:00:00.000Z', payload };
    this.handlers?.onSessionFrame(frame);
  }
  bodies(): JsonObject[] {
    return this.sent.map(({ payload }) => (payload as unknown as { body: JsonObject }).body);
  }
  transitions(): SessionTransition[] {
    return this.bodies().flatMap((body) => readStateTransition(body) ?? []);
  }
  /** The refusal causes on the session's state lane, as `name: detail`. */
  refusals(): string[] {
    return this.transitions()
      .filter((transition) => transition.cause.kind === 'refusal')
      .map((transition) => `${transition.cause.event}: ${transition.cause.detail}`);
  }
  named(name: string): string[] {
    return this.refusals().filter((line) => line.startsWith(`${name}: `));
  }
}

interface GateHost {
  readonly host: PeriscopeHost;
  readonly link: RecordingLink;
  readonly fake: FakeCodex;
  readonly asked: DecisionRequest[];
}

async function until(check: () => boolean, what: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A host with Codex on a fake app-server, its decider recording what it is asked. */
async function gateHost(
  options: {
    readonly fake?: Partial<FakeCodexOptions>;
    readonly decide?: (request: DecisionRequest) => unknown;
  } = {},
): Promise<GateHost> {
  const fake = fakeCodex({ codexHome: HOME, ...options.fake });
  const link = new RecordingLink();
  const asked: DecisionRequest[] = [];
  const decide: Decider = (request) => {
    asked.push(request);
    return Promise.resolve(options.decide === undefined ? { behavior: 'allow' } : options.decide(request));
  };
  const host = new PeriscopeHost({
    controllerUrl: 'ws://unused',
    hostId: 'test-host',
    decide,
    protectedPaths: [],
    baseEnv: { PATH: 'p' },
    homeDir: 'C:/nonexistent-home-for-tests',
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
    agentCatalog: async () => ({ ok: false, detail: 'not read in this test' }),
    codex: {
      runtime: {
        binary: 'C:/tools/codex.exe',
        home: HOME,
        clientVersion: '1.7.0',
        spawn: fake.spawn,
        killTree: () => Promise.resolve(),
        closeGraceMs: 20,
      },
      read: async () => ({
        entry: availableCodexEntry(
          '0.162.1',
          FAKE_MODELS.filter((model) => model['hidden'] !== true).map((model) =>
            codexHostModel(model as never),
          ),
        ),
        detail: null,
      }),
    },
  });
  host.start();
  await until(() => link.announced !== null, 'the hello');
  return { host, link, fake, asked };
}

const open = (
  link: RecordingLink,
  request: Parameters<typeof sessionNewRequest>[0] = {},
  gate: SessionNewGate | null = null,
): void =>
  link.deliver(
    'handle-1',
    sessionNew(CWD, { request: sessionNewRequest({ runtime: 'codex', ...request }), gate }),
  );

const ready = async (link: RecordingLink): Promise<void> =>
  until(() => link.transitions().some((transition) => transition.to === 'ready'), 'the session to be ready');
const ended = async (link: RecordingLink): Promise<void> =>
  until(() => link.transitions().some((transition) => transition.to === 'ended'), 'the session to end');

/** How the fake's app-server was spawned; fails when it was not. */
function spawned(fake: FakeCodex): {
  readonly env: Readonly<Record<string, string>>;
  readonly args: readonly string[];
} {
  const started = fake.child.spawned;
  assert.ok(started !== null, 'the app-server was never spawned');
  return started;
}

/** Ask the session's hook channel about one call, as the hook process does. */
function askHook(fake: FakeCodex, event: JsonObject): Promise<unknown> {
  const env = spawned(fake).env;
  const address = env[HOOK_CHANNEL_VARIABLE] ?? '';
  const token = env[HOOK_TOKEN_VARIABLE] ?? '';
  return new Promise((resolve) => {
    const socket = connect(address);
    let answer = '';
    socket.on('connect', () =>
      socket.write(
        `${JSON.stringify({ v: HOOK_EXCHANGE_VERSION, kind: 'decide', token, nonce: 'nonce', runtime: 'codex', event })}\n`,
      ),
    );
    socket.on('data', (chunk: Buffer) => (answer += chunk.toString('utf8')));
    socket.on('close', () => resolve(readHookAnswer(answer.trim(), token, 'nonce')));
    socket.on('error', () => resolve(null));
  });
}

const hookEvent = (
  toolUseId: string,
  toolName = 'Bash',
  toolInput: JsonObject = { command: 'ls' },
  turnId = 'turn-1',
): JsonObject => ({
  session_id: 'codex-session',
  turn_id: turnId,
  cwd: CWD,
  hook_event_name: 'PreToolUse',
  model: 'gpt-test',
  permission_mode: 'default',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: toolUseId,
});

const commandApproval = (itemId: string, extra: JsonObject = {}): JsonObject => ({
  kind: 'command',
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId,
  startedAtMs: 1,
  command: 'ls',
  cwd: CWD,
  ...extra,
});

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

test('an untrusted hook is written trusted over the wire, as Codex records trust, before the thread opens', async () => {
  const { host, link, fake } = await gateHost({ fake: { hookTrust: 'untrusted' } });
  open(link);
  await ready(link);
  const writes = fake.server.requestsOf('config/batchWrite');
  assert.equal(writes.length, 1);
  const params = writes[0]?.['params'] as JsonObject;
  assert.equal(params['reloadUserConfig'], true);
  const [edit] = params['edits'] as JsonObject[];
  assert.equal(edit?.['keyPath'], 'hooks.state');
  assert.equal(edit?.['mergeStrategy'], 'upsert');
  assert.deepEqual(Object.values(edit?.['value'] as JsonObject), [{ trusted_hash: FAKE_HOOK_HASH }]);
  const methods = fake.server.methods();
  assert.ok(methods.indexOf('config/batchWrite') < methods.indexOf('thread/start'), methods.join(', '));
  assert.ok(
    methods.lastIndexOf('hooks/list') > methods.indexOf('thread/start'),
    'the hook was not listed again after the thread opened',
  );
  host.stop();
});

// Only a hook that changes once trusted is caught after the thread opens; every other is caught before.
for (const [trust, why, opensThread] of [
  ['stuck', /untrusted, not trusted and enabled/, false],
  ['absent', /lists no PreToolUse hook/, false],
  ['disabled', /disabled in the home's hooks\.state/, false],
  ['drifts', /changed after it was trusted/, true],
] as const) {
  test(`a session whose hook is ${trust} is refused codex-hook-not-active, on the state lane, and never reaches ready`, async () => {
    const { host, link, fake } = await gateHost({ fake: { hookTrust: trust } });
    open(link);
    await ended(link);
    const refused = link.named('codex-hook-not-active');
    assert.equal(refused.length, 1, link.refusals().join('\n'));
    assert.match(refused[0] ?? '', why);
    assert.equal(
      link.transitions().some((transition) => transition.to === 'ready'),
      false,
    );
    assert.equal(
      fake.server.methods().includes('thread/start'),
      opensThread,
      fake.server.methods().join(', '),
    );
    host.stop();
  });
}

test('control: a trusted hook opens the session with no trust write', async () => {
  const { host, link, fake } = await gateHost();
  open(link);
  await ready(link);
  assert.equal(fake.server.requestsOf('config/batchWrite').length, 0);
  assert.deepEqual(link.named('codex-hook-not-active'), []);
  host.stop();
});

test('a foreign hook, an active project layer and a sandbox-less mode are named in the opening tier and raised with their detail', async () => {
  const foreign = {
    key: 'C:/work/session-1/.codex/hooks.json:permission_request:0:0',
    eventName: 'permissionRequest',
    handlerType: 'command',
    command: 'answer.cmd',
    async: false,
    matcher: null,
    timeoutSec: 600,
    sourcePath: 'C:/work/session-1/.codex/hooks.json',
    source: 'project',
    enabled: true,
    currentHash: 'sha256:foreign',
    trustStatus: 'trusted',
  };
  const { host, link } = await gateHost({ fake: { foreignHooks: [foreign], projectLayer: true } });
  open(link, { permissionMode: 'bypassPermissions' });
  await ready(link);
  const opened = link.transitions().find((transition) => transition.to === 'ready');
  assert.deepEqual(opened?.controlTier, {
    level: 'intercepted-with-residual',
    degrades: ['gate-hook-foreign', 'gate-project-config-active', 'gate-sandbox-absent'],
  });
  assert.match(
    link.named('gate-hook-foreign')[0] ?? '',
    /permissionRequest from C:\/work\/session-1\/\.codex\/hooks\.json \(project\)/,
  );
  assert.equal(link.named('gate-project-config-active').length, 1);
  assert.match(link.named('gate-sandbox-absent')[0] ?? '', /danger-full-access/);
  host.stop();
});

test(
  'on Windows a sandbox that is not ready is named in the opening tier',
  { skip: process.platform !== 'win32' ? 'the Windows sandbox is read only on Windows' : false },
  async () => {
    const { host, link } = await gateHost({ fake: { sandboxReadiness: 'notConfigured' } });
    open(link);
    await ready(link);
    assert.deepEqual(
      link.transitions().find((transition) => transition.to === 'ready')?.controlTier?.degrades,
      ['gate-sandbox-absent'],
    );
    assert.match(link.named('gate-sandbox-absent')[0] ?? '', /notConfigured/);
    host.stop();
  },
);

test("a Codex session whose decision deadline leaves no room inside the hook's is refused gate-deadlines-inverted; one with room opens", async () => {
  const refused = await gateHost();
  open(refused.link, {}, { decisionTimeoutMs: 110_000, holdAfterMs: null, matcherTimeoutSeconds: 200 });
  await ended(refused.link);
  assert.equal(refused.link.named('gate-deadlines-inverted').length, 1, refused.link.refusals().join('\n'));
  refused.host.stop();
  const opened = await gateHost();
  open(opened.link, {}, { decisionTimeoutMs: 109_999, holdAfterMs: null, matcherTimeoutSeconds: 200 });
  await ready(opened.link);
  assert.equal(spawned(opened.fake).env[HOOK_DEADLINE_VARIABLE], '114999');
  opened.host.stop();
});

test("the hook's variables ride the app-server's environment and are kept from the agent's shell by exact name", async () => {
  const { host, link, fake } = await gateHost();
  open(link);
  await ready(link);
  const { env, args } = spawned(fake);
  for (const name of [HOOK_CHANNEL_VARIABLE, HOOK_TOKEN_VARIABLE, HOOK_DEADLINE_VARIABLE]) {
    assert.ok((env[name] ?? '') !== '', `${name} is not in the app-server's environment`);
  }
  const flag = args.find((arg) => arg.startsWith('shell_environment_policy.exclude='));
  const excluded = JSON.parse((flag ?? '').slice('shell_environment_policy.exclude='.length)) as string[];
  assert.deepEqual(excluded, [HOOK_CHANNEL_VARIABLE, HOOK_TOKEN_VARIABLE, HOOK_DEADLINE_VARIABLE]);
  // Codex reads each entry as a case-insensitive glob; an exact name removes that variable and no other.
  const glob = (pattern: string, name: string): boolean =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
      'i',
    ).test(name);
  const sample = [...Object.keys(env), 'PERISCOPE_HOOK_TOKEN_OLD', 'PATH'];
  const removed = sample.filter((name) => excluded.some((pattern) => glob(pattern, name)));
  assert.deepEqual(
    removed.sort(),
    [HOOK_CHANNEL_VARIABLE, HOOK_DEADLINE_VARIABLE, HOOK_TOKEN_VARIABLE].sort(),
  );
  host.stop();
});

// ---------------------------------------------------------------------------
// The hook channel and the approval channel
// ---------------------------------------------------------------------------

test("a hook call is decided by the session's decider with Codex's kind, runtime and dialect", async () => {
  const { host, link, fake, asked } = await gateHost({
    decide: (request) =>
      request.toolUseId === 'call_deny'
        ? { behavior: 'deny', message: 'the operator said no' }
        : { behavior: 'allow' },
  });
  open(link);
  await ready(link);
  assert.deepEqual(await askHook(fake, hookEvent('call_allow')), { allow: true });
  assert.deepEqual(await askHook(fake, hookEvent('call_deny')), {
    allow: false,
    reason: 'the operator said no',
  });
  assert.equal(asked[0]?.toolKind, 'shell');
  assert.equal(asked[0]?.runtime, 'codex');
  assert.equal(asked[0]?.shellDialect, process.platform === 'win32' ? 'powershell' : 'posix');
  assert.ok(
    link
      .transitions()
      .some(
        (transition) => transition.cause.kind === 'control' && transition.cause.event === 'permission_denied',
      ),
  );
  host.stop();
});

test('an approval for a call the hook decided is answered from that decision, without asking again', async () => {
  const { host, link, fake, asked } = await gateHost();
  open(link);
  await ready(link);
  await askHook(fake, hookEvent('call_one'));
  assert.equal(asked.length, 1);
  const answered = await fake.server.ask(
    'item/commandExecution/requestApproval',
    commandApproval('call_one'),
  );
  assert.deepEqual(answered['result'], { decision: 'accept' });
  assert.equal(asked.length, 1, 'the approval asked the decider again');
  host.stop();
});

test('control: an approval for a call no hook decided is decided fresh, and answered as the decider says', async () => {
  const { host, link, fake, asked } = await gateHost({
    decide: (request) =>
      request.toolUseId === 'call_stop'
        ? { behavior: 'deny', message: 'stop', interrupt: true }
        : request.toolUseId === 'call_no'
          ? { behavior: 'deny', message: 'no' }
          : { behavior: 'allow' },
  });
  open(link);
  await ready(link);
  assert.deepEqual(
    (await fake.server.ask('item/commandExecution/requestApproval', commandApproval('call_fresh')))['result'],
    { decision: 'accept' },
  );
  assert.deepEqual(
    (await fake.server.ask('item/commandExecution/requestApproval', commandApproval('call_no')))['result'],
    { decision: 'decline' },
  );
  assert.deepEqual(
    (await fake.server.ask('item/commandExecution/requestApproval', commandApproval('call_stop')))['result'],
    { decision: 'cancel' },
  );
  assert.deepEqual(
    asked.map((request) => request.toolUseId),
    ['call_fresh', 'call_no', 'call_stop'],
  );
  assert.equal(asked[0]?.toolName, 'Bash');
  host.stop();
});

test("input for a running command is always decided fresh, never answered from the launch's decision", async () => {
  const { host, link, fake, asked } = await gateHost({
    decide: (request) =>
      request.toolName === 'write_stdin' ? { behavior: 'deny', message: 'no input' } : { behavior: 'allow' },
  });
  open(link);
  await ready(link);
  await askHook(fake, hookEvent('call_one'));
  const answered = await fake.server.ask(
    'item/commandExecution/requestApproval',
    commandApproval('call_one', {
      kind: 'writeStdin',
      approvalId: 'approval-one',
      command: 'write_stdin --session-id 7 y',
    }),
  );
  assert.deepEqual(answered['result'], { decision: 'decline' });
  assert.deepEqual(
    asked.map((request) => request.toolName),
    ['Bash', 'write_stdin'],
  );
  host.stop();
});

test("at the host's deadline an approval is declined, named gate-approval-unanswered, and the call does not run", async () => {
  const { host, link, fake } = await gateHost({ decide: () => new Promise(() => undefined) });
  open(link, {}, { decisionTimeoutMs: 200, holdAfterMs: 50, matcherTimeoutSeconds: null });
  await ready(link);
  const answered = await fake.server.ask(
    'item/commandExecution/requestApproval',
    commandApproval('call_slow'),
  );
  assert.deepEqual(answered['result'], { decision: 'decline' });
  assert.equal(link.named('gate-approval-unanswered').length, 1);
  assert.ok(
    link
      .transitions()
      .some(
        (transition) => transition.cause.kind === 'timeout' && transition.cause.event === 'hook_timed_out',
      ),
  );
  host.stop();
});

test('a file change is answered from the patch decision only when the patch named its files; otherwise it is decided fresh over them', async () => {
  const { host, link, fake, asked } = await gateHost();
  open(link);
  await ready(link);
  const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '@@', '-x', '+y', '*** End Patch'].join(
    '\n',
  );
  await askHook(fake, hookEvent('call_patch', 'apply_patch', { command: patch }));
  fake.server.notify('item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      type: 'fileChange',
      id: 'call_patch',
      status: 'inProgress',
      changes: [{ path: `${CWD}/src/a.ts`, kind: { type: 'update' }, diff: '' }],
    },
  });
  fake.server.notify('item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      type: 'fileChange',
      id: 'call_other',
      status: 'inProgress',
      changes: [{ path: `${CWD}/src/b.ts`, kind: { type: 'update' }, diff: '' }],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    (
      await fake.server.ask('item/fileChange/requestApproval', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'call_patch',
        startedAtMs: 1,
        grantRoot: 'C:/',
      })
    )['result'],
    { decision: 'accept' },
  );
  assert.equal(asked.length, 1, 'a covered file change asked again');
  assert.deepEqual(
    (
      await fake.server.ask('item/fileChange/requestApproval', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'call_other',
        startedAtMs: 1,
      })
    )['result'],
    { decision: 'accept' },
  );
  assert.deepEqual(asked[1]?.toolInput, { changes: [{ path: `${CWD}/src/b.ts` }] });
  assert.equal(asked[1]?.toolName, 'apply_patch');
  host.stop();
});

test('a permission widening gets the empty grant for the turn, and a question for a person gets no answers', async () => {
  const { host, link, fake, asked } = await gateHost();
  open(link);
  await ready(link);
  assert.deepEqual(
    (
      await fake.server.ask('item/permissions/requestApproval', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'x',
        startedAtMs: 1,
        cwd: CWD,
        reason: null,
        permissions: {},
      })
    )['result'],
    { permissions: {}, scope: 'turn' },
  );
  assert.deepEqual(
    (
      await fake.server.ask('item/tool/requestUserInput', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'y',
        questions: [],
        isBlocking: true,
      })
    )['result'],
    { answers: {} },
  );
  assert.equal(asked.length, 0);
  host.stop();
});

const mcpStarted = (fake: FakeCodex, id: string, args: JsonObject): void =>
  fake.server.notify('item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { type: 'mcpToolCall', id, server: 'docs', tool: 'search', status: 'inProgress', arguments: args },
  });
const elicitation = (meta: JsonObject | null): JsonObject => ({
  threadId: 'thread-1',
  turnId: 'turn-1',
  serverName: 'docs',
  mode: 'form',
  message: 'Allow docs to run search?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: meta,
});

test("an MCP tool approval is decided for the call pending on that server, by its tool's name", async () => {
  const { host, link, fake, asked } = await gateHost();
  open(link);
  await ready(link);
  mcpStarted(fake, 'call_mcp', { q: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const answered = await fake.server.ask(
    'mcpServer/elicitation/request',
    elicitation({ codex_approval_kind: 'mcp_tool_call', tool_params: { q: 'x' } }),
  );
  assert.deepEqual(answered['result'], { action: 'accept', content: null, _meta: null });
  assert.equal(asked[0]?.toolName, 'mcp__docs__search');
  assert.equal(asked[0]?.toolKind, 'mcp');
  host.stop();
});

test('with two calls pending on one server and one denied, the approval is declined and named gate-approval-ambiguous', async () => {
  const { host, link, fake } = await gateHost({
    decide: (request) =>
      request.toolUseId === 'call_two' ? { behavior: 'deny', message: 'no' } : { behavior: 'allow' },
  });
  open(link);
  await ready(link);
  mcpStarted(fake, 'call_one', { q: 'x' });
  mcpStarted(fake, 'call_two', { q: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const answered = await fake.server.ask(
    'mcpServer/elicitation/request',
    elicitation({ codex_approval_kind: 'mcp_tool_call', tool_params: { q: 'x' } }),
  );
  assert.deepEqual(answered['result'], { action: 'decline', content: null, _meta: null });
  assert.match(link.named('gate-approval-ambiguous')[0] ?? '', /from docs/);
  host.stop();
});

test('a form an MCP server asks for, with no tool call behind it, is declined', async () => {
  const { host, link, fake, asked } = await gateHost();
  open(link);
  await ready(link);
  const answered = await fake.server.ask('mcpServer/elicitation/request', elicitation(null));
  assert.deepEqual(answered['result'], { action: 'decline', content: null, _meta: null });
  assert.equal(asked.length, 0);
  host.stop();
});

// ---------------------------------------------------------------------------
// The degrades
// ---------------------------------------------------------------------------

const hookCompleted = (fake: FakeCodex, toolUseId: string, status: string, entries: JsonObject[]): void =>
  fake.server.notify('hook/completed', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    run: {
      id: fake.server.hookRunId(toolUseId),
      eventName: 'preToolUse',
      handlerType: 'command',
      executionMode: 'sync',
      scope: 'turn',
      sourcePath: fake.server.hooksPath,
      source: 'user',
      displayOrder: 0,
      status,
      statusMessage: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 5,
      entries,
    },
  });

test('a failed hook run raises the degrade its error names, on the state lane', async () => {
  const { host, link, fake } = await gateHost();
  open(link);
  await ready(link);
  hookCompleted(fake, 'call_a', 'failed', [{ kind: 'error', text: 'hook timed out after 120s' }]);
  hookCompleted(fake, 'call_b', 'failed', [
    { kind: 'error', text: 'PreToolUse hook returned unsupported permissionDecision:allow' },
  ]);
  hookCompleted(fake, 'call_c', 'failed', [{ kind: 'error', text: 'program not found' }]);
  await until(() => link.named('gate-hook-unspawnable').length === 1, 'the third degrade');
  assert.match(link.named('gate-hook-timed-out')[0] ?? '', /call_a/);
  assert.match(link.named('gate-hook-output-rejected')[0] ?? '', /call_b/);
  assert.match(link.named('gate-hook-unspawnable')[0] ?? '', /call_c/);
  host.stop();
});

test('a call that proceeded or started with no decision from this host is gate-hook-missing; a decided one is not', async () => {
  const { host, link, fake } = await gateHost();
  open(link);
  await ready(link);
  await askHook(fake, hookEvent('call_decided'));
  hookCompleted(fake, 'call_decided', 'completed', []);
  fake.server.notify('item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      type: 'commandExecution',
      id: 'call_decided',
      command: 'ls',
      status: 'inProgress',
      source: 'agent',
    },
  });
  hookCompleted(fake, 'call_skipped', 'completed', []);
  fake.server.notify('item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      type: 'commandExecution',
      id: 'call_unhooked',
      command: 'ls',
      status: 'inProgress',
      source: 'agent',
    },
  });
  await until(() => link.named('gate-hook-missing').length === 2, 'two missing hooks');
  const missing = link.named('gate-hook-missing').join('\n');
  assert.match(missing, /call_skipped/);
  assert.match(missing, /call_unhooked/);
  assert.doesNotMatch(missing, /call_decided/);
  host.stop();
});

test("a model command started through unified exec is the model's too: undecided, it is gate-hook-missing; the user's own shell is not", async () => {
  const { host, link, fake } = await gateHost();
  open(link);
  await ready(link);
  const started = (id: string, source: string): void =>
    fake.server.notify('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'commandExecution', id, command: 'echo hi', status: 'inProgress', source },
    });
  started('call_user_shell', 'userShell');
  started('call_interaction', 'unifiedExecInteraction');
  started('call_unified', 'unifiedExecStartup');
  await until(() => link.named('gate-hook-missing').length === 1, 'one missing hook');
  const missing = link.named('gate-hook-missing').join('\n');
  assert.match(missing, /call_unified/);
  assert.doesNotMatch(missing, /call_user_shell|call_interaction/);
  host.stop();
});

test('input written to a running command raises gate-unhooked-call once per call, however many times it is written', async () => {
  const { host, link, fake } = await gateHost();
  open(link);
  await ready(link);
  for (const stdin of ['y\n', 'n\n']) {
    fake.server.notify('item/commandExecution/terminalInteraction', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'call_shell',
      processId: '7',
      stdin,
    });
  }
  fake.server.notify('item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { type: 'webSearch', id: 'search_one', query: 'x', action: null, results: null },
  });
  await until(() => link.named('gate-unhooked-call').length === 2, 'the unhooked calls');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const unhooked = link.named('gate-unhooked-call');
  assert.equal(unhooked.filter((line) => line.includes('call_shell')).length, 1, unhooked.join('\n'));
  assert.equal(unhooked.filter((line) => line.includes('search_one')).length, 1);
  host.stop();
});

test("an approval Codex's own reviewer decided is gate-approval-auto-reviewed", async () => {
  const { host, link, fake } = await gateHost();
  open(link);
  await ready(link);
  fake.server.notify('item/autoApprovalReview/completed', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    startedAtMs: 1,
    completedAtMs: 2,
    reviewId: 'review-one',
    targetItemId: 'call_r',
    decisionSource: 'agent',
    review: { status: 'approved' },
    action: { type: 'command' },
  });
  await until(() => link.named('gate-approval-auto-reviewed').length === 1, 'the auto-review degrade');
  host.stop();
});

test('a call the hook blocked on its own is recorded: an expiry by its name, anything else as an outage', async () => {
  const { host, link, fake } = await gateHost();
  open(link);
  await ready(link);
  hookCompleted(fake, 'call_expired', 'blocked', [
    {
      kind: 'feedback',
      text: 'hook_timed_out: no decision from the host within 55000ms; the call did not run',
    },
  ]);
  hookCompleted(fake, 'call_unreached', 'blocked', [
    { kind: 'feedback', text: 'the hook channel could not be reached' },
  ]);
  await until(() => link.named('permission-decision-unavailable').length === 1, 'the outage');
  assert.ok(
    link
      .transitions()
      .some(
        (transition) => transition.cause.kind === 'timeout' && transition.cause.detail.includes('55000ms'),
      ),
  );
  assert.match(link.named('permission-decision-unavailable')[0] ?? '', /call_unreached/);
  host.stop();
});

test("a call this host's gate refused ends its conversation item as blocked, whatever Codex reports", async () => {
  const { host, link, fake } = await gateHost({ decide: () => ({ behavior: 'deny', message: 'no' }) });
  open(link);
  await ready(link);
  await askHook(fake, hookEvent('call_refused'));
  const item = {
    type: 'commandExecution',
    id: 'call_refused',
    command: 'ls',
    cwd: CWD,
    processId: null,
    source: 'agent',
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
  fake.server.notify('item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { ...item, status: 'inProgress' },
  });
  fake.server.notify('item/completed', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { ...item, status: 'failed' },
  });
  await until(
    () => link.bodies().some((body) => readAgentItem(body)?.item.kind === 'tool_result'),
    'the tool result',
  );
  const result = link
    .bodies()
    .map((body) => readAgentItem(body)?.item)
    .find((one) => one?.kind === 'tool_result');
  assert.equal(result?.kind === 'tool_result' ? result.status : null, 'blocked');
  host.stop();
});
