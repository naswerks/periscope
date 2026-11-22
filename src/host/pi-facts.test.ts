/**
 * The pi lift: the session's handle and receipt from pi's own state, its spend as pi states it (never a
 * figure computed here), its context, its fragments and its compactions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decode } from '../control/codec.js';
import type { AgentFact, JsonObject } from '../control/frames.js';
import { PI_PINNED_VERSION } from './pi-binary.js';
import { PiFactLift } from './pi-facts.js';
import type { PiHello } from './pi-extension.js';
import type { PiHostCommand, PiMessage } from './pi-wire.js';

const answer = (command: PiHostCommand, data: JsonObject, request: JsonObject = {}): PiMessage => ({
  kind: 'response',
  command,
  request,
  response: { id: 'periscope-1', type: 'response', command, success: true, data },
});

const event = (body: JsonObject): PiMessage => ({ kind: 'event', event: body });

const hello: PiHello = {
  reason: 'startup',
  tools: [
    { name: 'read', source: 'builtin', path: 'builtin:read' },
    { name: 'mcp__nas__seat_read', source: 'builtin', path: 'builtin:mcp' },
  ],
  commands: [],
  servers: [
    { name: 'nas', extensionPath: '/x/pi-extension.js' },
    { name: 'slow', extensionPath: '/x/pi-extension.js' },
  ],
  truncated: false,
};

const STATE = {
  sessionId: 'pi-session-1',
  sessionFile: '/base/sessions/s.jsonl',
  model: { provider: 'openrouter', id: 'deepseek/deepseek-chat', contextWindow: 128_000 },
  thinkingLevel: 'medium',
  isStreaming: false,
};

const COMMANDS = {
  commands: [
    { name: 'periscope', source: 'extension', sourceInfo: { path: '/x/pi-extension.js', source: 'cli' } },
    {
      name: 'skill:code-review',
      source: 'skill',
      sourceInfo: { path: '/p/skills/code-review/SKILL.md', source: 'local' },
    },
  ],
};

const stats = (input: number, cost: number): JsonObject => ({
  sessionId: 'pi-session-1',
  tokens: { input, output: 40, cacheRead: 300, cacheWrite: 25, total: input + 365 },
  cost,
  contextUsage: { tokens: 2_000, contextWindow: 128_000, percent: 1.5 },
});

function opened(): { lift: PiFactLift; facts: AgentFact[] } {
  const lift = new PiFactLift();
  const facts: AgentFact[] = [];
  for (const message of [
    { kind: 'hello', hello } satisfies PiMessage,
    answer('get_commands', COMMANDS),
    answer('get_state', STATE),
  ]) {
    facts.push(...lift.fromMessage(message).facts);
  }
  return { lift, facts };
}

test("the open yields the session's handle and pi's own receipt: its model, thinking level, skills and servers, and no permission mode", () => {
  const { facts } = opened();
  assert.deepEqual(facts, [
    { kind: 'session_handle', runtime: 'pi', handle: 'pi-session-1' },
    {
      kind: 'agent_receipt',
      runtime: 'pi',
      runtimeVersion: PI_PINNED_VERSION,
      model: 'deepseek/deepseek-chat',
      permissionMode: null,
      effort: 'medium',
      skills: ['code-review'],
      plugins: null,
      pluginErrors: null,
      mcpServers: [
        { name: 'nas', status: 'connected' },
        { name: 'slow', status: 'pending' },
      ],
      source: 'runtime',
      effortReported: true,
    },
  ]);
});

test("each run's totals are pi's own figures as it states them: catalogue-estimated, in US dollars, uncached input as pi counts it, turn and turnScope null", () => {
  const { lift } = opened();
  lift.fromMessage(
    event({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        model: 'deepseek/deepseek-chat',
        provider: 'openrouter',
        usage: { input: 1, output: 1, cacheRead: 77, cacheWrite: 0 },
      },
    }),
  );
  const first = lift.fromMessage(answer('get_session_stats', stats(1_000, 0.0042))).facts;
  assert.deepEqual(first, [
    {
      kind: 'turn_record',
      runtime: 'pi',
      totals: {
        cost: 0.0042,
        currency: 'USD',
        costBasis: 'catalogue-estimated',
        byModel: [
          {
            model: 'deepseek/deepseek-chat',
            canonicalModel: null,
            provider: 'openrouter',
            inputTokens: 1_000,
            outputTokens: 40,
            cacheReadTokens: 300,
            cacheWriteTokens: 25,
            reasoningTokens: null,
            cost: 0.0042,
            costBasis: 'catalogue-estimated',
            contextWindow: 128_000,
          },
        ],
      },
      turn: null,
      turnScope: null,
      numTurns: null,
      durationMs: null,
      sourceSessionId: 'pi-session-1',
    },
    {
      kind: 'usage_sample',
      runtime: 'pi',
      model: 'deepseek/deepseek-chat',
      contextTokens: 2_000,
      contextWindow: 128_000,
      cacheTtl: null,
      mainThread: true,
      cacheReadTokens: 77,
    },
  ]);
});

test('control: two runs each carry their own figure, never a sum or a difference of the two', () => {
  const { lift } = opened();
  const totals = [stats(1_000, 0.004), stats(2_500, 0.01)].map((one) => {
    const record = lift.fromMessage(answer('get_session_stats', one)).facts[0];
    assert.equal(record?.kind, 'turn_record');
    return record?.kind === 'turn_record' ? record.totals : null;
  });
  assert.deepEqual(
    totals.map((one) => [one?.cost, one?.byModel[0]?.inputTokens]),
    [
      [0.004, 1_000],
      [0.01, 2_500],
    ],
  );
});

test("a model this host set is said in a receipt composed by this host; a thinking level pi moved is said in pi's own", () => {
  const { lift } = opened();
  const set = lift.fromMessage(
    answer(
      'set_model',
      { provider: 'anthropic', id: 'claude-example' },
      { provider: 'anthropic', modelId: 'claude-example' },
    ),
  ).facts;
  assert.equal(set.length, 1);
  assert.equal(
    set[0]?.kind === 'agent_receipt' ? [set[0].model, set[0].source].join('/') : '',
    'claude-example/host',
  );
  const moved = lift.fromMessage(event({ type: 'thinking_level_changed', level: 'high' })).facts;
  assert.equal(
    moved[0]?.kind === 'agent_receipt' ? [moved[0].effort, moved[0].source].join('/') : '',
    'high/runtime',
  );
  assert.deepEqual(
    lift.fromMessage(event({ type: 'thinking_level_changed', level: 'high' })).facts,
    [],
    'a receipt with nothing moved was sent',
  );
});

test('no receipt before the session opens, and no totals with no model to file them under', () => {
  const lift = new PiFactLift();
  assert.deepEqual(lift.fromMessage(event({ type: 'thinking_level_changed', level: 'high' })).facts, []);
  const record = lift.fromMessage(answer('get_session_stats', stats(10, 0))).facts[0];
  assert.equal(record?.kind === 'turn_record' ? record.totals : 'none', null);
});

test("each streamed delta is a fragment: text, thinking and a piece of a tool call's input; nothing else is", () => {
  const lift = new PiFactLift();
  const fragments = ['text_delta', 'thinking_delta', 'toolcall_delta', 'text_end', 'done'].flatMap(
    (type) =>
      lift.fromMessage(event({ type: 'message_update', assistantMessageEvent: { type, delta: 'x' } }))
        .fragments,
  );
  assert.deepEqual(
    fragments.map((one) => one.channel),
    ['text', 'thinking', 'tool_input'],
  );
  assert.ok(fragments.every((one) => one.runtime === 'pi' && one.parentId === null));
});

test('a compaction the observer reports is a compaction fact, as reported', () => {
  assert.deepEqual(
    new PiFactLift().fromCompaction({
      status: 'ended',
      trigger: 'auto',
      tokensBefore: 90_000,
      tokensAfter: null,
    }),
    [
      {
        kind: 'compaction',
        runtime: 'pi',
        status: 'ended',
        trigger: 'auto',
        tokensBefore: 90_000,
        tokensAfter: null,
      },
    ],
  );
});

/** An assistant answer's `message_end`, as pi 1.5.2 writes it, its usage carrying the call's cost. */
const assistantEnd = (usage: JsonObject | undefined, role = 'assistant'): PiMessage =>
  event({
    type: 'message_end',
    message: {
      role,
      content: [],
      model: 'deepseek/deepseek-chat',
      provider: 'openrouter',
      ...(usage === undefined ? {} : { usage }),
    },
  });

