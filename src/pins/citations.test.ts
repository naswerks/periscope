/**
 * The citations pin: every test file a comment or string names exists.
 *
 * Comments point at suites the way prose points at footnotes ("pinned in `codec.test.ts`"), and a
 * rename leaves the pointer dangling with nothing going red. This makes a named test file a
 * checked fact: the basename must exist somewhere under `src/`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allFiles, packageFiles } from './walk.js';
import type { SourceFile } from './walk.js';

/**
 * A test-file name as it is written in prose: `codec.test.ts`, `stream.live.test.ts`. The lookbehind
 * keeps a bare suffix (`'.live.test.ts'` in an `endsWith`) from reading as a file called `live`.
 */
const CITATION = /(?<![.\w-])[\w-]+(?:\.live)?\.test\.ts(?!\w)/g;

function basenamesUnderSrc(): Set<string> {
  return new Set(allFiles().map((file) => file.path.split('/').at(-1) ?? file.path));
}

function scannedFiles(): SourceFile[] {
  const source = allFiles().map((file) => ({ path: `src/${file.path}`, text: file.text }));
  return [
    ...source,
    ...packageFiles([
      'README.md',
      'SECURITY.md',
      'CONTRIBUTING.md',
      'CHANGELOG.md',
      'docs',
      'examples',
      'scripts',
    ]),
  ];
}

/** Every citation of a test file that does not exist, as `path:line cites X` strings. */
function danglingIn(files: readonly SourceFile[], existing: ReadonlySet<string>): string[] {
  const dangling: string[] = [];
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(CITATION)) {
        if (!existing.has(match[0])) dangling.push(`${file.path}:${index + 1} cites ${match[0]}`);
      }
    });
  }
  return dangling;
}

test('regression: every test file named in a comment or string exists under src/', () => {
  const dangling = danglingIn(scannedFiles(), basenamesUnderSrc());
  assert.deepEqual(
    dangling,
    [],
    `a comment names a test file that does not exist:\n  ${dangling.join('\n  ')}`,
  );
});

// Guards the selector, not the rule. The missing name is assembled at runtime so that this file
// contains no dangling citation of its own.
test('control: the citation detector fires on a planted missing test file and accepts a real one', () => {
  const existing = basenamesUnderSrc();
  assert.ok(existing.has('walk.test.ts'), 'the basename set does not contain a file known to exist');
  assert.ok(existing.size >= 40, `the basename set looks empty: ${existing.size}`);

  const missing = `${'nonexistent'}.test.ts`;
  const planted = [
    '// pinned in walk.test.ts',
    `// see ${missing} and stream.live.test.ts`,
    `const name = '${missing}';`,
  ].join('\n');

  assert.deepEqual(danglingIn([{ path: 'planted.ts', text: planted }], existing), [
    `planted.ts:2 cites ${missing}`,
    `planted.ts:3 cites ${missing}`,
  ]);

  // A live probe is cited whole, never as its suffix alone.
  assert.deepEqual(
    [...'see stream.live.test.ts'.matchAll(CITATION)].map((match) => match[0]),
    ['stream.live.test.ts'],
  );
  // A glob or a bare suffix is not a citation.
  assert.deepEqual([...'dist/**/*.test.ts and the .test.ts suffix'.matchAll(CITATION)], []);
  assert.deepEqual([...`file.path.endsWith('.live.test.ts')`.matchAll(CITATION)], []);
});
