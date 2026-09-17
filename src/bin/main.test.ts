/**
 * The command dispatch, drivable without a process. Every verb and every edge is injected through
 * `Io`, so what is proven here is the wiring: which verb runs, which view of the environment it is
 * handed, and how each outcome reaches stdout, stderr and the exit code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ok, refuse } from '../core/result.js';
import { withTempDir } from '../test-support/temp-dir.js';
import { USAGE } from './command.js';
import type { Io } from './main.js';
import { main, processIo } from './main.js';
import type { ServeViews } from './serve.js';

/** Everything `main` did, recorded. */
interface Recorded {
  readonly io: Io;
  readonly out: string[];
  readonly err: string[];
  readonly exitCodes: number[];
  readonly loginEnvs: NodeJS.ProcessEnv[];
  readonly pairCalls: { code: string | null; env: NodeJS.ProcessEnv }[];
  readonly configCalls: { key: string | null; value: string | null; env: NodeJS.ProcessEnv }[];
  readonly serveViews: ServeViews[];
}

interface Answers {
  readonly login?: Io['runLogin'];
  readonly pair?: Io['runPair'];
  readonly config?: Io['runConfig'];
}

function recording(answers: Answers = {}): Recorded {
  const out: string[] = [];
  const err: string[] = [];
  const exitCodes: number[] = [];
  const loginEnvs: NodeJS.ProcessEnv[] = [];
  const pairCalls: Recorded['pairCalls'] = [];
  const configCalls: Recorded['configCalls'] = [];
  const serveViews: ServeViews[] = [];

  const io: Io = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    setExitCode: (code) => exitCodes.push(code),
    runLogin: (env, deps) => {
      loginEnvs.push(env);
      return (answers.login ?? (async () => ok({} as never)))(env, deps);
    },
    runPair: (code, env, deps) => {
      pairCalls.push({ code, env });
      return (answers.pair ?? (async () => ({ ok: true as const, hostId: 'ph', path: '/p' })))(
        code,
        env,
        deps,
      );
    },
    runConfig: (key, value, env) => {
      configCalls.push({ key, value, env });
      return (answers.config ?? (() => ({ ok: true, lines: ['configured'] })))(key, value, env);
    },
    serve: (views) => {
      serveViews.push(views);
      return { ok: false, detail: 'not started by this test' };
    },
  };
  return { io, out, err, exitCodes, loginEnvs, pairCalls, configCalls, serveViews };
}

/** A config dir holding a file that sets the decision URL, so the merged view is distinguishable from the raw one. */
function withConfigFile<T>(body: (raw: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  return withTempDir('main', async (dir) => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ PERISCOPE_DECISION_URL: 'http://from-file.example/decision' }),
      'utf8',
    );
    return body({ PERISCOPE_CONFIG_DIR: dir, HOME: '/home/agent' });
  });
}

