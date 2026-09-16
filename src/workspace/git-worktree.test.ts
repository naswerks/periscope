/**
 * The worktree provider, and the one rule that destroyed committed work.
 *
 * The `-B` matrix is the point of this file. `worktreeAddArgs` is pure, so the rule "never
 * hard-reset a branch that already exists" is checked directly rather than through a repository
 * somebody would have to create — and the failure it guards against is one where nothing errors and
 * the only evidence is commits that are no longer reachable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GitWorktreeProvider, worktreeAddArgs } from './git-worktree.js';
import type { CommandEffects, WorkspaceEffects } from './provider.js';

// ---------------------------------------------------------------------------
// The pure rule.
// ---------------------------------------------------------------------------

test('regression: an existing branch is attached to, and the argv carries no -B at all', () => {
  const args = worktreeAddArgs('/w/s1', 'periscope/s1', 'main', true);

  assert.deepEqual(args, ['worktree', 'add', '/w/s1', 'periscope/s1']);
  assert.equal(
    args.includes('-B'),
    false,
    '-B hard-resets the branch to the base ref, discarding every commit made in a worktree that was lost and re-provisioned',
  );
  assert.equal(
    args.includes('main'),
    false,
    'an attach must not name a base ref — that is what would move the branch',
  );
});

test('a new branch takes the -B create form, off the base ref', () => {
  assert.deepEqual(worktreeAddArgs('/w/s2', 'periscope/s2', 'main', false), [
    'worktree',
    'add',
    '-B',
    'periscope/s2',
    '/w/s2',
    'main',
  ]);
});

test('regression: the two forms differ in the operation, not only in argument order', () => {
  const attach = worktreeAddArgs('/w/s', 'b', 'main', true);
  const create = worktreeAddArgs('/w/s', 'b', 'main', false);

  // Sorted comparison: identical multisets would mean one command with reordered arguments, which is
  // what a "simplification" that unified the two branches would produce.
  assert.notDeepEqual(
    [...attach].sort(),
    [...create].sort(),
    'the attach and create forms collapsed into one command',
  );
  assert.equal(attach.length, 4);
  assert.equal(create.length, 6);
});

test('the rule is total over every branchExists value, with no third path', () => {
  for (const exists of [true, false]) {
    const args = worktreeAddArgs('/w/x', 'br', 'base', exists);
    assert.equal(args[0], 'worktree');
    assert.equal(args[1], 'add');
    assert.equal(args.includes('-B'), !exists, `-B presence must follow branchExists (${exists})`);
  }
});

// ---------------------------------------------------------------------------
// The provider, over recorded effects.
// ---------------------------------------------------------------------------

interface Recorded {
  readonly calls: string[][];
  readonly effects: WorkspaceEffects;
  readonly commands: CommandEffects;
}

/** `existing` names paths that already exist; `branches` names branches `rev-parse` will verify. */
function recorder(existing: string[] = [], branches: string[] = []): Recorded {
  const present = new Set(existing);
  const known = new Set(branches);
  const calls: string[][] = [];

  return {
    calls,
    effects: {
      async makeDirectory(path: string): Promise<void> {
        calls.push(['mkdir', path]);
        present.add(path);
      },
      async exists(path: string): Promise<boolean> {
        return present.has(path);
      },
      async removeDirectory(path: string): Promise<void> {
        calls.push(['rmdir', path]);
        present.delete(path);
      },
    },
    commands: {
      async run(program: string, args: readonly string[]): Promise<string> {
        calls.push([program, ...args]);
        if (args[0] === 'rev-parse') {
          const branch = args[2] ?? '';
          if (!known.has(branch)) throw new Error(`fatal: Needed a single revision: ${branch}`);
          return 'abc123';
        }
        return '';
      },
    },
  };
}

function provider(recorded: Recorded, branches: string[] = []): GitWorktreeProvider {
  return new GitWorktreeProvider({
    repositoryRoot: '/repo',
    workspaceRoot: '/work',
    baseRef: 'main',
    effects: recorded.effects,
    commands: recorded.commands,
    branchFor: (id) => `periscope/${id}`,
    ...(branches.length === 0 ? {} : {}),
  });
}

