import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentItem, JsonObject } from '../control/frames.js';
import { CODEX_ITEM_COVERAGE } from '../state/codex-coverage.js';
import { CODEX_NAMES, codexWireKey } from './codex-names.js';
import { CODEX_ITEM_FILLS, CodexItemFill } from './codex-items.js';
import type { CodexMessage } from './codex-wire.js';

const THREAD = 'thread-1';

/** The wire key Codex gives an agent message's stage, read from the names snapshot, never spelled. */
const STAGE = codexWireKey('agentMessage', 'stage');

const notification = (method: string, params: JsonObject): CodexMessage => ({
  kind: 'notification',
  method,
  params,
});

/** A fill that has read the answer that opened its thread. */
function opened(): CodexItemFill {
  const fill = new CodexItemFill();
  fill.fromMessage({
    kind: 'answer',
    method: 'thread/start',
    params: {},
    result: { thread: { id: THREAD }, model: 'gpt-6-sol', reasoningEffort: null },
  });
  return fill;
}

const completed = (item: JsonObject, threadId = THREAD): CodexMessage =>
  notification('item/completed', { threadId, turnId: 'turn-1', item, completedAtMs: 1 });

const started = (item: JsonObject, threadId = THREAD): CodexMessage =>
  notification('item/started', { threadId, turnId: 'turn-1', item, startedAtMs: 1 });

const one = (items: readonly AgentItem[]): AgentItem => {
  assert.equal(items.length, 1, JSON.stringify(items));
  return items[0] as AgentItem;
};

test('every item kind of the pinned release fills the items its coverage row names, and a declined kind fills none', () => {
  assert.deepEqual(Object.keys(CODEX_ITEM_FILLS).sort(), [...CODEX_NAMES.itemKinds].sort());
  for (const [kind, fills] of Object.entries(CODEX_ITEM_FILLS)) {
    const row = CODEX_ITEM_COVERAGE[kind as keyof typeof CODEX_ITEM_COVERAGE];
    assert.equal(fills.length > 0, row.handling === 'wired', `${kind}: wired exactly when it fills an item`);
    for (const filled of fills)
      assert.match(row.note, new RegExp(filled.replace('_', '.?')), `${kind}'s note names ${filled}`);
  }
});

test('an agent message: final_answer is the answer, commentary and partial_answer are not, no stage says nothing', () => {
  const fill = opened();
  const final = (stage: unknown): unknown => {
    const item = one(
      fill.fromMessage(
        completed({
          type: 'agentMessage',
          id: `m-${String(stage)}`,
          text: 'done',
          ...(stage === undefined ? {} : { [STAGE]: stage }),
        }),
      ),
    );
    return item.kind === 'agent_text' ? item.final : 'not agent text';
  };
  assert.equal(final('final_answer'), true);
  assert.equal(final('commentary'), false);
  assert.equal(final('partial_answer'), false);
  assert.equal(final(undefined), null, 'no stage: null, never guessed');
  assert.equal(final(null), null);
  assert.equal(final('summary_draft'), null, 'a word this host does not know: null');
  assert.equal(final('constructor'), null, 'a word is read off the table, never its prototype');
});

test('control: a completed command states exactly what it reported: no exit code, duration or output is invented', () => {
  const fill = opened();
  const [call, result] = fill.fromMessage(
    completed({
      type: 'commandExecution',
      id: 'call-1',
      command: 'ls',
      cwd: '/w',
      status: 'completed',
      commandActions: [],
    }),
  );
  assert.deepEqual(call, {
    kind: 'tool_call',
    itemId: 'call-1',
    turnId: 'turn-1',
    toolUseId: 'call-1',
    toolName: 'Bash',
    toolKind: 'shell',
    input: { command: 'ls', cwd: '/w' },
    truncated: false,
  });
  assert.deepEqual(result, {
    kind: 'tool_result',
    itemId: 'call-1:result',
    turnId: 'turn-1',
    toolUseId: 'call-1',
    status: 'completed',
    output: null,
    exitCode: null,
    durationMs: null,
    changes: null,
    truncated: false,
  });
  const [reported] = opened()
    .fromMessage(
      completed({
        type: 'commandExecution',
        id: 'call-2',
        command: 'false',
        cwd: '/w',
        status: 'failed',
        aggregatedOutput: 'nope',
        exitCode: 1,
        durationMs: 31,
      }),
    )
    .slice(-1);
  assert.deepEqual(
    reported?.kind === 'tool_result'
      ? [reported.status, reported.output, reported.exitCode, reported.durationMs]
      : null,
    ['failed', 'nope', 1, 31],
  );
});

