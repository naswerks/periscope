import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentItem, JsonObject } from '../control/frames.js';
import { QwenItemFill } from './qwen-items.js';
import type { QwenMessage } from './qwen-wire.js';

const message = (body: JsonObject): QwenMessage => ({ kind: 'message', message: body });
const init: QwenMessage = message({
  type: 'system',
  subtype: 'init',
  uuid: 's1',
  session_id: 's1',
  tools: [],
});

function fill(messages: readonly QwenMessage[], blocked: readonly string[] = []): AgentItem[] {
  const items = new QwenItemFill('session-1');
  for (const id of blocked) items.gateBlocked(id);
  return messages.flatMap((one) => [...items.fromMessage(one)]);
}

test('a prompt the host wrote is marked started, with its text, at the next main-thread init, in order', () => {
  const items = fill([
    { kind: 'prompt', text: 'first' },
    { kind: 'prompt', text: 'second' },
    init,
    init,
    init,
  ]);
  assert.deepEqual(
    items.map((item) => [item.kind, item.itemId, item.kind === 'user_text' ? item.text : null]),
    [
      ['turn', 'session-1:prompt:1:turn', null],
      ['user_text', 'session-1:prompt:1', 'first'],
      ['turn', 'session-1:prompt:2:turn', null],
      ['user_text', 'session-1:prompt:2', 'second'],
      ['turn', 'session-1:turn:3', null],
    ],
  );
});

test("the assistant's blocks fill text, thinking and tool calls, and a tool call's kind is Qwen's, never Claude's", () => {
  const items = fill([
    message({
      type: 'assistant',
      uuid: 'a1',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'running it' },
          { type: 'tool_use', id: 'call_1', name: 'run_shell_command', input: { command: 'git status' } },
        ],
      },
    }),
  ]);
  assert.deepEqual(
    items.map((item) => [item.kind, item.kind === 'tool_call' ? `${item.toolName}:${item.toolKind}` : null]),
    [
      ['thinking', null],
      ['agent_text', null],
      ['tool_call', 'run_shell_command:shell'],
    ],
  );
});

test('a tool result is blocked when this host refused the call, failed on an error, completed otherwise', () => {
  const result = (id: string, error: boolean): JsonObject => ({
    type: 'tool_result',
    tool_use_id: id,
    is_error: error,
    content: 'x',
  });
  const items = fill(
    [
      message({
        type: 'user',
        uuid: 'u1',
        parent_tool_use_id: null,
        message: { content: [result('a', true), result('b', true), result('c', false)] },
      }),
    ],
    ['a'],
  );
  assert.deepEqual(
    items.map((item) => (item.kind === 'tool_result' ? `${item.toolUseId}:${item.status}` : item.kind)),
    ['a:blocked', 'b:failed', 'c:completed'],
  );
});

test("a sub-agent's messages fill no item", () => {
  const items = fill([
    message({
      type: 'assistant',
      uuid: 'a1',
      parent_tool_use_id: 'call_0',
      message: { content: [{ type: 'text', text: 'inside' }] },
    }),
  ]);
  assert.deepEqual(items, []);
});

test("a turn ends completed, interrupted on the CLI's cancellation, or failed with its error", () => {
  const end = (body: JsonObject) => fill([message({ type: 'result', session_id: 's1', ...body })]);
  const [completed] = end({ subtype: 'success', uuid: 'r1', is_error: false });
  const [interrupted] = end({
    subtype: 'error_during_execution',
    uuid: 'r2',
    is_error: true,
    error: { message: 'Operation cancelled.' },
  });
  const [failed] = end({
    subtype: 'error_during_execution',
    uuid: 'r3',
    is_error: true,
    error: { message: '[API Error: 429]' },
  });
  assert.deepEqual(
    [completed, interrupted, failed].map((item) =>
      item?.kind === 'turn' ? [item.itemId, item.status, item.detail] : null,
    ),
    [
      ['r1', 'completed', null],
      ['r2', 'interrupted', 'Operation cancelled.'],
      ['r3', 'failed', '[API Error: 429]'],
    ],
  );
});

test('a retry, a model fallback and an unrecorded chat are warning notices; a declined subtype fills nothing', () => {
  const items = fill([
    message({ type: 'system', subtype: 'retry', uuid: 'n1', data: { attempt: 2, maxRetries: 5 } }),
    message({
      type: 'system',
      subtype: 'model_fallback',
      uuid: 'n2',
      data: { fromModel: 'a', toModel: 'b' },
    }),
    message({ type: 'system', subtype: 'session_recording_degraded', uuid: 'n3', data: {} }),
    message({ type: 'system', subtype: 'ui_log', uuid: 'n4', data: { text: 'x' } }),
  ]);
  assert.deepEqual(
    items.map((item) => (item.kind === 'notice' ? [item.level, item.text] : item.kind)),
    [
      ['warning', 'the model call is retried (attempt 2 of 5)'],
      ['warning', 'the model fell back from a to b'],
      ['warning', 'the CLI could not record the session, so a later resume may find nothing'],
    ],
  );
});
