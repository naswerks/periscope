/**
 * What the model claims about the SDK, proven against a real agent.
 *
 * The unit tests prove that a message of a given shape produces a given transition. They cannot
 * prove the agent ever sends that shape — and documented claims have turned out false against the
 * shipped types in both directions. So the coverage table's
 * `wired` rows are hypotheses until something here observes them arriving.
 *
 * They skip loudly. Without `PERISCOPE_LIVE=1` each is skipped with the reason in its own name,
 * so the suite's `skipped` count is the standing reminder that these are not exercised in an
 * ordinary run. A silent pass would read exactly like a proof.
 *
 * Every workspace is an OS temporary directory, deliberately outside any repository. The agent
 * discovers project settings by walking up from its working directory, so a workspace inside a
 * checkout inherits that checkout's `.claude/settings.json` — hooks included, which would then fire
 * for real against a system these probes are not testing.
 *
 * Each turn is the smallest thing that produces the event. These prove wiring, not capability.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { HookInput, HookJSONOutput, HookRegistrations } from '../host/agent-process.js';
import { mergeHooks, observationHooks, wiredHookEvents } from '../host/hooks.js';
import { readWhere } from '../host/git-facts.js';
import { systemClock, systemTicker } from '../core/time.js';
import { SessionRegistry } from '../sessions/registry.js';
import type { HostedSession } from '../sessions/session.js';
import { SessionStateMachine } from './machine.js';
import { SessionObserver } from './observer.js';
import { TransitionStore } from './store.js';
import { SessionStateReporter } from './reporter.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const skip = LIVE ? false : 'PERISCOPE_LIVE is not set — this property is NOT exercised';

const START_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 180_000;

function workspaceOutsideAnyRepo(label: string): string {
  return mkdtempSync(`${tmpdir()}/periscope-trace-${label}-`);
}

interface Wired {
  readonly registry: SessionRegistry;
  readonly machine: SessionStateMachine;
  readonly observer: SessionObserver;
  readonly store: TransitionStore;
  readonly firedHooks: Set<string>;
  readonly cwd: string;
}

/** A session's full observation stack, exactly as an embedder would assemble it. */
function wire(label: string): Wired {
  const cwd = workspaceOutsideAnyRepo(label);
  const machine = new SessionStateMachine({
    where: readWhere(cwd),
    clock: systemClock,
    ticker: systemTicker,
  });
  const observer = new SessionObserver(machine);
  const store = new TransitionStore();
  store.attach(machine);

  const registry = new SessionRegistry({
    baseEnv: process.env,
    homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
    startTimeoutMs: START_TIMEOUT_MS,
  });

  return { registry, machine, observer, store, firedHooks: new Set<string>(), cwd };
}

/**
 * The observation hooks, plus a second matcher on every wired event that records which events the
 * agent actually fired.
 *
 * The second matcher is the point of the merge seam, exercised for real: it is a separate
 * registration that cannot change what the observation handler does, which is exactly the shape a
 * permission-decision handler will take. `extra` is how a probe returns a real decision — a live
 * stand-in for that handler.
 */
function hooksFor(wired: Wired, extra?: (input: HookInput) => HookJSONOutput): HookRegistrations {
  const observing = observationHooks({ observer: wired.observer });
  const witnessing: HookRegistrations = {};

  for (const event of Object.keys(observing)) {
    witnessing[event as keyof HookRegistrations] = [
      {
        hooks: [
          async (input: HookInput): Promise<HookJSONOutput> => {
            wired.firedHooks.add(input.hook_event_name);
            return extra === undefined ? {} : extra(input);
          },
        ],
      },
    ];
  }

  return mergeHooks(observing, witnessing);
}

/** Run one turn to completion, feeding every message to the observer. Returns on the result. */
function driveTurn(session: HostedSession, observer: SessionObserver, prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      drop();
      resolve(false);
    }, TURN_TIMEOUT_MS);
    const drop = session.onMessage((message) => {
      observer.observeMessage(message);
      if (message.type !== 'result') return;
      clearTimeout(timer);
      drop();
      resolve(true);
    });
    observer.promptSubmitted('the probe queued a turn');
    session.prompt(prompt);
  });
}

