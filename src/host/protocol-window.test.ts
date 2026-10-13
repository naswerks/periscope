/**
 * The window's promise, checked against the peer it is made to: a controller on protocol 15 reads
 * everything this host sends it, and this host reads everything that controller sends.
 *
 * `V15` below is that controller's decoder: the protocol-15 schemas transcribed from the codec the
 * v1.6.0 tag ships (`git show v1.6.0:src/control/codec.ts`), cut to the kinds this file reads, with
 * that release's bounds written as numbers. It describes a released peer, so it never changes to
 * follow this build; an edit here that turns a test green changes the contract rather than fixing
 * it. The frames it reads are the bytes a real link carried, from a host the peer welcomed at 15.
 * Protocol 16 adds what such a controller receives inside members it already reads: `codex` in the
 * hello's runtimes list, a Codex session's own messages and fragments with `runtime: "codex"`, a
 * transition caused by an `agent-event`, and five reasons for a runtime's JSON-RPC peer. So what is
 * read here is a Claude session's traffic and a Codex session's, side by side on one link. The
 * decision request is unchanged at 16; its body is read with that release's `DecisionRequest`
 * (`V15_DECISION_REQUEST`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
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
import { tempDir } from '../test-support/temp-dir.js';
import { peerOn, waitFor } from '../test-support/ws-peer.js';
import type { HookInput, SDKMessage } from './agent-process.js';
import { availableCodexEntry, codexHostModel, codexNativeRuntime } from './codex-runtime.js';
import { PeriscopeHost } from './host.js';
import type { ModelEndpoint } from './model-endpoints.js';
import { readSessionConfigure } from './wire-request.js';

// ---------------------------------------------------------------------------
// The protocol-15 decoder, as v1.6.0 shipped it.
// ---------------------------------------------------------------------------

const V15_MAX_CONFIGURATION_VALUE_LENGTH = 1000;
const V15_MAX_PLUGIN_DIRS = 8;
const V15_MAX_CONFIGURE_ENTRIES = 8;
const V15_MAX_AGENT_MODELS = 32;
const V15_MAX_AGENT_ENTRIES = 8;
const V15_MAX_ENDPOINTS = 8;
const V15_MAX_ENDPOINT_MODELS = 32;
const V15_MAX_FACT_LIST_ENTRIES = 256;
const V15_MAX_FACT_TEXT_LENGTH = 1000;
const V15_MAX_FACT_WORD_LENGTH = 64;
const V15_TOOL_KINDS = ['shell', 'file_read', 'file_write', 'file_edit', 'mcp', 'web', 'other'] as const;

const v15JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(v15JsonValue),
    z.record(z.string(), v15JsonValue),
  ]),
);
const v15JsonObject = z.record(z.string(), v15JsonValue);
const v15Refusal = z.looseObject({ reason: z.string().min(1), detail: z.string() });
const v15SessionCursor = z.looseObject({ sessionId: z.string().min(1), seq: z.number().int().nonnegative() });
const v15ConfigurationValue = z.string().max(V15_MAX_CONFIGURATION_VALUE_LENGTH).nullable();
const v15HostPlugin = z.looseObject({
  name: z.string().min(1).max(200),
  version: z.string().max(64).nullable(),
  path: z.string().min(1).max(V15_MAX_CONFIGURATION_VALUE_LENGTH),
});
const v15AgentModelText = z.string().min(1).max(200);
const v15HostModel = z.looseObject({
  value: v15AgentModelText,
  resolvedModel: v15AgentModelText.nullable(),
  displayName: z.string().max(200),
  description: z.string().max(V15_MAX_CONFIGURATION_VALUE_LENGTH).nullable(),
  supportedEffortLevels: z.array(z.string().min(1).max(32)).max(16),
  supportsFastMode: z.boolean().nullable(),
  supportsAutoMode: z.boolean().nullable(),
  supportsAdaptiveThinking: z.boolean().nullable(),
});
const v15HostAgent = z.looseObject({
  claudeCodeVersion: z.string().min(1).max(64),
  sdkVersion: z.string().min(1).max(64),
  models: z.array(v15HostModel).max(V15_MAX_AGENT_MODELS),
});
const v15ControlTier = z.looseObject({
  level: z.string().min(1).max(V15_MAX_FACT_WORD_LENGTH),
  degrades: z.array(z.string().min(1).max(V15_MAX_FACT_WORD_LENGTH)).max(V15_MAX_FACT_LIST_ENTRIES),
});
const v15VocabularyWords = z.array(z.string().min(1).max(32)).max(16);
const v15HostAgentEntry = z.looseObject({
  runtime: z.string().min(1).max(V15_MAX_FACT_WORD_LENGTH),
  version: z.string().min(1).max(64),
  sdkVersion: z.string().min(1).max(64).nullable(),
  models: z.array(v15HostModel).max(V15_MAX_AGENT_MODELS),
  vocabularies: z.looseObject({
    permissionModes: v15VocabularyWords,
    efforts: v15VocabularyWords,
    thinking: z.boolean(),
  }),
  controlTier: v15ControlTier,
  available: z.boolean(),
  unavailableReason: z.string().max(V15_MAX_CONFIGURATION_VALUE_LENGTH).nullable(),
});
const v15HostEndpoint = z.looseObject({
  name: z.string().min(1).max(V15_MAX_FACT_WORD_LENGTH),
  wireApi: z.string().min(1).max(V15_MAX_FACT_WORD_LENGTH),
  runtimes: z.array(z.string().min(1).max(V15_MAX_FACT_WORD_LENGTH)).max(V15_MAX_AGENT_ENTRIES),
  models: z.array(v15AgentModelText).max(V15_MAX_ENDPOINT_MODELS).nullable(),
});
const v15HostConfiguration = z.looseObject({
  repositoryRoot: v15ConfigurationValue,
  workspaceRoot: v15ConfigurationValue,
  branchScheme: v15ConfigurationValue,
  transcriptsRoot: v15ConfigurationValue,
  controllerUrl: v15ConfigurationValue,
  decisionUrl: v15ConfigurationValue,
  agentHome: v15ConfigurationValue,
  plugins: z.array(v15HostPlugin).max(V15_MAX_PLUGIN_DIRS),
  agent: v15HostAgent.nullable().optional(),
  agents: z.array(v15HostAgentEntry).max(V15_MAX_AGENT_ENTRIES).nullable().optional(),
  endpoints: z.array(v15HostEndpoint).max(V15_MAX_ENDPOINTS).nullable().optional(),
});
const v15PendingRestart = z.array(z.string().min(1).max(64)).max(V15_MAX_CONFIGURE_ENTRIES);
const v15ProtocolRange = z.looseObject({ min: z.number().int().min(1), max: z.number().int().min(1) });

// The fact layer's bodies, every declared member nullable and optional, every unknown key carried.
const v15FactWord = z.string().max(V15_MAX_FACT_WORD_LENGTH);
const v15FactText = z.string().max(V15_MAX_FACT_TEXT_LENGTH);
const v15Count = z.number().int().nonnegative().nullable().optional();
const v15FactList = <T extends z.ZodType>(entry: T) =>
  z.array(entry).max(V15_MAX_FACT_LIST_ENTRIES).nullable().optional();
const v15ModelSpend = z.looseObject({
  model: v15FactText.nullable().optional(),
  canonicalModel: v15FactText.nullable().optional(),
  provider: v15FactWord.nullable().optional(),
  inputTokens: v15Count,
  outputTokens: v15Count,
  cacheReadTokens: v15Count,
  cacheWriteTokens: v15Count,
  reasoningTokens: v15Count,
  cost: z.number().nonnegative().nullable().optional(),
  costBasis: v15FactWord.nullable().optional(),
  contextWindow: v15Count,
});
const v15Spend = z.looseObject({
  cost: z.number().nonnegative().nullable().optional(),
  currency: v15FactWord.nullable().optional(),
  costBasis: v15FactWord.nullable().optional(),
  byModel: v15FactList(v15ModelSpend),
});
const V15_FACTS: Readonly<Record<string, z.ZodType>> = {
  session_handle: z.looseObject({
    runtime: v15FactWord.nullable().optional(),
    handle: v15FactText.nullable().optional(),
  }),
  agent_receipt: z.looseObject({
    runtime: v15FactWord.nullable().optional(),
    runtimeVersion: v15FactWord.nullable().optional(),
    model: v15FactText.nullable().optional(),
    permissionMode: v15FactWord.nullable().optional(),
    effort: v15FactWord.nullable().optional(),
    skills: v15FactList(v15FactText),
    plugins: v15FactList(
      z.looseObject({
        name: v15FactText.nullable().optional(),
        version: v15FactWord.nullable().optional(),
        path: v15FactText.nullable().optional(),
      }),
    ),
    pluginErrors: v15FactList(
      z.looseObject({
        plugin: v15FactText.nullable().optional(),
        type: v15FactWord.nullable().optional(),
        message: v15FactText.nullable().optional(),
        path: v15FactText.nullable().optional(),
      }),
    ),
    mcpServers: v15FactList(
      z.looseObject({ name: v15FactText.nullable().optional(), status: v15FactWord.nullable().optional() }),
    ),
    source: v15FactWord.nullable().optional(),
  }),
  turn_record: z.looseObject({
    runtime: v15FactWord.nullable().optional(),
    totals: v15Spend.nullable().optional(),
    turn: v15Spend.nullable().optional(),
    turnScope: v15FactWord.nullable().optional(),
    numTurns: v15Count,
    durationMs: v15Count,
    sourceSessionId: v15FactText.nullable().optional(),
  }),
  usage_sample: z.looseObject({
    runtime: v15FactWord.nullable().optional(),
    model: v15FactText.nullable().optional(),
    contextTokens: v15Count,
    contextWindow: v15Count,
    cacheTtl: v15FactWord.nullable().optional(),
    mainThread: z.boolean().nullable().optional(),
  }),
  tasks: z.looseObject({
    runtime: v15FactWord.nullable().optional(),
    running: v15FactList(
      z.looseObject({
        taskId: v15FactText.nullable().optional(),
        type: v15FactWord.nullable().optional(),
        description: v15FactText.nullable().optional(),
      }),
    ),
  }),
  compaction: z.looseObject({
    runtime: v15FactWord.nullable().optional(),
    status: v15FactWord.nullable().optional(),
    trigger: v15FactWord.nullable().optional(),
    tokensBefore: v15Count,
    tokensAfter: v15Count,
  }),
};
const v15AgentFactsBody = z.looseObject({
  update: z.literal('agent_facts'),
  fact: z.looseObject({ kind: z.string().min(1).max(V15_MAX_FACT_WORD_LENGTH) }),
  sourceId: v15FactText.nullable().optional(),
  observedAt: z.string().min(1).nullable().optional(),
});
const v15AgentFragmentBody = z.looseObject({
  update: z.literal('agent_fragment'),
  runtime: v15FactWord.nullable().optional(),
  channel: v15FactWord.nullable().optional(),
  text: z.string().nullable().optional(),
  parentId: v15FactText.nullable().optional(),
});
const v15AgentMessageRuntime = z.looseObject({ runtime: v15FactWord.nullable().optional() });

type V15Context = Parameters<Parameters<typeof v15JsonObject.superRefine>[0]>[1];

function v15Carry(
  result: { success: boolean; error?: { issues: readonly z.core.$ZodIssue[] } },
  prefix: readonly PropertyKey[],
  ctx: V15Context,
): void {
  if (result.success) return;
  for (const issue of result.error?.issues ?? []) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: [...prefix, ...issue.path] });
  }
}

/** The checks a body earns by its `update` at protocol 15; every other body is open JSON. */
function v15CheckBody(body: JsonObject, lane: 'update' | 'delta', ctx: V15Context): void {
  const update = body['update'];
  if (update === 'agent_message') {
    v15Carry(v15AgentMessageRuntime.safeParse(body), [], ctx);
    return;
  }
  if (lane === 'update' && update === 'state_transition') {
    const transition = body['transition'];
    if (typeof transition !== 'object' || transition === null || Array.isArray(transition)) return;
    v15Carry(
      v15ControlTier.nullable().optional().safeParse(transition['controlTier']),
      ['transition', 'controlTier'],
      ctx,
    );
    return;
  }
  if (lane === 'update' && update === 'agent_facts') {
    const parsed = v15AgentFactsBody.safeParse(body);
    v15Carry(parsed, [], ctx);
    if (!parsed.success) return;
    const schema = V15_FACTS[parsed.data.fact.kind];
    if (schema !== undefined) v15Carry(schema.safeParse(parsed.data.fact), ['fact'], ctx);
    return;
  }
  if (lane === 'delta' && update === 'agent_fragment') {
    v15Carry(v15AgentFragmentBody.safeParse(body), [], ctx);
  }
}

