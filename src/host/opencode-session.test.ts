/**
 * opencode through a whole host: the hello's runtimes list and its pack row, a session opened on opencode and
 * what reaches the wire from it, a decision request for one of its calls, the local gate on opencode's own
 * tool names, a further worktree, a server it has no form for, and an opencode this host cannot run.
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
import { fakeOpencode } from '../test-support/fake-opencode.js';
import type { FakeOpencodeOptions, FakeOpencodeRecord } from '../test-support/fake-opencode.js';
import { tempDir } from '../test-support/temp-dir.js';
import type { WorkspaceProvider } from '../workspace/provider.js';
import type { HostEvent, HostLink } from './host.js';
import { PeriscopeHost } from './host.js';
import type { OpencodeRuntimeRead } from './opencode-runtime.js';
import { availableOpencodeEntry, unavailableOpencodeEntry } from './opencode-runtime.js';

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

interface OpencodeHostRun {
  readonly host: PeriscopeHost;
  readonly link: RecordingLink;
  readonly record: FakeOpencodeRecord;
  readonly decided: DecisionRequest[];
  readonly events: HostEvent[];
  readonly base: string;
}

async function opencodeHost(
  options: {
    read?: OpencodeRuntimeRead;
    fake?: FakeOpencodeOptions;
    protect?: (base: string) => readonly string[];
    workspaces?: WorkspaceProvider;
    repositories?: ReadonlyMap<string, WorkspaceProvider>;
  } = {},
): Promise<OpencodeHostRun> {
  const base = await tempDir('opencode-host');
  const { connect, record } = fakeOpencode(options.fake);
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
    baseEnv: { PATH: 'p' },
    homeDir: base,
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
    ...(options.repositories === undefined ? {} : { repositories: new Map(options.repositories) }),
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
    agentCatalog: async () => ({ ok: true, agent: CLAUDE }),
    opencode: {
      runtime: {
        sdk: 'C:/sdk',
        base,
        readInstall: () => ok({ directory: 'C:/sdk', entry: 'C:/sdk/index.js', sdkVersion: '2.3.0' }),
        nodeProblem: () => null,
        connect,
        shell:
          process.platform === 'win32'
            ? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
            : '/bin/bash',
        killTree: () => Promise.resolve(),
        closeGraceMs: 20,
      },
      read: async () => options.read ?? { entry: availableOpencodeEntry(), detail: null },
    },
    report: (event) => events.push(event),
  });
  host.start();
  await until(() => link.announced !== null, 'the hello');
  return { host, link, record, decided, events, base };
}

async function stopped(run: OpencodeHostRun): Promise<void> {
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

const replies = (record: FakeOpencodeRecord): Record<string, string> =>
  Object.fromEntries(record.replies.map((reply) => [reply.requestID, reply.decision]));

test('the hello lists opencode after Claude, at its tier, with its versions and vocabularies, and its pack row', async () => {
  const run = await opencodeHost();
  try {
    const agents = run.link.announced?.agents ?? [];
    assert.deepEqual(
      agents.map((entry) => entry.runtime),
      ['claude', 'opencode'],
    );
    assert.deepEqual(agents[1], availableOpencodeEntry());
    assert.deepEqual(
      (run.link.announced?.agentSkills ?? []).find((row) => row.runtime === 'opencode'),
      { runtime: 'opencode', naming: 'bare', delivery: 'per-session' },
    );
    assert.ok(run.events.some((event) => event.kind === 'runtime-catalog' && event.runtime === 'opencode'));
  } finally {
    await stopped(run);
  }
});

test("a session on opencode opens ready at its tier once its open is proven; a prompt runs through the gate to idle; its facts, items and events ride the wire as opencode's", async () => {
  const run = await opencodeHost({
    fake: {
      calls: () => [
        {
          id: 'call_shell',
          name: 'shell',
          input: { command: 'git status' },
          requests: [
            { action: 'shell', resources: ['git status'], metadata: { input: { command: 'git status' } } },
          ],
        },
      ],
      cost: 0.0042,
    },
  });
  try {
    run.link.deliver('session-1', sessionNew(CWD, { request: sessionNewRequest({ runtime: 'opencode' }) }));
    await until(() => run.link.transitions().some((one) => one.to === 'ready'), 'the session to be ready');
    const ready = run.link.transitions().find((one) => one.to === 'ready');
    assert.equal(`${ready?.cause.kind}/${ready?.cause.event}`, 'agent-event/opencode:session.created');
    assert.deepEqual(ready?.controlTier, { level: 'intercepted-with-residual', degrades: [] });
    assert.equal(run.decided.length, 0, 'the open asked nobody');
    run.link.deliver('session-1', { kind: 'session_prompt', text: 'status please' }, 2);
    await until(() => run.link.transitions().some((one) => one.to === 'idle'), 'the run to settle');
    const causes = causesOf(run.link);
    const run1 = causes.slice(causes.indexOf('agent-event/opencode:session.execution.started'));
    assert.equal(run1[0], 'agent-event/opencode:session.execution.started', causes.join(', '));
    assert.equal(run1.at(-1), 'agent-event/opencode:session.execution.succeeded', causes.join(', '));
    assert.equal(run.decided.length, 1, 'the call was not asked about');
    const request = JSON.parse(JSON.stringify(run.decided[0])) as Record<string, unknown>;
    assert.deepEqual(
      [
        request['runtime'],
        request['toolName'],
        request['toolKind'],
        request['toolUseId'],
        request['sessionKey'],
      ],
      ['opencode', 'shell', 'shell', 'call_shell', 'session-1'],
    );
    assert.equal(request['shellDialect'], process.platform === 'win32' ? 'powershell' : 'posix');
    await until(
      () => run.link.bodies().some(({ body }) => readAgentFacts(body)?.fact.kind === 'turn_record'),
      'the spend',
    );
    const facts = run.link.bodies().flatMap(({ body }) => {
      const read = readAgentFacts(body);
      return read === null ? [] : [read.fact];
    });
    for (const kind of ['session_handle', 'agent_receipt', 'turn_record']) {
      assert.ok(
        facts.some((fact) => fact.kind === kind),
        `${kind} among ${facts.map((fact) => fact.kind).join(', ')}`,
      );
    }
    const spend = facts.find((fact) => fact.kind === 'turn_record');
    assert.ok(spend?.kind === 'turn_record');
    assert.equal(spend.turnScope, 'step');
    assert.equal(spend.turn?.costBasis, 'provider-reported');
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
        .some(({ body }) => body['update'] === 'agent_message' && body['runtime'] === 'opencode'),
    );
  } finally {
    await stopped(run);
  }
});

test("the local gate reads opencode's own tool names: a read of a protected file is refused before anything is asked", async () => {
  const where = { secret: '' };
  const run = await opencodeHost({
    protect: (base) => {
      where.secret = join(base, 'secret', 'token');
      return [join(base, 'secret')];
    },
    fake: {
      calls: () => [
        { id: 'call_read', name: 'read', requests: [{ action: 'read', resources: [where.secret] }] },
        {
          id: 'call_search',
          name: 'grep',
          input: { pattern: 'x', path: join(where.secret, '..') },
          requests: [
            {
              action: 'grep',
              resources: ['x'],
              metadata: { input: { pattern: 'x', path: join(where.secret, '..') } },
            },
          ],
        },
      ],
    },
  });
  try {
    run.link.deliver('session-1', sessionNew(CWD, { request: sessionNewRequest({ runtime: 'opencode' }) }));
    await until(() => run.link.transitions().some((one) => one.to === 'ready'), 'the session to be ready');
    run.link.deliver('session-1', { kind: 'session_prompt', text: 'read the token' }, 2);
    await until(() => run.link.transitions().some((one) => one.to === 'idle'), 'the run to settle');
    assert.deepEqual(run.decided, [], 'a protected read was asked about');
    const answered = replies(run.record);
    assert.equal(answered['per_call_read_1'], 'reject');
    const refused = run.link
      .transitions()
      .filter((one) => one.cause.kind === 'refusal' && one.cause.event === 'credential-path-denied');
    assert.ok(refused.length >= 1, causesOf(run.link).join(', '));
  } finally {
    await stopped(run);
  }
});

/** A provider of one repository whose worktrees live under `under`. */
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

