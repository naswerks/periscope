/**
 * The directory a session runs in, and who decides what it looks like.
 *
 * This is entirely the host's job. The SDK has no provisioning surface at all — it takes a `cwd`
 * and assumes something already made it. So the choice of what a workspace is — a plain directory, a
 * checkout, a linked worktree, a container mount — is the embedder's, and this is the seam where
 * that choice plugs in.
 *
 * The provider is the embedder's, not the package's. Two implementations ship because they cover
 * the two shapes almost everyone needs, but the interesting policies are not here and must not move
 * here: a shared directory per task, a write-once key, a branch naming rule, a cleanup schedule.
 * Those are the embedder's own conventions, and a tool that reviews code in a throwaway clone
 * should be able to write its own provider without ever learning that any of them exist.
 *
 * Every result is a named refusal, never an exception. `provision` failing is an ordinary outcome
 * — a disk is full, a path is taken, a git command failed — and the caller has to decide what to do
 * about it. A thrown error at this seam would make "the session could not get a directory"
 * indistinguishable from a bug in the provider, and the package names the difference everywhere else.
 */
import type { Result } from '../core/result.js';
import type { Refusal } from '../core/refusal.js';

/** Where a session works, plus whatever the provider wants the caller to know about it. */
export interface Workspace {
  /** Absolute, always. This is what becomes the session's `cwd`. */
  readonly path: string;
  /**
   * Provider-specific facts, as strings.
   *
   * Deliberately opaque to this package. A git provider reports its branch and base ref here; a
   * plain-directory provider reports almost nothing; somebody else's reports a container id. Nothing
   * in the host reads a key out of this — it exists so a provider can tell its caller something
   * without this file having to grow a field for every provider anyone might write.
   */
  readonly meta: Readonly<Record<string, string>>;
}

/** What `release` should do with the directory. */
export interface ReleaseOptions {
  /**
   * Remove the workspace from disk. Defaults to false.
   *
   * The default is "leave it", and that is a deliberate asymmetry. A session that ended badly is
   * one whose directory somebody wants to look at, and a host that tidied up by default would
   * destroy the evidence exactly when it matters. Leaving a directory costs disk; deleting one that
   * was still wanted costs the investigation.
   */
  readonly remove?: boolean;
  /**
   * Delete the branch the worktree is on, after the directory. Defaults to false, and only means
   * anything with `remove`. Deleting a branch is not reversible the way removing a directory is,
   * so it is asked for per call and never remembered.
   */
  readonly deleteBranch?: boolean;
  /** Delete the branch even when it is not merged into the repository's default branch. */
  readonly force?: boolean;
}

/**
 * What a release did. `refusal` is the partial: the directory went and the branch did not, said
 * rather than hidden. Null means everything asked for happened, or was already absent.
 */
export interface ReleaseReceipt {
  /** The workspace's path as this provider knows it. */
  readonly path: string;
  /** A directory existed and is gone. */
  readonly directoryRemoved: boolean;
  readonly branchDeleted: boolean;
  readonly refusal: Refusal | null;
}

/** One workspace on disk, as the provider's inventory reports it. See `WorkspaceListEntry` on the wire. */
export interface WorkspaceEntry {
  readonly key: string;
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly merged: boolean | null;
  /** Commits past the default branch; null when detached or when no default branch was named. */
  readonly aheadCount: number | null;
  readonly lastCommitAt: string | null;
}

/** What `inventory` answers: every workspace under the root, and the default branch `merged` was judged against. */
export interface WorkspaceInventory {
  readonly entries: readonly WorkspaceEntry[];
  readonly defaultBranch: string | null;
}

export interface WorkspaceProvider {
  /**
   * Get the directory for this session, creating it if needed.
   *
   * It must be safe to call twice for one session. A host that lost a directory — a cleanup ran,
   * a volume remounted, a container restarted — re-provisions, and the second call must attach to
   * whatever survived rather than recreate it. That is not a nicety: see git-worktree.ts, where
   * getting it wrong destroys committed work.
   */
  provision(sessionId: string): Promise<Result<Workspace>>;
  /**
   * Done with it. Idempotent: releasing a session this provider does not hold succeeds. The
   * receipt is optional so a provider that predates it still conforms; the host reads no receipt as
   * "vouches for nothing" and reports both flags false.
   */
  release(sessionId: string, options?: ReleaseOptions): Promise<Result<ReleaseReceipt | undefined>>;
  /**
   * The key of the workspace at `path`, when `path` is a directory directly under this provider's
   * root; null for anything else. Optional: a provider without it cannot be addressed by path.
   */
  keyForPath?(path: string): string | null;
  /**
   * What exists under the workspace root right now, read from disk on demand. Optional: a provider
   * that keeps no inventory leaves it out and the host answers `workspace-list-failed` by name.
   * Only what this provider provisioned is listed; the repository it links from never is.
   */
  inventory?(): Promise<Result<WorkspaceInventory>>;
  /**
   * The repository this provider clones from, when it has one. The one directory a controller may
   * name and get, provider or not: the operator's own checkout has no isolation to protect.
   */
  readonly repositoryRoot?: string;
}

/**
 * The filesystem and process effects a provider needs, as injected functions.
 *
 * Why this exists rather than a direct `node:fs` import. `src/host/` is the only directory allowed
 * to touch the machine (pinned by pins/host-boundary.test.ts), and the provider logic — which argv a
 * git call gets, when a directory is reused rather than made, what a release does — is exactly the
 * part worth testing without a disk. So the logic lives here and the real implementations live in
 * host/workspace-fs.ts, the same split the path jail already uses.
 *
 * The payoff is not tidiness: it makes "never hard-reset an existing branch" a pure unit test rather
 * than something only a destroyed branch could have proven.
 */
export interface WorkspaceEffects {
  /** Create a directory and every missing parent. Succeeds if it already exists. */
  makeDirectory(path: string): Promise<void>;
  /** Does anything exist at this path? */
  exists(path: string): Promise<boolean>;
  /** Remove a directory and everything under it. Succeeds if it is already gone. */
  removeDirectory(path: string): Promise<void>;
  /** The names of the directories directly under `path`, or an empty list when it does not exist. Optional. */
  listDirectories?(path: string): Promise<string[]>;
}

/** Running a command. Separate from the filesystem effects because only one provider needs it. */
export interface CommandEffects {
  /**
   * Run a program with an argv array and return its stdout, trimmed.
   *
   * Argv, never a command string. A shell string would make every branch name and path an
   * injection site, and branch names come from a caller this package does not control.
   */
  run(program: string, args: readonly string[], cwd: string): Promise<string>;
}
