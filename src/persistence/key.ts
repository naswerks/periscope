/**
 * Which transcript — the address of one session's stored entries.
 *
 * This is this package's own type, not the SDK's, and the duplication is deliberate. The store
 * adapter's key is an SDK type, and `src/host/` is the only directory allowed to name the SDK
 * (pinned by pins/sdk-confinement.test.ts). Everything worth testing about a key — what is refused,
 * how a subagent's transcript is addressed, how one becomes a storage path — is pure logic, so it
 * lives here and `host/session-store.ts` bridges the two shapes. The same split the workspace
 * providers and the path jail already use.
 *
 * The three fields are structurally the adapter contract's, and that is the point: bridging is a
 * field-for-field copy with nothing to get wrong, and a shape change on either side is a compile
 * error in one file rather than a silent mismatch.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';

/**
 * One transcript, addressed.
 *
 * `subpath` absent and `subpath` empty are different things, and conflating them reads the wrong
 * transcript. Absent means the session's main transcript; a subagent's is addressed by a subpath
 * that mirrors the on-disk directory. An empty string is neither — the adapter contract calls it
 * invalid and says to omit the field — so an empty one is refused rather than normalised away. A
 * normaliser here would answer a question about a subagent with the main transcript's contents,
 * which is a wrong answer wearing a right answer's shape.
 */
export interface TranscriptKey {
  /** The caller's scope — a tenant, a project. Never derived here; the embedder decides. */
  readonly projectKey: string;
  readonly sessionId: string;
  /** Absent = the main transcript. Present = a subagent's. Opaque: never parsed. */
  readonly subpath?: string;
}

/** Build a key, or say which part was unusable. */
export function transcriptKey(
  projectKey: string,
  sessionId: string,
  subpath?: string,
): Result<TranscriptKey> {
  if (projectKey.length === 0) {
    return refuse<TranscriptKey>('transcript-key-invalid', 'projectKey is empty');
  }
  if (sessionId.length === 0) {
    return refuse<TranscriptKey>('transcript-key-invalid', 'sessionId is empty');
  }
  if (subpath !== undefined && subpath.length === 0) {
    return refuse<TranscriptKey>(
      'transcript-key-invalid',
      'subpath is present and empty — omit the field for the main transcript',
    );
  }
  return ok(subpath === undefined ? { projectKey, sessionId } : { projectKey, sessionId, subpath });
}

/** Whether two keys address the same transcript. */
export function sameTranscript(left: TranscriptKey, right: TranscriptKey): boolean {
  return (
    left.projectKey === right.projectKey &&
    left.sessionId === right.sessionId &&
    (left.subpath ?? null) === (right.subpath ?? null)
  );
}

/**
 * A stable, comparable string for one key. For map keys and log lines — never parsed back.
 *
 * It is not a filesystem path and must not be used as one. A projectKey is caller-supplied and can
 * carry anything, including separators; turning that into a path is how a key climbs out of its
 * directory. `host/transcript-fs.ts` derives real paths through the same jail every other host-side
 * path goes through, and this exists only so two keys can be compared or logged as one token.
 */
export function transcriptToken(key: TranscriptKey): string {
  const main = `${encodeURIComponent(key.projectKey)}/${encodeURIComponent(key.sessionId)}`;
  return key.subpath === undefined ? main : `${main}/${encodeURIComponent(key.subpath)}`;
}
