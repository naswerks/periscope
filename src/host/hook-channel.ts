/**
 * The hook channel: the host-local lane a runtime's own hook process asks this host for a gate decision
 * over, one channel per session.
 *
 * It is a named pipe on Windows and a Unix socket in a directory only this user can enter elsewhere, and
 * never a TCP port, so this host still opens no listening port on any interface. The hook process finds
 * it, and proves it belongs to the session, through two variables this host sets in the runtime's own
 * environment (`PERISCOPE_HOOK_CHANNEL`, `PERISCOPE_HOOK_TOKEN`), which the runtime's tools never see;
 * an extension this host loads into the runtime's own process reads the same two from a file in the
 * protected set instead, so the runtime's environment never holds them.
 *
 * The agent shares this host's OS user, so it can find the channel and could read the token out of the
 * runtime's memory. What the token buys is asking: the host decides the call with the same local gate,
 * decider, deadlines and outcome record as every other call, and a decision runs nothing and grants
 * nothing. The controller's credential never leaves this process. A process that takes over the
 * channel's name cannot answer for the host either: every answer carries an HMAC keyed by the token,
 * which the hook verifies before it believes the answer.
 *
 * One request per connection, bounded and timed: a connection that sends nothing, sends too much or
 * sends something else is closed, and a request with the wrong token is answered no without anything
 * being asked of anyone.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RefusalReason } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { HookDecision, HookRequest } from '../gate/hook-exchange.js';
import {
  HOOK_EXCHANGE_VERSION,
  MAX_HOOK_INPUT_BYTES,
  hookAnswerLine,
  sameToken,
} from '../gate/hook-exchange.js';

/** How long a connection may take to send its request. The hook sends it as soon as it connects. */
export const HOOK_READ_DEADLINE_MS = 10_000;

export interface HookChannelOptions {
  /**
   * Decides one call from the event the runtime handed its hook. It never rejects: an outage, an expiry
   * and an unreadable event are each a refusal the answer carries. Its signal aborts when the hook's
   * connection closes, so a hook that was killed does not leave a decision outstanding.
   */
  readonly decide: (event: unknown, signal: AbortSignal) => Promise<HookDecision>;
  /** The runtime whose hook asks over this channel; a request naming another is refused. */
  readonly runtime: string;
  /** This host's version, answered to `hello`. */
  readonly version: string;
  /** A request this channel refused before deciding anything: the wrong token, a malformed line. */
  readonly onRefused?: (detail: string) => void;
  /**
   * A `hello` that carried the session's token and named this channel's runtime, with what it carried
   * beside them. Told before the hello is answered. A plugin that must be proven loaded before the
   * session runs says so this way.
   */
  readonly onHello?: (event: unknown) => void;
  /** The reason `ready()` refuses with when the channel cannot listen. Defaults to `codex-hook-not-active`. */
  readonly unavailableReason?: RefusalReason;
  /** The platform the address is chosen for. Defaults to this process's. */
  readonly platform?: string;
  /** How long a connection may take to send its request. Milliseconds. */
  readonly readDeadlineMs?: number;
}

/** One session's channel. */
export interface HookChannel {
  /** Where the hook connects: a pipe name or a socket path, never a host and port. */
  readonly address: string;
  /** The session's token, for the runtime's environment only. */
  readonly token: string;
  /** Settles once the channel is listening, or refuses with why it could not. */
  ready(): Promise<Result<void>>;
  /** Stops listening, ends every open connection and aborts its decision. Idempotent. */
  close(): void;
}

