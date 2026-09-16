/**
 * THE PURITY PIN: `src/core/` imports nothing but itself.
 *
 * No `node:`, no packages, not even a sibling module outside core. That is what lets the contract
 * types run anywhere — in the host, in a controller, in a browser — without dragging a runtime
 * behind them, and it is why core/paths.ts hand-rolls path handling instead of using `node:path`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { importsOf, sourceFiles } from './walk.js';

test('src/core/ imports nothing but itself', () => {
  const violations: string[] = [];

  for (const file of sourceFiles()) {
    if (!file.path.startsWith('core/')) continue;
    for (const specifier of importsOf(file.text)) {
      // Every core module sits directly in src/core/, so a legitimate import is `./sibling.js`.
      // Anything else (a bare package, a `node:` builtin, or a `../` climbing out) is a leak.
      // `file.path` already begins with `core/`, so it is not prefixed again in the message.
      if (!specifier.startsWith('./')) violations.push(`${file.path} imports ${specifier}`);
    }
  }

  assert.deepEqual(violations, [], `src/core/ must import nothing but itself:\n  ${violations.join('\n  ')}`);
});

test('the core is a real module set, not an empty directory', () => {
  const core = sourceFiles().filter((file) => file.path.startsWith('core/'));
  assert.ok(core.length >= 5, `expected the core modules, found ${core.length}`);
});
