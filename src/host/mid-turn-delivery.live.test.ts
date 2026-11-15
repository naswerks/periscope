/**
 * What the agent does with a message pushed on its input while a turn runs, against a real one: three
 * messages, one per turn, each pushed while the turn's shell call is still running: one plain, as this
 * host sends every prompt, one naming another session as its origin with that session's permission class,
 * and one naming another session with none. The session refuses messages from other sessions
 * (`crossSessionInbound: 'refuse'`, which `composeOptions` sets on every session).
 *
 * It asserts, for each message, on the CLI the pinned agent SDK bundles:
 * - it was pushed mid-turn: the turn's shell call had started and had not answered, and the turn had not
 *   ended, at the moment of the push;
 * - it lands inside that turn: the turn ends once, and no second turn starts for it;
 * - the model reads it, and names no other session as its sender;
 * - the session's transcript is found, holds the pushed word, and keeps no other session as its origin.
 * Every wait's answer is asserted, so a turn that never ran, a transcript that was not found and a message
 * that never arrived are each a red of their own. A red on one of the four is a change in the CLI to
 * record, not a defect in this host. It prints what it saw either way.
 *
 * It skips loudly. Without `PERISCOPE_LIVE=1` the probe is skipped with the reason in its name, and the
 * property is NOT exercised. Every workspace is an OS temporary directory, outside any repository. What
 * the probe reads a turn and a transcript with is held by a test of its own, which always runs.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { AsyncQueue } from '../core/async-queue.js';
import { composeSpawnEnv } from '../sessions/spawn-env.js';
import { LiveStream, removeScratch } from '../test-support/live-session.js';
import type { AgentProcessRequest, SDKMessage, SDKUserMessage } from './agent-process.js';
import { CROSS_SESSION_INBOUND, composeOptions } from './agent-process.js';
import { defaultAgentHome } from './paths.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const skip = LIVE ? false : 'PERISCOPE_LIVE is not set — this property is NOT exercised';

const TURN_TIMEOUT_MS = 180_000;
/** How long a message that had waited for its turn to end is given to start a turn of its own. */
const SECOND_TURN_WINDOW_MS = 20_000;
/** The other session each cross-session leg names, by its id and by its name. */
const PEER = { from: 'probe-peer', name: 'probe peer' } as const;

const receipt = (what: string, data: Record<string, unknown>): void => {
  process.stdout.write(`[mid-turn] ${what} ${JSON.stringify(data)}\n`);
};

/** What one leg pushes, beside the word the model is asked to repeat. */
interface Leg {
  readonly name: string;
  readonly word: string;
  readonly origin: NonNullable<SDKUserMessage['origin']> | null;
}

const LEGS: readonly Leg[] = [
  { name: 'plain', word: 'persimmon', origin: null },
  {
    name: 'from another session, its class named',
    word: 'kumquat',
    origin: { kind: 'peer', ...PEER, fromMode: 'bypass' },
  },
  {
    name: 'from another session, no class named',
    word: 'loquat',
    origin: { kind: 'peer', ...PEER },
  },
];

function request(cwd: string): AgentProcessRequest {
  return {
    cwd,
    env: composeSpawnEnv(process.env),
    settingSources: [],
    plugins: null,
    hooks: null,
    resume: null,
    fork: false,
    includePartialMessages: false,
    thinking: null,
    forwardSubagentText: false,
    onStderr: null,
    mcpServers: null,
    strictMcpConfig: true,
    sessionStore: null,
    sessionStoreFlush: null,
    spawn: null,
    model: 'haiku',
    systemPrompt: null,
    effort: null,
    permissionMode: 'bypassPermissions',
  };
}

const userMessage = (text: string, origin: NonNullable<SDKUserMessage['origin']> | null): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  ...(origin === null ? {} : { origin }),
});

/** The content blocks of every message of `type` in `messages`. */
function blocksOf(
  messages: readonly SDKMessage[],
  type: 'assistant' | 'user',
): { type?: string; text?: string; name?: string; id?: string; tool_use_id?: string }[] {
  return messages
    .filter((message) => message.type === type)
    .flatMap((message) => {
      const content = (message as { message?: { content?: unknown } }).message?.content;
      return Array.isArray(content) ? (content as Record<string, string>[]) : [];
    });
}