test('a first provision creates the branch off the base ref', async () => {
  const recorded = recorder();
  const result = await provider(recorded).provision('s1');

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.path, '/work/s1');
  assert.equal(result.ok && result.value.meta['attached'], 'created');

  const add = recorded.calls.find((call) => call[1] === 'worktree' && call[2] === 'add');
  assert.deepEqual(add, ['git', 'worktree', 'add', '-B', 'periscope/s1', '/work/s1', 'main']);
});

// The regression this file exists for. The directory was lost; the branch was not. Re-provisioning
// must attach at the branch's preserved tip. The `-B` form here would discard its commits silently.
test('regression: a lost directory whose branch survives re-provisions by attaching, never by resetting', async () => {
  const recorded = recorder([], ['periscope/s1']);
  const result = await provider(recorded).provision('s1');

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.meta['attached'], 'branch');

  const add = recorded.calls.find((call) => call[1] === 'worktree' && call[2] === 'add');
  assert.deepEqual(add, ['git', 'worktree', 'add', '/work/s1', 'periscope/s1']);
  assert.equal(add?.includes('-B'), false, 'the surviving branch was hard-reset — committed work is gone');
});

test('the branch probe runs for every session, not only ones expected to be re-provisioned', async () => {
  const recorded = recorder();
  await provider(recorded).provision('never-seen-before');

  const probe = recorded.calls.find((call) => call[1] === 'rev-parse');
  assert.deepEqual(probe, ['git', 'rev-parse', '--verify', 'periscope/never-seen-before']);
});

test('an existing directory is attached to without running git at all', async () => {
  const recorded = recorder(['/work/s1']);
  const result = await provider(recorded).provision('s1');

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.meta['attached'], 'directory');
  assert.deepEqual(
    recorded.calls.filter((call) => call[0] === 'git'),
    [],
    'an intact worktree directory was rebuilt — whatever was uncommitted in it is at risk',
  );
});

test('a failing git call becomes a named refusal rather than an exception', async () => {
  const recorded = recorder();
  const failing: CommandEffects = {
    async run(program, args): Promise<string> {
      if (args[0] === 'rev-parse') throw new Error('no such branch');
      throw new Error('fatal: not a git repository');
    },
  };
  const result = await new GitWorktreeProvider({
    repositoryRoot: '/repo',
    workspaceRoot: '/work',
    effects: recorded.effects,
    commands: failing,
  }).provision('s1');

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.reason, 'workspace-provision-failed');
  assert.match(!result.ok ? result.refusal.detail : '', /not a git repository/);
});

test('two sessions get two different worktree paths', async () => {
  const recorded = recorder();
  const under = provider(recorded);
  const a = await under.provision('alpha');
  const b = await under.provision('beta');

  assert.equal(a.ok && b.ok && a.value.path !== b.value.path, true);
  assert.equal(a.ok && a.value.path, '/work/alpha');
  assert.equal(b.ok && b.value.path, '/work/beta');
});

test('a session id carrying a path separator is refused, never sanitized', async () => {
  const recorded = recorder();
  for (const id of ['../escape', 'a/b', 'a\\b', '  ']) {
    const result = await provider(recorded).provision(id);
    assert.equal(result.ok, false, `${id} was accepted as a directory name`);
    assert.equal(!result.ok && result.refusal.reason, 'workspace-provision-failed');
  }
});

