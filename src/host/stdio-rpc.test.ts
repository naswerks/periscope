import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import type { JsonObject } from '../control/frames.js';
import type { Refusal } from '../core/refusal.js';
import { drain, fakeChild, spawnerFor } from '../test-support/fake-child.js';
import type { FakeChild } from '../test-support/fake-child.js';
import type { StdioRpcOptions, StdioRpcPeer } from './stdio-rpc.js';
import {
  JsonLineDecoder,
  RPC_METHOD_NOT_FOUND,
  RPC_SERVER_OVERLOADED,
  classifyRpc,
  isBatchFile,
  startStdioRpc,
} from './stdio-rpc.js';

const RPC_CHILD = fileURLToPath(new URL('../test-support/rpc-child.js', import.meta.url));

interface Started {
  readonly peer: StdioRpcPeer;
  readonly child: FakeChild;
  readonly notifications: { method: string; params: JsonObject }[];
  readonly refusals: Refusal[];
  readonly stderr: string[];
}

function started(options: Partial<StdioRpcOptions> = {}): Started {
  const child = fakeChild();
  const notifications: { method: string; params: JsonObject }[] = [];
  const refusals: Refusal[] = [];
  const stderr: string[] = [];
  const result = startStdioRpc({
    command: 'C:/tools/server.exe',
    args: ['serve', '--stdio'],
    cwd: 'C:/work',
    env: { PATH: 'p' },
    onNotification: (method, params) => notifications.push({ method, params }),
    onRefusal: (refusal) => refusals.push(refusal),
    onStderr: (line) => stderr.push(line),
    spawn: spawnerFor(child),
    closeGraceMs: 50,
    killTree: () => Promise.resolve(),
    ...options,
  });
  assert.ok(result.ok, result.ok ? '' : result.refusal.detail);
  return { peer: result.value, child, notifications, refusals, stderr };
}

test('the child is started with the argv, cwd and environment given, and nothing else', () => {
  const { child } = started();
  assert.deepEqual(child.spawned, {
    command: 'C:/tools/server.exe',
    args: ['serve', '--stdio'],
    cwd: 'C:/work',
    env: { PATH: 'p' },
  });
});

test('a batch file is refused as the child before anything is spawned', () => {
  const child = fakeChild();
  for (const command of ['C:/tools/codex.cmd', 'C:/tools/CODEX.BAT']) {
    const result = startStdioRpc({ command, args: [], cwd: 'C:/work', env: {}, spawn: spawnerFor(child) });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.refusal.detail, /batch file, which runs only through a shell/);
  }
  assert.equal(child.spawned, null, 'a batch file was spawned');
  assert.equal(isBatchFile('C:/tools/codex.exe'), false);
  assert.equal(isBatchFile('/usr/bin/codex'), false);
});

test('a request carries an integer id and jsonrpc 2.0, and its answer settles it by id', async () => {
  const { peer, child } = started();
  const first = peer.request('thread/start', { model: null }, 1000);
  const second = peer.request('model/list', {}, 1000);
  await drain();
  assert.deepEqual(child.received, [
    { jsonrpc: '2.0', id: 1, method: 'thread/start', params: { model: null } },
    { jsonrpc: '2.0', id: 2, method: 'model/list', params: {} },
  ]);
  child.send({ id: 2, result: { data: [] } });
  child.send({ id: 1, result: { thread: { id: 't-1' } } });
  assert.deepEqual(await first, { ok: true, value: { thread: { id: 't-1' } } });
  assert.deepEqual(await second, { ok: true, value: { data: [] } });
});

test('a notification carries jsonrpc 2.0 and no id', async () => {
  const { peer, child } = started();
  peer.notify('initialized', {});
  await drain();
  assert.deepEqual(child.received, [{ jsonrpc: '2.0', method: 'initialized', params: {} }]);
});

test('notifications reach the handler in arrival order, one that arrives before its answer included', async () => {
  const { peer, child, notifications } = started();
  const asked = peer.request('turn/start', {}, 1000);
  let answeredAt = -1;
  void asked.then(() => {
    answeredAt = notifications.length;
  });
  await drain();
  child.write(
    `${JSON.stringify({ method: 'turn/started', params: { n: 1 } })}\n` +
      `${JSON.stringify({ id: 1, result: { turn: { id: 'u-1' } } })}\n` +
      `${JSON.stringify({ method: 'item/started', params: { n: 2 } })}\n`,
  );
  await asked;
  await drain();
  assert.deepEqual(
    notifications.map((notification) => notification.method),
    ['turn/started', 'item/started'],
  );
  assert.ok(answeredAt >= 1, 'the notification that arrived first was delivered after the answer');
});

