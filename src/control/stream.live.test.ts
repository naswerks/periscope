/**
 * Streaming, against a real agent, because every claim here is about what the SDK does.
 *
 * A mock would prove the mock. The three questions this file exists to answer could each be
 * answered wrongly by reading types; "thinking prose arrives empty" is the kind of claim that is
 * true of a default and false of the knob, and only a live turn tells the two apart.
 *
 *   1. Does text arrive incrementally, so a turn can be rendered as it happens?
 *   2. Does `display: 'summarized'` yield real reasoning prose, and does the default not?
 *   3. Which message discriminators actually fire on a real turn? Two of the routing table's rows
 *      are for messages only ever seen in the SDK's types, and a row wired on type evidence alone
 *      is a claim, not a receipt.
 *
 * They skip loudly. Without `PERISCOPE_LIVE=1` each skips with the reason in its own name, so the
 * suite's `skipped` count is the standing reminder that these are NOT exercised in an ordinary run.
 *
 * Every workspace is an OS temporary directory, outside any repository. The agent discovers
 * project settings by walking up from its working directory, so a workspace inside a checkout would
 * inherit that checkout's `.claude/settings.json`, hooks included, which would then fire for real
 * against a system this is not testing.
 *
 * The prompts are one instruction each. These prove the stream, not the model.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { SDKMessage, ThinkingConfig } from '../host/agent-process.js';
import { discriminatorOf } from '../host/agent-process.js';
import { SessionRegistry } from '../sessions/registry.js';
import { SessionStateMachine } from '../state/machine.js';
import { SessionObserver } from '../state/observer.js';
import { systemClock, systemTicker } from '../core/time.js';
import type { Refusal } from '../core/refusal.js';
import type { SessionPayload } from './frames.js';
import { readAgentMessage, readStateTransition } from './frames.js';
import type { FrameSink } from './stream.js';
import { forwardSession } from './stream.js';
import { MESSAGE_ROUTING } from './stream-routing.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const skip = LIVE ? false : 'PERISCOPE_LIVE is not set — this property is NOT exercised';

const START_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 180_000;

const workspaceOutsideAnyRepo = (label: string): string =>
  mkdtempSync(`${tmpdir()}/periscope-stream-${label}-`);

/**
 * The probe's own environment carries `CLAUDE_CODE_CHILD_SESSION=1`, which makes the CLI skip
 * transcript persistence, and `CLAUDE_EFFORT`, which would run these at the host's effort. The
 * allow-list drops both; this only names why it matters here.
 */
const baseEnv = process.env;

interface Observed {
  /** Every frame the forwarder produced, in order. */
  readonly frames: { sessionId: string; payload: SessionPayload }[];
  /** Every discriminator seen on the raw stream, in order, duplicates included. */
  readonly discriminators: string[];
  readonly refusals: Refusal[];
  readonly cwd: string;
}

class Collecting implements FrameSink {
  readonly sent: { sessionId: string; payload: SessionPayload }[] = [];
  send(sessionId: string, payload: SessionPayload) {
    this.sent.push({ sessionId, payload });
    return { ok: true as const, value: undefined };
  }
}

/** Run one real turn with the forwarder attached, and hand back everything it saw. */
async function observeTurn(
  label: string,
  prompt: string,
  options: { thinking?: ThinkingConfig; forwardSubagentText?: boolean } = {},
): Promise<Observed> {
  const cwd = workspaceOutsideAnyRepo(label);
  const machine = new SessionStateMachine({
    where: { cwd, worktree: null, branch: null, unknownReason: 'a probe workspace is not a repository' },
    clock: systemClock,
    ticker: systemTicker,
  });
  const observer = new SessionObserver(machine);
  const sink = new Collecting();
  const refusals: Refusal[] = [];
  const discriminators: string[] = [];

  const registry = new SessionRegistry({
    baseEnv,
    homeDir: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
    startTimeoutMs: START_TIMEOUT_MS,
  });

  const created = registry.create({
    cwd,
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    ...(options.forwardSubagentText === undefined
      ? {}
      : { forwardSubagentText: options.forwardSubagentText }),
  });
  assert.equal(
    created.ok,
    true,
    `the probe session was refused: ${created.ok ? '' : created.refusal.detail}`,
  );
  const session = created.ok ? created.value : (undefined as never);

  // A second listener beside the forwarder: what the SDK actually sent, before any routing decision.
  session.onMessage((message: SDKMessage) => discriminators.push(discriminatorOf(message)));

  forwardSession({
    sessionKey: 'probe-controller-handle',
    session,
    observer,
    sink,
    onRefusal: (refusal) => refusals.push(refusal),
  });

  const sent = session.prompt(prompt);
  assert.equal(sent.ok, true);
  const live = await session.whenLive(START_TIMEOUT_MS);
  assert.equal(live.ok, true, `the agent never reported itself: ${live.ok ? '' : live.refusal.detail}`);

  await waitForResult(discriminators, TURN_TIMEOUT_MS);
  session.stop('the probe finished');

  return { frames: sink.sent, discriminators, refusals, cwd };
}

