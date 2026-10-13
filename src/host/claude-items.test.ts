import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentItem, SessionPayload } from '../control/frames.js';
import { readAgentItem } from '../control/frames.js';
import { fixedTicker } from '../core/time.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import { SessionRegistry } from '../sessions/registry.js';
import { MESSAGE_COVERAGE } from '../state/coverage.js';
import { fakeAgents, settle } from '../test-support/fake-agent.js';
import type { HookInput, SDKMessage } from './agent-process.js';
import {
  CLAUDE_BLOCK_ITEMS,
  CLAUDE_ITEM_COVERAGE,
  CLAUDE_USER_BLOCK_ITEMS,
  ClaudeItemFill,
} from './claude-items.js';
import { composeSession } from './host.js';

const message = (shape: Record<string, unknown>): SDKMessage => shape as unknown as SDKMessage;

const assistant = (uuid: string, content: unknown[], parent: string | null = null): SDKMessage =>
  message({
    type: 'assistant',
    uuid,
    session_id: 'agent-session-1',
    parent_tool_use_id: parent,
    message: { id: `msg-${uuid}`, model: 'claude-opus-5', content, usage: {} },
  });

const user = (uuid: string, content: unknown, over: Record<string, unknown> = {}): SDKMessage =>
  message({
    type: 'user',
    uuid,
    session_id: 'agent-session-1',
    parent_tool_use_id: null,
    message: { role: 'user', content },
    ...over,
  });

const result = (over: Record<string, unknown> = {}): SDKMessage =>
  message({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    session_id: 'agent-session-1',
    is_error: false,
    ...over,
  });

test('every message kind and every block kind the SDK declares has a row, filled or declined', () => {
  assert.deepEqual(Object.keys(CLAUDE_ITEM_COVERAGE).sort(), Object.keys(MESSAGE_COVERAGE).sort());
  assert.equal(Object.keys(CLAUDE_BLOCK_ITEMS).length, 18, 'the assistant block kinds of the pinned SDK');
  assert.equal(Object.keys(CLAUDE_USER_BLOCK_ITEMS).length, 16, 'the user block kinds of the pinned SDK');
  const tables: readonly Readonly<Record<string, { readonly note: string }>>[] = [
    CLAUDE_ITEM_COVERAGE,
    CLAUDE_BLOCK_ITEMS,
    CLAUDE_USER_BLOCK_ITEMS,
  ];
  for (const table of tables) {
    for (const [kind, row] of Object.entries(table))
      assert.ok(row.note.length > 0, `${kind} states its reason`);
  }
});

test("an assistant message's blocks: text, thinking and a tool call, each an item, the call by its own id", () => {
  const items = new ClaudeItemFill('handle-1').fromMessage(
    assistant('a-1', [
      { type: 'thinking', thinking: 'First, the file.', signature: 's' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'Reading it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'toolu_2', name: 'mcp__docs__search', input: { q: 'x' } },
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
    ]),
  );
  assert.deepEqual(items, [
    {
      kind: 'thinking',
      itemId: 'a-1:0',
      turnId: null,
      text: 'First, the file.',
      summary: false,
      truncated: false,
    },
    { kind: 'thinking', itemId: 'a-1:1', turnId: null, text: '', summary: false, truncated: false },
    { kind: 'agent_text', itemId: 'a-1:2', turnId: null, text: 'Reading it.', final: null, truncated: false },
    {
      kind: 'tool_call',
      itemId: 'toolu_1',
      turnId: null,
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      toolKind: 'shell',
      input: { command: 'ls' },
      truncated: false,
    },
    {
      kind: 'tool_call',
      itemId: 'toolu_2',
      turnId: null,
      toolUseId: 'toolu_2',
      toolName: 'mcp__docs__search',
      toolKind: 'mcp',
      input: { q: 'x' },
      truncated: false,
    },
  ]);
});

test("control: a subagent's messages fill no item, and neither does a replayed or a plain-text user message", () => {
  const fill = new ClaudeItemFill('handle-1');
  assert.deepEqual(fill.fromMessage(assistant('a-2', [{ type: 'text', text: 'inner' }], 'toolu_task')), []);
  assert.deepEqual(
    fill.fromMessage(
      user('u-1', [{ type: 'tool_result', tool_use_id: 'toolu_inner', content: 'x' }], {
        parent_tool_use_id: 'toolu_task',
      }),
    ),
    [],
  );
  assert.deepEqual(
    fill.fromMessage(
      user('u-2', [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'x' }], { isReplay: true }),
    ),
    [],
  );
  assert.deepEqual(fill.fromMessage(user('u-3', 'a prompt as a string')), []);
  assert.deepEqual(
    fill.fromMessage(user('u-4', [{ type: 'text', text: 'injected' }], { isSynthetic: true })),
    [],
  );
});

