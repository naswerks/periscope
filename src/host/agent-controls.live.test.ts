/**
 * What the agent does with the controls this host reaches, measured against a real one.
 *
 * Each probe answers one question the package's handling rests on: a model switch with nobody at a
 * keyboard, thinking turned off on the models that think by default, the bypass mode and its flag,
 * the per-turn init, the gate under plan mode, the model catalog, a mid-session effort, plugins
 * delivered over stdin, the four wired events measured not to fire, and the Todo tools on a current
 * model. Each prints what it saw and asserts what the package relies on; the rest is behaviour the
 * docs record.
 *
 * They skip loudly. Without `PERISCOPE_LIVE=1` each is skipped with the reason in its name, and the
 * property is NOT exercised: the suite's `skipped` count is the standing reminder.
 *
 * Cost is kept to plumbing: one-line turns, and the `haiku` alias wherever the answer does not
 * depend on the model. The thinking probe runs the large models, at `max` effort, because its
 * answer differs per model. The catalog read sends no prompt at all.
 *
 * Every workspace is an OS temporary directory, outside any repository, and is removed afterwards:
 * the agent walks up from its working directory for project settings, so a workspace inside a
 * checkout would load that checkout's hooks.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';

import { hostAgentProblem } from '../control/codec.js';
import { AsyncQueue } from '../core/async-queue.js';
import { systemClock, systemTicker } from '../core/time.js';
import { composeSpawnEnv } from '../sessions/spawn-env.js';
import { SessionStateMachine } from '../state/machine.js';
import type { SessionTransition } from '../state/model.js';
import { SessionObserver } from '../state/observer.js';
import type {
  AgentProcess,
  AgentProcessRequest,
  EffortLevel,
  HookEvent,
  HookInput,
  HookJSONOutput,
  HookRegistrations,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  SpawnOptions,
  StartCatalogQuery,
  ThinkingConfig,
} from './agent-process.js';
import {
  composeOptions,
  messagesOf,
  readAgentCatalogWith,
  readInitFacts,
  startAgentProcess,
} from './agent-process.js';
import { claudeProjectsRoot } from './claude-transcripts.js';
import { mergeHooks, modelSwitchHooks, wiredHookEvents } from './hooks.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const skip = LIVE ? false : 'PERISCOPE_LIVE is not set — this property is NOT exercised';

const TURN_TIMEOUT_MS = 180_000;
/** The model for every probe whose answer does not depend on the model. */
const CHEAP = 'haiku';
const ONE_WORD = 'Reply with the single word: ok';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const made: string[] = [];

function workspace(label: string): string {
  const dir = mkdtempSync(`${tmpdir()}/periscope-agent-${label}-`);
  made.push(dir);
  return dir;
}

// Every leg waits for its agent's stream to end before the next begins, so the directories are free
// by now. A removal Windows still refuses is retried for a while, then named rather than failing a
// run whose probes passed: cleanup is not the property under test.
after(async () => {
  for (const dir of made) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 40) {
          console.log(
            `[live] left behind, still refused after ${attempt} tries: ${dir} (${describeError(error)})`,
          );
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
});

interface Seen {
  readonly event: string;
  readonly input: Record<string, unknown>;
}

/** A matcher on each named event that records its input, and answers with `decide` when given. */
function witness(
  seen: Seen[],
  events: readonly HookEvent[],
  decide?: (input: Record<string, unknown>) => HookJSONOutput,
): HookRegistrations {
  const registrations: HookRegistrations = {};
  for (const event of events) {
    registrations[event] = [
      {
        hooks: [
          async (input: HookInput): Promise<HookJSONOutput> => {
            const record = input as unknown as Record<string, unknown>;
            seen.push({ event: input.hook_event_name, input: record });
            return decide === undefined ? {} : decide(record);
          },
        ],
      },
    ];
  }
  return registrations;
}

function request(
  cwd: string,
  stderr: string[],
  overrides: Partial<AgentProcessRequest> = {},
): AgentProcessRequest {
  return {
    cwd,
    env: composeSpawnEnv(process.env),
    settingSources: [],
    plugins: null,
    hooks: null,
    resume: null,
    fork: false,
    includePartialMessages: true,
    thinking: null,
    forwardSubagentText: false,
    onStderr: (data) => stderr.push(data.trim()),
    mcpServers: null,
    strictMcpConfig: true,
    sessionStore: null,
    sessionStoreFlush: null,
    spawn: null,
    model: CHEAP,
    systemPrompt: null,
    effort: null,
    permissionMode: null,
    ...overrides,
  };
}

