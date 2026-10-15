/**
 * The fake MCP server reads back what a client sent: a live probe's proof that a session's ticket arrived
 * as written rests on these records being exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeMcpHttp } from './fake-mcp-http.js';

const post = async (url: string, headers: Record<string, string>, message: object): Promise<void> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(message),
  });
  await response.text();
};

test("regression: every request's headers are recorded as they arrived, so a ticket is read back verbatim", async () => {
  const mcp = await fakeMcpHttp();
  try {
    const ticket = '!echo $NOT_A_VARIABLE';
    await post(
      mcp.url,
      { 'X-Job-Ticket': ticket },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    );
    await post(mcp.url, { 'X-Job-Ticket': ticket }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(
      mcp.requests.map((request) => [request.method, request.headers['x-job-ticket']]),
      [
        ['initialize', ticket],
        ['tools/list', ticket],
      ],
    );
  } finally {
    await mcp.close();
  }
});

test('control: a request that carried no ticket records none, so the record is the request, not a default', async () => {
  const mcp = await fakeMcpHttp();
  try {
    await post(mcp.url, {}, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(mcp.requests.length, 1);
    assert.equal(mcp.requests[0]?.headers['x-job-ticket'], undefined);
  } finally {
    await mcp.close();
  }
});
