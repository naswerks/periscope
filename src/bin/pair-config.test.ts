/**
 * The process-level proof that `periscope pair` sees the config file.
 *
 * This spawns a real process instead of calling a function because the defect class is not in
 * `runPair` (its env parameter is a plain argument) but in the wiring: `main()` handing it raw
 * `process.env` while only `serve()` merges the config file, so `periscope config` followed by
 * `periscope pair <code>` answers "nowhere to redeem the code" on the exact flow the verbs were
 * built for. A wiring defect in the composition root is observable only from outside the
 * composition root. Same reasoning, same harness, as `credential-fatal.test.ts`.
 *
 * These cases drive the shipped entry point rather than `runConfig` alone.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Run } from '../test-support/spawn-harness.js';
import { runBinary } from '../test-support/spawn-harness.js';

/** Runs `periscope pair <code>` and waits for it to end. A timeout kill is a failure, not clean-up. */
function runPairBinary(env: NodeJS.ProcessEnv): Promise<Run> {
  return runBinary(['pair', 'TEST-code'], env);
}

/**
 * An environment with no decision/pair URL of its own: the config-file-only machine.
 *
 * Stripped rather than trusted absent: the machine running this suite may itself be configured,
 * and `PERISCOPE_CONFIG_DIR` is pointed at a per-case fixture for the same reason
 * `credential-fatal.test.ts` documents. Deleting it would make the spawned binary read the real
 * `~/.periscope`, measuring whoever runs the suite instead of the case.
 */
function configFileOnlyEnv(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PERISCOPE_CONFIG_DIR: configDir };
  delete env['PERISCOPE_DECISION_URL'];
  delete env['PERISCOPE_PAIR_URL'];
  delete env['PERISCOPE_IDENTITY_AUTHORITY'];
  delete env['PERISCOPE_IDENTITY_CLIENT_ID'];
  delete env['PERISCOPE_IDENTITY_AUTHORIZE_URL'];
  delete env['PERISCOPE_IDENTITY_TOKEN_URL'];
  return env;
}

/** A fixture config dir; `entries === null` leaves it empty (the no-file control). */
function configDirHolding(entries: Record<string, string> | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'periscope-pair-config-'));
  if (entries !== null) {
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  }
  return dir;
}

test('regression: pair reads the decision URL from the config file', async () => {
  // Port 1 answers nothing, on purpose: "could not be reached" carries the derived URL, which is
  // the observation that the file value made it all the way to `redemptionUrl`. With raw env this
  // exact spawn says "nowhere to redeem the code".
  const dir = configDirHolding({ PERISCOPE_DECISION_URL: 'http://127.0.0.1:1/decision' });
  const run = await runPairBinary(configFileOnlyEnv(dir));

  assert.equal(
    run.code,
    1,
    `expected exit 1 (unreachable controller), got ${run.code}\nstderr:\n${run.stderr}`,
  );
  assert.match(run.stderr, /could not be reached/, 'the file-carried URL must be dialled, not ignored');
  assert.match(
    run.stderr,
    /127\.0\.0\.1:1\/api\/periscope\/pair/,
    'the failure must name the URL derived from the file',
  );
  assert.doesNotMatch(
    run.stderr,
    /nowhere to redeem/,
    'the raw-env answer: the config file was invisible to pair',
  );
});

test('control: no config file leaves raw-env behaviour unchanged: nowhere to redeem', async () => {
  // One variable (the file's presence) against the case above, and the outcomes disagree: a
  // merge that somehow invented a URL, or a probe green for an unrelated reason, fails here.
  const run = await runPairBinary(configFileOnlyEnv(configDirHolding(null)));

  assert.equal(run.code, 1, `expected exit 1, got ${run.code}\nstderr:\n${run.stderr}`);
  assert.match(
    run.stderr,
    /nowhere to redeem the code/,
    'with no env and no file there is genuinely nowhere',
  );
});

test('the environment still wins over the file — precedence observed, not asserted', async () => {
  // The failure detail carries the URL, so which port it names is the precedence measurement:
  // env says port 1, the file says port 2, and the dial must go to port 1.
  const dir = configDirHolding({ PERISCOPE_DECISION_URL: 'http://127.0.0.1:2/decision' });
  const env = { ...configFileOnlyEnv(dir), PERISCOPE_DECISION_URL: 'http://127.0.0.1:1/decision' };
  const run = await runPairBinary(env);

  assert.equal(run.code, 1, `expected exit 1, got ${run.code}\nstderr:\n${run.stderr}`);
  assert.match(run.stderr, /127\.0\.0\.1:1\/api\/periscope\/pair/, 'the env value must win per key');
  assert.doesNotMatch(
    run.stderr,
    /127\.0\.0\.1:2/,
    'the file value must be unreachable behind a set env var',
  );
});

test('a corrupt config file is fatal for pair — it must not impersonate a deliberate absence', async () => {
  // The same rule as the paired credential: silently degrading to "no file" would put the
  // operator back in exactly the ambiguous posture the config verb exists to end. `periscope
  // config` stays on raw env precisely so this refusal cannot lock anyone out of repairing it.
  const dir = configDirHolding(null);
  writeFileSync(join(dir, 'config.json'), 'this is not JSON\n', 'utf8');
  const run = await runPairBinary(configFileOnlyEnv(dir));

  assert.equal(run.code, 1, `expected exit 1, got ${run.code}\nstderr:\n${run.stderr}`);
  assert.match(run.stderr, /is not JSON/, 'the refusal must name the problem, never fall back silently');
  assert.doesNotMatch(
    run.stderr,
    /nowhere to redeem/,
    'falling through to the absence answer is the impersonation',
  );
});
