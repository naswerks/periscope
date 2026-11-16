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

test('a granted permission gets its exit from the call having run, in the order the CLI sends a call', () => {
  const { observer: o, machine, store } = observer();

  // A call as the pinned CLI was recorded sending it: its PreToolUse, then the permission request, and,
  // granted, the tool's own end.
  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'tu-1' }));
  o.observeHook(hook({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: {} }));
  assert.deepEqual(machine.activity, { kind: 'permission', name: 'Write' });
  o.observeHook(hook({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'tu-1' }));

  assert.deepEqual(machine.openEntries(), [], 'an entry with no exit on the allow path would age forever');
  const permission = store.all().filter((transition) => transition.entryId === 'permission:Write');
  assert.equal(permission.length, 2, 'the permission entry opened and closed');
  assert.equal(permission[1]?.cause.event, 'PostToolUse');
  assert.match(permission[1]?.cause.detail ?? '', /the permission for Write was granted and the tool ran/);

  // A tool that ran and failed had its permission granted all the same.
  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'tu-2' }));
  o.observeHook(hook({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: {} }));
  o.observeHook(
    hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Write', tool_use_id: 'tu-2', error: 'no' }),
  );
  assert.deepEqual(machine.openEntries(), []);

  // Control: a tool that ends with no permission outstanding records its own end and nothing else.
  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'tu-3' }));
  const before = store.all().length;
  o.observeHook(hook({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'tu-3' }));
  assert.deepEqual(
    store
      .all()
      .slice(before)
      .map((transition) => transition.entryId),
    ['tu-3'],
  );
});

test("another call's start is no resolution: a permission outstanding for one call stays open when the same tool is called again", () => {
  const { observer: o, machine, store } = observer();

  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'tu-a' }));
  o.observeHook(hook({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: {} }));
  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'tu-b' }));

  assert.ok(
    machine.openEntries().some((entry) => entry.activity.kind === 'permission'),
    'the second call closed a permission nobody had answered',
  );
  assert.equal(
    store.all().some((transition) => /resolved and the tool is running/.test(transition.cause.detail)),
    false,
    'the trace recorded a resolution that never happened',
  );
});

test("the CLI's own report of a denial closes the permission it asked for, once, whichever of the message and the hook reports it", () => {
  const denied = (toolUseId: string): SDKMessage =>
    message({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Write',
      tool_use_id: toolUseId,
      decision_reason_type: 'mode',
      message: 'This command requires approval',
    });
  const deniedHook = (toolUseId: string): HookInput =>
    hook({
      hook_event_name: 'PermissionDenied',
      tool_name: 'Write',
      tool_input: {},
      tool_use_id: toolUseId,
      reason: 'not allowed here',
    });
  const { observer: o, machine, store } = observer();

  // Two calls as the pinned CLI was recorded sending them when nobody grants: each call's PreToolUse, the
  // permission request, and the denial as a message. The PermissionDenied hook does not fire.
  for (const id of ['tu-a', 'tu-b']) {
    o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: id }));
    o.observeHook(hook({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: {} }));
    assert.deepEqual(machine.activity, { kind: 'permission', name: 'Write' });
    o.observeMessage(denied(id));
    assert.equal(
      machine.openEntries().some((entry) => entry.activity.kind === 'permission'),
      false,
      'the denial left its permission open',
    );
  }
  const closes = store
    .all()
    .filter(
      (transition) => transition.entryId === 'permission:Write' && /was denied/.test(transition.cause.detail),
    );
  assert.deepEqual(
    closes.map((transition) => [transition.cause.kind, transition.cause.event]),
    [
      ['sdk-message', 'system/permission_denied'],
      ['sdk-message', 'system/permission_denied'],
    ],
  );
  assert.match(closes[0]?.cause.detail ?? '', /Write was denied \(mode\): This command requires approval/);
  assert.equal(
    store.all().some((transition) => /resolved and the tool is running/.test(transition.cause.detail)),
    false,
  );

  // One denial reported both ways is one denial, in either order.
  const count = (): number =>
    store.all().filter((transition) => /was denied/.test(transition.cause.detail)).length;
  for (const [id, first, second] of [
    ['tu-c', () => o.observeHook(deniedHook('tu-c')), () => o.observeMessage(denied('tu-c'))],
    ['tu-d', () => o.observeMessage(denied('tu-d')), () => o.observeHook(deniedHook('tu-d'))],
  ] as const) {
    o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: id }));
    o.observeHook(hook({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: {} }));
    const before = count();
    first();
    second();
    assert.equal(count() - before, 1, `${id}: one denial was recorded twice`);
  }

  // Control: a denial with no permission of this lane's outstanding (one this host's own gate made)
  // records nothing here: the gate's outcome is its record.
  const before = store.all().length;
  o.observeMessage(denied('tu-e'));
  assert.equal(store.all().length, before);
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

