/**
 * An opencode session's host process: the program this host starts, one per session, that loads the
 * operator's `@opencode/sdk` and hosts opencode's server in its own memory. It opens no listener. It speaks
 * line-delimited JSON-RPC with this host on its stdin and stdout, the transport every runtime's process here
 * shares (`stdio-rpc.ts`), and nothing else ever reaches it.
 *
 * What it answers:
 * - `open`: load the SDK from the operator's install and create the server, with the database, the
 *   configuration directory and the configuration this host wrote for the session. The configuration
 *   arrives in the request, not in the environment or a file, so an endpoint's key in it stays in this
 *   process's memory: the agent's shell inherits this process's environment, which holds no key.
 * - `call`: one of the server's own calls, by name, from a fixed list (`OPENCODE_HOST_CALLS`). Any other name
 *   is refused, so this process never offers more of the server than this host reads or drives.
 * And it sends every event of the server's stream as an `event` notification, from the moment the server is
 * created. When its stdin ends it closes the server, which ends what the server still runs, and exits.
 *
 * What it asks: the server is created with one plugin of this package's (`OPENCODE_GATE_PLUGIN`), whose
 * pre-call hook the server runs before every tool call it runs, a subagent's included. For a call of a tool
 * the `open` request named (`gatedTools`), the hook sends this host a `gate` request (the tool, the session,
 * the call's id, its input) and waits for the answer: allowed, the call runs; refused, the hook rejects with
 * the answer's words and the call fails with them, its tool never run. The hook has no deadline of its own:
 * it waits as long as this host takes to decide, and ends refused when this process's stdin ends.
 *
 * It writes nothing to its stdout but the protocol: whatever the SDK would log goes to stderr.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { JsonObject, JsonValue } from '../control/frames.js';
import type { Result } from '../core/result.js';
import type {
  OpencodeExecuteBefore,
  OpencodeHost,
  OpencodeInstall,
  OpencodePlugin,
  OpencodeSdk,
} from './opencode-sdk.js';
import { OPENCODE_GATE_PLUGIN } from './opencode-home.js';
import { loadOpencodeSdk, readOpencodeInstall } from './opencode-sdk.js';
import { classifyRpc, JsonLineDecoder, RPC_INTERNAL_ERROR, RPC_METHOD_NOT_FOUND } from './stdio-rpc.js';

/** The server's calls this process answers, by name, and how each reaches the server. */
export const OPENCODE_HOST_CALLS: Readonly<
  Record<string, (host: OpencodeHost, input: JsonObject) => Promise<unknown>>
> = {
  'session.create': (host, input) => host.session.create(input as never),
  'session.get': (host, input) => host.session.get(input as never),
  'session.prompt': (host, input) => host.session.prompt(input as never),
  'session.interrupt': (host, input) => host.session.interrupt(input as never),
  'session.remove': (host, input) => host.session.remove(input as never),
  'session.fork': (host, input) => host.session.fork(input as never),
  'session.switchModel': (host, input) => host.session.switchModel(input as never),
  'session.switchAgent': (host, input) => host.session.switchAgent(input as never),
  'session.environment': (host, input) => host.session.environment(input as never),
  'session.form.cancel': (host, input) => host.session.form.cancel(input as never),
  'permission.reply': (host, input) => host.permission.reply(input as never),
  'permission.saved.list': (host, input) => host.permission.saved.list(input),
  'agent.list': (host, input) => host.agent.list(input),
  'plugin.list': (host, input) => host.plugin.list(input),
  'mcp.list': (host, input) => host.mcp.list(input),
  'config.get': (host, input) => host.config.get(input),
  'model.list': (host, input) => host.model.list(input),
};

/** What this host answers a call held at the pre-call hook. */
interface GateAnswer {
  readonly allow: boolean;
  readonly message: string;
}

/** What a held call is told when nothing can decide it any more. */
const GATE_GONE: GateAnswer = {
  allow: false,
  message: 'the host that decides this call is gone, so the call did not run',
};

