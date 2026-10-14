/**
 * Qwen Code through a whole host: the hello's runtimes list and its pack row, a session opened on Qwen
 * Code and what reaches the wire from it, a decision request for one of its calls, the dialect word a
 * controller below protocol 17 is not sent, and a configure that arrives while a session is opening.
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
  readAgentMessage,
  readStateTransition,
  sessionNew,
  sessionNewRequest,
} from '../control/frames.js';
import type { LinkHandlers } from '../control/link.js';
import { ok } from '../core/result.js';
import type { Result } from '../core/result.js';
import type { DecisionRequest } from '../gate/decision.js';
import type { SessionTransition } from '../state/model.js';
import { fakeQwen } from '../test-support/fake-qwen.js';
import type { FakeQwen, FakeQwenOptions } from '../test-support/fake-qwen.js';
import { tempDir } from '../test-support/temp-dir.js';
import type { WorkspaceProvider } from '../workspace/provider.js';
import type { HostEvent, HostLink } from './host.js';
import { PeriscopeHost, decideAtLinkVersion } from './host.js';
import type { QwenRuntimeRead } from './qwen-runtime.js';
import { availableQwenEntry, unavailableQwenEntry } from './qwen-runtime.js';

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

interface QwenHost {
  readonly host: PeriscopeHost;
  readonly link: RecordingLink;
  readonly fake: FakeQwen;
  readonly decided: DecisionRequest[];
  readonly events: HostEvent[];
  readonly base: string;
}

async function qwenHost(
  options: {
    read?: QwenRuntimeRead;
    fake?: FakeQwenOptions;
    workspaces?: WorkspaceProvider;
    env?: Readonly<Record<string, string>>;
    /** The protected set, from the runtime's base. Absent: none. */
    protect?: (base: string) => readonly string[];
  } = {},
): Promise<QwenHost> {
  const base = await tempDir('qwen-host');
  const fake = fakeQwen(options.fake);
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
    baseEnv: { PATH: 'p', ...(options.env ?? {}) },
    homeDir: base,
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
    agentCatalog: async () => ({ ok: true, agent: CLAUDE }),
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
    qwen: {
      runtime: {
        binary: 'C:/tools/qwen/cli-entry.js',
        base,
        operatorHome: base,
        spawn: fake.spawn,
        killTree: () => Promise.resolve(),
        closeGraceMs: 20,
      },
      read: async () => options.read ?? { entry: availableQwenEntry('0.25.1'), detail: null },
    },
    report: (event) => events.push(event),
  });
  host.start();
  await until(() => link.announced !== null, 'the hello');
  return { host, link, fake, decided, events, base };
}

async function stopped(run: QwenHost): Promise<void> {
  run.host.stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await rm(run.base, { recursive: true, force: true });
}

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const opening = (
  request: Parameters<typeof sessionNewRequest>[0] = {},
  cwd = CWD,
): ReturnType<typeof sessionNew> =>
  sessionNew(cwd, { request: sessionNewRequest({ runtime: 'qwen-code', ...request }) });