const v15SessionPayload = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('session_update'),
    body: v15JsonObject.superRefine((body, ctx) => v15CheckBody(body, 'update', ctx)),
  }),
  z.looseObject({
    kind: z.literal('session_delta'),
    body: v15JsonObject.superRefine((body, ctx) => v15CheckBody(body, 'delta', ctx)),
  }),
  z.looseObject({
    kind: z.literal('host_configure_result'),
    requestId: z.string().min(1),
    configuration: v15HostConfiguration,
    overriddenByEnvironment: z.array(z.string()),
    pendingRestart: v15PendingRestart,
    refusal: v15Refusal.nullable(),
  }),
]);

const v15ControlPayload = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('link_hello'),
    protocolVersion: z.number().int(),
    hostId: z.string().min(1),
    capabilities: z.array(z.string()),
    cursors: z.array(v15SessionCursor),
    configuration: v15HostConfiguration,
    pendingRestart: v15PendingRestart,
    protocolRange: v15ProtocolRange,
  }),
]);

const V15 = z.discriminatedUnion('frame', [
  z.looseObject({
    frame: z.literal('session'),
    sessionId: z.string().min(1),
    seq: z.number().int().positive(),
    at: z.string().min(1),
    payload: v15SessionPayload,
  }),
  z.looseObject({ frame: z.literal('control'), at: z.string().min(1), payload: v15ControlPayload }),
]);

