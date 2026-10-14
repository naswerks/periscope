import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject } from '../control/frames.js';
import type { Refusal } from '../core/refusal.js';
import { drain, fakeChild, spawnerFor } from '../test-support/fake-child.js';
import type { QwenControlAnswer } from './qwen-control.js';
import { QwenControl } from './qwen-control.js';

function started(
  onControlRequest?: (
    subtype: string,
    request: JsonObject,
    id: string,
    signal: AbortSignal,
  ) => Promise<QwenControlAnswer>,
) {
  const child = fakeChild();
  const messages: JsonObject[] = [];
  const refusals: Refusal[] = [];
  const result = QwenControl.start({
    command: 'node',
    args: ['cli.js'],
    cwd: 'C:/w',
    env: {},
    spawn: spawnerFor(child),
    closeGraceMs: 10,
    killTree: () => Promise.resolve(),
    onMessage: (message) => messages.push(message),
    onControlRequest: onControlRequest ?? (() => Promise.resolve({ error: 'unhandled' })),
    onRefusal: (refused) => refusals.push(refused),
  });
  assert.ok(result.ok);
  return { control: result.value, child, messages, refusals };
}

test("a request carries its own id and resolves with its answer's response; an error answer is a named refusal", async () => {
  const run = started();
  const asked = run.control.request('set_model', { model: 'm' }, 1_000);
  const sent = run.child.received[0];
  assert.equal(sent?.['type'], 'control_request');
  assert.deepEqual(sent?.['request'], { model: 'm', subtype: 'set_model' });
  run.child.send({
    type: 'control_response',
    response: { subtype: 'success', request_id: sent?.['request_id'] ?? '', response: { model: 'm' } },
  });
  assert.deepEqual(await asked, { ok: true, value: { model: 'm' } });
  const failing = run.control.request('set_permission_mode', { mode: 'x' }, 1_000);
  run.child.send({
    type: 'control_response',
    response: {
      subtype: 'error',
      request_id: run.child.received[1]?.['request_id'] ?? '',
      error: 'Invalid permission mode: x',
    },
  });
  const refused = await failing;
  assert.equal(refused.ok, false);
  assert.match(
    refused.ok ? '' : refused.refusal.detail,
    /set_permission_mode answered with an error: Invalid permission mode: x/,
  );
  await run.control.close();
});

test('a request with no answer by its deadline is refused rpc-request-timed-out, and a close refuses what is still waiting', async () => {
  const run = started();
  const late = await run.control.request('get_context_usage', {}, 10);
  assert.equal(late.ok ? null : late.refusal.reason, 'rpc-request-timed-out');
  const waiting = run.control.request('interrupt', {}, 10_000);
  await run.control.close();
  const closed = await waiting;
  assert.equal(closed.ok ? null : closed.refusal.reason, 'rpc-request-failed');
});

test('every request from the CLI is answered: a response, an error, and a handler that throws answered with an error', async () => {
  const run = started((subtype) => {
    if (subtype === 'can_use_tool') return Promise.resolve({ response: { behavior: 'deny', message: 'no' } });
    if (subtype === 'mcp_message') return Promise.resolve({ error: 'no in-process server' });
    return Promise.reject(new Error('broken'));
  });
  for (const [id, subtype] of [
    ['1', 'can_use_tool'],
    ['2', 'mcp_message'],
    ['3', 'other'],
  ] as const) {
    run.child.send({ type: 'control_request', request_id: id, request: { subtype } });
  }
  await drain();
  assert.deepEqual(run.child.received, [
    {
      type: 'control_response',
      response: { subtype: 'success', request_id: '1', response: { behavior: 'deny', message: 'no' } },
    },
    {
      type: 'control_response',
      response: { subtype: 'error', request_id: '2', error: 'no in-process server' },
    },
    {
      type: 'control_response',
      response: { subtype: 'error', request_id: '3', error: 'the host failed to answer: broken' },
    },
  ]);
  await run.control.close();
});

test('a cancel the CLI sends aborts the handler of its request', async () => {
  let aborted = false;
  // The handler settles only when it is aborted, so the cancel always finds it running: a handler that
  // settled on a timer would race the cancel on a busy machine.
  const run = started(
    (_subtype, _request, _id, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ response: { behavior: 'deny', message: 'late' } });
        });
      }),
  );
  run.child.send({ type: 'control_request', request_id: '9', request: { subtype: 'can_use_tool' } });
  await drain();
  run.child.send({ type: 'control_cancel_request', request_id: '9' });
  await drain();
  assert.equal(aborted, true);
  await run.control.close();
});

test('a stream message is handed on; a line with no type, or a response naming no request, is named and dropped', async () => {
  const run = started();
  run.child.send({ type: 'assistant', message: { content: [] } });
  run.child.send({ no: 'type' });
  run.child.send({ type: 'control_response', response: { subtype: 'success' } });
  await drain();
  assert.deepEqual(run.messages, [{ type: 'assistant', message: { content: [] } }]);
  assert.deepEqual(
    run.refusals.map((one) => one.reason),
    ['rpc-line-malformed', 'rpc-line-malformed'],
  );
  assert.equal(run.control.sendUser('hello'), true);
  assert.deepEqual(run.child.received.at(-1), { type: 'user', message: { role: 'user', content: 'hello' } });
  await run.control.close();
});
