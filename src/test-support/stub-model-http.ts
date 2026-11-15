/**
 * A stub model: an OpenAI-compatible chat completions endpoint on a loopback port that answers each request
 * from a script, never from a model. It stands in for a session's model endpoint where a test needs the
 * runtime to make a call a model would make (a sub-agent's spawn, a tool call inside a sub-agent), and
 * records every request as it arrived, so a test reads back what the runtime sent.
 *
 * Each request is answered by `script`: plain text, or one or more tool calls. Answers are whole JSON, or a
 * stream of chunks when the request asks to stream, with the usage the script states (or none). Nothing
 * here reaches the network beyond the loopback address it listens on, and it is never shipped.
 */
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One chat completions request, as the stub read it. */
export interface StubModelRequest {
  readonly url: string;
  readonly model: string | null;
  readonly stream: boolean;
  readonly messages: readonly {
    readonly role: string;
    readonly content: unknown;
    readonly tool_call_id?: string;
  }[];
  readonly tools: readonly string[];
}

/** What one request is answered with. */
export type StubModelReply =
  | { readonly text: string }
  | {
      readonly toolCalls: readonly {
        readonly id: string;
        readonly name: string;
        readonly arguments: unknown;
      }[];
    };

export interface StubModelOptions {
  /** The model id the endpoint lists. */
  readonly model?: string;
  /** The usage every answer states. */
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly prompt_tokens_details?: { readonly cached_tokens: number };
  };
}

export interface StubModel {
  /** The endpoint's base URL, for a provider's `baseUrl`. */
  readonly url: string;
  /** Every completions request, in arrival order. */
  readonly requests: StubModelRequest[];
  close(): Promise<void>;
}

/** The text of every message of a request, joined: what a script matches its markers in. */
export function stubRequestText(request: StubModelRequest): string {
  return request.messages
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
    .join('\n');
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

/** Start the stub, answering each completions request with `script`. */
export async function stubModel(
  script: (request: StubModelRequest) => StubModelReply,
  options: StubModelOptions = {},
): Promise<StubModel> {
  const model = options.model ?? 'stub-model';
  const usage = options.usage ?? { prompt_tokens: 100, completion_tokens: 5 };
  const requests: StubModelRequest[] = [];
  let calls = 0;
  const server = createServer((incoming, response) => {
    void (async () => {
      const url = incoming.url ?? '';
      if (incoming.method === 'GET' && url.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
        return;
      }
      if (incoming.method !== 'POST' || !url.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(await body(incoming)) as Record<string, unknown>;
      const request: StubModelRequest = {
        url,
        model: typeof parsed['model'] === 'string' ? parsed['model'] : null,
        stream: parsed['stream'] === true,
        messages: Array.isArray(parsed['messages'])
          ? (parsed['messages'] as StubModelRequest['messages'])
          : [],
        tools: Array.isArray(parsed['tools'])
          ? (parsed['tools'] as { function?: { name?: string } }[]).map((tool) => tool.function?.name ?? '')
          : [],
      };
      requests.push(request);
      calls += 1;
      const reply = script(request);
      const message =
        'text' in reply
          ? { role: 'assistant', content: reply.text }
          : {
              role: 'assistant',
              content: null,
              tool_calls: reply.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            };
      const finish = 'text' in reply ? 'stop' : 'tool_calls';
      const id = `stub-${calls}`;
      if (!request.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 0,
            model,
            choices: [{ index: 0, message, finish_reason: finish }],
            usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (payload: Record<string, unknown>): void => {
        response.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model, ...payload })}\n\n`,
        );
      };
      const delta =
        'text' in reply
          ? { role: 'assistant', content: reply.text }
          : {
              role: 'assistant',
              tool_calls: message.tool_calls?.map((call, index) => ({ index, ...call })),
            };
      chunk({ choices: [{ index: 0, delta, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      chunk({
        choices: [],
        usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
      });
      response.end('data: [DONE]\n\n');
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
