import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentFact, JsonObject } from '../control/frames.js';
import { QwenFactLift, qwenFactSourceId } from './qwen-facts.js';
import type { QwenMessage } from './qwen-wire.js';

const message = (body: JsonObject): QwenMessage => ({ kind: 'message', message: body });
const answer = (subtype: string, response: JsonObject, request: JsonObject = {}): QwenMessage => ({
  kind: 'answer',
  subtype,
  request,
  response,
});
const init = (overrides: JsonObject = {}): QwenMessage =>
  message({
    type: 'system',
    subtype: 'init',
    uuid: 's1',
    session_id: 's1',
    model: 'qwen3-coder-plus',
    permission_mode: 'default',
    mcp_servers: [{ name: 'nas', status: 'connected' }],
    qwen_code_version: '0.25.1',
    tools: [],
    ...overrides,
  });
const result = (usage: JsonObject, extra: JsonObject = {}): QwenMessage =>
  message({
    type: 'result',
    subtype: 'success',
    uuid: 'r1',
    session_id: 's1',
    is_error: false,
    duration_ms: 1200,
    num_turns: 2,
    usage,
    ...extra,
  });

function facts(lift: QwenFactLift, messages: readonly QwenMessage[]): AgentFact[] {
  return messages.flatMap((one) => [...lift.fromMessage(one).facts]);
}

const of = <K extends AgentFact['kind']>(list: readonly AgentFact[], kind: K) =>
  list.filter((fact): fact is Extract<AgentFact, { kind: K }> => fact.kind === kind);

test("the session handle is the initialize answer's id, and an init names a new one only when the id changed", () => {
  const lift = new QwenFactLift();
  const list = facts(lift, [
    answer('initialize', { session_id: 's1' }),
    init(),
    init(),
    init({ session_id: 's2' }),
  ]);
  assert.deepEqual(
    of(list, 'session_handle').map((fact) => fact.handle),
    ['s1', 's2'],
  );
});

test("the hand-over receipt goes out at initialize, from this host, with the skills handed over; the CLI's own waits for its skill list", () => {
  const lift = new QwenFactLift({
    handedOverSkills: ['review'],
    startModel: 'qwen3-coder-plus',
    startMode: 'default',
  });
  const opening = of(
    facts(lift, [answer('initialize', { session_id: 's1', effort_status: { effort: 'high' } })]),
    'agent_receipt',
  );
  assert.equal(opening.length, 1);
  assert.equal(opening[0]?.source, 'host');
  assert.deepEqual(opening[0]?.skills, ['review']);
  assert.equal(opening[0]?.model, 'qwen3-coder-plus');
  assert.equal(opening[0]?.permissionMode, 'default');
  assert.equal(opening[0]?.effort, 'high');
  assert.equal(opening[0]?.effortReported, true);
  // An init before the CLI listed its skills sends no receipt of the CLI's own.
  assert.deepEqual(of(facts(lift, [init()]), 'agent_receipt'), []);
  const listed = of(
    facts(lift, [answer('get_context_usage', { skills: [{ name: 'review' }, { name: 'bundled' }] })]),
    'agent_receipt',
  );
  assert.equal(listed[0]?.source, 'runtime');
  assert.deepEqual(listed[0]?.skills, ['review', 'bundled']);
  assert.equal(listed[0]?.runtimeVersion, '0.25.1');
  assert.deepEqual(listed[0]?.mcpServers, [{ name: 'nas', status: 'connected' }]);
  // Nothing moved: nothing is sent.
  assert.deepEqual(of(facts(lift, [init()]), 'agent_receipt'), []);
  // A widened mode on a later init is the CLI's own word, sent as such.
  const moved = of(facts(lift, [init({ permission_mode: 'plan' })]), 'agent_receipt');
  assert.equal(moved[0]?.permissionMode, 'plan');
  assert.equal(moved[0]?.source, 'runtime');
});

test("a result's usage is the session's running total: totals carry it, turn and turnScope are null, and no cost is invented", () => {
  const lift = new QwenFactLift({ startModel: 'qwen3-coder-plus' });
  const [record] = of(
    facts(lift, [
      result({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 300, total_tokens: 1200 }),
    ]),
    'turn_record',
  );
  assert.deepEqual(record, {
    kind: 'turn_record',
    runtime: 'qwen-code',
    totals: {
      cost: null,
      currency: null,
      costBasis: 'unreported',
      byModel: [
        {
          model: 'qwen3-coder-plus',
          canonicalModel: null,
          provider: null,
          inputTokens: 700,
          outputTokens: 200,
          cacheReadTokens: 300,
          cacheWriteTokens: 0,
          reasoningTokens: null,
          cost: null,
          costBasis: 'unreported',
          contextWindow: null,
        },
      ],
    },
    turn: null,
    turnScope: null,
    numTurns: 2,
    durationMs: 1200,
    sourceSessionId: 's1',
  });
});

