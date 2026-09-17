/**
 * The config verb's orchestration: what one invocation prints, and that env-wins is said where the
 * operator is looking. The file mechanics are `host/config-file.test.ts`'s; these tests are about
 * the lines.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runConfig } from './config.js';

async function scratchEnv(): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'periscope-config-verb-'));
  return { env: { PERISCOPE_CONFIG_DIR: dir }, dir };
}

test('list on a fresh machine names the path, the empty state, and the legal keys', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const outcome = runConfig(null, null, env);
    assert.equal(outcome.ok, true);
    const text = outcome.lines.join('\n');
    assert.match(text, /config\.json/);
    assert.match(text, /empty/);
    assert.match(
      text,
      /PERISCOPE_REPOSITORY_ROOT/,
      'the listing must teach the keys, or the verb is undiscoverable',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('write then read one key round-trips through the verb', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const wrote = runConfig('PERISCOPE_REPOSITORY_ROOT', 'C:/repo', env);
    assert.equal(wrote.ok, true, wrote.lines.join('\n'));
    const read = runConfig('PERISCOPE_REPOSITORY_ROOT', null, env);
    assert.deepEqual(read, { ok: true, lines: ['C:/repo'] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown key fails the invocation with the refusal as the output', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const outcome = runConfig('PERISCOPE_TYPO', 'x', env);
    assert.equal(outcome.ok, false);
    assert.match(outcome.lines.join('\n'), /not a config key/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: a write shadowed by the environment says so, because a silent no-op is confusing', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const shadowed = { ...env, PERISCOPE_REPOSITORY_ROOT: 'C:/from-env' };
    const outcome = runConfig('PERISCOPE_REPOSITORY_ROOT', 'C:/from-file', shadowed);
    assert.equal(outcome.ok, true);
    assert.match(
      outcome.lines.join('\n'),
      /environment wins/,
      'the one fact that explains the no-op went unsaid',
    );

    // The control: the same write with no env shadow carries no such note.
    const plain = runConfig('PERISCOPE_WORKSPACE_ROOT', 'C:/ws', env);
    assert.equal(plain.ok, true);
    assert.doesNotMatch(plain.lines.join('\n'), /environment wins/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--unset removes one key from the file and says so; an absent key is not an error', async () => {
  const { env, dir } = await scratchEnv();
  try {
    assert.equal(runConfig('PERISCOPE_REPOSITORY_ROOT', 'C:/repo', env).ok, true);
    const removed = runConfig('PERISCOPE_REPOSITORY_ROOT', null, env, true);
    assert.equal(removed.ok, true, removed.lines.join('\n'));
    assert.match(removed.lines[0] ?? '', /PERISCOPE_REPOSITORY_ROOT removed from/);
    assert.equal(runConfig('PERISCOPE_REPOSITORY_ROOT', null, env).ok, false, 'the key is gone');
    const again = runConfig('PERISCOPE_REPOSITORY_ROOT', null, env, true);
    assert.equal(again.ok, true);
    assert.match(again.lines[0] ?? '', /is not set in/);
    assert.equal(runConfig(null, null, env, true).ok, false, 'unset with no key is a usage error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a value the wire would refuse is refused before it is written: the same screen host_configure runs', async () => {
  const { env, dir } = await scratchEnv();
  try {
    for (const [key, value, why] of [
      ['PERISCOPE_CONTROLLER_URL', 'https://controller.example/link', /ws or wss/],
      ['PERISCOPE_DECISION_URL', 'ws://controller.example/decision', /http or https/],
      ['PERISCOPE_REPOSITORY_ROOT', 'relative/repo', /absolute path/],
      ['PERISCOPE_BRANCH_SCHEME', '{repo}/main', /\{key\}/],
    ] as const) {
      const outcome = runConfig(key, value, env);
      assert.equal(outcome.ok, false, `${key}=${value} must be refused`);
      assert.match(outcome.lines[0] ?? '', why);
    }
    assert.equal(
      runConfig(null, null, env).lines.some((line) => line.includes(' = ')),
      false,
      'nothing was written',
    );
    assert.equal(
      runConfig('PERISCOPE_CONTROLLER_URL', 'wss://controller.example/link', env).ok,
      true,
      'the control',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
