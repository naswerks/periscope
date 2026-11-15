/**
 * The observer's compaction report: when the compaction entry moves, and what the source that moved
 * it stated. Unit tests over the host's own translation, like `observer.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixedClock, fixedTicker } from '../core/time.js';
import type { HookInput, SDKMessage } from '../host/agent-process.js';
import type { SessionTransition, TransitionWhere } from './model.js';
import { SessionStateMachine } from './machine.js';
import type { CompactionReport } from './observer.js';
import { SessionObserver } from './observer.js';

const START_MS = Date.parse('2026-08-03T12:00:00.000Z');
const WHERE: TransitionWhere = { cwd: '/tmp/w', worktree: '/tmp/w', branch: 'main', unknownReason: null };

const message = (shape: Record<string, unknown>): SDKMessage => shape as unknown as SDKMessage;
const hook = (shape: Record<string, unknown>): HookInput => shape as unknown as HookInput;

const preCompact = hook({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null });
const postCompact = hook({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 'summary' });
const compacting = message({ type: 'system', subtype: 'status', status: 'compacting', uuid: 's-1' });
const requesting = message({ type: 'system', subtype: 'status', status: 'requesting', uuid: 's-2' });
const boundary = message({
  type: 'system',
  subtype: 'compact_boundary',
  uuid: 'b-1',
  compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 21000 },
});

/** An observer whose transitions and reports land on one timeline, in the order they were told. */
function watched(): { observer: SessionObserver; timeline: string[]; reports: CompactionReport[] } {
  const machine = new SessionStateMachine({
    where: WHERE,
    clock: fixedClock(START_MS),
    ticker: fixedTicker(START_MS),
  });
  const observer = new SessionObserver(machine);
  const timeline: string[] = [];
  const reports: CompactionReport[] = [];
  machine.onTransition((transition: SessionTransition) =>
    timeline.push(`transition:${transition.cause.event}`),
  );
  observer.onCompaction((report) => {
    reports.push(report);
    timeline.push(`report:${report.status}`);
  });
  return { observer, timeline, reports };
}

test('a compaction opened by the hook reports started with its trigger, after the transition that opened it', () => {
  const { observer, timeline, reports } = watched();
  observer.observeHook(preCompact);
  assert.deepEqual(reports, [
    { status: 'started', trigger: 'manual', tokensBefore: null, tokensAfter: null },
  ]);
  assert.deepEqual(timeline, ['transition:PreCompact', 'report:started']);
});

test('control: a second source opening the same compaction reports nothing; the first did', () => {
  const { observer, reports } = watched();
  observer.observeHook(preCompact);
  observer.observeMessage(compacting);
  assert.equal(reports.length, 1, 'the status message re-opens what the hook opened');
  assert.equal(reports[0]?.status, 'started');
});

test('the boundary closes it with the trigger and both token counts it carries', () => {
  const { observer, reports } = watched();
  observer.observeMessage(compacting);
  observer.observeMessage(boundary);
  assert.deepEqual(reports, [
    { status: 'started', trigger: null, tokensBefore: null, tokensAfter: null },
    { status: 'ended', trigger: 'auto', tokensBefore: 180000, tokensAfter: 21000 },
  ]);
});

test('control: the hook closing it carries only the trigger, and a later boundary reports nothing', () => {
  const { observer, reports } = watched();
  observer.observeHook(preCompact);
  observer.observeHook(postCompact);
  observer.observeMessage(boundary);
  assert.deepEqual(reports, [
    { status: 'started', trigger: 'manual', tokensBefore: null, tokensAfter: null },
    { status: 'ended', trigger: 'manual', tokensBefore: null, tokensAfter: null },
  ]);
});

test('a status message that does not touch the compaction entry reports nothing, nor does any other message', () => {
  const { observer, reports } = watched();
  observer.observeMessage(requesting);
  observer.observeMessage(message({ type: 'assistant', uuid: 'a', message: { content: [] } }));
  observer.observeHook(hook({ hook_event_name: 'Stop', session_id: 's' }));
  assert.deepEqual(reports, []);
});

test('the report adds nothing to the record: the transitions are the ones the sources always recorded', () => {
  const reported = watched();
  reported.observer.observeHook(preCompact);
  reported.observer.observeMessage(boundary);

  const machine = new SessionStateMachine({
    where: WHERE,
    clock: fixedClock(START_MS),
    ticker: fixedTicker(START_MS),
  });
  const unwatched = new SessionObserver(machine);
  const events: string[] = [];
  machine.onTransition((transition) => events.push(transition.cause.event));
  unwatched.observeHook(preCompact);
  unwatched.observeMessage(boundary);

  assert.deepEqual(
    reported.timeline.filter((entry) => entry.startsWith('transition:')).map((entry) => entry.slice(11)),
    events,
  );
});

const failedStatus = message({
  type: 'system',
  subtype: 'status',
  status: null,
  compact_result: 'failed',
  compact_error: 'the conversation could not be summarized',
  uuid: 's-3',
});
const succeededStatus = message({
  type: 'system',
  subtype: 'status',
  status: null,
  compact_result: 'success',
  uuid: 's-4',
});
const plainEnd = message({ type: 'system', subtype: 'status', status: null, uuid: 's-5' });

test('regression: a failed compaction ends the compaction, so its end is reported and the next compaction reports started', () => {
  const { observer, timeline, reports } = watched();
  observer.observeMessage(compacting);
  observer.observeMessage(failedStatus);
  observer.observeMessage(compacting);
  assert.deepEqual(
    reports.map((report) => report.status),
    ['started', 'ended', 'started'],
    'a failed compaction left its entry open, so its end went unreported and the next start was suppressed',
  );
  assert.deepEqual(reports[1], { status: 'ended', trigger: null, tokensBefore: null, tokensAfter: null });
  assert.ok(
    timeline.includes('transition:system/status'),
    'the end is recorded as the status message that stated it',
  );
});

test('control: a null status that states no outcome closes the request and leaves an open compaction open', () => {
  const { observer, reports } = watched();
  observer.observeMessage(compacting);
  observer.observeMessage(plainEnd);
  observer.observeMessage(compacting);
  assert.deepEqual(
    reports.map((report) => report.status),
    ['started'],
    'only the outcome a status states ends a compaction',
  );
});

test('a compaction that succeeded reports exactly one ended, with the counts its boundary states, whichever exits follow', () => {
  const { observer, reports } = watched();
  observer.observeHook(preCompact);
  observer.observeMessage(succeededStatus);
  observer.observeMessage(boundary);
  observer.observeHook(postCompact);
  assert.deepEqual(reports, [
    { status: 'started', trigger: 'manual', tokensBefore: null, tokensAfter: null },
    { status: 'ended', trigger: 'auto', tokensBefore: 180000, tokensAfter: 21000 },
  ]);
});
