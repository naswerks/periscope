/**
 * The host's own gate, composed: with the controller unreachable, a boundary-crossing call is
 * refused locally.
 *
 * The instrument needs an inconclusive state, or it manufactures one of its two answers. A probe
 * that asserts "the decider was never called" passes just as well when the decider was never wired,
 * when the tool name was never in a gated family, or when the harness silently did nothing. So every
 * offline assertion here is preceded by a positive control on the same harness: the decider is
 * reachable when the local gate has no opinion. Only then does its absence mean what it looks like.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { HookInput, HookJSONOutput } from '../host/agent-process.js';
import type { DecisionRequest } from './decision.js';
import type { GateOutcome } from './outcome.js';
import { gateTransitions } from './outcome.js';
import { permissionHooks } from './gate.js';
import { localGate } from './local.js';

const WORKSPACE = 'C:/repo';
const CREDENTIALS = 'C:/Users/agent/.claude';

const fakeResolve = (candidate: string): string => {
  const unified = candidate.replace(/\\/g, '/');
  const rooted = unified.startsWith('/') || /^[A-Za-z]:\//.test(unified) ? unified : `C:/work/${unified}`;
  const drive = /^[A-Za-z]:\//.test(rooted) ? rooted.slice(0, 3) : '/';
  const segments: string[] = [];
  for (const segment of rooted.slice(drive.length).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return drive + segments.join('/');
};

const gate = localGate({ workspaceRoot: WORKSPACE, resolve: fakeResolve, protectedPaths: [CREDENTIALS] });

const request = (overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
  toolName: 'Bash',
  toolUseId: 'toolu_1',
  toolInput: { command: 'git status' },
  sessionId: 'session-1',
  sessionKey: 'handle-1',
  cwd: WORKSPACE,
  agentId: null,
  agentType: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// The local gate on its own
// ---------------------------------------------------------------------------

test('a shell call it has no objection to gets no local opinion at all', () => {
  assert.equal(gate(request()), null);
});

test('a tool outside every declared family gets no local opinion', () => {
  assert.equal(gate(request({ toolName: 'Grep', toolInput: { pattern: 'x' } })), null);
});

test('a boundary command is refused locally, by name', () => {
  const found = gate(request({ toolInput: { command: 'git push origin main' } }));
  assert.equal(found?.reason, 'shell-boundary-command');
});

test('a shell call with no command refuses rather than being read as an empty one', () => {
  assert.equal(gate(request({ toolInput: {} }))?.reason, 'shell-command-missing');
});

test('a write outside the workspace refuses', () => {
  const found = gate(request({ toolName: 'Write', toolInput: { file_path: 'C:/elsewhere/x.txt' } }));
  assert.equal(found?.reason, 'path-escapes-root');
});

test('regression: a read of the credential path refuses — reads are jailed too', () => {
  const found = gate(
    request({ toolName: 'Read', toolInput: { file_path: `${CREDENTIALS}/.credentials.json` } }),
  );
  assert.equal(found?.reason, 'credential-path-denied');
});

test('a read of ordinary source flows', () => {
  assert.equal(gate(request({ toolName: 'Read', toolInput: { file_path: 'C:/repo/src/a.ts' } })), null);
});

test('the credential check runs before the boundary check, so the reader gets the graver answer', () => {
  const found = gate(request({ toolInput: { command: `git push origin main # ${CREDENTIALS}/x` } }));
  assert.equal(found?.reason, 'credential-path-denied');
});

test('an embedder may state its own tool families', () => {
  const custom = localGate({
    workspaceRoot: WORKSPACE,
    resolve: fakeResolve,
    protectedPaths: [],
    toolFamilies: { write: ['Deploy'], read: [], shell: [] },
  });
  assert.equal(
    custom(request({ toolName: 'Deploy', toolInput: { path: 'C:/elsewhere' } }))?.reason,
    'path-escapes-root',
  );
  assert.equal(custom(request({ toolName: 'Write', toolInput: { file_path: 'C:/elsewhere' } })), null);
});

// ---------------------------------------------------------------------------
// Composed into the gate, with the controller unreachable.
// ---------------------------------------------------------------------------

interface Harness {
  readonly run: (input?: HookInput) => Promise<HookJSONOutput>;
  readonly outcomes: GateOutcome[];
  readonly asked: string[];
}

/**
 * The gate, wired to a decider that records every question and then fails the way an unreachable
 * controller fails. `asked` is the instrument: a decider that is reached leaves a mark.
 */
