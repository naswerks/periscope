/**
 * The properties that can only be proven against a real agent.
 *
 * Every environment lesson this package carries fails silently in production, and a substitute
 * would only ever prove itself. So these spawn a real process and read what actually happened.
 *
 * They skip loudly rather than quietly. Without `PERISCOPE_LIVE=1` each one is skipped with the
 * reason in its own name, so the suite summary reports a non-zero `skipped` count. That number is
 * the standing reminder that these properties are not exercised in an ordinary run — a silent pass
 * would read exactly like a proof.
 *
 * Every workspace here is an OS temporary directory, deliberately outside any repository. The
 * agent CLI discovers project settings by walking up from its working directory, so a workspace
 * inside a checkout inherits that checkout's `.claude/settings.json` — including any hooks it
 * declares, which would then run for real against whatever they point at. A probe must not be able
 * to reach a system it is not testing.
 *
 * Each turn is one word and its answer does not matter. These prove plumbing: that a variable is
 * absent, that credentials resolved, that a version was recorded. Driving real work to test
 * plumbing costs money and proves nothing extra.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { SDKMessage, SpawnOptions } from '../host/agent-process.js';
import type { HostedSession } from './session.js';
import { SessionRegistry } from './registry.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const skip = LIVE ? false : 'PERISCOPE_LIVE is not set — this property is NOT exercised';

/** Generous: the agent is a large native binary starting cold, and these are one-turn sessions. */
const START_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 120_000;

function workspaceOutsideAnyRepo(label: string): string {
  return mkdtempSync(`${tmpdir()}/periscope-live-${label}-`);
}

function registry(baseEnv: Readonly<Record<string, string | undefined>> = process.env): SessionRegistry {
  return new SessionRegistry({
    baseEnv,
    homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
    startTimeoutMs: START_TIMEOUT_MS,
  });
}

/** Wait for the turn's own result message — the proof that a turn actually completed. */
function firstResult(session: HostedSession, timeoutMs: number): Promise<SDKMessage | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      drop();
      resolve(null);
    }, timeoutMs);
    const drop = session.onMessage((message) => {
      if (message.type !== 'result') return;
      clearTimeout(timer);
      drop();
      resolve(message);
    });
  });
}

/** A minimal local plugin carrying exactly one skill, for the settings-source question. */
function pluginWithOneSkill(root: string, skillName: string): string {
  const dir = `${root}/probe-plugin`;
  mkdirSync(`${dir}/.claude-plugin`, { recursive: true });
  writeFileSync(
    `${dir}/.claude-plugin/plugin.json`,
    JSON.stringify({ name: 'periscope-probe', description: 'One skill, to see whether it is discovered.' }),
    'utf8',
  );
  mkdirSync(`${dir}/skills/${skillName}`, { recursive: true });
  writeFileSync(
    `${dir}/skills/${skillName}/SKILL.md`,
    `---\nname: ${skillName}\ndescription: A probe skill that exists only to be counted.\n---\n\nDo nothing.\n`,
    'utf8',
  );
  return dir;
}

// ---------------------------------------------------------------------------