test('a tool result: blocked when the gate refused it, declined when the agent refused it, failed on an error', () => {
  const fill = new ClaudeItemFill('handle-1');
  fill.gateBlocked('toolu_gate');
  fill.fromMessage(
    message({
      type: 'system',
      subtype: 'permission_denied',
      uuid: 'p-1',
      tool_name: 'Bash',
      tool_use_id: 'toolu_mode',
      message: 'no',
    }),
  );
  const items = fill.fromMessage(
    user('u-5', [
      { type: 'tool_result', tool_use_id: 'toolu_gate', content: 'denied by the gate', is_error: true },
      { type: 'tool_result', tool_use_id: 'toolu_mode', content: 'denied by the mode', is_error: true },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_bad',
        content: [{ type: 'text', text: 'exit 1' }],
        is_error: true,
      },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_ok',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
      { type: 'tool_result', tool_use_id: 'toolu_img', content: [{ type: 'image', source: {} }] },
    ]),
  );
  assert.deepEqual(
    items.map((item) => (item.kind === 'tool_result' ? [item.itemId, item.status, item.output] : null)),
    [
      ['toolu_gate:result', 'blocked', 'denied by the gate'],
      ['toolu_mode:result', 'declined', 'denied by the mode'],
      ['toolu_bad:result', 'failed', 'exit 1'],
      ['toolu_ok:result', 'completed', 'a\nb'],
      ['toolu_img:result', 'completed', null],
    ],
  );
  for (const item of items) {
    assert.ok(item.kind === 'tool_result');
    assert.equal(item.exitCode, null, 'Claude reports no exit code on a tool result: none is invented');
    assert.equal(item.durationMs, null);
    assert.equal(item.changes, null);
  }
});

test('a result ends the turn: completed, interrupted when the agent says it stopped, failed by subtype or error flag', () => {
  const fill = new ClaudeItemFill('handle-1');
  const turn = (over: Record<string, unknown>): unknown => {
    const [item] = fill.fromMessage(result(over));
    return item?.kind === 'turn' ? [item.itemId, item.status, item.detail] : null;
  };
  assert.deepEqual(turn({}), ['result-1', 'completed', null]);
  assert.deepEqual(turn({ terminal_reason: 'aborted_tools' }), ['result-1', 'interrupted', 'aborted_tools']);
  assert.deepEqual(turn({ subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] }), [
    'result-1',
    'failed',
    'error_max_turns: too many turns',
  ]);
  assert.deepEqual(turn({ is_error: true, result: 'Prompt is too long' }), [
    'result-1',
    'failed',
    'Prompt is too long',
  ]);
});

test('a compaction and a retried model call are notices', () => {
  const fill = new ClaudeItemFill('handle-1');
  assert.deepEqual(
    fill.fromMessage(
      message({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'c-1',
        compact_metadata: { trigger: 'auto', pre_tokens: 1 },
      }),
    ),
    [
      {
        kind: 'notice',
        itemId: 'c-1',
        turnId: null,
        level: 'info',
        text: 'the context was compacted (auto)',
        truncated: false,
      },
    ],
  );
  const [retry] = fill.fromMessage(
    message({
      type: 'system',
      subtype: 'api_retry',
      uuid: 'retry-1',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 500,
      error_status: 529,
      error: 'server_error',
    }),
  );
  assert.equal(retry?.kind === 'notice' ? retry.level : null, 'warning');
  assert.equal(
    retry?.kind === 'notice' ? retry.text : null,
    'a model call failed (status 529): server_error; retry 2 of 10',
  );
});