test('a request from the child is answered with its own id, a string or an integer, verbatim', async () => {
  const { child } = started({
    onRequest: (method, params) => ({ result: { method, params } }),
  });
  child.send({ id: 'req-7', method: 'item/tool/requestUserInput', params: { a: 1 } });
  child.send({ id: 0, method: 'item/fileChange/requestApproval', params: {} });
  await drain();
  assert.deepEqual(child.received, [
    {
      jsonrpc: '2.0',
      id: 'req-7',
      result: { method: 'item/tool/requestUserInput', params: { a: 1 } },
    },
    { jsonrpc: '2.0', id: 0, result: { method: 'item/fileChange/requestApproval', params: {} } },
  ]);
});

test('control: with no handler every request from the child is answered -32601, never left waiting', async () => {
  const { child } = started();
  child.send({ id: 3, method: 'currentTime/read', params: {} });
  await drain();
  assert.equal(child.received.length, 1);
  const answer = child.received[0] as { id: number; error: { code: number } };
  assert.equal(answer.id, 3);
  assert.equal(answer.error.code, RPC_METHOD_NOT_FOUND);
});

test("a handler that throws is answered with an error, so the child's request is refused, not left waiting", async () => {
  const { child } = started({
    onRequest: () => {
      throw new Error('the decider is not here');
    },
  });
  child.send({ id: 4, method: 'item/commandExecution/requestApproval', params: {} });
  await drain();
  const answer = child.received[0] as { id: number; error: { code: number; message: string } };
  assert.equal(answer.id, 4);
  assert.equal(answer.error.code, -32603);
  assert.match(answer.error.message, /the decider is not here/);
});

test('no answer by the deadline is rpc-request-timed-out, and a late answer is dropped', async () => {
  const { peer, child } = started();
  const asked = await peer.request('thread/start', {}, 20);
  assert.equal(asked.ok, false);
  assert.equal(asked.ok ? '' : asked.refusal.reason, 'rpc-request-timed-out');
  assert.match(asked.ok ? '' : asked.refusal.detail, /thread\/start met no answer within 20 ms/);
  child.send({ id: 1, result: {} });
  await drain();
});

test('an error answer is rpc-request-failed with its code and message; the overload code is rpc-server-overloaded', async () => {
  const { peer, child } = started();
  const failed = peer.request('thread/start', {}, 1000);
  const busy = peer.request('turn/start', {}, 1000);
  await drain();
  child.send({ id: 1, error: { code: -32600, message: 'Invalid request' } });
  child.send({ id: 2, error: { code: RPC_SERVER_OVERLOADED, message: 'Server overloaded; retry later.' } });
  const first = await failed;
  const second = await busy;
  assert.equal(first.ok ? '' : first.refusal.reason, 'rpc-request-failed');
  assert.match(first.ok ? '' : first.refusal.detail, /thread\/start answered -32600: Invalid request/);
  assert.equal(second.ok ? '' : second.refusal.reason, 'rpc-server-overloaded');
});

test('a malformed line is dropped by name and the peer keeps reading', async () => {
  const { child, notifications, refusals } = started();
  child.write('this is not json\n');
  child.write('[1,2]\n');
  child.write('{"neither":"method nor id"}\n');
  child.send({ method: 'thread/started', params: {} });
  await drain();
  assert.deepEqual(
    refusals.map((refusal) => refusal.reason),
    ['rpc-line-malformed', 'rpc-line-malformed', 'rpc-line-malformed'],
  );
  assert.deepEqual(
    notifications.map((notification) => notification.method),
    ['thread/started'],
  );
});

test('a line past the bound is dropped whole by name, and the next line is read', async () => {
  const { child, notifications, refusals } = started({ maxLineBytes: 64 });
  child.write(`${JSON.stringify({ method: 'item/completed', params: { out: 'x'.repeat(200) } })}\n`);
  child.send({ method: 'turn/completed', params: {} });
  await drain();
  assert.deepEqual(
    refusals.map((refusal) => refusal.reason),
    ['rpc-line-too-large'],
  );
  assert.deepEqual(
    notifications.map((notification) => notification.method),
    ['turn/completed'],
  );
});

test('stderr reaches its listener line by line, a carriage return dropped', async () => {
  const { child, stderr } = started();
  child.stderr('first line\r\nsecond ');
  child.stderr('half\n');
  await drain();
  assert.deepEqual(stderr, ['first line', 'second half']);
});

test('a child that ends with a request waiting refuses it rpc-request-failed, naming how it ended', async () => {
  const { peer, child } = started();
  const asked = peer.request('turn/start', {}, 5000);
  await drain();
  child.exit(1);
  const result = await asked;
  assert.equal(result.ok ? '' : result.refusal.reason, 'rpc-request-failed');
  assert.match(result.ok ? '' : result.refusal.detail, /ended before it answered \(exit code 1\)/);
  assert.deepEqual(await peer.exited, { code: 1, signal: null, error: null });
  const after = await peer.request('turn/start', {}, 5000);
  assert.match(after.ok ? '' : after.refusal.detail, /the peer has ended/);
});

