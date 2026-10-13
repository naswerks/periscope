/**
 * Codex through a whole host: the hello's runtimes list, a session opened on Codex and what reaches
 * the wire from it, and the refusals a request meets before anything is spawned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  HostAgent,
  HostAgentEntry,
  HostConfiguration,
  JsonObject,
  SessionFrame,
  SessionPayload,
} from '../control/frames.js';
import {
  readAgentFacts,
  readAgentFragment,
  readAgentMessage,
  readStateTransition,
  sessionNew,
  sessionNewRequest,
} from '../control/frames.js';
import type { LinkHandlers } from '../control/link.js';
import { ok } from '../core/result.js';
import type { Result } from '../core/result.js';
import type { SessionTransition } from '../state/model.js';
import { FAKE_MODELS, fakeCodex } from '../test-support/fake-codex.js';
import type { FakeCodex } from '../test-support/fake-codex.js';
import type { CodexRuntimeRead } from './codex-runtime.js';
import { availableCodexEntry, codexHostModel, unavailableCodexEntry } from './codex-runtime.js';
import type { HostEvent, HostLink } from './host.js';
import { PeriscopeHost } from './host.js';

const HOME = 'C:/runner/codex-home';
const CWD = 'C:/work/session-1';

const CLAUDE: HostAgent = {
  claudeCodeVersion: '2.1.284',
  sdkVersion: '0.3.284',
  models: [
    {
      value: 'opus',
      resolvedModel: 'claude-opus-5-5',
      displayName: 'Opus',
      description: 'The model.',
      supportedEffortLevels: ['low', 'high'],
      supportsFastMode: null,
      supportsAutoMode: null,
      supportsAdaptiveThinking: true,
    },
  ],
};

const AVAILABLE = availableCodexEntry(
  '0.162.1',
  FAKE_MODELS.filter((model) => model['hidden'] !== true).map((model) => codexHostModel(model as never)),
);

class RecordingLink implements HostLink {
  readonly sent: { sessionId: string; payload: SessionPayload }[] = [];
  handlers: LinkHandlers | null = null;
  announced: HostConfiguration | null = null;
  send(sessionId: string, payload: SessionPayload): Result<void> {
    this.sent.push({ sessionId, payload });
    return ok(undefined);
  }
  start(): void {}
  stop(): void {}
  forgetSession(): void {}
  announce(_capabilities: readonly string[], configuration: HostConfiguration): void {
    this.announced = configuration;
  }
  deliver(sessionId: string, payload: SessionPayload, seq = 1): void {
    const frame: SessionFrame = { frame: 'session', sessionId, seq, at: '2026-10-12T00:00:00.000Z', payload };
    this.handlers?.onSessionFrame(frame);
  }
  bodies(): { lane: string; body: JsonObject }[] {
    return this.sent.map(({ payload }) => ({
      lane: payload.kind,
      body: (payload as unknown as { body: JsonObject }).body,
    }));
  }
  transitions(): SessionTransition[] {
    return this.bodies().flatMap(({ body }) => readStateTransition(body) ?? []);
  }
}

interface CodexHost {
  readonly host: PeriscopeHost;
  readonly link: RecordingLink;
  readonly fake: FakeCodex;
  readonly events: HostEvent[];
}

async function codexHost(read: CodexRuntimeRead = { entry: AVAILABLE, detail: null }): Promise<CodexHost> {
  const fake = fakeCodex({ codexHome: HOME });
  const link = new RecordingLink();
  const events: HostEvent[] = [];
  const host = new PeriscopeHost({
    controllerUrl: 'ws://unused',
    hostId: 'test-host',
    decide: async () => ({ behavior: 'allow' }),
    protectedPaths: [],
    baseEnv: { PATH: 'p' },
    homeDir: 'C:/nonexistent-home-for-tests',
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
    agentCatalog: async () => ({ ok: true, agent: CLAUDE }),
    codex: {
      runtime: {
        binary: 'C:/tools/codex.exe',
        home: HOME,
        clientVersion: '1.7.0',
        spawn: fake.spawn,
        killTree: () => Promise.resolve(),
        closeGraceMs: 20,
      },
      read: async () => read,
    },
    report: (event) => events.push(event),
  });
  host.start();
  await until(() => link.announced !== null, 'the hello');
  return { host, link, fake, events };
}

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const opening = (request: Parameters<typeof sessionNewRequest>[0]): ReturnType<typeof sessionNew> =>
  sessionNew(CWD, { request: sessionNewRequest({ runtime: 'codex', ...request }) });

// ---------------------------------------------------------------------------
// The hello
// ---------------------------------------------------------------------------

test("the hello lists Claude, then Codex: available, at tier intercepted-with-residual, with Codex's own vocabularies", async () => {
  const { host, link } = await codexHost();
  const agents = link.announced?.agents ?? [];
  assert.deepEqual(
    agents.map((entry) => entry.runtime),
    ['claude', 'codex'],
  );
  const codex = agents[1] as HostAgentEntry;
  assert.equal(codex.available, true);
  assert.deepEqual(codex.controlTier, { level: 'intercepted-with-residual', degrades: [] });
  assert.deepEqual(codex.vocabularies.permissionModes, ['default', 'dontAsk', 'bypassPermissions']);
  assert.deepEqual(codex.vocabularies.efforts, ['low', 'medium', 'high', 'none']);
  assert.equal(codex.vocabularies.thinking, true, 'a listed model takes none, so thinking off is honoured');
  assert.deepEqual(
    codex.models.map((model) => model.value),
    ['gpt-6-sol', 'gpt-6-luna'],
    'a hidden model was offered',
  );
  assert.equal(codex.sdkVersion, null);
  host.stop();
});

test('control: a catalog with no model that takes none gives no thinking control; no catalog, none either', () => {
  const noNone = availableCodexEntry('0.162.1', [
    codexHostModel({ id: 'm', displayName: 'M', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }),
  ]);
  assert.equal(noNone.vocabularies.thinking, false);
  assert.equal(availableCodexEntry('0.162.1', []).vocabularies.thinking, false);
});

test("a Codex entry too large for the hello rides with no models, named, and Claude's catalog is untouched", async () => {
  const description = 'x'.repeat(900);
  const huge = availableCodexEntry(
    '0.162.1',
    Array.from({ length: 32 }, (_, index) =>
      codexHostModel({
        id: `model-${index}`,
        displayName: `Model ${index}`,
        description,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      }),
    ),
  );
  assert.ok(
    new TextEncoder().encode(JSON.stringify(huge)).length > 16 * 1024,
    'the planted entry fits the budget alone',
  );
  const { host, link, events } = await codexHost({ entry: huge, detail: null });
  assert.ok(
    link.announced?.agent !== null && link.announced?.agent !== undefined,
    "Claude's catalog went null",
  );
  const agents = link.announced?.agents ?? [];
  assert.equal(agents[0]?.models.length, 1, "Claude's models were taken");
  assert.equal(agents[1]?.runtime, 'codex');
  assert.deepEqual(agents[1]?.models, []);
  const trimmed = events.find(
    (event) => event.kind === 'runtime-catalog' && event.detail?.includes('left out of the hello'),
  );
  assert.ok(trimmed !== undefined, 'the trim was not reported');
  host.stop();
});

// ---------------------------------------------------------------------------
// Opening a session on Codex
// ---------------------------------------------------------------------------

test('an unavailable Codex lists its reason in the hello, and a session on it is refused runtime-unavailable with it', async () => {
  const reason = 'the Codex binary C:/tools/codex.exe is Codex 0.163.0; this host is pinned to Codex 0.162.1';
  const { host, link, fake } = await codexHost({
    entry: unavailableCodexEntry('0.163.0', reason),
    detail: reason,
  });
  const codex = link.announced?.agents?.[1];
  assert.equal(codex?.available, false);
  assert.equal(codex?.unavailableReason, reason);
  link.deliver('handle-1', opening({}));
  await until(() => link.transitions().length > 0, 'the refused open');
  const refused = link.transitions()[0];
  assert.equal(refused?.to, 'ended');
  assert.equal(`${refused?.cause.kind}/${refused?.cause.event}`, 'refusal/runtime-unavailable');
  assert.match(refused?.cause.detail ?? '', /0\.163\.0; this host is pinned to Codex 0\.162\.1/);
  assert.equal(fake.child.spawned, null, 'a process was started for a refused open');
  host.stop();
});

test('a Codex session on the wire: its handle and receipt before ready, ready at tier intercepted-with-residual, its messages native and named', async () => {
  const { host, link, fake } = await codexHost();
  link.deliver('handle-1', opening({}));
  await until(
    () => link.transitions().some((transition) => transition.to === 'ready'),
    'the session to be ready',
  );
  const rows = link.bodies();
  const order = rows.map(({ body }) => {
    const transition = readStateTransition(body);
    if (transition !== null) return `transition:${transition.to}`;
    const fact = readAgentFacts(body);
    if (fact !== null) return `fact:${fact.fact.kind}`;
    const message = readAgentMessage(body);
    return message === null
      ? 'other'
      : `message:${typeof message['method'] === 'string' ? message['method'] : '?'}`;
  });
  assert.deepEqual(order.slice(0, 5), [
    'transition:spawning',
    'fact:session_handle',
    'fact:agent_receipt',
    'message:thread/started',
    'transition:ready',
  ]);
  const ready = link.transitions().find((transition) => transition.to === 'ready');
  assert.deepEqual(ready?.controlTier, { level: 'intercepted-with-residual', degrades: [] });
  assert.equal(`${ready?.cause.kind}/${ready?.cause.event}`, 'agent-event/codex:thread/started');
  assert.equal(ready?.sessionId, 'thread-1');
  const started = rows.find(({ body }) => readAgentMessage(body) !== null)?.body ?? {};
  assert.equal(started['runtime'], 'codex', 'a Codex message did not name its runtime');
  assert.deepEqual(readAgentMessage(started), {
    method: 'thread/started',
    params: { thread: { id: 'thread-1', cliVersion: '0.162.1' } },
  });
  void fake;
  host.stop();
});

test('a turn on the wire: working, a text fragment on the delta lane, a usage sample, the turn record, idle', async () => {
  const { host, link, fake } = await codexHost();
  link.deliver('handle-1', opening({}));
  await until(
    () => link.transitions().some((transition) => transition.to === 'ready'),
    'the session to be ready',
  );
  link.deliver('handle-1', { kind: 'session_prompt', text: 'hello' }, 2);
  await until(() => link.transitions().some((transition) => transition.to === 'working'), 'the turn to run');
  fake.server.notify('item/agentMessage/delta', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'msg-1',
    delta: 'Hel',
  });
  fake.server.notify('item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { type: 'commandExecution', id: 'call-1', command: 'ls' },
  });
  fake.server.notify('thread/tokenUsage/updated', {
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
  fake.server.completeTurn();
  await until(() => link.transitions().some((transition) => transition.to === 'idle'), 'the turn to end');

  const deltas = link.bodies().filter(({ lane }) => lane === 'session_delta');
  assert.equal(deltas[0]?.body['runtime'], 'codex');
  assert.equal(readAgentMessage(deltas[0]?.body ?? {})?.['method'], 'item/agentMessage/delta');
  assert.deepEqual(readAgentFragment(deltas[1]?.body ?? {}), {
    update: 'agent_fragment',
    runtime: 'codex',
    channel: 'text',
    text: 'Hel',
    parentId: null,
  });
  const tool = link.transitions().find((transition) => transition.activity?.kind === 'tool');
  assert.deepEqual(tool?.activity, { kind: 'tool', name: 'Bash' });
  const facts = link.bodies().flatMap(({ body }) => readAgentFacts(body) ?? []);
  const record = facts.find((fact) => fact.fact.kind === 'turn_record');
  assert.equal(record?.sourceId, 'turn-1', 'the turn record does not name its turn');
  assert.equal(record?.fact.kind === 'turn_record' ? record.fact.turn : 'missing', null);
  assert.equal(facts.filter((fact) => fact.fact.kind === 'usage_sample').length, 1);
  const idle = link.transitions().find((transition) => transition.to === 'idle');
  assert.equal(`${idle?.cause.kind}/${idle?.cause.event}`, 'agent-event/codex:turn/completed');
  host.stop();
});

// ---------------------------------------------------------------------------
// Refused before anything is spawned
// ---------------------------------------------------------------------------

test("a Codex session naming a member that is Claude's alone, or a value Codex does not take, is refused by name", async () => {
  const cases: [Parameters<typeof sessionNewRequest>[0], string, RegExp][] = [
    [{ settingSources: ['project'] }, 'request-key-unsupported', /^settingSources/],
    [{ forwardSubagentText: true }, 'request-key-unsupported', /^forwardSubagentText/],
    [
      { permissionMode: 'acceptEdits' },
      'request-key-unsupported',
      /^permissionMode: runtime codex takes default, dontAsk, bypassPermissions, not acceptEdits/,
    ],
    [
      { systemPrompt: { type: 'preset', preset: 'claude_code', append: 'x' } },
      'request-key-unsupported',
      /^systemPrompt/,
    ],
    [
      { effort: 'xhigh' },
      'request-key-unsupported',
      /^effort: runtime codex takes low, medium, high, none, not xhigh/,
    ],
    [{ endpoint: 'deepseek' }, 'endpoint-unknown', /deepseek/],
  ];
  for (const [request, reason, detail] of cases) {
    const { host, link, fake } = await codexHost();
    link.deliver('handle-1', opening(request));
    await until(() => link.transitions().length > 0, `the refusal for ${JSON.stringify(request)}`);
    const refused = link.transitions()[0];
    assert.equal(
      `${refused?.cause.kind}/${refused?.cause.event}`,
      `refusal/${reason}`,
      JSON.stringify(request),
    );
    assert.match(refused?.cause.detail ?? '', detail);
    assert.equal(fake.child.spawned, null);
    host.stop();
  }
});

test('a Codex session takes an effort word only Codex has, and the runtime-default prompt', async () => {
  const { host, link, fake } = await codexHost();
  link.deliver(
    'handle-1',
    opening({
      effort: 'none',
      systemPrompt: { type: 'preset', preset: 'runtime-default', append: 'Be brief.' },
    }),
  );
  await until(
    () => link.transitions().some((transition) => transition.to === 'ready'),
    'the session to be ready',
  );
  const start = (fake.server.requestsOf('thread/start')[0]?.['params'] ?? {}) as JsonObject;
  assert.equal((start['config'] as JsonObject)['model_reasoning_effort'], 'none');
  assert.equal(start['developerInstructions'], 'Be brief.');
  host.stop();
});

test("configure on a Codex session: an effort outside Codex's words is refused as a value; a mode it does not take, by its process", async () => {
  const { host, link } = await codexHost();
  link.deliver('handle-1', opening({}));
  await until(
    () => link.transitions().some((transition) => transition.to === 'ready'),
    'the session to be ready',
  );
  const configure = (asked: JsonObject): JsonObject => ({
    kind: 'session_configure',
    model: null,
    permissionMode: null,
    thinking: null,
    effort: null,
    ...asked,
  });
  link.deliver('handle-1', configure({ effort: 'ultra' }) as never, 2);
  link.deliver('handle-1', configure({ permissionMode: 'plan' }) as never, 3);
  await until(
    () => link.transitions().filter((transition) => transition.cause.kind === 'refusal').length === 2,
    'both refusals',
  );
  const refusals = link.transitions().filter((transition) => transition.cause.kind === 'refusal');
  assert.equal(refusals[0]?.cause.event, 'frame-malformed');
  assert.match(
    refusals[0]?.cause.detail ?? '',
    /the levels this runtime declares are low, medium, high, none/,
  );
  assert.equal(refusals[1]?.cause.event, 'session-configure-failed');
  assert.match(
    refusals[1]?.cause.detail ?? '',
    /setting permissionMode failed: Codex takes default, dontAsk, bypassPermissions, not plan/,
  );
  host.stop();
});
