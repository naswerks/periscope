/**
 * The SDK baseline pin: the installed `sdk.d.ts` hashes to `contracts/sdk.sha256`, and no copy of
 * it lives in this package.
 *
 * The SDK's type definitions are Anthropic's, all rights reserved, so this package keeps a hash of
 * them and never the text. `scripts/check-drift.mjs` compares the same hash; this pin recomputes it
 * with its own code so the two readers can disagree, and it runs inside the suite so a baseline
 * nobody re-ran the script over is still caught.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const at = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

const INSTALLED_TYPES = at('../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts');
const INSTALLED_MANIFEST = at('../../node_modules/@anthropic-ai/claude-agent-sdk/package.json');
const BASELINE = at('../../contracts/sdk.sha256');
const BASELINE_VERSION = at('../../contracts/sdk-version.txt');
const CONTRACTS_DIR = at('../../contracts');

const normalise = (text: string): string => text.replace(/\r\n/g, '\n');
const digest = (text: string): string => createHash('sha256').update(normalise(text), 'utf8').digest('hex');

/** Null when the text matches the baseline; otherwise both digests, so a failure names what it compared. */
function drift(installed: string, baseline: string): string | null {
  const actual = digest(installed);
  const expected = baseline.trim();
  return actual === expected ? null : `installed ${actual} does not match baseline ${expected}`;
}

const installed = (): string => readFileSync(INSTALLED_TYPES, 'utf8');

test('control: the installed sdk.d.ts is read whole and the comparator reports a planted one-byte change', () => {
  const text = installed();
  assert.ok(text.length > 100_000, `sdk.d.ts looks unread: ${text.length} chars`);

  const baseline = digest(text);
  assert.equal(drift(text, baseline), null, 'the comparator must accept the text it was baselined from');

  const planted = text.replace('export', 'exporT');
  assert.notEqual(planted, text, 'the plant did not change the text, so the control proves nothing');
  assert.match(
    drift(planted, baseline) ?? '',
    /does not match baseline/,
    'a one-byte change must be reported',
  );
});

test('control: line endings alone are not drift', () => {
  const text = installed();
  const crlf = normalise(text).replace(/\n/g, '\r\n');
  assert.notEqual(crlf, normalise(text));
  assert.equal(drift(crlf, digest(text)), null, 'CRLF and LF forms of the same text must hash alike');
});

test('the installed SDK types hash to the committed baseline', () => {
  const baseline = readFileSync(BASELINE, 'utf8');
  assert.match(baseline.trim(), /^[0-9a-f]{64}$/, 'contracts/sdk.sha256 must hold one SHA-256 hex digest');
  assert.equal(
    drift(installed(), baseline),
    null,
    'the installed sdk.d.ts has moved from the baseline; read the SDK diff, then `npm run check:drift -- --update`',
  );
});

test('the baseline names the installed SDK version', () => {
  const recorded = readFileSync(BASELINE_VERSION, 'utf8').trim();
  const { version } = JSON.parse(readFileSync(INSTALLED_MANIFEST, 'utf8')) as { version: string };
  assert.equal(recorded, version, 'contracts/sdk-version.txt must name the version the hash was taken from');
});

test('deliberate: no type-definition file lives under contracts/, only the hash', () => {
  const copies = readdirSync(CONTRACTS_DIR, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.d.ts'));
  assert.deepEqual(
    copies,
    [],
    'a .d.ts under contracts/ is a redistributed dependency, which this package cannot ship',
  );
});
