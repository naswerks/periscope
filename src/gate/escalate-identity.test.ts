/**
 * Two security-shaped properties of the escalation body and its transport.
 *
 *   1. The decision POST presents a credential, because the one surface that decides whether a
 *      tool runs must not ship unauthenticated.
 *   2. The body identifies a session by the controller's handle beside the agent's id, because
 *      every wire frame is keyed by the handle and a decision naming only the agent's id could
 *      name one the controller has never seen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ControllerCredential } from '../control/credential.js';
import { UnconfiguredCredential } from '../control/credential.js';
import { ok, refuse } from '../core/result.js';
import type { Authorization } from '../control/credential.js';
import type { Result } from '../core/result.js';
import type { DecisionRequest, EscalationResponse } from './index.js';
import { EscalationUnavailable, escalatingDecider } from './escalate.js';

const request: DecisionRequest = {
  toolName: 'Write',
  toolUseId: 'toolu_1',
  toolInput: { file_path: '/tmp/x' },
  sessionId: 'agent-1',
  sessionKey: 'handle-1',
  cwd: '/tmp',
  agentId: null,
  agentType: null,
};

class StubCredential implements ControllerCredential {
  calls = 0;
  constructor(private readonly answer: () => Result<Authorization>) {}
  authorize(): Promise<Result<Authorization>> {
    this.calls += 1;
    return Promise.resolve(this.answer());
  }
}

const answering = (status: number, body: string) => {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const transport = async (
    url: string,
    init: { headers: Record<string, string>; body: string },
  ): Promise<EscalationResponse> => {
    seen.push({ url, headers: init.headers, body: init.body });
    return { status, text: async () => body };
  };
  return { seen, transport };
};

// ---------------------------------------------------------------------------
// 1. The credential.
// ---------------------------------------------------------------------------

test('regression: the credential is resolved per request, never captured once', async () => {
  let issued = 0;
  const credential = new StubCredential(() => {
    issued += 1;
    return ok({ header: 'authorization', value: `Bearer token-${issued}` });
  });
  const { seen, transport } = answering(200, JSON.stringify({ behavior: 'allow' }));
  const decide = escalatingDecider({ url: 'https://controller/decisions', transport, credential });

  await decide(request, new AbortController().signal);
  await decide(request, new AbortController().signal);

  // Per request, because a bearer token is refreshed on a schedule this module does not know. A
  // value captured once is presented for the life of the host and starts failing silently at the
  // first expiry — as an outage, on every tool call.
  assert.equal(credential.calls, 2, 'the credential was resolved once and reused');
  assert.equal(seen[0]?.headers['authorization'], 'Bearer token-1');
  assert.equal(
    seen[1]?.headers['authorization'],
    'Bearer token-2',
    'a refreshed token did not reach the second call',
  );
  assert.equal(
    seen[0]?.headers['content-type'],
    'application/json',
    'the content type must survive the addition',
  );
});

test('regression: a credential that refuses sends no request at all — the tool does not run', async () => {
  // The posture is deliberately the opposite of the link's, which connects header-less rather than
  // pretending to have a scheme. The link carries observations; this endpoint decides whether a tool
  // runs, and an unauthenticated request to it is one anybody who can reach the URL could answer.
  const { seen, transport } = answering(200, JSON.stringify({ behavior: 'allow' }));
  const decide = escalatingDecider({
    url: 'https://controller/decisions',
    transport,
    credential: new UnconfiguredCredential(),
  });

  await assert.rejects(
    () => decide(request, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof EscalationUnavailable, 'must be an outage, so the gate refuses fail-closed');
      assert.match(error.message, /credential-unavailable/, 'the refusal reason must travel');
      assert.match(error.message, /was NOT sent/, 'and it must say the request never left');
      return true;
    },
  );

  assert.deepEqual(seen, [], 'an unauthenticated decision request was sent anyway');
});

test('a decider with no credential presents no authorization header', async () => {
  const { seen, transport } = answering(200, JSON.stringify({ behavior: 'allow' }));
  const decide = escalatingDecider({ url: 'https://controller/decisions', transport });

  const answer = await decide(request, new AbortController().signal);
  assert.deepEqual(answer, { behavior: 'allow' });
  assert.equal(seen[0]?.headers['authorization'], undefined);
});

test('the static headers seam still works, and the credential wins where they collide', async () => {
  const { seen, transport } = answering(200, JSON.stringify({ behavior: 'allow' }));
  const decide = escalatingDecider({
    url: 'https://controller/decisions',
    transport,
    headers: { authorization: 'Bearer stale', 'x-fixed': 'kept' },
    credential: new StubCredential(() => ok({ header: 'authorization', value: 'Bearer live' })),
  });

  await decide(request, new AbortController().signal);
  assert.equal(seen[0]?.headers['x-fixed'], 'kept', 'an unrelated static header was dropped');
  assert.equal(
    seen[0]?.headers['authorization'],
    'Bearer live',
    'a stale static token outranked the live one',
  );
});

test('regression: the credential is resolved before the status check, never after', async () => {
  // A credential failure and a controller outage are both outages, but only one of them should ever
  // reach the network. If the order were reversed, a host with no credential would still be POSTing.
  const { seen, transport } = answering(500, 'nope');
  const decide = escalatingDecider({
    url: 'https://controller/decisions',
    transport,
    credential: new StubCredential(() => refuse<Authorization>('token-unavailable', 'nobody has signed in')),
  });

  await assert.rejects(() => decide(request, new AbortController().signal), EscalationUnavailable);
  assert.deepEqual(seen, [], 'the request went out before the credential was consulted');
});

// ---------------------------------------------------------------------------
// 2. The correlation gap.
// ---------------------------------------------------------------------------

test('regression: the body carries the controller handle beside the agent id, and they differ', async () => {
  const { seen, transport } = answering(200, JSON.stringify({ behavior: 'allow' }));
  const decide = escalatingDecider({ url: 'https://controller/decisions', transport });

  await decide(request, new AbortController().signal);

  const body = JSON.parse(seen[0]?.body ?? '{}') as Record<string, unknown>;
  assert.equal(body['sessionKey'], 'handle-1', 'the controller could not route this decision to a session');
  assert.equal(
    body['sessionId'],
    'agent-1',
    'the agent id must still travel — it is a fact, not a substitute',
  );
  assert.notEqual(
    body['sessionKey'],
    body['sessionId'],
    'the fixture must keep them different, or this test would pass with either one missing',
  );
});
