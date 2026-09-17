/**
 * The translation, checked shape by shape.
 *
 * These are unit tests over the host's own logic, not evidence about the SDK. They prove that a
 * message of a given shape produces a given transition; they prove nothing about whether the agent
 * ever sends that shape. That claim needs a real session, and it is made in `lifecycle.live.test.ts`
 * — a mock asserting SDK behaviour proves the mock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixedClock, fixedTicker } from '../core/time.js';
import type { HookInput, SDKMessage } from '../host/agent-process.js';
import type { TransitionWhere } from './model.js';
import { SessionStateMachine } from './machine.js';
import { SessionObserver } from './observer.js';
import { TransitionStore } from './store.js';

const START_MS = Date.parse('2026-08-03T12:00:00.000Z');
const WHERE: TransitionWhere = { cwd: '/tmp/w', worktree: '/tmp/w', branch: 'main', unknownReason: null };

function observer(): { observer: SessionObserver; machine: SessionStateMachine; store: TransitionStore } {
  const machine = new SessionStateMachine({
    where: WHERE,
    clock: fixedClock(START_MS),
    ticker: fixedTicker(START_MS),
  });
  const store = new TransitionStore();
  store.attach(machine);
  return { observer: new SessionObserver(machine), machine, store };
}

/** The SDK's shapes carry many fields this layer never reads; only the read ones are supplied. */
const message = (shape: Record<string, unknown>): SDKMessage => shape as unknown as SDKMessage;
const hook = (shape: Record<string, unknown>): HookInput => shape as unknown as HookInput;

test('init names the session, and it is the only place the id arrives', () => {
  const { observer: o, machine } = observer();
  assert.equal(machine.sessionId, null);

  o.observeMessage(
    message({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'claude-opus-5',
      claude_code_version: '2.1.220',
    }),
  );

  assert.equal(machine.state, 'ready');
  assert.equal(machine.sessionId, 'sess-1');
});

test('a tool call opens and closes an entry, and the state says working throughout', () => {
  const { observer: o, machine } = observer();

  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-1' }));
  assert.equal(machine.state, 'working');
  assert.deepEqual(machine.activity, { kind: 'tool', name: 'Bash' });

  o.observeHook(
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-1', tool_response: 'ok' }),
  );
  assert.equal(machine.activity, null);
});

test('a tool that fails gets a different exit from one that finished', () => {
  const { observer: o, store } = observer();

  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-1' }));
  o.observeHook(
    hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'tu-1', error: 'exit 1' }),
  );

  const exit = store.all().at(-1);
  assert.equal(exit?.cause.event, 'PostToolUseFailure');
  assert.match(exit?.cause.detail ?? '', /exit 1/, 'the failure reason has to survive into the trace');
});

test('PostToolBatch closes what is still open and does not re-close what already exited', () => {
  const { observer: o, store } = observer();

  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'tu-1' }));
  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 'tu-2' }));
  o.observeHook(
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'tu-1', tool_response: 'ok' }),
  );

  const before = store.all().length;
  o.observeHook(
    hook({
      hook_event_name: 'PostToolBatch',
      tool_calls: [
        { tool_name: 'Read', tool_input: {}, tool_use_id: 'tu-1' },
        { tool_name: 'Grep', tool_input: {}, tool_use_id: 'tu-2' },
      ],
    }),
  );

  assert.equal(store.all().length - before, 1, 'only the still-open entry produces a close');
  assert.equal(store.all().at(-1)?.entryId, 'tu-2');
});

test('a permission decision is visible while it is outstanding, and a denial closes it', () => {
  const { observer: o, machine, store } = observer();

  o.observeHook(hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }));
  assert.deepEqual(
    machine.activity,
    { kind: 'permission', name: 'Bash' },
    'the condition a single status word cannot represent',
  );

  o.observeHook(
    hook({
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: {},
      tool_use_id: 'tu-1',
      reason: 'not allowed here',
    }),
  );
  assert.equal(machine.activity, null);

  const denial = store.all().at(-1);
  assert.equal(denial?.cause.kind, 'hook');
  assert.equal(denial?.cause.event, 'PermissionDenied');
});

test('regression: a denial and an outage in the same path leave different traces', () => {
  const { observer: o, store } = observer();

  o.observeHook(hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }));
  o.observeHook(
    hook({
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: {},
      tool_use_id: 't',
      reason: 'no',
    }),
  );
  o.refused({
    kind: 'refusal',
    event: 'link-send-failed',
    detail: 'the decision path could not be reached',
  });

  const [denial, outage] = [store.all().at(-2), store.all().at(-1)];
  assert.equal(denial?.cause.kind, 'hook');
  assert.equal(outage?.cause.kind, 'refusal');
  assert.notEqual(denial?.cause.event, outage?.cause.event);
  // The discriminators are what code branches on; the prose is not.
  assert.notEqual(
    `${denial?.cause.kind}/${denial?.cause.event}`,
    `${outage?.cause.kind}/${outage?.cause.event}`,
    'an outage arriving as a denial impersonates a human "no"',
  );
});

test('a granted permission still gets its exit, from the tool actually running', () => {
  const { observer: o, machine, store } = observer();

  o.observeHook(hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }));
  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-1' }));

  assert.deepEqual(machine.activity, { kind: 'tool', name: 'Bash' });
  assert.equal(
    store.all().filter((transition) => transition.entryId === 'permission:Bash').length,
    2,
    'the permission entry opened and closed — an entry with no exit on the allow path would age forever',
  );
});

