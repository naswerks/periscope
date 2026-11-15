import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { ok, refuse } from '../core/result.js';
import { waitFor } from '../test-support/ws-peer.js';
import { OPENCODE_HOST_CALLS, serveOpencodeHost } from './opencode-host.js';
import type {
  OpencodeCreateOptions,
  OpencodeEvent,
  OpencodeExecuteBefore,
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

/** The pre-call hook the process's plugin registers with a server, read out by setting the plugin up. */
async function preCallHookOf(
  options: OpencodeCreateOptions | undefined,
): Promise<(event: OpencodeExecuteBefore) => Promise<void> | void> {
  let registered: ((event: OpencodeExecuteBefore) => Promise<void> | void) | null = null;
  const plugin = options?.plugins?.[0];
  assert.ok(plugin !== undefined, 'the server was created with no plugin');
  await plugin.setup({
    tool: {
      hook: (name, callback) => {
        assert.equal(name, 'execute.before');
        registered = callback;
        return Promise.resolve({});
      },
    },
  });
  assert.ok(registered !== null, 'the plugin registered no pre-call hook');
  return registered;
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
  const open = (gatedTools?: readonly string[]): number =>
    request('open', {
      install: 'C:/sdk',
      database: 'C:/base/s/data/session.db',
      configDirectory: 'C:/base/s/opencode-config',
      config: '{"shell":"/bin/sh"}',
      ...(gatedTools === undefined ? {} : { gatedTools: [...gatedTools] }),
    });
  /** Write one answer of this host's to a request the process made. */
  const answer = (id: unknown, body: Record<string, unknown>): void => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
  };
  return { input, lines, created, done, request, answerTo, answer, open, exited: () => exited };
}

test("a call of a held tool waits at the pre-call hook for this host's answer: allowed it goes on, refused it fails with the answer's words", async () => {
  const server = fakeServer();
  const run = served(server);
  await run.answerTo(run.open(['shell']));
  const hook = await preCallHookOf(run.created[0]);
  const gateRequests = (): Record<string, unknown>[] => run.lines.filter((line) => line['method'] === 'gate');
  const call = (id: string, tool: string): OpencodeExecuteBefore => ({
    tool,
    sessionID: 'ses_1',
    id,
    input: { command: "${C:/work/f} = 'x'" },
  });

  // A tool this host did not ask to have held goes on at once, and nothing is asked.
  await hook(call('call_read', 'read'));
  assert.equal(gateRequests().length, 0);

  let settled = 'waiting';
  const allowed = Promise.resolve(hook(call('call_1', 'shell'))).then(
    () => (settled = 'ran'),
    (error: unknown) => (settled = String(error)),
  );
  await waitFor(() => gateRequests().length === 1, 'the held call');
  assert.deepEqual(gateRequests()[0]?.['params'], {
    tool: 'shell',
    sessionID: 'ses_1',
    callID: 'call_1',
    input: { command: "${C:/work/f} = 'x'" },
  });
  assert.equal(settled, 'waiting', 'the call went on before this host answered');
  run.answer(gateRequests()[0]?.['id'], { result: { allow: true } });
  await allowed;
  assert.equal(settled, 'ran');

  const refused = Promise.resolve(hook(call('call_2', 'shell'))).then(
    () => 'ran',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  await waitFor(() => gateRequests().length === 2, 'the second held call');
  run.answer(gateRequests()[1]?.['id'], { result: { allow: false, message: 'not that line' } });
  assert.equal(await refused, 'not that line');

  // An answer that is no stated allow refuses: an error answer, and one that says nothing.
  for (const [body, words] of [
    [{ error: { code: -32603, message: 'the gate itself failed' } }, 'the gate itself failed'],
    [{ result: {} }, 'this host refused the call and gave no reason'],
    [{ result: { allow: 'yes' } }, 'this host refused the call and gave no reason'],
  ] as const) {
    const before = gateRequests().length;
    const outcome = Promise.resolve(hook(call(`call_${before}`, 'shell'))).then(
      () => 'ran',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await waitFor(() => gateRequests().length === before + 1, 'a further held call');
    run.answer(gateRequests()[before]?.['id'], body);
    assert.equal(await outcome, words);
  }
  run.input.end();
  await run.done;
});

test('a call still held when this host goes away ends refused, and one held after that is refused at once', async () => {
  const server = fakeServer();
  const run = served(server);
  await run.answerTo(run.open(['shell']));
  const hook = await preCallHookOf(run.created[0]);
  const held = Promise.resolve(
    hook({ tool: 'shell', sessionID: 'ses_1', id: 'call_1', input: { command: 'ls' } }),
  ).then(
    () => 'ran',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  await waitFor(() => run.lines.some((line) => line['method'] === 'gate'), 'the held call');
  run.input.end();
  assert.match(await held, /the host that decides this call is gone/);
  await run.done;
  await assert.rejects(
    Promise.resolve(hook({ tool: 'shell', sessionID: 'ses_1', id: 'call_2', input: {} })),
    /the host that decides this call is gone/,
  );
});

test('control: with no tool named to be held, no call waits', async () => {
  const server = fakeServer();
  const run = served(server);
  await run.answerTo(run.open());
  const hook = await preCallHookOf(run.created[0]);
  await hook({ tool: 'shell', sessionID: 'ses_1', id: 'call_1', input: { command: 'ls' } });
  assert.equal(run.lines.filter((line) => line['method'] === 'gate').length, 0);
  run.input.end();
  await run.done;
});

test("the open loads the operator's SDK and creates the server with this host's database, configuration and switches", async () => {
  const server = fakeServer();
  const run = served(server);
  const answer = await run.answerTo(run.open());
  assert.deepEqual(answer['result'], { version: '2.3.0' });
  const { plugins, ...rest } = run.created[0] ?? ({} as OpencodeCreateOptions);
  assert.deepEqual(rest, {
    database: { path: 'C:/base/s/data/session.db' },
    config: {
      directory: 'C:/base/s/opencode-config',
      project: false,
      claude: false,
      content: '{"shell":"/bin/sh"}',
    },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
  });
  assert.deepEqual(
    (plugins ?? []).map((plugin) => plugin.id),
    ['periscope.gate'],
    "the server is created with this host's pre-call gate and no other plugin",
  );
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
