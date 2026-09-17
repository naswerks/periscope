/**
 * The help text's precedence claim, asserted against the wiring that makes it true.
 *
 * USAGE says "Configuration is read from the environment first, then the config file", with no
 * qualifier. That sentence is false for any verb `main()` hands the raw environment while only
 * `serve` sees the merged one, and the falsehood is invisible to every behavioural test: `runPair`
 * and `runLogin` take env as a parameter (so their own suites exercise a merge the binary may never
 * perform), and `login` reads no config key at all (so no spawn can observe its call site either
 * way). A source pin is the only instrument that can hold all three call sites to the sentence at
 * once.
 *
 * The `config` exclusion is the other half of the rule. `runConfig` must see raw env: its
 * "currently overridden by the environment" marker exists to distinguish env from file (a merged
 * view would mark every file value as overridden by itself), and the verb is the escape hatch that
 * makes fatal-on-corrupt safe everywhere else. A refactor that merges everywhere is as wrong as one
 * that merges nowhere, so both directions are pinned.
 *
 * In `bin/main.ts` the raw environment is the parameter named `raw` and the merged view is the
 * local named `env`; the patterns below key on those names, and the parameter name is itself
 * pinned so a rename cannot make the raw patterns match nothing. A verb is called either by name
 * (`runLogin(`) or in its injected-or-default form (`(io.runLogin ?? runLogin)(`), so an optional
 * `)` may sit between the verb name and its arguments.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { USAGE } from '../bin/command.js';
import { sourceFiles } from './walk.js';

const COMPOSITION_ROOT = 'bin/main.ts';

/** The raw environment reaching a verb: the process's own, or `main`'s `raw` parameter. */
const RAW_LOGIN = /runLogin\)?\((?:process\.env|raw\b)/;
const RAW_PAIR = /runPair\)?\([^)]*(?:process\.env|\braw\b)/;

/** `main`'s signature, with the environment parameter named `raw`. */
const MAIN_SIGNATURE = /export function main\(\s*argv: readonly string\[\],\s*raw: NodeJS\.ProcessEnv\b/;

function compositionRootText(): string {
  const file = sourceFiles().find((candidate) => candidate.path === COMPOSITION_ROOT);
  assert.ok(file !== undefined, `${COMPOSITION_ROOT} must exist: the wiring under this pin lives there`);
  return file.text;
}

test('regression: USAGE claims env-first-then-file unconditionally, the sentence this pin holds the wiring to', () => {
  assert.match(
    USAGE,
    /Configuration is read from the environment first, then the config file \(the environment wins\)/,
    'if this sentence is being reworded or scoped, this pin must move with it: the claim and the ' +
      'wiring below are one truth and ship together',
  );
});

test('regression: no configuration-consuming verb is wired to the raw environment', () => {
  const text = compositionRootText();

  assert.match(
    text,
    MAIN_SIGNATURE,
    'main must take the raw environment as a parameter named `raw`: the patterns below key on it',
  );

  assert.doesNotMatch(
    text,
    RAW_LOGIN,
    'login must receive the merged view: a raw-env call site makes USAGE overclaim, and login has no ' +
      'behavioural observable to catch it',
  );
  assert.doesNotMatch(
    text,
    RAW_PAIR,
    'pair must receive the merged view: PERISCOPE_DECISION_URL is a legal config key and is what ' +
      'redemptionUrl derives the door from',
  );
  assert.doesNotMatch(
    text,
    /process\.env/,
    "the composition root reads the environment it is handed, never the process's",
  );

  const mergeCalls = text.match(/environmentWithConfigFile\(raw\)/g) ?? [];
  assert.ok(
    mergeCalls.length >= 4,
    `expected the merge to be consumed by all four verbs (serve, login, pair, status), found ${mergeCalls.length} call(s)`,
  );
});

test('the config verb stays on raw env: the deliberate exclusion, pinned from the other direction', () => {
  assert.match(
    compositionRootText(),
    /runConfig\)?\(command\.key, command\.value, raw, command\.unset\)/,
    'runConfig must see raw env: the overridden-by-environment marker and the corrupt-file escape ' +
      'hatch both depend on it',
  );
});

test('serve receives both views, and the raw one is the process environment as handed to main', () => {
  // The daemon reads credentials and the session environment from the raw view and configuration
  // from the merged one; `bin/serve.ts` says which reads which. What this holds is that the split
  // is made at the call site rather than by serve re-reading the process.
  assert.match(
    compositionRootText(),
    /runStatus\)?\(\{\s*raw,\s*merged: environmentWithConfigFile\(raw\)\s*\}\)/,
    'status must see both views like serve: the raw environment for the file marks, the merged one for the values',
  );
  assert.match(
    compositionRootText(),
    /serve\(\{\s*raw,\s*merged: environmentWithConfigFile\(raw\)\s*\}\)/,
    'serve must be handed { raw, merged } with the merge derived from the same raw view',
  );
});

// Guards the selector, not the rule. A `doesNotMatch` over a pattern that matches nothing, or over
// a file that no longer contains the call sites, passes for the wrong reason.
test('control: the raw-env patterns fire on planted offending call sites, and the call sites exist', () => {
  assert.match('    void runLogin(process.env).then(', RAW_LOGIN, 'the login pattern missed a raw-env call');
  assert.match('    void runLogin(raw).then(', RAW_LOGIN, 'the login pattern missed a raw-parameter call');
  assert.match(
    '    return (io.runLogin ?? runLogin)(raw).then(',
    RAW_LOGIN,
    'the login pattern missed the injected-or-default form',
  );
  assert.match(
    '    void runPair(command.code, process.env).then(',
    RAW_PAIR,
    'the pair pattern missed a raw-env call',
  );
  assert.match(
    '    runPair(code, { ...process.env })',
    RAW_PAIR,
    'the pair pattern missed a spread of raw env',
  );
  assert.match(
    '    void runPair(command.code, raw).then(',
    RAW_PAIR,
    'the pair pattern missed a raw-parameter call',
  );
  assert.match(
    '    return (io.runPair ?? runPair)(command.code, raw).then(',
    RAW_PAIR,
    'the pair pattern missed the injected-or-default form',
  );
  assert.match(
    '    runPair(code, { ...raw })',
    RAW_PAIR,
    'the pair pattern missed a spread of the raw parameter',
  );

  assert.doesNotMatch('    void runLogin(env).then(', RAW_LOGIN);
  assert.doesNotMatch('    return (io.runLogin ?? runLogin)(env).then(', RAW_LOGIN);
  assert.doesNotMatch('    void runPair(command.code, env).then(', RAW_PAIR);
  assert.doesNotMatch('    return (io.runPair ?? runPair)(command.code, env).then(', RAW_PAIR);
  assert.doesNotMatch(
    '    void runPair(command.code, rawEnv).then(',
    RAW_PAIR,
    'a longer identifier is not the raw parameter',
  );

  assert.match(
    'export function main(argv: readonly string[], raw: NodeJS.ProcessEnv, io: Io)',
    MAIN_SIGNATURE,
  );
  assert.doesNotMatch(
    'export function main(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io)',
    MAIN_SIGNATURE,
  );

  const text = compositionRootText();
  assert.match(text, /runLogin\)?\(env\)/, 'the composition root no longer calls runLogin with a merged env');
  // The second argument is what the pin is about; the verb's later arguments (the pair flags) are
  // not the environment and may follow it.
  assert.match(
    text,
    /runPair\)?\(command\.code, env[,)]/,
    'the composition root no longer calls runPair with a merged env',
  );
});
