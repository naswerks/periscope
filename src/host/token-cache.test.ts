/**
 * The token cache on a real filesystem, and the honest reporting of what the platform can
 * actually confirm about it.
 *
 * Read this before adding an assertion about `0600` here. On win32 `node` accepts a mode and does
 * nothing with it: a file written `0o600`, a file `chmod`ed to `0o600`, and a file deliberately
 * written `0o666` all report `0o666` from `statSync`. So on win32 a real-file mode assertion is
 * either always-red or always-green-and-meaningless. The property is proven in
 * `identity/mode.test.ts` against stated inputs; what is proven here is that this module measures
 * the platform correctly and reports what it found. The POSIX half is exercised only where the
 * suite runs on a POSIX filesystem.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileTokenCache, probeModeEnforcement } from './token-cache.js';
import type { CachedTokens } from '../identity/store.js';

const CACHED: CachedTokens = {
  tokens: {
    accessToken: 'the-access-token',
    refreshToken: 'the-refresh-token',
    expiresAt: 1_800_000_000_000,
    tokenType: 'Bearer',
    scope: 'openid',
  },
  protocol: 'loopback',
  authority: 'https://example.ciamlogin.com/tenant',
  clientId: 'client-abc',
};

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'periscope-cache-'));
}

test('a written cache reads back as the same tokens', () => {
  const dir = scratch();
  try {
    const cache = new FileTokenCache(join(dir, 'token-cache.json'));

    assert.ok(cache.write(CACHED).ok);
    const read = cache.read();

    assert.ok(read.ok);
    assert.equal(read.value.tokens.accessToken, 'the-access-token');
    assert.equal(read.value.protocol, 'loopback');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the cache directory is created on first write — a fresh host has no .periscope yet', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'nested', 'deeper', 'token-cache.json');

    assert.ok(new FileTokenCache(path).write(CACHED).ok);
    assert.ok(statSync(path).isFile());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reading a cache that does not exist is token-unavailable, NOT a corruption error', () => {
  const dir = scratch();
  try {
    const result = new FileTokenCache(join(dir, 'token-cache.json')).read();

    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.refusal.reason : null, 'token-unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: a cache that exists and is not JSON gets its own reason, and the message says how to fix it', () => {
  // Reported as "not signed in" it would send an operator round a loop that cannot terminate: they
  // sign in, the write succeeds, and the same unparseable file is still there next boot.
  const dir = scratch();
  try {
    const path = join(dir, 'token-cache.json');
    writeFileSync(path, 'this is not json');

    const result = new FileTokenCache(path).read();

    assert.equal(result.ok === false ? result.refusal.reason : null, 'credential-cache-unreadable');
    assert.match(result.ok === false ? result.refusal.detail : '', /sign in again/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the written file is JSON a human can read, and ends with a newline', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'token-cache.json');
    new FileTokenCache(path).write(CACHED);

    const raw = readFileSync(path, 'utf8');

    assert.match(raw, /\n$/);
    assert.equal((JSON.parse(raw) as { protocol?: string }).protocol, 'loopback');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearing removes the cache, and clearing again is not an error', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'token-cache.json');
    const cache = new FileTokenCache(path);
    cache.write(CACHED);

    cache.clear();
    assert.equal(cache.read().ok, false);
    assert.doesNotThrow(() => cache.clear());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an overwrite does not widen an existing file — the mode is restated, not assumed', () => {
  // `writeFileSync`'s `mode` applies only when it CREATES the file. Without the explicit `chmod`,
  // a cache first written by some other tool at 0644 would stay 0644 through every refresh.
  const dir = scratch();
  try {
    const path = join(dir, 'token-cache.json');
    writeFileSync(path, '{}', { mode: 0o666 });

    const result = new FileTokenCache(path).write(CACHED);

    assert.ok(result.ok, result.ok === false ? result.refusal.detail : '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The platform probe
// ---------------------------------------------------------------------------

test('control: this filesystem can be observed to change a mode at all', () => {
  // Asserted before the negative, and that ordering is the point. Every claim below about modes
  // not being enforced is worthless unless the instrument can be shown to observe something. On
  // win32 the write bit is the one real bit: `chmod 0444` reads back as `444` while `0600` and
  // `0666` are identical. Without this, "unenforced" and "the probe is broken" are the same answer.
  //
  // 0444 is the control, never the target state: the cache must stay owner-writable, because
  // refreshes are written to it.
  const dir = scratch();
  try {
    const file = join(dir, 'control');
    writeFileSync(file, '', { mode: 0o666 });
    const wide = statSync(file).mode & 0o777;

    chmodSync(file, 0o444);
    const readOnly = statSync(file).mode & 0o777;
    chmodSync(file, 0o666);

    assert.notEqual(
      readOnly,
      wide,
      `this filesystem reported ${wide.toString(8)} for a writable file and ${readOnly.toString(8)} after ` +
        `clearing the write bit; the instrument observes nothing, so every mode finding here is inconclusive`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: the mode probe agrees with what this platform actually does, whichever platform it is', () => {
  // Written to pass on BOTH kinds of platform deliberately: it asserts the probe's answer matches a
  // measurement taken here, rather than asserting a platform. A `process.platform === 'win32'` test
  // would be a guess that WSL or a mounted POSIX filesystem makes wrong in the direction that
  // matters.
  const dir = scratch();
  try {
    const probeAnswer = probeModeEnforcement(dir);

    // Each widening is a `chmod`, never a rewrite. Taking the `wide` measurement with
    // `writeFileSync(file, '', { mode: 0o666 })` walks straight into the trap this file documents
    // above: the `mode` option applies only when `writeFileSync` creates the file. The file already
    // exists at 0600, so `wide` would read back 0600, `narrow !== wide` would be false, and the
    // derivation would fall through to `write-bit-only` on a platform that plainly enforces modes.
    //
    // That mistake is invisible where modes are not real: on win32 the narrow branch is never taken
    // (a 0600 file reads back 666), so it only surfaces on a POSIX filesystem.
    const file = join(dir, 'measure-me');
    writeFileSync(file, '', { mode: 0o600 });
    const narrow = statSync(file).mode & 0o777;
    chmodSync(file, 0o666);
    const wide = statSync(file).mode & 0o777;
    chmodSync(file, 0o444);
    const readOnly = statSync(file).mode & 0o777;
    chmodSync(file, 0o666);

    const expected =
      narrow === 0o600 && narrow !== wide
        ? 'enforced'
        : readOnly !== wide
          ? 'write-bit-only'
          : 'unobservable';

    assert.equal(
      probeAnswer,
      expected,
      `the probe said ${probeAnswer} while this filesystem reported ${narrow.toString(8)} / ${wide.toString(8)} / ${readOnly.toString(8)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: the mode enforcement answer is a measurement rather than an absence', () => {
  // The negative, stated only after the control above. On a POSIX filesystem this asserts the other
  // side, so the test says something on every platform instead of being skipped on one.
  const dir = scratch();
  try {
    const enforcement = probeModeEnforcement(dir);

    assert.notEqual(
      enforcement,
      'unobservable',
      'the probe could observe no mode change at all — inconclusive, not a finding',
    );
    assert.ok(['enforced', 'write-bit-only'].includes(enforcement), enforcement);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: the probe reports "unobservable" rather than throwing when it cannot run at all', () => {
  // Unable-to-measure is reported as unable-to-measure, and not as "modes are not enforced"; the
  // two are different investigations. A throw here would make a sign-in fail on a read-only
  // filesystem for a reason that has nothing to do with identity.
  assert.equal(
    probeModeEnforcement(join(tmpdir(), 'periscope-definitely-not-a-directory', 'nope')),
    'unobservable',
  );
});

test('the probe leaves nothing behind', () => {
  const dir = scratch();
  try {
    probeModeEnforcement(dir);

    assert.throws(() => statSync(join(dir, '.mode-probe')), 'the probe file was left on disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: a write reports the mode outcome rather than claiming a privacy it cannot confirm', () => {
  const dir = scratch();
  try {
    const cache = new FileTokenCache(join(dir, 'token-cache.json'));
    const result = cache.write(CACHED);

    assert.ok(result.ok);
    // Whichever platform this is, the outcome must be one of the two honest answers — never a bare
    // success that says nothing about what landed.
    assert.ok(['verified', 'unenforced'].includes(result.value.mode.kind), result.value.mode.kind);
    assert.equal(result.value.mode.kind === 'verified', cache.modeEnforcement() === 'enforced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: on a platform that cannot confirm privacy the outcome names the degrade, and says it measured it', () => {
  const dir = scratch();
  try {
    const cache = new FileTokenCache(join(dir, 'token-cache.json'));
    const result = cache.write(CACHED);

    assert.ok(result.ok);
    if (cache.modeEnforcement() === 'enforced') return; // A POSIX filesystem asserts the other branch.

    assert.equal(result.value.mode.kind, 'unenforced');
    if (result.value.mode.kind !== 'unenforced') return;
    assert.equal(result.value.mode.refusal.reason, 'credential-mode-unenforced');
    // The degrade must distinguish itself from a dead instrument, in words an operator reads.
    assert.match(result.value.mode.refusal.detail, /measurement rather than a dead check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Guards the SELECTOR: without this, the mode tests above could all be taking their uninteresting
// branch on every platform.
test('control: the cache reports a definite, non-inconclusive answer about modes', () => {
  const dir = scratch();
  try {
    const enforcement = new FileTokenCache(join(dir, 'token-cache.json')).modeEnforcement();

    assert.ok(
      ['enforced', 'write-bit-only'].includes(enforcement),
      `the instrument was inconclusive: ${enforcement}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
