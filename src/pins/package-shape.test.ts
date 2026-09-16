/**
 * THE PACKAGE SHAPE PIN: what an installer actually receives.
 *
 * `pins/protocol-closure.test.ts` proves the export MAP is a boundary. This proves the rest of the
 * shipped shape holds — the allowlist, the runtime floor, the shebang, and the agreement between
 * `engines.node` and the matrix that claims to prove it.
 *
 * Every shipped file is surface, which is why the allowlist is pinned and not just written. A
 * `files` list of `["dist/"]` alone packs every compiled test file and every source map (measured:
 * 674 files and 2.65 MB where the intended package is 169 files and 756 KB), and nothing in the
 * build notices.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { workflowPath } from './walk.js';

const at = (relative: string): string => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const manifest = JSON.parse(readFileSync(at('package.json'), 'utf8')) as {
  files?: string[];
  engines?: { node?: string };
  sideEffects?: unknown;
  private?: unknown;
  dependencies?: Record<string, string>;
  bin?: Record<string, string>;
};

test('the files allowlist exists and excludes tests, maps and pins', () => {
  const files = manifest.files;
  assert.ok(Array.isArray(files) && files.length > 0, 'a package with no `files` allowlist ships everything');

  for (const exclusion of ['!dist/**/*.test.js', '!dist/**/*.map', '!dist/pins/', '!dist/test-support/']) {
    assert.ok(
      files.includes(exclusion),
      `the allowlist does not exclude ${exclusion} — the suite and its maps would ship as API`,
    );
  }
});

test('the package declares no side effects, so a consumer bundler can drop what it does not use', () => {
  assert.equal(manifest.sideEffects, false);
});

test('regression: the SDK is pinned exactly; a caret admits a surface change with no commit to review', () => {
  const pin = manifest.dependencies?.['@anthropic-ai/claude-agent-sdk'];
  assert.ok(pin !== undefined, 'the SDK is not a dependency');
  assert.match(pin, /^\d+\.\d+\.\d+$/, `the pin is "${pin}" — no range operator is allowed at 0.3.x`);
});

/**
 * The floor and the matrix must agree, and nothing else notices when one of them moves. A package
 * that declares `engines.node: ">=20"` while its own test glob requires 22 advertises a floor it
 * cannot run. The matrix in the CI workflow (`workflowPath()`) must actually test the floor the
 * package claims.
 */
test('regression: engines.node names a floor, and the CI matrix actually tests it', () => {
  const declared = manifest.engines?.node;
  assert.ok(typeof declared === 'string', 'engines.node is missing — the runtime floor is undeclared');

  const floor = /^>=\s*(\d+)$/.exec(declared);
  assert.ok(floor !== null, `engines.node is "${declared}" — expected a ">=N" floor`);
  const floorMajor = floor[1] as string;

  const workflow = readFileSync(at(workflowPath()), 'utf8');

  // Positive control: prove the workflow was read and the matrix line is findable before trusting
  // this to report that a version is absent.
  assert.match(workflow, /node:\s*\[/, 'no node matrix found in the workflow — this pin is aimed wrong');

  const matrix = /node:\s*\[([^\]]+)\]/.exec(workflow)?.[1] ?? '';
  const versions = [...matrix.matchAll(/'(\d+)'/g)].map((match) => match[1]);

  assert.ok(versions.length >= 1, `no node versions parsed from the matrix: ${matrix}`);
  assert.ok(
    versions.includes(floorMajor),
    `engines.node declares >=${floorMajor} but the matrix tests [${versions.join(', ')}] — a floor no ` +
      `leg proves is a claim, not a constraint`,
  );
  assert.ok(
    !versions.some((version) => Number(version) < Number(floorMajor)),
    `the matrix tests [${versions.join(', ')}], below the declared floor ${floorMajor} — that leg would ` +
      `be proving a floor this package does not claim`,
  );

  // The floor is written once more in .nvmrc, which nvm, fnm, volta and actions/setup-node read; a
  // floor written in two places with no check is the drift this pin exists to catch.
  const nvmrc = readFileSync(at('.nvmrc'), 'utf8').trim();
  assert.equal(
    Number(nvmrc),
    Number(floorMajor),
    `.nvmrc holds "${nvmrc}" but engines.node declares >=${floorMajor} — the two must name one floor`,
  );
});

test('regression: both operating systems are in the matrix; one of them is where POSIX modes exist at all', () => {
  const workflow = readFileSync(at(workflowPath()), 'utf8');
  assert.match(
    workflow,
    /ubuntu-latest/,
    'no Linux leg — the credential-mode property is unobservable without it',
  );
  assert.match(
    workflow,
    /windows-latest/,
    'no Windows leg: USERPROFILE, windowsHide, case-insensitive env matching and path handling are only observable there',
  );
});

/**
 * The shebang must be LF, and this checks the emitted file rather than the source.
 *
 * A CRLF shebang fails as *"no such file or directory"*, naming the interpreter rather than the
 * line ending. `.gitattributes` governs `*.ts`, but `dist/` is emitted rather than checked out, so
 * `tsconfig.json`'s `newLine` is what decides it, and it is set explicitly rather than relied on
 * as a default.
 */
test('regression: the emitted bin has an LF shebang', () => {
  const binPath = manifest.bin?.['periscope'];
  assert.ok(typeof binPath === 'string', 'package.json declares no bin');

  const emitted = readFileSync(at(binPath.replace(/^\.\//, '')), 'utf8');
  assert.ok(emitted.startsWith('#!'), 'the emitted bin has no shebang at all');
  assert.ok(
    !/^#![^\n]*\r\n/.test(emitted),
    'the emitted shebang ends CRLF — this fails as "no such file or directory" naming the interpreter',
  );
  assert.match(emitted.split('\n')[0] as string, /^#!\/usr\/bin\/env node$/);
});

test('the package stays private until the publish gate is satisfied', () => {
  assert.equal(
    manifest.private,
    true,
    'removing `private` is what arms the publish gate — see scripts/publish-gate.mjs',
  );
});

/**
 * "Package-private" must be a fact the suite holds, not a sentence in a header. The loopback
 * module exports its injected-constructor variant for its own suite, the only way to reach a
 * post-listen server error at all. Its file ships inside `dist/` like every internal module; what
 * keeps it out of the API is the export map, and the export map's word is only as good as the
 * assertion that the published namespaces do not carry the name. This checks it from the
 * consumer's side.
 */
test('regression: the loopback test seam is not reachable from either published barrel', async () => {
  const api = (await import('../index.js')) as Record<string, unknown>;
  const protocol = (await import('../protocol.js')) as Record<string, unknown>;

  // Positive control: the real export is visible, so an absence below means absent, not unread.
  assert.ok(
    'openLoopbackListener' in api,
    'the barrel was not read — the public listener is missing from it',
  );

  assert.ok(
    !('openLoopbackListenerWith' in api),
    'the injected-constructor seam leaked into the main barrel',
  );
  assert.ok(
    !('openLoopbackListenerWith' in protocol),
    'the injected-constructor seam leaked into the protocol barrel',
  );
});
