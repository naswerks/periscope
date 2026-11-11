/**
 * Where a session may write, against a real agent: a Claude session writes under its temp folder and in
 * its own worktree of a further repository, both outside its own directory, and each file is on disk
 * afterwards. Claude is handed neither place as a directory of its own; the gate allows each write.
 *
 * It skips loudly. Without `PERISCOPE_LIVE=1` the probe is skipped with the reason in its name, and the
 * property is NOT exercised. Everything it makes is under the OS temp directory: the two repositories
 * the host serves are made here, with no settings of their own, and the turn runs on the cheapest model.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject } from '../control/frames.js';
import { PROTOCOL_VERSION, readStateTransition, sessionNew, sessionNewRequest } from '../control/frames.js';
import type { SessionTransition } from '../state/model.js';
import { peerOn, waitFor } from '../test-support/ws-peer.js';
import { GitWorktreeProvider } from '../workspace/git-worktree.js';
import { furtherWorkspaceRoot } from '../workspace/repositories.js';
import { PeriscopeHost } from './host.js';
import { nodeCommandEffects, nodeWorkspaceEffects } from './workspace-fs.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const skip = LIVE ? false : 'PERISCOPE_LIVE is not set — this property is NOT exercised';

const START_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 180_000;

const allow = async (): Promise<unknown> => ({ behavior: 'allow' });

/** Every state transition the peer received on one session's channel, in order. */
function transitionsOn(raw: readonly string[], sessionId: string): SessionTransition[] {
  const found: SessionTransition[] = [];
  for (const text of raw) {
    const frame = JSON.parse(text) as {
      frame?: string;
      sessionId?: string;
      payload?: { kind?: string; body?: unknown };
    };
    if (
      frame.frame !== 'session' ||
      frame.sessionId !== sessionId ||
      frame.payload?.kind !== 'session_update'
    )
      continue;
    const transition = readStateTransition(frame.payload.body as JsonObject);
    if (transition !== null) found.push(transition);
  }
  return found;
}

/** A repository with one commit, so a worktree of it has something to check out. */
function repositoryAt(path: string): void {
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  };
  git('init', '--initial-branch=main');
  writeFileSync(`${path}/README.md`, 'base\n', 'utf8');
  git('add', 'README.md');
  git('-c', 'user.email=probe@example.invalid', '-c', 'user.name=Probe', 'commit', '-m', 'base');
}

test(
  'live: a write the gate allows outside its own directory lands, under its temp folder and in its further worktree',
  { skip, timeout: 420_000 },
  async () => {
    const base = mkdtempSync(`${tmpdir()}/periscope-further-writes-`).replace(/\\/g, '/');
    const scratch = `${base}/scratch`;
    const workspaceRoot = `${base}/ws`;
    mkdirSync(scratch, { recursive: true });
    repositoryAt(`${base}/home`);
    repositoryAt(`${base}/tools`);
    const commands = nodeCommandEffects();
    const further = new GitWorktreeProvider({
      repositoryRoot: `${base}/tools`,
      workspaceRoot: furtherWorkspaceRoot(workspaceRoot, 'tools'),
      effects: nodeWorkspaceEffects,
      commands,
      branchFor: (key) => `probe/${key}`,
    });
    const peer = await peerOn({ ack: true });
    const host = new PeriscopeHost({
      controllerUrl: peer.url,
      hostId: 'live-further-writes',
      decide: allow,
      protectedPaths: [],
      // The temp folder is this host's to name; every spelling a platform reads names the one made here.
      baseEnv: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch },
      homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
      workspaces: new GitWorktreeProvider({
        repositoryRoot: `${base}/home`,
        workspaceRoot,
        effects: nodeWorkspaceEffects,
        commands,
        branchFor: (key) => `probe/${key}`,
      }),
      repositories: new Map([['tools', further]]),
    });
    const inTemp = `${scratch}/temp-probe.txt`;
    const inFurther = `${furtherWorkspaceRoot(workspaceRoot, 'tools')}/k1/further-probe.txt`;

    try {
      host.start();
      await waitFor(() => host.link.negotiatedVersion === PROTOCOL_VERSION, 'the welcome', START_TIMEOUT_MS);

      peer.send(
        's-1',
        1,
        sessionNew(null, {
          workspaceKey: 'k1',
          additionalRepositories: ['tools'],
          request: sessionNewRequest({ model: 'haiku' }),
        }),
      );
      peer.send('s-1', 2, {
        kind: 'session_prompt',
        text:
          `Use the Write tool twice and no other tool. First write the single word pomegranate to ${inTemp}. ` +
          `Then write the single word quince to ${inFurther}. Use exactly those absolute paths. ` +
          'If a write is refused, do not retry it. Then reply DONE.',
      });
      await waitFor(
        () => transitionsOn(peer.raw, 's-1').some((transition) => transition.cause.event === 'result'),
        'the turn to end',
        TURN_TIMEOUT_MS,
      );

      const transitions = transitionsOn(peer.raw, 's-1');
      const causes = transitions.map((transition) => `${transition.cause.kind}/${transition.cause.event}`);
      assert.equal(
        causes.includes('refusal/path-escapes-root'),
        false,
        `the gate refused a write it should allow: ${causes.join(', ')}`,
      );
      assert.equal(readFileSync(inTemp, 'utf8').trim(), 'pomegranate', 'the temp-folder write did not land');
      assert.equal(
        readFileSync(inFurther, 'utf8').trim(),
        'quince',
        'the further-worktree write did not land',
      );
      const spawning = transitions.find((transition) => transition.to === 'spawning');
      assert.equal(
        spawning?.where.repositories?.[0]?.worktree,
        `${furtherWorkspaceRoot(workspaceRoot, 'tools')}/k1`,
        'the session was not told where its further worktree is',
      );
    } finally {
      host.stop();
      await peer.close();
      // The agent's process lets go of its directory a moment after it exits on Windows; a failed
      // cleanup must not stand in for the probe's own answer.
      try {
        rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // Left in the OS temp directory.
      }
    }
  },
);
