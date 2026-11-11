/**
 * The repositories a host serves beside its home one: the list read, each root checked to be a work tree,
 * and the layout their worktrees take on disk, proven against real repositories.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { GitWorktreeProvider, keyDirectlyUnder, unusableKeyProblem } from '../workspace/git-worktree.js';
import { FURTHER_WORKTREES_DIRECTORY, furtherWorkspaceRoot } from '../workspace/repositories.js';
import { parseRepositoryRoots, repositoryWorkTreeProblem } from './repository-roots.js';
import { nodeCommandEffects, nodeWorkspaceEffects } from './workspace-fs.js';
import { tempDir } from '../test-support/temp-dir.js';

test('the list is read in the platform delimiter, blanks dropped, as the plugin directories are', () => {
  assert.deepEqual(parseRepositoryRoots(['/a', ' /b ', '', '/c'].join(delimiter)), ['/a', '/b', '/c']);
  assert.deepEqual(parseRepositoryRoots(''), []);
  assert.deepEqual(parseRepositoryRoots(null), []);
  assert.deepEqual(parseRepositoryRoots(undefined), []);
});

test('a root with no .git refuses by name; a checkout and a linked worktree pass', async () => {
  const home = await tempDir('repository-roots');
  try {
    const checkout = join(home, 'checkout');
    const linked = join(home, 'linked');
    const plain = join(home, 'plain');
    await mkdir(join(checkout, '.git'), { recursive: true });
    await mkdir(linked, { recursive: true });
    await writeFile(join(linked, '.git'), 'gitdir: elsewhere\n', 'utf8');
    await mkdir(plain, { recursive: true });

    assert.equal(repositoryWorkTreeProblem([checkout, linked]), null);
    assert.match(
      repositoryWorkTreeProblem([checkout, plain]) ?? '',
      /names .*plain, which is not a git work tree/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function repositoryAt(path: string): Promise<void> {
  const commands = nodeCommandEffects();
  await mkdir(path, { recursive: true });
  await commands.run('git', ['init', '--initial-branch=main'], path);
  await commands.run('git', ['config', 'user.email', 'tester@example.invalid'], path);
  await commands.run('git', ['config', 'user.name', 'Tester'], path);
  await writeFile(join(path, 'README.md'), 'base', 'utf8');
  await commands.run('git', ['add', 'README.md'], path);
  await commands.run('git', ['commit', '-m', 'base'], path);
}

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

test("regression: a further repository's worktrees live beneath .repositories, and nothing of the home repository ever touches them", async () => {
  const home = await tempDir('repository-layout');
  try {
    const homeRoot = join(home, 'home');
    const toolsRoot = join(home, 'tools');
    const workspaceRoot = join(home, 'ws');
    await repositoryAt(homeRoot);
    await repositoryAt(toolsRoot);
    const commands = nodeCommandEffects();
    const homeProvider = new GitWorktreeProvider({
      repositoryRoot: homeRoot,
      workspaceRoot,
      effects: nodeWorkspaceEffects,
      commands,
      branchFor: (key) => `home/${key}`,
    });
    const toolsProvider = new GitWorktreeProvider({
      repositoryRoot: toolsRoot,
      workspaceRoot: furtherWorkspaceRoot(workspaceRoot, 'tools'),
      effects: nodeWorkspaceEffects,
      commands,
      branchFor: (key) => `tools/${key}`,
    });

    const own = await homeProvider.provision('k1');
    const further = await toolsProvider.provision('k1');
    assert.ok(own.ok && further.ok);
    if (!own.ok || !further.ok) return;
    assert.equal(further.value.path, `${furtherWorkspaceRoot(workspaceRoot, 'tools')}/k1`);
    assert.ok(await exists(join(further.value.path, 'README.md')), 'the further worktree holds no checkout');

    // The same key again attaches to the tree already there, as a resumed session's open does.
    const again = await toolsProvider.provision('k1');
    assert.ok(again.ok);
    if (again.ok) {
      assert.equal(again.value.path, further.value.path);
      assert.equal(again.value.meta['attached'], 'directory');
    }

    // The home repository's inventory lists its own worktrees and never the directory beside them.
    const inventory = await homeProvider.inventory();
    assert.ok(inventory.ok);
    if (inventory.ok) {
      assert.deepEqual(
        inventory.value.entries.map((entry) => entry.key),
        ['k1'],
      );
      for (const entry of inventory.value.entries) {
        assert.ok(
          !entry.path.includes(FURTHER_WORKTREES_DIRECTORY),
          `the home inventory listed ${entry.path}`,
        );
      }
    }

    // A path naming the directory itself resolves to a key no workspace can have.
    const directory = join(workspaceRoot, FURTHER_WORKTREES_DIRECTORY);
    const asKey = keyDirectlyUnder(directory.replace(/\\/g, '/'), homeProvider.workspaceRoot);
    assert.equal(asKey, FURTHER_WORKTREES_DIRECTORY);
    assert.notEqual(unusableKeyProblem(asKey ?? ''), null, 'the directory reads as a usable home key');

    // Cleaning every home key leaves the further worktrees where they are.
    const cleaned = await homeProvider.release('k1', { remove: true, deleteBranch: true, force: true });
    assert.ok(cleaned.ok);
    assert.ok(
      await exists(join(further.value.path, 'README.md')),
      'cleaning the home key removed a further worktree',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
