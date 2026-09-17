/**
 * The generic pin: the host registers descriptors it does not understand.
 *
 * This is a property of shape rather than of a run. "A tool is callable" is proven by calling one;
 * "the registration path contains no tool-specific branch" is not: a host with
 * `if (name === 'roster')` in it would pass every callability test ever written, because the tool
 * it special-cases still works.
 *
 * So the pin is a permutation: register a descriptor set, then register the same set with every
 * name replaced by a different string, and require the two results to be identical in everything
 * except the names. A branch on any name makes the two diverge. Deleting the branch makes them
 * agree again.
 *
 * The names chosen are the ones most likely to tempt a special case. A roster (who is working, on
 * what, across every host) is cross-host and therefore the controller's, and this package carries
 * it with no host-side accommodation. If a roster ever needed a branch in here, that would be a
 * defect in the descriptor mechanism rather than a licence to add one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { planTools } from '../mcp/server.js';
import type { McpServerOptions, ToolCall } from '../mcp/server.js';
import type { ToolDescriptor } from '../mcp/descriptor.js';
import { sourceFiles } from './walk.js';

/** Three shapes covering the interesting conversions: required, optional, nested, enum, array. */
const SCHEMAS: ToolDescriptor['inputSchema'][] = [
  {
    type: 'object',
    properties: { note: { type: 'string' }, count: { type: 'integer' } },
    required: ['note'],
  },
  {
    type: 'object',
    properties: { mode: { enum: ['a', 'b'] }, tags: { type: 'array', items: { type: 'string' } } },
  },
  { type: 'object' },
];

function descriptors(names: readonly string[]): ToolDescriptor[] {
  return names.map((name, index) => ({
    name,
    description: `Tool number ${index}.`,
    inputSchema: SCHEMAS[index % SCHEMAS.length] as ToolDescriptor['inputSchema'],
  }));
}

/** Records every call the invoker sees, so a handler's BEHAVIOUR is observable, not just its type. */
function options(names: readonly string[], seen: Omit<ToolCall, 'toolName'>[] = []): McpServerOptions {
  return {
    name: 'controller',
    descriptors: descriptors(names),
    invoke: async (call) => {
      const { toolName: _ignored, ...rest } = call;
      seen.push(rest);
      return { text: 'ok' };
    },
    identity: () => ({ sessionId: 'S' }),
  };
}

/**
 * Everything about a built tool set EXCEPT the names — the part that must be invariant.
 *
 * The converted schema is reduced to its key set and each member's constructor, which distinguishes
 * `z.string()` from `z.number().int()` from an optional wrapper. That catches a special case which
 * built a different schema, marked a property required, or skipped a tool.
 *
 * It runs each handler. Recording only that the handler is a function would let a branch which
 * kept the name, description and schema identical while swapping the handler go straight through
 * the permutation. Running the handler and recording what the invoker received makes behaviour part
 * of the comparison rather than a type assertion standing in for it.
 */
async function fingerprint(
  built: ReturnType<typeof planTools>,
  seen: Omit<ToolCall, 'toolName'>[],
): Promise<unknown> {
  assert.equal(built.ok, true, built.ok ? '' : built.refusal.detail);
  if (!built.ok) return null;

  const results: unknown[] = [];
  for (const entry of built.value) {
    const before = seen.length;
    const output = await entry.handler({ note: 'probe', count: 1, mode: 'a', tags: ['t'] });
    results.push({
      description: entry.description,
      schema: Object.entries(entry.shape).map(([key, value]) => [key, value.constructor.name]),
      // What the handler DID: what it forwarded, and what it returned.
      forwarded: seen.slice(before),
      output,
    });
  }
  return results;
}

/** Plan a set and fingerprint it, with a fresh recorder each time. */
async function planAndFingerprint(names: readonly string[]): Promise<unknown> {
  const seen: Omit<ToolCall, 'toolName'>[] = [];
  return fingerprint(planTools(options(names, seen)), seen);
}

// The pin. Three registrations, permuted names, identical everything else: schema, description,
// what each handler forwards, and what each returns.
test('regression: registering under different names produces a structurally identical result', async () => {
  const ordinary = await planAndFingerprint(['alpha', 'beta', 'gamma']);
  const tempting = await planAndFingerprint(['roster', 'post_note', 'escalate']);
  const nonsense = await planAndFingerprint(['zzqx', 'wubble', 'a1']);

  assert.deepEqual(
    tempting,
    ordinary,
    'a tool name changed the result — the registration path branches on what a tool is called',
  );
  assert.deepEqual(nonsense, ordinary, 'an arbitrary name changed the result — the mechanism is not generic');
});

test('regression: the names themselves do come through, so the permutation is not comparing two empty sets', () => {
  const built = planTools(options(['roster', 'post_note', 'escalate']));

  assert.equal(built.ok, true);
  assert.deepEqual(built.ok ? built.value.map((entry) => entry.name) : null, [
    'roster',
    'post_note',
    'escalate',
  ]);
  assert.equal(
    built.ok && built.value.length,
    3,
    'a tool was dropped — the fingerprint would still have matched',
  );
});