test(
  'live: a spawned agent cannot see a variable that is not on the allow-list',
  { skip, timeout: 300_000 },
  async () => {
    const sentinel = 'PERISCOPE_SENTINEL_DO_NOT_INHERIT';
    const parentEnv = {
      ...process.env,
      [sentinel]: 'if-you-can-read-this-the-allow-list-failed',
    };

    // Positive control on the fixture: the hazard has to be in the parent environment, or the
    // absence proven below is the absence of something that was never there.
    assert.equal(sentinel in parentEnv, true, 'the sentinel must be in the parent env');
    assert.equal(
      'CLAUDE_CODE_CHILD_SESSION' in parentEnv || 'CLAUDE_EFFORT' in parentEnv,
      true,
      'this probe is only meaningful where at least one recorded hazard is genuinely live',
    );

    let observed: Record<string, string | undefined> | null = null;
    const workspace = workspaceOutsideAnyRepo('env');
    const sessions = registry(parentEnv);

    const opened = await sessions.open({
      cwd: workspace,
      prompt: 'Reply with the single word: ok',
      // The SDK's own seam for VMs and containers, used here to read the environment at the exact
      // moment of process creation — which is the child's environment, by construction.
      spawn: (options: SpawnOptions) => {
        observed = options.env;
        return spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      },
    });

    assert.ok(opened.ok, `the session should have started: ${JSON.stringify(opened)}`);
    assert.ok(observed !== null, 'the spawn seam was never called');
    const childEnv: Record<string, string | undefined> = observed;

    console.log('[live/env] child env key count :', Object.keys(childEnv).length);
    console.log('[live/env] sentinel in child   :', sentinel in childEnv);
    console.log('[live/env] CHILD_SESSION marker:', 'CLAUDE_CODE_CHILD_SESSION' in childEnv);
    console.log('[live/env] CLAUDE_EFFORT       :', 'CLAUDE_EFFORT' in childEnv);
    console.log('[live/env] USERPROFILE         :', 'USERPROFILE' in childEnv);
    console.log('[live/env] apiKeySource        :', opened.value.facts?.apiKeySource);
    console.log('[live/env] cliVersion          :', opened.value.facts?.cliVersion);

    assert.equal(sentinel in childEnv, false, 'an undeclared variable reached the agent');
    assert.equal('CLAUDE_CODE_CHILD_SESSION' in childEnv, false);
    assert.equal('CLAUDE_EFFORT' in childEnv, false);
    assert.equal('CLAUDECODE' in childEnv, false);

    // The other half: the keys that must survive did.
    assert.equal('USERPROFILE' in childEnv, true, 'USERPROFILE is load-bearing for ambient auth');
    assert.equal('PATH' in childEnv, true);

    // And the session is real — it reported a version and an identity of its own.
    assert.match(opened.value.facts?.cliVersion ?? '', /^\d+\.\d+\.\d+$/);
    assert.ok((opened.value.facts?.id ?? '').length > 0);

    const result = await firstResult(opened.value, TURN_TIMEOUT_MS);
    console.log(
      '[live/env] turn result         :',
      result === null
        ? 'NONE'
        : JSON.stringify({
            subtype: (result as { subtype?: string }).subtype,
            is_error: (result as { is_error?: boolean }).is_error,
            cost: (result as { total_cost_usd?: number }).total_cost_usd,
          }),
    );

    // This is the ambient-auth proof: a turn that completed without error means the agent found
    // its credentials, which on Windows it can only do through the USERPROFILE family.
    assert.ok(result !== null, 'the turn produced no result — the session did not authenticate');
    assert.equal((result as { is_error?: boolean }).is_error, false, 'the turn came back as an error');

    opened.value.stop('probe done');
    assert.equal(sessions.liveCount, 0, 'a stopped session leaves the registry');
  },
);

test(
  'live: the version receipt is per session, and plugin skills load with no settings sources',
  { skip, timeout: 300_000 },
  async () => {
    const workspace = workspaceOutsideAnyRepo('plugin-none');
    const plugin = pluginWithOneSkill(workspace, 'periscope-probe-skill');
    const sessions = registry();

    const opened = await sessions.open({
      cwd: workspace,
      prompt: 'Reply with the single word: ok',
      settingSources: [],
      plugins: [{ type: 'local', path: plugin }],
    });

    assert.ok(opened.ok, `the session should have started: ${JSON.stringify(opened)}`);
    const facts = opened.value.facts;
    assert.ok(facts !== null);

    console.log('[live/plugin-none] settingSources : []');
    console.log('[live/plugin-none] cliVersion     :', facts.cliVersion);
    console.log('[live/plugin-none] plugins        :', JSON.stringify(facts.plugins));
    console.log('[live/plugin-none] skills         :', JSON.stringify(facts.skills));

    // The answer: a plugin's skill is discovered with no settings sources at all.
    // It arrives plugin-qualified — `periscope-probe:periscope-probe-skill`, not the bare name —
    // which is why this matches the suffix. Checking for the bare name reports "not found" against
    // a skill that is plainly there, and would have inverted this whole result.
    assert.ok(
      facts.skills.some((name) => name.endsWith(':periscope-probe-skill')),
      `the plugin's skill was not discovered under settingSources: [] — got ${JSON.stringify(facts.skills)}`,
    );
    assert.ok(
      facts.plugins.some((plugin) => plugin.name === 'periscope-probe'),
      'the plugin itself was not loaded, so the skill result above proves nothing',
    );

    // The version receipt: a second session in the same process reports its own. A value cached at
    // module load would be indistinguishable from this one only while nothing changed underneath.
    assert.match(facts.cliVersion, /^\d+\.\d+\.\d+$/);
    assert.notEqual(facts.id, '', 'a second session has its own identity');

    opened.value.stop('probe done');
  },
);

