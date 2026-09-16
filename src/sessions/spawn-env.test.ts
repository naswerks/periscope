/**
 * The gate on the spawn environment, and the fixtures are the point.
 *
 * The two corpora below are observations, not configuration. Neither is a wish-list and neither may
 * be curated to make a run pass: they are the environment key names two real machines actually had.
 * Every key in either one is declared by spawn-env.ts or appears in EXPECTED_DROPPED with a written
 * reason — a closed diff over ground truth. That turns "is every key the CLI needs declared?",
 * which cannot be answered by inspection and whose failures are all silent, into an arithmetic check.
 *
 * What the corpora do not cover, measured rather than assumed — and the reason there is a second
 * closed diff below. Corpus A is a strict subset of corpus B (it adds no key of its own; B adds 25),
 * because both are captures of the same Windows environment family. So a second corpus does not supply
 * what a first one lacks, which is what a reader would reasonably expect it to be for. Its value is
 * different and narrower: A is the current observation and B the historical one, so A confirms B is
 * still representative, and A is where the recorded live hazards were actually seen. If a future
 * capture of A ever adds a key B lacks, that is a signal, and the subset assertion below catches it.
 *
 * The consequence: neither corpus contains a proxy variable, an `XDG_` key, an `LC_` key, or the
 * POSIX identity and temp-directory names. Those rules are designed, not derived, and the second
 * diff makes every one of them declare itself as such — otherwise a later reader takes the whole
 * declared set for observed ground truth, which is exactly the kind of quiet promotion this file
 * exists to prevent.
 *
 * If you are extending the declared set: add the key to spawn-env.ts and either observe it in a
 * corpus or name it in DECLARED_WITHOUT_OBSERVATION with why. If you are removing one, add it to
 * EXPECTED_DROPPED with why. Do not edit the corpora — they are historical observations; re-capture
 * one only when you mean to re-baseline against a machine you have actually looked at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECLARED_EXACT_KEYS,
  DECLARED_PREFIXES,
  DECLARED_SUFFIXES,
  composeSpawnEnv,
  isDeclaredSpawnEnvKey,
  redactProxyCredential,
} from './spawn-env.js';

/**
 * Corpus A: the environment of a Windows developer machine running the agent CLI under a Node
 * toolchain. Names only, with product-specific names replaced by neutral ones of the same class.
 */
const CORPUS_A_HOST_ENV = [
  '_',
  'AI_AGENT',
  'ALLUSERSPROFILE',
  'APPDATA',
  'ORCHESTRATOR_DASHBOARD_MCP_ENDPOINT_URL',
  'ORCHESTRATOR_DASHBOARD_OTLP_ENDPOINT_URL',
  'ORCHESTRATOR_DASHBOARD_OTLP_HTTP_ENDPOINT_URL',
  'ORCHESTRATOR_RESOURCE_SERVICE_ENDPOINT_URL',
  'PRODUCT_API_URL',
  'ChocolateyInstall',
  'ChocolateyLastPathUpdate',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDECODE',
  'COLOR',
  'COLORTERM',
  'COMMONPROGRAMFILES',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'COMPUTERNAME',
  'COMSPEC',
  'COREPACK_ENABLE_AUTO_PIN',
  'DOTNET_NOLOGO',
  'DriverData',
  'EDITOR',
  'EXEPATH',
  'GIT_EDITOR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LOCALAPPDATA',
  'LOGONSERVER',
  'MAX_THINKING_TOKENS',
  'MCP_TIMEOUT',
  'MSBUILDTERMINALLOGGER',
  'MSYSTEM',
  'PRODUCT_SESSION_ID',
  'NODE',
  'NODE_ENV',
  'NODE_NO_WARNINGS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NoDefaultCurrentDirectoryInExePath',
  'npm_command',
  'npm_config_allow_scripts',
  'npm_config_cache',
  'npm_config_global_prefix',
  'npm_config_globalconfig',
  'npm_config_init_module',
  'npm_config_local_prefix',
  'npm_config_node_gyp',
  'npm_config_noproxy',
  'npm_config_npm_version',
  'npm_config_prefix',
  'npm_config_user_agent',
  'npm_config_userconfig',
  'npm_execpath',
  'npm_node_execpath',
  'NUMBER_OF_PROCESSORS',
  'NVM_HOME',
  'NVM_SYMLINK',
  'OneDrive',
  'OS',
  'PATH',
  'PATHEXT',
  'PLINK_PROTOCOL',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'ProgramData',
  'PROGRAMFILES',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'PROMPT',
  'PSModulePath',
  'PUBLIC',
  'PWD',
  'SESSIONNAME',
  'SHELL',
  'SHLVL',
  'SSL_CERT_DIR',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TMP',
  'TRACEPARENT',
  'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE',
  'USERNAME',
  'USERPROFILE',
  'VSCODE_INJECTION',
  'VSCODE_PYTHON_AUTOACTIVATE_GUARD',
  'WINDIR',
  'ZES_ENABLE_SYSMAN',
];

