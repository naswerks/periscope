/**
 * The environment a spawned agent process receives — an allow-list, not a strip-list.
 *
 * The Agent SDK's `env` option replaces the subprocess environment rather than merging it, and when
 * omitted the subprocess inherits `process.env` whole. So the default posture is full inheritance,
 * and the only way to hold a boundary is to state what crosses it. A strip-list can only ever remove
 * what someone thought of; this one is "absent unless declared".
 *
 * The failures this prevents are all silent, which is why the set is pinned key-by-key rather than
 * eyeballed. Three are recorded, and two have been observed in a live host:
 *   - `CLAUDE_CODE_CHILD_SESSION` inherited: the CLI treats the spawn as a nested session and never
 *     persists its transcript, while the Stop path still reports the path it never wrote.
 *   - `CLAUDE_EFFORT` inherited: the host's own effort silently becomes every spawn's effort.
 *   - a host secret inherited: every subprocess the agent runs authenticates as the host.
 *
 * How the declared set was derived — read this before adding or removing a key.
 * Not copied from any single product's list. A list derived from a capture of one product's
 * machines declares that product's own service-discovery variables; carrying those here is how a
 * general-purpose package quietly becomes a single-product one. The test that gates this file runs
 * a closed diff over two corpora — a live host capture and a production capture from a different
 * machine — and every key in either is declared or carries a written reason for being dropped. Two
 * corpora rather than one because a single capture under-includes whatever that box happens to
 * lack: proxy variables, `XDG_`, `LC_`. Do not tidy them into one.
 *
 * Product-specific names are not declared here. They come back through `extraAllowedKeys`, which the
 * embedder states for its own deployment — `USERPROFILE` is a primitive, a dashboard endpoint URL
 * is somebody's product.
 *
 * The standing posture, because it decides every close call: over-inclusion is recoverable and
 * visible; under-inclusion breaks agents in ways that read as model failures many sessions later.
 * So a key is declared unless there is a positive reason to drop it — it carries a credential, it is
 * another process's handle, it is one product's configuration, or it actively lies to the child
 * about what it is.
 */

/** Any environment-shaped map. Deliberately not `NodeJS.ProcessEnv` — nothing here needs a runtime. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface SpawnEnvPolicy {
  /**
   * Keys the embedder declares for its own deployment, on top of the general set.
   *
   * This is where a product's own variables belong. Matched case-insensitively like the rest, and
   * it cannot override a denied key — see `DENIED_PATTERNS`.
   */
  readonly extraAllowedKeys?: readonly string[];
  /**
   * Keys the embedder refuses even though they are declared. For a host that knows a name in the
   * general set is a secret on its machines.
   */
  readonly extraDeniedKeys?: readonly string[];
  /**
   * Literal values set on the spawn, applied after filtering.
   *
   * Setting a value is not the same act as inheriting one: a value stated here is a decision with an
   * author, and it overrides whatever the host env happened to hold. That asymmetry is deliberate —
   * a variable this package refuses to inherit can still be set, but only by naming it and its value.
   */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// The declared set.
// ---------------------------------------------------------------------------

