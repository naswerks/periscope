/**
 * The vocabulary pin: this package speaks the SDK's words, never a controller's.
 *
 * The layer boundary and the naming boundary are the same line seen twice: the controller decides
 * what a session means, and this package only carries what it did. So a word like `spec` or
 * `verdict` appearing here is evidence that interpretation has leaked down a layer, and the names
 * of the systems this package was first built for are banned outright. A name that no test pins is
 * a name that drifts, which is why this is a check and not a note in a README.
 *
 * This file may say the forbidden words; it is the only one that can, because it is the one that
 * forbids them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allFiles, packageFiles, sourceFiles } from './walk.js';
import { SDK_NOUNS } from '../core/vocab.js';

const CEREMONY = [
  'spec',
  'seat',
  'park',
  'parked',
  'ruling',
  'recon',
  'chain',
  'pipeline',
  'phase',
  'verdict',
  'ceremony',
  'coordinator',
  'sidecar',
  'aspire',
  'whereami',
  'blackboard',
  'tldr',
  'callout',
  'cockpit',
  'kick',
];

const CEREMONY_PATTERN = new RegExp(`\\b(${CEREMONY.join('|')})\\b`, 'i');

/** Product names: no controller or platform is named in the package, as exact words. */
const PRODUCT_NAMES = /\b(nas-platform|NasAgentOps)\b/i;

const SELF = 'pins/vocabulary.test.ts';

/** The pins that must be able to say the forbidden words: this one, and the one that bans tracker rows by name. */
const EXEMPT = new Set([SELF, 'pins/provenance.test.ts']);

/**
 * Every source file (src-relative paths) and everything else that ships or is read by a stranger
 * (package-relative paths): the documents, the examples, the scripts, the CI workflows and the
 * four top-level documents.
 */
function scannedFiles() {
  return [
    ...allFiles(),
    ...packageFiles([
      'docs',
      'examples',
      'scripts',
      '.github',
      'README.md',
      'SECURITY.md',
      'CONTRIBUTING.md',
      'CHANGELOG.md',
      'CODE_OF_CONDUCT.md',
    ]),
  ];
}

function offendersIn(predicate: (path: string) => boolean): string[] {
  const found: string[] = [];
  for (const file of scannedFiles()) {
    if (EXEMPT.has(file.path) || !predicate(file.path)) continue;
    file.text.split('\n').forEach((line, index) => {
      for (const pattern of [CEREMONY_PATTERN, PRODUCT_NAMES]) {
        const hit = pattern.exec(line);
        if (hit !== null) found.push(`${file.path}:${index + 1} says "${hit[1]}"`);
      }
    });
  }
  return found;
}

test('no ceremony vocabulary appears in host/ or core/', () => {
  const offenders = offendersIn((path) => path.startsWith('host/') || path.startsWith('core/'));
  assert.deepEqual(offenders, [], `the controller's vocabulary has leaked:\n  ${offenders.join('\n  ')}`);
});

test('no ceremony vocabulary appears anywhere in the package', () => {
  // Every file under src/, tests included, and everything that ships beside it. A change that believes it
  // needs one of these words has found a layering question, and should answer it deliberately rather
  // than by editing this list.
  const offenders = offendersIn(() => true);
  assert.deepEqual(offenders, [], `the controller's vocabulary has leaked:\n  ${offenders.join('\n  ')}`);
});

// Guards the selector, not the rule: if the scan set were empty or the pattern broken, both
// assertions above would pass while checking nothing.
test('control: the ceremony pattern matches ceremony and the product names, and nothing adjacent', () => {
  assert.match('a spec chain ruling', CEREMONY_PATTERN);
  assert.match('the coordinator parked it', CEREMONY_PATTERN);
  assert.match('the sidecar and the whereami verb', CEREMONY_PATTERN);
  assert.match('served by Aspire', CEREMONY_PATTERN);
  assert.match('the blackboard, a tldr, a callout, the cockpit, a kick', CEREMONY_PATTERN);
  assert.doesNotMatch('the specifier resolves', CEREMONY_PATTERN, 'must not fire on "specifier"');
  assert.doesNotMatch(
    'aspirational, unparked, chained',
    CEREMONY_PATTERN,
    'must not fire inside longer words',
  );
  assert.doesNotMatch('session message hook tool subagent turn result', CEREMONY_PATTERN);

  assert.ok(
    scannedFiles().some((file) => file.path === 'docs/protocol.md'),
    'the scan set is missing the documents',
  );
  for (const expected of ['README.md', 'examples/README.md', 'scripts/publish-gate.mjs']) {
    assert.ok(
      scannedFiles().some((file) => file.path === expected),
      `the scan set is missing ${expected}`,
    );
  }

  assert.match('a product named nas-platform', PRODUCT_NAMES);
  assert.match('the NasAgentOps controller', PRODUCT_NAMES);
  assert.doesNotMatch('a nas mount, and a platform', PRODUCT_NAMES, '"nas" alone is too short to ban');

  assert.ok(sourceFiles().length >= 15);
  const files = allFiles();
  assert.ok(files.length >= 40, `the pin is not scanning a populated tree: ${files.length}`);
  assert.ok(
    files.some((file) => file.path.endsWith('.test.ts')),
    'the scan set excludes tests',
  );
  assert.ok(
    files.some((file) => file.path === SELF),
    'the walker cannot see this file, so the exemption is untested',
  );
});

test('the SDK nouns this package names things after are declared', () => {
  for (const noun of ['session', 'message', 'hook', 'tool', 'subagent', 'turn', 'result']) {
    assert.ok((SDK_NOUNS as readonly string[]).includes(noun), `${noun} must be declared vocabulary`);
  }
});
