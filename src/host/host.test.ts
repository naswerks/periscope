/**
 * The composer's own properties: what assembling the parts is supposed to guarantee.
 *
 * These are the claims a consumer inherits by calling `composeSession` instead of writing the
 * wiring themselves: the session is gated, it is observed, its transitions are on the wire, and the
 * host answers every command a controller can send rather than dropping the ones it does not model.
 *
 * The process and the link are both substituted, and only for this file's questions. Whether the
 * SDK does what the gate expects is proven against a real session (`gate.live.test.ts`); whether
 * the transport replays correctly is proven against the real link (`control/`). What is proven here
 * is the join: that the pieces are connected to each other at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fixedClock, fixedTicker } from '../core/time.js';
import { refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type {
  WorkspaceReleaseBulkResult,
  WorkspaceReleaseResult,
  HostConfiguration,
  WorkspaceListResult,
  RepositoryListResult,
  RepositoryReadResult,
  HostConfigureEntry,
  HostConfigureResult,
  JsonObject,
  SessionFrame,
  SessionListResult,
  SessionPayload,
  SessionPayloadKind,
  TranscriptFailed,
  TranscriptTailResult,
} from '../control/frames.js';
import {
  readStateTransition,
  sessionList,
  sessionListResult,
  sessionNew,
  sessionNewRequest,
  answerRefused,
  transcriptFailed,
  transcriptList,
  transcriptListResult,
  transcriptTail,
  transcriptTailResult,
  workspaceRelease,
  workspaceReleaseBulk,
  workspaceReleaseBulkResult,
  workspaceReleaseResult,
  hostConfigure,
  hostConfigureResult,
  unsetHostConfiguration,
  workspaceList,
  workspaceListResult,
  repositoryList,
  repositoryListResult,
  repositoryRead,
  repositoryReadResult,
} from '../control/frames.js';
import type { LinkHandlers } from '../control/link.js';
import type { ControllerCredential } from '../control/credential.js';
import type { DecisionRequest } from '../gate/decision.js';
import type { ToolFamilies } from '../gate/local.js';
import { DEFAULT_TOOL_FAMILIES } from '../gate/local.js';
import type { SessionTransition } from '../state/model.js';
import type {
  ReleaseOptions,
  WorkspaceEntry,
  WorkspaceInventory,
  WorkspaceProvider,
} from '../workspace/provider.js';
import { GitWorktreeProvider } from '../workspace/git-worktree.js';
import { nodeCommandEffects, nodeWorkspaceEffects } from './workspace-fs.js';
import type { AgentProcess, AgentProcessRequest, HookInput } from './agent-process.js';
import type { HostReconfigurer, HostEvent, HostLink } from './host.js';
import { PeriscopeHost, composeSession } from './host.js';
import type { SessionDegrade } from '../sessions/session.js';
import { SessionRegistry } from '../sessions/registry.js';
import type { FakeAgents } from '../test-support/fake-agent.js';
import { fakeAgents, settle } from '../test-support/fake-agent.js';
import { tempDir } from '../test-support/temp-dir.js';

const AT = Date.UTC(2026, 7, 4);

// --- fixtures ---------------------------------------------------------------

class FakeLink implements HostLink {
  readonly sent: { sessionId: string; payload: SessionPayload }[] = [];
  readonly forgotten: string[] = [];
  started = false;
  stopped = false;
  handlers: LinkHandlers | null = null;

  send(sessionId: string, payload: SessionPayload): Result<void> {
    this.sent.push({ sessionId, payload });
    return ok(undefined);
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  forgetSession(sessionId: string): void {
    this.forgotten.push(sessionId);
  }

  /** What the host told this link to declare next, if it did. */
  announced: {
    capabilities: readonly string[];
    configuration: HostConfiguration;
    pendingRestart: readonly string[];
  } | null = null;

  announce(
    capabilities: readonly string[],
    configuration: HostConfiguration,
    pendingRestart: readonly string[] = [],
  ): void {
    this.announced = { capabilities, configuration, pendingRestart };
  }

  /** Deliver an inbound frame exactly as the real link would, after its own seq check. */
  deliver(sessionId: string, payload: SessionPayload, seq = 1): void {
    const frame: SessionFrame = { frame: 'session', sessionId, seq, at: new Date(AT).toISOString(), payload };
    this.handlers?.onSessionFrame(frame);
  }

  causes(): string[] {
    const found: string[] = [];
    for (const entry of this.sent) {
      if (entry.payload.kind !== 'session_update') continue;
      const transition = readStateTransition((entry.payload as unknown as { body: JsonObject }).body);
      if (transition !== null) found.push(`${transition.cause.kind}/${transition.cause.event}`);
    }
    return found;
  }

  transitions(): SessionTransition[] {
    const found: SessionTransition[] = [];
    for (const entry of this.sent) {
      if (entry.payload.kind !== 'session_update') continue;
      const transition = readStateTransition((entry.payload as unknown as { body: JsonObject }).body);
      if (transition !== null) found.push(transition);
    }
    return found;
  }
}

const allow = async (): Promise<unknown> => ({ behavior: 'allow' });

const registryOver = (start: (request: AgentProcessRequest) => AgentProcess): SessionRegistry =>
  new SessionRegistry({
    baseEnv: { PATH: 'p' },
    homeDir: 'C:/nonexistent-home-for-tests',
    clock: fixedClock(AT),
    startProcess: start,
  });

const preToolUse = (toolName: string, input: unknown): HookInput =>
  ({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: 'call-1',
    tool_input: input,
    session_id: 'agent-1',
    cwd: 'C:/work',
  }) as unknown as HookInput;

/** Run the composed session's own PreToolUse handlers in order, exactly as the CLI would. */
async function callHooks(request: AgentProcessRequest, input: HookInput): Promise<unknown> {
  const matchers = request.hooks?.PreToolUse ?? [];
  let last: unknown = {};
  for (const matcher of matchers) {
    for (const handler of matcher.hooks) {
      last = await handler(input, 'call-1', { signal: new AbortController().signal });
    }
  }
  return last;
}

// --- composeSession ---------------------------------------------------------

test('regression: a composed session is gated; the PreToolUse handlers are registered, not left null', () => {
  const fake = fakeAgents();
  const link = new FakeLink();
  const composed = composeSession({
    registry: registryOver(fake.start),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink: link,
    decide: allow,
    clock: () => new Date(AT).toISOString(),
    ticker: fixedTicker(0),
  });
  assert.ok(composed.ok);

  const request = fake.started[0]?.request;
  assert.ok(request !== undefined, 'no process was started');
  assert.notEqual(request.hooks, null, 'the composed session runs with hooks: null, ungated and unobserved');
  assert.ok(
    (request.hooks?.PreToolUse ?? []).length >= 2,
    'observation and the gate must both be on PreToolUse',
  );
});

test('regression: a composed session is observed; every wired hook event is registered', () => {
  const fake = fakeAgents();
  const composed = composeSession({
    registry: registryOver(fake.start),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink: new FakeLink(),
    decide: allow,
  });
  assert.ok(composed.ok);

  const events = Object.keys(fake.started[0]?.request.hooks ?? {});
  for (const expected of ['PreToolUse', 'PostToolUse', 'Stop']) {
    assert.ok(events.includes(expected), `${expected} is not registered: ${events.join(', ')}`);
  }
});

test('regression: the spawning transition reaches the wire; forwarding is attached before the first record', () => {
  const link = new FakeLink();
  const composed = composeSession({
    registry: registryOver(fakeAgents().start),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink: link,
    decide: allow,
  });
  assert.ok(composed.ok);

  assert.deepEqual(
    link.causes(),
    ['control/create_requested'],
    "the first frame of a session's life was emitted to nobody",
  );
  assert.equal(link.sent[0]?.sessionId, 'handle-1', 'the frame is keyed by the controller handle');
});