test('close ends stdin, waits out the grace, kills the tree of a child still running, and is idempotent', async () => {
  const killed: number[] = [];
  const { peer, child } = started({
    killTree: (pid) => {
      killed.push(pid);
      child.exit(null, 'SIGKILL');
      return Promise.resolve();
    },
  });
  const waiting = peer.request('turn/interrupt', {}, 5000);
  const first = peer.close();
  const second = peer.close();
  assert.equal(first, second, 'a second close started a second ending');
  const refused = await waiting;
  assert.equal(refused.ok ? '' : refused.refusal.reason, 'rpc-request-failed');
  await first;
  assert.equal(child.stdinEnded, true, 'stdin was not ended');
  assert.deepEqual(killed, [4242]);
  assert.equal(peer.ended, true);
});

test('a child that leaves on its own when stdin ends is not tree-killed on Windows', async () => {
  const killed: number[] = [];
  const { peer, child } = started({
    killTree: (pid) => {
      killed.push(pid);
      return Promise.resolve();
    },
  });
  child.onLine(() => undefined);
  const closing = peer.close();
  child.exit(0);
  await closing;
  assert.deepEqual(killed, process.platform === 'win32' ? [] : [4242]);
});

test('classification: a request, a notification, an answer and an error answer; a missing params reads as empty', () => {
  assert.deepEqual(classifyRpc({ id: 1, method: 'a' }), {
    ok: true,
    value: { kind: 'request', id: 1, method: 'a', params: {} },
  });
  assert.deepEqual(classifyRpc({ method: 'b', params: { x: 1 } }), {
    ok: true,
    value: { kind: 'notification', method: 'b', params: { x: 1 } },
  });
  assert.deepEqual(classifyRpc({ id: 'k', result: null }), {
    ok: true,
    value: { kind: 'answer', id: 'k', result: null },
  });
  assert.deepEqual(classifyRpc({ id: 2, error: { code: -1, message: 'm' } }), {
    ok: true,
    value: { kind: 'error', id: 2, error: { code: -1, message: 'm' } },
  });
  for (const malformed of [
    { id: 1.5, method: 'a' },
    { method: 'a', params: [1] },
    { id: {}, result: 1 },
    'x',
  ]) {
    const classified = classifyRpc(malformed);
    assert.equal(
      classified.ok ? '' : classified.refusal.reason,
      'rpc-line-malformed',
      JSON.stringify(malformed),
    );
  }
});

test('the decoder reads a value split mid-character and a last line with no newline', () => {
  const decoder = new JsonLineDecoder();
  const bytes = Buffer.from(`${JSON.stringify({ text: 'é漢𝄞' })}\n${JSON.stringify({ last: true })}`, 'utf8');
  const split = bytes.indexOf(0xe6) + 1;
  const values = [
    ...decoder.push(bytes.subarray(0, split)),
    ...decoder.push(bytes.subarray(split)),
    ...decoder.end(),
  ];
  assert.deepEqual(values, [
    { ok: true, value: { text: 'é漢𝄞' } },
    { ok: true, value: { last: true } },
  ]);
});

// ---------------------------------------------------------------------------
// A real child process
// ---------------------------------------------------------------------------

function realPeer(behaviour: string, extra: Partial<StdioRpcOptions> = {}): StdioRpcPeer {
  const result = startStdioRpc({
    command: process.execPath,
    args: [RPC_CHILD, behaviour],
    cwd: process.cwd(),
    env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' },
    closeGraceMs: 400,
    ...extra,
  });
  assert.ok(result.ok, result.ok ? '' : result.refusal.detail);
  return result.value;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

test('a real child answers a request, and closing ends it', async () => {
  const peer = realPeer('echo');
  const answered = await peer.request('ping', { n: 1 }, 5000);
  assert.deepEqual(answered, { ok: true, value: { echo: { n: 1 } } });
  await peer.close();
  const exit = await peer.exited;
  assert.equal(exit.error, null);
});

test('a real child that crashes mid-request refuses the request rpc-request-failed with its exit code', async () => {
  const peer = realPeer('crash-on-request');
  const result = await peer.request('turn/start', {}, 5000);
  assert.equal(result.ok ? '' : result.refusal.reason, 'rpc-request-failed');
  assert.match(result.ok ? '' : result.refusal.detail, /exit code 3/);
  await peer.close();
});

test('closing a real child that ignores stdin kills its whole tree, its own child included', async () => {
  let pids: { child: number; grandchild: number } | null = null;
  const peer = realPeer('grandchild', {
    onNotification: (method, params) => {
      if (method === 'pids') pids = params as unknown as { child: number; grandchild: number };
    },
  });
  assert.ok(await until(() => pids !== null), 'the child never reported its pids');
  const { child, grandchild } = pids as unknown as { child: number; grandchild: number };
  assert.ok(alive(child) && alive(grandchild), 'the tree was not running before close');
  await peer.close();
  assert.ok(await until(() => !alive(child)), 'the child survived close');
  assert.ok(await until(() => !alive(grandchild)), "the child's own child survived close");
});