test("control: each result's totals are its own figure, never a sum, and a result with no model named carries none", () => {
  const lift = new QwenFactLift({ startModel: 'm' });
  const records = of(
    facts(lift, [
      result({ input_tokens: 100, output_tokens: 10 }),
      result({ input_tokens: 250, output_tokens: 30, cache_read_input_tokens: 50 }),
    ]),
    'turn_record',
  );
  assert.deepEqual(
    records.map((record) => [
      record.totals?.byModel[0]?.inputTokens,
      record.totals?.byModel[0]?.outputTokens,
    ]),
    [
      [100, 10],
      [200, 30],
    ],
  );
  const unnamed = of(
    facts(new QwenFactLift(), [result({ input_tokens: 1, output_tokens: 1 })]),
    'turn_record',
  );
  assert.equal(unnamed[0]?.totals, null);
  assert.equal(unnamed[0]?.turn, null);
  assert.equal(unnamed[0]?.turnScope, null);
});

test("the model register follows the assistant's model and a fallback, and each context-usage answer is a usage sample", () => {
  const lift = new QwenFactLift({ startModel: 'm1' });
  facts(lift, [
    message({
      type: 'assistant',
      uuid: 'a1',
      parent_tool_use_id: null,
      message: {
        model: 'm2',
        content: [],
        usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 4 },
      },
    }),
  ]);
  const [sample] = of(
    facts(lift, [answer('get_context_usage', { totalTokens: 1234, contextWindowSize: 200000 })]),
    'usage_sample',
  );
  assert.deepEqual(sample, {
    kind: 'usage_sample',
    runtime: 'qwen-code',
    model: 'm2',
    contextTokens: 1234,
    contextWindow: 200000,
    cacheTtl: null,
    mainThread: true,
    cacheReadTokens: 4,
  });
  facts(lift, [
    message({
      type: 'system',
      subtype: 'model_fallback',
      uuid: 'f',
      data: { fromModel: 'm2', toModel: 'm3' },
    }),
  ]);
  const [record] = of(facts(lift, [result({ input_tokens: 1, output_tokens: 1 })]), 'turn_record');
  assert.equal(record?.totals?.byModel[0]?.model, 'm3');
});

test('a task starts running, settles by its status (cancelled reads as stopped), and the settled list clears at the next turn', () => {
  const lift = new QwenFactLift();
  const system = (subtype: string, data: JsonObject): QwenMessage =>
    message({ type: 'system', subtype, uuid: `${subtype}-1`, data });
  const list = of(
    facts(lift, [
      system('task_started', { task_id: 't1', description: 'watch the build' }),
      system('task_started', { task_id: 't2', description: 'poll' }),
      system('task_notification', { task_id: 't1', status: 'completed' }),
      system('task_notification', { task_id: 't2', status: 'cancelled' }),
      init(),
    ]),
    'tasks',
  );
  assert.deepEqual(
    list.map((fact) => [
      fact.running.map((task) => task.taskId),
      (fact.settled ?? []).map((task) => `${task.taskId}:${task.status}`),
    ]),
    [
      [['t1'], []],
      [['t1', 't2'], []],
      [['t2'], ['t1:completed']],
      [[], ['t1:completed', 't2:stopped']],
      [[], []],
    ],
  );
});

test("content-block deltas are fragments: text, thinking and a tool's input; a sub-agent's names its call", () => {
  const lift = new QwenFactLift();
  const delta = (body: JsonObject, parent: string | null = null) =>
    lift.fromMessage(
      message({
        type: 'stream_event',
        uuid: 'e',
        parent_tool_use_id: parent,
        event: { type: 'content_block_delta', index: 0, delta: body },
      }),
    ).fragments;
  assert.deepEqual(
    [
      ...delta({ type: 'text_delta', text: 'hi' }),
      ...delta({ type: 'thinking_delta', thinking: 'hm' }),
      ...delta({ type: 'input_json_delta', partial_json: '{"a":1}' }, 'call_9'),
    ].map((fragment) => [fragment.channel, fragment.text, fragment.parentId]),
    [
      ['text', 'hi', null],
      ['thinking', 'hm', null],
      ['tool_input', '{"a":1}', 'call_9'],
    ],
  );
  assert.deepEqual(delta({ type: 'text_delta', text: '' }), []);
});

test('a setter the CLI applied is a receipt from this host', () => {
  const lift = new QwenFactLift({ startModel: 'm1', startMode: 'default' });
  facts(lift, [answer('initialize', { session_id: 's1' })]);
  const list = of(
    facts(lift, [
      answer('set_model', { subtype: 'set_model', model: 'm2' }, { model: 'm2' }),
      answer('set_permission_mode', { status: 'updated', mode: 'plan' }, { mode: 'plan' }),
      answer('set_effort', { subtype: 'set_effort', effort: 'max' }, { effort: 'max' }),
    ]),
    'agent_receipt',
  );
  assert.deepEqual(
    list.map((receipt) => [receipt.source, receipt.model, receipt.permissionMode, receipt.effort]),
    [
      ['host', 'm2', 'default', null],
      ['host', 'm2', 'plan', null],
      ['host', 'm2', 'plan', 'max'],
    ],
  );
});

test("a fact names its message's own uuid, never the init's, which is the session id, and never an answer's", () => {
  assert.equal(qwenFactSourceId(result({ input_tokens: 1, output_tokens: 1 })), 'r1');
  assert.equal(qwenFactSourceId(init()), null);
  assert.equal(qwenFactSourceId(answer('initialize', { session_id: 's1' })), null);
  assert.equal(qwenFactSourceId({ kind: 'prompt', text: 'p' }), null);
});
