/**
 * The wire edge. Bytes become types here and nowhere else.
 *
 * Two properties this file exists to hold:
 *   - Nothing inward of `decode` has seen an unvalidated object, and `decode` never throws — a
 *     malformed frame from a version-skewed stranger is a named refusal, not a crash.
 *   - Unknown fields survive. A newer peer's extra key is preserved rather than stripped, so an
 *     older host relaying a frame does not quietly destroy information it did not understand.
 */
import { z } from 'zod';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { isRefusalReason } from '../core/refusal.js';
import type { Frame, JsonValue, WireRefusal } from './frames.js';
import {
  MAX_BULK_RELEASES,
  MAX_CONFIGURATION_VALUE_LENGTH,
  MAX_CONFIGURE_ENTRIES,
  MAX_FRAME_BYTES,
  MAX_PLUGIN_DIRS,
  MAX_REPOSITORY_ENTRIES,
  MAX_REPOSITORY_READ_BYTES,
} from './frames.js';
import { MAX_WORKSPACE_ID_LENGTH } from '../core/workspace-id.js';

/**
 * UTF-8 byte length, the web-standard way.
 *
 * Not `Buffer.byteLength`: `Buffer` is a Node-only global. This module sits inside the
 * `periscope/protocol` closure, whose claim is that a controller can import the wire contract
 * without acquiring a runtime, and the pin guarding that claim reads imports, which a global is
 * invisible to. `TextEncoder` is WHATWG and present in Node, browsers, Deno and Bun.
 *
 * One instance, module-level: `encode` runs per frame and a fresh encoder per call is pure waste.
 */
const UTF8 = new TextEncoder();

