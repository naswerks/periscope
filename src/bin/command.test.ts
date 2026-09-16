/**
 * The command dispatch.
 *
 * `login` is the verb that makes an `npx` install usable at all: nothing else in this package
 * writes the token cache the daemon reads, so without it a fresh host has no way to acquire a
 * credential. That gap is invisible from inside the daemon: it comes up healthy, reads an empty
 * cache, refuses by name, and (because the link is fail-open) connects with no headers.
 *
 * These tests are about dispatch only. What `login` actually does is `login.ts`'s; what `serve`
 * does is the composition root's. What is pinned here is which one a given argv gets, the same
 * seam, and the same reason, as `workspaces.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { USAGE, readCommand } from './command.js';

test('regression: no arguments is `serve` — every existing supervisor invokes it bare', () => {
  // Not a preference: containers and process managers start this binary with no arguments. A
  // bare invocation must keep doing exactly what it did before the verb existed, or adding a CLI
  // would be a silent migration of every deployment.
  assert.deepEqual(readCommand([]), { kind: 'serve' });
  assert.deepEqual(readCommand(['']), { kind: 'serve' });
  assert.deepEqual(readCommand(['serve']), { kind: 'serve' });
});

test('`login` is reachable, because a host that cannot sign in is not a host', () => {
  assert.deepEqual(readCommand(['login']), { kind: 'login' });
});

test('`pair` carries its code, and a missing code is named rather than guessed', () => {
  // The code is single-use and expires in minutes; sending an empty one to the controller would
  // burn a round-trip to learn what the parser already knows. `null` lets the verb print usage.
  const bare = { controller: null, label: null, problem: null };
  assert.deepEqual(readCommand(['pair', 'abc123']), { kind: 'pair', code: 'abc123', ...bare });
  assert.deepEqual(readCommand(['pair']), { kind: 'pair', code: null, ...bare });
  assert.deepEqual(readCommand(['pair', '']), { kind: 'pair', code: null, ...bare });
});

test('help is reachable by the three spellings an operator actually types', () => {
  for (const spelling of ['help', '--help', '-h']) {
    assert.deepEqual(readCommand([spelling]), { kind: 'help' }, `'${spelling}' should reach help`);
  }
});

test('regression: an unrecognised verb is named, never treated as `serve`', () => {
  // The case that matters. Falling back to the default would mean `periscope logn` silently starts a
  // host: the operator believes they are signing in, the process dials out and begins accepting
  // sessions, and the mistake surfaces much later as an empty token cache. A typo has to fail at the
  // one moment it is cheap to fix.
  assert.deepEqual(readCommand(['logn']), { kind: 'unknown', name: 'logn' });
  assert.deepEqual(readCommand(['--verison']), { kind: 'unknown', name: '--verison' });
});

test('version is reachable by the three spellings an operator types', () => {
  for (const spelling of ['version', '--version', '-v']) {
    assert.deepEqual(readCommand([spelling]), { kind: 'version' });
  }
});

test('only the first argument selects the command', () => {
  // A trailing argument is not a second verb. Pinned so a future option parser cannot quietly change
  // which token decides the branch.
  assert.deepEqual(readCommand(['login', 'serve']), { kind: 'login' });
});

test('control: the usage text names every verb the parser accepts', () => {
  // A check that cannot return the other answer is not a check: without this, adding a verb and
  // forgetting the help line would leave a command that exists and is undiscoverable, and every
  // assertion above would still pass.
  for (const verb of ['serve', 'login', 'pair', 'config', 'help']) {
    assert.ok(
      USAGE.includes(verb),
      `USAGE does not mention '${verb}', so the parser accepts a verb the operator cannot find`,
    );
  }
});

// --- the config verb (v5) -----------------------------------------------------

test('config parses its four shapes: list, read one, write one, unset one', () => {
  assert.deepEqual(readCommand(['config']), { kind: 'config', key: null, value: null, unset: false });
  assert.deepEqual(readCommand(['config', 'PERISCOPE_REPOSITORY_ROOT']), {
    kind: 'config',
    key: 'PERISCOPE_REPOSITORY_ROOT',
    value: null,
    unset: false,
  });
  assert.deepEqual(readCommand(['config', 'PERISCOPE_REPOSITORY_ROOT', 'C:/repo']), {
    kind: 'config',
    key: 'PERISCOPE_REPOSITORY_ROOT',
    value: 'C:/repo',
    unset: false,
  });
  assert.deepEqual(readCommand(['config', '--unset', 'PERISCOPE_REPOSITORY_ROOT']), {
    kind: 'config',
    key: 'PERISCOPE_REPOSITORY_ROOT',
    value: null,
    unset: true,
  });
  assert.deepEqual(readCommand(['config', '--unset']), {
    kind: 'config',
    key: null,
    value: null,
    unset: true,
  });
});

test('config with empty-string arguments reads them as absent, matching every other verb', () => {
  assert.deepEqual(readCommand(['config', '']), { kind: 'config', key: null, value: null, unset: false });
  assert.deepEqual(readCommand(['config', 'K', '']), { kind: 'config', key: 'K', value: null, unset: false });
});

test('pair takes --controller and --label in both spellings, and the code stays positional', () => {
  assert.deepEqual(
    readCommand(['pair', 'abc', '--controller', 'https://c.example:7157', '--label', 'the laptop']),
    {
      kind: 'pair',
      code: 'abc',
      controller: 'https://c.example:7157',
      label: 'the laptop',
      problem: null,
    },
  );
  assert.deepEqual(readCommand(['pair', '--controller=https://c.example', 'abc']), {
    kind: 'pair',
    code: 'abc',
    controller: 'https://c.example',
    label: null,
    problem: null,
  });
});

test('regression: an unknown option, a flag without a value, and a second positional are problems, never the code', () => {
  const unknown = readCommand(['pair', 'abc', '--controler', 'x']);
  assert.equal(unknown.kind === 'pair' ? unknown.problem : null, "unknown option '--controler'");
  const noValue = readCommand(['pair', 'abc', '--label']);
  assert.equal(noValue.kind === 'pair' ? noValue.problem : null, '--label needs a value');
  const extra = readCommand(['pair', 'abc', 'def']);
  assert.equal(extra.kind === 'pair' ? extra.problem : null, "unexpected argument 'def'");
  assert.equal(extra.kind === 'pair' ? extra.code : null, 'abc', 'the first positional is still the code');
});
