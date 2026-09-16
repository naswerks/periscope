/**
 * A linked git worktree per session.
 *
 * The one rule here has destroyed committed work before: never `git worktree add -B` over a branch
 * that already exists. `-B` is create-or-reset — it hard-resets the branch to the base ref — so
 * re-provisioning a directory that was lost (a cleanup ran, a volume remounted) silently discards
 * every commit made in it. The directory comes back looking correct and the work is gone. Nothing
 * errors, nothing warns, and the loss is only visible to someone who knew what the branch used to
 * point at.
 *
 * The rule: if the branch exists, attach to it and let it keep its own tip. Only a branch being
 * created for the first time takes the `-B` form.
 *
 * That rule is a pure function here, and that is the point of the file's shape. `worktreeAddArgs`
 * takes four values and returns an argv; the invariant is a unit test with no git, no disk and no
 * repository. The alternative is a rule that only a destroyed branch could ever have proven.
 *
 * No key formula lives here. A branch naming convention is the controller's own convention, and
 * one baked in here would be this package deciding what a session means. The caller supplies the
 * branch name and the base ref.
 */
import type { Result } from '../core/result.js';
import type { Refusal } from '../core/refusal.js';
import { ok, refuse } from '../core/result.js';
import { isAbsolutePath, isContainedBy, normalizePath } from '../core/paths.js';
import { MAX_WORKSPACE_ID_LENGTH } from '../core/workspace-id.js';
import type {
  CommandEffects,
  ReleaseOptions,
  ReleaseReceipt,
  Workspace,
  WorkspaceEffects,
  WorkspaceEntry,
  WorkspaceInventory,
  WorkspaceProvider,
} from './provider.js';
import { parseBranchList, parseBranchTips, parseWorktreePorcelain } from './worktree-porcelain.js';

/**
 * The exact `git worktree add` argv, and the one decision that matters.
 *
 * `branchExists` decides between two different commands, not between two spellings of one.
 *   exists  gives `worktree add <path> <branch>`               attach: the branch keeps its own tip.
 *   new     gives `worktree add -B <branch> <path> <baseRef>`  create, off the base ref.
 * Passing `-B` in the first case hard-resets the branch and discards its commits. See this file's
 * header — that is not a hypothetical.
 *
 * Pure and total: no filesystem, no git, no I/O. Exported so the rule is testable directly rather
 * than only through a provider that would need a repository to exercise.
 */
export function worktreeAddArgs(
  path: string,
  branch: string,
  baseRef: string,
  branchExists: boolean,
): readonly string[] {
  if (branchExists) return ['worktree', 'add', path, branch];
  return ['worktree', 'add', '-B', branch, path, baseRef];
}

export interface GitWorktreeProviderOptions {
  /** The repository the worktrees are linked to. Absolute. */
  readonly repositoryRoot: string;
  /** Where worktree directories are created. Absolute. */
  readonly workspaceRoot: string;
  /**
   * The branch a session's worktree sits on, derived from its id.
   *
   * Supplied, not derived here. A branch naming convention is the caller's own; see the file
   * header. Defaults to `periscope/{sessionId}` only so the provider is usable without one.
   */
  readonly branchFor?: (sessionId: string) => string;
  /** What a new branch is created from. Defaults to `HEAD`. */
  readonly baseRef?: string;
  readonly effects: WorkspaceEffects;
  readonly commands: CommandEffects;
}

export class GitWorktreeProvider implements WorkspaceProvider {
  readonly #repositoryRoot: string;
  /** The checkout this provider clones from — see `WorkspaceProvider.repositoryRoot`. */
  get repositoryRoot(): string {
    return this.#repositoryRoot;
  }
  readonly #workspaceRoot: string;
  readonly #branchFor: (sessionId: string) => string;
  readonly #baseRef: string;
  readonly #effects: WorkspaceEffects;
  readonly #commands: CommandEffects;

  constructor(options: GitWorktreeProviderOptions) {
    this.#repositoryRoot = normalizePath(options.repositoryRoot);
    this.#workspaceRoot = normalizePath(options.workspaceRoot);
    this.#branchFor = options.branchFor ?? ((sessionId) => `periscope/${sessionId}`);
    this.#baseRef = options.baseRef ?? 'HEAD';
    this.#effects = options.effects;
    this.#commands = options.commands;
  }

  /** Where this session's worktree is, whether or not it exists yet. */
  pathFor(sessionId: string): string {
    return `${this.#workspaceRoot}/${sessionId}`;
  }

