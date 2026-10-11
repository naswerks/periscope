/**
 * The Claude lift, fact by fact, over messages shaped like the agent's own.
 *
 * These prove what the lift does with a shape it is given. Whether the agent sends that shape is the
 * live probes' claim; the replay over a recorded session (`fact-replay.test.ts`) is the evidence
 * that real messages read the way these do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentFact, ModelSpendFact } from '../control/frames.js';
import type { SDKMessage } from './agent-process.js';
import { ClaudeFactLift, costBasisOf, rolledUpBasis } from './claude-facts.js';

/** The SDK's shapes carry many fields the lift never reads; only the read ones are supplied. */
const message = (shape: Record<string, unknown>): SDKMessage => shape as unknown as SDKMessage;

const init = (over: Record<string, unknown> = {}): SDKMessage =>
  message({
    type: 'system',
    subtype: 'init',
    uuid: 'init-1',
    session_id: 'agent-session-1',
    claude_code_version: '2.1.284',
    model: 'claude-opus-5[1m]',
    cwd: '/work',
    tools: [],
    mcp_servers: [{ name: 'docs', status: 'connected' }],
    permissionMode: 'bypassPermissions',
    apiKeySource: 'none',
    skills: ['skill-one'],
    plugins: [{ name: 'plugin-one', path: '/plugins/one', version: '1.0.0' }],
    ...over,
  });

const modelUsage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  inputTokens: 28,
  outputTokens: 33957,
  cacheReadInputTokens: 1435200,
  cacheCreationInputTokens: 133244,
  webSearchRequests: 0,
  costUSD: 6.3,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  ...over,
});

const result = (over: Record<string, unknown> = {}): SDKMessage =>
  message({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    session_id: 'agent-session-1',
    num_turns: 4,
    duration_ms: 41250,
    total_cost_usd: 6.3,
    usage: {
      input_tokens: 2,
      output_tokens: 1743,
      cache_read_input_tokens: 132488,
      cache_creation_input_tokens: 756,
    },
    modelUsage: { 'claude-opus-5[1m]': modelUsage() },
    ...over,
  });

const assistant = (
  id: string | null,
  usage: Record<string, unknown>,
  over: Record<string, unknown> = {},
): SDKMessage =>
  message({
    type: 'assistant',
    uuid: `assistant-${id ?? 'none'}`,
    parent_tool_use_id: null,
    message: { ...(id === null ? {} : { id }), model: 'claude-opus-5', usage },
    ...over,
  });

const callUsage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  input_tokens: 2,
  output_tokens: 1,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 36375,
  cache_creation: { ephemeral_1h_input_tokens: 36375, ephemeral_5m_input_tokens: 0 },
  ...over,
});

function factsOf(lift: ClaudeFactLift, ...messages: SDKMessage[]): AgentFact[] {
  return messages.flatMap((one) => [...lift.fromMessage(one).facts]);
}

function only<K extends AgentFact['kind']>(
  facts: readonly AgentFact[],
  kind: K,
): Extract<AgentFact, { kind: K }>[] {
  return facts.filter((fact): fact is Extract<AgentFact, { kind: K }> => fact.kind === kind);
}

// ---------------------------------------------------------------------------
// session_handle and agent_receipt
// ---------------------------------------------------------------------------

test('an init yields the handle and the receipt, in that order, from what the agent stated', () => {
  const facts = factsOf(new ClaudeFactLift(), init({ effort: 'high' }));
  assert.deepEqual(
    facts.map((fact) => fact.kind),
    ['session_handle', 'agent_receipt'],
  );
  assert.deepEqual(facts[0], { kind: 'session_handle', runtime: 'claude', handle: 'agent-session-1' });
  assert.deepEqual(facts[1], {
    kind: 'agent_receipt',
    runtime: 'claude',
    runtimeVersion: '2.1.284',
    model: 'claude-opus-5[1m]',
    permissionMode: 'bypassPermissions',
    effort: 'high',
    skills: ['skill-one'],
    plugins: [{ name: 'plugin-one', version: '1.0.0', path: '/plugins/one' }],
    pluginErrors: null,
    mcpServers: [{ name: 'docs', status: 'connected' }],
    source: 'runtime',
  });
});

