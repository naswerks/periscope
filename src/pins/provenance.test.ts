/**
 * The provenance pin: no comment in this package points at a document the reader cannot open.
 *
 * A comment earns its line by explaining the code. A ledger id such as `HR-57` explains a project:
 * it is a row in a tracker that lives outside this package and is archived when the effort closes,
 * so the pointer dangles the moment it ships. The same goes for paths into a session archive and
 * for numbered rows, stages, seats, specs and artifacts.
 *
 * The fix when this fires: state the measured fact, and the path of anything in this repository
 * that holds the receipt. Never the id.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allFiles, packageFiles } from './walk.js';
import type { SourceFile } from './walk.js';

/** Ledger ids, as they are written: a short sequence tag, a dash, a number. */
const LEDGER_ID = /\b(?:HR|PI|FC|FX|RWS|E1|E2|DF|C1|D1|CK|L|R)-\d+\b/i;

/**
 * A tracker's short id used as a label: a capital letter or two and a number. It leads a test name or a
 * comment before its colon (`R1: ...`, `Q1 and Q2: ...`, `H3-24: ...`), closes one in brackets
 * (`... (R3)`), or names a constant (`const R1`). A constant that starts with `V` is left alone: a
 * protocol version's decoder is named that way (`V19`).
 */
const LABEL_ID =
  /(?:['"`]|\/\/ ?|\/\*\*? ?|^\s*\* ?)[A-Z]{1,2}\d{1,2}(?:-\d+)?(?::| and [^:'"`]{1,40}:)|\([A-Z]{1,2}\d{1,2}(?:-\d+)?\)|\bconst [A-UW-Z]\d{1,2}\b/;

/** A path into a numbered session archive. */
const SESSION_PATH = /\bsessions\/\d\d-/;

/** A numbered row, stage, seat, spec or artifact of a tracker. */
const NUMBERED_ROW = /\b(?:row|stage|seat|spec|artifact) 0?\d\b/i;

/**
 * A commit of some other repository cited beside its pull request or workflow run: the shape a
 * monorepo's receipts take, and the one thing a fresh repository cannot resolve.
 */
const FOREIGN_RECEIPT = /\b[0-9a-f]{7,40}\b[^\n]{0,80}\b(?:PR #\d+|workflow run \d+|run \d{6,})/i;

const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['ledger id', LEDGER_ID],
  ['tracker id used as a label', LABEL_ID],
  ['session archive path', SESSION_PATH],
  ['numbered tracker row', NUMBERED_ROW],
  ['a commit cited with its pull request or run', FOREIGN_RECEIPT],
];

/** This file plants the forbidden shapes to prove the patterns fire, so it is the one file exempt. */
const SELF = 'src/pins/provenance.test.ts';

/**
 * Every source file, tests included, plus the documents, examples and scripts a stranger reads.
 * Tests are shipped source too, and most ledger ids historically sat in test names.
 */
function scannedFiles(): SourceFile[] {
  const source = allFiles().map((file) => ({ path: `src/${file.path}`, text: file.text }));
  const rest = packageFiles([
    'README.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'publish-attestation.json',
    'docs',
    'examples',
    'scripts',
    '.github',
  ]);
  return [...source, ...rest].filter((file) => file.path !== SELF);
}

function violationsIn(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      for (const [what, pattern] of PATTERNS) {
        const hit = pattern.exec(line);
        if (hit !== null) violations.push(`${file.path}:${index + 1} cites ${what} ${hit[0]}`);
      }
    });
  }
  return violations;
}

test('regression: no ledger id, session archive path or numbered tracker row appears anywhere in this package', () => {
  const violations = violationsIn(scannedFiles());

  assert.deepEqual(
    violations,
    [],
    'a tracker pointer names a document that is not in this repository; state the measured fact ' +
      `instead:\n  ${violations.join('\n  ')}`,
  );
});

