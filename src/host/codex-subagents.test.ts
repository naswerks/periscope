/**
 * A Codex sub-agent, read the way the app-server protocol declares it at rust-v0.169.0 (`ThreadItem`'s
 * `collabAgentToolCall` and `subAgentActivity`, `ItemCompletedNotification`, `TurnCompletedNotification`): its
 * thread fills items naming the call that spawned it, its turns stay apart from the session's own, and
 * its task entry names that call and the message it ended with.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentItem, JsonObject } from '../control/frames.js';
import { MAX_FACT_TEXT_LENGTH } from '../control/frames.js';
import { fixedTicker } from '../core/time.js';
import { SessionStateMachine } from '../state/machine.js';
import type { SessionState } from '../state/model.js';
import { SessionObserver } from '../state/observer.js';
import { CodexFactLift } from './codex-facts.js';
import { CodexItemFill } from './codex-items.js';
import type { CodexMessage } from './codex-wire.js';

const THREAD = 'thread-1';

const notification = (method: string, params: JsonObject): CodexMessage => ({
  kind: 'notification',
  method,
  params,
});

const opened: CodexMessage = {
  kind: 'answer',
  method: 'thread/start',
  params: {},
  result: { thread: { id: THREAD }, model: 'gpt-6-sol' },
};

const completed = (threadId: string, item: JsonObject, turnId = `${threadId}-turn`): CodexMessage =>
  notification('item/completed', { threadId, turnId, item });

/** A v1 spawn: the collaboration call on `threadId` that starts each of `agents`. */
const spawn = (threadId: string, id: string, agents: readonly string[]): CodexMessage =>
  completed(threadId, {
    type: 'collabAgentToolCall',
    id,
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: threadId,
    receiverThreadIds: [...agents],
    prompt: 'Review it.',
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  });

const turn = (method: 'turn/started' | 'turn/completed', threadId: string, id: string): CodexMessage =>
  notification(method, {
    threadId,
    turn: { id, status: method === 'turn/started' ? 'inProgress' : 'completed', error: null },
  });

const said = (threadId: string, id: string, text: string): CodexMessage =>
  completed(threadId, { type: 'agentMessage', id, text });

/** Each item as `[itemId, parentId]`, an absent parent read as null. */
const placed = (items: readonly AgentItem[]): [string, string | null][] =>
  items.map((item) => [item.itemId, item.parentId ?? null]);

function fill(spawned: boolean, messages: readonly CodexMessage[]): AgentItem[] {
  const items = new CodexItemFill({ spawnedItems: () => spawned });
  return [opened, ...messages].flatMap((message) => items.fromMessage(message));
}

// ---------------------------------------------------------------------------
// The items
// ---------------------------------------------------------------------------

test("a sub-agent's thread fills items naming the call that spawned it; the session's own name none", () => {
  const items = fill(true, [
    turn('turn/started', THREAD, 'own-turn'),
    spawn(THREAD, 'call-spawn', ['agent-1']),
    turn('turn/started', 'agent-1', 'sub-turn'),
    said('agent-1', 'msg-sub', 'inside'),
    turn('turn/completed', 'agent-1', 'sub-turn'),
    said(THREAD, 'msg-own', 'outside'),
    turn('turn/completed', THREAD, 'own-turn'),
  ]);
  assert.deepEqual(placed(items), [
    ['own-turn:started', null],
    ['call-spawn', null],
    ['call-spawn:result', null],
    ['sub-turn:started', 'call-spawn'],
    ['msg-sub', 'call-spawn'],
    ['sub-turn:completed', 'call-spawn'],
    ['msg-own', null],
    ['own-turn:completed', null],
  ]);
  for (const item of items.filter((one) => one.parentId === undefined)) {
    assert.equal(
      'parentId' in item,
      false,
      `${item.itemId}: an own item states no parent, as 1.10.0 sent it`,
    );
  }
});

