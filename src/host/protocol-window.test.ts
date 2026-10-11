/**
 * The window's promise, checked against the peer it is made to: a controller on protocol 14 reads
 * everything this host sends it, and this host reads everything that controller sends.
 *
 * `V14` below is that controller's decoder: the protocol-14 schemas transcribed from the codec the
 * v1.5.0 tag ships (`git show v1.5.0:src/control/codec.ts`), cut to the kinds this file reads, with
 * that release's bounds written as numbers. It describes a released peer, so it never changes to
 * follow this build; an edit here that turns a test green changes the contract rather than fixing
 * it. The frames it reads are the bytes a real link carried, from a host the peer welcomed at 14.
 * Protocol 15 adds bodies such a controller receives as open JSON (the `agent_facts` update and the
 * `agent_fragment` delta), so what is read here is that traffic, the new bodies and the members
 * protocol 12 added included. It also adds members such a controller carries without reading: the
 * hello's `agents`, a first `ready` transition's `controlTier`, and `toolKind` and `runtime` on the
 * decision request, whose body that release's `DecisionRequest` describes (`V14_DECISION_REQUEST`).
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
  unsetHostConfiguration,
} from '../control/frames.js';
import type { DecisionRequest } from '../gate/decision.js';
import { SessionRegistry } from '../sessions/registry.js';
import { fakeAgents, initMessage } from '../test-support/fake-agent.js';
import { tempDir } from '../test-support/temp-dir.js';
import { peerOn, waitFor } from '../test-support/ws-peer.js';
import type { HookInput, SDKMessage } from './agent-process.js';
import { PeriscopeHost } from './host.js';
import { readSessionConfigure } from './wire-request.js';

// ---------------------------------------------------------------------------
// The protocol-14 decoder, as v1.5.0 shipped it.
// ---------------------------------------------------------------------------

const V14_MAX_CONFIGURATION_VALUE_LENGTH = 1000;
const V14_MAX_PLUGIN_DIRS = 8;
const V14_MAX_CONFIGURE_ENTRIES = 8;
const V14_MAX_AGENT_MODELS = 32;

const v14JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(v14JsonValue),
    z.record(z.string(), v14JsonValue),
  ]),
);
const v14JsonObject = z.record(z.string(), v14JsonValue);
const v14Refusal = z.looseObject({ reason: z.string().min(1), detail: z.string() });
const v14SessionCursor = z.looseObject({ sessionId: z.string().min(1), seq: z.number().int().nonnegative() });
const v14ConfigurationValue = z.string().max(V14_MAX_CONFIGURATION_VALUE_LENGTH).nullable();
const v14HostPlugin = z.looseObject({
  name: z.string().min(1).max(200),
  version: z.string().max(64).nullable(),
  path: z.string().min(1).max(V14_MAX_CONFIGURATION_VALUE_LENGTH),
});
const v14AgentModelText = z.string().min(1).max(200);
const v14HostModel = z.looseObject({
  value: v14AgentModelText,
  resolvedModel: v14AgentModelText.nullable(),
  displayName: z.string().max(200),
  description: z.string().max(V14_MAX_CONFIGURATION_VALUE_LENGTH).nullable(),
  supportedEffortLevels: z.array(z.string().min(1).max(32)).max(16),
  supportsFastMode: z.boolean().nullable(),
  supportsAutoMode: z.boolean().nullable(),
  supportsAdaptiveThinking: z.boolean().nullable(),
});
const v14HostAgent = z.looseObject({
  claudeCodeVersion: z.string().min(1).max(64),
  sdkVersion: z.string().min(1).max(64),
  models: z.array(v14HostModel).max(V14_MAX_AGENT_MODELS),
});
const v14HostConfiguration = z.looseObject({
  repositoryRoot: v14ConfigurationValue,
  workspaceRoot: v14ConfigurationValue,
  branchScheme: v14ConfigurationValue,
  transcriptsRoot: v14ConfigurationValue,
  controllerUrl: v14ConfigurationValue,
  decisionUrl: v14ConfigurationValue,
  agentHome: v14ConfigurationValue,
  plugins: z.array(v14HostPlugin).max(V14_MAX_PLUGIN_DIRS),
  agent: v14HostAgent.nullable().optional(),
});
const v14PendingRestart = z.array(z.string().min(1).max(64)).max(V14_MAX_CONFIGURE_ENTRIES);
const v14ProtocolRange = z.looseObject({ min: z.number().int().min(1), max: z.number().int().min(1) });

const v14SessionPayload = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('session_update'), body: v14JsonObject }),
  z.looseObject({ kind: z.literal('session_delta'), body: v14JsonObject }),
  z.looseObject({
    kind: z.literal('host_configure_result'),
    requestId: z.string().min(1),
    configuration: v14HostConfiguration,
    overriddenByEnvironment: z.array(z.string()),
    pendingRestart: v14PendingRestart,
    refusal: v14Refusal.nullable(),
  }),
]);

const v14ControlPayload = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('link_hello'),
    protocolVersion: z.number().int(),
    hostId: z.string().min(1),
    capabilities: z.array(z.string()),
    cursors: z.array(v14SessionCursor),
    configuration: v14HostConfiguration,
    pendingRestart: v14PendingRestart,
    protocolRange: v14ProtocolRange,
  }),
]);

const V14 = z.discriminatedUnion('frame', [
  z.looseObject({
    frame: z.literal('session'),
    sessionId: z.string().min(1),
    seq: z.number().int().positive(),
    at: z.string().min(1),
    payload: v14SessionPayload,
  }),
  z.looseObject({ frame: z.literal('control'), at: z.string().min(1), payload: v14ControlPayload }),
]);

/** The kinds `V14` models: everything this file's host is driven to send, bar the link's own chatter. */
const V14_KINDS = ['link_hello', 'session_update', 'session_delta', 'host_configure_result'];

