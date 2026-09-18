/**
 * The codec under generated frames.
 *
 * The hand-picked round trips in codec.test.ts pin particular shapes; these generalise them. Every
 * payload kind the wire declares has a generator in one map keyed by kind, and the map
 * `satisfies Record<SessionPayloadKind, ...>`, so a kind added to the union without a generator
 * here does not compile. The runtime half of that guarantee is the last test: the map's key set is
 * exactly the set of kinds `decode` accepts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { propertyRuns } from '../test-support/property.js';

import { decode, encode } from './codec.js';
import {
  MAX_BULK_RELEASES,
  MAX_FRAME_BYTES,
  MAX_REPOSITORY_READ_BYTES,
  PROTOCOL_VERSION,
  unsetHostConfiguration,
} from './frames.js';
import type {
  ControlFrame,
  ControlPayload,
  ControlPayloadKind,
  Frame,
  JsonObject,
  JsonValue,
  SessionCursor,
  SessionFrame,
  SessionPayload,
  SessionPayloadKind,
  WireRefusal,
} from './frames.js';
import { REFUSAL_REASONS, isRefusalReason } from '../core/refusal.js';

const RUNS = propertyRuns();

/** The reasons the codec itself can answer with. Closed; anything else is a codec defect. */
const CODEC_REASONS: ReadonlySet<string> = new Set(['frame-not-json', 'frame-malformed', 'frame-too-large']);

// ---------------------------------------------------------------------------
// Leaf arbitraries.
// ---------------------------------------------------------------------------

/**
 * A key named `__proto__` does not survive decode: the schema assembles objects by assignment, so an
 * own `__proto__` member is dropped rather than becoming a prototype. That is prototype-pollution
 * hygiene, pinned below, and the generators exclude the key so the round-trip claim stays about
 * ordinary members.
 */
const carriesProtoKey = (value: unknown): boolean => /"__proto__"\s*:/.test(JSON.stringify(value));

/** A JSON value as it comes back from a round trip: -0 has become 0, which is the wire's value. */
const jsonValueArb: fc.Arbitrary<JsonValue> = fc
  .jsonValue({ maxDepth: 3 })
  .filter((value) => !carriesProtoKey(value))
  .map((value) => JSON.parse(JSON.stringify(value)) as JsonValue);

const jsonObjectArb: fc.Arbitrary<JsonObject> = fc
  .dictionary(
    fc.string().filter((key) => key !== '__proto__'),
    jsonValueArb,
    { maxKeys: 4, noNullPrototype: true },
  )
  .map((value) => JSON.parse(JSON.stringify(value)) as JsonObject);

const nonEmptyString = fc.string({ minLength: 1 });
const nullable = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | null> => fc.option(arb, { nil: null });
const nonNegative = fc.integer({ min: 0 });
const positive = fc.integer({ min: 1 });
const isoDate = fc.date({ noInvalidDate: true }).map((date) => date.toISOString());
const declaredReason = fc.constantFrom(...REFUSAL_REASONS);

const wireRefusalArb: fc.Arbitrary<WireRefusal> = fc.record({ reason: declaredReason, detail: fc.string() });

const cursorArb: fc.Arbitrary<SessionCursor> = fc.record({ sessionId: nonEmptyString, seq: nonNegative });

const sessionNewRequestArb = fc.record({
  resume: nullable(nonEmptyString),
  fork: nullable(fc.boolean()),
  settingSources: nullable(fc.array(fc.string(), { maxLength: 3 })),
  plugins: nullable(
    fc.array(
      fc.record({ type: nonEmptyString, path: nonEmptyString, skipMcpDiscovery: nullable(fc.boolean()) }),
      {
        maxLength: 2,
      },
    ),
  ),
  mcpServers: nullable(jsonObjectArb),
  strictMcpConfig: nullable(fc.boolean()),
  includePartialMessages: nullable(fc.boolean()),
  thinking: nullable(jsonObjectArb),
  effort: nullable(nonEmptyString),
  permissionMode: nullable(nonEmptyString),
  forwardSubagentText: nullable(fc.boolean()),
  env: nullable(
    fc.record({
      extraAllowedKeys: nullable(fc.array(fc.string(), { maxLength: 3 })),
      extraDeniedKeys: nullable(fc.array(fc.string(), { maxLength: 3 })),
      extraEnv: nullable(fc.dictionary(fc.string(), fc.string(), { maxKeys: 3, noNullPrototype: true })),
    }),
  ),
  model: nullable(nonEmptyString),
  systemPrompt: nullable(jsonValueArb),
});

