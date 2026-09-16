/**
 * The loopback listener, on a real socket, because what is being asserted is what it binds and how
 * long it stays open, and neither is observable in a double.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { LOOPBACK_HOST, openLoopbackListener, openLoopbackListenerWith } from './loopback.js';

async function listener(timeoutMs = 5_000) {
  const opened = await openLoopbackListener(0, timeoutMs);
  assert.ok(opened.ok, opened.ok === false ? opened.refusal.detail : '');
  return opened.value;
}

test('regression: it binds 127.0.0.1, never every interface', () => {
  // The default binds 0.0.0.0, which would put an authorization callback endpoint on the network.
  // Nothing off this machine has any business reaching it, and the difference is one argument
  // nobody notices missing.
  assert.equal(LOOPBACK_HOST, '127.0.0.1');
});

test('an opened listener reports the port the OS gave it, and a matching redirect URI', async () => {
  const open = await listener();
  try {
    assert.ok(open.port > 0);
    assert.equal(open.redirectUri, `http://127.0.0.1:${open.port}/callback`);
  } finally {
    open.close();
  }
});

test('a callback on the redirect path resolves with its query string verbatim', async () => {
  const open = await listener();
  try {
    const response = await fetch(`${open.redirectUri}?code=the-code&state=the-state`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Signed in/);

    const result = await open.callback;

    assert.ok(result.ok);
    assert.equal(result.value, 'code=the-code&state=the-state');
  } finally {
    open.close();
  }
});

test('regression: the listener decides nothing about whether the callback belongs to this sign-in', async () => {
  // The `state` check belongs to `identity/authorize.ts` and is a pure function of the query
  // string. A listener that also validated would put the security decision in the one module that
  // needs a socket to test.
  const open = await listener();
  try {
    await fetch(`${open.redirectUri}?state=obviously-wrong&code=x`);

    const result = await open.callback;

    assert.ok(result.ok, 'the listener rejected a callback it should have handed on for checking');
  } finally {
    open.close();
  }
});

test('regression: a request to any other path does not end the wait', async () => {
  // A browser prefetch, or another local process scanning ports, must not be able to terminate a
  // sign-in that is still in progress.
  const open = await listener();
  try {
    const stray = await fetch(`http://127.0.0.1:${open.port}/favicon.ico`);
    assert.equal(stray.status, 404);

    // The wait is still open: prove it by completing it properly afterwards.
    await fetch(`${open.redirectUri}?code=real&state=s`);
    const result = await open.callback;

    assert.ok(result.ok);
    assert.equal(result.value, 'code=real&state=s');
  } finally {
    open.close();
  }
});

test('regression: it accepts exactly one callback and then closes', async () => {
  // A listener still open after answering is one something else can still reach, and there is no
  // second callback to wait for.
  const open = await listener();
  const port = open.port;

  await fetch(`${open.redirectUri}?code=first&state=s`);
  const result = await open.callback;
  assert.ok(result.ok);
  assert.equal(result.value, 'code=first&state=s');

  await assert.rejects(
    () => fetch(`http://127.0.0.1:${port}/callback?code=second&state=s`),
    'the port was still accepting connections after the sign-in completed',
  );
});

test('regression: an abandoned sign-in times out rather than holding the port forever', async () => {
  // This host runs unattended for weeks; a sign-in nobody finished must not leave a socket open.
  const open = await listener(150);

  const result = await open.callback;

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.refusal.reason : null, 'auth-callback-refused');
  assert.match(result.ok === false ? result.refusal.detail : '', /150ms/);
});

test('regression: closing before any callback settles the wait rather than leaving it pending forever', async () => {
  // A promise nobody will ever resolve is what turns a cancelled sign-in into a hung host — the
  // caller is awaiting a callback that can no longer arrive, on a port that no longer exists.
  const open = await listener(60_000);

  open.close();

  const result = await open.callback;
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.refusal.reason : null, 'auth-callback-refused');
  await assert.rejects(() => fetch(`http://127.0.0.1:${open.port}/callback`));
});

test('closing twice is not an error, and does not overwrite the first outcome', async () => {
  const open = await listener();
  await fetch(`${open.redirectUri}?code=real&state=s`);

  assert.doesNotThrow(() => {
    open.close();
    open.close();
  });

  const result = await open.callback;
  assert.ok(result.ok, 'a later close replaced a callback that had already succeeded');
});

test('two listeners can be open at once — the OS gives each its own port', async () => {
  const first = await listener();
  const second = await listener();
  try {
    assert.notEqual(first.port, second.port);
  } finally {
    first.close();
    second.close();
  }
});

test('a port already in use refuses by name rather than hanging', async () => {
  // A real bind conflict, not an emitted double: the second open races nothing and must come back
  // as a refusal the caller can read, naming the address it could not take.
  const first = await listener();
  try {
    const second = await openLoopbackListener(first.port, 5_000);
    assert.equal(second.ok, false);
    assert.equal(second.ok === false ? second.refusal.reason : null, 'identity-config-invalid');
    assert.match(second.ok === false ? second.refusal.detail : '', new RegExp(String(first.port)));
  } finally {
    first.close();
  }
});

test('regression: a server error after listening settles the wait with a refusal, never a silent hang', async () => {
  // No external trigger for a post-listen 'error' exists — the injected constructor is the only
  // way to hold the server this module builds. The emission is direct rather than induced (a
  // listen-twice trick would couple this pin to how each node version surfaces that mistake); the
  // subject under test is this module's routing of the event, which is real either way. Before the
  // routing existed, this wait never settled: the deadline timer was cleared, the outer promise was
  // already resolved, and the caller hung forever on a callback that could no longer arrive.
  let held: Server | null = null;
  const opened = await openLoopbackListenerWith(
    (handler) => {
      const server = createServer(handler);
      held = server;
      return server;
    },
    0,
    60_000,
  );
  assert.ok(opened.ok, opened.ok === false ? opened.refusal.detail : '');
  const open = opened.value;
  if (held === null) throw new Error('the injected constructor was never called');

  (held as Server).emit('error', new Error('accept failed'));

  let deadline: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      open.callback,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error('the wait never settled — the hang this test exists to refuse')),
          2_000,
        );
      }),
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.refusal.reason : null, 'auth-callback-refused');
    assert.match(result.ok === false ? result.refusal.detail : '', /accept failed/);
  } finally {
    clearTimeout(deadline);
    open.close();
  }

  // And the listener is actually gone, not merely reported gone.
  await assert.rejects(() => fetch(`http://127.0.0.1:${open.port}/callback`));
});