  async provision(sessionId: string): Promise<Result<Workspace>> {
    const invalid = rejectUnusableId<Workspace>(sessionId);
    if (invalid !== null) return invalid;
    if (!isAbsolutePath(this.#workspaceRoot) || !isAbsolutePath(this.#repositoryRoot)) {
      return refuse<Workspace>(
        'workspace-provision-failed',
        `both roots must be absolute: repository ${this.#repositoryRoot}, workspace ${this.#workspaceRoot}`,
      );
    }

    const path = this.pathFor(sessionId);

    try {
      // Inside the try, deliberately: `branchFor` is caller-supplied and may refuse a render by
      // throwing (a scheme whose output fails the refname screen). A throw here must become the
      // same named `workspace-provision-failed` every other provisioning failure gets — the
      // provider's own contract is results, never exceptions.
      const branch = this.#branchFor(sessionId);
      // An existing directory is attached to, never recreated. The whole point of re-provisioning is
      // that whatever is there survives — including the case where the directory is intact and only
      // this host's memory of it was lost.
      if (await this.#effects.exists(path)) {
        return ok({ path, meta: { branch, baseRef: this.#baseRef, attached: 'directory' } });
      }

      await this.#effects.makeDirectory(this.#workspaceRoot);

      // The probe that decides between attach and create. It runs for every session, not only the
      // ones a caller expects to be re-provisioned: the whole failure is that nobody expects it.
      const branchExists = await this.#branchExists(branch);
      await this.#commands.run(
        'git',
        worktreeAddArgs(path, branch, this.#baseRef, branchExists),
        this.#repositoryRoot,
      );

      return ok({
        path,
        meta: {
          branch,
          baseRef: this.#baseRef,
          // Reported rather than inferred: an operator reading this can tell whether their commits
          // were preserved by attachment or whether the branch was created fresh.
          attached: branchExists ? 'branch' : 'created',
        },
      });
    } catch (error) {
      return refuse<Workspace>(
        'workspace-provision-failed',
        `could not provision a worktree for ${sessionId} at ${path}: ${describe(error)}`,
      );
    }
  }

  /**
   * Release the worktree.
   *
   * The branch is never deleted unless the caller names it in the ask. Removing a directory is
   * reversible — the commits are still on the branch. Deleting a branch is not, so branch deletion
   * is opt-in per call (`deleteBranch`), refused for an unmerged branch unless forced, and the
   * merged check runs before anything is removed: a refusal never leaves a half-cleaned key. A
   * deletion that fails after the directory went is a partial, stated on the receipt.
   *
   * The branch is the one the worktree is on (from `worktree list`), which may differ from the
   * scheme's render if an agent checked out elsewhere; only when the directory is already gone is
   * the scheme's render the name.
   */
  async release(sessionId: string, options?: ReleaseOptions): Promise<Result<ReleaseReceipt | undefined>> {
    if (options?.remove !== true) return ok(undefined);

    const path = this.pathFor(sessionId);
    const receipt = (
      directoryRemoved: boolean,
      branchDeleted: boolean,
      refusal: Refusal | null = null,
    ): ReleaseReceipt => ({
      path,
      directoryRemoved,
      branchDeleted,
      refusal,
    });
    try {
      const existed = await this.#effects.exists(path);
      if (options.deleteBranch !== true) {
        if (!existed) return ok(receipt(false, false));
        await this.#removeWorktree(path);
        return ok(receipt(true, false));
      }

      const branch = (existed ? await this.#branchAt(path) : null) ?? this.#branchFor(sessionId);
      if (!existed && !(await this.#branchExists(branch))) return ok(receipt(false, false));
      if (options.force !== true) {
        const unmerged = await this.#unmergedProblem(branch);
        if (unmerged !== null)
          return refuse<ReleaseReceipt>('branch-not-merged', `${unmerged} — nothing was removed`);
      }

      if (existed) await this.#removeWorktree(path);
      try {
        await this.#commands.run(
          'git',
          ['branch', options.force === true ? '-D' : '-d', branch],
          this.#repositoryRoot,
        );
      } catch (error) {
        const removed = existed ? `removed the worktree at ${path} but ` : '';
        return ok(
          receipt(existed, false, {
            reason: 'workspace-release-failed',
            detail: `${removed}could not delete branch ${branch}: ${describe(error)}`,
          }),
        );
      }
      return ok(receipt(existed, true));
    } catch (error) {
      return refuse<ReleaseReceipt>(
        'workspace-release-failed',
        `could not release the worktree for ${sessionId} at ${path}: ${describe(error)}`,
      );
    }
  }

  /** The key of the directory at `path` when it sits directly under the workspace root, else null. */
  keyForPath(path: string): string | null {
    return keyDirectlyUnder(path, this.#workspaceRoot);
  }

  /**
   * `--force` because a worktree with uncommitted changes is still a worktree the caller asked to
   * remove; refusing here would leave it registered with no way for this API to clear it.
   */
  async #removeWorktree(path: string): Promise<void> {
    await this.#commands.run('git', ['worktree', 'remove', '--force', path], this.#repositoryRoot);
  }

  /** The branch the worktree at `path` is on, or null when it is detached or not a worktree git knows. */
  async #branchAt(path: string): Promise<string | null> {
    const porcelain = await this.#commands.run(
      'git',
      ['worktree', 'list', '--porcelain'],
      this.#repositoryRoot,
    );
    const entry = parseWorktreePorcelain(porcelain).find((worktree) => normalizePath(worktree.path) === path);
    return entry?.branch ?? null;
  }

  /** Why `branch` may not be deleted without force, or null when it is merged into the default branch. */
  async #unmergedProblem(branch: string): Promise<string | null> {
    const defaultBranch = await this.#defaultBranch();
    if (defaultBranch === null) {
      return `branch ${branch} cannot be judged merged: the repository names no default branch; force the deletion to delete it anyway`;
    }
    const merged = parseBranchList(
      await this.#commands.run(
        'git',
        ['branch', '--merged', defaultBranch, '--format=%(refname:short)'],
        this.#repositoryRoot,
      ),
    );
    if (merged.has(branch)) return null;
    return `branch ${branch} is not merged into ${defaultBranch}; force the deletion to delete it anyway`;
  }

  /**
   * Every worktree under the workspace root, from disk, with what git knows about its branch.
   *
   * Three commands for the whole list, plus one `rev-list --count` per branch entry: `worktree list --porcelain` for the worktrees, `for-each-ref`
   * for every branch tip's date, and `branch --merged <default>` for the merged set. Only worktrees
   * CONTAINED BY the workspace root are reported: the repository itself and any checkout the
   * operator keeps elsewhere are not this provider's to list, so no cleanup composed from this
   * answer can name them. `merged` is null when the repository names no default branch.
   */
  async inventory(): Promise<Result<WorkspaceInventory>> {
    try {
      const porcelain = await this.#commands.run(
        'git',
        ['worktree', 'list', '--porcelain'],
        this.#repositoryRoot,
      );
      const provisioned = parseWorktreePorcelain(porcelain)
        .map((worktree) => ({ ...worktree, path: normalizePath(worktree.path) }))
        .filter(
          (worktree) =>
            !worktree.bare &&
            worktree.path !== this.#workspaceRoot &&
            isContainedBy(worktree.path, this.#workspaceRoot),
        );
      const defaultBranch = await this.#defaultBranch();
      const merged =
        defaultBranch === null
          ? null
          : parseBranchList(
              await this.#commands.run(
                'git',
                ['branch', '--merged', defaultBranch, '--format=%(refname:short)'],
                this.#repositoryRoot,
              ),
            );
      const tips = parseBranchTips(
        await this.#commands.run(
          'git',
          ['for-each-ref', '--format=%(refname:short)\t%(committerdate:iso-strict)', 'refs/heads/'],
          this.#repositoryRoot,
        ),
      );
      const entries: WorkspaceEntry[] = [];
      for (const worktree of provisioned) {
        entries.push({
          key: lastSegment(worktree.path),
          path: worktree.path,
          branch: worktree.branch,
          head: worktree.head,
          detached: worktree.detached,
          locked: worktree.locked,
          prunable: worktree.prunable,
          merged: merged === null || worktree.branch === null ? null : merged.has(worktree.branch),
          // One `rev-list --count` per BRANCH entry: the third reading ("nothing here yet") needs the
          // count, and git offers no batch form of it. A count that fails to read is null, never zero.
          aheadCount:
            defaultBranch === null || worktree.branch === null
              ? null
              : await this.#aheadCount(defaultBranch, worktree.branch),
          lastCommitAt: worktree.branch === null ? null : (tips.get(worktree.branch) ?? null),
        });
      }
      // Newest first by the tip's date, the ones without a date last, ties by key: the order a
      // controller pages through, so a fresh worktree is on the first page rather than wherever git
      // happened to list it.
      entries.sort(byNewestTip);
      return ok({ entries, defaultBranch });
    } catch (error) {
      return refuse<WorkspaceInventory>('workspace-list-failed', describe(error));
    }
  }