/**
 * A handle over `query()` with options or a thinking cap this package would not send, for the legs
 * that measure what the package declines: a start without the bypass flag, and turning thinking on
 * with a null cap, the cleared limit the package no longer sends.
 */
function rawAgent(options: Options): { readonly agent: AgentProcess; readonly running: Query } {
  const input = new AsyncQueue<SDKUserMessage>(16);
  const running = query({ prompt: input, options });
  let closed = false;
  const agent: AgentProcess = {
    messages: messagesOf(running),
    prompt: (text) =>
      !closed &&
      input.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
      }),
    interrupt: () => running.interrupt().then(() => undefined),
    setModel: (model) => running.setModel(model ?? undefined),
    setPermissionMode: (mode: PermissionMode) => running.setPermissionMode(mode),
    setThinking: (thinking: ThinkingConfig) =>
      running.setMaxThinkingTokens(thinking.type === 'disabled' ? 0 : null, 'summarized'),
    setEffort: (level: EffortLevel) => running.applyFlagSettings({ effortLevel: level }),
    pluginsApplied: async () => (await running.initializationResult()).plugins_applied ?? null,
    close: () => {
      if (closed) return;
      closed = true;
      input.end();
      running.close();
    },
  };
  return { agent, running };
}

interface Driven {
  readonly messages: SDKMessage[];
  /** Queue one turn and wait for its result; null at the timeout or when the stream ended first. */
  turn(text: string): Promise<SDKMessage | null>;
  /**
   * Close the agent and wait, bounded, for its stream to end. On Windows a running process holds its
   * working directory, so a leg that did not wait would leave one the cleanup cannot remove.
   */
  close(): Promise<void>;
}

const CLOSE_WAIT_MS = 15_000;

/**
 * Read the agent's stream in the background, keeping every message and handing each to `observe` as
 * it arrives, and turn prompts into results.
 */
