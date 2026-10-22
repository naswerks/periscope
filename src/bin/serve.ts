/**
 * `periscope serve`: dial the controller and serve sessions. The daemon every supervisor starts.
 *
 * Two views of the environment arrive, and the split is deliberate. Configuration (`readConfig`)
 * comes from the merged view, where the config file fills absences. Credential material, the
 * environment sessions are filtered from, and the home directory come from the raw view: nothing
 * outside the closed config key set may arrive from a file, and the credential files are found by
 * the same `PERISCOPE_CONFIG_DIR` that says where the config file itself is.
 *
 * Every process-level edge is a dependency: where lines go, how the exit code is latched, how the
 * process is exited, how signals are subscribed. The link and the agent process are injectable for
 * the same reason, so the whole start-up sequence runs in a test with no socket and no agent.
 */
import type { ControllerCredential } from '../control/credential.js';
import type { LinkHandlers } from '../control/link.js';
import type { HostEvent } from '../host/index.js';
import type { HostLink } from '../host/host.js';
import {
  FilePairedCredential,
  FileTokenCache,
  PeriscopeHost,
  agentTranscriptPaths,
  defaultAgentHome,
  credentialPaths,
  homeDirectory,
  packageVersion,
  pairedCredentialPath,
  protocolFor,
  readMachineFacts,
  refresherFor,
  resolveEndpoints,
  tokenCachePath,
} from '../host/index.js';
import type {
  AgentCatalog,
  AgentCatalogOptions,
  AgentProcess,
  AgentProcessRequest,
} from '../host/agent-process.js';
import type { EscalationTransport } from '../gate/escalate.js';
import { escalatingDecider } from '../gate/escalate.js';
import type { TokenRefresher } from '../identity/index.js';
import { PairedHostCredential, TokenCredential, identityPosture } from '../identity/index.js';
import { SessionRegistry } from '../sessions/registry.js';
import { composeSpawnEnv } from '../sessions/spawn-env.js';
import { readConfigFile } from '../host/config-file.js';
import { readModelEndpoints } from '../host/model-endpoints.js';
import type { CodexRuntimeRead, ReadCodexRuntimeOptions } from '../host/codex-runtime.js';
import { codexNativeRuntime, readCodexRuntime } from '../host/codex-runtime.js';
import { codexHookLines, pendingCodexHookState, probeCodexHook } from '../host/codex-hook.js';
import { CODEX_RUNTIME, PI_RUNTIME, QWEN_RUNTIME } from '../sessions/runtimes.js';
import type { QwenRuntimeRead, ReadQwenRuntimeOptions } from '../host/qwen-runtime.js';
import { qwenNativeRuntime, readQwenRuntime } from '../host/qwen-runtime.js';
import type { PiRuntimeRead, ReadPiRuntimeOptions } from '../host/pi-runtime.js';
import { piNativeRuntime, readPiRuntime } from '../host/pi-runtime.js';
import { piEndpointRoutes } from '../host/pi-endpoints.js';
import { parsePluginDirs, pluginDirsProblem, readPluginManifests } from '../host/plugin-dirs.js';
import { MAX_PLUGIN_DIRS } from '../control/frames.js';
import { writeLinkState } from '../host/link-state-file.js';
import { describePosture, postureLine } from './posture.js';
import { isAbsolutePath } from '../core/paths.js';
import { systemClock, systemTicker } from '../core/time.js';
import {
  configValueProblem,
  overriddenByEnvironment,
  parseControllerEnvKeys,
  reconfigureHost,
} from './reconfigure.js';
import {
  hostConfigurationOf,
  workspaceCapabilitiesOf,
  workspacePostureProblem,
  workspacesFor,
} from './workspaces.js';

/**
 * How long the fatal-credential path holds the event loop open before exiting explicitly.
 *
 * Long enough for the stdout trace and the stderr remedy to flush through their pipes, short enough
 * that a supervisor sees the exit promptly. It is not a grace period for work in flight; the host
 * is already stopped by the time this runs.
 */
export const FATAL_EXIT_FLUSH_MS = 50;

/**
 * How long the agent has to answer the catalog read at start. It spawns the CLI and waits for its
 * initialize answer, which takes seconds; past this the hello goes out with `agent: null` rather
 * than holding the dial.
 */
export const AGENT_CATALOG_TIMEOUT_MS = 20_000;

/** The two environments the daemon reads. See the module header for which reads which. */
export interface ServeViews {
  /** The process environment as received. Credentials, the session base env and the home read it. */
  readonly raw: NodeJS.ProcessEnv;
  /**
   * The environment with the config file filling absences, or the problem that made the file
   * unusable. Checked after the root refusal, so a host that cannot run at all is told that first.
   */
  readonly merged: NodeJS.ProcessEnv | string;
}

