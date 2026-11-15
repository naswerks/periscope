/**
 * The Claude lift, fact by fact, over messages shaped like the agent's own.
 *
 * These prove what the lift does with a shape it is given. Whether the agent sends that shape is the
 * live probes' claim; the replay over a recorded session (`fact-replay.test.ts`) is the evidence
 * that real messages read the way these do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decode } from '../control/codec.js';
import type { AgentFact, ModelSpendFact } from '../control/frames.js';
import { MAX_FACT_TEXT_LENGTH } from '../control/frames.js';
import { fixedTicker } from '../core/time.js';
import type { SDKMessage } from './agent-process.js';
import { ClaudeFactLift, TASKS_USAGE_PACE_MS, costBasisOf, rolledUpBasis } from './claude-facts.js';

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
    effortReported: true,
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
    cacheReadTokens: 100,
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
  const settledA = only(factsOf(lift, notified('a')), 'tasks');
  assert.deepEqual(
    settledA.map((fact) => fact.running.map((task) => task.taskId)),
    [['a', 'e']],
    'the level still lists a, so the running set did not move; the fact carries only the settlement',
  );
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

test("a compaction's fact says how it came out where its report does, and carries no such member where it does not", () => {
  const ended = { status: 'ended', trigger: null, tokensBefore: null, tokensAfter: null } as const;
  const [failed] = new ClaudeFactLift().fromCompaction({ ...ended, outcome: 'failed' });
  assert.ok(failed?.kind === 'compaction');
  assert.equal(failed.outcome, 'failed');
  const [unstated] = new ClaudeFactLift().fromCompaction(ended);
  assert.ok(unstated?.kind === 'compaction');
  assert.equal(Object.hasOwn(unstated, 'outcome'), false);
  // The member crosses the wire, and a word this host does not declare is not sent.
  const frame = (fact: unknown): string =>
    JSON.stringify({
      frame: 'session',
      sessionId: 's-1',
      seq: 1,
      at: '2000-01-01T00:00:00.000Z',
      payload: { kind: 'session_update', body: { update: 'agent_facts', fact, sourceId: null } },
    });
  const read = decode(frame(failed));
  assert.ok(read.ok, read.ok ? '' : read.refusal.detail);
  assert.match(JSON.stringify(read.ok ? read.value : null), /"outcome":"failed"/);
});

test('a message that carries no fact yields nothing', () => {
  const lifted = new ClaudeFactLift().fromMessage(
    message({ type: 'user', uuid: 'u', message: { content: [] } }),
  );
  assert.deepEqual(lifted, { facts: [], fragments: [] });
});

// ---------------------------------------------------------------------------
// The members protocol 16 adds: settled tasks, cache reads, whether an effort was reported
// ---------------------------------------------------------------------------

const settledOf = (facts: readonly AgentFact[]): unknown[] =>
  only(facts, 'tasks').map((fact) => fact.settled ?? null);

test('a failed task settles with its status and the type it started with; the next turn clears it', () => {
  const lift = new ClaudeFactLift();
  factsOf(lift, init(), started('agent-1', 'local_agent'));
  const failed = message({
    type: 'system',
    subtype: 'task_notification',
    uuid: 'done-agent-1',
    task_id: 'agent-1',
    status: 'failed',
  });
  assert.deepEqual(settledOf(factsOf(lift, failed)), [
    [{ taskId: 'agent-1', type: 'local_agent', status: 'failed' }],
  ]);
  assert.deepEqual(settledOf(factsOf(lift, init({ uuid: 'init-2' }))), [[]], 'the next turn begins');
  assert.deepEqual(settledOf(factsOf(lift, init({ uuid: 'init-3' }))), [], 'nothing settled, nothing said');
});

test('control: a task the lift never saw start settles with no type, and an unknown status settles nothing', () => {
  const lift = new ClaudeFactLift();
  assert.deepEqual(settledOf(factsOf(lift, notified('bash-9'))), [
    [{ taskId: 'bash-9', type: null, status: 'completed' }],
  ]);
  const odd = message({
    type: 'system',
    subtype: 'task_notification',
    uuid: 'x',
    task_id: 'y',
    status: 'paused',
  });
  assert.deepEqual(settledOf(factsOf(lift, odd)), [], 'no word this build does not know is stated');
});

test('a sample states the cache reads the call reported, and null when it reported none', () => {
  const [read] = only(factsOf(new ClaudeFactLift(), assistant('msg-1', callUsage())), 'usage_sample');
  assert.equal(read?.cacheReadTokens, 100);
  const [none] = only(
    factsOf(new ClaudeFactLift(), assistant('msg-2', callUsage({ cache_read_input_tokens: undefined }))),
    'usage_sample',
  );
  assert.equal(none?.cacheReadTokens, null);
});

test('effortReported tells an init that stated no effort from one that carried none at all', () => {
  const stated = only(factsOf(new ClaudeFactLift(), init({ effort: null })), 'agent_receipt')[0];
  assert.equal(stated?.effort, null);
  assert.equal(stated?.effortReported, true, 'the init said no effort will be sent');
  const silent = init();
  delete (silent as unknown as Record<string, unknown>)['effort'];
  const absent = only(factsOf(new ClaudeFactLift(), silent), 'agent_receipt')[0];
  assert.equal(absent?.effort, null);
  assert.equal(absent?.effortReported, false, 'the init carried no effort: its null says nothing');
});

// ---------------------------------------------------------------------------
// what a task reported of itself
// ---------------------------------------------------------------------------

const progressed = (taskId: string, over: Record<string, unknown> = {}): SDKMessage =>
  message({
    type: 'system',
    subtype: 'task_progress',
    uuid: `progress-${taskId}`,
    task_id: taskId,
    description: `task ${taskId}`,
    usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4500 },
    ...over,
  });

const lastRunning = (facts: readonly AgentFact[]): readonly unknown[] =>
  only(facts, 'tasks').at(-1)?.running ?? [];

test('a running task carries the call that started it, and its latest summary and usage as the task messages report them', () => {
  const ticker = fixedTicker(0);
  const lift = new ClaudeFactLift({ ticker });
  factsOf(lift, started('agent-1', 'local_agent', { tool_use_id: 'toolu_task' }));
  const first = factsOf(lift, progressed('agent-1', { summary: 'reading the store' }));
  assert.deepEqual(lastRunning(first), [
    {
      taskId: 'agent-1',
      type: 'local_agent',
      description: 'task agent-1',
      toolUseId: 'toolu_task',
      summary: 'reading the store',
      usage: { tokens: 1200, toolUses: 3, durationMs: 4500 },
    },
  ]);
  // The next progress message arrives after the pace, so its figures are sent with it.
  ticker.advance(TASKS_USAGE_PACE_MS);
  const later = factsOf(
    lift,
    progressed('agent-1', { usage: { total_tokens: 2400, tool_uses: 5, duration_ms: 9000 } }),
  );
  assert.deepEqual(
    lastRunning(later),
    [
      {
        taskId: 'agent-1',
        type: 'local_agent',
        description: 'task agent-1',
        toolUseId: 'toolu_task',
        summary: 'reading the store',
        usage: { tokens: 2400, toolUses: 5, durationMs: 9000 },
      },
    ],
    'a progress message with no summary keeps the last one, and its usage replaces the last',
  );
});

test('a settled task carries what its notification reported: the call, the summary, the usage and the output file', () => {
  const lift = new ClaudeFactLift();
  factsOf(lift, init(), started('agent-1', 'local_agent', { tool_use_id: 'toolu_task' }));
  const done = message({
    type: 'system',
    subtype: 'task_notification',
    uuid: 'done-agent-1',
    task_id: 'agent-1',
    tool_use_id: 'toolu_task',
    status: 'completed',
    summary: 'mapped the store',
    output_file: '/tmp/tasks/agent-1.output',
    usage: { total_tokens: 3000, tool_uses: 7, duration_ms: 12000 },
  });
  assert.deepEqual(settledOf(factsOf(lift, done)), [
    [
      {
        taskId: 'agent-1',
        type: 'local_agent',
        status: 'completed',
        toolUseId: 'toolu_task',
        summary: 'mapped the store',
        usage: { tokens: 3000, toolUses: 7, durationMs: 12000 },
        outputFile: '/tmp/tasks/agent-1.output',
      },
    ],
  ]);
});

test('control: a member no task message carried is absent, never guessed, and a usage that is not three whole counts is not kept', () => {
  const lift = new ClaudeFactLift();
  const listed = factsOf(lift, level([{ task_id: 'bash-1', task_type: 'local_bash', description: 'suite' }]));
  assert.deepEqual(lastRunning(listed), [{ taskId: 'bash-1', type: 'local_bash', description: 'suite' }]);
  const partial = factsOf(lift, progressed('bash-1', { usage: { total_tokens: 10, tool_uses: 1 } }));
  assert.deepEqual(
    only(partial, 'tasks'),
    [],
    'a usage missing a count states nothing, and a tasks fact that states nothing new is not sent',
  );
});

test('every text a task entry carries is cut at its bound, the description among them', () => {
  const long = 'x'.repeat(MAX_FACT_TEXT_LENGTH + 10);
  const lift = new ClaudeFactLift();
  factsOf(lift, started('agent-1', 'local_agent', { description: long }));
  const [entry] = lastRunning(factsOf(lift, progressed('agent-1', { summary: long }))) as {
    description: string;
    summary: string;
  }[];
  assert.equal(entry?.description.length, MAX_FACT_TEXT_LENGTH);
  assert.equal(entry?.summary.length, MAX_FACT_TEXT_LENGTH);
  const done = message({
    type: 'system',
    subtype: 'task_notification',
    uuid: 'done-agent-1',
    task_id: 'agent-1',
    status: 'completed',
    summary: long,
    output_file: long,
  });
  const [settled] = (settledOf(factsOf(lift, done))[0] ?? []) as { summary: string; outputFile: string }[];
  assert.equal(settled?.summary.length, MAX_FACT_TEXT_LENGTH);
  assert.equal(settled?.outputFile.length, MAX_FACT_TEXT_LENGTH);
});

// ---------------------------------------------------------------------------
// how often the tasks fact is sent, and how large it may grow
// ---------------------------------------------------------------------------

const usageOf = (tokens: number): Record<string, number> => ({
  total_tokens: tokens,
  tool_uses: 1,
  duration_ms: tokens,
});

/** The tokens each tasks fact in `facts` states for its first running task. */
const tokensSent = (facts: readonly AgentFact[]): (number | null | undefined)[] =>
  only(facts, 'tasks').map((fact) => fact.running[0]?.usage?.tokens);