// ---------------------------------------------------------------------------
// One generator per payload kind. A kind missing here is a compile error.
// ---------------------------------------------------------------------------

/** The release ask's members, shared by the single kind and the bulk entries. */
const releaseEntryShape = {
  workspaceKey: nullable(nonEmptyString),
  path: nullable(nonEmptyString),
  deleteBranch: fc.boolean(),
  force: fc.boolean(),
};

/** The release receipt's members, shared by the single result and the bulk entries. */
const releaseEntryResultShape = {
  workspaceKey: nullable(fc.string()),
  path: nullable(fc.string()),
  directoryRemoved: fc.boolean(),
  branchDeleted: fc.boolean(),
  refusal: nullable(wireRefusalArb),
};

const sessionPayloadArbs = {
  session_update: fc.record({ kind: fc.constant('session_update' as const), body: jsonObjectArb }),
  session_delta: fc.record({ kind: fc.constant('session_delta' as const), body: jsonObjectArb }),
  session_new: fc.record({
    kind: fc.constant('session_new' as const),
    cwd: nullable(fc.string()),
    workspaceKey: nullable(fc.string()),
    correlationId: nullable(fc.string()),
    request: nullable(sessionNewRequestArb),
    gate: nullable(
      fc.record({
        decisionTimeoutMs: nullable(positive),
        holdAfterMs: nullable(nonNegative),
        matcherTimeoutSeconds: nullable(positive),
      }),
    ),
  }),
  session_prompt: fc.record({ kind: fc.constant('session_prompt' as const), text: fc.string() }),
  session_cancel: fc.record({ kind: fc.constant('session_cancel' as const) }),
  session_configure: fc.record({
    kind: fc.constant('session_configure' as const),
    model: nullable(nonEmptyString),
    permissionMode: nullable(nonEmptyString),
    thinking: nullable(jsonObjectArb),
  }),
  bulk_request: fc.record({
    kind: fc.constant('bulk_request' as const),
    deliveryId: nonEmptyString,
    what: fc.string(),
    fromOffset: nonNegative,
    postUrl: nonEmptyString,
  }),
  bulk_delivered: fc.record({
    kind: fc.constant('bulk_delivered' as const),
    deliveryId: nonEmptyString,
    byteCount: nonNegative,
    sizeBytes: nullable(nonNegative),
    mtimeMs: nullable(nonNegative),
  }),
  bulk_failed: fc.record({
    kind: fc.constant('bulk_failed' as const),
    deliveryId: nonEmptyString,
    refusal: wireRefusalArb,
  }),
  session_list: fc.record({ kind: fc.constant('session_list' as const), requestId: nonEmptyString }),
  session_list_result: fc.record({
    kind: fc.constant('session_list_result' as const),
    requestId: nonEmptyString,
    sessions: fc.array(
      fc.record({
        sessionKey: nonEmptyString,
        sessionId: nullable(fc.string()),
        state: nonEmptyString,
        cwd: nullable(fc.string()),
        startedAt: nullable(fc.string()),
      }),
      { maxLength: 3 },
    ),
    liveCount: nonNegative,
    provisioningCount: nonNegative,
  }),
  transcript_list: fc.record({
    kind: fc.constant('transcript_list' as const),
    requestId: nonEmptyString,
    fromIndex: nonNegative,
  }),
  transcript_list_result: fc.record({
    kind: fc.constant('transcript_list_result' as const),
    requestId: nonEmptyString,
    entries: fc.array(
      fc.record({
        projectSlug: nonEmptyString,
        sessionId: nonEmptyString,
        sizeBytes: nonNegative,
        mtimeMs: nonNegative,
        cwd: nullable(fc.string()),
      }),
      { maxLength: 3 },
    ),
    totalCount: nonNegative,
    nextIndex: nullable(nonNegative),
  }),
  transcript_tail: fc.record({
    kind: fc.constant('transcript_tail' as const),
    requestId: nonEmptyString,
    projectSlug: nonEmptyString,
    sessionId: nonEmptyString,
    fromOffset: nonNegative,
    needle: nullable(fc.string()),
  }),
  transcript_tail_result: fc.record({
    kind: fc.constant('transcript_tail_result' as const),
    requestId: nonEmptyString,
    found: fc.boolean(),
    absent: fc.boolean(),
    newOffset: nonNegative,
    sizeBytes: nullable(nonNegative),
    mtimeMs: nullable(nonNegative),
  }),
  transcript_failed: fc.record({
    kind: fc.constant('transcript_failed' as const),
    requestId: nonEmptyString,
    refusal: wireRefusalArb,
  }),
  answer_refused: fc.record({
    kind: fc.constant('answer_refused' as const),
    requestId: nonEmptyString,
    refusal: wireRefusalArb,
  }),
  workspace_release: fc.record({
    kind: fc.constant('workspace_release' as const),
    requestId: nonEmptyString,
    ...releaseEntryShape,
  }),
  workspace_release_result: fc.record({
    kind: fc.constant('workspace_release_result' as const),
    requestId: nonEmptyString,
    ...releaseEntryResultShape,
  }),
  workspace_release_bulk: fc.record({
    kind: fc.constant('workspace_release_bulk' as const),
    requestId: nonEmptyString,
    releases: fc.array(fc.record(releaseEntryShape), { minLength: 1, maxLength: MAX_BULK_RELEASES }),
  }),
  workspace_release_bulk_result: fc.record({
    kind: fc.constant('workspace_release_bulk_result' as const),
    requestId: nonEmptyString,
    results: fc.array(fc.record(releaseEntryResultShape), { maxLength: MAX_BULK_RELEASES }),
  }),
  host_configure: fc.record({
    kind: fc.constant('host_configure' as const),
    requestId: nonEmptyString,
    entries: fc.array(
      fc.record({
        key: fc.string({ minLength: 1, maxLength: 32 }),
        value: nullable(fc.string({ maxLength: 40 })),
      }),
      { minLength: 1, maxLength: 8 },
    ),
  }),
  host_configure_result: fc.record({
    kind: fc.constant('host_configure_result' as const),
    requestId: nonEmptyString,
    configuration: fc.record({
      repositoryRoot: nullable(fc.string({ maxLength: 40 })),
      workspaceRoot: nullable(fc.string({ maxLength: 40 })),
      branchScheme: nullable(fc.string({ maxLength: 40 })),
      transcriptsRoot: nullable(fc.string({ maxLength: 40 })),
      controllerUrl: nullable(fc.string({ maxLength: 40 })),
      decisionUrl: nullable(fc.string({ maxLength: 40 })),
      agentHome: nullable(fc.string({ maxLength: 40 })),
    }),
    overriddenByEnvironment: fc.array(fc.string({ maxLength: 32 }), { maxLength: 4 }),
    pendingRestart: fc.array(nonEmptyString, { maxLength: 2 }),
    refusal: nullable(wireRefusalArb),
  }),
  workspace_list: fc.record({
    kind: fc.constant('workspace_list' as const),
    requestId: nonEmptyString,
    fromIndex: nonNegative,
  }),
  workspace_list_result: fc.record({
    kind: fc.constant('workspace_list_result' as const),
    requestId: nonEmptyString,
    entries: fc.array(
      fc.record({
        key: fc.string({ minLength: 1, maxLength: 40 }),
        path: fc.string({ minLength: 1, maxLength: 60 }),
        branch: nullable(fc.string({ maxLength: 40 })),
        head: nullable(fc.string({ maxLength: 40 })),
        detached: fc.boolean(),
        locked: fc.boolean(),
        prunable: fc.boolean(),
        merged: nullable(fc.boolean()),
        aheadCount: nullable(fc.nat({ max: 100000 })),
        lastCommitAt: nullable(fc.string({ maxLength: 40 })),
      }),
      { maxLength: 3 },
    ),
    totalCount: nonNegative,
    nextIndex: nullable(nonNegative),
    defaultBranch: nullable(fc.string({ maxLength: 40 })),
    refusal: nullable(wireRefusalArb),
  }),
  repository_list: fc.record({
    kind: fc.constant('repository_list' as const),
    requestId: nonEmptyString,
    path: fc.string({ maxLength: 40 }),
  }),
  repository_list_result: fc.record({
    kind: fc.constant('repository_list_result' as const),
    requestId: nonEmptyString,
    entries: fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 40 }),
        directory: fc.boolean(),
        sizeBytes: nonNegative,
        mtimeMs: nonNegative,
      }),
      { maxLength: 4 },
    ),
    truncated: fc.boolean(),
    refusal: nullable(wireRefusalArb),
  }),
  repository_read: fc.record({
    kind: fc.constant('repository_read' as const),
    requestId: nonEmptyString,
    path: fc.string({ minLength: 1, maxLength: 40 }),
    maxBytes: fc.integer({ min: 1, max: MAX_REPOSITORY_READ_BYTES }),
  }),
  repository_read_result: fc.record({
    kind: fc.constant('repository_read_result' as const),
    requestId: nonEmptyString,
    text: nullable(fc.string({ maxLength: 80 })),
    sizeBytes: nonNegative,
    truncated: fc.boolean(),
    refusal: nullable(wireRefusalArb),
  }),
} satisfies Record<SessionPayloadKind, fc.Arbitrary<SessionPayload>>;

