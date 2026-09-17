import test from 'node:test';
import assert from 'node:assert/strict';

import { decode, encode } from './codec.js';
import {
  MAX_BULK_RELEASES,
  MAX_CONFIGURATION_VALUE_LENGTH,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MIN,
  bulkDelivered,
  readRefusal,
  sessionList,
  sessionListResult,
  transcriptFailed,
  transcriptList,
  transcriptListResult,
  transcriptTail,
  transcriptTailResult,
  unsetHostConfiguration,
} from './frames.js';
import type { ControlFrame, HostConfiguration, SessionFrame } from './frames.js';

const frame: SessionFrame = {
  frame: 'session',
  sessionId: 's-1',
  seq: 1,
  at: '2026-08-03T00:00:00.000Z',
  payload: { kind: 'session_update', body: { note: 'hello' } },
};

test('a frame survives a round trip unchanged', () => {
  const encoded = encode(frame);
  assert.ok(encoded.ok);
  const decoded = decode(encoded.value);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.value, frame);
});

test('an unknown field is carried, not stripped and not fatal', () => {
  // A newer peer will send fields this version has never heard of. Rejecting them would make every
  // additive change a breaking one; stripping them would silently destroy what a relay was handed.
  const wire = JSON.stringify({ ...frame, futureField: 'from a newer controller' });
  const decoded = decode(wire);

  assert.ok(decoded.ok, 'an unknown field must not fail the parse');
  assert.equal(
    (decoded.value as unknown as Record<string, unknown>)['futureField'],
    'from a newer controller',
  );
});

test('malformed input is a named refusal, never a throw', () => {
  for (const bad of ['', 'not json at all', '{', '{"frame":"session"}', '[]', 'null']) {
    const decoded = decode(bad);
    assert.equal(decoded.ok, false, `expected a refusal for ${JSON.stringify(bad)}`);
    if (!decoded.ok) {
      assert.ok(['frame-not-json', 'frame-malformed'].includes(decoded.refusal.reason));
    }
  }
});

test('seq zero is refused — the first frame is 1, so 0 can mean "none yet"', () => {
  const decoded = decode(JSON.stringify({ ...frame, seq: 0 }));
  assert.equal(decoded.ok, false);
});

test('a frame carrying bulk content will not encode, and the refusal names the lane', () => {
  // The mechanical half of "commands only, never payloads": a transcript cannot ride the link even
  // by accident, because the frame carrying it does not survive the codec.
  const transcript = 'x'.repeat(MAX_FRAME_BYTES + 1);
  const smuggled: SessionFrame = {
    ...frame,
    payload: { kind: 'session_update', body: { transcript } },
  };

  const encoded = encode(smuggled);
  assert.equal(encoded.ok, false);
  if (!encoded.ok) {
    assert.equal(encoded.refusal.reason, 'frame-too-large');
    assert.match(encoded.refusal.detail, /bulk_request/);
    assert.match(encoded.refusal.detail, /bulk-post/);
  }
});

test('an oversized frame is refused on the way in as well as out', () => {
  const oversized = `{"padding":"${'x'.repeat(MAX_FRAME_BYTES)}"}`;
  const decoded = decode(oversized);
  assert.equal(decoded.ok, false);
  if (!decoded.ok) assert.equal(decoded.refusal.reason, 'frame-too-large');
});

// ---------------------------------------------------------------------------
// The refusal enum's version-skew posture: strict out, tolerant in.
// ---------------------------------------------------------------------------

const failedFrame = (reason: string): SessionFrame => ({
  frame: 'session',
  sessionId: 's-1',
  seq: 7,
  at: '2026-08-03T00:00:00.000Z',
  payload: {
    kind: 'bulk_failed',
    deliveryId: 'd-1',
    refusal: { reason, detail: 'the controller answered 503' },
  },
});