  /**
   * The branch `merged` is judged against: the remote's HEAD when the repository has one, else
   * `main`, else `master`, else null. Probed, never assumed, and a probe that fails reads as
   * "not this one" because every arm's failure is the absence it tests for.
   */
  async #defaultBranch(): Promise<string | null> {
    try {
      const remoteHead = await this.#commands.run(
        'git',
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        this.#repositoryRoot,
      );
      const short = remoteHead.replace(/^origin\//, '').trim();
      if (short !== '') return short;
    } catch {
      // No remote HEAD recorded; fall through to the conventional names.
    }
    for (const candidate of ['main', 'master']) {
      if (await this.#branchExists(candidate)) return candidate;
    }
    return null;
  }

  /** Commits on `branch` past `defaultBranch`, or null when git cannot say. */
  async #aheadCount(defaultBranch: string, branch: string): Promise<number | null> {
    try {
      const text = await this.#commands.run(
        'git',
        ['rev-list', '--count', `${defaultBranch}..${branch}`],
        this.#repositoryRoot,
      );
      const count = Number.parseInt(text.trim(), 10);
      return Number.isInteger(count) && count >= 0 ? count : null;
    } catch {
      return null;
    }
  }

  /** `rev-parse --verify` succeeds for a branch that exists and fails for one that does not. */
  async #branchExists(branch: string): Promise<boolean> {
    try {
      await this.#commands.run('git', ['rev-parse', '--verify', branch], this.#repositoryRoot);
      return true;
    } catch {
      // A failing probe means "treat it as new", which takes the `-B` form — so a probe that fails
      // for a reason other than the branch being absent (a broken git, a bad repository path) would
      // hard-reset an existing branch. That is why `provision` runs the probe inside its own
      // try/catch: the `add` that follows fails too, and the refusal names the whole operation
      // rather than silently taking the destructive path.
      return false;
    }
  }
}