const controlPayloadArbs = {
  link_hello: fc.record({
    kind: fc.constant('link_hello' as const),
    protocolVersion: fc.constantFrom(PROTOCOL_VERSION, 1, 99),
    hostId: nonEmptyString,
    capabilities: fc.array(fc.string(), { maxLength: 3 }),
    cursors: fc.array(cursorArb, { maxLength: 3 }),
    configuration: fc.record({
      repositoryRoot: nullable(fc.string({ maxLength: 40 })),
      workspaceRoot: nullable(fc.string({ maxLength: 40 })),
      branchScheme: nullable(fc.string({ maxLength: 40 })),
      transcriptsRoot: nullable(fc.string({ maxLength: 40 })),
      controllerUrl: nullable(fc.string({ maxLength: 40 })),
      decisionUrl: nullable(fc.string({ maxLength: 40 })),
      agentHome: nullable(fc.string({ maxLength: 40 })),
    }),
    pendingRestart: fc.array(nonEmptyString, { maxLength: 2 }),
    protocolRange: fc.record({ min: fc.integer({ min: 1, max: 20 }), max: fc.integer({ min: 1, max: 20 }) }),
  }),
  link_welcome: fc.record({
    kind: fc.constant('link_welcome' as const),
    protocolVersion: fc.constantFrom(PROTOCOL_VERSION, 1, 99),
    protocolRange: nullable(
      fc.record({ min: fc.integer({ min: 1, max: 20 }), max: fc.integer({ min: 1, max: 20 }) }),
    ),
    capabilities: fc.array(fc.string(), { maxLength: 3 }),
    cursors: fc.array(cursorArb, { maxLength: 3 }),
  }),
  link_ack: fc.record({
    kind: fc.constant('link_ack' as const),
    cursors: fc.array(cursorArb, { maxLength: 3 }),
  }),
  link_ping: fc.record({ kind: fc.constant('link_ping' as const), nonce: fc.string() }),
  link_pong: fc.record({ kind: fc.constant('link_pong' as const), nonce: fc.string() }),
  link_bye: fc.record({ kind: fc.constant('link_bye' as const), cause: fc.string() }),
} satisfies Record<ControlPayloadKind, fc.Arbitrary<ControlPayload>>;

