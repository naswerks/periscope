/**
 * The gate's properties, against a real agent.
 *
 * This is the one seam that must not be faked: a mocked hook proves the mock, and this whole
 * package exists because executing something found what the documentation denied. So every claim
 * here about what the SDK does with a decision is measured on a real session.
 *
 * They skip loudly. Without `PERISCOPE_LIVE=1` each is skipped with the reason in its own name, so
 * the suite's `skipped` count is the standing reminder that these are NOT exercised in an ordinary
 * run.
 *
 * Every workspace is an OS temporary directory, outside any repository. The agent discovers
 * project settings by walking up from its working directory, so a workspace inside a checkout
 * inherits that checkout's `.claude/settings.json` — hooks included, which would then fire for real
 * against a system this is not testing.
 *
 * The prompts are one instruction each. These prove the gate, not the model.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { HookInput, HookJSONOutput, SDKMessage } from '../host/agent-process.js';
import { mergeHooks, observationHooks } from '../host/hooks.js';
import { SessionRegistry } from '../sessions/registry.js';
import type { HostedSession } from '../sessions/session.js';
import { SessionStateMachine } from '../state/machine.js';
import { SessionObserver } from '../state/observer.js';
import type { SessionTransition } from '../state/model.js';
import { systemClock, systemTicker } from '../core/time.js';
import type { Decider } from './decision.js';
import type { GateOutcome } from './outcome.js';
import { permissionHooks } from './gate.js';
import { recordGateOutcome } from './outcome.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const skip = LIVE ? false : 'PERISCOPE_LIVE is not set — this property is NOT exercised';

const START_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 180_000;

const workspaceOutsideAnyRepo = (label: string): string =>
  mkdtempSync(`${tmpdir()}/periscope-gate-${label}-`);

/**
 * A parent agent session's environment carries `CLAUDE_CODE_CHILD_SESSION=1`, which makes the CLI
 * skip transcript persistence, and `CLAUDE_EFFORT`, which would run these probes at the parent's
 * effort. Neither belongs in a probe, and the allow-list drops them — this only names why it
 * matters here.
 */
const baseEnv = process.env;

interface Wired {
  readonly session: HostedSession;
  readonly machine: SessionStateMachine;
  readonly transitions: SessionTransition[];
  readonly outcomes: GateOutcome[];
  readonly hookEvents: string[];
}

/**
 * A real session with the observer and the gate both registered on `PreToolUse`.
 *
 * The order (observer first, gate second) is convention, not a race guard: handlers on one event
 * have their synchronous prologues run in array order and are then awaited concurrently (measured),
 * and the gate opens its `permission` entry only from its hold timer — after every same-event
 * synchronous prologue — so neither order lets the observer close a hold opened in the same event.
 */
async function wire(
  label: string,
  decide: Decider,
  prompt: string,
  gateOptions: { decisionTimeoutMs?: number; holdAfterMs?: number } = {},
): Promise<Wired & { cwd: string }> {
  const cwd = workspaceOutsideAnyRepo(label);
  const machine = new SessionStateMachine({
    where: { cwd, worktree: null, branch: null, unknownReason: 'a probe workspace is not a repository' },
    clock: systemClock,
    ticker: systemTicker,
  });
  const transitions: SessionTransition[] = [];
  machine.onTransition((transition) => transitions.push(transition));

  const observer = new SessionObserver(machine);
  const outcomes: GateOutcome[] = [];
  const hookEvents: string[] = [];

  const counting = {
    PreToolUse: [
      {
        hooks: [
          async (input: HookInput) => {
            hookEvents.push(`${input.hook_event_name}:${'tool_name' in input ? input.tool_name : '?'}`);
            return {};
          },
        ],
      },
    ],
  };

  const gate = permissionHooks({
    sessionKey: 'handle-1',
    decide,
    onOutcome: (outcome) => {
      outcomes.push(outcome);
      recordGateOutcome(machine, outcome);
    },
    ...(gateOptions.decisionTimeoutMs === undefined
      ? {}
      : { decisionTimeoutMs: gateOptions.decisionTimeoutMs }),
    ...(gateOptions.holdAfterMs === undefined ? {} : { holdAfterMs: gateOptions.holdAfterMs }),
  });

  const registry = new SessionRegistry({
    baseEnv,
    homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
    startTimeoutMs: START_TIMEOUT_MS,
  });

  const opened = await registry.open({
    cwd,
    prompt,
    hooks: mergeHooks(counting, observationHooks({ observer }), gate),
  });
  assert.equal(opened.ok, true, `the probe session did not start: ${opened.ok ? '' : opened.refusal.detail}`);
  const session = opened.ok ? opened.value : (undefined as never);

  session.onMessage((message) => observer.observeMessage(message));
  await waitForResult(session, TURN_TIMEOUT_MS);
  session.stop('the probe finished');

  return { session, machine, transitions, outcomes, hookEvents, cwd };
}

