/**
 * `periscope login`: the verb's whole decision surface, drivable without a browser, a provider or
 * a disk. `LoginDeps` injects both sign-in flows and the store, so nothing here binds a port or
 * writes a cache.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { CachedTokens, TokenStore } from '../identity/index.js';
import type { DeviceCodeInstruction } from '../host/index.js';
import { tokenCachePath } from '../host/index.js';
import type { LoginDeps } from './login.js';
import { runLogin } from './login.js';

const ENV: NodeJS.ProcessEnv = {
  HOME: '/home/agent',
  PERISCOPE_CONFIG_DIR: '/cfg',
  PERISCOPE_IDENTITY_AUTHORITY: 'https://identity.example/tenant',
  PERISCOPE_IDENTITY_CLIENT_ID: 'c',
};

const TOKENS: CachedTokens = {
  tokens: {
    accessToken: 'an-access-token',
    refreshToken: 'a-refresh-token',
    expiresAt: 4_000_000_000_000,
    tokenType: 'Bearer',
    scope: 'openid',
  },
  protocol: 'loopback',
  authority: ENV['PERISCOPE_IDENTITY_AUTHORITY'] as string,
  clientId: 'c',
};

class MemoryStore implements TokenStore {
  written: CachedTokens | null = null;

  read(): Result<CachedTokens> {
    return this.written === null ? refuse('token-unavailable', 'nothing written') : ok(this.written);
  }

  write(cached: CachedTokens): Result<unknown> {
    this.written = cached;
    return ok({});
  }

  clear(): void {
    this.written = null;
  }
}

/** Every edge recorded: which flow ran, what was presented, which path the store was asked for. */
interface Harness {
  readonly deps: LoginDeps;
  readonly lines: string[];
  readonly loopbackCalls: number;
  readonly deviceCalls: number;
  readonly storePaths: string[];
}

function harness(answer: Result<CachedTokens>): Harness {
  const lines: string[] = [];
  const storePaths: string[] = [];
  const state = { loopbackCalls: 0, deviceCalls: 0 };
  const deps: LoginDeps = {
    write: (line) => lines.push(line),
    store: (path) => {
      storePaths.push(path);
      return new MemoryStore();
    },
    signIn: async (_config, _store, signInDeps) => {
      state.loopbackCalls += 1;
      signInDeps?.present?.('https://identity.example/authorize?state=s');
      return answer;
    },
    signInWithDeviceCode: async (_config, _store, instruct: (instruction: DeviceCodeInstruction) => void) => {
      state.deviceCalls += 1;
      instruct({ verificationUri: 'https://identity.example/device', userCode: 'ABCD-EFGH' });
      return answer;
    },
  };
  return {
    deps,
    lines,
    storePaths,
    get loopbackCalls() {
      return state.loopbackCalls;
    },
    get deviceCalls() {
      return state.deviceCalls;
    },
  };
}

test("unconfigured identity is the config module's own refusal, before any flow or store is touched", async () => {
  const run = harness(ok(TOKENS));
  const env: NodeJS.ProcessEnv = { HOME: '/home/agent', PERISCOPE_CONFIG_DIR: '/cfg' };

  const result = await runLogin(env, run.deps);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.refusal.reason, 'identity-not-configured');
    assert.match(result.refusal.detail, /no default issuer/);
  }
  assert.equal(run.loopbackCalls, 0, 'no flow may run without a configured identity');
  assert.equal(run.deviceCalls, 0);
  assert.deepEqual(run.storePaths, [], 'the store factory must not be invoked for a refused config');
  assert.deepEqual(run.lines, [], 'a refusal is returned, not narrated');
});

test("the cache location is the daemon's own derivation: the OS home when no variable names one, a named refusal only when there is no home at all", async () => {
  // With PERISCOPE_CONFIG_DIR, HOME and USERPROFILE all absent, `tokenCachePath` falls back to the
  // OS home directory, so the "nowhere to keep the cache" refusal is reachable only on a machine
  // with no resolvable home. Both outcomes are pinned to the same derivation the daemon reads.
  const run = harness(ok(TOKENS));
  const env: NodeJS.ProcessEnv = {
    PERISCOPE_IDENTITY_AUTHORITY: ENV['PERISCOPE_IDENTITY_AUTHORITY'],
    PERISCOPE_IDENTITY_CLIENT_ID: 'c',
  };
  const derived = tokenCachePath(env);

  const result = await runLogin(env, run.deps);

  if (derived === null) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.refusal.reason, 'identity-config-invalid');
      assert.match(result.refusal.detail, /PERISCOPE_CONFIG_DIR/);
    }
    assert.equal(run.loopbackCalls + run.deviceCalls, 0, 'no flow may run with nowhere to write');
    assert.deepEqual(run.storePaths, []);
    return;
  }
  assert.equal(result.ok, true);
  assert.deepEqual(run.storePaths, [derived], 'the store must open at the path the daemon derives');
});