const SESSION_KINDS = Object.keys(sessionPayloadArbs) as SessionPayloadKind[];
const byKind = sessionPayloadArbs as Record<SessionPayloadKind, fc.Arbitrary<SessionPayload>>;

const sessionPayloadArb: fc.Arbitrary<SessionPayload> = fc.oneof(
  ...(Object.values(sessionPayloadArbs) as fc.Arbitrary<SessionPayload>[]),
);
const controlPayloadArb: fc.Arbitrary<ControlPayload> = fc.oneof(
  ...(Object.values(controlPayloadArbs) as fc.Arbitrary<ControlPayload>[]),
);

/**
 * Non-ASCII text, and text built from the units JSON and UTF-8 treat specially: surrogate halves,
 * a real pair, multi-byte characters, structural characters and escapes.
 */
const anyUnicodeString = fc.oneof(
  fc.string({ unit: 'grapheme' }),
  fc.string({
    unit: fc.constantFrom(
      '\ud83d',
      '\udc00',
      '\u{1F600}',
      'é',
      '\u2192',
      '"',
      '\\',
      '{',
      '}',
      '[',
      ']',
      ':',
      ',',
      '\n',
      ' ',
    ),
  }),
);

const sessionFrameArb: fc.Arbitrary<SessionFrame> = fc.record({
  frame: fc.constant('session' as const),
  sessionId: nonEmptyString,
  seq: positive,
  at: isoDate,
  payload: sessionPayloadArb,
});

