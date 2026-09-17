/**
 * One plain directory per session, under a root the embedder names.
 *
 * The simplest thing that satisfies the contract, and enough to prove an agent works: no git, no
 * branches, no conventions. A code-review tool that clones somewhere itself, or a host running
 * agents over scratch space, wants exactly this and nothing more.
 *
 * Isolation is by construction, not by check. Each session's directory is a distinct child of the
 * root named by its own id, so two sessions cannot share one unless they share an id — and ids are
 * refused if they contain separators, which is the only way one could climb into another's.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { isAbsolutePath, normalizePath } from '../core/paths.js';
import type {
  ReleaseOptions,
  ReleaseReceipt,
  Workspace,
  WorkspaceEffects,
  WorkspaceEntry,
  WorkspaceInventory,
  WorkspaceProvider,
} from './provider.js';
import { keyDirectlyUnder, rejectUnusableId } from './git-worktree.js';

export interface PlainDirProviderOptions {
  /** Absolute. Every session directory is created directly beneath it. */
  readonly root: string;
  readonly effects: WorkspaceEffects;
}

export class PlainDirProvider implements WorkspaceProvider {
  readonly #root: string;
  readonly #effects: WorkspaceEffects;

  constructor(options: PlainDirProviderOptions) {
    this.#root = normalizePath(options.root);
    this.#effects = options.effects;
  }

  /** Where this session's directory is, whether or not it exists yet. */
  pathFor(sessionId: string): string {
    return `${this.#root}/${sessionId}`;
  }

  /**
   * The directories under the root. A plain directory has no branch, so every git-shaped member is
   * null or false, and `merged` is null: nothing here can say whether work is kept anywhere.
   */
  async inventory(): Promise<Result<WorkspaceInventory>> {
    const list = this.#effects.listDirectories?.bind(this.#effects);
    if (list === undefined) {
      return refuse<WorkspaceInventory>(
        'workspace-list-failed',
        'this provider has no directory listing to read',
      );
    }
    try {
      const names = await list(this.#root);
      const entries: WorkspaceEntry[] = names.map((name) => ({
        key: name,
        path: `${this.#root}/${name}`,
        branch: null,
        head: null,
        detached: false,
        locked: false,
        prunable: false,
        merged: null,
        aheadCount: null,
        lastCommitAt: null,
      }));
      return ok({ entries, defaultBranch: null });
    } catch (error) {
      return refuse<WorkspaceInventory>('workspace-list-failed', describe(error));
    }
  }

  async provision(sessionId: string): Promise<Result<Workspace>> {
    const invalid = rejectUnusableId<Workspace>(sessionId);
    if (invalid !== null) return invalid;
    if (!isAbsolutePath(this.#root)) {
      return refuse<Workspace>(
        'workspace-provision-failed',
        `the workspace root must be absolute: ${this.#root}`,
      );
    }

    const path = this.pathFor(sessionId);
    try {
      // Creating an existing directory is a no-op, so re-provisioning attaches to whatever is there
      // rather than replacing it. Same rule as the worktree provider, for the same reason: a host
      // that lost track of a directory must not destroy its contents on the way back.
      const reused = await this.#effects.exists(path);
      await this.#effects.makeDirectory(path);
      return ok({ path, meta: { attached: reused ? 'directory' : 'created' } });
    } catch (error) {
      return refuse<Workspace>(
        'workspace-provision-failed',
        `could not provision a directory for ${sessionId} at ${path}: ${describe(error)}`,
      );
    }
  }

  /** The key of the directory at `path` when it sits directly under the root, else null. */
  keyForPath(path: string): string | null {
    return keyDirectlyUnder(path, this.#root);
  }

  async release(sessionId: string, options?: ReleaseOptions): Promise<Result<ReleaseReceipt | undefined>> {
    // The default is to leave it — see ReleaseOptions. A directory nobody asked to remove is
    // evidence, and deleting it by default destroys it exactly when a session ended badly.
    if (options?.remove !== true) return ok(undefined);

    // A plain directory has no branch, so `deleteBranch` finds nothing to delete: the receipt says
    // so (`branchDeleted: false`, no refusal), the idempotent answer for a thing already absent.
    const path = this.pathFor(sessionId);
    try {
      const existed = await this.#effects.exists(path);
      if (existed) await this.#effects.removeDirectory(path);
      return ok({ path, directoryRemoved: existed, branchDeleted: false, refusal: null });
    } catch (error) {
      return refuse<ReleaseReceipt>(
        'workspace-release-failed',
        `could not release the directory for ${sessionId} at ${path}: ${describe(error)}`,
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
