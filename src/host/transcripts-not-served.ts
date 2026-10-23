/**
 * The names a transcript reader exported, each inert: this host does not look for, read or keep the
 * agent's transcript files (`<agent home>/projects`).
 *
 * Nothing here touches the filesystem. A reader answers what a host with no transcripts answers: the
 * listing is empty, and every resolution and probe refuses `transcripts-not-served`, the reason the
 * host itself answers a `transcript_list`, a `transcript_tail` and a `claude-transcript:` bulk locator
 * with. The two path helpers still derive a path, since deriving one reads nothing.
 *
 * Kept so an import still resolves; every name here goes at the next major version.
 */
import type { Result } from '../core/result.js';
import { refuse } from '../core/result.js';
import { defaultAgentHome, join } from './paths.js';

/** Why each reader here refuses: the host's own answer to a transcript ask. */
const NOT_SERVED = 'this host does not look for, read or keep the agent transcript files';

/**
 * One transcript on disk, as a reader described it. Nothing in this package produces one.
 *
 * @deprecated This host serves no transcripts. Kept so an import still resolves; it goes at the next
 * major version.
 */
export interface DiscoveredTranscript {
  readonly projectSlug: string;
  readonly sessionId: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly cwd: string | null;
}

/**
 * One page of a transcript listing. `listTranscripts` answers the empty one.
 *
 * @deprecated This host serves no transcripts. Kept so an import still resolves; it goes at the next
 * major version.
 */
export interface TranscriptPage {
  readonly entries: readonly DiscoveredTranscript[];
  readonly totalCount: number;
  readonly nextIndex: number | null;
}

/**
 * What a tail probe answered. Nothing in this package produces one.
 *
 * @deprecated This host serves no transcripts. Kept so an import still resolves; it goes at the next
 * major version.
 */
export interface TranscriptTailAnswer {
  readonly absent: boolean;
  readonly found: boolean;
  readonly newOffset: number;
  readonly sizeBytes: number | null;
  readonly mtimeMs: number | null;
}

/**
 * Where the agent CLI keeps transcripts under its home. A path, derived; nothing is read.
 *
 * @deprecated This host serves no transcripts. Kept so an import still resolves; it goes at the next
 * major version.
 */
export function transcriptsRootUnder(agentHome: string): string {
  return join(agentHome, 'projects');
}

/**
 * The transcripts directory under the default agent home, or null when there is no home. A path,
 * derived; nothing is read.
 *
 * @deprecated This host serves no transcripts. Kept so an import still resolves; it goes at the next
 * major version.
 */
export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = defaultAgentHome(env);
  return home === null ? null : transcriptsRootUnder(home);
}

/**
 * Always refuses `transcripts-not-served`.
 *
 * @deprecated This host serves no transcripts. Kept so an import still resolves; it goes at the next
 * major version.
 */
export function resolveTranscriptPath(root: string, projectSlug: string, sessionId: string): Result<string> {
  void root;
  void projectSlug;
  void sessionId;
  return refuse('transcripts-not-served', NOT_SERVED);
}

/**
 * Always the empty page: nothing is listed, and no directory is read.
 *
 * @deprecated This host serves no transcripts. Kept so an import still resolves; it goes at the next
 * major version.
 */
export function listTranscripts(
  root: string,
  page: { fromIndex?: number; pageSize?: number } = {},
): Promise<TranscriptPage> {
  void root;
  void page;
  return Promise.resolve({ entries: [], totalCount: 0, nextIndex: null });
}

/**
 * Always refuses `transcripts-not-served`; no file is read.
 *
 * @deprecated This host serves no transcripts. Kept so an import still resolves; it goes at the next
 * major version.
 */
export function tailTranscript(
  root: string,
  projectSlug: string,
  sessionId: string,
  probe: { fromOffset?: number; needle?: string | null } = {},
): Promise<Result<TranscriptTailAnswer>> {
  void root;
  void projectSlug;
  void sessionId;
  void probe;
  return Promise.resolve(refuse<TranscriptTailAnswer>('transcripts-not-served', NOT_SERVED));
}

/**
 * A bulk resolver that refuses every locator `transcripts-not-served`.
 *
 * @deprecated This host serves no transcripts. Compose a resolver of your own for the content your
 * controller asks for. Kept so an import still resolves; it goes at the next major version.
 */
export function claudeTranscriptResolver(root: string): (what: string, sessionKey: string) => Result<string> {
  void root;
  return (): Result<string> => refuse('transcripts-not-served', NOT_SERVED);
}

/**
 * Always false: no transcript line is read.
 *
 * @deprecated This host serves no transcripts. Kept so an import still resolves; it goes at the next
 * major version.
 */
export function isMatchingUserEntry(line: string, needle: string | null): boolean {
  void line;
  void needle;
  return false;
}
