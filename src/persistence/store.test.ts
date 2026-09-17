import test from 'node:test';
import assert from 'node:assert/strict';

import type { StoreEffects } from './store.js';
import { createJsonlStore } from './store.js';
import type { TranscriptKey } from './key.js';

const KEY: TranscriptKey = { projectKey: 'tenant-a', sessionId: 'sess-1' };

/** An in-memory stand-in for the disk. The rules under test are which record gets what, not fs. */
function fakeEffects(): StoreEffects & { records: Map<string, string>; appendCalls: number } {
  const records = new Map<string, string>();
  const self = {
    records,
    appendCalls: 0,
    async appendTo(token: string, text: string): Promise<void> {
      self.appendCalls += 1;
      records.set(token, (records.get(token) ?? '') + text);
    },
    async readAll(token: string): Promise<string | null> {
      return records.get(token) ?? null;
    },
    async list(projectKey: string) {
      return [...records.keys()]
        .filter((token) => token.startsWith(`${encodeURIComponent(projectKey)}/`))
        .map((token) => ({ token, sessionId: decodeURIComponent(token.split('/')[1] ?? ''), mtime: 1 }));
    },
    async remove(token: string): Promise<void> {
      records.delete(token);
    },
    async subkeys(): Promise<readonly string[]> {
      return [];
    },
  };
  return self;
}

test('an appended batch reads back as the entries that went in', async () => {
  const store = createJsonlStore(fakeEffects());
  await store.append(KEY, [
    { type: 'user', uuid: 'u-1' },
    { type: 'assistant', uuid: 'a-1' },
  ]);

  const loaded = await store.load(KEY);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.ok && loaded.value, [
    { type: 'user', uuid: 'u-1' },
    { type: 'assistant', uuid: 'a-1' },
  ]);
});

test('regression: a transcript that was never written reads as null, not as an empty transcript', () => {
  // A resume reading an empty list would start a session claiming it had checked and found no
  // history — which is a different and worse thing than knowing nothing was ever stored.
  return createJsonlStore(fakeEffects())
    .load(KEY)
    .then((loaded) => {
      assert.equal(loaded.ok, true);
      assert.equal(loaded.ok && loaded.value, null);
    });
});

test('two batches accumulate in order rather than replacing each other', async () => {
  const store = createJsonlStore(fakeEffects());
  await store.append(KEY, [{ type: 'user', uuid: 'u-1' }]);
  await store.append(KEY, [{ type: 'user', uuid: 'u-2' }]);

  const loaded = await store.load(KEY);
  assert.deepEqual(loaded.ok && loaded.value?.map((one) => one.uuid), ['u-1', 'u-2']);
});

test('regression: a replayed batch does not duplicate the transcript', async () => {
  const store = createJsonlStore(fakeEffects());
  const batch = [{ type: 'user', uuid: 'u-1' }];
  await store.append(KEY, batch);
  await store.append(KEY, batch);

  const loaded = await store.load(KEY);
  assert.equal(loaded.ok && loaded.value?.length, 1);
});

test('a fully-duplicate batch does not even reach the writer', async () => {
  const effects = fakeEffects();
  const store = createJsonlStore(effects);
  await store.append(KEY, [{ type: 'user', uuid: 'u-1' }]);
  const callsAfterFirst = effects.appendCalls;
  await store.append(KEY, [{ type: 'user', uuid: 'u-1' }]);
  assert.equal(effects.appendCalls, callsAfterFirst, 'nothing to write means no write');
});

test('an empty batch is a no-op that succeeds', async () => {
  const effects = fakeEffects();
  const result = await createJsonlStore(effects).append(KEY, []);
  assert.equal(result.ok, true);
  assert.equal(effects.appendCalls, 0);
});

