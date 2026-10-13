/**
 * The hook's two outputs, and why it never writes any other.
 *
 * Codex lets a call proceed whenever its hook's output is anything but an empty stdout or a deny with a
 * non-empty reason: a bare allow, `ask`, `continue: false`, a stop reason, plain text, JSON it cannot
 * read, an unknown key, a non-zero exit, a timeout, a command that will not start. The table below
 * states, row by row, what Codex does with each shape (paraphrased from its output parser, never run
 * here), and the property after it shows every answer the host can give reaches Codex as one of the two
 * shapes it honours.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { HOOK_TIMEOUT_EVENT } from '../state/model.js';
import { DEFAULT_DECISION_TIMEOUT_MS } from './gate.js';
import {
  CODEX_HOOK_TIMEOUT_SECONDS,
  HOOK_DEADLINE_MARGIN_MS,
  HOOK_EXPIRY_EVENT,
  MAX_HOOK_DEADLINE_MS,
  MAX_HOOK_REASON_LENGTH,
  hookAnswerLine,
  hookAnswerMac,
  hookDeadlineMs,
  hookDenyOutput,
  hookOutputFor,
  readHookAnswer,
  sameToken,
} from './hook-exchange.js';

type CodexReading = 'proceeds' | 'blocked' | 'failed, proceeds';

/**
 * What Codex does with one hook result, by the rules of its `PreToolUse` output parser at the pinned
 * release, in this package's words. Only `blocked` stops the call.
 */
function codexReads(stdout: string, exitCode: number | null, stderr = ''): CodexReading {
  if (exitCode === null) return 'failed, proceeds';
  if (exitCode === 2) return stderr.trim() === '' ? 'failed, proceeds' : 'blocked';
  if (exitCode !== 0) return 'failed, proceeds';
  const trimmed = stdout.trim();
  if (trimmed === '') return 'proceeds';
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 'proceeds';
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return 'failed, proceeds';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'failed, proceeds';
  const top = parsed as Record<string, unknown>;
  const allowedTop = [
    'continue',
    'stopReason',
    'suppressOutput',
    'systemMessage',
    'decision',
    'reason',
    'hookSpecificOutput',
  ];
  if (Object.keys(top).some((key) => !allowedTop.includes(key))) return 'failed, proceeds';
  if (top['continue'] === false || top['stopReason'] !== undefined || top['suppressOutput'] === true) {
    return 'failed, proceeds';
  }
  const specific = top['hookSpecificOutput'];
  if (specific !== undefined) {
    if (typeof specific !== 'object' || specific === null) return 'failed, proceeds';
    const fields = specific as Record<string, unknown>;
    const allowedSpecific = [
      'hookEventName',
      'permissionDecision',
      'permissionDecisionReason',
      'updatedInput',
      'additionalContext',
    ];
    if (Object.keys(fields).some((key) => !allowedSpecific.includes(key))) return 'failed, proceeds';
    if (typeof fields['hookEventName'] !== 'string') return 'failed, proceeds';
    const decision = fields['permissionDecision'];
    const reason = fields['permissionDecisionReason'];
    if (decision === 'deny') {
      return typeof reason === 'string' && reason.trim() !== '' ? 'blocked' : 'failed, proceeds';
    }
    if (decision === 'allow') return fields['updatedInput'] === undefined ? 'failed, proceeds' : 'proceeds';
    if (decision !== undefined) return 'failed, proceeds';
    if (reason !== undefined || fields['updatedInput'] !== undefined) return 'failed, proceeds';
    return 'proceeds';
  }
  if (top['decision'] === 'block') {
    return typeof top['reason'] === 'string' && top['reason'].trim() !== '' ? 'blocked' : 'failed, proceeds';
  }
  if (top['decision'] !== undefined || top['reason'] !== undefined) return 'failed, proceeds';
  return 'proceeds';
}

const DENY = (reason: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });

test('the table of what Codex does with each hook result: only an empty output and a reasoned deny are safe', () => {
  const rows: readonly (readonly [string, string, number | null, string, CodexReading])[] = [
    ['an empty stdout', '', 0, '', 'proceeds'],
    ['a deny with a reason', DENY('no'), 0, '', 'blocked'],
    ['a deny with an empty reason', DENY(''), 0, '', 'failed, proceeds'],
    [
      'a deny with no reason',
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }),
      0,
      '',
      'failed, proceeds',
    ],
    [
      'ask',
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'x',
        },
      }),
      0,
      '',
      'failed, proceeds',
    ],
    [
      'a bare allow',
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }),
      0,
      '',
      'failed, proceeds',
    ],
    ['continue false', JSON.stringify({ continue: false }), 0, '', 'failed, proceeds'],
    ['a stop reason', JSON.stringify({ stopReason: 'stop' }), 0, '', 'failed, proceeds'],
    ['plain text', 'denied', 0, '', 'proceeds'],
    ['JSON-looking garbage', '{"hookSpecificOutput":', 0, '', 'failed, proceeds'],
    [
      'an unknown key',
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'no',
          extra: 1,
        },
      }),
      0,
      '',
      'failed, proceeds',
    ],
    ['exit 2 with an empty stderr', '', 2, '', 'failed, proceeds'],
    ['exit 2 with a reason on stderr', '', 2, 'no', 'blocked'],
    ['another exit code', DENY('no'), 1, '', 'failed, proceeds'],
    ['a timeout or a spawn error (no exit code)', '', null, '', 'failed, proceeds'],
  ];
  for (const [shape, stdout, exitCode, stderr, expected] of rows) {
    assert.equal(codexReads(stdout, exitCode, stderr), expected, shape);
  }
});

