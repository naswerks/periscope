/**
 * Where a session may write, against a real agent: a Claude session writes under its temp folder and in
 * its own worktree of a further repository, both outside its own directory, with its Write tool and no
 * shell command, and each file is on disk afterwards. Claude is handed neither place as a directory of
 * its own; the gate allows each write. The control withholds the further repository from the session,
 * and the same check must then fail: the write is refused as outside the session's roots.
 *
 * It skips loudly. Without `PERISCOPE_LIVE=1` the probe is skipped with the reason in its name, and the
 * property is NOT exercised. Everything it makes is under the OS temp directory: the two repositories
 * the host serves are made here, with no settings of their own, and the turn runs on the cheapest model.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject } from '../control/frames.js';
import { PROTOCOL_VERSION, readStateTransition, sessionNew, sessionNewRequest } from '../control/frames.js';
import type { SessionTransition } from '../state/model.js';
import { assertWroteWithFileTools, causesOn } from '../test-support/write-check.js';
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

/** What one probe turn left: the frames the controller received, and where it asked the agent to write. */
interface ProbeRun {
  readonly raw: readonly string[];
  readonly inTemp: string;
  readonly inFurther: string;
  readonly furtherRoot: string;
}

/**
 * One session on a host serving a further repository, told to write one file under its temp folder and
 * one in its worktree of that repository with its Write tool. `namesFurther` false withholds the
 * repository from the session, so the second write has no root. `check` reads the run before cleanup.
 */
async function probe(namesFurther: boolean, check: (run: ProbeRun) => void): Promise<void> {
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
  const furtherRoot = `${furtherWorkspaceRoot(workspaceRoot, 'tools')}/k1`;
  const inTemp = `${scratch}/temp-probe.txt`;
  const inFurther = `${furtherRoot}/further-probe.txt`;

  try {
    host.start();
    await waitFor(() => host.link.negotiatedVersion === PROTOCOL_VERSION, 'the welcome', START_TIMEOUT_MS);

    peer.send(
      's-1',
      1,
      sessionNew(null, {
        workspaceKey: 'k1',
        ...(namesFurther ? { additionalRepositories: ['tools'] } : {}),
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
    check({ raw: [...peer.raw], inTemp, inFurther, furtherRoot });
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
}

test(
  'live: a write the gate allows outside its own directory lands, under its temp folder and in its further worktree, by the Write tool and no shell command',
  { skip, timeout: 420_000 },
  async () => {
    await probe(true, (run) => {
      assertWroteWithFileTools(run.raw, 's-1', [
        { path: run.inTemp, text: 'pomegranate' },
        { path: run.inFurther, text: 'quince' },
      ]);
      const spawning = transitionsOn(run.raw, 's-1').find((transition) => transition.to === 'spawning');
      assert.equal(
        spawning?.where.repositories?.[0]?.worktree,
        run.furtherRoot,
        'the session was not told where its further worktree is',
      );
    });
  },
);

test(
  'live control: with the further repository withheld, the write there is refused and the same check fails',
  { skip, timeout: 420_000 },
  async () => {
    await probe(false, (run) => {
      assert.ok(
        causesOn(run.raw, 's-1').includes('refusal/path-escapes-root'),
        `the write outside every root was not refused: ${causesOn(run.raw, 's-1').join(', ')}`,
      );
      assert.equal(existsSync(run.inFurther), false, 'a write the gate refused landed');
      assert.throws(() =>
        assertWroteWithFileTools(run.raw, 's-1', [
          { path: run.inTemp, text: 'pomegranate' },
          { path: run.inFurther, text: 'quince' },
        ]),
      );
    });
  },
);
