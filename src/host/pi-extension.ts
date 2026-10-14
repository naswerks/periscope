/**
 * The extension this host loads into every pi session it runs: the session's gate.
 *
 * pi has no permission system of its own. What it has is an extension's `tool_call` handler: every
 * handler is awaited before a tool runs, the first block wins, and a handler that throws blocks the
 * call. This host launches pi so that no extension loads but this one and pi's built-in MCP extension,
 * which pi loads first, so this handler is the last word on every call and the input it decides is the
 * input that runs. It asks this host for each decision over the session's hook channel, the same
 * per-call decision a Claude call gets.
 *
 * pi loads this file by its path (`-e`) and calls its default export with the extension API. It is not a
 * module of the package's API: no entry point exports it, and the host reads only its constants and its
 * configuration's shape. It imports nothing but Node, the channel's exchange and its own type
 * declarations, so loading it costs pi nothing else.
 *
 * What it does, all of it at load except the hello:
 * - reads its configuration from the file `PERISCOPE_PI_EXTENSION_CONFIG` names: the channel, its token,
 *   how long to wait for a decision, and the session's MCP servers. The file sits in the protected set,
 *   and the variable is taken out of the runtime's environment once read, so no command the agent runs
 *   is handed the path. A missing or unreadable file throws, and pi ends at load;
 * - registers each MCP server with its tools declared to the model by name (`mcp__<server>__<tool>`),
 *   every value pi would resolve escaped, so a ticket is sent as written;
 * - registers a command of its own, so pi's command list names this extension's file;
 * - blocks a shell command sent outside the agent's tool calls, which never reaches `tool_call`;
 * - on `session_start`, says hello over the channel with what it can see loaded: every tool's and
 *   command's source, and the servers registered. The host takes no prompt until it has.
 *
 * Every tool call is asked about. A deny blocks with the host's reason; an allow lets the call run,
 * with the host's rewritten input put in place of the old where it carries one; and every other way
 * the exchange can end blocks with a reason: no answer by the extension's own deadline, the turn's
 * abort, an answer that does not verify, a closed channel, or anything this file did not foresee.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as connectTo } from 'node:net';
import type { Socket } from 'node:net';

import {
  HOOK_EXCHANGE_VERSION,
  HOOK_EXPIRY_EVENT,
  MAX_HOOK_INPUT_BYTES,
  MAX_HOOK_REASON_LENGTH,
  readHookAnswer,
} from '../gate/hook-exchange.js';
import type {
  PiExtensionApi,
  PiMcpHttpServer,
  PiMcpStdioServer,
  PiToolCallResult,
} from './pi-extension-api.js';

/** The variable naming the file this extension reads its configuration from. */
export const PI_EXTENSION_CONFIG_VARIABLE = 'PERISCOPE_PI_EXTENSION_CONFIG';

/** The command this extension registers, so pi's command list names the extension's file. */
export const PI_EXTENSION_COMMAND = 'periscope';

/** The runtime every request this extension sends names. */
export const PI_EXTENSION_RUNTIME = 'pi';

/** How long the hello waits for the host's answer. */
export const PI_HELLO_ANSWER_MS = 10_000;

/** The most tools, commands or servers one hello names; past it the list is cut and says so. */
export const MAX_PI_HELLO_ENTRIES = 1024;

/** The longest name or path one hello entry carries. */
const MAX_PI_HELLO_TEXT = 1024;

/** One MCP server the session attaches, as the host hands it over. */
export type PiExtensionServer =
  | {
      readonly name: string;
      readonly type: 'http';
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly type: 'stdio';
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    };

/** This extension's configuration, as the host writes it for one session. */
export interface PiExtensionConfig {
  readonly v: 1;
  readonly runtime: typeof PI_EXTENSION_RUNTIME;
  /** The session's hook channel: a pipe name or a socket path. */
  readonly channel: string;
  /** The session's token for the channel. */
  readonly token: string;
  /** How long one call waits for the host's decision before it is blocked, in milliseconds. */
  readonly deadlineMs: number;
  readonly servers: readonly PiExtensionServer[];
}

/** One call, as this extension asks the host about it. */
export interface PiDecideEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly parentToolCallId?: string;
  readonly input: Record<string, unknown>;
  /** The session's working directory: where a relative path in the input resolves. */
  readonly cwd: string;
}

/** One tool or command in a hello, with where it came from. */
export interface PiHelloEntry {
  readonly name: string;
  /** The command's kind (`extension`, `prompt`, `skill`); absent on a tool. */
  readonly kind?: string;
  readonly source: string;
  readonly path: string;
  readonly baseDir?: string;
}

