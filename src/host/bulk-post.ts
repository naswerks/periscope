/**
 * The host half of the bulk lane: bytes leave over an outbound HTTP POST, never over the link.
 *
 * The link carries a locator and gets back a receipt; the content travels here. That inversion is
 * what keeps a megabyte transcript off a socket that also carries the transitions telling you what
 * a session is doing — a single large frame would otherwise stall every session sharing the link.
 *
 * The read is streamed. Buffering a whole transcript to send it would block the event loop for
 * every other session this host is serving, which is the same failure in a different costume.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { requireAbsolute } from '../core/paths.js';

export interface BulkPostRequest {
  readonly deliveryId: string;
  readonly postUrl: string;
  /**
   * The only origin this delivery may reach. Required, with no default, and that is the mechanism
   * rather than a style.
   *
   * `postUrl` is chosen by the peer and arrives verbatim on the wire; this is the value that says
   * which peer the host actually works for. An optional field defaulting to "no binding" would let
   * every present and future caller inherit a fail-open nobody picked. Required, the compiler
   * forces each caller to name the origin it trusts.
   *
   * Compute it with {@link bulkOriginFor}, which is the only thing that knows how to turn the
   * host's configured `ws(s)://` controller URL into the `http(s)://` origin a POST lands on.
   */
  readonly allowedOrigin: string;
  /** Absolute. A relative path means "relative to a cwd the controller cannot see". */
  readonly filePath: string;
  readonly fromOffset: number;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The host's ONE controller origin, derived from the link URL it already dials.
 *
 * Derived, never separately configured. The host dials `controllerUrl` and trusts whatever
 * answers it; the bulk POST goes to the same deployment over plain HTTP. Reading a second setting
 * would create a way for the two to disagree, and a host whose "trusted origin" is configured apart
 * from the one it actually talks to is a host that can be pointed at two peers at once.
 */
export function bulkOriginFor(controllerUrl: string): Result<string> {
  let parsed: URL;
  try {
    parsed = new URL(controllerUrl);
  } catch {
    return refuse('bulk-target-invalid', `the configured controller URL is not a URL: ${controllerUrl}`);
  }

  // The link speaks WebSocket and the bulk lane speaks HTTP against the SAME deployment, so the
  // scheme is mapped rather than compared: `wss://host:8443/periscope/link` and
  // `https://host:8443/periscope/bulk/<id>` are one controller, and `URL.origin` alone would call
  // them different peers.
  const scheme =
    parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol;
  if (scheme !== 'http:' && scheme !== 'https:') {
    return refuse('bulk-target-invalid', `a controller URL cannot carry scheme ${parsed.protocol}`);
  }

  return ok(`${scheme}//${parsed.host}`);
}

export interface BulkPostReceipt {
  readonly deliveryId: string;
  readonly byteCount: number;
  /**
   * The file's stat at the moment the delivery was read (size total, mtime as floored epoch ms).
   * Carried so a transcript puller can detect the CLI rewriting the file under it — a byte-offset
   * resume across a rewrite is invalid, and only the deliverer's own stat can say.
   */
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export async function postBulk(request: BulkPostRequest): Promise<Result<BulkPostReceipt>> {
  const absolute = requireAbsolute(request.filePath);
  if (!absolute.ok) return { ok: false, refusal: absolute.refusal };

  let target: URL;
  try {
    target = new URL(request.postUrl);
  } catch {
    return refuse('bulk-target-invalid', `not a URL: ${request.postUrl}`);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return refuse('bulk-target-invalid', `unsupported scheme: ${target.protocol}`);
  }

  // The destination is the peer's choice; whether it is reached is not.
  //
  // The caller attaches this host's durable, non-expiring paired credential to the request (see
  // `host.ts`'s `#deliver`). With a credential riding along, a peer-named `postUrl` is an
  // exfiltration surface: any code path that can compose a `BulkRequest` could name
  // `http://attacker.example/x` and receive the operator's transcript and the device credential
  // that outlives the discovery of the theft.
  //
  // Checked after the scheme, on purpose. A garbled URL should still say it is garbled; this reason
  // is reserved for a target that is well-formed and simply is not this host's controller.
  if (target.origin !== request.allowedOrigin) {
    return refuse(
      'bulk-target-not-controller',
      `refusing to deliver to ${target.origin}: this host posts bulk content only to its own ` +
        `controller at ${request.allowedOrigin}. The destination rides the wire, so a peer that ` +
        `names another origin is asking for the transcript AND this host's durable credential`,
    );
  }

  try {
    const stats = await stat(absolute.value);
    const start = Math.min(Math.max(0, request.fromOffset), stats.size);
    const byteCount = stats.size - start;

    // Bounded to the bytes the header promised. `content-length` is declared from the stat above,
    // but the stream was opened after it: reading a live transcript (the headline use case) lets
    // the CLI append between the two, so an unbounded stream drains past the declared length and
    // the delivery dies as `bulk-delivery-failed`, a name that blames the delivery for a file that
    // simply moved. The end offset is inclusive, hence the -1.
    //
    // The zero-byte arm is not `end: start - 1`: `end` must be a non-negative integer, so an
    // empty delivery at offset 0 would throw rather than send nothing. An empty stream is the
    // honest encoding of "the header promised no bytes".
    const stream =
      byteCount > 0
        ? createReadStream(absolute.value, { start, end: start + byteCount - 1 })
        : Readable.from([]);
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(byteCount),
        'x-delivery-id': request.deliveryId,
        ...request.headers,
      },
      body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      // Required by undici whenever the body is a stream: the request body is still being sent
      // while the response is read. Without it the fetch rejects before a byte moves.
      duplex: 'half',
    });

    if (!response.ok) {
      return refuse(
        'bulk-delivery-failed',
        `controller answered ${response.status} ${response.statusText} for delivery ${request.deliveryId}`,
      );
    }

    return ok({
      deliveryId: request.deliveryId,
      byteCount,
      sizeBytes: stats.size,
      mtimeMs: Math.floor(stats.mtimeMs),
    });
  } catch (error) {
    return refuse(
      'bulk-delivery-failed',
      `delivery ${request.deliveryId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
