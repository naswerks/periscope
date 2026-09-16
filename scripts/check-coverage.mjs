#!/usr/bin/env node
/**
 * The coverage ratchet. Compares this package's measured line coverage against `coverage.floor`.
 *
 *   node scripts/check-coverage.mjs <coverage-receipt.txt> [coverage.floor]
 *
 * The floor is derived, not chosen: it is set from what the suite actually achieved when measured,
 * rounded down for a little headroom. Picking a number in advance and writing tests up to it
 * inverts the discipline. The floor lives in `coverage.floor`.
 *
 * The figure the floor is compared against moves with the runner: the same commit measures a
 * quarter of a point apart on node 24 and node 22. That is inside the headroom, but the floor is a
 * single number checked against a version-dependent measurement, and nothing else says so.
 *
 * The floor only moves up. Lowering it is a reviewed decision, never a way to make a run go green.
 *
 * A coverage gate is not the discipline; it is the floor under it. It cannot see a test that passes
 * for an accidental reason. What catches that is watching the test fail with its invariant removed.
 * No percentage substitutes for it.
 *
 * This is a node script rather than a shell script on purpose: it runs identically on both CI legs
 * and never builds a shell pipe, so the `set -o pipefail` plus SIGPIPE failure class cannot arise
 * here.
 */
import { readFileSync } from 'node:fs';

const [, , receiptPath = 'coverage-receipt.txt', floorPath = 'coverage.floor'] = process.argv;

function fail(message) {
  process.stderr.write(`coverage gate: ${message}\n`);
  process.exit(1);
}

let receipt;
try {
  receipt = readFileSync(receiptPath, 'utf8');
} catch {
  fail(`receipt not found: ${receiptPath}. A run's exit code proves nothing until its output exists.`);
}

if (receipt.trim() === '') {
  fail(`receipt is EMPTY: ${receiptPath}. Grepping it for a shortfall finds none for the wrong reason.`);
}

/**
 * The summary row, whatever reporter printed it. Node's default test reporter for non-TTY output
 * differs by version: the default reporter on node 24 prefixes the row with an information-sign glyph
 * (U+2139), the TAP reporter (node 22) prefixes it with `#`:
 *
 *   node 24:         `<U+2139> all files            |  94.97 |    91.85 |   90.53 |`
 *   node 22 (TAP):   `# all files            |  95.00 |    91.44 |   91.23 |`
 *
 * The reporter prefix is not part of the contract, so the pattern does not anchor on it. A pattern
 * that requires one prefix matches nothing on the other runtime, and a gate that matches nothing
 * is not a gate. The row is found by its shape: the words `all files` followed by the three
 * pipe-separated percentages that make it a table row rather than prose.
 */
const SUMMARY = /all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/i;
const totals = SUMMARY.exec(receipt);

if (totals === null) {
  // Report what was established, never a cause that was not. A failure text that asserts the run
  // had no `--experimental-test-coverage` sends a reader to the test script when the defect may be
  // in this parser; a gate whose failure text names the wrong file is worse than one that says
  // "could not parse" and stops.
  //
  // The receipt echoes the npm script it ran, so the flag's presence is checkable rather than
  // guessable, and when it is present that cause is ruled out by evidence instead of suggested.
  const flagPresent = receipt.includes('--experimental-test-coverage');
  const reportPresent = /end of coverage report|# start of coverage report|\bfile\s*\|\s*line %/i.test(
    receipt,
  );
  const looseMention = receipt.split('\n').find((raw) => /all files/i.test(raw));

  const evidence = [
    `--experimental-test-coverage ${flagPresent ? 'IS present in the receipt (so the run DID ask for coverage)' : 'was NOT found in the receipt'}`,
    `a coverage report ${reportPresent ? 'IS present' : 'was NOT found'}`,
    looseMention === undefined
      ? 'no line mentioning "all files" exists at all'
      : `a line mentioning "all files" EXISTS but did not match the expected three-column shape:\n      ${looseMention.trim()}`,
  ];

  fail(
    `no "all files" summary row could be parsed from ${receiptPath}.\n` +
      evidence.map((line) => `    - ${line}`).join('\n') +
      `\n    This gate does NOT know which of these caused the failure. Read the receipt.` +
      (flagPresent
        ? `\n    Note the first point: the coverage flag WAS passed, so "coverage was never measured" is` +
          `\n    ruled out by the receipt itself. Suspect the reporter format or this parser before the test script.`
        : ''),
  );
}

const [, lineText, branchText, functionText] = totals;
const line = Number(lineText);

let floorText;
try {
  floorText = readFileSync(floorPath, 'utf8');
} catch {
  fail(`floor file not found: ${floorPath}`);
}

const floor = Number(floorText.split('\n')[0].trim());
if (!Number.isFinite(floor) || floor <= 0) {
  fail(`floor file does not hold a positive number: ${JSON.stringify(floorText)}`);
}

process.stdout.write(
  `Line coverage: ${line.toFixed(2)}% (floor ${floor.toFixed(2)}%) — branch ${branchText}%, function ${functionText}%\n`,
);

if (line < floor) {
  fail(
    `line coverage ${line.toFixed(2)}% is below the floor ${floor.toFixed(2)}%. Add tests, or — with ` +
      `review — justify lowering ${floorPath}. The floor is meant to move UP.`,
  );
}

process.stdout.write('Coverage gate passed.\n');
