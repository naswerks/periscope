/**
 * JSON-Schema to Zod raw shape, because that is the shape the SDK's `tool()` actually takes.
 *
 * Why a conversion exists at all. `SdkMcpToolDefinition<Schema extends AnyZodRawShape>` is generic
 * over a Zod raw shape — a plain record of Zod types, not a schema object and not JSON Schema. A
 * design in which descriptors carry `inputSchema: JsonSchema` and the host does
 * `validate(input, d.inputSchema)` does not compile against the shipped types. A controller in
 * another language cannot express Zod shapes, so the conversion happens here and the descriptor
 * contract stays JSON.
 *
 * An unconvertible construct is refused. Never widened, never `z.any()`, never skipped.
 * This is the most consequential line in the directory. A converter that met something it did not
 * recognise and fell back to a permissive schema would register the tool successfully and validate
 * nothing — so "a malformed call is rejected before it reaches the controller" would be silently
 * false for exactly the tools nobody looked at, while every test stayed green and the tool appeared
 * to work. That is a false green in the highest-consequence direction: the failure is invisible
 * precisely where the checking was supposed to be. Refusing happens at registration, before any
 * session exists, and names the construct that could not be converted.
 *
 * The subset is deliberately small — what a controller emits for a tool's arguments. Growing it is
 * a normal change; growing it by accident is what the refusal prevents.
 */
import { z } from 'zod';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { JsonSchemaNode, JsonSchemaObject } from './descriptor.js';
import { SUPPORTED_SCHEMA_TYPES } from './descriptor.js';

/** What `tool()` takes: a record of Zod types, one per top-level property. */
export type ZodRawShape = Record<string, z.ZodType>;

/**
 * Convert a tool's input schema into a raw shape.
 *
 * An object with no properties converts to an empty shape rather than being refused — a tool that
 * takes no arguments is ordinary, and refusing it would force every caller to invent a parameter.
 */
export function toRawShape(schema: JsonSchemaObject, at = 'inputSchema'): Result<ZodRawShape> {
  if (!isRecordLike(schema)) {
    return refuse<ZodRawShape>('mcp-schema-unsupported', `${at} is not an object`);
  }
  if (schema.type !== undefined && schema.type !== 'object') {
    // A tool's arguments are always a named set. A top-level array or string has no property names
    // to become a shape's keys, so there is nothing to convert it into.
    return refuse<ZodRawShape>(
      'mcp-schema-unsupported',
      `${at} must be an object schema, not ${String(schema.type)} — a tool's arguments are always named`,
    );
  }

  const properties: Readonly<Record<string, JsonSchemaNode>> = schema.properties ?? {};
  if (!isRecordLike(properties)) {
    return refuse<ZodRawShape>('mcp-schema-unsupported', `${at}.properties is not an object`);
  }

  const required = new Set<string>(schema.required ?? []);
  for (const name of required) {
    if (!(name in properties)) {
      // A required property with no definition would silently vanish from the shape, so a call
      // omitting it would pass — the schema says it is mandatory and nothing would enforce that.
      return refuse<ZodRawShape>(
        'mcp-schema-unsupported',
        `${at}.required names "${name}", which has no entry in properties`,
      );
    }
  }

  const shape: ZodRawShape = {};
  for (const [name, node] of Object.entries(properties)) {
    const converted = toZod(node, `${at}.properties.${name}`);
    if (!converted.ok) return refuse<ZodRawShape>(converted.refusal.reason, converted.refusal.detail);
    // Optional is the default, exactly as JSON Schema says: a property is required only when
    // `required` names it. Getting this backwards would make every argument mandatory and every
    // legitimate call fail.
    shape[name] = required.has(name) ? converted.value : converted.value.optional();
  }

  return ok(shape);
}

/** Convert one node. Recursive for `array` and `object`. */
export function toZod(node: JsonSchemaNode, at: string): Result<z.ZodType> {
  if (!isRecordLike(node)) {
    return refuse<z.ZodType>('mcp-schema-unsupported', `${at} is not a schema object`);
  }

  const base = baseType(node, at);
  if (!base.ok) return base;

  let schema = base.value;
  if (node.nullable === true) schema = schema.nullable();
  if (typeof node.description === 'string' && node.description !== '') {
    // Carried because the model reads it. A converted schema that dropped descriptions would produce
    // tools whose arguments are undocumented to the only reader that matters.
    schema = schema.describe(node.description);
  }
  return ok(schema);
}