/**
 * Corpus B: the environment inside a spawned agent on a second machine. Its value is that it holds
 * keys corpus A does not: an editor's git-credential helpers, OEM variables no denylist could have
 * anticipated, and a host product's own control-plane configuration.
 */
const CORPUS_B_PRODUCTION_SPAWN_ENV = [
  '_',
  'AI_AGENT',
  'ALLUSERSPROFILE',
  'APPDATA',
  'ORCHESTRATOR_ALLOW_UNSECURED_TRANSPORT',
  'ORCHESTRATOR_BACKCHANNEL_PATH',
  'ORCHESTRATOR_CLI_LOG_FILE',
  'ORCHESTRATOR_CLI_PID',
  'ORCHESTRATOR_CLI_RUN_DETACHED',
  'ORCHESTRATOR_CLI_STARTED',
  'ORCHESTRATOR_DASHBOARD_MCP_ENDPOINT_URL',
  'ORCHESTRATOR_DASHBOARD_OTLP_ENDPOINT_URL',
  'ORCHESTRATOR_DASHBOARD_OTLP_HTTP_ENDPOINT_URL',
  'ORCHESTRATOR_RESOURCE_SERVICE_ENDPOINT_URL',
  'PRODUCT_API_URL',
  'ChocolateyInstall',
  'ChocolateyLastPathUpdate',
  'EDITOR_CRASHPAD_PIPE_NAME',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDECODE',
  'COLOR',
  'COLORTERM',
  'COMMONPROGRAMFILES',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'COMPUTERNAME',
  'COMSPEC',
  'EDITOR_EXTENSION_DEBUG_NONCE',
  'COREPACK_ENABLE_AUTO_PIN',
  'DOTNET_NOLOGO',
  'DriverData',
  'EDITOR',
  'OEM_20481_1592913036',
  'OEM_20481_4126798990',
  'EXEPATH',
  'GIT_ASKPASS',
  'GIT_EDITOR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'OEM_GRAPHICS_DB',
  'INIT_CWD',
  'LANG',
  'LOCALAPPDATA',
  'LOGONSERVER',
  'MAX_THINKING_TOKENS',
  'MCP_TIMEOUT',
  'MSBUILDTERMINALLOGGER',
  'MSYSTEM',
  'PRODUCT_SESSION_ID',
  'NODE',
  'NODE_ENV',
  'NODE_NO_WARNINGS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NoDefaultCurrentDirectoryInExePath',
  'npm_command',
  'npm_config_allow_scripts',
  'npm_config_cache',
  'npm_config_global_prefix',
  'npm_config_globalconfig',
  'npm_config_init_module',
  'npm_config_local_prefix',
  'npm_config_node_gyp',
  'npm_config_noproxy',
  'npm_config_npm_version',
  'npm_config_prefix',
  'npm_config_user_agent',
  'npm_config_userconfig',
  'npm_execpath',
  'npm_lifecycle_event',
  'npm_lifecycle_script',
  'npm_node_execpath',
  'npm_package_engines_node',
  'npm_package_json',
  'npm_package_name',
  'npm_package_version',
  'NUMBER_OF_PROCESSORS',
  'NVM_HOME',
  'NVM_SYMLINK',
  'OneDrive',
  'OS',
  'PATH',
  'PATHEXT',
  'PLINK_PROTOCOL',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'ProgramData',
  'PROGRAMFILES',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'PROMPT',
  'PSModulePath',
  'PUBLIC',
  'PWD',
  'PRODUCT_REPO_ROOT',
  'SESSIONNAME',
  'SHELL',
  'SHLVL',
  'PRODUCT_SERVICE_PORT',
  'SSL_CERT_DIR',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TMP',
  'TRACEPARENT',
  'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE',
  'USERNAME',
  'USERPROFILE',
  'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
  'VSCODE_GIT_ASKPASS_MAIN',
  'VSCODE_GIT_ASKPASS_NODE',
  'VSCODE_GIT_IPC_HANDLE',
  'VSCODE_INJECTION',
  'VSCODE_PYTHON_AUTOACTIVATE_GUARD',
  'WINDIR',
  'ZES_ENABLE_SYSMAN',
];

