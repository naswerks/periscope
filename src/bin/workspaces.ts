/**
 * Which workspace provider a real process gets.
 *
 * Split out of the composition root (`main.ts` and `serve.ts`) rather than exported from it, for
 * the reason that file's own header gives: everything below the composition root takes its
 * configuration as arguments, which is what makes the rest of the package testable without a
 * process. The selector is pure and lives where it can be called on its own.
 */
import type { HostConfiguration } from '../control/frames.js';
import {
  GitWorktreeProvider,
  keyPreview,
  refnameOrPathIllegality,
  unusableKeyProblem,
} from '../workspace/git-worktree.js';
import { PlainDirProvider } from '../workspace/plain-dir.js';
import type { WorkspaceProvider } from '../workspace/provider.js';
import { nodeCommandEffects, nodeWorkspaceEffects } from '../host/workspace-fs.js';

/** The environment answers the selector reads. A subset of the binary's `Config`, by structure. */
export interface WorkspaceConfig {
  /** When set, every session gets a directory beneath it instead of the one the controller named. */
  readonly workspaceRoot: string | null;
  /** When set alongside the root, sessions get a linked git worktree on their own branch. */
  readonly repositoryRoot: string | null;
  /**
   * The branch template a worktree's branch is rendered from: `{key}` and `{repo}` are the
   * two placeholders, e.g. `periscope/{repo}/{key}`. Null means the provider's own fallback
   * (`periscope/{sessionId}`).
   */
  readonly branchScheme: string | null;
}

/** The two placeholder names a branch scheme may use. Anything else refuses at startup by name. */
const SCHEME_PLACEHOLDERS = ['key', 'repo'] as const;

/** Render a branch scheme. Pure; exported so the rule is testable without a provider. */
export function renderBranch(scheme: string, key: string, repo: string): string {
  return scheme.replaceAll('{key}', key).replaceAll('{repo}', repo);
}

/**
 * The first way this rendered branch name is illegal, or null.
 *
 * A legal key can render an illegal refname: a `{repo}` carrying a dot-prefixed segment, a
 * scheme with a trailing slash, a literal ending `.lock`. Validating the key and then building an
 * unvalidated branch from it would let a branch die inside git on every open, so the result is
 * screened: per slash-separated component, against the same union rule the key already passed
 * (`refnameOrPathIllegality`, the single source of that class).
 */
export function branchNameProblem(branch: string): string | null {
  if (branch.trim() === '') return 'is empty — a branch must have a name';
  for (const component of branch.split('/')) {
    if (component === '') return `has an empty component — '${branch}' contains a doubled or edge slash`;
    const illegality = refnameOrPathIllegality(component);
    if (illegality !== null) return `has a component '${component}' that ${illegality}`;
  }
  return null;
}

/**
 * What is wrong with this workspace posture, at startup, or null when it is usable.
 *
 * Screened when the process boots, not at the first session. A machine that will refuse every
 * session (an unusable default key, a scheme with a typo'd placeholder) must say so when it starts,
 * where the one person who can fix it is looking, not days later when someone finally opens a
 * session. Pure, and exported precisely so it is testable without starting a host.
 *
 * Three families of refusal, each by name:
 *   - a setting that depends on another that is absent (a key with no provider, a scheme with no
 *     repository); silently ignoring either is a misconfiguration nobody finds;
 *   - a default workspace key that fails the same union screen a wire-supplied key must pass;
 *   - a branch scheme with an unknown placeholder or an unmatched brace (never rendered literally;
 *     `{repoo}` or a trailing `{repo` in a branch name is a silent wrong answer), or whose literal
 *     text already renders illegally.
 */
