/**
 * The window's promise, checked against the peer it is made to: a controller on protocol 16 reads
 * everything this host sends it, and this host reads everything that controller sends.
 *
 * `V16` below is that controller's decoder: the protocol-16 schemas transcribed from the codec the
 * v1.7.0 tag ships (`git show v1.7.0:src/control/codec.ts`), cut to the kinds this file reads, with
 * that release's bounds written as numbers. It describes a released peer, so it never changes to
 * follow this build; an edit here that turns a test green changes the contract rather than fixing
 * it. The frames it reads are the bytes a real link carried, from a host the peer welcomed at 16.
 * Protocol 17 adds what such a controller receives inside members it already reads: `qwen-code` and
 * `pi` in the hello's runtimes list and their rows in the pack list, their sessions' own messages and
 * fragments with `runtime: "qwen-code"` or `runtime: "pi"`, transitions caused by their events, and six
 * reasons: two open refusals and four degrades, two of which ride a first `ready`'s control tier. So
 * what is read here is a Claude session's traffic, a Codex session's, a Qwen Code session's and a pi
 * session's, side by side on one link, and each word protocol 17 adds is shown read by that decoder
 * (the vectors it adds, below).
 * One word is not: the decision request's `shellDialect` gains `cmd`, which that release's
 * `DecisionRequest` (`V16_DECISION_REQUEST`) does not declare, so a request naming it is sent to a
 * controller at 16 with no dialect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { decode } from '../control/codec.js';
import type { HostAgent, JsonObject, JsonValue, SessionConfigure, SessionNew } from '../control/frames.js';
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MIN,
  hostConfigure,
  readObservedAt,
  readStateTransition,
  sessionNew,
  sessionNewRequest,
  unsetHostConfiguration,
} from '../control/frames.js';
import type { DecisionRequest } from '../gate/decision.js';
import { SessionRegistry } from '../sessions/registry.js';
import { fakeAgents, initMessage } from '../test-support/fake-agent.js';
import { FAKE_MODELS, fakeCodex } from '../test-support/fake-codex.js';
import { fakePi } from '../test-support/fake-pi.js';
import { fakeQwen } from '../test-support/fake-qwen.js';
import { tempDir } from '../test-support/temp-dir.js';
import { peerOn, waitFor } from '../test-support/ws-peer.js';
import type { HookInput, SDKMessage } from './agent-process.js';
import { availableCodexEntry, codexHostModel, codexNativeRuntime } from './codex-runtime.js';
import { PeriscopeHost, decideAtLinkVersion } from './host.js';
import type { ModelEndpoint } from './model-endpoints.js';
import type { PiRuntimeConfig } from './pi-process.js';
import { availablePiEntry, piNativeRuntime } from './pi-runtime.js';
import { availableQwenEntry, qwenNativeRuntime } from './qwen-runtime.js';
import type { QwenRuntimeConfig } from './qwen-process.js';
import { QWEN_NAMES } from './qwen-names.js';
import { readSessionConfigure } from './wire-request.js';

// ---------------------------------------------------------------------------
// The protocol-16 decoder, as v1.7.0 shipped it.
// ---------------------------------------------------------------------------

const V16_MAX_CONFIGURATION_VALUE_LENGTH = 1000;
const V16_MAX_PLUGIN_DIRS = 8;
const V16_MAX_CONFIGURE_ENTRIES = 8;
const V16_MAX_AGENT_MODELS = 32;
const V16_MAX_AGENT_ENTRIES = 8;
const V16_MAX_ENDPOINTS = 8;
const V16_MAX_ENDPOINT_MODELS = 32;
const V16_MAX_FACT_LIST_ENTRIES = 256;
const V16_MAX_FACT_TEXT_LENGTH = 1000;
const V16_MAX_FACT_WORD_LENGTH = 64;
const V16_MAX_AGENT_ITEM_BYTES = 32 * 1024;
const V16_TOOL_KINDS = ['shell', 'file_read', 'file_write', 'file_edit', 'mcp', 'web', 'other'] as const;
const V16_SHELL_DIALECTS = ['posix', 'powershell'] as const;

const v16JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(v16JsonValue),
    z.record(z.string(), v16JsonValue),
  ]),
);
const v16JsonObject = z.record(z.string(), v16JsonValue);
const v16Refusal = z.looseObject({ reason: z.string().min(1), detail: z.string() });
const v16SessionCursor = z.looseObject({ sessionId: z.string().min(1), seq: z.number().int().nonnegative() });
const v16ConfigurationValue = z.string().max(V16_MAX_CONFIGURATION_VALUE_LENGTH).nullable();
const v16HostPlugin = z.looseObject({
  name: z.string().min(1).max(200),
  version: z.string().max(64).nullable(),
  path: z.string().min(1).max(V16_MAX_CONFIGURATION_VALUE_LENGTH),
});
const v16AgentModelText = z.string().min(1).max(200);
const v16HostModel = z.looseObject({
  value: v16AgentModelText,
  resolvedModel: v16AgentModelText.nullable(),
  displayName: z.string().max(200),
  description: z.string().max(V16_MAX_CONFIGURATION_VALUE_LENGTH).nullable(),
  supportedEffortLevels: z.array(z.string().min(1).max(32)).max(16),
  supportsFastMode: z.boolean().nullable(),
  supportsAutoMode: z.boolean().nullable(),
  supportsAdaptiveThinking: z.boolean().nullable(),
});
const v16HostAgent = z.looseObject({
  claudeCodeVersion: z.string().min(1).max(64),
  sdkVersion: z.string().min(1).max(64),
  models: z.array(v16HostModel).max(V16_MAX_AGENT_MODELS),
});
const v16ControlTier = z.looseObject({
  level: z.string().min(1).max(V16_MAX_FACT_WORD_LENGTH),
  degrades: z.array(z.string().min(1).max(V16_MAX_FACT_WORD_LENGTH)).max(V16_MAX_FACT_LIST_ENTRIES),
});
const v16VocabularyWords = z.array(z.string().min(1).max(32)).max(16);
const v16HostAgentEntry = z.looseObject({
  runtime: z.string().min(1).max(V16_MAX_FACT_WORD_LENGTH),
  version: z.string().min(1).max(64),
  sdkVersion: z.string().min(1).max(64).nullable(),
  models: z.array(v16HostModel).max(V16_MAX_AGENT_MODELS),
  vocabularies: z.looseObject({
    permissionModes: v16VocabularyWords,
    efforts: v16VocabularyWords,
    thinking: z.boolean(),
  }),
  controlTier: v16ControlTier,
  available: z.boolean(),
  unavailableReason: z.string().max(V16_MAX_CONFIGURATION_VALUE_LENGTH).nullable(),
});
const v16HostEndpoint = z.looseObject({
  name: z.string().min(1).max(V16_MAX_FACT_WORD_LENGTH),
  wireApi: z.string().min(1).max(V16_MAX_FACT_WORD_LENGTH),
  runtimes: z.array(z.string().min(1).max(V16_MAX_FACT_WORD_LENGTH)).max(V16_MAX_AGENT_ENTRIES),
  models: z.array(v16AgentModelText).max(V16_MAX_ENDPOINT_MODELS).nullable(),
});
const v16HostAgentSkills = z.looseObject({
  runtime: z.string().min(1).max(V16_MAX_FACT_WORD_LENGTH),
  naming: z.string().min(1).max(V16_MAX_FACT_WORD_LENGTH),
  delivery: z.string().min(1).max(V16_MAX_FACT_WORD_LENGTH),
});
const v16HostConfiguration = z.looseObject({
  repositoryRoot: v16ConfigurationValue,
  workspaceRoot: v16ConfigurationValue,
  branchScheme: v16ConfigurationValue,
  transcriptsRoot: v16ConfigurationValue,
  controllerUrl: v16ConfigurationValue,
  decisionUrl: v16ConfigurationValue,
  agentHome: v16ConfigurationValue,
  plugins: z.array(v16HostPlugin).max(V16_MAX_PLUGIN_DIRS),
  agent: v16HostAgent.nullable().optional(),
  agents: z.array(v16HostAgentEntry).max(V16_MAX_AGENT_ENTRIES).nullable().optional(),
  endpoints: z.array(v16HostEndpoint).max(V16_MAX_ENDPOINTS).nullable().optional(),
  agentSkills: z.array(v16HostAgentSkills).max(V16_MAX_AGENT_ENTRIES).nullable().optional(),
});
const v16PendingRestart = z.array(z.string().min(1).max(64)).max(V16_MAX_CONFIGURE_ENTRIES);
const v16ProtocolRange = z.looseObject({ min: z.number().int().min(1), max: z.number().int().min(1) });

// The fact layer's bodies, every declared member nullable and optional, every unknown key carried.
const v16FactWord = z.string().max(V16_MAX_FACT_WORD_LENGTH);
const v16FactText = z.string().max(V16_MAX_FACT_TEXT_LENGTH);
const v16Count = z.number().int().nonnegative().nullable().optional();
const v16FactList = <T extends z.ZodType>(entry: T) =>
  z.array(entry).max(V16_MAX_FACT_LIST_ENTRIES).nullable().optional();
const v16ModelSpend = z.looseObject({
  model: v16FactText.nullable().optional(),
  canonicalModel: v16FactText.nullable().optional(),
  provider: v16FactWord.nullable().optional(),
  inputTokens: v16Count,
  outputTokens: v16Count,
  cacheReadTokens: v16Count,
  cacheWriteTokens: v16Count,
  reasoningTokens: v16Count,
  cost: z.number().nonnegative().nullable().optional(),
  costBasis: v16FactWord.nullable().optional(),
  contextWindow: v16Count,
});
const v16Spend = z.looseObject({
  cost: z.number().nonnegative().nullable().optional(),
  currency: v16FactWord.nullable().optional(),
  costBasis: v16FactWord.nullable().optional(),
  byModel: v16FactList(v16ModelSpend),
});
const V16_FACTS: Readonly<Record<string, z.ZodType>> = {
  session_handle: z.looseObject({
    runtime: v16FactWord.nullable().optional(),
    handle: v16FactText.nullable().optional(),
  }),
  agent_receipt: z.looseObject({
    runtime: v16FactWord.nullable().optional(),
    runtimeVersion: v16FactWord.nullable().optional(),
    model: v16FactText.nullable().optional(),
    permissionMode: v16FactWord.nullable().optional(),
    effort: v16FactWord.nullable().optional(),
    skills: v16FactList(v16FactText),
    plugins: v16FactList(
      z.looseObject({
        name: v16FactText.nullable().optional(),
        version: v16FactWord.nullable().optional(),
        path: v16FactText.nullable().optional(),
      }),
    ),
    pluginErrors: v16FactList(
      z.looseObject({
        plugin: v16FactText.nullable().optional(),
        type: v16FactWord.nullable().optional(),
        message: v16FactText.nullable().optional(),
        path: v16FactText.nullable().optional(),
      }),
    ),
    mcpServers: v16FactList(
      z.looseObject({ name: v16FactText.nullable().optional(), status: v16FactWord.nullable().optional() }),
    ),
    source: v16FactWord.nullable().optional(),
    effortReported: z.boolean().nullable().optional(),
  }),
  turn_record: z.looseObject({
    runtime: v16FactWord.nullable().optional(),
    totals: v16Spend.nullable().optional(),
    turn: v16Spend.nullable().optional(),
    turnScope: v16FactWord.nullable().optional(),
    numTurns: v16Count,
    durationMs: v16Count,
    sourceSessionId: v16FactText.nullable().optional(),
  }),
  usage_sample: z.looseObject({
    runtime: v16FactWord.nullable().optional(),
    model: v16FactText.nullable().optional(),
    contextTokens: v16Count,
    contextWindow: v16Count,
    cacheTtl: v16FactWord.nullable().optional(),
    mainThread: z.boolean().nullable().optional(),
    cacheReadTokens: v16Count,
  }),
  tasks: z.looseObject({
    runtime: v16FactWord.nullable().optional(),
    running: v16FactList(
      z.looseObject({
        taskId: v16FactText.nullable().optional(),
        type: v16FactWord.nullable().optional(),
        description: v16FactText.nullable().optional(),
      }),
    ),
    settled: v16FactList(
      z.looseObject({
        taskId: v16FactText.nullable().optional(),
        type: v16FactWord.nullable().optional(),
        status: v16FactWord.nullable().optional(),
      }),
    ),
  }),
  compaction: z.looseObject({
    runtime: v16FactWord.nullable().optional(),
    status: v16FactWord.nullable().optional(),
    trigger: v16FactWord.nullable().optional(),
    tokensBefore: v16Count,
    tokensAfter: v16Count,
  }),
};
const v16AgentFactsBody = z.looseObject({
  update: z.literal('agent_facts'),
  fact: z.looseObject({ kind: z.string().min(1).max(V16_MAX_FACT_WORD_LENGTH) }),
  sourceId: v16FactText.nullable().optional(),
  observedAt: z.string().min(1).nullable().optional(),
});
const v16AgentFragmentBody = z.looseObject({
  update: z.literal('agent_fragment'),
  runtime: v16FactWord.nullable().optional(),
  channel: v16FactWord.nullable().optional(),
  text: z.string().nullable().optional(),
  parentId: v16FactText.nullable().optional(),
});
const v16AgentMessageRuntime = z.looseObject({ runtime: v16FactWord.nullable().optional() });

// The conversation item stream's body: every declared member nullable and optional, every unknown key
// carried, an item kind the release does not model carried with only its kind checked, and every item
// held to the item budget.
const v16ItemMembers = {
  itemId: v16FactText.nullable().optional(),
  turnId: v16FactText.nullable().optional(),
  truncated: z.boolean().nullable().optional(),
};
const v16ItemText = z.string().nullable().optional();
const V16_ITEMS: Readonly<Record<string, z.ZodType>> = {
  turn: z.looseObject({ ...v16ItemMembers, status: v16FactWord.nullable().optional(), detail: v16ItemText }),
  user_text: z.looseObject({ ...v16ItemMembers, text: v16ItemText }),
  agent_text: z.looseObject({
    ...v16ItemMembers,
    text: v16ItemText,
    final: z.boolean().nullable().optional(),
  }),
  thinking: z.looseObject({
    ...v16ItemMembers,
    text: v16ItemText,
    summary: z.boolean().nullable().optional(),
  }),
  tool_call: z.looseObject({
    ...v16ItemMembers,
    toolUseId: v16FactText.nullable().optional(),
    toolName: v16FactText.nullable().optional(),
    toolKind: v16FactWord.nullable().optional(),
    input: v16JsonObject.nullable().optional(),
  }),
  tool_result: z.looseObject({
    ...v16ItemMembers,
    toolUseId: v16FactText.nullable().optional(),
    status: v16FactWord.nullable().optional(),
    output: v16ItemText,
    exitCode: z.number().int().nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    changes: v16FactList(
      z.looseObject({
        path: v16FactText.nullable().optional(),
        change: v16FactWord.nullable().optional(),
        movePath: v16FactText.nullable().optional(),
        diff: z.string().nullable().optional(),
      }),
    ),
  }),
  plan: z.looseObject({ ...v16ItemMembers, text: v16ItemText }),
  notice: z.looseObject({ ...v16ItemMembers, level: v16FactWord.nullable().optional(), text: v16ItemText }),
};
const v16AgentItemBody = z.looseObject({
  update: z.literal('agent_item'),
  runtime: v16FactWord.nullable().optional(),
  item: z.looseObject({ kind: z.string().min(1).max(V16_MAX_FACT_WORD_LENGTH) }),
  observedAt: z.string().min(1).nullable().optional(),
});
const V16_UTF8 = new TextEncoder();

type V16Context = Parameters<Parameters<typeof v16JsonObject.superRefine>[0]>[1];

function v16Carry(
  result: { success: boolean; error?: { issues: readonly z.core.$ZodIssue[] } },
  prefix: readonly PropertyKey[],
  ctx: V16Context,
): void {
  if (result.success) return;
  for (const issue of result.error?.issues ?? []) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: [...prefix, ...issue.path] });
  }
}

/** The checks a body earns by its `update` at protocol 16; every other body is open JSON. */
function v16CheckBody(body: JsonObject, lane: 'update' | 'delta', ctx: V16Context): void {
  const update = body['update'];
  if (update === 'agent_message') {
    v16Carry(v16AgentMessageRuntime.safeParse(body), [], ctx);
    return;
  }
  if (lane === 'update' && update === 'state_transition') {
    const transition = body['transition'];
    if (typeof transition !== 'object' || transition === null || Array.isArray(transition)) return;
    v16Carry(
      v16ControlTier.nullable().optional().safeParse(transition['controlTier']),
      ['transition', 'controlTier'],
      ctx,
    );
    return;
  }
  if (lane === 'update' && update === 'agent_facts') {
    const parsed = v16AgentFactsBody.safeParse(body);
    v16Carry(parsed, [], ctx);
    if (!parsed.success) return;
    const schema = V16_FACTS[parsed.data.fact.kind];
    if (schema !== undefined) v16Carry(schema.safeParse(parsed.data.fact), ['fact'], ctx);
    return;
  }
  if (lane === 'update' && update === 'agent_item') {
    const parsed = v16AgentItemBody.safeParse(body);
    v16Carry(parsed, [], ctx);
    if (!parsed.success) return;
    const schema = V16_ITEMS[parsed.data.item.kind];
    if (schema !== undefined) v16Carry(schema.safeParse(parsed.data.item), ['item'], ctx);
    const byteCount = V16_UTF8.encode(JSON.stringify(body['item']) ?? '').length;
    if (byteCount > V16_MAX_AGENT_ITEM_BYTES) {
      ctx.addIssue({ code: 'custom', message: `the item is ${byteCount} bytes as JSON`, path: ['item'] });
    }
    return;
  }
  if (lane === 'delta' && update === 'agent_fragment') {
    v16Carry(v16AgentFragmentBody.safeParse(body), [], ctx);
  }
}