test('the hello lists Claude, then Qwen Code: available, at tier intercepted-with-residual, with its own vocabularies and a bare per-session pack row', async () => {
  const run = await qwenHost();
  const agents = run.link.announced?.agents ?? [];
  assert.deepEqual(
    agents.map((entry) => entry.runtime),
    ['claude', 'qwen-code'],
  );
  const qwen = agents[1];
  assert.equal(qwen?.available, true);
  assert.equal(qwen?.version, '0.25.1');
  assert.equal(qwen?.sdkVersion, null);
  assert.deepEqual(qwen?.models, []);
  assert.deepEqual(qwen?.controlTier, { level: 'intercepted-with-residual', degrades: [] });
  assert.deepEqual(qwen?.vocabularies, {
    permissionModes: ['bypassPermissions', 'default', 'plan'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinking: false,
  });
  assert.deepEqual(run.link.announced?.agentSkills, [
    { runtime: 'claude', naming: 'namespaced', delivery: 'per-session' },
    { runtime: 'qwen-code', naming: 'bare', delivery: 'per-session' },
  ]);
  await stopped(run);
});

test('an unavailable Qwen Code lists its reason, and a session on it is refused runtime-unavailable before anything starts', async () => {
  const reason =
    'the Qwen Code CLI C:/tools/qwen/cli-entry.js is Qwen Code 0.26.0; this host is pinned to Qwen Code 0.25.1';
  const run = await qwenHost({ read: { entry: unavailableQwenEntry('0.26.0', reason), detail: reason } });
  assert.equal(run.link.announced?.agents?.[1]?.unavailableReason, reason);
  run.link.deliver('handle-1', opening());
  await until(() => run.link.transitions().length > 0, 'the refused open');
  const [refused] = run.link.transitions();
  assert.equal(`${refused?.cause.kind}/${refused?.cause.event}`, 'refusal/runtime-unavailable');
  assert.equal(run.fake.child.spawned, null);
  await stopped(run);
});

test('a Qwen Code session on the wire: handle and receipt, ready at its tier, a turn whose call the host decides, and its native messages named', async () => {
  const run = await qwenHost({
    env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    fake: { calls: () => [{ name: 'run_shell_command', input: { command: 'git status' } }] },
  });
  run.link.deliver('handle-1', opening());
  await until(() => run.link.transitions().some((transition) => transition.to === 'ready'), 'ready');
  run.link.deliver('handle-1', { kind: 'session_prompt', text: 'look' }, 2);
  await until(() => run.link.transitions().some((transition) => transition.to === 'idle'), 'the turn to end');

  const ready = run.link.transitions().find((transition) => transition.to === 'ready');
  assert.deepEqual(ready?.controlTier, { level: 'intercepted-with-residual', degrades: [] });
  assert.equal(`${ready?.cause.kind}/${ready?.cause.event}`, 'agent-event/qwen-code:initialize');
  const causes = run.link.transitions().map((transition) => `${transition.to}:${transition.cause.event}`);
  assert.ok(causes.includes('working:qwen-code:system/init'), causes.join(', '));
  assert.ok(causes.includes('idle:qwen-code:result'), causes.join(', '));

  const [decision] = run.decided;
  assert.equal(decision?.runtime, 'qwen-code');
  assert.equal(decision?.toolName, 'run_shell_command');
  assert.equal(decision?.toolUseId, 'call_1');
  assert.equal(decision?.toolKind, 'shell');
  assert.equal(decision?.shellDialect, process.platform === 'win32' ? 'cmd' : 'posix');
  assert.equal(decision?.sessionKey, 'handle-1');

  const facts = run.link.bodies().flatMap(({ body }) => {
    const read = readAgentFacts(body);
    return read === null ? [] : [read.fact];
  });
  assert.deepEqual(
    facts.filter((fact) => fact.kind === 'session_handle').map((fact) => (fact as { handle: string }).handle),
    [run.fake.cli.sessionId],
  );
  const record = facts.find((fact) => fact.kind === 'turn_record') as
    { turn: unknown; turnScope: unknown; totals: unknown } | undefined;
  assert.ok(record !== undefined);
  assert.equal(record.turn, null);
  assert.equal(record.turnScope, null);
  assert.notEqual(record.totals, null);

  const natives = run.link.bodies().flatMap(({ body }) => {
    const message = readAgentMessage(body);
    return message === null ? [] : [message];
  });
  assert.ok(natives.some((message) => message['type'] === 'result'));
  assert.ok(natives.some((message) => message['type'] === 'control_request'));
  await stopped(run);
});

test("regression: the session's settings file named through its own variable is refused in each shell's spelling; the shared runtime directory is not", async () => {
  const spellings = [
    'cat "$QWEN_CODE_SYSTEM_SETTINGS_PATH"',
    'type "%QWEN_CODE_SYSTEM_SETTINGS_PATH%"',
    'Get-Content "$env:QWEN_CODE_SYSTEM_SETTINGS_PATH"',
  ];
  const run = await qwenHost({
    env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    // The protected set as `credentialPaths` states it for a Qwen Code base: its sessions' homes.
    protect: (base) => [join(base, 'sessions')],
    fake: {
      calls: () => [
        ...spellings.map((command) => ({ name: 'run_shell_command', input: { command } })),
        // Control: the same spelling of a directory the protected set leaves out (the chats a resume reads).
        { name: 'run_shell_command', input: { command: 'ls "$QWEN_RUNTIME_DIR"' } },
      ],
    },
  });
  run.link.deliver('handle-1', opening());
  await until(() => run.link.transitions().some((transition) => transition.to === 'ready'), 'ready');
  run.link.deliver('handle-1', { kind: 'session_prompt', text: 'look' }, 2);
  await until(() => run.link.transitions().some((transition) => transition.to === 'idle'), 'the turn to end');

  const settings = run.fake.child.spawned?.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] ?? '';
  assert.ok(
    settings.startsWith(join(run.base, 'sessions')),
    `the settings file ${settings} is not in a session's home, so the refusals below would prove nothing`,
  );
  const refused = run.link
    .transitions()
    .filter(
      (transition) =>
        transition.cause.kind === 'refusal' && transition.cause.event === 'credential-path-denied',
    );
  assert.equal(
    refused.length,
    spellings.length,
    refused.map((transition) => transition.cause.detail).join('\n'),
  );
  assert.deepEqual(
    run.decided.map((request) => (request.toolInput as { command?: unknown }).command),
    ['ls "$QWEN_RUNTIME_DIR"'],
    'only the control reached the decider',
  );
  await stopped(run);
});