export function workspacePostureProblem(posture: {
  readonly workspaceRoot: string | null;
  readonly repositoryRoot: string | null;
  readonly branchScheme: string | null;
  readonly workspaceKey: string | null;
}): string | null {
  const hasProvider = posture.workspaceRoot !== null && posture.workspaceRoot !== '';
  const hasRepository = posture.repositoryRoot !== null && posture.repositoryRoot !== '';

  if (posture.workspaceKey !== null && posture.workspaceKey !== '') {
    if (!hasProvider) {
      return (
        'PERISCOPE_WORKSPACE_KEY is set but PERISCOPE_WORKSPACE_ROOT is not — with no workspace ' +
        'provider there is nothing to provision at that key, so the setting would be silently ignored'
      );
    }
    const problem = unusableKeyProblem(posture.workspaceKey);
    if (problem !== null) {
      return `PERISCOPE_WORKSPACE_KEY ${keyPreview(posture.workspaceKey)} ${problem} — every session on this host would refuse`;
    }
  }

  if (posture.branchScheme !== null && posture.branchScheme !== '') {
    if (!hasProvider || !hasRepository) {
      return (
        'PERISCOPE_BRANCH_SCHEME is set but sessions get no git worktrees here (it needs both ' +
        'PERISCOPE_WORKSPACE_ROOT and PERISCOPE_REPOSITORY_ROOT) — the setting would be silently ignored'
      );
    }
    for (const match of posture.branchScheme.matchAll(/\{([^}]*)\}/g)) {
      const placeholder = match[1] ?? '';
      if (!(SCHEME_PLACEHOLDERS as readonly string[]).includes(placeholder)) {
        return (
          `PERISCOPE_BRANCH_SCHEME uses an unknown placeholder '{${placeholder}}' — the two it may use are ` +
          `{key} and {repo}, and an unknown one is refused rather than rendered literally into a branch name`
        );
      }
    }
    // A brace that survives placeholder substitution is by definition not a placeholder this host
    // understands. The loop above sees only well-formed `{...}` groups, so a malformed brace is
    // invisible to it: `periscope/{key}/{repo` would pass and render the literal branch
    // `periscope/K/{repo`, and `{` is refname-legal, so the render screen below cannot catch it
    // either. Screened on the scheme text, not the rendered name, deliberately: a repository
    // directory legitimately named with a brace must still render, so `branchNameProblem` is the
    // wrong layer for this rule.
    const residue = posture.branchScheme.replace(/\{[^}]*\}/g, '');
    if (residue.includes('{') || residue.includes('}')) {
      return (
        `PERISCOPE_BRANCH_SCHEME contains an unmatched '{' or '}' — a brace that survives placeholder ` +
        `substitution is not a placeholder this host understands, and it would render literally into a branch name`
      );
    }
    // The scheme's literal text, screened with benign placeholder values: a trailing slash or a
    // literal `.lock` is wrong for every key, so it is caught here; a violation only a particular
    // key or repo name produces is caught at render, inside the provider's own named refusal.
    const rendered = renderBranch(posture.branchScheme, 'k', 'r');
    const problem = branchNameProblem(rendered);
    if (problem !== null) {
      return `PERISCOPE_BRANCH_SCHEME renders an illegal branch name (${rendered} ${problem})`;
    }
  }

  return null;
}

/** The last path segment of a repository root — what `{repo}` renders as. */
function repositoryName(repositoryRoot: string): string {
  const segments = repositoryRoot.split(/[\\/]+/).filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}

/**
 * The branch scheme a git-worktree host renders when none is configured: the repository's name,
 * then the key. With keys named after the platform's own identities (`session-150`,
 * `run-34`) this puts every session on `repo/session-150`, the name an operator reads in
 * the session's own URL. Explicitly configured schemes override it; the `workspace:branch-scheme`
 * marker means "explicitly configured", never "this default".
 */
export const DEFAULT_BRANCH_SCHEME = '{repo}/{key}';

/**
 * The `branchFor` a scheme produces, extracted so the render-and-screen rule is testable without
 * a provider, a repository, or a real git (the same reason this whole file exists).
 *
 * A render the screen refuses throws, and the throw is the contract: the provider calls this
 * inside its own try, so the message lands in a named `workspace-provision-failed` refusal rather
 * than dying inside git. This is the runtime half of the screen, for the violations only a
 * particular key or repo name produces (the startup screen already caught the scheme's literal
 * text).
 */
export function branchRenderer(scheme: string, repositoryRoot: string): (sessionId: string) => string {
  const repo = repositoryName(repositoryRoot);
  return (sessionId: string): string => {
    const branch = renderBranch(scheme, sessionId, repo);
    const problem = branchNameProblem(branch);
    if (problem !== null) {
      throw new Error(
        `the branch scheme '${scheme}' rendered an illegal branch name: '${branch}' ${problem}`,
      );
    }
    return branch;
  };
}

