import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonValue } from '../control/frames.js';
import type { Refusal } from '../core/refusal.js';
import { drain, fakeChild, spawnerFor } from '../test-support/fake-child.js';
import { startStdioLines } from './stdio-lines.js';

test('a batch file is refused as the child before anything is spawned', () => {
  const child = fakeChild();
  const started = startStdioLines({
    command: 'C:/tools/qwen.cmd',
    args: [],
    cwd: 'C:/w',
    env: {},
    spawn: spawnerFor(child),
  });
  assert.equal(started.ok, false);
  assert.equal(child.spawned, null);
});

test('values reach the adapter in arrival order across chunks and carriage returns, and a malformed line is named and dropped', async () => {
  const child = fakeChild();
  const values: JsonValue[] = [];
  const refusals: Refusal[] = [];
  const started = startStdioLines({
    command: 'node',
    args: ['cli.js'],
    cwd: 'C:/w',
    env: { PATH: 'p' },
    spawn: spawnerFor(child),
    onValue: (value) => values.push(value),
    onRefusal: (refused) => refusals.push(refused),
  });
  assert.ok(started.ok);
  child.write('{"a":1}\r\n{"b"');
  child.write(':2}\nnot json\n{"c":3}\n');
  await drain();
  assert.deepEqual(values, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.deepEqual(
    refusals.map((one) => one.reason),
    ['rpc-line-malformed'],
  );
  assert.deepEqual(child.spawned?.env, { PATH: 'p' });
  started.value.send({ type: 'user' });
  assert.deepEqual(child.received, [{ type: 'user' }]);
});

test('close ends stdin, waits the grace, then kills the tree of a child still running; a second close is the same close', async () => {
  const child = fakeChild(5150);
  const killed: number[] = [];
  const started = startStdioLines({
    command: 'node',
    args: [],
    cwd: 'C:/w',
    env: {},
    spawn: spawnerFor(child),
    closeGraceMs: 20,
    killTree: (pid) => {
      killed.push(pid);
      child.exit(null, 'SIGKILL');
      return Promise.resolve();
    },
  });
  assert.ok(started.ok);
  const first = started.value.close();
  assert.equal(started.value.close(), first);
  assert.equal(child.stdinEnded, true);
  await first;
  assert.deepEqual(killed, [5150]);
  assert.equal(started.value.send({ late: true }), false);
});

test('a child that exits within the grace on Windows is not walked; elsewhere its group is still signalled', async () => {
  const child = fakeChild(6160);
  const killed: number[] = [];
  const started = startStdioLines({
    command: 'node',
    args: [],
    cwd: 'C:/w',
    env: {},
    spawn: spawnerFor(child),
    closeGraceMs: 200,
    killTree: (pid) => {
      killed.push(pid);
      return Promise.resolve();
    },
  });
  assert.ok(started.ok);
  const closing = started.value.close();
  child.exit(0);
  await closing;
  assert.deepEqual(killed, process.platform === 'win32' ? [] : [6160]);
});
