/**
 * The opencode SDK is the operator's, never this package's.
 *
 * `@opencode/sdk` hosts opencode's whole server in the process that loads it, with native code and a tree of
 * its own, and releases more often than this package does. So it is never a dependency: the operator installs
 * it, at the pinned version, into a directory of the runner's own, and a session's host process imports it
 * from there by path when it opens (`src/host/opencode-sdk.ts`). What this file holds:
 * - no shipping file imports the package, by value or by type: the seam loads it from the operator's
 *   directory by path, and is the one file that names it at all;
 * - no test imports it by value, so nothing here loads it at run time but the tests that start it on purpose,
 *   which load it as an operator's install is loaded;
 * - the manifest lists it as a development dependency alone, at exactly the pinned version, and never as a
 *   dependency, an optional one or a peer, so the published package never carries or resolves it;
 * - no declaration the build emits imports it, so a consumer's compiler never looks for it.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { OPENCODE_SDK_PACKAGE, OPENCODE_SDK_PINNED_VERSION } from '../host/opencode-sdk.js';
import { allFiles, importsOf, sourceFiles } from './walk.js';

const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));
const DIST = fileURLToPath(new URL('../', import.meta.url));
const SEAM = 'host/opencode-sdk.ts';
const SCOPE = OPENCODE_SDK_PACKAGE.split('/')[0] ?? '';

const importsTheSdk = (text: string): boolean =>
  importsOf(text).some(
    (specifier) => specifier === OPENCODE_SDK_PACKAGE || specifier.startsWith(`${OPENCODE_SDK_PACKAGE}/`),
  );

/** Whether the code of `text`, its comments left out, names the package: a docs sentence is no use of it. */
const namesTheSdk = (text: string): boolean =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    .includes(OPENCODE_SDK_PACKAGE);

/** Every import of the package in `text` is `import type`. */
const typeOnly = (text: string): boolean =>
  [...text.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+['"]@opencode\/sdk(?:\/[^'"]*)?['"]/gm)].every(
    (found) => found[1] !== undefined,
  );

test('control: the detectors detect', () => {
  assert.equal(importsTheSdk(`import { OpenCode } from '${OPENCODE_SDK_PACKAGE}';`), true);
  assert.equal(
    importsTheSdk(`import type * as Sdk from '${OPENCODE_SDK_PACKAGE}';`),
    true,
    'type-only counts',
  );
  assert.equal(
    importsTheSdk(`import { x } from '${OPENCODE_SDK_PACKAGE}/effect';`),
    true,
    'a subpath counts',
  );
  assert.equal(importsTheSdk("import { z } from 'zod';"), false);
  assert.equal(typeOnly(`import type * as Sdk from '${OPENCODE_SDK_PACKAGE}';`), true);
  assert.equal(typeOnly(`import { OpenCode } from '${OPENCODE_SDK_PACKAGE}';`), false);
  assert.equal(namesTheSdk(`const name = '${OPENCODE_SDK_PACKAGE}';`), true);
  assert.equal(
    namesTheSdk(`/** Loads \`${OPENCODE_SDK_PACKAGE}\`. */\nconst x = 1; // ${OPENCODE_SDK_PACKAGE}`),
    false,
  );
  assert.equal(OPENCODE_SDK_PACKAGE, '@opencode/sdk');
});

test('no shipping file imports the opencode SDK, and the seam is the one file that names it', () => {
  const importers = sourceFiles()
    .filter((file) => importsTheSdk(file.text))
    .map((file) => file.path);
  assert.deepEqual(importers, [], "the SDK is loaded from the operator's directory by path, never imported");
  const naming = sourceFiles()
    .filter((file) => namesTheSdk(file.text))
    .map((file) => file.path);
  assert.deepEqual(naming, [SEAM]);
});

test('no test imports it by value', () => {
  const valueImports = allFiles()
    .filter((file) => importsTheSdk(file.text) && !typeOnly(file.text))
    .map((file) => file.path);
  assert.deepEqual(valueImports, []);
});

test('the manifest lists the SDK as a development dependency alone, at exactly the pinned version', () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >;
  assert.equal(manifest['devDependencies']?.[OPENCODE_SDK_PACKAGE], OPENCODE_SDK_PINNED_VERSION);
  for (const section of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
  ]) {
    const listed = Object.keys(manifest[section] ?? {}).filter((name) => name.startsWith(`${SCOPE}/`));
    assert.deepEqual(listed, [], `${section} lists ${listed.join(', ')}`);
  }
});

test('no declaration the build emits imports the SDK', () => {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = `${dir}${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'pins' || entry.name === 'test-support') continue;
        walk(`${child}/`, `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.d.ts')) {
        if (importsTheSdk(readFileSync(child, 'utf8'))) found.push(`${prefix}${entry.name}`);
      }
    }
  };
  assert.ok(existsSync(DIST), 'the build is where this reads');
  walk(DIST, '');
  assert.deepEqual(found, []);
});
