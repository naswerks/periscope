/**
 * `session_end` against a real agent: a controller ends a session over a real link after a real turn,
 * and the end reaches it as the session's transition to `ended`, caused by `stop_requested`.
 *
 * It skips loudly. Without `PERISCOPE_LIVE=1` the probe is skipped with the reason in its name, and
 * the property is NOT exercised. Its workspace comes from the OS temp directory, outside any
 * repository, and the turn runs on the cheapest model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject } from '../control/frames.js';
import { PROTOCOL_VERSION, readStateTransition, sessionNew, sessionNewRequest } from '../control/frames.js';
import { SessionRegistry } from '../sessions/registry.js';
import type { SessionTransition } from '../state/model.js';
import { peerOn, waitFor } from '../test-support/ws-peer.js';
import { PeriscopeHost } from './host.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const skip = LIVE ? false : 'PERISCOPE_LIVE is not set — this property is NOT exercised';

const START_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 180_000;
const END_TIMEOUT_MS = 30_000;

const allow = async (): Promise<unknown> => ({ behavior: 'allow' });

/** Every state transition the peer received on one session's channel, in order. */
function transitionsOn(raw: readonly string[], sessionId: string): SessionTransition[] {
  const found: SessionTransition[] = [];
  for (const text of raw) {
    const frame = JSON.parse(text) as {
      frame?: string;
      sessionId?: string;
      payload?: { kind?: string; body?: unknown };
    };
    if (
      frame.frame !== 'session' ||
      frame.sessionId !== sessionId ||
      frame.payload?.kind !== 'session_update'
    )
      continue;
    const transition = readStateTransition(frame.payload.body as JsonObject);
    if (transition !== null) found.push(transition);
  }
  return found;
}

test(
  'live: session_end ends a real session, and the end reaches the controller as stop_requested',
  { skip, timeout: 420_000 },
  async () => {
    const cwd = mkdtempSync(`${tmpdir()}/periscope-session-end-`);
    const peer = await peerOn({ ack: true });
    const host = new PeriscopeHost({
      controllerUrl: peer.url,
      hostId: 'live-session-end',
      decide: allow,
      protectedPaths: [],
      registry: new SessionRegistry({
        baseEnv: process.env,
        homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
        startTimeoutMs: START_TIMEOUT_MS,
      }),
    });

    try {
      host.start();
      await waitFor(() => host.link.negotiatedVersion === PROTOCOL_VERSION, 'the welcome', START_TIMEOUT_MS);

      peer.send('s-1', 1, sessionNew(cwd, { request: sessionNewRequest({ model: 'haiku' }) }));
      peer.send('s-1', 2, { kind: 'session_prompt', text: 'Reply with the single word: ok' });
      await waitFor(
        () => transitionsOn(peer.raw, 's-1').some((transition) => transition.cause.event === 'result'),
        'the turn to end',
        TURN_TIMEOUT_MS,
      );

      peer.send('s-1', 3, { kind: 'session_end' });
      await waitFor(
        () => transitionsOn(peer.raw, 's-1').some((transition) => transition.to === 'ended'),
        'the end to reach the controller',
        END_TIMEOUT_MS,
      );

      const ended = transitionsOn(peer.raw, 's-1').find((transition) => transition.to === 'ended');
      assert.equal(
        ended?.cause.event,
        'stop_requested',
        `the session ended for another reason: ${JSON.stringify(ended?.cause)}`,
      );
      assert.equal(host.session('s-1').ok, false, 'the host still holds the session it ended');
    } finally {
      host.stop();
      await peer.close();
      // The agent's process lets go of its directory a moment after it exits on Windows; a failed
      // cleanup must not stand in for the probe's own answer.
      try {
        rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // Left in the OS temp directory.
      }
    }
  },
);
