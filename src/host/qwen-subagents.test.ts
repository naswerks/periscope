/**
 * A Qwen Code sub-agent, read the way the CLI's stream-json path writes it at v0.27.3: a foreground
 * sub-agent's tool calls and their results carry the spawning call as `parent_tool_use_id`
 * (`processSubagentToolCall` and `emitToolResult`, `packages/cli/src/nonInteractive/nonInteractiveHelpers.ts`),
 * and an agent task's `system/task_notification` carries the spawning call and its counts (`tool_use_id`,
 * `usage` with `total_tokens`, `tool_uses` and `duration_ms`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentFact, AgentItem, JsonObject } from '../control/frames.js';
import { fixedTicker } from '../core/time.js';
import { SessionStateMachine } from '../state/machine.js';
import type { SessionState } from '../state/model.js';
import { SessionObserver } from '../state/observer.js';
import { QwenFactLift } from './qwen-facts.js';
import { QwenItemFill } from './qwen-items.js';
import type { QwenMessage } from './qwen-wire.js';

const message = (body: JsonObject): QwenMessage => ({ kind: 'message', message: body });

/** The spawning call the main thread makes, then a sub-agent's call and its result. */
const spawnAndWork: readonly QwenMessage[] = [
  message({
    type: 'assistant',
    uuid: 'a-main',
    session_id: 's1',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'call_agent', name: 'agent', input: { prompt: 'Look.' } }] },
  }),
  message({
    type: 'assistant',
    uuid: 'a-sub',
    session_id: 's1',
    parent_tool_use_id: 'call_agent',
    message: {
      content: [{ type: 'tool_use', id: 'sub_read', name: 'read_file', input: { file_path: 'a.ts' } }],
    },
  }),
  message({
    type: 'user',
    uuid: 'u-sub',
    session_id: 's1',
    parent_tool_use_id: 'call_agent',
    message: { content: [{ type: 'tool_result', tool_use_id: 'sub_read', content: 'text' }] },
  }),
  message({
    type: 'user',
    uuid: 'u-main',
    session_id: 's1',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: 'call_agent', content: 'found it' }] },
  }),
];

/** Each item as `[itemId, kind, parentId]`, an absent parent read as null. */
const placed = (items: readonly AgentItem[]): [string, string, string | null][] =>
  items.map((item) => [item.itemId, item.kind, item.parentId ?? null]);

function fill(spawned: boolean, messages: readonly QwenMessage[]): AgentItem[] {
  const items = new QwenItemFill('session-1', { spawnedItems: () => spawned });
  return messages.flatMap((one) => [...items.fromMessage(one)]);
}

test("a sub-agent's call and its result fill items naming the call that spawned it, read by Qwen's own kinds", () => {
  const items = fill(true, spawnAndWork);
  assert.deepEqual(placed(items), [
    ['call_agent', 'tool_call', null],
    ['sub_read', 'tool_call', 'call_agent'],
    ['sub_read:result', 'tool_result', 'call_agent'],
    ['call_agent:result', 'tool_result', null],
  ]);
  const read = items.find((item) => item.itemId === 'sub_read');
  assert.equal(read?.kind === 'tool_call' ? read.toolKind : null, 'file_read');
  for (const item of items.filter((one) => one.parentId === undefined)) {
    assert.equal('parentId' in item, false, `${item.itemId}: an own item states no parent`);
  }
});

test("control: with a sub-agent's items not wanted, the same messages fill only the session's own", () => {
  assert.deepEqual(placed(fill(false, spawnAndWork)), [
    ['call_agent', 'tool_call', null],
    ['call_agent:result', 'tool_result', null],
  ]);
});

/** The `tasks` facts `messages` lift. */
function tasks(messages: readonly QwenMessage[]): Extract<AgentFact, { kind: 'tasks' }>[] {
  const lift = new QwenFactLift();
  return messages
    .flatMap((one) => [...lift.fromMessage(one).facts])
    .filter((fact): fact is Extract<AgentFact, { kind: 'tasks' }> => fact.kind === 'tasks');
}

const system = (subtype: string, data: JsonObject): QwenMessage =>
  message({ type: 'system', subtype, uuid: `${subtype}-${String(data['task_id'])}`, session_id: 's1', data });

test('an agent task names the call that started it and, settled, the counts the CLI reported for it', () => {
  const lifted = tasks([
    system('task_started', {
      task_id: 't1',
      tool_use_id: 'call_agent',
      description: 'Look.',
      subagent_type: 'general-purpose',
    }),
    system('task_notification', {
      task_id: 't1',
      tool_use_id: 'call_agent',
      status: 'completed',
      usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4100 },
    }),
  ]);
  assert.deepEqual(lifted[0]?.running, [
    { taskId: 't1', type: 'background', description: 'Look.', toolUseId: 'call_agent' },
  ]);
  assert.deepEqual(lifted[1]?.settled, [
    {
      taskId: 't1',
      type: 'background',
      status: 'completed',
      toolUseId: 'call_agent',
      usage: { tokens: 1200, toolUses: 3, durationMs: 4100 },
    },
  ]);
  const entry = lifted[1]?.settled?.[0] as Record<string, unknown> | undefined;
  assert.equal('summary' in (entry ?? {}), false, 'the CLI reports no summary for a task');
  assert.equal('outputFile' in (entry ?? {}), false, 'the CLI reports no output file for a task');
});