async function waitForResult(discriminators: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (discriminators.includes('result')) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no result message within ${timeoutMs}ms — the turn never ended`);
}

/** The forwarded message bodies on one lane. */
function messagesOn(observed: Observed, kind: 'session_delta' | 'session_update'): Record<string, unknown>[] {
  return observed.frames
    .filter((frame) => frame.payload.kind === kind)
    .map((frame) => readAgentMessage((frame.payload as unknown as { body: Record<string, never> }).body))
    .filter((body): body is NonNullable<typeof body> => body !== null);
}

/**
 * Total characters of `thinking` prose across every thinking_delta on the stream, with the full
 * delta-type histogram beside it.
 *
 * The histogram is not decoration: a zero prose count has two completely different explanations
 * (the knob did nothing, or the model never entered a thinking block) and only the histogram tells
 * them apart. A probe that could not distinguish those would report "no prose" for both and be
 * quoted later as evidence against the knob.
 */
function thinkingProse(observed: Observed): { deltas: number; chars: number; histogram: string } {
  let deltas = 0;
  let chars = 0;
  const kinds = new Map<string, number>();

  for (const message of messagesOn(observed, 'session_delta')) {
    const event = message['event'] as
      { type?: string; delta?: { type?: string; thinking?: string } } | undefined;
    const key = event?.delta?.type ?? event?.type ?? '(no event)';
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
    if (event?.delta?.type !== 'thinking_delta') continue;
    deltas += 1;
    chars += (event.delta.thinking ?? '').length;
  }

  const histogram =
    [...kinds.entries()].map(([key, count]) => `${key}=${count}`).join(' ') || '(no deltas at all)';
  return { deltas, chars, histogram };
}

/**
 * Does a `user` message on the output stream carry the text that was sent in?
 *
 * Tool results also arrive as `user` messages, so a count of them proves nothing. What matters is
 * whether the host's own queued prompt is replayed, because if it is, a host synthesizing its own
 * user echo would be putting a second name for one message on the wire.
 */
function promptWasReplayed(observed: Observed, prompt: string): boolean {
  return messagesOn(observed, 'session_update')
    .filter((message) => message['type'] === 'user')
    .some((message) => JSON.stringify(message['message'] ?? {}).includes(prompt.slice(0, 24)));
}

// ---------------------------------------------------------------------------

test(
  'live: a turn can be rendered as it happens — text arrives in fragments before the message that settles it',
  { skip },
  async () => {
    const observed = await observeTurn('render', 'Reply with exactly: streaming works. Nothing else.');

    const deltas = messagesOn(observed, 'session_delta');
    const textFragments = deltas
      .map((message) => {
        const event = message['event'] as { delta?: { type?: string; text?: string } } | undefined;
        return event?.delta?.type === 'text_delta' ? (event.delta.text ?? '') : null;
      })
      .filter((text): text is string => text !== null);

    console.log(
      `[render] frames=${observed.frames.length} deltas=${deltas.length} textFragments=${textFragments.length}`,
    );
    assert.ok(textFragments.length > 0, 'no text_delta arrived — a turn cannot be rendered as it happens');

    const joined = textFragments.join('');
    assert.ok(joined.trim().length > 0, 'the fragments carried no prose');

    // The ordering, asserted rather than narrated. Asserting only that an assistant message exists
    // somewhere on the durable lane would be true of a stream that settled first and fragmented
    // afterwards, which is the failure the title is about.
    const lastDeltaAt = observed.frames.findLastIndex((frame) => frame.payload.kind === 'session_delta');
    const settledAt = observed.frames.findIndex((frame) => {
      if (frame.payload.kind !== 'session_update') return false;
      const body = readAgentMessage((frame.payload as unknown as { body: Record<string, never> }).body);
      return (body as unknown as { type?: string } | null)?.type === 'assistant';
    });

    assert.ok(
      settledAt >= 0,
      'the assistant message that settles the fragments never reached the durable lane',
    );
    assert.ok(lastDeltaAt >= 0, 'no delta reached the wire at all');
    assert.ok(
      lastDeltaAt < settledAt,
      `a fragment arrived after the settling message (last delta ${lastDeltaAt}, settled ${settledAt})`,
    );

    // Not asserted, and the reason is stated rather than left to a reader: that `joined` equals
    // the settled message's text. The fragments belong to one content block and a real turn may
    // carry several, so an equality here would be a guess.
    assert.deepEqual(observed.refusals, [], 'nothing was refused on the way to the wire');
  },
);

// Settled by watching. Two rows in the routing and coverage tables are for messages only ever
// seen in the shipped types. This prints the discriminators a real turn actually produced, so the
// tables can be read against evidence instead of against a type. The assertion is deliberately
// weak (a turn happened at all); the receipt is the printed list, and a row that never appears is
// reported rather than quietly assumed present.
test(
  'live: which message discriminators a real turn actually produces — observed, not inferred',
  { skip },
  async () => {
    const observed = await observeTurn(
      'discriminators',
      'Create a file called note.txt containing the word hello.',
    );

    const seen = [...new Set(observed.discriminators)].sort();
    const counts = seen.map((key) => `${key}=${observed.discriminators.filter((d) => d === key).length}`);
    console.log(`[discriminators] ${counts.join(' ')}`);

    const unrouted = seen.filter((key) => !(key in MESSAGE_ROUTING));
    assert.deepEqual(unrouted, [], 'a message arrived that the routing table has no row for');

    // The two rows that only have type evidence. Reported either way; a false claim of coverage is
    // worse than an honest gap.
    for (const questioned of ['system/status', 'system/session_state_changed']) {
      console.log(
        `[type-evidence-only] ${questioned}: ${seen.includes(questioned) ? 'OBSERVED' : 'NOT OBSERVED on this turn'}`,
      );
    }

    // SDKUserMessageReplay: does prompting through the host's own input queue produce a `user`
    // message on the output stream? If it does, a host that synthesized its own user echo would be
    // putting a second name for one message on the wire.
    const replays = messagesOn(observed, 'session_update').filter((message) => message['type'] === 'user');
    console.log(`[user-replay] user messages on the output stream: ${replays.length}`);

    assert.ok(observed.discriminators.includes('result'), 'the turn completed');
    assert.ok(observed.discriminators.includes('system/init'), 'the agent reported itself');
  },
);

// The point is the pair. One leg alone proves nothing: "prose is empty" is true of the default
// and says nothing about the knob. Running both against the same prompt is what turns it from a
// belief into a knob.
test(
  'live: thinking prose arrives only with display:summarized — both legs, same prompt',
  { skip },
  async () => {
    // A prompt that has to be reasoned through rather than recalled. A question with a one-token
    // answer lets adaptive thinking decide not to think at all, which produces a zero that looks
    // like a knob failure and is not one: a trivial comparison returns 0/0 on both legs and proves
    // nothing about either.
    const prompt =
      'Two trains 260 km apart approach each other at 65 km/h and 45 km/h. A bird flies at 90 km/h ' +
      'back and forth between them until they meet. How far does the bird fly? Reason it through step ' +
      'by step, then give the number.';

    const byDefault = await observeTurn('thinking-default', prompt, { thinking: { type: 'adaptive' } });
    const summarized = await observeTurn('thinking-summarized', prompt, {
      thinking: { type: 'adaptive', display: 'summarized' },
    });

    const plain = thinkingProse(byDefault);
    const rich = thinkingProse(summarized);
    const tickers = (observed: Observed): number =>
      observed.discriminators.filter((key) => key === 'system/thinking_tokens').length;

    console.log(`[thinking] adaptive            : ${plain.deltas} thinking_deltas / ${plain.chars} chars`);
    console.log(`[thinking] adaptive+summarized : ${rich.deltas} thinking_deltas / ${rich.chars} chars`);
    console.log(`[thinking] adaptive            delta types: ${plain.histogram}`);
    console.log(`[thinking] adaptive+summarized delta types: ${rich.histogram}`);
    console.log(
      `[thinking] thinking_tokens tickers: default=${tickers(byDefault)} summarized=${tickers(summarized)}`,
    );
    console.log(
      `[user-replay] the queued prompt came back on the output stream: ` +
        `default=${promptWasReplayed(byDefault, prompt)} summarized=${promptWasReplayed(summarized, prompt)}`,
    );

    // The control comes first. If neither turn produced a thinking block at all, the comparison is
    // about nothing, and reporting that as a knob failure would be worse than reporting no result.
    // `system/thinking_tokens` is digested from thinking deltas, so it is independent evidence that
    // thinking happened, which makes "no prose" and "no thinking" distinguishable rather than one
    // ambiguous zero.
    assert.ok(
      plain.deltas + rich.deltas > 0 || tickers(byDefault) + tickers(summarized) > 0,
      'NEITHER turn produced a thinking block, so this run says nothing about the display knob — ' +
        'INCONCLUSIVE, not a negative result',
    );

    assert.ok(rich.chars > 0, 'display:summarized produced no reasoning prose at all');
    assert.ok(
      rich.chars > plain.chars,
      `summarized carried no more prose than the default (${rich.chars} vs ${plain.chars})`,
    );
  },
);

// The cheap half of proving `forwardSubagentText`: that the host can compose it and a session
// still starts. Proving the nested transcript actually arrives needs a turn that spawns a
// subagent, which is a different order of cost and is not exercised here.
test(
  'live: forwardSubagentText composes, and a session with it set still runs a turn',
  { skip },
  async () => {
    const observed = await observeTurn('subagent-text', 'Reply with exactly: composed. Nothing else.', {
      forwardSubagentText: true,
    });

    assert.ok(observed.discriminators.includes('result'), 'the turn completed with the option composed');
    const transitions = observed.frames
      .map((frame) => readStateTransition((frame.payload as unknown as { body: Record<string, never> }).body))
      .filter((transition) => transition !== null);
    assert.ok(transitions.length > 0, 'transitions still rode the wire beside the messages');
  },
);