function withCorruptConfigFile<T>(body: (raw: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  return withTempDir('main-corrupt', async (dir) => {
    await writeFile(join(dir, 'config.json'), 'this is not JSON\n', 'utf8');
    return body({ PERISCOPE_CONFIG_DIR: dir, HOME: '/home/agent' });
  });
}

test('help prints USAGE to stdout and touches nothing else', () => {
  for (const argv of [['help'], ['--help'], ['-h']]) {
    const run = recording();
    const outcome = main(argv, {}, run.io);
    assert.equal(outcome, undefined, 'help is synchronous');
    assert.deepEqual(run.out, [USAGE]);
    assert.deepEqual(run.err, []);
    assert.deepEqual(run.exitCodes, []);
    assert.equal(
      run.loginEnvs.length + run.pairCalls.length + run.configCalls.length + run.serveViews.length,
      0,
    );
  }
});

test('an unknown verb is named on stderr with USAGE, exits 1, and starts nothing', () => {
  const run = recording();
  void main(['logn'], {}, run.io);

  assert.equal(run.err.length, 1);
  assert.match(run.err[0] ?? '', /^periscope: unknown command 'logn'\n\n/);
  assert.ok((run.err[0] ?? '').endsWith(USAGE));
  assert.deepEqual(run.exitCodes, [1]);
  assert.deepEqual(run.out, []);
  assert.equal(run.serveViews.length, 0, 'a typo must never start a host');
});

test('login runs on the merged view and a success writes nothing more', () =>
  withConfigFile(async (raw) => {
    const run = recording();
    await main(['login'], raw, run.io);

    assert.equal(run.loginEnvs.length, 1);
    assert.equal(
      run.loginEnvs[0]?.['PERISCOPE_DECISION_URL'],
      'http://from-file.example/decision',
      'the file must fill the absence',
    );
    assert.equal(raw['PERISCOPE_DECISION_URL'], undefined, 'the raw view must stay untouched');
    assert.deepEqual(run.err, []);
    assert.deepEqual(run.exitCodes, []);
  }));

test('regression: a refused login is reported on stderr with its reason and detail, and exits 1', () =>
  withConfigFile(async (raw) => {
    const run = recording({ login: async () => refuse('token-grant-rejected', 'the provider said no') });
    await main(['login'], raw, run.io);

    assert.deepEqual(run.err, ['periscope: login failed - token-grant-rejected - the provider said no']);
    assert.deepEqual(run.exitCodes, [1]);
  }));

test('a login that throws is reported, never an unhandled rejection with exit 0', () =>
  withConfigFile(async (raw) => {
    const run = recording({
      login: async () => {
        throw new Error('the listener died');
      },
    });
    await main(['login'], raw, run.io);

    assert.deepEqual(run.err, ['periscope: login failed - the listener died']);
    assert.deepEqual(run.exitCodes, [1]);
  }));

test('pair runs on the merged view with the code as parsed', () =>
  withConfigFile(async (raw) => {
    const run = recording();
    await main(['pair', 'THE-code'], raw, run.io);

    assert.equal(run.pairCalls.length, 1);
    assert.equal(run.pairCalls[0]?.code, 'THE-code');
    assert.equal(run.pairCalls[0]?.env['PERISCOPE_DECISION_URL'], 'http://from-file.example/decision');
    assert.deepEqual(run.err, []);
    assert.deepEqual(run.exitCodes, []);
  }));

test('a refused pair is reported with its detail and exits 1', () =>
  withConfigFile(async (raw) => {
    const run = recording({ pair: async () => ({ ok: false, detail: 'the controller refused this code' }) });
    await main(['pair', 'c'], raw, run.io);

    assert.deepEqual(run.err, ['periscope: pair failed - the controller refused this code']);
    assert.deepEqual(run.exitCodes, [1]);
  }));

test('a pair that throws is reported, never an unhandled rejection with exit 0', () =>
  withConfigFile(async (raw) => {
    const run = recording({
      pair: async () => {
        throw new Error('ECONNRESET');
      },
    });
    await main(['pair', 'c'], raw, run.io);

    assert.deepEqual(run.err, ['periscope: pair failed - ECONNRESET']);
    assert.deepEqual(run.exitCodes, [1]);
  }));

test('a thrown non-Error is stringified rather than lost', () =>
  withConfigFile(async (raw) => {
    const run = recording({
      pair: async () => {
        // deliberate: a non-Error rejection is the case under test
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'a bare string';
      },
    });
    await main(['pair', 'c'], raw, run.io);

    assert.deepEqual(run.err, ['periscope: pair failed - a bare string']);
  }));

test('regression: config runs on the raw view, so a file value is never marked as overridden by itself', () =>
  withConfigFile(async (raw) => {
    const run = recording();
    void main(['config', 'PERISCOPE_DECISION_URL'], raw, run.io);

    assert.equal(run.configCalls.length, 1);
    assert.equal(run.configCalls[0]?.key, 'PERISCOPE_DECISION_URL');
    assert.equal(run.configCalls[0]?.value, null);
    assert.equal(
      run.configCalls[0]?.env['PERISCOPE_DECISION_URL'],
      undefined,
      'config must see the environment before the merge',
    );
    assert.deepEqual(run.out, ['configured']);
    assert.deepEqual(run.exitCodes, []);
  }));

test('a failed config invocation sends its lines to stderr and exits 1', () => {
  const run = recording({ config: () => ({ ok: false, lines: ['first', 'second'] }) });
  void main(['config', 'PERISCOPE_TYPO', 'x'], { HOME: '/home/agent' }, run.io);

  assert.equal(run.configCalls[0]?.value, 'x');
  assert.deepEqual(run.err, ['first', 'second']);
  assert.deepEqual(run.out, []);
  assert.deepEqual(run.exitCodes, [1]);
});

test('regression: a corrupt config file is fatal for login and pair before the verb runs, and config still runs', () =>
  withCorruptConfigFile(async (raw) => {
    for (const argv of [['login'], ['pair', 'c']]) {
      const run = recording();
      await main(argv, raw, run.io);
      assert.equal(run.err.length, 1, `${argv[0]}: ${run.err.join('\n')}`);
      assert.match(run.err[0] ?? '', /^periscope: the config file at .* is not JSON/);
      assert.deepEqual(run.exitCodes, [1]);
      assert.equal(
        run.loginEnvs.length + run.pairCalls.length,
        0,
        `${argv[0]} must not run over a corrupt file`,
      );
    }

    // The escape hatch: the verb that repairs the file must still reach it.
    const run = recording();
    void main(['config'], raw, run.io);
    assert.equal(run.configCalls.length, 1);
    assert.deepEqual(run.err, []);
  }));

test('serve is handed both views: configuration merged, the raw environment as received', () =>
  withConfigFile(async (raw) => {
    const run = recording();
    const outcome = main([], raw, run.io);

    assert.equal(outcome, undefined, 'serve is synchronous');
    assert.equal(run.serveViews.length, 1);
    const views = run.serveViews[0];
    assert.ok(views !== undefined);
    assert.equal(views.raw, raw, 'the raw view is the very object main received');
    assert.notEqual(typeof views.merged, 'string');
    if (typeof views.merged !== 'string') {
      assert.equal(views.merged['PERISCOPE_DECISION_URL'], 'http://from-file.example/decision');
    }
  }));

test('serve with an explicit verb is the same arm as no verb', () => {
  const run = recording();
  void main(['serve'], { HOME: '/home/agent' }, run.io);
  assert.equal(run.serveViews.length, 1);
});

test('a corrupt config file reaches serve as the problem, for serve to report after its own root check', () =>
  withCorruptConfigFile(async (raw) => {
    const run = recording();
    void main([], raw, run.io);

    const views = run.serveViews[0];
    assert.ok(views !== undefined);
    assert.equal(typeof views.merged, 'string');
    assert.match(typeof views.merged === 'string' ? views.merged : '', /is not JSON/);
    assert.deepEqual(run.err, [], "the report is serve's, after the root refusal has had its turn");
  }));

test('control: the production io names the three process edges', () => {
  const io = processIo();
  assert.equal(typeof io.stdout, 'function');
  assert.equal(typeof io.stderr, 'function');
  assert.equal(typeof io.setExitCode, 'function');
  assert.equal(io.serve, undefined, 'serve takes its production default inside main');
});

test('version prints the package version to stdout and touches nothing else', () => {
  for (const argv of [['version'], ['--version'], ['-v']]) {
    const run = recording();
    const outcome = main(argv, {}, { ...run.io, version: () => '1.2.3' });
    assert.equal(outcome, undefined, 'version is synchronous');
    assert.deepEqual(run.out, ['1.2.3']);
    assert.deepEqual(run.err, []);
    assert.deepEqual(run.exitCodes, []);
    assert.equal(
      run.loginEnvs.length + run.pairCalls.length + run.configCalls.length + run.serveViews.length,
      0,
    );
  }
});