test("control: with a sub-agent's items not wanted, the same messages fill only the session's own", () => {
  const items = fill(false, [
    spawn(THREAD, 'call-spawn', ['agent-1']),
    turn('turn/started', 'agent-1', 'sub-turn'),
    said('agent-1', 'msg-sub', 'inside'),
    said(THREAD, 'msg-own', 'outside'),
  ]);
  assert.deepEqual(placed(items), [
    ['call-spawn', null],
    ['call-spawn:result', null],
    ['msg-own', null],
  ]);
});

test("a nested sub-agent names its parent sub-agent's call, and a later call about an agent never moves its parent", () => {
  const items = fill(true, [
    spawn(THREAD, 'call-outer', ['agent-1']),
    spawn('agent-1', 'call-inner', ['agent-2']),
    said('agent-2', 'msg-deep', 'deep'),
    completed(THREAD, {
      type: 'collabAgentToolCall',
      id: 'call-wait',
      tool: 'wait',
      status: 'completed',
      receiverThreadIds: ['agent-1'],
      agentsStates: {},
    }),
    said('agent-1', 'msg-mid', 'mid'),
  ]);
  const parents = new Map(placed(items));
  assert.equal(parents.get('call-inner'), 'call-outer', "the inner spawn is the outer sub-agent's call");
  assert.equal(parents.get('msg-deep'), 'call-inner');
  assert.equal(parents.get('msg-mid'), 'call-outer', 'a wait named the agent and moved its parent');
});

test("a v2 sub-agent is named by its activity's started item, whose id is the spawning call's", () => {
  const items = fill(true, [
    completed(THREAD, {
      type: 'subAgentActivity',
      id: 'call-v2',
      kind: 'started',
      agentThreadId: 'agent-v2',
      agentPath: '/root/reviewer',
      model: null,
      reasoningEffort: null,
    }),
    said('agent-v2', 'msg-v2', 'from v2'),
  ]);
  assert.deepEqual(placed(items), [
    ['call-v2', null],
    ['msg-v2', 'call-v2'],
  ]);
});

test('a sub-agent that speaks before its spawn reports it is held, then filled naming the spawn, in order', () => {
  const items = fill(true, [
    turn('turn/started', 'agent-early', 'early-turn'),
    said('agent-early', 'msg-early', 'first'),
    spawn(THREAD, 'call-late', ['agent-early']),
  ]);
  assert.deepEqual(placed(items), [
    ['call-late', null],
    ['call-late:result', null],
    ['early-turn:started', 'call-late'],
    ['msg-early', 'call-late'],
  ]);
});

test('control: a thread no call is known to have spawned fills nothing, and what it held is dropped at the end of the session turn', () => {
  const items = fill(true, [
    turn('turn/started', THREAD, 'own-turn'),
    said('agent-stray', 'msg-stray', 'nobody spawned me'),
    turn('turn/completed', THREAD, 'own-turn'),
    spawn(THREAD, 'call-after', ['agent-stray']),
  ]);
  assert.deepEqual(placed(items), [
    ['own-turn:started', null],
    ['own-turn:completed', null],
    ['call-after', null],
    ['call-after:result', null],
  ]);
});

// ---------------------------------------------------------------------------
// The session's own turn
// ---------------------------------------------------------------------------

/** The states the session moved through, and the turn records lifted, for `messages` on a Codex session. */
function session(messages: readonly CodexMessage[]): { states: SessionState[]; records: number } {
  const machine = new SessionStateMachine({
    where: { worktree: null, branch: null, cwd: 'C:/work', unknownReason: 'not a repository' },
    clock: () => '2000-01-01T00:00:00.000Z',
    ticker: fixedTicker(0),
  });
  const observer = new SessionObserver(machine, { controlTier: { level: 'none', degrades: [] } });
  const states: SessionState[] = [];
  machine.onTransition((transition) => states.push(transition.to));
  const lift = new CodexFactLift();
  let records = 0;
  for (const message of [opened, notification('thread/started', { thread: { id: THREAD } }), ...messages]) {
    observer.observeCodexMessage(message);
    records += lift.fromMessage(message).facts.filter((fact) => fact.kind === 'turn_record').length;
  }
  return { states, records };
}

