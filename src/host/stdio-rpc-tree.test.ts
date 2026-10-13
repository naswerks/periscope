/**
 * Killing a process tree elsewhere than Windows, over a fixed process table: the walk that finds every
 * descendant before any signal, the `/proc` listing it reads, and the signals it sends. These run on
 * every platform; the real tree is killed in `stdio-rpc.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProcessEntry, ProcReads } from './stdio-rpc.js';
import { descendantsOf, killProcessTree, parentOfStat, readProcTable } from './stdio-rpc.js';

// Pids no real process can hold, so none is ever this test's own, which the kill never signals: odd,
// where Windows pids are multiples of four, and above 2^22, the highest pid Linux allows.
const CHILD = 5_000_001;
const SHELL = 5_000_003;
const DETACHED = 5_000_005;
const SLEEPER = 5_000_007;
const OTHER = 5_000_009;
const OTHER_CHILD = 5_000_011;

// The child runs a shell; the shell started a process in a group and session of its own, and that
// process runs a sleeper. The tree under OTHER belongs to someone else, and 1 is init.
const TABLE: readonly ProcessEntry[] = [
  { pid: 1, ppid: 0 },
  { pid: CHILD, ppid: 1 },
  { pid: SHELL, ppid: CHILD },
  { pid: DETACHED, ppid: SHELL },
  { pid: SLEEPER, ppid: DETACHED },
  { pid: OTHER, ppid: 1 },
  { pid: OTHER_CHILD, ppid: OTHER },
];

async function signalsFor(pid: number, table: readonly ProcessEntry[]): Promise<number[]> {
  const sent: number[] = [];
  await killProcessTree(pid, {
    platform: 'linux',
    readTable: () => Promise.resolve(table),
    signal: (target) => {
      sent.push(target);
    },
  });
  return sent;
}

test('the walk reaches every descendant breadth-first, a grandchild in another group included', () => {
  assert.deepEqual(descendantsOf(CHILD, TABLE), [SHELL, DETACHED, SLEEPER]);
});

test('control: a tree that is not under the root is never walked, and a process that is its own parent is skipped', () => {
  assert.deepEqual(descendantsOf(OTHER, TABLE), [OTHER_CHILD]);
  assert.deepEqual(descendantsOf(CHILD, [...TABLE, { pid: CHILD, ppid: CHILD }]), [SHELL, DETACHED, SLEEPER]);
  assert.deepEqual(descendantsOf(5_000_999, TABLE), []);
});

test("each descendant's group and the descendant itself are killed, parents first, then the child's group", async () => {
  assert.deepEqual(await signalsFor(CHILD, TABLE), [
    -SHELL,
    SHELL,
    -DETACHED,
    DETACHED,
    -SLEEPER,
    SLEEPER,
    -CHILD,
  ]);
});

test('control: nothing outside the tree is signalled, and pid 1 never is, whatever the table claims', async () => {
  const sent = await signalsFor(CHILD, [...TABLE, { pid: 1, ppid: CHILD }]);
  for (const target of sent) {
    assert.ok(![OTHER, OTHER_CHILD, 1].includes(Math.abs(target)), `signalled ${target}`);
  }
  assert.ok(sent.includes(-CHILD));
});

test('control: this process is never signalled, even where a table lists it under the child', async () => {
  const sent = await signalsFor(CHILD, [...TABLE, { pid: process.pid, ppid: SHELL }]);
  assert.ok(
    !sent.includes(process.pid) && !sent.includes(-process.pid),
    `signalled this process: ${sent.join(', ')}`,
  );
  assert.deepEqual(sent, [-SHELL, SHELL, -DETACHED, DETACHED, -SLEEPER, SLEEPER, -CHILD]);
});

test('a pid listed in /proc and gone before its stat is read is left out; the rest of the table is read', async () => {
  const stats: Record<string, string> = {
    '/proc/1/stat': '1 (init) S 0 1 1 0',
    [`/proc/${CHILD}/stat`]: `${CHILD} (codex) S 1 ${CHILD} ${CHILD} 0`,
    [`/proc/${SHELL}/stat`]: `${SHELL} (node) S ${CHILD} ${CHILD} ${CHILD} 0`,
    [`/proc/${SLEEPER}/stat`]: `${SLEEPER} (sleep) S ${DETACHED} ${DETACHED} ${DETACHED} 0`,
  };
  const reads: ProcReads = {
    readdir: () => Promise.resolve(['1', `${CHILD}`, `${SHELL}`, `${DETACHED}`, `${SLEEPER}`, 'self', 'net']),
    readFile: (path) => {
      const stat = stats[path];
      return stat === undefined
        ? Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }))
        : Promise.resolve(stat);
    },
  };
  const table = await readProcTable(reads);
  assert.deepEqual(table, [
    { pid: 1, ppid: 0 },
    { pid: CHILD, ppid: 1 },
    { pid: SHELL, ppid: CHILD },
    { pid: SLEEPER, ppid: DETACHED },
  ]);
  // DETACHED exited between the listing and the read, so its child is no longer under the root.
  assert.deepEqual(await signalsFor(CHILD, table ?? []), [-SHELL, SHELL, -CHILD]);
});

test('with no /proc to list, the reading is null, so the caller falls back to ps', async () => {
  const reads: ProcReads = {
    readdir: () => Promise.reject(new Error('ENOENT: /proc')),
    readFile: () => Promise.reject(new Error('unreached')),
  };
  assert.equal(await readProcTable(reads), null);
});

test('the parent pid is read after the last parenthesis, whatever the command name holds', () => {
  assert.equal(parentOfStat('4242 (my (odd) cmd) S 17 4242 4242 0 -1'), 17);
  assert.equal(parentOfStat('7 (a) b) R 3 7 7'), 3);
  assert.equal(parentOfStat('no parenthesis here'), null);
  assert.equal(parentOfStat('9 (x)'), null);
});

test("a table that cannot be read still kills the child's group", async () => {
  const sent: number[] = [];
  await killProcessTree(CHILD, {
    platform: 'linux',
    readTable: () => Promise.reject(new Error('ps is not installed')),
    signal: (target) => {
      sent.push(target);
    },
  });
  assert.deepEqual(sent, [-CHILD]);
});

test('a signal that fails for one process does not stop the rest', async () => {
  const sent: number[] = [];
  await killProcessTree(CHILD, {
    platform: 'linux',
    readTable: () => Promise.resolve(TABLE),
    signal: (target) => {
      sent.push(target);
      if (target === -SHELL || target === DETACHED) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
    },
  });
  assert.deepEqual(sent, [-SHELL, SHELL, -DETACHED, DETACHED, -SLEEPER, SLEEPER, -CHILD]);
});
