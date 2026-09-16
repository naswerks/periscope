import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { linkStatePath, readLinkState, writeLinkState } from './link-state-file.js';

async function scratch(): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'periscope-link-state-'));
  return { env: { PERISCOPE_CONFIG_DIR: dir }, dir };
}

const RECORD = {
  state: 'accepted' as const,
  cause: 'hello_completed' as const,
  at: '2026-09-11T12:00:00.000Z',
  detail: 'protocol v9',
  negotiatedVersion: 9,
  pid: 4242,
};

test('a written record reads back whole, from the file beside the credentials', async () => {
  const { env, dir } = await scratch();
  try {
    assert.equal(writeLinkState(env, RECORD), null);
    assert.equal(linkStatePath(env), join(dir, 'link-state.json'));
    assert.deepEqual(readLinkState(env), RECORD);
    assert.match(await readFile(join(dir, 'link-state.json'), 'utf8'), /"state": "accepted"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a later write replaces the record whole, and no temporary file survives', async () => {
  const { env, dir } = await scratch();
  try {
    writeLinkState(env, RECORD);
    writeLinkState(env, {
      ...RECORD,
      state: 'backoff',
      cause: 'socket_closed',
      detail: null,
      negotiatedVersion: null,
    });
    assert.equal(readLinkState(env)?.state, 'backoff');
    assert.equal(readLinkState(env)?.negotiatedVersion, null);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(
      await readdir(dir),
      ['link-state.json'],
      'the sibling written first must have been renamed away',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no file, an unreadable file and a file of the wrong shape all read as null: a host that never said anything', async () => {
  const { env, dir } = await scratch();
  try {
    assert.equal(readLinkState(env), null);
    await writeFile(join(dir, 'link-state.json'), 'not json', 'utf8');
    assert.equal(readLinkState(env), null);
    await writeFile(join(dir, 'link-state.json'), JSON.stringify({ state: 'open' }), 'utf8');
    assert.equal(readLinkState(env), null, 'a record without its cause, time and pid is no record');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a directory that cannot be created is said, not thrown, and reads as no record', async () => {
  const { env: base, dir } = await scratch();
  try {
    await writeFile(join(dir, 'blocker'), '', 'utf8');
    const env: NodeJS.ProcessEnv = { ...base, PERISCOPE_CONFIG_DIR: join(dir, 'blocker', 'nested') };
    assert.match(writeLinkState(env, RECORD) ?? '', /^could not write /);
    assert.equal(readLinkState(env), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
