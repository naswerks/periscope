import test from 'node:test';
import assert from 'node:assert/strict';

import type { RefusalReason } from '../core/refusal.js';
import type { Decider, DecisionRequest } from '../gate/decision.js';
import type { GateOutcome } from '../gate/outcome.js';
import { COPILOT_EXCLUDED_TOOLS } from '../gate/tool-kind.js';
import { isCodexSessionGate } from './codex-gate.js';
import {
  COPILOT_HOOK_REASON,
  COPILOT_MEASURED_PERMISSION_WAIT_MS,
  COPILOT_PROBE_ID_PREFIX,
  copilotAnswerOf,
  MAX_RAISED_DEGRADES,
  copilotDeadlineOrderRefusal,
  copilotMcpToolName,
  createCopilotSessionGate,
  isCopilotSessionGate,
} from './copilot-gate.js';
import type { CopilotEvent, CopilotPermissionRequest } from './copilot-sdk.js';

function gate(decide: Decider, servers: readonly string[] = []) {
  const requests: DecisionRequest[] = [];
  const outcomes: GateOutcome[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const built = createCopilotSessionGate({
    sessionKey: 'k',
    cwd: 'C:/work',
    decide: (request, signal) => {
      requests.push(request);
      return decide(request, signal);
    },
    decisionTimeoutMs: 1_000,
    holdAfterMs: 10_000,
    servers,
    onOutcome: (outcome) => outcomes.push(outcome),
    onDegrade: (name, detail) => raised.push({ name, detail }),
    onSpawnDegrades: () => undefined,
    probeId: () => 'fixed',
  });
  return { built, requests, outcomes, raised };
}

const allow: Decider = () => Promise.resolve({ behavior: 'allow' });
const deny: Decider = () => Promise.resolve({ behavior: 'deny', message: 'not that one' });

const hooked = (
  toolName: string,
  toolCallId = 'call_1',
  toolArgs: unknown = {},
  workingDirectory = 'C:/work',
) => ({
  sessionId: 's',
  toolCallId,
  toolName,
  toolArgs,
  workingDirectory,
});

const request = (
  toolName: string,
  toolCallId = 'call_1',
  toolArgs: unknown = {},
): CopilotPermissionRequest => ({
  kind: 'hook',
  toolCallId,
  toolName,
  toolArgs,
  hookMessage: COPILOT_HOOK_REASON,
  workingDirectory: 'C:/work',
});

const event = (type: string, data: Record<string, unknown>): CopilotEvent => ({
  id: `e-${type}`,
  parentId: null,
  timestamp: '2026-11-15T00:00:00.000Z',
  type,
  data,
});

test('the hook answers ask for every call, at once, whatever the call', () => {
  const run = gate(allow);
  for (const name of ['powershell', 'view', 'probe-srv-echo', 'a-tool-nobody-knows']) {
    assert.deepEqual(run.built.preToolUse(hooked(name, `call_${name}`)), {
      permissionDecision: 'ask',
      permissionDecisionReason: COPILOT_HOOK_REASON,
    });
  }
  // A hook input missing every member still asks: an answer it failed to give is a call let through.
  assert.equal(run.built.preToolUse({} as never).permissionDecision, 'ask');
  assert.equal(run.requests.length, 0, 'the hook decides nothing: the request does');
});

test("a hook request is decided by the one decision: the call's own id, its kind, the runtime, a shell call's dialect and where it runs", async () => {
  const run = gate(allow);
  run.built.identify('copilot-session');
  run.built.preToolUse(hooked('powershell', 'call_1', { command: 'git status' }, 'C:/work/sub'));
  const answer = await run.built.decide(request('powershell', 'call_1', { command: 'git status' }));
  assert.deepEqual(answer, { kind: 'approve-once' });
  const [asked] = run.requests;
  assert.equal(asked?.toolUseId, 'call_1');
  assert.equal(asked?.toolName, 'powershell');
  assert.equal(asked?.toolKind, 'shell');
  assert.equal(asked?.shellDialect, 'powershell');
  assert.equal(asked?.runtime, 'copilot');
  assert.equal(asked?.sessionId, 'copilot-session');
  assert.equal(asked?.cwd, 'C:/work/sub');
  run.built.preToolUse(hooked('view', 'call_2', { path: 'a.ts' }, 'not-absolute'));
  await run.built.decide(request('view', 'call_2', { path: 'a.ts' }));
  assert.equal(run.requests[1]?.toolKind, 'file_read');
  assert.equal(run.requests[1]?.cwd, 'C:/work', "a call naming no absolute directory runs in the session's");
  assert.equal('shellDialect' in (run.requests[1] ?? {}), false);
});

test('a deny reaches the model as a refusal with its words; only one-time answers are ever sent', async () => {
  const run = gate(deny);
  run.built.preToolUse(hooked('create', 'call_1', { path: 'x', file_text: 'y' }));
  assert.deepEqual(await run.built.decide(request('create', 'call_1')), {
    kind: 'reject',
    feedback: 'not that one',
  });
  for (const answer of [
    copilotAnswerOf({
      kind: 'expired',
      request: run.requests[0] as DecisionRequest,
      detail: 'no answer',
    } as never),
  ]) {
    assert.equal(answer.kind, 'reject');
  }
});

test('an allow that rewrites the input is refused: the rewrite lives only in the fail-open hook', async () => {
  const run = gate(() => Promise.resolve({ behavior: 'allow', updatedInput: { command: 'echo other' } }));
  run.built.preToolUse(hooked('powershell', 'call_1', { command: 'git status' }));
  const answer = await run.built.decide(request('powershell', 'call_1', { command: 'git status' }));
  assert.equal(answer.kind, 'reject');
});

test("fail closed: a request of the runtime's own flow, one no hook announced, and one naming no call are refused and never decided", async () => {
  const run = gate(allow);
  const own = await run.built.decide({ kind: 'read', toolCallId: 'call_1', toolName: 'view' });
  assert.equal(own.kind, 'reject');
  const unannounced = await run.built.decide(request('view', 'call_2'));
  assert.equal(unannounced.kind, 'reject');
  const nameless = await run.built.decide({ kind: 'hook' });
  assert.equal(nameless.kind, 'reject');
  assert.equal(run.requests.length, 0, 'none of the three reached the decider');
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['gate-hook-missing', 'gate-hook-missing', 'gate-hook-missing'],
  );
});

