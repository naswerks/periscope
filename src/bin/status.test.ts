/**
 * The status verb, through the same seams the binary uses: `main` dispatches it on the merged
 * environment, and `runStatus` reads the real files under a scratch config directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from './main.js';
import type { Io } from './main.js';
import { runStatus } from './status.js';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'periscope-status-'));
}

function recording(): { io: Io; out: string[]; err: string[]; codes: number[] } {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  return {
    io: {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      setExitCode: (code) => codes.push(code),
    },
    out,
    err,
    codes,
  };
}

test('status on a fresh config directory says the link is unknown, the credential absent, and every key unset', async () => {
  const dir = await scratch();
  try {
    const outcome = runStatus({ raw: { PERISCOPE_CONFIG_DIR: dir }, merged: { PERISCOPE_CONFIG_DIR: dir } });
    assert.equal(outcome.ok, true);
    const text = outcome.lines.join('\n');
    assert.match(text, /^link: unknown/m);
    assert.match(text, /^credential: absent/m);
    assert.match(text, /PERISCOPE_CONTROLLER_URL = \(unset\)/);
    assert.match(text, new RegExp(`config file: .*config\\.json`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status reads the paired credential, the link record and the config file that serve left behind, and never dials', async () => {
  const dir = await scratch();
  try {
    await writeFile(
      join(dir, 'paired-credential.json'),
      JSON.stringify({ hostId: 'ph-7', credential: 'p1.ph-7.s3cret' }),
      'utf8',
    );
    await writeFile(
      join(dir, 'link-state.json'),
      JSON.stringify({
        state: 'accepted',
        cause: 'hello_completed',
        at: '2026-09-11T12:00:00.000Z',
        detail: 'protocol v9',
        negotiatedVersion: 9,
        pid: 999_999,
      }),
      'utf8',
    );
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ PERISCOPE_DECISION_URL: 'https://c.example/decision' }),
      'utf8',
    );
    const raw: NodeJS.ProcessEnv = { PERISCOPE_CONFIG_DIR: dir, PERISCOPE_HOST_ID: 'configured-box' };
    const merged: NodeJS.ProcessEnv = { ...raw, PERISCOPE_DECISION_URL: 'https://c.example/decision' };

    const outcome = runStatus(
      { raw, merged },
      { nowMs: () => Date.parse('2026-09-11T12:05:00.000Z'), pidAlive: () => false },
    );
    const text = outcome.lines.join('\n');
    assert.match(
      text,
      /^link: accepted since 2026-09-11T12:00:00\.000Z \(hello_completed: protocol v9\); serve pid 999999 is gone/m,
    );
    assert.match(text, /^protocol: v9 negotiated/m);
    assert.match(text, /^credential: paired as ph-7/m);
    assert.match(
      text,
      /^host id: ph-7 \(the paired credential's, overriding the configured configured-box\)/m,
    );
    assert.match(text, /PERISCOPE_DECISION_URL = https:\/\/c\.example\/decision {2}\[config-file\]/);
    assert.match(text, /PERISCOPE_HOST_ID = configured-box {2}\[environment\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('main dispatches status on the merged view: a corrupt config file is the refusal, on stderr, exit 1', async () => {
  const dir = await scratch();
  try {
    await writeFile(join(dir, 'config.json'), 'not json', 'utf8');
    const run = recording();
    await main(['status'], { PERISCOPE_CONFIG_DIR: dir }, run.io);
    assert.deepEqual(run.out, []);
    assert.equal(run.err.length, 1);
    assert.match(run.err[0] ?? '', /is not JSON/);
    assert.deepEqual(run.codes, [1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('main prints status on stdout and sets no exit code', async () => {
  const dir = await scratch();
  try {
    const run = recording();
    await main(['status'], { PERISCOPE_CONFIG_DIR: dir }, run.io);
    assert.ok(run.out.length >= 6, `too few lines: ${run.out.length}`);
    assert.match(run.out[0] ?? '', /^periscope \d+\.\d+\.\d+/, 'the first line names the package version');
    assert.match(run.out[1] ?? '', /^link: unknown/);
    assert.deepEqual(run.err, []);
    assert.deepEqual(run.codes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