test("the prompt hook: a turn starts and its prompt is an item, each id the periscope session's key and count", async () => {
  const fill = new ClaudeItemFill('handle-7');
  const pushed: AgentItem[] = [];
  fill.attach((item) => pushed.push(item));
  const [matcher] = fill.hooks().UserPromptSubmit ?? [];
  const hook = matcher?.hooks[0];
  assert.ok(hook !== undefined);
  const input = (prompt: string): HookInput =>
    ({ hook_event_name: 'UserPromptSubmit', session_id: 'agent-session-1', prompt }) as unknown as HookInput;
  assert.deepEqual(await hook(input('first'), undefined, { signal: new AbortController().signal }), {});
  await hook(input('second'), undefined, { signal: new AbortController().signal });
  assert.deepEqual(
    pushed.map((item) => [
      item.kind,
      item.itemId,
      item.kind === 'user_text' ? item.text : item.kind === 'turn' ? item.status : null,
    ]),
    [
      ['turn', 'handle-7:prompt:1:turn', 'started'],
      ['user_text', 'handle-7:prompt:1', 'first'],
      ['turn', 'handle-7:prompt:2:turn', 'started'],
      ['user_text', 'handle-7:prompt:2', 'second'],
    ],
  );
});

test('control: a prompt hook whose lane throws still answers, and reports the throw', async () => {
  const fill = new ClaudeItemFill('handle-1');
  fill.attach(() => {
    throw new Error('the lane broke');
  });
  const failures: unknown[] = [];
  const hook = fill.hooks((error) => failures.push(error)).UserPromptSubmit?.[0]?.hooks[0];
  assert.ok(hook !== undefined);
  const answer = await hook(
    { hook_event_name: 'UserPromptSubmit', prompt: 'p' } as unknown as HookInput,
    undefined,
    { signal: new AbortController().signal },
  );
  assert.deepEqual(answer, {});
  assert.equal(failures.length, 1);
});

/** A composed Claude session over a fake agent, with everything it put on the wire. */
async function composed(decide: () => Promise<unknown>) {
  const fake = fakeAgents();
  const registry = new SessionRegistry({
    baseEnv: { PATH: 'p' },
    homeDir: 'C:/nonexistent-home-for-tests',
    startProcess: fake.start,
  });
  const sent: SessionPayload[] = [];
  const sink = {
    send(_sessionId: string, payload: SessionPayload): Result<void> {
      sent.push(payload);
      return ok(undefined);
    },
  };
  const session = composeSession({
    registry,
    sessionKey: 'handle-9',
    cwd: 'C:/work',
    sink,
    decide: decide,
    clock: () => '2000-01-01T00:00:00.000Z',
    ticker: fixedTicker(0),
  });
  assert.ok(session.ok, session.ok ? '' : session.refusal.detail);
  const agent = fake.started[0];
  assert.ok(agent !== undefined);
  const items = (): AgentItem[] =>
    sent.flatMap((payload) => {
      if (payload.kind !== 'session_update') return [];
      const read = readAgentItem(payload.body);
      return read === null ? [] : [read.item];
    });
  return { agent, items, sent };
}

test("a composed Claude session: the prompt hook's items, then a call the gate denied ends blocked", async () => {
  const { agent, items, sent } = await composed(async () => ({ behavior: 'deny', message: 'not here' }));
  const run = async (event: string, extra: Record<string, unknown>, toolUseId?: string): Promise<void> => {
    for (const matcher of agent.request.hooks?.[event as 'PreToolUse'] ?? []) {
      for (const hook of matcher.hooks) {
        await hook(
          { hook_event_name: event, session_id: 'agent-session-1', ...extra } as unknown as HookInput,
          toolUseId,
          {
            signal: new AbortController().signal,
          },
        );
      }
    }
  };
  await run('UserPromptSubmit', { prompt: 'list the files' });
  await run(
    'PreToolUse',
    { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_d', cwd: 'C:/work' },
    'toolu_d',
  );
  agent.emit(
    user('u-9', [{ type: 'tool_result', tool_use_id: 'toolu_d', content: 'not here', is_error: true }]),
  );
  await settle();
  assert.deepEqual(
    items().map((item) => [item.kind, item.itemId, item.kind === 'tool_result' ? item.status : null]),
    [
      ['turn', 'handle-9:prompt:1:turn', null],
      ['user_text', 'handle-9:prompt:1', null],
      ['tool_result', 'toolu_d:result', 'blocked'],
    ],
  );
  const runtimes = sent.flatMap((payload) => {
    if (payload.kind !== 'session_update') return [];
    const read = readAgentItem(payload.body);
    return read === null ? [] : [read.runtime];
  });
  assert.deepEqual([...new Set(runtimes)], ['claude'], "a Claude session's items name their runtime");
});
