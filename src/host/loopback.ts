/**
 * The loopback redirect listener: a socket open for one callback, on one interface, for a bounded
 * time.
 *
 * Every constraint here is a consequence of one fact: the agent shares this host's OS user. That
 * is the premise the whole identity model rests on; it is why an 0600 token file is not a boundary
 * and why the gate carries a credential-path denial. It also means any local process can connect
 * to this listener, so the listener is a surface facing the exact actor the identity model
 * defends against:
 *
 *   - **`127.0.0.1` explicitly, never `0.0.0.0`.** The default binds every interface, which would
 *     put an authorization callback endpoint on the network. Nothing off this machine has any
 *     business reaching it, and the difference is one argument nobody notices missing.
 *   - **Exactly one callback, then closed.** A listener that stays open after answering is a
 *     listener something else can still reach, and there is no second callback to wait for.
 *   - **It times out.** An abandoned sign-in must not leave a port open indefinitely on a host that
 *     runs unattended for weeks.
 *   - **The `state` check is the caller's and it is not optional** — see `identity/authorize.ts`.
 *     This module returns the query string verbatim; it deliberately does not decide anything about
 *     whether the callback belongs to this sign-in.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { CALLBACK_PAGE } from '../identity/authorize.js';
import { redirectUriFor } from '../identity/authorize.js';

/** The one interface this listener will ever bind. */
export const LOOPBACK_HOST = '127.0.0.1';

/** Long enough for a real sign-in including a second factor; short enough to not be forever. */
export const DEFAULT_SIGN_IN_TIMEOUT_MS = 300_000;

export interface LoopbackListener {
  readonly port: number;
  readonly redirectUri: string;
  /** Resolves with the callback's raw query string, or a refusal. Settles exactly once. */
  readonly callback: Promise<Result<string>>;
  close(): void;
}

/**
 * Open the listener.
 *
 * `port` 0 asks the OS for a free one, which is the ordinary case — the redirect URI is then built
 * from what it gave back, which is why the provider registration must allow a loopback redirect with
 * any port. (Providers treat `http://127.0.0.1` loopback redirects specially for exactly this
 * reason; a fixed port would collide with whatever else is running.)
 */
export function openLoopbackListener(
  port = 0,
  timeoutMs = DEFAULT_SIGN_IN_TIMEOUT_MS,
): Promise<Result<LoopbackListener>> {
  return openLoopbackListenerWith(createServer, port, timeoutMs);
}

/**
 * The one server shape this module asks for — narrower than `createServer`'s overloads on purpose,
 * so an injected constructor is writable without reproducing them.
 */
export type LoopbackServerConstructor = (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) => Server;

/**
 * The listener over an injected server constructor.
 *
 * Injected for the same reason `jail.ts` takes its resolver injected: the server's failure paths
 * cannot be reached from outside this module — a post-listen `'error'` has no external trigger —
 * and the only way to exercise them at all is a caller that holds the server it built. This is
 * package-internal: it is exported from this file for the suite and deliberately NOT re-exported
 * from either barrel, and the package-shape suite asserts that stays true.
 */
export function openLoopbackListenerWith(
  createServerImpl: LoopbackServerConstructor,
  port: number,
  timeoutMs: number,
): Promise<Result<LoopbackListener>> {
  return new Promise((resolveListener) => {
    let settle: (result: Result<string>) => void = () => {};
    const callback = new Promise<Result<string>>((resolve) => {
      settle = resolve;
    });

    let settled = false;
    const finish = (result: Result<string>): void => {
      if (settled) return;
      settled = true;
      settle(result);
      close();
    };

    // Closing settles the wait. A caller that gives up (a shutdown signal, an outer timeout) must
    // not leave whoever is awaiting the callback pending forever. A promise nobody will ever
    // resolve is the shape that turns a cancelled sign-in into a hung host.
    const abandon = (): void =>
      finish(refuse('auth-callback-refused', 'the sign-in was closed before a callback arrived'));

    const server = createServerImpl((request, response) => {
      const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);

      // Anything that is not the redirect path gets a flat 404 and does NOT settle the wait. A
      // stray probe — a browser prefetch, another process scanning ports — must not be able to end
      // a sign-in that is still in progress.
      if (url.pathname !== '/callback') {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(CALLBACK_PAGE);
      finish(ok(url.search.startsWith('?') ? url.search.slice(1) : url.search));
    });

    const timer = setTimeout(() => {
      finish(
        refuse(
          'auth-callback-refused',
          `no callback arrived within ${timeoutMs}ms; the sign-in was not completed`,
        ),
      );
    }, timeoutMs);
    // The host must be able to exit while a sign-in is pending rather than being held open by it.
    timer.unref?.();

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      server.close();
      // Sockets kept alive by a browser would hold the server open past `close()`.
      server.closeAllConnections?.();
    };

    server.once('error', (error) => {
      // Before `listen` succeeds this settles the OPEN with a refusal. After it, the outer promise
      // is already resolved and that call is a no-op — the wait that must settle then is the
      // CALLBACK's, and `finish` is the one route that settles it, closes the server and clears
      // the deadline in one motion. Skipping `finish` here is what once left `signIn` hanging
      // forever on a callback that could no longer arrive, with the timeout already disarmed.
      resolveListener(
        refuse(
          'identity-config-invalid',
          `the loopback listener could not bind ${LOOPBACK_HOST}:${port}: ${String(error)}`,
        ),
      );
      finish(
        refuse(
          'auth-callback-refused',
          `the loopback listener failed (${String(error)}), so no callback can arrive; the sign-in was not completed`,
        ),
      );
    });

    server.listen(port, LOOPBACK_HOST, () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        close();
        resolveListener(refuse('identity-config-invalid', 'the loopback listener bound no address'));
        return;
      }
      resolveListener(
        ok({
          port: address.port,
          redirectUri: redirectUriFor(address.port),
          callback,
          close: abandon,
        }),
      );
    });
  });
}
