/**
 * The wire edge. Bytes become types here and nowhere else.
 *
 * Two properties this file exists to hold:
 *   - Nothing inward of `decode` has seen an unvalidated object, and `decode` never throws — a
 *     malformed frame from a version-skewed stranger is a named refusal, not a crash.
 *   - Unknown fields survive. A newer peer's extra key is preserved rather than stripped, so an
 *     older host relaying a frame does not quietly destroy information it did not understand.
 */
import { z } from 'zod';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { isRefusalReason } from '../core/refusal.js';
import type {
  AgentFact,
  AgentItem,
  Frame,
  HostAgent,
  HostAgentEntry,
  HostAgentSkills,
  HostEndpoint,
  JsonObject,
  JsonValue,
  WireRefusal,
} from './frames.js';
import {
  CACHE_TTLS,
  COMPACTION_STATUSES,
  COMPACTION_TRIGGERS,
  COST_BASES,
  ENDPOINT_WIRE_APIS,
  FILE_CHANGE_KINDS,
  FRAGMENT_CHANNELS,
  MAX_AGENT_CATALOG_BYTES,
  MAX_AGENT_ITEM_BYTES,
  MAX_AGENT_ENTRIES,
  MAX_AGENT_MODELS,
  MAX_BULK_RELEASES,
  MAX_CONFIGURATION_VALUE_LENGTH,
  MAX_CONFIGURE_ENTRIES,
  MAX_ENDPOINT_CATALOG_BYTES,
  MAX_ENDPOINT_MODELS,
  MAX_ENDPOINTS,
  MAX_FACT_LIST_ENTRIES,
  MAX_FACT_TEXT_LENGTH,
  MAX_FACT_WORD_LENGTH,
  MAX_FRAME_BYTES,
  MAX_PLUGIN_DIRS,
  MAX_REPOSITORY_ENTRIES,
  MAX_REPOSITORY_READ_BYTES,
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_READ_BYTES,
  NOTICE_LEVELS,
  RECEIPT_SOURCES,
  SKILL_DELIVERIES,
  SKILL_NAMINGS,
  TASK_SETTLEMENTS,
  TOOL_RESULT_STATUSES,
  TURN_ITEM_STATUSES,
  TURN_SCOPES,
} from './frames.js';
import { MAX_WORKSPACE_ID_LENGTH } from '../core/workspace-id.js';
import { TOOL_KINDS } from '../gate/decision.js';
import { agentItemBytes } from './item-budget.js';
import { CONTROL_TIER_LEVELS } from '../state/model.js';

/**
 * UTF-8 byte length, the web-standard way.
 *
 * Not `Buffer.byteLength`: `Buffer` is a Node-only global. This module sits inside the
 * `periscope/protocol` closure, whose claim is that a controller can import the wire contract
 * without acquiring a runtime, and the pin guarding that claim reads imports, which a global is
 * invisible to. `TextEncoder` is WHATWG and present in Node, browsers, Deno and Bun.
 *
 * One instance, module-level: `encode` runs per frame and a fresh encoder per call is pure waste.
 */
const UTF8 = new TextEncoder();