// A roster is cross-host and therefore the controller's. This asserts the mechanism carries one with
// no accommodation here.
test('regression: a roster-shaped descriptor registers through the ordinary path, with no host-side case', async () => {
  const roster: ToolDescriptor = {
    name: 'roster',
    description: 'Reports who is working, on what, and what each is waiting for.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { enum: ['all', 'blocked'], description: 'Which entries to report.' },
        since: { type: 'string', description: 'ISO timestamp.' },
      },
      required: ['scope'],
    },
  };

  const rosterSeen: Omit<ToolCall, 'toolName'>[] = [];
  const otherSeen: Omit<ToolCall, 'toolName'>[] = [];
  const asRoster = planTools({ ...options(['x'], rosterSeen), descriptors: [roster] });
  const asAnything = planTools({
    ...options(['x'], otherSeen),
    descriptors: [{ ...roster, name: 'wobble' }],
  });

  assert.equal(asRoster.ok, true, asRoster.ok ? '' : asRoster.refusal.detail);
  assert.deepEqual(
    await fingerprint(asAnything, otherSeen),
    await fingerprint(asRoster, rosterSeen),
    'the roster took a different path from any other tool',
  );
});

test('a tool that fails to convert fails the same way whatever it is called', () => {
  const bad = (name: string): ReturnType<typeof planTools> =>
    planTools({
      ...options(['x']),
      descriptors: [
        {
          name,
          description: 'Broken.',
          inputSchema: { type: 'object', properties: { v: { type: 'nope' } } },
        },
      ],
    });

  const asRoster = bad('roster');
  const asOther = bad('qqq');

  assert.equal(asRoster.ok, false);
  assert.equal(asOther.ok, false);
  assert.equal(
    !asRoster.ok && !asOther.ok && asRoster.refusal.reason,
    !asOther.ok ? asOther.refusal.reason : '',
    'a refusal differs by tool name — some tool is being treated specially even when it fails',
  );
});

// The second, weaker half. It fails for a different reason from the permutation — a scan cannot see
// a branch on a value it was not told to look for, and a permutation cannot see a name mentioned in
// a comment that a later edit turns into code.
const TEMPTING = ['roster', 'post_note', 'post_plan', 'escalate', 'check_in', 'notice_board'];

/**
 * Whole words only. A substring match fires on prose ("checking" contains "checkin"), and a scan
 * that cries wolf gets its list trimmed until it stops, which is how it ends up matching nothing.
 */
const NAMES_A_TOOL = new RegExp(String.raw`\b(${TEMPTING.join('|')})\b`);

test('no module under src/mcp/ names a specific tool', () => {
  const violations: string[] = [];

  for (const file of sourceFiles()) {
    if (!file.path.startsWith('mcp/')) continue;
    file.text.split('\n').forEach((line, index) => {
      const hit = NAMES_A_TOOL.exec(line);
      if (hit !== null) violations.push(`${file.path}:${index + 1} names "${hit[1]}"`);
    });
  }

  assert.deepEqual(
    violations,
    [],
    `a tool name appears in the registration path:\n  ${violations.join('\n  ')}`,
  );
});

// Guards this selector: a pattern that matched nothing would make the scan above pass over any
// source at all, which is the same green as the honest one.
test('control: the tool-name pattern matches a tool name and not the prose around it', () => {
  assert.match('  if (name === "roster") return special;', NAMES_A_TOOL);
  assert.match("  const t = 'post_note';", NAMES_A_TOOL);
  assert.doesNotMatch(
    '   * where the checking was supposed to be',
    NAMES_A_TOOL,
    'must not fire on "checking"',
  );
  assert.doesNotMatch('  const escalated = false;', NAMES_A_TOOL, 'must not fire on "escalated"');
  assert.doesNotMatch('  return plans;', NAMES_A_TOOL);
});

// Guards the selector. A scan over an empty set, or a fingerprint that captured nothing, is
// byte-identical to the honest green.
test('control: the generic pin is scanning a real directory and comparing a real fingerprint', async () => {
  const mcpFiles = sourceFiles().filter((file) => file.path.startsWith('mcp/'));
  assert.ok(
    mcpFiles.length >= 3,
    `the scan set is empty or tiny: ${mcpFiles.map((file) => file.path).join(', ')}`,
  );
  assert.ok(
    mcpFiles.some((file) => file.path === 'mcp/server.ts'),
    'the scan cannot see the registration path itself — this pin would pass vacuously',
  );

  // The fingerprint must DISTINGUISH things. If it collapsed everything to a constant, the
  // permutation test above would pass against a host riddled with special cases.
  const oneTool = await planAndFingerprint(['a']);
  const threeTools = await planAndFingerprint(['a', 'b', 'c']);
  assert.notDeepEqual(oneTool, threeTools, 'the fingerprint does not distinguish different tool sets');

  const schemaSeen: Omit<ToolCall, 'toolName'>[] = [];
  const differentSchema = await fingerprint(
    planTools({
      ...options(['a'], schemaSeen),
      descriptors: [
        {
          name: 'a',
          description: 'Tool number 0.',
          inputSchema: { type: 'object', properties: { note: { type: 'integer' } }, required: ['note'] },
        },
      ],
    }),
    schemaSeen,
  );
  assert.notDeepEqual(
    differentSchema,
    oneTool,
    'the fingerprint does not distinguish different converted schemas',
  );

  // And it must distinguish behaviour. Two plans identical in name, description and schema but
  // differing in what the handler forwards must still compare unequal, otherwise a branch that only
  // changed a handler would pass the pin.
  const quietSeen: Omit<ToolCall, 'toolName'>[] = [];
  const quiet = await fingerprint(
    planTools({ ...options(['a'], quietSeen), invoke: async () => ({ text: 'different answer' }) }),
    quietSeen,
  );
  assert.notDeepEqual(quiet, oneTool, 'the fingerprint does not distinguish what a handler actually does');
});
