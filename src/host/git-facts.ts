/**
 * Which worktree and which branch a directory sits in: the "where" half of every transition.
 *
 * Why this is read at all: a trace whose location is a bare path answers "where" with something
 * a reader still has to go and look up. Worktree and branch are what makes a transition legible on
 * its own, which is the whole bar the state model is held to.
 *
 * It reads; it never provisions. No `git` subprocess, no writes, no repository creation, just
 * two small file reads. Creating and managing worktrees is a different job and stays one.
 *
 * `.git` is often a file, not a directory, and that is the trap this file exists around.
 * In a linked worktree, `.git` is a text file holding `gitdir: <path>` and pointing at a directory
 * under the main repository's `.git/worktrees/`. A walk-up that looks for a `.git` directory finds
 * nothing there and reports "not a repository", which is wrong, silently, in exactly the
 * environment agents are most often given.
 *
 * Every failure is a named null, never an exception and never an empty string. Three ordinary
 * situations produce no branch: the directory is not in a repository at all (normal — a plain
 * working directory is a legitimate place to run), HEAD is detached (there IS no branch name), or
 * HEAD is unreadable. An empty string would make all three indistinguishable from each other and
 * from a branch literally named "".
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { TransitionWhere } from '../state/model.js';

/** How far up to walk. A repository root further than this from cwd is not a case worth serving. */
const MAX_DEPTH = 64;

/** A `.git` entry found on the way up: the worktree that holds it and the git directory it names. */
interface GitLocation {
  readonly worktree: string;
  readonly gitDir: string;
}

/**
 * The `where` for a directory. Never throws — the caller stamps this onto every transition, so a
 * throw here would take out the state record along with the fact it was decorating.
 */
export function readWhere(cwd: string): TransitionWhere {
  const located = locateGit(cwd);
  if (located === null) {
    return { cwd, worktree: null, branch: null, unknownReason: 'not inside a git repository' };
  }

  const head = readHead(located.gitDir);
  return {
    cwd,
    worktree: located.worktree,
    branch: head.branch,
    unknownReason: head.reason,
  };
}

/** Walk up from `start` for a `.git` entry, accepting both the directory and the pointer-file form. */
function locateGit(start: string): GitLocation | null {
  let current = resolve(start);

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const marker = join(current, '.git');
    const kind = entryKind(marker);

    if (kind === 'dir') return { worktree: current, gitDir: marker };
    if (kind === 'file') {
      const pointed = readGitDirPointer(marker, current);
      // A `.git` file that does not parse is still a `.git` file: this IS the worktree root, and
      // saying so with an unreadable HEAD beats walking past it and reporting "not a repository".
      return { worktree: current, gitDir: pointed ?? marker };
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }

  return null;
}

function entryKind(path: string): 'dir' | 'file' | 'absent' {
  try {
    const stats = statSync(path);
    return stats.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'absent';
  }
}

/** `gitdir: <path>` out of a linked worktree's `.git` file. Relative paths resolve against it. */
function readGitDirPointer(marker: string, worktree: string): string | null {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'));
    const target = pointer?.[1]?.trim();
    if (target === undefined || target.length === 0) return null;
    return isAbsolute(target) ? target : resolve(worktree, target);
  } catch {
    return null;
  }
}

/** The branch, or which of the ordinary situations means there is not one. */
function readHead(gitDir: string): { branch: string | null; reason: string | null } {
  let raw: string;
  try {
    raw = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return { branch: null, reason: 'HEAD could not be read' };
  }

  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(raw);
  if (ref?.[1] !== undefined) return { branch: ref[1].trim(), reason: null };

  // A bare object id is a detached HEAD: there genuinely is no branch, which is different from
  // failing to find one, and a reader deciding whether a run is on the branch it should be needs
  // to be able to tell those apart.
  if (/^[0-9a-f]{40}$/i.test(raw)) return { branch: null, reason: 'HEAD is detached' };

  return { branch: null, reason: `HEAD is in an unrecognised form: ${raw.slice(0, 40)}` };
}