function utf8ByteLength(text: string): number {
  return UTF8.encode(text).length;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/**
 * The tolerance is on the decode side only, and it is not a widening of the vocabulary.
 *
 * `reason` is a plain string here rather than `z.enum(REFUSAL_REASONS)`: a closed enum would make
 * a newer peer's added reason fatal, failing the whole `bulk_failed` frame as `frame-malformed`,
 * so a delivery receipt would become unreadable because the failure had a name this build did not
 * know. That would contradict this file's own header: unknown keys survive, and an unknown value
 * of a known key is the same information one level in.
 *
 * What may be written is enforced below in `encode`: this host cannot emit an
 * undeclared reason, checked at the moment a frame becomes bytes rather than trusted to a type. So
 * the pair is strict out, tolerant in. Read the result with `readRefusal`, which narrows a known
 * reason and preserves the raw string for one it has never seen.
 */
const refusalSchema = z.looseObject({
  reason: z.string().min(1),
  detail: z.string(),
});

const sessionCursorSchema = z.looseObject({
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
});

// Each value is host-controlled text on the one frame a controller reads before trusting anything,
// so the cap is enforced at the wire edge rather than left to the reader.
const configurationValueSchema = z.string().max(MAX_CONFIGURATION_VALUE_LENGTH).nullable();

const hostPluginSchema = z.looseObject({
  name: z.string().min(1).max(200),
  version: z.string().max(64).nullable(),
  path: z.string().min(1).max(MAX_CONFIGURATION_VALUE_LENGTH),
});

// The catalog is the agent's text, relayed: bounded here like every other value on the hello.
const agentModelTextSchema = z.string().min(1).max(200);

const hostModelSchema = z.looseObject({
  value: agentModelTextSchema,
  resolvedModel: agentModelTextSchema.nullable(),
  displayName: z.string().max(200),
  description: z.string().max(MAX_CONFIGURATION_VALUE_LENGTH).nullable(),
  supportedEffortLevels: z.array(z.string().min(1).max(32)).max(16),
  supportsFastMode: z.boolean().nullable(),
  supportsAutoMode: z.boolean().nullable(),
  supportsAdaptiveThinking: z.boolean().nullable(),
});

const hostAgentSchema = z.looseObject({
  claudeCodeVersion: z.string().min(1).max(64),
  sdkVersion: z.string().min(1).max(64),
  models: z.array(hostModelSchema).max(MAX_AGENT_MODELS),
});

/**
 * A control tier (protocol 15): its level and the paths that fall below it, each a word. The level
 * is a bounded string here, so a newer peer's added level is read; `encode` refuses a level this
 * host does not declare.
 */
const controlTierSchema = z.looseObject({
  level: z.string().min(1).max(MAX_FACT_WORD_LENGTH),
  degrades: z.array(z.string().min(1).max(MAX_FACT_WORD_LENGTH)).max(MAX_FACT_LIST_ENTRIES),
});

/** A runtime's session-control words: bounded like a model's effort levels. */
const vocabularyWordsSchema = z.array(z.string().min(1).max(32)).max(16);

// One runtime the host can spawn (protocol 15). The entry is new, so its own members are required;
// the list that carries it is the optional member.
const hostAgentEntrySchema = z.looseObject({
  runtime: z.string().min(1).max(MAX_FACT_WORD_LENGTH),
  version: z.string().min(1).max(64),
  sdkVersion: z.string().min(1).max(64).nullable(),
  models: z.array(hostModelSchema).max(MAX_AGENT_MODELS),
  vocabularies: z.looseObject({
    permissionModes: vocabularyWordsSchema,
    efforts: vocabularyWordsSchema,
    thinking: z.boolean(),
  }),
  controlTier: controlTierSchema,
  available: z.boolean(),
  unavailableReason: z.string().max(MAX_CONFIGURATION_VALUE_LENGTH).nullable(),
});

const hostAgentsSchema = z.array(hostAgentEntrySchema).max(MAX_AGENT_ENTRIES);

// One model endpoint the operator declared (protocol 15). The entry is new, so its own members are
// required; the list that carries it is the optional member. The wire API is a bounded word here, so a
// newer peer's added API is read; `encode` refuses an API this host does not declare.
const hostEndpointSchema = z.looseObject({
  name: z.string().min(1).max(MAX_FACT_WORD_LENGTH),
  wireApi: z.string().min(1).max(MAX_FACT_WORD_LENGTH),
  runtimes: z.array(z.string().min(1).max(MAX_FACT_WORD_LENGTH)).max(MAX_AGENT_ENTRIES),
  models: z.array(agentModelTextSchema).max(MAX_ENDPOINT_MODELS).nullable(),
});

const hostEndpointsSchema = z.array(hostEndpointSchema).max(MAX_ENDPOINTS);

// How one runtime takes plugin directories (protocol 16). The entry is new, so its own members are
// required; the list that carries it is the optional member. Each word is bounded here, so a newer
// peer's added word is read; `encode` refuses a word this host does not declare.
const hostAgentSkillsSchema = z.looseObject({
  runtime: z.string().min(1).max(MAX_FACT_WORD_LENGTH),
  naming: z.string().min(1).max(MAX_FACT_WORD_LENGTH),
  delivery: z.string().min(1).max(MAX_FACT_WORD_LENGTH),
});

const hostAgentSkillsListSchema = z.array(hostAgentSkillsSchema).max(MAX_AGENT_ENTRIES);

const hostConfigurationSchema = z.looseObject({
  repositoryRoot: configurationValueSchema,
  workspaceRoot: configurationValueSchema,
  branchScheme: configurationValueSchema,
  transcriptsRoot: configurationValueSchema,
  controllerUrl: configurationValueSchema,
  decisionUrl: configurationValueSchema,
  agentHome: configurationValueSchema,
  plugins: z.array(hostPluginSchema).max(MAX_PLUGIN_DIRS),
  // Protocol 12, and optional: a host one release behind omits it (see frames.ts's header).
  agent: hostAgentSchema.nullable().optional(),
  // Protocol 15, optional for the same reason.
  agents: hostAgentsSchema.nullable().optional(),
  endpoints: hostEndpointsSchema.nullable().optional(),
  // Protocol 16, optional for the same reason.
  agentSkills: hostAgentSkillsListSchema.nullable().optional(),
});

/** The key names a hello or a configure result lists as pending: config keys, so short and few. */
const pendingRestartSchema = z.array(z.string().min(1).max(64)).max(MAX_CONFIGURE_ENTRIES);

const protocolRangeSchema = z.looseObject({
  min: z.number().int().min(1),
  max: z.number().int().min(1),
});

// ---------------------------------------------------------------------------
// The fact layer's bodies (protocol 15).
//
// Every member a fact declares is `.nullable().optional()`: a peer that omits one is read as not
// stating it, and an unknown key is carried. What these schemas refuse is a member that is present
// with the wrong type, a count that is not a whole number or is negative, and text past its bound.
// Each count is spelled out as `<member>: z.number().int()` so a reader of this file, or a generator
// reading it, can see which members are whole numbers on the wire.
//
// A vocabulary member (a cost basis, a scope, a channel) is a bounded string here, so a newer peer's
// added word is read rather than refused; `encode` refuses a word this host does not declare, so
// nothing this host sends carries one. Tolerant in, strict out, as with refusal reasons.
// ---------------------------------------------------------------------------

const factWordSchema = z.string().max(MAX_FACT_WORD_LENGTH);
const factTextSchema = z.string().max(MAX_FACT_TEXT_LENGTH);
/** A fact's `kind` names which fact it is, so it is never empty. */
const factKindSchema = z.string().min(1).max(MAX_FACT_WORD_LENGTH);

const modelSpendFactSchema = z.looseObject({
  model: factTextSchema.nullable().optional(),
  canonicalModel: factTextSchema.nullable().optional(),
  provider: factWordSchema.nullable().optional(),
  inputTokens: z.number().int().nonnegative().nullable().optional(),
  outputTokens: z.number().int().nonnegative().nullable().optional(),
  cacheReadTokens: z.number().int().nonnegative().nullable().optional(),
  cacheWriteTokens: z.number().int().nonnegative().nullable().optional(),
  reasoningTokens: z.number().int().nonnegative().nullable().optional(),
  cost: z.number().nonnegative().nullable().optional(),
  costBasis: factWordSchema.nullable().optional(),
  contextWindow: z.number().int().nonnegative().nullable().optional(),
});

const spendFactsSchema = z.looseObject({
  cost: z.number().nonnegative().nullable().optional(),
  currency: factWordSchema.nullable().optional(),
  costBasis: factWordSchema.nullable().optional(),
  byModel: z.array(modelSpendFactSchema).max(MAX_FACT_LIST_ENTRIES).nullable().optional(),
});

/** One schema per fact kind this build models, each holding the members that kind declares. */
const FACT_SCHEMAS: Readonly<Record<AgentFact['kind'], z.ZodType>> = {
  session_handle: z.looseObject({
    runtime: factWordSchema.nullable().optional(),
    handle: factTextSchema.nullable().optional(),
  }),
  agent_receipt: z.looseObject({
    runtime: factWordSchema.nullable().optional(),
    runtimeVersion: factWordSchema.nullable().optional(),
    model: factTextSchema.nullable().optional(),
    permissionMode: factWordSchema.nullable().optional(),
    effort: factWordSchema.nullable().optional(),
    skills: z.array(factTextSchema).max(MAX_FACT_LIST_ENTRIES).nullable().optional(),
    plugins: z
      .array(
        z.looseObject({
          name: factTextSchema.nullable().optional(),
          version: factWordSchema.nullable().optional(),
          path: factTextSchema.nullable().optional(),
        }),
      )
      .max(MAX_FACT_LIST_ENTRIES)
      .nullable()
      .optional(),
    pluginErrors: z
      .array(
        z.looseObject({
          plugin: factTextSchema.nullable().optional(),
          type: factWordSchema.nullable().optional(),
          message: factTextSchema.nullable().optional(),
          path: factTextSchema.nullable().optional(),
        }),
      )
      .max(MAX_FACT_LIST_ENTRIES)
      .nullable()
      .optional(),
    mcpServers: z
      .array(
        z.looseObject({
          name: factTextSchema.nullable().optional(),
          status: factWordSchema.nullable().optional(),
        }),
      )
      .max(MAX_FACT_LIST_ENTRIES)
      .nullable()
      .optional(),
    source: factWordSchema.nullable().optional(),
    effortReported: z.boolean().nullable().optional(),
  }),
  turn_record: z.looseObject({
    runtime: factWordSchema.nullable().optional(),
    totals: spendFactsSchema.nullable().optional(),
    turn: spendFactsSchema.nullable().optional(),
    turnScope: factWordSchema.nullable().optional(),
    numTurns: z.number().int().nonnegative().nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    sourceSessionId: factTextSchema.nullable().optional(),
  }),
  usage_sample: z.looseObject({
    runtime: factWordSchema.nullable().optional(),
    model: factTextSchema.nullable().optional(),
    contextTokens: z.number().int().nonnegative().nullable().optional(),
    contextWindow: z.number().int().nonnegative().nullable().optional(),
    cacheTtl: factWordSchema.nullable().optional(),
    mainThread: z.boolean().nullable().optional(),
    cacheReadTokens: z.number().int().nonnegative().nullable().optional(),
  }),
  tasks: z.looseObject({
    runtime: factWordSchema.nullable().optional(),
    running: z
      .array(
        z.looseObject({
          taskId: factTextSchema.nullable().optional(),
          type: factWordSchema.nullable().optional(),
          description: factTextSchema.nullable().optional(),
        }),
      )
      .max(MAX_FACT_LIST_ENTRIES)
      .nullable()
      .optional(),
    settled: z
      .array(
        z.looseObject({
          taskId: factTextSchema.nullable().optional(),
          type: factWordSchema.nullable().optional(),
          status: factWordSchema.nullable().optional(),
        }),
      )
      .max(MAX_FACT_LIST_ENTRIES)
      .nullable()
      .optional(),
  }),
  compaction: z.looseObject({
    runtime: factWordSchema.nullable().optional(),
    status: factWordSchema.nullable().optional(),
    trigger: factWordSchema.nullable().optional(),
    tokensBefore: z.number().int().nonnegative().nullable().optional(),
    tokensAfter: z.number().int().nonnegative().nullable().optional(),
  }),
};

/**
 * The `agent_facts` body. `fact` is required because it is what the body is: a body naming this
 * update with no fact in it is malformed. A fact kind this build does not model is carried with only
 * its `kind` checked, so a newer peer's added kind crosses intact.
 */
const agentFactsBodySchema = z.looseObject({
  update: z.literal('agent_facts'),
  fact: z.looseObject({ kind: factKindSchema }),
  sourceId: factTextSchema.nullable().optional(),
  observedAt: z.string().min(1).nullable().optional(),
});

const agentFragmentBodySchema = z.looseObject({
  update: z.literal('agent_fragment'),
  runtime: factWordSchema.nullable().optional(),
  channel: factWordSchema.nullable().optional(),
  text: z.string().nullable().optional(),
  parentId: factTextSchema.nullable().optional(),
});

// ---------------------------------------------------------------------------
// The conversation item stream's body (protocol 16).
//
// Every member an item declares is `.nullable().optional()`, as the facts' are: a peer that omits one
// is read as not stating it, and an unknown key is carried. What these refuse is a member present with
// the wrong type, a count that is not a whole number, and an item past `MAX_AGENT_ITEM_BYTES`. Each
// count is spelled out as `<member>: z.number().int()` for the reason the facts' counts are.
// ---------------------------------------------------------------------------

/** The members every item carries, whatever its kind. */
const itemMembers = {
  itemId: factTextSchema.nullable().optional(),
  turnId: factTextSchema.nullable().optional(),
  truncated: z.boolean().nullable().optional(),
};

const itemTextSchema = z.string().nullable().optional();

const fileChangeEntrySchema = z.looseObject({
  path: factTextSchema.nullable().optional(),
  change: factWordSchema.nullable().optional(),
  movePath: factTextSchema.nullable().optional(),
  diff: z.string().nullable().optional(),
});

/** One schema per item kind this build models, each holding the members that kind declares. */
const ITEM_SCHEMAS: Readonly<Record<AgentItem['kind'], z.ZodType>> = {
  turn: z.looseObject({
    ...itemMembers,
    status: factWordSchema.nullable().optional(),
    detail: itemTextSchema,
  }),
  user_text: z.looseObject({ ...itemMembers, text: itemTextSchema }),
  agent_text: z.looseObject({
    ...itemMembers,
    text: itemTextSchema,
    final: z.boolean().nullable().optional(),
  }),
  thinking: z.looseObject({
    ...itemMembers,
    text: itemTextSchema,
    summary: z.boolean().nullable().optional(),
  }),
  tool_call: z.looseObject({
    ...itemMembers,
    toolUseId: factTextSchema.nullable().optional(),
    toolName: factTextSchema.nullable().optional(),
    toolKind: factWordSchema.nullable().optional(),
    input: jsonObjectSchema.nullable().optional(),
  }),
  tool_result: z.looseObject({
    ...itemMembers,
    toolUseId: factTextSchema.nullable().optional(),
    status: factWordSchema.nullable().optional(),
    output: itemTextSchema,
    exitCode: z.number().int().nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    changes: z.array(fileChangeEntrySchema).max(MAX_FACT_LIST_ENTRIES).nullable().optional(),
  }),
  plan: z.looseObject({ ...itemMembers, text: itemTextSchema }),
  notice: z.looseObject({
    ...itemMembers,
    level: factWordSchema.nullable().optional(),
    text: itemTextSchema,
  }),
};

/**
 * The `agent_item` body. `item` is required because it is what the body is. An item kind this build
 * does not model is carried with only its `kind` checked, and every item, of any kind, is held to the
 * item budget.
 */
const agentItemBodySchema = z.looseObject({
  update: z.literal('agent_item'),
  runtime: factWordSchema.nullable().optional(),
  item: z.looseObject({ kind: factKindSchema }),
  observedAt: z.string().min(1).nullable().optional(),
});

/** An `agent_message` body's one checked member: the runtime that emitted it. */
const agentMessageRuntimeSchema = z.looseObject({ runtime: factWordSchema.nullable().optional() });

type BodyCheckContext = Parameters<Parameters<typeof jsonObjectSchema.superRefine>[0]>[1];

/** Carries one schema's issues onto the body being refined, each under its own path. */
function carryIssues(
  result: { success: boolean; error?: { issues: readonly z.core.$ZodIssue[] } },
  prefix: readonly PropertyKey[],
  ctx: BodyCheckContext,
): void {
  if (result.success) return;
  for (const issue of result.error?.issues ?? []) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: [...prefix, ...issue.path] });
  }
}

