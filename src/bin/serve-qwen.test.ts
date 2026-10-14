/**
 * The daemon offering Qwen Code: the two keys it is configured with, refused at start when they cannot
 * be used, and the one line the read at start prints.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import type { LinkHandlers } from '../control/link.js';
import type { HostLink } from '../host/host.js';
import { availableQwenEntry, unavailableQwenEntry } from '../host/qwen-runtime.js';
import type { QwenRuntimeRead, ReadQwenRuntimeOptions } from '../host/qwen-runtime.js';
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
  readonly reads: ReadQwenRuntimeOptions[];
}

function serve(dir: string, extra: NodeJS.ProcessEnv, read: QwenRuntimeRead | null = null): Run {
  const out: string[] = [];
  const reads: ReadQwenRuntimeOptions[] = [];
  const raw = { PERISCOPE_CONFIG_DIR: dir, HOME: '/home/agent' };
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
      readQwenRuntime: async (options) => {
        reads.push(options);
        return read ?? { entry: availableQwenEntry('0.25.1'), detail: null };
      },
    },
  );
  return { outcome, out, reads };
}

const refused = (run: Run): string => (run.outcome.ok ? '' : run.outcome.detail);

test('Qwen Code is offered with both keys or neither: one without the other refuses start by name', () =>
  withTempDir('serve-qwen', async (dir) => {
    assert.match(
      refused(serve(dir, { PERISCOPE_QWEN_BIN: 'C:/tools/qwen/cli-entry.js' })),
      /^PERISCOPE_QWEN_BIN is set without PERISCOPE_QWEN_HOME/,
    );
    assert.match(
      refused(serve(dir, { PERISCOPE_QWEN_HOME: 'C:/runner/qwen' })),
      /^PERISCOPE_QWEN_HOME is set without PERISCOPE_QWEN_BIN/,
    );
    const neither = serve(dir, {});
    assert.equal(neither.outcome.ok, true);
    assert.deepEqual(neither.reads, [], 'Qwen Code was read with neither key set');
    if (neither.outcome.ok) neither.outcome.host.stop();
  }));

test('a relative Qwen Code path, or a batch file for the CLI, refuses start by name', () =>
  withTempDir('serve-qwen', async (dir) => {
    assert.match(
      refused(serve(dir, { PERISCOPE_QWEN_BIN: 'cli-entry.js', PERISCOPE_QWEN_HOME: 'C:/runner/qwen' })),
      /PERISCOPE_QWEN_BIN must be an absolute path/,
    );
    assert.match(
      refused(serve(dir, { PERISCOPE_QWEN_BIN: 'C:/tools/qwen/cli-entry.js', PERISCOPE_QWEN_HOME: 'qwen' })),
      /PERISCOPE_QWEN_HOME must be an absolute path/,
    );
    assert.match(
      refused(serve(dir, { PERISCOPE_QWEN_BIN: 'C:/npm/qwen.cmd', PERISCOPE_QWEN_HOME: 'C:/runner/qwen' })),
      /PERISCOPE_QWEN_BIN names a batch file, which runs only through a shell/,
    );
  }));

test('with both keys the runtime is read at start over the configured CLI and home, and said in one line', () =>
  withTempDir('serve-qwen', async (dir) => {
    const run = serve(dir, {
      PERISCOPE_QWEN_BIN: 'C:/tools/qwen/cli-entry.js',
      PERISCOPE_QWEN_HOME: 'C:/runner/qwen',
    });
    assert.equal(run.outcome.ok, true, refused(run));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(run.reads[0]?.binary, 'C:/tools/qwen/cli-entry.js');
    assert.equal(run.reads[0]?.base, 'C:/runner/qwen');
    assert.ok(
      run.out.some((line) =>
        /\[qwen-code\] qwen-code 0\.25\.1, 0 model\(s\) in the hello, control tier intercepted-with-residual/.test(
          line,
        ),
      ),
      run.out.join('\n'),
    );
    if (run.outcome.ok) run.outcome.host.stop();
  }));

test('an unavailable Qwen Code is said with its reason, and the host still starts', () =>
  withTempDir('serve-qwen', async (dir) => {
    const reason =
      'the Qwen Code CLI C:/tools/qwen/cli-entry.js is absent; this host is pinned to Qwen Code 0.25.1';
    const run = serve(
      dir,
      { PERISCOPE_QWEN_BIN: 'C:/tools/qwen/cli-entry.js', PERISCOPE_QWEN_HOME: 'C:/runner/qwen' },
      { entry: unavailableQwenEntry('0.25.1', reason), detail: reason },
    );
    assert.equal(run.outcome.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(
      run.out.some(
        (line) => line.includes('[qwen-code] qwen-code is listed unavailable') && line.includes('is absent'),
      ),
      run.out.join('\n'),
    );
    if (run.outcome.ok) run.outcome.host.stop();
  }));
