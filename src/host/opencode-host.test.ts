import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { ok, refuse } from '../core/result.js';
import { waitFor } from '../test-support/ws-peer.js';
import { OPENCODE_HOST_CALLS, serveOpencodeHost } from './opencode-host.js';
import type {
  OpencodeCreateOptions,
  OpencodeEvent,
  OpencodeHost,
  OpencodeInstall,
  OpencodeSdk,
} from './opencode-sdk.js';

const INSTALL: OpencodeInstall = { directory: 'C:/sdk', entry: 'C:/sdk/index.js', sdkVersion: '2.3.0' };

/** A server stand-in: each member records its call; the stream yields what is pushed until it ends. */
function fakeServer(options: { readonly streamError?: string; readonly failing?: string } = {}) {
  const calls: { member: string; input: unknown }[] = [];
  const pushed: OpencodeEvent[] = [];
  let wake: () => void = () => undefined;
  let closed = false;
  const member =
    (name: string, answer: unknown = null) =>
    (input: unknown): Promise<never> => {
      calls.push({ member: name, input });
      if (options.failing === name)
        return Promise.reject(Object.assign(new Error('it failed'), { _tag: 'NotFound' }));
      return Promise.resolve(answer as never);
    };
  const host = {
    session: {
      create: member('session.create', { id: 'ses_1' }),
      get: member('session.get', { id: 'ses_1' }),
      prompt: member('session.prompt'),
      interrupt: member('session.interrupt', { interrupted: true }),
      remove: member('session.remove'),
      fork: member('session.fork'),
      switchModel: member('session.switchModel'),
      switchAgent: member('session.switchAgent'),
      environment: member('session.environment'),
      form: { cancel: member('session.form.cancel') },
    },
    permission: { reply: member('permission.reply'), saved: { list: member('permission.saved.list', []) } },
    agent: { list: member('agent.list', { data: [] }) },
    plugin: { list: member('plugin.list', { data: [] }) },
    mcp: { list: member('mcp.list', { data: [] }) },
    config: { get: member('config.get', []) },
    model: { list: member('model.list', { data: [] }) },
    event: {
      async *subscribe(subscribeOptions?: { readonly signal?: AbortSignal }): AsyncIterable<OpencodeEvent> {
        calls.push({
          member: 'event.subscribe',
          input: subscribeOptions?.signal === undefined ? 'no signal' : 'a signal',
        });
        if (options.streamError !== undefined) throw new Error(options.streamError);
        while (!closed && subscribeOptions?.signal?.aborted !== true) {
          const next = pushed.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    close: () => {
      closed = true;
      calls.push({ member: 'close', input: null });
      wake();
      return Promise.resolve();
    },
  } satisfies OpencodeHost;
  return {
    host,
    calls,
    push(event: OpencodeEvent) {
      pushed.push(event);
      wake();
    },
  };
}

function served(server: ReturnType<typeof fakeServer>, overrides: { loadFails?: string } = {}) {
  const input = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  const created: OpencodeCreateOptions[] = [];
  let exited = false;
  const sdk: OpencodeSdk = {
    create: (options) => {
      created.push(options);
      return Promise.resolve(server.host);
    },
  };
  const done = serveOpencodeHost({
    input,
    write: (line) => {
      for (const one of line.split('\n').filter((text) => text !== ''))
        lines.push(JSON.parse(one) as Record<string, unknown>);
    },
    readInstall: () => ok(INSTALL),
    loadSdk: () =>
      Promise.resolve(
        overrides.loadFails === undefined ? ok(sdk) : refuse('runtime-unavailable', overrides.loadFails),
      ),
    exit: () => {
      exited = true;
    },
  });
  let next = 0;
  const request = (method: string, params: Record<string, unknown>): number => {
    next += 1;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
    return next;
  };
  const answerTo = async (id: number): Promise<Record<string, unknown>> => {
    await waitFor(() => lines.some((line) => line['id'] === id), `the answer to ${id}`);
    return lines.find((line) => line['id'] === id) ?? {};
  };
  const open = (): number =>
    request('open', {
      install: 'C:/sdk',
      database: 'C:/base/s/data/session.db',
      configDirectory: 'C:/base/s/opencode-config',
      config: '{"shell":"/bin/sh"}',
    });
  return { input, lines, created, done, request, answerTo, open, exited: () => exited };
}

test("the open loads the operator's SDK and creates the server with this host's database, configuration and switches", async () => {
  const server = fakeServer();
  const run = served(server);
  const answer = await run.answerTo(run.open());
  assert.deepEqual(answer['result'], { version: '2.3.0' });
  assert.deepEqual(run.created, [
    {
      database: { path: 'C:/base/s/data/session.db' },
      config: {
        directory: 'C:/base/s/opencode-config',
        project: false,
        claude: false,
        content: '{"shell":"/bin/sh"}',
      },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
    },
  ]);
  await waitFor(() => server.calls.some((call) => call.member === 'event.subscribe'), 'the subscription');
  assert.deepEqual(
    server.calls.find((call) => call.member === 'event.subscribe')?.input,
    'a signal',
    'the subscription is handed the signal that ends it',
  );
  run.input.end();
  await run.done;
});

test('each call of the fixed list reaches the server by name; any other name is refused, and nothing is called before the open', async () => {
  const server = fakeServer();
  const run = served(server);
  const early = await run.answerTo(run.request('call', { method: 'session.get', input: { sessionID: 's' } }));
  assert.match(
    String((early['error'] as { message?: string } | undefined)?.message),
    /the server is not open/,
  );
  await run.answerTo(run.open());
  for (const method of Object.keys(OPENCODE_HOST_CALLS)) {
    const answer = await run.answerTo(run.request('call', { method, input: { sessionID: 'ses_1' } }));
    assert.equal(answer['error'], undefined, method);
  }
  assert.deepEqual(
    server.calls.filter((call) => call.member !== 'event.subscribe').map((call) => call.member),
    Object.keys(OPENCODE_HOST_CALLS),
  );
  for (const method of [
    'session.shell',
    'provider.list',
    'permission.saved.update',
    'constructor',
    'toString',
  ]) {
    const refused = await run.answerTo(run.request('call', { method, input: {} }));
    assert.match(
      String((refused['error'] as { message?: string } | undefined)?.message),
      /is not a call this host answers/,
      method,
    );
  }
  const other = await run.answerTo(run.request('shutdown', {}));
  assert.match(String((other['error'] as { message?: string } | undefined)?.message), /is not handled here/);
  run.input.end();
  await run.done;
});

test("the server's error reaches this host in words, with its tag", async () => {
  const server = fakeServer({ failing: 'session.get' });
  const run = served(server);
  await run.answerTo(run.open());
  const answer = await run.answerTo(
    run.request('call', { method: 'session.get', input: { sessionID: 'x' } }),
  );
  assert.match(
    String((answer['error'] as { message?: string } | undefined)?.message),
    /^session\.get: it failed/,
  );
  run.input.end();
  await run.done;
});

test('a second open, an open missing a member, and an SDK that does not load are refused', async () => {
  const run = served(fakeServer());
  await run.answerTo(run.open());
  const again = await run.answerTo(run.open());
  assert.match(String((again['error'] as { message?: string } | undefined)?.message), /open already/);
  const missing = await run.answerTo(run.request('open', { install: 'C:/sdk' }));
  assert.match(
    String((missing['error'] as { message?: string } | undefined)?.message),
    /open already|needs install/,
  );
  run.input.end();
  await run.done;
  const unloaded = served(fakeServer(), { loadFails: 'no OpenCode.create' });
  const answer = await unloaded.answerTo(unloaded.open());
  assert.match(
    String((answer['error'] as { message?: string } | undefined)?.message),
    /^runtime-unavailable: no OpenCode\.create/,
  );
  unloaded.input.end();
  await unloaded.done;
});

test("every event of the server's stream is sent as it came; a stream that fails says why", async () => {
  const server = fakeServer();
  const run = served(server);
  await run.answerTo(run.open());
  server.push({ id: 'evt_1', type: 'session.created', data: { sessionID: 'ses_1' } });
  await waitFor(() => run.lines.some((line) => line['method'] === 'event'), 'the event');
  assert.deepEqual(run.lines.find((line) => line['method'] === 'event')?.['params'], {
    event: { id: 'evt_1', type: 'session.created', data: { sessionID: 'ses_1' } },
  });
  run.input.end();
  await run.done;
  const broken = served(fakeServer({ streamError: 'the stream broke' }));
  await broken.answerTo(broken.open());
  await waitFor(() => broken.lines.some((line) => line['method'] === 'stream-ended'), 'the stream end');
  assert.deepEqual(broken.lines.find((line) => line['method'] === 'stream-ended')?.['params'], {
    detail: 'the stream broke',
  });
  broken.input.end();
  await broken.done;
});

test('when stdin ends the server is closed, then the process exits', async () => {
  const server = fakeServer();
  const run = served(server);
  await run.answerTo(run.open());
  run.input.end();
  await run.done;
  assert.ok(server.calls.some((call) => call.member === 'close'));
  assert.equal(run.exited(), true);
});