const CALL_USAGE = {
  input: 120,
  output: 30,
  cacheRead: 64,
  cacheWrite: 8,
  totalTokens: 222,
  cost: { input: 0.0001, output: 0.0002, cacheRead: 0.00001, cacheWrite: 0.00002, total: 0.00033 },
};

test("each assistant message's usage is that model call's step figure: its tokens and pi's cost for it, catalogue-estimated, totals null", () => {
  const { lift } = opened();
  assert.deepEqual(lift.fromMessage(assistantEnd(CALL_USAGE)).facts, [
    {
      kind: 'turn_record',
      runtime: 'pi',
      totals: null,
      turn: {
        cost: 0.00033,
        currency: 'USD',
        costBasis: 'catalogue-estimated',
        byModel: [
          {
            model: 'deepseek/deepseek-chat',
            canonicalModel: null,
            provider: 'openrouter',
            inputTokens: 120,
            outputTokens: 30,
            cacheReadTokens: 64,
            cacheWriteTokens: 8,
            reasoningTokens: null,
            cost: 0.00033,
            costBasis: 'catalogue-estimated',
            contextWindow: null,
          },
        ],
      },
      turnScope: 'step',
      numTurns: null,
      durationMs: null,
      sourceSessionId: 'pi-session-1',
    },
  ]);
});

