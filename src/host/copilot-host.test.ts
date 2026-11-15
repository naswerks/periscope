/**
 * Copilot through a whole host: the hello's runtimes list and its pack row, a session opened on Copilot and
 * what reaches the wire from it, a decision request for one of its calls, the local gate on Copilot's own
 * tool names, the deadline this runtime admits, a server it has no form for, and a Copilot this host cannot
 * run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  HostAgent,
  HostConfiguration,
  JsonObject,
  SessionFrame,
  SessionPayload,
} from '../control/frames.js';
import {
  readAgentFacts,
  readAgentItem,
  readStateTransition,
  sessionNew,
  sessionNewRequest,
} from '../control/frames.js';
import type { LinkHandlers } from '../control/link.js';
import { ok } from '../core/result.js';
import type { Result } from '../core/result.js';
import type { DecisionRequest } from '../gate/decision.js';
import type { SessionTransition } from '../state/model.js';
import { fakeCopilot } from '../test-support/fake-copilot.js';
import type { FakeCopilotOptions, FakeCopilotRecord } from '../test-support/fake-copilot.js';
import { tempDir } from '../test-support/temp-dir.js';
import { COPILOT_MEASURED_PERMISSION_WAIT_MS } from './copilot-gate.js';
import type { CopilotRuntimeRead } from './copilot-runtime.js';
import { availableCopilotEntry, unavailableCopilotEntry } from './copilot-runtime.js';
import type { WorkspaceProvider } from '../workspace/provider.js';
import type { HostEvent, HostLink } from './host.js';
import { PeriscopeHost } from './host.js';
import { composeSession } from './host.js';

const CWD = process.platform === 'win32' ? 'C:/work/session-1' : '/work/session-1';
const CLAUDE: HostAgent = { claudeCodeVersion: '2.1.284', sdkVersion: '0.3.284', models: [] };

class RecordingLink implements HostLink {
  readonly sent: { sessionId: string; payload: SessionPayload }[] = [];
  handlers: LinkHandlers | null = null;
  announced: HostConfiguration | null = null;
  negotiatedVersion: number | null = 20;
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
    const frame: SessionFrame = { frame: 'session', sessionId, seq, at: '2026-11-15T00:00:00.000Z', payload };
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

interface CopilotHost {
  readonly host: PeriscopeHost;
  readonly link: RecordingLink;
  readonly record: FakeCopilotRecord;
  readonly decided: DecisionRequest[];
  readonly events: HostEvent[];
  readonly base: string;
}

async function copilotHost(
  options: {
    read?: CopilotRuntimeRead;
    fake?: FakeCopilotOptions;
    protect?: (base: string) => readonly string[];
    baseEnv?: Readonly<Record<string, string>>;
    workspaces?: WorkspaceProvider;
    repositories?: ReadonlyMap<string, WorkspaceProvider>;
  } = {},
): Promise<CopilotHost> {
  const base = await tempDir('copilot-host');
  const { sdk, record } = fakeCopilot(options.fake);
  const link = new RecordingLink();
  const events: HostEvent[] = [];
  const decided: DecisionRequest[] = [];
  const host = new PeriscopeHost({
    controllerUrl: 'ws://unused',
    hostId: 'test-host',
    decide: (request) => {
      decided.push(request);
      return Promise.resolve({ behavior: 'allow' });
    },
    protectedPaths: options.protect?.(base) ?? [],
    baseEnv: options.baseEnv ?? { PATH: 'p' },
    homeDir: base,
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
    ...(options.repositories === undefined ? {} : { repositories: new Map(options.repositories) }),
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
    agentCatalog: async () => ({ ok: true, agent: CLAUDE }),
    copilot: {
      runtime: {
        sdk: 'C:/sdk',
        base,
        readInstall: () =>
          ok({
            directory: 'C:/sdk',
            entry: 'C:/sdk/index.js',
            runtime: 'C:/sdk/runtime.exe',
            sdkVersion: '1.0.34',
            runtimeVersion: '1.0.112',
          }),
        loadSdk: () => Promise.resolve(ok(sdk)),
        policyHooks: () => Promise.resolve({ found: [], unread: [] }),
        killTree: () => Promise.resolve(),
        closeGraceMs: 20,
      },
      read: async () => options.read ?? { entry: availableCopilotEntry(), detail: null },
    },
    report: (event) => events.push(event),
  });
  host.start();
  await until(() => link.announced !== null, 'the hello');
  return { host, link, record, decided, events, base };
}

async function stopped(run: CopilotHost): Promise<void> {
  run.host.stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await rm(run.base, { recursive: true, force: true });
}

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const causesOf = (link: RecordingLink): string[] =>
  link.transitions().map((transition) => `${transition.cause.kind}/${transition.cause.event}`);

test('the hello lists Copilot after Claude, at its tier, with its versions and vocabularies, and its pack row', async () => {
  const run = await copilotHost();
  try {
    const agents = run.link.announced?.agents ?? [];
    assert.deepEqual(
      agents.map((entry) => entry.runtime),
      ['claude', 'copilot'],
    );
    assert.deepEqual(agents[1], availableCopilotEntry());
    assert.deepEqual(
      (run.link.announced?.agentSkills ?? []).find((row) => row.runtime === 'copilot'),
      {
        runtime: 'copilot',
        naming: 'bare',
        delivery: 'per-session',
      },
    );
    assert.ok(run.events.some((event) => event.kind === 'runtime-catalog' && event.runtime === 'copilot'));
  } finally {
    await stopped(run);
  }
});

test("a session on Copilot opens ready at its tier once its open is proven; a prompt runs through the gate to idle; its facts, items and events ride the wire as Copilot's", async () => {
  const run = await copilotHost({
    fake: {
      calls: () => [
        { toolName: 'powershell', toolArgs: { command: 'git status' }, toolCallId: 'call_shell' },
      ],
    },
  });
  try {
    run.link.deliver('session-1', sessionNew(CWD, { request: sessionNewRequest({ runtime: 'copilot' }) }));
    await until(() => run.link.transitions().some((one) => one.to === 'ready'), 'the session to be ready');
    const ready = run.link.transitions().find((one) => one.to === 'ready');
    assert.equal(`${ready?.cause.kind}/${ready?.cause.event}`, 'agent-event/copilot:session.start');
    assert.deepEqual(ready?.controlTier, { level: 'intercepted-with-residual', degrades: [] });
    assert.equal(run.decided.length, 0, "the open's probe asked nobody");
    run.link.deliver('session-1', { kind: 'session_prompt', text: 'status please' }, 2);
    await until(() => run.link.transitions().some((one) => one.to === 'idle'), 'the run to settle');
    const causes = causesOf(run.link);
    const run1 = causes.slice(causes.indexOf('agent-event/copilot:user.message'));
    assert.equal(run1[0], 'agent-event/copilot:user.message', causes.join(', '));
    assert.equal(run1.at(-1), 'agent-event/copilot:session.idle', causes.join(', '));
    assert.equal(run.decided.length, 1, 'the call was not asked about');
    const request = JSON.parse(JSON.stringify(run.decided[0])) as Record<string, unknown>;
    assert.deepEqual(
      [
        request['runtime'],
        request['toolName'],
        request['toolKind'],
        request['shellDialect'],
        request['toolUseId'],
        request['sessionKey'],
      ],
      ['copilot', 'powershell', 'shell', 'powershell', 'call_shell', 'session-1'],
    );
    await until(
      () => run.link.bodies().some(({ body }) => readAgentFacts(body)?.fact.kind === 'turn_record'),
      'the spend',
    );
    const kinds = run.link.bodies().flatMap(({ body }) => {
      const read = readAgentFacts(body);
      return read === null ? [] : [read.fact.kind];
    });
    for (const kind of ['session_handle', 'agent_receipt', 'turn_record']) {
      assert.ok(kinds.includes(kind as never), `${kind} among ${kinds.join(', ')}`);
    }
    const items = run.link.bodies().flatMap(({ body }) => {
      const read = readAgentItem(body);
      return read === null ? [] : [read.item.kind];
    });
    for (const kind of ['turn', 'user_text', 'tool_call', 'tool_result', 'agent_text']) {
      assert.ok(items.includes(kind as never), `${kind} among ${items.join(', ')}`);
    }
    assert.ok(
      run.link
        .bodies()
        .some(({ body }) => body['update'] === 'agent_message' && body['runtime'] === 'copilot'),
    );
  } finally {
    await stopped(run);
  }
});

test("the local gate reads Copilot's own tool names: a read of a protected file is refused before anything is asked", async () => {
  const where = { secret: '' };
  const run = await copilotHost({
    protect: (base) => {
      where.secret = join(base, 'secret', 'token');
      return [join(base, 'secret')];
    },
    fake: {
      calls: () => [
        { toolName: 'view', toolArgs: { path: where.secret }, toolCallId: 'call_read' },
        {
          toolName: 'grep',
          toolArgs: { pattern: 'x', paths: [join(where.secret, '..')] },
          toolCallId: 'call_search',
        },
      ],
    },
  });
  try {
    run.link.deliver('session-1', sessionNew(CWD, { request: sessionNewRequest({ runtime: 'copilot' }) }));
    await until(() => run.link.transitions().some((one) => one.to === 'ready'), 'the session to be ready');
    run.link.deliver('session-1', { kind: 'session_prompt', text: 'read the token' }, 2);
    await until(() => run.link.transitions().some((one) => one.to === 'idle'), 'the run to settle');
    assert.deepEqual(run.decided, [], 'a protected read was asked about');
    const answers = Object.fromEntries(run.record.answers.map((one) => [one.toolCallId, one.answer.kind]));
    assert.deepEqual([answers['call_read'], answers['call_search']], ['reject', 'reject']);
    const refused = run.link
      .transitions()
      .filter((one) => one.cause.kind === 'refusal' && one.cause.event === 'credential-path-denied');
    assert.ok(refused.length >= 2, causesOf(run.link).join(', '));
  } finally {
    await stopped(run);
  }
});

test("regression: the open is told the session's temp folder, so a runtime that allows it, as Copilot's does, opens", async () => {
  const temp = process.platform === 'win32' ? 'C:/session-temp' : '/session-temp';
  const run = await copilotHost({
    baseEnv: { PATH: 'p', TEMP: temp, TMPDIR: temp },
    fake: { directories: [CWD, temp] },
  });
  try {
    run.link.deliver('session-1', sessionNew(CWD, { request: sessionNewRequest({ runtime: 'copilot' }) }));
    await until(
      () =>
        run.link.transitions().some((one) => one.to === 'ready' || one.to === 'ended') ||
        run.events.some((event) => event.kind === 'refusal'),
      'the open to settle',
    );
    assert.ok(
      run.link.transitions().some((one) => one.to === 'ready'),
      `the open was refused: ${causesOf(run.link).join(', ')}`,
    );
  } finally {
    await stopped(run);
  }
});

/** A provider of one repository whose worktrees live under `under`, as `host.test.ts` builds one. */
function servedProvider(repositoryRoot: string, under: string): WorkspaceProvider {
  return {
    repositoryRoot,
    workspaceRoot: under,
    provision: (id: string) => Promise.resolve(ok({ path: `${under}/${id}`, meta: {} })),
    release: () => Promise.resolve(ok(undefined)),
    defaultBranch: () => Promise.resolve('main'),
    keyForPath: (path: string) => {
      const key = path.startsWith(`${under}/`) ? path.slice(under.length + 1) : '';
      return key === '' || key.includes('/') ? null : key;
    },
    inventory: () => Promise.resolve(ok({ defaultBranch: 'main', entries: [] })),
  };
}

