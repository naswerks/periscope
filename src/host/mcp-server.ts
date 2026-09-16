/**
 * The one place a tool plan becomes an SDK server.
 *
 * It lives here for the import, not for the danger. `createSdkMcpServer` and `tool()` build
 * in-process objects and start nothing, but the boundary rule is that one directory names
 * `@anthropic-ai/claude-agent-sdk`, so a reader answering "what can start a process here?" reads
 * `src/host/` and nowhere else. Carving out an exception for the safe calls in that package is
 * how a boundary stops meaning anything, so the exception is not taken. All the decisions are in
 * `mcp/server.ts`; this file adds the SDK call and nothing else.
 *
 * In-process removes machinery rather than replacing it: no `.mcp.json` written into the
 * workspace, no stdio child to spawn, no attach receipt to watch for, no port, no handshake.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { McpServerOptions, ToolPlan } from '../mcp/server.js';
import { planTools } from '../mcp/server.js';

/**
 * One tool definition, named through the SDK's own signature rather than by hand.
 *
 * `CreateSdkMcpServerOptions` is a `declare type` and not exported, so a consumer cannot name the
 * argument `createSdkMcpServer` takes. Deriving it from the function's parameter is how this file
 * stays exactly as wide as the SDK is: if the accepted shape changes, this breaks at build time
 * rather than after a cast quietly absorbed the difference.
 */
type ToolDefinition = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>[number];

/**
 * Build the in-process server from a controller's descriptors.
 *
 * Refuses rather than throwing — registration happens before any session exists, and a controller
 * that sent an unusable descriptor needs to be told which one and why.
 */
export function createToolServer(options: McpServerOptions): Result<McpSdkServerConfigWithInstance> {
  const planned = planTools(options);
  if (!planned.ok)
    return refuse<McpSdkServerConfigWithInstance>(planned.refusal.reason, planned.refusal.detail);

  return ok(
    createSdkMcpServer({
      name: options.name,
      version: options.version ?? '0.0.0',
      tools: planned.value.map(toDefinition),
    }),
  );
}

/**
 * A plan, as the SDK's own tool definition. The whole of this module's added value.
 *
 * The result is re-built rather than passed through; that is the adaptation this seam exists for.
 * The SDK's result type carries an index signature (`[x: string]: unknown`), which a declared
 * interface cannot satisfy — so `mcp/server.ts` states the shape it means in its own terms and the
 * translation happens here, in the one file allowed to know both. A cast would have compiled and
 * would have hidden any later divergence between the two shapes.
 */
function toDefinition(plan: ToolPlan): ToolDefinition {
  return tool(plan.name, plan.description, plan.shape, async (args: unknown) => {
    const result = await plan.handler(args);
    return { content: result.content, ...(result.isError === true ? { isError: true } : {}) };
  });
}
