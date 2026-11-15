import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentFact } from '../control/frames.js';
import { CopilotFactLift, copilotFactSourceId } from './copilot-facts.js';
import { CopilotItemFill } from './copilot-items.js';
import type { CopilotEvent } from './copilot-sdk.js';
import type { CopilotMessage } from './copilot-wire.js';

let events = 0;
const event = (
  type: string,
  data: Record<string, unknown>,
  envelope: Partial<CopilotEvent> = {},
): CopilotMessage => {
  events += 1;
  return {
    kind: 'event',
    event: {
      id: `e${events}`,
      parentId: null,
      timestamp: '2026-11-15T00:00:00.000Z',
      type,
      data,
      ...envelope,
    },
  };
};

const opened: CopilotMessage = {
  kind: 'opened',
  sessionId: 'copilot-session-1',
  model: 'gpt-5-mini',
  agentMode: 'interactive',
  tools: ['view'],
  origin: 'new',
};

const kinds = (facts: readonly AgentFact[]): string[] => facts.map((fact) => fact.kind);

test("the open names the session's handle and the runtime's receipt; a receipt is sent again only when a member moves", () => {
  const lift = new CopilotFactLift({ handedOverSkills: ['review'] });
  assert.deepEqual(
    lift.fromMessage(
      event('session.start', { sessionId: 'x', selectedModel: 'gpt-5-mini', reasoningEffort: 'medium' }),
    ).facts,
    [],
    'nothing before the open',
  );
  const first = lift.fromMessage(opened).facts;
  assert.deepEqual(kinds(first), ['session_handle', 'agent_receipt']);
  assert.deepEqual(first[0], { kind: 'session_handle', runtime: 'copilot', handle: 'copilot-session-1' });
  const receipt = first[1];
  assert.ok(receipt?.kind === 'agent_receipt');
  assert.equal(receipt.runtimeVersion, '1.0.112');
  assert.equal(receipt.model, 'gpt-5-mini');
  assert.equal(receipt.permissionMode, 'interactive');
  assert.equal(receipt.effort, 'medium');
  assert.equal(receipt.effortReported, true);
  assert.deepEqual(receipt.skills, ['review']);
  assert.equal(receipt.mcpServers, null);
  assert.equal(receipt.source, 'runtime');
  assert.deepEqual(lift.fromMessage(opened).facts, [], 'the same open again moves nothing');
  const moved = lift.fromMessage(
    event('session.model_change', { newModel: 'claude-sonnet-4.6', reasoningEffort: null }),
  ).facts;
  assert.ok(moved[0]?.kind === 'agent_receipt');
  assert.equal(moved[0].model, 'claude-sonnet-4.6');
  assert.equal(moved[0].effort, null);
  assert.equal(moved[0].effortReported, true, 'the runtime said no effort is in force');
  const mode = lift.fromMessage(
    event('session.mode_changed', { newMode: 'plan', previousMode: 'interactive' }),
  ).facts;
  assert.ok(mode[0]?.kind === 'agent_receipt' && mode[0].permissionMode === 'plan');
  const skills = lift.fromMessage(
    event('session.skills_loaded', {
      skills: [
        { name: 'review', enabled: true, description: '', source: 'custom', userInvocable: true },
        { name: 'lint', enabled: true, description: '', source: 'custom', userInvocable: true },
        { name: 'off', enabled: false, description: '', source: 'custom', userInvocable: true },
      ],
    }),
  ).facts;
  assert.ok(skills[0]?.kind === 'agent_receipt');
  assert.deepEqual(
    skills[0].skills,
    ['review', 'lint'],
    "the runtime's own list replaces the one handed over",
  );
  const servers = lift.fromMessage(
    event('session.mcp_servers_loaded', { servers: [{ name: 'nas', status: 'connected' }] }),
  ).facts;
  assert.ok(servers[0]?.kind === 'agent_receipt');
  assert.deepEqual(servers[0].mcpServers, [{ name: 'nas', status: 'connected' }]);
  const failed = lift.fromMessage(
    event('session.mcp_server_status_changed', { serverName: 'nas', status: 'failed' }),
  ).facts;
  assert.ok(failed[0]?.kind === 'agent_receipt');
  assert.deepEqual(failed[0].mcpServers, [{ name: 'nas', status: 'failed' }]);
});

