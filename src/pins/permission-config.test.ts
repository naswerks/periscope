/**
 * THE CONFIG PIN: no module in this package sets an option that alters permission outcomes.
 *
 * The gate is `PreToolUse`, and it is only THE permission mechanism while nothing else in the
 * composed options can quietly answer first. Nine lanes can:
 *
 *   permissionMode            'acceptEdits' and 'auto' auto-approve classes of call; 'bypassPermissions'
 *                             skips the remaining checks entirely
 *   settings                  object OR path, and the HIGHEST user precedence — can carry permissions.allow
 *   managedSettings           the same, from policy
 *   toolAliases               redirects a tool name AFTER the model emits it, so a gate matching on
 *                             tool_name sees the alias source while the TARGET executes. Silent
 *   permissionPromptToolName  reroutes prompts to an MCP tool
 *   allowedTools / disallowedTools   pre-answer by name
 *   canUseTool                a second decider, which the SDK then SHADOWS under several configs
 *
 * This is the second of two checks, and the weaker one. The strong check is structural:
 * `AGENT_PROCESS_REQUEST_KEYS` is declared `satisfies Record<keyof AgentProcessRequest, true>`, so
 * making any of the nine composable breaks the build (pinned in `host/agent-process.test.ts`). This
 * scan exists because the two fail for different reasons: a type cannot see a module that reaches
 * past the composer, and a scan cannot see a type. Two mechanisms, one invariant.
 *
 * `permissionMode` is scanned separately. It is the one lane with a legitimate appearance:
 * `readInitFacts` lifts it off `system/init` as part of the per-spawn receipt and `session.ts`
 * carries it on the handle, so `permissionMode: facts.permissionMode` is evidence being recorded,
 * not configuration being set, and no pattern distinguishes that from setting an option without
 * knowing which object it lands in. Rather than widen the pattern until it stops firing (which
 * would quietly stop covering the other eight), the word gets its own assertion: it may appear only
 * in the modules that carry it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sourceFiles } from './walk.js';
import { SHADOWING_LANES } from '../host/agent-process.js';

/**
 * The eight that have no legitimate appearance anywhere in this package.
 *
 * Derived from the compile pin's list rather than written twice: a hand-copied list once named an
 * option the SDK does not have (`permissionPrompt`) while missing one it does (`permissions`, a
 * real `Options` member carrying `allow`/`deny` rules), so the scan half had a hole exactly where a
 * real option lives. The agreement test below keeps the two sets identical.
 */
const SHADOWING_OPTIONS = SHADOWING_LANES.filter((lane) => lane !== 'permissionMode');

/**
 * `key: value`, `key = value` or `obj.key = value`: an option being set, not a word mentioned.
 *
 * The `.` in the leading class matters: without it the pattern matches `allowedTools: x` and misses
 * `options.allowedTools = x`, the same shadowing spelled the way anyone mutating an already-built
 * object would spell it. The control below asserts the predicate against real offenders.
 *
 * The class excludes a backtick, so naming these options in a doc comment (as the comment above
 * does) is not a violation. Prose explains the rule; only code can break it.
 */
const SETS = new RegExp(String.raw`(?:^|[\s{,(.])(${SHADOWING_OPTIONS.join('|')})\s*[:=][^:=]`);

/**
 * `permissionMode` is composable, for CLI parity: a session here exposes what `claude` exposes,
 * with bypass as the default. The gate never depended on the mode. Its authority is the
 * `PreToolUse` hook, which the SDK fires under every mode, so opening the lane moves no permission
 * decision out of this host. What this pin holds: the mode reaches the SDK through exactly these
 * modules (the wire types, the codec, the narrowing reader, which refuses an unknown mode by name,
 * the process that hands it to `query()`/`setPermissionMode`, the session handle, the registry and
 * the host's dispatch) and never from a settings file or a rule list (those eight lanes stay
 * closed, above).
 */
const MODE_MODULES = [
  'control/codec.ts',
  'control/frames.ts',
  'host/agent-process.ts',
  // composeSession reads the requested mode for the one exception to `permission-grant-shadows-settings`
  // (bypass) through `isBypassMode`; it never names a mode.
  'host/host.ts',
  'host/wire-request.ts',
  'sessions/registry.ts',
  'sessions/session.ts',
];

test('regression: nothing in this package sets an option that could answer a permission before the gate does', () => {
  const violations: string[] = [];
  for (const file of sourceFiles()) {
    file.text.split('\n').forEach((line, index) => {
      const hit = SETS.exec(line);
      if (hit !== null) violations.push(`${file.path}:${index + 1} sets "${hit[1]}"`);
    });
  }

  assert.deepEqual(
    violations,
    [],
    `an option that shadows the gate is being set:\n  ${violations.join('\n  ')}`,
  );
});