test('an absent effort and an absent plugin_errors are null, never inferred and never an empty list', () => {
  const [, receipt] = factsOf(new ClaudeFactLift(), init({ effort: null }));
  assert.equal(receipt?.kind, 'agent_receipt');
  assert.equal(receipt?.kind === 'agent_receipt' ? receipt.effort : 'x', null);
  assert.equal(receipt?.kind === 'agent_receipt' ? receipt.pluginErrors : 'x', null);

  const [, withErrors] = factsOf(
    new ClaudeFactLift(),
    init({ plugin_errors: [{ plugin: 'p@market', type: 'path-not-found', message: 'missing' }] }),
  );
  assert.deepEqual(withErrors?.kind === 'agent_receipt' ? withErrors.pluginErrors : null, [
    { plugin: 'p@market', type: 'path-not-found', message: 'missing', path: null },
  ]);
});

test('control: an identical re-sent init reports nothing, and one changed field reports exactly one receipt', () => {
  const lift = new ClaudeFactLift();
  factsOf(lift, init());
  assert.deepEqual(factsOf(lift, init({ uuid: 'init-2' })), [], 'the CLI re-sends its init each turn');

  const changed = factsOf(lift, init({ uuid: 'init-3', permissionMode: 'plan' }));
  assert.deepEqual(
    changed.map((fact) => fact.kind),
    ['agent_receipt'],
    'the handle did not move, the receipt did',
  );
});

test('a resume or a fork that reports a new id reports a new handle', () => {
  const lift = new ClaudeFactLift();
  factsOf(lift, init());
  const facts = factsOf(lift, init({ session_id: 'agent-session-2' }));
  assert.deepEqual(only(facts, 'session_handle'), [
    { kind: 'session_handle', runtime: 'claude', handle: 'agent-session-2' },
  ]);
});

// ---------------------------------------------------------------------------
// turn_record
// ---------------------------------------------------------------------------

test('regression: the totals are the running total the result reports, never summed from its rows', () => {
  // A total no sum of the rows produces, and a turn whose tokens no difference of totals produces.
  const lift = new ClaudeFactLift();
  factsOf(lift, init());
  const [record] = only(
    factsOf(
      lift,
      result({
        total_cost_usd: 13.579,
        modelUsage: {
          'claude-opus-5[1m]': modelUsage({ costUSD: 7 }),
          'model-two': modelUsage({ costUSD: 1 }),
        },
      }),
    ),
    'turn_record',
  );
  assert.equal(record?.totals?.cost, 13.579, 'the agent total, not 7 + 1');
  assert.equal(record?.totals?.currency, 'USD');
  assert.deepEqual(
    record?.totals?.byModel.map((row) => [row.model, row.cost]),
    [
      ['claude-opus-5[1m]', 7],
      ['model-two', 1],
    ],
  );
  assert.deepEqual(record?.turn?.byModel[0], {
    model: 'claude-opus-5[1m]',
    canonicalModel: null,
    provider: null,
    inputTokens: 2,
    outputTokens: 1743,
    cacheReadTokens: 132488,
    cacheWriteTokens: 756,
    reasoningTokens: null,
    cost: null,
    costBasis: 'unreported',
    contextWindow: null,
  });
  assert.equal(record?.turn?.cost, null, 'Claude prices the session, not the turn');
  assert.equal(record?.turnScope, 'turn');
  assert.equal(record?.numTurns, 4);
  assert.equal(record?.durationMs, 41250);
  assert.equal(record?.sourceSessionId, 'agent-session-1');
});

test('a row carries its figures as reported: uncached input, cache reads and writes, thinking as reasoning', () => {
  const lift = new ClaudeFactLift();
  const [record] = only(
    factsOf(
      lift,
      result({
        modelUsage: {
          'claude-opus-5[1m]': modelUsage({
            thinkingTokens: 812,
            canonicalModel: 'claude-opus-5',
            provider: 'firstParty',
          }),
        },
      }),
    ),
    'turn_record',
  );
  assert.deepEqual(record?.totals?.byModel[0], {
    model: 'claude-opus-5[1m]',
    canonicalModel: 'claude-opus-5',
    provider: 'firstParty',
    inputTokens: 28,
    outputTokens: 33957,
    cacheReadTokens: 1435200,
    cacheWriteTokens: 133244,
    reasoningTokens: 812,
    cost: 6.3,
    costBasis: 'list',
    contextWindow: 1_000_000,
  });
});