const ALLOWED_EXACT = [
  // -- Home resolution. Load-bearing, and the group travels together or not at all.
  //    On Windows the key is USERPROFILE, not HOME: `os.homedir()` reads the USERPROFILE family,
  //    and `HOME` in a Windows child is a Git-Bash invention. Declaring HOME while omitting
  //    USERPROFILE leaves the CLI unable to find its ambient credentials file — every agent
  //    silently unauthenticated, presenting as a confused model rather than an error.
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'ALLUSERSPROFILE',
  'OneDrive',
  //    Belongs to the group above, not to the CLI knobs below: it is another spelling of "where are
  //    my credentials", so dropping it breaks ambient auth in exactly the same silent way.
  'CLAUDE_CONFIG_DIR',

  // -- Identity
  'USERNAME',
  'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE',
  'COMPUTERNAME',
  'USER',
  'LOGNAME',

  // -- Windows OS substrate
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'ProgramData',
  'PROGRAMFILES',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'COMMONPROGRAMFILES',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'PUBLIC',
  'DriverData',
  'OS',
  'NoDefaultCurrentDirectoryInExePath',
  'PROMPT',
  'PSModulePath',
  'SESSIONNAME',
  'LOGONSERVER',
  'NUMBER_OF_PROCESSORS',
  'ZES_ENABLE_SYSMAN',

  // -- POSIX substrate. Neither corpus is a POSIX capture, so these are declared from the
  //    Windows keys' POSIX twins rather than observed. Stated openly because it is the one place
  //    this set is designed rather than derived — and under-inclusion on a platform no corpus
  //    covers is the invisible direction.
  'TMPDIR',

  // -- Terminal + locale
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'COLORTERM',
  'COLOR',
  'LANG',
  'TZ',

  // -- Node / npm toolchain. `npm_config_*` rides the prefix list; `npm_package_*`,
  //    `npm_lifecycle_*` and `INIT_CWD` deliberately do not — they describe the host's own npm
  //    invocation and would tell a child it is the host package.
  'NODE',
  'npm_command',
  'npm_execpath',
  'npm_node_execpath',
  'NVM_HOME',
  'NVM_SYMLINK',
  'COREPACK_ENABLE_AUTO_PIN',

  // -- Shell, git and dev toolchain. EDITOR/GIT_EDITOR are declared because an agent running a git
  //    command that opens an editor with none configured hangs instead of failing.
  'SHELL',
  'MSYSTEM',
  'EXEPATH',
  'PLINK_PROTOCOL',
  'SSL_CERT_DIR',
  'PWD',
  'SHLVL',
  'EDITOR',
  'GIT_EDITOR',
  'DOTNET_NOLOGO',
  'MSBUILDTERMINALLOGGER',
  'ChocolateyInstall',
  'ChocolateyLastPathUpdate',

  // -- Agent CLI knobs, exact names only. A `CLAUDE_` prefix would re-admit the stripped set below,
  //    above all the effort variable, and undo the whole point of this file.
  'CLAUDE_CODE_ENABLE_TELEMETRY',
] as const;

const ALLOWED_PREFIXES = [
  'NODE_', // NODE_ENV / NODE_NO_WARNINGS / NODE_OPTIONS / NODE_EXTRA_CA_CERTS
  'npm_config_', // a child running npm needs the host's cache and prefix resolution
  'PROCESSOR_', // PROCESSOR_ARCHITECTURE / _IDENTIFIER / _LEVEL / _REVISION
  'XDG_', // POSIX base directories
  'LC_', // locale category overrides
] as const;

// Matched as a suffix so one entry covers HTTP_PROXY / http_proxy / HTTPS_PROXY / ALL_PROXY /
// NO_PROXY, case-insensitively. A proxied host is exactly where under-inclusion is invisible on the
// machine that wrote the list and fatal on the machine that runs it.
const ALLOWED_SUFFIXES = ['_PROXY'] as const;

/**
 * Denied whatever else matches. Runs before every allow, including `extraAllowedKeys`, because a
 * key that is a credential does not stop being one because someone widened a prefix.
 */
const DENIED_PATTERNS: readonly RegExp[] = [
  // npm materialises every .npmrc key as an environment variable, so `npm_config_` genuinely
  // matches shapes like `npm_config_//registry.example.com/:_authToken`. A targeted deny rather
  // than a narrower prefix: a child running npm still needs the rest of its config resolution.
  /^npm_config_.*(:_authtoken|:_auth|:_password|:username|:email|_auth)$/i,
  // Disables certificate validation for every outbound request the child makes. A host may have a
  // local reason for it; a spawned agent inherits the reason's absence along with the value, and
  // the failure is a confidentiality one it cannot see. An embedder that means it states it as a
  // literal through `extraEnv`, where it has an author.
  /^NODE_TLS_REJECT_UNAUTHORIZED$/i,
];

/**
 * Stripped last and unconditionally — after the allow-list, after `extraEnv`, after everything.
 *
 * Deliberately redundant with "absent unless declared": this survives a widened declared set, a
 * `CLAUDE_`-shaped prefix added in haste, and an embedder that sets one of these by hand. The class
 * is the running host's own session fingerprint, and a spawned agent is a top-level session, not a
 * continuation of whoever launched the host.
 */
const HOST_SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_ENABLE_TASKS',
  'MCP_CONNECTION_NONBLOCKING',
  'AI_AGENT',
  // The host's own thinking budget, same class as the effort variable: an inherited value silently
  // becomes every spawn's budget. A deliberate one arrives through the SDK options, which have an
  // author and a type.
  'MAX_THINKING_TOKENS',
] as const;

// ---------------------------------------------------------------------------
// Matching.
// ---------------------------------------------------------------------------