/** What the process needs from its surroundings; each defaults to the real one. */
export interface OpencodeHostIo {
  readonly input: NodeJS.ReadableStream;
  readonly write: (line: string) => void;
  readonly readInstall?: (directory: string) => Result<OpencodeInstall>;
  readonly loadSdk?: (install: OpencodeInstall) => Promise<Result<OpencodeSdk>>;
  /** Called once the server is closed after stdin ended. */
  readonly exit?: () => void;
}

/** `error`'s words, with the runtime's own error tag where it names one. */
function wordsOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const tag = typeof record['_tag'] === 'string' ? record['_tag'] : null;
    const message = typeof record['message'] === 'string' ? record['message'] : JSON.stringify(record);
    return tag === null ? message : `${tag}: ${message}`;
  }
  return String(error);
}

/** A value as the wire carries it: JSON, `undefined` as null. */
function asJson(value: unknown): JsonValue {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
}

/** Serve one session's host on `io` until its input ends. */
export function serveOpencodeHost(io: OpencodeHostIo): Promise<void> {
  const decoder = new JsonLineDecoder();
  const events = new AbortController();
  let host: OpencodeHost | null = null;
  let opening: Promise<void> | null = null;
  let ended = false;
  // The tools whose every call waits at the pre-call hook, and each call waiting there, by its request's id.
  let gatedTools: ReadonlySet<string> = new Set();
  const held = new Map<string, (answer: GateAnswer) => void>();
  let gates = 0;

  const send = (message: JsonObject): void => io.write(`${JSON.stringify(message)}\n`);
  const answer = (id: string | number, result: JsonValue): void => send({ jsonrpc: '2.0', id, result });
  const fail = (id: string | number, code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } });

  const askGate = (event: OpencodeExecuteBefore): Promise<GateAnswer> =>
    new Promise((resolve) => {
      if (ended) return resolve(GATE_GONE);
      gates += 1;
      const id = `gate-${gates}`;
      held.set(id, resolve);
      send({
        jsonrpc: '2.0',
        id,
        method: 'gate',
        params: {
          tool: event.tool,
          sessionID: event.sessionID,
          callID: event.id,
          input: asJson(event.input),
        },
      });
    });

  /** This host's answer to a held call, read loosely: anything but a stated allow refuses. */
  const settleGate = (id: string, result: JsonValue | null, error: string | null): void => {
    const settle = held.get(id);
    if (settle === undefined) return;
    held.delete(id);
    const answered = typeof result === 'object' && result !== null && !Array.isArray(result) ? result : {};
    const words = answered['message'];
    settle(
      error === null && answered['allow'] === true
        ? { allow: true, message: '' }
        : {
            allow: false,
            message:
              typeof words === 'string' && words !== ''
                ? words
                : (error ?? 'this host refused the call and gave no reason'),
          },
    );
  };

  const gate: OpencodePlugin = {
    id: OPENCODE_GATE_PLUGIN,
    setup: async (context) => {
      await context.tool.hook('execute.before', async (event) => {
        if (!gatedTools.has(event.tool)) return;
        const answer = await askGate(event);
        if (!answer.allow) throw new Error(answer.message);
      });
    },
  };

  const forwardEvents = (server: OpencodeHost): void => {
    void (async () => {
      try {
        for await (const event of server.event.subscribe({ signal: events.signal })) {
          send({ jsonrpc: '2.0', method: 'event', params: { event: asJson(event) } });
        }
      } catch (error) {
        if (!events.signal.aborted) {
          send({ jsonrpc: '2.0', method: 'stream-ended', params: { detail: wordsOf(error) } });
        }
      }
    })();
  };

  const open = async (id: string | number, params: JsonObject): Promise<void> => {
    if (host !== null || opening !== null) return fail(id, RPC_INTERNAL_ERROR, 'the server is open already');
    const directory = params['install'];
    const database = params['database'];
    const configDirectory = params['configDirectory'];
    const content = params['config'];
    if (
      typeof directory !== 'string' ||
      typeof database !== 'string' ||
      typeof configDirectory !== 'string' ||
      typeof content !== 'string'
    ) {
      return fail(id, RPC_INTERNAL_ERROR, 'open needs install, database, configDirectory and config');
    }
    const named = params['gatedTools'];
    gatedTools = new Set(
      Array.isArray(named) ? named.filter((one): one is string => typeof one === 'string') : [],
    );
    const install = (io.readInstall ?? readOpencodeInstall)(directory);
    if (!install.ok)
      return fail(id, RPC_INTERNAL_ERROR, `${install.refusal.reason}: ${install.refusal.detail}`);
    const sdk = await (io.loadSdk ?? loadOpencodeSdk)(install.value);
    if (!sdk.ok) return fail(id, RPC_INTERNAL_ERROR, `${sdk.refusal.reason}: ${sdk.refusal.detail}`);
    try {
      const created = await sdk.value.create({
        database: { path: database },
        config: { directory: configDirectory, project: false, claude: false, content },
        models: { fetch: false },
        fs: { filewatcher: false, fff: false },
        plugins: [gate],
      });
      host = created;
      forwardEvents(created);
      answer(id, { version: install.value.sdkVersion });
    } catch (error) {
      fail(id, RPC_INTERNAL_ERROR, `the opencode server could not be created: ${wordsOf(error)}`);
    }
  };

  const call = async (id: string | number, params: JsonObject): Promise<void> => {
    const method = params['method'];
    const input = params['input'];
    if (typeof method !== 'string' || !Object.hasOwn(OPENCODE_HOST_CALLS, method)) {
      const named = typeof method === 'string' ? method : 'a call naming no method';
      return fail(id, RPC_METHOD_NOT_FOUND, `${named} is not a call this host answers`);
    }
    if (host === null) return fail(id, RPC_INTERNAL_ERROR, `${method}: the server is not open`);
    const run = OPENCODE_HOST_CALLS[method];
    if (run === undefined) return fail(id, RPC_METHOD_NOT_FOUND, `${method} is not a call this host answers`);
    try {
      const result = await run(
        host,
        typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {},
      );
      answer(id, asJson(result));
    } catch (error) {
      fail(id, RPC_INTERNAL_ERROR, `${method}: ${wordsOf(error)}`);
    }
  };

  return new Promise<void>((resolve) => {
    const end = (): void => {
      if (ended) return;
      ended = true;
      events.abort();
      // Nothing can decide a held call once this host is gone: each ends refused.
      for (const id of [...held.keys()]) settleGate(id, null, GATE_GONE.message);
      void (async () => {
        if (opening !== null) await opening.catch(() => undefined);
        const closing = host;
        host = null;
        if (closing !== null) await closing.close().catch(() => undefined);
        resolve();
        io.exit?.();
      })();
    };
    io.input.on('data', (chunk: Buffer) => {
      for (const decoded of decoder.push(chunk)) {
        if (!decoded.ok) continue;
        const message = classifyRpc(decoded.value);
        if (!message.ok) continue;
        if (message.value.kind === 'answer') {
          settleGate(String(message.value.id), message.value.result, null);
          continue;
        }
        if (message.value.kind === 'error') {
          if (message.value.id !== null) {
            settleGate(String(message.value.id), null, message.value.error.message);
          }
          continue;
        }
        if (message.value.kind !== 'request') continue;
        const { id, method, params } = message.value;
        if (method === 'open') {
          opening = open(id, params).finally(() => {
            opening = null;
          });
        } else if (method === 'call') {
          void call(id, params);
        } else {
          fail(id, RPC_METHOD_NOT_FOUND, `${method} is not handled here`);
        }
      }
    });
    io.input.on('end', end);
    io.input.on('close', end);
  });
}

/** Whether this module is the program the process was started with. */
function isEntry(): boolean {
  const started = process.argv[1];
  if (started === undefined) return false;
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    const there = realpathSync(started);
    return process.platform === 'win32' ? here.toLowerCase() === there.toLowerCase() : here === there;
  } catch {
    return false;
  }
}

if (isEntry()) {
  // The protocol owns stdout: whatever would be logged there goes to stderr instead.
  const toStderr = (...values: unknown[]): void => {
    process.stderr.write(`${values.map((value) => String(value)).join(' ')}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  void serveOpencodeHost({
    input: process.stdin,
    write: (line) => process.stdout.write(line),
    exit: () => process.exit(0),
  });
}