test("a request of the runtime's own flow is refused even for a call the hook announced: only the hook's request is decided", async () => {
  const run = gate(allow);
  run.built.preToolUse(hooked('view', 'call_1'));
  const answer = await run.built.decide({ kind: 'read', toolCallId: 'call_1', toolName: 'view' });
  assert.equal(answer.kind, 'reject');
  assert.equal(run.requests.length, 0, 'the decider was asked about a request the hook did not raise');
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['gate-hook-missing'],
  );
});

test('control: the joined route needs both halves; a request read as asked without its hook would decide an unannounced call', async () => {
  // With the hook's record, the decision runs.
  const joined = gate(allow);
  joined.built.preToolUse(hooked('view', 'call_1'));
  assert.equal((await joined.built.decide(request('view', 'call_1'))).kind, 'approve-once');
  // Without it, the same request is refused: the hook is half the receipt, not decoration.
  const half = gate(allow);
  assert.equal((await half.built.decide(request('view', 'call_1'))).kind, 'reject');
});

test('a tool this host turns off is refused at the gate, whatever the runtime offers, and never asked about', async () => {
  const run = gate(allow);
  for (const [index, tool] of COPILOT_EXCLUDED_TOOLS.entries()) {
    run.built.preToolUse(hooked(tool, `call_${index}`));
    const answer = await run.built.decide(request(tool, `call_${index}`));
    assert.equal(answer.kind, 'reject', `${tool} was let through`);
  }
  assert.equal(run.requests.length, 0);
});

test("an MCP tool is spelled by the servers' own tool lists, never by splitting on a hyphen", () => {
  const servers = new Map<string, readonly string[]>([
    ['probe-srv', ['echo-x', 'list']],
    ['probe', ['srv-echo-x']],
    ['nas', ['session_read']],
  ]);
  assert.equal(copilotMcpToolName('nas-session_read', servers), 'mcp__nas__session_read');
  assert.equal(copilotMcpToolName('probe-srv-list', servers), 'mcp__probe-srv__list');
  // Two (server, tool) pairs spell `probe-srv-echo-x`: the name keeps Copilot's spelling, a stranger's.
  assert.equal(copilotMcpToolName('probe-srv-echo-x', servers), 'probe-srv-echo-x');
  assert.equal(copilotMcpToolName('other-tool', servers), 'other-tool');
  // Control: the naive split a hyphen invites maps the ambiguous name to one of its two readings.
  const naive = (name: string): string =>
    `mcp__${name.slice(0, name.indexOf('-'))}__${name.slice(name.indexOf('-') + 1)}`;
  assert.notEqual(naive('probe-srv-echo-x'), copilotMcpToolName('probe-srv-echo-x', servers));
  assert.notEqual(naive('probe-srv-list'), copilotMcpToolName('probe-srv-list', servers));
});

