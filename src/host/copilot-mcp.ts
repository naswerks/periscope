/**
 * The MCP servers a session is asked to attach, as Copilot takes them: the session's `mcpServers`, sent over
 * the SDK's pipe with `session.create`, never on a command line and never in the runtime's environment
 * (which the agent's shell inherits whole).
 *
 * - A streamable HTTP server (`{ type: 'http', url, headers }`) keeps its URL and its headers. A server's
 *   credential (a ticket in a header) rides in the request.
 * - A stdio server (`{ command, args, env }`) becomes a `local` server with its command, arguments and
 *   environment.
 * - Every tool of every server is offered (`tools: ['*']`), and every call to one asks this host, as every
 *   built-in's does: the pre-tool hook sees MCP calls.
 *
 * What has no Copilot form is refused by name (`mcp-descriptor-invalid`), never dropped: an SSE server, a
 * server running inside this process, a key Copilot has no setting for, and a name the runtime would not
 * keep as written in a tool's name (`{server}-{tool}`).
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { McpServerConfig } from './agent-process.js';
import type { CopilotMcpServer } from './copilot-sdk.js';

/** The server names Copilot keeps as written in a tool's name: letters, digits, `_` and `-`. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** The keys each transport takes; any other is refused by name. */
const HTTP_KEYS: readonly string[] = ['type', 'url', 'headers'];
const STDIO_KEYS: readonly string[] = ['type', 'command', 'args', 'env'];

const invalid = (name: string, why: string): Result<Record<string, CopilotMcpServer>> =>
  refuse('mcp-descriptor-invalid', `MCP server "${name}" ${why}`);

/** A map of strings, or null when `value` is not one. */
function stringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(([, one]) => typeof one === 'string')
    ? Object.fromEntries(entries as [string, string][])
    : null;
}

/** The session's `mcpServers` for `servers`, or the first server with no Copilot form, by name. */
export function copilotMcpServers(
  servers: Readonly<Record<string, McpServerConfig>> | null,
): Result<Record<string, CopilotMcpServer>> {
  const config: Record<string, CopilotMcpServer> = {};
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!SERVER_NAME.test(name)) {
      return invalid(
        name,
        "has a name Copilot would not keep in its tools' names: letters, digits, _ and - only",
      );
    }
    const declared = server as unknown as Record<string, unknown>;
    const type = declared['type'] ?? 'stdio';
    const allowed = type === 'http' ? HTTP_KEYS : type === 'stdio' ? STDIO_KEYS : null;
    if (allowed === null) {
      return invalid(
        name,
        type === 'sse'
          ? 'is an SSE server; this host attaches streamable HTTP and stdio servers to Copilot'
          : `is a ${typeof type === 'string' ? type : 'nameless'} server, which has no form Copilot can start`,
      );
    }
    const extra = Object.keys(declared).find((key) => !allowed.includes(key));
    if (extra !== undefined) return invalid(name, `sets ${extra}, which Copilot has no setting for`);
    if (type === 'http') {
      const url = declared['url'];
      if (typeof url !== 'string' || url === '') return invalid(name, 'has no url');
      const headers = declared['headers'] === undefined ? null : stringMap(declared['headers']);
      if (declared['headers'] !== undefined && headers === null) {
        return invalid(name, 'has headers that are not a map of strings');
      }
      config[name] = { type: 'http', url, ...(headers === null ? {} : { headers }), tools: ['*'] };
      continue;
    }
    const command = declared['command'];
    if (typeof command !== 'string' || command === '') return invalid(name, 'has no command');
    const args = declared['args'];
    if (args !== undefined && (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))) {
      return invalid(name, 'has args that are not a list of strings');
    }
    const env = declared['env'] === undefined ? null : stringMap(declared['env']);
    if (declared['env'] !== undefined && env === null) {
      return invalid(name, 'has an env that is not a map of strings');
    }
    config[name] = {
      type: 'local',
      command,
      ...(args === undefined ? {} : { args: [...args] }),
      ...(env === null ? {} : { env }),
      tools: ['*'],
    };
  }
  return ok(config);
}