function harness(options: { withLocalGate: boolean }): Harness {
  const outcomes: GateOutcome[] = [];
  const asked: string[] = [];
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async (decisionRequest) => {
      asked.push(decisionRequest.toolName);
      throw new Error('the controller is unreachable');
    },
    onOutcome: (outcome) => outcomes.push(outcome),
    decisionTimeoutMs: 5_000,
    holdAfterMs: 5_000,
    ...(options.withLocalGate ? { localGate: gate } : {}),
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as (
    input: HookInput,
    toolUseId: string | undefined,
    hookOptions: { signal: AbortSignal },
  ) => Promise<HookJSONOutput>;
  assert.ok(handler, 'the gate registered no handler');

  return {
    outcomes,
    asked,
    run: (input = preToolUse()) => handler(input, 'toolu_1', { signal: new AbortController().signal }),
  };
}

const preToolUse = (toolInput: unknown = { command: 'git status' }, toolName = 'Bash'): HookInput =>
  ({
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: WORKSPACE,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'toolu_1',
  }) as unknown as HookInput;

const denies = (output: HookJSONOutput): boolean =>
  'hookSpecificOutput' in output &&
  output.hookSpecificOutput?.hookEventName === 'PreToolUse' &&
  'permissionDecision' in output.hookSpecificOutput &&
  output.hookSpecificOutput.permissionDecision === 'deny';

const reasonOf = (output: HookJSONOutput): string => {
  const specific = 'hookSpecificOutput' in output ? output.hookSpecificOutput : undefined;
  return specific !== undefined && 'permissionDecisionReason' in specific
    ? (specific.permissionDecisionReason ?? '')
    : '';
};

test('control: the decider is reached when the local gate has no opinion', async () => {
  // Without this the next test proves nothing: "the decider was never called" is also what a
  // never-wired decider looks like.
  const { run, asked } = harness({ withLocalGate: true });
  await run(preToolUse({ command: 'git status' }));
  assert.deepEqual(asked, ['Bash'], 'the decider was never reachable, so its absence below means nothing');
});

test('regression: a boundary call is escalated — the controller can hold it; an unreachable one refuses it', async () => {
  // The local classifier used to refuse publishing in-process, so the controller's hold for a
  // person's answer could never run and no agent on this host could publish anything. A boundary
  // shape now reaches the controller like any other call. With the controller unreachable the gate
  // still fails closed — the outage refusal, after the deadline — never an allow.
  const { run, outcomes, asked } = harness({ withLocalGate: true });

  const output = await run(preToolUse({ command: 'git push origin main' }));

  assert.equal(denies(output), true, 'a boundary command was not blocked');
  assert.deepEqual(asked, ['Bash'], 'the controller was not asked about a boundary command');
  assert.match(reasonOf(output), /permission-decision-unavailable/, 'the refusal did not name the outage');
  const last = outcomes.at(-1);
  assert.equal(last?.kind, 'refused');
});

test("regression: a boundary shape in the trace is the controller's outage, not a local rule", async () => {
  // This is the audit contract. The local rule's name no longer appears as the cause of a boundary
  // refusal: the call was escalated, and what refused it was the missing answer.
  const { run, outcomes } = harness({ withLocalGate: true });
  await run(preToolUse({ command: 'git push origin main' }));

  const transitions = gateTransitions(outcomes.at(-1) as GateOutcome);
  assert.equal(transitions[0]?.cause.kind, 'refusal');
  assert.notEqual(transitions[0]?.cause.event, 'shell-boundary-command');
});

test('control: without the local gate, the same call reaches the controller as an outage', async () => {
  // The counterfactual that gives the local refusal its meaning: the tool is still blocked either
  // way — the gate is fail-closed — but the reason changes from "this host refused it" to "nobody
  // answered", and it arrives only after the deadline rather than immediately.
  const { run, outcomes, asked } = harness({ withLocalGate: false });

  const output = await run(preToolUse({ command: 'git push origin main' }));

  assert.equal(denies(output), true);
  assert.match(reasonOf(output), /permission-decision-unavailable/);
  assert.deepEqual(asked, ['Bash'], 'the decider should have been the only thing consulted');
  assert.equal(outcomes.at(-1)?.kind, 'refused');
});

test('regression: `git send-pack` refuses locally when composed; `bash -c "git push …"` is escalated like the plain form', async () => {
  // The plumbing form is not a boundary shape the controller names, so the local allowlist still
  // refuses it immediately; the composed publish is the boundary shape and reaches the controller.
  {
    const { run, asked } = harness({ withLocalGate: true });
    const output = await run(preToolUse({ command: 'git send-pack origin main' }));
    assert.equal(denies(output), true, 'git send-pack was not blocked');
    assert.deepEqual(asked, [], 'git send-pack was escalated instead of refused locally');
  }
  {
    const { run, asked } = harness({ withLocalGate: true });
    const output = await run(preToolUse({ command: 'bash -c "git push origin main"' }));
    assert.equal(denies(output), true, 'the composed publish was not blocked');
    assert.deepEqual(asked, ['Bash'], 'the composed publish was refused locally instead of escalated');
  }
});