/**
 * The diff, and it is the review artifact — a reader checks reasons here, not code in spawn-env.ts.
 * Every key present in either corpus and absent from a composed spawn environment appears below.
 */
const EXPECTED_DROPPED: Record<string, string> = {
  // -- The running host's own session fingerprint. A spawned agent is a top-level session; telling
  //    it otherwise makes the CLI skip transcript persistence while still reporting a path.
  CLAUDECODE: 'host session fingerprint',
  CLAUDE_CODE_CHILD_SESSION: 'host session fingerprint — suppresses transcript persistence, silently',
  CLAUDE_CODE_ENTRYPOINT: 'host session fingerprint — names how the host was launched',
  CLAUDE_CODE_SESSION_ID: "host session fingerprint — another session's id",
  CLAUDE_CODE_EXECPATH: 'host session fingerprint — the executable the host is running',
  CLAUDE_CODE_SSE_PORT: "host session fingerprint — a port on the host's own control channel",
  CLAUDE_PID: "host session fingerprint — the host process's own PID",
  CLAUDE_EFFORT: "the host's effort would silently become every spawn's effort",
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: 'host session feature toggle, derived per session',
  AI_AGENT: 'host session fingerprint',
  MAX_THINKING_TOKENS:
    "the host's thinking budget, same class as effort — a deliberate one arrives through the options",

  // -- One product's service topology and configuration, kept out of the general set.
  //    Corpus B's own host declared these for itself. A general-purpose package that
  //    declared them would be shaped to a single consumer; an embedder that wants them names them
  //    through `extraAllowedKeys`, where the choice has an author.
  ORCHESTRATOR_DASHBOARD_MCP_ENDPOINT_URL: "one product's service discovery — belongs in extraAllowedKeys",
  ORCHESTRATOR_DASHBOARD_OTLP_ENDPOINT_URL: "one product's service discovery — belongs in extraAllowedKeys",
  ORCHESTRATOR_DASHBOARD_OTLP_HTTP_ENDPOINT_URL: "one product's service discovery",
  ORCHESTRATOR_RESOURCE_SERVICE_ENDPOINT_URL: "one product's service discovery",
  ORCHESTRATOR_ALLOW_UNSECURED_TRANSPORT: "one product's transport policy",
  ORCHESTRATOR_BACKCHANNEL_PATH: "one product's control channel — a capability, not configuration",
  ORCHESTRATOR_CLI_PID: "one product's control-plane state: a PID",
  ORCHESTRATOR_CLI_LOG_FILE: "one product's control-plane state: a log path",
  ORCHESTRATOR_CLI_STARTED: "one product's control-plane state: a boolean",
  ORCHESTRATOR_CLI_RUN_DETACHED: "one product's control-plane state: a boolean",
  PRODUCT_API_URL: "one product's service address",
  PRODUCT_SESSION_ID: "one product's session identifier",
  PRODUCT_REPO_ROOT: "one product's configuration, and a host-absolute path",
  PRODUCT_SERVICE_PORT: "one product's service address",
  MCP_TIMEOUT: "the host's own MCP connect window; a spawn's belongs to whoever composes its options",
  TRACEPARENT: "the host's trace context — a spawn is a new root unless an embedder states one via extraEnv",

  // -- Credential-bearing, in every case as a capability rather than a secret.
  GIT_ASKPASS:
    "hands the child the host's git credential helper — it could then authenticate to the host " +
    "user's remotes while holding no token of its own",
  VSCODE_GIT_ASKPASS_MAIN: 'the askpass group travels together; declaring part of it is worse than none',
  VSCODE_GIT_ASKPASS_NODE: 'the askpass group travels together; declaring part of it is worse than none',
  VSCODE_GIT_ASKPASS_EXTRA_ARGS: 'the askpass group travels together',
  VSCODE_GIT_IPC_HANDLE: "an IPC handle back to the host editor's git session — the same reach",
  NODE_TLS_REJECT_UNAUTHORIZED:
    'Denied, not merely undeclared: disables certificate validation for everything the child does, ' +
    'and the child inherits the value without the local reason that justified it',

  // -- Another process's handle. None of these mean anything in a child, and two are capabilities.
  EDITOR_CRASHPAD_PIPE_NAME: "the host editor's crash-handler pipe",
  EDITOR_EXTENSION_DEBUG_NONCE: "another extension's debug nonce",
  OEM_GRAPHICS_DB: 'a graphics-service blob; host/OEM, nothing in a child reads it',
  OEM_20481_1592913036: 'PID-keyed host/OEM variable — the case for an allow-list in one line',
  OEM_20481_4126798990: 'PID-keyed host/OEM variable — no denylist could have anticipated this name',
  VSCODE_INJECTION: "host editor fingerprint — a spawned agent is not inside the host's terminal",
  VSCODE_PYTHON_AUTOACTIVATE_GUARD: 'host editor extension guard',

  // -- Actively misleading: they describe the host's own npm invocation, so a child running npm in
  //    its own directory would read the host package's name and version as its own.
  npm_package_name: "the host package's metadata — actively wrong inside a child",
  npm_package_version: "the host package's metadata",
  npm_package_json: "the host package's manifest path",
  npm_package_engines_node: "the host package's engines constraint",
  npm_lifecycle_event: "the host's lifecycle script name",
  npm_lifecycle_script: "the host's lifecycle script body",
  INIT_CWD: "the directory the host's npm was invoked from",

  // -- Shell-local, recreated by any shell the child starts.
  _: 'shell-local "last command" variable; every shell rewrites it',
};