/** The kinds `V15` models: everything this file's host is driven to send, bar the link's own chatter. */
const V15_KINDS = ['link_hello', 'session_update', 'session_delta', 'host_configure_result'];

/**
 * The decision request a protocol-15 controller's decision endpoint reads: `DecisionRequest` as
 * v1.6.0 declares it (`git show v1.6.0:src/gate/decision.ts`), the members that release added
 * optional, unknown keys carried. The body rides HTTP, not the link, so this is the shape rather than
 * a codec.
 */
const V15_DECISION_REQUEST = z.looseObject({
  toolName: z.string(),
  toolKind: z.enum(V15_TOOL_KINDS).nullable().optional(),
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

/** An endpoint this build's host declares; a protocol-15 controller reads the hello's list. */
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

test('a controller on protocol 15 decodes every frame a host of this build sends it', async () => {
  const peer = await peerOn({ welcomeVersion: 15, ack: true });
  const cwd = await tempDir('protocol-window');
  const agents = fakeAgents();
  const codex = fakeCodex({ codexHome: cwd });
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
      baseEnv: {},
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
      },
    }),
    agentCatalog: () => Promise.resolve({ ok: true, agent: AGENT }),
    codex: {
      runtime: { binary: 'C:/tools/codex.exe', home: cwd, clientVersion: '1.7.0' },
      read: async () => ({ entry: CODEX_ENTRY, detail: null }),
    },
    endpoints: [ENDPOINT],
  });

  try {
    host.start();
    await waitFor(() => host.link.negotiatedVersion === 15, 'the welcome at 15', TIMEOUT_MS);

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

    // A Codex session, driven through a turn: what protocol 16 adds reaches the wire inside members a
    // protocol-15 controller already reads.
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
    const read = sent.filter((one) => V15_KINDS.includes(one.kind));
    const refused = read.flatMap((one) => {
      const decoded = V15.safeParse(JSON.parse(one.raw));
      return decoded.success
        ? []
        : [`${one.kind}: ${decoded.error.issues.map((issue) => issue.message).join('; ')}`];
    });
    assert.deepEqual(
      refused,
      [],
      `a protocol-15 controller refuses what this host sent:\n  ${refused.join('\n  ')}`,
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

    // The members protocol 16 adds were among what the protocol-15 decoder read, so the green above
    // covers them too: Codex in the runtimes list, its messages and fragments named, and a transition
    // an agent event caused.
    const runtimes = [CLAUDE_ENTRY, JSON.parse(JSON.stringify(CODEX_ENTRY)) as unknown];
    assert.deepEqual(helloConfiguration['agents'], runtimes, 'the hello lists Claude, then Codex');
    assert.deepEqual(answerConfiguration['agents'], runtimes, 'the configure answer lists both');
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

    // The decision request a protocol-15 endpoint reads, unchanged at 16.
    assert.equal(decided.length, 1, 'the tool call was not asked about');
    const body = JSON.parse(JSON.stringify(decided[0])) as Record<string, unknown>;
    const asV15 = V15_DECISION_REQUEST.safeParse(body);
    assert.ok(asV15.success, asV15.success ? '' : asV15.error.message);
    assert.equal(body['toolKind'], 'shell');
    assert.equal(body['runtime'], 'claude');
  } finally {
    host.stop();
    await peer.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a controller on protocol 15 is read in turn: its configure, effort included, applies what it asks', async () => {
  const peer = await peerOn({ welcomeVersion: 15, ack: true });
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
    await waitFor(() => host.link.negotiatedVersion === 15, 'the welcome at 15', TIMEOUT_MS);
    // The first hello, sent with no catalog read, carries the endpoints, and the protocol-15 decoder
    // reads it.
    const firstHello = sentFrames(peer.raw).find((one) => one.kind === 'link_hello');
    assert.ok(firstHello !== undefined, 'the hello was captured');
    assert.ok(
      V15.safeParse(JSON.parse(firstHello.raw)).success,
      'a protocol-15 controller refuses the hello',
    );
    assert.deepEqual((firstHello.payload['configuration'] as Record<string, unknown>)['endpoints'], [
      ENDPOINT_ENTRY,
    ]);
    peer.send('session-1', 1, sessionNew(cwd));
    await waitFor(() => agents.started.length === 1, 'the session to start', TIMEOUT_MS);
    const agent = agents.started[0]!;
    agent.emit(initMessage('agent-1'));

    // The shape a protocol-15 controller sends: the effort member protocol 12 added, applied after
    // the model.
    const fromV15 = {
      kind: 'session_configure',
      model: 'model-b',
      permissionMode: null,
      thinking: null,
      effort: 'max',
    };
    peer.send('session-1', 2, fromV15 as SessionConfigure);
    await waitFor(() => agent.configured.length === 2, 'the configure to apply', TIMEOUT_MS);
    assert.deepEqual(agent.configured, [
      { setter: 'setModel', value: 'model-b' },
      { setter: 'setEffort', value: 'max' },
    ]);

    // The `session_new` a protocol-15 controller sends: a request with every member that release
    // declares, its runtime and endpoint unset, which opens on this host's default runtime.
    const openedFromV15 = {
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
    peer.send('session-2', 1, openedFromV15 as SessionNew);
    await waitFor(() => agents.started.length === 2, 'the protocol-15 open to start a session', TIMEOUT_MS);
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
  const wire = JSON.stringify({
    frame: 'control',
    at: '2000-01-01T00:00:00.000Z',
    payload: {
      kind: 'link_hello',
      protocolVersion: 15,
      hostId: 'host-1',
      capabilities: [],
      cursors: [],
      configuration: {
        ...unsetHostConfiguration(),
        agent: AGENT,
        agents: [CLAUDE_ENTRY],
        endpoints: [ENDPOINT_ENTRY],
      },
      pendingRestart: [],
      protocolRange: { min: 14, max: 15 },
    },
  });
  const decoded = decode(wire);
  assert.ok(decoded.ok, decoded.ok ? '' : decoded.refusal.detail);
  const payload = decoded.value.payload as unknown as { configuration: Record<string, unknown> };
  assert.deepEqual(payload.configuration['agent'], AGENT, 'the catalog is read as sent');
  assert.deepEqual(payload.configuration['agents'], [CLAUDE_ENTRY], 'the runtimes list is read as sent');
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
test('control: the protocol-15 decoder refuses what a version-15 controller refuses', () => {
  const hello = (configuration: Record<string, unknown>): unknown => ({
    frame: 'control',
    at: '2000-01-01T00:00:00.000Z',
    payload: {
      kind: 'link_hello',
      protocolVersion: 15,
      hostId: 'host-1',
      capabilities: [],
      cursors: [],
      configuration,
      pendingRestart: [],
      protocolRange: { min: 14, max: 15 },
    },
  });
  const { plugins: _plugins, ...version10 } = unsetHostConfiguration();
  const { controlTier: _controlTier, ...untiered } = CLAUDE_ENTRY;

  assert.equal(
    V15.safeParse(hello({ ...unsetHostConfiguration(), agent: AGENT, agents: [CLAUDE_ENTRY] })).success,
    true,
    'a protocol-15 hello',
  );
  assert.equal(
    V15.safeParse(hello({ ...unsetHostConfiguration(), agent: { ...AGENT, models: 'all' } })).success,
    false,
    'a catalog whose models are not a list: the member protocol 12 added is checked',
  );
  assert.equal(
    V15.safeParse(hello({ ...unsetHostConfiguration(), agents: [untiered] })).success,
    false,
    'a runtime entry with no control tier: the members protocol 15 added are checked',
  );
  assert.equal(
    V15.safeParse(hello({ ...unsetHostConfiguration(), plugins: 'loop' })).success,
    false,
    'a member whose type changed',
  );
  assert.equal(V15.safeParse(hello(version10)).success, false, 'a protocol-10 hello, which has no plugins');

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
  assert.equal(V15.safeParse(update(record(30))).success, true, 'a turn record');
  assert.equal(
    V15.safeParse(update(record(-1))).success,
    false,
    'a negative count in a fact: the bodies protocol 15 added are checked',
  );
});

// The same for the decision request's shape: it must refuse a body a protocol-15 endpoint refuses.
test('control: the protocol-15 decision request refuses a body with no sessionKey, or a kind it does not know', () => {
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
  assert.equal(V15_DECISION_REQUEST.safeParse(request).success, true, 'a protocol-15 decision request');
  const { sessionKey: _sessionKey, ...unkeyed } = request;
  assert.equal(V15_DECISION_REQUEST.safeParse(unkeyed).success, false, 'a request with no controller handle');
  assert.equal(
    V15_DECISION_REQUEST.safeParse({ ...request, toolKind: 'teleport' }).success,
    false,
    'a tool kind that release does not declare',
  );
});
