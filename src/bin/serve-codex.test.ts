/**
 * The daemon offering Codex: the two keys it is configured with, refused at start when they cannot be
 * used, and the one line the read at start prints.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import type { LinkHandlers } from '../control/link.js';
import type { HostLink } from '../host/host.js';
import { availableCodexEntry, codexHostModel, unavailableCodexEntry } from '../host/codex-runtime.js';
import type { CodexRuntimeRead, ReadCodexRuntimeOptions } from '../host/codex-runtime.js';
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
  readonly reads: ReadCodexRuntimeOptions[];
}

function serve(dir: string, extra: NodeJS.ProcessEnv, read: CodexRuntimeRead | null = null): Run {
  const out: string[] = [];
  const reads: ReadCodexRuntimeOptions[] = [];
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
      readCodexRuntime: async (options) => {
        reads.push(options);
        return read ?? { entry: availableCodexEntry('0.162.1', []), detail: null };
      },
    },
  );
  return { outcome, out, reads };
}

const refused = (run: Run): string => (run.outcome.ok ? '' : run.outcome.detail);

test('Codex is offered with both keys or neither: one without the other refuses start by name', () =>
  withTempDir('serve-codex', async (dir) => {
    assert.match(
      refused(serve(dir, { PERISCOPE_CODEX_BIN: 'C:/tools/codex.exe' })),
      /^PERISCOPE_CODEX_BIN is set without PERISCOPE_CODEX_HOME/,
    );
    assert.match(
      refused(serve(dir, { PERISCOPE_CODEX_HOME: 'C:/runner/codex-home' })),
      /^PERISCOPE_CODEX_HOME is set without PERISCOPE_CODEX_BIN/,
    );
    const neither = serve(dir, {});
    assert.equal(neither.outcome.ok, true);
    assert.deepEqual(neither.reads, [], 'Codex was read with neither key set');
    if (neither.outcome.ok) neither.outcome.host.stop();
  }));

test('a relative Codex path, or a batch file for the binary, refuses start by name', () =>
  withTempDir('serve-codex', async (dir) => {
    assert.match(
      refused(serve(dir, { PERISCOPE_CODEX_BIN: 'codex.exe', PERISCOPE_CODEX_HOME: 'C:/runner/codex-home' })),
      /PERISCOPE_CODEX_BIN must be an absolute path/,
    );
    assert.match(
      refused(serve(dir, { PERISCOPE_CODEX_BIN: 'C:/tools/codex.exe', PERISCOPE_CODEX_HOME: 'codex-home' })),
      /PERISCOPE_CODEX_HOME must be an absolute path/,
    );
    assert.match(
      refused(
        serve(dir, { PERISCOPE_CODEX_BIN: 'C:/npm/codex.cmd', PERISCOPE_CODEX_HOME: 'C:/runner/codex-home' }),
      ),
      /PERISCOPE_CODEX_BIN names a batch file, which runs only through a shell/,
    );
  }));

test('with both keys the runtime is read at start over the configured binary and home, and said in one line', () =>
  withTempDir('serve-codex', async (dir) => {
    const models = [
      codexHostModel({ id: 'gpt-6-sol', displayName: 'GPT-6-Sol', supportedReasoningEfforts: [] }),
    ];
    const run = serve(
      dir,
      { PERISCOPE_CODEX_BIN: 'C:/tools/codex.exe', PERISCOPE_CODEX_HOME: 'C:/runner/codex-home' },
      { entry: availableCodexEntry('0.162.1', models), detail: null },
    );
    assert.equal(run.outcome.ok, true, refused(run));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(run.reads[0]?.binary, 'C:/tools/codex.exe');
    assert.equal(run.reads[0]?.home, 'C:/runner/codex-home');
    assert.ok(
      run.out.some((line) =>
        /\[codex\] codex 0\.162\.1, 1 model\(s\) in the hello, control tier none/.test(line),
      ),
      run.out.join('\n'),
    );
    if (run.outcome.ok) run.outcome.host.stop();
  }));

test('an unavailable Codex is said with its reason, and the host still starts', () =>
  withTempDir('serve-codex', async (dir) => {
    const reason = 'the Codex binary C:/tools/codex.exe is absent; this host is pinned to Codex 0.162.1';
    const run = serve(
      dir,
      { PERISCOPE_CODEX_BIN: 'C:/tools/codex.exe', PERISCOPE_CODEX_HOME: 'C:/runner/codex-home' },
      { entry: unavailableCodexEntry('0.162.1', reason), detail: reason },
    );
    assert.equal(run.outcome.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(
      run.out.some(
        (line) => line.includes('[codex] codex is listed unavailable') && line.includes('is absent'),
      ),
      run.out.join('\n'),
    );
    if (run.outcome.ok) run.outcome.host.stop();
  }));