/** A transition's `controlTier`, the one member of a transition the codec checks. */
const transitionControlTierSchema = controlTierSchema.nullable().optional();

/**
 * The checks a body earns by its `update`, for the bodies protocols 15 and 16 added shapes to. Every
 * other body is open JSON, exactly as before.
 */
function checkBody(body: JsonObject, lane: 'update' | 'delta', ctx: BodyCheckContext): void {
  const update = body['update'];
  if (update === 'agent_message') {
    carryIssues(agentMessageRuntimeSchema.safeParse(body), [], ctx);
    return;
  }
  if (lane === 'update' && update === 'state_transition') {
    // Only the tier protocol 15 added is checked; the rest of a transition stays unnarrowed.
    const transition = body['transition'];
    if (typeof transition !== 'object' || transition === null || Array.isArray(transition)) return;
    carryIssues(
      transitionControlTierSchema.safeParse(transition['controlTier']),
      ['transition', 'controlTier'],
      ctx,
    );
    return;
  }
  if (lane === 'update' && update === 'agent_facts') {
    const parsed = agentFactsBodySchema.safeParse(body);
    carryIssues(parsed, [], ctx);
    if (!parsed.success) return;
    const kind = parsed.data.fact.kind;
    const schema = (FACT_SCHEMAS as Partial<Record<string, z.ZodType>>)[kind];
    if (schema !== undefined) carryIssues(schema.safeParse(parsed.data.fact), ['fact'], ctx);
    return;
  }
  if (lane === 'update' && update === 'agent_item') {
    const parsed = agentItemBodySchema.safeParse(body);
    carryIssues(parsed, [], ctx);
    if (!parsed.success) return;
    const schema = (ITEM_SCHEMAS as Partial<Record<string, z.ZodType>>)[parsed.data.item.kind];
    if (schema !== undefined) carryIssues(schema.safeParse(parsed.data.item), ['item'], ctx);
    const byteCount = agentItemBytes(body['item']);
    if (byteCount > MAX_AGENT_ITEM_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `the item is ${byteCount} bytes as JSON, over the ${MAX_AGENT_ITEM_BYTES} an item takes`,
        path: ['item'],
      });
    }
    return;
  }
  if (lane === 'delta' && update === 'agent_fragment') {
    carryIssues(agentFragmentBodySchema.safeParse(body), [], ctx);
  }
}