const controlFrameArb: fc.Arbitrary<ControlFrame> = fc.record({
  frame: fc.constant('control' as const),
  at: isoDate,
  payload: controlPayloadArb,
});

/**
 * A frame as the wire would hand it over: a JSON round trip gives every object the plain prototype
 * a decoded frame has (fast-check's records may carry a null one) and folds -0 to 0.
 */
const frameArb: fc.Arbitrary<Frame> = fc
  .oneof(sessionFrameArb, controlFrameArb)
  .map((frame) => JSON.parse(JSON.stringify(frame)) as Frame);

function sessionFrameOf(payload: SessionPayload): SessionFrame {
  return { frame: 'session', sessionId: 's-1', seq: 1, at: '2026-01-01T00:00:00.000Z', payload };
}

// ---------------------------------------------------------------------------

test('every generated frame survives encode then decode unchanged', () => {
  fc.assert(
    fc.property(frameArb, (frame) => {
      const encoded = encode(frame);
      // A generated body can exceed the size cap; that tail is the size gate's business, not this.
      fc.pre(encoded.ok);
      const decoded = decode(encoded.value);
      assert.ok(
        decoded.ok,
        `decode refused a frame this host encoded: ${decoded.ok ? '' : decoded.refusal.detail}`,
      );
      assert.deepEqual(decoded.value, frame);
    }),
    RUNS,
  );
});

test("decode never throws on any string, and every refusal is one of the codec's own reasons", () => {
  const inputs = fc.oneof(
    fc.string(),
    anyUnicodeString,
    fc.jsonValue().map((value) => JSON.stringify(value)),
    // Near misses: a real frame with one key removed or one value replaced.
    fc.tuple(frameArb, fc.nat(), jsonValueArb, fc.boolean()).map(([frame, pick, value, remove]) => {
      const keys = Object.keys(frame);
      const key = keys[pick % keys.length] as string;
      const copy: Record<string, unknown> = { ...frame };
      if (remove) delete copy[key];
      else copy[key] = value;
      return JSON.stringify(copy);
    }),
  );
  fc.assert(
    fc.property(inputs, (raw) => {
      const decoded = decode(raw);
      if (!decoded.ok) {
        assert.ok(
          CODEC_REASONS.has(decoded.refusal.reason),
          `decode answered with a reason that is not the codec's: ${decoded.refusal.reason}`,
        );
      }
    }),
    RUNS,
  );
});

test('the size gate refuses on the way in exactly when the wire text is over the limit', () => {
  fc.assert(
    fc.property(frameArb, (frame) => {
      const text = JSON.stringify(frame);
      const bytes = new TextEncoder().encode(text).length;
      const decoded = decode(text);
      if (bytes > MAX_FRAME_BYTES) {
        assert.equal(decoded.ok, false);
        if (!decoded.ok) assert.equal(decoded.refusal.reason, 'frame-too-large');
      } else {
        assert.ok(decoded.ok, 'a frame inside the limit was refused');
      }
    }),
    RUNS,
  );
});

/** Is this a key that collides with nothing the target already carries, and cannot alias the prototype? */
const isUnknownKeyFor = (target: object, key: string): boolean =>
  key !== '__proto__' && !Object.hasOwn(target, key);

const unknownKey = fc.string({ minLength: 1 }).filter((key) => key !== '__proto__');

test('deliberate: a body member named __proto__ is dropped by decode and never becomes a prototype', () => {
  const wire =
    '{"frame":"session","sessionId":"s","seq":1,"at":"1970-01-01T00:00:00.000Z","payload":{"kind":"session_delta","body":{"__proto__":{"polluted":true},"x":1}}}';
  const decoded = decode(wire);
  assert.ok(decoded.ok);
  const body = (decoded.value.payload as { body: JsonObject }).body;
  assert.equal(
    Object.prototype.hasOwnProperty.call(body, '__proto__'),
    false,
    'the member must not survive as an own key',
  );
  assert.equal(Object.getPrototypeOf(body), Object.prototype, 'the member must not become the prototype');
  assert.equal(body['x'], 1, 'ordinary members survive beside it');
});

