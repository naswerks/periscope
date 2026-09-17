/**
 * What a refused WebSocket handshake does to the link.
 *
 * A 401/403 on the upgrade is the controller judging who is asking, and the link treats it the way
 * the token layer treats a dead grant: terminal, named, no redial. Any other non-101 answer keeps
 * the retry loop, because a peer mid-deploy answering 502 is an outage and the grant may be fine.
 * The pair below is the discriminator: same harness, one status code changes, and the two sides
 * must disagree about whether the link keeps trying.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Refusal } from '../core/refusal.js';
import type { LinkTransition } from './link-state.js';
import { ControllerLink } from './link.js';

/** An HTTP server that answers every WebSocket upgrade with one raw status line and hangs up. */
async function upgradeRefuser(
  status: number,
  text: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer();
  server.on('upgrade', (_request, socket) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Observed {
  readonly transitions: LinkTransition[];
  readonly refusals: Refusal[];
}

function linkAgainst(url: string): { link: ControllerLink; observed: Observed } {
  const observed: Observed = { transitions: [], refusals: [] };
  const link = new ControllerLink({
    url,
    hostId: 'upgrade-test-host',
    backoff: { baseMs: 10, maxMs: 40, factor: 2 },
    handlers: {
      onTransition: (transition) => observed.transitions.push(transition),
      onSessionFrame: () => {},
      onGap: () => {},
      onRefusal: (refused) => observed.refusals.push(refused),
    },
  });
  return { link, observed };
}

for (const status of [401, 403] as const) {
  test(`regression: an upgrade refused ${status} is terminal — named link-unauthorized, closed, never redialled`, async () => {
    const server = await upgradeRefuser(status, status === 401 ? 'Unauthorized' : 'Forbidden');
    const { link, observed } = linkAgainst(server.url);

    try {
      link.start();
      await waitFor(() => link.state === 'closed', 'the link to close');

      const named = observed.refusals.find((refused) => refused.reason === 'link-unauthorized');
      assert.ok(
        named !== undefined,
        `no link-unauthorized was surfaced: ${observed.refusals.map((r) => r.reason).join(', ')}`,
      );
      assert.match(
        named.detail,
        new RegExp(`HTTP ${status}`),
        'the detail must carry the status the peer answered',
      );
      assert.match(named.detail, /sign in again/, 'the detail must end in the action a person can take');

      const closing = observed.transitions.at(-1);
      assert.equal(closing?.to, 'closed', 'the link must end closed, not sitting in backoff');
      assert.equal(
        closing?.cause,
        'credential_rejected',
        'the close must carry the cause the composition root exits on',
      );
      assert.ok(
        !observed.transitions.some((transition) => transition.to === 'backoff'),
        `a terminal refusal must never enter backoff: ${observed.transitions.map((t) => `${t.from}->${t.to}`).join(', ')}`,
      );

      // And it stays closed: a redial would show up here as a new connecting transition.
      const seen = observed.transitions.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(observed.transitions.length, seen, 'the link moved again after announcing it was done');
    } finally {
      link.stop('test finished');
      await server.close();
    }
  });
}

test('control: any other unexpected status stays a retry, or the pair above is not a discriminator', async () => {
  // 502 is a peer mid-deploy: the identity was never judged, so the link must keep dialling. If
  // this case ever closes terminally, the terminal branch has widened past 401/403 and the two
  // tests in this file have become one observation wearing two names.
  const server = await upgradeRefuser(502, 'Bad Gateway');
  const { link, observed } = linkAgainst(server.url);

  try {
    link.start();
    await waitFor(
      () => observed.transitions.some((transition) => transition.to === 'backoff'),
      'a backoff transition',
    );

    assert.ok(
      !observed.refusals.some((refused) => refused.reason === 'link-unauthorized'),
      'a 502 must not wear the identity-refusal name',
    );
    assert.ok(
      observed.refusals.some((refused) => refused.reason === 'link-send-failed'),
      `the failed handshake is still named: ${observed.refusals.map((r) => r.reason).join(', ')}`,
    );
    assert.ok(
      !observed.transitions.some((transition) => transition.cause === 'credential_rejected'),
      'an outage must not close the link as though a person were required',
    );

    // And it dials again: the retry is observable, not assumed.
    await waitFor(
      () => observed.transitions.filter((transition) => transition.to === 'connecting').length >= 2,
      'a second connect attempt',
    );
  } finally {
    link.stop('test finished');
    await server.close();
  }
});
