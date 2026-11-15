/**
 * The relay to an opencode session's host process (`opencode-host.ts`), from this host's side: the process
 * started with this host's own Node, no shell and no window, its environment written whole, and spoken to
 * over its stdio with the transport every runtime's process shares (`stdio-rpc.ts`).
 *
 * The process is opened with the session's configuration in the `open` request itself, so what that
 * configuration holds (an endpoint's key among it) crosses the process's stdin into its memory and is never
 * written into an environment or a file. Every event of the server's stream arrives as an `event`
 * notification; each call this host makes is one of the process's fixed list, by name. A call of a tool this
 * host names (`gatedTools`) is held by the server before it runs and arrives as a `gate` request, which this
 * host answers: the call runs, or it fails with this host's words.
 */
import { fileURLToPath } from 'node:url';

import type { JsonObject, JsonValue } from '../control/frames.js';
import type { Refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { ChildExit, SpawnChild } from './stdio-rpc.js';
import { RPC_METHOD_NOT_FOUND, describeExit, startStdioRpc } from './stdio-rpc.js';

/** The program a session's host process runs: this package's own, beside this file. */
export function opencodeHostScript(): string {
  return fileURLToPath(new URL('./opencode-host.js', import.meta.url));
}

/** One live host process, as a session drives it. */
export interface OpencodeConnection {
  /** One of the server's calls, by name; an error answer or no answer by `deadlineMs` is a refusal. */
  call(method: string, input: JsonObject, deadlineMs: number): Promise<Result<JsonValue>>;
  /** The host process's id, or null when it never started. */
  readonly pid: number | null;
  /** Settles once the host process has exited. */
  readonly exited: Promise<ChildExit>;
  /** Ends the process: its stdin ends, so it closes its server and exits; then its tree is killed. */
  close(): Promise<void>;
}

/** One call the server holds at its pre-call hook until this host answers. */
export interface OpencodeHeldCall {
  /** The tool's name, as the server registered it. */
  readonly tool: string;
  readonly sessionID: string;
  readonly callId: string;
  /** The call's input, as the model sent it. */
  readonly input: JsonValue;
}

/** This host's answer to a held call: it runs, or it fails with the words and its tool never runs. */
export interface OpencodeHeldAnswer {
  readonly allow: boolean;
  readonly message?: string;
}

/** What one host process is opened with. */
export interface OpencodeConnectOptions {
  /** The session's directory, where the process runs. */
  readonly cwd: string;
  /** The process's whole environment: nothing is inherited beside it. */
  readonly env: Readonly<Record<string, string>>;
  /** `PERISCOPE_OPENCODE_SDK`: the operator's install, which the process loads the SDK from. */
  readonly install: string;
  readonly database: string;
  readonly configDirectory: string;
  /** The configuration the server loads, as JSON text. */
  readonly config: string;
  readonly openDeadlineMs: number;
  readonly onEvent: (event: JsonObject) => void;
  /** The tools whose every call the server holds at its pre-call hook for `onHeldCall`'s answer. */
  readonly gatedTools?: readonly string[];
  /** Decides one held call before it runs. Absent, every held call is refused. */
  readonly onHeldCall?: (call: OpencodeHeldCall) => Promise<OpencodeHeldAnswer>;
  /** Told each call the server begins to run without holding it: the tool, the session and the call's id. */
  readonly onBegan?: (call: {
    readonly tool: string;
    readonly sessionID: string;
    readonly callId: string;
  }) => void;
  /** The server's stream ended while the process lives, with why. */
  readonly onStreamEnd: (detail: string) => void;
  readonly onExit: (exit: ChildExit) => void;
  readonly onStderr?: (line: string) => void;
  readonly onRefusal?: (refusal: Refusal) => void;
  /** How the program is started; the default spawns it with no shell and no window. */
  readonly spawn?: SpawnChild;
  readonly killTree?: (pid: number) => Promise<void>;
  readonly closeGraceMs?: number;
}

/**
 * A refused call, named by the server's call rather than the transport's `call` it rode: an answer's error,
 * a deadline met with no answer and a process that ended each say which of the server's calls it was.
 */
export function namedRefusal(method: string, refusal: Refusal): Result<never> {
  const detail = refusal.detail.startsWith('call: ')
    ? refusal.detail.slice('call: '.length)
    : refusal.detail.replace(/^call /, `${method} `);
  return refuse(refusal.reason, detail.startsWith(method) ? detail : `${method}: ${detail}`);
}

/** How a host process is opened; the default starts this package's own program. */
export type ConnectOpencode = (options: OpencodeConnectOptions) => Promise<Result<OpencodeConnection>>;

/** Start a session's host process and open its server. Refuses `runtime-unavailable` with why it could not. */
export const connectOpencodeHost: ConnectOpencode = async (options) => {
  const started = startStdioRpc({
    command: process.execPath,
    args: [opencodeHostScript()],
    cwd: options.cwd,
    env: options.env,
    onNotification: (method, params) => {
      if (method === 'event') {
        const event = params['event'];
        if (typeof event === 'object' && event !== null && !Array.isArray(event)) options.onEvent(event);
      } else if (method === 'began') {
        const tool = params['tool'];
        const sessionID = params['sessionID'];
        const callId = params['callID'];
        if (typeof tool === 'string' && typeof sessionID === 'string' && typeof callId === 'string') {
          options.onBegan?.({ tool, sessionID, callId });
        }
      } else if (method === 'stream-ended') {
        options.onStreamEnd(typeof params['detail'] === 'string' ? params['detail'] : 'with no reason given');
      }
    },
    onRequest: async (method, params) => {
      if (method !== 'gate') {
        return { error: { code: RPC_METHOD_NOT_FOUND, message: `${method} is not handled here` } };
      }
      const tool = params['tool'];
      const sessionID = params['sessionID'];
      const callId = params['callID'];
      const decide = options.onHeldCall;
      if (
        decide === undefined ||
        typeof tool !== 'string' ||
        typeof sessionID !== 'string' ||
        typeof callId !== 'string'
      ) {
        return {
          result: {
            allow: false,
            message: 'this host could not read the call the runtime held, so the call did not run',
          },
        };
      }
      const answer = await decide({ tool, sessionID, callId, input: params['input'] ?? null });
      return {
        result: { allow: answer.allow, ...(answer.message === undefined ? {} : { message: answer.message }) },
      };
    },
    onExit: options.onExit,
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    ...(options.onRefusal === undefined ? {} : { onRefusal: options.onRefusal }),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.killTree === undefined ? {} : { killTree: options.killTree }),
    ...(options.closeGraceMs === undefined ? {} : { closeGraceMs: options.closeGraceMs }),
  });
  if (!started.ok) return refuse('runtime-unavailable', started.refusal.detail);
  const peer = started.value;
  const opened = await peer.request(
    'open',
    {
      install: options.install,
      database: options.database,
      configDirectory: options.configDirectory,
      config: options.config,
      gatedTools: [...(options.gatedTools ?? [])],
    },
    options.openDeadlineMs,
  );
  if (!opened.ok) {
    await peer.close();
    const exit = peer.ended ? await Promise.race([peer.exited, Promise.resolve(null)]) : null;
    return refuse(
      'runtime-unavailable',
      `the opencode host process did not open: ${opened.refusal.detail}${exit === null ? '' : ` (${describeExit(exit)})`}`,
    );
  }
  return ok({
    call: async (method, input, deadlineMs) => {
      const answered = await peer.request('call', { method, input }, deadlineMs);
      return answered.ok ? answered : namedRefusal(method, answered.refusal);
    },
    get pid() {
      return peer.pid;
    },
    exited: peer.exited,
    close: () => peer.close(),
  });
};
