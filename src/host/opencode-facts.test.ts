import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentFact, AgentItem } from '../control/frames.js';
import { OpencodeFactLift, opencodeFactSourceId } from './opencode-facts.js';
import { OpencodeItemFill } from './opencode-items.js';
import type { OpencodeMessage } from './opencode-wire.js';

let ids = 0;
/** One event, the session's own unless a subagent's session is named. */
function event(
  type: string,
  data: Record<string, unknown> = {},
  child?: { readonly session: string; readonly spawnedBy: string | null },
): OpencodeMessage {
  ids += 1;
  const session = child?.session ?? 'ses_main';
  return {
    kind: 'event',
    event: { id: `evt_${ids}`, type, data: { sessionID: session, ...data } },
    session,
    main: child === undefined,
    spawnedBy: child?.spawnedBy ?? null,
  };
}

const OPENED: OpencodeMessage = {
  kind: 'opened',
  sessionId: 'ses_main',
  model: 'endpoint-stub/stub-model',
  agent: 'build',
  origin: 'new',
};

const kinds = (facts: readonly AgentFact[]): string[] => facts.map((fact) => fact.kind);

test("the open names the session's handle and the runtime's receipt: its model, its agent as its permission mode, the skills handed over", () => {
  const lift = new OpencodeFactLift({ handedOverSkills: ['review'] });
  assert.deepEqual(
    lift.fromMessage(event('session.model.selected', { model: { id: 'x', providerID: 'p' } })).facts,
    [],
    'no receipt before the open',
  );
  const lifted = lift.fromMessage(OPENED).facts;
  assert.deepEqual(kinds(lifted), ['session_handle', 'agent_receipt']);
  const [handle, receipt] = lifted;
  assert.equal(handle?.kind === 'session_handle' ? handle.handle : null, 'ses_main');
  assert.ok(receipt?.kind === 'agent_receipt');
  assert.equal(receipt.runtime, 'opencode');
  assert.equal(receipt.model, 'endpoint-stub/stub-model');
  assert.equal(receipt.permissionMode, 'build');
  assert.equal(receipt.effort, null);
  assert.equal(receipt.effortReported, false);
  assert.deepEqual(receipt.skills, ['review']);
  assert.equal(receipt.source, 'runtime');
});

test('the receipt is sent again only when a member moved: the model, the agent', () => {
  const lift = new OpencodeFactLift();
  lift.fromMessage(OPENED);
  const model = lift.fromMessage(
    event('session.model.selected', { model: { id: 'other', providerID: 'endpoint-stub' } }),
  ).facts;
  assert.equal(model[0]?.kind === 'agent_receipt' ? model[0].model : null, 'endpoint-stub/other');
  assert.deepEqual(
    lift.fromMessage(event('session.model.selected', { model: { id: 'other', providerID: 'endpoint-stub' } }))
      .facts,
    [],
  );
  const agent = lift.fromMessage(event('session.agent.selected', { agent: 'plan' })).facts;
  assert.equal(agent[0]?.kind === 'agent_receipt' ? agent[0].permissionMode : null, 'plan');
  // A subagent's selection is its own.
  assert.deepEqual(
    lift.fromMessage(
      event('session.agent.selected', { agent: 'general' }, { session: 'ses_c', spawnedBy: 'call_t' }),
    ).facts,
    [],
  );
});

test("each model call is filed as that step's own figure, never a running total; a cost above zero is the provider's, a zero is none reported", () => {
  const lift = new OpencodeFactLift();
  lift.fromMessage(OPENED);
  const step = (cost: unknown) =>
    lift.fromMessage(
      event('session.step.ended', {
        tokens: { input: 120, output: 7, reasoning: 3, cache: { read: 20, write: 5 } },
        cost,
      }),
    ).facts[0];
  const priced = step(0.0042);
  assert.ok(priced?.kind === 'turn_record');
  assert.equal(priced.turnScope, 'step');
  assert.equal(priced.totals, null);
  assert.equal(priced.turn?.cost, 0.0042);
  assert.equal(priced.turn?.currency, 'USD');
  assert.equal(priced.turn?.costBasis, 'provider-reported');
  assert.deepEqual(priced.turn?.byModel[0], {
    model: 'endpoint-stub/stub-model',
    canonicalModel: null,
    provider: null,
    inputTokens: 120,
    outputTokens: 7,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
    reasoningTokens: 3,
    cost: 0.0042,
    costBasis: 'provider-reported',
    contextWindow: null,
  });
  assert.equal(priced.sourceSessionId, 'ses_main');
  for (const none of [0, -1, Number.NaN, 'free', undefined]) {
    const unpriced = step(none);
    assert.ok(unpriced?.kind === 'turn_record');
    assert.equal(unpriced.turn?.cost, null, `cost ${String(none)}`);
    assert.equal(unpriced.turn?.currency, null);
    assert.equal(unpriced.turn?.costBasis, 'unreported');
  }
  // A failed call that reports tokens is filed too; one that reports none is not.
  assert.equal(
    lift.fromMessage(event('session.step.failed', { tokens: { input: 5, output: 0 }, cost: 0 })).facts[0]
      ?.kind,
    'turn_record',
  );
  assert.deepEqual(lift.fromMessage(event('session.step.failed', { error: { message: 'x' } })).facts, []);
});

