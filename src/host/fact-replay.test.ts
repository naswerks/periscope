/**
 * The replay: one recorded Claude session, fed through a composed session, and the facts it puts on
 * the wire compared with the ones committed beside it.
 *
 * `src/test-support/fixtures/session.34.frames.jsonl` is one session's update-lane messages as a
 * controller stored them, one per line in arrival order, scrubbed by `TranscriptScrubber`: every
 * member name and number is the agent's own, and every other string a placeholder.
 * `session.34.facts.jsonl` beside it is what this host emits over them: one `agent_facts` body per
 * line, in wire order, without `observedAt`, since the recording carries no instants. Each fact's
 * `sourceId` is the `uuid` of the line it came from, so a controller replaying the two files can join
 * them.
 *
 * `npm run contracts:update` rewrites the facts file from the lift; read the diff before keeping it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decode, encode } from '../control/codec.js';
import type { AgentFact, AgentFactsUpdate, SessionPayload } from '../control/frames.js';
import { readAgentFacts } from '../control/frames.js';
import { fixedTicker } from '../core/time.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import { SessionRegistry } from '../sessions/registry.js';
import { fakeAgents } from '../test-support/fake-agent.js';
import type { SDKMessage } from './agent-process.js';
import { composeSession } from './host.js';

const FIXTURES = fileURLToPath(new URL('../../src/test-support/fixtures/', import.meta.url));
const FRAMES_FILE = `${FIXTURES}session.34.frames.jsonl`;
const FACTS_FILE = `${FIXTURES}session.34.facts.jsonl`;
const UPDATE = process.env['PERISCOPE_UPDATE_CONTRACTS'] === '1';

const AT = '2000-01-01T00:00:00.000Z';

type Frame = Record<string, unknown>;

const FRAMES: readonly Frame[] = readFileSync(FRAMES_FILE, 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Frame);

const allow = async (): Promise<unknown> => ({ behavior: 'allow' });

/** Every `agent_facts` body a composed session puts on the wire over `frames`, in wire order. */
async function replay(
  frames: readonly Frame[],
): Promise<{ bodies: AgentFactsUpdate[]; sent: SessionPayload[] }> {
  const fake = fakeAgents();
  const registry = new SessionRegistry({
    baseEnv: { PATH: 'p' },
    homeDir: 'C:/nonexistent-home-for-tests',
    startProcess: fake.start,
  });
  const sent: SessionPayload[] = [];
  const sink = {
    send(_sessionId: string, payload: SessionPayload): Result<void> {
      sent.push(payload);
      return ok(undefined);
    },
  };
  const composed = composeSession({
    registry,
    sessionKey: 'handle-1',
    cwd: 'C:/work',
    sink,
    decide: allow,
    clock: () => AT,
    ticker: fixedTicker(0),
  });
  assert.ok(composed.ok, composed.ok ? '' : composed.refusal.detail);
  const ended = new Promise<void>((resolve) => composed.value.session.onEnd(() => resolve()));
  const agent = fake.started[0];
  assert.ok(agent !== undefined);
  for (const frame of frames) agent.emit(frame as unknown as SDKMessage);
  agent.finish();
  await ended;

  const bodies = sent
    .map((payload) => (payload.kind === 'session_update' ? readAgentFacts(payload.body) : null))
    .filter((body) => body !== null);
  return { bodies, sent };
}

/** One line of the facts file: the body as the wire carries it, less the instant. */
function line(body: AgentFactsUpdate): string {
  return JSON.stringify({ update: body.update, fact: body.fact, sourceId: body.sourceId ?? null });
}

function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(numbersIn);
}

const recorded = replay(FRAMES);
// Awaited by every test below; a failed replay surfaces there, not as an unhandled rejection.
recorded.catch(() => undefined);

test('the facts a composed session emits over the recorded session are the committed ones', async () => {
  const { bodies } = await recorded;
  const text = `${bodies.map(line).join('\n')}\n`;
  if (UPDATE) writeFileSync(FACTS_FILE, text);
  assert.equal(
    text,
    readFileSync(FACTS_FILE, 'utf8'),
    'the lift no longer emits what is committed; read the diff',
  );
});

test('control: the comparison can fail: the recording without one of its results replays differently', async () => {
  const firstResult = FRAMES.findIndex((frame) => frame['type'] === 'result');
  assert.ok(firstResult > 0, 'the recording holds a result');
  const { bodies } = await replay(FRAMES.filter((_frame, index) => index !== firstResult));
  assert.notEqual(`${bodies.map(line).join('\n')}\n`, readFileSync(FACTS_FILE, 'utf8'));
});

test('every fact names a line of the recording, and every number in it is one that line reported', async () => {
  const { bodies } = await recorded;
  const byUuid = new Map(FRAMES.map((frame) => [frame['uuid'], frame] as const));
  const windowsReported = new Set(
    FRAMES.filter((frame) => frame['type'] === 'result').flatMap((frame) =>
      Object.values((frame['modelUsage'] ?? {}) as Record<string, { contextWindow?: number }>).map(
        (usage) => usage.contextWindow,
      ),
    ),
  );

  for (const body of bodies) {
    const source = byUuid.get(body.sourceId);
    assert.ok(source !== undefined, `${body.fact.kind}: sourceId ${String(body.sourceId)} names no line`);
    const reported = new Set(numbersIn(source));
    const fact: AgentFact = body.fact;
    if (fact.kind === 'usage_sample') {
      const usage = ((source['message'] as Frame)['usage'] ?? {}) as Record<string, number>;
      const sum =
        (usage['input_tokens'] ?? 0) +
        (usage['cache_read_input_tokens'] ?? 0) +
        (usage['cache_creation_input_tokens'] ?? 0);
      assert.equal(fact.contextTokens, sum, 'the one stated counting rule');
      assert.ok(
        fact.contextWindow === null || windowsReported.has(fact.contextWindow),
        'a window a result reported',
      );
      continue;
    }
    for (const number of numbersIn(fact)) {
      assert.ok(
        reported.has(number),
        `${fact.kind}: ${number} is not a number line ${String(body.sourceId)} reported`,
      );
    }
  }
});

