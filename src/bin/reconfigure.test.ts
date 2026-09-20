/**
 * The configure seam: every refusal leaves the file untouched, the environment wins and says so,
 * a null value removes a key, and a roots change is refused while the host is busy.
 *
 * Real filesystem in a temp config directory, the same shape `config-file.test.ts` uses: the
 * property under test is "nothing was written", which a faked writer would only assert about
 * itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { candidateProblem, overriddenByEnvironment, reconfigureHost } from './reconfigure.js';
import { readConfigFile } from '../host/config-file.js';
import { GitWorktreeProvider } from '../workspace/git-worktree.js';

async function scratchEnv(extra: NodeJS.ProcessEnv = {}): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'periscope-reconfigure-'));
  return {
    env: { PERISCOPE_CONFIG_DIR: dir, PERISCOPE_CONTROLLER_URL: 'ws://controller.example/link', ...extra },
    dir,
  };
}

async function fileBytes(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, 'config.json'), 'utf8');
  } catch {
    return null;
  }
}

test('a key outside the wire-settable set refuses config-key-unknown and writes nothing', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const outcome = reconfigureHost(env, [{ key: 'PERISCOPE_HOST_ID', value: 'elsewhere' }], false);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.refusal.reason, 'config-key-unknown');
      assert.match(outcome.refusal.detail, /PERISCOPE_WORKSPACE_ROOT/, 'the detail names the settable set');
    }
    assert.equal(await fileBytes(dir), null, 'nothing was written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('regression: a posture the start-up screen would refuse is refused config-value-invalid before any write', async () => {
  const { env, dir } = await scratchEnv();
  try {
    // A scheme with no repository root behind it: legal text, unusable posture.
    const scheme = reconfigureHost(env, [{ key: 'PERISCOPE_BRANCH_SCHEME', value: '{repo}/{key}' }], false);
    assert.equal(scheme.ok, false);
    if (!scheme.ok) assert.equal(scheme.refusal.reason, 'config-value-invalid');
    assert.equal(await fileBytes(dir), null, 'the refused scheme must not land');

    // A relative root.
    const relative = reconfigureHost(env, [{ key: 'PERISCOPE_WORKSPACE_ROOT', value: 'workspaces' }], false);
    assert.equal(relative.ok, false);
    if (!relative.ok) assert.match(relative.refusal.detail, /absolute/);

    // A scheme with no {key}: every workspace would share one branch.
    const problem = candidateProblem({
      workspaceRoot: '/srv/ws',
      repositoryRoot: '/srv/repo',
      branchScheme: '{repo}/main',
      workspaceKey: null,
      controllerUrl: null,
      decisionUrl: null,
      agentHome: null,
      pluginDirs: null,
    });
    assert.match(problem ?? '', /\{key\}/);

    // The control: the same roots with a legal scheme pass the screen, so the arms above are
    // discriminating rather than refusing everything.
    assert.equal(
      candidateProblem({
        workspaceRoot: '/srv/ws',
        repositoryRoot: '/srv/repo',
        branchScheme: '{repo}/{key}',
        workspaceKey: null,
        controllerUrl: null,
        decisionUrl: null,
        agentHome: null,
        pluginDirs: null,
      }),
      null,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a roots change is refused config-host-busy while busy and applies when idle; a scheme change applies either way', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const roots = [
      { key: 'PERISCOPE_WORKSPACE_ROOT', value: '/srv/ws' },
      { key: 'PERISCOPE_REPOSITORY_ROOT', value: '/srv/repo' },
    ];
    const busy = reconfigureHost(env, roots, true);
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.equal(busy.refusal.reason, 'config-host-busy');
    assert.equal(await fileBytes(dir), null, 'a busy refusal writes nothing');

    // The control: the identical ask on an idle host applies and builds the git provider.
    const idle = reconfigureHost(env, roots, false);
    assert.equal(idle.ok, true);
    if (idle.ok) {
      assert.ok(idle.value.workspaces instanceof GitWorktreeProvider, 'both roots select the git provider');
      assert.deepEqual(idle.value.linkCapabilities, ['workspace:git-worktree']);
      assert.equal(idle.value.configuration.repositoryRoot, '/srv/repo');
      assert.equal(idle.value.configuration.workspaceRoot, '/srv/ws');
      assert.equal(idle.value.configuration.controllerUrl, 'ws://controller.example/link');
    }
    assert.deepEqual(readConfigFile(env).values, {
      PERISCOPE_WORKSPACE_ROOT: '/srv/ws',
      PERISCOPE_REPOSITORY_ROOT: '/srv/repo',
    });

    // A scheme change on the same, now-busy host applies: it renders at the next provision and
    // moves no root.
    const scheme = reconfigureHost(env, [{ key: 'PERISCOPE_BRANCH_SCHEME', value: '{repo}/{key}' }], true);
    assert.equal(scheme.ok, true);
    if (scheme.ok) {
      assert.deepEqual(scheme.value.linkCapabilities, ['workspace:git-worktree', 'workspace:branch-scheme']);
      assert.equal(scheme.value.configuration.branchScheme, '{repo}/{key}');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the environment wins: a written value the environment sets is reported as overridden and the effective value is the environment's", async () => {
  const { env, dir } = await scratchEnv({ PERISCOPE_AGENT_HOME: '/from/env' });
  try {
    const outcome = reconfigureHost(env, [{ key: 'PERISCOPE_AGENT_HOME', value: '/from/wire' }], false);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.value.configuration.agentHome, '/from/env', 'the environment wins per key');
      assert.equal(
        outcome.value.configuration.transcriptsRoot,
        '/from/env/projects',
        'the transcripts root derives from the home in effect',
      );
      // The scratch environment also sets the controller URL, a wire key since v8, so it is shadowed too.
      assert.deepEqual(outcome.value.overriddenByEnvironment, [
        'PERISCOPE_AGENT_HOME',
        'PERISCOPE_CONTROLLER_URL',
      ]);
      assert.equal(outcome.value.transcriptsRoot, '/from/env/projects');
    }
    assert.deepEqual(
      readConfigFile(env).values,
      { PERISCOPE_AGENT_HOME: '/from/wire' },
      'the file still holds what was asked',
    );
    assert.deepEqual(overriddenByEnvironment(env), ['PERISCOPE_AGENT_HOME', 'PERISCOPE_CONTROLLER_URL']);
    assert.deepEqual(overriddenByEnvironment({}), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a null value removes the key, and an empty string is its documented twin', async () => {
  const { env, dir } = await scratchEnv();
  try {
    assert.equal(reconfigureHost(env, [{ key: 'PERISCOPE_AGENT_HOME', value: '/srv/t' }], false).ok, true);
    assert.equal(reconfigureHost(env, [{ key: 'PERISCOPE_AGENT_HOME', value: null }], false).ok, true);
    assert.deepEqual(readConfigFile(env).values, {});
    assert.equal(reconfigureHost(env, [{ key: 'PERISCOPE_AGENT_HOME', value: '/srv/t' }], false).ok, true);
    assert.equal(reconfigureHost(env, [{ key: 'PERISCOPE_AGENT_HOME', value: '' }], false).ok, true);
    assert.deepEqual(readConfigFile(env).values, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a key named twice in one ask refuses config-value-invalid, and a corrupt file refuses config-write-failed', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const twice = reconfigureHost(
      env,
      [
        { key: 'PERISCOPE_AGENT_HOME', value: '/a' },
        { key: 'PERISCOPE_AGENT_HOME', value: '/b' },
      ],
      false,
    );
    assert.equal(twice.ok, false);
    if (!twice.ok) assert.equal(twice.refusal.reason, 'config-value-invalid');

    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'config.json'), 'not json', 'utf8');
    const corrupt = reconfigureHost(env, [{ key: 'PERISCOPE_AGENT_HOME', value: '/a' }], false);
    assert.equal(corrupt.ok, false);
    if (!corrupt.ok) assert.equal(corrupt.refusal.reason, 'config-write-failed');
    assert.equal(await fileBytes(dir), 'not json', 'a corrupt file is never merged over');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the control-plane addresses are settable: written to the file, reported from it, named pending, never applied live', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const live = {
      controllerUrl: 'ws://controller.example/link',
      decisionUrl: 'http://controller.example/decision',
    };
    const outcome = reconfigureHost(
      env,
      [
        { key: 'PERISCOPE_CONTROLLER_URL', value: 'wss://next.example/periscope/link' },
        { key: 'PERISCOPE_DECISION_URL', value: 'https://next.example/periscope/decision' },
      ],
      true,
      live,
    );
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.refusal.detail);
    if (outcome.ok) {
      assert.equal(
        outcome.value.configuration.controllerUrl,
        'ws://controller.example/link',
        'the environment sets the controller URL here, so it wins per key',
      );
      assert.equal(
        outcome.value.configuration.decisionUrl,
        'https://next.example/periscope/decision',
        'the file value is what the configuration reports',
      );
      assert.deepEqual(
        outcome.value.pendingRestart,
        ['PERISCOPE_DECISION_URL'],
        'the key whose file value is not the dialled one is pending; the shadowed one is not',
      );
      assert.deepEqual(outcome.value.overriddenByEnvironment, ['PERISCOPE_CONTROLLER_URL']);
    }
    assert.deepEqual(readConfigFile(env).values, {
      PERISCOPE_CONTROLLER_URL: 'wss://next.example/periscope/link',
      PERISCOPE_DECISION_URL: 'https://next.example/periscope/decision',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('control: an address the act cannot use refuses config-value-invalid and writes nothing; a busy host still takes an address', async () => {
  const { env, dir } = await scratchEnv();
  try {
    for (const [key, value] of [
      ['PERISCOPE_CONTROLLER_URL', 'https://controller.example/periscope/link'],
      ['PERISCOPE_DECISION_URL', 'wss://controller.example/periscope/decision'],
      ['PERISCOPE_DECISION_URL', 'controller.example/decision'],
    ] as const) {
      const outcome = reconfigureHost(env, [{ key, value }], true);
      assert.equal(outcome.ok, false, `${key}=${value} was accepted`);
      if (!outcome.ok) {
        assert.equal(outcome.refusal.reason, 'config-value-invalid');
        assert.match(outcome.refusal.detail, new RegExp(key));
      }
    }
    assert.equal(await fileBytes(dir), null, 'a refused address reached the file');

    const busy = reconfigureHost(
      env,
      [{ key: 'PERISCOPE_DECISION_URL', value: 'https://controller.example/decision' }],
      true,
    );
    assert.equal(busy.ok, true, 'an address is not a root: a busy host still writes it');
    if (busy.ok) assert.deepEqual(busy.value.pendingRestart, ['PERISCOPE_DECISION_URL']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an address written back to the value in effect is not pending', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const live = {
      controllerUrl: 'ws://controller.example/link',
      decisionUrl: 'http://controller.example/decision',
    };
    const outcome = reconfigureHost(
      env,
      [{ key: 'PERISCOPE_DECISION_URL', value: 'http://controller.example/decision' }],
      false,
      live,
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok)
      assert.deepEqual(outcome.value.pendingRestart, [], 'the file now says what the host already dials');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PERISCOPE_TRANSCRIPTS_ROOT is an unknown key, over the wire and in the file; the transcripts root derives from the agent home', async () => {
  const { env, dir } = await scratchEnv();
  try {
    const refused = reconfigureHost(env, [{ key: 'PERISCOPE_TRANSCRIPTS_ROOT', value: '/old/way' }], false);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.refusal.reason, 'config-key-unknown');

    await writeFile(join(dir, 'config.json'), JSON.stringify({ PERISCOPE_TRANSCRIPTS_ROOT: '/old/way' }));
    const unusable = reconfigureHost(env, [{ key: 'PERISCOPE_AGENT_HOME', value: '/new/home' }], false);
    assert.equal(unusable.ok, false, 'a file carrying the retired key is a file with an unknown key');

    await writeFile(join(dir, 'config.json'), JSON.stringify({}));
    const outcome = reconfigureHost(env, [{ key: 'PERISCOPE_AGENT_HOME', value: '/new/home' }], false);
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.refusal.detail);
    if (outcome.ok) {
      assert.equal(outcome.value.configuration.agentHome, '/new/home');
      assert.equal(outcome.value.transcriptsRoot, '/new/home/projects', 'derived from the agent home');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
