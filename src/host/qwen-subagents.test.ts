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
