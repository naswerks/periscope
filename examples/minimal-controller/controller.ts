// The smallest controller that completes a link: the WebSocket the host dials, answering the hello,
// the heartbeat and every session frame's ack, and the HTTP endpoint that denies every tool call.
// Both transports are required; a host with nowhere to send a decision refuses to start.
import { createServer } from 'node:http';
import { WebSocketServer, type RawData } from 'ws';
import { PROTOCOL_VERSION, decode, encode, type ControlPayload } from '@naswerks/periscope/protocol';

const text = (data: RawData): string =>
  Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data as ArrayBuffer)]).toString('utf8');

new WebSocketServer({ port: 8790, path: '/link' }).on('connection', (socket) => {
  const control = (payload: ControlPayload): void => {
    const frame = encode({ frame: 'control', at: new Date().toISOString(), payload });
    if (frame.ok) socket.send(frame.value);
  };
  socket.on('message', (data) => {
    const frame = decode(text(data));
    if (!frame.ok) return;
    if (frame.value.frame === 'session') {
      control({ kind: 'link_ack', cursors: [{ sessionId: frame.value.sessionId, seq: frame.value.seq }] });
    } else if (frame.value.payload.kind === 'link_hello') {
      control({ kind: 'link_welcome', protocolVersion: PROTOCOL_VERSION, capabilities: [], cursors: [] });
    } else if (frame.value.payload.kind === 'link_ping') {
      control({ kind: 'link_pong', nonce: frame.value.payload.nonce });
    }
  });
});

createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({ behavior: 'deny', message: 'the minimal controller denies every tool call' }),
  );
}).listen(8791);

console.log(
  'PERISCOPE_CONTROLLER_URL=ws://127.0.0.1:8790/link PERISCOPE_DECISION_URL=http://127.0.0.1:8791/decisions',
);