test("the gate asks the runtime for a server's tools once, when a call names it, and spells the call from them", async () => {
  const run = gate(allow, ['probe-srv']);
  const listed: string[] = [];
  run.built.useToolLister((server) => {
    listed.push(server);
    return Promise.resolve(['echo-x']);
  });
  run.built.preToolUse(hooked('probe-srv-echo-x', 'call_1'));
  await run.built.decide(request('probe-srv-echo-x', 'call_1'));
  run.built.preToolUse(hooked('probe-srv-echo-x', 'call_2'));
  await run.built.decide(request('probe-srv-echo-x', 'call_2'));
  assert.deepEqual(listed, ['probe-srv']);
  assert.equal(run.requests[0]?.toolName, 'mcp__probe-srv__echo-x');
  assert.equal(run.requests[0]?.toolKind, 'mcp');
  assert.equal(run.built.toolName('probe-srv-echo-x'), 'mcp__probe-srv__echo-x');
  assert.equal(run.built.toolName('view'), 'view', 'a built-in is never read as a server tool');
});

test("a server's tool list that never answers does not hold the decision: the wait ends inside the deadline, and the call is asked about under the name the runtime gave", async () => {
  const run = gate(allow, ['probe-srv']);
  let asks = 0;
  run.built.useToolLister(() => {
    asks += 1;
    return new Promise(() => undefined);
  });
  const settledOrWaiting = async (id: string): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    run.built.preToolUse(hooked('probe-srv-echo-x', id));
    const answer = await Promise.race([
      run.built.decide(request('probe-srv-echo-x', id)),
      // Inside the decision's own deadline of a second.
      new Promise<'still waiting on the list'>((resolve) => {
        timer = setTimeout(() => resolve('still waiting on the list'), 900);
      }),
    ]);
    clearTimeout(timer);
    return answer;
  };
  assert.deepEqual(await settledOrWaiting('call_1'), { kind: 'approve-once' });
  assert.equal(run.requests[0]?.toolName, 'probe-srv-echo-x', "the runtime's own name, as when a list fails");
  // A second call while the first list is still unanswered asks the server nothing more, and is decided too.
  assert.deepEqual(await settledOrWaiting('call_2'), { kind: 'approve-once' });
  assert.equal(asks, 1);
});

test("what learning a server's tools takes comes out of the decision's deadline, so the two never outlast it", async () => {
  const run = gate(() => new Promise(() => undefined), ['probe-srv']);
  run.built.useToolLister(() => new Promise(() => undefined));
  run.built.preToolUse(hooked('probe-srv-echo-x', 'call_1'));
  const answer = await run.built.decide(request('probe-srv-echo-x', 'call_1'));
  assert.equal(answer.kind, 'reject');
  const expired = run.outcomes.find((outcome) => outcome.kind === 'expired');
  const left = Number(/within (\d+)ms/.exec(expired?.kind === 'expired' ? expired.detail : '')?.[1]);
  // The gate's deadline is a second and the list was waited on for a quarter of it.
  assert.ok(left >= 1 && left <= 800, `the decider was given ${left}ms after the wait`);
  // Control: a call that waits on no list has the whole deadline.
  run.built.preToolUse(hooked('view', 'call_2'));
  await run.built.decide(request('view', 'call_2'));
  const whole = run.outcomes.filter((outcome) => outcome.kind === 'expired').at(-1);
  assert.match(whole?.kind === 'expired' ? whole.detail : '', /within 1000ms/);
});

