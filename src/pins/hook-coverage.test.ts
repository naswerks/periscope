/**
 * The hook-coverage pin: the coverage table accounts for every event the shipped SDK declares.
 *
 * Why this exists beside the compiler, because they look redundant and are not. `coverage.ts`
 * declares its tables `satisfies Record<HookEvent, …>` and `satisfies Record<MessageDiscriminator,
 * …>`, so an SDK upgrade that adds an event breaks the BUILD. That is the strong half. What it
 * cannot catch is the local mirror drifting: `HOOK_EVENTS` in `state/model.ts` is a hand-written
 * list of the same literals, used for validating causes that arrive off the wire, and nothing in
 * the type system ties it to the SDK. Someone widening THAT instead of the table gets a green
 * compile and a table that no longer covers what it claims.
 *
 * So this reads the union out of the shipped `sdk.d.ts` — the artifact, not a copy of it — and
 * checks both. A document that asserts coverage is precisely the artifact that decays into a lie,
 * and the defence has to be something that fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { HOOK_COVERAGE, MESSAGE_COVERAGE } from '../state/coverage.js';
import { HOOK_EVENTS } from '../state/model.js';

const SDK_TYPES = fileURLToPath(
  new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts', import.meta.url),
);

const types = (): string => readFileSync(SDK_TYPES, 'utf8').replace(/\r\n/g, '\n');

/** The string-literal members of a `export declare type X = 'a' | 'b';` union. */
function unionLiterals(source: string, typeName: string): string[] {
  const declaration = new RegExp(`export declare type ${typeName} = ([^;]+);`).exec(source);
  if (declaration?.[1] === undefined) return [];
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
}

/** The member type NAMES of a `export declare type X = A | B;` union. */
function unionMembers(source: string, typeName: string): string[] {
  const declaration = new RegExp(`export declare type ${typeName} = ([^;]+);`).exec(source);
  if (declaration?.[1] === undefined) return [];
  return declaration[1]
    .split('|')
    .map((member) => member.trim())
    .filter((member) => /^[A-Za-z][\w]*$/.test(member));
}

/** One message shape's `type` and `subtype` literals, in the form the coverage table is keyed by. */
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

// ---------------------------------------------------------------------------
// Guards the SELECTOR before anything trusts what it did not find. A parser that silently matched
// nothing would make every assertion below pass over an empty set, and that green is byte-identical
// to the honest one.
// ---------------------------------------------------------------------------

test('control: the sdk.d.ts parser actually parses sdk.d.ts', () => {
  const source = types();
  assert.ok(source.length > 100_000, `sdk.d.ts looks unread: ${source.length} chars`);

  const events = unionLiterals(source, 'HookEvent');
  assert.ok(events.length >= 20, `HookEvent parsed to ${events.length} literals; the parser is wrong`);
  assert.ok(events.includes('PreToolUse'), 'a known event is missing; the parser is wrong');

  const members = unionMembers(source, 'SDKMessage');
  assert.ok(members.length >= 30, `SDKMessage parsed to ${members.length} members; the parser is wrong`);
  assert.ok(members.includes('SDKSystemMessage'), 'a known member is missing; the parser is wrong');

  assert.deepEqual(
    discriminatorsOf(source, 'SDKSystemMessage'),
    ['system/init'],
    'the discriminator reader is wrong',
  );
  assert.deepEqual(discriminatorsOf(source, 'SDKAssistantMessage'), ['assistant']);

  // And the negative: a name that does not exist must come back empty rather than matching
  // something adjacent, or "every event has a row" could be satisfied by a parser that finds none.
  assert.deepEqual(unionLiterals(source, 'NotARealTypeName'), []);
  assert.deepEqual(discriminatorsOf(source, 'NotARealMessageName'), []);
});

// ---------------------------------------------------------------------------

test('every hook event the SDK declares has a row in the coverage table', () => {
  const declared = unionLiterals(types(), 'HookEvent');
  const missing = declared.filter((event) => !(event in HOOK_COVERAGE));
  assert.deepEqual(missing, [], 'an event absent from the table is a GAP, not a default');
});

test('the coverage table invents no hook event the SDK does not have', () => {
  const declared = new Set(unionLiterals(types(), 'HookEvent'));
  const invented = Object.keys(HOOK_COVERAGE).filter((event) => !declared.has(event));
  assert.deepEqual(invented, [], 'a row for an event that does not exist is coverage of nothing');
});

test("model.ts's HOOK_EVENTS mirror is exactly the SDK's union, the drift the compiler cannot see", () => {
  const declared = unionLiterals(types(), 'HookEvent');
  assert.deepEqual(
    [...HOOK_EVENTS].sort(),
    [...declared].sort(),
    'the runtime mirror and the shipped types disagree',
  );
});

test('every message shape in the SDKMessage union has a coverage row', () => {
  const source = types();
  const members = unionMembers(source, 'SDKMessage');

  const unaccounted: string[] = [];
  for (const member of members) {
    const discriminators = discriminatorsOf(source, member);
    // A member whose discriminators cannot be read is itself a gap — it must not pass silently.
    if (discriminators.length === 0) {
      unaccounted.push(`${member} (no discriminator found)`);
      continue;
    }
    for (const discriminator of discriminators) {
      if (!(discriminator in MESSAGE_COVERAGE)) unaccounted.push(`${member} -> ${discriminator}`);
    }
  }

  assert.deepEqual(unaccounted, [], 'a message that can arrive with no row is an unaudited path');
});

test('every row states a reason, whether it is wired or declined', () => {
  const rows = [...Object.entries(HOOK_COVERAGE), ...Object.entries(MESSAGE_COVERAGE)];
  assert.ok(rows.length >= 60, `the tables look empty: ${rows.length} rows`);

  const silent = rows
    .filter(([, row]) => typeof row.note !== 'string' || row.note.trim().length < 20)
    .map(([key]) => key);
  assert.deepEqual(silent, [], 'a row with no reason makes a decline indistinguishable from an oversight');
});

test('the hooks actually registered are exactly the events the table calls wired', async () => {
  const { observationHooks, wiredHookEvents } = await import('../host/hooks.js');
  const { SessionStateMachine } = await import('../state/machine.js');
  const { SessionObserver } = await import('../state/observer.js');
  const { systemClock, systemTicker } = await import('../core/time.js');

  const machine = new SessionStateMachine({
    where: { cwd: '/tmp', worktree: null, branch: null, unknownReason: 'not inside a git repository' },
    clock: systemClock,
    ticker: systemTicker,
  });
  const registered = Object.keys(observationHooks({ observer: new SessionObserver(machine) }));

  assert.ok(registered.length >= 10, `nothing looks registered: ${registered.length}`);
  assert.deepEqual(
    registered.sort(),
    [...wiredHookEvents()].sort(),
    'the table claims a wiring the registration does not have, or the reverse',
  );
});