test("a step is filed under the model it started on, a switch while it ran notwithstanding; a step that names none, under the session's", () => {
  const lift = new OpencodeFactLift();
  lift.fromMessage(OPENED);
  lift.fromMessage(
    event('session.step.started', {
      assistantMessageID: 'msg_1',
      model: { id: 'first', providerID: 'endpoint-stub' },
    }),
  );
  lift.fromMessage(event('session.model.selected', { model: { id: 'second', providerID: 'endpoint-stub' } }));
  const first = lift.fromMessage(
    event('session.step.ended', { assistantMessageID: 'msg_1', tokens: { input: 1, output: 1 }, cost: 0 }),
  ).facts[0];
  assert.equal(first?.kind === 'turn_record' ? first.turn?.byModel[0]?.model : null, 'endpoint-stub/first');
  const unnamed = lift.fromMessage(
    event('session.step.ended', { assistantMessageID: 'msg_2', tokens: { input: 1, output: 1 }, cost: 0 }),
  ).facts[0];
  assert.equal(
    unnamed?.kind === 'turn_record' ? unnamed.turn?.byModel[0]?.model : null,
    'endpoint-stub/second',
  );
  // The started step is forgotten once it ends: a second end of the same id is the session's.
  const again = lift.fromMessage(
    event('session.step.ended', { assistantMessageID: 'msg_1', tokens: { input: 1, output: 1 }, cost: 0 }),
  ).facts[0];
  assert.equal(again?.kind === 'turn_record' ? again.turn?.byModel[0]?.model : null, 'endpoint-stub/second');
});

test("a subagent's model call is filed under its own session's model, naming its session", () => {
  const lift = new OpencodeFactLift();
  lift.fromMessage(OPENED);
  const child = { session: 'ses_child', spawnedBy: 'call_task' };
  lift.fromMessage(event('session.created', { model: { id: 'cheap', providerID: 'endpoint-stub' } }, child));
  const filed = lift.fromMessage(
    event('session.step.ended', { tokens: { input: 1, output: 1 }, cost: 0 }, child),
  ).facts[0];
  assert.ok(filed?.kind === 'turn_record');
  assert.equal(filed.turn?.byModel[0]?.model, 'endpoint-stub/cheap');
  assert.equal(filed.sourceSessionId, 'ses_child');
});

test("each subagent's session is a task from its run's start to its end, named by the call that started it; the settled start over with the session's next run", () => {
  const lift = new OpencodeFactLift();
  lift.fromMessage(OPENED);
  lift.fromMessage(event('session.execution.started'));
  const child = { session: 'ses_child', spawnedBy: 'call_task' };
  const running = lift.fromMessage(event('session.execution.started', {}, child)).facts[0];
  assert.ok(running?.kind === 'tasks');
  assert.deepEqual(running.running, [
    { taskId: 'ses_child', type: 'subagent', description: null, toolUseId: 'call_task' },
  ]);
  const failed = lift.fromMessage(
    event('session.execution.failed', { error: { message: 'it broke' } }, child),
  ).facts[0];
  assert.ok(failed?.kind === 'tasks');
  assert.deepEqual(failed.running, []);
  assert.deepEqual(failed.settled, [
    { taskId: 'ses_child', type: 'subagent', status: 'failed', toolUseId: 'call_task', summary: 'it broke' },
  ]);
  lift.fromMessage(event('session.execution.succeeded'));
  lift.fromMessage(event('session.execution.started'));
  const next = lift.fromMessage(
    event('session.execution.started', {}, { session: 'ses_two', spawnedBy: 'call_two' }),
  ).facts[0];
  assert.ok(next?.kind === 'tasks');
  assert.deepEqual(next.settled, [], 'the settled tasks started over with the run');
  // A subagent whose starting call is not known is no task.
  assert.deepEqual(
    lift.fromMessage(event('session.execution.started', {}, { session: 'ses_x', spawnedBy: null })).facts,
    [],
  );
});

