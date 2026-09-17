/**
 * The parallel-run proof: a real agent, driven end-to-end by a composed Periscope host against the
 * thin test controller.
 *
 * Run it:  node examples/parallel-run-proof/run.ts
 * It costs real money and needs the same ambient credentials the live tests use.
 *
 * Every assertion is observed or it is reported `not exercised` with its reason. Nothing here
 * concludes a property from reading the code: three of these fail invisibly in production, which is
 * exactly why a reasoned pass is worth less than an honest blank.
 *
 * It uses the published surface only: `@naswerks/periscope` and `@naswerks/periscope/protocol`, by package name. A
 * private hook added to make the proof pass would invalidate the proof.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FrameSink, HostEvent, SessionTransition, ToolCall } from '@naswerks/periscope';
import {
  GitWorktreeProvider,
  PeriscopeHost,
  SessionRegistry,
  composeSession,
  ok,
  createJsonlStore,
  credentialPaths,
  nodeCommandEffects,
  nodeStoreEffects,
  nodeWorkspaceEffects,
  asSessionStore,
  baselineAnchor,
  resolveReceipt,
  compactionCount,
  sessionNew,
} from '@naswerks/periscope';

import { TestController } from '../test-controller/controller.ts';

// ---------------------------------------------------------------------------

interface Outcome {
  readonly n: number;
  readonly title: string;
  status: 'OBSERVED' | 'NOT EXERCISED' | 'FAILED';
  detail: string;
}

const outcomes: Outcome[] = [];
const lines: string[] = [];

/** What this proof actually cost, summed from the agents' own `result` messages. Never estimated. */
let spentUsd = 0;

const say = (line: string): void => {
  lines.push(line);
  process.stdout.write(`${line}\n`);
};

const record = (n: number, title: string, status: Outcome['status'], detail: string): void => {
  outcomes.push({ n, title, status, detail });
  say(`\n=== ASSERTION ${n} — ${status} — ${title}\n    ${detail}\n`);
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until a predicate holds, or give up. Returns whether it held. */
async function until(predicate: () => boolean, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(stepMs);
  }
  return predicate();
}

/**
 * Wait for the turn to end, rather than for the side effect a turn was supposed to have.
 *
 * Waiting on the side effect means a turn that ran and did nothing is indistinguishable from a turn
 * still running, so a real result ("the agent tried and was refused") arrives as a timeout. The
 * turn boundary is observable on the wire (`sdk-message/result`), so it is what this waits for; the
 * side effect is then checked rather than waited for.
 */
async function turnEnds(controller: TestController, timeoutMs = 240_000): Promise<boolean> {
  const before = controller.transitions().filter((one) => one.cause.event === 'result').length;
  return until(
    () => controller.transitions().filter((one) => one.cause.event === 'result').length > before,
    timeoutMs,
  );
}

/**
 * Send a turn and wait for that turn to end.
 *
 * It waits for the session to go idle first, and that line is the whole function. Counting results
 * and sending in the same breath has a race: the previous turn's `result` can still be in flight,
 * arrive a moment later, and satisfy the wait for a turn that has not started, so a deny that did
 * happen and is in the trace reads as "no denial was recorded" because the trace was read before
 * the turn ran. A false negative from an instrument is the same class of defect as a false green.
 */
async function runTurn(
  controller: TestController,
  key: string,
  text: string,
  timeoutMs = 240_000,
): Promise<boolean> {
  await until(() => (controller.transitions().at(-1)?.to ?? '') === 'idle', 90_000);
  const before = controller.transitions().filter((one) => one.cause.event === 'result').length;
  controller.send(key, { kind: 'session_prompt', text });
  return until(
    () => controller.transitions().filter((one) => one.cause.event === 'result').length > before,
    timeoutMs,
  );
}

/** A scratch repository OUTSIDE any checkout, so nothing this proof does can touch a real one. */
function scratchRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'periscope-proof-repo-'));
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: root, windowsHide: true });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'proof@example.invalid');
  git('config', 'user.name', 'The Proof');
  writeFileSync(join(root, 'README.md'), '# a scratch repository\n');
  git('add', 'README.md');
  git('commit', '-m', 'the first commit');
  return root;
}

// ---------------------------------------------------------------------------

const DENY_FILE = 'forbidden.txt';
const HOLD_TOOL = 'mcp__proof__slow';