// The defect this guards, stated as the failure: with `reason` as a closed `z.enum`, a peer one
// version ahead sending a reason this build has never seen fails the whole frame as
// `frame-malformed`, losing a delivery receipt, its id and its detail, over a word. The codec's
// header promises the opposite for unknown fields; an unknown enum value is the same information
// one level in.
test('regression: a refusal reason from a newer peer decodes rather than destroying the receipt', () => {
  const wire = JSON.stringify(failedFrame('a-reason-invented-after-this-build-shipped'));
  const decoded = decode(wire);

  assert.ok(decoded.ok, 'an unrecognised reason must not be fatal to the frame that carries it');
  const payload = decoded.value as SessionFrame & {
    payload: { deliveryId: string; refusal: { reason: string; detail: string } };
  };
  assert.equal(payload.payload.deliveryId, 'd-1', 'the delivery it was about survived');
  assert.equal(
    payload.payload.refusal.reason,
    'a-reason-invented-after-this-build-shipped',
    "the raw value travels — dropping it makes a newer peer's failure invisible",
  );
  assert.equal(payload.payload.refusal.detail, 'the controller answered 503');
});

test('a recognised reason still decodes, so the tolerance did not replace the vocabulary', () => {
  const decoded = decode(JSON.stringify(failedFrame('bulk-delivery-failed')));
  assert.ok(decoded.ok);
});

// The other half, and it is what keeps the tolerance from being a widening. `refusal()` takes a
// `RefusalReason`, which a single `as` defeats. So the producer side is enforced at the one place
// a frame becomes bytes, and this is the cast that proves it.
test('regression: this host cannot emit a reason it does not declare, even by casting past the type', () => {
  const smuggled = failedFrame('a-reason-this-host-made-up');
  const encoded = encode(smuggled);

  assert.equal(encoded.ok, false, 'the producer side is not merely a type');
  if (!encoded.ok) {
    assert.equal(encoded.refusal.reason, 'frame-malformed');
    assert.match(encoded.refusal.detail, /a-reason-this-host-made-up/);
    assert.match(encoded.refusal.detail, /REFUSAL_REASONS/, 'the refusal teaches the fix');
  }
});

test('a declared reason encodes normally — the check costs a legitimate frame nothing', () => {
  assert.equal(encode(failedFrame('bulk-delivery-failed')).ok, true);
  assert.equal(encode(frame).ok, true, 'a frame with no refusal in it is untouched by the check');
});

// The checked accessor: same shape and same argument as `readStateTransition`. A consumer cannot
// read one without checking, and what it does not recognise it keeps rather than converts.
test('readRefusal narrows what it knows and preserves what it does not', () => {
  const known = readRefusal({ reason: 'bulk-delivery-failed', detail: 'a 503' });
  assert.equal(known.recognised, true);
  if (known.recognised) assert.equal(known.refusal.reason, 'bulk-delivery-failed');

  const unknown = readRefusal({ reason: 'from-a-newer-controller', detail: 'a 418' });
  assert.equal(unknown.recognised, false, 'an unrecognised value is a named outcome, not a silent map');
  if (!unknown.recognised) {
    assert.equal(unknown.raw, 'from-a-newer-controller', 'the raw payload travels');
    assert.equal(unknown.detail, 'a 418', 'and so does the human-readable half');
  }
});

// The codec counts bytes with `TextEncoder` (runtime-agnostic) rather than the Node-only
// `Buffer.byteLength`. A size gate is exactly the thing that must not shift by a byte, so the
// equivalence is asserted rather than assumed. The surrogate rows are the ones that could
// plausibly disagree: an unpaired half is replaced with U+FFFD by both.
test('the frame size gate counts UTF-8 bytes identically to Buffer.byteLength', () => {
  for (const sample of [
    '',
    'plain ascii',
    'café', // 2-byte
    '\u2192 \u2190 \u2191', // 3-byte arrows
    '\u{1F600} emoji', // a real surrogate pair, 4 bytes
    '\ud83d', // a lone high surrogate
    '\udc00', // a lone low surrogate
    'mixed \ud83d\ude00 café \u2192 tail',
    JSON.stringify({ frame: 'session', payload: { body: 'x'.repeat(500) } }),
  ]) {
    assert.equal(
      new TextEncoder().encode(sample).length,
      Buffer.byteLength(sample, 'utf8'),
      `byte count diverged for ${JSON.stringify(sample)} — the admission limit would move`,
    );
  }
});

