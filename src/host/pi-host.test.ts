/**
 * pi through a whole host: the hello's runtimes list and its pack row, a session opened on pi and what
 * reaches the wire from it, a decision request for one of its calls, code found at the open that this
 * host did not load, and a pi this host cannot run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

import type {
  HostAgent,
  HostConfiguration,
  JsonObject,
  SessionFrame,
  SessionPayload,
} from '../control/frames.js';
import { readAgentFacts, readStateTransition, sessionNew, sessionNewRequest } from '../control/frames.js';
import type { LinkHandlers } from '../control/link.js';
import { ok } from '../core/result.js';
import type { Result } from '../core/result.js';
import type { DecisionRequest } from '../gate/decision.js';
import type { SessionTransition } from '../state/model.js';
import { fakePi } from '../test-support/fake-pi.js';
import type { FakePi, FakePiOptions } from '../test-support/fake-pi.js';
import { tempDir } from '../test-support/temp-dir.js';
import type { HostEvent, HostLink } from './host.js';
import { PeriscopeHost } from './host.js';
import type { PiRuntimeRead } from './pi-runtime.js';
import { availablePiEntry, unavailablePiEntry } from './pi-runtime.js';

const CWD = process.platform === 'win32' ? 'C:/work/session-1' : '/work/session-1';

const CLAUDE: HostAgent = { claudeCodeVersion: '2.1.284', sdkVersion: '0.3.284', models: [] };

class RecordingLink implements HostLink {
  readonly sent: { sessionId: string; payload: SessionPayload }[] = [];
  handlers: LinkHandlers | null = null;
  announced: HostConfiguration | null = null;
  negotiatedVersion: number | null = 17;
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
    const frame: SessionFrame = { frame: 'session', sessionId, seq, at: '2026-10-14T00:00:00.000Z', payload };
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

interface PiHost {
  readonly host: PeriscopeHost;
  readonly link: RecordingLink;
  readonly fake: FakePi;
  readonly decided: DecisionRequest[];
  readonly events: HostEvent[];
  readonly base: string;
}

async function piHost(options: { read?: PiRuntimeRead; fake?: FakePiOptions } = {}): Promise<PiHost> {
  const base = await tempDir('pi-host');
  const fake = fakePi(options.fake);
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
    protectedPaths: [],
    baseEnv: { PATH: 'p' },
    homeDir: base,
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
    agentCatalog: async () => ({ ok: true, agent: CLAUDE }),
    pi: {
      runtime: {
        binary: 'C:/tools/pi/dist/bundle/cli.js',
        base,
        spawn: fake.spawn,
        killTree: () => Promise.resolve(),
        closeGraceMs: 20,
      },
      read: async () => options.read ?? { entry: availablePiEntry('1.2.0'), detail: null },
    },
    report: (event) => events.push(event),
  });
  host.start();
  await until(() => link.announced !== null, 'the hello');
  return { host, link, fake, decided, events, base };
}

async function stopped(run: PiHost): Promise<void> {
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

test('the hello lists pi after Claude, at its tier, and its pack row: skills by bare name, handed over with each session', async () => {
  const run = await piHost();
  try {
    const agents = run.link.announced?.agents ?? [];
    assert.deepEqual(
      agents.map((entry) => entry.runtime),
      ['claude', 'pi'],
    );
    assert.deepEqual(agents[1], availablePiEntry('1.2.0'));
    assert.deepEqual(
      (run.link.announced?.agentSkills ?? []).find((row) => row.runtime === 'pi'),
      { runtime: 'pi', naming: 'bare', delivery: 'per-session' },
    );
    const said = run.events.find((event) => event.kind === 'runtime-catalog' && event.runtime === 'pi');
    assert.ok(said !== undefined, 'the read at start was not reported');
  } finally {
    await stopped(run);
  }
});

test("a session on pi opens ready at its tier once its extension said hello; a prompt runs through the gate to idle; and its facts and messages ride the wire as pi's", async () => {
  const run = await piHost({
    fake: { calls: () => [{ toolName: 'bash', input: { command: 'git status' } }] },
  });
  try {
    run.link.deliver('session-1', sessionNew(CWD, { request: sessionNewRequest({ runtime: 'pi' }) }));
    await until(() => run.link.transitions().some((one) => one.to === 'ready'), 'the session to be ready');
    const ready = run.link.transitions().find((one) => one.to === 'ready');
    assert.equal(`${ready?.cause.kind}/${ready?.cause.event}`, 'agent-event/pi:get_state');
    assert.deepEqual(ready?.controlTier, { level: 'intercepted', degrades: [] });
    run.link.deliver('session-1', { kind: 'session_prompt', text: 'status please' }, 2);
    await until(() => run.link.transitions().some((one) => one.to === 'idle'), 'the run to settle');
    assert.ok(causesOf(run.link).includes('agent-event/pi:agent_start'), causesOf(run.link).join(', '));
    assert.ok(causesOf(run.link).includes('agent-event/pi:agent_settled'), causesOf(run.link).join(', '));
    assert.equal(run.decided.length, 1, 'the call was not asked about');
    const request = JSON.parse(JSON.stringify(run.decided[0])) as Record<string, unknown>;
    assert.deepEqual(
      [
        request['runtime'],
        request['toolName'],
        request['toolKind'],
        request['shellDialect'],
        request['sessionKey'],
      ],
      ['pi', 'bash', 'shell', 'posix', 'session-1'],
    );
    assert.deepEqual(
      run.fake.cli.ran.map((one) => one.toolName),
      ['bash'],
    );
    await until(
      () => run.link.bodies().some(({ body }) => readAgentFacts(body)?.fact.kind === 'turn_record'),
      'the totals',
    );
    const kinds = run.link.bodies().flatMap(({ body }) => {
      const read = readAgentFacts(body);
      return read === null ? [] : [read.fact.kind];
    });
    for (const kind of ['session_handle', 'agent_receipt', 'turn_record', 'usage_sample']) {
      assert.ok(kinds.includes(kind as never), `${kind} among ${kinds.join(', ')}`);
    }
    assert.ok(
      run.link.bodies().some(({ body }) => body['update'] === 'agent_message' && body['runtime'] === 'pi'),
      'no message of pi rode the wire',
    );
  } finally {
    await stopped(run);
  }
});

test('code this host did not load, found at the open, lowers the first ready to intercepted-with-residual and is named on the state lane', async () => {
  const run = await piHost({ fake: { foreignCommands: [{ name: 'deploy', path: '/elsewhere/deploy.ts' }] } });
  try {
    run.link.deliver('session-1', sessionNew(CWD, { request: sessionNewRequest({ runtime: 'pi' }) }));
    await until(() => run.link.transitions().some((one) => one.to === 'ready'), 'the session to be ready');
    const ready = run.link.transitions().find((one) => one.to === 'ready');
    assert.deepEqual(ready?.controlTier, {
      level: 'intercepted-with-residual',
      degrades: ['gate-foreign-extension'],
    });
    assert.ok(causesOf(run.link).includes('refusal/gate-foreign-extension'), causesOf(run.link).join(', '));
  } finally {
    await stopped(run);
  }
});

test('a pi this host cannot run is listed unavailable with the reason, and a session naming it is refused runtime-unavailable', async () => {
  const run = await piHost({
    read: { entry: unavailablePiEntry('1.2.0', 'the pi CLI is absent'), detail: 'the pi CLI is absent' },
  });
  try {
    assert.equal(run.link.announced?.agents?.find((entry) => entry.runtime === 'pi')?.available, false);
    run.link.deliver('session-1', sessionNew(CWD, { request: sessionNewRequest({ runtime: 'pi' }) }));
    await until(() => run.link.transitions().some((one) => one.to === 'ended'), 'the refusal');
    assert.ok(
      causesOf(run.link).some((cause) => cause.endsWith('runtime-unavailable')),
      causesOf(run.link).join(', '),
    );
    assert.equal(run.fake.spawned, false);
  } finally {
    await stopped(run);
  }
});

test('a session on pi asking for a permission mode is refused by name before anything starts: pi has none', async () => {
  const run = await piHost();
  try {
    run.link.deliver(
      'session-1',
      sessionNew(CWD, { request: sessionNewRequest({ runtime: 'pi', permissionMode: 'default' }) }),
    );
    await until(() => run.link.transitions().some((one) => one.to === 'ended'), 'the refusal');
    assert.ok(
      causesOf(run.link).some((cause) => cause.endsWith('request-key-unsupported')),
      causesOf(run.link).join(', '),
    );
    assert.equal(run.fake.spawned, false);
  } finally {
    await stopped(run);
  }
});
