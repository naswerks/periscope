/**
 * What the host's own gate does with Codex's tool calls: its shell commands read in the grammar they run
 * in, its patches' files jailed, its image reads checked against the protected set, and its hook input
 * read into a decision request. Beside each, the control that Claude's calls are read exactly as before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { DecisionRequest } from './decision.js';
import type { GateOutcome } from './outcome.js';
import type { HookInput } from '../host/agent-process.js';
import { createCallDecision } from './call-decision.js';
import { codexHookTurn, readCodexHookRequest } from './codex-request.js';
import { parseCommand, stripPowerShellComments } from './command.js';
import { permissionHooks } from './gate.js';
import { CODEX_TOOL_FAMILIES, localGate, patchInputPaths } from './local.js';
import { patchPaths } from './patch.js';

const WORKSPACE = 'C:/repo';
const CREDENTIALS = 'C:/Users/agent/.codex-home/auth.json';

const fakeResolve = (candidate: string): string => {
  const unified = candidate.replace(/\\/g, '/');
  const rooted = unified.startsWith('/') || /^[A-Za-z]:\//.test(unified) ? unified : `C:/work/${unified}`;
  const drive = /^[A-Za-z]:\//.test(rooted) ? rooted.slice(0, 3) : '/';
  const segments: string[] = [];
  for (const segment of rooted.slice(drive.length).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return drive + segments.join('/');
};

const claudeGate = localGate({
  workspaceRoot: WORKSPACE,
  resolve: fakeResolve,
  protectedPaths: [CREDENTIALS],
});
const codexGate = localGate({
  workspaceRoot: WORKSPACE,
  resolve: fakeResolve,
  protectedPaths: [CREDENTIALS],
  toolFamilies: CODEX_TOOL_FAMILIES,
  readsShellDialect: true,
  resolvesAgainstCallCwd: true,
});

const request = (overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
  toolName: 'Bash',
  toolUseId: 'call_one',
  toolInput: { command: 'git status' },
  sessionId: 'session-one',
  sessionKey: 'handle-one',
  cwd: WORKSPACE,
  agentId: null,
  agentType: null,
  toolKind: 'shell',
  runtime: 'codex',
  ...overrides,
});

const PATCH = (header: string): string =>
  ['*** Begin Patch', header, '@@', '-before', '+after', '*** End Patch'].join('\n');

// ---------------------------------------------------------------------------
// The shell dialect
// ---------------------------------------------------------------------------

const HIDDEN = '<# a note #> git frobnicate';

test('control: the POSIX reading hides a command after a PowerShell block comment', () => {
  // `<` is a separator to the POSIX reading, so `#` opens a comment to the end of the line and the
  // invocation after the block is never seen. This is what the PowerShell reading exists to catch.
  assert.deepEqual(
    parseCommand(HIDDEN).invocations.map((invocation) => invocation.program),
    [],
    'the POSIX reading saw an invocation after the block comment, so this control no longer shows the gap',
  );
  assert.deepEqual(
    parseCommand(HIDDEN, 'powershell').invocations.map((invocation) => invocation.program),
    ['git'],
  );
});

test('a Codex PowerShell command is refused when the PowerShell reading refuses what the POSIX reading cannot see', () => {
  const refused = codexGate(request({ toolInput: { command: HIDDEN }, shellDialect: 'powershell' }));
  assert.equal(refused?.reason, 'shell-verb-unrecognised');
});

test("Claude's local gate reads every command as it always has, whatever dialect the request states", () => {
  // Claude's dialect rides as data: its PowerShell tool keeps the POSIX reading, gap included.
  assert.equal(
    claudeGate(
      request({
        toolName: 'PowerShell',
        toolInput: { command: HIDDEN },
        shellDialect: 'powershell',
        runtime: 'claude',
      }),
    ),
    null,
  );
});

test('a Codex command the POSIX reading refuses is refused under PowerShell too: the union never scans less', () => {
  assert.equal(
    codexGate(request({ toolInput: { command: 'git frobnicate' }, shellDialect: 'powershell' }))?.reason,
    'shell-verb-unrecognised',
  );
});

test('a block-comment opener inside an escaped double-quoted string does not hide the next line', () => {
  const command = ['echo "a`"<#"', 'git frobnicate', 'echo "#>"'].join('\n');
  assert.ok(stripPowerShellComments(command).includes('git frobnicate'));
  assert.equal(
    codexGate(request({ toolInput: { command }, shellDialect: 'powershell' }))?.reason,
    'shell-verb-unrecognised',
  );
});

test('an unterminated block comment is left in place, the reading that scans more', () => {
  assert.equal(stripPowerShellComments('<# open git frobnicate'), '<# open git frobnicate');
});

test('a POSIX-dialect Codex command is read by the POSIX reading alone', () => {
  assert.equal(codexGate(request({ toolInput: { command: HIDDEN }, shellDialect: 'posix' })), null);
});

test('the credential scan reads the raw command under either dialect', () => {
  const command = `Get-Content ${CREDENTIALS}`;
  assert.equal(
    codexGate(request({ toolInput: { command }, shellDialect: 'powershell' }))?.reason,
    'credential-path-denied',
  );
});

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

test('a patch names its files on its header lines, the move target included, and nothing in its hunks', () => {
  const text = [
    '*** Begin Patch',
    '*** Add File: docs/new.md',
    '+*** Delete File: not-a-header.md',
    '*** Update File: src/a.ts',
    '*** Move to: src/b.ts',
    '@@',
    '-x',
    '+y',
    '*** Delete File: old.txt',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(patchPaths(text), ['docs/new.md', 'src/a.ts', 'src/b.ts', 'old.txt']);
});

test('text with no patch header names no file', () => {
  assert.equal(patchPaths('echo hello'), null);
  assert.equal(patchPaths('*** Begin Patch\n*** End Patch'), null);
});

test('a patch delivered inside a shell command still names its files', () => {
  const command = `apply_patch <<'EOF'\n${PATCH('*** Update File: src/a.ts')}\nEOF`;
  assert.deepEqual(patchPaths(command), ['src/a.ts']);
});

test('a patch whose files are inside the workspace has no local objection, relative paths resolved where the call runs', () => {
  assert.equal(
    codexGate(
      request({
        toolName: 'apply_patch',
        toolKind: 'file_edit',
        toolInput: { command: PATCH('*** Update File: src/a.ts') },
      }),
    ),
    null,
  );
});

test('a patch that writes outside the workspace is refused by the jail', () => {
  const refused = codexGate(
    request({
      toolName: 'apply_patch',
      toolKind: 'file_edit',
      toolInput: { command: PATCH('*** Add File: ../outside.txt') },
    }),
  );
  assert.equal(refused?.reason, 'path-escapes-root');
});

test('a move target outside the workspace is refused even when the source is inside', () => {
  const text = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '*** Move to: C:/elsewhere/a.ts',
    '*** End Patch',
  ].join('\n');
  assert.equal(
    codexGate(request({ toolName: 'apply_patch', toolKind: 'file_edit', toolInput: { command: text } }))
      ?.reason,
    'path-escapes-root',
  );
});

test('a patch naming a credential file is refused as credential material', () => {
  assert.equal(
    codexGate(
      request({
        toolName: 'apply_patch',
        toolKind: 'file_edit',
        toolInput: { command: PATCH(`*** Update File: ${CREDENTIALS}`) },
      }),
    )?.reason,
    'credential-path-denied',
  );
});

test('a patch naming no file is refused rather than guessed', () => {
  assert.equal(
    codexGate(
      request({ toolName: 'apply_patch', toolKind: 'file_edit', toolInput: { command: 'not a patch' } }),
    )?.reason,
    'path-input-missing',
  );
});

test('a relative patch path with no absolute working directory to stand on is refused', () => {
  const rootless = localGate({
    workspaceRoot: null,
    resolve: fakeResolve,
    protectedPaths: [],
    toolFamilies: CODEX_TOOL_FAMILIES,
  });
  assert.equal(
    rootless(
      request({
        toolName: 'apply_patch',
        cwd: '',
        toolInput: { command: PATCH('*** Update File: src/a.ts') },
      }),
    )?.reason,
    'path-not-absolute',
  );
});

test("a file change's listed paths are jailed like a patch's headers", () => {
  assert.deepEqual(patchInputPaths({ changes: [{ path: 'C:/repo/a.ts', movePath: 'C:/repo/b.ts' }] }), [
    'C:/repo/a.ts',
    'C:/repo/b.ts',
  ]);
  assert.equal(
    codexGate(request({ toolName: 'apply_patch', toolInput: { changes: [{ path: 'C:/elsewhere/a.ts' }] } }))
      ?.reason,
    'path-escapes-root',
  );
});

// ---------------------------------------------------------------------------
// Image reads
// ---------------------------------------------------------------------------

test("a Codex image read's relative path is checked where the call runs", () => {
  const credentialsRelative = '../Users/agent/.codex-home/auth.json';
  assert.equal(
    codexGate(
      request({
        toolName: 'view_image',
        toolKind: 'file_read',
        cwd: 'C:/repo',
        toolInput: { path: credentialsRelative },
      }),
    )?.reason,
    'credential-path-denied',
  );
  assert.equal(
    codexGate(request({ toolName: 'view_image', toolKind: 'file_read', toolInput: { path: 'shot.png' } })),
    null,
  );
});

// ---------------------------------------------------------------------------
// The hook input
// ---------------------------------------------------------------------------

const EVENT = {
  session_id: 'codex-session',
  turn_id: 'turn-one',
  transcript_path: null,
  cwd: 'C:/repo',
  hook_event_name: 'PreToolUse',
  model: 'gpt-test',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 'call_one',
};
const CONTEXT = { sessionKey: 'handle-one', runtime: 'codex', shellDialect: 'powershell' as const };

test('a Codex hook event reads as a decision request, the shell call carrying its dialect', () => {
  assert.deepEqual(readCodexHookRequest(EVENT, CONTEXT), {
    toolName: 'Bash',
    toolUseId: 'call_one',
    toolInput: { command: 'ls' },
    sessionId: 'codex-session',
    sessionKey: 'handle-one',
    cwd: 'C:/repo',
    agentId: null,
    agentType: null,
    toolKind: 'shell',
    runtime: 'codex',
    shellDialect: 'powershell',
  });
  assert.equal(codexHookTurn(EVENT), 'turn-one');
});

test('a non-shell Codex call carries no dialect, and a sub-agent call carries its agent', () => {
  const read = readCodexHookRequest(
    { ...EVENT, tool_name: 'mcp__nas__list', tool_input: {}, agent_id: 'agent-two', agent_type: 'worker' },
    CONTEXT,
  );
  assert.equal(read?.toolKind, 'mcp');
  assert.equal(read !== null && 'shellDialect' in read, false);
  assert.equal(read?.agentId, 'agent-two');
});

test('anything but a readable PreToolUse call reads as nothing, which the decision refuses', () => {
  for (const event of [
    null,
    'text',
    [],
    { ...EVENT, hook_event_name: 'preToolUse' },
    { ...EVENT, hook_event_name: 'PostToolUse' },
    { ...EVENT, tool_name: '' },
    { ...EVENT, tool_use_id: undefined },
  ]) {
    assert.equal(readCodexHookRequest(event, CONTEXT), null, JSON.stringify(event));
  }
});

// ---------------------------------------------------------------------------
// The per-call decision
// ---------------------------------------------------------------------------

const decision = (
  answer: unknown,
  canRewriteInput?: boolean,
): { outcomes: GateOutcome[]; decide: ReturnType<typeof createCallDecision> } => {
  const outcomes: GateOutcome[] = [];
  return {
    outcomes,
    decide: createCallDecision({
      decide: () => Promise.resolve(answer),
      onOutcome: (outcome) => outcomes.push(outcome),
      sessionKey: 'handle-one',
      runtime: 'codex',
      decisionTimeoutMs: 1_000,
      holdAfterMs: 500,
      ...(canRewriteInput === undefined ? {} : { canRewriteInput }),
    }),
  };
};

test('an allow that rewrites the input is refused where the runtime cannot apply a rewrite, and emitted once', async () => {
  const { outcomes, decide } = decision({ behavior: 'allow', updatedInput: { command: 'ls -a' } }, false);
  const outcome = await decide(request(), new AbortController().signal);
  assert.equal(outcome.kind, 'refused');
  assert.equal(
    outcome.kind === 'refused' ? outcome.refusal.reason : null,
    'permission-decision-unrecognised',
  );
  assert.deepEqual(
    outcomes.map((one) => one.kind),
    ['refused'],
  );
});

test('control: the same rewrite is an allow where the runtime can apply it', async () => {
  const { decide } = decision({ behavior: 'allow', updatedInput: { command: 'ls -a' } });
  const outcome = await decide(request(), new AbortController().signal);
  assert.equal(outcome.kind, 'allow');
});

test('a deny that asks to stop the turn says so on its outcome, and a plain deny does not', async () => {
  const stopping = await decision({ behavior: 'deny', message: 'no', interrupt: true }).decide(
    request(),
    new AbortController().signal,
  );
  assert.equal(stopping.kind === 'deny' ? stopping.interrupt : undefined, true);
  const plain = await decision({ behavior: 'deny', message: 'no' }).decide(
    request(),
    new AbortController().signal,
  );
  assert.equal(plain.kind === 'deny' && 'interrupt' in plain, false);
});

test('an unreadable call is refused, never asked about', async () => {
  let asked = 0;
  const decide = createCallDecision({
    decide: () => {
      asked += 1;
      return Promise.resolve({ behavior: 'allow' });
    },
    onOutcome: () => undefined,
    sessionKey: 'handle-one',
    runtime: 'codex',
    decisionTimeoutMs: 1_000,
    holdAfterMs: 500,
  });
  const outcome = await decide(null, new AbortController().signal);
  assert.equal(outcome.kind, 'refused');
  assert.equal(asked, 0);
});

// ---------------------------------------------------------------------------
// Claude's request carries its dialect as data
// ---------------------------------------------------------------------------

test("Claude's shell calls state their dialect on the request, and every other call states none", async () => {
  const seen: DecisionRequest[] = [];
  const hooks = permissionHooks({
    decide: (asked) => {
      seen.push(asked);
      return Promise.resolve({ behavior: 'allow' });
    },
    onOutcome: () => undefined,
    sessionKey: 'handle-one',
    grantOnAllow: true,
  });
  const handler = hooks.PreToolUse?.[0]?.hooks[0];
  assert.ok(handler !== undefined);
  const call = (tool_name: string, tool_input: Record<string, unknown>): HookInput =>
    ({
      hook_event_name: 'PreToolUse',
      session_id: 'claude-session',
      transcript_path: '',
      cwd: WORKSPACE,
      tool_name,
      tool_input,
      tool_use_id: `toolu_${tool_name}`,
    }) as unknown as HookInput;
  const signal = { signal: new AbortController().signal };
  await handler(call('Bash', { command: 'ls' }), undefined, signal);
  await handler(call('PowerShell', { command: 'Get-ChildItem' }), undefined, signal);
  await handler(call('Read', { file_path: 'C:/repo/a.ts' }), undefined, signal);
  assert.deepEqual(
    seen.map((asked) => [asked.toolName, asked.shellDialect]),
    [
      ['Bash', 'posix'],
      ['PowerShell', 'powershell'],
      ['Read', undefined],
    ],
  );
  assert.equal('shellDialect' in (seen[2] ?? {}), false, 'a non-shell call carries no dialect key at all');
});