test('an unknown key injected at frame, payload and request level survives decode intact', () => {
  fc.assert(
    fc.property(
      fc.tuple(frameArb, unknownKey, unknownKey, jsonValueArb),
      ([frame, frameKey, payloadKey, value]) => {
        fc.pre(isUnknownKeyFor(frame, frameKey) && isUnknownKeyFor(frame.payload, payloadKey));
        const injected = {
          ...frame,
          [frameKey]: value,
          payload: { ...frame.payload, [payloadKey]: value },
        };
        const encoded = encode(injected as unknown as Frame);
        fc.pre(encoded.ok);
        const decoded = decode(encoded.value);
        assert.ok(decoded.ok, 'an unknown key must not fail the parse');
        const out = decoded.value as unknown as Record<string, unknown>;
        assert.deepEqual(out[frameKey], value, 'the frame-level key was stripped');
        assert.deepEqual(
          (out['payload'] as Record<string, unknown>)[payloadKey],
          value,
          'the payload-level key was stripped',
        );
      },
    ),
    RUNS,
  );
});

test('an unknown key inside session_new.request survives decode intact', () => {
  const requested = sessionPayloadArbs.session_new.filter((payload) => payload.request !== null);
  fc.assert(
    fc.property(fc.tuple(requested, unknownKey, jsonValueArb), ([payload, key, value]) => {
      fc.pre(isUnknownKeyFor(payload.request as object, key));
      const injected = { ...payload, request: { ...(payload.request as object), [key]: value } };
      const encoded = encode(sessionFrameOf(injected as unknown as SessionPayload));
      fc.pre(encoded.ok);
      const decoded = decode(encoded.value);
      assert.ok(decoded.ok);
      const request = (
        (decoded.value as SessionFrame).payload as unknown as { request: Record<string, unknown> }
      ).request;
      assert.deepEqual(request[key], value, 'the request-level key was stripped');
    }),
    RUNS,
  );
});

test('a refusal reason this host does not declare never encodes through the result kinds or the wire_refusal body', () => {
  const undeclared = fc.string().filter((reason) => !isRefusalReason(reason));
  const carrier = fc
    .tuple(
      undeclared,
      fc.string(),
      fc.constantFrom(
        'host_configure_result',
        'workspace_list_result',
        'repository_list_result',
        'repository_read_result',
        'wire_refusal',
      ),
    )
    .map(([reason, detail, kind]): SessionPayload => {
      const refusal = { reason, detail };
      switch (kind) {
        case 'host_configure_result':
          return {
            kind,
            requestId: 'req-1',
            configuration: unsetHostConfiguration(),
            overriddenByEnvironment: [],
            pendingRestart: [],
            refusal,
          };
        case 'workspace_list_result':
          return {
            kind,
            requestId: 'req-1',
            entries: [],
            totalCount: 0,
            nextIndex: null,
            defaultBranch: null,
            refusal,
          };
        case 'repository_list_result':
          return { kind, requestId: 'req-1', entries: [], truncated: false, refusal };
        case 'repository_read_result':
          return { kind, requestId: 'req-1', text: null, sizeBytes: 0, truncated: false, refusal };
        default:
          return {
            kind: 'session_update',
            body: { update: 'wire_refusal', refusal, expected: 1, received: 2 },
          };
      }
    });
  fc.assert(
    fc.property(carrier, (payload) => {
      const encoded = encode({
        frame: 'session',
        sessionId: 's-1',
        seq: 1,
        at: '2000-01-01T00:00:00.000Z',
        payload,
      });
      assert.equal(encoded.ok, false, `an undeclared reason encoded through ${payload.kind}`);
      if (!encoded.ok) assert.equal(encoded.refusal.reason, 'frame-malformed');
    }),
    RUNS,
  );
});

