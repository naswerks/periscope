/**
 * The config file: the closed key set, the corrupt-is-loud posture, and the one env-wins overlay.
 *
 * Real filesystem in a temp directory, the same shape `workspace-fs.test.ts` uses — the module's
 * whole job is disk I/O, so a faked fs would prove the fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RESTART_KEYS,
  CONFIG_KEYS,
  WIRE_CONFIGURABLE_KEYS,
  configFilePath,
  readConfigFile,
  withConfigFallback,
  writeConfigEntries,
  writeConfigEntry,
} from './config-file.js';

/** An env whose config dir is a fresh temp directory — the override every path derives from. */
async function scratchEnv(): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'periscope-config-'));
  return { env: { PERISCOPE_CONFIG_DIR: dir }, dir };
}

test('the file lives beside the credential material — one derivation, one protected directory', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const path = configFilePath(env);
    assert.ok(path?.startsWith(dir), 'the config file left the credential directory');
    assert.ok(path?.endsWith('/config.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing file reads as empty — the ordinary state of a machine that never ran config', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const reading = readConfigFile(env);
    assert.equal(reading.problem, null);
    assert.deepEqual(reading.values, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('write then read round-trips, and a second write MERGES rather than clobbers', async () => {
  const { env, dir } = await scratchEnv();
  try {
    assert.equal(writeConfigEntry(env, 'PERISCOPE_REPOSITORY_ROOT', 'C:/repo'), null);
    assert.equal(writeConfigEntry(env, 'PERISCOPE_WORKSPACE_ROOT', 'C:/ws'), null);
    const reading = readConfigFile(env);
    assert.equal(reading.problem, null);
    assert.deepEqual(reading.values, {
      PERISCOPE_REPOSITORY_ROOT: 'C:/repo',
      PERISCOPE_WORKSPACE_ROOT: 'C:/ws',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: an unknown key refuses naming the legal set, and touches nothing on disk', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const problem = writeConfigEntry(env, 'PERISCOPE_REPOSITORY_ROTO', 'C:/repo');
    assert.notEqual(problem, null, 'a typo\'d key "worked" — it configured nothing, silently');
    assert.match(problem ?? '', /PERISCOPE_REPOSITORY_ROOT/, 'the refusal must name the legal keys');
    assert.equal(readConfigFile(env).values['PERISCOPE_REPOSITORY_ROTO'], undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: a corrupt file is a loud problem on read and blocks a write, never a silent empty', async () => {
  const { env, dir } = await scratchEnv();
  try {
    await writeFile(join(dir, 'config.json'), 'not json at all', 'utf8');
    const reading = readConfigFile(env);
    assert.notEqual(
      reading.problem,
      null,
      'a corrupt file read as a deliberate absence — the ambiguity pairing exists to end',
    );
    const problem = writeConfigEntry(env, 'PERISCOPE_HOST_ID', 'h1');
    assert.notEqual(problem, null, 'writing around a corrupt file destroys whatever the operator hand-wrote');
    assert.equal(
      await readFile(join(dir, 'config.json'), 'utf8'),
      'not json at all',
      'the write clobbered it anyway',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a hand-added unknown key in the FILE is a problem too — it would configure nothing', async () => {
  const { env, dir } = await scratchEnv();
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ PERISCOPE_TYPO: 'x' }), 'utf8');
    assert.match(readConfigFile(env).problem ?? '', /PERISCOPE_TYPO/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: the overlay: a file value fills an absent env var, and a present env var wins, both directions', () => {
  const values = { PERISCOPE_REPOSITORY_ROOT: 'C:/from-file' };

  const filled = withConfigFallback({}, values);
  assert.equal(
    filled['PERISCOPE_REPOSITORY_ROOT'],
    'C:/from-file',
    'an absence the file could fill stayed empty',
  );

  // The other direction IS the control: flip the overlay order and this goes red while the first
  // arm stays green — asserting both is what makes the pair a discriminator.
  const kept = withConfigFallback({ PERISCOPE_REPOSITORY_ROOT: 'C:/from-env' }, values);
  assert.equal(kept['PERISCOPE_REPOSITORY_ROOT'], 'C:/from-env', 'the environment did not win');

  // An EMPTY env var counts as absent, matching how the composition root reads them.
  const emptyFilled = withConfigFallback({ PERISCOPE_REPOSITORY_ROOT: '' }, values);
  assert.equal(emptyFilled['PERISCOPE_REPOSITORY_ROOT'], 'C:/from-file');
});

test('the overlay consults ONLY the closed key set — nothing else can arrive from a file', () => {
  const smuggled = withConfigFallback({}, { PERISCOPE_IDENTITY_AUTHORITY: 'https://evil' });
  assert.equal(
    smuggled['PERISCOPE_IDENTITY_AUTHORITY'],
    undefined,
    'a non-config key crossed over from the file',
  );
});

test('PERISCOPE_CONFIG_DIR is deliberately not a config key — a file cannot move itself', () => {
  assert.ok(!(CONFIG_KEYS as readonly string[]).includes('PERISCOPE_CONFIG_DIR'));
});

test('writeConfigEntries sets and removes in one write, and the agent home is a config key', async () => {
  const { env, dir } = await scratchEnv();
  try {
    assert.equal(writeConfigEntry(env, 'PERISCOPE_WORKSPACE_ROOT', 'C:/ws'), null);
    assert.equal(
      writeConfigEntries(env, [
        { key: 'PERISCOPE_AGENT_HOME', value: 'C:/agent-home' },
        { key: 'PERISCOPE_WORKSPACE_ROOT', value: null },
      ]),
      null,
    );
    const reading = readConfigFile(env);
    assert.equal(reading.problem, null);
    assert.deepEqual(reading.values, { PERISCOPE_AGENT_HOME: 'C:/agent-home' }, 'null removes; a value sets');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: one unknown key in a multi-entry write refuses the whole set before the disk is touched', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const problem = writeConfigEntries(env, [
      { key: 'PERISCOPE_WORKSPACE_ROOT', value: 'C:/ws' },
      { key: 'PERISCOPE_NOPE', value: 'x' },
    ]);
    assert.match(problem ?? '', /PERISCOPE_NOPE/);
    assert.deepEqual(readConfigFile(env).values, {}, 'the legal entry beside the illegal one must not land');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the wire-settable keys are a subset of the config keys, include the control-plane URLs, and exclude the host id and the default key', () => {
  for (const key of WIRE_CONFIGURABLE_KEYS) assert.ok((CONFIG_KEYS as readonly string[]).includes(key), key);
  for (const key of ['PERISCOPE_HOST_ID', 'PERISCOPE_WORKSPACE_KEY']) {
    assert.ok(
      !(WIRE_CONFIGURABLE_KEYS as readonly string[]).includes(key),
      `${key} must not be settable over the wire`,
    );
  }
  // The two addresses are settable and take effect only at the next start; the restart set is exactly them.
  for (const key of RESTART_KEYS)
    assert.ok(
      (WIRE_CONFIGURABLE_KEYS as readonly string[]).includes(key),
      `${key} must be settable over the wire`,
    );
  assert.deepEqual([...RESTART_KEYS], ['PERISCOPE_CONTROLLER_URL', 'PERISCOPE_DECISION_URL']);
});

test('a file carrying PERISCOPE_TRANSCRIPTS_ROOT is a file with an unknown key: refused by name, nothing merged', async () => {
  const { env, dir } = await scratchEnv();
  try {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ PERISCOPE_TRANSCRIPTS_ROOT: 'C:/old/projects', PERISCOPE_AGENT_HOME: 'C:/home' }),
    );
    const reading = readConfigFile(env);
    assert.match(reading.problem ?? '', /unknown key 'PERISCOPE_TRANSCRIPTS_ROOT'/);
    assert.deepEqual(reading.values, {});
    const refusedWrite = writeConfigEntry(env, 'PERISCOPE_TRANSCRIPTS_ROOT', 'C:/x');
    assert.notEqual(refusedWrite, null, 'the retired key is never written');
    assert.match(refusedWrite ?? '', /PERISCOPE_TRANSCRIPTS_ROOT/, 'the refusal names the key it refused');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