const sessionUpdateBodySchema = jsonObjectSchema.superRefine((body, ctx) => checkBody(body, 'update', ctx));
const sessionDeltaBodySchema = jsonObjectSchema.superRefine((body, ctx) => checkBody(body, 'delta', ctx));

// `looseObject` throughout: unknown keys are carried, not stripped and not fatal.
/** The members of one release ask, shared by the single kind and the bulk entries. */
const workspaceReleaseEntryShape = {
  workspaceKey: z.string().min(1).nullable(),
  path: z.string().min(1).max(MAX_CONFIGURATION_VALUE_LENGTH).nullable(),
  deleteBranch: z.boolean(),
  force: z.boolean(),
};

/** The members of one release receipt, shared by the single result and the bulk entries. */
const workspaceReleaseEntryResultShape = {
  workspaceKey: z.string().nullable(),
  path: z.string().nullable(),
  directoryRemoved: z.boolean(),
  branchDeleted: z.boolean(),
  refusal: refusalSchema.nullable(),
};

const sessionPayloadSchema = z.discriminatedUnion('kind', [
  // The body is validated as JSON rather than against the transition's shape: this edge exists to
  // keep malformed bytes out, and a newer peer's richer body must survive the crossing rather than
  // be rejected here. The typed union is what a consumer reads it back as.
  //
  // The bodies protocols 15 and 16 added shapes to are checked for the members they declare, and only
  // those: an `agent_facts`, `agent_item` or `agent_fragment` body, an `agent_message`'s `runtime` and a
  // `state_transition`'s `controlTier` (`checkBody`). Every declared member is optional and every
  // unknown key is carried, so a richer body still crosses; the rest of a `state_transition`, a
  // `wire_refusal` and an `agent_message`'s `message` are not narrowed.
  z.looseObject({ kind: z.literal('session_update'), body: sessionUpdateBodySchema }),
  z.looseObject({ kind: z.literal('session_delta'), body: sessionDeltaBodySchema }),
  // Every added field is `.nullable()`, never `.optional()`, and that mirrors the type on purpose.
  // JSON has no `undefined`, so an optional field makes "the controller said nothing" and "the
  // controller said unset" the same value after a round trip, the distinction this whole file
  // exists to keep. `looseObject` still carries a newer peer's extra keys across intact.
  //
  // What is not in this schema matters as much: `sessionStore`, `sessionStoreFlush`, `spawn`,
  // `onStderr` and `hooks` have no member here and cannot acquire one, because none of them has a
  // JSON form.
  z.looseObject({
    kind: z.literal('session_new'),
    // Nullable like every other member; null is "the provider decides" (protocol v3). A controller
    // with no cwd to ask for (its host provisions worktrees) sends `null`, and a non-nullable field
    // here would lose the whole frame to a silent decode refusal.
    cwd: z.string().nullable(),
    // Required-and-nullable like every other member, and deliberately not `.default(null)`: a v4
    // frame omitting it must refuse, which is exactly what the v5 version bump announces. Null is
    // "use the session key"; see `SessionNew.workspaceKey` for what a non-null key means.
    workspaceKey: z.string().nullable(),
    correlationId: z.string().nullable(),
    gate: z
      .looseObject({
        decisionTimeoutMs: z.number().int().positive().nullable(),
        holdAfterMs: z.number().int().nonnegative().nullable(),
        matcherTimeoutSeconds: z.number().int().positive().nullable(),
      })
      .nullable(),
    request: z
      .looseObject({
        resume: z.string().min(1).nullable(),
        fork: z.boolean().nullable(),
        settingSources: z.array(z.string()).nullable(),
        plugins: z
          .array(
            z.looseObject({
              type: z.string().min(1),
              path: z.string().min(1),
              skipMcpDiscovery: z.boolean().nullable(),
            }),
          )
          .nullable(),
        // Opaque here and narrowed by the host: the server-config union belongs to the SDK, which
        // this file is structurally forbidden to reach. Keeping it a JSON object is what lets the
        // wire edge stay runtime-agnostic while the host still refuses a shape it cannot use.
        mcpServers: jsonObjectSchema.nullable(),
        strictMcpConfig: z.boolean().nullable(),
        includePartialMessages: z.boolean().nullable(),
        thinking: jsonObjectSchema.nullable(),
        // v6: a plain string each; the host narrows to the SDK's vocabulary and refuses by name.
        effort: z.string().min(1).nullable(),
        permissionMode: z.string().min(1).nullable(),
        forwardSubagentText: z.boolean().nullable(),
        env: z
          .looseObject({
            extraAllowedKeys: z.array(z.string()).nullable(),
            extraDeniedKeys: z.array(z.string()).nullable(),
            extraEnv: z.record(z.string(), z.string()).nullable(),
          })
          .nullable(),
        model: z.string().min(1).nullable(),
        // A string, a list of strings, or a preset object — all three are what the SDK accepts, so
        // the wire carries any JSON value and the host hands it straight through.
        systemPrompt: jsonValueSchema.nullable(),
        // Protocol 15, and optional: a controller one release behind omits it. A runtime's name is
        // a word; whether this host can spawn it is the host's question, answered by name.
        runtime: z.string().min(1).max(MAX_FACT_WORD_LENGTH).nullable().optional(),
        // Protocol 15, optional for the same reason. An endpoint's name is a word; whether this host's
        // operator declared it is the host's question, answered by name.
        endpoint: z.string().min(1).max(MAX_FACT_WORD_LENGTH).nullable().optional(),
      })
      .nullable(),
  }),
  z.looseObject({ kind: z.literal('session_prompt'), text: z.string() }),
  z.looseObject({ kind: z.literal('session_cancel') }),
  z.looseObject({ kind: z.literal('session_end') }),
  // v6: live model / permission mode / thinking. Every member nullable — null is "not asked".
  z.looseObject({
    kind: z.literal('session_configure'),
    model: z.string().min(1).nullable(),
    permissionMode: z.string().min(1).nullable(),
    thinking: jsonObjectSchema.nullable(),
    // Protocol 12, and optional: a controller one release behind omits it.
    effort: z.string().min(1).nullable().optional(),
  }),
  z.looseObject({
    kind: z.literal('bulk_request'),
    deliveryId: z.string().min(1),
    what: z.string(),
    fromOffset: z.number().int().nonnegative(),
    postUrl: z.string().min(1),
  }),
  z.looseObject({
    kind: z.literal('bulk_delivered'),
    deliveryId: z.string().min(1),
    byteCount: z.number().int().nonnegative(),
    // The stat pair for rewrite detection. `.nullable()` never `.optional()`, but absent is
    // also tolerated here (`.default(null)`), because a v3 peer's receipt legitimately omits keys
    // it has never heard of, and destroying a delivery receipt over two unknowns would repeat the
    // exact failure the refusal-reason tolerance above exists to prevent.
    sizeBytes: z.number().int().nonnegative().nullable().default(null),
    mtimeMs: z.number().int().nonnegative().nullable().default(null),
  }),
  z.looseObject({
    kind: z.literal('bulk_failed'),
    deliveryId: z.string().min(1),
    refusal: refusalSchema,
  }),
  // Discovery. Every added optional is `.nullable()`, never `.optional()`, per the rule above.
  z.looseObject({
    kind: z.literal('session_list'),
    requestId: z.string().min(1),
  }),
  z.looseObject({
    kind: z.literal('session_list_result'),
    requestId: z.string().min(1),
    sessions: z.array(
      z.looseObject({
        sessionKey: z.string().min(1),
        sessionId: z.string().nullable(),
        state: z.string().min(1),
        cwd: z.string().nullable(),
        startedAt: z.string().nullable(),
      }),
    ),
    liveCount: z.number().int().nonnegative(),
    provisioningCount: z.number().int().nonnegative(),
  }),
  z.looseObject({
    kind: z.literal('transcript_list'),
    requestId: z.string().min(1),
    fromIndex: z.number().int().nonnegative(),
  }),
  z.looseObject({
    kind: z.literal('transcript_list_result'),
    requestId: z.string().min(1),
    entries: z.array(
      z.looseObject({
        projectSlug: z.string().min(1),
        sessionId: z.string().min(1),
        sizeBytes: z.number().int().nonnegative(),
        mtimeMs: z.number().int().nonnegative(),
        cwd: z.string().nullable().default(null),
      }),
    ),
    totalCount: z.number().int().nonnegative(),
    nextIndex: z.number().int().nonnegative().nullable(),
  }),
  z.looseObject({
    kind: z.literal('transcript_tail'),
    requestId: z.string().min(1),
    projectSlug: z.string().min(1),
    sessionId: z.string().min(1),
    fromOffset: z.number().int().nonnegative(),
    needle: z.string().nullable(),
  }),
  z.looseObject({
    kind: z.literal('transcript_tail_result'),
    requestId: z.string().min(1),
    found: z.boolean(),
    absent: z.boolean(),
    newOffset: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    mtimeMs: z.number().int().nonnegative().nullable(),
  }),
  z.looseObject({
    kind: z.literal('transcript_failed'),
    requestId: z.string().min(1),
    refusal: refusalSchema,
  }),
  // The answer that could not be sent (v10): one kind for every host-scoped ask, matched on the
  // request id. Always small, so it is the one answer the frame cap cannot refuse.
  z.looseObject({
    kind: z.literal('answer_refused'),
    requestId: z.string().min(1),
    refusal: refusalSchema,
  }),
  // The reap (v5; the flags, the path address and the receipt from v7). Host-scoped like the
  // discovery asks; the result's `refusal` is nullable because null is the released answer: one
  // kind for every exit, see `WorkspaceReleaseResult`. Key-or-path is the HOST's screen, not the
  // codec's: both or neither is a well-formed frame refused by name, never a malformed one.
  z.looseObject({
    kind: z.literal('workspace_release'),
    requestId: z.string().min(1),
    ...workspaceReleaseEntryShape,
  }),
  z.looseObject({
    kind: z.literal('workspace_release_result'),
    requestId: z.string().min(1),
    ...workspaceReleaseEntryResultShape,
  }),
  z.looseObject({
    kind: z.literal('workspace_release_bulk'),
    requestId: z.string().min(1),
    releases: z.array(z.looseObject(workspaceReleaseEntryShape)).min(1).max(MAX_BULK_RELEASES),
  }),
  z.looseObject({
    kind: z.literal('workspace_release_bulk_result'),
    requestId: z.string().min(1),
    results: z.array(z.looseObject(workspaceReleaseEntryResultShape)).max(MAX_BULK_RELEASES),
  }),
  // The configure pair. Host-scoped like the reap; the result's `refusal` is nullable because
  // null is the applied answer, and the effective configuration rides every exit.
  z.looseObject({
    kind: z.literal('host_configure'),
    requestId: z.string().min(1),
    entries: z
      .array(z.looseObject({ key: z.string().min(1).max(64), value: configurationValueSchema }))
      .min(1)
      .max(MAX_CONFIGURE_ENTRIES),
  }),
  z.looseObject({
    kind: z.literal('host_configure_result'),
    requestId: z.string().min(1),
    configuration: hostConfigurationSchema,
    overriddenByEnvironment: z.array(z.string()),
    pendingRestart: pendingRestartSchema,
    refusal: refusalSchema.nullable(),
  }),
  // The inventory. Host-scoped and paged like `transcript_list`; the result carries the
  // refusal so every exit is one kind.
  z.looseObject({
    kind: z.literal('workspace_list'),
    requestId: z.string().min(1),
    fromIndex: z.number().int().nonnegative(),
  }),
  z.looseObject({
    kind: z.literal('workspace_list_result'),
    requestId: z.string().min(1),
    entries: z.array(
      z.looseObject({
        key: z.string().min(1).max(MAX_WORKSPACE_ID_LENGTH),
        path: z.string().min(1).max(MAX_CONFIGURATION_VALUE_LENGTH),
        branch: z.string().max(400).nullable(),
        head: z.string().max(64).nullable(),
        detached: z.boolean(),
        locked: z.boolean(),
        prunable: z.boolean(),
        merged: z.boolean().nullable(),
        aheadCount: z.number().int().nonnegative().nullable(),
        lastCommitAt: z.string().nullable(),
      }),
    ),
    totalCount: z.number().int().nonnegative(),
    nextIndex: z.number().int().nonnegative().nullable(),
    defaultBranch: z.string().max(400).nullable(),
    refusal: refusalSchema.nullable(),
  }),
  // The repository read. Host-scoped like `transcript_list`; both results carry the refusal so
  // every exit is one kind. The path is relative text the HOST jails; the codec bounds its length.
  z.looseObject({
    kind: z.literal('repository_list'),
    requestId: z.string().min(1),
    path: z.string().max(MAX_CONFIGURATION_VALUE_LENGTH),
  }),
  z.looseObject({
    kind: z.literal('repository_list_result'),
    requestId: z.string().min(1),
    entries: z
      .array(
        z.looseObject({
          name: z.string().min(1).max(255),
          directory: z.boolean(),
          sizeBytes: z.number().int().nonnegative(),
          mtimeMs: z.number().int().nonnegative(),
        }),
      )
      .max(MAX_REPOSITORY_ENTRIES),
    truncated: z.boolean(),
    refusal: refusalSchema.nullable(),
  }),
  z.looseObject({
    kind: z.literal('repository_read'),
    requestId: z.string().min(1),
    path: z.string().min(1).max(MAX_CONFIGURATION_VALUE_LENGTH),
    maxBytes: z.number().int().min(1).max(MAX_REPOSITORY_READ_BYTES),
  }),
  z.looseObject({
    kind: z.literal('repository_read_result'),
    requestId: z.string().min(1),
    text: z.string().nullable(),
    sizeBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    refusal: refusalSchema.nullable(),
  }),
  z.looseObject({
    kind: z.literal('workspace_read'),
    requestId: z.string().min(1),
    workspaceKey: z.string().min(1),
    path: z.string().min(1).max(MAX_CONFIGURATION_VALUE_LENGTH),
    offset: z.number().int().min(0).max(MAX_WORKSPACE_FILE_BYTES),
    maxBytes: z.number().int().min(1).max(MAX_WORKSPACE_READ_BYTES),
  }),
  z.looseObject({
    kind: z.literal('workspace_read_result'),
    requestId: z.string().min(1),
    text: z.string().nullable(),
    sizeBytes: z.number().int().nonnegative(),
    nextOffset: z.number().int().positive().nullable(),
    refusal: refusalSchema.nullable(),
  }),
]);