test("regression: backgrounding rides the SDK's own caused moment, never a timer", () => {
  const { observer: o, machine } = observer();

  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-build' }));
  o.observeMessage(
    message({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tu-build' }),
  );
  assert.deepEqual(machine.activity, { kind: 'tool', name: 'Bash' }, 'still in the foreground');

  o.observeMessage(
    message({ type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { is_backgrounded: true } }),
  );

  assert.equal(machine.activity, null, 'background work does not hold the session');
  assert.equal(machine.state, 'idle', 'a session with only background work can take a new turn');
  assert.equal(machine.openEntries()[0]?.lane, 'background');

  o.observeMessage(
    message({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      tool_use_id: 'tu-build',
      status: 'completed',
    }),
  );
  assert.equal(machine.openEntries().length, 0, 'and it still exits — backgrounding is not completion');
});

test('a backgrounded task with no join is not guessed at', () => {
  const { observer: o, store } = observer();
  const before = store.all().length;

  // No task_started arrived, so nothing correlates this to an entry. Inventing one would be the
  // inference this model forbids.
  o.observeMessage(
    message({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'unknown',
      patch: { is_backgrounded: true },
    }),
  );

  assert.equal(store.all().length, before);
});

test("the SDK's own status drives the request and compaction lanes", () => {
  const { observer: o, machine } = observer();

  o.observeMessage(message({ type: 'system', subtype: 'status', status: 'requesting' }));
  assert.deepEqual(machine.activity, { kind: 'requesting', name: null });

  o.observeMessage(message({ type: 'system', subtype: 'status', status: null }));
  assert.equal(machine.activity, null, 'null is the exit, not an absence of information');

  o.observeMessage(message({ type: 'system', subtype: 'status', status: 'compacting' }));
  assert.deepEqual(machine.activity, { kind: 'compacting', name: null });
});

test('the turn-over signal moves the state, and requires_action does not invent a second one', () => {
  const { observer: o, machine } = observer();

  o.observeMessage(message({ type: 'system', subtype: 'session_state_changed', state: 'running' }));
  assert.equal(machine.state, 'working');

  o.observeMessage(message({ type: 'system', subtype: 'session_state_changed', state: 'requires_action' }));
  assert.equal(machine.state, 'working', "what it requires is the open entry's job to say");

  o.observeMessage(message({ type: 'system', subtype: 'session_state_changed', state: 'idle' }));
  assert.equal(machine.state, 'idle');
});

test('a result carries the turn to idle or to errored, and says which way', () => {
  const clean = observer();
  clean.observer.observeMessage(message({ type: 'result', subtype: 'success', duration_ms: 1200 }));
  assert.equal(clean.machine.state, 'idle');

  const broken = observer();
  broken.observer.observeMessage(
    message({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'api_error' }),
  );
  assert.equal(broken.machine.state, 'errored');
  assert.match(broken.store.all().at(-1)?.cause.detail ?? '', /api_error/);
});

test("a subagent is its own entry, and a tool inside it does not become the session's activity twice", () => {
  const { observer: o, machine } = observer();

  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 'tu-task' }));
  o.observeHook(hook({ hook_event_name: 'SubagentStart', agent_id: 'ag-1', agent_type: 'Explore' }));

  const subagentEntry = machine.openEntries().find((entry) => entry.entryId === 'ag-1');
  assert.equal(subagentEntry?.agentId, 'ag-1', 'an entry from inside a subagent says so');

  o.observeHook(hook({ hook_event_name: 'SubagentStop', agent_id: 'ag-1', agent_type: 'Explore' }));
  assert.deepEqual(machine.activity, { kind: 'tool', name: 'Task' }, 'the main thread is still on Task');
});

test('a directory change updates where for every later transition', () => {
  const { observer: o, machine, store } = observer();

  o.observeHook(hook({ hook_event_name: 'CwdChanged', old_cwd: '/tmp/w', new_cwd: '/tmp/w/sub' }));
  o.observeHook(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }));

  assert.equal(machine.where.cwd, '/tmp/w/sub');
  assert.equal(store.all().at(-1)?.where.cwd, '/tmp/w/sub');
  assert.equal(store.all().at(-1)?.where.branch, 'main', 'the rest of where survives the move');
});

test('a declined event records nothing at all — the table is the map, not this file', () => {
  const { observer: o, store } = observer();

  o.observeHook(hook({ hook_event_name: 'FileChanged', file_path: '/tmp/w/x.ts', event: 'change' }));
  o.observeHook(hook({ hook_event_name: 'Notification', message: 'hi', notification_type: 'info' }));
  o.observeMessage(message({ type: 'stream_event', event: {}, parent_tool_use_id: null }));
  o.observeMessage(message({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }));

  assert.equal(store.all().length, 0);
});

test('a session that dies mid-tool keeps the entry, marked, with its age', () => {
  const { observer: o, machine } = observer();

  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-1' }));
  o.ended({ kind: 'process', event: 'process_failed', detail: 'the stream threw' });

  const [stranded] = machine.openEntries();
  assert.equal(machine.state, 'ended');
  assert.equal(stranded?.entryId, 'tu-1');
  assert.notEqual(stranded?.abandonedAt, null, 'marked');
  assert.match(stranded?.abandonReason ?? '', /still open/);
});
