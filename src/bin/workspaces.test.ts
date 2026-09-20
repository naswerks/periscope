/**
 * The provider selector.
 *
 * `GitWorktreeProvider` is tested against a real repository in `host/workspace-fs.test.ts`; a
 * selector that hard-coded `PlainDirProvider` would leave it unreachable and no session
 * provisioned by this binary would ever get a branch. That gap lives in the composition root, so
 * it is pinned here.
 *
 * These tests are about selection only. Each provider's behaviour is proven by its own suite; what
 * is pinned here is which one a real process gets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BRANCH_SCHEME,
  type WorkspaceConfig,
  branchNameProblem,
  branchRenderer,
  hostConfigurationOf,
  workspaceCapabilitiesOf,
  workspacePostureProblem,
  workspacesFor,
} from './workspaces.js';
import { GitWorktreeProvider } from '../workspace/git-worktree.js';
import { PlainDirProvider } from '../workspace/plain-dir.js';

function config(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return { workspaceRoot: null, repositoryRoot: null, branchScheme: null, ...overrides };
}

test('no workspace root leaves the controller cwd in use — the posture that shares one directory', () => {
  // Pinned because it is the weakest posture, not because it is good: with no provider the
  // controller's own `cwd` is used verbatim, so every session on the host shares one directory. It is
  // the shipped default, and this test exists so the next reader meets it as a stated fact.
  assert.equal(workspacesFor(config()), null);
  assert.equal(workspacesFor(config({ workspaceRoot: '' })), null);
});

test('a workspace root alone still selects the plain-directory provider — unchanged behaviour', () => {
  assert.ok(
    workspacesFor(config({ workspaceRoot: '/srv/workspaces' })) instanceof PlainDirProvider,
    'a deployment that names no repository must behave exactly as before — the git mode is additive, ' +
      'and a selector that changed this would be a silent migration',
  );
});

test('regression: a workspace root and a repository root select the git worktree provider', () => {
  assert.ok(
    workspacesFor(config({ workspaceRoot: '/srv/workspaces', repositoryRoot: '/srv/repo' })) instanceof
      GitWorktreeProvider,
    'without this a session gets no branch, and a controller that admits a receipted own-branch ' +
      'push has nothing to admit',
  );
});

test('control: a repository root alone selects nothing — it is not a second way to turn workspaces on', () => {
  // Without this test, "a repository root selects git" would be satisfied by a selector that ignored
  // the workspace root entirely — and the git provider cannot place a worktree without one.
  assert.equal(workspacesFor(config({ repositoryRoot: '/srv/repo' })), null);
});

test('the selector supplies the default scheme {repo}/{key} when none is configured, and the path from the root', () => {
  // `git-worktree.ts`'s header states that branch naming is the caller's decision, and this file is
  // the caller: with no scheme it names the default, so a session lands on `repo/<key>` — the name
  // the key already carries (session-150, run-34) under the repository's own name.
  const provider = workspacesFor(
    config({ workspaceRoot: '/srv/workspaces', repositoryRoot: '/srv/repo' }),
  ) as GitWorktreeProvider;

  assert.equal(DEFAULT_BRANCH_SCHEME, '{repo}/{key}');
  assert.equal(branchRenderer(DEFAULT_BRANCH_SCHEME, '/srv/repo')('session-150'), 'repo/session-150');
  assert.equal(
    provider.pathFor('session-150'),
    '/srv/workspaces/session-150',
    'the session path is derived from the workspace root the selector passed through',
  );
});

test('control: {kind} and {id} are not placeholders — the posture screen refuses them by name', () => {
  const problem = workspacePostureProblem({
    workspaceRoot: '/srv/ws',
    repositoryRoot: '/srv/repo',
    branchScheme: '{repo}/{kind}-{id}',
    workspaceKey: null,
  });
  assert.notEqual(
    problem,
    null,
    'a scheme with {kind}/{id} passed the screen — the runner would render it literally',
  );
  assert.match(problem ?? '', /kind/);
});

// --- the branch scheme, and the workspace posture screen (v5) -----------------

test('branchRenderer renders {key} and {repo}, from the repository root basename', () => {
  const render = branchRenderer('periscope/{repo}/{key}', 'C:\\srv\\my-repo');
  assert.equal(render('effort-1'), 'periscope/my-repo/effort-1');
  assert.equal(branchRenderer('agents/{key}', '/srv/repo')('k2'), 'agents/k2');
});

test('regression: a render the refname screen refuses throws with the scheme and the violation named', () => {
  // A legal key that renders an illegal branch: the repo basename begins with a dot, so the
  // rendered component fails the same rule the key already passed, one step later.
  const render = branchRenderer('periscope/{repo}/{key}', '/srv/.hidden-repo');
  assert.throws(
    () => render('effort-1'),
    /rendered an illegal branch name/,
    'an illegal render must refuse by name, never reach git',
  );
  // The control: the same scheme over an ordinary repo renders. Without it, a renderer throwing
  // on everything would make the refusal case green while proving nothing.
  assert.equal(branchRenderer('periscope/{repo}/{key}', '/srv/repo')('effort-1'), 'periscope/repo/effort-1');
});

test('branchNameProblem screens per component and the doubled/edge-slash shapes', () => {
  assert.equal(branchNameProblem('periscope/repo/effort-1'), null);
  assert.match(branchNameProblem('periscope//effort-1') ?? '', /empty component/);
  assert.match(branchNameProblem('periscope/effort-1/') ?? '', /empty component/);
  assert.match(branchNameProblem('periscope/effort.lock') ?? '', /\.lock/);
  assert.match(branchNameProblem('periscope/.effort') ?? '', /begins with/);
  assert.match(branchNameProblem('a b/c') ?? '', /' '/);
});

test('regression: the posture screen refuses at startup: unknown placeholder, illegal literal, unusable default key', () => {
  const base = {
    workspaceRoot: '/srv/ws',
    repositoryRoot: '/srv/repo',
    branchScheme: null,
    workspaceKey: null,
  };

  // The control: a fully ordinary posture, and each single change below turns it red, so the
  // screen discriminates rather than refusing everything.
  assert.equal(workspacePostureProblem(base), null);
  assert.equal(workspacePostureProblem({ ...base, branchScheme: 'periscope/{repo}/{key}' }), null);
  assert.equal(workspacePostureProblem({ ...base, workspaceKey: 'shared-tree' }), null);

  // An unknown placeholder refuses by name: `{repoo}` rendered literally into a branch is a
  // silent wrong answer, and startup is the only cheap moment.
  assert.match(
    workspacePostureProblem({ ...base, branchScheme: 'periscope/{repoo}/{key}' }) ?? '',
    /\{repoo\}/,
  );
  // A scheme whose literal text renders illegally for every key.
  assert.match(
    workspacePostureProblem({ ...base, branchScheme: 'periscope/{key}/' }) ?? '',
    /illegal branch name/,
  );
  assert.match(
    workspacePostureProblem({ ...base, branchScheme: 'periscope/{key}.lock' }) ?? '',
    /illegal branch name/,
  );
  // A default key that fails the same union screen a wire key must pass.
  assert.match(
    workspacePostureProblem({ ...base, workspaceKey: 'solo:bad' }) ?? '',
    /PERISCOPE_WORKSPACE_KEY/,
  );

  // The length rule, through the startup screen: over the bound refuses naming the bound with a
  // truncated echo (the sentence must stay printable); at the bound still passes.
  const oversizedProblem = workspacePostureProblem({ ...base, workspaceKey: 'k'.repeat(60_000) });
  assert.match(oversizedProblem ?? '', /longer than 200 characters|over the 200-character bound/);
  assert.ok((oversizedProblem ?? '').length < 400, 'the startup refusal echoed the whole oversized key');
  assert.equal(
    workspacePostureProblem({ ...base, workspaceKey: 'k'.repeat(200) }),
    null,
    'a 200-char key must pass',
  );
});

test('regression: a malformed brace refuses at startup; the well-formed twin still passes', () => {
  // The placeholder loop sees only well-formed `{...}` groups, so without the residue check a
  // trailing `{repo` is invisible: the scheme passes and renders the literal branch
  // `periscope/K/{repo`, and `{` is refname-legal, so no later screen could catch it. The
  // docblock's "never rendered literally" is only true while this test can fail.
  const base = {
    workspaceRoot: '/srv/ws',
    repositoryRoot: '/srv/repo',
    branchScheme: null,
    workspaceKey: null,
  };
  const problemWith = (branchScheme: string): string | null =>
    workspacePostureProblem({ ...base, branchScheme });

  // One variable (the closing brace), and the outcomes must disagree, or the screen refuses
  // everything and the first half proves nothing.
  assert.match(problemWith('periscope/{key}/{repo') ?? '', /unmatched '\{' or '\}'/);
  assert.equal(problemWith('periscope/{repo}/{key}'), null, 'the well-formed twin must still pass');

  // The `}` side, and a bare stray: the rule is any surviving brace, not one shape of typo.
  assert.match(problemWith('periscope/{key}}/x') ?? '', /unmatched '\{' or '\}'/);
  assert.match(problemWith('periscope/{key') ?? '', /unmatched '\{' or '\}'/);
});

test('the posture screen refuses a setting whose prerequisite is absent — never silently ignores it', () => {
  assert.match(
    workspacePostureProblem({
      workspaceRoot: null,
      repositoryRoot: null,
      branchScheme: null,
      workspaceKey: 'k',
    }) ?? '',
    /PERISCOPE_WORKSPACE_ROOT/,
    'a key with no provider would be silently ignored: the misconfiguration nobody finds',
  );
  assert.match(
    workspacePostureProblem({
      workspaceRoot: '/srv/ws',
      repositoryRoot: null,
      branchScheme: 'p/{key}',
      workspaceKey: null,
    }) ?? '',
    /PERISCOPE_BRANCH_SCHEME/,
    'a scheme with no git worktrees would be silently ignored',
  );
});

// --- the mode, as capability markers for the hello ------------------------------

test('regression: workspaceCapabilitiesOf names the mode workspacesFor would choose, for every posture', () => {
  const wc = (over: Partial<WorkspaceConfig>): WorkspaceConfig => ({
    workspaceRoot: null,
    repositoryRoot: null,
    branchScheme: null,
    ...over,
  });

  assert.deepEqual(workspaceCapabilitiesOf(wc({})), ['workspace:none']);
  assert.deepEqual(workspaceCapabilitiesOf(wc({ workspaceRoot: '/srv/ws' })), ['workspace:plain']);
  assert.deepEqual(workspaceCapabilitiesOf(wc({ workspaceRoot: '/srv/ws', repositoryRoot: '/srv/repo' })), [
    'workspace:git-worktree',
  ]);
  assert.deepEqual(
    workspaceCapabilitiesOf(
      wc({ workspaceRoot: '/srv/ws', repositoryRoot: '/srv/repo', branchScheme: 'p/{key}' }),
    ),
    ['workspace:git-worktree', 'workspace:branch-scheme'],
    'a configured scheme must be visible as its own marker: "git mode" alone cannot say whether naming was set up',
  );
  // Empty string is the documented twin of unset, same as the selector reads it.
  assert.deepEqual(workspaceCapabilitiesOf(wc({ workspaceRoot: '' })), ['workspace:none']);

  // The lockstep pin: the marker must agree with the provider the selector actually builds
  // from the identical config. Derived from the same predicates by construction today; this pair
  // is what makes a future edit to one of the twins fail loudly instead of shipping a hello that
  // reports a mode the host is not in, a false "configured correctly" on the controller.
  const arms: readonly (readonly [WorkspaceConfig, string])[] = [
    [wc({}), 'workspace:none'],
    [wc({ workspaceRoot: '/srv/ws' }), 'workspace:plain'],
    [wc({ workspaceRoot: '/srv/ws', repositoryRoot: '/srv/repo' }), 'workspace:git-worktree'],
    [
      wc({ workspaceRoot: '/srv/ws', repositoryRoot: '/srv/repo', branchScheme: 'p/{key}' }),
      'workspace:git-worktree',
    ],
  ];
  for (const [config, expectedMode] of arms) {
    const provider = workspacesFor(config);
    const marker = workspaceCapabilitiesOf(config)[0];
    assert.equal(marker, expectedMode);
    if (expectedMode === 'workspace:none') {
      assert.equal(provider, null, 'the marker says no provider and the selector built one');
    } else if (expectedMode === 'workspace:plain') {
      assert.ok(
        provider instanceof PlainDirProvider,
        'the marker says plain and the selector chose otherwise',
      );
    } else {
      assert.ok(
        provider instanceof GitWorktreeProvider,
        'the marker says git-worktree and the selector chose otherwise',
      );
    }
  }
});

// --- the values behind the markers -----------------------------------------------

test('hostConfigurationOf reports the values the selector read, null where the selector saw absence', () => {
  const extras = {
    transcriptsRoot: '/home/agent/.claude/projects',
    controllerUrl: 'wss://c.example/link',
    decisionUrl: 'https://c.example/decision',
    agentHome: '/home/agent/.claude',
    plugins: [],
  };

  assert.deepEqual(hostConfigurationOf(config(), extras), {
    repositoryRoot: null,
    workspaceRoot: null,
    branchScheme: null,
    transcriptsRoot: '/home/agent/.claude/projects',
    controllerUrl: 'wss://c.example/link',
    decisionUrl: 'https://c.example/decision',
    agentHome: '/home/agent/.claude',
    plugins: [],
  });
  assert.deepEqual(
    hostConfigurationOf(
      config({ workspaceRoot: '/srv/ws', repositoryRoot: '/srv/repo', branchScheme: 'p/{key}' }),
      extras,
    ),
    {
      repositoryRoot: '/srv/repo',
      workspaceRoot: '/srv/ws',
      branchScheme: 'p/{key}',
      transcriptsRoot: '/home/agent/.claude/projects',
      controllerUrl: 'wss://c.example/link',
      decisionUrl: 'https://c.example/decision',
      agentHome: '/home/agent/.claude',
      plugins: [],
    },
  );
  // Git mode with no scheme configured reports the EFFECTIVE scheme — what a provision renders —
  // while the marker (workspace:branch-scheme absent) says it was defaulted, not configured.
  const defaulted = config({ workspaceRoot: '/srv/ws', repositoryRoot: '/srv/repo' });
  assert.equal(hostConfigurationOf(defaulted, extras).branchScheme, DEFAULT_BRANCH_SCHEME);
  assert.equal(workspaceCapabilitiesOf(defaulted).includes('workspace:branch-scheme'), false);
  // Outside git mode a scheme is inert, so nothing is defaulted: unset reports null.
  assert.equal(hostConfigurationOf(config({ workspaceRoot: '/srv/ws' }), extras).branchScheme, null);
  // Empty string is the documented twin of unset for the selector, so it is null here too: a
  // controller rendering '' as a path would show a root the host is not in.
  assert.deepEqual(
    hostConfigurationOf(config({ workspaceRoot: '', repositoryRoot: '' }), {
      transcriptsRoot: '',
      controllerUrl: null,
      decisionUrl: '',
      agentHome: '',
      plugins: [],
    }),
    {
      repositoryRoot: null,
      workspaceRoot: null,
      branchScheme: null,
      transcriptsRoot: null,
      controllerUrl: null,
      decisionUrl: null,
      agentHome: null,
      plugins: [],
    },
  );
});

test('control: the reported values and the mode marker agree for every posture', () => {
  const extras = {
    transcriptsRoot: null,
    controllerUrl: null,
    decisionUrl: null,
    agentHome: null,
    plugins: [],
  };
  const postures: readonly WorkspaceConfig[] = [
    config(),
    config({ workspaceRoot: '/srv/ws' }),
    config({ workspaceRoot: '/srv/ws', repositoryRoot: '/srv/repo' }),
    config({ workspaceRoot: '/srv/ws', repositoryRoot: '/srv/repo', branchScheme: 'p/{key}' }),
    config({ workspaceRoot: '', repositoryRoot: '/srv/repo' }),
  ];
  for (const posture of postures) {
    const marker = workspaceCapabilitiesOf(posture)[0];
    const values = hostConfigurationOf(posture, extras);
    // The one variable is the posture; the two twins must land on the same side of it. A marker
    // claiming a mode beside values that cannot produce it is a hello describing a host that does
    // not exist. The values report what is SET; the marker reports what that selects, so the
    // implications run from the marker to the values (git mode needs both roots) and from a
    // complete set of values to the marker, never from a lone inert setting to a mode: a
    // repository root with no workspace root is legal, reported, and selects nothing.
    if (marker === 'workspace:none') {
      assert.equal(values.workspaceRoot, null, 'workspace:none beside a workspace root');
    } else {
      assert.notEqual(values.workspaceRoot, null, `${marker} beside no workspace root`);
    }
    if (marker === 'workspace:git-worktree') {
      assert.notEqual(values.repositoryRoot, null, 'git mode beside no repository root');
    }
    if (values.workspaceRoot !== null && values.repositoryRoot !== null) {
      assert.equal(marker, 'workspace:git-worktree', 'both roots set and the marker is not git mode');
    }
    const schemeMarker = workspaceCapabilitiesOf(posture).includes('workspace:branch-scheme');
    if (schemeMarker) assert.notEqual(values.branchScheme, null, 'the scheme marker beside no scheme');
    // The values report the EFFECTIVE scheme, so in git mode one is always reported; the marker
    // says whether it was configured. A reported scheme that is NOT the default must carry the
    // marker, and the default without the marker is the defaulted posture, not a contradiction.
    if (marker === 'workspace:git-worktree') {
      assert.notEqual(values.branchScheme, null, 'git mode reports no effective scheme');
      if (values.branchScheme !== DEFAULT_BRANCH_SCHEME) {
        assert.equal(schemeMarker, true, 'a configured scheme in git mode and no scheme marker');
      }
    }
  }
});
