/**
 * The composition, assembled the way the binary assembles it: a `PeriscopeHost` over its DEFAULT
 * link (a real `ControllerLink` on a real WebSocket), a real HTTP decision endpoint behind
 * `escalatingDecider` and `fetch`, a real workspace provider on disk, and a substitute agent
 * process. `host.test.ts` proves the join with the link and the process both substituted; this file
 * proves the same join with only the process substituted, so a defect that lives in the
 * host-to-link seam (a dial, a hello, a replay, an ack) has somewhere to go red.
 *
 * The controller is the shipped example, imported at run time. It consumes the package by name
 * through `periscope/protocol`, so this test also proves the self-reference resolves from inside
 * the package directory. Node strips the example's types natively; on a node that cannot, the
 * whole file skips and says so, rather than turning an old runtime into a red build.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SessionListResult, SessionPayload } from '../control/frames.js';
import { sessionList, sessionNew } from '../control/frames.js';
import { runPair } from '../bin/pair.js';
import { reconfigureHost } from '../bin/reconfigure.js';
import type { ControllerCredential } from '../control/credential.js';
import type { ControllerLink } from '../control/link.js';
import { escalatingDecider } from '../gate/escalate.js';
import { SessionRegistry } from '../sessions/registry.js';
import { PairedHostCredential } from '../identity/paired-credential.js';
import type { SessionTransition } from '../state/model.js';
import { PlainDirProvider } from '../workspace/plain-dir.js';
import type { WorkspaceProvider } from '../workspace/provider.js';
import { fakeAgents, initMessage } from '../test-support/fake-agent.js';
import { tempDir } from '../test-support/temp-dir.js';
import { waitFor } from '../test-support/ws-peer.js';
import type { AgentProcessRequest, HookInput } from './agent-process.js';
import { writeConfigEntries } from './config-file.js';
import type { HostEvent } from './host.js';
import { PeriscopeHost } from './host.js';
import { FilePairedCredential } from './paired-credential-store.js';
import { pairedCredentialPath } from './paths.js';
import { nodeWorkspaceEffects } from './workspace-fs.js';

/** From dist/host/ up to the package root, then into the example that ships with it. */
const EXAMPLE_CONTROLLER = new URL('../../examples/test-controller/controller.ts', import.meta.url).href;

const SKIP = process.features.typescript
  ? false
  : 'this node cannot strip types; the property is NOT exercised';

// The shape of the example this file drives, restated structurally: the module arrives untyped
// through a run-time import, and the test names only what it touches.
interface ExampleSeen {
  readonly kind: 'frame' | 'ask' | 'answer' | 'tool' | 'bulk' | 'link' | 'door' | 'pair';
  readonly sessionKey: string | null;
  readonly text: string;
  readonly seq?: number;
  readonly payload?: SessionPayload;
}

interface ExampleController {
  readonly controllerUrl: string;
  readonly decisionUrl: string;
  readonly origin: string;
  readonly hostId: string | null;
  readonly connected: boolean;
  readonly seen: readonly ExampleSeen[];
  readonly faults: { readonly duplicates: readonly string[]; readonly gaps: readonly string[] };
  transitions(): SessionTransition[];
  hosts(): { readonly hostId: string; readonly label: string }[];
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  send(sessionKey: string, payload: SessionPayload): void;
}

interface ExampleModule {
  readonly TestController: new (options: { render?: (line: string) => void }) => ExampleController;
}