// The id names both a directory segment and a branch component, so the screen is the union of the
// two rule sets and the refusal names the offending character and the rule it breaks. An illegal id
// must be refused here, by name, and never reach git.
test('regression: an id illegal in a git refname or a win32 path segment is refused at the guard with the rule named', async () => {
  const recorded = recorder();
  const cases: ReadonlyArray<readonly [string, RegExp]> = [
    ['session:0f3a9c2e4b1d4e8a9c7b6a5d4e3f2a1b', /':'/],
    ['a:b', /':'/],
    ['a b', /' '/],
    ['a~b', /'~'/],
    ['a^b', /'\^'/],
    ['a[b', /'\['/],
    ['a?b', /'\?'/],
    ['a*b', /'\*'/],
    ['a"b', /'"'/],
    ['a<b', /'<'/],
    ['a|b', /'\|'/],
    ['a@{b', /'@\{'/],
    ['.hidden', /begins with/],
    ['a.', /ends with '\.'/],
    ['a.lock', /'\.lock'/],
    ['a\u0001b', /control character/],
  ];
  for (const [id, law] of cases) {
    const result = await provider(recorded).provision(id);
    assert.equal(result.ok, false, `${JSON.stringify(id)} was accepted as a workspace name`);
    assert.equal(!result.ok && result.refusal.reason, 'workspace-provision-failed');
    assert.match(
      !result.ok ? result.refusal.detail : '',
      law,
      `the refusal for ${JSON.stringify(id)} must name what it violated`,
    );
  }
  assert.deepEqual(
    recorded.calls.filter((call) => call[0] === 'git'),
    [],
    'an illegal id must be refused at the guard; git must never see it',
  );
});

// The control on the screen: legal hyphenated ids must still provision. A screen that refused these
// would pass every negative case above while breaking every caller.
test('control: hyphenated ids of the shapes callers actually use still provision', async () => {
  const recorded = recorder();
  const under = provider(recorded);
  for (const id of [
    'session-0f3a9c2e4b1d4e8a9c7b6a5d4e3f2a1b',
    'worker-19-4d2c8e1a6b3f4a5c9d8e7f6a5b4c3d2e',
  ]) {
    const result = await under.provision(id);
    assert.equal(
      result.ok,
      true,
      `${id} must provision — a screen refusing legal ids is the over-screen failure mode, and this pair is what catches it`,
    );
  }
});

// The length arm exists so a refusal can always be sent: every refusal echoes the id, and an id near
// `MAX_FRAME_BYTES` would make its own refusal unencodable. The bound is `MAX_WORKSPACE_ID_LENGTH`.
test('regression: an id over the length bound is refused at the guard with the bound named and the echo truncated', async () => {
  const recorded = recorder();
  const oversized = `k${'x'.repeat(65_000)}`;
  const result = await provider(recorded).provision(oversized);

  assert.equal(result.ok, false, 'a 65,001-character id was accepted as a workspace name');
  assert.equal(!result.ok && result.refusal.reason, 'workspace-provision-failed');
  const detail = !result.ok ? result.refusal.detail : '';
  assert.match(detail, /longer than 200 characters/, 'the refusal must name the bound');
  assert.match(detail, /65001 characters\)/, 'the truncated echo must state the original length');
  assert.ok(
    detail.length < 400,
    `the refusal detail echoed the oversized id (${detail.length} chars) — the unbounded-echo degradation this arm exists to end`,
  );
  assert.deepEqual(
    recorded.calls.filter((call) => call[0] === 'git'),
    [],
    'an over-length id must die at the guard, never inside git or the filesystem',
  );
});

test('control: an id at the bound still provisions — the arm refuses over, never at', async () => {
  const recorded = recorder();
  const atBound = 'k'.repeat(200);
  const result = await provider(recorded).provision(atBound);
  assert.equal(
    result.ok,
    true,
    'a 200-character id was refused — the bound is off by one or the arm over-screens',
  );
});

test('release does nothing unless removal was asked for', async () => {
  const recorded = recorder(['/work/s1']);
  const result = await provider(recorded).release('s1');

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [], 'a release nobody asked to remove touched the workspace');
});

test('release with remove alone runs worktree remove and never deletes the branch', async () => {
  const recorded = recorder(['/work/s1']);
  const result = await provider(recorded).release('s1', { remove: true });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, {
    path: '/work/s1',
    directoryRemoved: true,
    branchDeleted: false,
    refusal: null,
  });
  const git = recorded.calls.filter((call) => call[0] === 'git');
  assert.deepEqual(git, [['git', 'worktree', 'remove', '--force', '/work/s1']]);
  // The branch outlives the directory unless the ask names it. Deleting it would destroy the
  // commits the attach rule above exists to preserve, and unlike a directory it is not recoverable.
  assert.equal(
    git.some((call) => call.includes('branch') || call.includes('-D') || call.includes('-d')),
    false,
    'the release deleted a branch — its commits are unrecoverable',
  );
});