const v16SessionPayload = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('session_update'),
    body: v16JsonObject.superRefine((body, ctx) => v16CheckBody(body, 'update', ctx)),
  }),
  z.looseObject({
    kind: z.literal('session_delta'),
    body: v16JsonObject.superRefine((body, ctx) => v16CheckBody(body, 'delta', ctx)),
  }),
  z.looseObject({
    kind: z.literal('host_configure_result'),
    requestId: z.string().min(1),
    configuration: v16HostConfiguration,
    overriddenByEnvironment: z.array(z.string()),
    pendingRestart: v16PendingRestart,
    refusal: v16Refusal.nullable(),
  }),
]);

const v16ControlPayload = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('link_hello'),
    protocolVersion: z.number().int(),
    hostId: z.string().min(1),
    capabilities: z.array(z.string()),
    cursors: z.array(v16SessionCursor),
    configuration: v16HostConfiguration,
    pendingRestart: v16PendingRestart,
    protocolRange: v16ProtocolRange,
  }),
]);

const V16 = z.discriminatedUnion('frame', [
  z.looseObject({
    frame: z.literal('session'),
    sessionId: z.string().min(1),
    seq: z.number().int().positive(),
    at: z.string().min(1),
    payload: v16SessionPayload,
  }),
  z.looseObject({ frame: z.literal('control'), at: z.string().min(1), payload: v16ControlPayload }),
]);