function utf8ByteLength(text: string): number {
  return UTF8.encode(text).length;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/**
 * The tolerance is on the decode side only, and it is not a widening of the vocabulary.
 *
 * `reason` is a plain string here rather than `z.enum(REFUSAL_REASONS)`: a closed enum would make
 * a newer peer's added reason fatal, failing the whole `bulk_failed` frame as `frame-malformed`,
 * so a delivery receipt would become unreadable because the failure had a name this build did not
 * know. That would contradict this file's own header: unknown keys survive, and an unknown value
 * of a known key is the same information one level in.
 *
 * What may be written is enforced below in `encode`: this host cannot emit an
 * undeclared reason, checked at the moment a frame becomes bytes rather than trusted to a type. So
 * the pair is strict out, tolerant in. Read the result with `readRefusal`, which narrows a known
 * reason and preserves the raw string for one it has never seen.
 */
const refusalSchema = z.looseObject({
  reason: z.string().min(1),
  detail: z.string(),
});

const sessionCursorSchema = z.looseObject({
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
});

// Each value is host-controlled text on the one frame a controller reads before trusting anything,
// so the cap is enforced at the wire edge rather than left to the reader.
const configurationValueSchema = z.string().max(MAX_CONFIGURATION_VALUE_LENGTH).nullable();

const hostPluginSchema = z.looseObject({
  name: z.string().min(1).max(200),
  version: z.string().max(64).nullable(),
  path: z.string().min(1).max(MAX_CONFIGURATION_VALUE_LENGTH),
});

const hostConfigurationSchema = z.looseObject({
  repositoryRoot: configurationValueSchema,
  workspaceRoot: configurationValueSchema,
  branchScheme: configurationValueSchema,
  transcriptsRoot: configurationValueSchema,
  controllerUrl: configurationValueSchema,
  decisionUrl: configurationValueSchema,
  agentHome: configurationValueSchema,
  plugins: z.array(hostPluginSchema).max(MAX_PLUGIN_DIRS),
});

/** The key names a hello or a configure result lists as pending: config keys, so short and few. */
const pendingRestartSchema = z.array(z.string().min(1).max(64)).max(MAX_CONFIGURE_ENTRIES);

const protocolRangeSchema = z.looseObject({
  min: z.number().int().min(1),
  max: z.number().int().min(1),
});

// `looseObject` throughout: unknown keys are carried, not stripped and not fatal.
/** The members of one release ask, shared by the single kind and the bulk entries. */
const workspaceReleaseEntryShape = {
  workspaceKey: z.string().min(1).nullable(),
  path: z.string().min(1).max(MAX_CONFIGURATION_VALUE_LENGTH).nullable(),
  deleteBranch: z.boolean(),
  force: z.boolean(),
};

/** The members of one release receipt, shared by the single result and the bulk entries. */
const workspaceReleaseEntryResultShape = {
  workspaceKey: z.string().nullable(),
  path: z.string().nullable(),
  directoryRemoved: z.boolean(),
  branchDeleted: z.boolean(),
  refusal: refusalSchema.nullable(),
};

const sessionPayloadSchema = z.discriminatedUnion('kind', [
  // The body is validated as JSON rather than against the transition's shape: this edge exists to
  // keep malformed bytes out, and a newer peer's richer body must survive the crossing rather than
  // be rejected here. The typed union is what a consumer reads it back as.
  z.looseObject({ kind: z.literal('session_update'), body: jsonObjectSchema }),
  z.looseObject({ kind: z.literal('session_delta'), body: jsonObjectSchema }),
  // Every added field is `.nullable()`, never `.optional()`, and that mirrors the type on purpose.
  // JSON has no `undefined`, so an optional field makes "the controller said nothing" and "the
  // controller said unset" the same value after a round trip, the distinction this whole file
  // exists to keep. `looseObject` still carries a newer peer's extra keys across intact.
  //
  // What is not in this schema matters as much: `sessionStore`, `sessionStoreFlush`, `spawn`,
  // `onStderr` and `hooks` have no member here and cannot acquire one, because none of them has a
  // JSON form.
  z.looseObject({
    kind: z.literal('session_new'),
    // Nullable like every other member; null is "the provider decides" (protocol v3). A controller
    // with no cwd to ask for (its host provisions worktrees) sends `null`, and a non-nullable field
    // here would lose the whole frame to a silent decode refusal.
    cwd: z.string().nullable(),
    // Required-and-nullable like every other member, and deliberately not `.default(null)`: a v4
    // frame omitting it must refuse, which is exactly what the v5 version bump announces. Null is
    // "use the session key"; see `SessionNew.workspaceKey` for what a non-null key means.
    workspaceKey: z.string().nullable(),
    correlationId: z.string().nullable(),
    gate: z
      .looseObject({
        decisionTimeoutMs: z.number().int().positive().nullable(),
        holdAfterMs: z.number().int().nonnegative().nullable(),
        matcherTimeoutSeconds: z.number().int().positive().nullable(),
      })
      .nullable(),
    request: z
      .looseObject({
        resume: z.string().min(1).nullable(),
        fork: z.boolean().nullable(),
        settingSources: z.array(z.string()).nullable(),
        plugins: z
          .array(
            z.looseObject({
              type: z.string().min(1),
              path: z.string().min(1),
              skipMcpDiscovery: z.boolean().nullable(),
            }),
          )
          .nullable(),
        // Opaque here and narrowed by the host: the server-config union belongs to the SDK, which
        // this file is structurally forbidden to reach. Keeping it a JSON object is what lets the
        // wire edge stay runtime-agnostic while the host still refuses a shape it cannot use.
        mcpServers: jsonObjectSchema.nullable(),
        strictMcpConfig: z.boolean().nullable(),
        includePartialMessages: z.boolean().nullable(),
        thinking: jsonObjectSchema.nullable(),
        // v6: a plain string each; the host narrows to the SDK's vocabulary and refuses by name.
        effort: z.string().min(1).nullable(),
        permissionMode: z.string().min(1).nullable(),
        forwardSubagentText: z.boolean().nullable(),
        env: z
          .looseObject({
            extraAllowedKeys: z.array(z.string()).nullable(),
            extraDeniedKeys: z.array(z.string()).nullable(),
            extraEnv: z.record(z.string(), z.string()).nullable(),
          })
          .nullable(),
        model: z.string().min(1).nullable(),
        // A string, a list of strings, or a preset object — all three are what the SDK accepts, so
        // the wire carries any JSON value and the host hands it straight through.
        systemPrompt: jsonValueSchema.nullable(),
      })
      .nullable(),
  }),
  z.looseObject({ kind: z.literal('session_prompt'), text: z.string() }),
  z.looseObject({ kind: z.literal('session_cancel') }),
  // v6: live model / permission mode / thinking. Every member nullable — null is "not asked".
  z.looseObject({
    kind: z.literal('session_configure'),
    model: z.string().min(1).nullable(),
    permissionMode: z.string().min(1).nullable(),
    thinking: jsonObjectSchema.nullable(),
  }),
  z.looseObject({
    kind: z.literal('bulk_request'),
    deliveryId: z.string().min(1),
    what: z.string(),
    fromOffset: z.number().int().nonnegative(),
    postUrl: z.string().min(1),
  }),
  z.looseObject({
    kind: z.literal('bulk_delivered'),
    deliveryId: z.string().min(1),
    byteCount: z.number().int().nonnegative(),
    // The stat pair for rewrite detection. `.nullable()` never `.optional()`, but absent is
    // also tolerated here (`.default(null)`), because a v3 peer's receipt legitimately omits keys
    // it has never heard of, and destroying a delivery receipt over two unknowns would repeat the
    // exact failure the refusal-reason tolerance above exists to prevent.
    sizeBytes: z.number().int().nonnegative().nullable().default(null),
    mtimeMs: z.number().int().nonnegative().nullable().default(null),
  }),
  z.looseObject({
    kind: z.literal('bulk_failed'),
    deliveryId: z.string().min(1),
    refusal: refusalSchema,
  }),
  // Discovery. Every added optional is `.nullable()`, never `.optional()`, per the rule above.
  z.looseObject({
    kind: z.literal('session_list'),
    requestId: z.string().min(1),
  }),
  z.looseObject({
    kind: z.literal('session_list_result'),
    requestId: z.string().min(1),
    sessions: z.array(
      z.looseObject({
        sessionKey: z.string().min(1),
        sessionId: z.string().nullable(),
        state: z.string().min(1),
        cwd: z.string().nullable(),
        startedAt: z.string().nullable(),
      }),
    ),
    liveCount: z.number().int().nonnegative(),
    provisioningCount: z.number().int().nonnegative(),
  }),
  z.looseObject({
    kind: z.literal('transcript_list'),
    requestId: z.string().min(1),
    fromIndex: z.number().int().nonnegative(),
  }),
  z.looseObject({
    kind: z.literal('transcript_list_result'),
    requestId: z.string().min(1),
    entries: z.array(
      z.looseObject({
        projectSlug: z.string().min(1),
        sessionId: z.string().min(1),
        sizeBytes: z.number().int().nonnegative(),
        mtimeMs: z.number().int().nonnegative(),
        cwd: z.string().nullable().default(null),
      }),
    ),
    totalCount: z.number().int().nonnegative(),
    nextIndex: z.number().int().nonnegative().nullable(),
  }),
  z.looseObject({
    kind: z.literal('transcript_tail'),
    requestId: z.string().min(1),
    projectSlug: z.string().min(1),
    sessionId: z.string().min(1),
    fromOffset: z.number().int().nonnegative(),
    needle: z.string().nullable(),
  }),
  z.looseObject({
    kind: z.literal('transcript_tail_result'),
    requestId: z.string().min(1),
    found: z.boolean(),
    absent: z.boolean(),
    newOffset: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    mtimeMs: z.number().int().nonnegative().nullable(),
  }),
  z.looseObject({
    kind: z.literal('transcript_failed'),
    requestId: z.string().min(1),
    refusal: refusalSchema,
  }),
  // The answer that could not be sent (v10): one kind for every host-scoped ask, matched on the
  // request id. Always small, so it is the one answer the frame cap cannot refuse.
  z.looseObject({
    kind: z.literal('answer_refused'),
    requestId: z.string().min(1),
    refusal: refusalSchema,
  }),
  // The reap (v5; the flags, the path address and the receipt from v7). Host-scoped like the
  // discovery asks; the result's `refusal` is nullable because null is the released answer: one
  // kind for every exit, see `WorkspaceReleaseResult`. Key-or-path is the HOST's screen, not the
  // codec's: both or neither is a well-formed frame refused by name, never a malformed one.
  z.looseObject({
    kind: z.literal('workspace_release'),
    requestId: z.string().min(1),
    ...workspaceReleaseEntryShape,
  }),
  z.looseObject({
    kind: z.literal('workspace_release_result'),
    requestId: z.string().min(1),
    ...workspaceReleaseEntryResultShape,
  }),
  z.looseObject({
    kind: z.literal('workspace_release_bulk'),
    requestId: z.string().min(1),
    releases: z.array(z.looseObject(workspaceReleaseEntryShape)).min(1).max(MAX_BULK_RELEASES),
  }),
  z.looseObject({
    kind: z.literal('workspace_release_bulk_result'),
    requestId: z.string().min(1),
    results: z.array(z.looseObject(workspaceReleaseEntryResultShape)).max(MAX_BULK_RELEASES),
  }),
  // The configure pair. Host-scoped like the reap; the result's `refusal` is nullable because
  // null is the applied answer, and the effective configuration rides every exit.
  z.looseObject({
    kind: z.literal('host_configure'),
    requestId: z.string().min(1),
    entries: z
      .array(z.looseObject({ key: z.string().min(1).max(64), value: configurationValueSchema }))
      .min(1)
      .max(MAX_CONFIGURE_ENTRIES),
  }),
  z.looseObject({
    kind: z.literal('host_configure_result'),
    requestId: z.string().min(1),
    configuration: hostConfigurationSchema,
    overriddenByEnvironment: z.array(z.string()),
    pendingRestart: pendingRestartSchema,
    refusal: refusalSchema.nullable(),
  }),
  // The inventory. Host-scoped and paged like `transcript_list`; the result carries the
  // refusal so every exit is one kind.
  z.looseObject({
    kind: z.literal('workspace_list'),
    requestId: z.string().min(1),
    fromIndex: z.number().int().nonnegative(),
  }),
  z.looseObject({
    kind: z.literal('workspace_list_result'),
    requestId: z.string().min(1),
    entries: z.array(
      z.looseObject({
        key: z.string().min(1).max(MAX_WORKSPACE_ID_LENGTH),
        path: z.string().min(1).max(MAX_CONFIGURATION_VALUE_LENGTH),
        branch: z.string().max(400).nullable(),
        head: z.string().max(64).nullable(),
        detached: z.boolean(),
        locked: z.boolean(),
        prunable: z.boolean(),
        merged: z.boolean().nullable(),
        aheadCount: z.number().int().nonnegative().nullable(),
        lastCommitAt: z.string().nullable(),
      }),
    ),
    totalCount: z.number().int().nonnegative(),
    nextIndex: z.number().int().nonnegative().nullable(),
    defaultBranch: z.string().max(400).nullable(),
    refusal: refusalSchema.nullable(),
  }),
  // The repository read. Host-scoped like `transcript_list`; both results carry the refusal so
  // every exit is one kind. The path is relative text the HOST jails; the codec bounds its length.
  z.looseObject({
    kind: z.literal('repository_list'),
    requestId: z.string().min(1),
    path: z.string().max(MAX_CONFIGURATION_VALUE_LENGTH),
  }),
  z.looseObject({
    kind: z.literal('repository_list_result'),
    requestId: z.string().min(1),
    entries: z
      .array(
        z.looseObject({
          name: z.string().min(1).max(255),
          directory: z.boolean(),
          sizeBytes: z.number().int().nonnegative(),
          mtimeMs: z.number().int().nonnegative(),
        }),
      )
      .max(MAX_REPOSITORY_ENTRIES),
    truncated: z.boolean(),
    refusal: refusalSchema.nullable(),
  }),
  z.looseObject({
    kind: z.literal('repository_read'),
    requestId: z.string().min(1),
    path: z.string().min(1).max(MAX_CONFIGURATION_VALUE_LENGTH),
    maxBytes: z.number().int().min(1).max(MAX_REPOSITORY_READ_BYTES),
  }),
  z.looseObject({
    kind: z.literal('repository_read_result'),
    requestId: z.string().min(1),
    text: z.string().nullable(),
    sizeBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    refusal: refusalSchema.nullable(),
  }),
]);

const controlPayloadSchema = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('link_hello'),
    protocolVersion: z.number().int(),
    hostId: z.string().min(1),
    capabilities: z.array(z.string()),
    cursors: z.array(sessionCursorSchema),
    configuration: hostConfigurationSchema,
    pendingRestart: pendingRestartSchema,
    protocolRange: protocolRangeSchema,
  }),
  z.looseObject({
    kind: z.literal('link_welcome'),
    protocolVersion: z.number().int(),
    // Absent from a version-9 controller; read as null, never refused (v10).
    protocolRange: protocolRangeSchema.nullable().default(null),
    capabilities: z.array(z.string()),
    cursors: z.array(sessionCursorSchema),
  }),
  z.looseObject({ kind: z.literal('link_ack'), cursors: z.array(sessionCursorSchema) }),
  z.looseObject({ kind: z.literal('link_ping'), nonce: z.string() }),
  z.looseObject({ kind: z.literal('link_pong'), nonce: z.string() }),
  z.looseObject({ kind: z.literal('link_bye'), cause: z.string() }),
]);