test('a change in usage alone is held to the pace: several inside it send at most one tasks fact', () => {
  const lift = new ClaudeFactLift();
  factsOf(lift, started('agent-1', 'local_agent', { tool_use_id: 'toolu_task' }));
  const ticks = factsOf(
    lift,
    progressed('agent-1', { usage: usageOf(100) }),
    progressed('agent-1', { usage: usageOf(200) }),
    progressed('agent-1', { usage: usageOf(300) }),
  );
  assert.ok(
    only(ticks, 'tasks').length <= 1,
    `three usage-only messages inside the pace sent ${only(ticks, 'tasks').length} tasks facts`,
  );
});

test('held usage goes out with the first message after the pace, whatever that message is, and carries the latest figures', () => {
  const ticker = fixedTicker(0);
  const lift = new ClaudeFactLift({ ticker });
  factsOf(lift, started('agent-1', 'local_agent'));
  ticker.advance(1_000);
  assert.deepEqual(tokensSent(factsOf(lift, progressed('agent-1', { usage: usageOf(100) }))), []);
  ticker.advance(1_000);
  assert.deepEqual(tokensSent(factsOf(lift, progressed('agent-1', { usage: usageOf(200) }))), []);
  // A message that is no task message at all, still inside the pace: nothing yet.
  ticker.advance(1_000);
  assert.deepEqual(tokensSent(factsOf(lift, assistant('msg-1', callUsage()))), []);
  // The pace has passed since the task started: the next message of any kind carries the held figures.
  ticker.advance(TASKS_USAGE_PACE_MS - 3_000);
  assert.deepEqual(tokensSent(factsOf(lift, assistant('msg-2', callUsage()))), [200]);
  // Nothing is held now, so another message says nothing about tasks.
  ticker.advance(TASKS_USAGE_PACE_MS);
  assert.deepEqual(tokensSent(factsOf(lift, assistant('msg-3', callUsage()))), []);
});