test('a frame decode would refuse is refused by encode first, with the same reason, and never reaches the wire', () => {
  const malformed = fc.constantFrom<[string, unknown]>(
    [
      'seq 0',
      {
        frame: 'session',
        sessionId: 's-1',
        seq: 0,
        at: '2000-01-01T00:00:00.000Z',
        payload: { kind: 'session_cancel' },
      },
    ],
    [
      'seq 1.5',
      {
        frame: 'session',
        sessionId: 's-1',
        seq: 1.5,
        at: '2000-01-01T00:00:00.000Z',
        payload: { kind: 'session_cancel' },
      },
    ],
    ['empty at', { frame: 'session', sessionId: 's-1', seq: 1, at: '', payload: { kind: 'session_cancel' } }],
    [
      'empty sessionId',
      {
        frame: 'session',
        sessionId: '',
        seq: 1,
        at: '2000-01-01T00:00:00.000Z',
        payload: { kind: 'session_cancel' },
      },
    ],
    [
      'unknown kind',
      {
        frame: 'session',
        sessionId: 's-1',
        seq: 1,
        at: '2000-01-01T00:00:00.000Z',
        payload: { kind: 'session_teleport' },
      },
    ],
    [
      'undefined member',
      { frame: 'control', at: '2000-01-01T00:00:00.000Z', payload: { kind: 'link_ping', nonce: undefined } },
    ],
  );
  fc.assert(
    fc.property(malformed, ([label, frame]) => {
      const encoded = encode(frame as never);
      assert.equal(encoded.ok, false, `${label}: encode accepted a frame decode refuses`);
      if (!encoded.ok) assert.equal(encoded.refusal.reason, 'frame-malformed', label);
      const decoded = decode(JSON.stringify(frame));
      assert.equal(decoded.ok, false, `${label}: the control — decode must refuse it too`);
    }),
    RUNS,
  );
});

test('a refusal reason this host does not declare never encodes, whichever kind carries it', () => {
  const undeclared = fc.string().filter((reason) => !isRefusalReason(reason));
  const carrier = fc
    .tuple(
      undeclared,
      fc.string(),
      fc.constantFrom(
        'bulk_failed',
        'transcript_failed',
        'workspace_release_result',
        'workspace_release_bulk_result',
      ),
    )
    .map(([reason, detail, kind]): SessionPayload => {
      const refusal = { reason, detail };
      switch (kind) {
        case 'bulk_failed':
          return { kind, deliveryId: 'd-1', refusal };
        case 'transcript_failed':
          return { kind, requestId: 'req-1', refusal };
        case 'workspace_release_result':
          return {
            kind,
            requestId: 'req-1',
            workspaceKey: null,
            path: null,
            directoryRemoved: false,
            branchDeleted: false,
            refusal,
          };
        default:
          return {
            kind: 'workspace_release_bulk_result',
            requestId: 'req-1',
            results: [
              { workspaceKey: 'w1', path: null, directoryRemoved: true, branchDeleted: false, refusal },
            ],
          };
      }
    });
  fc.assert(
    fc.property(carrier, (payload) => {
      const encoded = encode(sessionFrameOf(payload));
      assert.equal(encoded.ok, false, `${payload.kind} encoded an undeclared reason`);
      if (!encoded.ok) assert.equal(encoded.refusal.reason, 'frame-malformed');
    }),
    RUNS,
  );
});

test('the generator map names exactly the kinds decode accepts', () => {
  // The compile-time half is `satisfies Record<SessionPayloadKind, ...>` on the map. This is the
  // runtime half: one sample per kind decodes, and a kind outside the map does not.
  const accepted = new Set<string>();
  for (const kind of SESSION_KINDS) {
    const [payload] = fc.sample(byKind[kind], { numRuns: 1, seed: 1 });
    assert.ok(payload !== undefined);
    const encoded = encode(sessionFrameOf(payload));
    assert.ok(encoded.ok, `${kind} did not encode`);
    if (decode(encoded.value).ok) accepted.add(kind);
  }
  assert.deepEqual([...accepted].sort(), [...SESSION_KINDS].sort());

  for (const stranger of ['session_started', 'session_ended', 'link_hello', '']) {
    const decoded = decode(JSON.stringify(sessionFrameOf({ kind: stranger } as unknown as SessionPayload)));
    assert.equal(decoded.ok, false, `an undeclared kind decoded: ${JSON.stringify(stranger)}`);
  }
});