test("a decision that ends while a server's tool list is awaited stops waiting at once", async () => {
  const run = gate(allow, ['probe-srv']);
  run.built.useToolLister(() => new Promise(() => undefined));
  run.built.preToolUse(hooked('probe-srv-echo-x', 'call_1'));
  const session = new AbortController();
  const began = Date.now();
  const deciding = run.built.decide(request('probe-srv-echo-x', 'call_1'), session.signal);
  await Promise.resolve();
  session.abort();
  assert.equal((await deciding).kind, 'reject');
  assert.ok(Date.now() - began < 200, `the wait ran on for ${Date.now() - began}ms after the decision ended`);
});

test('a built-in the tables do not name is named once and decided like any other call; a named built-in and a server tool are not', async () => {
  const run = gate(allow, ['docs']);
  run.built.toolsOffered(['view', 'powershell', 'docs-search', 'late_arrival'], ['docs-search']);
  const unnamed = (): string[] =>
    run.raised.filter((one) => one.name === 'gate-tool-unnamed').map((one) => one.detail);
  assert.equal(unnamed().length, 1);
  assert.match(
    unnamed()[0] ?? '',
    /Copilot offers the tool late_arrival, which this host's tables do not name/,
  );
  // Offered again, or called: said once.
  run.built.toolsOffered(['late_arrival'], []);
  run.built.preToolUse(hooked('late_arrival', 'call_1'));
  const answer = await run.built.decide(request('late_arrival', 'call_1'));
  assert.deepEqual(answer, { kind: 'approve-once' }, 'the call is decided, never refused for its name');
  assert.equal(run.requests[0]?.toolName, 'late_arrival');
  assert.equal(run.requests[0]?.toolKind, 'other');
  assert.equal(unnamed().length, 1);
  // A built-in that appears only when it is called is named then.
  run.built.preToolUse(hooked('appeared_later', 'call_2'));
  await run.built.decide(request('appeared_later', 'call_2'));
  assert.equal(unnamed().length, 2);
  assert.match(unnamed()[1] ?? '', /Copilot was asked to run the tool appeared_later/);
  // Control: a table's own tool, and a name an attached server's tools could carry, are no strangers.
  run.built.preToolUse(hooked('view', 'call_3', { path: 'C:/work/a.ts' }));
  await run.built.decide(request('view', 'call_3', { path: 'C:/work/a.ts' }));
  run.built.preToolUse(hooked('docs-not-listed-yet', 'call_4'));
  await run.built.decide(request('docs-not-listed-yet', 'call_4'));
  assert.equal(unnamed().length, 2);
});

test('the probe is refused here, never asked of anyone, and reports how far it got', async () => {
  const run = gate(allow);
  const probe = run.built.probe();
  assert.equal(probe.id, `${COPILOT_PROBE_ID_PREFIX}fixed`);
  assert.deepEqual(probe.reach(), { hooked: false, asked: false, otherKind: null });
  run.built.preToolUse(hooked('view', probe.id));
  assert.equal((await run.built.decide(request('view', probe.id))).kind, 'reject');
  assert.deepEqual(probe.reach(), { hooked: true, asked: true, otherKind: null });
  assert.equal(run.requests.length, 0);
  // Through the runtime's own flow instead, the reach says so.
  const own = gate(allow);
  const second = own.built.probe();
  await own.built.decide({ kind: 'read', toolCallId: second.id, toolName: 'view' });
  assert.deepEqual(second.reach(), { hooked: false, asked: false, otherKind: 'read' });
});

test('the degrades the session events name, each once per key', () => {
  const run = gate(allow);
  run.built.observe(
    event('permission.requested', {
      requestId: 'r1',
      resolvedByHook: true,
      permissionRequest: { kind: 'shell', toolCallId: 'call_9' },
    }),
  );
  run.built.observe(
    event('hook.end', {
      hookInvocationId: 'h1',
      hookType: 'preToolUse',
      success: false,
      error: { message: 'boom' },
    }),
  );
  run.built.observe(event('hook.end', { hookInvocationId: 'h2', hookType: 'preToolUse', success: true }));
  run.built.observe(
    event('tool.execution_complete', { toolCallId: 'call_undecided', toolName: 'view', success: true }),
  );
  run.built.observe(
    event('assistant.server_tool_progress', { kind: 'web_search', outputIndex: 0, status: 'in_progress' }),
  );
  run.built.observe(
    event('assistant.server_tool_progress', { kind: 'web_search', outputIndex: 1, status: 'done' }),
  );
  run.built.observe(event('session.permissions_changed', { mode: 'allow-all', previousMode: 'manual' }));
  run.built.observe(event('session.permissions_changed', { mode: 'manual', previousMode: 'allow-all' }));
  run.built.observe(event('session.mode_changed', { newMode: 'autopilot', previousMode: 'interactive' }));
  run.built.observe(event('session.mode_changed', { newMode: 'plan', previousMode: 'interactive' }));
  assert.deepEqual(
    run.raised.map((one) => one.name),
    [
      'gate-hook-foreign',
      'gate-hook-missing',
      'gate-hook-missing',
      'gate-unhooked-call',
      'gate-mode-widened',
      'gate-mode-widened',
    ],
  );
  assert.match(run.raised[2]?.detail ?? '', /call_undecided/);
});