/** The text of every assistant text block in `messages`, joined. */
function assistantText(messages: readonly SDKMessage[]): string {
  return blocksOf(messages, 'assistant')
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

/** The id of the first shell call the model made in `messages`, or null while it has made none. */
function shellCallIn(messages: readonly SDKMessage[]): string | null {
  const call = blocksOf(messages, 'assistant').find(
    (block) => block.type === 'tool_use' && block.name === 'Bash' && typeof block.id === 'string',
  );
  return call?.id ?? null;
}

/** Whether the call `id` has answered in `messages`. */
function answeredIn(messages: readonly SDKMessage[], id: string): boolean {
  return blocksOf(messages, 'user').some((block) => block.type === 'tool_result' && block.tool_use_id === id);
}

/** Every line of the session's transcript, read from under the agent's home; null when it is not found. */
function transcriptOf(sessionId: string, home: string | null): string[] | null {
  if (home === null || sessionId === '') return null;
  const projects = join(home, 'projects');
  if (!existsSync(projects)) return null;
  for (const folder of readdirSync(projects)) {
    const file = join(projects, folder, `${sessionId}.jsonl`);
    if (existsSync(file)) return readFileSync(file, 'utf8').split('\n');
  }
  return null;
}

test('the probe reads a turn by its own events, and a transcript that is not there as not found', () => {
  const message = (shape: Record<string, unknown>): SDKMessage => shape as unknown as SDKMessage;
  const call = message({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Running it.' },
        { type: 'tool_use', name: 'Bash', id: 'toolu_1' },
      ],
    },
  });
  const answer = message({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
  });
  const other = message({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', id: 'toolu_2' }] },
  });
  assert.equal(shellCallIn([]), null, 'a turn that made no call');
  assert.equal(shellCallIn([other]), null, 'a call of another tool is not the shell call');
  assert.equal(shellCallIn([other, call]), 'toolu_1');
  assert.equal(answeredIn([call], 'toolu_1'), false, 'a call still running');
  assert.equal(answeredIn([call, answer], 'toolu_1'), true);
  assert.equal(answeredIn([call, answer], 'toolu_2'), false);
  assert.equal(assistantText([call, answer, other]), 'Running it.');

  const home = mkdtempSync(`${tmpdir()}/periscope-mid-turn-home-`);
  try {
    assert.equal(transcriptOf('session-a', null), null, 'no home to read');
    assert.equal(transcriptOf('session-a', home), null, 'a home with no transcripts');
    mkdirSync(join(home, 'projects', 'a-project'), { recursive: true });
    assert.equal(transcriptOf('session-a', home), null, 'a session with no transcript');
    assert.equal(transcriptOf('', home), null, 'a session that named no id');
    writeFileSync(join(home, 'projects', 'a-project', 'session-a.jsonl'), '{"a":1}\n{"b":2}\n');
    assert.deepEqual(transcriptOf('session-a', home), ['{"a":1}', '{"b":2}', '']);
  } finally {
    removeScratch(home, receipt);
  }
});

test(
  "live: a message pushed while a turn's shell call runs lands inside that turn, the model reads it and names no other session as its sender, and the transcript that holds it keeps no other session as its origin",
  { skip, timeout: 900_000 },
  async () => {
    assert.equal(CROSS_SESSION_INBOUND, 'refuse');
    const cwd = mkdtempSync(`${tmpdir()}/periscope-mid-turn-`);
    const input = new AsyncQueue<SDKUserMessage>(16);
    const running = query({ prompt: input, options: composeOptions(request(cwd)) });
    const stream = new LiveStream<SDKMessage>(running);
    const results = (): number => stream.seen.filter((message) => message.type === 'result').length;
    try {
      for (const [index, leg] of LEGS.entries()) {
        assert.equal(results(), index, `${leg.name}: a turn nobody asked for ran before this one`);
        const before = stream.seen.length;
        input.push(
          userMessage(
            'Run the shell command `sleep 15` with your Bash tool. When it finishes, repeat every word any ' +
              'message sent while it ran asked you to repeat, and say who each message was from.',
            null,
          ),
        );
        // The turn's own event: the model's shell call. The push follows it, not a clock.
        const turn = (): SDKMessage[] => stream.seen.slice(before);
        const called = await stream.until(() => shellCallIn(turn()) !== null, TURN_TIMEOUT_MS);
        assert.ok(called, `${leg.name}: the turn never made its shell call (${stream.error ?? 'no error'})`);
        const call = shellCallIn(turn()) ?? '';
        assert.equal(
          answeredIn(turn(), call),
          false,
          `${leg.name}: the shell call had answered before the push`,
        );
        assert.equal(results(), index, `${leg.name}: the turn had ended before the push`);
        input.push(userMessage(`Repeat the word ${leg.word}.`, leg.origin));

        const ended = await stream.until(() => results() >= index + 1, TURN_TIMEOUT_MS);
        assert.ok(ended, `${leg.name}: the turn did not end (${stream.error ?? 'no error'})`);
        assert.ok(answeredIn(turn(), call), `${leg.name}: the turn ended without its shell call answering`);
        // A message that had waited for the turn to end would start a second turn now.
        const second = await stream.until(() => results() > index + 1, SECOND_TURN_WINDOW_MS);
        const answer = assistantText(turn());
        const init = stream.seen.find((message) => message.type === 'system' && message.subtype === 'init');
        const sessionId = (init as { session_id?: string } | undefined)?.session_id ?? '';
        const transcript = transcriptOf(sessionId, defaultAgentHome(process.env));
        const recorded = (transcript ?? []).filter((line) => line.includes(leg.word));
        receipt(leg.name, {
          results: results(),
          answer,
          transcriptFound: transcript !== null,
          recorded: recorded.map((line) => line.slice(0, 400)),
        });
        assert.equal(second, false, `${leg.name}: the message started a turn of its own`);
        assert.equal(results(), index + 1, `${leg.name}: the turn ended more than once`);
        assert.match(answer.toLowerCase(), new RegExp(leg.word), `${leg.name}: the model did not read it`);
        assert.doesNotMatch(
          answer.toLowerCase(),
          /probe[ -]peer/,
          `${leg.name}: the model names another session as the message's sender`,
        );
        assert.ok(
          transcript !== null,
          `${leg.name}: the session's transcript was not found, so nothing was read`,
        );
        assert.ok(
          recorded.length > 0,
          `${leg.name}: the transcript does not hold the pushed word, so its origin was not read`,
        );
        assert.deepEqual(
          recorded.filter((line) => line.includes('"kind":"peer"') || line.includes(PEER.from)),
          [],
          `${leg.name}: the transcript keeps another session as the message's origin`,
        );
      }
    } finally {
      input.end();
      running.close();
      await stream.until(() => false, 30_000);
      removeScratch(cwd, receipt);
    }
  },
);