/**
 * The decision request a protocol-14 controller's decision endpoint reads: `DecisionRequest` as
 * v1.5.0 declares it (`git show v1.5.0:src/gate/decision.ts`), every member required, unknown keys
 * carried. The body rides HTTP, not the link, so this is the shape rather than a codec.
 */
const V14_DECISION_REQUEST = z.looseObject({
  toolName: z.string(),
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

interface Sent {
  readonly kind: string;
  readonly raw: string;
  readonly payload: Record<string, unknown>;
}

function sentFrames(raw: readonly string[]): Sent[] {
  return raw.map((text) => {
    const parsed = JSON.parse(text) as { payload: Record<string, unknown> };
    return { kind: String(parsed.payload['kind']), raw: text, payload: parsed.payload };
  });
}

function bodyOf(sent: Sent): Record<string, unknown> {
  return (sent.payload['body'] ?? {}) as Record<string, unknown>;
}

test('a controller on protocol 14 decodes every frame a host of this build sends it', async () => {
  const peer = await peerOn({ welcomeVersion: 14, ack: true });
  const cwd = await tempDir('protocol-window');
  const agents = fakeAgents();
  const decided: DecisionRequest[] = [];
  const host = new PeriscopeHost({
    controllerUrl: peer.url,
    hostId: 'host-1',
    decide: async (request) => {
      decided.push(request);
      return allow();
    },
    protectedPaths: [],
    registry: new SessionRegistry({ baseEnv: {}, homeDir: cwd, startProcess: agents.start }),
    agentCatalog: () => Promise.resolve({ ok: true, agent: AGENT }),
  });

  try {
    host.start();
    await waitFor(() => host.link.negotiatedVersion === 14, 'the welcome at 14', TIMEOUT_MS);

    // A session, driven through each member protocol 12 added on the way out: a forwarded message
    // with its instant, a transition caused by a model switch and one by a refusal with no fallback.
    // And through the bodies protocol 15 added: the facts an init carries, and a streamed fragment.
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
      () => sentFrames(peer.raw).some((sent) => bodyOf(sent)['update'] === 'agent_fragment'),
      'the streamed fragment',
      TIMEOUT_MS,
    );

    const sent = sentFrames(peer.raw);
    const read = sent.filter((one) => V14_KINDS.includes(one.kind));
    const refused = read.flatMap((one) => {
      const decoded = V14.safeParse(JSON.parse(one.raw));
      return decoded.success
        ? []
        : [`${one.kind}: ${decoded.error.issues.map((issue) => issue.message).join('; ')}`];
    });
    assert.deepEqual(
      refused,
      [],
      `a protocol-14 controller refuses what this host sent:\n  ${refused.join('\n  ')}`,
    );

    // What was read carries protocol 12's members, so the green above is about them too.
    const hello = read.find((one) => one.kind === 'link_hello');
    assert.ok(hello !== undefined, 'the hello was captured');
    const helloConfiguration = hello.payload['configuration'] as Record<string, unknown>;
    assert.deepEqual(helloConfiguration['agent'], AGENT, 'the hello carries the catalog');
    assert.deepEqual(hello.payload['protocolRange'], { min: PROTOCOL_VERSION_MIN, max: PROTOCOL_VERSION });
    const answer = read.find((one) => one.kind === 'host_configure_result');
    assert.deepEqual((answer?.payload['configuration'] as Record<string, unknown>)['agent'], AGENT);
    assert.ok(
      read.some((one) => one.kind === 'session_update' && typeof bodyOf(one)['observedAt'] === 'string'),
      'a forwarded message carries its instant',
    );
    assert.ok(
      read.some((one) => one.raw.includes('"PostModelSwitch"')),
      'a transition caused by a model switch was sent',
    );
    // The bodies protocol 15 added were among what the protocol-14 decoder read, so the green above
    // covers them too.
    const facts = read.filter(
      (one) => one.kind === 'session_update' && bodyOf(one)['update'] === 'agent_facts',
    );
    assert.deepEqual(
      facts.map((one) => (bodyOf(one)['fact'] as Record<string, unknown>)['kind']),
      ['session_handle', 'agent_receipt'],
      'the init carried its facts',
    );
    assert.ok(
      read.some((one) => one.kind === 'session_delta' && bodyOf(one)['update'] === 'agent_fragment'),
      'a streamed fragment was sent',
    );

    // The members protocol 15 added to the hello, the configure answer and a transition were among
    // what the protocol-14 decoder read, so the green above covers them too.
    assert.deepEqual(helloConfiguration['agents'], [CLAUDE_ENTRY], 'the hello carries the runtimes list');
    assert.deepEqual(
      (answer?.payload['configuration'] as Record<string, unknown>)['agents'],
      [CLAUDE_ENTRY],
      'the configure answer carries the runtimes list',
    );
    const ready = read
      .filter((one) => one.kind === 'session_update')
      .map((one) => readStateTransition(bodyOf(one) as JsonObject))
      .find((transition) => transition?.to === 'ready');
    assert.deepEqual(
      ready?.controlTier,
      { level: 'intercepted', degrades: [] },
      'the first ready states the tier',
    );

    // The decision request a protocol-14 endpoint reads, with the two members it carries unread.
    assert.equal(decided.length, 1, 'the tool call was not asked about');
    const body = JSON.parse(JSON.stringify(decided[0])) as Record<string, unknown>;
    const asV14 = V14_DECISION_REQUEST.safeParse(body);
    assert.ok(asV14.success, asV14.success ? '' : asV14.error.message);
    assert.equal(body['toolKind'], 'shell');
    assert.equal(body['runtime'], 'claude');
  } finally {
    host.stop();
    await peer.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a controller on protocol 14 is read in turn: its configure, effort included, applies what it asks', async () => {
  const peer = await peerOn({ welcomeVersion: 14, ack: true });
  const cwd = await tempDir('protocol-window');
  const agents = fakeAgents();
  const host = new PeriscopeHost({
    controllerUrl: peer.url,
    hostId: 'host-1',
    decide: allow,
    protectedPaths: [],
    registry: new SessionRegistry({ baseEnv: {}, homeDir: cwd, startProcess: agents.start }),
  });

  try {
    host.start();
    await waitFor(() => host.link.negotiatedVersion === 14, 'the welcome at 14', TIMEOUT_MS);
    peer.send('session-1', 1, sessionNew(cwd));
    await waitFor(() => agents.started.length === 1, 'the session to start', TIMEOUT_MS);
    const agent = agents.started[0]!;
    agent.emit(initMessage('agent-1'));

    // The shape a protocol-14 controller sends: the effort member protocol 12 added, applied after
    // the model.
    const fromV14 = {
      kind: 'session_configure',
      model: 'model-b',
      permissionMode: null,
      thinking: null,
      effort: 'max',
    };
    peer.send('session-1', 2, fromV14 as SessionConfigure);
    await waitFor(() => agent.configured.length === 2, 'the configure to apply', TIMEOUT_MS);
    assert.deepEqual(agent.configured, [
      { setter: 'setModel', value: 'model-b' },
      { setter: 'setEffort', value: 'max' },
    ]);

    // The `session_new` a protocol-14 controller sends: a request with every member that release
    // declares and no `runtime`, which opens on this host's default runtime as it always did.
    const openedFromV14 = {
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
      },
    };
    peer.send('session-2', 1, openedFromV14 as SessionNew);
    await waitFor(() => agents.started.length === 2, 'the protocol-14 open to start a session', TIMEOUT_MS);
    assert.equal(agents.started[1]?.request.effort, 'high');
  } finally {
    host.stop();
    await peer.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a hello from a host one release behind, catalog and all, decodes on this build', () => {
  const wire = JSON.stringify({
    frame: 'control',
    at: '2000-01-01T00:00:00.000Z',
    payload: {
      kind: 'link_hello',
      protocolVersion: 14,
      hostId: 'host-1',
      capabilities: [],
      cursors: [],
      configuration: { ...unsetHostConfiguration(), agent: AGENT },
      pendingRestart: [],
      protocolRange: { min: 13, max: 14 },
    },
  });
  const decoded = decode(wire);
  assert.ok(decoded.ok, decoded.ok ? '' : decoded.refusal.detail);
  const payload = decoded.value.payload as unknown as { configuration: Record<string, unknown> };
  assert.deepEqual(payload.configuration['agent'], AGENT, 'the catalog is read as sent');
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
test('control: the protocol-14 decoder refuses what a version-14 controller refuses', () => {
  const hello = (configuration: Record<string, unknown>): unknown => ({
    frame: 'control',
    at: '2000-01-01T00:00:00.000Z',
    payload: {
      kind: 'link_hello',
      protocolVersion: 14,
      hostId: 'host-1',
      capabilities: [],
      cursors: [],
      configuration,
      pendingRestart: [],
      protocolRange: { min: 13, max: 14 },
    },
  });
  const { plugins: _plugins, ...version10 } = unsetHostConfiguration();

  assert.equal(
    V14.safeParse(hello({ ...unsetHostConfiguration(), agent: AGENT })).success,
    true,
    'a protocol-14 hello',
  );
  assert.equal(
    V14.safeParse(hello({ ...unsetHostConfiguration(), agent: { ...AGENT, models: 'all' } })).success,
    false,
    'a catalog whose models are not a list: the member protocol 12 added is checked',
  );
  assert.equal(
    V14.safeParse(hello({ ...unsetHostConfiguration(), plugins: 'loop' })).success,
    false,
    'a member whose type changed',
  );
  assert.equal(V14.safeParse(hello(version10)).success, false, 'a protocol-10 hello, which has no plugins');
});

// The same for the decision request's shape: it must refuse a body a protocol-14 endpoint refuses.
test('control: the protocol-14 decision request refuses a body with no sessionKey', () => {
  const request = {
    toolName: 'Bash',
    toolUseId: 'toolu_1',
    toolInput: { command: 'ls' },
    sessionId: 'agent-1',
    sessionKey: 'session-1',
    cwd: '/w',
    agentId: null,
    agentType: null,
  };
  assert.equal(V14_DECISION_REQUEST.safeParse(request).success, true, 'a protocol-14 decision request');
  const { sessionKey: _sessionKey, ...unkeyed } = request;
  assert.equal(V14_DECISION_REQUEST.safeParse(unkeyed).success, false, 'a request with no controller handle');
});