/** What the hello carries: what this extension can see loaded beside it. */
export interface PiHello {
  /** Why the session started (`startup`, `resume`, `fork`). */
  readonly reason: string;
  /** Every tool pi offers, or null when pi would not list them. */
  readonly tools: readonly PiHelloEntry[] | null;
  /** Every command pi offers, or null when pi would not list them. */
  readonly commands: readonly PiHelloEntry[] | null;
  /** The MCP servers registered, with the extension that registered each. */
  readonly servers: readonly { readonly name: string; readonly extensionPath: string }[] | null;
  /** True when a list was cut at `MAX_PI_HELLO_ENTRIES`. */
  readonly truncated: boolean;
}

/** The seams the tests replace. */
export interface PiExtensionIo {
  readonly connect?: (address: string) => Socket;
  readonly readFile?: (path: string) => string;
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((one) => typeof one === 'string');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why `value` is not a configuration this extension can run with, or null. */
export function piExtensionConfigProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'the configuration is not an object';
  if (value['v'] !== 1) return 'the configuration is not version 1';
  if (value['runtime'] !== PI_EXTENSION_RUNTIME) return 'the configuration names another runtime';
  if (typeof value['channel'] !== 'string' || value['channel'] === '')
    return 'the configuration names no channel';
  if (typeof value['token'] !== 'string' || value['token'] === '')
    return 'the configuration carries no token';
  const deadline = value['deadlineMs'];
  if (typeof deadline !== 'number' || !Number.isInteger(deadline) || deadline <= 0) {
    return 'the configuration states no deadline';
  }
  const servers = value['servers'];
  if (!Array.isArray(servers)) return 'the configuration lists no servers';
  for (const server of servers as unknown[]) {
    if (!isRecord(server)) return 'a server is not an object';
    const name = server['name'];
    if (typeof name !== 'string' || !SERVER_NAME.test(name)) return 'a server has no usable name';
    if (server['type'] === 'http') {
      if (typeof server['url'] !== 'string' || server['url'] === '') return `server ${name} has no url`;
      if (server['headers'] !== undefined && !isStringMap(server['headers'])) {
        return `server ${name} has headers that are not a map of strings`;
      }
    } else if (server['type'] === 'stdio') {
      if (typeof server['command'] !== 'string' || server['command'] === '')
        return `server ${name} has no command`;
      const args = server['args'];
      if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === 'string'))) {
        return `server ${name} has args that are not a list of strings`;
      }
      if (server['env'] !== undefined && !isStringMap(server['env'])) {
        return `server ${name} has an env that is not a map of strings`;
      }
    } else {
      return `server ${name} is neither an http nor a stdio server`;
    }
  }
  return null;
}

/**
 * `value` written so pi's config resolution gives it back as written. pi reads a value that starts with
 * `!` as a command to run and expands `$NAME`; `$$` is its literal `$`, and `$!` its literal `!`.
 */
export function escapePiConfigValue(value: string): string {
  const dollars = value.replace(/\$/g, () => '$$');
  return dollars.startsWith('!') ? `$${dollars}` : dollars;
}

function escapedMap(map: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  if (map === undefined) return undefined;
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, escapePiConfigValue(value)]));
}

/** The registration pi takes for `server`: its tools declared to the model by name, its values escaped. */
export function piServerRegistration(server: PiExtensionServer): PiMcpHttpServer | PiMcpStdioServer {
  if (server.type === 'http') {
    const headers = escapedMap(server.headers);
    return {
      type: 'http',
      url: server.url,
      ...(headers === undefined ? {} : { headers }),
      exposure: 'direct',
    };
  }
  const env = escapedMap(server.env);
  return {
    type: 'stdio',
    command: server.command,
    ...(server.args === undefined ? {} : { args: [...server.args] }),
    ...(env === undefined ? {} : { env }),
    exposure: 'direct',
  };
}

/** How one exchange with the host ended: the verified answer, or why there is none. */
type Asked = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly reason: string };

/** The reason a call the turn's abort ended is blocked with. */
export const PI_ABORTED_REASON = 'the turn was interrupted before this call was decided, so it does not run';

/**
 * One exchange over the channel: one request, one answer, verified by the session's token. Never
 * rejects. The deadline, the abort and every failure end it with a reason.
 */
