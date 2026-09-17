/**
 * Closes the exemption `src/pins/` is granted.
 *
 * The boundary rules skip this directory so it can read the source tree. That would be a hole if
 * anything in here could end up in a consumer's dependency graph, so this proves it cannot, which
 * turns the exemption from a convention into a checked fact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { closureFrom } from './walk.js';

for (const barrel of ['index.ts', 'protocol.ts']) {
  test(`nothing under src/pins/ is reachable from ${barrel}`, () => {
    const closure = closureFrom(barrel);

    // Positive control: an untraversed closure would satisfy the filter below for the wrong reason.
    assert.ok(closure.size >= 5, `closure looks untraversed: ${[...closure].join(', ')}`);

    const leaked = [...closure].filter(
      (path) => path.startsWith('pins/') || path.startsWith('test-support/'),
    );
    assert.deepEqual(leaked, [], `${barrel} reaches the exempt directory: ${leaked.join(', ')}`);
  });
}

// Guards the selector, not the rule: the `pins/` filter must be able to fire, and the walk must
// actually reach the privileged modules, or the two assertions above pass over nothing.
test('control: the closure walk sees pins/ when a pin is the entry, and reaches host/ from the main barrel', () => {
  const fromPin = closureFrom('pins/reachability.test.ts');
  assert.ok(fromPin.has('pins/walk.ts'), 'a closure rooted in a pin does not contain the walker it imports');
  assert.ok(
    [...fromPin].some((path) => path.startsWith('pins/')),
    'the pins/ filter can never fire',
  );

  const fromIndex = closureFrom('index.ts');
  assert.ok(fromIndex.has('host/host.ts'), 'the main barrel does not reach host/host.ts');
  assert.ok(fromIndex.has('control/link.ts'), 'the main barrel does not reach control/link.ts');
});
