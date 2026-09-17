/**
 * The local JSONL mirror, on a real disk.
 *
 * "It survives local pruning and is readable from the store" is a claim only a real file can
 * settle. The unit tests over recorded effects prove which key becomes which record; they cannot
 * prove that a transcript written by one process and read after the source is gone still reads back.
 * This file deletes the thing it wrote from and reads the store afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeStoreEffects } from './transcript-fs.js';
import { createJsonlStore } from '../persistence/store.js';
import { baselineAnchor, resolveReceipt } from '../persistence/receipt.js';
import type { TranscriptKey } from '../persistence/key.js';

const scratch = (): Promise<string> => mkdtemp(join(tmpdir(), 'periscope-transcript-'));
const KEY: TranscriptKey = { projectKey: 'tenant-a', sessionId: 'sess-1' };

test('a batch written through the real effects reads back from a real file', async () => {
  const store = createJsonlStore(nodeStoreEffects(await scratch()));
  await store.append(KEY, [
    { type: 'user', uuid: 'u-1' },
    { type: 'assistant', uuid: 'a-1' },
  ]);

  const loaded = await store.load(KEY);
  assert.deepEqual(loaded.ok && loaded.value?.map((one) => one.uuid), ['u-1', 'a-1']);
});

test('regression: a transcript survives the local source being pruned, and is still readable', async () => {
  // The store's whole reason for existing: local disk is swept on its own schedule, and what the
  // host governs must outlive that. Two roots, so the deletion is real rather than notional.
  const localRoot = await scratch();
  const storeRoot = await scratch();

  const local = createJsonlStore(nodeStoreEffects(localRoot));
  const durable = createJsonlStore(nodeStoreEffects(storeRoot));

  const entries = [
    { type: 'user', uuid: 'u-1', timestamp: '2026-08-04T10:00:00Z' },
    { type: 'assistant', uuid: 'a-1', timestamp: '2026-08-04T10:00:01Z' },
  ];
  await local.append(KEY, entries);
  await durable.append(KEY, entries);

  // The local copy is swept, as `cleanupPeriodDays` eventually does.
  await rm(localRoot, { recursive: true, force: true });

  const gone = await local.load(KEY);
  assert.equal(gone.ok && gone.value, null, 'the local copy really is gone');

  const survived = await durable.load(KEY);
  assert.equal(survived.ok, true);
  assert.deepEqual(survived.ok && survived.value?.map((one) => one.uuid), ['u-1', 'a-1']);
});

test('regression: a receipt resolves against a transcript read back off a real disk', async () => {
  // The whole path end to end: entries stored, the process forgets everything, the receipt is
  // answered from what is on disk. Nothing in this test holds the entries in memory.
  const store = createJsonlStore(nodeStoreEffects(await scratch()));
  await store.append(KEY, [
    { type: 'user', uuid: 'u-1', timestamp: '2026-08-04T10:00:00Z' },
    { type: 'assistant', uuid: 'a-1', timestamp: '2026-08-04T10:00:01Z' },
  ]);

  const first = await store.load(KEY);
  const anchor = baselineAnchor((first.ok && first.value) || []);
  assert.equal(anchor, 'a-1');

  await store.append(KEY, [
    { type: 'system', subtype: 'compact_boundary', uuid: 'cb-1', compact_metadata: { trigger: 'auto' } },
    { type: 'user', uuid: 'cs-1', isCompactSummary: true },
    { type: 'user', uuid: 'u-2', message: { role: 'user', content: 'do the thing' } },
  ]);

  const after = await store.load(KEY);
  const outcome = resolveReceipt((after.ok && after.value) || [], {
    anchorUuid: anchor,
    expectText: 'do the thing',
  });
  assert.equal(outcome.ok && outcome.value.delivered, true);
  assert.equal(outcome.ok && outcome.value.entryUuid, 'u-2');
  assert.equal(outcome.ok && outcome.value.crossedCompaction, true);
});

test('a transcript that was never written reads as null from a real directory', async () => {
  const store = createJsonlStore(nodeStoreEffects(await scratch()));
  const loaded = await store.load(KEY);
  assert.equal(loaded.ok && loaded.value, null);
});

test('appends accumulate across separate store instances over the same root', async () => {
  // The durability that matters: a host restarts and keeps writing to the same transcript.
  const root = await scratch();
  await createJsonlStore(nodeStoreEffects(root)).append(KEY, [{ type: 'user', uuid: 'u-1' }]);
  await createJsonlStore(nodeStoreEffects(root)).append(KEY, [{ type: 'user', uuid: 'u-2' }]);

  const loaded = await createJsonlStore(nodeStoreEffects(root)).load(KEY);
  assert.deepEqual(loaded.ok && loaded.value?.map((one) => one.uuid), ['u-1', 'u-2']);
});

test('regression: deduplication holds across restarts; a replay after a restart does not double', async () => {
  const root = await scratch();
  const batch = [{ type: 'user', uuid: 'u-1' }];
  await createJsonlStore(nodeStoreEffects(root)).append(KEY, batch);
  await createJsonlStore(nodeStoreEffects(root)).append(KEY, batch);

  const loaded = await createJsonlStore(nodeStoreEffects(root)).load(KEY);
  assert.equal(loaded.ok && loaded.value?.length, 1, 'the id is in the file, so the new instance sees it');
});

test('regression: two sessions get two files, and neither can see the other', async () => {
  const root = await scratch();
  const store = createJsonlStore(nodeStoreEffects(root));
  await store.append(KEY, [{ type: 'user', uuid: 'mine' }]);
  await store.append({ ...KEY, sessionId: 'sess-2' }, [{ type: 'user', uuid: 'theirs' }]);

  const first = await store.load(KEY);
  assert.deepEqual(first.ok && first.value?.map((one) => one.uuid), ['mine']);

  const names = await readdir(join(root, 'tenant-a'));
  assert.equal(names.length, 2, 'two real files exist — the isolation is not a string comparison');
});

test("a subagent's transcript is a separate record from its session's", async () => {
  const store = createJsonlStore(nodeStoreEffects(await scratch()));
  await store.append(KEY, [{ type: 'user', uuid: 'main' }]);
  await store.append({ ...KEY, subpath: 'subagents/agent-7' }, [{ type: 'user', uuid: 'sub' }]);

  const main = await store.load(KEY);
  const sub = await store.load({ ...KEY, subpath: 'subagents/agent-7' });
  assert.deepEqual(main.ok && main.value?.map((one) => one.uuid), ['main']);
  assert.deepEqual(sub.ok && sub.value?.map((one) => one.uuid), ['sub']);
});

test('listSessions reports what is actually on disk, with a real mtime', async () => {
  const store = createJsonlStore(nodeStoreEffects(await scratch()));
  await store.append(KEY, [{ type: 'user', uuid: 'u-1' }]);
  await store.append({ ...KEY, sessionId: 'sess-2' }, [{ type: 'user', uuid: 'u-2' }]);

  const listed = await store.listSessions?.('tenant-a');
  assert.deepEqual(listed?.ok && listed.value.map((one) => one.sessionId).sort(), ['sess-1', 'sess-2']);
  const mtime = (listed?.ok && listed.value[0]?.mtime) || 0;
  assert.equal(Number.isInteger(mtime), true, 'floored, as the contract asks');
  assert.ok(mtime > 0);
});

test('listing a project that has never been written is empty, not an error', async () => {
  const store = createJsonlStore(nodeStoreEffects(await scratch()));
  const listed = await store.listSessions?.('nobody');
  assert.equal(listed?.ok, true);
  assert.deepEqual(listed?.ok && listed.value, []);
});

test('delete removes the real file', async () => {
  const store = createJsonlStore(nodeStoreEffects(await scratch()));
  await store.append(KEY, [{ type: 'user', uuid: 'u-1' }]);
  await store.delete?.(KEY);
  const loaded = await store.load(KEY);
  assert.equal(loaded.ok && loaded.value, null);
});

test('deleting a transcript that is not on disk succeeds', async () => {
  const result = await createJsonlStore(nodeStoreEffects(await scratch())).delete?.(KEY);
  assert.equal(result?.ok, true);
});

test('regression: a corrupt line on a real disk refuses the load and names the line', async () => {
  const root = await scratch();
  const effects = nodeStoreEffects(root);
  await effects.appendTo('tenant-a/sess-1', '{"type":"user","uuid":"u-1"}\nwreckage\n');

  const loaded = await createJsonlStore(effects).load(KEY);
  assert.equal(loaded.ok, false);
  assert.match((!loaded.ok && loaded.refusal.detail) || '', /line 2/);
});

test('a relative root is refused at construction rather than resolved against the host cwd', () => {
  assert.throws(() => nodeStoreEffects('relative/path'), /absolute/);
});

test('regression: a project key containing separators cannot climb out of the root', async () => {
  // The key is caller-supplied, so this is the one place a store could be talked into writing
  // somewhere else. Escaping happens in the token; containment is checked again in the effects.
  const parent = await scratch();
  const root = join(parent, 'store');
  const store = createJsonlStore(nodeStoreEffects(root));

  const result = await store.append({ projectKey: '../../escaped', sessionId: 'x' }, [
    { type: 'user', uuid: 'u' },
  ]);
  assert.equal(result.ok, true, 'it is written — the point is WHERE');

  // The property is containment, not the absence of the characters. A traversal is defeated by
  // encoding the separator, so the dots legitimately survive as literal data in a directory name;
  // an assertion that no name contains ".." would fail here while nothing had escaped.
  assert.deepEqual(await readdir(parent), ['store'], 'nothing was created beside the root');

  const scoped = await readdir(root);
  assert.equal(scoped.length, 1, 'and the whole key became ONE directory name under it');
  assert.equal(scoped[0]?.includes('/'), false, 'the separator was encoded, which is what stops the climb');

  const loaded = await store.load({ projectKey: '../../escaped', sessionId: 'x' });
  assert.deepEqual(loaded.ok && loaded.value?.map((one) => one.uuid), ['u'], 'and it is still readable');
});

test('subkeys reports a session subagent transcripts, and nothing when there are none', async () => {
  const root = await scratch();
  const effects = nodeStoreEffects(root);
  assert.deepEqual(await effects.subkeys('tenant-a', 'sess-1'), []);

  await effects.appendTo('tenant-a/sess-1/subagents%2Fagent-7', '{"type":"user","uuid":"s-1"}\n');
  assert.deepEqual(await effects.subkeys('tenant-a', 'sess-1'), ['subagents/agent-7']);
});

test('a non-jsonl file beside a transcript is ignored by the listing', async () => {
  const root = await scratch();
  const effects = nodeStoreEffects(root);
  await effects.appendTo('tenant-a/sess-1', '{"type":"user","uuid":"u-1"}\n');
  await writeFile(join(root, 'tenant-a', 'notes.txt'), 'not a transcript', 'utf8');

  const listed = await effects.list('tenant-a');
  assert.equal(listed.length, 1);
});