// ---------------------------------------------------------------------------

/** A base env whose values encode their own key, so "present" and "correct" are distinguishable. */
function baseFrom(keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, `value-of-${key}`]));
}

test('the declared set reproduces both corpora minus exactly the justified removals', () => {
  for (const [name, corpus] of [
    ['A (host)', CORPUS_A_HOST_ENV],
    ['B (production spawn)', CORPUS_B_PRODUCTION_SPAWN_ENV],
  ] as const) {
    const env = composeSpawnEnv(baseFrom(corpus));
    const kept = new Set(Object.keys(env));
    const dropped = corpus.filter((key) => !kept.has(key));

    for (const key of dropped) {
      assert.ok(
        EXPECTED_DROPPED[key],
        `corpus ${name}: ${key} was dropped with no stated reason — declare it, or add it to ` +
          'EXPECTED_DROPPED with why it is safe to lose',
      );
    }
    for (const key of corpus.filter((k) => EXPECTED_DROPPED[k] !== undefined)) {
      assert.equal(kept.has(key), false, `corpus ${name}: ${key} is listed as removed but survived`);
    }
    // Survival is by value, not merely by presence: a key kept with the wrong value is the same
    // silent breakage as a key dropped.
    for (const key of corpus.filter((k) => EXPECTED_DROPPED[k] === undefined)) {
      assert.equal(env[key], `value-of-${key}`, `${key} must survive with its value intact`);
    }
  }
});

// Guards the SELECTOR: if the corpora were emptied, truncated or mistyped, every assertion above
// would pass while checking nothing, and that green is byte-identical to the honest one.
//
// The subset relation is pinned as what is true — the intuitive expectation, that each corpus holds
// keys the other does not, is false for these two — so a future capture that breaks the relation
// is news instead of a surprise.
test('the corpora are real, populated, and A is a strict subset of B', () => {
  assert.equal(CORPUS_A_HOST_ENV.length, 105, 'corpus A must stay at its observed size');
  assert.equal(CORPUS_B_PRODUCTION_SPAWN_ENV.length, 130, 'corpus B must stay at its observed size');

  const b = new Set(CORPUS_B_PRODUCTION_SPAWN_ENV);
  assert.deepEqual(
    CORPUS_A_HOST_ENV.filter((key) => !b.has(key)),
    [],
    'corpus A now holds a key corpus B does not — the host environment moved; re-read both before extending',
  );

  const a = new Set(CORPUS_A_HOST_ENV);
  assert.equal(
    CORPUS_B_PRODUCTION_SPAWN_ENV.filter((key) => !a.has(key)).length,
    25,
    'corpus B must keep contributing the keys corpus A never had',
  );

  // And the diff is not vacuous in the other direction either: real keys must actually survive.
  const survivors = Object.keys(composeSpawnEnv(baseFrom(CORPUS_A_HOST_ENV)));
  assert.ok(survivors.length >= 60, `only ${survivors.length} keys survived — the filter is too tight`);
  assert.ok(survivors.includes('PATH'));
  assert.ok(survivors.includes('USERPROFILE'));
});