test('regression: a gate deny from the composed session reaches the wire', async () => {
  const fake = fakeAgents();
  const link = new FakeLink();
  const composed = composeSession({
    registry: registryOver(fake.start),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink: link,
    decide: async () => ({ behavior: 'deny', message: 'not this one' }),
    gate: { decisionTimeoutMs: 200, holdAfterMs: 20 },
  });
  assert.ok(composed.ok);

  const request = fake.started[0]?.request;
  assert.ok(request !== undefined);
  const output = await callHooks(request, preToolUse('Write', { file_path: 'C:/work/a.txt' }));
  await settle();

  assert.equal(
    (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision,
    'deny',
    'the CLI was not told to block',
  );
  assert.ok(
    link.causes().includes('control/permission_denied'),
    `the deny is not on the wire: ${link.causes().join(', ')}`,
  );
});

test('regression: the local gate is consulted first; a path outside the workspace is refused with no decider call', async () => {
  const fake = fakeAgents();
  const link = new FakeLink();
  let askedTheController = 0;
  const composed = composeSession({
    registry: registryOver(fake.start),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink: link,
    decide: async () => {
      askedTheController += 1;
      return { behavior: 'allow' };
    },
    localGate: (request: DecisionRequest) =>
      request.toolName === 'Write' ? refusal('path-escapes-root', 'outside the workspace') : null,
  });
  assert.ok(composed.ok);

  const request = fake.started[0]?.request;
  assert.ok(request !== undefined);
  await callHooks(request, preToolUse('Write', { file_path: 'C:/elsewhere/a.txt' }));
  await settle();

  assert.equal(askedTheController, 0, 'the controller was asked about a call the host had already refused');
  assert.ok(
    link.causes().includes('refusal/path-escapes-root'),
    `the local refusal is not on the wire under its own name: ${link.causes().join(', ')}`,
  );
});

test('regression: the composed gate grants what it allows; without it the gate is a veto, not a gate', async () => {
  const fake = fakeAgents();
  const composed = composeSession({
    registry: registryOver(fake.start),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink: new FakeLink(),
    decide: allow,
    gate: { grantOnAllow: true },
  });
  assert.ok(composed.ok);

  const request = fake.started[0]?.request;
  assert.ok(request !== undefined);
  const output = await callHooks(request, preToolUse('Write', { file_path: 'C:/work/a.txt' }));

  assert.equal(
    (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision,
    'allow',
    "the gate approved the call and then said nothing, so the agent's own permission mode decides " +
      'and there is nobody to answer it',
  );
});

test('without granting, an allow says nothing; the default posture is unchanged', async () => {
  const fake = fakeAgents();
  const composed = composeSession({
    registry: registryOver(fake.start),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink: new FakeLink(),
    decide: allow,
  });
  assert.ok(composed.ok);

  const request = fake.started[0]?.request;
  assert.ok(request !== undefined);
  const output = await callHooks(request, preToolUse('Write', { file_path: 'C:/work/a.txt' }));
  assert.deepEqual(output, {}, 'the default allow returned an opinion');
});

test('regression: granting while settings load is refused by name, before any process exists', () => {
  const fake = fakeAgents();
  const composed = composeSession({
    registry: registryOver(fake.start),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink: new FakeLink(),
    decide: allow,
    gate: { grantOnAllow: true },
    request: { settingSources: ['project'] },
  });

  assert.equal(composed.ok, false, 'the gate would silently override deny rules the operator wrote');
  assert.equal(composed.ok === false && composed.refusal.reason, 'permission-grant-shadows-settings');
  assert.equal(fake.started.length, 0, 'a process was started for a composition that was refused');
});

// The exception: under bypassPermissions the grant changes nothing the mode does not already
// allow, so the operator's settings tiers may load beside a granting gate. The pair stays refused
// under every other mode (the control below).
test('under bypassPermissions the settings tiers load beside a granting gate; under default the pair still refuses', () => {
  const fake = fakeAgents();
  const bypass = composeSession({
    registry: registryOver(fake.start),
    sessionKey: 'handle-bypass',
    cwd: 'C:/work',
    sink: new FakeLink(),
    decide: allow,
    gate: { grantOnAllow: true },
    request: { settingSources: ['user', 'project', 'local'], permissionMode: 'bypassPermissions' },
  });
  assert.equal(bypass.ok, true, bypass.ok ? '' : `${bypass.refusal.reason}: ${bypass.refusal.detail}`);
  assert.equal(fake.started.length, 1, 'the process started, with the tiers');
  assert.deepEqual(fake.started[0]?.request.settingSources, ['user', 'project', 'local']);
  assert.equal(fake.started[0]?.request.permissionMode, 'bypassPermissions');

  const asking = composeSession({
    registry: registryOver(fakeAgents().start),
    sessionKey: 'handle-default',
    cwd: 'C:/work',
    sink: new FakeLink(),
    decide: allow,
    gate: { grantOnAllow: true },
    request: { settingSources: ['project'], permissionMode: 'default' },
  });
  assert.equal(asking.ok, false, 'control: any mode the grant can shadow keeps the refusal');
  assert.equal(asking.ok === false && asking.refusal.reason, 'permission-grant-shadows-settings');
});

test('either half alone composes; it is the pair that is refused, not each of them', () => {
  const granting = composeSession({
    registry: registryOver(fakeAgents().start),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink: new FakeLink(),
    decide: allow,
    gate: { grantOnAllow: true },
  });
  const loading = composeSession({
    registry: registryOver(fakeAgents().start),
    sessionKey: 'handle-2',
    cwd: 'C:/work',
    sink: new FakeLink(),
    decide: allow,
    request: { settingSources: ['project'] },
  });
  assert.equal(granting.ok, true, 'granting alone was refused');
  assert.equal(loading.ok, true, 'loading settings alone was refused');
});

test('regression: a PeriscopeHost grants by default, because it loads no settings and its gate must be able to say yes', async () => {
  const { link, processes } = hostOver();
  link.deliver('handle-1', sessionNew('C:/work'));
  await settle();

  const request = processes.started[0]?.request;
  assert.ok(request !== undefined);
  assert.deepEqual(request.settingSources, [], 'the host loaded settings, so granting would shadow them');
  const output = await callHooks(request, preToolUse('Bash', { command: 'echo hello' }));
  assert.equal(
    (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision,
    'allow',
    'a composed host approved a call and did not grant it',
  );
});

test('a composed session refuses a relative cwd rather than resolving it against the host', () => {
  const composed = composeSession({
    registry: registryOver(fakeAgents().start),
    sessionKey: 'handle-1',
    cwd: 'work',
    sink: new FakeLink(),
    decide: allow,
  });
  assert.equal(composed.ok, false);
  assert.equal(composed.ok === false && composed.refusal.reason, 'path-not-absolute');
});

test('the correlation id is carried onto every transition and never interpreted', () => {
  const link = new FakeLink();
  const composed = composeSession({
    registry: registryOver(fakeAgents().start),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink: link,
    decide: allow,
    correlationId: 'whatever-the-controller-means',
  });
  assert.ok(composed.ok);
  assert.equal(link.transitions()[0]?.correlationId, 'whatever-the-controller-means');
});

// --- PeriscopeHost: the dispatcher -------------------------------------------

function hostOver(
  options: {
    processes?: FakeAgents;
    workspaces?: WorkspaceProvider;
    events?: HostEvent[];
    bulk?: (what: string) => Result<string>;
    transcriptsRoot?: string;
    credential?: ControllerCredential;
    /**
     * Load-bearing: the bulk lane binds `postUrl`'s origin to this value, so any case that actually
     * delivers must name the origin its fake receiver is listening on. `ws://unused` stays the
     * default precisely because it matches nothing: a delivery test that forgets to set it refuses
     * rather than silently posting anywhere.
     */
    controllerUrl?: string;
    /** The key an unkeyed session_new provisions at. Absent means the session key. */
    defaultWorkspaceKey?: string;
    /** The configure seam. Absent means every host_configure refuses config-write-failed. */
    reconfigure?: HostReconfigurer;
    /** The local gate's tool families. Absent means the SDK's own tool names. */
    toolFamilies?: ToolFamilies;
  } = {},
): { host: PeriscopeHost; link: FakeLink; processes: FakeAgents } {
  const processes = options.processes ?? fakeAgents();
  const link = new FakeLink();
  const host = new PeriscopeHost({
    controllerUrl: options.controllerUrl ?? 'ws://unused',
    hostId: 'test-host',
    decide: allow,
    protectedPaths: [],
    registry: registryOver(processes.start),
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
    ...(options.bulk === undefined ? {} : { bulk: options.bulk }),
    ...(options.transcriptsRoot === undefined ? {} : { transcriptsRoot: options.transcriptsRoot }),
    ...(options.events === undefined ? {} : { report: (event) => options.events?.push(event) }),
    ...(options.credential === undefined ? {} : { credential: options.credential }),
    ...(options.defaultWorkspaceKey === undefined
      ? {}
      : { defaultWorkspaceKey: options.defaultWorkspaceKey }),
    ...(options.reconfigure === undefined ? {} : { reconfigure: options.reconfigure }),
    ...(options.toolFamilies === undefined ? {} : { toolFamilies: options.toolFamilies }),
  });
  return { host, link, processes };
}

test('regression: toolFamilies reaches the local gate, so an embedder-named MCP tool is jailed like the built-in it resembles', async () => {
  const families: ToolFamilies = {
    ...DEFAULT_TOOL_FAMILIES,
    write: [...DEFAULT_TOOL_FAMILIES.write, 'mcp__tools__write_file'],
  };
  const { link, processes } = hostOver({ toolFamilies: families });
  link.deliver('handle-1', sessionNew('C:/work'));
  await settle();

  const request = processes.started[0]?.request;
  assert.ok(request !== undefined);
  await callHooks(request, preToolUse('mcp__tools__write_file', { file_path: 'C:/elsewhere/a.txt' }));
  await settle();

  assert.ok(
    link.causes().includes('refusal/path-escapes-root'),
    `the named MCP tool was not jailed locally: ${link.causes().join(', ')}`,
  );
});

test('regression: session_new starts a session', async () => {
  const { host, link, processes } = hostOver();
  link.deliver('handle-1', sessionNew('C:/work'));
  await settle();

  assert.equal(processes.started.length, 1, 'session_new started nothing');
  assert.equal(host.session('handle-1').ok, true, 'the session is not reachable by its controller handle');
  assert.ok(link.causes().includes('control/create_requested'), 'the new session put nothing on the wire');
});

test('regression: session_prompt sends a turn, and records that it did', async () => {
  const { link, processes } = hostOver();
  link.deliver('handle-1', sessionNew('C:/work'));
  await settle();
  link.deliver('handle-1', { kind: 'session_prompt', text: 'do the thing' }, 2);
  await settle();

  assert.deepEqual(processes.started[0]?.prompts, ['do the thing']);
  assert.ok(
    link.causes().includes('control/prompt_submitted'),
    `no turn in the trace: ${link.causes().join(', ')}`,
  );
});

test('regression: session_cancel interrupts the turn and says so, rather than ending the session', async () => {
  const { host, link, processes } = hostOver();
  link.deliver('handle-1', sessionNew('C:/work'));
  await settle();
  link.deliver('handle-1', { kind: 'session_cancel' }, 2);
  await settle();

  assert.equal(processes.started[0]?.interrupts, 1, 'the turn was not interrupted');
  assert.ok(
    link.causes().includes('control/interrupt_requested'),
    `no interrupt in the trace: ${link.causes().join(', ')}`,
  );
  assert.equal(
    host.session('handle-1').ok,
    true,
    'a cancel ended the session; it stops a turn, not a session',
  );
});

test('regression: a command for a handle this host does not hold is refused, never dropped', async () => {
  const events: HostEvent[] = [];
  const { link } = hostOver({ events });
  link.deliver('never-opened', { kind: 'session_prompt', text: 'hello' });
  await settle();

  const refused = events.filter(
    (event): event is Extract<HostEvent, { kind: 'refusal' }> => event.kind === 'refusal',
  );
  assert.ok(refused.length > 0, 'a command for an unknown session vanished silently');
  assert.equal(refused[0]?.refusal.reason, 'session-unknown');
});

test('a payload kind this host produces is refused when it arrives inbound, under its own name', async () => {
  const events: HostEvent[] = [];
  const { link } = hostOver({ events });
  link.deliver('handle-1', {
    kind: 'bulk_delivered',
    deliveryId: 'd1',
    byteCount: 1,
    sizeBytes: null,
    mtimeMs: null,
  });
  await settle();

  const refused = events.filter(
    (event): event is Extract<HostEvent, { kind: 'refusal' }> => event.kind === 'refusal',
  );
  assert.equal(refused[0]?.refusal.reason, 'frame-malformed');
  assert.match(String(refused[0]?.refusal.detail), /bulk_delivered/);
});

test('regression: a second session_new for one handle is refused; it must not silently replace a live agent', async () => {
  const events: HostEvent[] = [];
  const { link, processes } = hostOver({ events });
  link.deliver('handle-1', sessionNew('C:/work'));
  await settle();
  link.deliver('handle-1', sessionNew('C:/other'), 2);
  await settle();

  assert.equal(processes.started.length, 1, 'a second agent was started for one controller handle');
  const refused = events.filter(
    (event): event is Extract<HostEvent, { kind: 'refusal' }> => event.kind === 'refusal',
  );
  assert.ok(refused.some((event) => event.refusal.reason === 'session-unknown'));
});

test('regression: two session_new frames in flight for one handle spawn one agent; the guard holds across the provider await', async () => {
  // The sequential case above never raced: with no provider, #open is synchronous all the way to
  // the map write, so the second frame always found the first already recorded. A provider inserts
  // an await between the guard and the write; the second frame must be refused from a reservation
  // taken before that await, or both frames pass the guard, both provision, and two agents end up
  // forwarding under one handle with the first one leaked.
  const events: HostEvent[] = [];
  let provisions = 0;
  const provider: WorkspaceProvider = {
    provision: async () => {
      provisions += 1;
      return ok({ path: 'C:/provisioned', meta: {} });
    },
    release: async () => ok(undefined),
  };
  const { host, link, processes } = hostOver({ workspaces: provider, events });

  // No settle between the two: the second frame arrives while the first is awaiting provision.
  link.deliver('handle-1', sessionNew('C:/work'));
  link.deliver('handle-1', sessionNew('C:/work'), 2);
  await settle();

  assert.equal(processes.started.length, 1, 'two in-flight session_new for one handle each spawned an agent');
  assert.equal(provisions, 1, 'the second frame reached the provider before the first finished opening');
  const refused = events.filter(
    (event): event is Extract<HostEvent, { kind: 'refusal' }> => event.kind === 'refusal',
  );
  assert.ok(
    refused.some((event) => event.refusal.reason === 'session-unknown'),
    'the second frame was swallowed rather than refused',
  );
  assert.equal(host.session('handle-1').ok, true, 'the surviving session is not reachable by its handle');
});

// --- the two-send race --------------------------------------------------------
//
// The twin of the pin above: the same await, the other frame. A controller sends `session_new`
// then `session_prompt`; the ordering is real on the wire and says nothing about acceptance,
// because the host acknowledges no controller frame. A seed landing seconds before its session
// opens (the width of a real `git worktree add`, measured at 13 s once) would be refused
// `session-unknown`, and the session would then sit idle forever with nothing able to say why.
//
// Every arm below delivers the two frames with no `settle()` between them. That is what makes the
// race deterministic rather than timing-dependent: `#open` is asynchronous from its first await, so
// the prompt is inside the window whatever the provider's real latency turns out to be.

/** A provider whose provisioning is held open until the test says otherwise: the window, on demand. */
function heldProvider(): { provider: WorkspaceProvider; finish: () => void } {
  let release = (): void => {};
  const window = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return {
    provider: {
      provision: async () => {
        await window;
        return ok({ path: 'C:/provisioned', meta: {} });
      },
      release: async () => ok(undefined),
    },
    finish: () => release(),
  };
}

const refusalsIn = (events: HostEvent[]): Extract<HostEvent, { kind: 'refusal' }>[] =>
  events.filter((event): event is Extract<HostEvent, { kind: 'refusal' }> => event.kind === 'refusal');

test('regression: a turn that arrives while its session is still opening is held and delivered; the two-send race', async () => {
  const events: HostEvent[] = [];
  const { provider, finish } = heldProvider();
  const { link, processes } = hostOver({ workspaces: provider, events });

  link.deliver('handle-1', sessionNew('C:/work'));
  link.deliver('handle-1', { kind: 'session_prompt', text: 'do the thing' }, 2);
  await settle();

  // Mid-window. The control on the fixture: if provisioning had already finished here, the arm would
  // pass against a host that never queued anything at all.
  assert.equal(processes.started.length, 0, 'the provisioning window was already shut; this proves nothing');
  assert.deepEqual(
    refusalsIn(events).map((event) => event.refusal.reason),
    [],
    'the turn was refused while its own session was still opening; this is the defect',
  );
  assert.ok(
    events.some((event) => event.kind === 'prompt-held'),
    'the turn was neither refused nor reported as held, which is the silent third outcome',
  );

  finish();
  await settle();

  assert.deepEqual(processes.started[0]?.prompts, ['do the thing'], 'the held turn never reached the agent');
  assert.ok(
    link.causes().includes('control/prompt_submitted'),
    `no turn in the trace: ${link.causes().join(', ')}`,
  );
  assert.ok(
    events.some((event) => event.kind === 'prompt-delivered'),
    'nothing reports the delivery, so the window cannot be measured from the trace',
  );
});

test('regression: a held turn whose open fails is refused, never dropped', async () => {
  // The queue's honesty arm. Holding a turn is a promise to answer it, and a queue that discarded on
  // failure would be the same silent defect one layer in: an agent that never spoke, again.
  const events: HostEvent[] = [];
  const provider: WorkspaceProvider = {
    provision: async () => ({
      ok: false,
      refusal: refusal('workspace-provision-failed', 'the disk is full'),
    }),
    release: async () => ok(undefined),
  };
  const { link, processes } = hostOver({ workspaces: provider, events });

  link.deliver('handle-1', sessionNew('C:/work'));
  link.deliver('handle-1', { kind: 'session_prompt', text: 'do the thing' }, 2);
  await settle();

  assert.equal(processes.started.length, 0, 'a session started without the directory it was refused');
  const reasons = refusalsIn(events).map((event) => event.refusal.reason);
  assert.ok(
    reasons.includes('workspace-provision-failed'),
    `the open's own failure vanished: ${reasons.join(', ')}`,
  );
  assert.ok(
    refusalsIn(events).some((event) => /never opened/.test(event.refusal.detail)),
    `the held turn was swallowed when the open failed: ${reasons.join(', ')}`,
  );
});

test('held turns are delivered in arrival order', async () => {
  const { provider, finish } = heldProvider();
  const { link, processes } = hostOver({ workspaces: provider });

  link.deliver('handle-1', sessionNew('C:/work'));
  link.deliver('handle-1', { kind: 'session_prompt', text: 'first' }, 2);
  link.deliver('handle-1', { kind: 'session_prompt', text: 'second' }, 3);
  await settle();
  finish();
  await settle();

  assert.deepEqual(processes.started[0]?.prompts, ['first', 'second'], 'the queue reordered the turns');
});

test('the hold is bounded; a wire-fed buffer does not grow without limit', async () => {
  const events: HostEvent[] = [];
  const { provider, finish } = heldProvider();
  const { link, processes } = hostOver({ workspaces: provider, events });

  link.deliver('handle-1', sessionNew('C:/work'));
  for (let index = 0; index < 12; index += 1) {
    link.deliver('handle-1', { kind: 'session_prompt', text: `turn ${index}` }, index + 2);
  }
  await settle();
  finish();
  await settle();

  assert.equal(processes.started[0]?.prompts.length, 8, 'the bound did not hold');
  assert.ok(
    refusalsIn(events).some((event) => /are already waiting/.test(event.refusal.detail)),
    'the turns past the bound were dropped rather than refused',
  );
});

test('regression: a cancel during the open withdraws the waiting turn; the same race, the other frame', async () => {
  const events: HostEvent[] = [];
  const { provider, finish } = heldProvider();
  const { host, link, processes } = hostOver({ workspaces: provider, events });

  link.deliver('handle-1', sessionNew('C:/work'));
  link.deliver('handle-1', { kind: 'session_prompt', text: 'do the thing' }, 2);
  link.deliver('handle-1', { kind: 'session_cancel' }, 3);
  await settle();
  finish();
  await settle();

  assert.deepEqual(processes.started[0]?.prompts, [], 'a cancelled turn was delivered anyway');
  assert.ok(
    events.some((event) => event.kind === 'prompt-withdrawn'),
    'the turn vanished without the trace saying who withdrew it; the silent third outcome',
  );

  // And the session still opens. `session_cancel` ends a turn, never a session: the same
  // contract the live-session arm above pins, held across the provisioning window.
  assert.equal(host.session('handle-1').ok, true, 'a cancel during the open killed the session itself');
  assert.deepEqual(
    refusalsIn(events).map((event) => event.refusal.reason),
    [],
    'the withdrawal was reported as a failure; the controller asked for this',
  );
});

test('control: a cancel for a handle this host never heard of is still refused', async () => {
  // The negative half. Widening the cancel path must not turn an unknown id into a quiet success:
  // `session-unknown` stays the immediate, honest answer for something that does not and never will
  // exist, and only a handle already reserved in `#opening` can withdraw.
  const events: HostEvent[] = [];
  const { link } = hostOver({ events });
  link.deliver('never-opened', { kind: 'session_cancel' });
  await settle();

  assert.equal(refusalsIn(events)[0]?.refusal.reason, 'session-unknown');
  assert.equal(
    events.some((event) => event.kind === 'prompt-withdrawn'),
    false,
    'an unknown handle was treated as a withdrawal',
  );
});

test('a turn arriving after a withdrawal is held and delivered; the cancel ends one turn, not the lane', async () => {
  const { provider, finish } = heldProvider();
  const { link, processes } = hostOver({ workspaces: provider });

  link.deliver('handle-1', sessionNew('C:/work'));
  link.deliver('handle-1', { kind: 'session_prompt', text: 'the withdrawn one' }, 2);
  link.deliver('handle-1', { kind: 'session_cancel' }, 3);
  link.deliver('handle-1', { kind: 'session_prompt', text: 'the replacement' }, 4);
  await settle();
  finish();
  await settle();

  assert.deepEqual(
    processes.started[0]?.prompts,
    ['the replacement'],
    'the cancel either swallowed the later turn or resurrected the withdrawn one',
  );
});

test('regression: the slow-provision arm; the same race against a real git worktree, not a stub', async () => {
  // The configuration that hides this defect is the one it must be proven in. `PlainDirProvider`
  // is a `mkdir`; the fix passing against it would prove nothing, because the window never opens
  // there. This arm runs a real `git worktree add` through the real command effects, the same
  // provider a session gets when it needs to commit.
  const home = await tempDir('two-send');
  const repository = join(home, 'repo');
  const commands = nodeCommandEffects();

  await nodeWorkspaceEffects.makeDirectory(repository);
  await commands.run('git', ['init', '--initial-branch=main'], repository);
  await commands.run('git', ['config', 'user.email', 'tester@example.invalid'], repository);
  await commands.run('git', ['config', 'user.name', 'Tester'], repository);
  await writeFile(join(repository, 'README.md'), 'base', 'utf8');
  await commands.run('git', ['add', 'README.md'], repository);
  await commands.run('git', ['commit', '-m', 'base'], repository);

  const events: HostEvent[] = [];
  const { link, processes } = hostOver({
    workspaces: new GitWorktreeProvider({
      repositoryRoot: repository,
      workspaceRoot: join(home, 'workspaces'),
      baseRef: 'main',
      effects: nodeWorkspaceEffects,
      commands,
    }),
    events,
  });

  // The two sends, back to back, exactly as a controller writes them to the socket.
  link.deliver('handle-1', sessionNew('C:/the-controller-guessed'));
  link.deliver('handle-1', { kind: 'session_prompt', text: 'do the thing' }, 2);

  // Real git needs real wall clock, and `settle()` does not provide it: it drains the microtask
  // queue, which a `git worktree add` is not waiting on. So this waits for an outcome (the turn
  // landing or a refusal appearing) and never for a duration. A wait that ends in neither falls
  // through to the assertions below, which is the honest report for a session born in silence.
  for (let index = 0; index < 400; index += 1) {
    if (processes.started[0]?.prompts.length === 1 || refusalsIn(events).length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.deepEqual(
    refusalsIn(events).map((event) => event.refusal.reason),
    [],
    'a real worktree provision refused the seed it was racing',
  );
  assert.deepEqual(
    processes.started[0]?.prompts,
    ['do the thing'],
    'the session was born on a real git worktree and never received its first turn',
  );
  assert.match(
    String(processes.started[0]?.request.cwd),
    /handle-1/,
    'the session did not run in the worktree',
  );

  await rm(home, { recursive: true, force: true });
});

test('a workspace provider decides the directory, and the trace reports where the session actually is', async () => {
  const provider: WorkspaceProvider = {
    provision: async () => ok({ path: 'C:/provisioned', meta: { by: 'the provider' } }),
    release: async () => ok(undefined),
  };
  const { link, processes } = hostOver({ workspaces: provider });
  link.deliver('handle-1', sessionNew('C:/the-controller-guessed'));
  await settle();

  assert.equal(processes.started[0]?.request.cwd, 'C:/provisioned');
  assert.equal(
    link.transitions()[0]?.where.cwd,
    'C:/provisioned',
    'the controller was never told where its session actually is',
  );
});

// The one exception: the provider's own repository root, the operator's checkout, is the one
// directory a named cwd gets under a provider. No worktree could be more "the repo" than the repo,
// and there is no isolation to protect when the operator asks for the source itself. Every other
// named directory still gets the provider's decision (the control).
test('regression: the operator’s own checkout wins over the provider; any other named directory does not', async () => {
  const provider: WorkspaceProvider = {
    provision: async () => ok({ path: 'C:/provisioned', meta: { by: 'the provider' } }),
    release: async () => ok(undefined),
    repositoryRoot: 'C:/repo',
  };
  const own = hostOver({ workspaces: provider });
  own.link.deliver('handle-1', sessionNew('C:/repo'));
  await settle();
  assert.equal(own.processes.started[0]?.request.cwd, 'C:/repo', 'the operator asked for the source itself');
  assert.equal(own.link.transitions()[0]?.where.cwd, 'C:/repo');

  const other = hostOver({ workspaces: provider });
  other.link.deliver('handle-2', sessionNew('C:/the-controller-guessed'));
  await settle();
  assert.equal(
    other.processes.started[0]?.request.cwd,
    'C:/provisioned',
    'control: the provider still decides',
  );
});

// A resume runs where its transcript lives. Under a provider a named cwd is advisory, but a
// resume moved into a fresh workspace is a fresh session that says nothing. So the host refuses by
// name instead of overruling, and the control shows the same resume running when the cwd is the
// repository root.
test('regression: a resume named for a directory the provider would not honour is refused on the wire, never moved', async () => {
  const provider: WorkspaceProvider = {
    provision: async () => ok({ path: 'C:/provisioned', meta: { by: 'the provider' } }),
    release: async () => ok(undefined),
    repositoryRoot: 'C:/repo',
  };
  const elsewhere = hostOver({ workspaces: provider });
  elsewhere.link.deliver(
    'handle-1',
    sessionNew('C:/somewhere-else', { request: sessionNewRequest({ resume: 'abc-123' }) }),
  );
  await settle();
  assert.equal(
    elsewhere.processes.started.length,
    0,
    'a resume elsewhere would be a fresh session that says nothing',
  );
  const ended = elsewhere.link.transitions().find((transition) => transition.to === 'ended');
  assert.equal(ended?.cause.kind, 'refusal');
  assert.equal(ended?.cause.event, 'resume-cwd-not-honoured');
  assert.match(ended?.cause.detail ?? '', /C:\/somewhere-else/);

  const own = hostOver({ workspaces: provider });
  own.link.deliver('handle-2', sessionNew('C:/repo', { request: sessionNewRequest({ resume: 'abc-123' }) }));
  await settle();
  assert.equal(
    own.processes.started[0]?.request.cwd,
    'C:/repo',
    'control: the same resume at the root runs there',
  );
});

// A refused open goes on the wire. A line in this host's log alone would leave the controller
// with a session record nobody could talk to while the operator watched a session that "did
// nothing".
test('regression: a refused open reaches the controller as spawning to ended, the refusal as its cause', async () => {
  const { link, processes } = hostOver({});
  link.deliver('handle-1', sessionNew(null)); // no provider, no cwd: path-input-missing
  await settle();

  assert.equal(processes.started.length, 0, 'nothing started');
  const ended = link.transitions().find((transition) => transition.to === 'ended');
  assert.ok(ended, 'the controller was never told the open failed');
  assert.equal(ended?.from, 'spawning');
  assert.equal(ended?.cause.kind, 'refusal');
  assert.equal(ended?.cause.event, 'path-input-missing');
  assert.match(ended?.cause.detail ?? '', /nowhere to run/);
});

test('regression: a null cwd under a workspace provider provisions normally; the ask was already advisory', async () => {
  // The controller-side fact this arm exists for: a controller whose host provisions worktrees has
  // no directory to ask for. Null reaches this dispatcher, and the provider decides exactly as it
  // does for a stated ask.
  const provider: WorkspaceProvider = {
    provision: async () => ok({ path: 'C:/provisioned', meta: {} }),
    release: async () => ok(undefined),
  };
  const { link, processes } = hostOver({ workspaces: provider });
  link.deliver('handle-1', sessionNew(null));
  await settle();

  assert.equal(processes.started.length, 1, 'a null ask under a provider must start a session');
  assert.equal(processes.started[0]?.request.cwd, 'C:/provisioned');
  assert.equal(
    link.transitions()[0]?.where.cwd,
    'C:/provisioned',
    'the controller learns where its session is from the transition, same as a stated ask',
  );
});

test('regression: a null cwd with no provider refuses path-input-missing; there is no decider to defer to', async () => {
  // The other half of "null is the provider decides": with no provider there is no decider, and
  // falling back to the host's own cwd would be the weakest isolation this package knows, chosen by
  // an absence. Refused by name instead, and no session may exist afterwards.
  const events: HostEvent[] = [];
  const { host, link, processes } = hostOver({ events });
  link.deliver('handle-1', sessionNew(null));
  await settle();

  assert.equal(processes.started.length, 0, 'a session started with a directory nobody chose');
  const refused = events.filter(
    (event): event is Extract<HostEvent, { kind: 'refusal' }> => event.kind === 'refusal',
  );
  assert.equal(refused[0]?.refusal.reason, 'path-input-missing');
  assert.equal(host.session('handle-1').ok, false, 'the refused open left a session behind');
});

test('a workspace that cannot be provisioned refuses the session rather than falling back to a directory nobody chose', async () => {
  const events: HostEvent[] = [];
  const provider: WorkspaceProvider = {
    provision: async () => ({
      ok: false,
      refusal: refusal('workspace-provision-failed', 'the disk is full'),
    }),
    release: async () => ok(undefined),
  };
  const { link, processes } = hostOver({ workspaces: provider, events });
  link.deliver('handle-1', sessionNew('C:/work'));
  await settle();

  assert.equal(processes.started.length, 0, 'a session started without the directory it was refused');
  const refused = events.filter(
    (event): event is Extract<HostEvent, { kind: 'refusal' }> => event.kind === 'refusal',
  );
  assert.equal(refused[0]?.refusal.reason, 'workspace-provision-failed');
});

test('a workspace this host asked for and could not use is handed back, not leaked', async () => {
  const released: string[] = [];
  const provider: WorkspaceProvider = {
    provision: async () => ok({ path: 'C:/provisioned', meta: {} }),
    release: async (sessionId) => {
      released.push(sessionId);
      return ok(undefined);
    },
  };
  const link = new FakeLink();
  // A descriptor with no description is refused at registration, which happens after the workspace
  // has already been claimed, so this is the path where the claim would otherwise be stranded.
  new PeriscopeHost({
    controllerUrl: 'ws://unused',
    hostId: 'test-host',
    decide: allow,
    protectedPaths: [],
    registry: registryOver(fakeAgents().start),
    workspaces: provider,
    tools: {
      name: 'proof',
      descriptors: [{ name: 'x', description: '', inputSchema: {} }],
      invoke: async () => ({ text: '' }),
    },
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
  });

  link.deliver('handle-1', sessionNew('C:/work'));
  await settle();

  assert.deepEqual(released, ['handle-1'], 'a refused start kept the workspace it had already claimed');
});

test('regression: a bulk request this host cannot resolve answers with a failure receipt, not with silence', async () => {
  const { link } = hostOver({
    bulk: () => ({ ok: false, refusal: refusal('bulk-target-invalid', 'no such thing') }),
  });
  link.deliver('handle-1', {
    kind: 'bulk_request',
    deliveryId: 'd1',
    what: 'x',
    fromOffset: 0,
    postUrl: 'http://c/',
  });
  await settle();

  const failure = link.sent.find((entry) => entry.payload.kind === 'bulk_failed');
  assert.ok(failure !== undefined, 'a bulk request that could not be served said nothing back');
  assert.equal((failure.payload as { deliveryId: string }).deliveryId, 'd1');
});

test('regression: a bulk POST presents the host credential', async () => {
  const root = await tempDir('bulk-cred');
  const file = join(root, 'payload.txt');
  await writeFile(file, 'the pulled bytes\n', 'utf8');

  const seen: Array<Record<string, string | string[] | undefined>> = [];
  const { createServer } = await import('node:http');
  const sink = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      seen.push({ ...request.headers });
      response.statusCode = 200;
      response.end();
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const port = (sink.address() as { port: number }).port;

  try {
    const credential: ControllerCredential = {
      authorize: () => Promise.resolve(ok({ header: 'Authorization', value: 'Bearer host-token-1' })),
    };
    const { link } = hostOver({ credential, bulk: () => ok(file), controllerUrl: `ws://127.0.0.1:${port}` });
    link.deliver('handle-1', {
      kind: 'bulk_request',
      deliveryId: 'd-cred',
      what: 'x',
      fromOffset: 0,
      postUrl: `http://127.0.0.1:${port}/bulk/d-cred`,
    });
    await answered(link, 'bulk_delivered', 'the credentialed delivery receipt');

    assert.equal(seen.length, 1, 'the sink saw no POST');
    assert.equal(
      seen[0]?.['authorization'],
      'Bearer host-token-1',
      'the same credential the link and the decision POST present must ride the bulk POST',
    );
  } finally {
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('a bulk POST with no credential configured stays headerless; anonymity is a posture, not a bug', async () => {
  const root = await tempDir('bulk-anon');
  const file = join(root, 'payload.txt');
  await writeFile(file, 'anonymous bytes\n', 'utf8');

  const seen: Array<Record<string, string | string[] | undefined>> = [];
  const { createServer } = await import('node:http');
  const sink = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      seen.push({ ...request.headers });
      response.statusCode = 200;
      response.end();
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const port = (sink.address() as { port: number }).port;

  try {
    const { link } = hostOver({ bulk: () => ok(file), controllerUrl: `ws://127.0.0.1:${port}` });
    link.deliver('handle-1', {
      kind: 'bulk_request',
      deliveryId: 'd-anon',
      what: 'x',
      fromOffset: 0,
      postUrl: `http://127.0.0.1:${port}/bulk/d-anon`,
    });
    await answered(link, 'bulk_delivered', 'the anonymous delivery receipt');

    assert.equal(seen.length, 1, 'the sink saw no POST');
    assert.equal(
      seen[0]?.['authorization'],
      undefined,
      'no credential configured must mean no authorization header; the parity arm for the test above',
    );
  } finally {
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('regression: a session_new whose open throws becomes a named refusal, never an unhandled rejection', async () => {
  // The dispatcher calls `void this.#open(…)`, so an uncaught throw would reject a promise nobody
  // held: the controller would receive nothing, its record of the session would read `open`
  // forever, and a host with no unhandledRejection handler could die outright. The workspace
  // provider is the cheapest real throw source; it sits inside `#compose`, exactly where
  // `readWhere` and the composer do.
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    const exploding: WorkspaceProvider = {
      provision: () => {
        throw new Error('the provider exploded');
      },
      release: () => Promise.resolve(ok(undefined)),
    };
    const events: HostEvent[] = [];
    const { link } = hostOver({ workspaces: exploding, events });
    link.deliver('handle-boom', sessionNew('C:/work'));
    await settle();
    // Give any rejection a full turn of the microtask queue to surface before its absence is asserted.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const refused = events.filter((event) => event.kind === 'refusal');
    assert.ok(refused.length > 0, 'the throw produced no refusal; it vanished, which is the defect');
    assert.equal(
      (refused[0] as { refusal: { reason: string } }).refusal.reason,
      'session-spawn-failed',
      'the failure must be named, not swallowed into silence',
    );
    assert.match(
      String((refused[0] as { refusal: { detail: string } }).refusal.detail),
      /the provider exploded/,
      'and it must carry the underlying cause, or the operator learns only that something failed',
    );
    assert.deepEqual(
      rejections,
      [],
      'an unhandled rejection escaped; none may, and that is the whole property',
    );
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('control: the same session_new with a working provider still opens', async () => {
  // The discriminator: without it, an `#open` that refused everything would make the test above
  // green while having broken every session this host can start.
  const events: HostEvent[] = [];
  const fine: WorkspaceProvider = {
    provision: () => Promise.resolve(ok({ path: 'C:/work/provisioned', meta: {} })),
    release: () => Promise.resolve(ok(undefined)),
  };
  const { link } = hostOver({ workspaces: fine, events });
  link.deliver('handle-fine', sessionNew('C:/work'));
  await settle();

  assert.ok(
    events.some((event) => event.kind === 'session-opened'),
    'the identical frame that the throwing provider refused must open here, or the pair is not a discriminator',
  );
});

test('regression: a bulk_request naming a foreign origin answers bulk_failed, and the credential never leaves', async () => {
  const root = await tempDir('bulk-foreign');
  const file = join(root, 'payload.txt');
  await writeFile(file, 'secret transcript bytes\n', 'utf8');

  const seen: Array<Record<string, string | string[] | undefined>> = [];
  const { createServer } = await import('node:http');
  const attacker = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      seen.push({ ...request.headers });
      response.statusCode = 200;
      response.end();
    });
  });
  await new Promise<void>((resolve) => attacker.listen(0, '127.0.0.1', resolve));
  const attackerPort = (attacker.address() as { port: number }).port;

  try {
    const credential: ControllerCredential = {
      authorize: () => Promise.resolve(ok({ header: 'Authorization', value: 'Bearer p1.host.secret' })),
    };
    // The host's controller is a different origin from the one the frame names. `+1` is enough:
    // the binding is on the whole origin, and a neighbouring port is a different peer.
    const { link } = hostOver({
      credential,
      bulk: () => ok(file),
      controllerUrl: `ws://127.0.0.1:${attackerPort + 1}`,
    });
    link.deliver('handle-1', {
      kind: 'bulk_request',
      deliveryId: 'd-foreign',
      what: 'x',
      fromOffset: 0,
      postUrl: `http://127.0.0.1:${attackerPort}/bulk/d-foreign`,
    });

    // The answer is still a receipt. A refusal that reached only the local reporter would read to
    // the controller as a host that hung, the failure the closed dispatch set exists to end.
    await answered(link, 'bulk_failed', 'the foreign-origin refusal receipt');
    const failure = link.sent.find((entry) => entry.payload.kind === 'bulk_failed');
    assert.ok(failure !== undefined);
    assert.equal(
      (failure.payload as unknown as { refusal?: { reason?: string } }).refusal?.reason,
      'bulk-target-not-controller',
      'the wire must carry the specific reason, not a generic delivery failure',
    );

    assert.deepEqual(seen, [], 'the foreign origin must receive nothing: no bytes, and no credential');
  } finally {
    await new Promise<void>((resolve) => attacker.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('a finished session releases its handle, and the link is told after the ending is recorded', async () => {
  const { host, link, processes } = hostOver();
  link.deliver('handle-1', sessionNew('C:/work'));
  await settle();
  processes.started[0]?.finish();
  await settle();

  assert.equal(host.session('handle-1').ok, false, 'a finished session is still reachable by its handle');
  assert.deepEqual(link.forgotten, ['handle-1']);
  assert.ok(
    link.causes().includes('process/process_ended'),
    `no ending in the trace: ${link.causes().join(', ')}`,
  );

  const lastTransition = link.transitions().at(-1);
  assert.equal(lastTransition?.to, 'ended', 'the ending was not the last thing said about the session');
});

// --- the degrade audience ----------------------------------------------------

/**
 * The degrade pin: every kind the sessions layer can raise has an audience in the shipped host.
 *
 * The sessions layer names its conditions and raises them into a listener set; without the
 * subscription in `#compose` that set has no subscribers, and the one message that tells an
 * operator how to resolve an id collision is raised and never received. This walks every declared
 * kind through a host-composed session and requires each to arrive as a `degrade` HostEvent.
 *
 * The record below is the exhaustiveness guarantee: widening `SessionDegrade['kind']` without
 * adding the new kind here refuses to compile, so the pin cannot quietly stop covering something.
 */
const EVERY_DEGRADE_KIND: Record<SessionDegrade['kind'], true> = {
  workspace_untrusted: true,
  subscriber_failed: true,
  session_id_collision: true,
};

test('regression: every degrade kind reaches the host reporter as a degrade event', async () => {
  for (const kind of Object.keys(EVERY_DEGRADE_KIND) as SessionDegrade['kind'][]) {
    const events: HostEvent[] = [];
    const { host, link } = hostOver({ events });
    link.deliver('handle-1', sessionNew('C:/work'));
    await settle();

    const composed = host.session('handle-1');
    assert.ok(composed.ok, `no session to degrade for kind ${kind}`);
    composed.value.session.degrade(kind, `a ${kind} raised at the pin's request`);

    const arrived = events.filter(
      (event): event is Extract<HostEvent, { kind: 'degrade' }> => event.kind === 'degrade',
    );
    assert.equal(
      arrived.length,
      1,
      `a ${kind} degrade was raised and the host reported ${arrived.length} of it`,
    );
    assert.equal(arrived[0]?.degrade.kind, kind, 'the kind must travel whole');
    assert.equal(arrived[0]?.sessionKey, 'handle-1', 'keyed by the controller handle, like every host event');
    assert.equal(
      arrived[0]?.degrade.detail,
      `a ${kind} raised at the pin's request`,
      'the detail is the operator instruction and must travel whole',
    );
  }
});

test('a degrade raised before the subscription still arrives; the replay is load-bearing', async () => {
  // The registry raises `workspace_untrusted` inside `create()` when settings files are requested
  // in a workspace nobody trusted, which is before `#compose` can possibly have subscribed. The
  // fixture's home directory does not exist, so trust is never `trusted` and the raise is real.
  //
  // Built by hand rather than through `hostOver` because the default host posture grants
  // (`grantOnAllow: true`), and a granting gate composed with settings sources is refused by name
  // (`permission-grant-shadows-settings`), so the one request that raises a create-time degrade
  // never makes a session under the default. The embedder override is the supported posture for
  // exactly this combination.
  const events: HostEvent[] = [];
  const link = new FakeLink();
  new PeriscopeHost({
    controllerUrl: 'ws://unused',
    hostId: 'test-host',
    decide: allow,
    protectedPaths: [],
    gate: { grantOnAllow: false },
    registry: registryOver(fakeAgents().start),
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
    report: (event) => events.push(event),
  });
  link.deliver(
    'handle-1',
    sessionNew('C:/work', { request: sessionNewRequest({ settingSources: ['project'] }) }),
  );
  await settle();

  const arrived = events.filter(
    (event): event is Extract<HostEvent, { kind: 'degrade' }> => event.kind === 'degrade',
  );
  assert.equal(arrived.length, 1, 'the create-time degrade was raised into a set nobody had joined yet');
  assert.equal(arrived[0]?.degrade.kind, 'workspace_untrusted');
  assert.match(
    arrived[0]?.degrade.detail ?? '',
    /settings sources project/,
    'the operator instruction travels whole',
  );
});

test('control: the same degrade on a session composed without the host reaches no reporter', () => {
  // The pair above/below is the discriminator: one variable changes (host wiring), and the two
  // sides must disagree. If a bare `composeSession` also delivered a host event, the pin above
  // would be proving the reporter plumbing rather than the host's subscription.
  const fake = fakeAgents();
  const composed = composeSession({
    registry: registryOver(fake.start),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink: new FakeLink(),
    decide: allow,
  });
  assert.ok(composed.ok);

  composed.value.session.degrade('session_id_collision', 'raised with no host in the wiring');

  assert.equal(
    composed.value.session.degrades.length,
    1,
    'the raise itself must be real, or this control proves nothing',
  );
  // No reporter exists on this path; `composeSession` takes no host report option at all. The
  // recorded-but-undelivered state is the defect the pin above guards against, reproduced on purpose.
});

// --- the discovery door -------------------------------------------------------

/**
 * The closed-set pin: every payload kind is classified, and the classification is exhaustive.
 *
 * The dispatcher's whole doctrine is that a command is handled and everything else is refused by
 * name. This record is the exhaustiveness guarantee, in the degrade-pin's shape: widening
 * `SessionPayload` without classifying the new kind here refuses to compile, so the set cannot
 * quietly grow an unclassified member, the exact path by which a command could vanish.
 */
const EVERY_PAYLOAD_KIND: { [K in SessionPayloadKind]: 'command' | 'refused' } = {
  session_new: 'command',
  session_prompt: 'command',
  session_cancel: 'command',
  session_configure: 'command',
  bulk_request: 'command',
  session_list: 'command',
  transcript_list: 'command',
  transcript_tail: 'command',
  workspace_release: 'command',
  workspace_release_bulk: 'command',
  host_configure: 'command',
  workspace_list: 'command',
  repository_list: 'command',
  repository_read: 'command',
  session_update: 'refused',
  session_delta: 'refused',
  bulk_delivered: 'refused',
  bulk_failed: 'refused',
  session_list_result: 'refused',
  transcript_list_result: 'refused',
  transcript_tail_result: 'refused',
  transcript_failed: 'refused',
  answer_refused: 'refused',
  workspace_release_result: 'refused',
  workspace_release_bulk_result: 'refused',
  host_configure_result: 'refused',
  workspace_list_result: 'refused',
  repository_list_result: 'refused',
  repository_read_result: 'refused',
};

/** One minimal instance per kind, kind-correct by construction so the map cannot drift. */
const PAYLOAD_SAMPLES: { [K in SessionPayloadKind]: Extract<SessionPayload, { kind: K }> } = {
  session_new: sessionNew('C:/work'),
  session_prompt: { kind: 'session_prompt', text: 'hello' },
  session_cancel: { kind: 'session_cancel' },
  session_configure: { kind: 'session_configure', model: null, permissionMode: null, thinking: null },
  bulk_request: { kind: 'bulk_request', deliveryId: 'd', what: 'x', fromOffset: 0, postUrl: 'http://c/' },
  session_list: sessionList('r'),
  transcript_list: transcriptList('r'),
  transcript_tail: transcriptTail('r', 's', 'i', 0),
  session_update: { kind: 'session_update', body: {} },
  session_delta: { kind: 'session_delta', body: {} },
  bulk_delivered: { kind: 'bulk_delivered', deliveryId: 'd', byteCount: 1, sizeBytes: null, mtimeMs: null },
  bulk_failed: {
    kind: 'bulk_failed',
    deliveryId: 'd',
    refusal: { reason: 'bulk-delivery-failed', detail: 'x' },
  },
  session_list_result: sessionListResult('r', [], { liveCount: 0, provisioningCount: 0 }),
  transcript_list_result: transcriptListResult('r', [], { totalCount: 0 }),
  transcript_tail_result: transcriptTailResult('r', { found: false, absent: true, newOffset: 0 }),
  transcript_failed: transcriptFailed('r', { reason: 'transcript-path-escape', detail: 'x' }),
  answer_refused: answerRefused('r', { reason: 'frame-too-large', detail: 'x' }),
  workspace_release: workspaceRelease('r', 'w1'),
  workspace_release_result: workspaceReleaseResult('r'),
  workspace_release_bulk: workspaceReleaseBulk('r', [
    { workspaceKey: 'w1', path: null, deleteBranch: false, force: false },
  ]),
  workspace_release_bulk_result: workspaceReleaseBulkResult('r', []),
  host_configure: hostConfigure('r', [{ key: 'PERISCOPE_BRANCH_SCHEME', value: 'x/{key}' }]),
  host_configure_result: hostConfigureResult('r', unsetHostConfiguration(), []),
  workspace_list: workspaceList('r'),
  workspace_list_result: workspaceListResult('r', [], { totalCount: 0 }),
  repository_list: repositoryList('r'),
  repository_list_result: repositoryListResult('r', []),
  repository_read: repositoryRead('r', 'README.md'),
  repository_read_result: repositoryReadResult('r', { text: null, sizeBytes: 0, truncated: false }),
};

test('regression: the closed-set pin; commands are handled, everything else refuses frame-malformed by name', async () => {
  for (const kind of Object.keys(EVERY_PAYLOAD_KIND) as SessionPayloadKind[]) {
    const events: HostEvent[] = [];
    const { link } = hostOver({ events });
    link.deliver('handle-1', PAYLOAD_SAMPLES[kind]);
    await settle();

    const notInbound = events.filter(
      (event): event is Extract<HostEvent, { kind: 'refusal' }> =>
        event.kind === 'refusal' &&
        event.refusal.reason === 'frame-malformed' &&
        /takes no inbound/.test(event.refusal.detail),
    );
    if (EVERY_PAYLOAD_KIND[kind] === 'refused') {
      assert.equal(notInbound.length, 1, `${kind} must refuse as not-a-command; saw ${notInbound.length}`);
      assert.match(
        notInbound[0]?.refusal.detail ?? '',
        new RegExp(`"${kind}"`),
        'the refusal names the kind',
      );
    } else {
      assert.equal(notInbound.length, 0, `${kind} is a command and must not be refused as unknown`);
    }
  }
});

test('session_list answers what this host is running, keyed by the controller handle', async () => {
  const { link } = hostOver();
  link.deliver('handle-1', sessionNew('C:/work'));
  await settle();
  link.deliver('discovery-channel', sessionList('req-1'));
  await settle();

  const answers = link.sent.filter(
    (entry): entry is { sessionId: string; payload: SessionListResult } =>
      entry.payload.kind === 'session_list_result',
  );
  assert.equal(answers.length, 1, 'one ask, one answer');
  assert.equal(answers[0]?.sessionId, 'discovery-channel', 'the answer rides back on the asking channel');
  assert.equal(answers[0]?.payload.requestId, 'req-1');
  const entry = answers[0]?.payload.sessions[0];
  assert.equal(answers[0]?.payload.sessions.length, 1);
  assert.equal(entry?.sessionKey, 'handle-1', 'the entry carries the handle the asker can act on');
  assert.equal(entry?.cwd, 'C:/work');
});

/**
 * The discovery handlers do real filesystem work, so a fixed number of event-loop turns is not a
 * settlement guarantee under whole-suite load. Wait on the observable outcome instead.
 */
async function answered(
  link: FakeLink,
  kind: SessionPayloadKind,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (link.sent.some((entry) => entry.payload.kind === kind)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('transcript_list serves a page from the discovery root, and absence of a root is a named wire answer', async () => {
  const root = await tempDir('host-discovery');
  try {
    await writeFile(join(root, 'notes.txt'), 'not a slug dir\n', 'utf8');
    const { link } = hostOver({ transcriptsRoot: root });
    link.deliver('discovery-channel', transcriptList('req-2'));
    await answered(link, 'transcript_list_result', 'the page answer');

    const answers = link.sent.filter((entry) => entry.payload.kind === 'transcript_list_result');
    assert.equal(answers.length, 1, 'a configured root must answer with a page, even an empty one');

    // The same ask against a host with no root: still an answer, still on the wire, still named.
    const bare = hostOver();
    bare.link.deliver('discovery-channel', transcriptList('req-3'));
    await answered(bare.link, 'transcript_failed', 'the no-root failure answer');
    const failed = bare.link.sent.filter(
      (entry): entry is { sessionId: string; payload: TranscriptFailed } =>
        entry.payload.kind === 'transcript_failed',
    );
    assert.equal(failed.length, 1, 'a host with no root must say so, not go quiet');
    assert.equal(failed[0]?.payload.refusal.reason, 'path-input-missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('regression: a jailed transcript_tail refusal arrives on the wire as transcript_failed, never as silence', async () => {
  const root = await tempDir('host-discovery');
  try {
    const { link } = hostOver({ transcriptsRoot: root });
    link.deliver('discovery-channel', transcriptTail('req-4', '..', 'session-id', 0));
    await answered(link, 'transcript_failed', 'the jail failure answer');

    const failed = link.sent.filter(
      (entry): entry is { sessionId: string; payload: TranscriptFailed } =>
        entry.payload.kind === 'transcript_failed',
    );
    assert.equal(failed.length, 1, 'the jail refusal must reach the asker');
    assert.equal(failed[0]?.payload.refusal.reason, 'transcript-path-escape');
    assert.equal(failed[0]?.payload.requestId, 'req-4', 'the failure names the request it answers');

    // And an absent transcript is a value: the tail result says absent, no failure anywhere.
    link.deliver('discovery-channel', transcriptTail('req-5', 'no-such-slug', 'no-such-id', 0));
    await answered(link, 'transcript_tail_result', 'the absent-transcript answer');
    const tails = link.sent.filter(
      (entry): entry is { sessionId: string; payload: TranscriptTailResult } =>
        entry.payload.kind === 'transcript_tail_result',
    );
    assert.equal(tails.length, 1);
    assert.equal(tails[0]?.payload.absent, true);
    assert.equal(tails[0]?.payload.found, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- the workspace key, and the reap (protocol v5) ---------------------------

/** A provider that records every call: what key provisioned, what key released, with what option. */
function keyedProvider(): {
  provider: WorkspaceProvider;
  provisions: string[];
  releases: { id: string; remove: boolean | undefined }[];
} {
  const provisions: string[] = [];
  const releases: { id: string; remove: boolean | undefined }[] = [];
  return {
    provisions,
    releases,
    provider: {
      provision: async (id) => {
        provisions.push(id);
        return ok({ path: `C:/ws/${id}`, meta: {} });
      },
      release: async (id, releaseOptions) => {
        releases.push({ id, remove: releaseOptions?.remove });
        return ok(undefined);
      },
    },
  };
}

/** The result frames a reap answered with, in arrival order. */
function releaseResults(
  link: FakeLink,
): { requestId: string; refusal: { reason: string; detail: string } | null }[] {
  return link.sent
    .filter((entry) => entry.payload.kind === 'workspace_release_result')
    .map(
      (entry) =>
        entry.payload as unknown as { requestId: string; refusal: { reason: string; detail: string } | null },
    );
}

test('regression: a session_new carrying a workspaceKey provisions at that key; null provisions at the session key', async () => {
  const keyed = keyedProvider();
  const { link } = hostOver({ workspaces: keyed.provider });

  link.deliver('handle-1', sessionNew('C:/work', { workspaceKey: 'effort-1' }));
  await settle();
  // The control: an unkeyed open still provisions at the session key.
  link.deliver('handle-2', sessionNew('C:/work'));
  await settle();

  assert.deepEqual(keyed.provisions, ['effort-1', 'handle-2'], 'the key did not steer the provision');
});

test('two sessions naming one workspaceKey resolve to the same workspace path', async () => {
  const keyed = keyedProvider();
  const { link, processes } = hostOver({ workspaces: keyed.provider });

  link.deliver('handle-1', sessionNew(null, { workspaceKey: 'effort-1' }));
  await settle();
  link.deliver('handle-2', sessionNew(null, { workspaceKey: 'effort-1' }));
  await settle();

  assert.equal(processes.started.length, 2);
  assert.equal(processes.started[0]?.request.cwd, 'C:/ws/effort-1');
  assert.equal(
    processes.started[1]?.request.cwd,
    processes.started[0]?.request.cwd,
    'one key, two sessions, two different directories; the shared topology did not happen',
  );
});

test('regression: an illegal workspaceKey refuses before any workspace is claimed, naming the field', async () => {
  const keyed = keyedProvider();
  const events: HostEvent[] = [];
  const { link, processes } = hostOver({ workspaces: keyed.provider, events });

  link.deliver('handle-1', sessionNew('C:/work', { workspaceKey: 'solo:bad' }));
  await settle();

  assert.equal(
    keyed.provisions.length,
    0,
    'the claim happened first; the key must be refused before any provision',
  );
  assert.equal(processes.started.length, 0);
  const refusals = events.filter(
    (event): event is Extract<HostEvent, { kind: 'refusal' }> =>
      event.kind === 'refusal' && event.refusal.reason === 'workspace-provision-failed',
  );
  assert.equal(refusals.length, 1);
  assert.match(
    refusals[0]?.refusal.detail ?? '',
    /session_new\.workspaceKey/,
    'the refusal must name the field',
  );
  assert.match(refusals[0]?.refusal.detail ?? '', /':'/, 'the refusal must name the offending character');

  // The control: the same open with a legal key provisions exactly once. Without this arm, a
  // guard refusing every key would make the zero-provision assertion green while proving nothing.
  link.deliver('handle-2', sessionNew('C:/work', { workspaceKey: 'effort-1' }));
  await settle();
  assert.deepEqual(
    keyed.provisions,
    ['effort-1'],
    'the control key must provision, or this pair is not a discriminator',
  );
});

test('a workspaceKey on a host with no provider refuses loudly, never runs in the controller cwd', async () => {
  const events: HostEvent[] = [];
  const { link, processes } = hostOver({ events });

  link.deliver('handle-1', sessionNew('C:/work', { workspaceKey: 'effort-1' }));
  await settle();

  assert.equal(processes.started.length, 0, 'the session ran anyway; the wrong topology, delivered silently');
  const refusals = events.filter(
    (event): event is Extract<HostEvent, { kind: 'refusal' }> =>
      event.kind === 'refusal' && event.refusal.reason === 'workspace-provision-failed',
  );
  assert.equal(refusals.length, 1);
  assert.match(refusals[0]?.refusal.detail ?? '', /no workspace provider/);
});

test('regression: an aliased session releases its workspace key at close, not its session key', async () => {
  const keyed = keyedProvider();
  const { link, processes } = hostOver({ workspaces: keyed.provider });

  link.deliver('handle-1', sessionNew(null, { workspaceKey: 'effort-1' }));
  await settle();
  processes.started[0]?.finish();
  await settle();

  assert.deepEqual(
    keyed.releases.map((entry) => entry.id),
    ['effort-1'],
    'the claim was taken at the workspace key and handed back at the session key; a leak per aliased session',
  );

  // The control: an unkeyed session still releases its session key.
  link.deliver('handle-2', sessionNew(null));
  await settle();
  processes.started[1]?.finish();
  await settle();
  assert.equal(keyed.releases[1]?.id, 'handle-2');
});

test('regression: an ordinary close passes no remove option; only workspace_release passes remove: true', async () => {
  const keyed = keyedProvider();
  const { link, processes } = hostOver({ workspaces: keyed.provider });

  link.deliver('handle-1', sessionNew(null, { workspaceKey: 'effort-1' }));
  await settle();
  processes.started[0]?.finish();
  await settle();
  assert.equal(
    keyed.releases[0]?.remove,
    undefined,
    'a session ending must leave the directory; the default moved',
  );

  link.deliver('ops-channel', workspaceRelease('r1', 'effort-1'));
  await settle();
  assert.equal(keyed.releases[1]?.id, 'effort-1');
  assert.equal(keyed.releases[1]?.remove, true, 'the reap is the one path that removes, and it did not');
  assert.deepEqual(
    releaseResults(link).map((result) => result.refusal),
    [null],
    'a completed reap answers refusal: null on the wire',
  );
});

test('regression: the in-use guard is many-to-one; a reap refuses until the last session on the key is gone', async () => {
  const keyed = keyedProvider();
  const { link, processes } = hostOver({ workspaces: keyed.provider });

  link.deliver('handle-1', sessionNew(null, { workspaceKey: 'effort-1' }));
  await settle();
  link.deliver('handle-2', sessionNew(null, { workspaceKey: 'effort-1' }));
  await settle();

  // Close one of the two. A single-mapping guard clears here, and would let the reap delete a
  // tree the second session is still working in.
  processes.started[0]?.finish();
  await settle();
  link.deliver('ops-channel', workspaceRelease('r1', 'effort-1'));
  await settle();

  const afterOne = releaseResults(link);
  assert.equal(afterOne.length, 1);
  assert.notEqual(
    afterOne[0]?.refusal,
    null,
    'one session closed and the reap went through; the guard is 1:1',
  );
  assert.match(afterOne[0]?.refusal?.detail ?? '', /live or opening session/);
  assert.equal(
    keyed.releases.some((entry) => entry.remove === true),
    false,
    'the provider was asked to remove anyway',
  );

  // The control: close the last session and the same ask succeeds. Without it, a guard that
  // refuses every reap would make the refusal arm green while proving nothing.
  processes.started[1]?.finish();
  await settle();
  link.deliver('ops-channel', workspaceRelease('r2', 'effort-1'), 2);
  await settle();

  const afterBoth = releaseResults(link);
  assert.equal(afterBoth.length, 2);
  assert.equal(
    afterBoth[1]?.refusal,
    null,
    'the key is free and the reap still refused; the guard never clears',
  );
  assert.equal(keyed.releases.filter((entry) => entry.remove === true).length, 1);
});

test('a reap of an illegal key answers a named refusal and never reaches the provider', async () => {
  const keyed = keyedProvider();
  const { link } = hostOver({ workspaces: keyed.provider });

  link.deliver('ops-channel', workspaceRelease('r1', 'solo:bad'));
  await settle();

  const results = releaseResults(link);
  assert.equal(results.length, 1, 'every exit is a wire answer; this one vanished');
  assert.equal(results[0]?.refusal?.reason, 'workspace-release-failed');
  assert.match(results[0]?.refusal?.detail ?? '', /workspace_release\.workspaceKey/);
  assert.equal(keyed.releases.length, 0);
});

test('regression: a reap of a near-64KiB key answers a named refusal small enough to send', async () => {
  // Without a length arm the refusal detail would echo the key verbatim, so exactly this input
  // would inflate the answer toward `MAX_FRAME_BYTES` and the named refusal would degrade to
  // silence. The arm refuses by length and the echo is `keyPreview`-bounded.
  const keyed = keyedProvider();
  const { link } = hostOver({ workspaces: keyed.provider });

  link.deliver('ops-channel', workspaceRelease('r1', 'k'.repeat(60_000)));
  await settle();

  const results = releaseResults(link);
  assert.equal(results.length, 1, 'every exit is a wire answer; this one vanished');
  assert.equal(results[0]?.refusal?.reason, 'workspace-release-failed');
  assert.match(results[0]?.refusal?.detail ?? '', /over the 200-character bound/);
  assert.ok(
    (results[0]?.refusal?.detail ?? '').length < 400,
    'the refusal detail carries the whole key; the answer is back inside the degradation margin',
  );
  assert.equal(keyed.releases.length, 0, 'an over-length key reached the provider');
});

test('a reap on a host with no provider answers a named refusal, never a silence', async () => {
  const { link } = hostOver();
  link.deliver('ops-channel', workspaceRelease('r1', 'effort-1'));
  await settle();

  const results = releaseResults(link);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.refusal?.reason, 'workspace-release-failed');
  assert.match(results[0]?.refusal?.detail ?? '', /no workspace provider/);
});

test('a reap the provider refuses carries the provider refusal back on the wire', async () => {
  const failing: WorkspaceProvider = {
    provision: async () => ok({ path: 'C:/ws/x', meta: {} }),
    release: async () => ({
      ok: false,
      refusal: refusal('workspace-release-failed', 'the directory is locked'),
    }),
  };
  const { link } = hostOver({ workspaces: failing });
  link.deliver('ops-channel', workspaceRelease('r1', 'effort-1'));
  await settle();

  const results = releaseResults(link);
  assert.equal(results.length, 1);
  assert.match(
    results[0]?.refusal?.detail ?? '',
    /locked/,
    'the provider refusal must travel, not be summarised away',
  );
});

test('regression: a configured default workspace key gathers unkeyed sessions into one workspace', async () => {
  const keyed = keyedProvider();
  const { link, processes } = hostOver({ workspaces: keyed.provider, defaultWorkspaceKey: 'shared-tree' });

  link.deliver('handle-1', sessionNew(null));
  await settle();
  link.deliver('handle-2', sessionNew(null));
  await settle();

  assert.deepEqual(keyed.provisions, ['shared-tree', 'shared-tree']);
  assert.equal(
    processes.started[0]?.request.cwd,
    processes.started[1]?.request.cwd,
    'two unkeyed sessions, two paths',
  );

  // A frame that names a key never has the default consulted: a default for an absence, never an
  // override.
  link.deliver('handle-3', sessionNew(null, { workspaceKey: 'stated' }));
  await settle();
  assert.equal(keyed.provisions[2], 'stated', 'the configured default overrode a stated key');
});

test('control: with no default, the same two unkeyed sessions provision at different paths', async () => {
  const keyed = keyedProvider();
  const { link, processes } = hostOver({ workspaces: keyed.provider });

  link.deliver('handle-1', sessionNew(null));
  await settle();
  link.deliver('handle-2', sessionNew(null));
  await settle();

  assert.deepEqual(keyed.provisions, ['handle-1', 'handle-2']);
  assert.notEqual(
    processes.started[0]?.request.cwd,
    processes.started[1]?.request.cwd,
    'unkeyed sessions collapsed into one directory; the ?? resolution is ordered wrongly',
  );
});

// --- the per-key turns ----------------------------------------------------------
//
// Shared keys make the concurrent same-key window reachable (13 to 18 s measured for a real
// `git worktree add`, the same order for `git worktree remove --force`) and `#dispatch` fires
// every workspace verb fire-and-forget. The reachable interleavings, each an arm below: a
// `session_new` provisioning into a directory the reap is mid-deleting (the in-use scan happened
// before the multi-second await), a reap starting inside `#close`'s window (the map entry is gone
// before its release settles), and two same-key provisions overlapping. The guard is one serial
// queue per key at the provider chokepoint; the control arm proves different keys never wait.
//
// Every arm delivers its frames with no `settle()` between them, same doctrine as the two-send
// race above: the window is held open by the fixture, so the race is deterministic.

/** A provider that logs start/done per call and holds every release open until the test says otherwise. */
function heldReleaseProvider(): { provider: WorkspaceProvider; log: string[]; finishReleases: () => void } {
  let open = (): void => {};
  const window = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  const log: string[] = [];
  return {
    log,
    finishReleases: () => open(),
    provider: {
      provision: async (id) => {
        log.push(`provision:${id}:start`);
        log.push(`provision:${id}:done`);
        return ok({ path: `C:/ws/${id}`, meta: {} });
      },
      release: async (id, releaseOptions) => {
        log.push(`release:${id}:start${releaseOptions?.remove === true ? ':remove' : ''}`);
        await window;
        log.push(`release:${id}:done`);
        return ok(undefined);
      },
    },
  };
}

test('regression: a session_new arriving mid-reap waits for the removal instead of provisioning into it', async () => {
  // The reap needs no prior session at the key; release is idempotent on the provider. The
  // removal is started first and held open by the fixture, and the open lands inside that
  // window; the settle between the two frames cannot shut it, so the race is deterministic.
  // (An open dispatched in the same tick as the reap takes its reservation first and the reap
  // refuses in-use: the safe direction, already pinned by the many-to-one arm.)
  const { provider, log, finishReleases } = heldReleaseProvider();
  const { link, processes } = hostOver({ workspaces: provider });

  link.deliver('ops-channel', workspaceRelease('r1', 'effort-1'));
  await settle();
  link.deliver('handle-1', sessionNew(null, { workspaceKey: 'effort-1' }));
  await settle();

  // Mid-window, the control on the fixture: if the removal had already finished here, the
  // ordering assertion below would pass against a host that serializes nothing.
  assert.ok(
    log.includes('release:effort-1:start:remove'),
    'the reap never started; this window proves nothing',
  );
  assert.ok(
    !log.includes('provision:effort-1:start'),
    'the open provisioned into the mid-delete window; the defect',
  );

  finishReleases();
  await settle();

  assert.deepEqual(
    log,
    [
      'release:effort-1:start:remove',
      'release:effort-1:done',
      'provision:effort-1:start',
      'provision:effort-1:done',
    ],
    'the removal and the provision overlapped on one key',
  );
  assert.equal(releaseResults(link)[0]?.refusal, null, 'the reap did not answer released');
  assert.equal(processes.started.length, 1, 'the queued open never became a session');
});

test('regression: a reap arriving while a closing session release is in flight waits for it', async () => {
  const { provider, log, finishReleases } = heldReleaseProvider();
  const { link, processes } = hostOver({ workspaces: provider });

  link.deliver('handle-1', sessionNew(null, { workspaceKey: 'effort-1' }));
  await settle();
  log.length = 0;

  // The close deletes the map entry synchronously and its release is held by the fixture, so
  // after this settle the key already reads as free while the release is still in flight, which
  // is exactly the window. The settle here cannot shut the window; the fixture holds it.
  processes.started[0]?.finish();
  await settle();
  assert.ok(log.includes('release:effort-1:start'), 'the close never released; there is no window to race');

  link.deliver('ops-channel', workspaceRelease('r1', 'effort-1'));
  await settle();

  // Mid-window: the close's release started (no remove), the reap's removal has not.
  assert.ok(
    !log.includes('release:effort-1:start:remove'),
    'the reap removed while the close release ran; the defect',
  );

  finishReleases();
  await settle();

  assert.deepEqual(
    log,
    [
      'release:effort-1:start',
      'release:effort-1:done',
      'release:effort-1:start:remove',
      'release:effort-1:done',
    ],
    'the two releases overlapped on one key',
  );
  assert.equal(releaseResults(link)[0]?.refusal, null, 'the reap did not answer released');
});

/** A provider that logs and holds every provision open: the other verb's window. */
function heldProvisionProvider(): {
  provider: WorkspaceProvider;
  log: string[];
  finishProvisions: () => void;
} {
  let open = (): void => {};
  const window = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  const log: string[] = [];
  return {
    log,
    finishProvisions: () => open(),
    provider: {
      provision: async (id) => {
        log.push(`provision:${id}:start`);
        await window;
        log.push(`provision:${id}:done`);
        return ok({ path: `C:/ws/${id}`, meta: {} });
      },
      release: async () => ok(undefined),
    },
  };
}

test('regression: two session_new on one key provision serially, never overlapping', async () => {
  const { provider, log, finishProvisions } = heldProvisionProvider();
  const { link, processes } = hostOver({ workspaces: provider });

  link.deliver('handle-1', sessionNew(null, { workspaceKey: 'effort-1' }));
  link.deliver('handle-2', sessionNew(null, { workspaceKey: 'effort-1' }));
  await settle();

  // Mid-window: exactly one provision may be inside the provider.
  assert.deepEqual(
    log,
    ['provision:effort-1:start'],
    'both opens reached the provider inside one window; the defect',
  );

  finishProvisions();
  await settle();

  assert.deepEqual(
    log,
    [
      'provision:effort-1:start',
      'provision:effort-1:done',
      'provision:effort-1:start',
      'provision:effort-1:done',
    ],
    'the two provisions overlapped on one key',
  );
  assert.equal(processes.started.length, 2, 'a queued open was lost rather than run after its turn');
});

test('control: two session_new on different keys provision concurrently', async () => {
  // The discriminator: one variable changes (the key), and the outcomes must disagree with the
  // arm above; an executor that serialized every key behind one lock would pass the serial arm
  // while making every workspace on this host wait on every other.
  const { provider, log, finishProvisions } = heldProvisionProvider();
  const { link, processes } = hostOver({ workspaces: provider });

  link.deliver('handle-1', sessionNew(null, { workspaceKey: 'effort-1' }));
  link.deliver('handle-2', sessionNew(null, { workspaceKey: 'effort-2' }));
  await settle();

  assert.deepEqual(
    [...log].sort(),
    ['provision:effort-1:start', 'provision:effort-2:start'],
    'an unrelated key waited on a held one; the serialization is over-broad',
  );

  finishProvisions();
  await settle();
  assert.equal(processes.started.length, 2);
});

// --- host_configure (v7) ------------------------------------------------------------

function configureResults(link: FakeLink): HostConfigureResult[] {
  return link.sent
    .filter((entry) => entry.payload.kind === 'host_configure_result')
    .map((entry) => entry.payload as HostConfigureResult);
}

test('host_configure without a configuration seam answers config-write-failed on the wire, never silence', async () => {
  const { link } = hostOver();
  link.deliver(
    'discovery-channel',
    hostConfigure('cfg-1', [{ key: 'PERISCOPE_BRANCH_SCHEME', value: 'x/{key}' }]),
  );
  await settle();

  const answers = configureResults(link);
  assert.equal(answers.length, 1, 'every configure ask is answered');
  assert.equal(answers[0]?.refusal?.reason, 'config-write-failed');
  assert.equal(answers[0]?.requestId, 'cfg-1');
  assert.deepEqual(
    answers[0]?.configuration,
    unsetHostConfiguration(),
    'a refusal still reports the effective view',
  );
});

test('a reconfigure that applies swaps the transcripts root live, reports the new view, and re-announces the hello', async () => {
  const root = await tempDir('host-reconfigure');
  try {
    const asked: { entries: readonly HostConfigureEntry[]; hostBusy: boolean }[] = [];
    const configuration: HostConfiguration = {
      ...unsetHostConfiguration(),
      transcriptsRoot: root,
      controllerUrl: 'ws://unused',
      decisionUrl: null,
      agentHome: null,
    };
    const { link } = hostOver({
      reconfigure: (entries, hostBusy) => {
        asked.push({ entries, hostBusy });
        return ok({
          workspaces: undefined,
          transcriptsRoot: root,
          bulk: undefined,
          linkCapabilities: ['workspace:none'],
          configuration,
          overriddenByEnvironment: ['PERISCOPE_REPOSITORY_ROOT'],
          pendingRestart: [],
        });
      },
    });

    // Before: no transcripts root, so the discovery door refuses by name.
    link.deliver('discovery-channel', transcriptList('before'));
    await answered(link, 'transcript_failed', 'the no-root failure');

    link.deliver('discovery-channel', hostConfigure('cfg-2', [{ key: 'PERISCOPE_AGENT_HOME', value: root }]));
    await settle();
    const answers = configureResults(link);
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.refusal, null, 'the seam applied, so the answer is the applied one');
    assert.deepEqual(answers[0]?.configuration, configuration);
    assert.deepEqual(answers[0]?.overriddenByEnvironment, ['PERISCOPE_REPOSITORY_ROOT']);
    assert.deepEqual(
      asked,
      [{ entries: [{ key: 'PERISCOPE_AGENT_HOME', value: root }], hostBusy: false }],
      'an idle host asks the seam with hostBusy false',
    );
    assert.deepEqual(
      link.announced,
      { capabilities: ['workspace:none'], configuration, pendingRestart: [] },
      'the next hello must declare the new view',
    );

    // After: the same ask now serves a page from the new root. The swap is observable, not asserted
    // from the answer alone.
    link.deliver('discovery-channel', transcriptList('after'));
    await answered(link, 'transcript_list_result', 'the page from the new root');
    assert.equal(link.sent.filter((entry) => entry.payload.kind === 'transcript_list_result').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a seam refusal is relayed by name with the unchanged view, and nothing is swapped', async () => {
  const { link } = hostOver({
    reconfigure: () => refuse('config-host-busy', 'a workspace root cannot change while a session is live'),
  });
  link.deliver(
    'discovery-channel',
    hostConfigure('cfg-3', [{ key: 'PERISCOPE_WORKSPACE_ROOT', value: '/srv/ws' }]),
  );
  await settle();

  const answers = configureResults(link);
  assert.equal(answers[0]?.refusal?.reason, 'config-host-busy');
  assert.deepEqual(answers[0]?.configuration, unsetHostConfiguration());
  assert.equal(link.announced, null, 'a refused change must not re-announce anything');
});

test('the seam is told the host is busy while a session is opening or live', async () => {
  const seen: boolean[] = [];
  const { link } = hostOver({
    reconfigure: (_entries, hostBusy) => {
      seen.push(hostBusy);
      return refuse('config-host-busy', 'busy');
    },
  });
  link.deliver('handle-1', sessionNew('C:/work'));
  link.deliver(
    'discovery-channel',
    hostConfigure('cfg-4', [{ key: 'PERISCOPE_WORKSPACE_ROOT', value: '/srv/ws' }]),
  );
  await settle();
  assert.deepEqual(seen, [true], 'a session that has been asked for, opening or live, makes the host busy');
});

// --- workspace_list (v7) ------------------------------------------------------------

function listResults(link: FakeLink): WorkspaceListResult[] {
  return link.sent
    .filter((entry) => entry.payload.kind === 'workspace_list_result')
    .map((entry) => entry.payload as WorkspaceListResult);
}

function inventoryOf(entries: readonly WorkspaceEntry[]): WorkspaceProvider {
  return {
    provision: async (id: string) => ok({ path: `/work/${id}`, meta: {} }),
    release: async () => ok(undefined),
    inventory: async (): Promise<Result<WorkspaceInventory>> => ok({ entries, defaultBranch: 'main' }),
  };
}

function entryNamed(key: string): WorkspaceEntry {
  return {
    key,
    path: `/work/${key}`,
    branch: `repo/${key}`,
    head: 'abc',
    detached: false,
    locked: false,
    prunable: false,
    merged: false,
    aheadCount: null,
    lastCommitAt: null,
  };
}

test('workspace_list answers a page from the provider inventory, paged like the transcript listing', async () => {
  const entries = Array.from({ length: 27 }, (_, index) => entryNamed(`session-${index + 1}`));
  const { link } = hostOver({ workspaces: inventoryOf(entries) });

  link.deliver('discovery-channel', workspaceList('ws-1'));
  await answered(link, 'workspace_list_result', 'the first page');
  const first = listResults(link)[0];
  assert.equal(first?.refusal, null);
  assert.equal(first?.entries.length, 25, 'one page');
  assert.equal(first?.totalCount, 27);
  assert.equal(first?.nextIndex, 25, 'two more remain');
  assert.equal(first?.defaultBranch, 'main');

  link.deliver('discovery-channel', workspaceList('ws-2', 25));
  await settle();
  const second = listResults(link)[1];
  assert.equal(second?.entries.length, 2);
  assert.equal(second?.nextIndex, null, 'the last page ends the listing');
  assert.equal(second?.entries[0]?.key, 'session-26');
});

test('a host with no provider, or a provider without an inventory, answers workspace-list-failed on the wire', async () => {
  const bare = hostOver();
  bare.link.deliver('discovery-channel', workspaceList('ws-3'));
  await answered(bare.link, 'workspace_list_result', 'the no-provider answer');
  assert.equal(listResults(bare.link)[0]?.refusal?.reason, 'workspace-list-failed');

  const noInventory: WorkspaceProvider = {
    provision: async (id: string) => ok({ path: `/work/${id}`, meta: {} }),
    release: async () => ok(undefined),
  };
  const withoutInventory = hostOver({ workspaces: noInventory });
  withoutInventory.link.deliver('discovery-channel', workspaceList('ws-4'));
  await answered(withoutInventory.link, 'workspace_list_result', 'the no-inventory answer');
  const answer = listResults(withoutInventory.link)[0];
  assert.equal(answer?.refusal?.reason, 'workspace-list-failed');
  assert.match(answer?.refusal?.detail ?? '', /keeps no inventory/);
  assert.equal(answer?.totalCount, 0);
});

test('a provider inventory that refuses or throws lands as the same named answer, never silence', async () => {
  const refusing: WorkspaceProvider = {
    ...inventoryOf([]),
    inventory: async () => refuse('workspace-list-failed', 'fatal: not a git repository'),
  };
  const { link } = hostOver({ workspaces: refusing });
  link.deliver('discovery-channel', workspaceList('ws-5'));
  await answered(link, 'workspace_list_result', 'the refused answer');
  assert.match(listResults(link)[0]?.refusal?.detail ?? '', /not a git repository/);

  const throwing: WorkspaceProvider = {
    ...inventoryOf([]),
    inventory: async () => {
      throw new Error('boom');
    },
  };
  const thrown = hostOver({ workspaces: throwing });
  thrown.link.deliver('discovery-channel', workspaceList('ws-6'));
  await answered(thrown.link, 'workspace_list_result', 'the thrown answer');
  assert.match(listResults(thrown.link)[0]?.refusal?.detail ?? '', /boom/);
});

// --- repository_list / repository_read (v8) ----------------------------------------------

function repositoryLists(link: FakeLink): RepositoryListResult[] {
  return link.sent
    .filter((entry) => entry.payload.kind === 'repository_list_result')
    .map((entry) => entry.payload as RepositoryListResult);
}

function repositoryReads(link: FakeLink): RepositoryReadResult[] {
  return link.sent
    .filter((entry) => entry.payload.kind === 'repository_read_result')
    .map((entry) => entry.payload as RepositoryReadResult);
}

/** Wait until `count` answers of `kind` have been sent, like `answered` for the second and later ones. */
async function answeredTimes(
  link: FakeLink,
  kind: SessionPayloadKind,
  count: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (link.sent.filter((entry) => entry.payload.kind === kind).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A provider that names a repository root and does nothing else; the host reads under it. */
function providerRootedAt(repositoryRoot: string): WorkspaceProvider {
  return {
    repositoryRoot,
    provision: async (id: string) => ok({ path: `/work/${id}`, meta: {} }),
    release: async () => ok(undefined),
  };
}

test("repository_list and repository_read answer under the provider's repository root, jailed and bounded", async () => {
  const root = await tempDir('repository-read');
  try {
    await mkdir(join(root, 'docs', 'notes'), { recursive: true });
    await writeFile(join(root, 'docs', 'a.md'), '# A\n\nhello\n', 'utf8');
    await writeFile(join(root, 'docs', 'b.md'), 'b', 'utf8');
    const { link } = hostOver({ workspaces: providerRootedAt(root) });

    link.deliver('discovery-channel', repositoryList('rl-1', 'docs'));
    await answered(link, 'repository_list_result', 'the listing');
    const listed = repositoryLists(link)[0];
    assert.equal(listed?.refusal, null);
    assert.deepEqual(
      listed?.entries.map((entry) => [entry.name, entry.directory]),
      [
        ['a.md', false],
        ['b.md', false],
        ['notes', true],
      ],
      'sorted by name, directories flagged',
    );
    assert.equal(listed?.truncated, false);

    link.deliver('discovery-channel', repositoryRead('rr-1', 'docs/a.md', 3));
    await answered(link, 'repository_read_result', 'the read');
    const read = repositoryReads(link)[0];
    assert.equal(read?.refusal, null);
    assert.equal(read?.text, '# A', 'the first maxBytes of the file');
    assert.equal(read?.sizeBytes, 11);
    assert.equal(read?.truncated, true);

    link.deliver('discovery-channel', repositoryList('rl-2', '../'));
    await answeredTimes(link, 'repository_list_result', 2, 'the refused listing');
    assert.equal(
      repositoryLists(link)[1]?.refusal?.reason,
      'repository-path-escape',
      'a path above the root is refused by name',
    );
    link.deliver('discovery-channel', repositoryRead('rr-2', 'docs/missing.md', 100));
    await answeredTimes(link, 'repository_read_result', 2, 'the refused read');
    assert.equal(
      repositoryReads(link)[1]?.refusal?.reason,
      'repository-read-failed',
      'an absent file is refused by name',
    );
    assert.equal(repositoryReads(link)[1]?.text, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a host with no repository root answers repository-path-escape to both asks: nothing to read under', async () => {
  const { link } = hostOver();
  link.deliver('discovery-channel', repositoryList('rl-3', ''));
  await answered(link, 'repository_list_result', 'the rootless listing');
  assert.equal(repositoryLists(link)[0]?.refusal?.reason, 'repository-path-escape');
  assert.match(repositoryLists(link)[0]?.refusal?.detail ?? '', /no repository root/);

  link.deliver('discovery-channel', repositoryRead('rr-3', 'README.md', 100));
  await answered(link, 'repository_read_result', 'the rootless read');
  assert.equal(repositoryReads(link)[0]?.refusal?.reason, 'repository-path-escape');
});

// ── The release flags, the path address and the bulk ask ────────────────────────────────────────

/** A provider answering a receipt, recording every release ask, and addressable by path under `root`. */
function receiptProvider(root = 'C:/ws'): {
  provider: WorkspaceProvider;
  asks: { id: string; options: ReleaseOptions | undefined }[];
} {
  const asks: { id: string; options: ReleaseOptions | undefined }[] = [];
  return {
    asks,
    provider: {
      provision: async (id) => ok({ path: `${root}/${id}`, meta: {} }),
      release: async (id, options) => {
        asks.push({ id, options });
        return ok({
          path: `${root}/${id}`,
          directoryRemoved: true,
          branchDeleted: options?.deleteBranch === true,
          refusal: null,
        });
      },
      keyForPath: (path) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null),
    },
  };
}

/** The single release results a host answered, whole. */
function releaseReceipts(link: FakeLink): WorkspaceReleaseResult[] {
  return link.sent
    .filter((entry) => entry.payload.kind === 'workspace_release_result')
    .map((entry) => entry.payload as WorkspaceReleaseResult);
}

/** The bulk release results a host answered, whole. */
function bulkReceipts(link: FakeLink): WorkspaceReleaseBulkResult[] {
  return link.sent
    .filter((entry) => entry.payload.kind === 'workspace_release_bulk_result')
    .map((entry) => entry.payload as WorkspaceReleaseBulkResult);
}

test('workspace_release passes deleteBranch and force to the provider and answers its receipt', async () => {
  const keyed = receiptProvider();
  const { link } = hostOver({ workspaces: keyed.provider });

  link.deliver('ops-channel', workspaceRelease('r1', 'effort-1', { deleteBranch: true, force: true }));
  await settle();

  assert.deepEqual(
    keyed.asks[0]?.options,
    { remove: true, deleteBranch: true, force: true },
    'the flags did not reach the provider',
  );
  const [result] = releaseReceipts(link);
  assert.deepEqual(
    {
      key: result?.workspaceKey,
      path: result?.path,
      dir: result?.directoryRemoved,
      branch: result?.branchDeleted,
      refusal: result?.refusal,
    },
    { key: 'effort-1', path: 'C:/ws/effort-1', dir: true, branch: true, refusal: null },
    'the receipt did not ride the result',
  );
});

test('workspace_release by path resolves to the key under the provider root; an unplaceable path refuses by name', async () => {
  const keyed = receiptProvider();
  const { link } = hostOver({ workspaces: keyed.provider });

  link.deliver('ops-channel', workspaceRelease('r1', { path: 'C:/ws/effort-2' }));
  await settle();
  link.deliver('ops-channel', workspaceRelease('r2', { path: 'D:/elsewhere/effort-2' }), 2);
  await settle();

  assert.deepEqual(
    keyed.asks.map((ask) => ask.id),
    ['effort-2'],
    'only the placeable path reached the provider',
  );
  const [placed, elsewhere] = releaseReceipts(link);
  assert.equal(placed?.workspaceKey, 'effort-2', 'the path was not resolved to its key');
  assert.equal(placed?.refusal, null);
  assert.equal(elsewhere?.refusal?.reason, 'workspace-release-failed');
  assert.match(
    elsewhere?.refusal?.detail ?? '',
    /workspace_release\.path .* is not a directory directly under/,
  );
  assert.equal(
    elsewhere?.path,
    'D:/elsewhere/effort-2',
    'the refused path is echoed so the caller can tell which entry it was',
  );
});

test('control: an ask naming both a key and a path, or neither, refuses by name and releases nothing', async () => {
  const keyed = receiptProvider();
  const { link } = hostOver({ workspaces: keyed.provider });

  link.deliver('ops-channel', { ...workspaceRelease('r1', 'effort-1'), path: 'C:/ws/effort-1' });
  await settle();
  link.deliver('ops-channel', { ...workspaceRelease('r2', 'effort-1'), workspaceKey: null }, 2);
  await settle();

  assert.deepEqual(keyed.asks, [], 'an ambiguous or empty address reached the provider');
  const [both, neither] = releaseReceipts(link);
  assert.match(both?.refusal?.detail ?? '', /names both a workspaceKey and a path/);
  assert.match(neither?.refusal?.detail ?? '', /names neither a workspaceKey nor a path/);
});

test('a provider receipt carrying a partial refusal rides the result with its flags intact', async () => {
  const partial: WorkspaceProvider = {
    provision: async (id) => ok({ path: `C:/ws/${id}`, meta: {} }),
    release: async (id) =>
      ok({
        path: `C:/ws/${id}`,
        directoryRemoved: true,
        branchDeleted: false,
        refusal: refusal('workspace-release-failed', 'removed the worktree but could not delete the branch'),
      }),
  };
  const { link } = hostOver({ workspaces: partial });

  link.deliver('ops-channel', workspaceRelease('r1', 'effort-1', { deleteBranch: true }));
  await settle();

  const [result] = releaseReceipts(link);
  assert.equal(result?.directoryRemoved, true, 'the partial lost what DID happen');
  assert.equal(result?.branchDeleted, false);
  assert.equal(result?.refusal?.reason, 'workspace-release-failed');
  assert.match(result?.refusal?.detail ?? '', /could not delete the branch/);
});

test('workspace_release_bulk answers one result per entry in ask order, and a refusal never aborts the rest', async () => {
  const keyed = receiptProvider();
  const { link, processes } = hostOver({ workspaces: keyed.provider });

  link.deliver('handle-1', sessionNew(null, { workspaceKey: 'effort-2' }));
  await settle();
  assert.equal(processes.started.length, 1, 'the session on effort-2 did not open');

  link.deliver(
    'ops-channel',
    workspaceReleaseBulk('b1', [
      { workspaceKey: 'effort-1', path: null, deleteBranch: true, force: false },
      { workspaceKey: 'effort-2', path: null, deleteBranch: true, force: false },
      { workspaceKey: null, path: 'C:/ws/effort-3', deleteBranch: false, force: false },
    ]),
  );
  await settle();

  const [answer] = bulkReceipts(link);
  assert.equal(answer?.requestId, 'b1');
  assert.deepEqual(
    answer?.results.map((result) => [
      result.workspaceKey,
      result.refusal?.reason ?? null,
      result.branchDeleted,
    ]),
    [
      ['effort-1', null, true],
      ['effort-2', 'workspace-release-failed', false],
      ['effort-3', null, false],
    ],
    'the in-use refusal in the middle must not abort the entries around it, and order is the ask order',
  );
  assert.match(answer?.results[1]?.refusal?.detail ?? '', /still backs a live or opening session/);
  assert.deepEqual([...keyed.asks.map((ask) => ask.id)].sort(), ['effort-1', 'effort-3']);
});

test('a key named twice in one bulk ask is refused on its second entry, and the first still releases', async () => {
  const keyed = receiptProvider();
  const { link } = hostOver({ workspaces: keyed.provider });

  link.deliver(
    'ops-channel',
    workspaceReleaseBulk('b1', [
      { workspaceKey: 'effort-1', path: null, deleteBranch: false, force: false },
      { workspaceKey: 'effort-1', path: null, deleteBranch: false, force: false },
    ]),
  );
  await settle();

  const [answer] = bulkReceipts(link);
  assert.equal(answer?.results[0]?.refusal, null);
  assert.match(answer?.results[1]?.refusal?.detail ?? '', /named twice in one ask/);
  assert.equal(keyed.asks.length, 1, 'the duplicate reached the provider');
});

test("host_configure_result carries the seam's pendingRestart, and a refusal keeps the last one", async () => {
  const { link } = hostOver({
    reconfigure: (entries) =>
      entries[0]?.key === 'PERISCOPE_DECISION_URL'
        ? ok({
            workspaces: undefined,
            transcriptsRoot: undefined,
            bulk: undefined,
            linkCapabilities: ['workspace:none'],
            configuration: { ...unsetHostConfiguration(), decisionUrl: 'https://next.example/decision' },
            overriddenByEnvironment: [],
            pendingRestart: ['PERISCOPE_DECISION_URL'],
          })
        : refuse('config-key-unknown', 'not a wire key'),
  });

  link.deliver(
    'ops-channel',
    hostConfigure('c1', [{ key: 'PERISCOPE_DECISION_URL', value: 'https://next.example/decision' }]),
  );
  await settle();
  link.deliver('ops-channel', hostConfigure('c2', [{ key: 'PERISCOPE_HOST_ID', value: 'x' }]), 2);
  await settle();

  const results = link.sent
    .filter((entry) => entry.payload.kind === 'host_configure_result')
    .map(
      (entry) => entry.payload as { requestId: string; pendingRestart: readonly string[]; refusal: unknown },
    );
  assert.deepEqual(
    results.map((r) => [r.requestId, [...r.pendingRestart], r.refusal === null]),
    [
      ['c1', ['PERISCOPE_DECISION_URL'], true],
      ['c2', ['PERISCOPE_DECISION_URL'], false],
    ],
    'the applied answer names the pending key; a later refusal changes nothing and still names it',
  );
});

// --- answer_refused (v10) ---------------------------------------------------------------------

test('regression: an answer the link refuses as too large is followed by answer_refused with the same request id, once', async () => {
  const { link } = hostOver();
  // The link refuses the first oversized-looking answer exactly as the real one does, and takes the
  // substitute: the controller then learns by name rather than by timeout.
  const refusedOnce: string[] = [];
  const realSend = link.send.bind(link);
  link.send = (sessionId: string, payload: SessionPayload): Result<void> => {
    if (payload.kind === 'repository_read_result' && refusedOnce.length === 0) {
      refusedOnce.push(payload.requestId);
      return refuse('frame-too-large', 'frame is 70000 bytes, over the 65536 limit');
    }
    return realSend(sessionId, payload);
  };

  link.deliver('discovery-channel', repositoryRead('rr-big', 'README.md', 100));
  await answered(link, 'answer_refused', 'the refused answer');

  const substitute = link.sent.find((entry) => entry.payload.kind === 'answer_refused')?.payload;
  assert.ok(substitute !== undefined && substitute.kind === 'answer_refused');
  assert.equal(substitute.requestId, 'rr-big', 'the substitute names the ask it answers');
  assert.equal(substitute.refusal.reason, 'frame-too-large');
  assert.equal(
    link.sent.filter((entry) => entry.payload.kind === 'answer_refused').length,
    1,
    'one substitute per refused answer, never a loop of substitutes',
  );
});
