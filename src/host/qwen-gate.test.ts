import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject } from '../control/frames.js';
import type { RefusalReason } from '../core/refusal.js';
import type { Decider, DecisionRequest } from '../gate/decision.js';
import type { GateOutcome } from '../gate/outcome.js';
import { isCodexSessionGate } from './codex-gate.js';
import {
  QWEN_MAX_PERMISSION_TIMEOUT_MS,
  createQwenSessionGate,
  isQwenSessionGate,
  qwenAnswerOf,
  qwenDeadlineOrderRefusal,
  qwenPermissionTimeoutMs,
  ruleNames,
} from './qwen-gate.js';

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

function gate(decide: Decider, platform = 'win32') {
  const requests: DecisionRequest[] = [];
  const outcomes: GateOutcome[] = [];
  const raised: { name: RefusalReason; detail: string }[] = [];
  const built = createQwenSessionGate({
    sessionKey: 'k',
    cwd: 'C:/work',
    decide: (request, signal) => {
      requests.push(request);
      return decide(request, signal);
    },
    decisionTimeoutMs: 1_000,
    holdAfterMs: 10_000,
    askRules: ['run_shell_command', 'read_file', 'mcp__nas'],
    onOutcome: (outcome) => outcomes.push(outcome),
    onDegrade: (name, detail) => raised.push({ name, detail }),
    onSpawnDegrades: () => undefined,
    platform,
  });
  return { built, requests, outcomes, raised };
}

const ask = (tool: string, input: JsonObject, id = 'call_1'): JsonObject => ({
  subtype: 'can_use_tool',
  tool_name: tool,
  tool_use_id: id,
  input,
  permission_suggestions: null,
  blocked_path: null,
});

test("the CLI's permission timeout sits above the decision deadline, and a deadline past the CLI's ceiling is refused", () => {
  assert.equal(qwenPermissionTimeoutMs(50_000), 55_000);
  assert.equal(qwenDeadlineOrderRefusal(50_000), null);
  assert.equal(qwenDeadlineOrderRefusal(QWEN_MAX_PERMISSION_TIMEOUT_MS - 5_000), null);
  assert.match(
    qwenDeadlineOrderRefusal(QWEN_MAX_PERMISSION_TIMEOUT_MS - 4_999) ?? '',
    /leaves no room inside Qwen Code's permission timeout/,
  );
});

test("the decision request names the call by the CLI's own id, its kind, the runtime, and a shell call's dialect from the CLI's environment", async () => {
  const run = gate(() => Promise.resolve({ behavior: 'allow' }));
  run.built.identify('qwen-session');
  run.built.spawnedWith({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
  const answer = await run.built.decide(
    ask('run_shell_command', { command: 'git status', directory: 'C:/work/sub' }),
    new AbortController().signal,
  );
  assert.deepEqual(answer, { response: { behavior: 'allow' } });
  const [request] = run.requests;
  assert.equal(request?.toolUseId, 'call_1');
  assert.equal(request?.toolName, 'run_shell_command');
  assert.equal(request?.toolKind, 'shell');
  assert.equal(request?.shellDialect, 'cmd');
  assert.equal(request?.runtime, 'qwen-code');
  assert.equal(request?.sessionId, 'qwen-session');
  assert.equal(request?.sessionKey, 'k');
  assert.equal(request?.cwd, 'C:/work/sub');
  await run.built.decide(
    ask('read_file', { file_path: 'C:/work/a.ts' }, 'call_2'),
    new AbortController().signal,
  );
  assert.equal(run.requests[1]?.toolKind, 'file_read');
  assert.equal('shellDialect' in (run.requests[1] ?? {}), false, 'only a shell call states a dialect');
  assert.equal(run.requests[1]?.cwd, 'C:/work');
});

test('a deny carries its reason; a refusal and an expiry are denies the model reads; an allow carries no input of its own', () => {
  const request = {
    toolName: 't',
    toolUseId: 'u',
    toolInput: {},
    sessionId: '',
    sessionKey: 'k',
    cwd: '',
    agentId: null,
    agentType: null,
  };
  assert.deepEqual(qwenAnswerOf({ kind: 'allow', request, held: false, updatedInput: { a: 1 } }), {
    behavior: 'allow',
  });
  assert.deepEqual(qwenAnswerOf({ kind: 'deny', request, held: false, message: 'no' }), {
    behavior: 'deny',
    message: 'no',
  });
  assert.deepEqual(
    qwenAnswerOf({
      kind: 'refused',
      request,
      held: false,
      refusal: { reason: 'credential-path-denied', detail: 'd' },
    }),
    { behavior: 'deny', message: 'credential-path-denied: d' },
  );
  assert.match(
    textOf(qwenAnswerOf({ kind: 'expired', request, held: false, detail: 'late' })['message']),
    /^hook_timed_out: late$/,
  );
});

test('control: a request the gate cannot read is refused and denied, never allowed', async () => {
  const run = gate(() => Promise.resolve({ behavior: 'allow' }));
  const answer = await run.built.decide({ subtype: 'can_use_tool', input: {} }, new AbortController().signal);
  assert.equal('response' in answer && answer.response['behavior'] === 'allow', false);
  assert.equal(run.requests.length, 0, 'an unreadable call never reached the decider');
});

test('a tool the first init lists with no rule is named once; a server rule names every tool of that server', () => {
  const run = gate(() => Promise.resolve({ behavior: 'allow' }));
  run.built.observeInit(['read_file', 'monitor', 'mcp__nas__seat_read', 'mcp__other__x'], 'default');
  run.built.observeInit(['read_file', 'later_tool'], 'default');
  assert.deepEqual(
    run.raised.map((one) => one.name),
    ['gate-tool-unruled', 'gate-tool-unruled'],
  );
  assert.match(run.raised[0]?.detail ?? '', /monitor/);
  assert.match(run.raised[1]?.detail ?? '', /mcp__other__x/);
  assert.equal(ruleNames(new Set(['mcp__nas']), 'mcp__nas__seat_read'), true);
  assert.equal(ruleNames(new Set(['mcp__nas']), 'mcp__nasty__x'), false);
  assert.equal(ruleNames(new Set(['mcp__nas']), 'mcp__nas'), true);
});

test('a widened mode is named once per mode; default and plan are not', () => {
  const run = gate(() => Promise.resolve({ behavior: 'allow' }));
  run.built.observeInit(null, 'default');
  run.built.observeInit(null, 'plan');
  run.built.observeInit(null, 'auto-edit');
  run.built.observeInit(null, 'auto-edit');
  run.built.observeInit(null, 'yolo');
  assert.deepEqual(
    run.raised.map((one) => one.detail),
    [
      'Qwen Code reports permission mode auto-edit, which approves calls itself',
      'Qwen Code reports permission mode yolo, which approves calls itself',
    ],
  );
});

test("a Qwen gate and a Codex gate are never mistaken for each other on the registry's route", () => {
  const run = gate(() => Promise.resolve({ behavior: 'allow' }));
  assert.equal(isQwenSessionGate(run.built), true);
  assert.equal(isCodexSessionGate(run.built), false);
  assert.equal(isQwenSessionGate({ answer: () => 0, observe: () => 0, ready: () => 0 }), false);
});