/**
 * The second closed diff, and it runs the other way: which declared rules no observation supports.
 *
 * The first diff proves nothing observed was lost. It cannot prove the reverse — that nothing was
 * declared on a hunch — and both corpora are Windows, so every POSIX and proxy rule in this set is a
 * design decision wearing the same clothes as the derived ones. Naming them here keeps the
 * distinction legible to someone who was not present, and makes adding an unsupported key a
 * deliberate act with a written reason rather than one more line in a long list.
 */
const DECLARED_WITHOUT_OBSERVATION: Record<string, string> = {
  CLAUDE_CONFIG_DIR:
    'redirects where the CLI looks for its credentials, so it belongs to the home-resolution group ' +
    'and omitting it breaks ambient auth in the same silent way — neither capture host set it',
  USER: 'the POSIX twin of USERNAME; neither corpus is a POSIX capture',
  LOGNAME: 'the POSIX twin of USERNAME; neither corpus is a POSIX capture',
  TMPDIR: 'the POSIX twin of TEMP/TMP; a spawn with no temp directory fails in unhelpful ways',
  TZ: 'timezone; POSIX-conventional and absent from both Windows captures',
};

const RULES_WITHOUT_OBSERVATION: Record<string, string> = {
  XDG_: 'POSIX base directories — neither corpus is a POSIX capture',
  LC_: 'locale category overrides — neither capture host set one',
  _PROXY: [
    'Neither capture host was behind a proxy, so this whole rule — and the credential redaction ',
    'attached to it — rests on no observation at all. Kept, and flagged, because a proxied host is ',
    'exactly where under-inclusion is invisible on the machine that wrote the list and fatal on the ',
    'machine that runs it.',
  ].join(''),
};

test('every declared key is either observed or declares itself unobserved', () => {
  const observed = new Set(
    [...CORPUS_A_HOST_ENV, ...CORPUS_B_PRODUCTION_SPAWN_ENV].map((key) => key.toUpperCase()),
  );

  const unobserved = DECLARED_EXACT_KEYS.filter((key) => !observed.has(key.toUpperCase()));
  for (const key of unobserved) {
    assert.ok(
      DECLARED_WITHOUT_OBSERVATION[key],
      `${key} is declared but appears in neither corpus and states no reason — observe it, or say ` +
        'why it is declared without an observation',
    );
  }
  // Nothing claims to be unobserved while a corpus actually has it: a stale entry here would read
  // as "designed" about a key that is in fact ground truth.
  for (const key of Object.keys(DECLARED_WITHOUT_OBSERVATION)) {
    assert.equal(
      observed.has(key.toUpperCase()),
      false,
      `${key} is observed in a corpus — remove it from DECLARED_WITHOUT_OBSERVATION`,
    );
  }
  assert.deepEqual(unobserved.sort(), Object.keys(DECLARED_WITHOUT_OBSERVATION).sort());

  // The same question for the pattern rules, which is where the real exposure is: one unsupported
  // prefix admits an unbounded family of names.
  const supported = (rule: string): boolean =>
    rule.startsWith('_')
      ? [...observed].some((key) => key.endsWith(rule))
      : [...observed].some((key) => key.startsWith(rule.toUpperCase()));

  const rules = [...DECLARED_PREFIXES, ...DECLARED_SUFFIXES];
  for (const rule of rules.filter((r) => !supported(r))) {
    assert.ok(RULES_WITHOUT_OBSERVATION[rule], `matching rule "${rule}" rests on no observation`);
  }
  assert.deepEqual(
    rules.filter((rule) => !supported(rule)).sort(),
    Object.keys(RULES_WITHOUT_OBSERVATION).sort(),
  );

  // Positive control on this test's own selector: the support check must actually distinguish, or
  // both lists above could be empty and every assertion would pass.
  assert.equal(supported('npm_config_'), true, 'a corpus-supported prefix must read as supported');
  assert.equal(supported('XDG_'), false, 'an unsupported prefix must read as unsupported');
});

