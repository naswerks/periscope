/**
 * The gate's own invariants. Unit tests, deliberately — every assertion here is about this package's
 * logic, and the claims about what the SDK does with the output live in `gate.live.test.ts` against
 * a real session, because a mocked hook proves the mock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { HookInput, HookJSONOutput } from '../host/agent-process.js';
import type { Decider } from './decision.js';
import type { GateOutcome } from './outcome.js';
import { permissionHooks } from './gate.js';
import { EscalationUnavailable } from './escalate.js';
import { HOOK_TIMEOUT_EVENT } from '../state/model.js';

type Handler = (
  input: HookInput,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

const preToolUse = (overrides: Record<string, unknown> = {}): HookInput =>
  ({
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/x', content: 'pomegranate' },
    tool_use_id: 'toolu_1',
    ...overrides,
  }) as unknown as HookInput;

interface Harness {
  readonly run: (input?: HookInput, signal?: AbortSignal) => Promise<HookJSONOutput>;
  readonly outcomes: GateOutcome[];
  readonly timeout: number | undefined;
}

function harness(
  decide: Decider,
  options: { decisionTimeoutMs?: number; holdAfterMs?: number } = {},
): Harness {
  const outcomes: GateOutcome[] = [];
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide,
    onOutcome: (outcome) => outcomes.push(outcome),
    decisionTimeoutMs: options.decisionTimeoutMs ?? 5_000,
    holdAfterMs: options.holdAfterMs ?? 5_000,
  });
  const matcher = registrations.PreToolUse?.[0];
  assert.ok(matcher, 'the gate registered no PreToolUse matcher');
  const handler = matcher.hooks[0] as unknown as Handler;
  assert.ok(handler, 'the matcher carries no handler');

  return {
    outcomes,
    timeout: matcher.timeout,
    run: (input = preToolUse(), signal = new AbortController().signal) =>
      handler(input, 'toolu_1', { signal }),
  };
}

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

// ---------------------------------------------------------------------------
// The fail-closed property.
//
// A hook that throws is treated by the CLI as absent rather than as a denial, so under
// `bypassPermissions` a bug in the gate's own code is an open door. This test throws on purpose and
// asserts the handler still returns an explicit deny. It fails with the try/catch removed.
// ---------------------------------------------------------------------------

test('regression: a decider that throws blocks the tool — an absent hook is an open one', async () => {
  const { run, outcomes } = harness(() => {
    throw new Error('a bug in the gate itself');
  });

  const output = await run();

  assert.equal(denies(output), true, 'a throwing decider did not produce a deny — the gate is fail-open');
  assert.match(reasonOf(output), /permission-decision-unavailable/);
  assert.equal(outcomes.at(-1)?.kind, 'refused');
});

test('regression: a rejecting decider blocks the tool too — the async half of the same hole', async () => {
  const { run, outcomes } = harness(async () => {
    await Promise.resolve();
    throw new Error('the controller connection died');
  });

  const output = await run();

  assert.equal(denies(output), true);
  assert.match(reasonOf(output), /permission-decision-unavailable/);
  assert.equal(outcomes.at(-1)?.kind, 'refused');
});

// An input the gate cannot read is not an input it can authorize.
//
// A negative control that only removes the outer `try/catch` is vacuous: the invariant is really
// held by `decide()`'s own catch. This case exercises the outer path. If the catch built its outcome
// by calling `readRequest(input)` unguarded, then when reading the input is what threw, the recovery
// would throw too and the whole handler would escape as a thrown (i.e. absent) hook. A fail-closed
// wrapper whose recovery path can fail is fail-open, and it reads as correct.
test('regression: an unreadable hook input still blocks, and the decider is never asked', async () => {
  const unreadable = new Proxy(
    { hook_event_name: 'PreToolUse' },
    {
      get(target, property) {
        if (property === 'hook_event_name') return 'PreToolUse';
        throw new Error(`reading ${String(property)} from this input throws`);
      },
    },
  ) as unknown as HookInput;

  let asked = false;
  const { run, outcomes } = harness(async () => {
    asked = true;
    return { behavior: 'allow' };
  });

  const output = await run(unreadable);

  assert.equal(denies(output), true, 'an unreadable input escaped the handler as a thrown, absent hook');
  assert.equal(asked, false, 'the decider was reached, so this is not exercising the outer wrapper');
  assert.equal(outcomes.at(-1)?.kind, 'refused');
});

test('regression: the gate still says it failed closed — emission is outside the deny path', async () => {
  const { run, outcomes } = harness(() => {
    throw new Error('boom');
  });
  await run();

  assert.equal(
    outcomes.length,
    1,
    'a fail-closed gate that emits nothing is indistinguishable from an outage',
  );
  const [outcome] = outcomes;
  assert.equal(outcome?.kind, 'refused');
  assert.equal(outcome?.kind === 'refused' && outcome.refusal.reason, 'permission-decision-unavailable');
});

test('regression: a listener that throws cannot re-open the door it was told about', async () => {
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async () => ({ behavior: 'deny', message: 'no' }),
    onOutcome: () => {
      throw new Error('the emitter is broken');
    },
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as Handler;

  const output = await handler(preToolUse(), 'toolu_1', { signal: new AbortController().signal });

  assert.equal(denies(output), true, 'a broken listener turned a deny into a thrown — i.e. absent — hook');
});

// ---------------------------------------------------------------------------
// The unknown decision.
// ---------------------------------------------------------------------------

test('regression: an unrecognised decision blocks, and is named unrecognised, not deny', async () => {
  const { run, outcomes } = harness(async () => ({ behavior: 'escalate', tier: 3 }));

  const output = await run();

  assert.equal(denies(output), true);
  assert.match(reasonOf(output), /permission-decision-unrecognised/);
  // The raw payload reaches the emitted outcome, not only the log line.
  assert.match(reasonOf(output), /"behavior":"escalate"/);
  assert.match(reasonOf(output), /"tier":3/);

  const outcome = outcomes.at(-1);
  assert.equal(outcome?.kind, 'refused');
  assert.equal(outcome?.kind === 'refused' && outcome.refusal.reason, 'permission-decision-unrecognised');
});

test('an unrecognised decision is refused by the gate, so the tool has a decided fate', async () => {
  // Reaching the gate at all is the point: a transport that rejected the frame would leave the tool
  // depending on where the parse failed rather than on a policy act with a receipt.
  const { run, outcomes } = harness(async () => 'allow');
  await run();
  assert.equal(outcomes.length, 1, 'the gate never saw the decision');
  assert.equal(outcomes[0]?.kind, 'refused');
});

// ---------------------------------------------------------------------------
// Denials and allows.
// ---------------------------------------------------------------------------

test('a deny blocks and carries the reason the model will be shown verbatim', async () => {
  const { run, outcomes } = harness(async () => ({
    behavior: 'deny',
    message: 'writes outside the workspace',
  }));

  const output = await run();

  assert.equal(denies(output), true);
  assert.equal(reasonOf(output), 'writes outside the workspace');
  assert.equal(outcomes.at(-1)?.kind, 'deny');
});

test('an allow returns no opinion — never an explicit allow, which would skip later checks', async () => {
  const { run, outcomes } = harness(async () => ({ behavior: 'allow' }));

  const output = await run();

  assert.deepEqual(output, {}, 'the gate asserted an allow, short-circuiting the later checks');
  assert.equal(outcomes.at(-1)?.kind, 'allow');
});

test('an allow that rewrites arguments carries them, and still asserts no permission of its own', async () => {
  const { run } = harness(async () => ({ behavior: 'allow', updatedInput: { file_path: '/tmp/safe' } }));

  const output = await run();

  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { file_path: '/tmp/safe' },
    },
  });
});

// ---------------------------------------------------------------------------
// The deadline, the hold, and cancellation.
// ---------------------------------------------------------------------------

test('regression: a decision that never arrives blocks, and the block says it was an expiry', async () => {
  const { run, outcomes } = harness(() => new Promise(() => undefined), {
    decisionTimeoutMs: 20,
    holdAfterMs: 5_000,
  });

  const output = await run();

  assert.equal(denies(output), true);
  // The prefix is the declared event name, not a lookalike. A lookalike such as `hook-timed-out` —
  // kebab like a refusal reason, declared nowhere — would hand the reader a token that resolves to
  // nothing. Asserted against the constant rather than a literal, so the two move together.
  assert.match(reasonOf(output), new RegExp(HOOK_TIMEOUT_EVENT));
  assert.match(reasonOf(output), /20ms/);
  assert.equal(outcomes.at(-1)?.kind, 'expired');
});

test('a slow decision is reported as a hold, so a waiting session is visible while it waits', async () => {
  const { run, outcomes } = harness(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { behavior: 'deny', message: 'no' };
    },
    { decisionTimeoutMs: 5_000, holdAfterMs: 10 },
  );

  await run();

  assert.deepEqual(
    outcomes.map((outcome) => outcome.kind),
    ['holding', 'deny'],
  );
  assert.equal(
    outcomes[1]?.kind === 'deny' && outcomes[1].held,
    true,
    'the terminal outcome forgot it had held',
  );
});

test('a fast decision opens no permission entry at all — a hold shorter than a read is noise', async () => {
  const { run, outcomes } = harness(async () => ({ behavior: 'deny', message: 'no' }), {
    holdAfterMs: 5_000,
  });

  await run();

  assert.deepEqual(
    outcomes.map((outcome) => outcome.kind),
    ['deny'],
  );
  assert.equal(outcomes[0]?.kind === 'deny' && outcomes[0].held, false);
});

test('a cancelled turn blocks rather than leaving the decision to resolve into nothing', async () => {
  const controller = new AbortController();
  const { run, outcomes } = harness(() => new Promise(() => undefined), { decisionTimeoutMs: 5_000 });

  const running = run(preToolUse(), controller.signal);
  controller.abort();
  const output = await running;

  assert.equal(denies(output), true);
  assert.match(reasonOf(output), /permission-decision-unavailable/);
  assert.equal(outcomes.at(-1)?.kind, 'refused');
});

test('an EscalationUnavailable keeps its own detail, so an outage says which lane failed', async () => {
  const { run } = harness(async () => {
    throw new EscalationUnavailable('the controller answered 503 to a decision request for Write');
  });

  const output = await run();

  assert.equal(denies(output), true);
  assert.match(reasonOf(output), /answered 503/);
});

// ---------------------------------------------------------------------------
// Registration shape.
// ---------------------------------------------------------------------------

test("the matcher sets its timeout explicitly, in the SDK's unit, and matches every tool", () => {
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async () => ({ behavior: 'allow' }),
    onOutcome: () => undefined,
    // The pair must satisfy the two-deadline invariant the constructor now enforces.
    decisionTimeoutMs: 40_000,
    matcherTimeoutSeconds: 45,
  });
  const matcher = registrations.PreToolUse?.[0];

  assert.equal(matcher?.timeout, 45, 'per-matcher, in seconds; implicit is a choice nobody made');
  assert.equal(matcher?.matcher, undefined, 'a matcher pattern would let some tool calls miss the gate');
  assert.deepEqual(Object.keys(registrations), ['PreToolUse']);
});

test('the gate has a timeout even when the embedder does not name one', () => {
  const { timeout } = harness(async () => ({ behavior: 'allow' }));
  assert.equal(typeof timeout, 'number');
  assert.ok((timeout ?? 0) > 0);
});

// The two-deadline invariant is enforced, not described. If the matcher's timeout fired first
// the tool would still be blocked — the CLI is fail-closed — but this handler would never learn it
// happened, nothing would be recorded, and the trace would show a tool entry and a permission entry
// opened and never closed. That is the exact failure the header says the inner deadline exists to
// avoid, so a configuration that inverts the order is refused at construction, before any session.
test('regression: a decisionTimeoutMs at or above the matcher timeout is refused at construction', () => {
  const decide: Decider = async () => ({ behavior: 'allow' });
  const onOutcome = (): void => undefined;

  // Above the 60s default matcher.
  assert.throws(
    () => permissionHooks({ sessionKey: 'handle-1', decide, onOutcome, decisionTimeoutMs: 120_000 }),
    /decisionTimeoutMs.*matcherTimeoutSeconds/s,
    'a decision deadline above the matcher default constructed a gate whose expiry is unrecordable',
  );

  // Equal is also refused: two timers racing at the same instant is a coin flip, not an ordering.
  assert.throws(() =>
    permissionHooks({ sessionKey: 'handle-1', decide, onOutcome, decisionTimeoutMs: 60_000 }),
  );
  assert.throws(() =>
    permissionHooks({
      sessionKey: 'handle-1',
      decide,
      onOutcome,
      decisionTimeoutMs: 10_000,
      matcherTimeoutSeconds: 10,
    }),
  );

  // The defaults hold the invariant — this is the pin that a future default edit cannot invert
  // silently, because construction itself would throw.
  permissionHooks({ sessionKey: 'handle-1', decide, onOutcome });
  permissionHooks({
    sessionKey: 'handle-1',
    decide,
    onOutcome,
    decisionTimeoutMs: 9_000,
    matcherTimeoutSeconds: 10,
  });
});

test('every tool reaches the gate, MCP names and subagent calls included', async () => {
  const seen: string[] = [];
  const { run } = harness(async (request) => {
    seen.push(`${request.toolName}${request.agentId === null ? '' : `@${request.agentId}`}`);
    return { behavior: 'allow' };
  });

  await run(preToolUse({ tool_name: 'Bash' }));
  await run(preToolUse({ tool_name: 'mcp__workspace__list' }));
  await run(preToolUse({ tool_name: 'Read', agent_id: 'agent-7', agent_type: 'general-purpose' }));

  assert.deepEqual(seen, ['Bash', 'mcp__workspace__list', 'Read@agent-7']);
});

test('a hook input that is not PreToolUse passes through with no opinion', async () => {
  let asked = false;
  const { run } = harness(async () => {
    asked = true;
    return { behavior: 'deny', message: 'no' };
  });

  const output = await run({ hook_event_name: 'Stop', session_id: 's' } as unknown as HookInput);

  assert.deepEqual(output, {});
  assert.equal(asked, false, 'the gate decided on an event that is not a tool call');
});

// A malformed input is the failure path's own failure path: the reason the handler is in the catch may be
// that the input was not what its type promised, so the outcome must still name a tool.
test('a PreToolUse whose fields are missing still produces a named, blocking outcome', async () => {
  const { run, outcomes } = harness(async () => {
    throw new Error('boom');
  });

  const output = await run({ hook_event_name: 'PreToolUse' } as unknown as HookInput);

  assert.equal(denies(output), true);
  assert.equal(outcomes.at(-1)?.request.toolName, '(unnamed tool)');
});

// An SDK build that stops passing an abort signal — or the whole options argument — must not turn
// the gate into a thrown (absent) hook. The timers are armed inside the try that disarms them and
// the abort race carries a bad signal's throw as a rejection, so both shapes land as a named
// refusal.
test('a handler invoked without a usable abort signal still refuses by name', async () => {
  const outcomes: GateOutcome[] = [];
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async () => ({ behavior: 'allow' }),
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as (
    ...args: unknown[]
  ) => Promise<HookJSONOutput>;
  assert.ok(handler);

  // No third argument at all: `hookOptions.signal` throws inside the handler's own try.
  const bare = await handler(preToolUse(), 'toolu_1');
  assert.equal(denies(bare), true);
  assert.match(reasonOf(bare), /permission-decision-unavailable/);

  // An options object carrying no signal: the abort race rejects into decide's own catch.
  const noSignal = await handler(preToolUse(), 'toolu_1', {});
  assert.equal(denies(noSignal), true);
  assert.match(reasonOf(noSignal), /permission-decision-unavailable/);

  assert.equal(outcomes.length, 2);
  assert.equal(
    outcomes.every((outcome) => outcome.kind === 'refused'),
    true,
    'a missing signal produced something other than a named refusal',
  );
});

// ---------------------------------------------------------------------------
// The `grantOnAllow` residual, as a named outcome rather than a comment.
//
// An allow that does not take effect is this gate's quietest failure: the call is approved, the
// tool does not run, and the agent reports a permission nobody was ever going to grant. The degrade
// raises it where an embedder hits it.
// ---------------------------------------------------------------------------

test('regression: an allow that cannot take effect raises gate-cannot-grant, by name', async () => {
  const degrades: { name: string; detail: string }[] = [];
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async () => ({ behavior: 'allow' }),
    onOutcome: () => undefined,
    onDegrade: (degrade) => degrades.push(degrade),
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as Handler;

  await handler(preToolUse(), 'toolu_1', { signal: new AbortController().signal });

  assert.equal(degrades.length, 1, 'an ineffective allow passed silently');
  assert.equal(degrades[0]?.name, 'gate-cannot-grant');
  assert.match(String(degrades[0]?.detail), /grantOnAllow/);
});

test('the degrade fires once per gate, not once per approved call', async () => {
  // A session that hits this hits it on every call; one degrade per call buries the signal.
  const degrades: { name: string; detail: string }[] = [];
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async () => ({ behavior: 'allow' }),
    onOutcome: () => undefined,
    onDegrade: (degrade) => degrades.push(degrade),
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as Handler;

  for (let call = 0; call < 3; call += 1) {
    await handler(preToolUse(), 'toolu_1', { signal: new AbortController().signal });
  }

  assert.equal(degrades.length, 1);
});

test('control: with grantOnAllow set there is no degrade, because the allow is effective', async () => {
  const degrades: { name: string; detail: string }[] = [];
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async () => ({ behavior: 'allow' }),
    onOutcome: () => undefined,
    grantOnAllow: true,
    onDegrade: (degrade) => degrades.push(degrade),
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as Handler;

  await handler(preToolUse(), 'toolu_1', { signal: new AbortController().signal });

  assert.deepEqual(degrades, []);
});

test('a deny raises no grant degrade — the residual is about allows, not about every outcome', async () => {
  const degrades: { name: string; detail: string }[] = [];
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async () => ({ behavior: 'deny', message: 'no' }),
    onOutcome: () => undefined,
    onDegrade: (degrade) => degrades.push(degrade),
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as Handler;

  await handler(preToolUse(), 'toolu_1', { signal: new AbortController().signal });

  assert.deepEqual(degrades, []);
});

test('an onDegrade listener that throws cannot turn a decided call into an absent hook', async () => {
  // Same invariant as `onOutcome`: a thrown hook is read by the CLI as absent, and absent is open.
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async () => ({ behavior: 'allow' }),
    onOutcome: () => undefined,
    onDegrade: () => {
      throw new Error('a listener misbehaved');
    },
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as Handler;

  const output = await handler(preToolUse(), 'toolu_1', { signal: new AbortController().signal });

  assert.ok(output, 'the gate threw instead of returning an output');
});
