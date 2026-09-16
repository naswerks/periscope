/**
 * The store adapter seam: where this package's transcript store becomes the SDK's `SessionStore`.
 *
 * It lives in `src/host/` because it names `@anthropic-ai/claude-agent-sdk`, which is confined here
 * exactly like `node:fs` is. Everything above works in the package's own vocabulary; the bridge is
 * a field-for-field copy in one file, so a shape change on either side is a compile error here
 * rather than a silent mismatch anywhere else.
 *
 * The adapter is an interface this package implements, not an API it calls, and that is why
 * standing on an `@alpha` surface is acceptable here. If the shape moves, `satisfies` stops
 * holding and the build breaks, loudly, before anything ships. An alpha surface that is called
 * fails the other way: it keeps compiling and behaves differently in production. The version is
 * pinned exactly, and pins/sdk-confinement.test.ts asserts that the pin has no range.
 *
 * The SDK's errors are exceptions and this package's are refusals, so the bridge converts. The
 * adapter contract says a rejection is retried and a timeout is not, which means throwing is how an
 * adapter reports a failure it wants retried; returning normally would tell the SDK the batch
 * landed. So a refusal from the store is re-thrown here deliberately: it is the only way to refuse
 * in the adapter's own vocabulary, and swallowing it would silently accept data loss.
 */
import type { SDKMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';

import type { TranscriptKey } from '../persistence/key.js';
import type { MirrorDrop } from '../persistence/mirror.js';
import type { TranscriptStore } from '../persistence/store.js';

export type { SessionKey, SessionStore, SessionStoreEntry };

/** The SDK's key, in this package's vocabulary. A copy: the two types may not meet above this file. */
export function toTranscriptKey(key: SessionKey): TranscriptKey {
  return key.subpath === undefined
    ? { projectKey: key.projectKey, sessionId: key.sessionId }
    : { projectKey: key.projectKey, sessionId: key.sessionId, subpath: key.subpath };
}

/** This package's key, as the SDK's. */
export function toSessionKey(key: TranscriptKey): SessionKey {
  return key.subpath === undefined
    ? { projectKey: key.projectKey, sessionId: key.sessionId }
    : { projectKey: key.projectKey, sessionId: key.sessionId, subpath: key.subpath };
}

/**
 * Present a `TranscriptStore` to the SDK as a `SessionStore`.
 *
 * `listSessionSummaries` is not implemented, deliberately; see persistence/store.ts for the three
 * reasons. The adapter contract marks it optional and states the fallback in as many words, so its
 * absence is a supported posture rather than a missing feature.
 */
export function asSessionStore(store: TranscriptStore): SessionStore {
  const adapter: SessionStore = {
    async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      const result = await store.append(toTranscriptKey(key), entries);
      if (!result.ok) {
        // Thrown, not swallowed: a normal return tells the SDK the batch is durable. See the header.
        throw new Error(`${result.refusal.reason}: ${result.refusal.detail}`);
      }
    },

    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const result = await store.load(toTranscriptKey(key));
      if (!result.ok) throw new Error(`${result.refusal.reason}: ${result.refusal.detail}`);
      return result.value === null ? null : result.value;
    },
  };

  if (store.listSessions !== undefined) {
    adapter.listSessions = async (projectKey: string) => {
      const result = await store.listSessions?.(projectKey);
      if (result === undefined || !result.ok) {
        throw new Error(result === undefined ? 'listSessions is unavailable' : result.refusal.detail);
      }
      return result.value.map((one) => ({ sessionId: one.sessionId, mtime: one.mtime }));
    };
  }

  if (store.delete !== undefined) {
    adapter.delete = async (key: SessionKey) => {
      const result = await store.delete?.(toTranscriptKey(key));
      if (result !== undefined && !result.ok) throw new Error(result.refusal.detail);
    };
  }

  if (store.listSubkeys !== undefined) {
    adapter.listSubkeys = async (key: { projectKey: string; sessionId: string }) => {
      const result = await store.listSubkeys?.({ projectKey: key.projectKey, sessionId: key.sessionId });
      if (result === undefined || !result.ok) {
        throw new Error(result === undefined ? 'listSubkeys is unavailable' : result.refusal.detail);
      }
      return result.value;
    };
  }

  return adapter;
}

/**
 * A dropped mirror batch, lifted off the message stream: the one failure that is otherwise
 * indistinguishable from nothing having happened.
 *
 * The store simply ends up with fewer entries than local disk: no error at the read, no gap anything
 * can compute, and the durable copy silently behind local truth. The SDK reports it as a system
 * message and this is what turns that into a named degrade a caller must handle. A host that only
 * forwarded the message lane would drop it on the floor.
 *
 * The message does not carry the lost entries or how many attempts ran, so those are what this
 * host knows rather than what it was told: attempts come from the contract's own stated policy, and
 * the uuids are empty unless a caller correlates the batch itself. Reporting an attempt count the
 * message did not carry would be inventing detail, so the kind is what decides it.
 */
export function readMirrorDrop(message: SDKMessage): MirrorDrop | null {
  if (message.type !== 'system' || message.subtype !== 'mirror_error') return null;
  const kind = looksLikeTimeout(message.error) ? 'timed-out' : 'rejected';
  return {
    key: toTranscriptKey(message.key),
    kind,
    attempts: kind === 'timed-out' ? 1 : 3,
    error: message.error,
    entryUuids: [],
  };
}

/**
 * Whether the store's error text describes a timeout.
 *
 * A text match, and said out loud because it is the weak part. The message carries the failure as
 * a string with no discriminant, so the two drop paths (retried three times, versus not retried at
 * all) cannot be told apart structurally. Guessing wrong misreports the attempt count and nothing
 * else; the drop itself is reported either way, which is the property that matters.
 */
function looksLikeTimeout(error: string): boolean {
  return /timed?[\s-]?out|timeout|etimedout/i.test(error);
}
