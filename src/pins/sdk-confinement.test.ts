/**
 * THE SIXTH BOUNDARY PIN: only `src/host/` names the Agent SDK.
 *
 * WHY THIS EXISTS, because it is not obvious from the rule alone. The boundary this package is sold
 * on is stated as *"nothing outside `src/host/` touches the filesystem, spawns a process, or reads
 * the machine"* — but host-boundary.test.ts checks four `node:` specifiers, and an import of
 * `@anthropic-ai/claude-agent-sdk` is none of them. That import starts a real CLI subprocess. So
 * before this file existed, moving the SDK into any other directory would have left the boundary
 * pin GREEN while the claim it states became false: a pin that reads like coverage and is not.
 *
 * That failure mode is the reason the claim gets its own check rather than a wider list on the
 * existing one. A package specifier is not a `node:` builtin, and conflating them would make the
 * older pin's message wrong about what it found.
 *
 * The rule covers type-only imports too, deliberately: a type import still names the specifier,
 * and the point is that one directory answers "what can start a process here?".
 * `host/agent-process.ts` re-exports the SDK types the layer above needs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { allFiles, importsOf, sourceFiles } from './walk.js';

const SDK = '@anthropic-ai/claude-agent-sdk';
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

const namesTheSdk = (text: string): boolean =>
  importsOf(text).some((specifier) => specifier === SDK || specifier.startsWith(`${SDK}/`));

test('only src/host/ imports the Agent SDK', () => {
  const violations = sourceFiles()
    .filter((file) => !file.path.startsWith('host/') && namesTheSdk(file.text))
    .map((file) => file.path);

  assert.deepEqual(
    violations,
    [],
    `the SDK spawns a process, so it is confined to src/host/ like the node: builtins are:\n  ${violations.join('\n  ')}`,
  );
});

// The rule is only worth having if src/host/ is genuinely where that capability lives. A boundary
// around an empty room is not a boundary; the same control host-boundary.test.ts carries.
test('src/host/ actually holds the SDK import', () => {
  const importers = sourceFiles()
    .filter((file) => file.path.startsWith('host/') && namesTheSdk(file.text))
    .map((file) => file.path);

  assert.ok(importers.length > 0, 'nothing in src/host/ imports the SDK; has the seam moved?');
});

// Guards the selector rather than the rule. A renamed package, a typo in the specifier, or a walker
// that stopped finding files would make the first assertion pass over an empty set, and that green
// is byte-identical to the honest one.
test('control: the SDK detector actually detects the SDK', () => {
  assert.equal(namesTheSdk(`import { query } from '${SDK}';`), true);
  assert.equal(namesTheSdk(`import type { Options } from '${SDK}';`), true, 'type-only counts');
  assert.equal(namesTheSdk(`export type { X } from '${SDK}/sdk-tools';`), true, 'subpaths count');
  assert.equal(namesTheSdk("import { z } from 'zod';"), false);
  assert.equal(namesTheSdk("import x from './agent-process.js';"), false);

  assert.ok(allFiles().length >= 20, 'the walker is not reading the source tree');
});

// The specifier this rule is written against must be the one the package actually depends on. A pin
// guarding a package name nothing installs would pass forever while the real dependency went
// unwatched — the same shape as a rule whose subject set is empty.
test('the confined specifier is a real declared dependency, not a string', () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    dependencies: Record<string, string>;
  };
  assert.ok(
    Object.prototype.hasOwnProperty.call(manifest.dependencies, SDK),
    `${SDK} is not a dependency; this pin is guarding a name nothing uses`,
  );
  // Pinned exactly, no range: every build must read the same shipped types, and a caret would let
  // a bump land between one install and the next.
  assert.match(
    manifest.dependencies[SDK] ?? '',
    /^\d+\.\d+\.\d+$/,
    'the SDK must be pinned to an exact version',
  );
});