test('control: a result with no modelUsage has no rows, never invented ones; with rows it has them', () => {
  const lift = new ClaudeFactLift();
  const [bare] = only(factsOf(lift, result({ modelUsage: undefined })), 'turn_record');
  assert.deepEqual(bare?.totals?.byModel, [], 'nothing is synthesised from the turn usage');
  assert.equal(bare?.totals?.costBasis, 'list', 'no rows reads as the SDK says an absent basis reads');

  const [rows] = only(factsOf(lift, result()), 'turn_record');
  assert.equal(rows?.totals?.byModel.length, 1);
});

test('the turn is null, and its scope with it, until an init names the model it is filed under', () => {
  const [before] = only(factsOf(new ClaudeFactLift(), result()), 'turn_record');
  assert.equal(before?.turn, null);
  assert.equal(before?.turnScope, null, 'turnScope is null exactly when turn is');

  const lift = new ClaudeFactLift();
  factsOf(lift, init());
  const [after] = only(factsOf(lift, result()), 'turn_record');
  assert.equal(after?.turnScope, 'turn');
});

test('control: a result with no usage gives a null turn and a null scope; with usage, the turn and its scope', () => {
  const lift = new ClaudeFactLift();
  factsOf(lift, init());
  const [without] = only(factsOf(lift, result({ usage: undefined })), 'turn_record');
  assert.deepEqual([without?.turn, without?.turnScope], [null, null]);
  const [withUsage] = only(factsOf(lift, result()), 'turn_record');
  assert.equal(withUsage?.turnScope, 'turn');
  assert.notEqual(withUsage?.turn, null);
});

test('control: Claude\'s "unknown" basis is "guessed"; "list" and "managed" are themselves; absent is "list"', () => {
  assert.equal(costBasisOf('unknown'), 'guessed');
  assert.equal(costBasisOf('list'), 'list');
  assert.equal(costBasisOf('managed'), 'managed');
  assert.equal(costBasisOf(undefined), 'list');
  assert.equal(costBasisOf(null), 'list');
  assert.equal(
    costBasisOf('a-word-from-a-later-sdk'),
    'guessed',
    'a basis it cannot name is never a list price',
  );

  const [record] = only(
    factsOf(new ClaudeFactLift(), result({ modelUsage: { m: modelUsage({ costBasis: 'unknown' }) } })),
    'turn_record',
  );
  assert.equal(record?.totals?.byModel[0]?.costBasis, 'guessed');
});

test("control: the figure's basis is the weakest row's; one guessed row among list rows makes it guessed", () => {
  const row = (costBasis: ModelSpendFact['costBasis']): ModelSpendFact => ({
    model: 'm',
    canonicalModel: null,
    provider: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: null,
    cost: 0,
    costBasis,
    contextWindow: null,
  });
  assert.equal(rolledUpBasis([row('list'), row('guessed'), row('list')]), 'guessed');
  assert.equal(rolledUpBasis([row('list'), row('managed')]), 'managed');
  assert.equal(rolledUpBasis([row('list'), row('list')]), 'list');
  assert.equal(rolledUpBasis([]), 'list');

  const [record] = only(
    factsOf(
      new ClaudeFactLift(),
      result({ modelUsage: { a: modelUsage(), b: modelUsage({ costBasis: 'unknown' }), c: modelUsage() } }),
    ),
    'turn_record',
  );
  assert.equal(record?.totals?.costBasis, 'guessed');
  assert.deepEqual(
    record?.totals?.byModel.map((one) => one.costBasis),
    ['list', 'guessed', 'list'],
    'each row keeps its own',
  );
});

// ---------------------------------------------------------------------------
// usage_sample
// ---------------------------------------------------------------------------

test('a main-thread call is sampled with its context, its cache lifetime and no window before a result', () => {
  const [sample] = only(factsOf(new ClaudeFactLift(), assistant('msg-1', callUsage())), 'usage_sample');
  assert.deepEqual(sample, {
    kind: 'usage_sample',
    runtime: 'claude',
    model: 'claude-opus-5',
    contextTokens: 2 + 100 + 36375,
    contextWindow: null,
    cacheTtl: '1h',
    mainThread: true,
  });
});

test('control: a subagent call is not sampled; the same call on the main thread is', () => {
  const sub = factsOf(
    new ClaudeFactLift(),
    assistant('msg-1', callUsage(), { parent_tool_use_id: 'toolu_1' }),
  );
  assert.deepEqual(only(sub, 'usage_sample'), [], "a subagent's context is its own");
  const main = factsOf(new ClaudeFactLift(), assistant('msg-1', callUsage()));
  assert.equal(only(main, 'usage_sample').length, 1);
});

