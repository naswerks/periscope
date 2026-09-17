/**
 * The "where" reader, against real directories on disk.
 *
 * The linked-worktree case is the one that matters and it is easy to get silently wrong: `.git` is
 * a FILE there, not a directory, and a walk-up that only looks for a directory reports "not a
 * repository" for a directory that plainly is one. Agents are routinely given linked worktrees, so
 * that wrong answer would be the normal answer.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { readWhere } from './git-facts.js';

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `periscope-git-${label}-`));
}

test('a plain checkout reports its worktree root and its branch', () => {
  const root = scratch('plain');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });

  const where = readWhere(join(root, 'src', 'deep'));
  assert.equal(where.cwd, join(root, 'src', 'deep'));
  assert.equal(where.worktree, root, 'the walk-up found the root from a nested directory');
  assert.equal(where.branch, 'main');
  assert.equal(where.unknownReason, null);
});

test('regression: a linked worktree, where .git is a file, is read, not mistaken for a plain directory', () => {
  const main = scratch('linked-main');
  const linked = scratch('linked-tree');
  const gitDir = join(main, '.git', 'worktrees', 'topic');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/feature/topic-branch\n');
  writeFileSync(join(linked, '.git'), `gitdir: ${gitDir.replace(/\\/g, '/')}\n`);

  const where = readWhere(linked);
  assert.equal(where.worktree, linked, 'the worktree is where the pointer file lives');
  assert.equal(where.branch, 'feature/topic-branch', 'a branch name with a slash survives intact');
  assert.equal(where.unknownReason, null);
});

test('a relative gitdir pointer resolves against the worktree that holds it', () => {
  const root = scratch('relative');
  const gitDir = join(root, 'store', 'worktrees', 'w1');
  const tree = join(root, 'tree');
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(tree);
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/feature\n');
  writeFileSync(join(tree, '.git'), 'gitdir: ../store/worktrees/w1\n');

  assert.equal(readWhere(tree).branch, 'feature');
});

test('a directory in no repository is a NAMED outcome, not an error and not an empty string', () => {
  const plain = scratch('norepo');

  const where = readWhere(plain);
  assert.equal(where.worktree, null);
  assert.equal(where.branch, null);
  assert.equal(where.unknownReason, 'not inside a git repository');
  assert.equal(where.cwd, plain, 'the one thing always known is still reported');
});

test('a detached HEAD says so — there is no branch, which is not the same as failing to find one', () => {
  const root = scratch('detached');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), 'a'.repeat(40));

  const where = readWhere(root);
  assert.equal(where.worktree, root, 'it IS a repository');
  assert.equal(where.branch, null);
  assert.equal(where.unknownReason, 'HEAD is detached');
});

test('an unreadable or unrecognised HEAD is reported rather than thrown', () => {
  const missing = scratch('nohead');
  mkdirSync(join(missing, '.git'));
  assert.equal(readWhere(missing).unknownReason, 'HEAD could not be read');

  const odd = scratch('oddhead');
  mkdirSync(join(odd, '.git'));
  writeFileSync(join(odd, '.git', 'HEAD'), 'ref: refs/remotes/origin/weird\n');
  assert.match(readWhere(odd).unknownReason ?? '', /unrecognised form/);
});

test('a .git file that does not parse still identifies the worktree', () => {
  const root = scratch('badpointer');
  writeFileSync(join(root, '.git'), 'this is not a gitdir pointer\n');

  const where = readWhere(root);
  assert.equal(where.worktree, root, 'a .git file IS the marker, whatever it says inside');
  assert.equal(where.branch, null);
  assert.match(where.unknownReason ?? '', /HEAD could not be read/);
});

test('reading never throws, whatever it is pointed at', () => {
  assert.doesNotThrow(() => readWhere(join(tmpdir(), 'periscope-definitely-absent-directory')));
  assert.doesNotThrow(() => readWhere(''));
});

test("this package's own directory reads as a repository — the environment it actually runs in", () => {
  // The regression control for the linked-worktree case: this suite is itself frequently run
  // from a linked worktree, so a reader that only understood plain checkouts would fail HERE and
  // nowhere else. It asserts a repository was found rather than a specific branch, because the
  // branch legitimately differs between checkouts — and on a DETACHED HEAD (actions/checkout@v4's
  // default, so the state every CI run is in) there legitimately is no branch at all. The bar is
  // a READABLE HEAD: a named branch, or the detached form said in so many words. Anything else
  // (an unreadable or unrecognised HEAD) still fails.
  const where = readWhere(process.cwd());
  assert.notEqual(where.worktree, null, `the package's own directory read as: ${where.unknownReason}`);
  const namedBranch = (where.branch?.length ?? 0) > 0 && where.unknownReason === null;
  const detached = where.branch === null && where.unknownReason === 'HEAD is detached';
  assert.ok(
    namedBranch || detached,
    `HEAD should read as a named branch or as detached — got branch=${JSON.stringify(where.branch)}, unknownReason=${JSON.stringify(where.unknownReason)}`,
  );
});