function drive(agent: AgentProcess, stderr: string[], observe?: (message: SDKMessage) => void): Driven {
  const messages: SDKMessage[] = [];
  let waiter: ((message: SDKMessage | null) => void) | null = null;
  let ended = false;
  let finished: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (finished = resolve));
  const settle = (message: SDKMessage | null): void => {
    const waiting = waiter;
    waiter = null;
    waiting?.(message);
  };
  void (async () => {
    try {
      for await (const message of agent.messages) {
        messages.push(message);
        observe?.(message);
        if (message.type === 'result') settle(message);
      }
    } catch (error) {
      stderr.push(`the stream failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ended = true;
      settle(null);
      finished();
    }
  })();
  return {
    messages,
    turn: (text) =>
      new Promise((resolve) => {
        if (ended) return resolve(null);
        const timer = setTimeout(() => settle(null), TURN_TIMEOUT_MS);
        waiter = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
        agent.prompt(text);
      }),
    close: async () => {
      agent.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        done,
        new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_WAIT_MS))),
      ]);
      clearTimeout(timer);
    },
  };
}

function resultSummary(result: SDKMessage | null): string {
  if (result === null) return 'NO RESULT';
  const shape = result as unknown as {
    subtype?: string;
    is_error?: boolean;
    total_cost_usd?: number;
    result?: string;
  };
  return JSON.stringify({
    subtype: shape.subtype,
    is_error: shape.is_error,
    cost: shape.total_cost_usd,
    said: typeof shape.result === 'string' ? shape.result.slice(0, 160) : undefined,
  });
}

const isError = (result: SDKMessage | null): boolean =>
  result === null || (result as unknown as { is_error?: boolean }).is_error === true;

function inits(messages: readonly SDKMessage[]): SDKMessage[] {
  return messages.filter((message) => message.type === 'system' && message.subtype === 'init');
}

/** Thinking in the assistant messages from `from` on: how many blocks, and how much text they carry. */
function thinkingSince(messages: readonly SDKMessage[], from: number): { blocks: number; chars: number } {
  let blocks = 0;
  let chars = 0;
  for (const message of messages.slice(from)) {
    if (message.type !== 'assistant') continue;
    for (const block of message.message.content as unknown as { type: string; thinking?: string }[]) {
      if (block.type !== 'thinking' && block.type !== 'redacted_thinking') continue;
      blocks += 1;
      chars += (block.thinking ?? '').length;
    }
  }
  return { blocks, chars };
}

/** The model the last assistant message says answered. */
function answeredBy(messages: readonly SDKMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'assistant') return (message.message as { model?: string }).model ?? null;
  }
  return null;
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const CONTROL_TIMEOUT_MS = 60_000;

/** How a control call ended: resolved, rejected with its text, or no answer within the bound. */
async function settled(work: Promise<unknown>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`no answer within ${CONTROL_TIMEOUT_MS}ms`), CONTROL_TIMEOUT_MS);
  });
  const answer = work.then(
    () => 'resolved',
    (error: unknown) => `rejected: ${describeError(error)}`,
  );
  try {
    return await Promise.race([answer, bound]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// (a) A model switch with nobody at a keyboard
// ---------------------------------------------------------------------------

test(
  'live: a headless model switch after a warm turn, without the host allow and with it',
  { skip, timeout: 900_000 },
  async () => {
    // The refusal-fallback question, answered by the types and not provoked here (provoking a
    // refusal means asking for what the model refuses): `PostModelSwitch.source` includes `auto`,
    // "automatic fallback", and `PreModelSwitch.source` does not, so a fallback is reported after
    // the fact and is never put to the host's answer.
    console.log(
      '[live/switch] a refusal fallback: PostModelSwitch source auto; PreModelSwitch never (typed, not provoked)',
    );

    for (const leg of ['no host answer', 'host allow'] as const) {
      const cwd = workspace('switch');
      const stderr: string[] = [];
      const seen: Seen[] = [];
      const observed = witness(seen, ['PreModelSwitch', 'PostModelSwitch']);
      const hooks = leg === 'host allow' ? mergeHooks(observed, modelSwitchHooks()) : observed;
      const agent = startAgentProcess(request(cwd, stderr, { hooks, model: CHEAP }));
      const driven = drive(agent, stderr);
      try {
        const warm = await driven.turn(ONE_WORD);
        const usage = (
          warm as unknown as {
            usage?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
          } | null
        )?.usage;
        console.log(`[live/switch:${leg}] warm turn            :`, resultSummary(warm));
        console.log(
          `[live/switch:${leg}] cache written / read :`,
          usage?.cache_creation_input_tokens,
          '/',
          usage?.cache_read_input_tokens,
        );
        // Control: the cache holds something, so a switch forfeits it and the confirm has a reason to ask.
        assert.ok(!isError(warm), `${leg}: the warm turn failed, so nothing below means anything`);
        assert.ok(
          (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) > 0,
          `${leg}: the warm turn cached nothing`,
        );

        const switched = await settled(agent.setModel('sonnet'));
        const second = await driven.turn(ONE_WORD);
        const pre = seen.filter((one) => one.event === 'PreModelSwitch').map((one) => one.input);
        const post = seen.filter((one) => one.event === 'PostModelSwitch').map((one) => one.input);
        const pick = (input: Record<string, unknown> | undefined): string =>
          input === undefined
            ? 'did not fire'
            : JSON.stringify({
                from: input['from_model'],
                to: input['to_model'],
                source: input['source'],
                warm: input['prompt_cache_warm'],
                ttl: input['cache_ttl'],
                context: input['context_tokens'],
                usd: input['estimated_cache_write_usd'],
              });
        console.log(`[live/switch:${leg}] setModel('sonnet')   :`, switched);
        console.log(`[live/switch:${leg}] PreModelSwitch       :`, pick(pre[0]));
        console.log(`[live/switch:${leg}] PostModelSwitch      :`, pick(post[0]));
        console.log(`[live/switch:${leg}] second turn          :`, resultSummary(second));
        console.log(`[live/switch:${leg}] answered by          :`, answeredBy(driven.messages));
        console.log(`[live/switch:${leg}] stderr               :`, JSON.stringify(stderr.slice(-5)));

        if (leg === 'host allow') {
          // What the package relies on: with its answer, a switch a controller asks for goes through.
          assert.equal(switched, 'resolved', 'the switch was refused with the host allow in place');
          assert.equal(post.length, 1, 'the switch went through but PostModelSwitch did not report it');
          assert.equal(post[0]?.['source'], 'sdk');
          assert.match(
            answeredBy(driven.messages) ?? '',
            /sonnet/,
            'the next turn did not run on the new model',
          );
        }
      } finally {
        await driven.close();
      }
    }
  },
);

// ---------------------------------------------------------------------------
// (b) Thinking off, and back on
// ---------------------------------------------------------------------------

// Two different questions: the second turn must be one the session has not already answered, or
// a model that answers from its own history does not think whatever the setting says. Each needs a
// few steps and asks for the bare answer, so the reasoning has to happen somewhere other than the
// reply, and every leg runs at `max` effort, where adaptive thinking is least inclined to skip.
const FIRST =
  'What is the smallest positive integer that leaves a remainder of 1 when divided by 2, 3, 4, 5 and ' +
  '6, and is divisible by 7? Reply with only the number.';
const SECOND =
  'How many positive integers below 1000 are divisible by 3 or by 5, but not by 15? Reply with only ' +
  'the number.';

interface ThinkingLeg {
  readonly first: SDKMessage | null;
  readonly firstThinking: { blocks: number; chars: number };
  readonly changed: string;
  readonly second: SDKMessage | null;
  readonly secondThinking: { blocks: number; chars: number };
  readonly model: string;
}

/** Start one agent, ask FIRST, apply `change` (when given), ask SECOND, and count the thinking each time. */
async function thinkingLeg(
  agent: AgentProcess,
  stderr: string[],
  change: ((agent: AgentProcess) => Promise<void>) | null,
): Promise<ThinkingLeg> {
  const driven = drive(agent, stderr);
  try {
    const first = await driven.turn(FIRST);
    const firstThinking = thinkingSince(driven.messages, 0);
    const model = readInitFacts(inits(driven.messages)[0] ?? ({} as SDKMessage))?.model ?? '?';
    const changed = change === null ? 'no change' : await settled(change(agent));
    const mark = driven.messages.length;
    const second = await driven.turn(SECOND);
    return {
      first,
      firstThinking,
      changed,
      second,
      secondThinking: thinkingSince(driven.messages, mark),
      model,
    };
  } finally {
    await driven.close();
  }
}

const legRow = (leg: ThinkingLeg): string =>
  `first ${resultSummary(leg.first)} thinking ${JSON.stringify(leg.firstThinking)}; ${leg.changed}; ` +
  `second ${isError(leg.second) ? 'ERROR' : 'ok'} thinking ${JSON.stringify(leg.secondThinking)}`;

test(
  'live: thinking disabled on the models that think by default, and the way back from a disabled start',
  { skip, timeout: 1_800_000 },
  async () => {
    const rows: string[] = [];
    let anyControlThought = false;
    const wayBackFailures: string[] = [];

    for (const model of ['opus', 'fable', 'sonnet']) {
      const cwd = workspace(`thinking-${model}`);
      const stderr: string[] = [];

      // Control: the same two turns on a session started with thinking on. What the ways back below
      // are measured against, turn for turn. A block counts, with or without its prose.
      const control = await thinkingLeg(
        startAgentProcess(
          request(cwd, stderr, {
            model,
            effort: 'max',
            thinking: { type: 'adaptive', display: 'summarized' },
          }),
        ),
        stderr,
        null,
      );
      rows.push(`${model} (${control.model}) control, adaptive summarized start: ${legRow(control)}`);
      const controlProse = control.secondThinking.chars > 0;
      anyControlThought ||= control.secondThinking.blocks > 0 || control.firstThinking.blocks > 0;

      // A disabled start, then this package's way back: `setThinking` adaptive with its display,
      // which sends a positive cap (`THINKING_ON_CAP`).
      const wayBack = await thinkingLeg(
        startAgentProcess(request(cwd, stderr, { model, effort: 'max', thinking: { type: 'disabled' } })),
        stderr,
        (agent) => agent.setThinking({ type: 'adaptive', display: 'summarized' }),
      );
      rows.push(`${model} disabled start, then setThinking: ${legRow(wayBack)}`);

      // The cleared limit the package no longer sends, for the record: the reason it sends a cap.
      const raw = rawAgent(
        composeOptions(request(cwd, stderr, { model, effort: 'max', thinking: { type: 'disabled' } })),
      );
      const nullCap = await thinkingLeg(raw.agent, stderr, (agent) =>
        agent.setThinking({ type: 'adaptive' }),
      );
      rows.push(`${model} disabled start, then a null cap: ${legRow(nullCap)}`);
      if (stderr.length > 0) rows.push(`${model}: stderr ${JSON.stringify(stderr.slice(-5))}`);

      // What the package relies on: where a session started with thinking on streams prose, the way
      // back from a disabled start streams it too.
      if (controlProse) wayBackFailures.push(...(wayBack.secondThinking.chars > 0 ? [] : [model]));
    }

    for (const row of rows) console.log(`[live/thinking] ${row}`);
    // Guards the detector, not a model: if no control on any model produced a thinking block, every
    // count above could be a reader that sees nothing.
    assert.ok(
      anyControlThought,
      'no control on any model produced a thinking block; the counts above prove nothing',
    );
    assert.deepEqual(
      wayBackFailures,
      [],
      'setThinking did not bring thinking prose back after a disabled start',
    );
  },
);

// ---------------------------------------------------------------------------
// (c) The bypass mode and its flag
// ---------------------------------------------------------------------------

test(
  'live: bypass at start and as a mid-session switch, with the SDK flag and without it',
  { skip, timeout: 900_000 },
  async () => {
    const modeOf = (seen: readonly Seen[]): string => {
      const mode = seen.filter((one) => one.event === 'UserPromptSubmit').at(-1)?.input['permission_mode'];
      return typeof mode === 'string' ? mode : 'not reported';
    };

    // Leg 1, the package's own start: bypass asked, so the flag is set.
    {
      const cwd = workspace('bypass-flag');
      const stderr: string[] = [];
      const seen: Seen[] = [];
      const agent = startAgentProcess(
        request(cwd, stderr, {
          hooks: witness(seen, ['UserPromptSubmit']),
          permissionMode: 'bypassPermissions',
        }),
      );
      const driven = drive(agent, stderr);
      try {
        const result = await driven.turn(ONE_WORD);
        console.log('[live/bypass] start with the flag    :', resultSummary(result), 'mode', modeOf(seen));
        assert.ok(!isError(result), 'a bypass start with the flag failed');
        assert.equal(modeOf(seen), 'bypassPermissions');
      } finally {
        await driven.close();
      }
    }

    // Leg 2, bypass asked with the flag removed: what a host without the flag would meet.
    {
      const cwd = workspace('bypass-noflag');
      const stderr: string[] = [];
      const seen: Seen[] = [];
      const { allowDangerouslySkipPermissions: _flag, ...withoutFlag } = composeOptions(
        request(cwd, stderr, {
          hooks: witness(seen, ['UserPromptSubmit']),
          permissionMode: 'bypassPermissions',
        }),
      );
      const raw = rawAgent(withoutFlag);
      const driven = drive(raw.agent, stderr);
      try {
        const initialized = await settled(raw.running.initializationResult());
        const result = await driven.turn(ONE_WORD);
        console.log(
          '[live/bypass] start without the flag :',
          initialized,
          resultSummary(result),
          'mode',
          modeOf(seen),
        );
        console.log('[live/bypass]   stderr               :', JSON.stringify(stderr.slice(-5)));
      } finally {
        await driven.close();
      }
    }

    // Legs 3 and 4: a default start, then a switch into bypass; without the flag, and with it set at start.
    for (const flagAtStart of [false, true]) {
      const cwd = workspace('bypass-switch');
      const stderr: string[] = [];
      const seen: Seen[] = [];
      const options = composeOptions(
        request(cwd, stderr, { hooks: witness(seen, ['UserPromptSubmit']), permissionMode: 'default' }),
      );
      const raw = flagAtStart ? rawAgent({ ...options, allowDangerouslySkipPermissions: true }) : null;
      const agent =
        raw?.agent ??
        startAgentProcess(
          request(cwd, stderr, { hooks: witness(seen, ['UserPromptSubmit']), permissionMode: 'default' }),
        );
      const driven = drive(agent, stderr);
      try {
        const first = await driven.turn(ONE_WORD);
        const before = modeOf(seen);
        const switched = await settled(agent.setPermissionMode('bypassPermissions'));
        const second = await driven.turn(ONE_WORD);
        const label = flagAtStart ? 'flag at start' : 'no flag      ';
        console.log(
          `[live/bypass] default then bypass, ${label}: first ${resultSummary(first)} mode ${before}`,
        );
        console.log(
          `[live/bypass]   switch ${switched}; second ${resultSummary(second)} mode ${modeOf(seen)}`,
        );
        // Control: a default start works and the hooks report the mode the session runs in.
        assert.ok(!isError(first), 'a default start failed');
        assert.equal(before, 'default');
      } finally {
        await driven.close();
      }
    }
  },
);

// ---------------------------------------------------------------------------
// (d) The per-turn init
// ---------------------------------------------------------------------------

test(
  'live: the init message on each turn, and the first one alone reporting ready',
  { skip, timeout: 600_000 },
  async () => {
    const cwd = workspace('init');
    const stderr: string[] = [];
    const machine = new SessionStateMachine({
      where: { cwd, worktree: null, branch: null, unknownReason: 'a probe workspace' },
      clock: systemClock,
      ticker: systemTicker,
    });
    const observer = new SessionObserver(machine);
    const transitions: SessionTransition[] = [];
    machine.onTransition((transition) => transitions.push(transition));
    observer.created('the probe asked for a process');

    const agent = startAgentProcess(request(cwd, stderr));
    // Observed as it arrives, the way the host observes a session.
    const driven = drive(agent, stderr, (message) => observer.observeMessage(message));
    try {
      observer.promptSubmitted('turn 1');
      await driven.turn(ONE_WORD);
      const afterOne = inits(driven.messages).length;
      observer.promptSubmitted('turn 2');
      await driven.turn(ONE_WORD);
      const afterTwo = inits(driven.messages).length;
      const readies = transitions.filter((transition) => transition.to === 'ready').length;

      console.log('[live/init] init messages after 1 turn :', afterOne);
      console.log('[live/init] init messages after 2 turns:', afterTwo);
      console.log('[live/init] ready transitions recorded :', readies);
      assert.equal(afterOne, 1, 'control: one turn, one init');
      // What the package relies on, whatever the count: readiness is reported once.
      assert.equal(readies, 1, 'a later init moved the session back to ready');
    } finally {
      await driven.close();
    }
  },
);

// ---------------------------------------------------------------------------
// (e) The gate under plan mode
// ---------------------------------------------------------------------------

test(
  'live: the PreToolUse hook decides a call in plan mode as it does in default mode',
  { skip, timeout: 900_000 },
  async () => {
    const secret = 'periscope-plan-probe-contents';
    for (const mode of ['default', 'plan'] as const) {
      const cwd = workspace(`plan-${mode}`);
      writeFileSync(`${cwd}/probe.txt`, `${secret}\n`, 'utf8');
      const stderr: string[] = [];
      const seen: Seen[] = [];
      // Every call is refused, so the file's contents can only reach the reply past a refusal.
      const deny = (): HookJSONOutput => ({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'this probe refuses every call',
        },
      });
      const hooks = mergeHooks(witness(seen, ['PostToolUse']), witness(seen, ['PreToolUse'], deny));
      const agent = startAgentProcess(request(cwd, stderr, { hooks, permissionMode: mode }));
      const driven = drive(agent, stderr);
      try {
        const result = await driven.turn(
          'This is a read-only request: use the Read tool on the file probe.txt in the current ' +
            'directory and reply with its first line. Do not write a plan; just read the file.',
        );
        const asked = seen
          .filter((one) => one.event === 'PreToolUse')
          .map((one) => String(one.input['tool_name']));
        const ran = seen
          .filter((one) => one.event === 'PostToolUse')
          .map((one) => String(one.input['tool_name']));
        const said = JSON.stringify(driven.messages.filter((message) => message.type === 'assistant'));
        console.log(`[live/plan:${mode}] result     :`, resultSummary(result));
        console.log(`[live/plan:${mode}] PreToolUse :`, JSON.stringify(asked));
        console.log(`[live/plan:${mode}] PostToolUse:`, JSON.stringify(ran));
        assert.ok(asked.length > 0, `${mode}: the agent attempted no tool, so the gate was never asked`);
        assert.deepEqual(ran, [], `${mode}: a call the hook refused ran anyway`);
        assert.equal(said.includes(secret), false, `${mode}: the file's contents got past the refusal`);
      } finally {
        await driven.close();
      }
    }
  },
);