// Matching is case-insensitive. Windows environment names are case-insensitive and Node preserves
// the OS's own casing verbatim — `ProgramData`, `CommonProgramFiles(x86)`, `ChocolateyInstall` — so
// a case-sensitive set silently drops real keys. On POSIX this only over-includes (a lowercase twin
// of a declared name), which is the recoverable direction, and it is how `http_proxy` is covered by
// the same entry as `HTTPS_PROXY`.
const ALLOWED_EXACT_UPPER = new Set<string>(ALLOWED_EXACT.map((key) => key.toUpperCase()));
const ALLOWED_PREFIXES_UPPER = ALLOWED_PREFIXES.map((prefix) => prefix.toUpperCase());
const ALLOWED_SUFFIXES_UPPER = ALLOWED_SUFFIXES.map((suffix) => suffix.toUpperCase());
const HOST_SESSION_MARKERS_UPPER = new Set<string>(HOST_SESSION_MARKERS.map((key) => key.toUpperCase()));

/** Every key this package declares for a spawned agent, in declaration order. For the pin. */
export const DECLARED_EXACT_KEYS: readonly string[] = ALLOWED_EXACT;
export const DECLARED_PREFIXES: readonly string[] = ALLOWED_PREFIXES;
export const DECLARED_SUFFIXES: readonly string[] = ALLOWED_SUFFIXES;
export const STRIPPED_HOST_SESSION_KEYS: readonly string[] = HOST_SESSION_MARKERS;

function isDenied(key: string, policy: SpawnEnvPolicy): boolean {
  if (DENIED_PATTERNS.some((pattern) => pattern.test(key))) return true;
  const upper = key.toUpperCase();
  return (policy.extraDeniedKeys ?? []).some((denied) => denied.toUpperCase() === upper);
}

/** Is this key declared for spawned agents? Exported so the gate test can drive it directly. */
export function isDeclaredSpawnEnvKey(key: string, policy: SpawnEnvPolicy = {}): boolean {
  if (isDenied(key, policy)) return false;

  const upper = key.toUpperCase();
  if ((policy.extraAllowedKeys ?? []).some((extra) => extra.toUpperCase() === upper)) return true;
  if (ALLOWED_EXACT_UPPER.has(upper)) return true;
  if (ALLOWED_PREFIXES_UPPER.some((prefix) => upper.startsWith(prefix))) return true;
  return ALLOWED_SUFFIXES_UPPER.some((suffix) => upper.endsWith(suffix));
}

const isProxyKey = (key: string): boolean =>
  ALLOWED_SUFFIXES_UPPER.some((suffix) => key.toUpperCase().endsWith(suffix));

/**
 * Strip `user:pass@` from a proxy URL, keeping the proxy reachable.
 *
 * The key stays declared and the credential leaves the value: proxy URLs routinely embed
 * credentials, so declaring the key was declaring a secret — but dropping the key breaks every
 * spawn behind a corporate proxy, which trades an availability failure for a confidentiality one.
 * A value that does not parse as a URL (`NO_PROXY` is a comma-separated host list) is returned
 * verbatim: a redaction must never corrupt a value it does not understand, because a mangled
 * no-proxy list silently changes which hosts bypass the proxy.
 */
export function redactProxyCredential(value: string): string {
  if (!value.includes('@')) return value;
  try {
    const url = new URL(value);
    if (url.username === '' && url.password === '') return value;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * The environment for a spawned agent: the declared subset of `baseEnv`, then the embedder's
 * literals, then the host-session strip.
 *
 * The strip runs last on purpose. It is the one rule that cannot be widened away, so the property
 * "a spawned agent is never told it is a continuation of this process" holds no matter what a later
 * change does to the declared set or what an embedder passes.
 *
 * Returns a fresh object every call and never mutates `baseEnv`.
 */
export function composeSpawnEnv(baseEnv: EnvSource, policy: SpawnEnvPolicy = {}): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of Object.keys(baseEnv)) {
    if (!isDeclaredSpawnEnvKey(key, policy)) continue;
    const value = baseEnv[key];
    // An undeclared value and an empty one are different things, but neither is worth passing: the
    // SDK's env map allows `undefined` and the CLI would see the name with nothing behind it.
    if (value === undefined) continue;
    env[key] = isProxyKey(key) ? redactProxyCredential(value) : value;
  }

  for (const [key, value] of Object.entries(policy.extraEnv ?? {})) {
    env[key] = value;
  }

  for (const key of Object.keys(env)) {
    if (HOST_SESSION_MARKERS_UPPER.has(key.toUpperCase())) delete env[key];
  }

  return env;
}