test('releasing a workspace that is already gone succeeds', async () => {
  const recorded = recorder();
  const result = await provider(recorded).release('never-existed', { remove: true });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, []);
});

test('a failing removal is a named refusal, not a silent leak', async () => {
  const recorded = recorder(['/work/s1']);
  const failing: CommandEffects = {
    async run(): Promise<string> {
      throw new Error('worktree is locked');
    },
  };
  const result = await new GitWorktreeProvider({
    repositoryRoot: '/repo',
    workspaceRoot: '/work',
    effects: recorded.effects,
    commands: failing,
  }).release('s1', { remove: true });

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.reason, 'workspace-release-failed');
});

test('a relative root is refused rather than resolved against whatever cwd the host has', async () => {
  const recorded = recorder();
  const result = await new GitWorktreeProvider({
    repositoryRoot: '/repo',
    workspaceRoot: 'relative/work',
    effects: recorded.effects,
    commands: recorded.commands,
  }).provision('s1');

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.reason, 'workspace-provision-failed');
});

test('the caller owns the branch name — no naming convention is baked in', async () => {
  const recorded = recorder();
  const result = await new GitWorktreeProvider({
    repositoryRoot: '/repo',
    workspaceRoot: '/work',
    baseRef: 'develop',
    branchFor: (id) => `review-bot/${id}/work`,
    effects: recorded.effects,
    commands: recorded.commands,
  }).provision('s9');

  assert.equal(result.ok && result.value.meta['branch'], 'review-bot/s9/work');
  assert.equal(result.ok && result.value.meta['baseRef'], 'develop');
});

// --- the inventory ------------------------------------------------------------------

const PORCELAIN = [
  'worktree /repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /work/session-150',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/periscope/session-150',
  '',
  'worktree /work/solo-detached',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
  'worktree /elsewhere/operator-checkout',
  'HEAD 4444444444444444444444444444444444444444',
  'branch refs/heads/periscope/outside',
  '',
].join('\n');

/** Commands answering canned text per git verb, and recording every call. */
function commandsAnswering(answers: Record<string, string | Error>): {
  calls: string[][];
  commands: CommandEffects;
} {
  const calls: string[][] = [];
  return {
    calls,
    commands: {
      async run(program: string, args: readonly string[]): Promise<string> {
        calls.push([program, ...args]);
        const answer = answers[args[0] ?? ''];
        if (answer instanceof Error) throw answer;
        return answer ?? '';
      },
    },
  };
}

function inventoryProvider(commands: CommandEffects): GitWorktreeProvider {
  return new GitWorktreeProvider({
    repositoryRoot: '/repo',
    workspaceRoot: '/work',
    effects: recorder().effects,
    commands,
  });
}

test('inventory lists only the worktrees under the workspace root, with the merged flag and the tip date', async () => {
  const { calls, commands } = commandsAnswering({
    worktree: PORCELAIN,
    'symbolic-ref': 'origin/main',
    branch: ['* main', '  periscope/session-150'].join('\n'),
    'for-each-ref': [
      'main\t2026-09-01T10:00:00+00:00',
      'periscope/session-150\t2026-09-09T08:30:00+00:00',
    ].join('\n'),
    'rev-list': '0',
  });
  const result = await inventoryProvider(commands).inventory();
  assert.ok(result.ok, result.ok ? '' : result.refusal.detail);
  assert.equal(result.value.defaultBranch, 'main');
  assert.deepEqual(
    result.value.entries.map((entry) => entry.key),
    ['session-150', 'solo-detached'],
    'the repository itself and a checkout outside the workspace root are never listed',
  );
  assert.deepEqual(result.value.entries[0], {
    key: 'session-150',
    path: '/work/session-150',
    branch: 'periscope/session-150',
    head: '2222222222222222222222222222222222222222',
    detached: false,
    locked: false,
    prunable: false,
    merged: true,
    aheadCount: 0,
    lastCommitAt: '2026-09-09T08:30:00+00:00',
  });
  assert.deepEqual(
    [
      result.value.entries[1]?.branch,
      result.value.entries[1]?.merged,
      result.value.entries[1]?.aheadCount,
      result.value.entries[1]?.lastCommitAt,
    ],
    [null, null, null, null],
    'a detached worktree has no branch, so no merged flag, no count and no tip',
  );
  // Three git reads for the whole inventory, plus one rev-list per BRANCH entry (the detached one has none).
  assert.deepEqual(
    calls.map((call) => call[1]),
    ['worktree', 'symbolic-ref', 'branch', 'for-each-ref', 'rev-list'],
  );
  assert.deepEqual(calls[4], ['git', 'rev-list', '--count', 'main..periscope/session-150']);
});

