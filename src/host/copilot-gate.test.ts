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
    event('tool.execution_complete', { toolCallId: `${COPILOT_PROBE_ID_PREFIX}x`, success: false }),
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

test('a decided call that ran raises nothing', async () => {
  const run = gate(allow);
  run.built.preToolUse(hooked('view', 'call_1'));
  await run.built.decide(request('view', 'call_1'));
  run.built.observe(event('tool.execution_complete', { toolCallId: 'call_1', success: true }));
  assert.deepEqual(run.raised, []);
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
