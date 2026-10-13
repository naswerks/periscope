/**
 * Claude's whole wire, held byte for byte: the recorded session replayed through a composed session,
 * with one gated tool call and one content delta per channel added, and every frame the session puts
 * on the wire encoded as the link would send it.
 *
 * `src/test-support/fixtures/session.34.wire.jsonl` is the result: the process request's data members
 * first, then one encoded session frame per line in send order, then each decision request the gate
 * posted. A change to how a Claude session reaches the wire, a message body, a fact, a fragment, a
 * transition, a decision request or the request handed to the agent process, shows here as a diff.
 * `PERISCOPE_UPDATE_CONTRACTS=1` rewrites the file; read the diff before keeping it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { encode } from '../control/codec.js';
import type { SessionPayload } from '../control/frames.js';
import { fixedTicker } from '../core/time.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import type { DecisionRequest } from '../gate/decision.js';
import { SessionRegistry } from '../sessions/registry.js';
import { fakeAgents, settle } from '../test-support/fake-agent.js';
import type { HookInput, SDKMessage } from './agent-process.js';
import { composeSession } from './host.js';

const FIXTURES = fileURLToPath(new URL('../../src/test-support/fixtures/', import.meta.url));
const FRAMES_FILE = `${FIXTURES}session.34.frames.jsonl`;
const WIRE_FILE = `${FIXTURES}session.34.wire.jsonl`;
const UPDATE = process.env['PERISCOPE_UPDATE_CONTRACTS'] === '1';

const AT = '2000-01-01T00:00:00.000Z';

type Frame = Record<string, unknown>;

const FRAMES: readonly Frame[] = readFileSync(FRAMES_FILE, 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Frame);

/** The session id the recorded init names, or empty when it names none. */
function initSessionId(frames: readonly Frame[]): string {
  const id = frames.find((frame) => frame['subtype'] === 'init')?.['session_id'];
  return typeof id === 'string' ? id : '';
}

/** One content delta per fragment channel, as the agent streams them. */
const STREAMED: readonly Frame[] = [
  { type: 'text_delta', text: 'Hel' },
  { type: 'thinking_delta', thinking: 'Reading the file first.' },
  { type: 'input_json_delta', partial_json: '{"command":"l' },
].map((delta, index) => ({
  type: 'stream_event',
  uuid: `streamed-${index}`,
  session_id: 'streamed-session',
  parent_tool_use_id: delta.type === 'input_json_delta' ? 'toolu_streamed' : null,
  event: { type: 'content_block_delta', index: 0, delta },
}));

/** The data members of the request handed to the agent process; a callback is named, never copied. */
function requestLine(request: object): string {
  const data = Object.fromEntries(
    Object.entries(request)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => {
        if (typeof value === 'function') return [key, '<function>'];
        if (key === 'hooks' && value !== null && typeof value === 'object') {
          return [key, Object.keys(value as object).sort()];
        }
        return [key, value];
      }),
  );
  return JSON.stringify({ request: data });
}

/** Every line of the wire file a composed session produces over `frames`. */
async function replay(frames: readonly Frame[]): Promise<string> {
  const fake = fakeAgents();
  const registry = new SessionRegistry({
    baseEnv: { PATH: 'p' },
    homeDir: 'C:/nonexistent-home-for-tests',
    startProcess: fake.start,
  });
  const sent: SessionPayload[] = [];
  const asked: DecisionRequest[] = [];
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
    decide: async (request) => {
      asked.push(request);
      return { behavior: 'allow' };
    },
    clock: () => AT,
    ticker: fixedTicker(0),
  });
  assert.ok(composed.ok, composed.ok ? '' : composed.refusal.detail);
  const ended = new Promise<void>((resolve) => composed.value.session.onEnd(() => resolve()));
  const agent = fake.started[0];
  assert.ok(agent !== undefined, 'no process was started');

  for (const frame of frames) agent.emit(frame as unknown as SDKMessage);
  await settle();

  const call = {
    session_id: initSessionId(frames),
    cwd: 'C:/work',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'toolu_replayed',
  };
  for (const [event, extra] of [
    ['PreToolUse', {}],
    ['PostToolUse', { tool_response: { stdout: 'a\nb', stderr: '', interrupted: false } }],
  ] as const) {
    const input = { ...call, ...extra, hook_event_name: event } as unknown as HookInput;
    for (const matcher of agent.request.hooks?.[event] ?? []) {
      for (const hook of matcher.hooks) {
        await hook(input, call.tool_use_id, { signal: new AbortController().signal });
      }
    }
  }

  for (const frame of STREAMED) agent.emit(frame as unknown as SDKMessage);
  agent.finish();
  await ended;

  const lines = [requestLine(agent.request)];
  let seq = 0;
  for (const payload of sent) {
    seq += 1;
    const encoded = encode({ frame: 'session', sessionId: 'handle-1', seq, at: AT, payload });
    assert.ok(encoded.ok, encoded.ok ? '' : encoded.refusal.detail);
    lines.push(encoded.value);
  }
  for (const request of asked) lines.push(JSON.stringify({ decision: request }));
  return `${lines.join('\n')}\n`;
}

const recorded = replay(FRAMES);
// Awaited by every test below; a failed replay surfaces there, not as an unhandled rejection.
recorded.catch(() => undefined);

test("a Claude session's wire over the recorded session is the committed one, byte for byte", async () => {
  const text = await recorded;
  if (UPDATE) writeFileSync(WIRE_FILE, text);
  assert.equal(text, readFileSync(WIRE_FILE, 'utf8'), "a Claude session's wire moved; read the diff");
});

test('control: the comparison can fail: the recording without its first assistant message replays differently', async () => {
  const first = FRAMES.findIndex((frame) => frame['type'] === 'assistant');
  assert.ok(first >= 0, 'the recording holds an assistant message');
  const text = await replay(FRAMES.filter((_frame, index) => index !== first));
  assert.notEqual(text, readFileSync(WIRE_FILE, 'utf8'));
});

test('the wire file carries the request, every lane and the gate: messages, facts, fragments, transitions, a decision', async () => {
  const text = await recorded;
  for (const marker of [
    '{"request":',
    '"update":"agent_message"',
    '"update":"agent_facts"',
    '"update":"agent_fragment"',
    '"update":"state_transition"',
    '"kind":"session_delta"',
    '{"decision":',
  ]) {
    assert.ok(text.includes(marker), `the wire file lacks ${marker}`);
  }
});