/** The kinds `V16` models: everything this file's host is driven to send, bar the link's own chatter. */
const V16_KINDS = ['link_hello', 'session_update', 'session_delta', 'host_configure_result'];

/**
 * The decision request a protocol-16 controller's decision endpoint reads: `DecisionRequest` as
 * v1.7.0 declares it (`git show v1.7.0:src/gate/decision.ts`), the members added since protocol 14
 * optional, unknown keys carried, and each closed vocabulary held to that release's words. The body
 * rides HTTP, not the link, so this is the shape rather than a codec.
 */
const V16_DECISION_REQUEST = z.looseObject({
  toolName: z.string(),
  toolKind: z.enum(V16_TOOL_KINDS).nullable().optional(),
  shellDialect: z.enum(V16_SHELL_DIALECTS).nullable().optional(),
  runtime: z.string().nullable().optional(),
  toolUseId: z.string(),
  toolInput: z.unknown(),
  sessionId: z.string(),
  sessionKey: z.string(),
  cwd: z.string(),
  agentId: z.string().nullable(),
  agentType: z.string().nullable(),
});

// ---------------------------------------------------------------------------

const AGENT: HostAgent = {
  claudeCodeVersion: '2.1.284',
  sdkVersion: '0.3.284',
  models: [
    {
      value: 'alias-1',
      resolvedModel: 'model-id-1',
      displayName: 'Model One',
      description: 'The first model',
      supportedEffortLevels: ['low', 'high', 'max'],
      supportsFastMode: true,
      supportsAutoMode: false,
      supportsAdaptiveThinking: true,
    },
  ],
};