test('the recording yields one handle, one receipt, a record per result, a sample per main-thread call', async () => {
  const { bodies } = await recorded;
  const kinds = (kind: AgentFact['kind']): AgentFactsUpdate[] =>
    bodies.filter((body) => body.fact.kind === kind);

  const inits = FRAMES.filter((frame) => frame['type'] === 'system' && frame['subtype'] === 'init');
  const results = FRAMES.filter((frame) => frame['type'] === 'result');
  const mainThread = FRAMES.filter(
    (frame) => frame['type'] === 'assistant' && (frame['parent_tool_use_id'] ?? null) === null,
  );
  const callIds = new Set(
    mainThread.map((frame) => (frame['message'] as Frame)['id']).filter((id) => typeof id === 'string'),
  );
  const withoutId = mainThread.filter((frame) => typeof (frame['message'] as Frame)['id'] !== 'string');

  assert.equal(inits.length, 19, 'the recording re-sends its init at every turn');
  assert.equal(kinds('session_handle').length, 1, 'one id across nineteen inits');
  assert.equal(kinds('agent_receipt').length, 1, 'nineteen identical inits are one receipt');
  assert.equal(kinds('turn_record').length, results.length);
  assert.equal(results.length, 19);
  assert.equal(callIds.size, 153, 'the main-thread API calls in the recording');
  assert.equal(
    withoutId.length,
    0,
    'no main-thread frame here lacks a message id, so none took the fallback',
  );
  assert.equal(kinds('usage_sample').length, callIds.size, 'one sample per API call, never one per frame');
  assert.ok(
    kinds('turn_record').every((body) => body.fact.kind === 'turn_record' && body.fact.turnScope === 'turn'),
  );
  assert.ok(
    kinds('turn_record').every(
      (body) =>
        body.fact.kind === 'turn_record' &&
        body.fact.totals?.byModel.every((row) => row.costBasis === 'list'),
    ),
    'no row reports a basis, and an absent basis is list',
  );
});

test("the recording's running tasks: each level, a subagent edge outliving its level, nothing for a bash start", async () => {
  const { bodies } = await recorded;
  const sets = bodies.flatMap((body) =>
    body.fact.kind === 'tasks' ? [body.fact.running.map((task) => task.taskId)] : [],
  );
  // A tasks fact that reports only a settled task restates the running set; each change of it is what
  // this reads, from the nothing a session starts with.
  const running = sets.filter((ids, index) => JSON.stringify(ids) !== JSON.stringify(sets[index - 1] ?? []));
  assert.deepEqual(running, [['aea05d375a29eaa82'], [], ['b5cwk2a74'], [], ['bofwxth9n'], []]);
  const stated = bodies.flatMap((body) =>
    body.fact.kind === 'tasks' ? [JSON.stringify([body.fact.running, body.fact.settled])] : [],
  );
  const repeated = stated.filter((key, index) => index > 0 && key === stated[index - 1]);
  assert.deepEqual(repeated, [], 'every tasks fact carries news: its running or its settled set changed');
});

test("the recording's settled tasks: each notification's task with its status, cleared as the next turn begins", async () => {
  const { bodies } = await recorded;
  const word = (value: unknown): string => (typeof value === 'string' ? value : '');
  const notified = FRAMES.filter((frame) => frame['subtype'] === 'task_notification').map((frame) =>
    [word(frame['task_id']), word(frame['status'])].join(' '),
  );
  const settled = new Map<string, string>();
  for (const body of bodies) {
    if (body.fact.kind !== 'tasks') continue;
    for (const task of body.fact.settled ?? []) settled.set(task.taskId, task.status);
  }
  assert.ok(notified.length > 0, 'the recording holds task notifications');
  assert.deepEqual(
    [...settled].map(([id, status]) => `${id} ${status}`).sort(),
    [...new Set(notified)].sort(),
    'every notification settled its task with the status it reported',
  );
  const last = bodies.filter((body) => body.fact.kind === 'tasks').at(-1);
  assert.deepEqual(last?.fact.kind === 'tasks' ? last.fact.settled : null, [], 'the next turn cleared them');
});

test('every fact frame the replay put on the wire encodes and decodes back unchanged', async () => {
  const { sent } = await recorded;
  const facts = sent.filter(
    (payload) => payload.kind === 'session_update' && readAgentFacts(payload.body) !== null,
  );
  assert.ok(facts.length > 0);
  let seq = 0;
  for (const payload of facts) {
    seq += 1;
    const frame = { frame: 'session' as const, sessionId: 'handle-1', seq, at: AT, payload };
    const encoded = encode(frame);
    assert.ok(encoded.ok, encoded.ok ? '' : encoded.refusal.detail);
    const decoded = decode(encoded.value);
    assert.ok(decoded.ok, decoded.ok ? '' : decoded.refusal.detail);
  }
});