test('control: a branch NOT in the merged set reads merged false, so the flag discriminates', async () => {
  const { commands } = commandsAnswering({
    worktree: PORCELAIN,
    'symbolic-ref': 'origin/main',
    branch: '* main',
    'for-each-ref': '',
  });
  const result = await inventoryProvider(commands).inventory();
  assert.ok(result.ok);
  assert.equal(result.value.entries[0]?.merged, false);
});

test('the default branch falls back to main, then master, then null (merged unknown), never a guess', async () => {
  const noRemote = new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
  const mainOnly = commandsAnswering({
    worktree: PORCELAIN,
    'symbolic-ref': noRemote,
    'rev-parse': 'abc',
    branch: '',
    'for-each-ref': '',
  });
  const withMain = await inventoryProvider(mainOnly.commands).inventory();
  assert.ok(withMain.ok);
  assert.equal(withMain.value.defaultBranch, 'main');

  const nothing = commandsAnswering({
    worktree: PORCELAIN,
    'symbolic-ref': noRemote,
    'rev-parse': new Error('fatal: Needed a single revision'),
    'for-each-ref': '',
  });
  const withNone = await inventoryProvider(nothing.commands).inventory();
  assert.ok(withNone.ok);
  assert.equal(withNone.value.defaultBranch, null);
  assert.equal(
    withNone.value.entries[0]?.merged,
    null,
    'no default branch means no merged flag, not a false one',
  );
  assert.ok(
    !nothing.calls.some((call) => call[1] === 'branch'),
    'nothing to judge against, so the merged set is never asked for',
  );
});

test('a git that refuses to list is a named refusal, never a throw', async () => {
  const { commands } = commandsAnswering({ worktree: new Error('fatal: not a git repository') });
  const result = await inventoryProvider(commands).inventory();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.refusal.reason, 'workspace-list-failed');
    assert.match(result.refusal.detail, /not a git repository/);
  }
});

// ── Branch deletion: opt-in per ask, refused unmerged unless forced, judged before anything moves ──

/** A provider over an existing worktree whose git answers canned text per verb. */
function releaseHarness(
  existing: string[],
  answers: Record<string, string | Error>,
  commands?: CommandEffects,
): { calls: string[][]; provider: GitWorktreeProvider } {
  const answering = commandsAnswering(answers);
  const provider = new GitWorktreeProvider({
    repositoryRoot: '/repo',
    workspaceRoot: '/work',
    baseRef: 'main',
    effects: recorder(existing).effects,
    commands: commands ?? answering.commands,
    branchFor: (id) => `periscope/${id}`,
  });
  return { calls: answering.calls, provider };
}

const MERGED = ['* main', '  periscope/session-150', '  periscope/s9'].join('\n');

test('deleteBranch on a merged branch removes the worktree, then deletes the branch with -d', async () => {
  const { calls, provider } = releaseHarness(['/work/session-150'], {
    worktree: PORCELAIN,
    'symbolic-ref': 'origin/main',
    branch: MERGED,
  });

  const result = await provider.release('session-150', { remove: true, deleteBranch: true });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, {
    path: '/work/session-150',
    directoryRemoved: true,
    branchDeleted: true,
    refusal: null,
  });
  assert.deepEqual(calls, [
    ['git', 'worktree', 'list', '--porcelain'],
    ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    ['git', 'branch', '--merged', 'main', '--format=%(refname:short)'],
    ['git', 'worktree', 'remove', '--force', '/work/session-150'],
    ['git', 'branch', '-d', 'periscope/session-150'],
  ]);
});