// Guards the selector, not the rule: an empty scan set or a broken pattern reports the same empty
// array as a clean tree.
test('control: the provenance patterns match the shapes they exist to catch', () => {
  for (const offender of [
    '  // the mode check that HR-57 made honest',
    "test('HR-56: the gate refuses a read', () => {",
    '  // filed as PI-15',
    '  // FC-1.1, the causally linked one',
    '  // RWS-16: pair belongs on that list',
    '  // e1-14 is the CI red',
    "test('L-13: reading the token cache refuses, by name', () => {",
    '  // see DF-3 and CK-187',
    '  // rider R-2 screens the branch name',
  ]) {
    assert.match(offender, LEDGER_ID, `the ledger pattern missed: ${offender}`);
  }
  for (const offender of [
    "test('R1: every path holding a credential is in the protected set', () => {",
    'test("R2: with a token file configured, the value is in no environment", async () => {',
    '  "Q1 and Q2: the hook fires and asks for a shell and a read",',
    "  'Q4 and the untrusted directory: no session-start hook at create',",
    '  "H3-24: a sub-agent\'s call asks this host through the hook",',
    "test('the read-back and the session config share one list (R3)', () => {",
    '      // R3: the tools turned off are never offered.',
    '/** R1: every path holding a credential or a record, each named. */',
    'const R1 = {',
  ]) {
    assert.match(offender, LABEL_ID, `the label pattern missed: ${offender}`);
  }
  for (const offender of [
    'the CI run on commit 49297fe0 (PR #52)',
    'ciGreen at 9c5d3f87, workflow run 34629960526',
  ]) {
    assert.match(offender, FOREIGN_RECEIPT, `the foreign-receipt pattern missed: ${offender}`);
  }
  assert.doesNotMatch('a sha256 like deadbeef in a hash baseline', FOREIGN_RECEIPT);
  for (const offender of [
    '  // receipt at `sessions/11-proof/artifacts/proof.txt`',
    '  // measured in sessions/07-identity/',
  ]) {
    assert.match(offender, SESSION_PATH, `the session-path pattern missed: ${offender}`);
  }
  for (const offender of [
    '  // decided at row 04',
    '  // stage 7 made this honest',
    '  // Seat 3 owned the wiring',
    '  // spec 02 ordered the matrix',
    '  // artifact 9 records the baseline',
  ]) {
    assert.match(offender, NUMBERED_ROW, `the numbered-row pattern missed: ${offender}`);
  }

  // And nothing may fire on ordinary code and prose that looks similar.
  for (const legitimate of [
    '  const HR = computeHitRate(samples);',
    '  // see RFC-7636 for the PKCE exchange',
    '  const id = `s-1`;',
    '  const seat = 3;',
    '  // the second phase of the handshake',
    '  // sessions/ is the directory the SDK keeps transcripts in',
    '  // a Uint8Array-16 window',
    "test('H1 and H2 headings render as titles', () => {",
    "  const key = 'P256: the curve';",
    '  const ES256 = alg();',
    '  const V19 = decoderOf(19);',
    '  // a (UTF8) label and a (v2) one',
  ]) {
    for (const [what, pattern] of PATTERNS) {
      assert.doesNotMatch(legitimate, pattern, `the ${what} pattern fired on: ${legitimate}`);
    }
  }

  // The reporter must be the thing the rule above uses, and it must name file and line.
  assert.deepEqual(violationsIn([{ path: 'planted.ts', text: 'ok\n// HR-57\n// row 04' }]), [
    'planted.ts:2 cites ledger id HR-57',
    'planted.ts:3 cites numbered tracker row row 04',
  ]);

  // The scan must see a populated tree including tests, documents, examples and scripts, or every
  // assertion above passes over nothing.
  const files = scannedFiles();
  assert.ok(files.length >= 40, `the pin is not scanning a populated tree: ${files.length}`);
  assert.ok(
    !files.some((file) => file.path === SELF),
    'the exemption is not holding: this file would report itself',
  );
  assert.ok(
    files.some((file) => file.path.endsWith('.test.ts')),
    'the scan set excludes tests',
  );
  assert.ok(
    files.some((file) => file.path === 'src/core/refusal.ts'),
    'the scan set is missing shipped source',
  );
  for (const expected of [
    'README.md',
    'SECURITY.md',
    'docs/protocol.md',
    'examples/README.md',
    'scripts/check-coverage.mjs',
  ]) {
    assert.ok(
      files.some((file) => file.path === expected),
      `the scan set is missing ${expected}`,
    );
  }
});