test('a mode a sub-agent reports is said of that sub-agent, by its id, and never of the session', () => {
  const run = gate(allow);
  const fromAgent = (type: string, data: Record<string, unknown>): CopilotEvent => ({
    ...event(type, data),
    agentId: 'agent-7',
  });
  run.built.observe(fromAgent('session.mode_changed', { newMode: 'autopilot', previousMode: 'interactive' }));
  run.built.observe(fromAgent('session.permissions_changed', { mode: 'allow-all', previousMode: 'manual' }));
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['gate-mode-widened', 'gate-mode-widened'],
  );
  for (const one of run.raised) {
    assert.match(one.detail, /^A sub-agent of the Copilot session \(agent-7\) reports /, one.detail);
  }
  // The session's own report of the same mode is a second fact, said in the session's name.
  run.built.observe(event('session.mode_changed', { newMode: 'autopilot', previousMode: 'interactive' }));
  assert.equal(run.raised.length, 3);
  assert.match(run.raised[2]?.detail ?? '', /^Copilot reports agent mode autopilot/);
  // Control: an admitted mode is nothing to name, whoever reports it.
  run.built.observe(fromAgent('session.mode_changed', { newMode: 'plan', previousMode: 'interactive' }));
  assert.equal(run.raised.length, 3);
});

test('a call is decided on the arguments its hook announced, and a request that carries others is named, not refused', async () => {
  const run = gate(allow);
  run.built.preToolUse(hooked('powershell', 'call_1', { command: 'npm test', description: 'tests' }));
  const answer = await run.built.decide(
    request('powershell', 'call_1', { command: 'npm test -- --watch', description: 'tests' }),
  );
  assert.deepEqual(answer, { kind: 'approve-once' }, 'the call is decided like any other');
  assert.deepEqual(run.requests[0]?.toolInput, { command: 'npm test', description: 'tests' });
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['gate-hook-missing'],
  );
  assert.match(
    run.raised[0]?.detail ?? '',
    /call call_1 with other arguments than its pre-tool hook announced/,
  );
  // Control: the same arguments by value, in another order and as a text, are no difference.
  run.built.preToolUse(hooked('powershell', 'call_2', { command: 'npm test', description: 'tests' }));
  await run.built.decide(request('powershell', 'call_2', { description: 'tests', command: 'npm test' }));
  run.built.preToolUse(hooked('apply_patch', 'call_3', '*** Begin Patch'));
  await run.built.decide(request('apply_patch', 'call_3', '*** Begin Patch'));
  assert.equal(run.raised.length, 1);
  assert.equal(run.requests[2]?.toolInput, '*** Begin Patch');
  // A hook that announced no arguments leaves the request's to be read; a request with none, the hook's.
  run.built.preToolUse({ ...hooked('view', 'call_4'), toolArgs: undefined });
  await run.built.decide(request('view', 'call_4', { path: 'C:/work/a.txt' }));
  assert.deepEqual(run.requests[3]?.toolInput, { path: 'C:/work/a.txt' });
  run.built.preToolUse(hooked('view', 'call_5', { path: 'C:/work/b.txt' }));
  await run.built.decide({ kind: 'hook', toolCallId: 'call_5', toolName: 'view' });
  assert.deepEqual(run.requests[4]?.toolInput, { path: 'C:/work/b.txt' });
  assert.equal(run.raised.length, 1);
});

