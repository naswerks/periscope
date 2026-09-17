/**
 * The property: a subscriber's failure belongs to the subscriber.
 *
 * The session reads the agent's stream once and fans it out, so a listener that throws is running
 * inside machinery it does not own. What must hold: the pump keeps reading, the other listeners
 * keep receiving, the process is not blamed (`process_failed` means the stream failed, nothing
 * else), nothing rejects unhandled — and the failure is still named, as a `subscriber_failed`
 * degrade, because contained must never mean silent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentProcess, AgentProcessRequest, SDKMessage } from '../host/agent-process.js';
import { fixedClock } from '../core/time.js';
import { fakeAgents, initMessage } from '../test-support/fake-agent.js';
import { SessionRegistry } from './registry.js';

function textMessage(index: number): SDKMessage {
  return { type: 'assistant', uuid: `uuid-msg-${index}`, message: { index } } as unknown as SDKMessage;
}

function registryWith(factory: (r: AgentProcessRequest) => AgentProcess) {
  return new SessionRegistry({
    baseEnv: { PATH: 'p' },
    homeDir: 'C:/nonexistent-home-for-tests',
    clock: fixedClock(Date.UTC(2026, 7, 3)),
    startTimeoutMs: 2_000,
    startProcess: factory,
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('a throwing onMessage subscriber does not end the session, and the others still receive', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);
  const created = registry.create({ cwd: 'C:/work' });
  assert.ok(created.ok);
  const session = created.value;

  const received: SDKMessage[] = [];
  session.onMessage(() => {
    throw new Error('subscriber bug');
  });
  session.onMessage((message) => received.push(message));

  fake.started[0]?.emit(initMessage('s1'));
  fake.started[0]?.emit(textMessage(1));
  await waitFor(() => received.length === 2);

  assert.equal(session.state, 'live', 'the session survives its subscriber');
  assert.equal(session.ended, null);
  assert.equal(fake.started[0]?.closed(), false, 'the process was never touched');
  const failures = session.degrades.filter((degrade) => degrade.kind === 'subscriber_failed');
  assert.equal(failures.length, 2, 'one named failure per throw — contained is not silent');
  assert.match(failures[0]?.detail ?? '', /an onMessage subscriber threw: subscriber bug/);
});

test('a subscriber bug cannot impersonate an outage — the end cause stays what the stream did', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);
  const created = registry.create({ cwd: 'C:/work' });
  assert.ok(created.ok);
  const session = created.value;

  session.onMessage(() => {
    throw new Error('subscriber bug');
  });
  fake.started[0]?.emit(initMessage('s1'));
  await waitFor(() => session.state === 'live');

  fake.started[0]?.finish();
  await waitFor(() => session.ended !== null);
  assert.equal(session.ended?.cause, 'process_ended', 'a clean stream end, whatever the subscriber did');
});

test('a throwing onEnd listener is contained, and the other end listeners still run', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);
  const created = registry.create({ cwd: 'C:/work' });
  assert.ok(created.ok);
  const session = created.value;

  const witnessed: string[] = [];
  session.onEnd(() => {
    throw new Error('end listener bug');
  });
  session.onEnd((ended) => witnessed.push(ended.cause));

  fake.started[0]?.emit(initMessage('s1'));
  await waitFor(() => session.state === 'live');
  fake.started[0]?.finish();
  await waitFor(() => session.ended !== null);

  assert.deepEqual(witnessed, ['process_ended'], 'the second listener heard the end');
  // The history outlives the cleared listener sets, so even a post-mortem reader sees the failure.
  const failures = session.degrades.filter((degrade) => degrade.kind === 'subscriber_failed');
  assert.equal(failures.length, 1);
  assert.match(failures[0]?.detail ?? '', /an onEnd listener threw: end listener bug/);
});

test('a stream failure closes the process and keeps its own name', async () => {
  const fake = fakeAgents();
  const registry = registryWith(fake.start);
  const created = registry.create({ cwd: 'C:/work' });
  assert.ok(created.ok);
  const session = created.value;

  fake.started[0]?.emit(initMessage('s1'));
  await waitFor(() => session.state === 'live');
  fake.started[0]?.fail(new Error('the stream broke'));
  await waitFor(() => session.ended !== null);

  assert.equal(session.ended?.cause, 'process_failed', 'the stream really did fail');
  assert.match(session.ended?.detail ?? '', /the stream broke/);
  assert.equal(fake.started[0]?.closed(), true, 'the handle is closed on the failure path, not leaked');
  assert.deepEqual(
    session.degrades.filter((degrade) => degrade.kind === 'subscriber_failed'),
    [],
    'no subscriber is blamed for a stream failure',
  );
});
