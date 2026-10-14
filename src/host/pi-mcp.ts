/**
 * The MCP servers a session is asked to attach, as a pi session takes them: handed to this host's
 * extension in its configuration file, which registers each with pi when it loads.
 *
 * - A streamable HTTP server (`{ type: 'http', url, headers }`) keeps its URL and headers. A server's
 *   credential (a ticket in a header) rides in a file in the protected set, never in pi's environment,
 *   where the agent's shell would read it, and never on its command line, which any process listing shows.
 *   The extension writes every header value so pi reads it as written.
 * - A stdio server (`{ command, args, env }`) keeps its command, arguments and environment.
 * - Every server's tools are declared to the model by name (`mcp__<server>__<tool>`), and every call to
 *   one is decided by the session's gate like any other.
 *
 * What has no pi form is refused by name (`mcp-descriptor-invalid`), never dropped: an SSE server, which
 * pi does not take, a server running inside this process, a key pi's extension API has no setting for,
 * and a name pi would not take.
 */
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { McpServerConfig } from './agent-process.js';
import type { PiExtensionServer } from './pi-extension.js';

/** The server names pi takes. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** The keys each transport takes; any other is refused by name. */
const HTTP_KEYS: readonly string[] = ['type', 'url', 'headers'];
const STDIO_KEYS: readonly string[] = ['type', 'command', 'args', 'env'];

const invalid = (name: string, why: string): Result<PiExtensionServer[]> =>
  refuse<PiExtensionServer[]>('mcp-descriptor-invalid', `MCP server "${name}" ${why}`);

/** A map of strings, or null when `value` is not one. */
function stringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(([, one]) => typeof one === 'string')
    ? Object.fromEntries(entries as [string, string][])
    : null;
}

/** The servers the extension registers for `servers`, or the first server with no pi form, by name. */
export function piMcpServers(
  servers: Readonly<Record<string, McpServerConfig>> | null,
): Result<PiExtensionServer[]> {
  const out: PiExtensionServer[] = [];
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!SERVER_NAME.test(name)) {
      return invalid(name, 'has a name pi does not take: letters, digits, _ and - only');
    }
    const declared = server as unknown as Record<string, unknown>;
    const type = declared['type'] ?? 'stdio';
    const allowed = type === 'http' ? HTTP_KEYS : type === 'stdio' ? STDIO_KEYS : null;
    if (allowed === null) {
      return invalid(
        name,
        type === 'sse'
          ? 'is an SSE server; pi takes streamable HTTP and stdio servers'
          : `is a ${typeof type === 'string' ? type : 'nameless'} server, which has no form pi can start`,
      );
    }
    const extra = Object.keys(declared).find((key) => !allowed.includes(key));
    if (extra !== undefined) return invalid(name, `sets ${extra}, which pi has no setting for`);

    if (type === 'http') {
      const url = declared['url'];
      if (typeof url !== 'string' || url === '') return invalid(name, 'has no url');
      let headers: Record<string, string> | undefined;
      if (declared['headers'] !== undefined) {
        const read = stringMap(declared['headers']);
        if (read === null) return invalid(name, 'has headers that are not a map of strings');
        headers = read;
      }
      out.push({ name, type: 'http', url, ...(headers === undefined ? {} : { headers }) });
      continue;
    }
    const command = declared['command'];
    if (typeof command !== 'string' || command === '') return invalid(name, 'has no command');
    const args = declared['args'];
    if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === 'string'))) {
      return invalid(name, 'has args that are not a list of strings');
    }
    let env: Record<string, string> | undefined;
    if (declared['env'] !== undefined) {
      const read = stringMap(declared['env']);
      if (read === null) return invalid(name, 'has an env that is not a map of strings');
      env = read;
    }
    out.push({
      name,
      type: 'stdio',
      command,
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
    });
  }
  return ok(out);
}