/** The edges. Every one has a production default in `main.ts`; a test replaces them all. */
export interface ServeDeps {
  /** One stdout line, without its newline: the trace. */
  readonly log: (line: string) => void;
  /** One stderr line, without its newline: refusals and the fatal remedy. */
  readonly stderr: (line: string) => void;
  readonly setExitCode: (code: number) => void;
  /** Ends the process now. Called only on the fatal-credential path, after the flush delay. */
  readonly exit: (code: number) => void;
  readonly onSignal: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void;
  /** The decision POST's transport. Defaults to global fetch. */
  readonly transport?: EscalationTransport;
  /** How the link is built. Defaults to the real `ControllerLink`. */
  readonly link?: (handlers: LinkHandlers) => HostLink;
  /** The effective uid, or null where the platform has none (win32). Defaults to the process's. */
  readonly getuid?: (() => number) | null;
  /** How an agent process is started. Defaults to the real one. */
  readonly startProcess?: (request: AgentProcessRequest) => AgentProcess;
  /**
   * Reads the agent's model catalog for the hello. `main.ts` supplies the real one; with none, the
   * hello carries no catalog and no agent is started to read one.
   */
  readonly readAgentCatalog?: (options: AgentCatalogOptions) => Promise<AgentCatalog>;
  /** Reads the Codex runtime at start, when one is configured. Defaults to the real read. */
  readonly readCodexRuntime?: (options: ReadCodexRuntimeOptions) => Promise<CodexRuntimeRead>;
  /** Reads the Qwen Code runtime at start, when one is configured. Defaults to the real read. */
  readonly readQwenRuntime?: (options: ReadQwenRuntimeOptions) => Promise<QwenRuntimeRead>;
  /** Reads the pi runtime at start, when one is configured. Defaults to the real read. */
  readonly readPiRuntime?: (options: ReadPiRuntimeOptions) => Promise<PiRuntimeRead>;
}

export type ServeOutcome =
  { readonly ok: true; readonly host: PeriscopeHost } | { readonly ok: false; readonly detail: string };

interface Config {
  readonly controllerUrl: string;
  readonly hostId: string;
  /** Where the controller answers a permission escalation. See `readConfig` on why it is required. */
  readonly decisionUrl: string;
  /** When set, every session gets a directory beneath it instead of the one the controller named. */
  readonly workspaceRoot: string | null;
  /**
   * The repository a session's worktree is linked to. When set (alongside `workspaceRoot`), sessions
   * get a linked git worktree on their own branch instead of a plain directory; see `workspacesFor`.
   */
  readonly repositoryRoot: string | null;
  /** The branch template worktree branches render from. Null = the provider's fallback. */
  readonly branchScheme: string | null;
  /** The key an unkeyed session provisions at. Null = the session key. */
  readonly workspaceKey: string | null;
  /**
   * The agent's home: the folder the agent CLI keeps its state and its sign-in in, protected from
   * the agent's own tools. Null = the CLI's own default under the home directory (`defaultAgentHome`).
   */
  readonly agentHome: string | null;
  /** The plugin directories every session loads, as configured (a path list). Null = none. */
  readonly pluginDirs: string | null;
  /** The names a controller may place in a spawn's environment. Empty = none. */
  readonly controllerEnvKeys: readonly string[];
  /** The file of model endpoints the operator declares. Null = none. */
  readonly modelEndpoints: string | null;
  /** The Codex binary and its runner-owned home; both, or neither. Null = Codex is not offered. */
  readonly codex: { readonly binary: string; readonly home: string } | null;
  /** The Qwen Code CLI and its runner-owned home; both, or neither. Null = Qwen Code is not offered. */
  readonly qwen: { readonly binary: string; readonly home: string } | null;
  /** The pi CLI and its runner-owned home; both, or neither. Null = pi is not offered. */
  readonly pi: { readonly binary: string; readonly home: string } | null;
}