test('control: deleteBranch on an UNMERGED branch refuses branch-not-merged and removes nothing', async () => {
  const { calls, provider } = releaseHarness(['/work/session-150'], {
    worktree: PORCELAIN,
    'symbolic-ref': 'origin/main',
    branch: '* main',
  });

  const result = await provider.release('session-150', { remove: true, deleteBranch: true });

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.reason, 'branch-not-merged');
  assert.match(
    !result.ok ? result.refusal.detail : '',
    /periscope\/session-150 is not merged into main.*nothing was removed/,
  );
  assert.equal(
    calls.some((call) => call[1] === 'worktree' && call[2] === 'remove'),
    false,
    'the directory went before the check',
  );
  assert.equal(
    calls.some((call) => call[1] === 'branch' && (call[2] === '-d' || call[2] === '-D')),
    false,
    'an unmerged branch was deleted',
  );
});

test('force deletes an unmerged branch with -D and never consults the merged set', async () => {
  const { calls, provider } = releaseHarness(['/work/session-150'], {
    worktree: PORCELAIN,
    branch: '* main',
  });

  const result = await provider.release('session-150', { remove: true, deleteBranch: true, force: true });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value?.branchDeleted, true);
  assert.deepEqual(
    calls.filter((call) => call[1] === 'branch'),
    [['git', 'branch', '-D', 'periscope/session-150']],
  );
  assert.equal(
    calls.some((call) => call[1] === 'symbolic-ref'),
    false,
    'force still judged the merge',
  );
});

test('an absent directory with deleteBranch deletes the scheme branch when it exists, and answers absent when it does not', async () => {
  const present = releaseHarness([], { 'symbolic-ref': 'origin/main', branch: MERGED });
  const gone = releaseHarness([], { 'rev-parse': new Error('fatal: Needed a single revision') });

  const deleted = await present.provider.release('s9', { remove: true, deleteBranch: true });
  const absent = await gone.provider.release('s9', { remove: true, deleteBranch: true });

  assert.deepEqual(deleted.ok && deleted.value, {
    path: '/work/s9',
    directoryRemoved: false,
    branchDeleted: true,
    refusal: null,
  });
  assert.deepEqual(
    present.calls.filter((call) => call[1] === 'branch' && call[2] === '-d'),
    [['git', 'branch', '-d', 'periscope/s9']],
  );
  assert.equal(
    present.calls.some((call) => call[1] === 'worktree'),
    false,
    'nothing to remove, yet a worktree command ran',
  );
  assert.deepEqual(absent.ok && absent.value, {
    path: '/work/s9',
    directoryRemoved: false,
    branchDeleted: false,
    refusal: null,
  });
  assert.equal(
    gone.calls.some((call) => call[1] === 'branch'),
    false,
    'a branch that does not exist was asked to go',
  );
});

test('a branch deletion that fails after the removal is a partial on the receipt, never a silent success', async () => {
  const calls: string[][] = [];
  const commands: CommandEffects = {
    async run(program: string, args: readonly string[]): Promise<string> {
      calls.push([program, ...args]);
      if (args[0] === 'branch' && args[1] === '-d')
        throw new Error("error: Cannot delete branch 'periscope/session-150' checked out elsewhere");
      if (args[0] === 'worktree' && args[1] === 'list') return PORCELAIN;
      if (args[0] === 'symbolic-ref') return 'origin/main';
      if (args[0] === 'branch') return MERGED;
      return '';
    },
  };
  const { provider } = releaseHarness(['/work/session-150'], {}, commands);

  const result = await provider.release('session-150', { remove: true, deleteBranch: true });

  assert.equal(result.ok, true, 'a partial is a receipt, not a whole refusal: the directory DID go');
  assert.equal(result.ok && result.value?.directoryRemoved, true);
  assert.equal(result.ok && result.value?.branchDeleted, false);
  assert.equal(result.ok && result.value?.refusal?.reason, 'workspace-release-failed');
  assert.match(
    result.ok ? (result.value?.refusal?.detail ?? '') : '',
    /removed the worktree at \/work\/session-150 but could not delete branch periscope\/session-150/,
  );
  assert.equal(
    calls.some((call) => call[1] === 'worktree' && call[2] === 'remove'),
    true,
  );
});

