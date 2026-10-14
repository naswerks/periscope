/**
 * A streamable HTTP MCP server with one tool, on a loopback port, that answers `initialize` with the
 * protocol version it is given and records what the client sent: the version the client asked for, its
 * `clientInfo`, the `mcp-protocol-version` header on every later request, and every request's headers
 * as they arrived, so a ticket a session's server carries can be read back verbatim. It stands in for a
 * controller's MCP surface that answers an older version, to show what a client negotiates with it.
 */
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { JsonObject } from '../control/frames.js';

export interface FakeMcpHttp {
  /** The server's endpoint, for an `httpUrl`. */
  readonly url: string;
  /** Each `initialize`: the version the client asked for, and who it said it was. */
  readonly initialized: { readonly asked: string | null; readonly clientInfo: unknown }[];
  /** The `mcp-protocol-version` header of every request after an `initialize`, in order. */
  readonly versionHeaders: (string | null)[];
  /** Each tool call's arguments. */
  readonly calls: JsonObject[];
  /** Every request's JSON-RPC method and headers, in arrival order: a header's value exactly as it arrived. */
  readonly requests: { readonly method: string; readonly headers: IncomingHttpHeaders }[];
  close(): Promise<void>;
}

/** A member's text, or nothing when it is not text. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      text += chunk;
    });
    request.on('end', () => resolve(text));
  });
}

/** Start the server, answering `initialize` with `answerVersion`. */
export async function fakeMcpHttp(answerVersion = '2024-11-05'): Promise<FakeMcpHttp> {
  const initialized: FakeMcpHttp['initialized'][number][] = [];
  const versionHeaders: (string | null)[] = [];
  const calls: JsonObject[] = [];
  const requests: FakeMcpHttp['requests'][number][] = [];
  const answer = (response: ServerResponse, id: unknown, result: JsonObject): void => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const message = JSON.parse(await body(request)) as JsonObject;
      const method = message['method'];
      requests.push({ method: textOf(method), headers: { ...request.headers } });
      if (method !== 'initialize') {
        const header = request.headers['mcp-protocol-version'];
        versionHeaders.push(typeof header === 'string' ? header : null);
      }
      if (message['id'] === undefined) {
        response.writeHead(202).end();
        return;
      }
      const params = (message['params'] ?? {}) as JsonObject;
      switch (method) {
        case 'initialize':
          initialized.push({
            asked: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : null,
            clientInfo: params['clientInfo'] ?? null,
          });
          return answer(response, message['id'], {
            protocolVersion: answerVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1' },
          });
        case 'tools/list':
          return answer(response, message['id'], {
            tools: [
              {
                name: 'echo',
                description: 'Echoes text.',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
              },
            ],
          });
        case 'tools/call':
          calls.push((params['arguments'] ?? {}) as JsonObject);
          return answer(response, message['id'], {
            content: [
              { type: 'text', text: textOf((params['arguments'] as JsonObject | undefined)?.['text']) },
            ],
          });
        default:
          return answer(response, message['id'], {});
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    initialized,
    versionHeaders,
    calls,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