test('control: usage missing a count, or not a whole count, is never stated in part', () => {
  const settled = (usage: JsonObject) =>
    tasks([system('task_notification', { task_id: 't2', tool_use_id: 'call_x', status: 'failed', usage })])[0]
      ?.settled?.[0];
  assert.deepEqual(settled({ total_tokens: 10, tool_uses: 1 }), {
    taskId: 't2',
    type: null,
    status: 'failed',
    toolUseId: 'call_x',
  });
  assert.equal('usage' in (settled({ total_tokens: 10, tool_uses: 1, duration_ms: 2.5 }) ?? {}), false);
  assert.equal('usage' in (settled({ total_tokens: -1, tool_uses: 1, duration_ms: 2 }) ?? {}), false);
});

// ---------------------------------------------------------------------------
// A foreground sub-agent's own end
// ---------------------------------------------------------------------------

/**
 * The `result` the CLI writes when a foreground sub-agent fails or is cancelled, as v0.27.3 builds it
 * (`buildSubagentErrorResult`, `packages/cli/src/nonInteractive/io/BaseJsonOutputAdapter.ts`): no parent,
 * the error subtype, no turns and no time. `overrides` changes one field for a control.
 */
const subagentEnd = (overrides: JsonObject = {}): QwenMessage =>
  message({
    type: 'result',
    subtype: 'error_during_execution',
    uuid: 'r-sub',
    session_id: 's1',
    is_error: true,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    permission_denials: [],
    error: { message: 'Task execution failed' },
    ...overrides,
  });

const sessionEnd: QwenMessage = message({
  type: 'result',
  subtype: 'success',
  uuid: 'r-main',
  session_id: 's1',
  is_error: false,
  duration_ms: 900,
  num_turns: 2,
  usage: { input_tokens: 40, output_tokens: 9 },
  result: 'done',
});

const turnStart = message({ type: 'system', subtype: 'init', uuid: 's1', session_id: 's1', tools: [] });
const [spawnCall, subCall, , spawnResult] = spawnAndWork as [
  QwenMessage,
  QwenMessage,
  QwenMessage,
  QwenMessage,
];

/** What each of the session's readers made of `messages`: the states, the turns ended, the turn records. */
function readers(messages: readonly QwenMessage[]): {
  states: SessionState[];
  ended: string[];
  records: number;
} {
  const machine = new SessionStateMachine({
    where: { worktree: null, branch: null, cwd: 'C:/work', unknownReason: 'not a repository' },
    clock: () => '2000-01-01T00:00:00.000Z',
    ticker: fixedTicker(0),
  });
  const observer = new SessionObserver(machine, { controlTier: { level: 'none', degrades: [] } });
  const states: SessionState[] = [];
  machine.onTransition((transition) => states.push(transition.to));
  const items = new QwenItemFill('session-1', { spawnedItems: () => true });
  const lift = new QwenFactLift({ startModel: 'qwen3-coder-plus' });
  const ended: string[] = [];
  let records = 0;
  const opening: QwenMessage = {
    kind: 'answer',
    subtype: 'initialize',
    request: {},
    response: { session_id: 's1' },
  };
  for (const one of [opening, ...messages]) {
    observer.observeQwenMessage(one);
    for (const item of items.fromMessage(one)) {
      if (item.kind === 'turn' && item.status !== 'started') ended.push(item.status);
    }
    records += lift.fromMessage(one).facts.filter((fact) => fact.kind === 'turn_record').length;
  }
  return { states, ended, records };
}

test("a foreground sub-agent's failure ends none of the session's turn, records no turn and closes no entry", () => {
  const { states, ended, records } = readers([
    turnStart,
    spawnCall,
    subCall,
    subagentEnd(),
    spawnResult,
    sessionEnd,
  ]);
  assert.deepEqual(ended, ['completed'], "the sub-agent's end was read as the session's turn ending");
  assert.equal(records, 1, "the sub-agent's end was recorded as a turn of the session's");
  assert.equal(states.at(-1), 'idle');
  assert.equal(states.includes('errored'), false, "the sub-agent's end errored the session");
});

test('control: the same result once the spawning call has returned is the session turn ending', () => {
  const { states, ended, records } = readers([turnStart, spawnCall, subCall, spawnResult, subagentEnd()]);
  assert.deepEqual(ended, ['failed']);
  assert.equal(records, 1);
  assert.equal(states.at(-1), 'errored');
});

test('control: an interrupt with the spawning call still open ends the turn interrupted', () => {
  const interrupt = subagentEnd({ error: { message: 'Operation cancelled.' } });
  const { states, ended } = readers([turnStart, spawnCall, subCall, interrupt]);
  assert.deepEqual(ended, ['interrupted']);
  assert.equal(states.at(-1), 'interrupted');
});

test("control: a session result with the spawning call open but turns of its own still ends the session's turn", () => {
  const { states, ended, records } = readers([turnStart, spawnCall, subCall, subagentEnd({ num_turns: 1 })]);
  assert.deepEqual(ended, ['failed']);
  assert.equal(records, 1);
  assert.equal(states.at(-1), 'errored');
});

test("control: a session result with the spawning call open and no turns counted, but time of its own, still ends the session's turn", () => {
  const { states, ended, records } = readers([
    turnStart,
    spawnCall,
    subCall,
    subagentEnd({ duration_ms: 900 }),
  ]);
  assert.deepEqual(ended, ['failed']);
  assert.equal(records, 1);
  assert.equal(states.at(-1), 'errored');
});
