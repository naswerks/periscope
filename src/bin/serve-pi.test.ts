/**
 * The daemon offering pi: the two keys it is configured with, refused at start when they cannot be used,
 * the endpoints handed to the read at start, and the one line that read prints.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import type { LinkHandlers } from '../control/link.js';
import type { HostLink } from '../host/host.js';
import { availablePiEntry, unavailablePiEntry } from '../host/pi-runtime.js';
import type { PiRuntimeRead, ReadPiRuntimeOptions } from '../host/pi-runtime.js';
import { fakeAgents } from '../test-support/fake-agent.js';
import { withTempDir } from '../test-support/temp-dir.js';
import type { ServeOutcome } from './serve.js';
import { runServe } from './serve.js';

class QuietLink implements HostLink {
  handlers: LinkHandlers | null = null;
  send(): Result<void> {
    return ok(undefined);
  }
  start(): void {}
  stop(): void {}
  forgetSession(): void {}
}

interface Run {
  readonly outcome: ServeOutcome;
  readonly out: string[];
  readonly reads: ReadPiRuntimeOptions[];
}

function serve(dir: string, extra: NodeJS.ProcessEnv, read: PiRuntimeRead | null = null): Run {
  const out: string[] = [];
  const reads: ReadPiRuntimeOptions[] = [];
  const raw = { PERISCOPE_CONFIG_DIR: dir, HOME: '/home/agent', EXAMPLE_ENDPOINT_KEY: 'example-secret' };
  const merged = {
    ...raw,
    PERISCOPE_CONTROLLER_URL: 'ws://127.0.0.1:1/link',
    PERISCOPE_DECISION_URL: 'http://127.0.0.1:1/decision',
    PERISCOPE_HOST_ID: 'configured-host',
    ...extra,
  };
  const outcome = runServe(
    { raw, merged },
    {
      log: (line) => out.push(line),
      stderr: () => undefined,
      setExitCode: () => undefined,
      exit: () => undefined,
      onSignal: () => undefined,
      transport: async () => {
        throw new Error('no decision transport in this test');
      },
      link: () => new QuietLink(),
      getuid: () => 1000,
      startProcess: fakeAgents().start,
      readPiRuntime: async (options) => {
        reads.push(options);
        return read ?? { entry: availablePiEntry('1.2.0'), detail: null };
      },
    },
  );
  return { outcome, out, reads };
}

const refused = (run: Run): string => (run.outcome.ok ? '' : run.outcome.detail);

const BIN = 'C:/tools/pi/dist/bundle/cli.js';
const HOME = 'C:/runner/pi';

test('pi is offered with both keys or neither: one without the other refuses start by name', () =>
  withTempDir('serve-pi', async (dir) => {
    assert.match(
      refused(serve(dir, { PERISCOPE_PI_BIN: BIN })),
      /^PERISCOPE_PI_BIN is set without PERISCOPE_PI_HOME/,
    );
    assert.match(
      refused(serve(dir, { PERISCOPE_PI_HOME: HOME })),
      /^PERISCOPE_PI_HOME is set without PERISCOPE_PI_BIN/,
    );
    const neither = serve(dir, {});
    assert.equal(neither.outcome.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(neither.reads, [], 'pi was read with neither key set');
    if (neither.outcome.ok) neither.outcome.host.stop();
  }));

test('a relative pi path, or a batch file for the CLI, refuses start by name', () =>
  withTempDir('serve-pi', async (dir) => {
    assert.match(
      refused(serve(dir, { PERISCOPE_PI_BIN: 'cli.js', PERISCOPE_PI_HOME: HOME })),
      /PERISCOPE_PI_BIN must be an absolute path/,
    );
    assert.match(
      refused(serve(dir, { PERISCOPE_PI_BIN: BIN, PERISCOPE_PI_HOME: 'pi' })),
      /PERISCOPE_PI_HOME must be an absolute path/,
    );
    assert.match(
      refused(serve(dir, { PERISCOPE_PI_BIN: 'C:/npm/pi.cmd', PERISCOPE_PI_HOME: HOME })),
      /PERISCOPE_PI_BIN names a batch file, which runs only through a shell/,
    );
  }));

test('with both keys pi is read at start over the configured CLI and home, with the endpoints it may open on, and said in one line', () =>
  withTempDir('serve-pi', async (dir) => {
    const path = join(dir, 'endpoints.json');
    const router = {
      name: 'router',
      wireApi: 'openai-chat',
      runtimes: ['pi'],
      baseUrl: 'https://router.example/v1',
      credential: { env: 'EXAMPLE_ENDPOINT_KEY' },
      models: ['vendor/model-a'],
    };
    await writeFile(path, JSON.stringify({ endpoints: [router] }), 'utf8');
    const run = serve(dir, {
      PERISCOPE_PI_BIN: BIN,
      PERISCOPE_PI_HOME: HOME,
      PERISCOPE_MODEL_ENDPOINTS: path,
    });
    assert.equal(run.outcome.ok, true, refused(run));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(run.reads[0]?.binary, BIN);
    assert.equal(run.reads[0]?.base, HOME);
    assert.deepEqual(
      (run.reads[0]?.endpoints ?? []).map((route) => route.name),
      ['router'],
      'the endpoints were not handed to the read',
    );
    assert.ok(
      run.out.some((line) =>
        /\[pi\] pi 1\.2\.0, 0 model\(s\) in the hello, control tier intercepted\b/.test(line),
      ),
      run.out.join('\n'),
    );
    if (run.outcome.ok) run.outcome.host.stop();
  }));

test('an unavailable pi is said with its reason, and the host still starts', () =>
  withTempDir('serve-pi', async (dir) => {
    const reason = `the pi CLI ${BIN} is absent; this host is pinned to pi 1.2.0`;
    const run = serve(
      dir,
      { PERISCOPE_PI_BIN: BIN, PERISCOPE_PI_HOME: HOME },
      { entry: unavailablePiEntry('1.2.0', reason), detail: reason },
    );
    assert.equal(run.outcome.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(
      run.out.some((line) => line.includes('[pi] pi is listed unavailable') && line.includes('is absent')),
      run.out.join('\n'),
    );
    if (run.outcome.ok) run.outcome.host.stop();
  }));
