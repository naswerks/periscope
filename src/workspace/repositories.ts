/**
 * The repositories a host serves beside its home one: their names, where their worktrees live, and the
 * variable a session finds each of its own worktrees in. Pure, so the composition root, the host and the
 * start-up screen read one statement of each rule.
 */
import { normalizePath } from '../core/paths.js';

/**
 * The directory under the workspace root that holds every further repository's worktrees, one directory
 * per repository beneath it. A workspace key cannot begin with `.`, so no key of the home repository can
 * ever name it, and the home repository's worktrees stay exactly where they were.
 */
export const FURTHER_WORKTREES_DIRECTORY = '.repositories';

/** A repository's name: its root's last path segment, which the branch scheme's `{repo}` renders. */
export function repositoryNameOf(repositoryRoot: string): string {
  const segments = repositoryRoot.split(/[\\/]+/).filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}

/** Where a further repository's worktrees are made: `<workspace root>/.repositories/<name>`. */
export function furtherWorkspaceRoot(workspaceRoot: string, name: string): string {
  return `${normalizePath(workspaceRoot)}/${FURTHER_WORKTREES_DIRECTORY}/${name}`;
}

/**
 * The variable a session finds its own worktree of `name` in: `PERISCOPE_WORKTREE_` and the name
 * upper-cased, every character outside `A-Z0-9` an underscore. It holds the worktree's path, never the
 * repository's root.
 */
export function worktreeVariableOf(name: string): string {
  return `PERISCOPE_WORKTREE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