function waitForResult(session: HostedSession, timeoutMs: number): Promise<SDKMessage | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      drop();
      resolve(null);
    }, timeoutMs);
    const drop = session.onMessage((message) => {
      if (message.type !== 'result') return;
      clearTimeout(timer);
      drop();
      resolve(message);
    });
  });
}

const causesOf = (transitions: readonly SessionTransition[]): string[] =>
  transitions.map((transition) => `${transition.cause.kind}/${transition.cause.event}`);

// ---------------------------------------------------------------------------

test(
  'live: a deny is a hard block — the file never reaches disk and the model is told why',
  { skip },
  async () => {
    const reason = 'the probe denies every Write';
    const { cwd, outcomes, transitions, machine } = await wire(
      'deny',
      async (request) =>
        request.toolName === 'Write' ? { behavior: 'deny', message: reason } : { behavior: 'allow' },
      'Use the Write tool once to write the single word pomegranate to blocked.txt in the current directory. ' +
        'If it is refused, do not retry and do not use any other tool — just say REFUSED.',
    );

    assert.equal(
      existsSync(join(cwd, 'blocked.txt')),
      false,
      'the deny did not block — the file reached disk',
    );

    const denials = outcomes.filter((outcome) => outcome.kind === 'deny');
    assert.ok(denials.length > 0, 'the gate never saw the Write');

    // The denial is in the trace, and as a decision rather than as a refusal. A gate that blocks
    // silently makes a deliberate "no" indistinguishable from a hang; one that records a denial as
    // a refusal makes it indistinguishable from an outage.
    assert.ok(
      causesOf(transitions).includes('control/permission_denied'),
      `no denial in the trace: ${causesOf(transitions).join(', ')}`,
    );
    assert.equal(
      causesOf(transitions).some((cause) => cause.startsWith('refusal/')),
      false,
      'a deliberate denial was recorded as a refusal — an outage and a human "no" must never look alike',
    );

    // The denied call's tool entry does not leak. `PostToolUse` does not fire for a hook-authored
    // deny — so if `PostToolBatch.tool_calls` omitted the denied call, its entry would stay open
    // forever and forty denials in an unattended run would bury the one signal this model exists
    // to produce. It does not omit it: the entry is closed by the existing backstop.
    const openTools = machine.openEntries().filter((entry) => entry.activity.kind === 'tool');
    assert.deepEqual(
      openTools.map((entry) => entry.entryId),
      [],
      'a denied tool call left its entry open — a deliberate "no" now looks exactly like a hang',
    );
    assert.ok(
      transitions.some((transition) => transition.cause.event === 'PostToolBatch'),
      'PostToolBatch never fired, so this run cannot say whether the entry would have leaked',
    );
  },
);

test(
  'live: a decider that throws blocks the tool — the fail-open hole, closed against a real agent',
  { skip },
  async () => {
    const { cwd, outcomes, transitions } = await wire(
      'throw',
      () => {
        throw new Error('a deliberate bug in the gate itself');
      },
      'Use the Write tool once to write the single word pomegranate to thrown.txt in the current directory. ' +
        'If it is refused, do not retry and do not use any other tool — just say REFUSED.',
    );

    assert.equal(existsSync(join(cwd, 'thrown.txt')), false, 'a throwing handler did not block — fail-open');

    const refused = outcomes.filter((outcome) => outcome.kind === 'refused');
    assert.ok(
      refused.length > 0,
      'the gate failed closed but said nothing — a denial indistinguishable from an outage',
    );
    assert.ok(
      causesOf(transitions).includes('refusal/permission-decision-unavailable'),
      `no outage in the trace: ${causesOf(transitions).join(', ')}`,
    );
  },
);