/** Open one session's channel. It starts listening at once; `ready()` says whether it could. */
export function openHookChannel(options: HookChannelOptions): HookChannel {
  const platform = options.platform ?? process.platform;
  const token = randomBytes(32).toString('hex');
  const readDeadlineMs = options.readDeadlineMs ?? HOOK_READ_DEADLINE_MS;
  const sockets = new Set<Socket>();
  const pending = new Set<AbortController>();
  let directory: string | null = null;
  let closed = false;

  let address: string;
  if (platform === 'win32') {
    address = `\\\\.\\pipe\\periscope-hook-${randomBytes(16).toString('hex')}`;
  } else {
    directory = mkdtempSync(join(tmpdir(), 'periscope-hook-'));
    address = join(directory, 's');
  }

  const refused = (detail: string): void => {
    try {
      options.onRefused?.(detail);
    } catch {
      // A reporter that throws must not take the channel down with it.
    }
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const abort = new AbortController();
    pending.add(abort);
    let buffer = Buffer.alloc(0);
    let handled = false;

    const done = (): void => {
      clearTimeout(timer);
      pending.delete(abort);
      sockets.delete(socket);
    };
    const timer = setTimeout(() => {
      refused('a hook connection sent no request in time and was closed');
      socket.destroy();
    }, readDeadlineMs);
    timer.unref();

    socket.on('error', () => {
      // A hook killed mid-exchange is a broken pipe here; the close below cleans up.
    });
    socket.on('close', () => {
      abort.abort();
      done();
    });
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        if (buffer.length > MAX_HOOK_INPUT_BYTES) {
          handled = true;
          refused(`a hook request exceeded ${MAX_HOOK_INPUT_BYTES} bytes and was closed`);
          socket.destroy();
        }
        return;
      }
      handled = true;
      clearTimeout(timer);
      void answer(buffer.subarray(0, newline).toString('utf8'), socket, abort.signal);
    });
  });

  const answer = async (line: string, socket: Socket, signal: AbortSignal): Promise<void> => {
    const request = readRequest(line);
    if (request === null) {
      refused('a hook request could not be read and was closed');
      socket.destroy();
      return;
    }
    if (!sameToken(request.token, token)) {
      // Answered no, unauthenticated: the asker does not hold the token the answer would be keyed by.
      refused('a hook request carried the wrong token and was refused without a decision');
      socket.end(`${JSON.stringify({ v: HOOK_EXCHANGE_VERSION, refused: 'token' })}\n`);
      return;
    }
    if (request.runtime !== options.runtime) {
      refused(`a hook request named runtime ${request.runtime}, and this channel answers ${options.runtime}`);
      socket.end(
        hookAnswerLine(token, request.nonce, { allow: false, reason: 'the hook named another runtime' }),
      );
      return;
    }
    if (request.kind === 'hello') {
      try {
        options.onHello?.(request.event);
      } catch {
        // A listener that throws must not cost the plugin its answer.
      }
      socket.end(hookAnswerLine(token, request.nonce, { ok: true, version: options.version }));
      return;
    }
    let decision: HookDecision;
    try {
      decision = await options.decide(request.event, signal);
    } catch (error) {
      decision = { allow: false, reason: `the host could not decide this call: ${String(error)}` };
    }
    if (!socket.destroyed) socket.end(hookAnswerLine(token, request.nonce, decision));
  };

  // The channel never keeps this process alive by itself: the session it belongs to does, and a decision
  // it is waiting on holds its own deadline timer.
  server.unref();

  const listening = new Promise<Result<void>>((resolve) => {
    server.once('error', (error) => {
      resolve(
        refuse(
          options.unavailableReason ?? 'codex-hook-not-active',
          `the hook channel ${address} could not listen: ${String(error)}`,
        ),
      );
    });
    server.listen(address, () => resolve(ok(undefined)));
  });

  return {
    address,
    token,
    ready: () => listening,
    close: () => {
      if (closed) return;
      closed = true;
      for (const abort of pending) abort.abort();
      for (const socket of sockets) socket.destroy();
      server.close();
      if (directory !== null) {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {
          // A socket directory that cannot be removed is left behind; it holds nothing but the socket.
        }
      }
    },
  };
}

/** A request line, read; null for anything that is not one. */
function readRequest(line: string): HookRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const request = parsed as Partial<Record<keyof HookRequest, unknown>>;
  if (request.v !== HOOK_EXCHANGE_VERSION) return null;
  if (request.kind !== 'decide' && request.kind !== 'hello') return null;
  if (typeof request.token !== 'string' || typeof request.nonce !== 'string' || request.nonce === '')
    return null;
  if (typeof request.runtime !== 'string') return null;
  return {
    v: HOOK_EXCHANGE_VERSION,
    kind: request.kind,
    token: request.token,
    nonce: request.nonce,
    runtime: request.runtime,
    ...(request.event === undefined ? {} : { event: request.event }),
  };
}