test('the size gate still refuses a frame over the limit, and admits one under it', () => {
  // The gate itself, not just the arithmetic: a green equivalence over a gate that stopped firing
  // would prove nothing about admission.
  const oversized: SessionFrame = {
    ...frame,
    payload: { kind: 'session_update', body: { note: 'x'.repeat(MAX_FRAME_BYTES) } },
  };
  const refused = encode(oversized);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.refusal.reason, 'frame-too-large');

  assert.equal(encode(frame).ok, true, 'an ordinary frame is still admitted');
});

// ---------------------------------------------------------------------------
// v3: `session_new.cwd` is `string | null`.
// ---------------------------------------------------------------------------

const sessionNewFrame = (cwd: unknown): string =>
  JSON.stringify({
    frame: 'session',
    sessionId: 's-1',
    seq: 1,
    at: '2026-08-03T00:00:00.000Z',
    payload: { kind: 'session_new', cwd, workspaceKey: null, correlationId: null, request: null, gate: null },
  });

// The defect this guards, stated as the failure: a controller whose host provisions worktrees has
// no cwd to ask for and sends `null`. A codec that refuses the whole `session_new` on that (the one
// frame a session cannot exist without) leaves the controller hearing nothing, because refusals
// are not acked; it keeps replaying the refused frame at every resync and the session lane wedges
// forever. `cwd` is nullable in v3, matching the rule the schema states for every other member.
test('regression: a session_new with cwd: null decodes — null is "the provider decides", not garbage (v3)', () => {
  const decoded = decode(sessionNewFrame(null));
  assert.ok(decoded.ok, 'refusing null cwd is the silent-wedge defect the v3 schema prevents');
  const payload = (decoded.value as SessionFrame).payload as { kind: string; cwd: string | null };
  assert.equal(payload.kind, 'session_new');
  assert.equal(payload.cwd, null, 'the null travels: it is an answer, not an absence');
});

test('a session_new with a string cwd still decodes — a stated ask is unchanged from v2', () => {
  const decoded = decode(sessionNewFrame('/w'));
  assert.ok(decoded.ok);
  assert.equal(((decoded.value as SessionFrame).payload as { cwd: string | null }).cwd, '/w');
});

