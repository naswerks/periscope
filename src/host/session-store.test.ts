import test from 'node:test';
import assert from 'node:assert/strict';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { asSessionStore, readMirrorDrop, toSessionKey, toTranscriptKey } from './session-store.js';
import { createJsonlStore } from '../persistence/store.js';
import type { StoreEffects } from '../persistence/store.js';
import type { TranscriptStore } from '../persistence/store.js';
import { refuse } from '../core/result.js';

function memoryEffects(): StoreEffects {
  const records = new Map<string, string>();
  return {
    async appendTo(token, text) {
      records.set(token, (records.get(token) ?? '') + text);
    },
    async readAll(token) {
      return records.get(token) ?? null;
    },
    async list() {
      return [];
    },
    async remove(token) {
      records.delete(token);
    },
    async subkeys() {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// the key bridge — a field-for-field copy with nothing to get wrong
// ---------------------------------------------------------------------------

test('a main-transcript key round-trips both ways with no subpath', () => {
  const ours = toTranscriptKey({ projectKey: 't', sessionId: 's' });
  assert.deepEqual(ours, { projectKey: 't', sessionId: 's' });
  assert.equal(Object.prototype.hasOwnProperty.call(ours, 'subpath'), false);
  assert.deepEqual(toSessionKey(ours), { projectKey: 't', sessionId: 's' });
});

test("a subagent's key carries its subpath both ways", () => {
  const ours = toTranscriptKey({ projectKey: 't', sessionId: 's', subpath: 'subagents/agent-7' });
  assert.equal(ours.subpath, 'subagents/agent-7');
  assert.equal(toSessionKey(ours).subpath, 'subagents/agent-7');
});

test('regression: an absent subpath stays absent rather than becoming an explicit undefined', () => {
  // The contract distinguishes an omitted subpath from a present one, so a bridge that materialised
  // the key would change which transcript is addressed.
  assert.equal('subpath' in toSessionKey({ projectKey: 't', sessionId: 's' }), false);
});

// ---------------------------------------------------------------------------
// the adapter — and the deliberate re-throw
// ---------------------------------------------------------------------------

test('the adapter presents append and load, and they reach the store underneath', async () => {
  const adapter = asSessionStore(createJsonlStore(memoryEffects()));
  await adapter.append({ projectKey: 't', sessionId: 's' }, [{ type: 'user', uuid: 'u-1' }]);

  const loaded = await adapter.load({ projectKey: 't', sessionId: 's' });
  assert.deepEqual(
    loaded?.map((one) => one.uuid),
    ['u-1'],
  );
});

test('regression: a transcript never written loads as null through the adapter, not as an empty array', async () => {
  const adapter = asSessionStore(createJsonlStore(memoryEffects()));
  assert.equal(await adapter.load({ projectKey: 't', sessionId: 'nobody' }), null);
});

test('regression: a refusal from the store throws at the adapter; returning would claim the batch is durable', async () => {
  // The adapter contract treats a normal return as success and a rejection as retryable. Swallowing
  // a refusal here would tell the SDK a batch landed that did not, which is silent data loss.
  const failing: TranscriptStore = {
    async append() {
      return refuse<void>('transcript-write-failed', 'disk full');
    },
    async load() {
      return refuse<null>('transcript-read-failed', 'unreadable');
    },
  };
  const adapter = asSessionStore(failing);

  await assert.rejects(
    () => adapter.append({ projectKey: 't', sessionId: 's' }, [{ type: 'user', uuid: 'u-1' }]),
    /transcript-write-failed.*disk full/,
  );
  await assert.rejects(() => adapter.load({ projectKey: 't', sessionId: 's' }), /transcript-read-failed/);
});

test('optional members are present only when the store underneath has them', () => {
  const minimal: TranscriptStore = {
    async append() {
      return { ok: true, value: undefined };
    },
    async load() {
      return { ok: true, value: null };
    },
  };
  const adapter = asSessionStore(minimal);
  // The presence of the optional members is the assertion; nothing is called, so the unbound read is the point.
  /* eslint-disable @typescript-eslint/unbound-method */
  assert.equal(adapter.delete, undefined, 'absent means deletion is a no-op, per the contract');
  assert.equal(adapter.listSessions, undefined);
  assert.equal(adapter.listSubkeys, undefined);
  /* eslint-enable @typescript-eslint/unbound-method */
});

test('a store that CAN enumerate exposes the optional members', () => {
  const adapter = asSessionStore(createJsonlStore(memoryEffects()));
  assert.equal(typeof adapter.listSessions, 'function');
  assert.equal(typeof adapter.delete, 'function');
  assert.equal(typeof adapter.listSubkeys, 'function');
});

test('regression: listSessionSummaries is never presented; declined deliberately, and the contract allows it', () => {
  const adapter = asSessionStore(createJsonlStore(memoryEffects()));
  // eslint-disable-next-line @typescript-eslint/unbound-method -- the member's absence is the assertion
  assert.equal(adapter.listSessionSummaries, undefined);
});

// ---------------------------------------------------------------------------
// the dropped batch surfaces
// ---------------------------------------------------------------------------

const mirrorError = (error: string): SDKMessage =>
  ({
    type: 'system',
    subtype: 'mirror_error',
    error,
    key: { projectKey: 'tenant-a', sessionId: 'sess-1' },
    uuid: 'm-1',
    session_id: 'sess-1',
  }) as unknown as SDKMessage;

test('regression: a dropped batch is lifted off the stream as a named degrade, never ignored', () => {
  const drop = readMirrorDrop(mirrorError('the store returned HTTP 503'));
  assert.notEqual(drop, null, 'silence here is indistinguishable from health');
  assert.equal(drop?.error, 'the store returned HTTP 503');
});

test('regression: the drop names which session lost entries', () => {
  const drop = readMirrorDrop(mirrorError('boom'));
  assert.deepEqual(drop?.key, { projectKey: 'tenant-a', sessionId: 'sess-1' });
});

test("regression: a subagent's dropped batch keeps its subpath", () => {
  const message = {
    type: 'system',
    subtype: 'mirror_error',
    error: 'boom',
    key: { projectKey: 't', sessionId: 's', subpath: 'subagents/agent-7' },
    uuid: 'm-1',
    session_id: 's',
  } as unknown as SDKMessage;
  assert.equal(readMirrorDrop(message)?.key.subpath, 'subagents/agent-7');
});

test('regression: a timeout drop reports one attempt, because a timeout is not retried', () => {
  for (const text of ['request timed out', 'ETIMEDOUT', 'store timeout after 60s', 'timed-out']) {
    const drop = readMirrorDrop(mirrorError(text));
    assert.equal(drop?.kind, 'timed-out', `${text} reads as a timeout`);
    assert.equal(drop?.attempts, 1, 'reporting three would imply a retry that never ran');
  }
});

test('regression: a rejection drop reports three attempts', () => {
  const drop = readMirrorDrop(mirrorError('HTTP 503 Service Unavailable'));
  assert.equal(drop?.kind, 'rejected');
  assert.equal(drop?.attempts, 3);
});

test('every other message reads as no drop — the detector does not fire on ordinary traffic', () => {
  const ordinary: SDKMessage[] = [
    { type: 'user' } as unknown as SDKMessage,
    { type: 'assistant' } as unknown as SDKMessage,
    { type: 'system', subtype: 'init' } as unknown as SDKMessage,
    { type: 'system', subtype: 'compact_boundary' } as unknown as SDKMessage,
    { type: 'result' } as unknown as SDKMessage,
  ];
  for (const message of ordinary) assert.equal(readMirrorDrop(message), null);
});
