/**
 * The window's promise, checked against the peer it is made to: a controller on protocol 12 reads
 * everything this host sends it, and this host reads everything that controller sends.
 *
 * `V12` below is that controller's decoder: the protocol-12 schemas transcribed from the codec the
 * v1.3.0 tag ships (`git show v1.3.0:src/control/codec.ts`), cut to the kinds this file reads, with
 * that release's bounds written as numbers. It describes a released peer, so it never changes to
 * follow this build; an edit here that turns a test green changes the contract rather than fixing
 * it. The frames it reads are the bytes a real link carried, from a host the peer welcomed at 12.
 * Protocol 13 adds no member to a kind such a controller receives (its one new answer answers an ask
 * that controller never sends), so what is read here is the traffic it does receive, protocol 12's
 * own members included.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { z } from 'zod';

import { decode } from '../control/codec.js';
import type { HostAgent, JsonObject, JsonValue, SessionConfigure } from '../control/frames.js';
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MIN,
  hostConfigure,
  readObservedAt,
  sessionNew,
  unsetHostConfiguration,
} from '../control/frames.js';
import { SessionRegistry } from '../sessions/registry.js';
import { fakeAgents, initMessage } from '../test-support/fake-agent.js';
import { tempDir } from '../test-support/temp-dir.js';
import { peerOn, waitFor } from '../test-support/ws-peer.js';
import type { HookInput, SDKMessage } from './agent-process.js';
import { PeriscopeHost } from './host.js';
import { readSessionConfigure } from './wire-request.js';

// ---------------------------------------------------------------------------
// The protocol-12 decoder, as v1.3.0 shipped it.
// ---------------------------------------------------------------------------

const V12_MAX_CONFIGURATION_VALUE_LENGTH = 1000;
const V12_MAX_PLUGIN_DIRS = 8;
const V12_MAX_CONFIGURE_ENTRIES = 8;
const V12_MAX_AGENT_MODELS = 32;

const v12JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(v12JsonValue),
    z.record(z.string(), v12JsonValue),
  ]),
);
const v12JsonObject = z.record(z.string(), v12JsonValue);
const v12Refusal = z.looseObject({ reason: z.string().min(1), detail: z.string() });
const v12SessionCursor = z.looseObject({ sessionId: z.string().min(1), seq: z.number().int().nonnegative() });
const v12ConfigurationValue = z.string().max(V12_MAX_CONFIGURATION_VALUE_LENGTH).nullable();
const v12HostPlugin = z.looseObject({
  name: z.string().min(1).max(200),
  version: z.string().max(64).nullable(),
  path: z.string().min(1).max(V12_MAX_CONFIGURATION_VALUE_LENGTH),
});
const v12AgentModelText = z.string().min(1).max(200);
const v12HostModel = z.looseObject({
  value: v12AgentModelText,
  resolvedModel: v12AgentModelText.nullable(),
  displayName: z.string().max(200),
  description: z.string().max(V12_MAX_CONFIGURATION_VALUE_LENGTH).nullable(),
  supportedEffortLevels: z.array(z.string().min(1).max(32)).max(16),
  supportsFastMode: z.boolean().nullable(),
  supportsAutoMode: z.boolean().nullable(),
  supportsAdaptiveThinking: z.boolean().nullable(),
});
const v12HostAgent = z.looseObject({
  claudeCodeVersion: z.string().min(1).max(64),
  sdkVersion: z.string().min(1).max(64),
  models: z.array(v12HostModel).max(V12_MAX_AGENT_MODELS),
});
const v12HostConfiguration = z.looseObject({
  repositoryRoot: v12ConfigurationValue,
  workspaceRoot: v12ConfigurationValue,
  branchScheme: v12ConfigurationValue,
  transcriptsRoot: v12ConfigurationValue,
  controllerUrl: v12ConfigurationValue,
  decisionUrl: v12ConfigurationValue,
  agentHome: v12ConfigurationValue,
  plugins: z.array(v12HostPlugin).max(V12_MAX_PLUGIN_DIRS),
  agent: v12HostAgent.nullable().optional(),
});
const v12PendingRestart = z.array(z.string().min(1).max(64)).max(V12_MAX_CONFIGURE_ENTRIES);
const v12ProtocolRange = z.looseObject({ min: z.number().int().min(1), max: z.number().int().min(1) });

const v12SessionPayload = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('session_update'), body: v12JsonObject }),
  z.looseObject({ kind: z.literal('session_delta'), body: v12JsonObject }),
  z.looseObject({
    kind: z.literal('host_configure_result'),
    requestId: z.string().min(1),
    configuration: v12HostConfiguration,
    overriddenByEnvironment: z.array(z.string()),
    pendingRestart: v12PendingRestart,
    refusal: v12Refusal.nullable(),
  }),
]);

const v12ControlPayload = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('link_hello'),
    protocolVersion: z.number().int(),
    hostId: z.string().min(1),
    capabilities: z.array(z.string()),
    cursors: z.array(v12SessionCursor),
    configuration: v12HostConfiguration,
    pendingRestart: v12PendingRestart,
    protocolRange: v12ProtocolRange,
  }),
]);

const V12 = z.discriminatedUnion('frame', [
  z.looseObject({
    frame: z.literal('session'),
    sessionId: z.string().min(1),
    seq: z.number().int().positive(),
    at: z.string().min(1),
    payload: v12SessionPayload,
  }),
  z.looseObject({ frame: z.literal('control'), at: z.string().min(1), payload: v12ControlPayload }),
]);

/** The kinds `V12` models: everything this file's host is driven to send, bar the link's own chatter. */
const V12_KINDS = ['link_hello', 'session_update', 'session_delta', 'host_configure_result'];

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