test('the recorded hazards never reach a spawn — not by inheritance, not by a widened set, not by hand', () => {
  const hazards = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_EFFORT', 'CLAUDECODE', 'MAX_THINKING_TOKENS'];
  const base = baseFrom(['PATH', ...hazards]);

  // 1. Inheritance — the ordinary path.
  const plain = composeSpawnEnv(base);
  for (const key of hazards) assert.equal(key in plain, false, `${key} survived inheritance`);

  // 2. A widened declared set — someone adds them to extraAllowedKeys, by accident or by prefix.
  const widened = composeSpawnEnv(base, { extraAllowedKeys: hazards });
  for (const key of hazards) assert.equal(key in widened, false, `${key} survived a widened set`);

  // 3. Set by hand — the strongest form, and the reason the strip runs last.
  const forced = composeSpawnEnv(base, { extraEnv: Object.fromEntries(hazards.map((k) => [k, '1'])) });
  for (const key of hazards) assert.equal(key in forced, false, `${key} survived being set explicitly`);

  assert.equal(plain['PATH'], 'value-of-PATH', 'and the rest of the environment is untouched');
});

test('home resolution survives as a group — this is what preserves ambient credential-file auth', () => {
  const env = composeSpawnEnv({
    USERPROFILE: 'C:\\Users\\dev',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\dev',
    HOME: '/c/Users/dev',
    APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    ALLUSERSPROFILE: 'C:\\ProgramData',
    CLAUDE_CONFIG_DIR: 'D:\\claude',
  });
  // USERPROFILE is the load-bearing one on Windows; the CLI resolves ~ through it, so declaring
  // HOME alone leaves the credentials file unfindable and every agent silently unauthenticated.
  for (const key of [
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'ALLUSERSPROFILE',
    'CLAUDE_CONFIG_DIR',
  ]) {
    assert.ok(key in env, `${key} is load-bearing for credentials-file resolution`);
  }
});

test('matching is case-insensitive — real Windows casing is preserved, not dropped', () => {
  const env = composeSpawnEnv({
    ProgramData: 'C:\\ProgramData',
    'CommonProgramFiles(x86)': 'C:\\CPF',
    ChocolateyInstall: 'C:\\choco',
    'ProgramFiles(x86)': 'C:\\PFx86',
    path: '/usr/bin',
    http_proxy: 'http://proxy:8080',
    HTTPS_PROXY: 'http://proxy:8080',
  });
  assert.equal(env['ProgramData'], 'C:\\ProgramData');
  assert.equal(env['CommonProgramFiles(x86)'], 'C:\\CPF');
  assert.equal(env['ChocolateyInstall'], 'C:\\choco');
  assert.equal(env['ProgramFiles(x86)'], 'C:\\PFx86');
  assert.equal(env['path'], '/usr/bin', 'a POSIX lowercase twin still resolves');
  assert.equal(env['http_proxy'], 'http://proxy:8080', 'lowercase proxy vars ride the same suffix rule');
  assert.equal(env['HTTPS_PROXY'], 'http://proxy:8080');
});

test('absent unless declared — an invented vendor key does not cross', () => {
  const env = composeSpawnEnv({
    PATH: 'C:\\bin',
    TOTALLY_MADE_UP_VENDOR_VAR: 'x',
    SOME_NEW_CLI_TOKEN: 'y',
    WORKER_KEY: 'platform-secret',
    TICKET_KEY: 'signing-secret',
    GH_TOKEN: 'ghp_x',
    GITHUB_TOKEN: 'ghp_y',
    ANTHROPIC_API_KEY: 'sk-ant-xyz',
    ANTHROPIC_AUTH_TOKEN: 'tok',
  });
  assert.equal(env['PATH'], 'C:\\bin');
  for (const key of [
    'TOTALLY_MADE_UP_VENDOR_VAR',
    'SOME_NEW_CLI_TOKEN',
    'WORKER_KEY',
    'TICKET_KEY',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
  ]) {
    assert.equal(key in env, false, `${key} must be absent by construction, not by exception`);
  }
  assert.equal(isDeclaredSpawnEnvKey('PATH'), true);
  assert.equal(isDeclaredSpawnEnvKey('WORKER_KEY'), false);
});