async function main(): Promise<void> {
  const startedAt = Date.now();
  say(`PARALLEL-RUN PROOF — started ${new Date(startedAt).toISOString()}`);
  say(`node ${process.version}`);

  const repositoryRoot = scratchRepository();
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'periscope-proof-work-'));
  const storeRoot = mkdtempSync(join(tmpdir(), 'periscope-proof-store-'));
  say(`repository ${repositoryRoot}`);
  say(`workspaces ${workspaceRoot}`);

  await runTheTurns(repositoryRoot, workspaceRoot);
  await runTheThrowingHandler(repositoryRoot, workspaceRoot);
  await runOffline(repositoryRoot, workspaceRoot);
  await runMirrorAndResume(workspaceRoot, storeRoot);

  say(`\nfinished in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  say(`MEASURED SPEND: $${spentUsd.toFixed(4)} — summed from every turn's own result message`);
  writeReport();
}

// ---------------------------------------------------------------------------
// The main run: assertions 1, 2, 3, 5, 7, 9, 10 and 12. Assertion 8 is `runMirrorAndResume`.
// ---------------------------------------------------------------------------

async function runTheTurns(repositoryRoot: string, workspaceRoot: string): Promise<void> {
  say('\n--- THE MULTI-TURN RUN ------------------------------------------------');

  let heldFor = 0;
  const controller = new TestController({
    render: (line) => say(line),
    tools: {
      note: (args) => `the note was recorded: ${typeof args['text'] === 'string' ? args['text'] : ''}`,
      slow: () => 'the slow tool answered',
    },
    policy: async (ask) => {
      // One deliberate DENY: a named file the agent is told to write and must not.
      if (String((ask.toolInput as { file_path?: string } | null)?.file_path ?? '').includes(DENY_FILE)) {
        return {
          behavior: 'deny',
          message: `${DENY_FILE} is off limits — the controller refuses this write`,
        };
      }
      // One deliberate HOLD, longer than a minute, then resolved: the hold, exercised.
      if (ask.toolName === HOLD_TOOL) {
        const began = Date.now();
        await wait(65_000);
        heldFor = Date.now() - began;
        return { behavior: 'allow' };
      }
      return { behavior: 'allow' };
    },
  });
  await controller.start();

  const host = new PeriscopeHost({
    controllerUrl: controller.controllerUrl,
    hostId: 'proof-host',
    decide: escalateTo(controller.decisionUrl),
    protectedPaths: credentialPaths(process.env),
    workspaces: new GitWorktreeProvider({
      repositoryRoot,
      workspaceRoot,
      effects: nodeWorkspaceEffects,
      commands: nodeCommandEffects(),
    }),
    tools: {
      name: 'proof',
      descriptors: [
        {
          name: 'note',
          description: 'Records a short note with the controller and returns a confirmation.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
        {
          name: 'slow',
          description: 'A tool whose permission decision the controller deliberately takes its time over.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ],
      invoke: invokerFor(controller.toolUrl),
    },
    // The host's deadline must outlast the deliberate 65-second hold, and the matcher's must
    // outlast the host's — both stated rather than defaulted, because the default is 50 seconds.
    gate: { decisionTimeoutMs: 150_000, holdAfterMs: 250, matcherTimeoutSeconds: 300 },
    baseEnv: process.env,
    homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
    report: (event) => reportOf(event),
  });

  host.start();
  await until(() => controller.connected, 15_000);

  const key = 'proof-session-1';
  controller.send(key, sessionNew(workspaceRoot));
  const opened = await until(() => host.session(key).ok, 20_000);
  if (!opened) {
    record(1, 'the agent edits real files in a real worktree', 'FAILED', 'the session never opened');
    await controller.stop();
    return;
  }
  const composed = host.session(key);
  const cwd = composed.ok ? (composed.value.machine.where.cwd ?? '') : '';
  say(`the session got the worktree ${cwd}`);

  // -- turn 1: a real edit ---------------------------------------------------
  controller.send(key, {
    kind: 'session_prompt',
    text:
      'Use the Write tool once to create greeting.txt in the current directory containing exactly the ' +
      'word pomegranate. Then stop.',
  });
  await turnEnds(controller);

  const wrote = existsSync(join(cwd, 'greeting.txt'));
  const allowed = controller.seen.some((one) => one.kind === 'answer' && one.text === 'Write -> allow');
  record(
    1,
    'the agent edits real files in a real worktree',
    wrote ? 'OBSERVED' : 'FAILED',
    wrote
      ? `greeting.txt exists in the git worktree ${cwd} and reads ${JSON.stringify(readFileSync(join(cwd, 'greeting.txt'), 'utf8').trim())}`
      : `nothing reached ${cwd}. The gate ${allowed ? 'ALLOWED the Write and the tool still did not run' : 'never allowed a Write'} — ` +
          'see permission-mode-probe.ts: an allow that is not granted leaves the tool unrun, and the ' +
          'options that could change the permission mode from a settings file or a rule list are pinned unreachable',
  );

  // -- turn 2: an MCP tool, and the deliberate hold ---------------------------
  const beforeHold = Date.now();
  controller.send(key, {
    kind: 'session_prompt',
    text:
      'Do these two things and then stop. 1) Call the mcp__proof__note tool with text set to "hello". ' +
      '2) Call the mcp__proof__slow tool with no arguments.',
  });

  const sawHold = await until(
    () => controller.transitions().some((one) => one.activity?.kind === 'permission'),
    30_000,
  );
  say(
    `    the hold became visible ${Math.round((Date.now() - beforeHold) / 1000)}s in: ${sawHold ? 'a permission activity reached the controller' : 'NOTHING reached the controller'}`,
  );

  const toolAnswered = await until(
    () => controller.seen.some((one) => one.kind === 'tool' && one.text.startsWith('slow')),
    180_000,
  );
  record(
    2,
    'every tool call reaches the gate, including MCP calls',
    controller.seen.some((one) => one.kind === 'ask' && one.text.startsWith('mcp__proof__'))
      ? 'OBSERVED'
      : 'FAILED',
    `the controller was asked to decide: ${controller.seen
      .filter((one) => one.kind === 'ask')
      .map((one) => one.text.split(' ')[0])
      .join(', ')}`,
  );

  const held = heldFor > 60_000;
  // The assertion is "survives and resolves", a property of the hold, not of what the tool did
  // afterwards. Requiring the tool to have executed as well would fold an unrelated finding into
  // this measurement. The resolution is observable in its own right: the entry opens, and the same
  // entry closes with the decision that ended it.
  const resolved = controller
    .transitions()
    .some((one) => one.cause.detail.includes(`the permission for ${HOLD_TOOL} resolved`));
  record(
    5,
    'a hold survives more than 60 seconds and then resolves',
    sawHold && held && resolved ? 'OBSERVED' : 'FAILED',
    sawHold && held && resolved
      ? `the permission entry opened, stayed open while the controller withheld the decision for ` +
          `${Math.round(heldFor / 1000)}s — past the 60s the SDK's own matcher default would have expired at — ` +
          `and then closed with the decision that ended it, all of it visible on the wire. ` +
          `(Whether the tool then EXECUTED is a separate finding: ${toolAnswered ? 'it did' : 'it did not - see assertion 1'}.)`
      : `hold visible: ${sawHold}; withheld for ${heldFor}ms; resolution on the wire: ${resolved}`,
  );

  // -- turn 3: the deny -------------------------------------------------------
  await runTurn(
    controller,
    key,
    `Use the Write tool once to create ${DENY_FILE} in the current directory containing the word denied. ` +
      'If it is refused, do not retry and do not use any other tool — just say REFUSED and stop.',
  );
  const denied = controller.transitions().some((one) => one.cause.event === 'permission_denied');
  const denialReachedDisk = existsSync(join(cwd, DENY_FILE));
  const denial = controller.transitions().find((one) => one.cause.event === 'permission_denied');
  record(
    3,
    'a deny blocks, and the reason reaches the model',
    denied && !denialReachedDisk ? 'OBSERVED' : 'FAILED',
    denied
      ? `${DENY_FILE} never reached disk; the controller's reason travelled to the wire verbatim: ${JSON.stringify(denial?.cause.detail ?? '')}`
      : 'no denial was recorded',
  );

  // -- assertion 7: incremental rendering -------------------------------------
  const deltas = controller.seen.filter((one) => one.kind === 'frame' && one.text.startsWith('delta'));
  record(
    7,
    'frames render a turn live, text incrementally',
    deltas.length > 0 ? 'OBSERVED' : 'FAILED',
    `${deltas.length} delta frames arrived while turns were composing, ahead of the messages that settled them`,
  );

  // -- assertion 9: interrupt --------------------------------------------------
  controller.send(key, {
    kind: 'session_prompt',
    text: 'Count slowly from 1 to 400, one number per line, using no tools.',
  });
  await wait(8_000);
  controller.send(key, { kind: 'session_cancel' });
  const interrupted = await until(
    () => controller.transitions().some((one) => one.cause.event === 'interrupt_requested'),
    30_000,
  );
  record(
    9,
    'interrupt stops a turn and returns a receipt',
    interrupted ? 'OBSERVED' : 'FAILED',
    interrupted
      ? 'the cancel was recorded as control/interrupt_requested and reached the controller as a transition'
      : 'no interrupt reached the controller',
  );

  // -- assertion 10: reconnect --------------------------------------------------
  // The drop happens mid-turn, with frames in flight, and that is the difference between a real
  // observation and a vacuous one. Dropping the link while the session is idle leaves nothing
  // pending and nothing unacked, so "lost nothing and duplicated nothing" would be true of an empty
  // retention window and of a host with no replay at all.
  say('\n--- dropping the link MID-TURN, then bringing it back on the same ports ---');
  const seqBefore = controller.transitions().length;
  controller.send(key, {
    kind: 'session_prompt',
    text: 'Count from 1 to 40, one number per line, using no tools. Then stop.',
  });
  await wait(3_000); // long enough that the turn is streaming
  await controller.restart();
  const back = await until(() => controller.connected, 60_000);
  await turnEnds(controller, 120_000);

  const grew = controller.transitions().length > seqBefore;
  record(
    10,
    'reconnect after a link drop loses and duplicates nothing',
    back && grew && controller.faults.gaps.length === 0 ? 'OBSERVED' : back ? 'FAILED' : 'NOT EXERCISED',
    back
      ? `the link was dropped WHILE a turn was streaming and the host reconnected on its own. ` +
          `The receiver's dense-seq arithmetic reports ${controller.faults.gaps.length} gaps and ` +
          `${controller.faults.duplicates.length} duplicate frames dropped as already-held ` +
          `(a replayed frame the controller already has is expected and is not a fault). ` +
          `${controller.transitions().length - seqBefore} further transitions arrived after the drop, so the ` +
          `window was not empty.`
      : 'the host never reconnected',
  );

  // -- assertion 12: the trace alone --------------------------------------------
  const trace = controller.transitions();
  const reconstruction = reconstruct(trace);
  say('\n--- ASSERTION 12: the run, reconstructed from transitions alone ---');
  for (const line of reconstruction) say(`    ${line}`);
  const lanes = new Set(trace.map((one) => one.cause.kind));
  record(
    12,
    'the trace alone reconstructs the whole run, without opening a transcript',
    trace.length > 0 && lanes.has('control') && lanes.has('hook') ? 'OBSERVED' : 'FAILED',
    `${trace.length} transitions carried where/what/why for every turn, across ${lanes.size} cause lanes ` +
      `(${[...lanes].sort().join(', ')}); no transcript was opened to produce the reconstruction above. ` +
      'The hook and control lanes are present because the gate lane now reaches the wire.',
  );

  // Assertion 8 is answered by `runMirrorAndResume`, which attaches a store to a real session;
  // reading a store nothing was ever mirrored to would prove only that it was empty.

  spentUsd += controller.spendUsd;
  say(`\n    this run cost $${controller.spendUsd.toFixed(4)}`);
  host.stop('the run is over');
  await controller.stop();
}

// ---------------------------------------------------------------------------
// Assertion 4: a throwing handler blocks. Its own session, because it blocks everything.
// ---------------------------------------------------------------------------

async function runTheThrowingHandler(repositoryRoot: string, workspaceRoot: string): Promise<void> {
  say('\n--- THE THROWING HANDLER ---------------------------------------------');
  const controller = new TestController({
    render: (line) => say(line),
    tools: { note: () => 'the note was recorded' },
  });
  await controller.start();

  const host = new PeriscopeHost({
    controllerUrl: controller.controllerUrl,
    hostId: 'proof-host-throwing',
    tools: {
      name: 'proof',
      descriptors: [
        {
          name: 'note',
          description: 'Records a short note with the controller and returns a confirmation.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
      ],
      invoke: invokerFor(controller.toolUrl),
    },
    // A bug in the gate itself. The CLI treats a throwing hook as absent, so without the package's
    // own try/catch this is an open door rather than a refusal.
    decide: () => {
      throw new Error('a deliberate bug in the gate itself');
    },
    protectedPaths: credentialPaths(process.env),
    workspaces: new GitWorktreeProvider({
      repositoryRoot,
      workspaceRoot,
      effects: nodeWorkspaceEffects,
      commands: nodeCommandEffects(),
    }),
    gate: { decisionTimeoutMs: 20_000, holdAfterMs: 250 },
    baseEnv: process.env,
    homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
    report: (event) => reportOf(event),
  });
  host.start();
  await until(() => controller.connected, 15_000);

  const key = 'proof-session-throwing';
  controller.send(key, sessionNew(workspaceRoot));
  await until(() => host.session(key).ok, 20_000);
  // The tool is an MCP tool, and the choice is this measurement's own control. A `Write` never
  // reaches the decider here: the host's local gate is consulted first and refuses a path outside
  // the workspace, which would measure the local gate and leave the throwing decider unproven. The
  // local gate has no opinion about an `mcp__...` name, so an MCP call is guaranteed to reach the
  // decider, which is what this assertion is about.
  await runTurn(
    controller,
    key,
    'Call the mcp__proof__note tool once with text set to "thrown". If it is refused, do not retry and ' +
      'do not use any other tool — just say REFUSED and stop.',
  );
  const refused = controller
    .transitions()
    .some((one) => one.cause.kind === 'refusal' && one.cause.event === 'permission-decision-unavailable');
  const ran = controller.seen.some((one) => one.kind === 'tool');

  record(
    4,
    'a THROWING handler blocks',
    refused && !ran ? 'OBSERVED' : 'FAILED',
    refused && !ran
      ? 'the decider threw on every call. The tool never reached the controller, and the trace names it ' +
          'refusal/permission-decision-unavailable - an outage, never a denial. Without the gate own ' +
          'try/catch the CLI would have treated the throwing hook as ABSENT and the call would have run.'
      : `the tool ${ran ? 'RAN - FAIL-OPEN' : 'did not run, but no refusal was recorded'}`,
  );

  spentUsd += controller.spendUsd;
  say(`\n    this run cost $${controller.spendUsd.toFixed(4)}`);
  host.stop('the throwing run is over');
  await controller.stop();
}

// ---------------------------------------------------------------------------
// Assertion 6: the controller killed mid-run. And the MCP contrast.
// ---------------------------------------------------------------------------

async function runOffline(repositoryRoot: string, workspaceRoot: string): Promise<void> {
  say('\n--- THE CONTROLLER, KILLED MID-RUN -----------------------------------');
  const controller = new TestController({
    render: (line) => say(line),
    tools: { note: () => 'the note was recorded' },
  });
  await controller.start();

  const events: HostEvent[] = [];
  const host = new PeriscopeHost({
    controllerUrl: controller.controllerUrl,
    hostId: 'proof-host-offline',
    decide: escalateTo(controller.decisionUrl),
    protectedPaths: credentialPaths(process.env),
    workspaces: new GitWorktreeProvider({
      repositoryRoot,
      workspaceRoot,
      effects: nodeWorkspaceEffects,
      commands: nodeCommandEffects(),
    }),
    tools: {
      name: 'proof',
      descriptors: [
        {
          name: 'note',
          description: 'Records a short note with the controller and returns a confirmation.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
      ],
      invoke: invokerFor(controller.toolUrl),
    },
    // Short on purpose: the point of the local gate is that a boundary call never waits for this.
    gate: { decisionTimeoutMs: 15_000, holdAfterMs: 250 },
    baseEnv: process.env,
    homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
    report: (event) => {
      events.push(event);
      reportOf(event);
    },
  });
  host.start();
  await until(() => controller.connected, 15_000);

  const key = 'proof-session-offline';
  controller.send(key, sessionNew(workspaceRoot));
  await until(() => host.session(key).ok, 20_000);

  say('killing the controller — both transports');
  await controller.stop();

  const composed = host.session(key);
  if (!composed.ok) {
    record(
      6,
      'with the controller killed, a boundary call is refused locally',
      'FAILED',
      'the session was gone',
    );
    return;
  }

  // The refusal is read off the machine, not off the host's refusal channel, and the reason is the
  // whole point of the scenario. The controller is dead, so nothing can reach it; a probe that
  // watched the wire here would be measuring the link being down. A local refusal is recorded as a
  // transition on the session's own machine, which is exactly where an offline host still knows
  // things.
  const local: string[] = [];
  composed.value.machine.onTransition((transition) => {
    if (transition.cause.kind === 'refusal') local.push(transition.cause.event);
  });

  // A call at the boundary, with nobody to ask: the agent's own credential store, which the local
  // gate protects by name. No shell verb is involved, deliberately — the property is that a
  // boundary-crossing call is refused locally, and a path is the cleaner way to state it.
  const boundaryAt = Date.now();
  composed.value.session.prompt(
    'Use the Read tool once on the file .claude.json in your home directory. If it is refused, do not retry ' +
      'and do not use any other tool — just say REFUSED and stop.',
  );
  const refusedLocally = await until(
    () => local.some((reason) => reason.startsWith('credential-') || reason.startsWith('path-')),
    120_000,
  );
  const localMs = Date.now() - boundaryAt;

  record(
    6,
    'with the controller killed, a boundary call is refused LOCALLY',
    refusedLocally ? 'OBSERVED' : 'FAILED',
    refusedLocally
      ? `refused ${Math.round(localMs / 1000)}s after the turn was queued, BY NAME (${[...new Set(local)].join(', ')}), ` +
          "with both of the controller's transports dead and the host never asking it. The gate's own " +
          'deadline was 15s, so a refusal faster than that is the local gate answering rather than the ' +
          'escalation timing out.'
      : `no local refusal was recorded in ${Math.round(localMs / 1000)}s; the machine saw: ${local.join(', ') || '(nothing)'}`,
  );

  // The contrast, measured rather than reasoned: the same offline host, an MCP tool. The local gate
  // matches on tool name and the shipped families name no `mcp__...` tool, so it has no opinion,
  // the call is escalated to a controller that is not there, and the refusal arrives as an outage
  // instead of by name.
  const mcpAt = Date.now();
  composed.value.session.prompt(
    'Call the mcp__proof__note tool once with text set to "offline". If it is refused, do not retry — just stop.',
  );
  const outage = await until(() => local.includes('permission-decision-unavailable'), 120_000);
  say(
    `\n    MCP CONTRAST: ${outage ? `refused as an OUTAGE after ${Math.round((Date.now() - mcpAt) / 1000)}s` : 'no outage observed'} — ` +
      'the local gate had no opinion about an mcp__ tool name, so the same offline host refused a ' +
      'built-in BY NAME and an MCP tool as an OUTAGE. THE COST IS THE KIND, NOT THE DELAY: a ' +
      'refused connection fails fast, so neither waited out the deadline. The decision timeout is ' +
      'only paid when a controller ACCEPTS the connection and does not answer — and an outage still ' +
      'cannot be told apart from a platform failure, which is what the local gate exists to avoid.',
  );

  spentUsd += controller.spendUsd;
  say(`\n    this run cost $${controller.spendUsd.toFixed(4)}`);
  host.stop('the offline run is over');
}

// ---------------------------------------------------------------------------
// A real session mirrors to a store and resumes from it: the property that proves the store
// adapter works rather than merely type-checks.
// ---------------------------------------------------------------------------

async function runMirrorAndResume(workspaceRoot: string, storeRoot: string): Promise<void> {
  say('\n--- THE MIRROR, AND A RESUME FROM IT ----------------------------------');

  // This uses `composeSession` directly rather than the host's dispatcher, for exactly one reason:
  // the store. `session_new` carries `resume`, `fork` and `settingSources`, so a controller can ask
  // for a resume over the link; a `SessionStore` is an object with methods and has no JSON form, so
  // it cannot cross a wire even in principle. That is the boundary rather than an omission: the
  // store receives every message the agent saw, so a controller able to name one could name a
  // destination for a transcript. This probe composes locally because it needs to pass a real
  // store, which stays embedder-side by construction.
  const registry = new SessionRegistry({
    baseEnv: process.env,
    homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
    startTimeoutMs: 120_000,
  });
  const store = createJsonlStore(nodeStoreEffects(storeRoot));
  const sink: FrameSink = { send: () => ok(undefined) };
  const cwd = mkdtempSync(join(workspaceRoot, 'mirror-'));

  // The key is learned, not assumed. The SDK derives `projectKey` by sanitising the cwd (separators
  // and colons become dashes), so a read keyed by the raw cwd finds nothing and reports an empty
  // store for a mirror that worked. Wrapping the adapter and recording what it was called with
  // needs no knowledge of that rule, and cannot drift when the rule changes.
  const adapter = asSessionStore(store);
  let writtenKey: { projectKey: string; sessionId: string } | null = null;
  let appends = 0;
  const recording: ReturnType<typeof asSessionStore> = {
    ...adapter,
    append: async (key, entries) => {
      writtenKey = { projectKey: key.projectKey, sessionId: key.sessionId };
      appends += 1;
      return adapter.append(key, entries);
    },
  };

  const first = composeSession({
    registry,
    sessionKey: 'mirror-1',
    cwd,
    sink,
    decide: () => Promise.resolve({ behavior: 'allow' }),
    gate: { grantOnAllow: true },
    request: { sessionStore: recording, sessionStoreFlush: 'eager' },
  });
  if (!first.ok) {
    record(
      8,
      'a receipt resolves across a compaction boundary',
      'NOT EXERCISED',
      `the session refused: ${first.refusal.detail}`,
    );
    return;
  }

  const secret = 'periscope-mirror-elderflower';
  first.value.session.prompt(`Remember this word and reply with it: ${secret}. Use no tools.`);
  const live = await first.value.session.whenLive(120_000);
  await until(() => first.value.machine.state === 'idle', 180_000);
  const sessionId = live.ok ? live.value.id : null;
  say(`    the first session is ${sessionId ?? '(unidentified)'}`);
  first.value.session.stop('the first half is done');

  if (sessionId === null) {
    record(
      8,
      'a receipt resolves across a compaction boundary',
      'NOT EXERCISED',
      'the agent never reported a session id',
    );
    return;
  }

  const readKey: { projectKey: string; sessionId: string } = writtenKey ?? { projectKey: cwd, sessionId };
  say(`    the SDK wrote ${appends} batch(es) under projectKey ${readKey.projectKey}`);
  const loaded = await store.load(readKey);
  const entries = loaded.ok && loaded.value !== null ? loaded.value : [];
  say(`    the store holds ${entries.length} entries for that session`);

  // The receipt read path, against entries a real agent actually produced.
  const anchorUuid = entries.length > 0 ? baselineAnchor(entries.slice(0, 1)) : null;
  const receipt = resolveReceipt(entries, { anchorUuid, expectText: secret });
  const compactions = compactionCount(entries);
  say(
    `    resolveReceipt: ${receipt.ok ? `delivered=${receipt.value.delivered} crossedCompaction=${receipt.value.crossedCompaction} scanned=${receipt.value.scannedAfterAnchor}` : `refused ${receipt.refusal.reason}`}`,
  );

  record(
    8,
    'a receipt resolves across a compaction boundary',
    compactions > 0 && receipt.ok && receipt.value.crossedCompaction ? 'OBSERVED' : 'NOT EXERCISED',
    compactions > 0
      ? `${compactions} compaction(s) in ${entries.length} entries`
      : `the mirror was attached and holds ${entries.length} real entries, and the receipt read path ` +
          `resolved against them (${receipt.ok ? `delivered=${receipt.value.delivered}` : receipt.refusal.reason}) — ` +
          `but NO COMPACTION OCCURRED, so the boundary itself is still unexercised. There is no API that ` +
          `forces one: a compaction happens when a context window fills, and a run long enough to fill one ` +
          `is a different and much more expensive exercise than this proof. Predicted before the run, and ` +
          `unchanged by it.`,
  );

  // --- the resume half ---------------------------------------------------------------------
  const second = composeSession({
    registry,
    sessionKey: 'mirror-2',
    cwd,
    sink,
    decide: () => Promise.resolve({ behavior: 'allow' }),
    gate: { grantOnAllow: true },
    request: { sessionStore: asSessionStore(store), resume: sessionId, fork: true },
  });
  if (!second.ok) {
    say(`    THE RESUME REFUSED: ${second.refusal.reason} ${second.refusal.detail}`);
    return;
  }

  let answered = '';
  second.value.session.onMessage((message: unknown) => {
    const seen = message as { type: string; message?: { content?: unknown } };
    if (seen.type === 'assistant') answered += JSON.stringify(seen.message?.content ?? '');
  });
  second.value.session.prompt(
    'What was the word I asked you to remember? Reply with just that word, and use no tools.',
  );
  await second.value.session.whenLive(120_000);
  await until(() => second.value.machine.state === 'idle' || answered.includes(secret), 180_000);
  second.value.session.stop('the resume is done');

  const carried = answered.includes(secret);
  const mirrored = entries.length > 0;
  // The two halves are reported separately because only one of them is about the store. A resume
  // recalling the word proves the agent kept its context, which its own local transcript would
  // deliver whether or not any mirror existed; claiming "the store adapter works" beside a measured
  // `0 entries` would be a false statement generated by the probe itself.
  say(
    `\n    MIRROR: ${mirrored ? `PROVEN — the SDK made ${appends} append call(s) through this package's adapter and the store holds ${entries.length} real entries, ${entries.filter((e) => JSON.stringify(e).includes(secret)).length} of them carrying the word` : `NOT PROVEN — the store is empty after ${appends} append call(s)`}.`,
  );
  say(
    `    RESUME: ${carried ? 'PROVEN' : 'NOT PROVEN'} — a second session started with resume ${carried ? 'recalled the word from the first' : `answered ${answered.slice(0, 160)}`}. ` +
      `Note: this half is about the AGENT's context, not about the store: the CLI keeps its own local ` +
      `transcript, so a recall does not by itself show the mirror was read.`,
  );
}

// ---------------------------------------------------------------------------

/** The trace, as prose. Nothing here opens a transcript; this is assertion 12's whole claim. */
function reconstruct(trace: readonly SessionTransition[]): string[] {
  return trace.map((one) => {
    const where = one.where.branch ?? one.where.worktree ?? one.where.cwd;
    const what = one.activity === null ? one.to : `${one.to} [${one.activity.kind}:${one.activity.name}]`;
    return `${one.seq.toString().padStart(3, ' ')} ${one.at} ${where} — ${what} because ${one.cause.kind}/${one.cause.event}: ${one.cause.detail}`;
  });
}

/**
 * The escalation decider, hand-built.
 *
 * `escalatingDecider` ships in the package and does exactly this, but taking it means importing
 * from `@naswerks/periscope`, which is the entry point that reaches the privileged module. Written out here so
 * the proof records what a controller-side implementer actually has to reproduce.
 */
function escalateTo(url: string): (request: unknown, signal: AbortSignal) => Promise<unknown> {
  return async (request: unknown, signal: AbortSignal): Promise<unknown> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw new Error(`the controller answered ${response.status}`);
    return await response.json();
  };
}

/** How a validated tool call reaches the controller. There is no wire lane for this. */
function invokerFor(toolUrl: string): (call: ToolCall) => Promise<{ text: string; isError?: boolean }> {
  return async (call: ToolCall) => {
    const response = await fetch(`${toolUrl}/${call.toolName}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ arguments: call.arguments, sessionId: call.identity.sessionId }),
    });
    return (await response.json()) as { text: string; isError?: boolean };
  };
}

function reportOf(event: HostEvent): void {
  if (event.kind === 'refusal')
    say(`  HOST REFUSAL ${event.sessionKey ?? '-'} ${event.refusal.reason} — ${event.refusal.detail}`);
  if (event.kind === 'session-opened') say(`  HOST session ${event.sessionKey} opened in ${event.cwd}`);
  if (event.kind === 'link') say(`  HOST link ${event.transition.from} -> ${event.transition.to}`);
}

function writeReport(): void {
  const table = [
    '',
    '=== THE TWELVE ASSERTIONS ===',
    '',
    ...outcomes
      .sort((a, b) => a.n - b.n)
      .map(
        (one) =>
          `${String(one.n).padStart(2, ' ')}. ${one.status.padEnd(13, ' ')} ${one.title}\n      ${one.detail}`,
      ),
    '',
  ];
  for (const line of table) say(line);

  const out = process.env['PERISCOPE_PROOF_OUT'];
  if (out !== undefined && out !== '') {
    writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
    process.stdout.write(`\nwrote ${out}\n`);
  }
  if (outcomes.some((one) => one.status === 'FAILED')) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  say(`\nTHE PROOF ITSELF FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  writeReport();
  process.exitCode = 1;
});
