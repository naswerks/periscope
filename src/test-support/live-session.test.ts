/**
 * What a live probe leans on when it removes its scratch directory: a probe that leaves its directory
 * behind hides whether a process of its session was still there to hold it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { removeScratch } from './live-session.js';
import { tempDir } from './temp-dir.js';

test('a scratch directory a process still has as its working directory is waited for and removed, and the wait is said', async () => {
  const dir = await tempDir('scratch-held');
  writeFileSync(join(dir, 'notes.txt'), 'the notes say hello\n');
  // A process that holds the directory as its working directory, then leaves by itself: what a session's
  // command is for a moment after the close that ended it. It says when it is running, since a process
  // takes hold of its working directory as it starts and not when it is asked for.
  const child = spawn(
    process.execPath,
    ['-e', "process.stdout.write('running'); setTimeout(() => {}, 1500)"],
    { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const left = new Promise((resolve) => child.on('close', resolve));
  await new Promise((resolve) => child.stdout.once('data', resolve));
  const receipts: { what: string; data: Record<string, unknown> }[] = [];
  removeScratch(dir, (what, data) => receipts.push({ what, data }));
  await left;
  assert.equal(existsSync(dir), false, 'the directory was left behind');
  assert.deepEqual(
    receipts.filter((one) => one.what === 'scratch directory left behind'),
    [],
  );
  // On Windows a directory cannot be removed while it is a process's working directory, so the removal
  // had to wait there, and says so. Elsewhere it is removed under the process, at once.
  if (process.platform === 'win32') {
    assert.equal(receipts[0]?.what, 'scratch directory removed after a wait');
    assert.ok(Number(receipts[0]?.data['tries']) > 1, 'the removal says it went at the first try');
  }
});

test('control: a scratch directory nothing holds is removed at once, with nothing to say', async () => {
  const dir = await tempDir('scratch-free');
  writeFileSync(join(dir, 'notes.txt'), 'the notes say hello\n');
  const receipts: string[] = [];
  removeScratch(dir, (what) => receipts.push(what));
  assert.equal(existsSync(dir), false);
  assert.deepEqual(receipts, []);
});
