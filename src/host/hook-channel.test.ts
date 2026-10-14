/**
 * The hook channel: a pipe or a socket, never a port; a request with the wrong token never reaches the
 * decider; every answer authenticated for the request it answers; a connection that sends nothing, too
 * much or something unreadable is closed; and closing the channel abandons what it was deciding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { HookDecision } from '../gate/hook-exchange.js';
import { HOOK_EXCHANGE_VERSION, MAX_HOOK_INPUT_BYTES, readHookAnswer } from '../gate/hook-exchange.js';
import { sourceFiles } from '../pins/walk.js';
import { openHookChannel } from './hook-channel.js';

/** Send one line and read the one answer line, or null when the channel closed without one. */
function exchange(address: string, line: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect(address);
    let answer = '';
    socket.on('connect', () => socket.write(line));
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('utf8');
    });
    socket.on('error', () => resolve(null));
    socket.on('close', () => resolve(answer === '' ? null : answer.trim()));
  });
}

const request = (
  token: string,
  nonce: string,
  event: unknown = { tool: 'x' },
  kind = 'decide',
  runtime = 'codex',
): string => `${JSON.stringify({ v: HOOK_EXCHANGE_VERSION, kind, token, nonce, runtime, event })}\n`;

test('the channel is a pipe name or a socket path, never a host and a port', async () => {
  const channel = openHookChannel({
    runtime: 'codex',
    version: '1.7.0',
    decide: () => Promise.resolve({ allow: true }),
  });
  try {
    assert.equal((await channel.ready()).ok, true);
    assert.equal(typeof channel.address, 'string');
    if (process.platform === 'win32')
      assert.ok(channel.address.startsWith('\\\\.\\pipe\\periscope-hook-'), channel.address);
    else assert.ok(channel.address.endsWith('/s'), channel.address);
    assert.doesNotMatch(channel.address, /:\d+$/, 'the address names a port');
  } finally {
    channel.close();
  }
});

test('a decision is answered and authenticated for the request it answers', async () => {
  const asked: unknown[] = [];
  const channel = openHookChannel({
    runtime: 'codex',
    version: '1.7.0',
    decide: (event) => {
      asked.push(event);
      return Promise.resolve({ allow: false, reason: 'the operator said no' });
    },
  });
  try {
    await channel.ready();
    const answer = await exchange(
      channel.address,
      request(channel.token, 'nonce-one', { tool_name: 'Bash' }),
    );
    assert.ok(answer !== null);
    assert.deepEqual(readHookAnswer(answer, channel.token, 'nonce-one'), {
      allow: false,
      reason: 'the operator said no',
    });
    assert.deepEqual(asked, [{ tool_name: 'Bash' }]);
  } finally {
    channel.close();
  }
});

test('control: a request with the wrong token is refused and never reaches the decider', async () => {
  let asked = 0;
  const refusals: string[] = [];
  const channel = openHookChannel({
    runtime: 'codex',
    version: '1.7.0',
    decide: () => {
      asked += 1;
      return Promise.resolve({ allow: true });
    },
    onRefused: (detail) => refusals.push(detail),
  });
  try {
    await channel.ready();
    const answer = await exchange(channel.address, request('not-the-token', 'nonce-one'));
    assert.equal(asked, 0, 'an unauthenticated ask reached the decider');
    assert.ok(
      answer === null || readHookAnswer(answer, channel.token, 'nonce-one') === null,
      'it was answered as if authorized',
    );
    assert.ok(
      refusals.some((detail) => detail.includes('wrong token')),
      refusals.join('; '),
    );
    // The positive control on the same channel: the right token is asked.
    await exchange(channel.address, request(channel.token, 'nonce-two'));
    assert.equal(asked, 1);
  } finally {
    channel.close();
  }
});

test('a hello is answered with the version, and a request naming another runtime is refused', async () => {
  const channel = openHookChannel({
    runtime: 'codex',
    version: '1.7.0',
    decide: () => Promise.resolve({ allow: true }),
  });
  try {
    await channel.ready();
    const hello = await exchange(channel.address, request(channel.token, 'nonce-one', undefined, 'hello'));
    assert.deepEqual(readHookAnswer(hello ?? '', channel.token, 'nonce-one'), { ok: true, version: '1.7.0' });
    const other = await exchange(
      channel.address,
      request(channel.token, 'nonce-two', {}, 'decide', 'qwen-code'),
    );
    assert.equal(
      (readHookAnswer(other ?? '', channel.token, 'nonce-two') as HookDecision | null)?.allow,
      false,
    );
  } finally {
    channel.close();
  }
});