test("a degrade past the session's cap is kept off its lane and still reaches the host's log, each time it occurs", () => {
  const onLane: string[] = [];
  const logged: string[] = [];
  const built = createCopilotSessionGate({
    sessionKey: 'k',
    cwd: 'C:/work',
    decide: allow,
    decisionTimeoutMs: 1_000,
    holdAfterMs: 10_000,
    servers: [],
    onOutcome: () => undefined,
    onDegrade: (_name, detail) => onLane.push(detail),
    onDegradePastCap: (name, detail) => logged.push(`${name}: ${detail}`),
    onSpawnDegrades: () => undefined,
  });
  for (let index = 0; index < MAX_RAISED_DEGRADES; index += 1) {
    built.raise('gate-hook-missing', `call ${index}`, `call_${index}`);
  }
  assert.equal(onLane.length, MAX_RAISED_DEGRADES);
  assert.deepEqual(logged, [], 'a degrade under the cap went to the log alone');
  built.raise('gate-unhooked-call', 'one more', 'call_past');
  built.raise('gate-unhooked-call', 'one more', 'call_past');
  assert.equal(onLane.length, MAX_RAISED_DEGRADES, 'the lane took a degrade past its cap');
  assert.deepEqual(logged, ['gate-unhooked-call: one more', 'gate-unhooked-call: one more']);
  // One raised before the cap is still said once.
  built.raise('gate-hook-missing', 'call 0', 'call_0');
  assert.equal(logged.length, 2);
});

test('a decided call that ran raises nothing', async () => {
  const run = gate(allow);
  run.built.preToolUse(hooked('view', 'call_1'));
  await run.built.decide(request('view', 'call_1'));
  run.built.observe(event('tool.execution_complete', { toolCallId: 'call_1', success: true }));
  assert.deepEqual(run.raised, []);
});

const finished = (toolCallId: string, success: boolean, toolName = 'view'): CopilotEvent =>
  event('tool.execution_complete', { toolCallId, toolName, success });

test("a call that ran against this host's refusal is named; a refused call that did not run is not", async () => {
  const run = gate(deny);
  run.built.preToolUse(hooked('create', 'call_refused'));
  assert.equal((await run.built.decide(request('create', 'call_refused'))).kind, 'reject');
  run.built.observe(finished('call_refused', true, 'create'));
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['gate-hook-missing'],
  );
  assert.match(run.raised[0]?.detail ?? '', /ran call call_refused \(create\) although this host refused it/);
  // Control: the refusal held, the call failed with the refusal's words, and nothing is named.
  const held = gate(deny);
  held.built.preToolUse(hooked('create', 'call_held'));
  await held.built.decide(request('create', 'call_held'));
  held.built.observe(finished('call_held', false, 'create'));
  assert.deepEqual(held.raised, []);
  // A request of the runtime's own flow is refused here too, and a call that ran past that is named.
  const own = gate(allow);
  await own.built.decide({ kind: 'write', toolCallId: 'call_own', toolName: 'create' });
  own.built.observe(finished('call_own', true, 'create'));
  assert.match(own.raised.at(-1)?.detail ?? '', /although this host refused it/);
});

test("a call id handed out again is a new call: the first one's answer does not cover it", async () => {
  const run = gate(allow);
  run.built.preToolUse(hooked('view', 'call_0'));
  await run.built.decide(request('view', 'call_0'));
  run.built.observe(finished('call_0', true));
  assert.equal(run.raised.length, 0, 'the decided call ran');
  // The provider reuses the id for a later call, and this one reaches no hook and no request.
  run.built.observe(finished('call_0', true));
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['gate-hook-missing'],
  );
  assert.match(run.raised[0]?.detail ?? '', /ran call call_0 \(view\) with no decision from this host/);
});

