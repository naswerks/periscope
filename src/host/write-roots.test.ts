/**
 * Where a session may write beside its own directory: the temp folder its environment names, and the fence
 * a further root stands behind.
 *
 * The environment, the platform, the resolver and the real-path reader are passed in, so these assert a
 * stated machine instead of whatever the machine running them happens to have.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mayBeWriteRoot, sessionTempFolder, sessionTempRoots } from './write-roots.js';
import type { WriteRootFence } from './write-roots.js';

test('the temp folder is the one the session environment names: TEMP, then TMP, on Windows', () => {
  assert.equal(sessionTempFolder({ TEMP: 'C:\\t1', TMP: 'C:\\t2' }, 'win32'), 'C:\\t1');
  assert.equal(sessionTempFolder({ TMP: 'C:\\t2' }, 'win32'), 'C:\\t2');
  assert.equal(sessionTempFolder({ TMPDIR: '/x' }, 'win32'), null, 'TMPDIR is not where Windows writes');
});

test('regression: on Windows with neither named there is no temp folder, never the profile the system falls back to', () => {
  assert.equal(sessionTempFolder({ USERPROFILE: 'C:\\Users\\agent' }, 'win32'), null);
  assert.equal(sessionTempFolder({ TEMP: '  ' }, 'win32'), null);
});

test('elsewhere the temp folder is TMPDIR, else /tmp', () => {
  assert.equal(sessionTempFolder({ TMPDIR: '/var/folders/x/T' }, 'linux'), '/var/folders/x/T');
  assert.equal(sessionTempFolder({}, 'linux'), '/tmp');
  assert.equal(sessionTempFolder({ TEMP: 'C:\\t1' }, 'darwin'), '/tmp');
});

const FENCE: WriteRootFence = {
  notAbove: [
    'C:/Users/agent',
    'C:/Users/agent/.claude/.credentials.json',
    'C:/Users/agent/.periscope',
    'C:/ws',
    'C:/checkouts/home',
  ],
  notBeneath: ['C:/ws', 'C:/checkouts/home'],
};

test('a temp folder beneath the home directory, as Windows places it, may be a root', () => {
  assert.equal(mayBeWriteRoot('C:/Users/agent/AppData/Local/Temp', FENCE), true);
  assert.equal(
    mayBeWriteRoot('/tmp', { notAbove: ['/home/agent', '/srv/ws'], notBeneath: ['/srv/ws'] }),
    true,
  );
});

test('regression: a temp folder at or above the home directory or a protected path is no root', () => {
  assert.equal(
    mayBeWriteRoot('C:/Users/agent', FENCE),
    false,
    'the home directory holds the agent configuration',
  );
  assert.equal(mayBeWriteRoot('C:/Users', FENCE), false);
  assert.equal(mayBeWriteRoot('C:/Users/agent/.claude', FENCE), false);
  assert.equal(mayBeWriteRoot('c:/users/AGENT', FENCE), false, 'another spelling of the home is the home');
});

test('regression: a temp folder that covers a workspace or a checkout, or sits inside one, is no root', () => {
  assert.equal(mayBeWriteRoot('C:/', FENCE), false);
  assert.equal(mayBeWriteRoot('C:/ws/tmp', FENCE), false, 'it would admit writes beside every worktree');
  assert.equal(
    mayBeWriteRoot('C:/checkouts/home/.tmp', FENCE),
    false,
    "it would admit the operator's checkout",
  );
  assert.equal(mayBeWriteRoot('C:/ws-scratch', FENCE), true, 'a sibling by prefix is not inside');
});

test('control: the fence is what refuses; an empty one admits the same folders', () => {
  const open: WriteRootFence = { notAbove: [], notBeneath: [] };
  for (const folder of ['C:/Users/agent', 'C:/ws/tmp', 'C:/checkouts/home/.tmp']) {
    assert.equal(mayBeWriteRoot(folder, open), true, folder);
  }
});

const identity = (candidate: string): string => candidate.replace(/\\/g, '/');

test('the temp roots are the folder as named and its real path beside when spelled otherwise', () => {
  const roots = sessionTempRoots({ TEMP: 'C:\\Users\\AGENT~1\\AppData\\Local\\Temp' }, FENCE, {
    platform: 'win32',
    resolve: identity,
    realPath: () => 'C:/Users/agent/AppData/Local/Temp',
  });
  assert.deepEqual(roots, ['C:/Users/AGENT~1/AppData/Local/Temp', 'C:/Users/agent/AppData/Local/Temp']);
  const one = sessionTempRoots({ TEMP: 'C:\\Users\\agent\\AppData\\Local\\Temp' }, FENCE, {
    platform: 'win32',
    resolve: identity,
    realPath: (candidate) => candidate,
  });
  assert.deepEqual(one, ['C:/Users/agent/AppData/Local/Temp']);
});

test('regression: a temp folder whose real path is fenced gives no root at all, whatever it is named', () => {
  const roots = sessionTempRoots({ TEMP: 'C:\\scratch' }, FENCE, {
    platform: 'win32',
    resolve: identity,
    realPath: () => 'C:/Users/agent',
  });
  assert.deepEqual(roots, []);
});

test('no temp folder named, or one the resolver cannot read, gives no root', () => {
  assert.deepEqual(sessionTempRoots({}, FENCE, { platform: 'win32', resolve: identity }), []);
  const throwing = sessionTempRoots({ TEMP: 'C:\\t' }, FENCE, {
    platform: 'win32',
    resolve: () => {
      throw new Error('unreadable');
    },
  });
  assert.deepEqual(throwing, []);
});