// ---------------------------------------------------------------------------
// (f) The model catalog
// ---------------------------------------------------------------------------

test(
  'live: the model catalog is read with no prompt sent, no transcript written and no agent left running',
  { skip, timeout: 300_000 },
  async () => {
    const cwd = workspace('catalog');
    let child: ChildProcess | null = null;
    const start: StartCatalogQuery = ({ prompt, options }) =>
      query({
        prompt,
        options: {
          ...options,
          spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => {
            const spawned = spawn(spawnOptions.command, spawnOptions.args, {
              cwd: spawnOptions.cwd,
              env: spawnOptions.env,
              signal: spawnOptions.signal,
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
            });
            child = spawned;
            return spawned;
          },
        },
      });

    const began = Date.now();
    const read = await readAgentCatalogWith(start, {
      env: composeSpawnEnv(process.env),
      cwd,
      timeoutMs: 60_000,
    });
    console.log('[live/catalog] read in               :', `${Date.now() - began}ms`);
    assert.ok(read.ok, `the catalog read failed: ${read.ok ? '' : read.detail}`);
    console.log(
      '[live/catalog] versions              :',
      read.agent.claudeCodeVersion,
      read.agent.sdkVersion,
    );
    for (const model of read.agent.models) {
      console.log(
        `[live/catalog]   ${model.value} -> ${model.resolvedModel ?? '-'} "${model.displayName}" ` +
          `effort [${model.supportedEffortLevels.join(',')}] fast ${model.supportsFastMode} auto ${model.supportsAutoMode} ` +
          `adaptive ${model.supportsAdaptiveThinking}`,
      );
    }

    // Control: a catalog that names none of the aliases every account has is not a catalog.
    const values = read.agent.models.map((model) => model.value);
    assert.ok(
      values.some((value) => ['default', 'opus', 'sonnet', 'haiku', 'fable'].includes(value)),
      `no known alias in the catalog: ${JSON.stringify(values)}`,
    );
    assert.equal(hostAgentProblem(read.agent), null, 'the catalog does not fit the hello');

    // No agent left running.
    const spawned = child as ChildProcess | null;
    assert.ok(spawned !== null, 'the spawn seam was never called');
    if (spawned.exitCode === null && spawned.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        spawned.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    console.log('[live/catalog] agent exit            :', spawned.exitCode, spawned.signalCode);
    assert.ok(
      spawned.exitCode !== null || spawned.signalCode !== null,
      'the agent is still running after the read',
    );

    // No transcript: nothing under the projects root names this workspace.
    const projects = claudeProjectsRoot(process.env);
    const named =
      projects !== null && existsSync(projects)
        ? readdirSync(projects).filter((entry) => entry.includes(basename(cwd)))
        : [];
    console.log('[live/catalog] transcript folders    :', JSON.stringify(named));
    assert.deepEqual(named, [], 'the read left a transcript folder behind');
  },
);

// ---------------------------------------------------------------------------
// (g) A mid-session effort
// ---------------------------------------------------------------------------

test('live: setEffort moves the effort level the next turn runs at', { skip, timeout: 600_000 }, async () => {
  const cwd = workspace('effort');
  const stderr: string[] = [];
  const seen: Seen[] = [];
  const agent = startAgentProcess(
    request(cwd, stderr, { model: 'sonnet', effort: 'low', hooks: witness(seen, ['Stop']) }),
  );
  const driven = drive(agent, stderr);
  const level = (): string =>
    String(
      (seen.filter((one) => one.event === 'Stop').at(-1)?.input['effort'] as { level?: string } | undefined)
        ?.level ?? 'not reported',
    );
  try {
    const first = await driven.turn(ONE_WORD);
    const before = level();
    const set = await settled(agent.setEffort('high'));
    const second = await driven.turn(ONE_WORD);
    const after = level();
    console.log('[live/effort] first turn :', resultSummary(first), 'Stop effort', before);
    console.log('[live/effort] setEffort  :', set);
    console.log('[live/effort] second turn:', resultSummary(second), 'Stop effort', after);
    assert.equal(before, 'low', 'control: the first turn runs at the level the session started with');
    assert.equal(set, 'resolved');
    assert.equal(after, 'high', 'setEffort did not move the level the next turn ran at');
  } finally {
    await driven.close();
  }
});

// ---------------------------------------------------------------------------
// (h) Plugins delivered over stdin
// ---------------------------------------------------------------------------

function plugin(root: string): string {
  const dir = `${root}/probe-plugin`;
  mkdirSync(`${dir}/.claude-plugin`, { recursive: true });
  writeFileSync(
    `${dir}/.claude-plugin/plugin.json`,
    JSON.stringify({ name: 'periscope-probe', description: 'One skill, to see whether it loads.' }),
    'utf8',
  );
  mkdirSync(`${dir}/skills/periscope-probe-skill`, { recursive: true });
  writeFileSync(
    `${dir}/skills/periscope-probe-skill/SKILL.md`,
    '---\nname: periscope-probe-skill\ndescription: A probe skill that exists only to be counted.\n---\n\nDo nothing.\n',
    'utf8',
  );
  return dir;
}

test(
  'live: plugins over stdin load, and a directory that is not there is named in plugin_errors',
  { skip, timeout: 600_000 },
  async () => {
    const root = workspace('plugins');
    const present = plugin(root);
    const missing = `${root}/not-a-plugin`;

    for (const leg of ['present', 'present and missing'] as const) {
      const cwd = workspace('plugins-cwd');
      const stderr: string[] = [];
      const plugins = [
        { type: 'local' as const, path: present },
        ...(leg === 'present' ? [] : [{ type: 'local' as const, path: missing }]),
      ];
      const agent = startAgentProcess(request(cwd, stderr, { plugins }));
      const driven = drive(agent, stderr);
      try {
        const result = await driven.turn(ONE_WORD);
        const init = inits(driven.messages)[0];
        const facts = init === undefined ? null : readInitFacts(init);
        const errors = (
          init as unknown as { plugin_errors?: { plugin: string; type: string; path?: string }[] } | undefined
        )?.plugin_errors;
        const applied = await agent.pluginsApplied();
        console.log(`[live/plugins:${leg}] result         :`, resultSummary(result));
        console.log(`[live/plugins:${leg}] plugins        :`, JSON.stringify(facts?.plugins ?? null));
        console.log(`[live/plugins:${leg}] plugin_errors  :`, JSON.stringify(errors ?? null));
        console.log(`[live/plugins:${leg}] pluginsApplied :`, applied);
        assert.ok(
          init !== undefined,
          `${leg}: no init arrived, so the agent did not start: ${JSON.stringify(stderr.slice(-5))}`,
        );
        // Control: the directory that is there loads, either way.
        assert.ok(
          (facts?.plugins ?? []).some((one) => one.name === 'periscope-probe'),
          `${leg}: the plugin that is there did not load`,
        );
        if (leg === 'present') {
          assert.equal(applied, true);
        } else {
          assert.ok(
            (errors ?? []).some(
              (error) => typeof error.path === 'string' && error.path.endsWith('not-a-plugin'),
            ),
            'the missing directory is not named, with its path, in plugin_errors',
          );
        }
      } finally {
        await driven.close();
      }
    }
  },
);

// ---------------------------------------------------------------------------
// (i) The four wired events measured not to fire
// ---------------------------------------------------------------------------

test(
  'live: SessionStart, PermissionRequest, PermissionDenied and session_state_changed, measured again',
  { skip, timeout: 600_000 },
  async () => {
    const cwd = workspace('never-fire');
    const stderr: string[] = [];
    const seen: Seen[] = [];
    const deny = (input: Record<string, unknown>): HookJSONOutput =>
      input['hook_event_name'] === 'PreToolUse'
        ? {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'this probe refuses every call',
            },
          }
        : {};
    const agent = startAgentProcess(
      request(cwd, stderr, { hooks: witness(seen, wiredHookEvents() as HookEvent[], deny) }),
    );
    const driven = drive(agent, stderr);
    try {
      const result = await driven.turn('Run the bash command: echo periscope');
      const fired = [...new Set(seen.map((one) => one.event))].sort();
      const stateChanged = driven.messages.filter(
        (message) => message.type === 'system' && message.subtype === 'session_state_changed',
      ).length;
      console.log('[live/never-fire] result                  :', resultSummary(result));
      console.log('[live/never-fire] hooks that fired        :', fired.join(', '));
      console.log('[live/never-fire] session_state_changed   :', stateChanged);

      // Control: the witness sees the events a one-call turn is known to fire.
      assert.ok(fired.includes('PreToolUse'), 'the agent attempted no tool, so a deny was never given');
      assert.ok(fired.includes('Stop'), 'the witness saw no Stop; it may be seeing nothing');
      // The documented claim, which the docs follow if this goes red.
      for (const event of ['SessionStart', 'PermissionRequest', 'PermissionDenied']) {
        assert.equal(fired.includes(event), false, `${event} fired; the coverage table says it does not`);
      }
      assert.equal(stateChanged, 0, 'session_state_changed arrived; the coverage table says it does not');
    } finally {
      await driven.close();
    }
  },
);

