/**
 * A rot guard on the probes that need a real agent.
 *
 * The properties those probes cover (that an undeclared variable cannot reach a spawn, that
 * ambient credentials resolve, that a resume carries its context) all fail silently in production,
 * and none of them are exercised by an ordinary `npm test`. So the one thing an ordinary run can
 * check is that they still exist, still name their properties, and are still reachable by the
 * script that runs them. A probe file quietly deleted or renamed would otherwise take its property
 * with it and leave a green suite behind.
 *
 * This is not a substitute for running them. It is the difference between "not exercised in this
 * run" and "no longer exercised by anything".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { allFiles } from './walk.js';

const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

const liveFiles = (): { path: string; text: string }[] =>
  allFiles().filter((file) => file.path.endsWith('.live.test.ts'));

/** The properties the live probes must claim, matched case-insensitively so a rename of case alone does not rot them. */
const CLAIMED_PROPERTIES = [
  'cannot see a variable that is not on the allow-list',
  'version receipt is per session',
  'workspace trust is explicit',
  'survives resume with its context',
];

/** A workspace created under the OS temp directory, and a `mkdtempSync` that is not. */
const TMPDIR_WORKSPACE = /mkdtempSync\(`\$\{tmpdir\(\)\}/;
const OTHER_WORKSPACE = /mkdtempSync\((?!`\$\{tmpdir\(\)\})/;

const claims = (bodies: string, property: string): boolean =>
  bodies.toLowerCase().includes(property.toLowerCase());

test('the live probes exist and each states the property it proves', () => {
  const files = liveFiles();
  assert.ok(files.length > 0, 'every real-agent probe has disappeared');

  const bodies = files.map((file) => file.text).join('\n');
  for (const property of CLAIMED_PROPERTIES) {
    assert.ok(claims(bodies, property), `no live probe claims: ${property}`);
  }
});

test('a live probe never runs against a directory inside a repository', () => {
  // The agent discovers project settings by walking up from its working directory, so a probe
  // rooted in a checkout would load that checkout's settings, hooks included, and could act on a
  // system it is not testing. Every workspace here comes from the OS temp directory instead.
  for (const file of liveFiles()) {
    assert.match(
      file.text,
      TMPDIR_WORKSPACE,
      `${file.path} must build its workspaces under the OS temp directory`,
    );
    assert.equal(
      OTHER_WORKSPACE.test(file.text),
      false,
      `${file.path} creates a workspace somewhere other than the OS temp directory`,
    );
  }
});

test('the live probes are reachable by a script, and excluded from no ordinary run by accident', () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { scripts: Record<string, string> };

  assert.ok(manifest.scripts['test:live'], 'nothing runs the live probes');
  assert.match(manifest.scripts['test:live'] ?? '', /\.live\.test\.js/);
  // And the ordinary suite still loads them, which is what makes their skips visible in its summary
  // rather than invisible by omission.
  assert.match(manifest.scripts['test'] ?? '', /dist\/\*\*\/\*\.test\.js/);
});

test('the probes skip on a named condition rather than on an accident', () => {
  for (const file of liveFiles()) {
    assert.match(file.text, /PERISCOPE_LIVE/, `${file.path} has no gate`);
    // The reason has to travel with the skip, or the summary reports a number and no cause.
    assert.match(
      file.text,
      /not exercised/i,
      `${file.path} skips without stating that the property went unproven`,
    );
  }
});

// Guards the selectors, not the rules: a regex that fires on nothing and an `includes` that
// discriminates nothing would both leave the assertions above green over any file at all.
test('control: the workspace patterns and the property check discriminate on planted text', () => {
  assert.match('const cwd = mkdtempSync(`${tmpdir()}/periscope-live-`);', TMPDIR_WORKSPACE);
  assert.doesNotMatch('const cwd = mkdtempSync(`${tmpdir()}/periscope-live-`);', OTHER_WORKSPACE);

  assert.doesNotMatch("const cwd = mkdtempSync(join(process.cwd(), 'live-'));", TMPDIR_WORKSPACE);
  assert.match("const cwd = mkdtempSync(join(process.cwd(), 'live-'));", OTHER_WORKSPACE);
  assert.match("const cwd = mkdtempSync('/repo/checkout/live-');", OTHER_WORKSPACE);

  const bodies = liveFiles()
    .map((file) => file.text)
    .join('\n');
  assert.ok(bodies.length > 1_000, 'the probe bodies look unread');
  const unclaimed = 'a property that no live probe has ever claimed';
  assert.equal(claims(bodies, unclaimed), false, 'the property check accepts a string nobody claims');
  assert.equal(
    claims(bodies, CLAIMED_PROPERTIES[0] ?? ''),
    true,
    'the property check rejects a claimed property',
  );
});