test('keyForPath names only a directory directly under the workspace root', () => {
  const posix = provider(recorder());
  assert.equal(posix.keyForPath('/work/s1'), 's1');
  assert.equal(posix.keyForPath('/work/s1/'), 's1', 'a trailing separator is the same directory');
  assert.equal(posix.keyForPath('/work'), null, 'the root is not a workspace');
  assert.equal(posix.keyForPath('/work/a/b'), null, 'a nested path is not a workspace');
  assert.equal(posix.keyForPath('/elsewhere/s1'), null, 'a path outside the root is never resolved');
  assert.equal(posix.keyForPath('relative/s1'), null, 'a relative path is never resolved');

  const windows = new GitWorktreeProvider({
    repositoryRoot: 'C:/repo',
    workspaceRoot: 'C:/work',
    effects: recorder().effects,
    commands: recorder().commands,
  });
  assert.equal(windows.keyForPath('C:\\work\\s1'), 's1', 'the observed path may carry the other separator');
});

test('the inventory is newest first by the tip date, the undated last, ties by key', async () => {
  const porcelain = [
    'worktree /repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /work/older',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/periscope/older',
    '',
    'worktree /work/detached-b',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    '',
    'worktree /work/newest',
    'HEAD 4444444444444444444444444444444444444444',
    'branch refs/heads/periscope/newest',
    '',
    'worktree /work/detached-a',
    'HEAD 5555555555555555555555555555555555555555',
    'detached',
    '',
  ].join('\n');
  const { commands } = commandsAnswering({
    worktree: porcelain,
    'symbolic-ref': 'origin/main',
    branch: '* main',
    'for-each-ref': [
      'main\t2026-09-01T10:00:00+00:00',
      'periscope/older\t2026-09-02T00:00:00+00:00',
      'periscope/newest\t2026-09-10T09:00:00+00:00',
    ].join('\n'),
  });
  const result = await inventoryProvider(commands).inventory();
  assert.ok(result.ok, result.ok ? '' : result.refusal.detail);
  assert.deepEqual(
    result.value.entries.map((entry) => entry.key),
    ['newest', 'older', 'detached-a', 'detached-b'],
    'git listed the fresh worktree third; the inventory puts it first, and the undated ones last in key order',
  );
});

test('aheadCount is the commits past the default branch: zero on a merged branch reads as "nothing here yet", N on an unmerged one, null when it cannot be read', async () => {
  const counted = await inventoryProvider(
    commandsAnswering({
      worktree: PORCELAIN,
      'symbolic-ref': 'origin/main',
      branch: '* main',
      'for-each-ref': '',
      'rev-list': '3',
    }).commands,
  ).inventory();
  assert.ok(counted.ok);
  assert.deepEqual(
    [counted.value.entries[0]?.merged, counted.value.entries[0]?.aheadCount],
    [false, 3],
    'unmerged with three commits',
  );

  const unreadable = await inventoryProvider(
    commandsAnswering({
      worktree: PORCELAIN,
      'symbolic-ref': 'origin/main',
      branch: '* main',
      'for-each-ref': '',
      'rev-list': new Error('fatal: bad revision'),
    }).commands,
  ).inventory();
  assert.ok(unreadable.ok, 'a count that cannot be read does not fail the inventory');
  assert.equal(unreadable.value.entries[0]?.aheadCount, null, 'null, never zero: zero is a reading');

  const noDefault = await inventoryProvider(
    commandsAnswering({
      worktree: PORCELAIN,
      'symbolic-ref': new Error('no remote HEAD'),
      'rev-parse': new Error('no such branch'),
      'for-each-ref': '',
    }).commands,
  ).inventory();
  assert.ok(noDefault.ok);
  assert.deepEqual(
    [noDefault.value.entries[0]?.merged, noDefault.value.entries[0]?.aheadCount],
    [null, null],
    'no default branch: neither reading can be judged',
  );
});
