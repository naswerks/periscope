import test from 'node:test';
import assert from 'node:assert/strict';

import type { DecisionRequest } from './decision.js';
import type { EscalationResponse, EscalationTransport } from './escalate.js';
import { EscalationUnavailable, escalatingDecider } from './escalate.js';

const request: DecisionRequest = {
  toolName: 'Write',
  toolUseId: 'toolu_1',
  toolInput: { file_path: '/tmp/x' },
  sessionId: 'session-1',
  sessionKey: 'handle-1',
  cwd: '/tmp',
  agentId: null,
  agentType: null,
};

/** Records whether the body was read at all — the assertion this file exists for. */
function responding(
  status: number,
  body: string,
): { transport: EscalationTransport; bodyWasRead: () => boolean } {
  let read = false;
  const response: EscalationResponse = {
    status,
    async text() {
      read = true;
      return body;
    },
  };
  return { transport: async () => response, bodyWasRead: () => read };
}

const ask = (transport: EscalationTransport): Promise<unknown> =>
  escalatingDecider({ url: 'https://controller.example/decide', transport })(
    request,
    new AbortController().signal,
  );

test('a 2xx decision comes back intact, unread by this module', async () => {
  const { transport } = responding(
    200,
    JSON.stringify({ behavior: 'deny', message: 'the operator said no' }),
  );
  assert.deepEqual(await ask(transport), { behavior: 'deny', message: 'the operator said no' });
});

// The defect this file is built against: a client that parses the body first turns a 500 carrying
// a valid problem-details document into an object with no `allow`, whose falsy value renders as
// "blocked by operator". An outage impersonating a human decision.
test('regression: a non-2xx is an outage and the body is never read', async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
    const { transport, bodyWasRead } = responding(
      status,
      // A body that would parse perfectly and read as a denial if anyone looked at it.
      JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', allow: false }),
    );

    await assert.rejects(
      () => ask(transport),
      EscalationUnavailable,
      `${status} was not treated as an outage`,
    );
    assert.equal(
      bodyWasRead(),
      false,
      `the body of a ${status} was read — status must be discriminated first`,
    );
  }
});

test('the outage names the status, so an operator learns which half failed', async () => {
  const { transport } = responding(503, 'unavailable');
  await assert.rejects(
    () => ask(transport),
    (error: Error) => {
      assert.match(error.message, /503/);
      assert.match(error.message, /Write/);
      return true;
    },
  );
});

test('a transport that never connects is an outage, not a decision', async () => {
  const transport: EscalationTransport = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(() => ask(transport), EscalationUnavailable);
});

// Version skew produces a different decision, never a broken one — so a body that is not JSON is a
// controller-side failure, and only a well-formed answer can be an unrecognised one.
test('a 2xx whose body is not JSON is an outage, not an unrecognised decision', async () => {
  const { transport } = responding(200, '<html>proxy error</html>');
  await assert.rejects(
    () => ask(transport),
    (error: Error) => {
      assert.ok(error instanceof EscalationUnavailable);
      assert.match(error.message, /not JSON/);
      return true;
    },
  );
});

// The complement, and the reason the two are split: a well-formed answer this build does not
// understand must not be turned into an outage here. It has to reach the gate to be refused as
// unrecognised, because "the controller is a version ahead" and "the controller is down" are
// different investigations.
test('an answer this build does not understand passes through, not converted to an outage', async () => {
  const { transport } = responding(200, JSON.stringify({ behavior: 'escalate', tier: 3 }));
  assert.deepEqual(await ask(transport), { behavior: 'escalate', tier: 3 });
});

test("the request is posted as JSON with the embedder's headers, and carries the abort signal", async () => {
  let seen: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  } | null = null;
  const controller = new AbortController();

  await escalatingDecider({
    url: 'https://controller.example/decide',
    headers: { authorization: 'Bearer token' },
    transport: async (url, init) => {
      seen = { url, ...init };
      return { status: 200, text: async () => JSON.stringify({ behavior: 'allow' }) };
    },
  })(request, controller.signal);

  const call = seen as unknown as {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  };
  assert.equal(call.url, 'https://controller.example/decide');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers['authorization'], 'Bearer token');
  assert.deepEqual(JSON.parse(call.body), request);
  assert.equal(call.signal, controller.signal);
});
