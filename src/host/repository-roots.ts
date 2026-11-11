/**
 * The repositories a host serves beside its home one, as its operator configures them
 * (`PERISCOPE_REPOSITORY_ROOTS`): the list read, and each root checked to be a git work tree. The rules
 * that need no disk are `bin/workspaces.ts`'s `repositoryRootsProblem`; this is the half that reads it.
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The roots a `PERISCOPE_REPOSITORY_ROOTS` value names: a path list in the platform's delimiter, as `PERISCOPE_PLUGIN_DIRS` is. */
export function parseRepositoryRoots(value: string | null | undefined): readonly string[] {
  if (value === undefined || value === null) return [];
  return value
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The first root that is not a git work tree, named, or null. A work tree carries `.git` at its top, a
 * directory in a checkout and a file in a linked worktree; a root without one would refuse every
 * session that named it, so the host says so when it starts.
 */
export function repositoryWorkTreeProblem(roots: readonly string[]): string | null {
  for (const root of roots) {
    if (!existsSync(join(root, '.git'))) {
      return `PERISCOPE_REPOSITORY_ROOTS names ${root}, which is not a git work tree (it holds no .git)`;
    }
  }
  return null;
}