// ---------------------------------------------------------------------------
// (j) The Todo tools on a current model
// ---------------------------------------------------------------------------

test(
  'live: the Todo and Task tools on a current model, without and with CLAUDE_CODE_ENABLE_TODO_TOOLS',
  { skip, timeout: 600_000 },
  async () => {
    const todo = (tools: readonly string[]): string[] => tools.filter((name) => /todo|^task/i.test(name));
    // Whatever the enclosing environment carries, the first leg runs without the variable.
    const { CLAUDE_CODE_ENABLE_TODO_TOOLS: _inherited, ...base } = composeSpawnEnv(process.env);
    for (const leg of ['unset', 'set'] as const) {
      const cwd = workspace('todo');
      const stderr: string[] = [];
      const env = leg === 'set' ? { ...base, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } : base;
      const agent = startAgentProcess(request(cwd, stderr, { model: 'sonnet', env }));
      const driven = drive(agent, stderr);
      try {
        const result = await driven.turn(ONE_WORD);
        const init = inits(driven.messages)[0];
        const facts = init === undefined ? null : readInitFacts(init);
        const tools = facts?.tools ?? [];
        console.log(`[live/todo:${leg}] model ${facts?.model ?? '?'}, ${tools.length} tools`);
        console.log(`[live/todo:${leg}] todo and task tools: ${JSON.stringify(todo(tools))}`);
        console.log(`[live/todo:${leg}] every tool: ${JSON.stringify(tools)}`);
        // Control: the agent reported a tool list at all, so an empty match reads as absent, not unread.
        assert.ok(tools.length > 0, `${leg}: the init carried no tool list; ${resultSummary(result)}`);
      } finally {
        await driven.close();
      }
    }
  },
);