test(
  'a real turn produces a caused trace end to end — where, what and why, with no transcript',
  { skip },
  async () => {
    const wired = wire('turn');
    const created = wired.registry.create({ cwd: wired.cwd, hooks: hooksFor(wired) });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    wired.observer.created('the probe asked for a process');
    const completed = await driveTurn(created.value, wired.observer, 'Run the bash command: echo periscope');
    wired.registry.stopAll('probe finished');
    assert.equal(completed, true, 'the turn never produced a result');

    const trace = wired.store.all();
    console.log(`[live] hooks that actually fired: ${[...wired.firedHooks].sort().join(', ')}`);
    console.log(`[live] transitions: ${trace.length}`);
    for (const transition of trace) {
      console.log(
        `[live]   ${transition.seq} ${transition.from}->${transition.to} ` +
          `${transition.activity === null ? '-' : `${transition.activity.kind}:${transition.activity.name ?? ''}`} ` +
          `<= ${transition.cause.kind}/${transition.cause.event}`,
      );
    }

    // Where, what and why, from the trace alone.
    assert.ok(trace.length >= 5, 'a real turn produced almost no transitions');
    assert.ok(
      trace.every((transition) => transition.cause.event.length > 0 && transition.where.cwd.length > 0),
      'every transition names its cause and its place',
    );
    assert.equal(wired.machine.rejectedCount, 0, 'a real session produced a cause the model could not name');

    // The session identified itself, and the id reached the trace.
    assert.notEqual(wired.machine.sessionId, null);
    assert.ok(
      trace.some((transition) => transition.to === 'ready' && transition.cause.event === 'system/init'),
      'the identity transition is the one row that says what this session is',
    );

    // A clean turn end was recorded. This is the record a single status word loses.
    assert.ok(
      trace.some((transition) => transition.to === 'idle'),
      'no clean turn end was recorded',
    );

    // The tool call opened and closed.
    const toolTransitions = trace.filter((transition) => transition.activity?.kind === 'tool');
    assert.ok(toolTransitions.length > 0, 'no tool entry was ever opened — did the agent run the command?');
    assert.equal(
      wired.machine.openEntries().filter((entry) => entry.lane === 'foreground' && entry.abandonedAt === null)
        .length,
      0,
      'a foreground entry outlived the turn',
    );

    // The hooks a one-tool turn genuinely reaches. Asserted from what a real session was observed to
    // fire, not from what the type surface suggests it ought to: `SessionStart` is declared, is wired,
    // and does not arrive on this path — recorded in the coverage table rather than asserted here,
    // because an assertion written from an assumption fails for the wrong reason.
    for (const expected of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolBatch', 'Stop']) {
      assert.ok(wired.firedHooks.has(expected), `${expected} is marked wired but never fired`);
    }

    const wiredButUnseen = wiredHookEvents().filter((event) => !wired.firedHooks.has(event));
    console.log(`[live] wired but NOT fired by this turn shape: ${wiredButUnseen.join(', ')}`);
  },
);

test(
  'a deliberately abandoned tool call stays open, ageing, and is marked rather than erased',
  { skip },
  async () => {
    const wired = wire('abandon');
    const created = wired.registry.create({ cwd: wired.cwd, hooks: hooksFor(wired) });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    wired.observer.created('the probe asked for a process');

    // Kill the session while a tool is provably still running. The tool is a long sleep, so the
    // window is not a race: the entry is open when the process dies.
    const opened = new Promise<void>((resolve) => {
      const drop = wired.machine.onTransition((transition) => {
        if (transition.activity?.kind !== 'tool') return;
        drop();
        resolve();
      });
    });

    wired.observer.promptSubmitted('the probe queued a turn');
    created.value.prompt('Run the bash command: sleep 120');
    const raced = await Promise.race([
      opened.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), TURN_TIMEOUT_MS)),
    ]);
    assert.equal(raced, true, 'the tool entry never opened, so nothing was abandoned');

    created.value.stop('the probe killed the session mid-tool');
    wired.observer.ended({
      kind: 'process',
      event: 'stop_requested',
      detail: 'the probe killed it mid-tool',
    });
    wired.registry.stopAll('probe finished');

    const stranded = wired.machine.openEntries();
    console.log(
      `[live] stranded entries: ${JSON.stringify(stranded.map((e) => ({ id: e.entryId, age: e.ageMs, abandoned: e.abandonReason })))}`,
    );

    assert.ok(stranded.length > 0, 'the entry was erased — the evidence that it happened is gone');
    const entry = stranded[0];
    assert.notEqual(entry?.abandonedAt, null, 'it must be marked');
    assert.ok((entry?.ageMs ?? 0) >= 0, 'and it must still carry how long it was open');
    assert.equal(entry?.activity.kind, 'tool');
  },
);

test('backgrounded work stops holding the session while the turn moves on', { skip }, async () => {
  const wired = wire('background');
  const created = wired.registry.create({ cwd: wired.cwd, hooks: hooksFor(wired) });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  wired.observer.created('the probe asked for a process');
  const completed = await driveTurn(
    created.value,
    wired.observer,
    'Run this bash command in the background using run_in_background: sleep 30. Then immediately tell me you started it. Do not wait for it.',
  );
  wired.registry.stopAll('probe finished');
  assert.equal(completed, true, 'the turn never produced a result');

  const backgrounded = wired.store
    .all()
    .filter((transition) => transition.cause.event === 'system/task_updated');
  const inBackground = wired.machine.openEntries().filter((entry) => entry.lane === 'background');

  console.log(
    `[live] task_updated transitions: ${backgrounded.length}; background entries: ${inBackground.length}`,
  );
  console.log(
    `[live] causes seen: ${[...new Set(wired.store.all().map((t) => `${t.cause.kind}/${t.cause.event}`))].join(', ')}`,
  );

  // Stated as an observation rather than a required pass: whether the agent chooses to background
  // the command is the model's decision, not something this host controls. A run where it did not
  // background anything proves nothing about the wiring either way, so it is reported, not asserted.
  if (backgrounded.length === 0 && inBackground.length === 0) {
    console.log('[live] the agent did not background anything this run — the lane was NOT exercised');
    return;
  }

  assert.ok(
    backgrounded.length > 0,
    'work moved to the background with no task_updated cause — that would be inference',
  );
  for (const entry of inBackground) {
    assert.notEqual(entry.backgroundedAt, null, 'a background entry records when it stopped holding');
    assert.equal(entry.abandonedAt, null, 'backgrounding is not abandonment');
  }
});