const allow = async (): Promise<unknown> => ({ behavior: 'allow' });

const TIMEOUT_MS = 3_000;

/** What the hello's runtimes list states for Claude over `AGENT`. */
const CLAUDE_ENTRY = {
  runtime: 'claude',
  version: AGENT.claudeCodeVersion,
  sdkVersion: AGENT.sdkVersion,
  models: AGENT.models,
  vocabularies: {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinking: true,
  },
  controlTier: { level: 'intercepted', degrades: [] },
  available: true,
  unavailableReason: null,
};

/** What the hello's runtimes list states for a signed-in Codex on the pinned binary. */
const CODEX_ENTRY = availableCodexEntry(
  '0.162.1',
  FAKE_MODELS.filter((model) => model['hidden'] !== true).map((model) => codexHostModel(model as never)),
);

/** What the hello's runtimes list states for Qwen Code on the pinned CLI. */
const QWEN_ENTRY = availableQwenEntry('0.25.1');

/** What the hello's runtimes list states for pi on the pinned CLI. */
const PI_ENTRY = availablePiEntry('1.2.0');

/** An endpoint this build's host declares; a protocol-16 controller reads the hello's list. */
const ENDPOINT: ModelEndpoint = {
  name: 'example-endpoint',
  wireApi: 'anthropic-messages',
  runtimes: ['claude'],
  baseUrl: 'https://endpoint.example/anthropic',
  models: ['example-model'],
  modelAliases: { opus: 'example-model', sonnet: 'example-model', haiku: 'example-model' },
  contextWindow: null,
  env: {},
  firstParty: false,
  authToken: () => 'example-token',
};

/** What the hello's endpoints list states for `ENDPOINT`. */
const ENDPOINT_ENTRY = {
  name: 'example-endpoint',
  wireApi: 'anthropic-messages',
  runtimes: ['claude'],
  models: ['example-model', 'opus', 'sonnet', 'haiku'],
};

interface Sent {
  readonly kind: string;
  readonly sessionId: string | null;
  readonly raw: string;
  readonly payload: Record<string, unknown>;
}

function sentFrames(raw: readonly string[]): Sent[] {
  return raw.map((text) => {
    const parsed = JSON.parse(text) as { sessionId?: string; payload: Record<string, unknown> };
    return {
      kind: String(parsed.payload['kind']),
      sessionId: parsed.sessionId ?? null,
      raw: text,
      payload: parsed.payload,
    };
  });
}

function bodyOf(sent: Sent): Record<string, unknown> {
  return (sent.payload['body'] ?? {}) as Record<string, unknown>;
}

/** Whether the session behind `handle` has sent a transition into `to`. */
function reached(raw: readonly string[], handle: string, to: string): boolean {
  return sentFrames(raw).some(
    (sent) =>
      sent.sessionId === handle &&
      sent.kind === 'session_update' &&
      readStateTransition(bodyOf(sent) as JsonObject)?.to === to,
  );
}