test("each model call is one step's spend, unpriced, its input counted without the cache reads; the shutdown files the totals", () => {
  const lift = new CopilotFactLift();
  lift.fromMessage(opened);
  const step = lift.fromMessage(
    event('assistant.usage', {
      model: 'gpt-5-mini',
      modelProvider: 'openai',
      inputTokens: 120,
      outputTokens: 7,
      cacheReadTokens: 20,
      cacheWriteTokens: 3,
      reasoningTokens: 2,
      cost: 1,
      duration: 812,
    }),
  ).facts;
  assert.deepEqual(step, [
    {
      kind: 'turn_record',
      runtime: 'copilot',
      totals: null,
      turn: {
        cost: null,
        currency: null,
        costBasis: 'unreported',
        byModel: [
          {
            model: 'gpt-5-mini',
            canonicalModel: null,
            provider: 'openai',
            inputTokens: 100,
            outputTokens: 7,
            cacheReadTokens: 20,
            cacheWriteTokens: 3,
            reasoningTokens: 2,
            cost: null,
            costBasis: 'unreported',
            contextWindow: null,
          },
        ],
      },
      turnScope: 'step',
      numTurns: null,
      durationMs: 812,
      sourceSessionId: 'copilot-session-1',
    },
  ]);
  const sample = lift.fromMessage(
    event('session.usage_info', { currentTokens: 5000, tokenLimit: 128000, messagesLength: 4 }),
  ).facts;
  assert.deepEqual(sample, [
    {
      kind: 'usage_sample',
      runtime: 'copilot',
      model: 'gpt-5-mini',
      contextTokens: 5000,
      contextWindow: 128000,
      cacheTtl: null,
      mainThread: true,
      cacheReadTokens: 20,
    },
  ]);
  const totals = lift.fromMessage(
    event('session.shutdown', {
      shutdownType: 'routine',
      totalApiDurationMs: 3000,
      sessionStartTime: 0,
      codeChanges: {},
      modelMetrics: {
        'gpt-5-mini': {
          requests: { count: 2, cost: 1 },
          usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 },
        },
      },
    }),
  ).facts;
  assert.ok(totals[0]?.kind === 'turn_record');
  assert.equal(totals[0].turn, null);
  assert.equal(totals[0].turnScope, null);
  assert.equal(totals[0].totals?.byModel[0]?.inputTokens, 250);
  assert.equal(totals[0].totals?.cost, null);
});

test('a sub-agent is a task named by the call that spawned it, settled with what it used; the settled ones start over with each run', () => {
  const lift = new CopilotFactLift();
  lift.fromMessage(event('user.message', { content: 'go' }));
  const running = lift.fromMessage(
    event('subagent.started', {
      toolCallId: 'call_task',
      agentName: 'explore',
      agentDisplayName: 'Explore',
      agentDescription: 'look around',
    }),
  ).facts;
  assert.deepEqual(running, [
    {
      kind: 'tasks',
      runtime: 'copilot',
      running: [{ taskId: 'call_task', type: 'explore', description: 'look around', toolUseId: 'call_task' }],
      settled: [],
    },
  ]);
  const settled = lift.fromMessage(
    event('subagent.completed', {
      toolCallId: 'call_task',
      agentName: 'explore',
      agentDisplayName: 'Explore',
      totalTokens: 900,
      totalToolCalls: 3,
      durationMs: 4000,
    }),
  ).facts;
  assert.deepEqual(settled[0], {
    kind: 'tasks',
    runtime: 'copilot',
    running: [],
    settled: [
      {
        taskId: 'call_task',
        type: 'explore',
        status: 'completed',
        toolUseId: 'call_task',
        usage: { tokens: 900, toolUses: 3, durationMs: 4000 },
      },
    ],
  });
  const failed = lift.fromMessage(
    event('subagent.failed', {
      toolCallId: 'call_other',
      agentName: 'x',
      agentDisplayName: 'X',
      error: 'model call failed',
    }),
  ).facts;
  assert.ok(failed[0]?.kind === 'tasks');
  assert.deepEqual(failed[0].settled?.[1], {
    taskId: 'call_other',
    type: null,
    status: 'failed',
    toolUseId: 'call_other',
    summary: 'model call failed',
  });
  lift.fromMessage(event('session.idle', {}));
  lift.fromMessage(event('user.message', { content: 'again' }));
  const next = lift.fromMessage(
    event('subagent.started', {
      toolCallId: 'call_3',
      agentName: 'y',
      agentDisplayName: 'Y',
      agentDescription: '',
    }),
  ).facts;
  assert.ok(next[0]?.kind === 'tasks');
  assert.deepEqual(next[0].settled, [], 'the settled tasks started over with the run');
});