test('a tool call is stated once, at its start; its completion adds only the result, a declined one included', () => {
  const fill = opened();
  const call = one(
    fill.fromMessage(
      started({ type: 'commandExecution', id: 'call-3', command: 'rm x', cwd: '/w', status: 'inProgress' }),
    ),
  );
  assert.equal(call.kind, 'tool_call');
  const [result] = fill.fromMessage(
    completed({ type: 'commandExecution', id: 'call-3', command: 'rm x', cwd: '/w', status: 'declined' }),
  );
  assert.deepEqual(result?.kind === 'tool_result' ? [result.itemId, result.status] : null, [
    'call-3:result',
    'declined',
  ]);
  assert.equal(
    fill.fromMessage(
      completed({ type: 'commandExecution', id: 'call-4', status: 'inProgress', command: 'x' }),
    ).length,
    1,
    'still running: the call, no result',
  );
});

test('a file change: each change as reported, a move with its path, a diff absent stays null', () => {
  const [call, result] = opened().fromMessage(
    completed({
      type: 'fileChange',
      id: 'patch-1',
      status: 'completed',
      changes: [
        { path: '/w/a.ts', kind: { type: 'add' }, diff: 'new file' },
        { path: '/w/b.ts', kind: { type: 'update', move_path: '/w/c.ts' }, diff: '@@ -1 +1 @@' },
        { path: '/w/d.ts', kind: { type: 'delete' } },
        { path: '/w/e.ts', kind: { type: 'rename' }, diff: 'x' },
      ],
    }),
  );
  assert.deepEqual(call?.kind === 'tool_call' ? [call.toolName, call.toolKind, call.input] : null, [
    'apply_patch',
    'file_edit',
    { paths: ['/w/a.ts', '/w/b.ts', '/w/d.ts', '/w/e.ts'] },
  ]);
  assert.ok(result?.kind === 'tool_result');
  assert.deepEqual(result.changes, [
    { path: '/w/a.ts', change: 'add', movePath: null, diff: 'new file' },
    { path: '/w/b.ts', change: 'update', movePath: '/w/c.ts', diff: '@@ -1 +1 @@' },
    { path: '/w/d.ts', change: 'delete', movePath: null, diff: null },
  ]);
  assert.equal(result.truncated, true, 'a change of a kind this host does not know is left out, and says so');
  assert.equal(result.exitCode, null);
});

test('an MCP call, an image view, a web search, an image and a collaboration call each fill a call and a result', () => {
  const fill = opened();
  const kinds = (item: JsonObject): unknown =>
    fill
      .fromMessage(completed(item))
      .map((one) =>
        one.kind === 'tool_call'
          ? [one.toolName, one.toolKind]
          : one.kind === 'tool_result'
            ? [one.status, one.output]
            : one.kind,
      );
  assert.deepEqual(
    kinds({
      type: 'mcpToolCall',
      id: 'm-1',
      server: 'docs',
      tool: 'search',
      status: 'completed',
      arguments: { q: 'x' },
      result: { content: [{ type: 'text', text: 'hit' }] },
    }),
    [
      ['mcp__docs__search', 'mcp'],
      ['completed', '[{"type":"text","text":"hit"}]'],
    ],
  );
  assert.deepEqual(
    kinds({
      type: 'mcpToolCall',
      id: 'm-2',
      server: 'docs',
      tool: 'search',
      status: 'failed',
      arguments: {},
      error: { message: 'declined' },
    }),
    [
      ['mcp__docs__search', 'mcp'],
      ['failed', 'declined'],
    ],
  );
  assert.deepEqual(kinds({ type: 'imageView', id: 'v-1', path: '/w/a.png' }), [
    ['view_image', 'file_read'],
    ['completed', null],
  ]);
  assert.deepEqual(kinds({ type: 'webSearch', id: 'w-1', query: 'q', action: null, results: null }), [
    ['web_search', 'web'],
    ['completed', null],
  ]);
  assert.deepEqual(
    kinds({
      type: 'imageGeneration',
      id: 'g-1',
      status: 'done',
      result: 'b64',
      revisedPrompt: null,
      failure: { type: 'usageLimitExceeded' },
    }),
    [
      ['image_generation', 'other'],
      ['failed', 'usageLimitExceeded'],
    ],
  );
  assert.deepEqual(
    kinds({
      type: 'collabAgentToolCall',
      id: 'c-1',
      tool: 'spawnAgent',
      status: 'interrupted',
      receiverThreadIds: ['a'],
      prompt: 'p',
      agentsStates: {},
    }),
    [
      ['spawnAgent', 'other'],
      ['failed', null],
    ],
  );
});