/**
 * A session id that cannot safely become a path segment or a branch-name component.
 *
 * Refused rather than sanitized. Rewriting an id to make it safe means the directory no longer
 * corresponds to the id the caller used, so two different sessions can collapse onto one workspace —
 * which is the exact isolation property the plain-directory tests check, broken quietly by a
 * helpful-looking fix.
 *
 * The screen is the union of two rule sets. The id becomes both a directory segment (win32/POSIX)
 * and a git branch-name component (`periscope/{id}` by default); an id containing a character that
 * only git refuses would pass a separators-only screen and fail inside git as an unnamed
 * `workspace-provision-failed`. So the guard screens every character either rule set refuses — the
 * `git check-ref-format` component rules together with the win32 segment rules — and the refusal
 * names the offending character and its rule. Deliberately not screened: win32 reserved device
 * names (CON, NUL, …) — a name-list, not a character class; those still die loudly at provision
 * under the named refusal below.
 */
function rejectUnusableId<T>(sessionId: string): Result<T> | null {
  if (sessionId.trim() === '') {
    return refuse<T>('workspace-provision-failed', 'a session id is required to name a workspace');
  }
  if (sessionId.length > MAX_WORKSPACE_ID_LENGTH) {
    return refuse<T>(
      'workspace-provision-failed',
      `the session id ${keyPreview(sessionId)} is longer than ${MAX_WORKSPACE_ID_LENGTH} characters, so it cannot name a worktree branch or directory`,
    );
  }
  if (/[\\/]/.test(sessionId) || sessionId.includes('..')) {
    return refuse<T>(
      'workspace-provision-failed',
      `the session id ${keyPreview(sessionId)} contains path separators or a parent reference, so it cannot name a directory`,
    );
  }
  const illegality = refnameOrPathIllegality(sessionId);
  if (illegality !== null) {
    return refuse<T>(
      'workspace-provision-failed',
      `the session id ${keyPreview(sessionId)} ${illegality}, so it cannot name a worktree branch or directory`,
    );
  }
  return null;
}

/** Which rule refuses each screened character — quoted verbatim into the refusal detail. */
const CHARACTER_LAWS: ReadonlyMap<string, string> = new Map([
  [' ', 'illegal in a git refname'],
  [':', 'illegal in a git refname AND a win32 path segment'],
  ['~', 'illegal in a git refname'],
  ['^', 'illegal in a git refname'],
  ['[', 'illegal in a git refname'],
  ['?', 'illegal in a git refname AND a win32 path segment'],
  ['*', 'illegal in a git refname AND a win32 path segment'],
  ['"', 'illegal in a win32 path segment'],
  ['<', 'illegal in a win32 path segment'],
  ['>', 'illegal in a win32 path segment'],
  ['|', 'illegal in a win32 path segment'],
]);

