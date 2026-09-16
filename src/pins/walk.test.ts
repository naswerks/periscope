/**
 * The walker's own pin, because every boundary pin in this directory is only as good as this file.
 *
 * `importsOf` is the discriminator under `core-purity`, `host-boundary`, `sdk-confinement` and
 * `protocol-closure`. It can fail in both directions:
 *
 *   false positive: a comment containing `from "the controller said no"` read as an import, so the
 *   purity pin reports `refusal.ts imports the controller said no`. Rewording the comment to make
 *   the guard stop firing is how a guard quietly stops guarding.
 *
 *   false negative (the risk of over-correcting): anchoring the pattern to a line start would
 *   silence the prose, and also stop seeing this package's multi-line imports. A pin that covers
 *   less is worse than the noise it replaced.
 *
 * So the tests below pin both directions, and the multi-line case is the one that matters most:
 * it is what a naive fix breaks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { importsOf, nodeGlobalUsesIn, resolveSpecifier, sourceFiles } from './walk.js';

test('a real import is found, however it is spelled', () => {
  assert.deepEqual(importsOf(`import { a } from './a.js';`), ['./a.js']);
  assert.deepEqual(importsOf(`import type { A } from '../core/a.js';`), ['../core/a.js']);
  assert.deepEqual(importsOf(`import * as ns from 'node:fs';`), ['node:fs']);
  assert.deepEqual(importsOf(`import 'node:os';`), ['node:os']);
  assert.deepEqual(importsOf(`export { a } from './a.js';`), ['./a.js']);
  assert.deepEqual(importsOf(`const m = await import('node:child_process');`), ['node:child_process']);
  assert.deepEqual(importsOf(`const m = require('node:fs');`), ['node:fs']);
});

test('regression: a multi-line import is still found, the case a line-anchored fix would silently lose', () => {
  const source = ['import {', '  FileTokenCache,', '  tokenCachePath,', "} from '../host/index.js';"].join(
    '\n',
  );

  assert.deepEqual(importsOf(source), ['../host/index.js']);
});

test('regression: prose in a comment is not an import', () => {
  const source = `  // ...the refusal that came back from "the controller said no" is not a denial.`;
  assert.deepEqual(importsOf(source), []);
});

test('prose in a BLOCK comment is not an import either', () => {
  const source = [
    '/**',
    ' * Read the value from "the init message" rather than from "the types".',
    ' */',
  ].join('\n');
  assert.deepEqual(importsOf(source), []);
});

test('regression: a sentence inside a string is not an import, the half comment-stripping cannot reach', () => {
  // Survives the stripper, so the whitespace rule is what catches it. Two mechanisms, one invariant,
  // and this is the case that proves the second one is load-bearing.
  const source = `const detail = 'the frame arrived from "a peer we do not know"';`;
  assert.deepEqual(importsOf(source), []);
});

test('a commented-out import is not counted', () => {
  // It does not execute, so it cannot violate a boundary. Reporting it would send a reader to a
  // line that is already dead.
  assert.deepEqual(importsOf(`// import { readFileSync } from 'node:fs';`), []);
});

test('the walker still sees every real import in the shipped tree', () => {
  // The blunt regression guard on the fix above: if stripping or the whitespace rule ever ate a
  // real specifier, the count collapses and this fires. Both numbers are measured, not chosen:
  // at least 16 files import a module, and codec.ts is the busiest single importer.
  const files = sourceFiles();
  const withImports = files.filter((file) => importsOf(file.text).length > 0);

  assert.ok(files.length >= 15, `the walk is not scanning a populated tree: ${files.length}`);
  assert.ok(
    withImports.length >= 15,
    `only ${withImports.length} files appear to import anything; the matcher has narrowed`,
  );
  assert.ok(
    importsOf(files.find((file) => file.path === 'control/codec.ts')?.text ?? '').includes('zod'),
    'the walker lost a real bare-package import',
  );
});

test('resolveSpecifier maps a relative import to its source path, and refuses a bare one', () => {
  assert.equal(resolveSpecifier('control/codec.ts', '../core/result.js'), 'core/result.ts');
  assert.equal(resolveSpecifier('control/codec.ts', './frames.js'), 'control/frames.ts');
  assert.equal(resolveSpecifier('control/codec.ts', 'zod'), null);
});

test('the Node-global scanner reports the file and line, so a reader can go straight there', () => {
  const source = ['const a = 1;', 'const n = Buffer.byteLength(s);'].join('\n');
  assert.deepEqual(nodeGlobalUsesIn({ path: 'control/codec.ts', text: source }), [
    'control/codec.ts:2 uses Buffer',
  ]);
});