test('an unreadable line and an oversize request are closed without a decision', async () => {
  let asked = 0;
  const channel = openHookChannel({
    runtime: 'codex',
    version: '1.7.0',
    decide: () => {
      asked += 1;
      return Promise.resolve({ allow: true });
    },
  });
  try {
    await channel.ready();
    assert.equal(await exchange(channel.address, 'not json\n'), null);
    const oversize = 'x'.repeat(MAX_HOOK_INPUT_BYTES + 16);
    assert.equal(await exchange(channel.address, oversize), null);
    assert.equal(asked, 0);
  } finally {
    channel.close();
  }
});

test('closing the channel abandons a decision it was waiting on', async () => {
  let aborted = false;
  const channel = openHookChannel({
    runtime: 'codex',
    version: '1.7.0',
    decide: (_event, signal) =>
      new Promise<HookDecision>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ allow: false, reason: 'abandoned' });
        });
      }),
  });
  await channel.ready();
  const pending = exchange(channel.address, request(channel.token, 'nonce-one'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  channel.close();
  assert.equal(await pending, null);
  assert.equal(aborted, true, 'the decision was left outstanding');
});

test('the only listening sockets this package opens are the hook channel, on a path, and the sign-in loopback', () => {
  const listens = sourceFiles()
    .filter((file) => !file.path.endsWith('.test.ts') && /\.listen\(/.test(file.text))
    .map((file) => file.path)
    .sort();
  assert.deepEqual(listens, ['host/hook-channel.ts', 'host/loopback.ts']);
  const channel = readFileSync(
    fileURLToPath(new URL('../../src/host/hook-channel.ts', import.meta.url)),
    'utf8',
  );
  assert.match(
    channel,
    /server\.listen\(address,/,
    'the channel listens on something other than its address',
  );
});

test('a hello with the session token, naming the channel runtime, is told to its listener with what it carried; one with the wrong token or another runtime is not', async () => {
  const told: unknown[] = [];
  const channel = openHookChannel({
    runtime: 'pi',
    version: '1.7.0',
    decide: () => Promise.resolve({ allow: true }),
    onHello: (event) => told.push(event),
  });
  try {
    await channel.ready();
    await exchange(
      channel.address,
      request('not-the-token', 'nonce-one', { reason: 'startup' }, 'hello', 'pi'),
    );
    await exchange(
      channel.address,
      request(channel.token, 'nonce-two', { reason: 'startup' }, 'hello', 'codex'),
    );
    assert.deepEqual(told, [], 'a hello that does not belong to the session was told');
    const hello = await exchange(
      channel.address,
      request(channel.token, 'nonce-three', { reason: 'startup' }, 'hello', 'pi'),
    );
    assert.deepEqual(readHookAnswer(hello ?? '', channel.token, 'nonce-three'), {
      ok: true,
      version: '1.7.0',
    });
    assert.deepEqual(told, [{ reason: 'startup' }]);
  } finally {
    channel.close();
  }
});

test(
  'a channel that cannot listen refuses with the reason its runtime gave it, and with the hook reason when none was given',
  {
    skip:
      process.platform === 'win32'
        ? false
        : 'a channel is made to fail to listen only on Windows, where a socket path is no pipe name',
  },
  async () => {
    const given = openHookChannel({
      runtime: 'pi',
      version: '1.7.0',
      platform: 'linux',
      unavailableReason: 'pi-extension-not-active',
      decide: () => Promise.resolve({ allow: true }),
    });
    const unnamed = openHookChannel({
      runtime: 'codex',
      version: '1.7.0',
      platform: 'linux',
      decide: () => Promise.resolve({ allow: true }),
    });
    try {
      const refused = await given.ready();
      assert.equal(refused.ok ? null : refused.refusal.reason, 'pi-extension-not-active');
      const defaulted = await unnamed.ready();
      assert.equal(defaulted.ok ? null : defaulted.refusal.reason, 'codex-hook-not-active');
    } finally {
      given.close();
      unnamed.close();
    }
  },
);