function readConfig(env: NodeJS.ProcessEnv): Config | string {
  const controllerUrl = env['PERISCOPE_CONTROLLER_URL'];
  if (controllerUrl === undefined || controllerUrl === '') {
    return 'PERISCOPE_CONTROLLER_URL is not set';
  }

  // A host with nowhere to ask must not start, and neither alternative is survivable. Defaulting
  // to allow makes this a code-execution service for whoever reaches the socket. Defaulting to deny
  // makes a host that comes up healthy, accepts sessions, and blocks every tool call, which reads
  // to an operator as the agent being broken rather than as this host being unconfigured. So it is
  // named at start-up, once, in the one place that reads the environment.
  const decisionUrl = env['PERISCOPE_DECISION_URL'];
  if (decisionUrl === undefined || decisionUrl === '') {
    return (
      'PERISCOPE_DECISION_URL is not set — this host has nowhere to send a permission decision, and a ' +
      'host that cannot ask is either an open door or a session where nothing runs. Set it to the ' +
      'endpoint your controller answers on.'
    );
  }

  // The same screen the wire runs on `host_configure`: a controller URL that is not ws(s), a
  // decision URL that is not http(s), refused at boot by name instead of dialled forever.
  for (const [key, value] of [
    ['PERISCOPE_CONTROLLER_URL', controllerUrl],
    ['PERISCOPE_DECISION_URL', decisionUrl],
  ] as const) {
    const problem = configValueProblem(key, value);
    if (problem !== null) return problem;
  }

  // What a controller may place in a spawn's environment, screened at boot by the same check
  // `periscope config` runs: a name that is malformed, or beneath the floor, would declare nothing.
  const controllerEnvKeys = env['PERISCOPE_CONTROLLER_ENV_KEYS'];
  if (controllerEnvKeys !== undefined) {
    const problem = configValueProblem('PERISCOPE_CONTROLLER_ENV_KEYS', controllerEnvKeys);
    if (problem !== null) return problem;
  }

  const modelEndpoints = env['PERISCOPE_MODEL_ENDPOINTS'];
  if (modelEndpoints !== undefined && modelEndpoints !== '') {
    const problem = configValueProblem('PERISCOPE_MODEL_ENDPOINTS', modelEndpoints);
    if (problem !== null) return problem;
  }

  // Codex is offered only with both: a binary with no home would run from the operator's own, and a
  // home with no binary offers nothing to run. Each is an absolute path, and the binary no batch file.
  const codexBinary = nonEmpty(env['PERISCOPE_CODEX_BIN']);
  const codexHome = nonEmpty(env['PERISCOPE_CODEX_HOME']);
  if ((codexBinary === null) !== (codexHome === null)) {
    return codexBinary === null
      ? 'PERISCOPE_CODEX_HOME is set without PERISCOPE_CODEX_BIN: Codex is offered with both or neither'
      : "PERISCOPE_CODEX_BIN is set without PERISCOPE_CODEX_HOME: Codex is offered with both or neither, and never from the operator's own home";
  }
  for (const [key, value] of [
    ['PERISCOPE_CODEX_BIN', codexBinary],
    ['PERISCOPE_CODEX_HOME', codexHome],
  ] as const) {
    const problem = value === null ? null : configValueProblem(key, value);
    if (problem !== null) return problem;
  }

  // Qwen Code likewise: a CLI with no home would write its settings into the operator's own, and a home
  // with no CLI offers nothing to run.
  const qwenBinary = nonEmpty(env['PERISCOPE_QWEN_BIN']);
  const qwenHome = nonEmpty(env['PERISCOPE_QWEN_HOME']);
  if ((qwenBinary === null) !== (qwenHome === null)) {
    return qwenBinary === null
      ? 'PERISCOPE_QWEN_HOME is set without PERISCOPE_QWEN_BIN: Qwen Code is offered with both or neither'
      : "PERISCOPE_QWEN_BIN is set without PERISCOPE_QWEN_HOME: Qwen Code is offered with both or neither, and never from the operator's own home";
  }
  for (const [key, value] of [
    ['PERISCOPE_QWEN_BIN', qwenBinary],
    ['PERISCOPE_QWEN_HOME', qwenHome],
  ] as const) {
    const problem = value === null ? null : configValueProblem(key, value);
    if (problem !== null) return problem;
  }

  // pi likewise: a CLI with no home would run from the operator's own agent home, with its sign-in and
  // its extensions, and a home with no CLI offers nothing to run.
  const piBinary = nonEmpty(env['PERISCOPE_PI_BIN']);
  const piHome = nonEmpty(env['PERISCOPE_PI_HOME']);
  if ((piBinary === null) !== (piHome === null)) {
    return piBinary === null
      ? 'PERISCOPE_PI_HOME is set without PERISCOPE_PI_BIN: pi is offered with both or neither'
      : "PERISCOPE_PI_BIN is set without PERISCOPE_PI_HOME: pi is offered with both or neither, and never from the operator's own home";
  }
  for (const [key, value] of [
    ['PERISCOPE_PI_BIN', piBinary],
    ['PERISCOPE_PI_HOME', piHome],
  ] as const) {
    const problem = value === null ? null : configValueProblem(key, value);
    if (problem !== null) return problem;
  }

  const configuredHostId = env['PERISCOPE_HOST_ID'];
  return {
    controllerUrl,
    // An empty value counts as unset, as every other key reads it: a shell that exports the name
    // with nothing behind it has not chosen a host id.
    hostId:
      configuredHostId === undefined || configuredHostId === ''
        ? readMachineFacts().hostname
        : configuredHostId,
    decisionUrl,
    workspaceRoot: env['PERISCOPE_WORKSPACE_ROOT'] ?? null,
    repositoryRoot: env['PERISCOPE_REPOSITORY_ROOT'] ?? null,
    branchScheme: env['PERISCOPE_BRANCH_SCHEME'] ?? null,
    workspaceKey: env['PERISCOPE_WORKSPACE_KEY'] ?? null,
    agentHome: env['PERISCOPE_AGENT_HOME'] ?? null,
    pluginDirs: env['PERISCOPE_PLUGIN_DIRS'] ?? null,
    controllerEnvKeys: parseControllerEnvKeys(controllerEnvKeys),
    modelEndpoints: modelEndpoints === undefined || modelEndpoints === '' ? null : modelEndpoints,
    codex: codexBinary === null || codexHome === null ? null : { binary: codexBinary, home: codexHome },
    qwen: qwenBinary === null || qwenHome === null ? null : { binary: qwenBinary, home: qwenHome },
    pi: piBinary === null || piHome === null ? null : { binary: piBinary, home: piHome },
  };
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/** One trace line: `<clock> [channel] message — detail`. */
export type Logger = (channel: string, message: string, detail: string | null) => void;

/** What `readCredential` decided: the credential (or none), and, when the paired branch chose, the
 * host id the credential is bound to, which overrides the configured one at `link_hello`. */
export interface CredentialPosture {
  readonly credential: ControllerCredential | null;
  readonly pairedHostId: string | null;
}

/**
 * Which credential this host presents, or null when it presents none.
 *
 * The paired credential is preferred over the OIDC cache, and the preference is the point of
 * pairing: an OIDC refresh token can expire after a period of inactivity, the paired credential has
 * no clock. A machine that has run `periscope pair` dials on the paired credential even when a
 * token cache also exists. A missing paired file falls through to the OIDC postures; a corrupt one
 * is fatal rather than a fallback, because silently degrading to a maybe-dead refresh token would
 * put the host back in exactly the ambiguous posture pairing exists to end.
 *
 * The OIDC three-way decision itself lives in `identity/config.ts` and is tested there; this is the
 * wiring. A misconfiguration returns a string, which `runServe` treats as fatal: a host that was
 * told to use identity and cannot must not come up looking healthy while authenticating as nobody.
 *
 * The `absent` posture returns null rather than a refusing credential, which is the whole
 * difference between "no identity" and "no tool calls". `UnconfiguredCredential` refuses by name on
 * every call, and `escalatingDecider` treats a refusing credential as an outage and does not send
 * the request, so handing one to it would turn every escalation in every session into
 * `permission-decision-unavailable`. That is the exact outcome `readConfig` above refuses to ship
 * for the missing-URL case, in the same file, for the same stated reason: a host that comes up
 * healthy, accepts sessions, and blocks every tool call reads to an operator as the agent being
 * broken. Null means the option is omitted, which `EscalationOptions.credential` documents as the
 * supported no-identity mode; the placeholder stays the exported shape for an embedder that wants a
 * credential that says no out loud.
 */
export function readCredential(env: NodeJS.ProcessEnv, log: Logger): CredentialPosture | string {
  const pairedPath = pairedCredentialPath(env);
  if (pairedPath !== null) {
    const paired = new FilePairedCredential(pairedPath).read();
    if (paired.ok) {
      // The one posture line, matching the absent-case line in `runServe`: which credential this
      // host is on is otherwise invisible until the first refusal.
      log(
        'credential',
        `paired as ${paired.value.hostId} - the paired credential is presented on every dial`,
        null,
      );
      return { credential: new PairedHostCredential(paired.value), pairedHostId: paired.value.hostId };
    }
    if (paired.refusal.reason !== 'token-unavailable') {
      // Exists and is unreadable: fatal, loud, with the fix in the message (see the docblock).
      return paired.refusal.detail;
    }
    // token-unavailable = this machine has never been paired: the normal fall-through.
  }

  const posture = identityPosture(env);

  if (posture.kind === 'invalid') return posture.detail;
  if (posture.kind === 'absent') return { credential: null, pairedHostId: null };

  const cachePath = tokenCachePath(env);
  if (cachePath === null) {
    return 'identity is configured but there is nowhere to keep the token cache — set PERISCOPE_CONFIG_DIR';
  }

  const store = new FileTokenCache(cachePath);
  const config = posture.config;

  // The endpoints are resolved on first refresh, not at start-up. Discovery is a network call, and
  // making it at construction would mean this host refuses to start when the provider is briefly
  // unreachable, while holding a perfectly good cached token it could have presented. A host that
  // cannot start is worse than one that refreshes late.
  const refresh: TokenRefresher = async (cached) => {
    const endpoints = await resolveEndpoints(config);
    if (!endpoints.ok) return endpoints;
    return refresherFor(config, endpoints.value, store)(cached);
  };

  return {
    credential: new TokenCredential({
      store,
      config,
      // Loopback is the primary flow; the device-code fallback is a deliberate act, so a host running
      // unattended is configured for the one it will actually use.
      protocol: protocolFor(config),
      nowMs: systemTicker,
      refresh,
      // The one line that tells an operator which of the three happened. Without it a cache hit, a
      // silent refresh and "nobody ever signed in here" are the same silence, and the first difference
      // is a 401 the user reads as a server fault. `[credential] refused` names the one thing they can
      // act on, on the machine where they can act on it.
      report: (outcome) =>
        log(
          'credential',
          outcome.kind === 'refused' ? `refused — ${outcome.reason}` : outcome.kind,
          outcome.kind === 'refused' ? outcome.detail : null,
        ),
    }),
    pairedHostId: null,
  };
}

/**
 * Running as root is refused by policy.
 *
 * An unattended agent running as root has the whole machine on every tool call, and a container
 * built the obvious way runs as root. The gate decides which calls run; it does not shrink what a
 * call can reach once it runs, and as uid 0 that is everything.
 *
 * Checked first, before configuration, so the answer arrives as one line at startup rather than as
 * a session that can reach everything. A null `getuid` is win32, where the condition cannot arise.
 */
function rootRefusal(getuid: (() => number) | null): string | null {
  if (getuid === null) return null;
  if (getuid() !== 0) return null;
  return (
    'refusing to start as root: an unattended agent as uid 0 has the whole machine on every tool call. ' +
    'Run as a non-root user (add a USER line to your container).'
  );
}

/** Start the daemon. Returns the running host, or the refusal already written to stderr. */
export function runServe(views: ServeViews, deps: ServeDeps): ServeOutcome {
  const refuse = (detail: string): ServeOutcome => {
    deps.stderr(`periscope: ${detail}`);
    deps.setExitCode(1);
    return { ok: false, detail };
  };
  const log: Logger = (channel, message, detail) => {
    const line = detail === null ? message : `${message} — ${detail}`;
    deps.log(`${systemClock()} [${channel}] ${line}`);
  };

  const asRoot = rootRefusal(deps.getuid === undefined ? processUid() : deps.getuid);
  if (asRoot !== null) return refuse(asRoot);

  // The config file fills absences, and only absences; the merge is `main.ts`'s, shared by every
  // configuration-consuming verb, and a file that cannot be used is fatal rather than empty.
  const env = views.merged;
  if (typeof env === 'string') return refuse(env);

  const config = readConfig(env);
  if (typeof config === 'string') return refuse(config);

  // The workspace posture is screened at startup, by name. A default workspace key that fails
  // the union screen, or a branch scheme with a typo'd placeholder, would refuse every session,
  // and a machine that will refuse every session must say so when it boots, where the person who
  // can fix it is looking, not when someone finally opens a session.
  const workspaceMisconfiguration = workspacePostureProblem({
    workspaceRoot: config.workspaceRoot,
    repositoryRoot: config.repositoryRoot,
    branchScheme: config.branchScheme,
    workspaceKey: config.workspaceKey,
  });
  if (workspaceMisconfiguration !== null) return refuse(workspaceMisconfiguration);
  // The agent home names credential files the gate protects; a relative one means "relative to a cwd
  // nobody chose", so it is refused at start-up like every other posture problem.
  if (config.agentHome !== null && config.agentHome !== '' && !isAbsolutePath(config.agentHome)) {
    return refuse(`PERISCOPE_AGENT_HOME must be an absolute path — got '${config.agentHome}'`);
  }
  // A plugin directory is loaded into every session; one that is absent or carries no manifest is
  // refused at start-up by name. The agent would name it too, in a session's `plugin_errors`, but
  // only once that session was running; a host that will fail every session says so when it boots.
  const pluginDirs = parsePluginDirs(config.pluginDirs);
  const pluginProblem =
    pluginDirs.length > MAX_PLUGIN_DIRS
      ? `PERISCOPE_PLUGIN_DIRS names ${pluginDirs.length} directories; at most ${MAX_PLUGIN_DIRS}`
      : pluginDirsProblem(pluginDirs);
  if (pluginProblem !== null) return refuse(`PERISCOPE_PLUGIN_DIRS: ${pluginProblem}`);

  const raw = views.raw;

  // The model endpoints, read, checked and their credentials resolved now: an entry this host could
  // not honour would refuse every session that named it, so it refuses start instead, by name. An
  // `env` credential is read from the process environment as received.
  const endpoints = config.modelEndpoints === null ? null : readModelEndpoints(config.modelEndpoints, raw);
  if (typeof endpoints === 'string') return refuse(`PERISCOPE_MODEL_ENDPOINTS: ${endpoints}`);
  // The posture line leads the output and the credential lines follow it: the one-line summary
  // first, then the detail. The credential is read before the summary can be composed, so its
  // lines are held until the summary has printed.
  const held: Array<Parameters<Logger>> = [];
  const hold: Logger = (...line) => {
    held.push(line);
  };
  const posture = readCredential(raw, hold);
  if (typeof posture === 'string') return refuse(posture);
  const credential = posture.credential;
  if (credential === null) {
    // A legitimate posture, and a silent one until this line existed: a host with no identity
    // configured dials with no header, and "misconfigured to nobody" and "deliberately anonymous"
    // looked identical from the outside. Said once, at start-up, where the other two postures
    // already speak.
    hold(
      'credential',
      'absent - no identity is configured, so this host will dial without authentication',
      null,
    );
  }

  // A paired credential names its host, and the name wins. The controller refuses a link_hello
  // whose hostId differs from the credential's, so announcing anything else guarantees a closed
  // socket. Said out loud when the environment disagrees, because a silently ignored variable is a
  // misconfiguration nobody finds.
  const hostId = posture.pairedHostId ?? config.hostId;
  if (
    posture.pairedHostId !== null &&
    config.hostId !== posture.pairedHostId &&
    raw['PERISCOPE_HOST_ID'] !== undefined
  ) {
    hold(
      'credential',
      `PERISCOPE_HOST_ID ('${config.hostId}') is overridden by the paired credential's host id ('${posture.pairedHostId}')`,
      null,
    );
  }

  // An endpoint member no runtime reaching it reads is applied by nobody: said once, after the summary.
  for (const ignored of endpoints?.ignored ?? []) {
    report({ kind: 'endpoint-members-ignored', endpoint: ignored.endpoint, members: ignored.members }, hold);
  }
  for (const listed of endpoints?.unmappedAliases ?? []) {
    report({ kind: 'endpoint-aliases-unmapped', endpoint: listed.endpoint, aliases: listed.members }, hold);
  }

  // The one line status prints whole, from the same description, so the two cannot disagree.
  const reading = readConfigFile(raw);
  const cachePath = tokenCachePath(raw);
  const cached = cachePath === null ? null : new FileTokenCache(cachePath).read();
  log(
    'host',
    `periscope ${packageVersion()} · ` +
      postureLine(
        describePosture({
          raw,
          merged: env,
          fileValues: reading.problem === null ? reading.values : {},
          credential: posture,
          tokenExpiresAtMs: cached !== null && cached.ok ? cached.value.tokens.expiresAt : null,
          nowMs: Date.now(),
          link: null,
          pidAlive: () => false,
          hostname: readMachineFacts().hostname,
        }),
      ),
    null,
  );
  for (const line of held) log(...line);
  if (endpoints !== null) {
    log(
      'endpoints',
      `${endpoints.endpoints.length} model endpoint(s) declared` +
        (endpoints.endpoints.length === 0
          ? ''
          : `: ${endpoints.endpoints.map((one) => one.name).join(', ')}`),
      null,
    );
  }

  const workspaces = workspacesFor(config);
  const agentHome =
    config.agentHome === null || config.agentHome === '' ? defaultAgentHome(raw) : config.agentHome;
  const homeDir = raw['USERPROFILE'] ?? raw['HOME'] ?? '';

  // Declared before the host so the event callback can reach it: the callback runs only after
  // `start()` below, so the binding is always assigned by the time anything can fire.
  let host: PeriscopeHost | null = null;
  // Whether the fatal path has latched the exit code. A later signal must not reset it.
  let fatal = false;

  /**
   * The one event that ends this process unsuccessfully without anyone asking it to.
   *
   * Everything else this host reports is an observation. `credential_rejected` is a conclusion about
   * the host itself: the identity provider has refused its material and will keep refusing until a
   * person signs in, so there is nothing left for the process to do and staying up implies
   * otherwise. Without this, the link fails, no ref'd handle remains, node drains, and the process
   * exits zero, so a supervisor records a clean run and a dashboard shows a finished host that
   * never once connected.
   *
   * The exit code and the stderr line are both required, and they answer different readers. The
   * code is what a supervisor branches on; the line is what the person at the machine acts on. A
   * non-zero exit whose reason appears only in the stdout trace still leaves somebody reading logs.
   */
  // The catalog read starts the agent the way a session does: the same filtered environment, so the
  // same sign-in and the same models. It starts in the home directory and loads no settings there.
  const readCatalog = deps.readAgentCatalog;
  const agentCatalog =
    readCatalog === undefined
      ? undefined
      : () => readCatalog({ env: composeSpawnEnv(raw), cwd: homeDir, timeoutMs: AGENT_CATALOG_TIMEOUT_MS });
  // Codex, read the way a session starts it: the same filtered environment, the runner-owned home.
  const codexConfigured = config.codex;
  // Periscope's own hook in the Codex home: written and probed by the start-up read, and asked by every
  // Codex session's open whether it can run.
  const codexHook =
    codexConfigured === null
      ? null
      : (() => {
          const lines = codexHookLines(codexConfigured.home);
          const probeEnv = { ...composeSpawnEnv(raw), CODEX_HOME: codexConfigured.home };
          return pendingCodexHookState(lines, () =>
            probeCodexHook(lines, { env: probeEnv, version: packageVersion() }),
          );
        })();
  const codex =
    codexConfigured === null || codexHook === null
      ? null
      : {
          runtime: {
            binary: codexConfigured.binary,
            home: codexConfigured.home,
            clientVersion: packageVersion(),
            hook: codexHook,
          },
          read: async () => {
            const read = await (deps.readCodexRuntime ?? readCodexRuntime)({
              binary: codexConfigured.binary,
              home: codexConfigured.home,
              env: composeSpawnEnv(raw),
              clientVersion: packageVersion(),
              installHook: true,
            });
            codexHook.report(read.hook);
            if (read.hook !== undefined) {
              const problem = !read.hook.installed.ok
                ? read.hook.installed.refusal.detail
                : !read.hook.probed.ok
                  ? read.hook.probed.refusal.detail
                  : null;
              log(
                'codex',
                problem === null
                  ? `periscope's hook is written to ${codexHook.lines.hooksPath} and answered its probe`
                  : "periscope's hook cannot run yet: every Codex session's open tries again and is refused codex-hook-not-active while it cannot",
                problem,
              );
            }
            return read;
          },
        };

  // Qwen Code, read the way a session starts it: the same filtered environment, the runner-owned home.
  const qwenConfigured = config.qwen;
  const qwen =
    qwenConfigured === null
      ? null
      : {
          runtime: {
            binary: qwenConfigured.binary,
            base: qwenConfigured.home,
            operatorHome: homeDir,
          },
          read: () =>
            (deps.readQwenRuntime ?? readQwenRuntime)({
              binary: qwenConfigured.binary,
              base: qwenConfigured.home,
              env: composeSpawnEnv(raw),
            }),
        };

  // pi, read the way a session starts it: the same filtered environment, the runner-owned home, and the
  // endpoints a pi session may open on, written into its agent home.
  const piConfigured = config.pi;
  const pi =
    piConfigured === null
      ? null
      : {
          runtime: { binary: piConfigured.binary, base: piConfigured.home },
          read: () =>
            (deps.readPiRuntime ?? readPiRuntime)({
              binary: piConfigured.binary,
              base: piConfigured.home,
              env: composeSpawnEnv(raw),
              endpoints: piEndpointRoutes(endpoints === null ? [] : endpoints.endpoints),
            }),
        };

  let linkStateProblemSaid = false;
  const onEvent = (event: HostEvent): void => {
    if (event.kind === 'link') {
      // The record status reads. A disk that will not take it is said once and never stops the link.
      const problem = writeLinkState(raw, {
        state: event.transition.to,
        cause: event.transition.cause,
        at: event.transition.at,
        detail: event.transition.detail,
        negotiatedVersion: host?.link.negotiatedVersion ?? null,
        pid: process.pid,
      });
      if (problem !== null && !linkStateProblemSaid) {
        linkStateProblemSaid = true;
        log(
          'config',
          `the link state file is not being written; periscope status will read nothing — ${problem}`,
          null,
        );
      }
    }
    report(event, log);

    if (event.kind === 'link' && event.transition.cause === 'credential_rejected') {
      // The process exits now, live sessions included, and the count says what that cost. The
      // alternative (serve the survivors and exit when the last one ends) is declined: an idle
      // session never ends on its own, so that shape is a process that can stay up forever behind
      // a link that will never carry another frame, which is the quiet-death posture this file
      // exists to prevent. What the sessions produced stays in each agent's own record of it; the
      // one number on this line tells the operator whether work was cut mid-flight.
      const liveSessions = host?.registry.list().length ?? 0;
      // The remedy names the credential the host was actually on: a paired credential is revived by
      // re-pairing, not by signing in. Telling a paired operator to `login` sends them to a flow
      // whose token this host would not even present.
      const remedy =
        posture.pairedHostId !== null
          ? 'run: periscope pair <code> with a freshly minted code, then start this host again'
          : 'run: periscope login, then start this host again';
      deps.stderr(
        'periscope: the controller or its identity provider refused this credential ' +
          `(${liveSessions} live session(s) stopped) - ${remedy}`,
      );
      fatal = true;
      deps.setExitCode(1);
      host?.stop("this host's credential was refused");
      // Exit deliberately: draining is what lets a signal launder this failure. Latching the
      // code and letting the loop empty leaves a window in which node has released the loop but the
      // process still exists with its default signal dispositions restored; a SIGTERM landing there
      // terminates by signal, so the exit code arrives as null and a supervisor reads "killed"
      // rather than "failed", the exact laundering this terminal class exists to prevent. The
      // ref'd timer holds the loop open, which keeps the handlers below installed while the pipes
      // flush, and the explicit exit is then the only way this path can end. Node 22 on Linux
      // loses this race where node 24 wins it.
      setTimeout(() => deps.exit(1), FATAL_EXIT_FLUSH_MS);
    }
  };

  host = new PeriscopeHost({
    controllerUrl: config.controllerUrl,
    hostId,
    // Omitted, not nulled, when there is no identity. Both this option and the decision
    // transport's are optional by type, and omitting is the documented no-identity mode on each.
    // Spelling it as one spread keeps the two transports impossible to configure differently by
    // accident (one authenticated, one not).
    ...(credential === null ? {} : { credential }),
    // The same credential the link presents, on the decision POST. The surface that decides
    // whether a tool runs must not ship unauthenticated while the surface that merely reports is
    // authenticated.
    //
    // Per host, not per session, and the distinction is a design constraint rather than a detail:
    // one host serves many sessions, and this is read once from the environment, so nothing here can
    // authenticate as the particular session a decision is about. That is what
    // `DecisionRequest.sessionKey` is for: the controller attributes; the credential authenticates.
    //
    // And it is omitted when there is none, not passed as a credential that refuses. Passing one
    // that refuses does not make the request unauthenticated; it makes there be no request, on
    // every tool call, in every session. See `readCredential` above.
    decide: escalatingDecider({
      url: config.decisionUrl,
      transport: deps.transport ?? fetch,
      ...(credential === null ? {} : { credential }),
    }),
    // Derived, never spelled out here: `credentialPaths` is the one source both this and the token
    // cache's own location come from, so they cannot disagree about what is protected.
    protectedPaths: credentialPaths(raw, {
      agentHome,
      ...(endpoints === null ? {} : { modelEndpointFiles: endpoints.files }),
      ...(config.codex === null ? {} : { codexHome: config.codex.home }),
      ...(config.qwen === null ? {} : { qwenHome: config.qwen.home }),
      ...(config.pi === null ? {} : { piHome: config.pi.home }),
    }),
    // The agent's transcript folders, from the same sources and the same agent home as the set above:
    // the read doors refuse them whatever their root.
    transcriptPaths: agentTranscriptPaths(raw, { agentHome }),
    // The home the shell check expands `~` and `$HOME` to, from the same environment as the set above.
    home: homeDirectory(raw),
    // No transcript reader and no bulk resolver: this host does not look for, read or keep the
    // agent's transcripts, and serves no bulk content of its own. A transcript ask is answered
    // `transcripts-not-served`, and any other `bulk_request` `bulk-target-invalid`.
    ...(workspaces === null ? {} : { workspaces }),
    // The workspace mode rides the hello as capability markers, derived from the same config the
    // selector above consumed: the read half of what `periscope config` writes, and what lets a
    // controller verify a host is set up rather than trusting its operator's memory.
    linkCapabilities: workspaceCapabilitiesOf(config),
    // The values behind the markers, from the same reading: which roots, which scheme, which agent
    // home, which controller this process dialled.
    configuration: hostConfigurationOf(config, {
      controllerUrl: config.controllerUrl,
      decisionUrl: config.decisionUrl,
      agentHome,
      plugins: readPluginManifests(pluginDirs),
    }),
    // The directories themselves, for every open; the manifests above are what the hello says.
    pluginDirs,
    // What a controller may place in a spawn's environment: the operator's declaration, never the
    // controller's. Nothing declared means both lanes refuse every key.
    controllerEnvKeys: config.controllerEnvKeys,
    // The operator's model endpoints: offered in the hello by name, applied by this host to a session
    // that names one. Omitted when none are declared, so the hello lists none.
    ...(endpoints === null ? {} : { endpoints: endpoints.endpoints }),
    overriddenByEnvironment: overriddenByEnvironment(raw),
    // The configure seam: validates, writes the config file, rebuilds the provider. It reads
    // the raw environment because the file fills absences in it, and only this file may read that.
    // The addresses this process dialled ride in so a written URL is reported as pending rather than
    // applied: the live link is never re-pointed, the next start reads the file.
    reconfigure: (entries, hostBusy) =>
      reconfigureHost(raw, entries, hostBusy, {
        controllerUrl: config.controllerUrl,
        decisionUrl: config.decisionUrl,
        // The agent home the protected set above was built from; a written one waits for the next start.
        agentHome: config.agentHome === '' ? null : config.agentHome,
      }),
    // The default an unkeyed session_new resolves to, screened above at startup, so a bad
    // value died before this line. Omitted (not nulled) when unset: absence is the documented mode.
    ...(config.workspaceKey === null || config.workspaceKey === ''
      ? {}
      : { defaultWorkspaceKey: config.workspaceKey }),
    // The registry is the host's own unless a test supplies the process starter; then it is built
    // here over the same base environment and home the host would have used, and the pair goes to
    // the registry alone: the host refuses the two beside a registry, where nothing would read them.
    ...(deps.startProcess === undefined
      ? { baseEnv: raw, homeDir }
      : {
          registry: new SessionRegistry({
            baseEnv: raw,
            homeDir,
            startProcess: deps.startProcess,
            ...(codex === null && qwen === null && pi === null
              ? {}
              : {
                  runtimes: {
                    ...(codex === null ? {} : { [CODEX_RUNTIME]: codexNativeRuntime(codex.runtime) }),
                    ...(qwen === null ? {} : { [QWEN_RUNTIME]: qwenNativeRuntime(qwen.runtime) }),
                    ...(pi === null
                      ? {}
                      : {
                          [PI_RUNTIME]: piNativeRuntime({
                            ...pi.runtime,
                            endpoints: piEndpointRoutes(endpoints === null ? [] : endpoints.endpoints),
                          }),
                        }),
                  },
                }),
          }),
        }),
    ...(deps.link === undefined ? {} : { link: deps.link }),
    ...(agentCatalog === undefined ? {} : { agentCatalog }),
    ...(codex === null ? {} : { codex }),
    ...(qwen === null ? {} : { qwen }),
    ...(pi === null ? {} : { pi }),
    report: onEvent,
  });

  // A signal must leave the process in a state a supervisor can distinguish from a crash, so the
  // sessions and the link are closed deliberately and the exit code says which path was taken.
  const shutdown = (signal: string): void => {
    host?.stop(`received ${signal}`);
    // A signal does not erase a failure already recorded. If the credential was refused first,
    // that exit code stands: a supervisor stopping a host it has just been told is unusable must not
    // read its own stop as evidence the run was fine.
    if (!fatal) deps.setExitCode(0);
  };
  deps.onSignal('SIGTERM', () => shutdown('SIGTERM'));
  deps.onSignal('SIGINT', () => shutdown('SIGINT'));

  host.start();
  return { ok: true, host };
}

/** The process's effective-uid reader, or null where the platform has none. */
function processUid(): (() => number) | null {
  return process.getuid?.bind(process) ?? null;
}

/** Every named thing the host reports, as one line each. The only output this process produces. */
export function report(event: HostEvent, log: Logger): void {
  switch (event.kind) {
    case 'link':
      return log(
        'link',
        `${event.transition.from} -> ${event.transition.to} (${event.transition.cause})`,
        event.transition.detail,
      );
    case 'refusal':
      return log('refused', `${event.sessionKey ?? 'link'}: ${event.refusal.reason}`, event.refusal.detail);
    case 'gap':
      return log('gap', `${event.sessionKey} expected ${event.expected}, received ${event.received}`, null);
    case 'session-opened':
      return log('session', `${event.sessionKey} opened in ${event.cwd}`, null);
    case 'session-closed':
      return log('session', `${event.sessionKey} closed`, null);
    // The held-prompt queue's own trace. Without these the queue would work and nothing would say
    // so, and the gap between this pair is the measurement that a provisioning window was survived.
    case 'prompt-held':
      return log('held', `${event.sessionKey} a turn waits for the session to open`, `${event.held} held`);
    case 'prompt-delivered':
      return log('held', `${event.sessionKey} held turns delivered`, `${event.delivered} delivered`);
    case 'prompt-withdrawn':
      return log(
        'held',
        `${event.sessionKey} the controller cancelled before the session opened`,
        `${event.withdrawn} withdrawn`,
      );
    case 'transition':
      return log(
        'state',
        `${event.sessionKey} ${event.transition.from} -> ${event.transition.to} ` +
          `(${event.transition.cause.kind}/${event.transition.cause.event})`,
        event.transition.cause.detail,
      );
    case 'degrade':
      // The named conditions that change what is true of a session without ending it: an
      // untrusted workspace, an id collision. The detail is the operator's instruction and it
      // travels whole: the collision's detail is the only place "resume with fork" is ever said.
      return log('degrade', `${event.sessionKey} ${event.degrade.kind}`, event.degrade.detail);
    case 'agent-catalog':
      // What the hello tells a controller about the agent, said where the operator reads.
      return event.agent === null
        ? log('agent', 'the hello carries no model catalog', event.detail)
        : log(
            'agent',
            `Claude Code ${event.agent.claudeCodeVersion} (agent SDK ${event.agent.sdkVersion}), ` +
              `${event.agent.models.length} model(s) in the hello`,
            null,
          );
    case 'endpoint-aliases-unmapped':
      // An alias listed and not mapped is offered in the hello and refused when named: said once, so
      // the refusal is not the first anyone hears of it.
      return log(
        'endpoint',
        `${event.endpoint}: ${event.aliases.join(', ')} listed and not mapped`,
        'a session naming one is refused model-endpoint-mismatch; map it in "modelAliases" or remove it from "models"',
      );
    case 'endpoint-members-ignored':
      // A member no runtime reaching the endpoint reads: said once, so a file that states one is not
      // read as applying it.
      return log(
        'endpoint',
        `${event.endpoint}: ${event.members.join(', ')} ignored`,
        'no runtime that reaches this endpoint reads it',
      );
    case 'runtime-catalog':
      // A runtime beside Claude, said once: what the hello lists for it, and what is wrong, if anything.
      return log(
        event.runtime,
        event.entry.available
          ? `${event.entry.runtime} ${event.entry.version}, ${event.entry.models.length} model(s) in the hello, control tier ${event.entry.controlTier.level}`
          : `${event.entry.runtime} is listed unavailable`,
        event.detail,
      );
    default:
      return;
  }
}
