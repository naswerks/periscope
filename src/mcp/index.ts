/**
 * In-process MCP servers and the tool descriptors that build them.
 *
 * `createToolServer` is not here. It calls the SDK, so it lives in `host/mcp-server.ts` under the
 * rule that one directory names the SDK — see that file. Everything in this directory is the
 * decisions: the descriptor contract, the schema conversion, and the plan a server is built from.
 */
export type { JsonSchemaNode, JsonSchemaObject, SupportedSchemaType, ToolDescriptor } from './descriptor.js';
export { SUPPORTED_SCHEMA_TYPES, isUsableToolName } from './descriptor.js';

export type { ZodRawShape } from './schema.js';
export { toRawShape, toZod } from './schema.js';

export type {
  McpServerOptions,
  ToolCall,
  ToolCallIdentity,
  ToolInvoker,
  ToolPlan,
  ToolResponse,
  ToolResult,
} from './server.js';
export { planTools } from './server.js';