test("a write in an opencode session's further worktree flows; its operator's checkout refuses", async () => {
  const run = await opencodeHost({
    workspaces: servedProvider('C:/checkouts/home', 'C:/ws'),
    repositories: new Map([['tools', servedProvider('C:/checkouts/tools', 'C:/ws/.repositories/tools')]]),
    fake: {
      calls: () => [
        {
          id: 'call_inside',
          name: 'edit',
          requests: [{ action: 'edit', resources: ['C:/ws/.repositories/tools/k1/src/a.ts'] }],
        },
        {
          id: 'call_checkout',
          name: 'edit',
          requests: [{ action: 'edit', resources: ['C:/checkouts/tools/src/a.ts'] }],
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
        request: sessionNewRequest({ runtime: 'opencode' }),
      }),
    );
    await until(() => run.link.transitions().some((one) => one.to === 'ready'), 'the session to be ready');
    run.link.deliver('session-1', { kind: 'session_prompt', text: 'write both' }, 2);
    await until(() => run.link.transitions().some((one) => one.to === 'idle'), 'the run to settle');
    const answered = replies(run.record);
    const words = (requestID: string): string =>
      run.record.replies.find((reply) => reply.requestID === requestID)?.message ?? 'no words';
    assert.equal(
      answered['per_call_inside_1'],
      'once',
      `the further worktree's write was refused: ${words('per_call_inside_1')}`,
    );
    assert.equal(answered['per_call_checkout_1'], 'reject');
    assert.match(words('per_call_checkout_1'), /^path-escapes-root:/);
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

test('an SSE server, which opencode has no form for here, refuses the open by name and starts nothing', async () => {
  const run = await opencodeHost();
  try {
    run.link.deliver(
      'session-1',
      sessionNew(CWD, {
        request: sessionNewRequest({
          runtime: 'opencode',
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
    assert.deepEqual(run.record.connects, []);
  } finally {
    await stopped(run);
  }
});

test('an opencode this host cannot run is listed unavailable with why, and a session naming it is refused', async () => {
  const run = await opencodeHost({
    read: {
      entry: unavailableOpencodeEntry(
        'this host runs Node 22.12.0, which cannot parse `await using`; opencode needs Node 24 or later',
      ),
      detail: 'old Node',
    },
  });
  try {
    const entry = (run.link.announced?.agents ?? []).find((one) => one.runtime === 'opencode');
    assert.equal(entry?.available, false);
    assert.match(entry?.unavailableReason ?? '', /opencode needs Node 24 or later/);
    run.link.deliver('session-1', sessionNew(CWD, { request: sessionNewRequest({ runtime: 'opencode' }) }));
    await until(
      () =>
        run.events.some(
          (event) => event.kind === 'refusal' && event.refusal.reason === 'runtime-unavailable',
        ),
      'the refusal',
    );
    assert.deepEqual(run.record.connects, []);
  } finally {
    await stopped(run);
  }
});
