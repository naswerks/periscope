import test from 'node:test';
import assert from 'node:assert/strict';

import { isAbsolutePath, isContainedBy, normalizePath, requireAbsolute } from './paths.js';

test('absolute is recognised on both platforms', () => {
  for (const absolute of ['/var/tmp', 'C:\\Users\\x', 'c:/users/x', '\\\\server\\share\\x']) {
    assert.ok(isAbsolutePath(absolute), absolute);
  }
  for (const relative of ['x', './x', '../x', '']) {
    assert.equal(isAbsolutePath(relative), false, relative);
  }
});

test('separators unify and redundant segments collapse', () => {
  assert.equal(normalizePath('C:\\Users\\x\\.\\y'), 'C:/Users/x/y');
  assert.equal(normalizePath('/a//b/./c'), '/a/b/c');
  assert.equal(normalizePath('/a/b/../c'), '/a/c');
});

test('a rooted path cannot climb above its root', () => {
  // Otherwise `/..` escapes a jail by arithmetic, before any filesystem is consulted.
  assert.equal(normalizePath('/../../etc'), '/etc');
  assert.equal(normalizePath('C:\\..\\..\\Windows'), 'C:/Windows');
});

test('requireAbsolute refuses by name rather than guessing a base', () => {
  const refused = requireAbsolute('relative/path');
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.refusal.reason, 'path-not-absolute');

  const accepted = requireAbsolute('/a/b/../c');
  assert.ok(accepted.ok);
  assert.equal(accepted.value, '/a/c');
});

test('containment compares whole segments, so a shared prefix is not containment', () => {
  assert.ok(isContainedBy('/a/b/c', '/a/b'));
  assert.ok(isContainedBy('/a/b', '/a/b'));
  assert.equal(isContainedBy('/a/bc', '/a/b'), false, '/a/bc is a sibling of /a/b, not a child');
  assert.equal(isContainedBy('/a', '/a/b'), false);
  assert.equal(isContainedBy('/a/b/../../c', '/a/b'), false, 'traversal must not sneak in');
});