test('control: two frames of one API call give one sample; two calls with identical figures give two', () => {
  const lift = new ClaudeFactLift();
  const oneCall = factsOf(lift, assistant('msg-1', callUsage()), assistant('msg-1', callUsage()));
  assert.equal(only(oneCall, 'usage_sample').length, 1, "a call's later frames report nothing");

  const twoCalls = factsOf(
    new ClaudeFactLift(),
    assistant('msg-1', callUsage()),
    assistant('msg-2', callUsage()),
  );
  assert.equal(only(twoCalls, 'usage_sample').length, 2, 'identical figures from two calls are two calls');
});

test('control: a frame with no message id is sampled only when its figures differ from the last sample', () => {
  const lift = new ClaudeFactLift();
  const same = factsOf(lift, assistant(null, callUsage()), assistant(null, callUsage()));
  assert.equal(only(same, 'usage_sample').length, 1);
  const moved = factsOf(lift, assistant(null, callUsage({ input_tokens: 3 })));
  assert.equal(only(moved, 'usage_sample').length, 1);
});

test("the window is the latest result's row naming the call's model: exact, then without the selector, then canonical", () => {
  const lift = new ClaudeFactLift();
  factsOf(lift, result({ modelUsage: { 'claude-opus-5[1m]': modelUsage({ contextWindow: 1_000_000 }) } }));
  const [selector] = only(factsOf(lift, assistant('msg-1', callUsage())), 'usage_sample');
  assert.equal(selector?.contextWindow, 1_000_000, 'the key without its bracketed selector names the model');

  factsOf(
    lift,
    result({
      uuid: 'result-2',
      modelUsage: {
        'claude-opus-5': modelUsage({ contextWindow: 200_000 }),
        'claude-opus-5[1m]': modelUsage({ contextWindow: 1_000_000 }),
      },
    }),
  );
  const [exact] = only(factsOf(lift, assistant('msg-2', callUsage())), 'usage_sample');
  assert.equal(exact?.contextWindow, 200_000, 'an exact key wins over a selector match');

  factsOf(
    lift,
    result({ uuid: 'result-3', modelUsage: { alias: modelUsage({ canonicalModel: 'claude-opus-5' }) } }),
  );
  const [canonical] = only(factsOf(lift, assistant('msg-3', callUsage())), 'usage_sample');
  assert.equal(canonical?.contextWindow, 1_000_000, 'the canonical model names it last');
});

test('the cache lifetime is the hour when any hour-long tokens were written, else five minutes, else none', () => {
  const ttl = (creation: Record<string, unknown>): unknown =>
    only(
      factsOf(new ClaudeFactLift(), assistant('m', callUsage({ cache_creation: creation }))),
      'usage_sample',
    )[0]?.cacheTtl;
  assert.equal(ttl({ ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 5 }), '1h');
  assert.equal(ttl({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 5 }), '5m');
  assert.equal(ttl({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }), null);
});

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

const level = (tasks: Record<string, unknown>[], uuid = 'level-1'): SDKMessage =>
  message({ type: 'system', subtype: 'background_tasks_changed', uuid, tasks });
const started = (taskId: string, taskType: string, over: Record<string, unknown> = {}): SDKMessage =>
  message({
    type: 'system',
    subtype: 'task_started',
    uuid: `started-${taskId}`,
    task_id: taskId,
    task_type: taskType,
    description: `task ${taskId}`,
    ...over,
  });
const notified = (taskId: string): SDKMessage =>
  message({
    type: 'system',
    subtype: 'task_notification',
    uuid: `done-${taskId}`,
    task_id: taskId,
    status: 'completed',
  });

const running = (facts: readonly AgentFact[]): string[][] =>
  only(facts, 'tasks').map((fact) => fact.running.map((task) => task.taskId));

test('a level replaces the running set with its non-ambient entries', () => {
  const lift = new ClaudeFactLift();
  const facts = factsOf(
    lift,
    level([
      { task_id: 'a', task_type: 'local_bash', description: 'a' },
      { task_id: 'b', task_type: 'local_agent', description: 'b', ambient: true },
    ]),
    level([{ task_id: 'c', task_type: 'local_bash', description: 'c' }], 'level-2'),
  );
  assert.deepEqual(running(facts), [['a'], ['c']]);
});

