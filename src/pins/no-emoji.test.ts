/**
 * The no-emoji pin: no emoji, dingbat, arrow glyph or marker symbol appears anywhere in the
 * package's source, tests, documents, examples, scripts or workflow.
 *
 * A glyph in a comment or a test name carries a meaning only its author had ("red" for a
 * regression, a star for emphasis), renders differently on every terminal, and is invisible to a
 * plain grep. Words carry the same meaning to everyone. Arrows in prose become words; a
 * regression's name says `regression:`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allFiles, packageFiles, workflowPath } from './walk.js';
import type { SourceFile } from './walk.js';

/**
 * Emoji and pictographs (`Extended_Pictographic` covers the emoji blocks plus the information
 * source and the copyright/registered signs), the Miscellaneous Symbols and Dingbats blocks, the
 * Miscellaneous Symbols and Arrows block, the three arrows that prose most often borrows, the black
 * star and the white circle.
 */
const GLYPH = /\p{Extended_Pictographic}|[\u2600-\u27BF]|[\u2B00-\u2BFF]|\u2190|\u2192|\u21D2|\u2605|\u26AA/u;
const GLYPHS = new RegExp(GLYPH.source, 'gu');

const WORKFLOW = workflowPath();

function scannedFiles(): SourceFile[] {
  const source = allFiles().map((file) => ({ path: `src/${file.path}`, text: file.text }));
  const rest = packageFiles([
    'README.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'docs',
    'examples',
    'scripts',
    'eslint.config.js',
    '.github',
    WORKFLOW,
  ]);
  return [...source, ...rest];
}

/** Every glyph in every file, as `path:line:column is U+XXXX` strings. */
function glyphsIn(files: readonly SourceFile[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(GLYPHS)) {
        const codePoint = (match[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
        found.push(`${file.path}:${index + 1}:${match.index + 1} is U+${codePoint}`);
      }
    });
  }
  return found;
}

test('regression: no emoji, dingbat or arrow glyph appears anywhere in the package', () => {
  const violations = glyphsIn(scannedFiles());
  assert.deepEqual(violations, [], `glyphs found (say it in words instead):\n  ${violations.join('\n  ')}`);
});

// Guards the selector, not the rule. The planted glyphs are built from code points so that this
// file itself stays clean and inside the scan set.
test('control: the glyph detector fires on planted glyphs and names file, line and column', () => {
  const redCircle = String.fromCodePoint(0x1f534);
  const planted = [
    'const a = 1;',
    `test('${redCircle} the gate refuses', () => {});`,
    `// wire ${String.fromCodePoint(0x2192)} reader ${String.fromCodePoint(0x21d2)} process`,
    `// ${String.fromCodePoint(0x2605)} emphasis, ${String.fromCodePoint(0x26aa)} not exercised, ${String.fromCodePoint(0x2139)} info`,
    `// ${String.fromCodePoint(0x2b50)} star, ${String.fromCodePoint(0x2190)} back, ${String.fromCodePoint(0x26a0)} warning`,
  ].join('\n');

  assert.deepEqual(glyphsIn([{ path: 'planted.ts', text: planted }]), [
    'planted.ts:2:7 is U+1F534',
    'planted.ts:3:9 is U+2192',
    'planted.ts:3:18 is U+21D2',
    'planted.ts:4:4 is U+2605',
    'planted.ts:4:16 is U+26AA',
    'planted.ts:4:33 is U+2139',
    'planted.ts:5:4 is U+2B50',
    'planted.ts:5:12 is U+2190',
    'planted.ts:5:20 is U+26A0',
  ]);

  // Ordinary typography is not a glyph: dashes, middle dots, ellipses, comparison signs, accents.
  const ordinary = 'a — b · c … d ≥ 22 × e ≤ f café `code` **bold** -> => <-';
  assert.deepEqual(glyphsIn([{ path: 'ordinary.md', text: ordinary }]), []);

  // The scan set must be populated and must reach beyond src/, or the rule passes over nothing.
  const files = scannedFiles();
  assert.ok(files.length >= 40, `the pin is not scanning a populated tree: ${files.length}`);
  for (const expected of [
    'src/pins/no-emoji.test.ts',
    'README.md',
    'SECURITY.md',
    'docs/protocol.md',
    'scripts/check-coverage.mjs',
    'eslint.config.js',
    WORKFLOW,
  ]) {
    assert.ok(
      files.some((file) => file.path === expected),
      `the scan set is missing ${expected}`,
    );
  }
  assert.ok(
    files.some((file) => file.path.startsWith('examples/')),
    'the scan set is missing the examples',
  );
});
