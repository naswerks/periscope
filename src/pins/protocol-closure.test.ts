/**
 * THE CONSUMER-VISIBLE BOUNDARY: `periscope/protocol` cannot reach the privileged module.
 *
 * The other two pins prove the rule holds inside this repo. This one proves the claim a stranger
 * actually relies on — that importing the wire contract does not hand you a package which can read
 * their disk or spawn a process. It is what makes the `./protocol` subpath a boundary rather than
 * a filing convention.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { closureFrom, importsOf, nodeGlobalUsesIn, sourceFiles } from './walk.js';

const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

test('the protocol subpath cannot reach src/host/', () => {
  const closure = closureFrom('protocol.ts');

  // Positive control: an empty or one-file closure would pass the assertion below for the wrong
  // reason, so prove the walk actually traversed before trusting what it did not find.
  assert.ok(closure.size >= 5, `closure looks untraversed: ${[...closure].join(', ')}`);
  assert.ok(closure.has('control/codec.ts'), 'closure missed the codec; the walk is wrong');

  const privileged = [...closure].filter((path) => path.startsWith('host/'));
  assert.deepEqual(privileged, [], `periscope/protocol reaches ${privileged.join(', ')}`);
});

test('the protocol subpath pulls no node: builtin', () => {
  const byPath = new Map(sourceFiles().map((file) => [file.path, file.text]));
  const offenders: string[] = [];

  for (const path of closureFrom('protocol.ts')) {
    const text = byPath.get(path);
    if (text === undefined) continue;
    for (const specifier of importsOf(text)) {
      if (specifier.startsWith('node:')) offenders.push(`${path} imports ${specifier}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `periscope/protocol must stay runtime-agnostic:\n  ${offenders.join('\n  ')}`,
  );
});

/**
 * The other half of "runtime-agnostic". A `node:` import is visible to an import scan; a Node
 * global is not. `Buffer.byteLength` needs no import, so it can sit inside this closure while the
 * pin above stays green, and the stated claim is then wider than anything asserted.
 */
test('the protocol subpath uses no Node-only global', () => {
  const byPath = new Map(sourceFiles().map((file) => [file.path, file.text]));
  const offenders: string[] = [];

  for (const path of closureFrom('protocol.ts')) {
    const text = byPath.get(path);
    if (text === undefined) continue;
    offenders.push(...nodeGlobalUsesIn({ path, text }));
  }

  assert.deepEqual(
    offenders,
    [],
    `periscope/protocol must run without a Node runtime:\n  ${offenders.join('\n  ')}`,
  );
});

// Guards the selector, not the rule. A scanner that matches nothing reports the same empty array as
// a clean tree.
test('control: the Node-global scanner actually fires on a Node global', () => {
  assert.deepEqual(nodeGlobalUsesIn({ path: 'fake.ts', text: 'const n = Buffer.byteLength(s, "utf8");' }), [
    'fake.ts:1 uses Buffer',
  ]);
  assert.deepEqual(nodeGlobalUsesIn({ path: 'fake.ts', text: 'process.exitCode = 1;' }), [
    'fake.ts:1 uses process',
  ]);

  // And it must not fire on the word. `'process'` is a member of this package's own closed cause
  // vocabulary and appears as English in comments; matching the bare word would read prose as code.
  assert.deepEqual(nodeGlobalUsesIn({ path: 'fake.ts', text: "const kinds = ['process', 'hook'];" }), []);
  assert.deepEqual(nodeGlobalUsesIn({ path: 'fake.ts', text: '// the agent process did not come up' }), []);

  // The closure must be populated, or every assertion above passes over nothing.
  assert.ok(closureFrom('protocol.ts').size >= 5);
});

// The subpath is only a boundary while `exports` refuses to serve anything else. A catch-all
// `"./*"` would leave `periscope/dist/host/machine.js` importable and make the pins above
// decorative — so the shape of the export map is itself part of the contract.
test('exports names exactly the two barrels and no catch-all', () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { exports: Record<string, unknown> };
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './protocol']);
});

/**
 * The property a controller author actually needs, asserted on the source rather than inferred.
 *
 * The closure tests above prove the subpath cannot reach `host/`. They say nothing about whether it
 * carries enough to be usable: the permission decision is the one surface a controller is required
 * to implement, and if every name for it were absent, honouring the boundary and typing your own
 * controller would be mutually exclusive.
 */
test('the protocol subpath exports the permission surface a controller must implement', () => {
  const source = sourceFiles().find((file) => file.path === 'protocol.ts')?.text ?? '';
  assert.ok(source.length > 0, 'protocol.ts was not found by the source walker');

  for (const name of [
    'Decider',
    'Decision',
    'DecisionRequest',
    'DecisionReading',
    'EscalationTransport',
    'EscalationResponse',
  ]) {
    assert.match(
      source,
      new RegExp(String.raw`\b${name}\b`),
      `periscope/protocol does not export ${name}, so a controller cannot type its own decision handler ` +
        `without importing the main barrel and forfeiting this subpath's whole reason to exist`,
    );
  }
});

test('control: the check above can fail, and names a type that is deliberately absent', () => {
  // `SessionStore` is an Agent SDK re-export living in `host/`; it must not be here. If this ever
  // matches, the boundary claim in protocol.ts has quietly become false.
  const source = sourceFiles().find((file) => file.path === 'protocol.ts')?.text ?? '';
  const exportsIt = /export\s+type\s*\{[^}]*\bSessionStore\b/.test(source);

  assert.equal(
    exportsIt,
    false,
    'protocol.ts exports SessionStore; the wire subpath now pulls the Agent SDK',
  );
});
