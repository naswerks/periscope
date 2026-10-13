/**
 * The MCP servers a session is asked to attach, as Codex takes them: one `mcp_servers.<name>` table
 * per server in the thread's own config, sent over the app-server's stdin with the thread request.
 *
 * - A streamable HTTP server (`{ type: 'http', url, headers }`) keeps its headers as static
 *   `http_headers`. That is where a server's credential (a ticket in a header) rides: in the config the
 *   app-server reads, never in its process environment (`env_http_headers` would read it from there,
 *   where the agent's shell could too) and never on its command line (`-c`), which any process listing
 *   shows. An inline bearer token is refused by Codex for HTTP, so none is ever sent.
 * - A stdio server (`{ command, args, env }`) keeps its command, arguments and environment.
 * - Every server's tools are asked about before each call (`default_tools_approval_mode = "prompt"`),
 *   so a call reaches this host's answers rather than running on Codex's own say.
 * - A server gets a bounded start (`startup_timeout_sec`), and its own per-call timeout when it has one.
 *
 * What has no Codex form is refused by name (`mcp-descriptor-invalid`), never dropped: an SSE server, a
 * server running inside this process, a key Codex has no setting for, and a name Codex would read as
 * more than one key (its config keys are dotted, so a `.` in a name splits it).
 */
import type { JsonObject, JsonValue } from '../control/frames.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { McpServerConfig } from './agent-process.js';

/** How long Codex waits for an MCP server this host attaches to start, in seconds. */
export const CODEX_MCP_STARTUP_TIMEOUT_SEC = 20;

/** The answer mode every attached server's tools take: each call is asked about first. */
export const CODEX_MCP_APPROVAL_MODE = 'prompt';

/** The server names Codex reads as one config key. */
const SERVER_NAME = /^[A-Za-z0-9_:@/-]+$/;

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

/**
 * The thread config keys that attach `servers` to a Codex session, each `mcp_servers.<name>` with its
 * table, or the first server that has no Codex form, refused by name.
 */
export function codexMcpConfig(
  servers: Readonly<Record<string, McpServerConfig>> | null,
): Result<JsonObject> {
  const config: JsonObject = {};
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!SERVER_NAME.test(name)) {
      return invalid(
        name,
        'has a name Codex would not read as one config key: letters, digits and _ : @ / - only',
      );
    }
    const declared = server as unknown as Record<string, unknown>;
    const type = declared['type'] ?? 'stdio';
    const allowed = type === 'http' ? HTTP_KEYS : type === 'stdio' ? STDIO_KEYS : null;
    if (allowed === null) {
      return invalid(
        name,
        type === 'sse'
          ? 'is an SSE server; Codex takes streamable HTTP and stdio servers'
          : `is a ${typeof type === 'string' ? type : 'nameless'} server, which has no form Codex can start`,
      );
    }
    const extra = Object.keys(declared).find((key) => !allowed.includes(key));
    if (extra !== undefined) return invalid(name, `sets ${extra}, which Codex has no setting for`);

    const table: Record<string, JsonValue> = {
      default_tools_approval_mode: CODEX_MCP_APPROVAL_MODE,
      startup_timeout_sec: CODEX_MCP_STARTUP_TIMEOUT_SEC,
    };
    const timeout = declared['timeout'];
    if (timeout !== undefined) {
      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
        return invalid(name, 'has a timeout that is not a positive number of milliseconds');
      }
      table['tool_timeout_sec'] = timeout / 1000;
    }

    if (type === 'http') {
      const url = declared['url'];
      if (typeof url !== 'string' || url === '') return invalid(name, 'has no url');
      table['url'] = url;
      if (declared['headers'] !== undefined) {
        const headers = stringMap(declared['headers']);
        if (headers === null) return invalid(name, 'has headers that are not a map of strings');
        table['http_headers'] = headers;
      }
    } else {
      const command = declared['command'];
      if (typeof command !== 'string' || command === '') return invalid(name, 'has no command');
      table['command'] = command;
      const args = declared['args'];
      if (args !== undefined) {
        if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
          return invalid(name, 'has args that are not a list of strings');
        }
        table['args'] = args;
      }
      if (declared['env'] !== undefined) {
        const env = stringMap(declared['env']);
        if (env === null) return invalid(name, 'has an env that is not a map of strings');
        table['env'] = env;
      }
    }
    config[`mcp_servers.${name}`] = table;
  }
  return ok(config);
}