const controlPayloadSchema = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('link_hello'),
    protocolVersion: z.number().int(),
    hostId: z.string().min(1),
    capabilities: z.array(z.string()),
    cursors: z.array(sessionCursorSchema),
    configuration: hostConfigurationSchema,
    pendingRestart: pendingRestartSchema,
    protocolRange: protocolRangeSchema,
  }),
  z.looseObject({
    kind: z.literal('link_welcome'),
    protocolVersion: z.number().int(),
    // Absent from a version-9 controller; read as null, never refused (v10).
    protocolRange: protocolRangeSchema.nullable().default(null),
    capabilities: z.array(z.string()),
    cursors: z.array(sessionCursorSchema),
  }),
  z.looseObject({ kind: z.literal('link_ack'), cursors: z.array(sessionCursorSchema) }),
  z.looseObject({ kind: z.literal('link_ping'), nonce: z.string() }),
  z.looseObject({ kind: z.literal('link_pong'), nonce: z.string() }),
  z.looseObject({ kind: z.literal('link_bye'), cause: z.string() }),
]);

const frameSchema = z.discriminatedUnion('frame', [
  z.looseObject({
    frame: z.literal('session'),
    sessionId: z.string().min(1),
    // Dense from 1. Zero would make "no frames yet" and "the first frame" the same value.
    seq: z.number().int().positive(),
    at: z.string().min(1),
    payload: sessionPayloadSchema,
  }),
  z.looseObject({
    frame: z.literal('control'),
    at: z.string().min(1),
    payload: controlPayloadSchema,
  }),
]);