function baseType(node: JsonSchemaNode, at: string): Result<z.ZodType> {
  // `enum` wins over `type`: a closed set of literals is a stronger statement than the type of its
  // members, and an emitter that sends both means the enum.
  if (node.enum !== undefined) return fromEnum(node.enum, at);

  if (node.type === undefined) {
    // A typeless node is refused, and this is the case a fallback would swallow. In
    // JSON Schema, no `type` means "anything" — so converting it to a permissive schema is the
    // literally correct reading and also the one that turns validation off for that property
    // without saying so.
    return refuse<z.ZodType>(
      'mcp-schema-unsupported',
      `${at} declares no type, which would accept any value — state a type or an enum rather than validating nothing`,
    );
  }

  switch (node.type) {
    case 'string':
      return ok(z.string());
    case 'boolean':
      return ok(z.boolean());
    case 'number':
      return ok(z.number());
    case 'integer':
      return ok(z.number().int());
    case 'array':
      return fromArray(node, at);
    case 'object':
      return fromObject(node, at);
    default:
      return refuse<z.ZodType>(
        'mcp-schema-unsupported',
        `${at} has type "${String(node.type)}", which this host cannot convert — supported: ${SUPPORTED_SCHEMA_TYPES.join(', ')}`,
      );
  }
}

function fromArray(node: JsonSchemaNode, at: string): Result<z.ZodType> {
  if (node.items === undefined) {
    // An array with no `items` accepts a list of anything, which is the same hole as a typeless
    // property one level down.
    return refuse<z.ZodType>(
      'mcp-schema-unsupported',
      `${at} is an array with no items schema, so its elements would not be validated at all`,
    );
  }
  const items = toZod(node.items, `${at}.items`);
  if (!items.ok) return items;
  return ok(z.array(items.value));
}

function fromObject(node: JsonSchemaNode, at: string): Result<z.ZodType> {
  const properties: Readonly<Record<string, JsonSchemaNode>> = node.properties ?? {};
  if (!isRecordLike(properties)) {
    return refuse<z.ZodType>('mcp-schema-unsupported', `${at}.properties is not an object`);
  }
  if (Object.keys(properties).length === 0) {
    return refuse<z.ZodType>(
      'mcp-schema-unsupported',
      `${at} is an object with no properties, so any object would satisfy it`,
    );
  }

  const required = new Set(node.required ?? []);
  const shape: ZodRawShape = {};
  for (const [name, child] of Object.entries(properties)) {
    const converted = toZod(child, `${at}.properties.${name}`);
    if (!converted.ok) return converted;
    shape[name] = required.has(name) ? converted.value : converted.value.optional();
  }
  return ok(z.object(shape));
}

function fromEnum(values: readonly unknown[], at: string): Result<z.ZodType> {
  if (!Array.isArray(values) || values.length === 0) {
    return refuse<z.ZodType>('mcp-schema-unsupported', `${at}.enum is empty, so no value could satisfy it`);
  }

  const literals: z.ZodType[] = [];
  for (const value of values) {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean' &&
      value !== null
    ) {
      return refuse<z.ZodType>(
        'mcp-schema-unsupported',
        `${at}.enum carries a non-primitive value (${JSON.stringify(value)}); only strings, numbers, booleans and null convert`,
      );
    }
    literals.push(value === null ? z.null() : z.literal(value));
  }

  const [first, second, ...rest] = literals;
  if (first === undefined) {
    return refuse<z.ZodType>('mcp-schema-unsupported', `${at}.enum is empty`);
  }
  // A one-value enum is a literal; a union needs at least two members.
  if (second === undefined) return ok(first);
  return ok(z.union([first, second, ...rest]));
}

/**
 * A plain object, checked at runtime without narrowing the compile-time type.
 *
 * It returns `boolean`, not a type predicate, on purpose. These values arrive typed as schema
 * nodes but come off the wire, so the check has to run — and a predicate would re-narrow an already
 * precise type down to `Record<string, unknown>`, turning every child node into `unknown` and
 * forcing casts back to the type the caller already had.
 */
function isRecordLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