test('regression: permissionMode travels only through the wire, reader and process path, never a settings file or a rule list', () => {
  const mentions = sourceFiles()
    .filter((file) => /\bpermissionMode\b/.test(file.text))
    .map((file) => file.path)
    .sort();

  assert.deepEqual(
    mentions,
    MODE_MODULES.slice().sort(),
    'permissionMode appears outside the modules that carry it from the wire to the SDK — a new carrier ' +
      'is a new place a mode can be chosen, and it must be named here with its reason',
  );

  // The vocabulary is named in ONE place — the reader that refuses an unknown mode — and in the wire
  // type's documentation. Nowhere else does code choose a mode by name.
  const choosers = sourceFiles()
    .filter((file) => !['host/wire-request.ts', 'control/frames.ts'].includes(file.path))
    .filter((file) =>
      ["'bypassPermissions'", "'acceptEdits'", "'dontAsk'"].some((mode) => file.text.includes(mode)),
    )
    .map((file) => file.path);
  assert.deepEqual(choosers, [], `a module names a permission mode as a value: ${choosers.join(', ')}`);
});

test('the three mid-session permission mutators are never called; setPermissionMode is called in ONE place, by the wire', () => {
  // These act after any construction-time check, so no inspection of the composed options could
  // catch them. They are unreachable by construction (the handle wraps the query object rather
  // than handing it out) and this asserts the absence directly rather than trusting that.
  // `setPermissionMode` is not on the list: it is the `session_configure` frame's own path and may
  // be called from exactly one module.
  const mutators = ['applyFlagSettings', 'setMcpServers', 'setMcpPermissionModeOverride'];
  const modeSetters = sourceFiles()
    .filter((file) => file.text.includes('running.setPermissionMode('))
    .map((file) => file.path);
  assert.deepEqual(
    modeSetters,
    ['host/agent-process.ts'],
    'setPermissionMode reaches the SDK from one module only',
  );
  const violations: string[] = [];

  for (const file of sourceFiles()) {
    file.text.split('\n').forEach((line, index) => {
      for (const mutator of mutators) {
        if (line.includes(`${mutator}(`)) violations.push(`${file.path}:${index + 1} calls ${mutator}`);
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `a mid-session permission mutator is called:\n  ${violations.join('\n  ')}`,
  );
});

/**
 * Every lane name is a real `Options` member, checked against the shipped types, not remembered.
 * A lane named `permissionPrompt` appears zero times in `sdk.d.ts`; a mechanism watching for a
 * spelling that can never occur guards nothing. The types win.
 */
test('regression: every shadowing lane this package guards is a name the SDK actually declares', () => {
  const types = readFileSync(
    fileURLToPath(new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts', import.meta.url)),
    'utf8',
  );

  // Positive control first: prove the file loaded and the search can find a member before trusting
  // it to report that one is missing. A read that silently returned '' would pass every check below.
  assert.ok(types.length > 100_000, `sdk.d.ts looks unread: ${types.length} chars`);
  assert.match(types, /\bpermissionMode\?:/, 'the search cannot find a member it is known to have');
  assert.doesNotMatch(types, /\bpermissionPrompt\?:/, 'the name this pin used to carry is still absent');

  const missing = SHADOWING_LANES.filter((lane) => !new RegExp(`\\b${lane}\\?:`).test(types));
  assert.deepEqual(
    missing,
    [],
    `named as an Options lane but absent from the shipped types: ${missing.join(', ')}`,
  );
});

test('the scan pin and the compile pin guard the SAME set, minus the one with a legitimate use', () => {
  assert.deepEqual(
    [...SHADOWING_OPTIONS].sort(),
    SHADOWING_LANES.filter((lane) => lane !== 'permissionMode')
      .slice()
      .sort(),
  );
  // `permissionMode` is composable (CLI parity), so the scan set and the compile set are the same
  // eight names with nothing left to subtract.
  assert.equal(SHADOWING_LANES.length, 8, 'the eight lanes are eight');
  assert.equal(
    SHADOWING_OPTIONS.length,
    8,
    'the scan set is the eight; permissionMode is not among them to subtract',
  );
});

// Guards the selector, not the rule. A zero-violation result over an empty scan set, or against a
// pattern that matches nothing, is byte-identical to the honest green.
test('control: the shadowing-option pattern actually matches a shadowing option', () => {
  for (const offender of [
    '  options.allowedTools = tools;',
    "  return { settings: '/etc/claude/settings.json' };",
    '  toolAliases: { Bash: "mcp__workspace__bash" },',
    '  canUseTool: async () => ({ behavior: "allow" }),',
    '  managedSettings: policy,',
    '  permissionPromptToolName: "mcp__ui__ask",',
    '  disallowedTools: [],',
  ]) {
    assert.match(offender, SETS, `the pattern missed: ${offender}`);
  }

  for (const legitimate of [
    ' * `settings`, `managedSettings`, `toolAliases`: named in prose, which explains the rule',
    '  settingSources: [...request.settingSources],',
    '  const allowed = readSettings(path);',
  ]) {
    assert.doesNotMatch(legitimate, SETS, `the pattern fired on a legitimate line: ${legitimate}`);
  }

  assert.ok(sourceFiles().length >= 15, 'the pin is not scanning a populated source tree');
  assert.ok(
    sourceFiles().some((file) => file.path === 'gate/gate.ts'),
    'the selector cannot see the gate itself; this pin would pass vacuously',
  );
});