function exchange(
  config: PiExtensionConfig,
  kind: 'decide' | 'hello',
  event: unknown,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  connect: (address: string) => Socket,
): Promise<Asked> {
  return new Promise<Asked>((resolve) => {
    if (signal?.aborted === true) {
      resolve({ ok: false, reason: PI_ABORTED_REASON });
      return;
    }
    const nonce = randomBytes(16).toString('hex');
    let settled = false;
    let buffer = Buffer.alloc(0);
    let socket: Socket | null = null;
    const finish = (asked: Asked): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket?.destroy();
      resolve(asked);
    };
    const onAbort = (): void => finish({ ok: false, reason: PI_ABORTED_REASON });
    const timer = setTimeout(() => {
      finish({ ok: false, reason: `${HOOK_EXPIRY_EVENT}: no decision from the host within ${deadlineMs}ms` });
    }, deadlineMs);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      socket = connect(config.channel);
    } catch (error) {
      finish({ ok: false, reason: `the host's channel could not be opened: ${describe(error)}` });
      return;
    }
    socket.on('error', (error: Error) => {
      finish({ ok: false, reason: `the host's channel failed: ${error.message}` });
    });
    socket.on('connect', () => {
      const line = JSON.stringify({
        v: HOOK_EXCHANGE_VERSION,
        kind,
        token: config.token,
        nonce,
        runtime: PI_EXTENSION_RUNTIME,
        ...(event === undefined ? {} : { event }),
      });
      socket?.write(`${line}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        if (buffer.length > MAX_HOOK_INPUT_BYTES)
          finish({ ok: false, reason: "the host's answer was too long" });
        return;
      }
      const body = readHookAnswer(buffer.subarray(0, newline).toString('utf8'), config.token, nonce);
      finish(
        body === null
          ? { ok: false, reason: "the host's answer did not verify, so it was not believed" }
          : { ok: true, body },
      );
    });
    socket.on('close', () => finish({ ok: false, reason: 'the host closed the channel without answering' }));
  });
}

/** A block pi shows the model, its reason never empty and never past the bound. */
function block(reason: string): PiToolCallResult {
  const stated = reason.trim() === '' ? 'the host refused this call and gave no reason' : reason;
  return {
    block: true,
    reason:
      stated.length > MAX_HOOK_REASON_LENGTH
        ? `${stated.slice(0, MAX_HOOK_REASON_LENGTH)}...[truncated]`
        : stated,
  };
}

/** What the host's answer lets happen: the call as asked, the call with new input, or a block. */
function decisionOf(
  body: unknown,
):
  | { readonly allow: true; readonly updatedInput?: Record<string, unknown> }
  | { readonly allow: false; readonly reason: string } {
  if (!isRecord(body)) return { allow: false, reason: 'the host answered with no decision' };
  if (body['allow'] === true) {
    const updated = body['updatedInput'];
    if (updated === undefined) return { allow: true };
    return isRecord(updated)
      ? { allow: true, updatedInput: updated }
      : { allow: false, reason: 'the host allowed this call with input that is not an object' };
  }
  if (body['allow'] === false && typeof body['reason'] === 'string')
    return { allow: false, reason: body['reason'] };
  return { allow: false, reason: 'the host answered with a decision this extension does not recognise' };
}

/** `input` made `updated`, in place: pi runs the object it handed the handler. */
function rewriteInPlace(input: Record<string, unknown>, updated: Record<string, unknown>): void {
  for (const key of Object.keys(input)) Reflect.deleteProperty(input, key);
  Object.assign(input, updated);
}

/** Each entry cut to the bound, and the list to its own. */
function boundedEntries<T>(
  list: readonly T[],
  entry: (one: T) => PiHelloEntry,
): {
  readonly entries: PiHelloEntry[];
  readonly cut: boolean;
} {
  const cut = (text: string): string =>
    text.length <= MAX_PI_HELLO_TEXT ? text : text.slice(0, MAX_PI_HELLO_TEXT);
  const entries = list.slice(0, MAX_PI_HELLO_ENTRIES).map((one) => {
    const read = entry(one);
    return {
      name: cut(read.name),
      ...(read.kind === undefined ? {} : { kind: cut(read.kind) }),
      source: cut(read.source),
      path: cut(read.path),
      ...(read.baseDir === undefined ? {} : { baseDir: cut(read.baseDir) }),
    };
  });
  return { entries, cut: list.length > MAX_PI_HELLO_ENTRIES };
}

/** What this extension can see loaded beside it. Each list pi will not give is null, never guessed. */
export function piHelloOf(pi: PiExtensionApi, reason: string): PiHello {
  let truncated = false;
  const listed = <T>(read: () => readonly T[], entry: (one: T) => PiHelloEntry): PiHelloEntry[] | null => {
    try {
      const bounded = boundedEntries(read(), entry);
      truncated ||= bounded.cut;
      return bounded.entries;
    } catch {
      return null;
    }
  };
  const tools = listed(
    () => pi.getAllTools(),
    (tool) => ({
      name: tool.name,
      source: tool.sourceInfo.source,
      path: tool.sourceInfo.path,
      ...(tool.sourceInfo.baseDir === undefined ? {} : { baseDir: tool.sourceInfo.baseDir }),
    }),
  );
  const commands = listed(
    () => pi.getCommands(),
    (command) => ({
      name: command.name,
      kind: command.source,
      source: command.sourceInfo.source,
      path: command.sourceInfo.path,
      ...(command.sourceInfo.baseDir === undefined ? {} : { baseDir: command.sourceInfo.baseDir }),
    }),
  );
  let servers: PiHello['servers'];
  try {
    const registered = pi.getMcpServers();
    truncated ||= registered.length > MAX_PI_HELLO_ENTRIES;
    servers = registered
      .slice(0, MAX_PI_HELLO_ENTRIES)
      .map((server) => ({ name: server.name, extensionPath: server.extensionPath }));
  } catch {
    servers = null;
  }
  return { reason, tools, commands, servers, truncated };
}

/** The reason a shell command sent outside the agent's tool calls is refused with. */
export const PI_USER_BASH_REFUSAL =
  "this host runs pi's shell only through the agent's tool calls, each decided by its gate; a command sent beside them does not run";

/**
 * Activate the extension on `pi`: read the configuration `env` names, register the servers, the command
 * and the three handlers. Throws when the configuration cannot be read, which ends pi at load.
 */
export function activatePiExtension(
  pi: PiExtensionApi,
  env: Record<string, string | undefined>,
  io: PiExtensionIo = {},
): void {
  const path = env[PI_EXTENSION_CONFIG_VARIABLE];
  if (path === undefined || path === '') {
    throw new Error(
      `${PI_EXTENSION_CONFIG_VARIABLE} is not set, so this extension has no channel to the host`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse((io.readFile ?? ((file) => readFileSync(file, 'utf8')))(path));
  } catch (error) {
    throw new Error(`this extension's configuration ${path} could not be read: ${describe(error)}`, {
      cause: error,
    });
  }
  const problem = piExtensionConfigProblem(parsed);
  if (problem !== null) throw new Error(`this extension's configuration ${path} is unusable: ${problem}`);
  const config = parsed as PiExtensionConfig;
  // No command the agent runs is handed the path: pi's shell inherits this process's environment.
  Reflect.deleteProperty(env, PI_EXTENSION_CONFIG_VARIABLE);
  const connect = io.connect ?? ((address: string): Socket => connectTo(address));

  for (const server of config.servers) pi.registerMcpServer(server.name, piServerRegistration(server));

  pi.registerCommand(PI_EXTENSION_COMMAND, {
    description: "periscope's gate: every tool call in this session is decided by the host that runs it",
    handler: () => Promise.resolve(),
  });

  pi.on('tool_call', async (event, ctx) => {
    try {
      const asked = await exchange(
        config,
        'decide',
        {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
          input: event.input,
          cwd: ctx.cwd,
        } satisfies PiDecideEvent,
        config.deadlineMs,
        ctx.signal,
        connect,
      );
      if (!asked.ok) return block(asked.reason);
      const decision = decisionOf(asked.body);
      if (!decision.allow) return block(decision.reason);
      if (decision.updatedInput !== undefined) rewriteInPlace(event.input, decision.updatedInput);
      return undefined;
    } catch (error) {
      return block(`the host could not decide this call: ${describe(error)}`);
    }
  });

  pi.on('user_bash', () => {
    throw new Error(PI_USER_BASH_REFUSAL);
  });

  pi.on('session_start', async (event) => {
    // A hello that is not answered is the host's to name: it takes no prompt until one arrives.
    await exchange(config, 'hello', piHelloOf(pi, event.reason), PI_HELLO_ANSWER_MS, undefined, connect);
  });
}

/** The extension, as pi loads it: the API is its one argument. */
export default function periscopePiExtension(pi: PiExtensionApi): void {
  activatePiExtension(pi, process.env);
}