test("a write in a Copilot session's further worktree flows; its operator's checkout refuses", async () => {
  const run = await copilotHost({
    workspaces: servedProvider('C:/checkouts/home', 'C:/ws'),
    repositories: new Map([['tools', servedProvider('C:/checkouts/tools', 'C:/ws/.repositories/tools')]]),
    fake: {
      calls: () => [
        {
          toolName: 'create',
          toolArgs: { path: 'C:/ws/.repositories/tools/k1/src/a.ts', file_text: 'x' },
          toolCallId: 'call_inside',
        },
        {
          toolName: 'create',
          toolArgs: { path: 'C:/checkouts/tools/src/a.ts', file_text: 'x' },
          toolCallId: 'call_checkout',
        },
      ],
    },
  });
  try {
    run.link.deliver(
      'session-1',
      sessionNew(null, {
        workspaceKey: 'k1',
        additionalRepositories: ['tools'],
        request: sessionNewRequest({ runtime: 'copilot' }),
      }),
    );
    await until(() => run.link.transitions().some((one) => one.to === 'ready'), 'the session to be ready');
    run.link.deliver('session-1', { kind: 'session_prompt', text: 'write both' }, 2);
    await until(() => run.link.transitions().some((one) => one.to === 'idle'), 'the run to settle');
    const answers = Object.fromEntries(run.record.answers.map((one) => [one.toolCallId, one.answer.kind]));
    assert.deepEqual([answers['call_inside'], answers['call_checkout']], ['approve-once', 'reject']);
    assert.deepEqual(
      run.decided.map((one) => one.toolUseId),
      ['call_inside'],
      "the checkout's write was asked about",
    );
    assert.ok(causesOf(run.link).includes('refusal/path-escapes-root'), causesOf(run.link).join(', '));
  } finally {
    await stopped(run);
  }
});

