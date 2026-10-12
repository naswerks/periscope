/**
 * The codec over what protocol 15 adds for model endpoints: the hello's endpoints list and a
 * request's endpoint. Tolerant in, strict out, as for every vocabulary on the wire. And the hello as a
 * whole, with every bound filled, still fits one frame.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decode, encode, hostAgentProblem, hostAgentsProblem, hostEndpointsProblem } from './codec.js';
import type {
  Frame,
  HostAgent,
  HostAgentEntry,
  HostConfiguration,
  HostEndpoint,
  HostModel,
} from './frames.js';
import {
  MAX_AGENT_CATALOG_BYTES,
  MAX_AGENT_ENTRIES,
  MAX_AGENT_MODELS,
  MAX_CONFIGURATION_VALUE_LENGTH,
  MAX_CONFIGURE_ENTRIES,
  MAX_ENDPOINT_CATALOG_BYTES,
  MAX_ENDPOINT_MODELS,
  MAX_ENDPOINTS,
  MAX_FRAME_BYTES,
  MAX_PLUGIN_DIRS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MIN,
  sessionNew,
  sessionNewRequest,
  unsetHostConfiguration,
} from './frames.js';
import { DEFAULT_MAX_SESSIONS } from '../sessions/registry.js';

const AT = '2000-01-01T00:00:00.000Z';

const ENDPOINT: HostEndpoint = {
  name: 'deepseek',
  wireApi: 'anthropic-messages',
  runtimes: ['claude'],
  models: ['deepseek-flash[1m]', 'deepseek-flash', 'opus', 'sonnet', 'haiku'],
};

const hello = (configuration: HostConfiguration | Record<string, unknown>): Frame =>
  ({
    frame: 'control',
    at: AT,
    payload: {
      kind: 'link_hello',
      protocolVersion: PROTOCOL_VERSION,
      hostId: 'host-1',
      capabilities: [],
      cursors: [],
      configuration,
      pendingRestart: [],
      protocolRange: { min: PROTOCOL_VERSION_MIN, max: PROTOCOL_VERSION },
    },
  }) as unknown as Frame;

const withEndpoints = (endpoints: unknown): Record<string, unknown> => ({
  ...unsetHostConfiguration(),
  endpoints,
});

function roundTrip(frame: Frame): Frame {
  const encoded = encode(frame);
  assert.ok(encoded.ok, encoded.ok ? '' : encoded.refusal.detail);
  const decoded = decode(encoded.value);
  assert.ok(decoded.ok, decoded.ok ? '' : decoded.refusal.detail);
  return decoded.value;
}

test("a hello's endpoints list round-trips, and a hello without one still decodes", () => {
  const frame = hello(withEndpoints([ENDPOINT]));
  assert.deepEqual(roundTrip(frame), frame);
  assert.deepEqual(roundTrip(hello(unsetHostConfiguration())), hello(unsetHostConfiguration()));
});

test("a request's endpoint round-trips as a bounded word; empty or past the bound, it is refused", () => {
  const named = {
    frame: 'session',
    sessionId: 'session-1',
    seq: 1,
    at: AT,
    payload: sessionNew('/w', { request: sessionNewRequest({ endpoint: 'deepseek' }) }),
  } as Frame;
  assert.deepEqual(roundTrip(named), named);
  for (const endpoint of ['', 'x'.repeat(65)]) {
    const wire = JSON.stringify({
      ...named,
      payload: { ...(named as { payload: object }).payload, request: { ...sessionNewRequest(), endpoint } },
    });
    const decoded = decode(wire);
    assert.equal(decoded.ok, false, `endpoint of length ${endpoint.length} decoded`);
  }
});

test('control: the bound decodes and one past it is refused', () => {
  const at = Array.from({ length: MAX_ENDPOINTS }, (_, index) => ({
    ...ENDPOINT,
    name: `endpoint-${index}`,
  }));
  assert.equal(decode(JSON.stringify(hello(withEndpoints(at)))).ok, true, 'the bound itself was refused');
  const past = [...at, { ...ENDPOINT, name: 'one-too-many' }];
  assert.equal(decode(JSON.stringify(hello(withEndpoints(past)))).ok, false, 'one past the bound decoded');
  const tooManyModels = [
    { ...ENDPOINT, models: Array.from({ length: MAX_ENDPOINT_MODELS + 1 }, (_, i) => `m-${i}`) },
  ];
  assert.equal(decode(JSON.stringify(hello(withEndpoints(tooManyModels)))).ok, false);
});

test('a malformed endpoint entry is refused beside its well-formed twin', () => {
  assert.equal(decode(JSON.stringify(hello(withEndpoints([ENDPOINT])))).ok, true);
  assert.equal(decode(JSON.stringify(hello(withEndpoints([{ ...ENDPOINT, models: 'all' }])))).ok, false);
  assert.equal(decode(JSON.stringify(hello(withEndpoints([{ ...ENDPOINT, runtimes: null }])))).ok, false);
});

test('a wire API a newer peer adds is read on the way in, and one this host does not declare is refused on the way out', () => {
  const newer = { ...ENDPOINT, wireApi: 'a-wire-api-from-a-newer-peer' };
  assert.equal(
    decode(JSON.stringify(hello(withEndpoints([newer])))).ok,
    true,
    'a newer wire API was refused on decode',
  );
  const sent = encode(hello(withEndpoints([newer])));
  assert.equal(sent.ok, false, 'an undeclared wire API was sent');
  assert.match(
    sent.ok ? '' : sent.refusal.detail,
    /endpoints\.0\.wireApi "a-wire-api-from-a-newer-peer" is not a word this host declares/,
  );
  assert.match(
    hostEndpointsProblem([newer as unknown as HostEndpoint]) ?? '',
    /is not a wire API this host declares/,
  );
});

test('the endpoints list is held to its own byte budget', () => {
  assert.equal(hostEndpointsProblem([ENDPOINT]), null);
  const long = Array.from({ length: MAX_ENDPOINTS }, (_, index) => ({
    ...ENDPOINT,
    name: `endpoint-${index}`,
    models: Array.from({ length: MAX_ENDPOINT_MODELS }, (_, i) => `${'m'.repeat(60)}-${i}`),
  }));
  assert.match(
    hostEndpointsProblem(long) ?? '',
    new RegExp(`over the ${MAX_ENDPOINT_CATALOG_BYTES} a hello gives it`),
  );
});

// ---------------------------------------------------------------------------
// The whole hello, every bound filled.
// ---------------------------------------------------------------------------

const utf8Length = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** The largest `n` (up to `max`) for which `make(n)` fits `budget` as JSON, by bisection. */
function fill<T>(budget: number, max: number, make: (n: number) => T): T {
  let low = 0;
  let high = max;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Length(make(middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return make(low);
}

const model = (description: number, index: number): HostModel => ({
  value: `model-${index}`,
  resolvedModel: `resolved-model-${index}`,
  displayName: `Model ${index}`,
  description: 'x'.repeat(description),
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportsFastMode: true,
  supportsAutoMode: true,
  supportsAdaptiveThinking: true,
});

test('a hello with every bound filled encodes under MAX_FRAME_BYTES, so no list growing to its own bound can drop the frame', () => {
  const agent = fill<HostAgent>(MAX_AGENT_CATALOG_BYTES, MAX_CONFIGURATION_VALUE_LENGTH, (n) => ({
    claudeCodeVersion: 'c'.repeat(64),
    sdkVersion: 's'.repeat(64),
    models: Array.from({ length: MAX_AGENT_MODELS }, (_, index) => model(n, index)),
  }));
  const entry = (description: number, index: number): HostAgentEntry => ({
    runtime: `runtime-${index}`,
    version: 'v'.repeat(64),
    sdkVersion: 's'.repeat(64),
    models: [model(description, index)],
    vocabularies: {
      permissionModes: Array.from({ length: 16 }, (_, i) => `mode-${i}-${'p'.repeat(20)}`),
      efforts: Array.from({ length: 16 }, (_, i) => `effort-${i}-${'e'.repeat(20)}`),
      thinking: true,
    },
    controlTier: { level: 'intercepted', degrades: [] },
    available: false,
    unavailableReason: 'u'.repeat(200),
  });
  const agents = fill<HostAgentEntry[]>(MAX_AGENT_CATALOG_BYTES, MAX_CONFIGURATION_VALUE_LENGTH, (n) =>
    Array.from({ length: MAX_AGENT_ENTRIES }, (_, index) => entry(n, index)),
  );
  const endpoints = fill<HostEndpoint[]>(MAX_ENDPOINT_CATALOG_BYTES, 190, (n) =>
    Array.from({ length: MAX_ENDPOINTS }, (_, index) => ({
      name: `endpoint-${index}-${'n'.repeat(40)}`,
      wireApi: 'anthropic-messages',
      runtimes: ['claude'],
      models: Array.from({ length: MAX_ENDPOINT_MODELS }, (_, i) => `${i}-${'m'.repeat(n)}`),
    })),
  );

  // Each list is accepted as the host would accept it, and each sits within a hundred bytes of its own
  // budget: a pin over half-empty lists would prove nothing about the bounds.
  assert.equal(hostAgentProblem(agent), null);
  assert.equal(hostAgentsProblem(agents), null);
  assert.equal(hostEndpointsProblem(endpoints), null);
  for (const [name, value, budget] of [
    ['agent', agent, MAX_AGENT_CATALOG_BYTES],
    ['agents', agents, MAX_AGENT_CATALOG_BYTES],
    ['endpoints', endpoints, MAX_ENDPOINT_CATALOG_BYTES],
  ] as const) {
    assert.ok(
      budget - utf8Length(value) < 1_000,
      `${name} is ${utf8Length(value)} bytes, far under its ${budget}`,
    );
  }

  const value = 'p'.repeat(MAX_CONFIGURATION_VALUE_LENGTH);
  const configuration: HostConfiguration = {
    repositoryRoot: value,
    workspaceRoot: value,
    branchScheme: value,
    transcriptsRoot: value,
    controllerUrl: value,
    decisionUrl: value,
    agentHome: value,
    plugins: Array.from({ length: MAX_PLUGIN_DIRS }, () => ({
      name: 'n'.repeat(200),
      version: 'v'.repeat(64),
      path: value,
    })),
    agent,
    agents,
    endpoints,
  };
  // The three members the codec leaves unbounded are taken at what this host ships: a handful of
  // capability markers, a host id, and one cursor per session up to the default session bound.
  const frame: Frame = {
    frame: 'control',
    at: AT,
    payload: {
      kind: 'link_hello',
      protocolVersion: PROTOCOL_VERSION,
      hostId: 'h'.repeat(64),
      capabilities: ['bulk-post', 'workspace:git-worktree', 'workspace:branch-scheme'],
      cursors: Array.from({ length: DEFAULT_MAX_SESSIONS }, (_, index) => ({
        sessionId: `${index}`.padEnd(36, 'f'),
        seq: Number.MAX_SAFE_INTEGER,
      })),
      configuration,
      pendingRestart: Array.from({ length: MAX_CONFIGURE_ENTRIES }, () => 'k'.repeat(64)),
      protocolRange: { min: PROTOCOL_VERSION_MIN, max: PROTOCOL_VERSION },
    },
  };
  const encoded = encode(frame);
  assert.ok(encoded.ok, encoded.ok ? '' : encoded.refusal.detail);
  const bytes = new TextEncoder().encode(encoded.value).length;
  assert.ok(bytes <= MAX_FRAME_BYTES, `the filled hello is ${bytes} bytes, over ${MAX_FRAME_BYTES}`);
});