test("each streamed delta is a fragment of its channel; a subagent's names the call that started it, and one whose call is not known is none", () => {
  const lift = new OpencodeFactLift();
  const fragments = (message: OpencodeMessage) => lift.fromMessage(message).fragments;
  assert.deepEqual(fragments(event('session.text.delta', { delta: 'he' })), [
    { update: 'agent_fragment', runtime: 'opencode', channel: 'text', text: 'he', parentId: null },
  ]);
  assert.equal(fragments(event('session.reasoning.delta', { delta: 'hm' }))[0]?.channel, 'thinking');
  assert.equal(fragments(event('session.tool.input.delta', { delta: '{"' }))[0]?.channel, 'tool_input');
  assert.equal(
    fragments(event('session.text.delta', { delta: 'x' }, { session: 'ses_c', spawnedBy: 'call_t' }))[0]
      ?.parentId,
    'call_t',
  );
  assert.deepEqual(
    fragments(event('session.text.delta', { delta: 'x' }, { session: 'ses_c', spawnedBy: null })),
    [],
  );
  assert.deepEqual(fragments(event('session.text.delta', { delta: '' })), []);
});

test('a compaction is filed as the observer reports it, with no token figures; a fact names its event as its source', () => {
  const lift = new OpencodeFactLift();
  assert.deepEqual(
    lift.fromCompaction({ status: 'ended', trigger: 'auto', tokensBefore: null, tokensAfter: null }),
    [
      {
        kind: 'compaction',
        runtime: 'opencode',
        status: 'ended',
        trigger: 'auto',
        tokensBefore: null,
        tokensAfter: null,
      },
    ],
  );
  assert.equal(opencodeFactSourceId(OPENED), null);
  const one = event('session.step.ended');
  assert.equal(opencodeFactSourceId(one), one.kind === 'event' ? one.event.id : 'unreachable');
});

test("the conversation's items: a run, a prompt, the answer, its reasoning, a call, its result, a failure as a notice", () => {
  const fill = new OpencodeItemFill('key', {
    toolName: (name) => (name === 'docs_search' ? 'mcp__docs__search' : name),
  });
  const items: AgentItem[] = [];
  const push = (message: OpencodeMessage): void => {
    items.push(...fill.fromMessage(message));
  };
  push(OPENED);
  push(
    event('session.inbox.enqueued', { inboxID: 'inbox_1', item: { type: 'user', payload: { text: 'go' } } }),
  );
  push(event('session.execution.started'));
  push(event('session.reasoning.ended', { text: 'thinking' }));
  push(event('session.tool.input.started', { id: 'call_1', name: 'docs_search' }));
  push(event('session.tool.called', { id: 'call_1', input: { query: 'x' } }));
  push(event('session.tool.success', { id: 'call_1', content: [{ type: 'text', text: 'found' }] }));
  push(event('session.tool.input.started', { id: 'call_2', name: 'edit' }));
  push(event('session.tool.called', { id: 'call_2', input: { filePath: 'a.ts' } }));
  fill.gateBlocked('call_2');
  push(event('session.tool.failed', { id: 'call_2', error: { type: 'rejected', message: 'not that one' } }));
  push(event('session.text.ended', { text: 'done' }));
  push(event('session.step.failed', { error: { type: 'api', message: 'rate limited' } }));
  push(event('session.execution.failed', { error: { type: 'api', message: 'gave up' } }));
  assert.deepEqual(
    items.map((item) => item.kind),
    [
      'user_text',
      'turn',
      'thinking',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'agent_text',
      'notice',
      'notice',
      'turn',
    ],
  );
  const call = items.find((item) => item.kind === 'tool_call');
  assert.ok(call?.kind === 'tool_call');
  assert.equal(call.toolName, 'mcp__docs__search');
  assert.equal(call.toolKind, 'mcp');
  const results = items.filter((item) => item.kind === 'tool_result');
  assert.deepEqual(
    results.map((item) => (item.kind === 'tool_result' ? [item.status, item.output] : null)),
    [
      ['completed', 'found'],
      ['blocked', 'rejected: not that one'],
    ],
  );
  const end = items.at(-1);
  assert.ok(end?.kind === 'turn');
  assert.equal(end.status, 'failed');
  assert.equal(end.detail, 'api: gave up');
});

