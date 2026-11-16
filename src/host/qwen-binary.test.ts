/**
 * The Qwen Code pin: the CLI's `--version` read and held to `QWEN_PINNED_VERSION`, so the release the pin
 * moved from, or any other, is listed unavailable by name and the pinned release is admitted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { RunVersion } from './codex-binary.js';
import { QWEN_PINNED_VERSION, qwenVersionOf, qwenVersionProblem, readQwenVersion } from './qwen-binary.js';

const answering =
  (stdout: string): RunVersion =>
  () =>
    Promise.resolve({ stdout });

const CLI = 'C:/tools/qwen/cli-entry.js';

test('the version is the first token of the first line the CLI prints', () => {
  assert.equal(qwenVersionOf(`${QWEN_PINNED_VERSION}\n`), QWEN_PINNED_VERSION);
  assert.equal(qwenVersionOf(`\r\n${QWEN_PINNED_VERSION}\r\n`), QWEN_PINNED_VERSION);
  assert.equal(qwenVersionOf(''), null);
});

test('the release the pin moved from is refused by name, and the pinned release is admitted', async () => {
  assert.equal(
    qwenVersionProblem('the CLI', '0.25.1'),
    `the CLI is Qwen Code 0.25.1; this host is pinned to Qwen Code ${QWEN_PINNED_VERSION}`,
  );
  assert.equal(qwenVersionProblem('the CLI', QWEN_PINNED_VERSION), null);
  const older = await readQwenVersion(CLI, {}, answering('0.25.1\n'));
  assert.equal(older.ok ? '' : older.refusal.reason, 'runtime-unavailable');
  assert.equal(
    older.ok ? '' : older.refusal.detail,
    `the Qwen Code CLI ${CLI} is Qwen Code 0.25.1; this host is pinned to Qwen Code ${QWEN_PINNED_VERSION}`,
  );
  assert.deepEqual(await readQwenVersion(CLI, {}, answering(`${QWEN_PINNED_VERSION}\n`)), {
    ok: true,
    value: QWEN_PINNED_VERSION,
  });
});

test('control: a CLI that cannot be run, or prints no version, is refused naming the pin', async () => {
  const absent = await readQwenVersion(CLI, {}, () => Promise.resolve({ error: 'absent' }));
  assert.equal(
    absent.ok ? '' : absent.refusal.detail,
    `the Qwen Code CLI ${CLI} is absent; this host is pinned to Qwen Code ${QWEN_PINNED_VERSION}`,
  );
  assert.match(qwenVersionProblem('the CLI', null) ?? '', /reports no version/);
});
