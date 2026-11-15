/**
 * The MCP servers a session is asked to attach, as opencode takes them: entries of the configuration this
 * host writes for the session (`mcp.servers`), handed to the session's host process with that configuration,
 * never on a command line and never in an environment (which the agent's shell inherits).
 *
 * - A streamable HTTP server (`{ type: 'http', url, headers }`) is a `remote` server with its URL and its
 *   headers. A server's credential (a ticket in a header) rides in the configuration. No OAuth flow is ever
 *   offered (`oauth: false`), so no callback listener opens.
 * - A stdio server (`{ command, args, env }`) is a `local` server with its command line and environment.
 * - Every server's tools are offered directly (`codemode: false`), so each call keeps its own name and id.
 *
 * opencode names a server's tool `{server}_{tool}` in its permission requests, so the names a session attaches
 * must be told apart in that form: a name that opencode would rewrite (anything outside letters, digits, `_`
 * and `-`), or one that with an `_` begins another's (`probe` beside `probe_srv`), is refused, and the gate
 * can then read the server out of any tool's name exactly (`opencodeMcpToolName`). What has no opencode form
 * is refused by name (`mcp-descriptor-invalid`), never dropped: an SSE server, a server running inside this
 * process, a key opencode has no setting for.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { McpServerConfig } from './agent-process.js';

/** One server, as the session's configuration takes it. */
export type OpencodeMcpServer =
  | {
      readonly type: 'remote';
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly oauth: false;
      readonly codemode: false;
    }
  | {
      readonly type: 'local';
      readonly command: string[];
      readonly environment?: Record<string, string>;
      readonly codemode: false;
    };

/** The server names opencode keeps as written in a tool's name: letters, digits, `_` and `-`. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** The keys each transport takes; any other is refused by name. */
const HTTP_KEYS: readonly string[] = ['type', 'url', 'headers'];
const STDIO_KEYS: readonly string[] = ['type', 'command', 'args', 'env'];

const invalid = (name: string, why: string): Result<Record<string, OpencodeMcpServer>> =>
  refuse('mcp-descriptor-invalid', `MCP server "${name}" ${why}`);

/** A map of strings, or null when `value` is not one. */
function stringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(([, one]) => typeof one === 'string')
    ? Object.fromEntries(entries as [string, string][])
    : null;
}

/** The session's `mcp.servers` for `servers`, or the first server with no opencode form, by name. */
export function opencodeMcpServers(
  servers: Readonly<Record<string, McpServerConfig>> | null,
): Result<Record<string, OpencodeMcpServer>> {
  const config: Record<string, OpencodeMcpServer> = {};
  const names = Object.keys(servers ?? {});
  for (const name of names) {
    if (!SERVER_NAME.test(name)) {
      return invalid(
        name,
        "has a name opencode would rewrite in its tools' names: letters, digits, _ and - only",
      );
    }
    const prefixed = names.find((other) => other !== name && other.startsWith(`${name}_`));
    if (prefixed !== undefined) {
      return invalid(
        name,
        `and "${prefixed}" could not be told apart in opencode's tool names ({server}_{tool}); rename one`,
      );
    }
  }
  for (const [name, server] of Object.entries(servers ?? {})) {
    const declared = server as unknown as Record<string, unknown>;
    const type = declared['type'] ?? 'stdio';
    const allowed = type === 'http' ? HTTP_KEYS : type === 'stdio' ? STDIO_KEYS : null;
    if (allowed === null) {
      return invalid(
        name,
        type === 'sse'
          ? 'is an SSE server; this host attaches streamable HTTP and stdio servers to opencode'
          : `is a ${typeof type === 'string' ? type : 'nameless'} server, which has no form opencode can start`,
      );
    }
    const extra = Object.keys(declared).find((key) => !allowed.includes(key));
    if (extra !== undefined) return invalid(name, `sets ${extra}, which opencode has no setting for`);
    if (type === 'http') {
      const url = declared['url'];
      if (typeof url !== 'string' || url === '') return invalid(name, 'has no url');
      const headers = declared['headers'] === undefined ? null : stringMap(declared['headers']);
      if (declared['headers'] !== undefined && headers === null) {
        return invalid(name, 'has headers that are not a map of strings');
      }
      config[name] = {
        type: 'remote',
        url,
        ...(headers === null ? {} : { headers }),
        oauth: false,
        codemode: false,
      };
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
      command: [command, ...(args ?? [])],
      ...(env === null ? {} : { environment: env }),
      codemode: false,
    };
  }
  return ok(config);
}