const preToolUse = (toolName: string, input: unknown, cwd: string): HookInput =>
  ({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: 'call-1',
    tool_input: input,
    session_id: 'agent-1',
    cwd,
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

const TIMEOUT_MS = 2_000;

test(
  'a host over a real link and a real decision endpoint opens a session, gates over HTTP, answers discovery and reconnects densely',
  { skip: SKIP },
  async () => {
    const { TestController } = (await import(EXAMPLE_CONTROLLER)) as ExampleModule;
    const homeDir = await tempDir('end-to-end-home');
    const workspaceRoot = await tempDir('end-to-end-workspaces');
    const controller = new TestController({ render: () => undefined });
    const agents = fakeAgents();
    const events: HostEvent[] = [];
    const linkCauses = (): string[] =>
      events.flatMap((event) => (event.kind === 'link' ? [event.transition.cause] : []));
    // Counted on the controller's side as the control for the host's own `hello_completed`
    // transition (`open -> accepted`), which is what a reporter reads.
    const hellos = (): number =>
      controller.seen.filter(
        (one) => one.kind === 'link' && one.text.startsWith('hello from end-to-end-host'),
      ).length;

    await controller.start();

    const host = new PeriscopeHost({
      controllerUrl: controller.controllerUrl,
      hostId: 'end-to-end-host',
      backoff: { baseMs: 10, maxMs: 50, factor: 2 },
      decide: escalatingDecider({ url: controller.decisionUrl, transport: fetch }),
      protectedPaths: [],
      workspaces: new PlainDirProvider({ root: workspaceRoot, effects: nodeWorkspaceEffects }),
      gate: { decisionTimeoutMs: 1_000, holdAfterMs: 100, matcherTimeoutSeconds: 5 },
      registry: new SessionRegistry({ baseEnv: { PATH: 'p' }, homeDir, startProcess: agents.start }),
      report: (event) => events.push(event),
    });
    const link = host.link as ControllerLink;

    try {
      // ---- the hello -------------------------------------------------------------------------
      host.start();
      await waitFor(() => hellos() === 1, 'the hello to arrive', TIMEOUT_MS);
      assert.ok(controller.connected, 'the controller does not see the host as connected');
      assert.ok(linkCauses().includes('socket_connected'), 'the host did not report the socket opening');
      await waitFor(
        () => linkCauses().includes('hello_completed'),
        'the host to report the acceptance',
        TIMEOUT_MS,
      );
      assert.ok(
        events.some(
          (event) =>
            event.kind === 'link' &&
            event.transition.from === 'open' &&
            event.transition.to === 'accepted' &&
            event.transition.cause === 'hello_completed',
        ),
        'the acceptance must be a transition of its own, open -> accepted, not a dropped self-loop',
      );

      // ---- session_new: the provider decides where, the first frame says so ------------------
      controller.send('s-1', sessionNew(null));
      await waitFor(() => host.session('s-1').ok, 'the session to open', TIMEOUT_MS);
      assert.equal(agents.started.length, 1, 'session_new started no process');
      const opened = events.find((event) => event.kind === 'session-opened');
      assert.ok(opened !== undefined && opened.kind === 'session-opened', 'the open was not reported');
      const cwd = opened.cwd;
      assert.ok(cwd.endsWith('/s-1') || cwd.endsWith('\\s-1'), `the provider did not decide the cwd: ${cwd}`);

      await waitFor(
        () => controller.transitions().some((one) => one.to === 'spawning'),
        'the spawning frame',
        TIMEOUT_MS,
      );
      const first = controller.transitions()[0];
      assert.ok(first !== undefined);
      assert.equal(
        first.cause.event,
        'create_requested',
        'the opening transition is not the first frame on the wire',
      );

      // ---- the agent reports itself: the state moves on, over the real link ------------------
      const agent = agents.started[0];
      assert.ok(agent !== undefined);
      agent.emit(initMessage('agent-1'));
      await waitFor(
        () => controller.transitions().some((one) => one.to === 'ready'),
        'the ready transition',
        TIMEOUT_MS,
      );

      // ---- session_prompt reaches the process ------------------------------------------------
      controller.send('s-1', { kind: 'session_prompt', text: 'say hello' });
      await waitFor(() => agent.prompts.includes('say hello'), 'the prompt to reach the process', TIMEOUT_MS);

      // ---- the gate asks the controller over HTTP, and the answer takes effect ----------------
      const output = await callHooks(
        agent.request,
        preToolUse('Read', { file_path: join(cwd, 'notes.md') }, cwd),
      );
      const asked = controller.seen.filter((one) => one.kind === 'ask' && one.text.startsWith('Read '));
      const answered = controller.seen.filter((one) => one.kind === 'answer' && one.text === 'Read -> allow');
      assert.equal(asked.length, 1, 'the decision endpoint was not asked exactly once');
      assert.equal(answered.length, 1, 'the decision endpoint did not answer over HTTP');
      assert.equal(
        (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
          ?.permissionDecision,
        'allow',
        'the HTTP allow did not become the hook decision',
      );

      // ---- session_list on the host-scoped channel ---------------------------------------------
      const discovery = 'discovery:end-to-end-host';
      controller.send(discovery, sessionList('req-1'));
      await waitFor(
        () => controller.seen.some((one) => one.payload?.kind === 'session_list_result'),
        'the session_list_result',
        TIMEOUT_MS,
      );
      const listed = controller.seen.find((one) => one.payload?.kind === 'session_list_result');
      const result = listed?.payload as SessionListResult;
      assert.equal(listed?.sessionKey, discovery, 'the answer did not ride back on the asking channel');
      assert.equal(result.requestId, 'req-1');
      assert.equal(result.sessions.length, 1, 'the listing does not hold the one live session');
      assert.equal(result.sessions[0]?.sessionKey, 's-1');
      assert.equal(
        result.sessions[0]?.sessionId,
        'agent-1',
        'the listing does not carry the id the agent reported',
      );
      assert.equal(result.liveCount, 1);

      // ---- the controller goes away and comes back on the same ports -------------------------
      // Every written frame is acked before the drop, so a frame replayed after it would be a real
      // fault of the reconnect and not a lost ack dressed as one.
      await waitFor(() => link.queueStats.depth === 0, 'the ack loop to drain', TIMEOUT_MS);
      const framesBefore = controller.seen.filter(
        (one) => one.kind === 'frame' && one.sessionKey === 's-1',
      ).length;

      await controller.stop();
      await waitFor(() => linkCauses().includes('socket_closed'), 'the host to notice the drop', TIMEOUT_MS);
      await controller.restart();
      await waitFor(() => hellos() === 2, 'the link to reconnect', TIMEOUT_MS);
      assert.ok(controller.connected, 'the restarted controller does not see the host');

      // A frame minted after the reconnect must continue the numbering the controller already holds.
      controller.send('s-1', { kind: 'session_prompt', text: 'and again' });
      await waitFor(
        () =>
          controller.seen.filter((one) => one.kind === 'frame' && one.sessionKey === 's-1').length >
          framesBefore,
        'a frame after the reconnect',
        TIMEOUT_MS,
      );
      assert.deepEqual(
        controller.faults,
        { duplicates: [], gaps: [] },
        'the reconnect lost or replayed a frame',
      );
      const seqs = controller.seen.flatMap((one) =>
        one.kind === 'frame' && one.sessionKey === 's-1' ? [one.seq ?? 0] : [],
      );
      assert.deepEqual(
        seqs,
        seqs.map((_, index) => index + 1),
        `the seq is not dense across the reconnect: ${seqs.join(',')}`,
      );
      assert.equal(
        events.filter((event) => event.kind === 'gap').length,
        0,
        'the host reported an inbound gap',
      );

      // ---- a host-scoped ask after the reconnect is answered ---------------------------------
      // The host process survived the drop, so its counters for the channel continue; the
      // controller numbers its side from the cursor the hello reported and seeds its inbound from
      // the first frame. A controller that restarted the channel at 1 would regress the host's
      // tracker and never see an answer.
      controller.send(discovery, sessionList('req-2'));
      await waitFor(
        () =>
          controller.seen.some(
            (one) => (one.payload as { requestId?: unknown } | undefined)?.requestId === 'req-2',
          ),
        'the session_list_result after the reconnect',
        TIMEOUT_MS,
      );
      assert.deepEqual(
        controller.faults,
        { duplicates: [], gaps: [] },
        'the host-scoped channel lost or replayed a frame across the reconnect',
      );
      assert.equal(
        events.filter((event) => event.kind === 'gap').length,
        0,
        'the host reported an inbound gap on the host-scoped channel',
      );
    } finally {
      host.stop('the test is over');
      await waitFor(() => agents.started.every((one) => one.closed()), 'the process to close', TIMEOUT_MS);
      await controller.stop();
      await rm(homeDir, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);

const DOOR_TIMEOUT_MS = 5_000;

test(
  'the reference controller drives every host-scoped ask through its doors, and pairing gates the upgrade',
  { skip: SKIP },
  async () => {
    const { TestController } = (await import(EXAMPLE_CONTROLLER)) as ExampleModule;
    const homeDir = await tempDir('reference-home');
    const workspaceRoot = await tempDir('reference-workspaces');
    const repositoryRoot = await tempDir('reference-repository');
    const transcriptsRoot = await tempDir('reference-transcripts');
    const configDir = await tempDir('reference-config');
    const pairedDir = await tempDir('reference-paired');
    await writeFile(join(repositoryRoot, 'README.md'), 'hello from the repository\n', 'utf8');
    await mkdir(join(transcriptsRoot, 'C--work-repo'), { recursive: true });
    await writeFile(
      join(transcriptsRoot, 'C--work-repo', 'agent-9.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: 'C:/work/repo', message: { role: 'user', content: 'first' } })}\n`,
      'utf8',
    );

    const controller = new TestController({ render: () => undefined });
    const agents = fakeAgents();
    const events: HostEvent[] = [];
    const raw: NodeJS.ProcessEnv = { PERISCOPE_CONFIG_DIR: configDir };
    // The plain provider, given a repository root, so the workspace and repository asks have
    // something to answer about without a git repository in the test.
    const plain = new PlainDirProvider({ root: workspaceRoot, effects: nodeWorkspaceEffects });
    const workspaces: WorkspaceProvider = {
      provision: (id) => plain.provision(id),
      release: (id, options) => plain.release(id, options),
      inventory: () => plain.inventory(),
      repositoryRoot,
    };
    const hostOf = (hostId: string, credential?: ControllerCredential): PeriscopeHost =>
      new PeriscopeHost({
        controllerUrl: controller.controllerUrl,
        hostId,
        ...(credential === undefined ? {} : { credential }),
        backoff: { baseMs: 10, maxMs: 50, factor: 2 },
        decide: escalatingDecider({ url: controller.decisionUrl, transport: fetch }),
        protectedPaths: [],
        workspaces,
        transcriptsRoot,
        gate: { decisionTimeoutMs: 1_000, holdAfterMs: 100, matcherTimeoutSeconds: 5 },
        reconfigure: (entries, hostBusy) =>
          reconfigureHost(raw, entries, hostBusy, {
            controllerUrl: controller.controllerUrl,
            decisionUrl: controller.decisionUrl,
          }),
        registry: new SessionRegistry({ baseEnv: { PATH: 'p' }, homeDir, startProcess: agents.start }),
        report: (event) => events.push(event),
      });
    const accepted = (): number =>
      events.filter((event) => event.kind === 'link' && event.transition.to === 'accepted').length;

    await controller.start();
    // The config file a paired runner has: both addresses, as the pair verb writes them, so a
    // configure that rewrites one names only that one as pending.
    assert.equal(
      writeConfigEntries(raw, [
        { key: 'PERISCOPE_CONTROLLER_URL', value: controller.controllerUrl },
        { key: 'PERISCOPE_DECISION_URL', value: controller.decisionUrl },
      ]),
      null,
    );
    const host = hostOf('reference-host');
    let hostStopped = false;
    let paired: PeriscopeHost | null = null;
    let impostor: PeriscopeHost | null = null;
    try {
      host.start();
      await waitFor(() => accepted() === 1, 'the first host to be accepted', DOOR_TIMEOUT_MS);
      assert.equal(controller.hostId, 'reference-host', 'the controller did not record the hello host id');

      // One live session, so the listing and the inventory have a row.
      controller.send('s-1', sessionNew(null));
      await waitFor(() => host.session('s-1').ok, 'the session to open', DOOR_TIMEOUT_MS);
      agents.started[0]?.emit(initMessage('agent-1'));
      await waitFor(
        () => controller.transitions().some((one) => one.to === 'ready'),
        'the ready transition',
        DOOR_TIMEOUT_MS,
      );

      // ---- every host-scoped ask, through its door ------------------------------------------
      const door = async (
        kind: string,
        members: Record<string, unknown> = {},
      ): Promise<{ status: number; body: Record<string, unknown> }> => {
        const response = await fetch(`${controller.origin}/asks/${kind}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(members),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      };
      const asks: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
        ['session_list', {}, 'session_list_result'],
        ['transcript_list', { fromIndex: 0 }, 'transcript_list_result'],
        [
          'transcript_tail',
          { projectSlug: 'C--work-repo', sessionId: 'agent-9', fromOffset: 0, needle: null },
          'transcript_tail_result',
        ],
        ['workspace_list', { fromIndex: 0 }, 'workspace_list_result'],
        ['repository_list', { path: '' }, 'repository_list_result'],
        ['repository_read', { path: 'README.md', maxBytes: 1024 }, 'repository_read_result'],
        [
          'workspace_release',
          { workspaceKey: 'never-provisioned', path: null, deleteBranch: false, force: false },
          'workspace_release_result',
        ],
        [
          'workspace_release_bulk',
          {
            releases: [
              { workspaceKey: 'never-provisioned-either', path: null, deleteBranch: false, force: false },
            ],
          },
          'workspace_release_bulk_result',
        ],
        // Last: a configure rebuilds the provider from the environment and the config file.
        [
          'host_configure',
          { entries: [{ key: 'PERISCOPE_CONTROLLER_URL', value: 'wss://elsewhere.example/link' }] },
          'host_configure_result',
        ],
      ];
      const answers = new Map<string, Record<string, unknown>>();
      for (const [kind, members, expected] of asks) {
        const { status, body } = await door(kind, members);
        assert.equal(status, 200, `${kind}: the door answered ${status}: ${JSON.stringify(body)}`);
        assert.equal(body['kind'], expected, `${kind}: the door answered a ${String(body['kind'])}`);
        assert.equal(typeof body['requestId'], 'string', `${kind}: the answer carries no requestId`);
        answers.set(kind, body);
      }
      // One answer per ask, each matched on the requestId the controller minted for it.
      const doors = controller.seen.filter((one) => one.kind === 'door');
      assert.equal(doors.length, asks.length, 'the controller did not send one ask per door');
      for (const one of doors) {
        const requestId = one.text.split(' ')[1] ?? '';
        const echoed = [...answers.values()].filter((answer) => answer['requestId'] === requestId);
        assert.equal(echoed.length, 1, `${one.text}: answered ${echoed.length} times`);
      }
      // The content, where the fixtures make it checkable.
      assert.equal((answers.get('session_list')?.['sessions'] as unknown[]).length, 1);
      const transcripts = answers.get('transcript_list')?.['entries'] as {
        sessionId: string;
        cwd: string | null;
      }[];
      assert.deepEqual(
        transcripts.map((entry) => [entry.sessionId, entry.cwd]),
        [['agent-9', 'C:/work/repo']],
      );
      assert.equal(answers.get('transcript_tail')?.['absent'], false, 'the tail did not find the transcript');
      const worktrees = answers.get('workspace_list')?.['entries'] as { key: string }[];
      assert.ok(
        worktrees.some((entry) => entry.key === 's-1'),
        `the inventory does not list the session's directory: ${JSON.stringify(worktrees)}`,
      );
      assert.ok(
        (answers.get('repository_list')?.['entries'] as { name: string }[]).some(
          (entry) => entry.name === 'README.md',
        ),
      );
      assert.match(String(answers.get('repository_read')?.['text']), /hello from the repository/);
      assert.equal(
        answers.get('workspace_release')?.['refusal'],
        null,
        'released or already absent is the same answer',
      );
      assert.equal((answers.get('workspace_release_bulk')?.['results'] as unknown[]).length, 1);
      const configured = answers.get('host_configure');
      assert.equal(
        configured?.['refusal'],
        null,
        `the configure was refused: ${JSON.stringify(configured?.['refusal'])}`,
      );
      assert.deepEqual(
        configured?.['pendingRestart'],
        ['PERISCOPE_CONTROLLER_URL'],
        'a written URL is pending, never applied to the live link',
      );

      // The control: a door that does not exist, and an ask the codec refuses before it is sent.
      const unknown = await door('session_lst');
      assert.equal(unknown.status, 404);
      const malformed = await door('repository_read', { path: 'README.md', maxBytes: 'lots' });
      assert.equal(
        malformed.status,
        400,
        `a malformed ask must be refused at the controller: ${JSON.stringify(malformed.body)}`,
      );
      assert.match(String(malformed.body['error']), /maxBytes/);
      assert.equal(
        controller.seen.filter((one) => one.kind === 'door').length,
        asks.length,
        'a refused ask must not have been sent',
      );

      // ---- pairing: mint a code, redeem it with the real verb, dial with what it wrote --------
      const minted = await fetch(`${controller.origin}/api/periscope/pair-codes`, { method: 'POST' });
      assert.equal(minted.status, 201);
      const { code } = (await minted.json()) as { code: string };
      const pairEnv: NodeJS.ProcessEnv = { PERISCOPE_CONFIG_DIR: pairedDir };
      const quiet = { transport: fetch, write: () => undefined };
      const outcome = await runPair(code, pairEnv, quiet, {
        controller: controller.origin,
        label: 'the reference box',
      });
      assert.ok(outcome.ok, `pair refused: ${outcome.ok ? '' : outcome.detail}`);
      assert.deepEqual(
        controller.hosts().map((one) => one.label),
        ['the reference box'],
      );
      const reused = await runPair(code, pairEnv, quiet, { controller: controller.origin });
      assert.ok(!reused.ok, 'a pair code is single-use');

      // The unpaired host leaves; from here every upgrade presents the paired credential or is refused.
      host.stop('the unpaired host is done');
      hostStopped = true;
      await waitFor(
        () => !controller.connected,
        'the controller to see the unpaired host go',
        DOOR_TIMEOUT_MS,
      );

      const credentialPath = pairedCredentialPath(pairEnv);
      assert.ok(credentialPath !== null);
      const file = new FilePairedCredential(credentialPath).read();
      assert.ok(file.ok, 'the pair verb wrote no credential');
      paired = hostOf(file.value.hostId, new PairedHostCredential(file.value));
      paired.start();
      await waitFor(() => accepted() === 2, 'the paired host to be accepted', DOOR_TIMEOUT_MS);
      assert.equal(
        controller.hostId,
        file.value.hostId,
        'the paired host announces the id the controller assigned',
      );

      impostor = hostOf(
        'ph-impostor',
        new PairedHostCredential({ hostId: 'ph-impostor', credential: 'p1.ph-impostor.not-minted-here' }),
      );
      impostor.start();
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.kind === 'link' &&
              event.transition.to === 'closed' &&
              event.transition.cause === 'credential_rejected',
          ),
        'the impostor to be refused at the door',
        DOOR_TIMEOUT_MS,
      );
      assert.ok(
        events.some((event) => event.kind === 'refusal' && event.refusal.reason === 'link-unauthorized'),
        'the refusal must be named link-unauthorized',
      );
      assert.equal(accepted(), 2, 'the impostor must not have been accepted');
    } finally {
      if (!hostStopped) host.stop('the test is over');
      paired?.stop('the test is over');
      impostor?.stop('the test is over');
      await waitFor(
        () => agents.started.every((one) => one.closed()),
        'the process to close',
        DOOR_TIMEOUT_MS,
      );
      await controller.stop();
      for (const dir of [homeDir, workspaceRoot, repositoryRoot, transcriptsRoot, configDir, pairedDir]) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
);
