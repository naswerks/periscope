/**
 * The pi fill: a run is the conversation's turn, every message pi ends is its items, every tool's end is
 * its result (blocked when this host's gate refused the call), and what pi says beside the run is a
 * notice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentItem, JsonObject } from '../control/frames.js';
import { PiItemFill } from './pi-items.js';
import type { PiMessage } from './pi-wire.js';

const event = (body: JsonObject): PiMessage => ({ kind: 'event', event: body });

function fill(fill: PiItemFill, messages: readonly PiMessage[]): AgentItem[] {
  return messages.flatMap((message) => [...fill.fromMessage(message)]);
}

const assistant = (content: JsonObject[], extra: JsonObject = {}): PiMessage =>
  event({
    type: 'message_end',
    message: { role: 'assistant', content, model: 'm', provider: 'p', stopReason: 'stop', ...extra },
  });

test("a run is one turn, its prompt the user's text and its answer's blocks the agent's text, thinking and tool calls, read by pi's tool kinds", () => {
  const items = fill(new PiItemFill('session-1'), [
    event({ type: 'agent_start' }),
    event({ type: 'turn_start' }),
    event({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'list the files' }] },
    }),
    assistant([
      { type: 'thinking', thinking: 'ls is enough' },
      { type: 'text', text: 'Listing.' },
      { type: 'toolCall', id: 'call_1', name: 'ls', arguments: { path: '.' } },
    ]),
    event({ type: 'turn_end' }),
    event({ type: 'agent_settled', aborted: false }),
  ]);
  assert.deepEqual(
    items.map((item) => item.kind),
    ['turn', 'user_text', 'thinking', 'agent_text', 'tool_call', 'turn'],
  );
  assert.deepEqual(items[1], {
    kind: 'user_text',
    itemId: 'session-1:prompt:1',
    turnId: null,
    text: 'list the files',
    truncated: false,
  });
  const call = items[4];
  assert.equal(
    call?.kind === 'tool_call' ? [call.toolUseId, call.toolKind].join('/') : '',
    'call_1/file_read',
  );
  assert.equal(items[3]?.kind === 'agent_text' ? items[3].final : 'unset', null, 'pi marks no answer');
  assert.deepEqual(
    items.filter((item) => item.kind === 'turn').map((item) => (item.kind === 'turn' ? item.status : '')),
    ['started', 'completed'],
  );
});

test('a tool result is blocked when the gate refused the call, failed on an error, and completed otherwise, with the duration pi measured', () => {
  const items = new PiItemFill('session-1');
  items.gateBlocked('call_1');
  const results = fill(items, [
    event({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'bash',
      isError: true,
      result: { content: [{ type: 'text', text: 'not that' }] },
    }),
    event({
      type: 'tool_execution_end',
      toolCallId: 'call_2',
      toolName: 'bash',
      isError: true,
      result: { content: [{ type: 'text', text: 'exit 1' }] },
      durationMs: 12,
    }),
    event({
      type: 'tool_execution_end',
      toolCallId: 'call_3',
      toolName: 'read',
      isError: false,
      result: { content: [{ type: 'text', text: 'ok' }] },
      durationMs: 3.6,
    }),
    event({
      type: 'tool_execution_end',
      toolCallId: 'call_4/1',
      parentToolCallId: 'call_4',
      toolName: 'read',
      isError: false,
      result: {},
    }),
  ]);
  assert.deepEqual(
    results.map((item) =>
      item.kind === 'tool_result' ? [item.toolUseId, item.status, item.output, item.durationMs] : [],
    ),
    [
      ['call_1', 'blocked', 'not that', null],
      ['call_2', 'failed', 'exit 1', 12],
      ['call_3', 'completed', 'ok', 3],
    ],
  );
});

test('a run that was aborted ended interrupted, and one whose answer stopped on an error ended failed with it', () => {
  const aborted = fill(new PiItemFill('s'), [
    event({ type: 'agent_start' }),
    event({ type: 'agent_settled', aborted: true }),
  ]);
  assert.equal(aborted[1]?.kind === 'turn' ? aborted[1].status : '', 'interrupted');
  const failed = fill(new PiItemFill('s'), [
    event({ type: 'agent_start' }),
    assistant([], { stopReason: 'error', errorMessage: '401: invalid api key' }),
    event({ type: 'agent_settled', aborted: false }),
  ]);
  const end = failed.at(-1);
  assert.deepEqual(end?.kind === 'turn' ? [end.status, end.detail] : [], ['failed', '401: invalid api key']);
});

test("what pi says beside the run is a notice: its retries, a failed compaction, an extension's error and notification, and a prompt it would not take", () => {
  const items = fill(new PiItemFill('s'), [
    event({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: 'overloaded' }),
    event({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'overloaded' }),
    event({
      type: 'summarization_retry_scheduled',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 10,
      errorMessage: 'x',
    }),
    event({
      type: 'compaction_end',
      reason: 'threshold',
      aborted: false,
      willRetry: false,
      errorMessage: 'too big',
    }),
    {
      kind: 'record',
      record: { type: 'extension_error', extensionPath: '/e.js', event: 'turn_start', error: 'boom' },
    },
    {
      kind: 'record',
      record: {
        type: 'extension_ui_request',
        id: 'u1',
        method: 'notify',
        message: 'nas needs a sign-in',
        notifyType: 'warning',
      },
    },
    {
      kind: 'record',
      record: { type: 'extension_ui_request', id: 'u2', method: 'confirm', title: 'x', message: 'y' },
    },
    {
      kind: 'response',
      command: 'prompt',
      request: {},
      response: {
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'No API key found for openrouter.',
      },
    },
  ]);
  assert.deepEqual(
    items.map((item) => (item.kind === 'notice' ? `${item.level}: ${item.text}` : item.kind)),
    [
      'warning: the model call is retried (attempt 1 of 3): overloaded',
      "error: the model call's retries ran out after attempt 3: overloaded",
      "warning: a summary's model call is retried (attempt 1 of 2): x",
      'warning: the compaction failed: too big',
      'error: the extension /e.js failed on turn_start: boom',
      'warning: nas needs a sign-in',
      'error: pi did not take the prompt: No API key found for openrouter.',
    ],
  );
});
