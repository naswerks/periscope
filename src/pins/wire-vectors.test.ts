/**
 * THE WIRE-VECTOR PIN: the bytes the codec writes and reads, held as a corpus on disk.
 *
 * `contracts/wire-vectors/*.json` is one file per case, language-neutral: a frame, the exact
 * `encode()` output for it, and what `decode()` answers. A controller written in another language
 * checks itself against the same files. Here, every file is re-derived from the codec on every run:
 * the version must match `PROTOCOL_VERSION`, `encode(frame)` must reproduce `wire` byte for byte,
 * and `decode(wire)` must give back the frame (or the recorded `decoded`, where the codec defaults
 * an absent member) or refuse with the named reason.
 *
 * A change to the codec, to a payload shape or to the version reddens the corpus. Accepting it is
 * `npm run contracts:update`, which sets `PERISCOPE_UPDATE_CONTRACTS=1` and makes this file
 * rewrite the corpus from the authored cases below before the checks run.
 *
 * The file's shape:
 *
 *   {
 *     "name":            "session_new.full",           // <payload kind>.<variant> or refused.<variant>
 *     "protocolVersion": 6,
 *     "frame":           { ... } | null,               // null when no frame of this build encodes to `wire`
 *     "wire":            "<exact encode() output>",
 *     "expect":          { "decode": "ok" } | { "decode": "refused", "reason": "frame-malformed" },
 *     "decoded":         { ... }                       // only when decode(wire) differs from frame
 *   }
 *
 * Top-level keys are sorted. The frame's own key order is the wire's key order and is kept as
 * authored, because `encode` is `JSON.stringify` and key order is insertion order.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decode, encode } from '../control/codec.js';
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MIN,
  agentMessageDelta,
  agentMessageUpdate,
  bulkDelivered,
  sessionList,
  sessionListResult,
  sessionNew,
  sessionNewRequest,
  stateTransitionUpdate,
  answerRefused,
  transcriptFailed,
  transcriptList,
  transcriptListResult,
  transcriptTail,
  hostConfigure,
  hostConfigureResult,
  transcriptTailResult,
  unsetHostConfiguration,
  wireRefusalUpdate,
  workspaceList,
  workspaceListResult,
  repositoryList,
  repositoryListResult,
  repositoryRead,
  repositoryReadResult,
  workspaceRelease,
  workspaceReleaseBulk,
  workspaceReleaseBulkResult,
  workspaceReleaseEntryResult,
  workspaceReleaseResult,
} from '../control/frames.js';
import type {
  ControlPayload,
  ControlPayloadKind,
  Frame,
  SessionPayload,
  SessionPayloadKind,
} from '../control/frames.js';
import type { SessionTransition } from '../state/model.js';

/** From dist/pins/ up to the package root, then into the corpus. */
const VECTORS_DIR = fileURLToPath(new URL('../../contracts/wire-vectors/', import.meta.url));

const UPDATE = process.env['PERISCOPE_UPDATE_CONTRACTS'] === '1';

// ---------------------------------------------------------------------------
// The file format.
// ---------------------------------------------------------------------------

type Expectation =
  | { readonly decode: 'ok' }
  | { readonly decode: 'refused'; readonly reason: string }
  | { readonly encode: 'refused'; readonly reason: string };

/** A vector whose `expect` names an encode refusal carries the frame and no wire: nothing reaches the wire. */
interface WireVector {
  readonly name: string;
  readonly protocolVersion: number;
  readonly frame: Frame | null;
  readonly wire: string | null;
  readonly expect: Expectation;
  readonly decoded?: unknown;
}

const REFUSED_PREFIX = 'refused';

/** The payload kind a vector is about, read from its name: everything before the first dot. */
function kindOf(name: string): string {
  return name.split('.')[0] ?? name;
}

