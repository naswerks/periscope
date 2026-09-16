/**
 * THE BOUNDARY PIN: nothing outside `src/host/` touches the filesystem, spawns a process, or reads
 * the machine.
 *
 * This is the claim the package is sold on — a reviewer answers "what can this touch on my
 * machine?" by reading one directory. It is enforced twice, and this is the half that survives the
 * ESLint config being edited, disabled or deleted, because it runs in the suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { importsOf, sourceFiles } from './walk.js';

const PRIVILEGED = ['node:fs', 'node:fs/promises', 'node:child_process', 'node:os'];

test('nothing outside src/host/ imports fs, child_process or os', () => {
  const violations: string[] = [];

  for (const file of sourceFiles()) {
    if (file.path.startsWith('host/')) continue;
    for (const specifier of importsOf(file.text)) {
      if (PRIVILEGED.includes(specifier)) violations.push(`${file.path} imports ${specifier}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `the privileged modules are confined to src/host/:\n  ${violations.join('\n  ')}`,
  );
});

// The rule is only worth having if src/host/ is genuinely where that capability lives. A boundary
// around an empty room is not a boundary.
test('src/host/ actually holds the privileged imports', () => {
  const hostImports = sourceFiles()
    .filter((file) => file.path.startsWith('host/'))
    .flatMap((file) => importsOf(file.text));

  for (const expected of ['node:fs', 'node:fs/promises', 'node:os']) {
    assert.ok(hostImports.includes(expected), `src/host/ does not import ${expected}`);
  }
});