const frameSchema = z.discriminatedUnion('frame', [
  z.looseObject({
    frame: z.literal('session'),
    sessionId: z.string().min(1),
    // Dense from 1. Zero would make "no frames yet" and "the first frame" the same value.
    seq: z.number().int().positive(),
    at: z.string().min(1),
    payload: sessionPayloadSchema,
  }),
  z.looseObject({
    frame: z.literal('control'),
    at: z.string().min(1),
    payload: controlPayloadSchema,
  }),
]);

/**
 * A frame to a wire string.
 *
 * Refuses a frame that does not match the shape `decode` accepts, with the same per-kind schema, so
 * a malformed frame is refused at the caller and never minted a sequence number; a frame that only
 * the peer refused would burn a number the receiver then waits on. Refuses anything past
 * MAX_FRAME_BYTES, naming the bulk lane — this is the enforcement point for "commands only, never
 * payloads", so the check is here rather than at each call site that might forget it.
 */
export function encode(frame: Frame): Result<string> {
  // The producer-closed half, enforced here rather than by a type. `refusal()` takes a
  // `RefusalReason`, which is a compile-time guarantee a single `as` defeats. This is the one
  // place a frame becomes bytes, so checking here makes "nothing this host emits carries an
  // undeclared reason" true by construction. Two mechanisms, one invariant.
  const undeclared = undeclaredRefusalReason(frame);
  if (undeclared !== null) {
    return refuse(
      'frame-malformed',
      `refusal reason "${undeclared}" is not one this host declares — the wire tolerates an ` +
        `unknown reason on the way IN, but this host may not invent one on the way OUT; add it to ` +
        `REFUSAL_REASONS`,
    );
  }

  const shape = frameSchema.safeParse(frame);
  if (!shape.success) {
    return refuse(
      'frame-malformed',
      `frame does not match its declared shape: ${shape.error.issues.map(describeIssue).join('; ')}`,
    );
  }

  let text: string;
  try {
    text = JSON.stringify(frame);
  } catch (error) {
    return refuse('frame-malformed', `frame is not serializable: ${describe(error)}`);
  }

  const byteCount = utf8ByteLength(text);
  if (byteCount > MAX_FRAME_BYTES) {
    return refuse(
      'frame-too-large',
      `frame is ${byteCount} bytes, over the ${MAX_FRAME_BYTES} limit — bulk content does not ride ` +
        `the link; request it with bulk_request and answer on the bulk-post lane`,
    );
  }

  return ok(text);
}