test(
  'a permission denial and a decision-path outage leave different traces on a real session',
  { skip },
  async () => {
    // The denial half: a second PreToolUse matcher denies, the shape a permission-decision handler takes.
    const denied = wire('denied');
    const created = denied.registry.create({
      cwd: denied.cwd,
      hooks: hooksFor(denied, (input) =>
        input.hook_event_name === 'PreToolUse'
          ? {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'the probe denies every tool',
              },
            }
          : {},
      ),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    denied.observer.created('the probe asked for a process');
    await driveTurn(created.value, denied.observer, 'Run the bash command: echo denied-probe');
    denied.registry.stopAll('probe finished');

    console.log(`[live] hooks fired under deny: ${[...denied.firedHooks].sort().join(', ')}`);
    const denialTrace = denied.store
      .all()
      .filter((transition) => transition.cause.event === 'PermissionDenied');
    console.log(`[live] PermissionDenied transitions: ${denialTrace.length}`);

    // The outage half, recorded on the same model so the two can be compared directly.
    denied.observer.refused({
      kind: 'refusal',
      event: 'link-send-failed',
      detail: 'the decision path could not be reached',
    });
    const outage = denied.store.all().at(-1);

    assert.equal(outage?.cause.kind, 'refusal');
    for (const denial of denialTrace) {
      assert.notEqual(denial.cause.kind, outage?.cause.kind, 'an outage must not read as a deliberate no');
    }
    if (denialTrace.length === 0) {
      console.log('[live] PermissionDenied did not fire this run — the denial leg was NOT exercised live');
    }
  },
);

test(
  "a subagent is its own entry on a real session, opened and closed by the SDK's own hooks",
  { skip },
  async () => {
    const wired = wire('subagent');
    const created = wired.registry.create({ cwd: wired.cwd, hooks: hooksFor(wired) });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    wired.observer.created('the probe asked for a process');
    const completed = await driveTurn(
      created.value,
      wired.observer,
      'Use the Task tool to launch exactly one general-purpose agent whose entire job is to reply with the single word: ok',
    );
    wired.registry.stopAll('probe finished');
    assert.equal(completed, true, 'the turn never produced a result');

    const subagentTransitions = wired.store
      .all()
      .filter((transition) => transition.activity?.kind === 'subagent');
    console.log(`[live] hooks fired with a subagent: ${[...wired.firedHooks].sort().join(', ')}`);
    console.log(`[live] subagent transitions: ${subagentTransitions.length}`);

    // Whether the model actually reaches for the Task tool is its decision, not this host's. A run
    // where it answered directly proves nothing about the wiring, so it is reported, not asserted.
    if (!wired.firedHooks.has('SubagentStart')) {
      console.log('[live] the agent did not launch a subagent this run — the lane was NOT exercised');
      return;
    }

    assert.ok(wired.firedHooks.has('SubagentStop'), 'a subagent entry opened with no exit wired');
    assert.ok(subagentTransitions.length > 0, 'SubagentStart fired but produced no activity');
    assert.equal(
      wired.machine.openEntries().filter((entry) => entry.activity.kind === 'subagent').length,
      0,
      'a subagent entry outlived the turn',
    );
  },
);

test(
  'this host can enumerate its own sessions with state, activity and open-entry ages',
  { skip },
  async () => {
    const wired = wire('enumerate');
    const reporter = new SessionStateReporter();
    reporter.add(wired.machine);

    const created = wired.registry.create({ cwd: wired.cwd, hooks: hooksFor(wired) });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    wired.observer.created('the probe asked for a process');
    await driveTurn(created.value, wired.observer, 'Reply with the single word: ok');
    wired.registry.stopAll('probe finished');

    const listed = reporter.list();
    console.log(
      `[live] enumeration: ${JSON.stringify(listed.map((s) => ({ id: s.sessionId, state: s.state, open: s.openEntries.length })))}`,
    );

    assert.equal(listed.length, 1);
    assert.notEqual(listed[0]?.sessionId, null, "the host knows the agent's own id");
    assert.notEqual(listed[0]?.where.cwd, undefined);
    assert.ok(listed[0]?.transitionCount ?? 0 > 0);

    // It is raw material, not a roster: no aggregation, no filtering, nothing about what it means.
    assert.deepEqual(Object.keys(listed[0] ?? {}).sort(), [
      'activity',
      'correlationId',
      'lastTransitionAt',
      'openEntries',
      'sessionId',
      'state',
      'transitionCount',
      'where',
    ]);
  },
);