test('a controller on protocol 16 decodes every frame a host of this build sends it', async () => {
  const peer = await peerOn({ welcomeVersion: 16, ack: true });
  const cwd = await tempDir('protocol-window');
  const agents = fakeAgents();
  const codex = fakeCodex({ codexHome: cwd });
  // Qwen Code lists a tool its ask rules do not name and reports a mode that approves calls itself,
  // and a variables file sits in the operator's home: the three degrades protocol 17 adds.
  const qwen = fakeQwen({
    tools: [...QWEN_NAMES.tools, 'example_unruled_tool'],
    mode: 'yolo',
    calls: () => [{ name: 'run_shell_command', input: { command: 'git status' } }],
  });
  writeFileSync(join(cwd, '.env'), 'EXAMPLE_TOKEN=x\n');
  const qwenRuntime: QwenRuntimeConfig = {
    binary: 'C:/tools/qwen/cli-entry.js',
    base: join(cwd, 'qwen'),
    operatorHome: cwd,
    spawn: qwen.spawn,
    killTree: () => Promise.resolve(),
    closeGraceMs: 20,
  };
  // pi lists a command an extension this host did not load registered: the degrade protocol 17 adds
  // for pi, known when it opens.
  const pi = fakePi({
    calls: () => [{ toolName: 'bash', input: { command: 'git status' } }],
    foreignCommands: [{ name: 'example-command', path: '/srv/example/extension.ts' }],
  });
  const piRuntime: PiRuntimeConfig = {
    binary: 'C:/tools/pi/dist/bundle/cli.js',
    base: join(cwd, 'pi'),
    spawn: pi.spawn,
    killTree: () => Promise.resolve(),
    closeGraceMs: 20,
  };
  const decided: DecisionRequest[] = [];
  const host = new PeriscopeHost({
    controllerUrl: peer.url,
    hostId: 'host-1',
    decide: async (request) => {
      decided.push(request);
      return allow();
    },
    protectedPaths: [],
    registry: new SessionRegistry({
      // The shell Qwen Code runs its commands through on Windows, which its decision request names.
      baseEnv: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      homeDir: cwd,
      startProcess: agents.start,
      runtimes: {
        codex: codexNativeRuntime({
          binary: 'C:/tools/codex.exe',
          home: cwd,
          clientVersion: '1.7.0',
          spawn: codex.spawn,
          killTree: () => Promise.resolve(),
          closeGraceMs: 20,
        }),
        'qwen-code': qwenNativeRuntime(qwenRuntime),
        pi: piNativeRuntime(piRuntime),
      },
    }),
    agentCatalog: () => Promise.resolve({ ok: true, agent: AGENT }),
    codex: {
      runtime: { binary: 'C:/tools/codex.exe', home: cwd, clientVersion: '1.7.0' },
      read: async () => ({ entry: CODEX_ENTRY, detail: null }),
    },
    qwen: { runtime: qwenRuntime, read: async () => ({ entry: QWEN_ENTRY, detail: null }) },
    pi: { runtime: piRuntime, read: async () => ({ entry: PI_ENTRY, detail: null }) },
    endpoints: [ENDPOINT],
  });

  try {
    host.start();
    await waitFor(() => host.link.negotiatedVersion === 16, 'the welcome at 16', TIMEOUT_MS);

    // A Claude session, driven through the members protocol 12 added on the way out (a forwarded
    // message with its instant, a transition caused by a model switch and one by a refusal with no
    // fallback) and the bodies protocol 15 added (the facts an init carries, and a streamed fragment).
    peer.send('session-1', 1, sessionNew(cwd));
    await waitFor(() => agents.started.length === 1, 'the session to start', TIMEOUT_MS);
    const agent = agents.started[0]!;
    agent.emit(initMessage('agent-1'));
    agent.emit({
      type: 'stream_event',
      uuid: 'delta-1',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    } as unknown as SDKMessage);
    const switched = agent.request.hooks?.PostModelSwitch?.[0]?.hooks[0];
    assert.ok(switched !== undefined, 'the composed session observes PostModelSwitch');
    await waitFor(
      () =>
        sentFrames(peer.raw).some(
          (sent) => sent.kind === 'session_update' && readObservedAt(bodyOf(sent) as JsonObject) !== null,
        ),
      'the forwarded init message',
      TIMEOUT_MS,
    );
    await switched(
      {
        hook_event_name: 'PostModelSwitch',
        session_id: 'agent-1',
        transcript_path: '',
        cwd,
        from_model: 'model-a',
        to_model: 'model-b',
        requested_model: 'model-b',
        source: 'sdk',
        context_tokens: 1_000,
        prompt_cache_warm: false,
        cache_ttl: '5m',
        estimated_cache_write_usd: 0.01,
        pricing: 'catalog',
      } as unknown as HookInput,
      undefined,
      { signal: new AbortController().signal },
    );
    agent.emit({
      type: 'system',
      subtype: 'model_refusal_no_fallback',
      original_model: 'model-b',
      session_id: 'agent-1',
      uuid: 'refusal-1',
    } as unknown as SDKMessage);

    // A tool call through the gate, so a decision request is posted the way a decider receives it.
    const toolCall = {
      hook_event_name: 'PreToolUse',
      session_id: 'agent-1',
      transcript_path: '',
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'toolu_1',
    } as unknown as HookInput;
    for (const matcher of agent.request.hooks?.PreToolUse ?? []) {
      for (const hook of matcher.hooks)
        await hook(toolCall, 'toolu_1', { signal: new AbortController().signal });
    }

    // A Codex session, driven through a turn: what protocol 16 added, read natively at 16.
    peer.send('session-2', 1, sessionNew(cwd, { request: sessionNewRequest({ runtime: 'codex' }) }));
    await waitFor(() => reached(peer.raw, 'session-2', 'ready'), 'the Codex session to be ready', TIMEOUT_MS);
    peer.send('session-2', 2, { kind: 'session_prompt', text: 'hello' });
    await waitFor(() => reached(peer.raw, 'session-2', 'working'), 'the Codex turn to run', TIMEOUT_MS);
    codex.server.notify('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'msg-1',
      delta: 'Hel',
    });
    codex.server.notify('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        total: {
          totalTokens: 60,
          inputTokens: 50,
          cachedInputTokens: 20,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 2,
        },
        last: {
          totalTokens: 60,
          inputTokens: 50,
          cachedInputTokens: 20,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 2,
        },
        modelContextWindow: 272000,
      },
    });
    codex.server.completeTurn();
    await waitFor(() => reached(peer.raw, 'session-2', 'idle'), 'the Codex turn to end', TIMEOUT_MS);

    // A Qwen Code session, driven through a turn with a shell call: what protocol 17 adds reaches the
    // wire inside members a protocol-16 controller already reads.
    peer.send(
      'session-3',
      1,
      sessionNew(cwd, { request: sessionNewRequest({ runtime: 'qwen-code', includePartialMessages: true }) }),
    );
    await waitFor(
      () => reached(peer.raw, 'session-3', 'ready'),
      'the Qwen Code session to be ready',
      TIMEOUT_MS,
    );
    peer.send('session-3', 2, { kind: 'session_prompt', text: 'hello' });
    await waitFor(() => reached(peer.raw, 'session-3', 'idle'), 'the Qwen Code turn to end', TIMEOUT_MS);

    // A pi session, driven through a run with a shell call: what protocol 17 adds for pi reaches the
    // wire inside the same members.
    peer.send(
      'session-4',
      1,
      sessionNew(cwd, { request: sessionNewRequest({ runtime: 'pi', includePartialMessages: true }) }),
    );
    await waitFor(() => reached(peer.raw, 'session-4', 'ready'), 'the pi session to be ready', TIMEOUT_MS);
    peer.send('session-4', 2, { kind: 'session_prompt', text: 'hello' });
    await waitFor(() => reached(peer.raw, 'session-4', 'idle'), 'the pi run to end', TIMEOUT_MS);

    // A host-scoped answer, whose configuration carries the catalog. No seam is composed, so it is
    // refused, and the refusal answer still carries the whole configuration.
    peer.send(
      'host-channel',
      1,
      hostConfigure('request-1', [{ key: 'PERISCOPE_BRANCH_SCHEME', value: 'x' }]),
    );

    await waitFor(
      () => sentFrames(peer.raw).some((sent) => sent.kind === 'host_configure_result'),
      'the configure answer',
      TIMEOUT_MS,
    );
    await waitFor(
      () => sentFrames(peer.raw).some((sent) => sent.raw.includes('system/model_refusal_no_fallback')),
      'the refusal transition',
      TIMEOUT_MS,
    );
    await waitFor(
      () =>
        sentFrames(peer.raw).some(
          (sent) => sent.sessionId === 'session-1' && bodyOf(sent)['update'] === 'agent_fragment',
        ),
      'the streamed fragment',
      TIMEOUT_MS,
    );

    const sent = sentFrames(peer.raw);
    const read = sent.filter((one) => V16_KINDS.includes(one.kind));
    const refused = read.flatMap((one) => {
      const decoded = V16.safeParse(JSON.parse(one.raw));
      return decoded.success
        ? []
        : [`${one.kind}: ${decoded.error.issues.map((issue) => issue.message).join('; ')}`];
    });
    assert.deepEqual(
      refused,
      [],
      `a protocol-16 controller refuses what this host sent:\n  ${refused.join('\n  ')}`,
    );

    // What was read carries the members protocols 12 and 15 added, so the green above is about them too.
    const hello = read.find((one) => one.kind === 'link_hello');
    assert.ok(hello !== undefined, 'the hello was captured');
    const helloConfiguration = hello.payload['configuration'] as Record<string, unknown>;
    assert.deepEqual(helloConfiguration['agent'], AGENT, 'the hello carries the catalog');
    assert.deepEqual(hello.payload['protocolRange'], { min: PROTOCOL_VERSION_MIN, max: PROTOCOL_VERSION });
    const answer = read.find((one) => one.kind === 'host_configure_result');
    const answerConfiguration = answer?.payload['configuration'] as Record<string, unknown>;
    assert.deepEqual(answerConfiguration['agent'], AGENT);
    assert.ok(
      read.some((one) => one.kind === 'session_update' && typeof bodyOf(one)['observedAt'] === 'string'),
      'a forwarded message carries its instant',
    );
    assert.ok(
      read.some((one) => one.raw.includes('"PostModelSwitch"')),
      'a transition caused by a model switch was sent',
    );
    const claudeFacts = read.filter(
      (one) =>
        one.sessionId === 'session-1' &&
        one.kind === 'session_update' &&
        bodyOf(one)['update'] === 'agent_facts',
    );
    assert.deepEqual(
      claudeFacts.map((one) => (bodyOf(one)['fact'] as Record<string, unknown>)['kind']),
      ['session_handle', 'agent_receipt'],
      'the init carried its facts',
    );
    assert.deepEqual(helloConfiguration['endpoints'], [ENDPOINT_ENTRY], 'the hello carries the endpoints');
    assert.deepEqual(answerConfiguration['endpoints'], [ENDPOINT_ENTRY]);
    const ready = read
      .filter((one) => one.sessionId === 'session-1' && one.kind === 'session_update')
      .map((one) => readStateTransition(bodyOf(one) as JsonObject))
      .find((transition) => transition?.to === 'ready');
    assert.deepEqual(
      ready?.controlTier,
      { level: 'intercepted', degrades: [] },
      'the first ready states the tier',
    );

    // What protocol 16 added, read natively: Codex in the runtimes list beside Qwen Code and pi, the
    // pack list, Codex's messages and fragments named, and a transition an agent event caused.
    const runtimes = [
      CLAUDE_ENTRY,
      JSON.parse(JSON.stringify(CODEX_ENTRY)) as unknown,
      JSON.parse(JSON.stringify(QWEN_ENTRY)) as unknown,
      JSON.parse(JSON.stringify(PI_ENTRY)) as unknown,
    ];
    assert.deepEqual(
      helloConfiguration['agents'],
      runtimes,
      'the hello lists Claude, then Codex, then Qwen Code, then pi',
    );
    assert.deepEqual(answerConfiguration['agents'], runtimes, 'the configure answer lists all four');
    assert.deepEqual(
      helloConfiguration['agentSkills'],
      [
        { runtime: 'claude', naming: 'namespaced', delivery: 'per-session' },
        { runtime: 'codex', naming: 'namespaced', delivery: 'per-process' },
        { runtime: 'qwen-code', naming: 'bare', delivery: 'per-session' },
        { runtime: 'pi', naming: 'bare', delivery: 'per-session' },
      ],
      'the hello lists how each runtime takes plugins',
    );
    const codexRead = read.filter((one) => one.sessionId === 'session-2');
    assert.ok(
      codexRead.some((one) => one.kind === 'session_update' && bodyOf(one)['runtime'] === 'codex'),
      'a Codex message was sent',
    );
    assert.ok(
      codexRead.some(
        (one) =>
          one.kind === 'session_delta' &&
          bodyOf(one)['update'] === 'agent_fragment' &&
          bodyOf(one)['runtime'] === 'codex',
      ),
      'a Codex fragment was sent',
    );
    const causes = codexRead
      .flatMap((one) =>
        one.kind === 'session_update' ? [readStateTransition(bodyOf(one) as JsonObject)] : [],
      )
      .flatMap((transition) =>
        transition === null ? [] : [`${transition.cause.kind}/${transition.cause.event}`],
      );
    assert.ok(causes.includes('agent-event/codex:thread/started'), causes.join(', '));
    assert.ok(causes.includes('agent-event/codex:turn/completed'), causes.join(', '));
    assert.ok(
      codexRead.some(
        (one) =>
          bodyOf(one)['update'] === 'agent_facts' &&
          (bodyOf(one)['fact'] as Record<string, unknown>)['kind'] === 'turn_record',
      ),
      'a Codex turn record was sent',
    );

    // What protocol 17 adds for Qwen Code, among what the protocol-16 decoder read: its messages,
    // its fragments, transitions its events caused, its three degrades, and the one known when it
    // opened riding the first ready's tier.
    const qwenRead = read.filter((one) => one.sessionId === 'session-3');
    assert.ok(
      qwenRead.some((one) => one.kind === 'session_update' && bodyOf(one)['runtime'] === 'qwen-code'),
      'a Qwen Code message was sent',
    );
    assert.ok(
      qwenRead.some((one) => one.kind === 'session_delta' && bodyOf(one)['runtime'] === 'qwen-code'),
      'a Qwen Code fragment was sent',
    );
    const qwenTransitions = qwenRead.flatMap((one) =>
      one.kind === 'session_update' ? [readStateTransition(bodyOf(one) as JsonObject)] : [],
    );
    const qwenCauses = qwenTransitions.flatMap((transition) =>
      transition === null ? [] : [`${transition.cause.kind}/${transition.cause.event}`],
    );
    for (const cause of [
      'agent-event/qwen-code:initialize',
      'agent-event/qwen-code:system/init',
      'agent-event/qwen-code:result',
      'refusal/gate-tool-unruled',
      'refusal/gate-mode-widened',
    ]) {
      assert.ok(qwenCauses.includes(cause), `${cause} among ${qwenCauses.join(', ')}`);
    }
    assert.deepEqual(
      qwenTransitions.find((transition) => transition?.to === 'ready')?.controlTier,
      { level: 'intercepted-with-residual', degrades: ['gate-credential-in-shell'] },
      'the first ready states the tier, the degrade known at open with it',
    );

    // What protocol 17 adds for pi, among what the protocol-16 decoder read: its messages, its
    // fragments, transitions its events and the host's commands caused, and the degrade known when it
    // opened, named and riding the first ready's tier.
    const piRead = read.filter((one) => one.sessionId === 'session-4');
    assert.ok(
      piRead.some((one) => one.kind === 'session_update' && bodyOf(one)['runtime'] === 'pi'),
      'a pi message was sent',
    );
    assert.ok(
      piRead.some((one) => one.kind === 'session_delta' && bodyOf(one)['runtime'] === 'pi'),
      'a pi fragment was sent',
    );
    const piTransitions = piRead.flatMap((one) =>
      one.kind === 'session_update' ? [readStateTransition(bodyOf(one) as JsonObject)] : [],
    );
    const piCauses = piTransitions.flatMap((transition) =>
      transition === null ? [] : [`${transition.cause.kind}/${transition.cause.event}`],
    );
    for (const cause of [
      'agent-event/pi:get_state',
      'agent-event/pi:agent_start',
      'agent-event/pi:agent_settled',
      'refusal/gate-foreign-extension',
    ]) {
      assert.ok(piCauses.includes(cause), `${cause} among ${piCauses.join(', ')}`);
    }
    assert.deepEqual(
      piTransitions.find((transition) => transition?.to === 'ready')?.controlTier,
      { level: 'intercepted-with-residual', degrades: ['gate-foreign-extension'] },
      'the first ready states the tier, the degrade known at open with it',
    );

    // The decision requests a protocol-16 endpoint reads: one for the Claude call, one for Qwen Code's
    // and one for pi's. Qwen Code's shell on Windows is `cmd`, a word 16 does not declare, so its
    // request is sent with no dialect at all; pi's `bash` is `posix` on every host, a word 16 declares.
    assert.equal(decided.length, 3, 'a tool call was not asked about');
    for (const request of decided) {
      const asV16 = V16_DECISION_REQUEST.safeParse(JSON.parse(JSON.stringify(request)));
      assert.ok(asV16.success, asV16.success ? '' : asV16.error.message);
    }
    const body = JSON.parse(JSON.stringify(decided[0])) as Record<string, unknown>;
    assert.equal(body['toolKind'], 'shell');
    assert.equal(body['runtime'], 'claude');
    const qwenBody = JSON.parse(JSON.stringify(decided[1])) as Record<string, unknown>;
    assert.equal(qwenBody['runtime'], 'qwen-code');
    assert.equal(qwenBody['toolKind'], 'shell');
    assert.equal(qwenBody['shellDialect'], process.platform === 'win32' ? undefined : 'posix');
    const piBody = JSON.parse(JSON.stringify(decided[2])) as Record<string, unknown>;
    assert.deepEqual(
      [piBody['runtime'], piBody['toolKind'], piBody['shellDialect']],
      ['pi', 'shell', 'posix'],
    );
  } finally {
    host.stop();
    await peer.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a controller on protocol 16 is read in turn: its configure, effort included, applies what it asks', async () => {
  const peer = await peerOn({ welcomeVersion: 16, ack: true });
  const cwd = await tempDir('protocol-window');
  const agents = fakeAgents();
  const host = new PeriscopeHost({
    controllerUrl: peer.url,
    hostId: 'host-1',
    decide: allow,
    protectedPaths: [],
    registry: new SessionRegistry({ baseEnv: {}, homeDir: cwd, startProcess: agents.start }),
    endpoints: [ENDPOINT],
  });

  try {
    host.start();
    await waitFor(() => host.link.negotiatedVersion === 16, 'the welcome at 16', TIMEOUT_MS);
    // The first hello, sent with no catalog read, carries the endpoints, and the protocol-16 decoder
    // reads it.
    const firstHello = sentFrames(peer.raw).find((one) => one.kind === 'link_hello');
    assert.ok(firstHello !== undefined, 'the hello was captured');
    assert.ok(
      V16.safeParse(JSON.parse(firstHello.raw)).success,
      'a protocol-16 controller refuses the hello',
    );
    assert.deepEqual((firstHello.payload['configuration'] as Record<string, unknown>)['endpoints'], [
      ENDPOINT_ENTRY,
    ]);
    peer.send('session-1', 1, sessionNew(cwd));
    await waitFor(() => agents.started.length === 1, 'the session to start', TIMEOUT_MS);
    const agent = agents.started[0]!;
    agent.emit(initMessage('agent-1'));

    // The shape a protocol-16 controller sends: the effort member protocol 12 added, applied after
    // the model.
    const fromV16 = {
      kind: 'session_configure',
      model: 'model-b',
      permissionMode: null,
      thinking: null,
      effort: 'max',
    };
    peer.send('session-1', 2, fromV16 as SessionConfigure);
    await waitFor(() => agent.configured.length === 2, 'the configure to apply', TIMEOUT_MS);
    assert.deepEqual(agent.configured, [
      { setter: 'setModel', value: 'model-b' },
      { setter: 'setEffort', value: 'max' },
    ]);

    // The `session_new` a protocol-16 controller sends: a request with every member that release
    // declares, its runtime and endpoint unset, which opens on this host's default runtime.
    const openedFromV16 = {
      kind: 'session_new',
      cwd,
      workspaceKey: null,
      correlationId: null,
      gate: null,
      request: {
        resume: null,
        fork: null,
        settingSources: null,
        plugins: null,
        mcpServers: null,
        strictMcpConfig: null,
        includePartialMessages: null,
        thinking: null,
        forwardSubagentText: null,
        env: null,
        model: null,
        systemPrompt: null,
        effort: 'high',
        permissionMode: null,
        runtime: null,
        endpoint: null,
      },
    };
    peer.send('session-2', 1, openedFromV16 as SessionNew);
    await waitFor(() => agents.started.length === 2, 'the protocol-16 open to start a session', TIMEOUT_MS);
    assert.equal(agents.started[1]?.request.effort, 'high');
    // It names no endpoint, so it takes the runtime's own route on a host that declares one.
    assert.equal('ANTHROPIC_BASE_URL' in (agents.started[1]?.request.env ?? {}), false);
    assert.equal('ANTHROPIC_AUTH_TOKEN' in (agents.started[1]?.request.env ?? {}), false);
  } finally {
    host.stop();
    await peer.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a hello from a host one release behind, runtimes and endpoints and all, decodes on this build', () => {
  const skills = [
    { runtime: 'claude', naming: 'namespaced', delivery: 'per-session' },
    { runtime: 'codex', naming: 'namespaced', delivery: 'per-process' },
  ];
  const codexEntry = JSON.parse(JSON.stringify(CODEX_ENTRY)) as unknown;
  const wire = JSON.stringify({
    frame: 'control',
    at: '2000-01-01T00:00:00.000Z',
    payload: {
      kind: 'link_hello',
      protocolVersion: 16,
      hostId: 'host-1',
      capabilities: [],
      cursors: [],
      configuration: {
        ...unsetHostConfiguration(),
        agent: AGENT,
        agents: [CLAUDE_ENTRY, codexEntry],
        endpoints: [ENDPOINT_ENTRY],
        agentSkills: skills,
      },
      pendingRestart: [],
      protocolRange: { min: 15, max: 16 },
    },
  });
  const decoded = decode(wire);
  assert.ok(decoded.ok, decoded.ok ? '' : decoded.refusal.detail);
  const payload = decoded.value.payload as unknown as { configuration: Record<string, unknown> };
  assert.deepEqual(payload.configuration['agent'], AGENT, 'the catalog is read as sent');
  assert.deepEqual(
    payload.configuration['agents'],
    [CLAUDE_ENTRY, codexEntry],
    'the runtimes list is read as sent',
  );
  assert.deepEqual(payload.configuration['agentSkills'], skills, 'the pack list is read as sent');
});