const ANSWERS: readonly unknown[] = [
  { allow: true },
  { allow: true, updatedInput: { command: 'ls -a' } },
  { allow: false, reason: 'the operator said no' },
  { allow: false, reason: '' },
  { allow: false, reason: '   ' },
  { allow: false },
  { allow: 'yes' },
  { ok: true, version: '1.7.0' },
  null,
  'allow',
  42,
  [],
  { allow: false, reason: 'x'.repeat(MAX_HOOK_REASON_LENGTH * 2) },
  { allow: false, reason: 'non-ASCII — reason \u{1F600}' },
];

test('every answer the host can give reaches Codex as an empty output or a reasoned deny, and nothing else', () => {
  for (const answer of ANSWERS) {
    const output = hookOutputFor(answer);
    const reading = codexReads(output, 0);
    const allowsAsAsked =
      typeof answer === 'object' &&
      answer !== null &&
      (answer as { allow?: unknown }).allow === true &&
      (answer as { updatedInput?: unknown }).updatedInput === undefined;
    if (allowsAsAsked)
      assert.equal(output, '', `${JSON.stringify(answer)} must proceed with nothing written`);
    else
      assert.equal(
        reading,
        'blocked',
        `${JSON.stringify(answer)} must reach Codex as a block, read ${reading}`,
      );
    assert.notEqual(
      reading,
      'failed, proceeds',
      `${JSON.stringify(answer)} produced a shape Codex refuses and proceeds on`,
    );
  }
});

test('the deny is exactly the three keys Codex declares, ASCII only, its reason never empty and bounded', () => {
  for (const reason of ['', 'a — b', 'y'.repeat(MAX_HOOK_REASON_LENGTH + 10)]) {
    const output = hookDenyOutput(reason);
    assert.ok(/^[\x20-\x7e]*$/.test(output), `non-ASCII byte in ${output.slice(0, 80)}`);
    const parsed = JSON.parse(output) as { hookSpecificOutput: Record<string, unknown> };
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(parsed.hookSpecificOutput), [
      'hookEventName',
      'permissionDecision',
      'permissionDecisionReason',
    ]);
    const stated = parsed.hookSpecificOutput['permissionDecisionReason'] as string;
    assert.ok(stated.trim() !== '');
    assert.ok(stated.length <= MAX_HOOK_REASON_LENGTH + '...[truncated]'.length);
  }
  assert.equal(
    (JSON.parse(hookDenyOutput('a — b')) as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason,
    'a — b',
  );
});

test('an answer is believed only when its HMAC verifies for this token and this nonce', () => {
  const line = hookAnswerLine('token-one', 'nonce-one', { allow: true });
  assert.deepEqual(readHookAnswer(line, 'token-one', 'nonce-one'), { allow: true });
  assert.equal(readHookAnswer(line, 'token-two', 'nonce-one'), null, 'another token verified it');
  assert.equal(readHookAnswer(line, 'token-one', 'nonce-two'), null, 'a replay for another call verified');
  const forged = JSON.stringify({ v: 1, body: JSON.stringify({ allow: true }), mac: 'ab'.repeat(32) });
  assert.equal(readHookAnswer(forged, 'token-one', 'nonce-one'), null, 'a forged mac verified');
  const tampered = JSON.stringify({
    v: 1,
    body: JSON.stringify({ allow: true }),
    mac: hookAnswerMac('token-one', 'nonce-one', JSON.stringify({ allow: false, reason: 'no' })),
  });
  assert.equal(readHookAnswer(tampered, 'token-one', 'nonce-one'), null, 'a mac for another body verified');
  assert.equal(readHookAnswer('not json', 'token-one', 'nonce-one'), null);
  assert.equal(sameToken('abc', 'abc'), true);
  assert.equal(sameToken('abc', 'abcd'), false);
});

test("the deadline order: the host's decision, then the hook's own, then Codex's timeout, each a margin apart", () => {
  assert.ok(DEFAULT_DECISION_TIMEOUT_MS + HOOK_DEADLINE_MARGIN_MS < MAX_HOOK_DEADLINE_MS);
  assert.ok(MAX_HOOK_DEADLINE_MS < CODEX_HOOK_TIMEOUT_SECONDS * 1000);
  assert.equal(hookDeadlineMs(String(DEFAULT_DECISION_TIMEOUT_MS + HOOK_DEADLINE_MARGIN_MS)), 55_000);
  assert.equal(hookDeadlineMs(undefined), MAX_HOOK_DEADLINE_MS, 'no stated deadline waits the most it may');
  assert.equal(
    hookDeadlineMs('9999999'),
    MAX_HOOK_DEADLINE_MS,
    "a stated deadline past Codex's timeout is held inside it",
  );
  assert.equal(hookDeadlineMs('-5'), MAX_HOOK_DEADLINE_MS);
  assert.equal(hookDeadlineMs('soon'), MAX_HOOK_DEADLINE_MS);
});

test("the hook's expiry is named by the word the session's trace names it by", () => {
  assert.equal(HOOK_EXPIRY_EVENT, HOOK_TIMEOUT_EVENT);
});