test("a model request is closed by the answer that arrives for it, and never outlives its turn: the CLI states a request's start and not its end", () => {
  const { observer: o, machine, store } = observer();
  const requesting = message({ type: 'system', subtype: 'status', status: 'requesting' });
  const answer = (id: string, parent: string | null = null): SDKMessage =>
    message({ type: 'assistant', parent_tool_use_id: parent, message: { id, content: [] } });
  const result = (subtype = 'success'): SDKMessage => message({ type: 'result', subtype, duration_ms: 5 });
  const open = (): string[] => machine.openEntries().map((entry) => entry.activity.kind);

  // One turn as the pinned CLI was recorded sending it: a status at each request's start, the answer,
  // the tool's hooks, a second request and its answer, the stop and the result. No status ends a request.
  o.observeHook(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }));
  o.observeMessage(requesting);
  assert.deepEqual(machine.activity, { kind: 'requesting', name: null });
  o.observeMessage(answer('msg-1'));
  assert.deepEqual(open(), [], 'the request stayed open after its answer arrived');
  const closed = store.all().at(-1);
  assert.deepEqual(
    [closed?.cause.kind, closed?.cause.event, closed?.to],
    ['sdk-message', 'assistant', 'working'],
    'the close is not named for the message that caused it',
  );
  o.observeHook(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-1' }));
  o.observeHook(hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-1' }));
  o.observeMessage(requesting);
  // A sub-agent's message is not the answer to the session's own request.
  o.observeMessage(answer('msg-sub', 'toolu_task'));
  assert.deepEqual(open(), ['requesting']);
  o.observeMessage(answer('msg-2'));
  assert.deepEqual(open(), []);
  o.observeHook(hook({ hook_event_name: 'Stop' }));
  o.observeMessage(result());
  assert.equal(machine.state, 'idle');
  assert.deepEqual(open(), [], 'a model request was still open after the turn');

  // A request that gets no answer ends with its turn, by the stop or by the result, whichever arrives.
  o.observeMessage(requesting);
  o.observeHook(hook({ hook_event_name: 'Stop' }));
  assert.deepEqual(open(), [], 'the stop left a model request open');
  o.observeMessage(requesting);
  o.observeMessage(result('error_during_execution'));
  assert.deepEqual(open(), [], 'the result left a model request open');

  // Control: with no request open, an answer records nothing, and a stop and a result name no entry.
  const before = store.all().length;
  o.observeMessage(answer('msg-3'));
  assert.equal(store.all().length, before, 'an answer with no request open was recorded');
  o.observeHook(hook({ hook_event_name: 'Stop' }));
  o.observeMessage(result());
  assert.deepEqual(
    store
      .all()
      .slice(before)
      .map((transition) => transition.entryId),
    [null, null],
  );
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

test('a model switch is recorded once, as it happened, with what it cost the prompt cache', () => {
  const { observer: o, machine, store } = observer();
  o.observeHook(hook({ hook_event_name: 'UserPromptSubmit' }));
  const before = store.all().length;

  o.observeHook(
    hook({
      hook_event_name: 'PostModelSwitch',
      from_model: 'model-a',
      to_model: 'model-b',
      requested_model: 'model-b',
      source: 'sdk',
      context_tokens: 41_000,
      prompt_cache_warm: true,
      cache_ttl: '1h',
      estimated_cache_write_usd: 0.33,
      pricing: 'catalog',
    }),
  );

  assert.equal(store.all().length - before, 1, 'one switch, one record');
  const record = store.all().at(-1);
  assert.equal(record?.cause.kind, 'hook');
  assert.equal(record?.cause.event, 'PostModelSwitch');
  assert.equal(record?.to, 'working', 'a switch changes no state');
  for (const fact of ['model-a', 'model-b', '(sdk)', 'warm', '1h', '41000', '$0.33', 'catalog']) {
    assert.ok(
      (record?.cause.detail ?? '').includes(fact),
      `the detail lost "${fact}": ${record?.cause.detail}`,
    );
  }
  assert.equal(machine.rejectedCount, 0, 'PostModelSwitch is a declared cause event');
});

test('regression: only the first init reports readiness; a later one arrives mid-turn and records nothing', () => {
  // The CLI re-sends its init with current values at every later turn. Recording `ready` for each
  // one moved a working session backwards in the middle of its turn.
  const { observer: o, machine, store } = observer();
  o.observeMessage(message({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'model-a' }));
  o.observeHook(hook({ hook_event_name: 'UserPromptSubmit' }));
  assert.equal(machine.state, 'working');

  const later = o.observeMessage(
    message({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'model-b' }),
  );

  assert.deepEqual(later, [], 'a later init recorded a transition');
  assert.equal(machine.state, 'working', 'the session moved backwards mid-turn');
  assert.equal(store.all().filter((transition) => transition.to === 'ready').length, 1);
});

test('regression: a refusal with no fallback is recorded, not refused as an unnamed cause', () => {
  // The observer always recorded it, but the event was missing from the declared vocabulary, so the
  // machine refused every such transition as `transition-cause-unnamed` and the trace never had it.
  const { observer: o, machine, store } = observer();
  o.observeHook(hook({ hook_event_name: 'UserPromptSubmit' }));
  const before = store.all().length;

  const recorded = o.observeMessage(
    message({
      type: 'system',
      subtype: 'model_refusal_no_fallback',
      original_model: 'model-a',
      api_refusal_category: 'cyber',
      request_id: null,
      content: '',
    }),
  );

  assert.equal(machine.rejectedCount, 0, 'the refusal was rejected as an unnamed cause');
  assert.ok(recorded.every((result) => result.ok));
  assert.equal(store.all().length - before, 1);
  const record = store.all().at(-1);
  assert.equal(record?.cause.kind, 'sdk-message');
  assert.equal(record?.cause.event, 'system/model_refusal_no_fallback');
  assert.match(record?.cause.detail ?? '', /model-a, category cyber/);
});

test('the ask before a model switch records nothing; a deny or an unconfirmed id would cancel it', () => {
  const { observer: o, store } = observer();
  o.observeHook(hook({ hook_event_name: 'PreModelSwitch', from_model: 'model-a', to_model: 'model-b' }));
  assert.equal(store.all().length, 0);
});