test('a step whose usage states no cost is unpriced: cost null, no currency, basis unreported, its tokens kept', () => {
  const { lift } = opened();
  const { cost: _cost, ...uncosted } = CALL_USAGE;
  const record = lift.fromMessage(assistantEnd(uncosted)).facts[0];
  assert.equal(record?.kind, 'turn_record');
  if (record?.kind !== 'turn_record') return;
  assert.deepEqual(
    [record.turn?.cost, record.turn?.currency, record.turn?.costBasis, record.turn?.byModel[0]?.costBasis],
    [null, null, 'unreported', 'unreported'],
  );
  assert.equal(record.turn?.byModel[0]?.inputTokens, 120);
});

test("control: a user's or a tool's message, and an assistant message with no usage, file no step", () => {
  const { lift } = opened();
  assert.deepEqual(lift.fromMessage(assistantEnd(CALL_USAGE, 'user')).facts, []);
  assert.deepEqual(lift.fromMessage(assistantEnd(CALL_USAGE, 'toolResult')).facts, []);
  assert.deepEqual(lift.fromMessage(assistantEnd(undefined)).facts, []);
});

test('each model call of a run files its own step, never a sum of the two', () => {
  const { lift } = opened();
  const steps = [CALL_USAGE, { ...CALL_USAGE, input: 400, cost: { total: 0.001 } }].map((usage) => {
    const record = lift.fromMessage(assistantEnd(usage)).facts[0];
    return record?.kind === 'turn_record' ? [record.turn?.cost, record.turn?.byModel[0]?.inputTokens] : null;
  });
  assert.deepEqual(steps, [
    [0.00033, 120],
    [0.001, 400],
  ]);
});

test('a step record crosses the wire as the step record Copilot and opencode send: priced, and unpriced', () => {
  const { lift } = opened();
  const { cost: _cost, ...uncosted } = CALL_USAGE;
  for (const usage of [CALL_USAGE, uncosted]) {
    const fact = lift.fromMessage(assistantEnd(usage)).facts[0];
    assert.equal(fact?.kind, 'turn_record');
    const decoded = decode(
      JSON.stringify({
        frame: 'session',
        sessionId: 's-1',
        seq: 1,
        at: '2000-01-01T00:00:00.000Z',
        payload: { kind: 'session_update', body: { update: 'agent_facts', fact, sourceId: null } },
      }),
    );
    assert.ok(decoded.ok, decoded.ok ? '' : `the fact does not cross the wire: ${decoded.refusal.detail}`);
  }
});
