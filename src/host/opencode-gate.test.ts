import test from 'node:test';
import assert from 'node:assert/strict';

import type { RefusalReason } from '../core/refusal.js';
import type { Decider, DecisionRequest } from '../gate/decision.js';
import { OPENCODE_TOOL_FAMILIES, localGate } from '../gate/local.js';
import type { LocalGate } from '../gate/local.js';
import type { GateOutcome } from '../gate/outcome.js';
import { OPENCODE_DENIED_TOOLS } from '../gate/tool-kind.js';
import { isCopilotSessionGate } from './copilot-gate.js';
import {
  createOpencodeSessionGate,
  isOpencodeBuiltin,
  isOpencodeSessionGate,
  opencodeAnswerOf,
  opencodeAskedOf,
  opencodeMcpToolName,
} from './opencode-gate.js';
import type { OpencodeAsked } from './opencode-gate.js';
import { opencodeRuleset } from './opencode-home.js';
import type { OpencodeMessage } from './opencode-wire.js';
import { nodePathResolver } from './paths.js';

const WINDOWS = process.platform === 'win32';
const CWD = WINDOWS ? 'C:/work' : '/work';

function gate(decide: Decider, options: { servers?: readonly string[]; localGate?: LocalGate } = {}) {
  const requests: DecisionRequest[] = [];
  const outcomes: GateOutcome[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const built = createOpencodeSessionGate({
    sessionKey: 'k',
    cwd: CWD,
    decide: (request, signal) => {
      requests.push(request);
      return decide(request, signal);
    },
    ...(options.localGate === undefined ? {} : { localGate: options.localGate }),
    decisionTimeoutMs: 1_000,
    holdAfterMs: 10_000,
    servers: options.servers ?? [],
    onOutcome: (outcome) => outcomes.push(outcome),
    onDegrade: (name, detail) => raised.push({ name, detail }),
    onSpawnDegrades: () => undefined,
  });
  built.identify('ses_main');
  return { built, requests, outcomes, raised };
}

const allow: Decider = () => Promise.resolve({ behavior: 'allow' });
const deny: Decider = () => Promise.resolve({ behavior: 'deny', message: 'not that one' });

const asked = (overrides: Partial<OpencodeAsked> = {}): OpencodeAsked => ({
  id: 'per_1',
  sessionID: 'ses_main',
  action: 'read',
  resources: ['a.ts'],
  metadata: {},
  callId: 'call_1',
  ...overrides,
});

const message = (type: string, data: Record<string, unknown>, session = 'ses_main'): OpencodeMessage => ({
  kind: 'event',
  event: { id: `evt_${type}`, type, data: { sessionID: session, ...data } },
  session,
  main: session === 'ses_main',
  spawnedBy: null,
});

test('each terminal outcome is a one-time answer, and a refusal always carries words', () => {
  const request = {} as DecisionRequest;
  assert.deepEqual(opencodeAnswerOf({ kind: 'allow', request, held: false } as never), { decision: 'once' });
  assert.deepEqual(opencodeAnswerOf({ kind: 'deny', request, held: false, message: 'no' } as never), {
    decision: 'reject',
    message: 'no',
  });
  assert.deepEqual(opencodeAnswerOf({ kind: 'deny', request, held: false, message: '' } as never), {
    decision: 'reject',
    message: 'this call was denied',
  });
  assert.deepEqual(
    opencodeAnswerOf({
      kind: 'refused',
      request,
      held: false,
      refusal: { reason: 'path-escapes-root', detail: 'outside' },
    } as never),
    { decision: 'reject', message: 'path-escapes-root: outside' },
  );
  assert.match(
    opencodeAnswerOf({ kind: 'expired', request, held: false, detail: 'no decision' } as never).message ?? '',
    /no decision/,
  );
});

test("a request's data is read loosely: its id, session, action, resources, metadata and the call that raised it", () => {
  assert.deepEqual(
    opencodeAskedOf({
      id: 'per_1',
      sessionID: 'ses_main',
      action: 'edit',
      resources: ['a.ts', 7, 'b.ts'],
      metadata: { input: { filePath: 'a.ts' } },
      source: { type: 'tool', id: 'call_1' },
    }),
    {
      id: 'per_1',
      sessionID: 'ses_main',
      action: 'edit',
      resources: ['a.ts', 'b.ts'],
      metadata: { input: { filePath: 'a.ts' } },
      callId: 'call_1',
    },
  );
  assert.equal(opencodeAskedOf({ sessionID: 's', action: 'read' }), null, 'no id');
  assert.equal(opencodeAskedOf({ id: 'p', action: 'read' }), null, 'no session');
  assert.equal(opencodeAskedOf({ id: 'p', sessionID: 's', action: 'read' })?.callId, null);
});

test("an MCP tool's name is read by the attached servers' names, never by splitting on an underscore", () => {
  assert.equal(opencodeMcpToolName('probe_srv_echo_twice', ['probe_srv']), 'mcp__probe_srv__echo_twice');
  assert.equal(opencodeMcpToolName('docs_search', ['docs', 'other']), 'mcp__docs__search');
  assert.equal(
    opencodeMcpToolName('stranger_tool', ['docs']),
    'stranger_tool',
    'no attached server keeps the name',
  );
  assert.equal(opencodeMcpToolName('docs_', ['docs']), 'docs_', 'a server name alone names no tool');
  assert.equal(
    opencodeMcpToolName('a_b_c', ['a', 'a_b']),
    'a_b_c',
    'two servers that could own it keep the name',
  );
  assert.equal(isOpencodeBuiltin('read'), true);
  assert.equal(isOpencodeBuiltin('external_directory'), true);
  assert.equal(isOpencodeBuiltin('execute'), true);
  assert.equal(isOpencodeBuiltin('docs_search'), false);
});

test("a request is decided by the one decision: the call's own id, the tool's spelling and kind, the runtime and session, a shell's dialect and where it runs", async () => {
  const run = gate(allow, { servers: ['docs'] });
  run.built.useShell(WINDOWS ? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : '/bin/bash');
  assert.deepEqual(
    await run.built.decide(
      asked({
        action: 'shell',
        resources: ['git status'],
        metadata: { input: { command: 'git status', workdir: 'sub' } },
      }),
    ),
    { decision: 'once' },
  );
  const [shell] = run.requests;
  assert.equal(shell?.toolUseId, 'call_1');
  assert.equal(shell?.toolName, 'shell');
  assert.equal(shell?.toolKind, 'shell');
  assert.equal(shell?.shellDialect, WINDOWS ? 'powershell' : 'posix');
  assert.equal(shell?.runtime, 'opencode');
  assert.equal(shell?.sessionId, 'ses_main');
  assert.equal(shell?.cwd, `${CWD}/sub`);
  assert.equal(shell?.agentId, null);
  await run.built.decide(asked({ id: 'per_2', callId: 'call_2', action: 'docs_search', resources: ['*'] }));
  assert.equal(run.requests[1]?.toolName, 'mcp__docs__search');
  assert.equal(run.requests[1]?.toolKind, 'mcp');
  assert.equal('shellDialect' in (run.requests[1] ?? {}), false);
  await run.built.decide(asked({ id: 'per_3', callId: null }));
  assert.equal(run.requests[2]?.toolUseId, 'per_3', 'a request naming no call is keyed by its own id');
});

test("the input is the call's own: the request's metadata first, else the input the stream announced, else the resources", async () => {
  const run = gate(allow);
  await run.built.decide(asked({ metadata: { input: { filePath: 'from-metadata.ts' } } }));
  run.built.observe(message('session.tool.called', { id: 'call_2', input: { filePath: 'announced.ts' } }));
  await run.built.decide(asked({ id: 'per_2', callId: 'call_2' }));
  await run.built.decide(asked({ id: 'per_3', callId: 'call_unknown', resources: ['x.ts', 'y.ts'] }));
  assert.deepEqual(
    run.requests.map((request) => request.toolInput),
    [{ filePath: 'from-metadata.ts' }, { filePath: 'announced.ts' }, { resources: ['x.ts', 'y.ts'] }],
  );
});

test('a deny reaches the model as a refusal with its words', async () => {
  const run = gate(deny);
  assert.deepEqual(await run.built.decide(asked({ action: 'edit' })), {
    decision: 'reject',
    message: 'not that one',
  });
});

test('a turned-off tool is refused without asking anyone, whatever the rules the runtime holds', async () => {
  const run = gate(allow);
  for (const action of OPENCODE_DENIED_TOOLS) {
    const answer = await run.built.decide(asked({ id: `per_${action}`, action }));
    assert.equal(answer.decision, 'reject', action);
    assert.match(answer.message ?? '', /turned off/);
  }
  assert.deepEqual(run.requests, []);
});

test("this host's own gate checks every path a request names, one at a time, and a directory request as its directory", async () => {
  const root = WINDOWS ? 'C:/work' : '/work';
  const outside = WINDOWS ? 'C:/elsewhere' : '/elsewhere';
  const local = localGate({
    workspaceRoot: root,
    writeRoots: [],
    resolve: nodePathResolver,
    protectedPaths: [`${outside}/creds`],
    home: WINDOWS ? 'C:/home' : '/home',
    toolFamilies: OPENCODE_TOOL_FAMILIES,
    readsShellDialect: true,
    resolvesAgainstCallCwd: true,
    resolvesWritesAgainstCallCwd: true,
  });
  const run = gate(allow, { localGate: local });
  const inside = await run.built.decide(
    asked({ action: 'edit', resources: [`${root}/a.ts`, `${root}/b.ts`] }),
  );
  assert.deepEqual(inside, { decision: 'once' });
  const escaped = await run.built.decide(
    asked({ id: 'per_2', callId: 'call_2', action: 'edit', resources: [`${root}/a.ts`, `${outside}/b.ts`] }),
  );
  assert.equal(escaped.decision, 'reject');
  assert.match(escaped.message ?? '', /^path-escapes-root:/);
  // A directory outside the location is a read: asked of the decider, unless it holds credential material.
  const directory = await run.built.decide(
    asked({ id: 'per_3', callId: 'call_3', action: 'external_directory', resources: [`${outside}/creds/*`] }),
  );
  assert.equal(directory.decision, 'reject');
  assert.match(directory.message ?? '', /^credential-path-denied:/);
  assert.equal(run.requests.length, 1, 'neither refused call was asked of anyone');
  const free = await run.built.decide(
    asked({ id: 'per_4', callId: 'call_4', action: 'external_directory', resources: [`${outside}/free/*`] }),
  );
  assert.deepEqual(free, { decision: 'once' }, 'control: a directory holding none is asked as any read is');
  assert.equal(run.requests.length, 2);
});

test("a subagent's request names its session and its agent", async () => {
  const run = gate(allow);
  run.built.observe(message('session.created', { agent: 'general', parentID: 'ses_main' }, 'ses_child'));
  await run.built.decide(asked({ sessionID: 'ses_child' }));
  assert.equal(run.requests[0]?.agentId, 'ses_child');
  assert.equal(run.requests[0]?.agentType, 'general');
});

test('a request the runtime refused together with another is ended here, refused with words, and never answered twice', async () => {
  const run = gate(() => new Promise(() => undefined));
  const pending = run.built.decide(asked({ id: 'per_waiting' }));
  await new Promise((resolve) => setImmediate(resolve));
  run.built.observe(message('permission.replied', { requestID: 'per_waiting', reply: 'reject' }));
  const answer = await pending;
  assert.equal(answer.decision, 'reject');
  assert.match(
    answer.message ?? '',
    /^permission-decision-unavailable: the runtime refused this request together with another/,
  );
  const [outcome] = run.outcomes.filter((one) => one.kind === 'refused');
  assert.equal(
    outcome?.kind === 'refused' ? outcome.refusal.reason : null,
    'permission-decision-unavailable',
  );
  assert.equal(run.raised.length, 0, 'a batch refusal is no widening');
});

test('an interrupt ends every decision still pending for its session, and no other', async () => {
  const run = gate(() => new Promise(() => undefined));
  const mine = run.built.decide(asked({ id: 'per_mine' }));
  const theirs = run.built.decide(asked({ id: 'per_theirs', sessionID: 'ses_child', callId: 'call_2' }));
  await new Promise((resolve) => setImmediate(resolve));
  run.built.endPending('ses_main', 'the turn was interrupted while this decision was outstanding');
  assert.match((await mine).message ?? '', /the turn was interrupted/);
  let settled = false;
  void theirs.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the subagent's decision is still pending");
  run.built.endPending('ses_child', 'closed');
  await theirs;
});

test('an approval this host never gave is named: gate-mode-widened; a reply to one of its own answers is not', async () => {
  const run = gate(allow);
  await run.built.decide(asked({ id: 'per_mine' }));
  run.built.observe(message('permission.replied', { requestID: 'per_mine', reply: 'once' }));
  assert.equal(run.raised.length, 0);
  run.built.observe(message('permission.replied', { requestID: 'per_stranger', reply: 'always' }));
  assert.equal(run.raised[0]?.name, 'gate-mode-widened');
  assert.match(run.raised[0]?.detail ?? '', /never gave approved request per_stranger \(always\)/);
});

test("rules that are no longer this host's are named: gate-mode-widened; the same rules are not", () => {
  const run = gate(allow);
  run.built.observe(message('session.permissions', { permissions: opencodeRuleset() }));
  assert.equal(run.raised.length, 0);
  run.built.observe(
    message('session.permissions', {
      permissions: [...opencodeRuleset(), { action: 'edit', resource: '*', effect: 'allow' }],
    }),
  );
  assert.equal(run.raised[0]?.name, 'gate-mode-widened');
  run.built.observe(message('session.permissions', { permissions: [] }));
  assert.equal(run.raised.length, 1, 'raised once per session');
});

test("a call the model's provider ran itself is named: gate-unhooked-call; a call that ran with no request for it: gate-hook-missing", async () => {
  const run = gate(allow);
  run.built.observe(message('session.tool.input.started', { id: 'call_web', name: 'websearch' }));
  run.built.observe(message('session.tool.called', { id: 'call_web', input: {}, executed: true }));
  run.built.observe(message('session.tool.success', { id: 'call_web', executed: true }));
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['gate-unhooked-call'],
  );
  assert.match(run.raised[0]?.detail ?? '', /websearch/);
  run.built.observe(message('session.tool.input.started', { id: 'call_bare', name: 'shell' }));
  run.built.observe(message('session.tool.called', { id: 'call_bare', input: { command: '' } }));
  run.built.observe(message('session.tool.success', { id: 'call_bare' }));
  assert.equal(run.raised[1]?.name, 'gate-hook-missing');
  assert.match(run.raised[1]?.detail ?? '', /call_bare \(shell\)/);
  // Control: a call decided here ran with its request.
  await run.built.decide(asked({ id: 'per_ok', callId: 'call_ok' }));
  run.built.observe(message('session.tool.success', { id: 'call_ok' }));
  assert.equal(run.raised.length, 2);
});

test('a degrade is raised once per name and key', () => {
  const run = gate(allow);
  run.built.raise('gate-foreign-extension', 'one', 'a');
  run.built.raise('gate-foreign-extension', 'two', 'a');
  run.built.raise('gate-foreign-extension', 'three', 'b');
  assert.deepEqual(
    run.raised.map((one) => one.detail),
    ['one', 'three'],
  );
});

test("an opencode gate is told from another runtime's", () => {
  const run = gate(allow);
  assert.equal(isOpencodeSessionGate(run.built), true);
  assert.equal(isCopilotSessionGate(run.built), false);
  assert.equal(isOpencodeSessionGate({ runtime: 'copilot', decide: () => undefined }), false);
  assert.equal(isOpencodeSessionGate(null), false);
});