test(
  'live: an expired decision blocks and says so, and the hold is visible while it waits',
  { skip },
  async () => {
    const { cwd, outcomes, transitions } = await wire(
      'timeout',
      () => new Promise(() => undefined),
      'Use the Write tool once to write the single word pomegranate to expired.txt in the current directory. ' +
        'If it is refused, do not retry and do not use any other tool — just say REFUSED.',
      { decisionTimeoutMs: 3_000, holdAfterMs: 200 },
    );

    assert.equal(existsSync(join(cwd, 'expired.txt')), false, 'an expired decision did not block');
    assert.ok(
      outcomes.some((outcome) => outcome.kind === 'expired'),
      'the expiry was not reported, so a blocked tool reads as a hang',
    );
    assert.ok(
      causesOf(transitions).includes('timeout/hook_timed_out'),
      `no expiry in the trace: ${causesOf(transitions).join(', ')}`,
    );

    // A session waiting on a permission decision is visible as such. This is the activity the
    // declared model exists to make answerable — "show me every session waiting on a decision" —
    // and the gate's own hold entry is the only live path that reaches it.
    const holding = transitions.filter((transition) => transition.activity?.kind === 'permission');
    assert.ok(
      holding.length > 0,
      `no transition reported a permission activity: ${transitions.map((t) => `${t.activity?.kind}`).join(', ')}`,
    );
  },
);

test(
  'live: two parallel same-tool calls — an overlapped live hold records no resolution that never happened',
  { skip },
  async () => {
    // The cross-event window: a hold for call A is live when PreToolUse for call B (same tool)
    // arrives. Whether the CLI ever produces that interleaving is a fact about the CLI, so it is
    // measured here rather than assumed — the trace property below is asserted either way.
    const inFlightByTool = new Map<string, number>();
    let maxSameToolOverlap = 0;

    const { transitions } = await wire(
      'overlap',
      async (request) => {
        const now = (inFlightByTool.get(request.toolName) ?? 0) + 1;
        inFlightByTool.set(request.toolName, now);
        maxSameToolOverlap = Math.max(maxSameToolOverlap, now);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        inFlightByTool.set(request.toolName, now - 1);
        return { behavior: 'allow' };
      },
      'In a single message, call the Write tool twice IN PARALLEL — one call writing the word alpha ' +
        'to a.txt and one call writing the word beta to b.txt, both in the current directory. ' +
        'Use no other tool, then stop.',
      { holdAfterMs: 200 },
    );

    // The trace property, unconditional: no transition may record that a permission "resolved
    // and the tool is running" — with the gate's hold keyed by tool_use_id, the observer's
    // name-keyed close has nothing of the gate's to close, whatever the interleaving.
    assert.equal(
      transitions.some((transition) => transition.cause.detail.includes('resolved and the tool is running')),
      false,
      'the trace recorded a permission resolution while the decision was still outstanding',
    );

    // The measurement, reported either way — a run where the CLI serializes is not a negative.
    const observed = maxSameToolOverlap >= 2;
    console.log(
      `[gate.live] same-tool PreToolUse overlap: ${
        observed
          ? `OBSERVED (max ${maxSameToolOverlap} deciders in flight for one tool)`
          : 'NOT OBSERVED on this run'
      }`,
    );

    if (observed) {
      // Two live holds for one tool are two entries, held and closed independently.
      const holdIds = new Set(
        transitions
          .filter((transition) =>
            transition.cause.detail.includes('permission decision for Write is outstanding'),
          )
          .map((transition) => transition.entryId),
      );
      assert.ok(
        holdIds.size >= 2,
        `overlapping same-tool holds shared an entry: ${JSON.stringify([...holdIds])}`,
      );
    }
  },
);

test(
  'live: every tool call reaches the gate — an MCP tool and a subagent-internal call, by observed count',
  { skip },
  async () => {
    // This leg talks to the SDK directly rather than through the host. The claim being proven is
    // the SDK's own ("the hook fires for MCP tools and inside subagents"), which is what the gate's
    // universality rests on, independent of how the host composes an MCP server.
    const cwd = workspaceOutsideAnyRepo('universality');
    const seen: { tool: string; agentId: string | null; agentType: string | null }[] = [];

    const probeServer = createSdkMcpServer({
      name: 'probe',
      version: '0.0.0',
      tools: [
        tool('ping', 'Returns the word pong.', { note: z.string() }, async () => ({
          content: [{ type: 'text' as const, text: 'pong' }],
        })),
      ],
    });

    for await (const message of query({
      prompt:
        'Do these two things and then stop. ' +
        '1) Call the mcp__probe__ping tool with note set to "one". ' +
        '2) Use the Task tool to launch ONE general-purpose subagent whose entire instruction is: ' +
        'run the Bash command `echo pomegranate` and report its output. Do nothing else.',
      options: {
        cwd,
        settingSources: [],
        mcpServers: { probe: probeServer },
        maxTurns: 12,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name !== 'PreToolUse') return {};
                  seen.push({
                    tool: input.tool_name,
                    agentId: input.agent_id ?? null,
                    agentType: input.agent_type ?? null,
                  });
                  return {};
                },
              ],
            },
          ],
        },
      },
    })) {
      if (message.type === 'result') break;
    }

    const tools = seen.map((call) => call.tool);

    // An MCP tool's calls reach the same hook as a built-in's, under its prefixed name.
    assert.ok(
      tools.some((name) => name.startsWith('mcp__probe__')),
      `no MCP tool call reached the gate: ${tools.join(', ')}`,
    );

    // And so do calls made inside a spawned subagent, which closes the subagent blind spot.
    // `agent_id` is the discriminator: `agent_type` alone is also present on the main thread of a
    // session started with --agent.
    const insideSubagent = seen.filter((call) => call.agentId !== null);
    assert.ok(
      insideSubagent.length > 0,
      `no subagent-internal call reached the gate: ${JSON.stringify(seen)}`,
    );
    assert.ok(
      insideSubagent.every((call) => call.agentType !== null),
      'a subagent call carried an agent_id but no agent_type',
    );

    // Observed counts, never inference.
    assert.ok(
      seen.length >= 3,
      `expected at least three observed calls, saw ${seen.length}: ${tools.join(', ')}`,
    );
  },
);