/**
 * The refname/path-segment class check: the first way this id would be refused by
 * `git check-ref-format` (as the component of a branch name) or by win32 (as a path segment), as a
 * human sentence — or null for an id both rule sets accept. Pure and total, exported so the class
 * is testable without a provider.
 */
export function refnameOrPathIllegality(sessionId: string): string | null {
  // deliberate: the control range is the thing being refused, so the regex names it
  // eslint-disable-next-line no-control-regex
  const control = sessionId.match(/[\u0000-\u001f\u007f]/);
  if (control !== null) {
    const code = control[0].codePointAt(0)!.toString(16).padStart(2, '0');
    return `contains a control character (0x${code}) — illegal in a git refname and a win32 path segment`;
  }
  const character = sessionId.match(/[ :~^?*"<>|[]/);
  if (character !== null) {
    return `contains '${character[0]}' — ${CHARACTER_LAWS.get(character[0])!}`;
  }
  if (sessionId.includes('@{')) return `contains '@{' — illegal in a git refname`;
  if (sessionId.startsWith('.')) return `begins with '.' — a git refname component cannot`;
  if (sessionId.endsWith('.lock')) return `ends with '.lock' — a git refname component cannot`;
  if (sessionId.endsWith('.'))
    return `ends with '.' — illegal in a git refname component and a win32 path segment`;
  return null;
}

export { rejectUnusableId };

/**
 * The same screen as `rejectUnusableId`, as a sentence a caller can attach to its own noun.
 *
 * The host validates `session_new.workspaceKey` before any workspace is claimed, and its refusal
 * must name the field — "the session id …" would send a controller author to the wrong key. The
 * union class itself stays single-sourced in `refnameOrPathIllegality`; the two structural checks
 * are restated here because their sentences are the caller's to phrase. Keep the three checks in
 * step with `rejectUnusableId` above — a key this accepts and that refuses (or the reverse) would
 * mean the host's guard and the provider's disagree about the same id.
 */
export function unusableKeyProblem(key: string): string | null {
  if (key.trim() === '') return 'is empty, so it cannot name a workspace';
  if (key.length > MAX_WORKSPACE_ID_LENGTH) {
    return `is ${key.length} characters long — over the ${MAX_WORKSPACE_ID_LENGTH}-character bound, so it cannot name a worktree branch or directory`;
  }
  if (/[\\/]/.test(key) || key.includes('..')) {
    return 'contains path separators or a parent reference, so it cannot name a directory';
  }
  const illegality = refnameOrPathIllegality(key);
  if (illegality !== null) return `${illegality}, so it cannot name a worktree branch or directory`;
  return null;
}

/** The bound on a workspace id; declared in `core/` so the wire codec can enforce it too. */
export { MAX_WORKSPACE_ID_LENGTH };

/**
 * A key safe to echo into a refusal detail: verbatim when short, truncated with its length named
 * when not. Every screen above bounds accepted ids, but the refusal for an over-length id still
 * has to describe the very string that broke the bound — this is the one place an unbounded input
 * reaches a detail, so it is bounded here rather than at each caller's discretion.
 */
export function keyPreview(id: string): string {
  if (id.length <= 100) return id;
  return `${id.slice(0, 100)}… (${id.length} characters)`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Newest tip first; entries with no tip date (detached, unknown) after every dated one; ties by key. */
export function byNewestTip(
  a: { readonly key: string; readonly lastCommitAt: string | null },
  b: { readonly key: string; readonly lastCommitAt: string | null },
): number {
  if (a.lastCommitAt === null && b.lastCommitAt === null) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  if (a.lastCommitAt === null) return 1;
  if (b.lastCommitAt === null) return -1;
  const byDate = Date.parse(b.lastCommitAt) - Date.parse(a.lastCommitAt);
  if (byDate !== 0 && !Number.isNaN(byDate)) return byDate;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** The last path segment: the directory name, which is the key a worktree was provisioned at. */
function lastSegment(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}

/**
 * The key of `path` when it is an absolute path to a directory DIRECTLY under `root` (normalised),
 * else null: the root itself, a nested path, a relative path and anything elsewhere are all null,
 * so a release addressed by path can only ever name what a provision could have made.
 */
export function keyDirectlyUnder(path: string, root: string): string | null {
  if (!isAbsolutePath(path)) return null;
  const candidate = normalizePath(path);
  if (candidate === root || !isContainedBy(candidate, root)) return null;
  const key = lastSegment(candidate);
  return candidate === `${root}/${key}` ? key : null;
}
