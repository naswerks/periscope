/**
 * The registry's ownership model — the contract later layers attach through.
 *
 * These use a substitute process on purpose. What is under test is the host's own bookkeeping — that
 * a session leaves the table however it ended, that an unknown id is refused rather than quietly
 * succeeding, that two registries in one process share nothing — and none of that is a claim about
 * the agent. Every claim about the agent is proven against a real one in the `.live.test.ts` files,
 * because a substitute would only prove itself.
 *
 * The substitute deliberately reproduces the one behaviour that shapes this whole contract: it emits
 * nothing until a turn is queued, exactly as the real agent does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentProcess, AgentProcessRequest } from '../host/agent-process.js';
import { fixedClock } from '../core/time.js';
import { FAKE_PROMPT_CAPACITY, fakeAgents, initMessage } from '../test-support/fake-agent.js';
import { SessionRegistry } from './registry.js';

function registryWith(
  factory: (r: AgentProcessRequest) => AgentProcess,
  baseEnv: Record<string, string> = { PATH: 'p' },
  startTimeoutMs = 2_000,
) {
  return new SessionRegistry({
    baseEnv,
    // A path that does not exist: the trust read must answer `unknown` rather than throw, and no
    // test here may depend on the real user's config.
    homeDir: 'C:/nonexistent-home-for-tests',
    clock: fixedClock(Date.UTC(2026, 7, 3)),
    startTimeoutMs,
    startProcess: factory,
  });
}

test('create returns a provisioning session with no id — the agent has not spoken yet', () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  const created = registry.create({ cwd: 'C:/work' });

  assert.ok(created.ok);
  assert.equal(created.value.state, 'provisioning');
  assert.equal(created.value.id, null, 'an id before the agent reports one would be invented');
  assert.equal(registry.provisioningCount, 1);
  assert.equal(registry.liveCount, 0, 'not reachable by id, because there is no id');
  assert.equal(fake.started.length, 1, 'the process exists all the same');
});

test('a session becomes keyed by the id the agent reports, not one the host invents', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  const created = registry.create({ cwd: 'C:/work' });
  assert.ok(created.ok);
  created.value.prompt('go');
  fake.started[0]?.emit(initMessage('agent-chosen-id'));

  const live = await created.value.whenLive(2_000);
  assert.ok(live.ok, 'the session should have reported itself');
  assert.equal(live.value.id, 'agent-chosen-id');
  assert.equal(created.value.state, 'live');
  assert.equal(registry.liveCount, 1);
  assert.equal(registry.provisioningCount, 0, 'it moved out of provisioning, not into both');
  assert.ok(registry.get('agent-chosen-id').ok);
});

test('open() queues the first turn before waiting — the ordering that would otherwise deadlock', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  const opening = registry.open({ cwd: 'C:/work', prompt: 'hello' });
  await waitFor(() => fake.started.length === 1);
  // The turn is already queued at this point; the agent replies with init only because of it.
  assert.deepEqual(fake.started[0]?.prompts, ['hello'], 'the turn must precede the wait');
  fake.started[0]?.emit(initMessage('s1'));

  const opened = await opening;
  assert.ok(opened.ok);
  assert.equal(opened.value.state, 'live');
});

test('the version receipt and auth source come from this session, per session', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  const opening1 = registry.open({ cwd: 'C:/work', prompt: 'a' });
  await waitFor(() => fake.started.length === 1);
  fake.started[0]?.emit(initMessage('s1', { claude_code_version: '1.1.1', apiKeySource: 'oauth' }));
  const a = await opening1;

  // The second session reports a different version — an update landed underneath a running host.
  const opening2 = registry.open({ cwd: 'C:/work', prompt: 'b' });
  await waitFor(() => fake.started.length === 2);
  fake.started[1]?.emit(initMessage('s2', { claude_code_version: '2.2.2', apiKeySource: 'user' }));
  const b = await opening2;

  assert.ok(a.ok && b.ok);
  assert.equal(a.value.facts?.cliVersion, '1.1.1');
  assert.equal(b.value.facts?.cliVersion, '2.2.2', 'a cached version would report 1.1.1 here');
  assert.equal(a.value.facts?.apiKeySource, 'oauth');
  assert.equal(b.value.facts?.apiKeySource, 'user');
});

test('the registry is instance state — two registries in one process share nothing', async () => {
  const one = fakeAgents();
  const two = fakeAgents();
  const registryOne = registryWith(one.start);
  const registryTwo = registryWith(two.start);

  const a = registryOne.open({ cwd: 'C:/work-one', prompt: 'x' });
  await waitFor(() => one.started.length === 1);
  one.started[0]?.emit(initMessage('shared-id'));
  await a;

  const b = registryTwo.open({ cwd: 'C:/work-two', prompt: 'x' });
  await waitFor(() => two.started.length === 1);
  two.started[0]?.emit(initMessage('shared-id'));
  await b;

  // Positive control: both are genuinely populated, so the isolation below is not vacuous.
  assert.equal(registryOne.liveCount, 1);
  assert.equal(registryTwo.liveCount, 1);

  // The same id in both, and each holds its own. A module-global map would make these one object.
  const fromOne = registryOne.get('shared-id');
  const fromTwo = registryTwo.get('shared-id');
  assert.ok(fromOne.ok && fromTwo.ok);
  assert.notEqual(fromOne.value, fromTwo.value);

  registryOne.stopAll('one is done');
  assert.equal(registryOne.liveCount, 0);
  assert.equal(registryTwo.liveCount, 1, "one registry's shutdown must not reach the other");
});

test('a session leaves the registry however it ended — stop, normal end, or failure', async () => {
  for (const ending of ['stop', 'finish', 'fail'] as const) {
    const fake = fakeAgents();
    const registry = registryWith(fake.start);
    const opening = registry.open({ cwd: 'C:/work', prompt: 'x' });
    await waitFor(() => fake.started.length === 1);
    fake.started[0]?.emit(initMessage(`s-${ending}`));
    const opened = await opening;
    assert.ok(opened.ok);
    assert.equal(registry.liveCount, 1, `${ending}: present before it ends`);

    if (ending === 'stop') opened.value.stop('done');
    if (ending === 'finish') fake.started[0]?.finish();
    if (ending === 'fail') fake.started[0]?.fail(new Error('the process died'));

    await waitFor(() => registry.liveCount === 0);
    assert.equal(registry.liveCount, 0, `${ending}: removed`);
    assert.equal(opened.value.state, 'ended');
    assert.ok(opened.value.ended, `${ending}: an ended session always says why`);
  }
});

test('the end cause is the observed one, and never inferred from silence', async () => {
  const cases = [
    ['stop', 'stop_requested'],
    ['finish', 'process_ended'],
    ['fail', 'process_failed'],
  ] as const;

  for (const [ending, expected] of cases) {
    const fake = fakeAgents();
    const registry = registryWith(fake.start);
    const opening = registry.open({ cwd: 'C:/work', prompt: 'x' });
    await waitFor(() => fake.started.length === 1);
    fake.started[0]?.emit(initMessage(`s-${ending}`));
    const opened = await opening;
    assert.ok(opened.ok);

    if (ending === 'stop') opened.value.stop('asked to');
    if (ending === 'finish') fake.started[0]?.finish();
    if (ending === 'fail') fake.started[0]?.fail(new Error('boom'));

    await waitFor(() => opened.value.state === 'ended');
    assert.equal(opened.value.ended?.cause, expected);
  }
});

test('an unknown session id is refused by name, never silently accepted', () => {
  const registry = registryWith(fakeAgents().start);

  const got = registry.get('never-existed');
  assert.equal(got.ok, false);
  assert.equal(got.ok === false && got.refusal.reason, 'session-unknown');

  const stopped = registry.stop('never-existed');
  assert.equal(stopped.ok, false);
  assert.equal(stopped.ok === false && stopped.refusal.reason, 'session-unknown');
});

test('a relative cwd is refused before anything is started', () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  const created = registry.create({ cwd: 'relative/path' });
  assert.equal(created.ok, false);
  assert.equal(created.ok === false && created.refusal.reason, 'path-not-absolute');
  assert.equal(fake.started.length, 0, 'nothing may be spawned for a request that cannot be honoured');
});

test('an agent that never reports itself fails the wait rather than hanging forever', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start, { PATH: 'p' }, 60);

  const opened = await registry.open({ cwd: 'C:/work', prompt: 'x' });
  assert.equal(opened.ok, false);
  assert.equal(opened.ok === false && opened.refusal.reason, 'session-spawn-failed');
  assert.equal(fake.started[0]?.closed(), true, 'the process must be closed, not abandoned running');
  assert.equal(registry.liveCount, 0);
  assert.equal(registry.provisioningCount, 0, 'a timed-out start must not leak a provisioning entry');
});

test('a session that dies before reporting itself releases its waiter with the reason', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start, { PATH: 'p' }, 5_000);

  const created = registry.create({ cwd: 'C:/work' });
  assert.ok(created.ok);
  created.value.prompt('x');
  const waiting = created.value.whenLive(5_000);
  fake.started[0]?.fail(new Error('the process died at startup'));

  const live = await waiting;
  assert.equal(live.ok, false, 'the waiter must not be left pending');
  assert.equal(live.ok === false && live.refusal.reason, 'session-spawn-failed');
  assert.match(live.ok === false ? live.refusal.detail : '', /died at startup/);
});

test('stopAll reaches sessions that are still provisioning and hold a real process', () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  const created = registry.create({ cwd: 'C:/work' });
  assert.ok(created.ok);
  assert.equal(registry.provisioningCount, 1, 'it has a process but no id yet');
  assert.equal(registry.liveCount, 0);

  registry.stopAll('host shutting down');
  assert.equal(fake.started[0]?.closed(), true, 'a shutdown that walked only the keyed map would miss this');
  assert.equal(registry.provisioningCount, 0);
});

test('the spawn environment is composed, not inherited, and reaches the process', () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start, {
    PATH: 'C:/bin',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_EFFORT: 'max',
    SOME_HOST_SECRET: 'nope',
  });

  registry.create({ cwd: 'C:/work' });

  const env = fake.started[0]?.request.env ?? {};
  assert.equal(env['PATH'], 'C:/bin');
  assert.equal('CLAUDE_CODE_CHILD_SESSION' in env, false);
  assert.equal('CLAUDE_EFFORT' in env, false);
  assert.equal('SOME_HOST_SECRET' in env, false);
});

test('settings sources default to none, and what a caller asks for is what is passed', () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  registry.create({ cwd: 'C:/work' });
  assert.deepEqual(fake.started[0]?.request.settingSources, [], 'no settings file is read by default');

  registry.create({ cwd: 'C:/work', settingSources: ['project'] });
  assert.deepEqual(fake.started[1]?.request.settingSources, ['project']);
});

test('asking for settings files in a workspace nobody trusted is a named degrade, not silence', () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);
  const seen: string[] = [];

  const created = registry.create({ cwd: 'C:/untrusted-workspace', settingSources: ['project'] });
  assert.ok(created.ok);
  assert.equal(created.value.facts, null, 'facts arrive with init; trust is asserted below on stderr');

  // Two distinct notices, both audible: the create-time one (replayed to this late subscriber —
  // it fired before `create()` returned, when no subscriber could exist) and the stderr one.
  created.value.onDegrade((degrade) => seen.push(degrade.detail));
  assert.equal(seen.length, 1, 'the create-time degrade replays on subscribe');
  assert.match(seen[0] ?? '', /settings sources project were requested/);

  fake.started[0]?.request.onStderr?.(
    'Ignoring 1 permissions.allow entry: this workspace has not been trusted',
  );
  assert.equal(seen.length, 2);
  assert.match(seen[1] ?? '', /has not been trusted/);

  // Positive control on the matcher: ordinary stderr must not raise a degrade.
  fake.started[0]?.request.onStderr?.('some unrelated warning about a plugin');
  assert.equal(seen.length, 2, 'the matcher must not fire on everything');
});

test('the degrade raised inside create() reaches a subscriber that could not have existed yet', () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  const created = registry.create({ cwd: 'C:/untrusted-workspace', settingSources: ['project'] });
  assert.ok(created.ok);

  // Readable directly, and replayed — either way the emission has an audience now.
  assert.equal(created.value.degrades.length, 1);
  assert.equal(created.value.degrades[0]?.kind, 'workspace_untrusted');

  const replayed: string[] = [];
  created.value.onDegrade((degrade) => replayed.push(degrade.kind));
  assert.deepEqual(replayed, ['workspace_untrusted']);
});

test('the trust the session reports is the one that was read at start', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  const opening = registry.open({ cwd: 'C:/work', prompt: 'x' });
  await waitFor(() => fake.started.length === 1);
  fake.started[0]?.emit(initMessage('s1'));
  const opened = await opening;

  assert.ok(opened.ok);
  // No config file exists at the test home, so `unknown` — reported, never assumed to be untrusted.
  assert.equal(opened.value.facts?.workspaceTrust, 'unknown');
});

test('a turn on an ended session is refused rather than swallowed', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);
  const opening = registry.open({ cwd: 'C:/work', prompt: 'first' });
  await waitFor(() => fake.started.length === 1);
  fake.started[0]?.emit(initMessage('s1'));
  const opened = await opening;
  assert.ok(opened.ok);

  opened.value.stop('done');

  const after = opened.value.prompt('second');
  assert.equal(after.ok, false);
  assert.equal(after.ok === false && after.refusal.reason, 'session-unknown');
  assert.deepEqual(fake.started[0]?.prompts, ['first'], 'the refused turn must not reach the process');
});

test('regression: a turn past the live queue bound is refused prompt-queue-full and the session is untouched', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);
  const opening = registry.open({ cwd: 'C:/work', prompt: 'first' });
  await waitFor(() => fake.started.length === 1);
  fake.started[0]?.emit(initMessage('s1'));
  const opened = await opening;
  assert.ok(opened.ok);

  const outcomes: boolean[] = [];
  for (let i = 0; i < FAKE_PROMPT_CAPACITY + 2; i += 1) outcomes.push(opened.value.prompt(`turn ${i}`).ok);
  const taken = outcomes.filter((ok) => ok).length;
  assert.equal(taken, FAKE_PROMPT_CAPACITY - 1, 'the opening turn already took one slot');
  const refused = opened.value.prompt('one more');
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.refusal.reason, 'prompt-queue-full');
  assert.equal(opened.value.state, 'live', 'a refused turn must not end or degrade the session');
});

test('regression: a session past the bound is refused session-cap-reached before anything starts, and room returns when one ends', async () => {
  const fake = fakeAgents();
  const registry = new SessionRegistry({
    baseEnv: {},
    homeDir: 'C:/nonexistent-home-for-tests',
    startProcess: fake.start,
    maxSessions: 2,
  });
  const first = registry.create({ cwd: 'C:/work/a' });
  const second = registry.create({ cwd: 'C:/work/b' });
  assert.ok(first.ok && second.ok);

  const third = registry.create({ cwd: 'C:/work/c' });
  assert.equal(third.ok, false);
  assert.equal(third.ok === false && third.refusal.reason, 'session-cap-reached');
  assert.equal(fake.started.length, 2, 'the refused session must not start a process');

  first.value.stop('done');
  await waitFor(() => registry.liveCount + registry.provisioningCount === 1);
  const again = registry.create({ cwd: 'C:/work/c' });
  assert.equal(again.ok, true, 'room returns when a session ends');
});

test('messages fan out to every subscriber, and subscriptions do not outlive the session', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);
  const opening = registry.open({ cwd: 'C:/work', prompt: 'x' });
  await waitFor(() => fake.started.length === 1);
  fake.started[0]?.emit(initMessage('s1'));
  const opened = await opening;
  assert.ok(opened.ok);

  const first: string[] = [];
  const second: string[] = [];
  opened.value.onMessage((m) => first.push(m.type));
  const drop = opened.value.onMessage((m) => second.push(m.type));

  fake.started[0]?.emit(initMessage('s1', { subtype: 'status' }));
  await waitFor(() => first.length === 1);
  // Two independent readers both saw it — a single-consumer stream would have split them.
  assert.deepEqual(first, ['system']);
  assert.deepEqual(second, ['system']);

  drop();
  fake.started[0]?.emit(initMessage('s1', { subtype: 'status' }));
  await waitFor(() => first.length === 2);
  assert.equal(second.length, 1, 'an unsubscribed listener stops hearing');

  opened.value.stop('done');
  await waitFor(() => opened.value.state === 'ended');
  fake.started[0]?.emit(initMessage('s1', { subtype: 'status' }));
  await settle();
  assert.equal(first.length, 2, 'a dead session delivers nothing further');

  // And the references are actually released. Asserting only the line above would pass whether or
  // not the listeners were dropped, because a closed process emits nothing either way — the
  // assertion could not fail, which makes it a claim rather than a check.
  assert.equal(opened.value.observerCount, 0, 'nothing keyed to a session may outlive it');
});

test('observers are counted while they are attached — the control for the release above', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);
  const opening = registry.open({ cwd: 'C:/work', prompt: 'x' });
  await waitFor(() => fake.started.length === 1);
  fake.started[0]?.emit(initMessage('s1'));
  const opened = await opening;
  assert.ok(opened.ok);

  assert.equal(opened.value.observerCount, 0);
  const drop = opened.value.onMessage(() => undefined);
  opened.value.onEnd(() => undefined);
  opened.value.onDegrade(() => undefined);
  assert.equal(opened.value.observerCount, 3, 'the counter must move, or zero at the end means nothing');
  drop();
  assert.equal(opened.value.observerCount, 2, 'unsubscribing releases its own reference');
});

test('onEnd fires once, and a listener attached after the end is told immediately', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);
  const opening = registry.open({ cwd: 'C:/work', prompt: 'x' });
  await waitFor(() => fake.started.length === 1);
  fake.started[0]?.emit(initMessage('s1'));
  const opened = await opening;
  assert.ok(opened.ok);

  const during: string[] = [];
  opened.value.onEnd((ended) => during.push(ended.cause));
  opened.value.stop('done');
  opened.value.stop('done again');
  assert.deepEqual(during, ['stop_requested'], 'stopping twice must not end twice');

  const after: string[] = [];
  opened.value.onEnd((ended) => after.push(ended.cause));
  assert.deepEqual(after, ['stop_requested'], 'a late subscriber is not left waiting forever');
});

test('resume and fork are carried to the process, never decided here', () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  registry.create({ cwd: 'C:/work' });
  assert.equal(fake.started[0]?.request.resume, null, 'a new session resumes nothing');

  registry.create({ cwd: 'C:/work', resume: 'earlier-session', fork: true });
  assert.equal(fake.started[1]?.request.resume, 'earlier-session');
  assert.equal(fake.started[1]?.request.fork, true);
});

// --- helpers ---------------------------------------------------------------

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// ---------------------------------------------------------------------------
// An id collision on resume. A resume without fork keeps the same session id (observed on a real
// agent), so resuming a session this registry is already running produces two live handles
// claiming one key.
// ---------------------------------------------------------------------------

test('regression: a second session reporting an id this registry already holds is refused, not swapped in', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  const first = registry.create({ cwd: 'C:/work' });
  assert.ok(first.ok);
  await waitFor(() => fake.started.length === 1);
  fake.started[0]?.emit(initMessage('same-id'));
  await waitFor(() => registry.liveCount === 1);

  const degrades: string[] = [];
  const second = registry.create({ cwd: 'C:/work', resume: 'same-id' });
  assert.ok(second.ok);
  second.value.onDegrade((degrade) => degrades.push(degrade.kind));
  await waitFor(() => fake.started.length === 2);
  fake.started[1]?.emit(initMessage('same-id')); // a resume keeps the original id
  await waitFor(() => second.value.state === 'ended');

  assert.equal(registry.liveCount, 1, 'exactly one session holds the key');
  const held = registry.get('same-id');
  assert.ok(held.ok);
  assert.equal(held.value, first.value, 'the incumbent kept the key — the one already being observed');
  assert.deepEqual(degrades, ['session_id_collision'], 'the newcomer was told why, by name');
  assert.equal(second.value.ended?.cause, 'stop_requested');
});

// The second loss, and it is the worse one. Without the guard, the colliding session's eventual
// end would delete the key from `#live` whichever session held it — so a live session would become
// unreachable because a different one finished. Silent both ways: no error, and `get` would simply
// start refusing.
test('regression: a colliding session ending does not evict the session that actually holds the id', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  const first = registry.create({ cwd: 'C:/work' });
  assert.ok(first.ok);
  await waitFor(() => fake.started.length === 1);
  fake.started[0]?.emit(initMessage('same-id'));
  await waitFor(() => registry.liveCount === 1);

  const second = registry.create({ cwd: 'C:/work', resume: 'same-id' });
  assert.ok(second.ok);
  await waitFor(() => fake.started.length === 2);
  fake.started[1]?.emit(initMessage('same-id'));
  await waitFor(() => second.value.state === 'ended');

  assert.equal(
    registry.get('same-id').ok,
    true,
    'the incumbent is still reachable after the colliding session ended',
  );
  assert.equal(first.value.state, 'live', 'and it is genuinely still running');
});

test('the guard does not fire on a session re-reporting its own id', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  const created = registry.create({ cwd: 'C:/work' });
  assert.ok(created.ok);
  await waitFor(() => fake.started.length === 1);
  fake.started[0]?.emit(initMessage('an-id'));
  fake.started[0]?.emit(initMessage('an-id'));
  await waitFor(() => registry.liveCount === 1);

  assert.equal(created.value.state, 'live', 'a session is never a collision with itself');
  assert.equal(registry.liveCount, 1);
});

// ---------------------------------------------------------------------------
// The streaming options, and the two default lines that carry the policy.
// ---------------------------------------------------------------------------

// The asymmetry is the policy, and it is these two defaults. Partial messages are on because the
// lane they create is droppable by construction — losing one costs a repaint. Thinking is left at
// the SDK's own default because summarized prose costs tokens on the wire and puts reasoning text
// into transcripts and mirrors, which is a cost a caller should choose. The rule "on when someone
// is watching" cannot be written here at all: whether a run is watched is a judgement about what a
// session is for, and this host has no fact that distinguishes one.
test('regression: streaming is on by default and thinking prose is not — the two lines that carry the policy', () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  registry.create({ cwd: 'C:/work' });

  assert.equal(fake.started[0]?.request.includePartialMessages, true, 'a turn can be rendered as it happens');
  assert.equal(fake.started[0]?.request.thinking, null, 'the SDK decides, and no prose is stored by default');
  assert.equal(fake.started[0]?.request.forwardSubagentText, false, "the SDK's own default");
});

test('every streaming option a caller asks for is what is passed — none is decided here', () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);

  registry.create({
    cwd: 'C:/work',
    includePartialMessages: false,
    thinking: { type: 'adaptive', display: 'summarized' },
    forwardSubagentText: true,
  });

  assert.equal(fake.started[0]?.request.includePartialMessages, false);
  assert.deepEqual(fake.started[0]?.request.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(fake.started[0]?.request.forwardSubagentText, true);
});