/** A wire string to a frame. Never throws: every failure path returns a named refusal. */
export function decode(raw: string): Result<Frame> {
  const byteCount = utf8ByteLength(raw);
  if (byteCount > MAX_FRAME_BYTES) {
    return refuse(
      'frame-too-large',
      `received ${byteCount} bytes, over the ${MAX_FRAME_BYTES} limit — bulk content does not ride ` +
        `the link; request it with bulk_request and answer on the bulk-post lane`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return refuse('frame-not-json', `not JSON: ${describe(error)}`);
  }

  const result = frameSchema.safeParse(parsed);
  if (!result.success) {
    return refuse('frame-malformed', result.error.issues.map(describeIssue).join('; '));
  }

  return ok(result.data as Frame);
}

/**
 * The reason on an outgoing refusal-carrying payload when this host does not declare it, else null.
 * Covers every kind that carries one: `bulk_failed`, `transcript_failed`, the result kinds whose
 * `refusal` is non-null, every entry of a bulk release answer, and the `wire_refusal` member of a
 * `session_update` body (opaque JSON to the schema, so it is read here by hand) — so no door can
 * invent a word on the way out.
 */
function undeclaredRefusalReason(frame: Frame): string | null {
  if (frame.frame !== 'session') return null;
  const payload = frame.payload;
  let carried: readonly (WireRefusal | null)[];
  if (payload.kind === 'session_update') {
    const body = payload.body as { update?: unknown; refusal?: unknown };
    if (body.update !== 'wire_refusal' || typeof body.refusal !== 'object' || body.refusal === null)
      return null;
    const reason = (body.refusal as { reason?: unknown }).reason;
    return typeof reason === 'string' && !isRefusalReason(reason) ? reason : null;
  }
  switch (payload.kind) {
    case 'bulk_failed':
    case 'transcript_failed':
    case 'workspace_release_result':
    case 'host_configure_result':
    case 'workspace_list_result':
    case 'repository_list_result':
    case 'repository_read_result':
      carried = [payload.refusal];
      break;
    case 'workspace_release_bulk_result':
      carried = payload.results.map((result) => result.refusal);
      break;
    default:
      return null;
  }
  for (const refusal of carried) {
    if (refusal !== null && !isRefusalReason(refusal.reason)) return refusal.reason;
  }
  return null;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
