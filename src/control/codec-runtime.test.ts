/**
 * The codec over what protocol 15 adds for runtimes: the hello's runtimes list, a request's runtime
 * and a transition's control tier. Tolerant in, strict out, as for every vocabulary on the wire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decode, encode } from './codec.js';
import type { Frame, HostAgentEntry, SessionPayload } from './frames.js';
import { MAX_AGENT_ENTRIES, sessionNew, sessionNewRequest, unsetHostConfiguration } from './frames.js';
import type { SessionTransition } from '../state/model.js';

const AT = '2000-01-01T00:00:00.000Z';

const session = (payload: SessionPayload): Frame => ({
  frame: 'session',
  sessionId: 'session-1',
  seq: 1,
  at: AT,
  payload,
});

const ENTRY: HostAgentEntry = {
  runtime: 'claude',
  version: '2.1.284',
  sdkVersion: '0.3.284',
  models: [],
  vocabularies: { permissionModes: ['default'], efforts: ['high'], thinking: true },
  controlTier: { level: 'intercepted', degrades: [] },
  available: true,
  unavailableReason: null,
};

const hello = (agents: unknown): Frame =>
  ({
    frame: 'control',
    at: AT,
    payload: {
      kind: 'link_hello',
      protocolVersion: 15,
      hostId: 'host-1',
      capabilities: [],
      cursors: [],
      configuration: { ...unsetHostConfiguration(), agents },
      pendingRestart: [],
      protocolRange: { min: 14, max: 15 },
    },
  }) as unknown as Frame;

const READY: SessionTransition = {
  sessionId: 'agent-1',
  seq: 2,
  at: AT,
  from: 'working',
  to: 'ready',
  activity: null,
  entryId: null,
  cause: { kind: 'sdk-message', event: 'system/init', detail: 'reported' },
  where: { cwd: '/w', worktree: null, branch: null, unknownReason: 'not-a-repository' },
  correlationId: null,
  controlTier: { level: 'intercepted', degrades: [] },
};

const transition = (members: Record<string, unknown>): Frame =>
  session({
    kind: 'session_update',
    body: { update: 'state_transition', transition: { ...READY, ...members } },
  } as unknown as SessionPayload);

const decodes = (frame: Frame): boolean => decode(JSON.stringify(frame)).ok;

test('the runtimes list decodes up to its bound and is refused past it', () => {
  assert.ok(decodes(hello([ENTRY])));
  assert.ok(decodes(hello(Array.from({ length: MAX_AGENT_ENTRIES }, () => ENTRY))), 'the bound is inclusive');
  assert.equal(decodes(hello(Array.from({ length: MAX_AGENT_ENTRIES + 1 }, () => ENTRY))), false);
  assert.ok(decodes(hello(null)), 'null is a host that read nothing');
  assert.equal(decodes(hello([{ ...ENTRY, models: 'all' }])), false, 'an entry whose models are not a list');
});

test('a tier level a newer peer adds is read on the way in and refused on the way out, on a hello and a transition', () => {
  const newer = { level: 'a-level-from-a-newer-peer', degrades: [] };
  assert.ok(decodes(hello([{ ...ENTRY, controlTier: newer }])));
  assert.ok(decodes(transition({ controlTier: newer })));

  const outHello = encode(hello([{ ...ENTRY, controlTier: newer }]));
  assert.equal(outHello.ok ? '' : outHello.refusal.reason, 'frame-malformed');
  assert.match(outHello.ok ? '' : outHello.refusal.detail, /agents\.0\.controlTier\.level/);

  const outTransition = encode(transition({ controlTier: newer }));
  assert.equal(outTransition.ok ? '' : outTransition.refusal.reason, 'frame-malformed');
  assert.match(outTransition.ok ? '' : outTransition.refusal.detail, /transition\.controlTier\.level/);

  // The declared twin of each encodes.
  assert.ok(encode(hello([ENTRY])).ok);
  assert.ok(encode(transition({})).ok);
});

test('a transition tier of the wrong shape is refused beside its well-formed twin; a transition with none is unchanged', () => {
  assert.ok(decodes(transition({})));
  assert.equal(decodes(transition({ controlTier: { level: 'intercepted', degrades: 'none' } })), false);
  assert.equal(decodes(transition({ controlTier: 'intercepted' })), false);
  assert.ok(decodes(transition({ controlTier: null })), 'null is a transition that states no tier');

  const { controlTier: _tier, ...withoutTier } = READY;
  assert.ok(decodes(transition({ controlTier: undefined, ...withoutTier })));
  // The rest of a transition stays unnarrowed: a body whose transition is not an object still crosses.
  assert.ok(
    decodes(
      session({
        kind: 'session_update',
        body: { update: 'state_transition', transition: 7 },
      } as unknown as SessionPayload),
    ),
  );
});

test("a request's runtime is a word: stated, null or absent decodes, and an empty or overlong one is malformed", () => {
  const opening = (runtime: unknown): Frame =>
    session(sessionNew('/w', { request: { ...sessionNewRequest(), runtime } as never }));
  assert.ok(decodes(opening('claude')));
  assert.ok(decodes(opening(null)));
  assert.ok(decodes(session(sessionNew('/w', { request: sessionNewRequest() }))), 'absent');
  assert.equal(decodes(opening('')), false);
  assert.equal(decodes(opening('x'.repeat(65))), false);
});
