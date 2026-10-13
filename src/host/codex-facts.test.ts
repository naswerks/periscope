import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentFact, JsonObject } from '../control/frames.js';
import { CodexFactLift, codexFactSourceId } from './codex-facts.js';
import type { CodexMessage } from './codex-wire.js';

const THREAD = 'thread-1';
const answer = (method: string, result: JsonObject, params: JsonObject = {}): CodexMessage => ({
  kind: 'answer',
  method,
  params,
  result,
});
const notification = (method: string, params: JsonObject): CodexMessage => ({
  kind: 'notification',
  method,
  params,
});

/** A lift that has read a session's opening, and the facts the opening yielded. */
function openedLift(): { lift: CodexFactLift; facts: AgentFact[] } {
  const lift = new CodexFactLift();
  const facts: AgentFact[] = [];
  for (const message of [
    answer('initialize', {
      userAgent: 'periscope/0.162.1 (Windows 10; x86_64) test (periscope; 1.7.0)',
      codexHome: 'C:/h',
    }),
    answer('thread/start', {
      thread: { id: THREAD, cliVersion: '0.162.1' },
      model: 'gpt-6-sol',
      cwd: 'C:/w',
      approvalPolicy: 'on-request',
      reasoningEffort: 'medium',
    }),
    answer('skills/list', {
      data: [{ cwd: 'C:/w', skills: [{ name: 'example:review' }, { name: 'example:build' }], errors: [] }],
    }),
    answer('mcpServerStatus/list', {
      data: [{ name: 'docs', runtimeStatus: 'connected' }],
      nextCursor: null,
    }),
  ]) {
    facts.push(...lift.fromMessage(message).facts);
  }
  return { lift, facts };
}

const usage = (
  turnId: string,
  total: JsonObject,
  last: JsonObject,
  window: number | null = 272000,
  threadId = THREAD,
): CodexMessage =>
  notification('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: { total, last, modelContextWindow: window },
  });

const counts = (input: number, cached: number, output: number, reasoning: number, write = 0): JsonObject => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: write,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
});

test('the opening yields one handle and one receipt, the receipt only once every opening answer is in', () => {
  const lift = new CodexFactLift();
  const handle = lift.fromMessage(
    answer('thread/start', {
      thread: { id: THREAD },
      model: 'gpt-6-sol',
      approvalPolicy: 'never',
      reasoningEffort: null,
    }),
  );
  assert.deepEqual(handle.facts, [{ kind: 'session_handle', runtime: 'codex', handle: THREAD }]);
  const { facts } = openedLift();
  assert.deepEqual(facts, [
    { kind: 'session_handle', runtime: 'codex', handle: THREAD },
    {
      kind: 'agent_receipt',
      runtime: 'codex',
      runtimeVersion: '0.162.1',
      model: 'gpt-6-sol',
      permissionMode: 'on-request',
      effort: 'medium',
      skills: ['example:review', 'example:build'],
      plugins: null,
      pluginErrors: [],
      mcpServers: [{ name: 'docs', status: 'connected' }],
      source: 'runtime',
    },
  ]);
});

test('a turn record carries the running total as Codex reported it, turn and turnScope null, uncached input only', () => {
  const { lift } = openedLift();
  assert.deepEqual(
    lift.fromMessage(usage('turn-1', counts(1000, 600, 50, 20, 7), counts(1000, 600, 50, 20))).facts,
    [
      {
        kind: 'usage_sample',
        runtime: 'codex',
        model: 'gpt-6-sol',
        contextTokens: 1050,
        contextWindow: 272000,
        cacheTtl: null,
        mainThread: true,
      },
    ],
  );
  const record = lift.fromMessage(
    notification('turn/completed', {
      threadId: THREAD,
      turn: { id: 'turn-1', status: 'completed', durationMs: 4200 },
    }),
  ).facts;
  assert.deepEqual(record, [
    {
      kind: 'turn_record',
      runtime: 'codex',
      totals: {
        cost: null,
        currency: null,
        costBasis: 'unreported',
        byModel: [
          {
            model: 'gpt-6-sol',
            canonicalModel: null,
            provider: null,
            inputTokens: 400,
            outputTokens: 50,
            cacheReadTokens: 600,
            cacheWriteTokens: 7,
            reasoningTokens: 20,
            cost: null,
            costBasis: 'unreported',
            contextWindow: 272000,
          },
        ],
      },
      turn: null,
      turnScope: null,
      numTurns: null,
      durationMs: 4200,
      sourceSessionId: THREAD,
    },
  ]);
});