test('loopback is the default flow: the URL is presented and success names the cache path the daemon reads', async () => {
  const run = harness(ok(TOKENS));

  const result = await runLogin(ENV, run.deps);

  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, TOKENS);
  assert.equal(run.loopbackCalls, 1);
  assert.equal(run.deviceCalls, 0, 'the device-code flow is never reached by default');

  const expectedPath = tokenCachePath(ENV);
  assert.ok(expectedPath !== null);
  assert.deepEqual(
    run.storePaths,
    [expectedPath],
    'the store must be opened at exactly the path the daemon reads',
  );
  assert.ok(
    run.lines.some((line) => line.includes('https://identity.example/authorize?state=s')),
    run.lines.join('\n'),
  );
  assert.ok(
    run.lines.some((line) => line === `signed in; token cache written to ${expectedPath}`),
    run.lines.join('\n'),
  );
});

test('PERISCOPE_IDENTITY_DEVICE_CODE=1 selects the device-code flow and prints the URI with the user code', async () => {
  const run = harness(ok(TOKENS));

  const result = await runLogin({ ...ENV, PERISCOPE_IDENTITY_DEVICE_CODE: '1' }, run.deps);

  assert.equal(result.ok, true);
  assert.equal(run.deviceCalls, 1);
  assert.equal(run.loopbackCalls, 0, 'one flow runs, never both');
  const instruction = run.lines.find((line) => line.includes('https://identity.example/device'));
  assert.ok(instruction !== undefined, `no instruction line: ${run.lines.join('\n')}`);
  assert.match(instruction, /ABCD-EFGH/, 'the user code must travel with the URI');
});

test('a refused sign-in is written with its reason and detail, and returned unchanged', async () => {
  const refusal = refuse<CachedTokens>('token-grant-rejected', 'the provider said no');
  const run = harness(refusal);

  const result = await runLogin(ENV, run.deps);

  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.refusal, refusal.ok ? null : refusal.refusal);
  assert.ok(
    run.lines.some((line) => line.startsWith('sign-in failed: token-grant-rejected')),
    run.lines.join('\n'),
  );
  assert.ok(
    run.lines.some((line) => line.includes('the provider said no')),
    'the detail must reach the operator',
  );
  assert.equal(
    run.lines.some((line) => line.startsWith('signed in')),
    false,
  );
});

test('the policy-block code carries its do-not-retry line', async () => {
  const run = harness(refuse('token-grant-rejected', 'AADSTS530036: blocked by Conditional Access'));

  await runLogin({ ...ENV, PERISCOPE_IDENTITY_DEVICE_CODE: '1' }, run.deps);

  const remedy = run.lines.find((line) => line.startsWith('do not re-run the device code flow'));
  assert.ok(remedy !== undefined, `no remedy line: ${run.lines.join('\n')}`);
  assert.match(remedy, /PERISCOPE_IDENTITY_DEVICE_CODE/, 'the remedy must name the switch that changes flow');
});

test('control: a refusal without the policy-block code gets no do-not-retry line', async () => {
  const run = harness(refuse('token-grant-rejected', 'invalid_grant: the refresh token has expired'));

  await runLogin({ ...ENV, PERISCOPE_IDENTITY_DEVICE_CODE: '1' }, run.deps);

  assert.equal(
    run.lines.some((line) => line.startsWith('do not re-run')),
    false,
    `the remedy fired on an unrelated refusal: ${run.lines.join('\n')}`,
  );
});

test('a thrown error from the sign-in flow propagates rather than becoming a refusal', async () => {
  const run = harness(ok(TOKENS));
  const deps: LoginDeps = {
    ...run.deps,
    signIn: async () => {
      throw new Error('the listener died');
    },
  };

  await assert.rejects(runLogin(ENV, deps), /the listener died/);
});

test('a machine that already holds a paired credential is told the token will not be the one presented', async () => {
  const withPaired = harness(ok(TOKENS));
  const result = await runLogin(ENV, { ...withPaired.deps, pairedCredentialPresent: () => true });
  assert.equal(result.ok, true);
  assert.ok(
    withPaired.lines.some((line) => line.startsWith('note: this machine holds a paired credential')),
    withPaired.lines.join('\n'),
  );

  const without = harness(ok(TOKENS));
  await runLogin(ENV, { ...without.deps, pairedCredentialPresent: () => false });
  assert.equal(
    without.lines.some((line) => line.startsWith('note: this machine holds a paired credential')),
    false,
    'the control: no notice without a paired credential',
  );
});
