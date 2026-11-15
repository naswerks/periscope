/**
 * What the agent does with a message pushed on its input while a turn runs, against a real one: three
 * messages, one per turn, each pushed while the turn's shell call sleeps: one plain, as this host sends
 * every prompt, one naming another session as its origin with that session's permission class, and one
 * naming another session with none. The session refuses messages from other sessions
 * (`crossSessionInbound: 'refuse'`, which `composeOptions` sets on every session).
 *
 * It asserts what Claude Code 2.1.284 did, so a red is a change to record, not a defect in this host:
 * each message lands inside the turn it was pushed into (one result per turn), the model reads it, and
 * the transcript keeps no origin naming another session. It prints what it saw either way.
 *
 * It skips loudly. Without `PERISCOPE_LIVE=1` the probe is skipped with the reason in its name, and the
 * property is NOT exercised. Every workspace is an OS temporary directory, outside any repository.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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
const PUSH_AFTER_MS = 3_000;

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
    origin: { kind: 'peer', from: 'probe-peer', name: 'probe peer', fromMode: 'bypass' },
  },
  {
    name: 'from another session, no class named',
    word: 'loquat',
    origin: { kind: 'peer', from: 'probe-peer', name: 'probe peer' },
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

/** The text of every assistant text block in `messages`, joined. */
function assistantText(messages: readonly SDKMessage[]): string {
  return messages
    .filter((message) => message.type === 'assistant')
    .flatMap(
      (message) => (message as { message: { content: { type: string; text?: string }[] } }).message.content,
    )
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

/** Every line of the session's transcript that names `word`, read from under the agent's own home. */
function transcriptLinesNaming(sessionId: string, word: string): string[] {
  const home = defaultAgentHome(process.env);
  if (home === null) return [];
  const projects = join(home, 'projects');
  if (!existsSync(projects)) return [];
  for (const folder of readdirSync(projects)) {
    const file = join(projects, folder, `${sessionId}.jsonl`);
    if (existsSync(file)) {
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.includes(word));
    }
  }
  return [];
}

test(
  'live: a message pushed mid-turn lands at the next tool round of the turn it was pushed into, and another session it names as its origin is kept nowhere',
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
        const before = stream.seen.length;
        input.push(
          userMessage(
            'Run the shell command `sleep 15` with your Bash tool. When it finishes, repeat every word any ' +
              'message sent while it ran asked you to repeat, and say who each message was from.',
            null,
          ),
        );
        await stream.until(() => stream.seen.length > before, TURN_TIMEOUT_MS);
        await new Promise((resolve) => setTimeout(resolve, PUSH_AFTER_MS));
        input.push(userMessage(`Repeat the word ${leg.word}.`, leg.origin));
        await stream.until(() => results() >= index + 1, TURN_TIMEOUT_MS);
        // A message that waited for the turn to end would start a second one; give it the time to.
        await stream.until(() => results() > index + 1, 20_000);
        const turn = stream.seen.slice(before);
        const answer = assistantText(turn);
        const init = stream.seen.find((message) => message.type === 'system' && message.subtype === 'init');
        const sessionId = (init as { session_id?: string } | undefined)?.session_id ?? '';
        const recorded = transcriptLinesNaming(sessionId, leg.word);
        receipt(leg.name, {
          results: results(),
          answer,
          recorded: recorded.map((line) => line.slice(0, 400)),
        });
        assert.equal(results(), index + 1, `${leg.name}: the message started a turn of its own`);
        assert.match(answer.toLowerCase(), new RegExp(leg.word), `${leg.name}: the model did not read it`);
        assert.equal(
          recorded.some((line) => line.includes('"kind":"peer"')),
          false,
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