test('the embedder seams: extraAllowedKeys admits, extraDeniedKeys refuses, a deny beats an allow', () => {
  const base = { PATH: 'p', ORCHESTRATOR_DASHBOARD_OTLP_ENDPOINT_URL: 'http://otlp', NODE_ENV: 'production' };

  assert.equal('ORCHESTRATOR_DASHBOARD_OTLP_ENDPOINT_URL' in composeSpawnEnv(base), false);
  const admitted = composeSpawnEnv(base, { extraAllowedKeys: ['ORCHESTRATOR_DASHBOARD_OTLP_ENDPOINT_URL'] });
  assert.equal(admitted['ORCHESTRATOR_DASHBOARD_OTLP_ENDPOINT_URL'], 'http://otlp');

  const refused = composeSpawnEnv(base, { extraDeniedKeys: ['NODE_ENV'] });
  assert.equal('NODE_ENV' in refused, false, 'an embedder may refuse a declared key');

  // A deny always wins, including over the embedder's own allow — a credential does not stop being
  // one because a later line widened the set.
  const both = composeSpawnEnv(
    { NODE_TLS_REJECT_UNAUTHORIZED: '0', 'npm_config_//registry.example.com/:_authToken': 'npm_xyz' },
    { extraAllowedKeys: ['NODE_TLS_REJECT_UNAUTHORIZED', 'npm_config_//registry.example.com/:_authToken'] },
  );
  assert.deepEqual(Object.keys(both), []);
});

test('the result is a fresh object and the source is never mutated', () => {
  const base: Record<string, string | undefined> = { PATH: 'p', UNDECLARED: 'x', EMPTY: undefined };
  const env = composeSpawnEnv(base);
  env['PATH'] = 'mutated';

  assert.equal(base['PATH'], 'p', "composing must not write back into the caller's env");
  assert.equal('UNDECLARED' in base, true, 'the source keeps its own keys');
  assert.equal('EMPTY' in env, false, 'a declared key with no value is not passed as an empty name');
});

test('a proxy URL keeps its host and loses its credential; a non-URL value is returned verbatim', () => {
  const env = composeSpawnEnv({
    HTTPS_PROXY: 'http://alice:s3cret@proxy.example.com:8080',
    NO_PROXY: 'localhost,127.0.0.1,.internal',
    HTTP_PROXY: 'http://proxy.example.com:8080',
  });
  assert.equal(env['HTTPS_PROXY']?.includes('s3cret'), false, 'the credential must not ride along');
  assert.ok(env['HTTPS_PROXY']?.includes('proxy.example.com:8080'), 'the proxy must stay reachable');
  assert.equal(env['NO_PROXY'], 'localhost,127.0.0.1,.internal', 'a host list is not a URL — verbatim');
  assert.equal(env['HTTP_PROXY'], 'http://proxy.example.com:8080', 'no credential, no change');

  // The redaction fires on the shape, not on the key name.
  assert.equal(redactProxyCredential('not a url at all @ home'), 'not a url at all @ home');
});

test('the declared set is a real list, and its load-bearing members are in it', () => {
  assert.ok(DECLARED_EXACT_KEYS.length >= 50, `only ${DECLARED_EXACT_KEYS.length} keys declared`);
  for (const key of ['USERPROFILE', 'PATH', 'SYSTEMROOT', 'CLAUDE_CONFIG_DIR']) {
    assert.ok(DECLARED_EXACT_KEYS.includes(key), `${key} must be declared`);
  }
  // The inverse, so the list cannot quietly re-acquire what it exists to exclude.
  for (const key of ['CLAUDE_EFFORT', 'CLAUDE_CODE_CHILD_SESSION', 'WORKER_KEY']) {
    assert.equal(DECLARED_EXACT_KEYS.includes(key), false, `${key} must never be declared`);
  }
});