test(
  'live: workspace trust is EXPLICIT — a provisioned directory is untrusted and says so',
  { skip, timeout: 300_000 },
  async () => {
    const workspace = workspaceOutsideAnyRepo('trust');
    const plugin = pluginWithOneSkill(workspace, 'periscope-probe-skill');

    // The probe supplies its own settings file, so what is under test is this package's settings
    // discovery rather than whatever repository the probe happens to run near.
    mkdirSync(`${workspace}/.claude`, { recursive: true });
    writeFileSync(
      `${workspace}/.claude/settings.json`,
      JSON.stringify({ permissions: { allow: ['Read(*)'] } }),
      'utf8',
    );

    const sessions = registry();
    const degrades: string[] = [];

    const created = sessions.create({
      cwd: workspace,
      settingSources: ['project'],
      plugins: [{ type: 'local', path: plugin }],
    });
    assert.ok(created.ok);
    created.value.onDegrade((degrade) => degrades.push(`${degrade.kind}: ${degrade.detail}`));

    created.value.prompt('Reply with the single word: ok');
    const live = await created.value.whenLive(START_TIMEOUT_MS);
    assert.ok(live.ok, `the session should have started: ${JSON.stringify(live)}`);

    console.log('[live/trust] workspaceTrust :', live.value.workspaceTrust);
    console.log('[live/trust] degrades       :', JSON.stringify(degrades));
    console.log('[live/trust] skills         :', JSON.stringify(live.value.skills));

    // The control leg for the settings-source question: the same plugin under `['project']`. If
    // this differed from the `[]` leg, the choice would cost something; it does not, which is what
    // makes the no-settings default free.
    assert.ok(
      live.value.skills.some((name) => name.endsWith(':periscope-probe-skill')),
      `the plugin's skill was not discovered under settingSources: ['project'] either`,
    );

    // The property: a directory this host just created has never been trusted, and the host says
    // so rather than discovering it as a line on stderr nobody read.
    assert.equal(
      live.value.workspaceTrust,
      'untrusted',
      'a freshly provisioned directory cannot have been trusted by anyone',
    );
    assert.ok(
      degrades.some((entry) => entry.startsWith('workspace_untrusted')),
      'asking for settings files in an untrusted workspace must be a named condition',
    );

    created.value.stop('probe done');
  },
);

test('live: a session survives resume with its context', { skip, timeout: 420_000 }, async () => {
  const workspace = workspaceOutsideAnyRepo('resume');
  const sessions = registry();

  const first = await sessions.open({
    cwd: workspace,
    prompt: 'Remember this word: pomegranate. Reply with only: stored',
  });
  assert.ok(first.ok, `the first session should have started: ${JSON.stringify(first)}`);
  const originalId = first.value.facts?.id ?? '';
  console.log('[live/resume] first session id :', originalId);

  const firstResultMessage = await firstResult(first.value, TURN_TIMEOUT_MS);
  assert.ok(firstResultMessage !== null, 'the first turn did not complete');
  first.value.stop('first turn done');

  // The host carries out a resume; it never decides when one happens.
  const resumed = await sessions.open({
    cwd: workspace,
    prompt: 'What word did I ask you to remember? Reply with only that word.',
    resume: originalId,
  });
  assert.ok(resumed.ok, `the resumed session should have started: ${JSON.stringify(resumed)}`);
  console.log('[live/resume] resumed session id:', resumed.value.facts?.id);

  const replies: string[] = [];
  resumed.value.onMessage((message) => {
    if (message.type !== 'assistant') return;
    for (const block of message.message.content) {
      if (block.type === 'text') replies.push(block.text);
    }
  });

  const secondResult = await firstResult(resumed.value, TURN_TIMEOUT_MS);
  assert.ok(secondResult !== null, 'the resumed turn did not complete');
  const said = replies.join(' ').toLowerCase();
  console.log('[live/resume] said            :', JSON.stringify(replies));

  // The property: the context crossed the resume. Nothing in the second turn's own words
  // contains the answer, so recalling it can only come from the first session's history.
  assert.match(said, /pomegranate/, 'the resumed session did not carry its context');

  resumed.value.stop('probe done');
});