/** Sorted top-level keys, two-space indentation, LF, one trailing newline. */
function render(vector: WireVector): string {
  const sorted = Object.fromEntries(
    Object.entries(vector).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The authored cases: one list per payload kind. `satisfies` makes a new kind fail to compile
// until it has at least an entry here, so the corpus cannot quietly stop covering the union.
// ---------------------------------------------------------------------------

const AT = '2000-01-01T00:00:00.000Z';

interface AuthoredFrame {
  readonly name: string;
  readonly frame: Frame;
}

const session = (payload: SessionPayload, seq = 1): Frame => ({
  frame: 'session',
  sessionId: 'session-1',
  seq,
  at: AT,
  payload,
});

const control = (payload: ControlPayload): Frame => ({ frame: 'control', at: AT, payload });

const TRANSITION_READY: SessionTransition = {
  sessionId: 'agent-session-1',
  seq: 2,
  at: AT,
  from: 'spawning',
  to: 'ready',
  activity: null,
  entryId: null,
  cause: { kind: 'sdk-message', event: 'system/init', detail: 'the agent reported itself' },
  where: { cwd: '/work/repo', worktree: '/work/repo', branch: 'main', unknownReason: null },
  correlationId: 'correlation-1',
};

const TRANSITION_TOOL: SessionTransition = {
  sessionId: 'agent-session-1',
  seq: 3,
  at: AT,
  from: 'ready',
  to: 'working',
  activity: { kind: 'tool', name: 'Bash' },
  entryId: 'toolu_1',
  cause: { kind: 'hook', event: 'PreToolUse', detail: 'Bash' },
  where: { cwd: '/work/plain', worktree: null, branch: null, unknownReason: 'not-a-repository' },
  correlationId: null,
};

const REFUSAL = { reason: 'bulk-delivery-failed', detail: 'the controller answered 503' };

const AUTHORED = {
  session_update: [
    { name: 'session_update.state-transition', frame: session(stateTransitionUpdate(TRANSITION_READY)) },
    {
      name: 'session_update.state-transition-with-activity',
      frame: session(stateTransitionUpdate(TRANSITION_TOOL), 2),
    },
    {
      name: 'session_update.agent-message',
      frame: session(
        agentMessageUpdate({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 }),
      ),
    },
    {
      name: 'session_update.wire-refusal',
      frame: session(wireRefusalUpdate({ reason: 'seq-gap', detail: 'expected 4, received 6' }, 4, 6)),
    },
  ],
  session_delta: [
    {
      name: 'session_delta.agent-message',
      frame: session(
        agentMessageDelta({ type: 'stream_event', event: { type: 'content_block_delta', index: 0 } }),
      ),
    },
  ],
  session_new: [
    {
      name: 'session_new.full',
      frame: session(
        sessionNew('/work/repo', {
          workspaceKey: 'workspace-1',
          correlationId: 'correlation-1',
          request: sessionNewRequest({
            resume: 'agent-session-0',
            fork: true,
            settingSources: ['project'],
            plugins: [{ type: 'local', path: '/plugins/one', skipMcpDiscovery: false }],
            mcpServers: { docs: { type: 'stdio', command: 'docs-server', args: [] } },
            strictMcpConfig: true,
            includePartialMessages: false,
            thinking: { type: 'enabled', budgetTokens: 2048 },
            forwardSubagentText: true,
            env: { extraAllowedKeys: ['CI'], extraDeniedKeys: ['SECRET'], extraEnv: { FLAG: '1' } },
            model: 'model-id',
            systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Answer briefly.' },
            effort: 'high',
            permissionMode: 'default',
          }),
          gate: { decisionTimeoutMs: 30_000, holdAfterMs: 5_000, matcherTimeoutSeconds: 60 },
        }),
      ),
    },
    { name: 'session_new.minimal', frame: session(sessionNew(null)) },
    {
      name: 'session_new.request-all-null',
      frame: session(
        sessionNew('/work/repo', {
          request: sessionNewRequest(),
          gate: { decisionTimeoutMs: null, holdAfterMs: null, matcherTimeoutSeconds: null },
        }),
      ),
    },
  ],
  session_prompt: [
    { name: 'session_prompt.text', frame: session({ kind: 'session_prompt', text: 'list the open files' }) },
    { name: 'session_prompt.empty', frame: session({ kind: 'session_prompt', text: '' }) },
    {
      name: 'session_prompt.multibyte',
      frame: session({ kind: 'session_prompt', text: 'caf\u00e9 \u00fcber' }),
    },
  ],
  session_cancel: [{ name: 'session_cancel.bare', frame: session({ kind: 'session_cancel' }) }],
  session_configure: [
    {
      name: 'session_configure.full',
      frame: session({
        kind: 'session_configure',
        model: 'model-id',
        permissionMode: 'plan',
        thinking: { type: 'adaptive' },
      }),
    },
    {
      name: 'session_configure.minimal',
      frame: session({ kind: 'session_configure', model: null, permissionMode: null, thinking: null }),
    },
  ],
  bulk_request: [
    {
      name: 'bulk_request.full',
      frame: session({
        kind: 'bulk_request',
        deliveryId: 'delivery-1',
        what: 'claude-transcript:slug/agent-session-1',
        fromOffset: 4096,
        postUrl: 'https://controller.example/bulk/delivery-1',
      }),
    },
  ],
  bulk_delivered: [
    {
      name: 'bulk_delivered.full',
      frame: session(bulkDelivered('delivery-1', 512, { sizeBytes: 4608, mtimeMs: 1_700_000_000_000 })),
    },
    { name: 'bulk_delivered.minimal', frame: session(bulkDelivered('delivery-1', 0)) },
  ],
  bulk_failed: [
    {
      name: 'bulk_failed.declared-reason',
      frame: session({ kind: 'bulk_failed', deliveryId: 'delivery-1', refusal: REFUSAL }),
    },
  ],
  session_list: [{ name: 'session_list.request', frame: session(sessionList('request-1')) }],
  session_list_result: [
    {
      name: 'session_list_result.full',
      frame: session(
        sessionListResult(
          'request-1',
          [
            {
              sessionKey: 'session-1',
              sessionId: 'agent-session-1',
              state: 'working',
              cwd: '/work/repo',
              startedAt: AT,
            },
            { sessionKey: 'session-2', sessionId: null, state: 'spawning', cwd: null, startedAt: null },
          ],
          { liveCount: 1, provisioningCount: 1 },
        ),
      ),
    },
    {
      name: 'session_list_result.empty',
      frame: session(sessionListResult('request-1', [], { liveCount: 0, provisioningCount: 0 })),
    },
  ],
  transcript_list: [
    { name: 'transcript_list.from-start', frame: session(transcriptList('request-2')) },
    { name: 'transcript_list.paged', frame: session(transcriptList('request-2', 100)) },
  ],
  transcript_list_result: [
    {
      name: 'transcript_list_result.full',
      frame: session(
        transcriptListResult(
          'request-2',
          [
            {
              projectSlug: 'C--work-repo',
              sessionId: 'agent-session-1',
              sizeBytes: 4608,
              mtimeMs: 1_700_000_000_000,
              cwd: 'C:/work/repo',
            },
          ],
          { totalCount: 370, nextIndex: 100 },
        ),
      ),
    },
    {
      name: 'transcript_list_result.last-page',
      frame: session(
        transcriptListResult(
          'request-2',
          [
            {
              projectSlug: 'C--work-repo',
              sessionId: 'agent-session-2',
              sizeBytes: 12,
              mtimeMs: 1_700_000_000_000,
              cwd: null,
            },
          ],
          { totalCount: 1 },
        ),
      ),
    },
  ],
  transcript_tail: [
    {
      name: 'transcript_tail.with-needle',
      frame: session(transcriptTail('request-3', 'C--work-repo', 'agent-session-1', 4096, 'the needle')),
    },
    {
      name: 'transcript_tail.any-user-entry',
      frame: session(transcriptTail('request-3', 'C--work-repo', 'agent-session-1', 0)),
    },
  ],
  transcript_tail_result: [
    {
      name: 'transcript_tail_result.found',
      frame: session(
        transcriptTailResult('request-3', {
          found: true,
          absent: false,
          newOffset: 8192,
          sizeBytes: 8192,
          mtimeMs: 1_700_000_000_000,
        }),
      ),
    },
    {
      name: 'transcript_tail_result.absent',
      frame: session(transcriptTailResult('request-3', { found: false, absent: true, newOffset: 0 })),
    },
  ],
  transcript_failed: [
    {
      name: 'transcript_failed.declared-reason',
      frame: session(
        transcriptFailed('request-4', {
          reason: 'transcript-path-escape',
          detail: 'refused by the allowlist',
        }),
      ),
    },
  ],
  answer_refused: [
    {
      name: 'answer_refused.frame-too-large',
      frame: session(
        answerRefused('request-4', {
          reason: 'frame-too-large',
          detail: 'the answer was 70000 bytes, over the 65536 limit',
        }),
      ),
    },
  ],
  workspace_release: [
    { name: 'workspace_release.request', frame: session(workspaceRelease('request-5', 'workspace-1')) },
    {
      name: 'workspace_release.by-path-delete-branch',
      frame: session(
        workspaceRelease('request-5', { path: 'C:/work/workspace-1' }, { deleteBranch: true, force: true }),
      ),
    },
  ],
  workspace_release_result: [
    {
      name: 'workspace_release_result.released',
      frame: session(
        workspaceReleaseResult('request-5', {
          workspaceKey: 'workspace-1',
          path: 'C:/work/workspace-1',
          directoryRemoved: true,
          branchDeleted: true,
        }),
      ),
    },
    {
      name: 'workspace_release_result.refused',
      frame: session(
        workspaceReleaseResult('request-5', {
          workspaceKey: 'workspace-1',
          refusal: { reason: 'workspace-release-failed', detail: 'still backing a live session' },
        }),
      ),
    },
    {
      name: 'workspace_release_result.partial',
      frame: session(
        workspaceReleaseResult('request-5', {
          workspaceKey: 'workspace-1',
          path: 'C:/work/workspace-1',
          directoryRemoved: true,
          branchDeleted: false,
          refusal: {
            reason: 'workspace-release-failed',
            detail: 'removed the worktree but could not delete the branch',
          },
        }),
      ),
    },
  ],
  workspace_release_bulk: [
    {
      name: 'workspace_release_bulk.two-entries',
      frame: session(
        workspaceReleaseBulk('request-8', [
          { workspaceKey: 'workspace-1', path: null, deleteBranch: true, force: false },
          { workspaceKey: null, path: 'C:/work/workspace-2', deleteBranch: false, force: false },
        ]),
      ),
    },
  ],
  workspace_release_bulk_result: [
    {
      name: 'workspace_release_bulk_result.mixed',
      frame: session(
        workspaceReleaseBulkResult('request-8', [
          workspaceReleaseEntryResult({
            workspaceKey: 'workspace-1',
            path: 'C:/work/workspace-1',
            directoryRemoved: true,
            branchDeleted: true,
          }),
          workspaceReleaseEntryResult({
            workspaceKey: 'workspace-2',
            path: 'C:/work/workspace-2',
            refusal: { reason: 'branch-not-merged', detail: 'not merged into main' },
          }),
        ]),
      ),
    },
  ],
  host_configure: [
    {
      name: 'host_configure.set-and-remove',
      frame: session(
        hostConfigure('request-6', [
          { key: 'PERISCOPE_BRANCH_SCHEME', value: '{repo}/{key}' },
          { key: 'PERISCOPE_AGENT_HOME', value: null },
        ]),
      ),
    },
  ],
  host_configure_result: [
    {
      name: 'host_configure_result.applied',
      frame: session(
        hostConfigureResult(
          'request-6',
          {
            repositoryRoot: '/srv/repo',
            workspaceRoot: '/srv/repo-workspaces',
            branchScheme: '{repo}/{key}',
            transcriptsRoot: '/home/agent/.claude/projects',
            controllerUrl: 'wss://controller.example/periscope/link',
            decisionUrl: 'https://controller.example/periscope/decision',
            agentHome: '/home/agent/.claude',
          },
          ['PERISCOPE_REPOSITORY_ROOT'],
          undefined,
          ['PERISCOPE_CONTROLLER_URL'],
        ),
      ),
    },
    {
      name: 'host_configure_result.refused',
      frame: session(
        hostConfigureResult('request-6', unsetHostConfiguration(), [], {
          reason: 'config-key-unknown',
          detail: 'PERISCOPE_HOST_ID is not a key this host takes over the wire',
        }),
      ),
    },
  ],
  workspace_list: [{ name: 'workspace_list.from-start', frame: session(workspaceList('request-7')) }],
  workspace_list_result: [
    {
      name: 'workspace_list_result.page',
      frame: session(
        workspaceListResult(
          'request-7',
          [
            {
              key: 'session-150',
              path: '/srv/repo-workspaces/session-150',
              branch: 'repo/session-150',
              head: '2222222222222222222222222222222222222222',
              detached: false,
              locked: false,
              prunable: false,
              merged: true,
              aheadCount: 0,
              lastCommitAt: '2026-09-09T08:30:00+00:00',
            },
            {
              key: 'solo-detached',
              path: '/srv/repo-workspaces/solo-detached',
              branch: null,
              head: null,
              detached: true,
              locked: true,
              prunable: true,
              merged: null,
              aheadCount: null,
              lastCommitAt: null,
            },
          ],
          { totalCount: 27, nextIndex: 25, defaultBranch: 'main' },
        ),
      ),
    },
    {
      name: 'workspace_list_result.refused',
      frame: session(
        workspaceListResult(
          'request-7',
          [],
          { totalCount: 0 },
          { reason: 'workspace-list-failed', detail: 'no provider' },
        ),
      ),
    },
  ],
  repository_list: [
    { name: 'repository_list.root', frame: session(repositoryList('request-9')) },
    { name: 'repository_list.subdirectory', frame: session(repositoryList('request-9', 'docs')) },
  ],
  repository_list_result: [
    {
      name: 'repository_list_result.entries',
      frame: session(
        repositoryListResult('request-9', [
          { name: 'README.md', directory: false, sizeBytes: 4096, mtimeMs: 1_757_400_000_000 },
          { name: 'guides', directory: true, sizeBytes: 0, mtimeMs: 1_757_400_000_000 },
        ]),
      ),
    },
    {
      name: 'repository_list_result.refused',
      frame: session(
        repositoryListResult('request-9', [], false, {
          reason: 'repository-path-escape',
          detail: 'outside the repository root',
        }),
      ),
    },
  ],
  repository_read: [
    {
      name: 'repository_read.head',
      frame: session(repositoryRead('request-10', 'docs/guides/getting-started.md', 16384)),
    },
  ],
  repository_read_result: [
    {
      name: 'repository_read_result.truncated',
      frame: session(
        repositoryReadResult('request-10', { text: '# The brief\n', sizeBytes: 20480, truncated: true }),
      ),
    },
    {
      name: 'repository_read_result.refused',
      frame: session(
        repositoryReadResult(
          'request-10',
          { text: null, sizeBytes: 0, truncated: false },
          { reason: 'repository-read-failed', detail: 'the path is not a file' },
        ),
      ),
    },
  ],
  link_hello: [
    {
      name: 'link_hello.full',
      frame: control({
        kind: 'link_hello',
        protocolVersion: PROTOCOL_VERSION,
        hostId: 'host-1',
        capabilities: ['bulk-post', 'workspace:git-worktree', 'workspace:branch-scheme'],
        cursors: [{ sessionId: 'session-1', seq: 4 }],
        configuration: {
          repositoryRoot: '/srv/repo',
          workspaceRoot: '/srv/repo-workspaces',
          branchScheme: '{repo}/{key}',
          transcriptsRoot: '/home/agent/.claude/projects',
          controllerUrl: 'wss://controller.example/periscope/link',
          decisionUrl: 'https://controller.example/periscope/decision',
          agentHome: '/home/agent/.claude',
        },
        pendingRestart: ['PERISCOPE_DECISION_URL'],
        protocolRange: { min: PROTOCOL_VERSION_MIN, max: PROTOCOL_VERSION },
      }),
    },
    {
      name: 'link_hello.empty',
      frame: control({
        kind: 'link_hello',
        protocolVersion: PROTOCOL_VERSION,
        hostId: 'host-1',
        capabilities: [],
        cursors: [],
        configuration: unsetHostConfiguration(),
        pendingRestart: [],
        protocolRange: { min: PROTOCOL_VERSION_MIN, max: PROTOCOL_VERSION },
      }),
    },
  ],
  link_welcome: [
    {
      name: 'link_welcome.full',
      frame: control({
        kind: 'link_welcome',
        protocolVersion: PROTOCOL_VERSION,
        protocolRange: null,
        capabilities: ['bulk-post'],
        cursors: [{ sessionId: 'session-1', seq: 3 }],
      }),
    },
    {
      name: 'link_welcome.empty',
      frame: control({
        kind: 'link_welcome',
        protocolVersion: PROTOCOL_VERSION,
        protocolRange: null,
        capabilities: [],
        cursors: [],
      }),
    },
  ],
  link_ack: [
    {
      name: 'link_ack.cursors',
      frame: control({
        kind: 'link_ack',
        cursors: [
          { sessionId: 'session-1', seq: 4 },
          { sessionId: 'session-2', seq: 0 },
        ],
      }),
    },
    { name: 'link_ack.empty', frame: control({ kind: 'link_ack', cursors: [] }) },
  ],
  link_ping: [{ name: 'link_ping.nonce', frame: control({ kind: 'link_ping', nonce: 'nonce-1' }) }],
  link_pong: [{ name: 'link_pong.nonce', frame: control({ kind: 'link_pong', nonce: 'nonce-1' }) }],
  link_bye: [{ name: 'link_bye.cause', frame: control({ kind: 'link_bye', cause: 'shutdown' }) }],
} satisfies Record<SessionPayloadKind | ControlPayloadKind, readonly AuthoredFrame[]>;

const KINDS: readonly string[] = Object.keys(AUTHORED);

// ---------------------------------------------------------------------------
// The authored wires: bytes no frame of this build encodes to. The refusals, and the tolerances
// (an older or newer peer's shape that must decode). `decoded` is stated, not recorded, so a
// codec that starts answering differently reddens here rather than being accepted by a rewrite.
// ---------------------------------------------------------------------------

interface AuthoredWire {
  readonly name: string;
  readonly wire: string;
  readonly expect: Expectation;
  readonly decoded?: unknown;
}

const sessionWire = (
  payload: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
  seq = 1,
): string => JSON.stringify({ frame: 'session', sessionId: 'session-1', seq, at: AT, payload, ...envelope });

const controlWire = (payload: Record<string, unknown>): string =>
  JSON.stringify({ frame: 'control', at: AT, payload });

const refused = (reason: string): Expectation => ({ decode: 'refused', reason });
const OK: Expectation = { decode: 'ok' };

/** The wire, decoded exactly as parsed: decode adds nothing and strips nothing. */
const asParsed = (name: string, wire: string): AuthoredWire => ({
  name,
  wire,
  expect: OK,
  decoded: JSON.parse(wire) as unknown,
});

const WITHOUT_STAT_PAIR = sessionWire({ kind: 'bulk_delivered', deliveryId: 'delivery-1', byteCount: 7 });
const ENTRY_WITHOUT_CWD = sessionWire({
  kind: 'transcript_list_result',
  requestId: 'request-2',
  entries: [
    { projectSlug: 'C--work-repo', sessionId: 'agent-session-1', sizeBytes: 12, mtimeMs: 1_700_000_000_000 },
  ],
  totalCount: 1,
  nextIndex: null,
});

/** A frame encode must refuse: the shape decode would refuse, or a reason this host does not declare. */
interface AuthoredMalformed {
  readonly name: string;
  readonly frame: unknown;
  readonly reason: string;
}

const AUTHORED_MALFORMED: readonly AuthoredMalformed[] = [
  {
    name: 'refused.encode.seq-zero',
    frame: { frame: 'session', sessionId: 'session-1', seq: 0, at: AT, payload: { kind: 'session_cancel' } },
    reason: 'frame-malformed',
  },
  {
    name: 'refused.encode.empty-at',
    frame: { frame: 'session', sessionId: 'session-1', seq: 1, at: '', payload: { kind: 'session_cancel' } },
    reason: 'frame-malformed',
  },
  {
    name: 'refused.encode.empty-session-id',
    frame: { frame: 'session', sessionId: '', seq: 1, at: AT, payload: { kind: 'session_cancel' } },
    reason: 'frame-malformed',
  },
  {
    name: 'refused.encode.missing-member',
    frame: {
      frame: 'session',
      sessionId: 'session-1',
      seq: 1,
      at: AT,
      payload: { kind: 'session_new', cwd: '/work/repo', correlationId: null, request: null, gate: null },
    },
    reason: 'frame-malformed',
  },
  {
    name: 'refused.encode.undeclared-wire-refusal',
    frame: {
      frame: 'session',
      sessionId: 'session-1',
      seq: 1,
      at: AT,
      payload: {
        kind: 'session_update',
        body: {
          update: 'wire_refusal',
          refusal: { reason: 'a-reason-this-host-does-not-declare', detail: '' },
          expected: 1,
          received: 2,
        },
      },
    },
    reason: 'frame-malformed',
  },
  {
    name: 'refused.encode.undeclared-configure-refusal',
    frame: {
      frame: 'session',
      sessionId: 'session-1',
      seq: 1,
      at: AT,
      payload: {
        kind: 'host_configure_result',
        requestId: 'request-1',
        configuration: {
          repositoryRoot: null,
          workspaceRoot: null,
          branchScheme: null,
          transcriptsRoot: null,
          controllerUrl: null,
          decisionUrl: null,
          agentHome: null,
        },
        overriddenByEnvironment: [],
        pendingRestart: [],
        refusal: { reason: 'a-reason-this-host-does-not-declare', detail: '' },
      },
    },
    reason: 'frame-malformed',
  },
];

const AUTHORED_WIRES: readonly AuthoredWire[] = [
  // Refusals.
  { name: 'refused.not-json', wire: 'not json at all', expect: refused('frame-not-json') },
  { name: 'refused.empty', wire: '', expect: refused('frame-not-json') },
  {
    name: 'refused.seq-zero',
    wire: sessionWire({ kind: 'session_cancel' }, {}, 0),
    expect: refused('frame-malformed'),
  },
  {
    name: 'refused.unknown-kind',
    wire: sessionWire({ kind: 'session_teleport' }),
    expect: refused('frame-malformed'),
  },
  {
    name: 'refused.unknown-frame',
    wire: JSON.stringify({ frame: 'bulk', at: AT, payload: { kind: 'link_ping', nonce: 'n' } }),
    expect: refused('frame-malformed'),
  },
  {
    name: 'refused.missing-member',
    wire: sessionWire({
      kind: 'session_new',
      cwd: '/work/repo',
      correlationId: null,
      request: null,
      gate: null,
    }),
    expect: refused('frame-malformed'),
  },
  {
    name: 'refused.over-limit',
    wire: `{"padding":"${'x'.repeat(MAX_FRAME_BYTES)}"}`,
    expect: refused('frame-too-large'),
  },

  // Tolerances: an unknown key survives at either level, on either frame.
  asParsed(
    'session_prompt.unknown-frame-key',
    sessionWire({ kind: 'session_prompt', text: 'hello' }, { futureField: 'from a newer peer' }),
  ),
  asParsed(
    'session_prompt.unknown-payload-key',
    sessionWire({ kind: 'session_prompt', text: 'hello', futureField: 'from a newer peer' }),
  ),
  asParsed(
    'link_ping.unknown-payload-key',
    controlWire({ kind: 'link_ping', nonce: 'nonce-1', futureField: 'from a newer peer' }),
  ),

  // Tolerances: the two members the codec defaults when an older peer omits them.
  {
    name: 'bulk_delivered.without-stat-pair',
    wire: WITHOUT_STAT_PAIR,
    expect: OK,
    decoded: session(bulkDelivered('delivery-1', 7)),
  },
  {
    name: 'transcript_list_result.entry-without-cwd',
    wire: ENTRY_WITHOUT_CWD,
    expect: OK,
    decoded: session(
      transcriptListResult(
        'request-2',
        [
          {
            projectSlug: 'C--work-repo',
            sessionId: 'agent-session-1',
            sizeBytes: 12,
            mtimeMs: 1_700_000_000_000,
            cwd: null,
          },
        ],
        {
          totalCount: 1,
        },
      ),
    ),
  },

  // Tolerance: a refusal reason this build does not declare decodes with the raw word kept.
  asParsed(
    'bulk_failed.unknown-reason',
    sessionWire({
      kind: 'bulk_failed',
      deliveryId: 'delivery-1',
      refusal: { reason: 'a-reason-from-a-newer-peer', detail: 'the controller answered 503' },
    }),
  ),
];

// ---------------------------------------------------------------------------
// From the authored cases to vector documents.
// ---------------------------------------------------------------------------

function vectorFromFrame(authored: AuthoredFrame): WireVector {
  const encoded = encode(authored.frame);
  if (!encoded.ok)
    throw new Error(`${authored.name}: the authored frame does not encode: ${encoded.refusal.detail}`);
  const base: WireVector = {
    name: authored.name,
    protocolVersion: PROTOCOL_VERSION,
    frame: authored.frame,
    wire: encoded.value,
    expect: OK,
  };
  const decoded = decode(encoded.value);
  if (decoded.ok && !sameJson(decoded.value, authored.frame)) return { ...base, decoded: decoded.value };
  return base;
}

function vectorFromWire(authored: AuthoredWire): WireVector {
  const base: WireVector = {
    name: authored.name,
    protocolVersion: PROTOCOL_VERSION,
    frame: null,
    wire: authored.wire,
    expect: authored.expect,
  };
  return authored.decoded === undefined ? base : { ...base, decoded: authored.decoded };
}

function vectorFromMalformed(authored: AuthoredMalformed): WireVector {
  return {
    name: authored.name,
    protocolVersion: PROTOCOL_VERSION,
    frame: authored.frame as Frame,
    wire: null,
    expect: { encode: 'refused', reason: authored.reason },
  };
}

function authoredVectors(): WireVector[] {
  const fromFrames = Object.values(AUTHORED).flatMap((cases: readonly AuthoredFrame[]) =>
    cases.map(vectorFromFrame),
  );
  return [
    ...fromFrames,
    ...AUTHORED_WIRES.map(vectorFromWire),
    ...AUTHORED_MALFORMED.map(vectorFromMalformed),
  ];
}

// ---------------------------------------------------------------------------
// The checks a file must pass, as failure strings so a control can prove they fire.
// ---------------------------------------------------------------------------

function firstDifference(left: string, right: string): number {
  const shorter = Math.min(left.length, right.length);
  for (let index = 0; index < shorter; index += 1) if (left[index] !== right[index]) return index;
  return shorter;
}

function checkVector(vector: WireVector): string[] {
  const failures: string[] = [];
  const { name } = vector;

  if (vector.protocolVersion !== PROTOCOL_VERSION) {
    failures.push(
      `${name}: recorded at protocol ${vector.protocolVersion}, this build is ${PROTOCOL_VERSION}`,
    );
  }

  if ('encode' in vector.expect) {
    if (vector.frame === null) {
      failures.push(`${name}: an encode expectation needs a frame`);
    } else {
      const encoded = encode(vector.frame);
      if (encoded.ok) failures.push(`${name}: expected encode to refuse ${vector.expect.reason}, it encoded`);
      else if (encoded.refusal.reason !== vector.expect.reason)
        failures.push(
          `${name}: expected encode to refuse ${vector.expect.reason}, got ${encoded.refusal.reason}`,
        );
    }
    return failures;
  }
  if (vector.wire === null) {
    failures.push(`${name}: a decode expectation needs a wire`);
    return failures;
  }

  if (vector.frame !== null) {
    const encoded = encode(vector.frame);
    if (!encoded.ok) {
      failures.push(`${name}: the frame no longer encodes: ${encoded.refusal.reason}`);
    } else if (encoded.value !== vector.wire) {
      const at = firstDifference(encoded.value, vector.wire);
      failures.push(
        `${name}: wire differs from encode(frame) at byte ${at}: recorded ${JSON.stringify(vector.wire.slice(at, at + 40))}, encoded ${JSON.stringify(encoded.value.slice(at, at + 40))}`,
      );
    }
  }

  const decoded = decode(vector.wire);
  if (vector.expect.decode === 'ok') {
    if (!decoded.ok) {
      failures.push(
        `${name}: expected to decode, refused ${decoded.refusal.reason}: ${decoded.refusal.detail}`,
      );
    } else {
      const expected = vector.decoded === undefined ? vector.frame : vector.decoded;
      if (!sameJson(decoded.value, expected))
        failures.push(
          `${name}: decode(wire) differs from ${vector.decoded === undefined ? 'frame' : 'decoded'}`,
        );
    }
  } else if (decoded.ok) {
    failures.push(`${name}: expected refusal ${vector.expect.reason}, decoded`);
  } else if (decoded.refusal.reason !== vector.expect.reason) {
    failures.push(`${name}: expected refusal ${vector.expect.reason}, got ${decoded.refusal.reason}`);
  }

  return failures;
}

// ---------------------------------------------------------------------------
// The corpus on disk.
// ---------------------------------------------------------------------------

const lf = (text: string): string => text.replace(/\r\n/g, '\n');

function filesOnDisk(): string[] {
  if (!existsSync(VECTORS_DIR)) return [];
  return readdirSync(VECTORS_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
}

function readVector(file: string): WireVector {
  return JSON.parse(lf(readFileSync(`${VECTORS_DIR}${file}`, 'utf8'))) as WireVector;
}

function rewriteCorpus(vectors: readonly WireVector[]): void {
  mkdirSync(VECTORS_DIR, { recursive: true });
  const wanted = new Set(vectors.map((vector) => `${vector.name}.json`));
  const removed = filesOnDisk().filter((file) => !wanted.has(file));
  for (const file of removed) rmSync(`${VECTORS_DIR}${file}`);

  let changed = 0;
  for (const vector of vectors) {
    const path = `${VECTORS_DIR}${vector.name}.json`;
    const text = render(vector);
    const before = existsSync(path) ? lf(readFileSync(path, 'utf8')) : null;
    if (before === text) continue;
    writeFileSync(path, text);
    changed += 1;
  }
  process.stdout.write(
    `wire-vectors: ${vectors.length} vector(s) in contracts/wire-vectors/, ${changed} written, ${removed.length} removed` +
      `${removed.length > 0 ? ` (${removed.join(', ')})` : ''}\n`,
  );
}

if (UPDATE) rewriteCorpus(authoredVectors());

// ---------------------------------------------------------------------------

test('every payload kind has at least one vector on disk, and every file names a kind or a refusal', () => {
  const files = filesOnDisk();
  assert.ok(
    files.length >= 40,
    `the corpus looks empty (${files.length} files); run \`npm run contracts:update\``,
  );

  const kindsOnDisk = new Set(files.map((file) => kindOf(file.replace(/\.json$/, ''))));
  const uncovered = KINDS.filter((kind) => !kindsOnDisk.has(kind));
  assert.deepEqual(uncovered, [], `payload kinds with no vector on disk: ${uncovered.join(', ')}`);

  const strangers = [...kindsOnDisk].filter((kind) => kind !== REFUSED_PREFIX && !KINDS.includes(kind));
  assert.deepEqual(strangers, [], `files naming a kind this build does not carry: ${strangers.join(', ')}`);
});

test('every vector on disk: version, encode byte for byte, decode outcome', () => {
  const failures: string[] = [];
  for (const file of filesOnDisk()) {
    const vector = readVector(file);
    if (`${vector.name}.json` !== file) failures.push(`${file}: names itself ${vector.name}`);
    failures.push(...checkVector(vector));
  }
  assert.deepEqual(
    failures,
    [],
    `the wire contract moved; run \`npm run contracts:update\` to accept:\n  ${failures.join('\n  ')}`,
  );
});

// The authored cases and the files must be the same text, or an edit to the cases above (a new
// variant, a changed fixture) passes here while the corpus a stranger reads says something else.
test('the corpus on disk is the current authoring, byte for byte', () => {
  const authored = new Map(authoredVectors().map((vector) => [`${vector.name}.json`, render(vector)]));
  const onDisk = filesOnDisk();

  const missing = [...authored.keys()].filter((file) => !onDisk.includes(file));
  const stale = onDisk.filter((file) => !authored.has(file));
  const differing = onDisk.filter(
    (file) => authored.has(file) && lf(readFileSync(`${VECTORS_DIR}${file}`, 'utf8')) !== authored.get(file),
  );

  const problems = [
    ...missing.map((file) => `missing: ${file}`),
    ...stale.map((file) => `stale: ${file}`),
    ...differing.map((file) => `differs: ${file}`),
  ];
  assert.deepEqual(
    problems,
    [],
    `the corpus is behind the authored cases; run \`npm run contracts:update\` to accept:\n  ${problems.join('\n  ')}`,
  );
});

test('every vector is under the frame limit except the one that exists to be over it', () => {
  for (const file of filesOnDisk()) {
    const vector = readVector(file);
    const over = new TextEncoder().encode(vector.wire ?? '').length > MAX_FRAME_BYTES;
    assert.equal(
      over,
      vector.name === 'refused.over-limit',
      `${vector.name} is ${over ? 'over' : 'under'} the limit`,
    );
  }
});

// Guards the detector, not the rule. A checker that reports nothing on a corrupted file is a
// corpus that pins nothing.
test('control: a corrupted wire, a stale version and a wrong expectation each fail the check', () => {
  const clean = vectorFromFrame({
    name: 'link_ping.control',
    frame: control({ kind: 'link_ping', nonce: 'nonce-1' }),
  });
  assert.deepEqual(checkVector(clean), [], 'the control vector must be clean before it is corrupted');

  // A corrupted wire fails twice: the bytes no longer match the frame, and what they decode to no
  // longer matches it either. Both are asserted so neither check can be dropped unnoticed.
  const corrupted = { ...clean, wire: (clean.wire ?? '').replace('nonce-1', 'nonce-2') };
  const wireFailures = checkVector(corrupted);
  assert.equal(wireFailures.length, 2, wireFailures.join('; '));
  assert.match(wireFailures[0] ?? '', /wire differs from encode\(frame\) at byte \d+/);
  assert.match(wireFailures[1] ?? '', /decode\(wire\) differs from frame/);

  const stale = { ...clean, protocolVersion: PROTOCOL_VERSION - 1 };
  assert.match(checkVector(stale).join('; '), /recorded at protocol/);

  const wrongExpectation: WireVector = { ...clean, expect: refused('frame-malformed') };
  assert.match(checkVector(wrongExpectation).join('; '), /expected refusal frame-malformed, decoded/);

  const wrongReason: WireVector = { ...clean, wire: 'not json', expect: refused('frame-malformed') };
  assert.match(checkVector(wrongReason).join('; '), /expected refusal frame-malformed, got frame-not-json/);

  const wrongDecoded: WireVector = { ...clean, decoded: control({ kind: 'link_ping', nonce: 'nonce-2' }) };
  assert.match(checkVector(wrongDecoded).join('; '), /decode\(wire\) differs from decoded/);
});

test('control: the authored cases cover both refusal and tolerance, and the corpus stays under one file per name', () => {
  const vectors = authoredVectors();
  const names = vectors.map((vector) => vector.name);
  assert.equal(new Set(names).size, names.length, 'two authored cases share a name');

  const refusals = vectors.filter(
    (vector) => 'decode' in vector.expect && vector.expect.decode === 'refused',
  );
  const reasons = new Set(refusals.map((vector) => (vector.expect as { reason: string }).reason));
  assert.deepEqual([...reasons].sort(), ['frame-malformed', 'frame-not-json', 'frame-too-large']);

  const encodeRefusals = vectors.filter((vector) => 'encode' in vector.expect);
  assert.ok(encodeRefusals.length >= 6, `too few encode-refusal vectors: ${encodeRefusals.length}`);

  const tolerated = vectors.filter(
    (vector) => vector.frame === null && 'decode' in vector.expect && vector.expect.decode === 'ok',
  );
  assert.ok(tolerated.length >= 5, `too few tolerance vectors: ${tolerated.length}`);
  assert.ok(
    vectors.every(
      (vector) =>
        vector.frame !== null ||
        ('decode' in vector.expect && vector.expect.decode === 'refused') ||
        vector.decoded !== undefined,
    ),
  );
});