test('the newest usage for a turn is its total; a turn with none reported records no totals', () => {
  const { lift } = openedLift();
  lift.fromMessage(usage('turn-2', counts(100, 0, 10, 0), counts(100, 0, 10, 0)));
  lift.fromMessage(usage('turn-2', counts(300, 100, 30, 0), counts(200, 100, 20, 0)));
  const done = lift.fromMessage(
    notification('turn/completed', { threadId: THREAD, turn: { id: 'turn-2', status: 'completed' } }),
  );
  const record = done.facts[0];
  assert.equal(record?.kind, 'turn_record');
  assert.equal(record?.kind === 'turn_record' ? record.totals?.byModel[0]?.inputTokens : null, 200);
  const none = lift.fromMessage(
    notification('turn/completed', { threadId: THREAD, turn: { id: 'turn-3', status: 'interrupted' } }),
  );
  assert.equal(none.facts[0]?.kind === 'turn_record' ? none.facts[0].totals : 'missing', null);
});

test('control: uncached input is floored at zero, never negative, and the window may be unknown', () => {
  const { lift } = openedLift();
  lift.fromMessage(usage('turn-4', counts(10, 50, 1, 0), counts(10, 50, 1, 0), null));
  const record = lift.fromMessage(
    notification('turn/completed', { threadId: THREAD, turn: { id: 'turn-4', status: 'completed' } }),
  ).facts[0];
  const row = record?.kind === 'turn_record' ? record.totals?.byModel[0] : undefined;
  assert.equal(row?.inputTokens, 0);
  assert.equal(row?.contextWindow, null);
});

test("a sub-agent's usage is sampled as not the main thread, and never becomes the session's turn total", () => {
  const { lift } = openedLift();
  const sample = lift.fromMessage(usage('turn-9', counts(5, 0, 1, 0), counts(5, 0, 1, 0), 1000, 'thread-sub'))
    .facts[0];
  assert.equal(sample?.kind === 'usage_sample' ? sample.mainThread : null, false);
  const record = lift.fromMessage(
    notification('turn/completed', { threadId: THREAD, turn: { id: 'turn-9', status: 'completed' } }),
  ).facts[0];
  assert.equal(record?.kind === 'turn_record' ? record.totals : 'missing', null);
});

test('the model register moves with a turn the host started on another model, and with a reroute', () => {
  const { lift } = openedLift();
  const applied = lift.fromMessage(
    answer('turn/start', { turn: { id: 'turn-5' } }, { threadId: THREAD, model: 'gpt-6-luna' }),
  ).facts;
  assert.equal(applied.length, 1);
  assert.equal(
    applied[0]?.kind === 'agent_receipt' ? `${applied[0].source}:${applied[0].model}` : null,
    'host:gpt-6-luna',
  );
  const rerouted = lift.fromMessage(
    notification('model/rerouted', {
      threadId: THREAD,
      turnId: 'turn-5',
      fromModel: 'gpt-6-luna',
      toModel: 'gpt-5.5',
      reason: 'x',
    }),
  ).facts;
  assert.equal(
    rerouted[0]?.kind === 'agent_receipt' ? `${rerouted[0].source}:${rerouted[0].model}` : null,
    'runtime:gpt-5.5',
  );
  const sample = lift.fromMessage(usage('turn-5', counts(1, 0, 1, 0), counts(1, 0, 1, 0))).facts[0];
  assert.equal(sample?.kind === 'usage_sample' ? sample.model : null, 'gpt-5.5');
  assert.deepEqual(
    lift.fromMessage(answer('turn/start', { turn: { id: 'turn-6' } }, { threadId: THREAD })).facts,
    [],
    'a turn with no setter is no receipt',
  );
});

test('an MCP server whose status changes sends the receipt again; an unchanged one sends nothing', () => {
  const { lift } = openedLift();
  const changed = lift.fromMessage(
    notification('mcpServer/startupStatus/updated', {
      threadId: null,
      name: 'docs',
      status: 'failed',
      error: 'x',
    }),
  ).facts;
  assert.equal(
    changed[0]?.kind === 'agent_receipt' ? JSON.stringify(changed[0].mcpServers) : null,
    '[{"name":"docs","status":"failed"}]',
  );
  assert.deepEqual(
    lift.fromMessage(
      notification('mcpServer/startupStatus/updated', {
        threadId: null,
        name: 'docs',
        status: 'failed',
        error: 'x',
      }),
    ).facts,
    [],
  );
});