test('an effort a controller names that the SDK does not is refused by name, not dropped', () => {
  const asked: SessionConfigure = {
    kind: 'session_configure',
    model: null,
    permissionMode: null,
    thinking: null,
    effort: 'extreme',
  };
  const read = readSessionConfigure(asked);
  assert.equal(read.ok, false);
  assert.match(read.ok ? '' : read.refusal.detail, /effort is "extreme"; the levels this SDK declares are/);
  const { effort: _effort, ...withoutEffort } = asked;
  const absent = readSessionConfigure(withoutEffort);
  assert.deepEqual(absent.ok ? absent.value : null, {}, 'an absent effort asks for nothing');
});

// The frozen decoder is only evidence if it can refuse. A released peer's shape that accepted
// anything would pass every frame above whatever this host sent.
test('control: the protocol-16 decoder refuses what a version-16 controller refuses', () => {
  const hello = (configuration: Record<string, unknown>): unknown => ({
    frame: 'control',
    at: '2000-01-01T00:00:00.000Z',
    payload: {
      kind: 'link_hello',
      protocolVersion: 16,
      hostId: 'host-1',
      capabilities: [],
      cursors: [],
      configuration,
      pendingRestart: [],
      protocolRange: { min: 15, max: 16 },
    },
  });
  const { plugins: _plugins, ...version10 } = unsetHostConfiguration();
  const { controlTier: _controlTier, ...untiered } = CLAUDE_ENTRY;

  assert.equal(
    V16.safeParse(hello({ ...unsetHostConfiguration(), agent: AGENT, agents: [CLAUDE_ENTRY] })).success,
    true,
    'a protocol-16 hello',
  );
  assert.equal(
    V16.safeParse(hello({ ...unsetHostConfiguration(), agent: { ...AGENT, models: 'all' } })).success,
    false,
    'a catalog whose models are not a list: the member protocol 12 added is checked',
  );
  assert.equal(
    V16.safeParse(hello({ ...unsetHostConfiguration(), agents: [untiered] })).success,
    false,
    'a runtime entry with no control tier: the members protocol 15 added are checked',
  );
  assert.equal(
    V16.safeParse(hello({ ...unsetHostConfiguration(), agentSkills: [{ runtime: 'codex', naming: 'bare' }] }))
      .success,
    false,
    'a pack row with no delivery: the member protocol 16 added is checked',
  );
  assert.equal(
    V16.safeParse(hello({ ...unsetHostConfiguration(), plugins: 'loop' })).success,
    false,
    'a member whose type changed',
  );
  assert.equal(V16.safeParse(hello(version10)).success, false, 'a protocol-10 hello, which has no plugins');

  const update = (body: Record<string, unknown>): unknown => ({
    frame: 'session',
    sessionId: 'session-1',
    seq: 1,
    at: '2000-01-01T00:00:00.000Z',
    payload: { kind: 'session_update', body },
  });
  const record = (inputTokens: unknown): Record<string, unknown> => ({
    update: 'agent_facts',
    fact: { kind: 'turn_record', runtime: 'codex', totals: { byModel: [{ inputTokens }] } },
  });
  assert.equal(V16.safeParse(update(record(30))).success, true, 'a turn record');
  assert.equal(
    V16.safeParse(update(record(-1))).success,
    false,
    'a negative count in a fact: the bodies protocol 15 added are checked',
  );
  const item = (exitCode: unknown): Record<string, unknown> => ({
    update: 'agent_item',
    runtime: 'codex',
    item: { kind: 'tool_result', toolUseId: 'call-1', status: 'completed', exitCode },
  });
  assert.equal(V16.safeParse(update(item(0))).success, true, 'a tool result');
  assert.equal(
    V16.safeParse(update(item(0.5))).success,
    false,
    'an exit code that is not a whole number: the item body protocol 16 added is checked',
  );
});