test("the fill keeps a call by its session and its id: a refusal and a tool's name do not cross to another session's call of the same id", () => {
  const fill = new OpencodeItemFill('session-1', { spawnedItems: () => true });
  const child = (type: string, data: Record<string, unknown>): OpencodeMessage => ({
    kind: 'event',
    event: { id: `evt_child_${type}`, type, data: { sessionID: 'ses_child', ...data } },
    session: 'ses_child',
    main: false,
    spawnedBy: 'call_spawn',
  });
  // The session's own call and a subagent's call share the id the provider handed out.
  fill.fromMessage(event('session.tool.input.started', { id: 'call_1', name: 'edit' }));
  fill.fromMessage(child('session.tool.input.started', { id: 'call_1', name: 'read' }));
  fill.gateBlocked('call_1');
  const items = [
    event('session.tool.called', { id: 'call_1', input: { path: 'a.ts' } }),
    child('session.tool.called', { id: 'call_1', input: { path: 'b.ts' } }),
    event('session.tool.failed', { id: 'call_1', error: { message: 'refused' } }),
    child('session.tool.success', { id: 'call_1', content: [{ type: 'text', text: 'read' }] }),
  ].flatMap((message) => fill.fromMessage(message));
  assert.deepEqual(
    items.map((item) =>
      item.kind === 'tool_call'
        ? `${item.toolName}${item.parentId === undefined ? '' : ' of the subagent'}`
        : item.kind === 'tool_result'
          ? `${item.status}${item.parentId === undefined ? '' : ' of the subagent'}`
          : item.kind,
    ),
    ['edit', 'read of the subagent', 'blocked', 'completed of the subagent'],
  );
  // The subagent's own refusal is the subagent's.
  fill.gateBlocked('call_2', 'ses_child');
  fill.fromMessage(event('session.tool.input.started', { id: 'call_2', name: 'read' }));
  const [own] = fill.fromMessage(event('session.tool.success', { id: 'call_2', content: [] }));
  assert.ok(own?.kind === 'tool_result' && own.status === 'completed');
  const [theirs] = fill.fromMessage(child('session.tool.failed', { id: 'call_2', error: { message: 'x' } }));
  assert.ok(theirs?.kind === 'tool_result' && theirs.status === 'blocked');
});

test('the fill forgets a call when it ends, whether or not its items are filled: an id handed out again is a new call', () => {
  let wanted = false;
  const fill = new OpencodeItemFill('session-1', { spawnedItems: () => wanted });
  const child = (type: string, data: Record<string, unknown>): OpencodeMessage => ({
    kind: 'event',
    event: { id: `evt_child_${type}`, type, data: { sessionID: 'ses_child', ...data } },
    session: 'ses_child',
    main: false,
    spawnedBy: 'call_spawn',
  });
  // A subagent's call is refused while its items are not wanted: nothing is filled for it.
  fill.fromMessage(child('session.tool.input.started', { id: 'call_1', name: 'edit' }));
  fill.gateBlocked('call_1', 'ses_child');
  assert.deepEqual(
    fill.fromMessage(child('session.tool.failed', { id: 'call_1', error: { message: 'x' } })),
    [],
  );
  // The provider hands the same id out again, and this time the subagent's items are wanted.
  wanted = true;
  const call = fill.fromMessage(child('session.tool.called', { id: 'call_1', input: {} }));
  assert.ok(call[0]?.kind === 'tool_call');
  assert.equal(call[0].toolName, 'tool', "the earlier call's name was kept for a later call of the same id");
  const [result] = fill.fromMessage(child('session.tool.success', { id: 'call_1', content: [] }));
  assert.ok(result?.kind === 'tool_result');
  assert.equal(
    result.status,
    'completed',
    "the earlier call's refusal was kept for a later call of the same id",
  );
});

test("a subagent's items are filled only where they are wanted, under the call that started it", () => {
  const child = { session: 'ses_c', spawnedBy: 'call_t' };
  const quiet = new OpencodeItemFill('key');
  assert.deepEqual(quiet.fromMessage(event('session.text.ended', { text: 'sub' }, child)), []);
  const wanted = new OpencodeItemFill('key', { spawnedItems: () => true });
  const [item] = wanted.fromMessage(event('session.text.ended', { text: 'sub' }, child));
  assert.ok(item?.kind === 'agent_text');
  assert.equal(item.parentId, 'call_t');
  assert.deepEqual(
    wanted.fromMessage(event('session.text.ended', { text: 'x' }, { session: 'ses_x', spawnedBy: null })),
    [],
  );
  assert.deepEqual(
    wanted.fromMessage(event('session.execution.started', {}, child)),
    [],
    "a subagent's run is no turn of the session's",
  );
});