test('the running tasks: spawned sub-agents join, a closed or settled one leaves, each change the whole set', () => {
  const { lift } = openedLift();
  const item = (extra: JsonObject): CodexMessage =>
    notification('item/completed', {
      threadId: THREAD,
      turnId: 't',
      item: { type: 'collabAgentToolCall', id: 'call-1', ...extra },
    });
  const spawned = lift.fromMessage(
    item({
      tool: 'spawnAgent',
      receiverThreadIds: ['agent-a', 'agent-b'],
      prompt: 'Review it.',
      agentsStates: {},
    }),
  ).facts;
  assert.deepEqual(spawned, [
    {
      kind: 'tasks',
      runtime: 'codex',
      running: [
        { taskId: 'agent-a', type: 'subagent', description: 'Review it.' },
        { taskId: 'agent-b', type: 'subagent', description: 'Review it.' },
      ],
    },
  ]);
  const settled = lift.fromMessage(
    item({
      tool: 'wait',
      receiverThreadIds: [],
      agentsStates: { 'agent-a': { status: 'completed', message: null } },
    }),
  ).facts;
  assert.deepEqual(settled[0]?.kind === 'tasks' ? settled[0].running.map((task) => task.taskId) : null, [
    'agent-b',
  ]);
  const closed = lift.fromMessage(
    item({ tool: 'closeAgent', receiverThreadIds: ['agent-b'], agentsStates: {} }),
  ).facts;
  assert.deepEqual(closed[0]?.kind === 'tasks' ? closed[0].running : null, []);
  const activity = lift.fromMessage(
    notification('item/completed', {
      threadId: THREAD,
      turnId: 't',
      item: {
        type: 'subAgentActivity',
        id: 'act-1',
        kind: 'started',
        agentThreadId: 'agent-c',
        agentPath: '/',
      },
    }),
  ).facts;
  assert.deepEqual(activity[0]?.kind === 'tasks' ? activity[0].running.map((task) => task.taskId) : null, [
    'agent-c',
  ]);
  const message = item({ tool: 'closeAgent', receiverThreadIds: ['agent-c'], agentsStates: {} });
  const fact = lift.fromMessage(message).facts[0];
  assert.ok(fact !== undefined);
  assert.equal(codexFactSourceId(message, fact), 'call-1', 'a tasks fact names the item it was lifted from');
});

test('fragments: text and thinking deltas, parentless on the main thread, naming the spawning call for a sub-agent', () => {
  const { lift } = openedLift();
  const delta = (method: string, threadId: string): readonly unknown[] =>
    lift.fromMessage(notification(method, { threadId, turnId: 't', itemId: 'item-9', delta: 'Hel' }))
      .fragments;
  assert.deepEqual(delta('item/agentMessage/delta', THREAD), [
    { update: 'agent_fragment', runtime: 'codex', channel: 'text', text: 'Hel', parentId: null },
  ]);
  assert.deepEqual(delta('item/reasoning/summaryTextDelta', THREAD), [
    { update: 'agent_fragment', runtime: 'codex', channel: 'thinking', text: 'Hel', parentId: null },
  ]);
  assert.deepEqual(
    delta('item/reasoning/textDelta', 'agent-x'),
    [{ update: 'agent_fragment', runtime: 'codex', channel: 'thinking', text: 'Hel', parentId: null }],
    'a sub-agent no call is known to have spawned gets no parent, never an invented one',
  );
  lift.fromMessage(
    notification('item/started', {
      threadId: THREAD,
      turnId: 't',
      item: { type: 'collabAgentToolCall', id: 'call-7', tool: 'spawnAgent', receiverThreadIds: ['agent-y'] },
    }),
  );
  assert.deepEqual(delta('item/agentMessage/delta', 'agent-y'), [
    { update: 'agent_fragment', runtime: 'codex', channel: 'text', text: 'Hel', parentId: 'call-7' },
  ]);
});

test('a turn record names the turn as its source; a sample and a receipt name none', () => {
  const message = notification('turn/completed', {
    threadId: THREAD,
    turn: { id: 'turn-1', status: 'completed' },
  });
  assert.equal(codexFactSourceId(message, { kind: 'turn_record' } as AgentFact), 'turn-1');
  assert.equal(codexFactSourceId(message, { kind: 'usage_sample' } as AgentFact), null);
  assert.equal(codexFactSourceId(answer('thread/start', {}), { kind: 'agent_receipt' } as AgentFact), null);
});

test('a compaction report becomes a compaction fact with no figures Codex did not report', () => {
  assert.deepEqual(
    new CodexFactLift().fromCompaction({
      status: 'started',
      trigger: 'auto',
      tokensBefore: null,
      tokensAfter: null,
      sourceId: 'item-c',
    }),
    [
      {
        kind: 'compaction',
        runtime: 'codex',
        status: 'started',
        trigger: 'auto',
        tokensBefore: null,
        tokensAfter: null,
      },
    ],
  );
});
