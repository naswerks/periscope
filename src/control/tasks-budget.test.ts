import test from 'node:test';
import assert from 'node:assert/strict';

import { decode } from './codec.js';
import type { RunningTaskEntry, SettledTaskEntry } from './frames.js';
import { MAX_FACT_LIST_ENTRIES, MAX_FACT_TEXT_LENGTH } from './frames.js';
import { agentItemBytes } from './item-budget.js';
import { MAX_TASKS_FACT_BYTES, SHORTEST_TASK_TEXT, fitTasks } from './tasks-budget.js';

const settledTask = (index: number, over: Partial<SettledTaskEntry> = {}): SettledTaskEntry => ({
  taskId: `task-${String(index).padStart(4, '0')}`,
  type: 'local_agent',
  status: 'completed',
  toolUseId: `toolu_${index}`,
  ...over,
});

const runningTask = (index: number, over: Partial<RunningTaskEntry> = {}): RunningTaskEntry => ({
  taskId: `run-${String(index).padStart(4, '0')}`,
  type: 'local_agent',
  description: null,
  ...over,
});

const many = <T>(count: number, make: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index));

/** Whether a `tasks` fact carrying these lists is a frame the codec reads. */
function decodes(running: readonly RunningTaskEntry[], settled: readonly SettledTaskEntry[]): boolean {
  return decode(
    JSON.stringify({
      frame: 'session',
      sessionId: 's-1',
      seq: 1,
      at: '2000-01-01T00:00:00.000Z',
      payload: {
        kind: 'session_update',
        body: {
          update: 'agent_facts',
          fact: { kind: 'tasks', runtime: 'claude', running, settled },
          sourceId: null,
        },
      },
    }),
  ).ok;
}

test('lists within the budget are returned as they were given', () => {
  const running = many(3, (index) => runningTask(index, { description: 'x'.repeat(200) }));
  const settled = many(3, (index) => settledTask(index, { summary: 'y'.repeat(MAX_FACT_TEXT_LENGTH) }));
  const fitted = fitTasks(running, settled);
  assert.equal(fitted.running, running);
  assert.equal(fitted.settled, settled);
});

test('control: the lists this budget exists for make a frame the codec refuses, and the fitted ones make one it reads', () => {
  const settled = many(200, (index) => settledTask(index, { summary: 'y'.repeat(MAX_FACT_TEXT_LENGTH) }));
  assert.equal(decodes([], settled), false, 'the unfitted fact fits, so the fitted one proves nothing');
  const fitted = fitTasks([], settled);
  assert.equal(decodes(fitted.running, fitted.settled), true);
  assert.ok(agentItemBytes(fitted) <= MAX_TASKS_FACT_BYTES);
});

test('text is cut before any entry is left out, the longest first: a short text keeps every character', () => {
  const settled = many(200, (index) =>
    settledTask(index, {
      summary: index === 7 ? 'short and whole' : 'y'.repeat(MAX_FACT_TEXT_LENGTH),
      outputFile: `/tmp/tasks/${index}.output`,
    }),
  );
  const fitted = fitTasks([runningTask(0, { description: 'd'.repeat(MAX_FACT_TEXT_LENGTH) })], settled);
  assert.equal(fitted.settled.length, 200, 'an entry was left out while text could still be cut');
  assert.equal(fitted.running.length, 1);
  assert.equal(fitted.settled[7]?.summary, 'short and whole');
  assert.equal(fitted.settled[8]?.outputFile, '/tmp/tasks/8.output');
  const lengths = new Set(
    fitted.settled.filter((_, index) => index !== 7).map((task) => task.summary?.length),
  );
  assert.equal(lengths.size, 1, 'every long text is cut to the one length');
  const [length] = [...lengths];
  assert.ok(length !== undefined && length >= SHORTEST_TASK_TEXT && length < MAX_FACT_TEXT_LENGTH);
  assert.equal(fitted.running[0]?.description?.length, length);
  // The length is the longest that fits: one more character on each text would not.
  const longer = settled.map((task, index) =>
    index === 7 ? task : { ...task, summary: 'y'.repeat((length ?? 0) + 1) },
  );
  assert.ok(
    agentItemBytes({
      running: [runningTask(0, { description: 'd'.repeat((length ?? 0) + 1) })],
      settled: longer,
    }) > MAX_TASKS_FACT_BYTES,
  );
});

test('an id is never cut', () => {
  const settled = many(200, (index) =>
    settledTask(index, { toolUseId: `toolu_${'i'.repeat(60)}_${index}`, summary: 'y'.repeat(900) }),
  );
  const fitted = fitTasks([], settled);
  for (const [index, task] of fitted.settled.entries()) {
    assert.equal(task.taskId, settled[index]?.taskId);
    assert.equal(task.toolUseId, settled[index]?.toolUseId);
  }
});

test('a cut never splits a character pair', () => {
  const pair = '\u{20000}';
  const settled = many(200, (index) =>
    settledTask(index, { summary: `${'y'.repeat(index % 2)}${pair.repeat(450)}` }),
  );
  const fitted = fitTasks([], settled);
  for (const task of fitted.settled) {
    assert.doesNotMatch(
      task.summary ?? '',
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  }
  assert.equal(decodes([], fitted.settled), true);
});

test('with every text at its shortest, entries are left out: the oldest settled first, and a running task only after every settled one', () => {
  const id = (index: number): string => `${'k'.repeat(400)}-${index}`;
  const settled = many(MAX_FACT_LIST_ENTRIES, (index) =>
    settledTask(index, { taskId: id(index), summary: 'y'.repeat(100) }),
  );
  const running = many(40, (index) => runningTask(index, { description: 'd'.repeat(100) }));
  const fitted = fitTasks(running, settled);
  assert.ok(agentItemBytes(fitted) <= MAX_TASKS_FACT_BYTES);
  assert.equal(fitted.running.length, 40, 'a running task was left out while settled ones remained');
  assert.ok(fitted.settled.length > 0 && fitted.settled.length < settled.length);
  assert.deepEqual(
    fitted.settled.map((task) => task.taskId),
    settled.slice(-fitted.settled.length).map((task) => task.taskId),
    'the newest settled tasks are the ones kept',
  );
  assert.equal(fitted.settled[0]?.summary?.length, SHORTEST_TASK_TEXT);
  // Running tasks alone past the budget: the first ones stay.
  const crowd = many(MAX_FACT_LIST_ENTRIES, (index) => runningTask(index, { taskId: id(index) }));
  const kept = fitTasks(crowd, []);
  assert.ok(kept.running.length > 0 && kept.running.length < crowd.length);
  assert.deepEqual(
    kept.running.map((task) => task.taskId),
    crowd.slice(0, kept.running.length).map((task) => task.taskId),
  );
  assert.equal(decodes(kept.running, kept.settled), true);
});

test('each list is held to the most entries a fact list may carry, the newest settled kept', () => {
  const settled = many(MAX_FACT_LIST_ENTRIES + 5, (index) => settledTask(index));
  const running = many(MAX_FACT_LIST_ENTRIES + 5, (index) => runningTask(index));
  const fitted = fitTasks(running, settled);
  assert.equal(fitted.settled.length, MAX_FACT_LIST_ENTRIES);
  assert.equal(fitted.running.length, MAX_FACT_LIST_ENTRIES);
  assert.equal(fitted.settled.at(-1)?.taskId, settled.at(-1)?.taskId);
  assert.equal(fitted.settled[0]?.taskId, settled[5]?.taskId);
  assert.equal(decodes(fitted.running, fitted.settled), true);
});
