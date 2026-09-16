/**
 * The real effects, on a real disk, and the workspace isolation property proven the only way that
 * counts.
 *
 * "Two different paths" and "neither can see the other's work" are different claims, and the unit
 * tests over recorded effects only ever prove the first. This file writes a real file into one
 * session's workspace and reads the other's directory to show it is not there. A string comparison
 * would pass just as happily against a provider that handed both sessions the same directory under
 * two spellings.
 *
 * These run everywhere — they need a temp directory and nothing else. The git-worktree leg needs a
 * real repository, so it creates a throwaway one rather than touching this checkout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeCommandEffects, nodeWorkspaceEffects } from './workspace-fs.js';
import { PlainDirProvider } from '../workspace/plain-dir.js';
import { GitWorktreeProvider } from '../workspace/git-worktree.js';

const scratch = (): Promise<string> => mkdtemp(join(tmpdir(), 'periscope-workspace-'));

test('the real effects create, detect and remove a directory', async () => {
  const root = await scratch();
  const path = join(root, 'made', 'deeply');

  assert.equal(await nodeWorkspaceEffects.exists(path), false);
  await nodeWorkspaceEffects.makeDirectory(path);
  assert.equal(await nodeWorkspaceEffects.exists(path), true);
  await nodeWorkspaceEffects.removeDirectory(join(root, 'made'));
  assert.equal(await nodeWorkspaceEffects.exists(path), false);
});

test('creating a directory that already exists is not an error', async () => {
  const root = await scratch();
  await nodeWorkspaceEffects.makeDirectory(join(root, 'twice'));
  await nodeWorkspaceEffects.makeDirectory(join(root, 'twice'));
  assert.equal(await nodeWorkspaceEffects.exists(join(root, 'twice')), true);
});

test('removing a directory that is already gone is not an error', async () => {
  const root = await scratch();
  await assert.doesNotReject(() => nodeWorkspaceEffects.removeDirectory(join(root, 'never-there')));
});

// Isolation on a real disk: two sessions, two workspaces, a real file written into one.
test("regression: two sessions get independent workspaces and neither sees the other's work", async () => {
  const root = await scratch();
  const provider = new PlainDirProvider({ root, effects: nodeWorkspaceEffects });

  const alpha = await provider.provision('alpha');
  const beta = await provider.provision('beta');
  assert.equal(alpha.ok && beta.ok, true);
  if (!alpha.ok || !beta.ok) return;

  assert.notEqual(alpha.value.path, beta.value.path);

  // Real work, in one of them.
  await writeFile(join(alpha.value.path, 'notes.txt'), 'alpha wrote this', 'utf8');

  // The other session's directory does not contain it — read from disk, not inferred from the path.
  assert.deepEqual(await readdir(beta.value.path), [], "beta can see alpha's work");
  assert.deepEqual(await readdir(alpha.value.path), ['notes.txt']);

  // And the file that IS there is alpha's, so the read above is looking at the right directory.
  assert.equal(await readFile(join(alpha.value.path, 'notes.txt'), 'utf8'), 'alpha wrote this');

  // Positive control: this whole test would pass vacuously if provisioning had silently done
  // nothing, so assert both directories are real before trusting the emptiness above.
  assert.equal(await nodeWorkspaceEffects.exists(alpha.value.path), true);
  assert.equal(await nodeWorkspaceEffects.exists(beta.value.path), true);
});

test('regression: re-provisioning a session returns the same workspace, with its work intact', async () => {
  const root = await scratch();
  const provider = new PlainDirProvider({ root, effects: nodeWorkspaceEffects });

  const first = await provider.provision('s1');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await writeFile(join(first.value.path, 'work.txt'), 'committed work', 'utf8');

  const second = await provider.provision('s1');
  assert.equal(second.ok, true);
  if (!second.ok) return;

  assert.equal(second.value.path, first.value.path);
  assert.equal(second.value.meta['attached'], 'directory');
  assert.equal(await readFile(join(second.value.path, 'work.txt'), 'utf8'), 'committed work');
});

test('release with remove actually deletes it from the disk', async () => {
  const root = await scratch();
  const provider = new PlainDirProvider({ root, effects: nodeWorkspaceEffects });
  const made = await provider.provision('gone');
  assert.equal(made.ok, true);
  if (!made.ok) return;

  await writeFile(join(made.value.path, 'x.txt'), 'x', 'utf8');
  assert.equal((await provider.release('gone', { remove: true })).ok, true);
  assert.equal(await nodeWorkspaceEffects.exists(made.value.path), false);
});

// ---------------------------------------------------------------------------
// The command effects, and the property the branch probe depends on.
// ---------------------------------------------------------------------------

test('regression: a non-zero exit rejects; the branch probe reads that failure as "no such branch"', async () => {
  const root = await scratch();
  const commands = nodeCommandEffects();

  // `rev-parse --verify` on a branch that cannot exist, in a directory that is not a repository.
  await assert.rejects(
    () => commands.run('git', ['rev-parse', '--verify', 'periscope/nothing-here'], root),
    /failed/,
    'a non-zero exit resolved instead of rejecting — every branch would read as existing, and the provider would attach where it must create',
  );
});

test('a successful command returns its trimmed stdout', async () => {
  const root = await scratch();
  const output = await nodeCommandEffects().run('git', ['--version'], root);
  assert.match(output, /^git version /);
  assert.equal(output, output.trim());
});

test('the failure message carries git\'s own words, not just "command failed"', async () => {
  const root = await scratch();
  await assert.rejects(
    () => nodeCommandEffects().run('git', ['rev-parse', '--verify', 'no-such-branch'], root),
    (error: Error) => {
      assert.match(error.message, /git rev-parse --verify no-such-branch failed/);
      assert.ok(
        error.message.length > 'git rev-parse --verify no-such-branch failed: '.length,
        'no reason was carried',
      );
      return true;
    },
  );
});

// The `-B` rule, end to end, against a real repository. The pure test proves the argv; this proves
// the argv does what it is believed to do: that attaching preserves a commit the base ref does not
// have. Those are two different claims and only this one can falsify the belief itself.
test('regression: a re-provisioned worktree keeps the commits its branch had, against a real repository', async () => {
  const home = await scratch();
  const repository = join(home, 'repo');
  const workspaces = join(home, 'workspaces');
  const commands = nodeCommandEffects();

  await nodeWorkspaceEffects.makeDirectory(repository);
  await commands.run('git', ['init', '--initial-branch=main'], repository);
  await commands.run('git', ['config', 'user.email', 'tester@example.invalid'], repository);
  await commands.run('git', ['config', 'user.name', 'Tester'], repository);
  await writeFile(join(repository, 'README.md'), 'base', 'utf8');
  await commands.run('git', ['add', 'README.md'], repository);
  await commands.run('git', ['commit', '-m', 'base'], repository);

  const provider = new GitWorktreeProvider({
    repositoryRoot: repository,
    workspaceRoot: workspaces,
    baseRef: 'main',
    effects: nodeWorkspaceEffects,
    commands,
  });

  const first = await provider.provision('w1');
  assert.equal(first.ok, true, first.ok ? '' : first.refusal.detail);
  if (!first.ok) return;
  assert.equal(first.value.meta['attached'], 'created');

  // Work, committed inside the worktree — the thing `-B` would destroy.
  await writeFile(join(first.value.path, 'session-work.txt'), 'work that must survive', 'utf8');
  await commands.run('git', ['add', 'session-work.txt'], first.value.path);
  await commands.run('git', ['commit', '-m', 'session work'], first.value.path);
  const tip = await commands.run('git', ['rev-parse', 'HEAD'], first.value.path);

  // The DIRECTORY is lost — a cleanup ran, a volume remounted. The branch is not.
  await commands.run('git', ['worktree', 'remove', '--force', first.value.path], repository);
  await commands.run('git', ['worktree', 'prune'], repository);
  assert.equal(await nodeWorkspaceEffects.exists(first.value.path), false);

  const second = await provider.provision('w1');
  assert.equal(second.ok, true, second.ok ? '' : second.refusal.detail);
  if (!second.ok) return;

  assert.equal(second.value.meta['attached'], 'branch', 'the branch was not detected, so it was recreated');
  assert.equal(
    await commands.run('git', ['rev-parse', 'HEAD'], second.value.path),
    tip,
    'the re-provisioned worktree does not carry the commit made in the first — -B hard-reset the branch and the work is gone',
  );
  assert.equal(
    await readFile(join(second.value.path, 'session-work.txt'), 'utf8'),
    'work that must survive',
    'the committed file did not come back with the branch',
  );
});