/**
 * The provider selector: which workspace provider, if any, the shipped entry point composes.
 *
 * With no workspace root there is no provider at all and every session on a host shares the
 * controller's `cwd` verbatim, the weakest isolation available. With a workspace root alone, each
 * session gets a plain directory and no branch. With a repository root as well, each session gets
 * a linked git worktree on its own branch, which is what lets a controller admit a push to a
 * session's own branch.
 *
 * The presence of a repository root is the mode switch: a deployment that does not set one gets
 * plain directories. There is no boolean to get backwards, and the git
 * mode cannot be selected without naming the repository it would link worktrees to, which is the one
 * fact the provider cannot default.
 *
 * No branch formula lives in the provider. `git-worktree.ts`'s header states that branch naming is
 * the caller's decision, and this file is the caller: it always hands a `branchFor` in — the
 * configured scheme, else `DEFAULT_BRANCH_SCHEME` — so the provider's own `periscope/{sessionId}`
 * fallback is reached only by a hand composition that names nothing. The rendered name is
 * screened: a render only a particular key or repo produces illegally throws here, which the
 * provider's own try/catch turns into a named `workspace-provision-failed` refusal carrying this
 * message, never an unnamed death inside git.
 */
/** The scheme a git-worktree host renders: the configured one, else the default. */
function effectiveScheme(configured: string | null): string {
  return configured === null || configured === '' ? DEFAULT_BRANCH_SCHEME : configured;
}

export function workspacesFor(config: WorkspaceConfig): WorkspaceProvider | null {
  if (config.workspaceRoot === null || config.workspaceRoot === '') return null;

  if (config.repositoryRoot !== null && config.repositoryRoot !== '') {
    return new GitWorktreeProvider({
      repositoryRoot: config.repositoryRoot,
      workspaceRoot: config.workspaceRoot,
      effects: nodeWorkspaceEffects,
      commands: nodeCommandEffects(),
      branchFor: branchRenderer(effectiveScheme(config.branchScheme), config.repositoryRoot),
    });
  }

  return new PlainDirProvider({ root: config.workspaceRoot, effects: nodeWorkspaceEffects });
}

/**
 * The mode, as capability markers for the hello: the read half of what `periscope config` writes.
 * A host that can be configured but cannot report how it is configured gives a controller nothing
 * to verify.
 *
 * A pure twin of `workspacesFor`, kept beside it so the two cannot drift: the marker is derived
 * from the same predicates that choose the provider, never from a second reading of the
 * environment. Exactly one `workspace:*` mode marker is always present; absence of all three in a
 * hello therefore means "this build does not report", which is what lets a controller render
 * "not reported" instead of a default.
 *
 * Markers, not values. Which repository root, which scheme text: those would be payload members
 * and a protocol-version change, deliberately not smuggled into marker strings.
 */
export function workspaceCapabilitiesOf(config: WorkspaceConfig): readonly string[] {
  if (config.workspaceRoot === null || config.workspaceRoot === '') return ['workspace:none'];
  if (config.repositoryRoot !== null && config.repositoryRoot !== '') {
    const hasScheme = config.branchScheme !== null && config.branchScheme !== '';
    return hasScheme ? ['workspace:git-worktree', 'workspace:branch-scheme'] : ['workspace:git-worktree'];
  }
  return ['workspace:plain'];
}

/** The values the hello reports that the workspace config does not hold. */
export interface HostConfigurationExtras {
  readonly transcriptsRoot: string | null;
  readonly controllerUrl: string | null;
  readonly decisionUrl: string | null;
  readonly agentHome: string | null;
}

/**
 * The values behind the markers: what the hello reports as `configuration`.
 *
 * The other pure twin of `workspacesFor`. Read from the same `WorkspaceConfig` the selector and
 * the markers consume, so a root the selector treats as unset (null or empty) is reported as
 * null here, never as an empty string a controller would render as a path. A value present here
 * and a `workspace:none` marker cannot both be true of one config, and the test pins that.
 */
export function hostConfigurationOf(
  config: WorkspaceConfig,
  extras: HostConfigurationExtras,
): HostConfiguration {
  const setOrNull = (value: string | null): string | null => (value === null || value === '' ? null : value);
  const gitMode = setOrNull(config.workspaceRoot) !== null && setOrNull(config.repositoryRoot) !== null;
  return {
    repositoryRoot: setOrNull(config.repositoryRoot),
    workspaceRoot: setOrNull(config.workspaceRoot),
    // The EFFECTIVE scheme: what a provision would render. In git mode that is never null; the
    // marker beside it says whether it was configured or defaulted.
    branchScheme: gitMode ? effectiveScheme(config.branchScheme) : setOrNull(config.branchScheme),
    transcriptsRoot: setOrNull(extras.transcriptsRoot),
    controllerUrl: setOrNull(extras.controllerUrl),
    decisionUrl: setOrNull(extras.decisionUrl),
    agentHome: setOrNull(extras.agentHome),
  };
}