/**
 * A frame to a wire string.
 *
 * Refuses a frame that does not match the shape `decode` accepts, with the same per-kind schema, so
 * a malformed frame is refused at the caller and never minted a sequence number; a frame that only
 * the peer refused would burn a number the receiver then waits on. Refuses anything past
 * MAX_FRAME_BYTES, naming the bulk lane — this is the enforcement point for "commands only, never
 * payloads", so the check is here rather than at each call site that might forget it.
 */
export function encode(frame: Frame): Result<string> {
  // The producer-closed half, enforced here rather than by a type. `refusal()` takes a
  // `RefusalReason`, which is a compile-time guarantee a single `as` defeats. This is the one
  // place a frame becomes bytes, so checking here makes "nothing this host emits carries an
  // undeclared reason" true by construction. Two mechanisms, one invariant.
  const undeclared = undeclaredRefusalReason(frame);
  if (undeclared !== null) {
    return refuse(
      'frame-malformed',
      `refusal reason "${undeclared}" is not one this host declares — the wire tolerates an ` +
        `unknown reason on the way IN, but this host may not invent one on the way OUT; add it to ` +
        `REFUSAL_REASONS`,
    );
  }

  // The same pair for the fact layer's and the item stream's vocabularies, the control tier's levels,
  // the endpoints' wire APIs and the runtimes' skill words: a newer peer's word is read on the way in,
  // and this host may send only the words it declares.
  const undeclaredWord =
    undeclaredFactWord(frame) ??
    undeclaredItemWord(frame) ??
    undeclaredTierLevel(frame) ??
    undeclaredWireApi(frame) ??
    undeclaredSkillWord(frame);
  if (undeclaredWord !== null) {
    return refuse(
      'frame-malformed',
      `${undeclaredWord.member} "${undeclaredWord.value}" is not a word this host declares — the wire ` +
        `reads an unknown word on the way IN, but this host may not send one on the way OUT`,
    );
  }

  const shape = frameSchema.safeParse(frame);
  if (!shape.success) {
    return refuse(
      'frame-malformed',
      `frame does not match its declared shape: ${shape.error.issues.map(describeIssue).join('; ')}`,
    );
  }

  let text: string;
  try {
    text = JSON.stringify(frame);
  } catch (error) {
    return refuse('frame-malformed', `frame is not serializable: ${describe(error)}`);
  }

  const byteCount = utf8ByteLength(text);
  if (byteCount > MAX_FRAME_BYTES) {
    return refuse(
      'frame-too-large',
      `frame is ${byteCount} bytes, over the ${MAX_FRAME_BYTES} limit — bulk content does not ride ` +
        `the link; request it with bulk_request and answer on the bulk-post lane`,
    );
  }

  return ok(text);
}