test('control: a usage that moves long after the last tasks fact is sent at once', () => {
  const ticker = fixedTicker(0);
  const lift = new ClaudeFactLift({ ticker });
  factsOf(lift, started('agent-1', 'local_agent'));
  ticker.advance(TASKS_USAGE_PACE_MS);
  assert.deepEqual(tokensSent(factsOf(lift, progressed('agent-1', { usage: usageOf(100) }))), [100]);
  // And the one right behind it waits its turn.
  assert.deepEqual(tokensSent(factsOf(lift, progressed('agent-1', { usage: usageOf(200) }))), []);
});

test('a start, a finish and a changed summary are sent at once inside the pace, each with the latest usage', () => {
  const ticker = fixedTicker(0);
  const lift = new ClaudeFactLift({ ticker });
  factsOf(lift, init(), started('agent-1', 'local_agent'));
  factsOf(lift, progressed('agent-1', { usage: usageOf(100) }));
  // A changed summary, with usage that had been held behind it.
  assert.deepEqual(
    tokensSent(factsOf(lift, progressed('agent-1', { summary: 'reading the store', usage: usageOf(150) }))),
    [150],
  );
  factsOf(lift, progressed('agent-1', { usage: usageOf(175) }));
  // Another task starts: the list changed, and the first task's held figures ride along.
  assert.deepEqual(tokensSent(factsOf(lift, started('agent-2', 'local_agent'))), [175]);
  // The finish carries the last figures, whatever was held.
  factsOf(lift, progressed('agent-1', { usage: usageOf(190) }));
  const done = message({
    type: 'system',
    subtype: 'task_notification',
    uuid: 'done-agent-1',
    task_id: 'agent-1',
    status: 'completed',
    usage: usageOf(200),
  });
  const finished = only(factsOf(lift, done), 'tasks');
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.settled?.[0]?.usage?.tokens, 200);
});