test("a sub-agent's turn moves none of the session's turn state and records no turn of the session's", () => {
  const { states, records } = session([
    turn('turn/started', THREAD, 'own-turn'),
    spawn(THREAD, 'call-spawn', ['agent-1']),
    turn('turn/started', 'agent-1', 'sub-turn'),
    turn('turn/completed', 'agent-1', 'sub-turn'),
  ]);
  assert.equal(states.at(-1), 'working', "the sub-agent's completed turn ended the session's turn");
  assert.equal(records, 0, "the sub-agent's turn was recorded as the session's");
  // Control: the session's own completed turn does end it, and is recorded once.
  const own = session([turn('turn/started', THREAD, 'own-turn'), turn('turn/completed', THREAD, 'own-turn')]);
  assert.equal(own.states.at(-1), 'idle');
  assert.equal(own.records, 1);
});

// ---------------------------------------------------------------------------
// The task entries
// ---------------------------------------------------------------------------

test('a task entry names the call that started it and the message it ended with; usage and its file are never stated', () => {
  const lift = new CodexFactLift();
  lift.fromMessage(opened);
  const tasks = (message: CodexMessage) =>
    lift.fromMessage(message).facts.flatMap((fact) => (fact.kind === 'tasks' ? [fact] : []));
  const [running] = tasks(spawn(THREAD, 'call-spawn', ['agent-1']));
  assert.deepEqual(running?.running, [
    { taskId: 'agent-1', type: 'subagent', description: 'Review it.', toolUseId: 'call-spawn' },
  ]);
  const [settled] = tasks(
    completed(THREAD, {
      type: 'collabAgentToolCall',
      id: 'call-wait',
      tool: 'wait',
      status: 'completed',
      receiverThreadIds: ['agent-1'],
      agentsStates: { 'agent-1': { status: 'completed', message: 'All three files reviewed.' } },
    }),
  );
  assert.deepEqual(settled?.settled, [
    {
      taskId: 'agent-1',
      type: 'subagent',
      status: 'completed',
      toolUseId: 'call-spawn',
      summary: 'All three files reviewed.',
    },
  ]);
  const entry = settled?.settled?.[0] as Record<string, unknown> | undefined;
  assert.equal('usage' in (entry ?? {}), false, 'Codex reports no usage for a sub-agent');
  assert.equal('outputFile' in (entry ?? {}), false, 'Codex reports no output file for a sub-agent');
});

test("a sub-agent's long final message is cut at the bound, never inside a surrogate pair", () => {
  const lift = new CodexFactLift();
  lift.fromMessage(opened);
  lift.fromMessage(spawn(THREAD, 'call-spawn', ['agent-1']));
  // The bound's last unit is the first half of a pair: a plain slice would leave it alone.
  const message = `${'a'.repeat(MAX_FACT_TEXT_LENGTH - 1)}\u{1F600}tail`;
  const facts = lift.fromMessage(
    completed(THREAD, {
      type: 'collabAgentToolCall',
      id: 'call-wait',
      tool: 'wait',
      status: 'completed',
      receiverThreadIds: ['agent-1'],
      agentsStates: { 'agent-1': { status: 'completed', message } },
    }),
  ).facts;
  const summary = facts.flatMap((fact) => (fact.kind === 'tasks' ? (fact.settled ?? []) : []))[0]?.summary;
  assert.equal(summary?.length, MAX_FACT_TEXT_LENGTH - 1, 'the cut split the pair or ran past the bound');
  assert.equal(summary, 'a'.repeat(MAX_FACT_TEXT_LENGTH - 1));
});
