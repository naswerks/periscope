/**
 * The session's runtime picks what the composer attaches to it: the fact lift its facts come from,
 * the control tier its first `ready` states, and the runtime its decision requests name. Read from
 * the request through `runtimeOf`, with `claude` when the request names none.
 *
 * A second runtime is registered here, in the two lookups, for the length of one test; the wire's
 * screen still refuses it, so this drives `composeSession` directly, the way an embedder would.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixedClock, fixedTicker } from '../core/time.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import type { AgentFact, JsonObject, SessionPayload } from '../control/frames.js';
import { readAgentFacts, readStateTransition } from '../control/frames.js';
import type { FrameSink } from '../control/stream.js';
import type { DecisionRequest } from '../gate/decision.js';
import type { FactLift } from '../sessions/fact-lift.js';
import { FACT_LIFTS } from '../sessions/fact-lift.js';
import { SessionRegistry } from '../sessions/registry.js';
import { CONTROL_TIERS } from '../sessions/runtimes.js';
import type { ControlTier, SessionTransition } from '../state/model.js';
import { fakeAgents, initMessage, settle } from '../test-support/fake-agent.js';
import type { HookInput } from './agent-process.js';
import { composeSession } from './host.js';

const AT = '2026-08-04T00:00:00.000Z';
const EXAMPLE = 'example-runtime';
const EXAMPLE_TIER: ControlTier = { level: 'cooperative', degrades: ['example-degrade'] };
const EXAMPLE_FACT: AgentFact = { kind: 'session_handle', runtime: EXAMPLE, handle: 'from-the-example-lift' };

class RecordingSink implements FrameSink {
  readonly sent: SessionPayload[] = [];
  send(_sessionId: string, payload: SessionPayload): Result<void> {
    this.sent.push(payload);
    return ok(undefined);
  }

  bodies(): JsonObject[] {
    return this.sent.flatMap((payload) =>
      payload.kind === 'session_update' ? [(payload as { body: JsonObject }).body] : [],
    );
  }

  transitions(): SessionTransition[] {
    return this.bodies().flatMap((body) => readStateTransition(body) ?? []);
  }

  facts(): AgentFact[] {
    return this.bodies().flatMap((body) => readAgentFacts(body)?.fact ?? []);
  }
}

/** A lift that states one fact per init, so a reader can tell which lift a session got. */
const exampleLift = (): FactLift => ({
  fromMessage: (message) => ({
    facts: (message as { subtype?: unknown }).subtype === 'init' ? [EXAMPLE_FACT] : [],
    fragments: [],
  }),
  fromCompaction: () => [],
});

/** Registers `EXAMPLE` in both lookups for the length of `run`, and takes it out again. */
async function withExampleRuntime(run: () => Promise<void>): Promise<void> {
  const lifts = FACT_LIFTS as Record<string, () => FactLift>;
  const tiers = CONTROL_TIERS as unknown as Record<string, ControlTier>;
  lifts[EXAMPLE] = exampleLift;
  tiers[EXAMPLE] = EXAMPLE_TIER;
  try {
    await run();
  } finally {
    Reflect.deleteProperty(lifts, EXAMPLE);
    Reflect.deleteProperty(tiers, EXAMPLE);
  }
}

/** One composed session on `runtime` (or none named): its init emitted and one tool call gated. */
async function composedOn(runtime: string | undefined): Promise<{
  sink: RecordingSink;
  asked: DecisionRequest[];
  processRequest: Record<string, unknown>;
}> {
  const fake = fakeAgents();
  const sink = new RecordingSink();
  const asked: DecisionRequest[] = [];
  const composed = composeSession({
    registry: new SessionRegistry({
      baseEnv: { PATH: 'p' },
      homeDir: 'C:/nonexistent-home-for-tests',
      clock: fixedClock(Date.parse(AT)),
      startProcess: fake.start,
    }),
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink,
    decide: async (request) => {
      asked.push(request);
      return { behavior: 'allow' };
    },
    clock: () => AT,
    ticker: fixedTicker(0),
    ...(runtime === undefined ? {} : { request: { runtime } }),
  });
  assert.ok(composed.ok, composed.ok ? '' : composed.refusal.detail);

  const agent = fake.started[0];
  assert.ok(agent !== undefined, 'no process was started');
  agent.emit(initMessage('agent-1'));
  const input = {
    hook_event_name: 'PreToolUse',
    session_id: 'agent-1',
    cwd: 'C:/work',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'toolu_1',
  } as unknown as HookInput;
  for (const matcher of agent.request.hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) await hook(input, 'toolu_1', { signal: new AbortController().signal });
  }
  await settle();
  composed.value.detach();
  return { sink, asked, processRequest: agent.request as unknown as Record<string, unknown> };
}

const readyOf = (sink: RecordingSink): SessionTransition | undefined =>
  sink.transitions().find((transition) => transition.to === 'ready');

test("control: a session on a second runtime gets that runtime's lift, tier and decision runtime, by its request", async () => {
  await withExampleRuntime(async () => {
    const { sink, asked, processRequest } = await composedOn(EXAMPLE);

    assert.deepEqual(readyOf(sink)?.controlTier, EXAMPLE_TIER, "the ready states another runtime's tier");
    assert.deepEqual(sink.facts(), [EXAMPLE_FACT], "the facts came from another runtime's lift");
    assert.equal(asked.length, 1, 'the tool call was not asked about');
    assert.equal(asked[0]?.runtime, EXAMPLE, 'the decision request names another runtime');
    assert.equal('runtime' in processRequest, false, 'the runtime reached the agent process');
  });
});

test("a session that names no runtime is Claude's: Claude's lift, Claude's tier, and claude on its decision requests", async () => {
  await withExampleRuntime(async () => {
    const { sink, asked } = await composedOn(undefined);

    assert.deepEqual(readyOf(sink)?.controlTier, { level: 'intercepted', degrades: [] });
    const kinds = sink.facts().map((fact) => `${fact.kind}:${fact.runtime}`);
    assert.ok(kinds.includes('session_handle:claude'), `Claude's lift did not report: ${kinds.join(', ')}`);
    assert.equal(asked[0]?.runtime, 'claude');
  });
});

test('the example runtime is gone once its test is over, so no other test meets it', () => {
  assert.equal(Object.hasOwn(FACT_LIFTS, EXAMPLE), false);
  assert.equal(Object.hasOwn(CONTROL_TIERS, EXAMPLE), false);
});
