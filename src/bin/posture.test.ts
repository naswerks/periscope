/**
 * The posture is pure over its inputs: every fact `status` prints and the one line `serve` prints
 * come from `describePosture`, so the cases here are the cases an operator meets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PostureInputs } from './posture.js';
import { describePosture, postureLine, renderPosture } from './posture.js';

const NOW = Date.parse('2026-09-11T12:00:00.000Z');

function inputs(overrides: Partial<PostureInputs> = {}): PostureInputs {
  return {
    raw: { PERISCOPE_CONFIG_DIR: '/secrets/periscope', PERISCOPE_CONTROLLER_URL: 'wss://c.example/link' },
    merged: {
      PERISCOPE_CONFIG_DIR: '/secrets/periscope',
      PERISCOPE_CONTROLLER_URL: 'wss://c.example/link',
      PERISCOPE_DECISION_URL: 'https://c.example/decision',
    },
    fileValues: { PERISCOPE_DECISION_URL: 'https://c.example/decision' },
    credential: { credential: null, pairedHostId: null },
    tokenExpiresAtMs: null,
    nowMs: NOW,
    link: null,
    pidAlive: () => false,
    hostname: 'this-machine',
    ...overrides,
  };
}

test('an absent credential, no link record and an unconfigured host id fall back to what the machine is', () => {
  const posture = describePosture(inputs());
  assert.equal(posture.credential.kind, 'absent');
  assert.equal(posture.hostId.effective, 'this-machine');
  assert.equal(posture.link.state, 'unknown');
  assert.equal(posture.workspace.mode, 'none');
  assert.match(renderPosture(posture).join('\n'), /link: unknown/);
  assert.match(renderPosture(posture).join('\n'), /credential: absent/);
});

test('every setting names its source: environment, config file, default, or unset, and a shadowed file value says so', () => {
  const posture = describePosture(inputs());
  const by = Object.fromEntries(posture.sources.map((one) => [one.key, one]));
  assert.equal(by['PERISCOPE_CONTROLLER_URL']?.source, 'environment');
  assert.equal(by['PERISCOPE_DECISION_URL']?.source, 'config-file');
  assert.equal(by['PERISCOPE_WORKSPACE_ROOT']?.source, 'unset');

  const shadowed = describePosture(
    inputs({
      raw: {
        PERISCOPE_CONFIG_DIR: '/secrets/periscope',
        PERISCOPE_DECISION_URL: 'https://env.example/decision',
      },
      merged: {
        PERISCOPE_CONFIG_DIR: '/secrets/periscope',
        PERISCOPE_DECISION_URL: 'https://env.example/decision',
      },
    }),
  );
  const decision = shadowed.sources.find((one) => one.key === 'PERISCOPE_DECISION_URL');
  assert.equal(decision?.source, 'environment');
  assert.equal(decision?.shadowsFile, true, 'the file holds a value the environment shadows');
  assert.match(renderPosture(shadowed).join('\n'), /shadowing the config file/);
});

test('a paired credential names the host id it is bound to, and it wins over the configured one', () => {
  const posture = describePosture(
    inputs({
      raw: { PERISCOPE_CONFIG_DIR: '/secrets/periscope', PERISCOPE_HOST_ID: 'configured-box' },
      merged: { PERISCOPE_CONFIG_DIR: '/secrets/periscope', PERISCOPE_HOST_ID: 'configured-box' },
      credential: { credential: null, pairedHostId: 'ph-42' },
    }),
  );
  assert.equal(posture.credential.kind, 'paired');
  assert.deepEqual(posture.hostId, { configured: 'configured-box', paired: 'ph-42', effective: 'ph-42' });
  assert.match(postureLine(posture), /host ph-42 \(paired; configured configured-box\)/);
  assert.match(renderPosture(posture).join('\n'), /no expiry; rotation is re-pairing/);
});

test('a signed-in token reports its expiry, and says EXPIRED once the clock has passed it', () => {
  const credential = { credential: {} as never, pairedHostId: null };
  const live = describePosture(inputs({ credential, tokenExpiresAtMs: NOW + 60_000 }));
  assert.equal(live.credential.kind, 'token');
  assert.equal(live.credential.expired, false);
  assert.match(renderPosture(live).join('\n'), /expires 2026-09-11T12:01:00\.000Z/);

  const stale = describePosture(inputs({ credential, tokenExpiresAtMs: NOW - 1 }));
  assert.equal(stale.credential.expired, true);
  assert.match(renderPosture(stale).join('\n'), /EXPIRED at/);
});

test('an unreadable credential is reported as such with its problem, never as absent', () => {
  const posture = describePosture(inputs({ credential: 'the paired credential file is not JSON' }));
  assert.equal(posture.credential.kind, 'unreadable');
  assert.match(
    renderPosture(posture).join('\n'),
    /credential: unreadable — the paired credential file is not JSON/,
  );
});

test('the link record reports its state, cause, negotiated version, and whether the serve that wrote it still runs', () => {
  const link = {
    state: 'accepted' as const,
    cause: 'hello_completed' as const,
    at: '2026-09-11T11:59:00.000Z',
    detail: 'protocol v9',
    negotiatedVersion: 9,
    pid: 4242,
  };
  const running = describePosture(inputs({ link, pidAlive: (pid) => pid === 4242 }));
  assert.equal(running.link.alive, true);
  const text = renderPosture(running).join('\n');
  assert.match(
    text,
    /link: accepted since 2026-09-11T11:59:00\.000Z \(hello_completed: protocol v9\); serve pid 4242 is running/,
  );
  assert.match(text, /protocol: v9 negotiated/);

  const gone = describePosture(inputs({ link, pidAlive: () => false }));
  assert.match(renderPosture(gone).join('\n'), /serve pid 4242 is gone, so this is the last thing it said/);
});

test('the workspace mode follows the roots: both give git worktrees, one gives plain directories, none gives none', () => {
  const both = describePosture(
    inputs({
      raw: { PERISCOPE_CONFIG_DIR: '/s', PERISCOPE_WORKSPACE_ROOT: '/w', PERISCOPE_REPOSITORY_ROOT: '/r' },
      merged: { PERISCOPE_CONFIG_DIR: '/s', PERISCOPE_WORKSPACE_ROOT: '/w', PERISCOPE_REPOSITORY_ROOT: '/r' },
    }),
  );
  assert.equal(both.workspace.mode, 'git-worktree');
  const one = describePosture(
    inputs({
      raw: { PERISCOPE_CONFIG_DIR: '/s', PERISCOPE_WORKSPACE_ROOT: '/w' },
      merged: { PERISCOPE_CONFIG_DIR: '/s', PERISCOPE_WORKSPACE_ROOT: '/w' },
    }),
  );
  assert.equal(one.workspace.mode, 'plain');
});