test('control: a non-ambient subagent start adds an edge; any other start adds nothing', () => {
  const lift = new ClaudeFactLift();
  assert.deepEqual(running(factsOf(lift, started('bash-1', 'local_bash'))), [], 'not a subagent');
  assert.deepEqual(
    running(factsOf(lift, started('agent-1', 'local_agent', { ambient: true }))),
    [],
    'ambient',
  );
  assert.deepEqual(running(factsOf(lift, started('agent-2', 'local_agent'))), [['agent-2']]);
  assert.deepEqual(running(factsOf(lift, started('agent-2', 'local_agent'))), [], 'an id already present');
});

test('control: a notification removes its edge and never a level entry', () => {
  const lift = new ClaudeFactLift();
  factsOf(
    lift,
    level([{ task_id: 'a', task_type: 'local_agent', description: 'a' }]),
    started('e', 'local_agent'),
  );
  assert.deepEqual(running(factsOf(lift, notified('a'))), [], 'the level still lists a, so nothing moved');
  assert.deepEqual(running(factsOf(lift, notified('e'))), [['a']], 'the edge went');
});

test('control: a result clears every edge, and the level stays', () => {
  const lift = new ClaudeFactLift();
  factsOf(
    lift,
    level([{ task_id: 'a', task_type: 'local_bash', description: 'a' }]),
    started('e', 'local_agent'),
  );
  assert.deepEqual(running(factsOf(lift, result())), [['a']]);
  assert.deepEqual(
    running(factsOf(new ClaudeFactLift(), result())),
    [],
    'nothing was running, nothing moved',
  );
});

test('the running set is the level, then each edge the level lacks, by id', () => {
  const lift = new ClaudeFactLift();
  factsOf(lift, started('x', 'local_agent'), started('y', 'local_agent'));
  const facts = factsOf(
    lift,
    level([{ task_id: 'y', task_type: 'local_agent', description: 'y from the level' }]),
  );
  assert.deepEqual(only(facts, 'tasks')[0]?.running, [
    { taskId: 'y', type: 'local_agent', description: 'y from the level' },
    { taskId: 'x', type: 'local_agent', description: 'task x' },
  ]);
});

// ---------------------------------------------------------------------------
// fragments and compaction
// ---------------------------------------------------------------------------

const streamed = (event: Record<string, unknown>, parent: string | null = null): SDKMessage =>
  message({ type: 'stream_event', uuid: 'delta-1', parent_tool_use_id: parent, event });

test('control: each content delta is one fragment on its channel; every other stream event is none', () => {
  const lift = new ClaudeFactLift();
  const fragment = (event: Record<string, unknown>, parent: string | null = null): unknown[] => [
    ...lift.fromMessage(streamed(event, parent)).fragments,
  ];
  assert.deepEqual(fragment({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }), [
    { update: 'agent_fragment', runtime: 'claude', channel: 'text', text: 'Hel', parentId: null },
  ]);
  assert.deepEqual(
    fragment({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } }),
    [{ update: 'agent_fragment', runtime: 'claude', channel: 'thinking', text: '', parentId: null }],
  );
  assert.deepEqual(
    fragment(
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a' } },
      'toolu_1',
    ),
    [
      {
        update: 'agent_fragment',
        runtime: 'claude',
        channel: 'tool_input',
        text: '{"a',
        parentId: 'toolu_1',
      },
    ],
  );
  assert.deepEqual(fragment({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }), []);
  assert.deepEqual(
    fragment({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 's' } }),
    [],
  );
  assert.deepEqual(fragment({ type: 'content_block_start', index: 0 }), []);
});

test('a compaction report becomes a compaction fact, figures as reported', () => {
  const facts = new ClaudeFactLift().fromCompaction({
    status: 'ended',
    trigger: 'auto',
    tokensBefore: 180000,
    tokensAfter: 21000,
  });
  assert.deepEqual(facts, [
    {
      kind: 'compaction',
      runtime: 'claude',
      status: 'ended',
      trigger: 'auto',
      tokensBefore: 180000,
      tokensAfter: 21000,
    },
  ]);
});

test('a message that carries no fact yields nothing', () => {
  const lifted = new ClaudeFactLift().fromMessage(
    message({ type: 'user', uuid: 'u', message: { content: [] } }),
  );
  assert.deepEqual(lifted, { facts: [], fragments: [] });
});
