/**
 * Descriptors in, tool plans out — the whole registration path, with no SDK anywhere in it.
 *
 * Why this file stops short of the SDK. Only `src/host/` names `@anthropic-ai/claude-agent-sdk`,
 * pinned by pins/sdk-confinement.test.ts, so that one directory answers "what can start a process
 * here?". Building an in-process MCP server is not a spawn — but the rule is about the specifier,
 * not about which of the package's functions happen to be dangerous, and weakening it for a safe
 * call is how the boundary stops meaning anything. So the decisions live here and
 * `host/mcp-server.ts` turns a plan into an actual server. Exactly the split the path jail uses
 * (`gate/jail.ts` pure, `host/paths.ts` real) and the workspace providers use.
 *
 * The payoff is the same one it always is: the generic pin can fingerprint a plan and compare two
 * registrations without an SDK object anywhere near the test.
 *
 * The host never learns what a tool means. Every tool takes one path: validate the descriptor,
 * convert the schema it was handed, check a call's arguments against that schema, attach session
 * identity, forward to the invoker, return the answer. There is no branch on a tool's name anywhere
 * — pinned by pins/mcp-generic.test.ts, which plans the same descriptors under permuted names and
 * requires the results to be identical.
 *
 * No `MCP_TIMEOUT` knob, deliberately. A 30-second connect window lost under a spawn storm, and a
 * CLI that never reconnects a failed stdio server, are process-transport failures. An in-process
 * server never connects, so it cannot lose a race and has nothing to reconnect. Porting the knob
 * anyway would document a failure mode this design does not have.
 */
import type { JsonObject, JsonValue } from '../control/frames.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { ToolDescriptor } from './descriptor.js';
import { isUsableToolName } from './descriptor.js';
import type { ZodRawShape } from './schema.js';
import { toRawShape } from './schema.js';

/** Which session a call came from. Read at call time — see `identity` below. */
export interface ToolCallIdentity {
  /**
   * The agent's own session id, or null before it has reported one.
   *
   * Null is reachable and is not an error. An agent does not report itself until its first turn
   * has been queued, so a server composed at session start genuinely has no id yet. An invoker
   * receiving null knows the call arrived before the agent named itself, which is information —
   * inventing a placeholder id would destroy it.
   */
  readonly sessionId: string | null;
}

/** One forwarded call, in the invoker's terms. */
export interface ToolCall {
  readonly serverName: string;
  readonly toolName: string;
  /** Already validated against the tool's own schema. */
  readonly arguments: JsonObject;
  readonly identity: ToolCallIdentity;
}

/** What the invoker answers with. */
export interface ToolResponse {
  readonly text: string;
  /** Reported to the model as an error result. Defaults to false. */
  readonly isError?: boolean;
}

/** How a validated call reaches the embedder's invoker, the only thing that knows what a tool does. */
export type ToolInvoker = (call: ToolCall) => Promise<ToolResponse>;

/**
 * A tool result in the shape MCP expects. Structural, so this file needs no SDK type.
 *
 * `content` is mutable, against this package's habit, because the SDK's own result type declares a
 * mutable array and a `readonly` one is not assignable to it. Stated rather than left as a puzzle:
 * the alternative is a cast at the seam, which would hide any future divergence in that shape.
 */
export interface ToolResult {
  readonly content: { type: 'text'; text: string }[];
  readonly isError?: boolean;
}

/**
 * One tool, ready to be handed to the SDK.
 *
 * Everything about a tool that this package decides. `host/mcp-server.ts` adds nothing but the
 * SDK call — which is what makes a plan a complete and checkable statement of the registration.
 */
export interface ToolPlan {
  readonly name: string;
  readonly description: string;
  readonly shape: ZodRawShape;
  readonly handler: (args: unknown) => Promise<ToolResult>;
}

export interface McpServerOptions {
  /** The server's name. Tools reach the model as `mcp__{name}__{tool}`. */
  readonly name: string;
  readonly version?: string;
  readonly descriptors: readonly ToolDescriptor[];
  readonly invoke: ToolInvoker;
  /**
   * Session identity, read at call time rather than captured at composition time.
   *
   * A function, not a value, and the reason is a measured SDK property. The server has to exist
   * before `query()` is called, and the agent does not report its session id until its first turn
   * has been queued — so a value captured here would be null forever, on every call, for the whole
   * session. Reading it lazily is the only shape that can ever carry a real id.
   */
  readonly identity: () => ToolCallIdentity;
}

/**
 * Turn descriptors into plans.
 *
 * Refuses rather than throwing: this runs before any session exists, and an embedder that supplied an
 * unusable descriptor needs to be told which one and why.
 */
export function planTools(options: McpServerOptions): Result<ToolPlan[]> {
  if (!isUsableToolName(options.name)) {
    return refuse<ToolPlan[]>(
      'mcp-descriptor-invalid',
      `"${options.name}" is not a usable server name — letters, digits, hyphen and single underscores only`,
    );
  }

  const seen = new Set<string>();
  const plans: ToolPlan[] = [];

  for (const descriptor of options.descriptors) {
    const invalid = rejectDescriptor<ToolPlan[]>(descriptor, seen);
    if (invalid !== null) return invalid;
    seen.add(descriptor.name);

    const shape = toRawShape(descriptor.inputSchema, `${descriptor.name}.inputSchema`);
    if (!shape.ok) return refuse<ToolPlan[]>(shape.refusal.reason, shape.refusal.detail);

    // The handler closes over the tool's name as data. It reads nothing else about the tool and
    // branches on nothing — every tool in every server runs this identical body.
    const toolName = descriptor.name;
    const handler = async (args: unknown): Promise<ToolResult> => {
      const response = await options.invoke({
        serverName: options.name,
        toolName,
        arguments: asJsonObject(args),
        identity: options.identity(),
      });
      return {
        content: [{ type: 'text' as const, text: response.text }],
        ...(response.isError === true ? { isError: true } : {}),
      };
    };

    plans.push({ name: descriptor.name, description: descriptor.description, shape: shape.value, handler });
  }

  return ok(plans);
}

function rejectDescriptor<T>(descriptor: ToolDescriptor, seen: Set<string>): Result<T> | null {
  if (typeof descriptor?.name !== 'string' || !isUsableToolName(descriptor.name)) {
    return refuse<T>(
      'mcp-descriptor-invalid',
      `"${String(descriptor?.name)}" is not a usable tool name — letters, digits, hyphen and single underscores only`,
    );
  }
  if (typeof descriptor.description !== 'string' || descriptor.description.trim() === '') {
    // The description is the only thing that tells the model what the tool is for. A tool without
    // one is registered, callable, and never called — which looks like a broken tool, not a bad
    // descriptor.
    return refuse<T>('mcp-descriptor-invalid', `tool "${descriptor.name}" has no description`);
  }
  if (seen.has(descriptor.name)) {
    // Two tools with one name: the second silently shadows the first, so an embedder would see
    // calls it expected to reach one tool arrive at another.
    return refuse<T>('mcp-descriptor-invalid', `tool "${descriptor.name}" is described twice in one server`);
  }
  return null;
}

/** The SDK hands the handler its parsed arguments; this narrows them for the wire. */
function asJsonObject(args: unknown): JsonObject {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {};
  return args as Record<string, JsonValue>;
}