/** A wire string to a frame. Never throws: every failure path returns a named refusal. */
export function decode(raw: string): Result<Frame> {
  const byteCount = utf8ByteLength(raw);
  if (byteCount > MAX_FRAME_BYTES) {
    return refuse(
      'frame-too-large',
      `received ${byteCount} bytes, over the ${MAX_FRAME_BYTES} limit — bulk content does not ride ` +
        `the link; request it with bulk_request and answer on the bulk-post lane`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return refuse('frame-not-json', `not JSON: ${describe(error)}`);
  }

  const result = frameSchema.safeParse(parsed);
  if (!result.success) {
    return refuse('frame-malformed', result.error.issues.map(describeIssue).join('; '));
  }

  return ok(result.data as Frame);
}

/**
 * Why a catalog cannot ride the hello, or null when it can: first the schema a controller decodes
 * it with, then the byte budget that keeps the hello under the frame cap. A host runs this before it
 * puts a catalog in its configuration, so what it sends and what a controller accepts cannot differ.
 */
export function hostAgentProblem(agent: HostAgent): string | null {
  const shape = hostAgentSchema.safeParse(agent);
  if (!shape.success) return shape.error.issues.map(describeIssue).join('; ');
  const byteCount = utf8ByteLength(JSON.stringify(agent));
  if (byteCount > MAX_AGENT_CATALOG_BYTES) {
    return `the catalog is ${byteCount} bytes as JSON, over the ${MAX_AGENT_CATALOG_BYTES} a hello gives it`;
  }
  return null;
}

/**
 * Why a hello's `agents` list cannot ride, or null when it can: the schema a controller decodes it
 * with, the tier levels this host may send, and the byte budget the catalog has, for the whole list.
 * A host runs this before it puts the list in its configuration, beside `hostAgentProblem`.
 */
export function hostAgentsProblem(agents: readonly HostAgentEntry[]): string | null {
  const shape = hostAgentsSchema.safeParse(agents);
  if (!shape.success) return shape.error.issues.map(describeIssue).join('; ');
  const undeclared = undeclaredEntryLevel(agents);
  if (undeclared !== null)
    return `${undeclared.member} "${undeclared.value}" is not a level this host declares`;
  const byteCount = utf8ByteLength(JSON.stringify(agents));
  if (byteCount > MAX_AGENT_CATALOG_BYTES) {
    return `the runtimes list is ${byteCount} bytes as JSON, over the ${MAX_AGENT_CATALOG_BYTES} a hello gives it`;
  }
  return null;
}

/**
 * Why a hello's `endpoints` list cannot ride, or null when it can: the schema a controller decodes it
 * with, the wire APIs this host may send, and the endpoints' own byte budget. The list is the
 * operator's configuration, so a host runs this before it starts and refuses a list that fails.
 */
export function hostEndpointsProblem(endpoints: readonly HostEndpoint[]): string | null {
  const shape = hostEndpointsSchema.safeParse(endpoints);
  if (!shape.success) return shape.error.issues.map(describeIssue).join('; ');
  const undeclared = undeclaredEndpointApi(endpoints);
  if (undeclared !== null)
    return `${undeclared.member} "${undeclared.value}" is not a wire API this host declares`;
  const byteCount = utf8ByteLength(JSON.stringify(endpoints));
  if (byteCount > MAX_ENDPOINT_CATALOG_BYTES) {
    return `the endpoints list is ${byteCount} bytes as JSON, over the ${MAX_ENDPOINT_CATALOG_BYTES} a hello gives it`;
  }
  return null;
}

/**
 * The reason on an outgoing refusal-carrying payload when this host does not declare it, else null.
 * Covers every kind that carries one: `bulk_failed`, `transcript_failed`, the result kinds whose
 * `refusal` is non-null, every entry of a bulk release answer, and the `wire_refusal` member of a
 * `session_update` body (opaque JSON to the schema, so it is read here by hand) — so no door can
 * invent a word on the way out.
 */
function undeclaredRefusalReason(frame: Frame): string | null {
  if (frame.frame !== 'session') return null;
  const payload = frame.payload;
  let carried: readonly (WireRefusal | null)[];
  if (payload.kind === 'session_update') {
    const body = payload.body as { update?: unknown; refusal?: unknown };
    if (body.update !== 'wire_refusal' || typeof body.refusal !== 'object' || body.refusal === null)
      return null;
    const reason = (body.refusal as { reason?: unknown }).reason;
    return typeof reason === 'string' && !isRefusalReason(reason) ? reason : null;
  }
  switch (payload.kind) {
    case 'bulk_failed':
    case 'transcript_failed':
    case 'workspace_release_result':
    case 'host_configure_result':
    case 'workspace_list_result':
    case 'repository_list_result':
    case 'repository_read_result':
    case 'workspace_read_result':
      carried = [payload.refusal];
      break;
    case 'workspace_release_bulk_result':
      carried = payload.results.map((result) => result.refusal);
      break;
    default:
      return null;
  }
  for (const refusal of carried) {
    if (refusal !== null && !isRefusalReason(refusal.reason)) return refusal.reason;
  }
  return null;
}

/** A vocabulary member holding a word outside its declared set: which member, and the word. */
interface UndeclaredWord {
  readonly member: string;
  readonly value: string;
}

/** The fact kinds this host declares, for the outgoing check. */
const DECLARED_FACT_KINDS: readonly string[] = Object.keys(FACT_SCHEMAS);

/**
 * The first fact-layer word on an outgoing frame that this host does not declare, else null: a fact
 * kind, a cost basis (on a figure or on any of its rows), a turn scope, a receipt source, a cache
 * lifetime, a compaction status or trigger, or a fragment channel. Null and absent are not words.
 */
function undeclaredFactWord(frame: Frame): UndeclaredWord | null {
  if (frame.frame !== 'session') return null;
  const payload = frame.payload;
  if (payload.kind !== 'session_update' && payload.kind !== 'session_delta') return null;
  const body = payload.body as Record<string, unknown>;

  if (payload.kind === 'session_delta') {
    if (body['update'] !== 'agent_fragment') return null;
    return wordOutside('channel', body['channel'], FRAGMENT_CHANNELS);
  }
  if (body['update'] !== 'agent_facts') return null;

  const fact = body['fact'];
  if (typeof fact !== 'object' || fact === null) return null;
  const members = fact as Record<string, unknown>;
  const kind = wordOutside('fact.kind', members['kind'], DECLARED_FACT_KINDS);
  if (kind !== null) return kind;

  switch (members['kind']) {
    case 'agent_receipt':
      return wordOutside('fact.source', members['source'], RECEIPT_SOURCES);
    case 'turn_record':
      return (
        wordOutside('fact.turnScope', members['turnScope'], TURN_SCOPES) ??
        undeclaredBasis('fact.totals', members['totals']) ??
        undeclaredBasis('fact.turn', members['turn'])
      );
    case 'usage_sample':
      return wordOutside('fact.cacheTtl', members['cacheTtl'], CACHE_TTLS);
    case 'tasks':
      return undeclaredInList('fact.settled', members['settled'], 'status', TASK_SETTLEMENTS);
    case 'compaction':
      return (
        wordOutside('fact.status', members['status'], COMPACTION_STATUSES) ??
        wordOutside('fact.trigger', members['trigger'], COMPACTION_TRIGGERS)
      );
    default:
      return null;
  }
}

/** The item kinds this host declares, for the outgoing check. */
const DECLARED_ITEM_KINDS: readonly string[] = Object.keys(ITEM_SCHEMAS);

/**
 * The first item-stream word on an outgoing frame that this host does not declare, else null: an item
 * kind, a turn's status, a tool call's kind, a tool result's status or a change's kind, or a notice's
 * level. Null and absent are not words.
 */
function undeclaredItemWord(frame: Frame): UndeclaredWord | null {
  if (frame.frame !== 'session' || frame.payload.kind !== 'session_update') return null;
  const body = frame.payload.body as Record<string, unknown>;
  if (body['update'] !== 'agent_item') return null;
  const item = body['item'];
  if (typeof item !== 'object' || item === null) return null;
  const members = item as Record<string, unknown>;
  const kind = wordOutside('item.kind', members['kind'], DECLARED_ITEM_KINDS);
  if (kind !== null) return kind;

  switch (members['kind']) {
    case 'turn':
      return wordOutside('item.status', members['status'], TURN_ITEM_STATUSES);
    case 'tool_call':
      return wordOutside('item.toolKind', members['toolKind'], TOOL_KINDS);
    case 'tool_result':
      return (
        wordOutside('item.status', members['status'], TOOL_RESULT_STATUSES) ??
        undeclaredInList('item.changes', members['changes'], 'change', FILE_CHANGE_KINDS)
      );
    case 'notice':
      return wordOutside('item.level', members['level'], NOTICE_LEVELS);
    default:
      return null;
  }
}

/** The first undeclared word among one member of a list's entries, else null. */
function undeclaredInList(
  member: string,
  list: unknown,
  key: string,
  declared: readonly string[],
): UndeclaredWord | null {
  if (!Array.isArray(list)) return null;
  for (const [index, entry] of (list as readonly unknown[]).entries()) {
    const value = (entry as Record<string, unknown> | null)?.[key];
    const undeclared = wordOutside(`${member}.${index}.${key}`, value, declared);
    if (undeclared !== null) return undeclared;
  }
  return null;
}

/** The first skill naming or delivery word on an outgoing hello's or configure answer's `agentSkills` this host does not declare, else null. */
function undeclaredSkillWord(frame: Frame): UndeclaredWord | null {
  let skills: readonly HostAgentSkills[] | null | undefined;
  if (frame.frame === 'control') {
    if (frame.payload.kind !== 'link_hello') return null;
    skills = frame.payload.configuration.agentSkills;
  } else {
    if (frame.payload.kind !== 'host_configure_result') return null;
    skills = frame.payload.configuration.agentSkills;
  }
  return (
    undeclaredInList('agentSkills', skills, 'naming', SKILL_NAMINGS) ??
    undeclaredInList('agentSkills', skills, 'delivery', SKILL_DELIVERIES)
  );
}

/**
 * The first control-tier level on an outgoing frame that this host does not declare, else null: on a
 * transition's `controlTier`, and on each `agents` entry of a hello or a configure answer.
 */
function undeclaredTierLevel(frame: Frame): UndeclaredWord | null {
  if (frame.frame === 'control') {
    return frame.payload.kind === 'link_hello'
      ? undeclaredEntryLevel(frame.payload.configuration.agents)
      : null;
  }
  const payload = frame.payload;
  if (payload.kind === 'host_configure_result') return undeclaredEntryLevel(payload.configuration.agents);
  if (payload.kind !== 'session_update') return null;
  const body = payload.body as Record<string, unknown>;
  if (body['update'] !== 'state_transition') return null;
  const transition = body['transition'];
  if (typeof transition !== 'object' || transition === null) return null;
  const tier = (transition as { controlTier?: unknown }).controlTier;
  if (typeof tier !== 'object' || tier === null) return null;
  return wordOutside(
    'transition.controlTier.level',
    (tier as { level?: unknown }).level,
    CONTROL_TIER_LEVELS,
  );
}

/** The first undeclared tier level among a configuration's runtime entries, else null. */
function undeclaredEntryLevel(agents: readonly HostAgentEntry[] | null | undefined): UndeclaredWord | null {
  if (!Array.isArray(agents)) return null;
  for (const [index, entry] of (agents as readonly unknown[]).entries()) {
    const tier = (entry as { controlTier?: unknown } | null)?.controlTier;
    if (typeof tier !== 'object' || tier === null) continue;
    const level = (tier as { level?: unknown }).level;
    const undeclared = wordOutside(`agents.${index}.controlTier.level`, level, CONTROL_TIER_LEVELS);
    if (undeclared !== null) return undeclared;
  }
  return null;
}

/** The first wire API on an outgoing hello's or configure answer's endpoints that this host does not declare, else null. */
function undeclaredWireApi(frame: Frame): UndeclaredWord | null {
  if (frame.frame === 'control') {
    return frame.payload.kind === 'link_hello'
      ? undeclaredEndpointApi(frame.payload.configuration.endpoints)
      : null;
  }
  const payload = frame.payload;
  return payload.kind === 'host_configure_result'
    ? undeclaredEndpointApi(payload.configuration.endpoints)
    : null;
}

/** The first undeclared wire API among a configuration's endpoints, else null. */
function undeclaredEndpointApi(endpoints: readonly HostEndpoint[] | null | undefined): UndeclaredWord | null {
  if (!Array.isArray(endpoints)) return null;
  for (const [index, entry] of (endpoints as readonly unknown[]).entries()) {
    const api = (entry as { wireApi?: unknown } | null)?.wireApi;
    const undeclared = wordOutside(`endpoints.${index}.wireApi`, api, ENDPOINT_WIRE_APIS);
    if (undeclared !== null) return undeclared;
  }
  return null;
}

/** The undeclared cost basis on one spend figure or any of its rows, else null. */
function undeclaredBasis(member: string, figure: unknown): UndeclaredWord | null {
  if (typeof figure !== 'object' || figure === null) return null;
  const spend = figure as { costBasis?: unknown; byModel?: unknown };
  const own = wordOutside(`${member}.costBasis`, spend.costBasis, COST_BASES);
  if (own !== null) return own;
  if (!Array.isArray(spend.byModel)) return null;
  for (const [index, row] of spend.byModel.entries()) {
    const basis = (row as { costBasis?: unknown } | null)?.costBasis;
    const undeclared = wordOutside(`${member}.byModel.${index}.costBasis`, basis, COST_BASES);
    if (undeclared !== null) return undeclared;
  }
  return null;
}

/** A word present and outside `declared`, else null. */
function wordOutside(member: string, value: unknown, declared: readonly string[]): UndeclaredWord | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && declared.includes(value)) return null;
  return { member, value: typeof value === 'string' ? value : JSON.stringify(value) };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