test('a non-string, non-null cwd is still refused — nullable did not become anything-goes', () => {
  for (const bad of [42, true, ['/w'], { path: '/w' }]) {
    const decoded = decode(sessionNewFrame(bad));
    assert.equal(decoded.ok, false, `expected a refusal for cwd ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// v5: `session_new.workspaceKey` is required-and-nullable, and the reap pair exists.
// ---------------------------------------------------------------------------

/** The v5 frame with the workspace key stated; the helper above already sends `null`. */
const sessionNewFrameWithKey = (workspaceKey: unknown): string =>
  JSON.stringify({
    frame: 'session',
    sessionId: 's-1',
    seq: 1,
    at: '2026-08-03T00:00:00.000Z',
    payload: { kind: 'session_new', cwd: '/w', workspaceKey, correlationId: null, request: null, gate: null },
  });

test('a session_new with a string workspaceKey decodes, and the key travels (v5)', () => {
  const decoded = decode(sessionNewFrameWithKey('effort-7'));
  assert.ok(decoded.ok);
  const payload = (decoded.value as SessionFrame).payload as { workspaceKey: string | null };
  assert.equal(payload.workspaceKey, 'effort-7');
});

// The v5 pin, and its control is the frame the helper above builds. A v4 controller's
// session_new carries no workspaceKey member, and it must refuse: that refusal is exactly what the
// 4 to 5 version bump announces, and the handshake refuses the pairing so no such frame is ever
// sent to this host by a linked controller. If this test starts passing a memberless frame, the
// schema has quietly grown `.optional()` or `.default()`, the round-trip ambiguity the codec's own
// header forbids, and "the controller said nothing" has become indistinguishable from "unset".
test('regression: a session_new without workspaceKey refuses — a v4 frame does not decode at v5', () => {
  const v4Frame = JSON.stringify({
    frame: 'session',
    sessionId: 's-1',
    seq: 1,
    at: '2026-08-03T00:00:00.000Z',
    payload: { kind: 'session_new', cwd: '/w', correlationId: null, request: null, gate: null },
  });
  const refused = decode(v4Frame);
  assert.equal(refused.ok, false, 'a memberless frame decoded — the schema went optional');
  if (!refused.ok) assert.equal(refused.refusal.reason, 'frame-malformed');

  // The control: the same frame with the member stated as null decodes. Without this pair, a
  // schema refusing every session_new would make the wedge pin green while proving nothing.
  const control = decode(sessionNewFrame(null));
  assert.ok(
    control.ok,
    'the identical frame with workspaceKey: null must decode, or this pair is not a discriminator',
  );
});

test('a non-string, non-null workspaceKey is refused — nullable did not become anything-goes (v5)', () => {
  for (const bad of [42, true, ['k'], { key: 'k' }]) {
    const decoded = decode(sessionNewFrameWithKey(bad));
    assert.equal(decoded.ok, false, `expected a refusal for workspaceKey ${JSON.stringify(bad)}`);
  }
});

const sessionFrame = (payload: Record<string, unknown>): string =>
  JSON.stringify({ frame: 'session', sessionId: 's-1', seq: 1, at: '2026-08-03T00:00:00.000Z', payload });

test('workspace_release decodes, and an empty key or requestId refuses (v5; the v7 members required)', () => {
  const ask = { kind: 'workspace_release', path: null, deleteBranch: false, force: false };
  const decoded = decode(sessionFrame({ ...ask, requestId: 'r1', workspaceKey: 'effort-7' }));
  assert.ok(decoded.ok);
  assert.equal(decode(sessionFrame({ ...ask, requestId: 'r1', workspaceKey: '' })).ok, false);
  assert.equal(decode(sessionFrame({ ...ask, requestId: '', workspaceKey: 'k' })).ok, false);
  // The v5 shape is refused at v7: the flags and the path are required members, which the bump announces.
  assert.equal(
    decode(sessionFrame({ kind: 'workspace_release', requestId: 'r1', workspaceKey: 'effort-7' })).ok,
    false,
  );
});

test('workspace_release_result round-trips both exits — refusal null, and refusal named (v5; the v7 receipt required)', () => {
  const receipt = {
    kind: 'workspace_release_result',
    workspaceKey: 'effort-7',
    path: null,
    directoryRemoved: true,
    branchDeleted: false,
  };
  const released = decode(sessionFrame({ ...receipt, requestId: 'r1', refusal: null }));
  assert.ok(released.ok, 'refusal: null is the released answer and must decode');
  const refused = decode(
    sessionFrame({
      ...receipt,
      requestId: 'r1',
      refusal: { reason: 'workspace-release-failed', detail: 'still in use' },
    }),
  );
  assert.ok(refused.ok);
  // Required, not defaulted: a result that omits a member is malformed, same rule as every field.
  assert.equal(decode(sessionFrame({ ...receipt, requestId: 'r1' })).ok, false);
  assert.equal(
    decode(sessionFrame({ kind: 'workspace_release_result', requestId: 'r1', refusal: null })).ok,
    false,
  );
});

test('regression: a multi-byte character counts as its bytes, not its characters, at the boundary', () => {
  // The failure this guards: counting `.length` would admit a frame ~3x over the wire limit, and the
  // refusal would arrive from the socket instead of from this host, with the caller long gone.
  const threeByteChars = '\u2192'.repeat(MAX_FRAME_BYTES / 3);
  const frameWithChars: SessionFrame = {
    ...frame,
    payload: { kind: 'session_update', body: { note: threeByteChars } },
  };

  assert.ok(threeByteChars.length < MAX_FRAME_BYTES, 'the sample is under the limit by character count');
  const encoded = encode(frameWithChars);
  assert.equal(encoded.ok, false, 'but over it by byte count, which is what the wire charges for');
  if (!encoded.ok) assert.equal(encoded.refusal.reason, 'frame-too-large');
});

// ---------------------------------------------------------------------------
// The discovery kinds (v4): every one round-trips, malformed ones refuse by name,
// and the widened bulk receipt tolerates an older peer's shape.
// ---------------------------------------------------------------------------

test('every discovery payload survives a round trip unchanged', () => {
  const payloads = [
    sessionList('req-1'),
    sessionListResult(
      'req-1',
      [
        {
          sessionKey: 'handle-1',
          sessionId: 'agent-1',
          state: 'live',
          cwd: 'C:/work',
          startedAt: '2026-08-24T00:00:00.000Z',
        },
      ],
      { liveCount: 1, provisioningCount: 0 },
    ),
    transcriptList('req-2', 100),
    transcriptListResult(
      'req-2',
      [{ projectSlug: 'C--src-x', sessionId: 'abc', sizeBytes: 10, mtimeMs: 1_000, cwd: 'C:/src/x' }],
      {
        totalCount: 370,
        nextIndex: 200,
      },
    ),
    transcriptTail('req-3', 'C--src-x', 'abc', 4_096, 'the needle'),
    transcriptTailResult('req-3', {
      found: true,
      absent: false,
      newOffset: 8_192,
      sizeBytes: 8_192,
      mtimeMs: 1_000,
    }),
    transcriptFailed('req-4', { reason: 'transcript-path-escape', detail: 'refused by the allowlist layer' }),
  ];
  for (const payload of payloads) {
    const wire: SessionFrame = { ...frame, payload };
    const encoded = encode(wire);
    assert.ok(encoded.ok, `${payload.kind} did not encode`);
    const decoded = decode(encoded.value);
    assert.ok(decoded.ok, `${payload.kind} did not decode`);
    assert.deepEqual(decoded.value, wire, `${payload.kind} did not survive the round trip`);
  }
});

test('the builders state every unasked optional as null, so nothing is deleted by JSON.stringify', () => {
  assert.equal(transcriptTail('r', 's', 'i', 0).needle, null);
  assert.equal(transcriptListResult('r', [], { totalCount: 0 }).nextIndex, null);
  const tail = transcriptTailResult('r', { found: false, absent: true, newOffset: 0 });
  assert.equal(tail.sizeBytes, null);
  assert.equal(tail.mtimeMs, null);
  const receipt = bulkDelivered('d', 1);
  assert.equal(receipt.sizeBytes, null);
  assert.equal(receipt.mtimeMs, null);
});

test('control: an unround-trippable discovery frame refuses frame-malformed, never passes loosened', () => {
  // The case that reddens if a schema is loosened to passthrough: a transcript_tail with no
  // fromOffset is not a frame this host may act on, whatever else it carries.
  const missingOffset = JSON.stringify({
    ...frame,
    payload: { kind: 'transcript_tail', requestId: 'r', projectSlug: 's', sessionId: 'i', needle: null },
  });
  const decoded = decode(missingOffset);
  assert.equal(decoded.ok, false, 'a tail probe without an offset must not decode');
  if (!decoded.ok) assert.equal(decoded.refusal.reason, 'frame-malformed');

  const badIndex = JSON.stringify({
    ...frame,
    payload: { kind: 'transcript_list', requestId: 'r', fromIndex: -1 },
  });
  const negative = decode(badIndex);
  assert.equal(negative.ok, false, 'a negative fromIndex must not decode');
});

test('a v3 bulk_delivered with no stat pair at all still decodes, with both unknowns stated as null', () => {
  const older = JSON.stringify({
    ...frame,
    payload: { kind: 'bulk_delivered', deliveryId: 'd-1', byteCount: 7 },
  });
  const decoded = decode(older);
  assert.ok(decoded.ok, 'an older peer receipt must not be destroyed over two unknown fields');
  const payload = (decoded.value as SessionFrame).payload as {
    sizeBytes: number | null;
    mtimeMs: number | null;
  };
  assert.equal(payload.sizeBytes, null);
  assert.equal(payload.mtimeMs, null);
});

test('regression: transcript_failed cannot emit a reason this host does not declare — same guard as bulk_failed', () => {
  const invented: SessionFrame = {
    ...frame,
    payload: transcriptFailed('req-5', { reason: 'made-up-reason', detail: 'should not encode' }),
  };
  const encoded = encode(invented);
  assert.equal(encoded.ok, false, 'an undeclared reason must be stopped where the frame becomes bytes');
  if (!encoded.ok) assert.match(encoded.refusal.detail, /made-up-reason/);
});

// --- the hello's configuration values (v7) --------------------------------------

function hello(configuration: HostConfiguration): ControlFrame {
  return {
    frame: 'control',
    at: '2026-08-03T00:00:00.000Z',
    payload: {
      kind: 'link_hello',
      protocolVersion: PROTOCOL_VERSION,
      hostId: 'h-1',
      capabilities: [],
      cursors: [],
      configuration,
      pendingRestart: [],
      protocolRange: { min: PROTOCOL_VERSION_MIN, max: PROTOCOL_VERSION },
    },
  };
}

test('a hello configuration value at the cap decodes, and one past it is refused as malformed', () => {
  const atCap = 'p'.repeat(MAX_CONFIGURATION_VALUE_LENGTH);
  const pastCap = 'p'.repeat(MAX_CONFIGURATION_VALUE_LENGTH + 1);

  const accepted = decode(JSON.stringify(hello({ ...unsetHostConfiguration(), repositoryRoot: atCap })));
  assert.ok(accepted.ok, 'a value exactly at the cap must decode');

  // The control: the same frame with one more character. Without this pair a cap that was never
  // enforced would leave the first assertion green while proving nothing about the bound.
  const refused = decode(JSON.stringify(hello({ ...unsetHostConfiguration(), repositoryRoot: pastCap })));
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.refusal.reason, 'frame-malformed');
});

test('a hello without the configuration member is refused: the member is required, null values inside it are not', () => {
  const nulls = decode(JSON.stringify(hello(unsetHostConfiguration())));
  assert.ok(nulls.ok, 'every value null is the documented shape of a host with nothing set');

  const withoutMember = JSON.parse(JSON.stringify(hello(unsetHostConfiguration()))) as {
    payload: Record<string, unknown>;
  };
  delete withoutMember.payload['configuration'];
  const refused = decode(JSON.stringify(withoutMember));
  assert.equal(refused.ok, false, 'a v6-shaped hello must refuse, which is what the version bump announces');
});

test('a workspace_release_bulk past MAX_BULK_RELEASES is malformed, and one at the bound decodes', () => {
  const entry = { workspaceKey: 'w', path: null, deleteBranch: false, force: false };
  const frameOf = (count: number): string =>
    JSON.stringify({
      frame: 'session',
      sessionId: 'discovery:h',
      seq: 1,
      at: '2026-01-01T00:00:00.000Z',
      payload: {
        kind: 'workspace_release_bulk',
        requestId: 'r',
        releases: Array.from({ length: count }, () => entry),
      },
    });

  assert.equal(decode(frameOf(MAX_BULK_RELEASES)).ok, true);
  const over = decode(frameOf(MAX_BULK_RELEASES + 1));
  assert.equal(over.ok, false);
  assert.equal(!over.ok && over.refusal.reason, 'frame-malformed');
});

test('a hello without pendingRestart is refused, and one naming a pending key decodes (v8)', () => {
  const pending = hello(unsetHostConfiguration());
  (pending.payload as unknown as { pendingRestart: string[] }).pendingRestart = ['PERISCOPE_CONTROLLER_URL'];
  assert.ok(decode(JSON.stringify(pending)).ok, 'a pending key is a documented shape');

  const withoutMember = JSON.parse(JSON.stringify(hello(unsetHostConfiguration()))) as {
    payload: Record<string, unknown>;
  };
  delete withoutMember.payload['pendingRestart'];
  const refused = decode(JSON.stringify(withoutMember));
  assert.equal(refused.ok, false, 'a v7-shaped hello must refuse, which is what the v8 bump announces');
});