test("a decision deadline longer than Copilot's measured wait is refused at the open, by name", async () => {
  const run = await copilotHost();
  try {
    run.link.deliver(
      'session-1',
      sessionNew(CWD, {
        request: sessionNewRequest({ runtime: 'copilot' }),
        gate: {
          decisionTimeoutMs: COPILOT_MEASURED_PERMISSION_WAIT_MS + 1,
          holdAfterMs: null,
          matcherTimeoutSeconds: null,
        },
      }),
    );
    await until(
      () =>
        run.events.some(
          (event) => event.kind === 'refusal' && event.refusal.reason === 'gate-deadlines-inverted',
        ),
      'the refusal',
    );
    assert.deepEqual(run.record.clients, [], 'nothing was started');
  } finally {
    await stopped(run);
  }
});

test('an SSE server, which Copilot has no form for here, refuses the open by name', async () => {
  const run = await copilotHost();
  try {
    run.link.deliver(
      'session-1',
      sessionNew(CWD, {
        request: sessionNewRequest({
          runtime: 'copilot',
          mcpServers: { old: { type: 'sse', url: 'http://127.0.0.1:9/sse' } },
        }),
      }),
    );
    await until(
      () =>
        run.events.some(
          (event) => event.kind === 'refusal' && event.refusal.reason === 'mcp-descriptor-invalid',
        ),
      'the refusal',
    );
    assert.deepEqual(run.record.clients, []);
  } finally {
    await stopped(run);
  }
});

