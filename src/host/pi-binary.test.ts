/**
 * The pi pin: the CLI's `--version` read and held to `PI_PINNED_VERSION`, so the release the pin
 * moved from, or any other, is listed unavailable by name and the pinned release is admitted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { RunVersion } from './codex-binary.js';
import { PI_PINNED_VERSION, piVersionOf, piVersionProblem, readPiVersion } from './pi-binary.js';

const answering =
  (stdout: string): RunVersion =>
  () =>
    Promise.resolve({ stdout });

const CLI = 'C:/tools/pi/dist/bundle/cli.js';

test('the version is the first token of the first line the CLI prints', () => {
  assert.equal(piVersionOf(`${PI_PINNED_VERSION}\n`), PI_PINNED_VERSION);
  assert.equal(piVersionOf(`\r\n${PI_PINNED_VERSION}\r\n`), PI_PINNED_VERSION);
  assert.equal(piVersionOf(''), null);
});

test('the release the pin moved from is refused by name, and the pinned release is admitted', async () => {
  assert.equal(
    piVersionProblem('the CLI', '1.2.0'),
    `the CLI is pi 1.2.0; this host is pinned to pi ${PI_PINNED_VERSION}`,
  );
  assert.equal(piVersionProblem('the CLI', PI_PINNED_VERSION), null);
  const older = await readPiVersion(CLI, {}, answering('1.2.0\n'));
  assert.equal(older.ok ? '' : older.refusal.reason, 'runtime-unavailable');
  assert.equal(
    older.ok ? '' : older.refusal.detail,
    `the pi CLI ${CLI} is pi 1.2.0; this host is pinned to pi ${PI_PINNED_VERSION}`,
  );
  assert.deepEqual(await readPiVersion(CLI, {}, answering(`${PI_PINNED_VERSION}\n`)), {
    ok: true,
    value: PI_PINNED_VERSION,
  });
});

test('control: a CLI that cannot be run, or prints no version, is refused naming the pin', async () => {
  const absent = await readPiVersion(CLI, {}, () => Promise.resolve({ error: 'absent' }));
  assert.equal(
    absent.ok ? '' : absent.refusal.detail,
    `the pi CLI ${CLI} is absent; this host is pinned to pi ${PI_PINNED_VERSION}`,
  );
  assert.match(piVersionProblem('the CLI', null) ?? '', /reports no version/);
});