test("the deltas are fragments, a sub-agent's naming the call that spawned it, and one naming no spawning call is never read as the session's own", () => {
  const lift = new CopilotFactLift();
  assert.deepEqual(
    lift.fromMessage(event('assistant.message_delta', { messageId: 'm', deltaContent: 'Hel' })).fragments,
    [{ update: 'agent_fragment', runtime: 'copilot', channel: 'text', text: 'Hel', parentId: null }],
  );
  assert.equal(
    lift.fromMessage(event('assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'hmm' }))
      .fragments[0]?.channel,
    'thinking',
  );
  assert.equal(
    lift.fromMessage(event('assistant.tool_call_delta', { toolCallId: 'c', inputDelta: '{"pa' })).fragments[0]
      ?.channel,
    'tool_input',
  );
  assert.equal(
    lift.fromMessage(
      event(
        'assistant.message_delta',
        { messageId: 'm', deltaContent: 'sub', parentToolCallId: 'call_task' },
        { agentId: 'a1' },
      ),
    ).fragments[0]?.parentId,
    'call_task',
  );
  assert.deepEqual(
    lift.fromMessage(
      event('assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'x' }, { agentId: 'a1' }),
    ).fragments,
    [],
  );
  assert.deepEqual(
    lift.fromMessage(event('assistant.message_delta', { messageId: 'm', deltaContent: '' })).fragments,
    [],
  );
});

test("a fact names its event's own id as its source; the open names none", () => {
  const message = event('assistant.usage', { model: 'm' });
  assert.equal(copilotFactSourceId(message), message.kind === 'event' ? message.event.id : null);
  assert.equal(copilotFactSourceId(opened), null);
});

test('the fill: a run is a turn from the prompt taken to session.idle, with the prompt, the text, the reasoning, the calls and their results', () => {
  const fill = new CopilotItemFill('session-1');
  const items = [
    event('user.message', { content: 'list the files' }),
    event('assistant.reasoning', { reasoningId: 'r', content: 'I should look.' }),
    event('tool.execution_start', {
      toolCallId: 'call_1',
      toolName: 'powershell',
      arguments: { command: 'ls' },
    }),
    event('tool.execution_complete', {
      toolCallId: 'call_1',
      success: true,
      result: { content: 'a.ts' },
      shellExecution: { exitCode: 0 },
    }),
    event('tool.execution_start', { toolCallId: 'call_2', toolName: 'create', arguments: { path: 'b.ts' } }),
    event('tool.execution_complete', {
      toolCallId: 'call_2',
      success: true,
      result: { content: 'created' },
      fileEdits: [
        { kind: 'create', path: 'b.ts' },
        { kind: 'rename', path: 'c.ts' },
      ],
    }),
    event('assistant.message', { messageId: 'm1', content: 'Done.' }),
    event('session.idle', {}),
  ].flatMap((message) => fill.fromMessage(message));
  assert.deepEqual(
    items.map((item) => item.kind),
    [
      'turn',
      'user_text',
      'thinking',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'agent_text',
      'turn',
    ],
  );
  const [start, prompt, , call, result, , written, text, end] = items;
  assert.ok(start?.kind === 'turn' && start.status === 'started' && start.itemId === 'session-1:run:1');
  assert.ok(prompt?.kind === 'user_text' && prompt.text === 'list the files');
  assert.ok(call?.kind === 'tool_call' && call.toolKind === 'shell' && call.toolUseId === 'call_1');
  assert.ok(
    result?.kind === 'tool_result' &&
      result.status === 'completed' &&
      result.exitCode === 0 &&
      result.output === 'a.ts',
  );
  assert.ok(written?.kind === 'tool_result');
  assert.deepEqual(
    written.changes,
    [{ path: 'b.ts', change: 'add', movePath: null, diff: null }],
    'an edit kind the runtime adds later fills no entry',
  );
  assert.ok(text?.kind === 'agent_text' && text.final === null && text.text === 'Done.');
  assert.ok(end?.kind === 'turn' && end.status === 'completed' && end.itemId === 'session-1:run:1:end');
});

test('the fill: a call the gate refused is blocked; a run that errored fails with the error, and an aborted one is interrupted', () => {
  const fill = new CopilotItemFill('s', {
    toolName: (name) => (name === 'nas-read' ? 'mcp__nas__read' : name),
  });
  fill.gateBlocked('call_1');
  const blocked = [
    event('user.message', { content: 'go' }),
    event('tool.execution_start', { toolCallId: 'call_1', toolName: 'nas-read', arguments: {} }),
    event('tool.execution_complete', {
      toolCallId: 'call_1',
      success: false,
      error: { message: 'not that one' },
    }),
    event('session.error', { errorType: 'authentication', message: 'Not authenticated' }),
    event('session.idle', {}),
    event('user.message', { content: 'again' }),
    event('session.idle', { aborted: true }),
  ].flatMap((message) => fill.fromMessage(message));
  const call = blocked.find((item) => item.kind === 'tool_call');
  assert.ok(call?.kind === 'tool_call' && call.toolName === 'mcp__nas__read' && call.toolKind === 'mcp');
  const result = blocked.find((item) => item.kind === 'tool_result');
  assert.ok(
    result?.kind === 'tool_result' && result.status === 'blocked' && result.output === 'not that one',
  );
  const notice = blocked.find((item) => item.kind === 'notice');
  assert.ok(
    notice?.kind === 'notice' &&
      notice.level === 'error' &&
      notice.text === 'authentication: Not authenticated',
  );
  const ends = blocked.filter((item) => item.kind === 'turn' && item.status !== 'started');
  assert.deepEqual(
    ends.map((item) => (item.kind === 'turn' ? [item.status, item.detail] : null)),
    [
      ['failed', 'authentication: Not authenticated'],
      ['interrupted', 'the run was aborted'],
    ],
  );
});

test('the fill: a run that fails before the runtime takes its prompt (no sign-in) is its error notice alone, never a turn that ended unstarted', () => {
  const fill = new CopilotItemFill('s');
  const items = [
    event('session.error', {
      errorType: 'query',
      message: 'Execution failed: InvalidArg, No GitHub OAuth token or Copilot HMAC key provided',
    }),
    event('assistant.idle', {}),
    event('session.idle', {}),
  ].flatMap((message) => fill.fromMessage(message));
  assert.deepEqual(
    items.map((item) => [item.kind, item.kind === 'notice' ? item.text : null]),
    [['notice', 'query: Execution failed: InvalidArg, No GitHub OAuth token or Copilot HMAC key provided']],
  );
  // The next run starts its turn at one, as the first.
  const next = [event('user.message', { content: 'again' })].flatMap((message) => fill.fromMessage(message));
  assert.equal(next[0]?.itemId, 's:run:1');
});

test("the fill: a sub-agent's items carry the call that spawned it, only where they are wanted", () => {
  const sub = (type: string, data: Record<string, unknown>) =>
    event(type, { ...data, parentToolCallId: 'call_task' }, { agentId: 'agent-1' });
  const messages = [
    sub('tool.execution_start', { toolCallId: 'call_sub', toolName: 'view', arguments: { path: 'x' } }),
    sub('assistant.message', { messageId: 'm', content: 'found it' }),
    event(
      'assistant.message',
      { messageId: 'm2', content: 'no spawning call named' },
      { agentId: 'agent-1' },
    ),
  ];
  const off = new CopilotItemFill('s');
  assert.deepEqual(
    messages.flatMap((message) => off.fromMessage(message)),
    [],
  );
  const on = new CopilotItemFill('s', { spawnedItems: () => true });
  const items = messages.flatMap((message) => on.fromMessage(message));
  assert.deepEqual(
    items.map((item) => [item.kind, item.parentId]),
    [
      ['tool_call', 'call_task'],
      ['agent_text', 'call_task'],
    ],
  );
});