// ---------------------------------------------------------------------------
// The one claim this package asserts about the SDK and has never measured.
//
// `grantOnAllow`'s safety argument rests on what an explicit hook allow skips. The Claude Code
// permissions documentation states that deny and ask rules are evaluated whatever a PreToolUse
// hook returns (https://code.claude.com/docs/en/permissions#extend-permissions-with-hooks), so a
// hook allow skips only the permission mode, the allow rules and `canUseTool`. This
// package's standing rule is that the runtime beats the docs, so a documented order is not enough:
// this is the probe that settles it by running it.
//
// It is not exercised, and the reason is recorded rather than glossed. Attempts made from inside
// an agent session were contaminated: the child inherited the enclosing session's tool surface
// (`ToolSearch`, `PowerShell`, `Bash` all appeared despite `allowedTools: ['Write']`), so the agent
// satisfied the prompt with a tool the deny rule did not name and the denied `Write` was never
// called. An observed "the write happened" was a Bash redirect, not a bypassed deny rule. A
// measurement whose control was never exercised is not a measurement — so nothing was recorded,
// and the claim stays documented-not-measured until this runs on a machine that is not itself an
// agent session.
// ---------------------------------------------------------------------------

test(
  'live: does a hook allow override an operator deny rule? — the grantOnAllow premise, measured',
  { skip },
  async () => {
    const cwd = workspaceOutsideAnyRepo('deny-rule');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Write'] } }, null, 2),
    );

    const target = join(cwd, 'canary.txt');
    let allowsIssued = 0;
    const toolsCalled: string[] = [];

    for await (const message of query({
      prompt:
        'Use the Write tool ONCE to create canary.txt in the current directory containing exactly: pomegranate. ' +
        'Do not use any other tool for any reason. If Write is refused, say REFUSED and stop.',
      options: {
        cwd,
        env: baseEnv,
        // The deny rule is the subject, so the settings tier that carries it must load. This is
        // the exact pair `composeSession` refuses — asserted here deliberately, outside it.
        settingSources: ['project'],
        maxTurns: 4,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (): Promise<HookJSONOutput> => {
                  allowsIssued += 1;
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'allow',
                      permissionDecisionReason: 'the probe allows everything, on purpose',
                    },
                  };
                },
              ],
            },
          ],
        },
      },
    })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content ?? []) {
          if (block.type === 'tool_use') toolsCalled.push(block.name);
        }
      }
      if (message.type === 'result') break;
    }

    // The control comes first, because without it this test reports on a run that never happened.
    // If the agent never called `Write`, the deny rule was never reached and whether the file exists
    // says nothing at all — which is precisely how a contaminated attempt fools itself.
    assert.ok(allowsIssued > 0, 'the hook never fired — no tool call reached the gate');
    assert.ok(
      toolsCalled.includes('Write'),
      `the denied tool was never called, so this run measures nothing; tools seen: ${toolsCalled.join(', ') || '(none)'}`,
    );
    assert.deepEqual(
      [...new Set(toolsCalled)],
      ['Write'],
      `another tool ran alongside Write, so the file's existence is not attributable: ${toolsCalled.join(', ')}`,
    );

    // The measurement. Per the documented order the deny rule survives the hook allow, so the file
    // must not exist. If it does, the documentation is wrong — either way, this line is the receipt
    // and the comments in `gate.ts` must match it.
    assert.equal(
      existsSync(target),
      false,
      'a PreToolUse hook `allow` overrode an operator deny rule — the documented order is wrong, ' +
        'and every comment in this package that says deny rules survive a grant must be corrected',
    );
  },
);