test('a controller on protocol 12 decodes every frame a host of this build sends it', async () => {
  const peer = await peerOn({ welcomeVersion: 12, ack: true });
  const cwd = await tempDir('protocol-window');
  const agents = fakeAgents();
  const host = new PeriscopeHost({
    controllerUrl: peer.url,
    hostId: 'host-1',
    decide: allow,
    protectedPaths: [],
    registry: new SessionRegistry({ baseEnv: {}, homeDir: cwd, startProcess: agents.start }),
    agentCatalog: () => Promise.resolve({ ok: true, agent: AGENT }),
  });

  try {
    host.start();
    await waitFor(() => host.link.negotiatedVersion === 12, 'the welcome at 12', TIMEOUT_MS);

    // A session, driven through each member protocol 12 added on the way out: a forwarded message
    // with its instant, a transition caused by a model switch and one by a refusal with no fallback.
    peer.send('session-1', 1, sessionNew(cwd));
    await waitFor(() => agents.started.length === 1, 'the session to start', TIMEOUT_MS);
    const agent = agents.started[0]!;
    agent.emit(initMessage('agent-1'));
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

    const sent = sentFrames(peer.raw);
    const read = sent.filter((one) => V12_KINDS.includes(one.kind));
    const refused = read.flatMap((one) => {
      const decoded = V12.safeParse(JSON.parse(one.raw));
      return decoded.success
        ? []
        : [`${one.kind}: ${decoded.error.issues.map((issue) => issue.message).join('; ')}`];
    });
    assert.deepEqual(
      refused,
      [],
      `a protocol-12 controller refuses what this host sent:\n  ${refused.join('\n  ')}`,
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
  } finally {
    host.stop();
    await peer.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a controller on protocol 12 is read in turn: its configure, effort included, applies what it asks', async () => {
  const peer = await peerOn({ welcomeVersion: 12, ack: true });
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
    await waitFor(() => host.link.negotiatedVersion === 12, 'the welcome at 12', TIMEOUT_MS);
    peer.send('session-1', 1, sessionNew(cwd));
    await waitFor(() => agents.started.length === 1, 'the session to start', TIMEOUT_MS);
    const agent = agents.started[0]!;
    agent.emit(initMessage('agent-1'));

    // The protocol-12 shape: the effort member it added, applied after the model.
    const fromV12 = {
      kind: 'session_configure',
      model: 'model-b',
      permissionMode: null,
      thinking: null,
      effort: 'max',
    };
    peer.send('session-1', 2, fromV12 as SessionConfigure);
    await waitFor(() => agent.configured.length === 2, 'the configure to apply', TIMEOUT_MS);
    assert.deepEqual(agent.configured, [
      { setter: 'setModel', value: 'model-b' },
      { setter: 'setEffort', value: 'max' },
    ]);
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
      protocolVersion: 12,
      hostId: 'host-1',
      capabilities: [],
      cursors: [],
      configuration: { ...unsetHostConfiguration(), agent: AGENT },
      pendingRestart: [],
      protocolRange: { min: 11, max: 12 },
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
test('control: the protocol-12 decoder refuses what a version-12 controller refuses', () => {
  const hello = (configuration: Record<string, unknown>): unknown => ({
    frame: 'control',
    at: '2000-01-01T00:00:00.000Z',
    payload: {
      kind: 'link_hello',
      protocolVersion: 12,
      hostId: 'host-1',
      capabilities: [],
      cursors: [],
      configuration,
      pendingRestart: [],
      protocolRange: { min: 11, max: 12 },
    },
  });
  const { plugins: _plugins, ...version10 } = unsetHostConfiguration();

  assert.equal(
    V12.safeParse(hello({ ...unsetHostConfiguration(), agent: AGENT })).success,
    true,
    'a protocol-12 hello',
  );
  assert.equal(
    V12.safeParse(hello({ ...unsetHostConfiguration(), agent: { ...AGENT, models: 'all' } })).success,
    false,
    'a catalog whose models are not a list: the member protocol 12 added is checked',
  );
  assert.equal(
    V12.safeParse(hello({ ...unsetHostConfiguration(), plugins: 'loop' })).success,
    false,
    'a member whose type changed',
  );
  assert.equal(V12.safeParse(hello(version10)).success, false, 'a protocol-10 hello, which has no plugins');
});