// The same for the decision request's shape: it must refuse a body a protocol-16 endpoint refuses.
test('control: the protocol-16 decision request refuses a body with no sessionKey, or a kind it does not know', () => {
  const request = {
    toolName: 'Bash',
    toolKind: 'shell',
    runtime: 'claude',
    toolUseId: 'toolu_1',
    toolInput: { command: 'ls' },
    sessionId: 'agent-1',
    sessionKey: 'session-1',
    cwd: '/w',
    agentId: null,
    agentType: null,
  };
  assert.equal(V16_DECISION_REQUEST.safeParse(request).success, true, 'a protocol-16 decision request');
  const { sessionKey: _sessionKey, ...unkeyed } = request;
  assert.equal(V16_DECISION_REQUEST.safeParse(unkeyed).success, false, 'a request with no controller handle');
  assert.equal(
    V16_DECISION_REQUEST.safeParse({ ...request, toolKind: 'teleport' }).success,
    false,
    'a tool kind that release does not declare',
  );
  assert.equal(
    V16_DECISION_REQUEST.safeParse({ ...request, shellDialect: 'powershell' }).success,
    true,
    'a dialect that release declares',
  );
  assert.equal(
    V16_DECISION_REQUEST.safeParse({ ...request, shellDialect: 'cmd' }).success,
    false,
    'the dialect protocol 17 adds, which that release does not declare',
  );
});

