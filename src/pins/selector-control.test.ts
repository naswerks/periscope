/**
 * The control that makes the other pins believable.
 *
 * A zero-violation result proves nothing when the subject set may be empty: a moved directory, a
 * renamed suffix or a wrong relative path makes every boundary pin pass vacuously, and that green
 * is byte-identical to the honest one. These two assertions are the only thing that tells them
 * apart, so they guard the SELECTOR rather than the rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { importsOf, sourceFiles } from './walk.js';

test('control: the pins are scanning a real, populated source tree', () => {
  const files = sourceFiles();
  assert.ok(files.length >= 15, `expected the source tree, found ${files.length} files`);

  for (const expected of [
    'index.ts',
    'protocol.ts',
    'core/result.ts',
    'host/machine.ts',
    'control/link.ts',
  ]) {
    assert.ok(
      files.some((file) => file.path === expected),
      `selector missed ${expected}; the boundary pins would pass vacuously`,
    );
  }
});

test('the import scanner finds every spelling of an import', () => {
  const found = importsOf(`
    import a from 'alpha';
    import 'beta';
    export { c } from 'gamma';
    const d = await import('delta');
    const e = require('epsilon');
  `);
  assert.deepEqual(found.sort(), ['alpha', 'beta', 'delta', 'epsilon', 'gamma']);
});