test('deduplication can be turned off, and then a replay does land twice', async () => {
  const store = createJsonlStore(fakeEffects(), { dedupeOnAppend: false });
  const batch = [{ type: 'user', uuid: 'u-1' }];
  await store.append(KEY, batch);
  await store.append(KEY, batch);

  const loaded = await store.load(KEY);
  assert.equal(loaded.ok && loaded.value?.length, 2, 'the named cost of turning it off');
});

test('regression: a main transcript and a subagent of the same session are separate records', async () => {
  const store = createJsonlStore(fakeEffects());
  await store.append(KEY, [{ type: 'user', uuid: 'main-1' }]);
  await store.append({ ...KEY, subpath: 'subagents/agent-7' }, [{ type: 'user', uuid: 'sub-1' }]);

  const main = await store.load(KEY);
  const sub = await store.load({ ...KEY, subpath: 'subagents/agent-7' });
  assert.deepEqual(main.ok && main.value?.map((one) => one.uuid), ['main-1']);
  assert.deepEqual(sub.ok && sub.value?.map((one) => one.uuid), ['sub-1']);
});

test('two sessions in one project do not share a record', async () => {
  const store = createJsonlStore(fakeEffects());
  await store.append(KEY, [{ type: 'user', uuid: 'one' }]);
  await store.append({ ...KEY, sessionId: 'sess-2' }, [{ type: 'user', uuid: 'two' }]);

  const first = await store.load(KEY);
  assert.deepEqual(first.ok && first.value?.map((one) => one.uuid), ['one']);
});

test('a write failure is a named refusal, never an exception escaping the store', async () => {
  const effects = fakeEffects();
  effects.appendTo = async () => {
    throw new Error('disk full');
  };
  const result = await createJsonlStore(effects).append(KEY, [{ type: 'user', uuid: 'u-1' }]);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.reason, 'transcript-write-failed');
  assert.match((!result.ok && result.refusal.detail) || '', /disk full/);
});

test('a read failure is a named refusal', async () => {
  const effects = fakeEffects();
  effects.readAll = async () => {
    throw new Error('permission denied');
  };
  const result = await createJsonlStore(effects).load(KEY);
  assert.equal(!result.ok && result.refusal.reason, 'transcript-read-failed');
});

test('regression: a corrupt stored line refuses the load rather than returning the readable part', async () => {
  const effects = fakeEffects();
  effects.records.set('tenant-a/sess-1', '{"type":"user","uuid":"u-1"}\nwreckage\n');
  const result = await createJsonlStore(effects).load(KEY);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.reason, 'transcript-entry-malformed');
  assert.match((!result.ok && result.refusal.detail) || '', /line 2/);
});

test('listSessions reports the sessions stored under a project', async () => {
  const store = createJsonlStore(fakeEffects());
  await store.append(KEY, [{ type: 'user', uuid: 'u-1' }]);
  await store.append({ ...KEY, sessionId: 'sess-2' }, [{ type: 'user', uuid: 'u-2' }]);

  const listed = await store.listSessions?.('tenant-a');
  assert.equal(listed?.ok, true);
  assert.deepEqual(listed?.ok && listed.value.map((one) => one.sessionId).sort(), ['sess-1', 'sess-2']);
});

test('delete removes a transcript, and loading it afterwards reads as never written', async () => {
  const store = createJsonlStore(fakeEffects());
  await store.append(KEY, [{ type: 'user', uuid: 'u-1' }]);
  await store.delete?.(KEY);

  const loaded = await store.load(KEY);
  assert.equal(loaded.ok && loaded.value, null);
});

test('deleting a transcript that is not there succeeds', async () => {
  const result = await createJsonlStore(fakeEffects()).delete?.(KEY);
  assert.equal(result?.ok, true);
});

test('a store with no summary side-file is a complete store — the method is optional by contract', () => {
  const store = createJsonlStore(fakeEffects());
  assert.equal('listSessionSummaries' in store, false, 'declined deliberately; see this module header');
  assert.equal(typeof store.append, 'function');
  assert.equal(typeof store.load, 'function');
});