test("the turn's result carries whatever usage was held, so the last figures of a task that outlives the turn arrive", () => {
  const ticker = fixedTicker(0);
  const lift = new ClaudeFactLift({ ticker });
  factsOf(lift, level([{ task_id: 'bash-1', task_type: 'local_bash', description: 'suite' }]));
  assert.deepEqual(tokensSent(factsOf(lift, progressed('bash-1', { usage: usageOf(100) }))), []);
  assert.deepEqual(tokensSent(factsOf(lift, result())), [100]);
  // Control: with nothing held and nothing changed, a result says nothing about tasks.
  assert.deepEqual(tokensSent(factsOf(lift, result({ uuid: 'result-2' }))), []);
});

test('a tasks fact always fits a frame: two hundred settled tasks with full-length summaries still decode', () => {
  const lift = new ClaudeFactLift();
  factsOf(lift, init());
  let last: AgentFact | undefined;
  for (let index = 0; index < 200; index += 1) {
    const done = message({
      type: 'system',
      subtype: 'task_notification',
      uuid: `done-${index}`,
      task_id: `agent-${index}`,
      tool_use_id: `toolu_${index}`,
      status: 'completed',
      summary: 'x'.repeat(MAX_FACT_TEXT_LENGTH),
      output_file: `/tmp/tasks/agent-${index}.output`,
    });
    last = only(factsOf(lift, done), 'tasks').at(-1) ?? last;
  }
  assert.ok(last !== undefined, 'no tasks fact was sent, so there is nothing to measure');
  const decoded = decode(
    JSON.stringify({
      frame: 'session',
      sessionId: 's-1',
      seq: 1,
      at: '2000-01-01T00:00:00.000Z',
      payload: { kind: 'session_update', body: { update: 'agent_facts', fact: last, sourceId: null } },
    }),
  );
  assert.ok(decoded.ok, decoded.ok ? '' : `${decoded.refusal.reason}: ${decoded.refusal.detail}`);
});
