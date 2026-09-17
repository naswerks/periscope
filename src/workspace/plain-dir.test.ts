/**
 * The plain-directory provider, and its isolation property.
 *
 * Isolation is checked here over recorded effects; `host/workspace-fs.test.ts` proves the same
 * property against real directories on a real disk, because "these two paths are different strings" and
 * "writing in one is invisible from the other" are not the same claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PlainDirProvider } from './plain-dir.js';
import type { WorkspaceEffects } from './provider.js';
import { isContainedBy } from '../core/paths.js';

function recorder(existing: string[] = []): { calls: string[][]; effects: WorkspaceEffects } {
  const present = new Set(existing);
  const calls: string[][] = [];
  return {
    calls,
    effects: {
      async makeDirectory(path: string): Promise<void> {
        calls.push(['mkdir', path]);
        present.add(path);
      },
      async exists(path: string): Promise<boolean> {
        return present.has(path);
      },
      async removeDirectory(path: string): Promise<void> {
        calls.push(['rmdir', path]);
        present.delete(path);
      },
    },
  };
}

test('a session gets a directory named for it, beneath the root', async () => {
  const recorded = recorder();
  const result = await new PlainDirProvider({ root: '/work', effects: recorded.effects }).provision('s1');

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.path, '/work/s1');
  assert.equal(result.ok && result.value.meta['attached'], 'created');
  assert.deepEqual(recorded.calls, [['mkdir', '/work/s1']]);
});

// The isolation mechanism. Two ids, two directories, and neither contains the other — so nothing one
// session writes can be reached by the other through an ordinary relative path.
test('regression: two sessions get independent directories, neither inside the other', async () => {
  const recorded = recorder();
  const under = new PlainDirProvider({ root: '/work', effects: recorded.effects });
  const a = await under.provision('alpha');
  const b = await under.provision('beta');

  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;

  assert.notEqual(a.value.path, b.value.path);
  assert.equal(isContainedBy(a.value.path, b.value.path), false, 'one session can see into the other');
  assert.equal(isContainedBy(b.value.path, a.value.path), false, 'one session can see into the other');
});

test('re-provisioning attaches to the surviving directory rather than replacing it', async () => {
  const recorded = recorder(['/work/s1']);
  const result = await new PlainDirProvider({ root: '/work', effects: recorded.effects }).provision('s1');

  assert.equal(result.ok && result.value.meta['attached'], 'directory');
  assert.deepEqual(
    recorded.calls.filter((call) => call[0] === 'rmdir'),
    [],
    'an existing workspace was removed on re-provision — whatever was in it is gone',
  );
});

test('a failing mkdir becomes a named refusal', async () => {
  const failing: WorkspaceEffects = {
    async makeDirectory(): Promise<void> {
      throw new Error('EACCES: permission denied');
    },
    async exists(): Promise<boolean> {
      return false;
    },
    async removeDirectory(): Promise<void> {},
  };
  const result = await new PlainDirProvider({ root: '/work', effects: failing }).provision('s1');

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.reason, 'workspace-provision-failed');
  assert.match(!result.ok ? result.refusal.detail : '', /EACCES/);
});

test('an id that could climb out of the root is refused', async () => {
  const recorded = recorder();
  const under = new PlainDirProvider({ root: '/work', effects: recorded.effects });

  // `solo:abc` carries a character git refuses in a refname: the same shared guard screens the
  // refname/path-illegal class here too, so the plain-dir provider cannot re-open the hole the
  // worktree provider closed.
  for (const id of ['../elsewhere', 'a/b', '..', '', 'solo:abc']) {
    const result = await under.provision(id);
    assert.equal(result.ok, false, `${id} was accepted`);
  }
  assert.deepEqual(recorded.calls, [], 'a refused id still touched the filesystem');
});

test('a relative root is refused rather than resolved against the host cwd', async () => {
  const recorded = recorder();
  const result = await new PlainDirProvider({ root: 'work', effects: recorded.effects }).provision('s1');

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.reason, 'workspace-provision-failed');
});

test('release leaves the directory alone by default', async () => {
  const recorded = recorder(['/work/s1']);
  const result = await new PlainDirProvider({ root: '/work', effects: recorded.effects }).release('s1');

  assert.equal(result.ok, true);
  assert.deepEqual(
    recorded.calls,
    [],
    'a directory nobody asked to remove was deleted — the evidence is gone',
  );
});

test('release with remove deletes it', async () => {
  const recorded = recorder(['/work/s1']);
  const result = await new PlainDirProvider({ root: '/work', effects: recorded.effects }).release('s1', {
    remove: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [['rmdir', '/work/s1']]);
});

test('a failing removal is a named refusal rather than a silent leak', async () => {
  const failing: WorkspaceEffects = {
    async makeDirectory(): Promise<void> {},
    async exists(): Promise<boolean> {
      return true;
    },
    async removeDirectory(): Promise<void> {
      throw new Error('EBUSY');
    },
  };
  const result = await new PlainDirProvider({ root: '/work', effects: failing }).release('s1', {
    remove: true,
  });

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.reason, 'workspace-release-failed');
});

test('releasing a session this provider never provisioned succeeds', async () => {
  const recorded = recorder();
  const result = await new PlainDirProvider({ root: '/work', effects: recorded.effects }).release('unknown');

  assert.equal(result.ok, true);
});

test('a windows-shaped root produces windows-shaped session paths', async () => {
  const recorded = recorder();
  const result = await new PlainDirProvider({
    root: 'C:\\work\\sessions',
    effects: recorded.effects,
  }).provision('s1');

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.path, 'C:/work/sessions/s1');
});

test('release with remove answers a receipt: the directory removed, or absent; a plain directory has no branch to delete', async () => {
  const recorded = recorder(['/work/s1']);
  const plain = new PlainDirProvider({ root: '/work', effects: recorded.effects });

  const removed = await plain.release('s1', { remove: true, deleteBranch: true });
  const absent = await plain.release('s2', { remove: true, deleteBranch: true });

  assert.deepEqual(removed.ok && removed.value, {
    path: '/work/s1',
    directoryRemoved: true,
    branchDeleted: false,
    refusal: null,
  });
  assert.deepEqual(absent.ok && absent.value, {
    path: '/work/s2',
    directoryRemoved: false,
    branchDeleted: false,
    refusal: null,
  });
  assert.deepEqual(recorded.calls, [['rmdir', '/work/s1']]);
});

test('keyForPath names only a directory directly under the root', () => {
  const plain = new PlainDirProvider({ root: '/work', effects: recorder().effects });
  assert.equal(plain.keyForPath('/work/s1'), 's1');
  assert.equal(plain.keyForPath('/work'), null);
  assert.equal(plain.keyForPath('/work/a/b'), null);
  assert.equal(plain.keyForPath('/elsewhere/s1'), null);
});