test("a Qwen Code session's decision drops the cmd word for a controller below protocol 17, and keeps it at 17; the local gate reads it either way", async () => {
  const requests: DecisionRequest[] = [];
  let version: number | null = 16;
  const decide = decideAtLinkVersion(
    (request) => {
      requests.push(request);
      return Promise.resolve({ behavior: 'allow' });
    },
    () => version,
  );
  const shell: DecisionRequest = {
    toolName: 'run_shell_command',
    toolUseId: 'u',
    toolInput: { command: 'dir' },
    sessionId: 's',
    sessionKey: 'k',
    cwd: CWD,
    agentId: null,
    agentType: null,
    toolKind: 'shell',
    runtime: 'qwen-code',
    shellDialect: 'cmd',
  };
  const signal = new AbortController().signal;
  await decide(shell, signal);
  version = 17;
  await decide(shell, signal);
  version = null;
  await decide(shell, signal);
  version = 16;
  await decide({ ...shell, shellDialect: 'powershell' }, signal);
  assert.deepEqual(
    requests.map((request) => request.shellDialect ?? 'absent'),
    ['absent', 'cmd', 'cmd', 'powershell'],
  );
});

test("regression: a configure that arrives while its session is still opening is refused, and the refusal reaches that session's own lane once it opens", async () => {
  let release = (): void => {};
  const window = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const workspaces: WorkspaceProvider = {
    provision: async () => {
      await window;
      return ok({ path: CWD, meta: {} });
    },
    release: async () => ok(undefined),
  };
  const run = await qwenHost({ workspaces });
  run.link.deliver('handle-1', opening());
  run.link.deliver(
    'handle-1',
    { kind: 'session_configure', model: 'qwen3-max', permissionMode: null, thinking: null, effort: null },
    2,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.fake.child.spawned, null, 'the opening window was already shut; this proves nothing');
  assert.ok(
    run.events.some((event) => event.kind === 'refusal' && event.refusal.reason === 'session-unknown'),
    'the refusal was not reported here',
  );
  release();
  await until(
    () => run.link.transitions().some((transition) => transition.cause.event === 'session-unknown'),
    "the refusal on the session's lane",
  );
  const refusal = run.link.transitions().find((transition) => transition.cause.event === 'session-unknown');
  assert.equal(refusal?.cause.kind, 'refusal');
  assert.equal(refusal?.from, refusal?.to, 'the refusal moved the session');
  assert.match(
    refusal?.cause.detail ?? '',
    /still opening when the configure arrived, so nothing was applied/,
  );
  assert.equal(
    run.fake.cli.requests.some((request) => request['subtype'] === 'set_model'),
    false,
    'the configure was applied',
  );
  await stopped(run);
});
