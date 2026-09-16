/**
 * THE ROUTING TABLE ACCOUNTS FOR EVERY MESSAGE THE SHIPPED SDK CAN SEND.
 *
 * Beside the compiler for the same reason `hook-coverage.test.ts` is: `satisfies
 * Record<MessageDiscriminator, RoutingRow>` breaks the build when the SDK adds a message, which is
 * the strong half — but it is keyed off a DERIVED type, so it can only be as right as the derivation.
 * This reads the union out of the shipped `sdk.d.ts` itself and checks the table against the
 * artifact.
 *
 * It also guards the two things a routing table can quietly lose: a `declined` row whose reason has
 * evaporated, and the notify contract, which is a paragraph of prose that a tidy-up would delete
 * without noticing that a consumer inherits it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { MESSAGE_ROUTING, discriminatorsOn } from '../control/stream-routing.js';
import { DROPPABLE_KINDS } from '../control/frames.js';
import { sourceFiles } from './walk.js';

const SDK_TYPES = fileURLToPath(
  new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts', import.meta.url),
);

const types = (): string => readFileSync(SDK_TYPES, 'utf8').replace(/\r\n/g, '\n');

function unionMembers(source: string, typeName: string): string[] {
  const declaration = new RegExp(`export declare type ${typeName} = ([^;]+);`).exec(source);
  if (declaration?.[1] === undefined) return [];
  return declaration[1]
    .split('|')
    .map((member) => member.trim())
    .filter((member) => /^[A-Za-z][\w]*$/.test(member));
}

function discriminatorsOf(source: string, memberName: string): string[] {
  const start = source.indexOf(`export declare type ${memberName} =`);
  if (start < 0) return [];
  const end = source.indexOf('\n};', start);
  const body = source.slice(start, end < 0 ? start + 6000 : end);

  const kinds = [...body.matchAll(/^ {4}type: '([^']+)';$/gm)].map((match) => match[1] as string);
  const subtypes = [...body.matchAll(/^ {4}subtype: '([^']+)';$/gm)].map((match) => match[1] as string);

  if (!kinds.includes('system')) return kinds;
  return subtypes.map((subtype) => `system/${subtype}`);
}

// Guards the SELECTOR before anything trusts what it did not find. A parser that matched nothing
// would make "every message has a row" pass over an empty set, and that green looks identical.
test('control: the routing pin is really reading sdk.d.ts', () => {
  const source = types();
  assert.ok(source.length > 100_000, `sdk.d.ts looks unread: ${source.length} chars`);

  const members = unionMembers(source, 'SDKMessage');
  assert.ok(members.length >= 30, `SDKMessage parsed to ${members.length} members; the parser is wrong`);
  assert.ok(members.includes('SDKPartialAssistantMessage'), "the delta lane's own member is missing");
  assert.deepEqual(discriminatorsOf(source, 'SDKPartialAssistantMessage'), ['stream_event']);
  assert.deepEqual(discriminatorsOf(source, 'NotARealMessageName'), []);
});

test('every message the SDK can send has a routing row', () => {
  const source = types();
  const unaccounted: string[] = [];

  for (const member of unionMembers(source, 'SDKMessage')) {
    const discriminators = discriminatorsOf(source, member);
    if (discriminators.length === 0) {
      unaccounted.push(`${member} (no discriminator found)`);
      continue;
    }
    for (const discriminator of discriminators) {
      if (!(discriminator in MESSAGE_ROUTING)) unaccounted.push(`${member} -> ${discriminator}`);
    }
  }

  assert.deepEqual(unaccounted, [], 'a message with no row would ride no lane and vanish silently');
});

test('the routing table invents no message the SDK does not have', () => {
  const source = types();
  const declared = new Set(
    unionMembers(source, 'SDKMessage').flatMap((member) => discriminatorsOf(source, member)),
  );
  const invented = Object.keys(MESSAGE_ROUTING).filter((key) => !declared.has(key));
  assert.deepEqual(invented, [], 'a row for a message that cannot arrive is routing for nothing');
});

test('every row says why it rides its lane, a declined row most of all', () => {
  const rows = Object.entries(MESSAGE_ROUTING);
  assert.ok(rows.length >= 30, `the table looks empty: ${rows.length} rows`);

  const silent = rows
    .filter(([, row]) => typeof row.note !== 'string' || row.note.trim().length < 20)
    .map(([key]) => key);
  assert.deepEqual(silent, [], 'a row with no reason makes a decline indistinguishable from an oversight');
});

// The declined set is the one a later change will grow by accident. Declining is how a message
// stops reaching the wire at all, so the list is asserted by name: adding one has to be a deliberate
// edit here, argued, rather than a row quietly flipped while someone is editing something else.
test('regression: exactly five messages are declined, and each has a stated route by which its fact still travels', () => {
  assert.deepEqual(
    discriminatorsOn('declined').sort(),
    [
      'system/control_request_progress',
      'system/files_persisted',
      'system/hook_response',
      'system/hook_started',
      'system/session_state_changed',
    ].sort(),
  );
});

test('the delta lane is small, named, and made only of things something later restates', () => {
  assert.deepEqual(
    discriminatorsOn('delta').sort(),
    [
      'stream_event',
      'system/hook_progress',
      'system/status',
      'system/task_progress',
      'system/thinking_tokens',
      'tool_progress',
    ].sort(),
  );
});

// The two halves of "broadcast-only" have to agree: the routing table decides which MESSAGES are
// ephemeral, `DROPPABLE_KINDS` decides which PAYLOAD KIND may be discarded under pressure. If the
// delta lane were ever routed onto a non-droppable kind, the ephemeral declaration would be a
// comment rather than a mechanism.
test('everything on the delta lane lands on the one droppable payload kind', () => {
  assert.deepEqual([...DROPPABLE_KINDS], ['session_delta']);
  assert.ok(discriminatorsOn('delta').length > 0, 'an empty delta lane would satisfy this vacuously');
});

// A rot guard on a paragraph, because the thing being protected is prose and prose is what gets
// tidied away. The notify contract is inherited by whatever renders these frames and it fails
// silently when broken (mid-turn painting simply stops), so its absence must break something.
test('regression: the notify contract is still stated in the frame contract', () => {
  const frames = sourceFiles().find((file) => file.path === 'control/frames.ts');
  assert.ok(frames, 'control/frames.ts has moved; the frame contract is somewhere else now');

  const text = frames.text.toLowerCase();
  for (const clause of [
    'notify contract',
    'new top-level state reference',
    'same reference',
    'reference-equality',
  ]) {
    assert.ok(
      text.includes(clause),
      `the notify contract lost "${clause}"; a consumer would inherit the constraint with no way to learn it`,
    );
  }

  // And it must sit with the droppable kind rather than drifting into a header nobody reads.
  const contractAt = text.indexOf('notify contract');
  const deltaAt = text.indexOf('export interface sessiondelta');
  assert.ok(contractAt > 0 && deltaAt > contractAt, 'the contract has drifted away from SessionDelta');
});
