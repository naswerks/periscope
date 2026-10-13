import test from 'node:test';
import assert from 'node:assert/strict';

import { encode } from './codec.js';
import type { AgentItem, FileChangeEntry, Frame } from './frames.js';
import { MAX_AGENT_ITEM_BYTES, MAX_FACT_LIST_ENTRIES, agentItemUpdate } from './frames.js';
import { agentItemBytes, fitAgentItem, prefixWithin } from './item-budget.js';

const AT = '2000-01-01T00:00:00.000Z';

const frameOf = (item: AgentItem): Frame => ({
  frame: 'session',
  sessionId: 'session-1',
  seq: 1,
  at: AT,
  payload: agentItemUpdate('claude', item, AT),
});

const text = (length: number, unit = 'x'): string => unit.repeat(length);

/** A character outside the basic plane: two UTF-16 units, so a cut between them would split it. */
const WIDE = String.fromCodePoint(0x1f600);

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

test('an item within the budget is returned as it is, its truncated as the filler set it', () => {
  const item: AgentItem = {
    kind: 'agent_text',
    itemId: 'i',
    turnId: null,
    text: 'hello',
    final: null,
    truncated: false,
  };
  assert.equal(fitAgentItem(item), item);
});

test('a text past the budget is cut to fit and says so', () => {
  const item: AgentItem = {
    kind: 'agent_text',
    itemId: 'i',
    turnId: 't',
    text: text(MAX_AGENT_ITEM_BYTES * 2),
    final: true,
    truncated: false,
  };
  const fitted = fitAgentItem(item);
  assert.equal(fitted.truncated, true, 'a cut is never silent');
  assert.ok(agentItemBytes(fitted) <= MAX_AGENT_ITEM_BYTES, 'the item fits the budget');
  assert.ok(fitted.kind === 'agent_text' && item.text.startsWith(fitted.text), 'the cut keeps the start');
  assert.ok(agentItemBytes(fitted) > MAX_AGENT_ITEM_BYTES - 16, 'the cut takes no more than it must');
  assert.ok(encode(frameOf(fitted)).ok, 'the fitted item encodes');
});

test('control: an item past the budget does not encode, so a cut that was skipped cannot reach the wire', () => {
  const item: AgentItem = {
    kind: 'plan',
    itemId: 'i',
    turnId: null,
    text: text(MAX_AGENT_ITEM_BYTES),
    truncated: false,
  };
  const encoded = encode(frameOf(item));
  assert.equal(encoded.ok, false);
  assert.match(
    encoded.ok ? '' : encoded.refusal.detail,
    new RegExp(`over the ${MAX_AGENT_ITEM_BYTES} an item takes`),
  );
});

test('the cut never splits a character, whatever unit the budget lands on', () => {
  for (let shift = 0; shift < 4; shift += 1) {
    const item: AgentItem = {
      kind: 'thinking',
      itemId: 'i',
      turnId: null,
      text: text(shift) + WIDE.repeat(MAX_AGENT_ITEM_BYTES),
      summary: true,
      truncated: false,
    };
    const fitted = fitAgentItem(item);
    assert.ok(fitted.kind === 'thinking');
    assert.equal(isHighSurrogate(fitted.text.charCodeAt(fitted.text.length - 1)), false, `shift ${shift}`);
    assert.ok(agentItemBytes(fitted) <= MAX_AGENT_ITEM_BYTES);
  }
  assert.equal(prefixWithin(`a${WIDE}`, JSON.stringify(`a${WIDE}`).length + 2), `a${WIDE}`);
  assert.equal(prefixWithin(`a${WIDE}`, 4), 'a', 'a wide character is kept whole or left out whole');
});

test('text that JSON escapes is measured as it rides, escapes included', () => {
  const item: AgentItem = {
    kind: 'notice',
    itemId: 'i',
    turnId: null,
    level: 'warning',
    text: text(MAX_AGENT_ITEM_BYTES, '"\n\u0001'),
    truncated: false,
  };
  const fitted = fitAgentItem(item);
  assert.equal(fitted.truncated, true);
  assert.ok(agentItemBytes(fitted) <= MAX_AGENT_ITEM_BYTES);
  assert.ok(encode(frameOf(fitted)).ok);
});

test('a tool call input past the budget is left out whole, never cut', () => {
  const item: AgentItem = {
    kind: 'tool_call',
    itemId: 'toolu_1',
    turnId: null,
    toolUseId: 'toolu_1',
    toolName: 'Write',
    toolKind: 'file_write',
    input: { file_path: '/work/a.txt', content: text(MAX_AGENT_ITEM_BYTES) },
    truncated: false,
  };
  const fitted = fitAgentItem(item);
  assert.equal(fitted.kind === 'tool_call' ? fitted.input : 'x', null);
  assert.equal(fitted.truncated, true);
  assert.equal(fitted.kind === 'tool_call' ? fitted.toolName : null, 'Write', 'the call itself is kept');
});

test('a tool result is cut in its longest text first: the output before a short diff', () => {
  const change: FileChangeEntry = {
    path: '/work/a.txt',
    change: 'update',
    movePath: null,
    diff: '@@ -1 +1 @@',
  };
  const item: AgentItem = {
    kind: 'tool_result',
    itemId: 'r',
    turnId: null,
    toolUseId: 'call-1',
    status: 'completed',
    output: text(MAX_AGENT_ITEM_BYTES * 3),
    exitCode: 0,
    durationMs: 12,
    changes: [change],
    truncated: false,
  };
  const fitted = fitAgentItem(item);
  assert.ok(fitted.kind === 'tool_result');
  assert.equal(fitted.changes?.[0]?.diff, '@@ -1 +1 @@', 'the short diff stands');
  assert.ok((fitted.output ?? '').length < MAX_AGENT_ITEM_BYTES * 3);
  assert.equal(fitted.exitCode, 0);
  assert.equal(fitted.truncated, true);
});

test('a change list longer than a fact list may be is held to it, and says so', () => {
  const changes: FileChangeEntry[] = Array.from({ length: MAX_FACT_LIST_ENTRIES + 3 }, (_, index) => ({
    path: `/f/${index}`,
    change: 'add',
    movePath: null,
    diff: null,
  }));
  const item: AgentItem = {
    kind: 'tool_result',
    itemId: 'r',
    turnId: null,
    toolUseId: 'call-1',
    status: 'completed',
    output: null,
    exitCode: null,
    durationMs: null,
    changes,
    truncated: false,
  };
  const fitted = fitAgentItem(item);
  assert.equal(fitted.kind === 'tool_result' ? fitted.changes?.length : 0, MAX_FACT_LIST_ENTRIES);
  assert.equal(fitted.truncated, true);
  assert.ok(encode(frameOf(fitted)).ok);
});