test('the dialect word protocol 17 adds is held back from a controller at 16, and sent at 17', async () => {
  const sent: DecisionRequest[] = [];
  let version: number | null = 16;
  const decide = decideAtLinkVersion(
    async (request) => {
      sent.push(request);
      return allow();
    },
    () => version,
  );
  const request: DecisionRequest = {
    toolName: 'run_shell_command',
    toolKind: 'shell',
    shellDialect: 'cmd',
    runtime: 'qwen-code',
    toolUseId: 'call_1',
    toolInput: { command: 'dir' },
    sessionId: 'qwen-session-1',
    sessionKey: 'session-1',
    cwd: '/w',
    agentId: null,
    agentType: null,
  };
  await decide(request, new AbortController().signal);
  version = 17;
  await decide(request, new AbortController().signal);
  const [at16, at17] = sent.map((one) => JSON.parse(JSON.stringify(one)) as Record<string, unknown>);
  assert.equal(at16?.['shellDialect'], undefined, 'a controller at 16 was sent the word it does not declare');
  assert.ok(V16_DECISION_REQUEST.safeParse(at16).success, 'a controller at 16 refuses what it was sent');
  assert.equal(at17?.['shellDialect'], 'cmd', 'a controller at 17 was not sent the dialect');
});

test('a controller on protocol 16 decodes every vector protocol 17 adds: the Qwen Code entry and pack row, its messages, its causes, its open refusal and its degrades', () => {
  const corpus = fileURLToPath(new URL('../../contracts/wire-vectors/', import.meta.url));
  const added = readdirSync(corpus).filter((file) => /qwen-code/.test(file));
  assert.equal(added.length, 8, `the vectors this reads: ${added.join(', ')}`);
  for (const file of added) {
    const wire = (JSON.parse(readFileSync(`${corpus}${file}`, 'utf8')) as { wire: string }).wire;
    const read = V16.safeParse(JSON.parse(wire));
    assert.ok(read.success, `${file}: ${read.success ? '' : JSON.stringify(read.error.issues)}`);
  }
});

test('a controller on protocol 16 decodes every vector protocol 17 adds for pi: its entry and pack row, its messages and fragments, its causes, its open refusal and its degrade', () => {
  const corpus = fileURLToPath(new URL('../../contracts/wire-vectors/', import.meta.url));
  const added = readdirSync(corpus).filter((file) => /[.-]pi[-.]/.test(file));
  assert.equal(added.length, 7, `the vectors this reads: ${added.join(', ')}`);
  for (const file of added) {
    const wire = (JSON.parse(readFileSync(`${corpus}${file}`, 'utf8')) as { wire: string }).wire;
    const read = V16.safeParse(JSON.parse(wire));
    assert.ok(read.success, `${file}: ${read.success ? '' : JSON.stringify(read.error.issues)}`);
  }
});
