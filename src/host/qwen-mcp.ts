/**
 * The MCP servers a session is asked to attach, as Qwen Code takes them: the `mcpServers` member of the
 * `initialize` request, sent over the CLI's stdin, never on its command line.
 *
 * - A streamable HTTP server (`{ type: 'http', url, headers }`) becomes `{ httpUrl, headers }`. Never a
 *   bare `url`: Qwen Code reads that as an SSE server. A server's credential (a ticket in a header) rides
 *   in the request, never in the process environment, where the agent's shell would read it, and never
 *   on the command line, which any process listing shows.
 * - A stdio server (`{ command, args, env }`) keeps its command, arguments and environment.
 * - No server is marked trusted, so every tool of every server takes the session's rules, and the
 *   session's settings name every attached server's tools as ones to ask about (`mcp__{server}`).
 *
 * What has no Qwen Code form is refused by name (`mcp-descriptor-invalid`), never dropped: an SSE server,
 * a server running inside this process, a key Qwen Code has no setting for, and a name the CLI would
 * rewrite before matching it.
 */
import type { JsonObject, JsonValue } from '../control/frames.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { McpServerConfig } from './agent-process.js';

/** The server names Qwen Code keeps as written in a tool's name and an ask rule. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** The keys each transport takes; any other is refused by name. */
const HTTP_KEYS: readonly string[] = ['type', 'url', 'headers', 'timeout'];
const STDIO_KEYS: readonly string[] = ['type', 'command', 'args', 'env', 'timeout'];

const invalid = (name: string, why: string): Result<JsonObject> =>
  refuse<JsonObject>('mcp-descriptor-invalid', `MCP server "${name}" ${why}`);

/** A map of strings, or null when `value` is not one. */
function stringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(([, one]) => typeof one === 'string')
    ? Object.fromEntries(entries as [string, string][])
    : null;
}

/** The `initialize` request's `mcpServers` for `servers`, or the first server with no Qwen form, by name. */
export function qwenMcpServers(
  servers: Readonly<Record<string, McpServerConfig>> | null,
): Result<JsonObject> {
  const config: JsonObject = {};
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!SERVER_NAME.test(name)) {
      return invalid(
        name,
        "has a name Qwen Code would rewrite in its tools' names: letters, digits, _ and - only",
      );
    }
    const declared = server as unknown as Record<string, unknown>;
    const type = declared['type'] ?? 'stdio';
    const allowed = type === 'http' ? HTTP_KEYS : type === 'stdio' ? STDIO_KEYS : null;
    if (allowed === null) {
      return invalid(
        name,
        type === 'sse'
          ? 'is an SSE server; this host attaches streamable HTTP and stdio servers to Qwen Code'
          : `is a ${typeof type === 'string' ? type : 'nameless'} server, which has no form Qwen Code can start`,
      );
    }
    const extra = Object.keys(declared).find((key) => !allowed.includes(key));
    if (extra !== undefined) return invalid(name, `sets ${extra}, which Qwen Code has no setting for`);

    const entry: Record<string, JsonValue> = {};
    const timeout = declared['timeout'];
    if (timeout !== undefined) {
      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
        return invalid(name, 'has a timeout that is not a positive number of milliseconds');
      }
      entry['timeout'] = timeout;
    }
    if (type === 'http') {
      const url = declared['url'];
      if (typeof url !== 'string' || url === '') return invalid(name, 'has no url');
      entry['httpUrl'] = url;
      if (declared['headers'] !== undefined) {
        const headers = stringMap(declared['headers']);
        if (headers === null) return invalid(name, 'has headers that are not a map of strings');
        entry['headers'] = headers;
      }
    } else {
      const command = declared['command'];
      if (typeof command !== 'string' || command === '') return invalid(name, 'has no command');
      entry['command'] = command;
      const args = declared['args'];
      if (args !== undefined) {
        if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
          return invalid(name, 'has args that are not a list of strings');
        }
        entry['args'] = args;
      }
      if (declared['env'] !== undefined) {
        const env = stringMap(declared['env']);
        if (env === null) return invalid(name, 'has an env that is not a map of strings');
        entry['env'] = env;
      }
    }
    config[name] = entry;
  }
  return ok(config);
}
