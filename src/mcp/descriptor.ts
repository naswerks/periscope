/**
 * The descriptor contract — what an embedder supplies so this host can register an in-process tool.
 *
 * The descriptor is deliberately language-neutral. An embedder composing this host from another
 * language, or a controller whose descriptors an embedder forwards,
 * cannot express a TypeScript schema library's types, and asking it to would put a TypeScript
 * dependency on the wire — which is precisely the leak this package is built to avoid. So a
 * descriptor is JSON: a name, a description, and a JSON-Schema object. The host converts it
 * (schema.ts) into what the SDK needs.
 *
 * The host never learns what a tool means. It validates the descriptor's shape, converts the
 * schema it was handed, checks a call's arguments against that schema, attaches session identity,
 * forwards, and returns the answer. There is no branch anywhere on a tool's name — pinned by
 * pins/mcp-generic.test.ts, which registers the same descriptors under permuted names and requires
 * the results to be identical.
 *
 * The subset is declared, not inferred. Only the constructs below are convertible. A descriptor
 * carrying anything else is refused at registration rather than converted to something permissive —
 * see schema.ts, where that rule is the most consequential line in this directory.
 */
import type { JsonValue } from '../control/frames.js';

/** The JSON-Schema types this host converts. Anything else is refused by name. */
export const SUPPORTED_SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'] as const;

export type SupportedSchemaType = (typeof SUPPORTED_SCHEMA_TYPES)[number];

/**
 * One node of a tool's input schema.
 *
 * Everything is optional because this is what ARRIVES — an untrusted object off the wire, not a
 * shape this package constructs. Validation happens in schema.ts and reports what was wrong.
 */
export interface JsonSchemaNode {
  readonly type?: string;
  readonly description?: string;
  /** A closed set of literal values. Takes precedence over `type`. */
  readonly enum?: readonly JsonValue[];
  /** For `array`. */
  readonly items?: JsonSchemaNode;
  /** For `object`. */
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  /** JSON-Schema draft-4 style, and the spelling most emitters produce. */
  readonly nullable?: boolean;
}

/** A tool's input schema. Always an object at the top level — `tool()` takes a shape, not a type. */
export interface JsonSchemaObject extends JsonSchemaNode {
  readonly type?: 'object';
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
}

/** One tool, as the embedder describes it. */
export interface ToolDescriptor {
  /** What the agent calls. Reaches the model as `mcp__{server}__{name}`. */
  readonly name: string;
  /** What the tool does, in the model's terms. The only thing that makes it usable. */
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
}

/**
 * A tool name both the MCP protocol and the agent CLI accept.
 *
 * Conservative on purpose: the name is concatenated into `mcp__{server}__{name}`, so a name carrying
 * the separator would produce a tool the agent addresses ambiguously — and the failure would look
 * like the wrong tool being called rather than like a bad name.
 */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isUsableToolName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.includes('__');
}
