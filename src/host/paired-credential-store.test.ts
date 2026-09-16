/**
 * The paired credential's file half, against a real temp directory — the same substrate discipline
 * as `token-cache.test.ts`: no fs mocking, because the store's whole job is what a disk actually
 * does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilePairedCredential } from './paired-credential-store.js';

function scratch(): { path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'periscope-paired-'));
  return {
    path: join(dir, 'paired-credential.json'),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('a written credential reads back intact', () => {
  const { path, done } = scratch();
  try {
    const store = new FilePairedCredential(path);
    const written = store.write({ hostId: 'ph-abc', credential: 'p1.ph-abc.s3cret' });
    assert.ok(written.ok, written.ok ? '' : written.refusal.detail);

    const read = store.read();
    assert.ok(read.ok, read.ok ? '' : read.refusal.detail);
    assert.deepEqual(read.value, { hostId: 'ph-abc', credential: 'p1.ph-abc.s3cret' });
  } finally {
    done();
  }
});

test('regression: a missing file is token-unavailable, the normal unpaired state, never an error', () => {
  // The composition root branches on exactly this reason: missing falls through to the OIDC
  // postures, anything else is fatal. Collapsing the two would make every unpaired host refuse
  // to start, or every corrupt file silently degrade to a maybe-dead refresh token.
  const { path, done } = scratch();
  try {
    const read = new FilePairedCredential(path).read();
    assert.equal(read.ok, false);
    if (!read.ok) assert.equal(read.refusal.reason, 'token-unavailable');
  } finally {
    done();
  }
});

test('a file that exists and is not JSON is credential-cache-unreadable, with the fix in the detail', () => {
  const { path, done } = scratch();
  try {
    writeFileSync(path, 'not json at all');
    const read = new FilePairedCredential(path).read();
    assert.equal(read.ok, false);
    if (!read.ok) {
      assert.equal(read.refusal.reason, 'credential-cache-unreadable');
      assert.match(read.refusal.detail, /periscope pair/);
    }
  } finally {
    done();
  }
});

test('a re-pair overwrites in place, and clear is idempotent', () => {
  const { path, done } = scratch();
  try {
    const store = new FilePairedCredential(path);
    assert.ok(store.write({ hostId: 'ph-old', credential: 'p1.ph-old.s1' }).ok);
    assert.ok(store.write({ hostId: 'ph-new', credential: 'p1.ph-new.s2' }).ok);

    const read = store.read();
    assert.ok(read.ok);
    assert.equal(read.value.hostId, 'ph-new', 'the newer pairing wins — re-pairing is the remedy path');

    store.clear();
    store.clear(); // clearing what is not there is success, not an error
    const after = store.read();
    assert.equal(after.ok, false);
    if (!after.ok) assert.equal(after.refusal.reason, 'token-unavailable');
  } finally {
    done();
  }
});