test("a call the runtime makes by itself is named with its tool and with what it is: its read of a finished background command's output reaches no hook", () => {
  const run = gate(allow);
  // As the pinned runtime sends them: the command's end, then a read of its output under an id of the
  // runtime's own, whose start names the tool and whose end does not.
  run.built.observe(
    event('system.notification', { kind: { type: 'shell_completed', shellId: '0', exitCode: 1 } }),
  );
  run.built.observe(
    event('tool.execution_start', {
      toolCallId: 'd7ef7090',
      toolName: 'read_powershell',
      arguments: { shellId: '0', delay: 0 },
    }),
  );
  run.built.observe(event('tool.execution_complete', { toolCallId: 'd7ef7090', success: true }));
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['gate-hook-missing'],
  );
  assert.match(
    run.raised[0]?.detail ?? '',
    /ran call d7ef7090 \(read_powershell\) with no decision from this host for it: the runtime's own read of the output of a background command that had ended \(shell 0\)/,
  );
  // Control: a read of a shell nothing said had ended is named with its tool, and as nothing more.
  run.built.observe(
    event('tool.execution_start', {
      toolCallId: 'call_other',
      toolName: 'read_powershell',
      arguments: { shellId: '7' },
    }),
  );
  run.built.observe(event('tool.execution_complete', { toolCallId: 'call_other', success: true }));
  assert.match(
    run.raised[1]?.detail ?? '',
    /ran call call_other \(read_powershell\) with no decision from this host for it$/,
  );
});

test('a call that finishes while this host is still deciding it is named', async () => {
  let answer: (decision: unknown) => void = () => undefined;
  const run = gate(() => new Promise((resolve) => (answer = resolve)));
  run.built.preToolUse(hooked('view', 'call_early'));
  const deciding = run.built.decide(request('view', 'call_early'));
  await Promise.resolve();
  run.built.observe(finished('call_early', true));
  assert.match(
    run.raised[0]?.detail ?? '',
    /finished call call_early \(view\) while this host was still deciding it/,
  );
  answer({ behavior: 'allow' });
  await deciding;
});

test('ending the waiting decisions refuses each in the words given, records it refused, and leaves the next call to be decided afresh', async () => {
  let answer: (decision: unknown) => void = () => undefined;
  let asked = 0;
  const run = gate(() => {
    asked += 1;
    return asked === 1
      ? new Promise((resolve) => (answer = resolve))
      : Promise.resolve({ behavior: 'allow' });
  });
  run.built.preToolUse(hooked('powershell', 'call_waiting', { command: 'npm test' }));
  const waiting = run.built.decide(request('powershell', 'call_waiting', { command: 'npm test' }));
  await Promise.resolve();
  run.built.endPending('the turn was interrupted while this decision was outstanding');
  const ended = await waiting;
  assert.equal(ended.kind, 'reject');
  assert.match(
    ended.kind === 'reject' ? (ended.feedback ?? '') : '',
    /permission-decision-unavailable: the turn was interrupted while this decision was outstanding/,
  );
  assert.equal(run.outcomes.at(-1)?.kind, 'refused', 'the call is on record as refused, never as allowed');
  // A late answer from the decider changes nothing, and the session still decides its next call.
  answer({ behavior: 'allow' });
  run.built.preToolUse(hooked('view', 'call_next'));
  assert.deepEqual(await run.built.decide(request('view', 'call_next')), { kind: 'approve-once' });
  // With nothing waiting, ending is nothing.
  run.built.endPending('again');
  assert.equal(run.outcomes.filter((outcome) => outcome.kind === 'refused').length, 1);
});

test('only the probe this gate minted is its own: another id that starts the same is a call like any other', () => {
  const run = gate(allow);
  const minted = run.built.probe();
  run.built.observe(finished(minted.id, false));
  assert.equal(run.raised.length, 0, "the probe's own end is this host's doing");
  run.built.observe(finished(`${COPILOT_PROBE_ID_PREFIX}of-someone-else`, true));
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['gate-hook-missing'],
  );
  assert.match(run.raised[0]?.detail ?? '', /with no decision from this host for it/);
});

test('the deadline order: a decision deadline at the measured wait is admitted, a millisecond over is refused', () => {
  assert.equal(copilotDeadlineOrderRefusal(COPILOT_MEASURED_PERMISSION_WAIT_MS), null);
  assert.equal(copilotDeadlineOrderRefusal(50_000), null);
  assert.match(
    copilotDeadlineOrderRefusal(COPILOT_MEASURED_PERMISSION_WAIT_MS + 1) ?? '',
    /longer than Copilot's wait for a permission answer is known to be/,
  );
});

test("the registry's route tells a Copilot gate from another runtime's", () => {
  const run = gate(allow);
  assert.equal(isCopilotSessionGate(run.built), true);
  assert.equal(isCodexSessionGate(run.built), false);
  assert.equal(isCopilotSessionGate({ runtime: 'codex', decide: () => undefined }), false);
  assert.equal(isCopilotSessionGate(null), false);
});