test('a Copilot this host cannot run is listed unavailable with why, and a session naming it is refused', async () => {
  const run = await copilotHost({
    read: {
      entry: unavailableCopilotEntry('no @github/copilot-sdk is installed under C:/sdk'),
      detail: 'no SDK',
    },
  });
  try {
    const entry = (run.link.announced?.agents ?? []).find((one) => one.runtime === 'copilot');
    assert.equal(entry?.available, false);
    assert.match(entry?.unavailableReason ?? '', /no @github\/copilot-sdk is installed/);
    run.link.deliver('session-1', sessionNew(CWD, { request: sessionNewRequest({ runtime: 'copilot' }) }));
    await until(
      () =>
        run.events.some(
          (event) => event.kind === 'refusal' && event.refusal.reason === 'runtime-unavailable',
        ),
      'the refusal',
    );
  } finally {
    await stopped(run);
  }
});

test('composeSession refuses the inverted deadline itself, before any registry is asked', () => {
  const refused = composeSession({
    registry: { nativeRuntime: () => ({}) } as never,
    sessionKey: 'k',
    cwd: CWD,
    sink: { send: () => ok(undefined) },
    decide: () => Promise.resolve({ behavior: 'allow' }),
    gate: { decisionTimeoutMs: COPILOT_MEASURED_PERMISSION_WAIT_MS + 1 },
    request: { runtime: 'copilot' },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? null : refused.refusal.reason, 'gate-deadlines-inverted');
});