test('the prompt, reasoning, a plan, and the notices each fill their items', () => {
  const fill = opened();
  assert.deepEqual(
    one(
      fill.fromMessage(
        completed({
          type: 'userMessage',
          id: 'u-1',
          clientId: null,
          content: [
            { type: 'text', text: 'hi', text_elements: [] },
            { type: 'localImage', path: '/x' },
          ],
        }),
      ),
    ),
    { kind: 'user_text', itemId: 'u-1', turnId: 'turn-1', text: 'hi', truncated: false },
  );
  assert.deepEqual(
    fill
      .fromMessage(completed({ type: 'reasoning', id: 'reason-1', summary: ['a', 'b'], content: ['raw'] }))
      .map((item) => [item.itemId, item.kind === 'thinking' ? [item.summary, item.text] : null]),
    [
      ['reason-1', [true, 'a\n\nb']],
      ['reason-1:raw', [false, 'raw']],
    ],
  );
  assert.deepEqual(
    one(fill.fromMessage(completed({ type: 'reasoning', id: 'reason-2', summary: [], content: [] }))),
    { kind: 'thinking', itemId: 'reason-2', turnId: 'turn-1', text: '', summary: false, truncated: false },
  );
  const plan = one(
    fill.fromMessage(
      notification('turn/plan/updated', {
        threadId: THREAD,
        turnId: 'turn-1',
        explanation: 'Two steps.',
        plan: [
          { step: 'read', status: 'completed' },
          { step: 'write', status: 'inProgress' },
        ],
      }),
    ),
  );
  assert.deepEqual(plan.kind === 'plan' ? [plan.itemId, plan.text] : null, [
    'turn-1:plan:1',
    'Two steps.\n- [completed] read\n- [inProgress] write',
  ]);
  const levels = [
    notification('error', {
      threadId: THREAD,
      turnId: 'turn-1',
      willRetry: true,
      error: { message: 'slow', codexErrorInfo: 'serverOverloaded' },
    }),
    notification('error', {
      threadId: THREAD,
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'gone', codexErrorInfo: null },
    }),
    notification('warning', { threadId: null, message: 'careful' }),
    notification('configWarning', { summary: 'odd key', details: 'line 3' }),
    notification('deprecationNotice', { summary: 'old', details: null }),
    completed({ type: 'hookPrompt', id: 'h-1', fragments: [{ text: 'context', hookRunId: 'r' }] }),
    completed({ type: 'contextCompaction', id: 'cc-1' }),
    completed({
      type: 'subAgentActivity',
      id: 's-1',
      kind: 'started',
      agentThreadId: 'agent-a',
      agentPath: 'p',
    }),
  ].map((message) => {
    const item = one(fill.fromMessage(message));
    return item.kind === 'notice' ? [item.level, item.text] : null;
  });
  assert.deepEqual(levels, [
    ['warning', 'slow (serverOverloaded)'],
    ['error', 'gone'],
    ['warning', 'careful'],
    ['warning', 'odd key: line 3'],
    ['info', 'old'],
    ['info', 'context'],
    ['info', 'the context was compacted'],
    ['info', 'sub-agent agent-a started'],
  ]);
});

test('a turn: started, then completed, interrupted or failed with its error; in progress fills nothing', () => {
  const fill = opened();
  const turn = (method: string, status: string, error: JsonObject | null = null): unknown =>
    fill
      .fromMessage(notification(method, { threadId: THREAD, turn: { id: 't-9', status, error } }))
      .map((item) => (item.kind === 'turn' ? [item.itemId, item.status, item.detail] : null));
  assert.deepEqual(turn('turn/started', 'inProgress'), [['t-9:started', 'started', null]]);
  assert.deepEqual(
    turn('turn/completed', 'failed', {
      message: 'quota',
      codexErrorInfo: 'usageLimitExceeded',
      additionalDetails: 'wait',
    }),
    [['t-9:completed', 'failed', 'quota (usageLimitExceeded) - wait']],
  );
  assert.deepEqual(turn('turn/completed', 'interrupted'), [['t-9:completed', 'interrupted', null]]);
  assert.deepEqual(turn('turn/completed', 'inProgress'), [], 'a turn still in progress is no end');
});

test("control: only the session's own thread fills items, and nothing fills before the thread is known", () => {
  const before = new CodexItemFill();
  assert.deepEqual(before.fromMessage(completed({ type: 'agentMessage', id: 'm-0', text: 'early' })), []);
  const fill = opened();
  assert.deepEqual(
    fill.fromMessage(completed({ type: 'agentMessage', id: 'm-1', text: 'from a sub-agent' }, 'thread-sub')),
    [],
  );
  assert.deepEqual(
    fill.fromMessage(
      notification('turn/started', { threadId: 'thread-sub', turn: { id: 't', status: 'inProgress' } }),
    ),
    [],
  );
  assert.deepEqual(
    fill.fromMessage(notification('warning', { threadId: 'thread-sub', message: 'theirs' })),
    [],
  );
  assert.equal(fill.fromMessage(completed({ type: 'agentMessage', id: 'm-2', text: 'mine' })).length, 1);
});

test('the declined kinds fill nothing', () => {
  const fill = opened();
  for (const type of [
    'functionCallOutput',
    'dynamicToolCall',
    'sleep',
    'enteredReviewMode',
    'exitedReviewMode',
  ]) {
    assert.deepEqual(fill.fromMessage(completed({ type, id: `x-${type}` })), [], type);
    assert.deepEqual(CODEX_ITEM_FILLS[type as keyof typeof CODEX_ITEM_FILLS], [], type);
  }
});