test('regression: reading the token cache refuses through the composed gate, controller down', async () => {
  const { run, asked } = harness({ withLocalGate: true });
  const output = await run(preToolUse({ file_path: `${CREDENTIALS}/.credentials.json` }, 'Read'));
  assert.equal(denies(output), true);
  assert.match(reasonOf(output), /credential-path-denied/);
  assert.deepEqual(asked, []);
});

// ---------------------------------------------------------------------------
// The throwing local gate. The wrong implementation here does not look wrong.
// ---------------------------------------------------------------------------

test('regression: a local gate that throws refuses — it must not fall through to the decider', async () => {
  // Falling through is not fail-open, which is exactly why it would survive review: the controller
  // is still asked and the tool is still blocked if it says no. What it does is silently convert a
  // local refusal into a remote question — the offline property evaporating at the one moment the
  // controller is unreachable.
  const outcomes: GateOutcome[] = [];
  const asked: string[] = [];
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async (decisionRequest) => {
      asked.push(decisionRequest.toolName);
      return { behavior: 'allow' };
    },
    onOutcome: (outcome) => outcomes.push(outcome),
    decisionTimeoutMs: 5_000,
    holdAfterMs: 5_000,
    localGate: () => {
      throw new Error('a bug in the local policy');
    },
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as (
    input: HookInput,
    toolUseId: string | undefined,
    hookOptions: { signal: AbortSignal },
  ) => Promise<HookJSONOutput>;

  const output = await handler(preToolUse(), 'toolu_1', { signal: new AbortController().signal });

  assert.equal(denies(output), true, 'a throwing local gate did not block the tool');
  assert.deepEqual(asked, [], 'a throwing local gate fell through to the decider');
  assert.equal(outcomes.at(-1)?.kind, 'refused');

  // And the trace says which component failed, which is the only thing the local recovery adds.
  // With that recovery deleted the assertions above still pass, because the handler's outer catch
  // already blocks the tool — so without this assertion the test is vacuous. The invariant is held
  // twice over; what is not held twice is the diagnosis, and "a bug in the local policy" and "a bug
  // in the gate itself" are different investigations.
  const last = outcomes.at(-1);
  assert.match(
    last?.kind === 'refused' ? last.refusal.detail : '',
    /the host's own gate failed/,
    'the refusal did not say which component failed, so the outer catch is doing all the work',
  );
});

test('the gate behaves exactly as before when no local gate is composed', async () => {
  const { run, outcomes } = harness({ withLocalGate: false });
  const output = await run(preToolUse({ command: 'git status' }));
  assert.equal(denies(output), true, 'the unreachable controller should still block');
  assert.match(reasonOf(output), /permission-decision-unavailable/);
  assert.equal(outcomes.at(-1)?.kind, 'refused');
});

// ---------------------------------------------------------------------------
// The abort listener is detached: a hold that ends leaves no listener on the signal, or a
// long-lived controller accumulates one per gated call.
// ---------------------------------------------------------------------------

test('the abort listener is removed when the decision settles, not left on the signal', async () => {
  const added: string[] = [];
  const removed: string[] = [];
  const controller = new AbortController();
  const recording = {
    get aborted() {
      return controller.signal.aborted;
    },
    addEventListener: (type: string, listener: () => void, options?: unknown) => {
      added.push(type);
      controller.signal.addEventListener(type, listener, options as { once?: boolean });
    },
    removeEventListener: (type: string, listener: () => void) => {
      removed.push(type);
      controller.signal.removeEventListener(type, listener);
    },
  } as unknown as AbortSignal;

  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async () => ({ behavior: 'deny', message: 'no' }),
    onOutcome: () => undefined,
    decisionTimeoutMs: 5_000,
    holdAfterMs: 5_000,
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as (
    input: HookInput,
    toolUseId: string | undefined,
    hookOptions: { signal: AbortSignal },
  ) => Promise<HookJSONOutput>;

  await handler(preToolUse(), 'toolu_1', { signal: recording });

  assert.deepEqual(added, ['abort'], 'the abort listener was never attached, so removing it proves nothing');
  assert.deepEqual(removed, ['abort'], 'the abort listener was left attached to the signal');
});

test('a signal with no removeEventListener does not turn a settled decision into a thrown hook', async () => {
  const crippled = {
    aborted: false,
    addEventListener: () => undefined,
    // removeEventListener deliberately absent.
  } as unknown as AbortSignal;

  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async () => ({ behavior: 'deny', message: 'no' }),
    onOutcome: () => undefined,
    decisionTimeoutMs: 5_000,
    holdAfterMs: 5_000,
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as (
    input: HookInput,
    toolUseId: string | undefined,
    hookOptions: { signal: AbortSignal },
  ) => Promise<HookJSONOutput>;

  const output = await handler(preToolUse(), 'toolu_1', { signal: crippled });
  assert.equal(denies(output), true);
});
