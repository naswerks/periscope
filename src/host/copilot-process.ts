/**
 * A Copilot session's process: one runtime per session, started and driven through `@github/copilot-sdk`,
 * presented to the session as an `AgentProcess` whose messages are `CopilotMessage`s.
 *
 * One runtime per session, so its home, its skill directories and its servers are its own, and stopping the
 * client ends exactly one session. What it holds to:
 *
 * - **The SDK is the operator's.** It is imported when the session opens, from the directory the operator
 *   installed it into at the pinned version (`copilot-sdk.ts`), and the runtime is started by its path inside
 *   that install, so no other runtime is ever resolved.
 * - **Nothing the runtime reads is discovered.** The client runs in `empty` mode, signed in as nobody
 *   (`useLoggedInUser: false`), its home a fresh directory under the runner's base (`copilot-home.ts`). The
 *   session is created with config discovery and custom instructions off, so a repository's own Copilot
 *   settings, instructions, servers and skills do not load; its skills are the plugin directories' alone,
 *   and its servers the ones the session attaches.
 * - **The environment holds no credential.** The runtime starts with the session's spawn environment less
 *   every GitHub token variable and every `COPILOT_` name, its caches pointed into the home. The runtime
 *   hands that environment whole to every command the agent runs, so a credential reaches it only over the
 *   SDK's own pipe: a GitHub token from the operator's token file (`gitHubTokenProvider`), read at each
 *   acquisition and given for `github.com` alone, or an endpoint's key in the session's `provider`. The
 *   variable that names another GitHub host (`GH_HOST`) is taken out of the runtime's environment too.
 * - **The open, proven before any prompt.** The session is created in the `manual` permission mode with
 *   this host's pre-tool hook and permission handler (`copilot-gate.ts`). Then the runtime is read back
 *   (`copilotReadBackProblem`), and one probe call is run through it: `view` on the session's own directory,
 *   under an id this host minted. Its hook must fire and its `hook` request reach this host, which refuses
 *   it, so nothing runs. Any other outcome refuses the open (`copilot-gate-not-active`) and no prompt is
 *   ever sent. A machine-wide policy hook is named at the open (`gate-hook-foreign`): the runtime is asked
 *   which it finds, on every platform, beside this host's own read of where one sits on Windows, and a
 *   source neither could read is named as one that may hold one.
 * - **Queue semantics.** A prompt is sent as it comes, queued behind any turn running (`enqueue`), up to
 *   `MAX_PENDING_PROMPTS` the runtime has not yet taken (`user.message`). Prompts that arrive before the open
 *   is proven are held, in order, and sent after.
 * - **Setters apply now.** The model and the effort are each the runtime's own call. The permission mode
 *   is Copilot's agent mode: `default` is `interactive` and `plan` is `plan`; nothing else is ever sent, and
 *   the permission mode stays `manual`. Copilot has no thinking switch, so a request to turn thinking off is
 *   refused by name.
 * - **Close.** Every decision still waiting is ended. What the runtime started is ended next, while the
 *   runtime and its shells are there to root the walk: the runtime ends a shell of its own without the
 *   command that shell is running, and a command left under a shell that is gone is under nothing a tree
 *   kill finds. Then the turn and its background sub-agents are ended while the hook and the permission
 *   handler still have their route, so a call that arrives as the turn winds down is refused here and
 *   never runs unasked. Only then is the session disconnected, the runtime's process tree ended by its
 *   pid, the client stopped, the session's state moved out of the home for a later resume, and the home
 *   removed. A turn that would not end is never disconnected while it runs: its tree is ended first.
 */
import type { RefusalReason } from '../core/refusal.js';
import { AsyncQueue } from '../core/async-queue.js';
import type { Result } from '../core/result.js';
import { COPILOT_EXCLUDED_TOOLS } from '../gate/tool-kind.js';
import type { AgentInitFacts, AgentProcess, AgentProcessRequest, ThinkingConfig } from './agent-process.js';
import { MAX_PENDING_PROMPTS, isRuntimeDefaultPrompt } from './agent-process.js';
import type { CopilotEndpointRoute } from './copilot-endpoints.js';
import { copilotProvider } from './copilot-endpoints.js';
import type { CopilotSessionGate } from './copilot-gate.js';
import type {
  CopilotAsked,
  CopilotPolicyLook,
  CopilotPostureRead,
  CopilotSessionHome,
} from './copilot-home.js';
import {
  carryCopilotStateIn,
  carryCopilotStateOut,
  copilotPolicyDetail,
  copilotPolicyDirectories,
  copilotPolicyHooks,
  copilotRuntimePolicyLook,
  mergeCopilotPolicyLooks,
  copilotOutsideDirectories,
  copilotReadBackProblem,
  copilotRuntimeEnv,
  copilotTokenProvider,
  createCopilotSessionHome,
  readCopilotPolicyKey,
} from './copilot-home.js';
import { copilotMcpServers } from './copilot-mcp.js';
import { copilotSkillDirectories } from './copilot-pack.js';
import type {
  CopilotClient,
  CopilotEvent,
  CopilotInstall,
  CopilotMcpServer,
  CopilotProvider,
  CopilotSdk,
  CopilotSession,
  CopilotSessionConfig,
  CopilotTokenAnswer,
  CopilotTokenRequest,
} from './copilot-sdk.js';
import {
  COPILOT_RUNTIME_PINNED_VERSION,
  copilotRuntimePid,
  loadCopilotSdk,
  onCopilotRuntimeExit,
  onCopilotRuntimeStderr,
  readCopilotInstall,
} from './copilot-sdk.js';
import type { CopilotMessage } from './copilot-wire.js';
import { copilotData, copilotRecord, copilotWord, isCopilotMainThread } from './copilot-wire.js';
import { killDescendants, killProcessTree } from './stdio-rpc.js';

/** The effort words a Copilot session takes: the runtime's reasoning efforts this host offers. */
export const COPILOT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The permission modes a Copilot session takes: `default` is the agent mode `interactive`, `plan` is `plan`. */
export const COPILOT_PERMISSION_MODES = ['default', 'plan'] as const;

/** How long the open may take, from the client's start to the probe's answer. */
export const COPILOT_OPEN_DEADLINE_MS = 60_000;
/** How long a setter, an abort or a read may take to be answered. */
export const COPILOT_CALL_DEADLINE_MS = 30_000;
/** How long the runtime has to say which policy hooks it finds, before the open goes on without its answer. */
export const COPILOT_POLICY_ASK_MS = 10_000;
/** How long each step of the close may take before the next one runs. */
export const COPILOT_CLOSE_GRACE_MS = 10_000;

/** What a Copilot runtime is configured with, beside each session's own request. */
export interface CopilotRuntimeConfig {
  /** `PERISCOPE_COPILOT_SDK`: the directory the operator installed the SDK into. */
  readonly sdk: string;
  /** `PERISCOPE_COPILOT_HOME`: the runner-owned base the sessions' homes and kept states live under. */
  readonly base: string;
  /** `PERISCOPE_COPILOT_TOKEN_FILE`: the file the GitHub token is read from, at each acquisition. */
  readonly tokenFile?: string | null;
  /** The operator's model endpoints a Copilot session may open on (`copilotEndpointRoutes`). */
  readonly endpoints?: readonly CopilotEndpointRoute[];
  /** How the install is checked; the default reads the operator's directory (`readCopilotInstall`). */
  readonly readInstall?: (directory: string) => Result<CopilotInstall>;
  /** How the SDK is loaded from a checked install; the default imports it (`loadCopilotSdk`). */
  readonly loadSdk?: (install: CopilotInstall) => Promise<Result<CopilotSdk>>;
  /**
   * The machine-wide policy hook sources this host reads itself; the default reads the policy directories
   * and the policy key, on Windows. The runtime is asked for its own account beside it on every platform.
   */
  readonly policyHooks?: () => Promise<CopilotPolicyLook>;
  readonly killTree?: (pid: number) => Promise<void>;
  /** How everything a running runtime started is ended, the runtime left running (`killDescendants`). */
  readonly killDescendants?: (pid: number) => Promise<void>;
  readonly closeGraceMs?: number;
  readonly openDeadlineMs?: number;
}

/** The init facts a Copilot session goes live on: the open, proven. */
export function copilotInitFacts(message: CopilotMessage): AgentInitFacts | null {
  if (message.kind !== 'opened') return null;
  return {
    sessionId: message.sessionId,
    cliVersion: COPILOT_RUNTIME_PINNED_VERSION,
    cwd: '',
    model: message.model ?? '',
    permissionMode: message.agentMode,
    apiKeySource: 'none',
    tools: message.tools,
    skills: [],
    plugins: [],
    capabilities: [],
    mcpServers: [],
  };
}

/** Why `request` cannot run on Copilot, or null. Members with no Copilot meaning are refused, never dropped. */
export function copilotRequestProblem(request: AgentProcessRequest): string | null {
  if (request.hooks !== null) {
    return "hooks: in-process Claude hook callbacks have no Copilot meaning; Copilot's gate is this host's own hook";
  }
  if (request.sessionStore !== null)
    return "sessionStore: Copilot keeps its own session state, in the session's home";
  if (request.sessionStoreFlush !== null) {
    return "sessionStoreFlush: Copilot keeps its own session state, in the session's home";
  }
  if (request.spawn !== null) {
    return "spawn: the agent SDK's spawner has no Copilot meaning; the Copilot SDK starts the runtime itself";
  }
  if (request.settingSources.length > 0) {
    return "settingSources: Claude's settings tiers; a Copilot session reads no settings of a workspace's or a user's";
  }
  if (request.strictMcpConfig === false) {
    return "strictMcpConfig: a Copilot session attaches the session's servers alone; config discovery stays off";
  }
  if (request.fork && request.resume === null) return 'fork: a fork names the session it forks in resume';
  const mode = request.permissionMode;
  if (mode !== null && !(COPILOT_PERMISSION_MODES as readonly string[]).includes(mode)) {
    return `permissionMode ${mode}: Copilot takes ${COPILOT_PERMISSION_MODES.join(', ')}`;
  }
  if (request.thinking !== null && request.thinking.type !== 'adaptive') {
    return 'thinking: Copilot has no thinking switch; its reasoning is set by the effort';
  }
  if (request.effort !== null && !(COPILOT_EFFORTS as readonly string[]).includes(request.effort)) {
    return `effort ${request.effort}: Copilot takes ${COPILOT_EFFORTS.join(', ')}`;
  }
  const prompt = request.systemPrompt;
  if (prompt !== null && !isRuntimeDefaultPrompt(prompt)) {
    return "systemPrompt: Copilot takes the runtime-default preset's append; replacing its base prompt removes the runtime's own guardrails";
  }
  return null;
}

/** What a session's configuration is composed from, beside its request. */
export interface CopilotSessionParts {
  readonly gate: CopilotSessionGate;
  readonly servers: Readonly<Record<string, CopilotMcpServer>>;
  readonly skillDirectories: readonly string[];
  readonly model: string | null;
  readonly provider: CopilotProvider | null;
  readonly tokenProvider: ((request: CopilotTokenRequest) => Promise<CopilotTokenAnswer>) | null;
  readonly onEvent: (event: CopilotEvent) => void;
  /** Every permission request is answered here; the signal ends what is still waiting at close. */
  readonly signal: AbortSignal;
}

/**
 * The session's configuration: every built-in and every attached server's tools offered, less the tools this
 * host turns off; the `manual` permission mode; no configuration of the workspace's or the user's; the
 * session's skills, servers, model, effort and prompt append; the hook and the permission handler.
 */
export function copilotSessionConfig(
  request: AgentProcessRequest,
  parts: CopilotSessionParts,
): CopilotSessionConfig {
  const prompt = request.systemPrompt;
  const append = isRuntimeDefaultPrompt(prompt) ? (prompt.append ?? '') : '';
  const servers = { ...parts.servers };
  return {
    workingDirectory: request.cwd,
    availableTools: ['builtin:*', 'mcp:*'],
    excludedTools: COPILOT_EXCLUDED_TOOLS.map((tool) => `builtin:${tool}`),
    permissionMode: 'manual',
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    // The runtime's own session telemetry, on by default for a signed-in or endpoint session, stays off.
    enableSessionTelemetry: false,
    enableSkills: parts.skillDirectories.length > 0,
    ...(parts.skillDirectories.length === 0 ? {} : { skillDirectories: [...parts.skillDirectories] }),
    ...(Object.keys(servers).length === 0 ? {} : { mcpServers: servers }),
    streaming: request.includePartialMessages,
    includeSubAgentStreamingEvents: request.forwardSubagentText,
    ...(append === '' ? {} : { systemMessage: { mode: 'append', content: append } }),
    ...(parts.model === null ? {} : { model: parts.model }),
    ...(request.effort === null ? {} : { reasoningEffort: request.effort }),
    ...(parts.provider === null ? {} : { provider: parts.provider }),
    ...(parts.tokenProvider === null ? {} : { gitHubTokenProvider: parts.tokenProvider }),
    hooks: {
      onPreToolUse: (input) => parts.gate.preToolUse(input),
      // An observation only: the hook that gates is the pre-tool hook, and this one answers nothing.
      onSessionStart: () => undefined,
    },
    onPermissionRequest: (asked) => parts.gate.decide(asked, parts.signal),
    onEvent: parts.onEvent,
  };
}

/** `promise`, or a rejection naming `what` once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms}ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** `error`'s words. */
function wordsOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The machine-wide policy hook sources this host reads itself, read the default way. */
function defaultPolicyHooks(): Promise<CopilotPolicyLook> {
  return copilotPolicyHooks({
    directories: copilotPolicyDirectories(),
    ...(process.platform === 'win32' ? { registryHolds: readCopilotPolicyKey } : {}),
  });
}

/** What `ask` answered within `ms`, or why it gave no answer. Never throws. */
async function asked(ask: () => Promise<unknown>, ms: number, what: string): Promise<CopilotAsked> {
  try {
    return { answer: await within(ask(), ms, what) };
  } catch (error) {
    return { failed: wordsOf(error) };
  }
}

/**
 * The runtime's own account of the policy hooks it would run: its hook discovery, less the user's and the
 * plugins' rows, and its read of the machine's managed settings. Asked of a started client, on every
 * platform.
 */
async function runtimePolicyHooks(client: CopilotClient, ms: number): Promise<CopilotPolicyLook> {
  const [discovered, managed] = await Promise.all([
    asked(() => client.rpc.hooks.discover({ excludeHostHooks: true }), ms, "the runtime's hook discovery"),
    asked(() => client.rpc.managedSettings.read(), ms, "the runtime's read of the managed settings"),
  ]);
  return copilotRuntimePolicyLook(discovered, managed);
}

/** Read the runtime's posture: the reads `copilotReadBackProblem` holds to what was asked. */
async function readPosture(session: CopilotSession): Promise<CopilotPostureRead> {
  const rpc = session.rpc;
  const [permission, agentMode, allowAll, paths, plugins] = await Promise.all([
    rpc.permissions.getMode(),
    rpc.mode.get(),
    rpc.permissions.getAllowAll(),
    rpc.permissions.paths.list(),
    rpc.plugins.list(),
  ]);
  let metadata = await rpc.tools.getCurrentMetadata();
  if (metadata.tools === null) {
    // The runtime builds its tool list lazily; asked to, it builds it now, before the first prompt.
    await rpc.tools.initializeAndValidate();
    metadata = await rpc.tools.getCurrentMetadata();
  }
  const offered = metadata.tools ?? [];
  return {
    permissionModeResult: session.permissionModeResult ?? null,
    permissionMode: permission.mode,
    agentMode,
    allowAll,
    paths,
    plugins: plugins.plugins,
    offeredTools: offered.map((tool) => tool.name),
    offeredServerTools: offered.flatMap((tool) =>
      typeof tool.mcpServerName === 'string' && tool.mcpServerName !== ''
        ? [
            {
              name: tool.name,
              server: tool.mcpServerName,
              ...(typeof tool.mcpToolName === 'string' && tool.mcpToolName !== ''
                ? { tool: tool.mcpToolName }
                : {}),
            },
          ]
        : [],
    ),
  };
}

/**
 * Start one Copilot session's runtime. Never throws: what cannot run ends the session by name. `writeRoots`
 * are the session's further write roots, which the runtime's allowed directories may name.
 */
export function startCopilotProcess(
  request: AgentProcessRequest,
  runtime: CopilotRuntimeConfig,
  degrade: (detail: string) => void = () => undefined,
  endpoint: string | null = null,
  gate: CopilotSessionGate | null = null,
  writeRoots: readonly string[] = [],
): AgentProcess<CopilotMessage> {
  const output = new AsyncQueue<CopilotMessage>();
  const decisions = new AbortController();
  const grace = runtime.closeGraceMs ?? COPILOT_CLOSE_GRACE_MS;
  let failure: Error | null = null;
  let closed = false;
  let opened = false;
  let closing: Promise<void> | null = null;
  const held: string[] = [];
  let outstanding = 0;
  let home: CopilotSessionHome | null = null;
  let client: CopilotClient | null = null;
  let live: CopilotSession | null = null;
  let sessionId: string | null = null;
  // Set when the runtime's process exits on its own: there is then no turn to end and no tree to end by its id.
  let runtimeExited: string | null = null;
  let startModel: string | null = null;
  // The open's probe call, and the hook runs and requests its events carry, so none of them rides on.
  let probeId: string | null = null;
  const probeHooks = new Set<string>();
  const probeRequests = new Set<string>();

  const route =
    endpoint === null ? null : ((runtime.endpoints ?? []).find((one) => one.name === endpoint) ?? null);
  const agentMode = request.permissionMode === 'plan' ? 'plan' : 'interactive';
  const skills = copilotSkillDirectories((request.plugins ?? []).map((plugin) => plugin.path));
  const servers = copilotMcpServers(request.mcpServers);
  const resumeId = request.resume;
  const model = request.model ?? (route === null ? null : (route.models[0] ?? null));
  const problem = ((): string | null => {
    if (endpoint !== null && route === null) {
      return `endpoint-unknown: ${endpoint} is not one this Copilot runtime routes`;
    }
    const found = copilotRequestProblem(request);
    if (found !== null) return `request-key-unsupported: ${found}`;
    if (!servers.ok) return `${servers.refusal.reason}: ${servers.refusal.detail}`;
    if (route !== null && model !== null && !route.models.includes(model)) {
      return `request-key-unsupported: model ${model} is not one the endpoint ${route.name} lists`;
    }
    if (gate === null)
      return 'copilot-gate-not-active: this session has no gate, so no call could be decided';
    return null;
  })();

  const fail = (detail: string): void => {
    if (failure === null) failure = new Error(detail);
    void shutDown();
  };

  function removeHome(): void {
    const removing = home;
    home = null;
    if (removing === null) return;
    const removed = removing.remove();
    if (!removed.ok) degrade(removed.refusal.detail);
  }

  function isProbeEvent(event: CopilotEvent): boolean {
    if (probeId === null) return false;
    const data = copilotData(event);
    switch (event.type) {
      case 'hook.start': {
        const calls = copilotRecord(data['input'])['toolCalls'];
        const named =
          copilotRecord(data['input'])['toolCallId'] === probeId ||
          (Array.isArray(calls) && calls.some((call) => copilotRecord(call)['id'] === probeId));
        const id = copilotWord(data['hookInvocationId']);
        if (named && id !== null) probeHooks.add(id);
        return named;
      }
      case 'hook.end':
        return probeHooks.has(copilotWord(data['hookInvocationId']) ?? '');
      case 'permission.requested': {
        const named = copilotRecord(data['permissionRequest'])['toolCallId'] === probeId;
        const id = copilotWord(data['requestId']);
        if (named && id !== null) probeRequests.add(id);
        return named;
      }
      case 'permission.completed':
        return data['toolCallId'] === probeId || probeRequests.has(copilotWord(data['requestId']) ?? '');
      default:
        return data['toolCallId'] === probeId;
    }
  }

  function onEvent(event: CopilotEvent): void {
    try {
      gate?.observe(event);
    } catch {
      // A degrade the gate failed to name must not stop the event reaching the session.
    }
    if (isProbeEvent(event)) return;
    // The session's own start names its model; a sub-agent's start is the sub-agent's.
    if ((event.type === 'session.start' || event.type === 'session.resume') && isCopilotMainThread(event)) {
      startModel = copilotWord(copilotData(event)['selectedModel']) ?? startModel;
    }
    if (event.type === 'user.message' && isCopilotMainThread(event)) {
      outstanding = Math.max(0, outstanding - 1);
    }
    // Idle means the runtime's queue is empty: a prompt it dropped on a failed run is pending no longer.
    if (event.type === 'session.idle' && isCopilotMainThread(event)) outstanding = 0;
    output.push({ kind: 'event', event });
  }

  async function open(): Promise<void> {
    if (gate === null) return;
    const deadline = runtime.openDeadlineMs ?? COPILOT_OPEN_DEADLINE_MS;
    const install = (runtime.readInstall ?? readCopilotInstall)(runtime.sdk);
    if (!install.ok) return fail(`${install.refusal.reason}: ${install.refusal.detail}`);
    const sdk = await (runtime.loadSdk ?? loadCopilotSdk)(install.value);
    if (!sdk.ok) return fail(`${sdk.refusal.reason}: ${sdk.refusal.detail}`);
    if (closed) return;

    const made = createCopilotSessionHome(runtime.base);
    if (!made.ok) return fail(`${made.refusal.reason}: ${made.refusal.detail}`);
    home = made.value;
    if (resumeId !== null) {
      const carried = carryCopilotStateIn(runtime.base, home.home, resumeId);
      if (!carried.ok) return fail(`${carried.refusal.reason}: ${carried.refusal.detail}`);
    }
    const env = copilotRuntimeEnv(request.env, home.env);
    // The SDK adds the home itself; the local gate reads it as the path it is.
    gate.spawnedWith({ ...env, COPILOT_HOME: home.home });
    const onMachine = await (runtime.policyHooks ?? defaultPolicyHooks)().catch(
      (error: unknown): CopilotPolicyLook => ({
        found: [],
        unread: [`this host's own look (${wordsOf(error)})`],
      }),
    );
    if (closed) return;

    const started = new sdk.value.CopilotClient({
      mode: 'empty',
      useLoggedInUser: false,
      baseDirectory: home.home,
      workingDirectory: request.cwd,
      logLevel: 'error',
      connection: sdk.value.RuntimeConnection.forStdio({ path: install.value.runtime, env }),
    });
    client = started;
    await within(started.start(), deadline, "the Copilot runtime's start");
    onCopilotRuntimeExit(started, (detail) => {
      runtimeExited ??= detail;
      if (!closed && failure === null) failure = new Error(`the Copilot runtime exited (${detail})`);
      if (!closed) void shutDown();
    });
    // What the runtime writes to its standard error reaches the session's own lane, as every runtime's does.
    const stderr = request.onStderr;
    if (stderr !== null) onCopilotRuntimeStderr(started, (text) => stderr(text));
    if (closed) return;
    const policy = copilotPolicyDetail(
      mergeCopilotPolicyLooks(
        onMachine,
        await runtimePolicyHooks(started, Math.min(deadline, COPILOT_POLICY_ASK_MS)),
      ),
    );
    gate.stateSpawnDegrades(policy === null ? [] : [{ name: 'gate-hook-foreign', detail: policy }]);
    if (closed) return;

    const config = copilotSessionConfig(request, {
      gate,
      servers: servers.ok ? servers.value : {},
      skillDirectories: skills.directories,
      model,
      provider: route === null ? null : copilotProvider(route),
      tokenProvider:
        route === null && runtime.tokenFile !== undefined && runtime.tokenFile !== null
          ? copilotTokenProvider(runtime.tokenFile, undefined, (host) =>
              degrade(
                `the Copilot runtime asked for a GitHub token for ${host === '' ? 'a host it did not name' : host}; the operator's token is given for github.com alone, so none was given`,
              ),
            )
          : null,
      onEvent,
      signal: decisions.signal,
    });
    let session: CopilotSession;
    if (resumeId === null) {
      session = await within(started.createSession(config), deadline, "the Copilot session's create");
    } else if (request.fork) {
      const forked = await within(started.rpc.sessions.fork({ sessionId: resumeId }), deadline, 'the fork');
      session = await within(started.resumeSession(forked.sessionId, config), deadline, 'the forked resume');
    } else {
      session = await within(started.resumeSession(resumeId, config), deadline, 'the resume');
    }
    live = session;
    sessionId = session.sessionId;
    gate.identify(session.sessionId);
    if (closed) return;
    if (agentMode === 'plan') await within(session.rpc.mode.set({ mode: 'plan' }), deadline, 'the plan mode');

    // The posture, read back before the first prompt.
    const read = await within(readPosture(session), deadline, "the runtime's read-back");
    const posture = { agentMode, cwd: request.cwd, writeRoots, home: home?.home ?? '' };
    const unread = copilotReadBackProblem(read, posture);
    if (unread !== null) return refuseOpen('copilot-gate-not-active', unread);
    // A directory the runtime allows that is none of the session's is named, and the session opens: the
    // runtime's list bounds no write, since the hook asks about every call and this host's gate holds a
    // write to the session's write limits.
    const outside = copilotOutsideDirectories(read, posture);
    if (outside.length > 0) {
      gate.raise(
        'gate-mode-widened',
        `the runtime allows directories outside the session's roots: ${outside.join(', ')}; a write is still held to the session's write limits by this host's gate`,
        'directories',
      );
    }
    // A built-in the tables do not name is named, once, and the session opens: its calls ask like any other.
    gate.toolsOffered(
      read.offeredTools,
      (read.offeredServerTools ?? []).map((tool) => tool.name),
    );
    // Each attached server's tools, as the runtime has just listed them: a call to one is spelled from these,
    // and the runtime is asked again only for a server that had listed none yet.
    const brought = new Map<string, string[]>();
    for (const tool of read.offeredServerTools ?? []) {
      if (tool.tool !== undefined) brought.set(tool.server, [...(brought.get(tool.server) ?? []), tool.tool]);
    }
    for (const [server, tools] of brought) gate.serverTools(server, tools);
    gate.useToolLister(async (server) => {
      const listed = await within(
        session.rpc.mcp.listTools({ serverName: server }),
        COPILOT_CALL_DEADLINE_MS,
        `server ${server}'s tool list`,
      );
      return listed.tools.map((tool) => tool.name);
    });

    // The route, proven: one call through the hook and the request both, refused here, never run.
    const probe = gate.probe();
    probeId = probe.id;
    const result = await within(
      session.rpc.tools.execute({ name: 'view', arguments: { path: request.cwd }, toolCallId: probe.id }),
      deadline,
      "the open's probe call",
    );
    const reach = probe.reach();
    const resultType = copilotRecord(result)['resultType'];
    const missing =
      reach.otherKind !== null
        ? `the probe call reached this host as a ${reach.otherKind} request, through the runtime's own flow rather than the pre-tool hook`
        : !reach.hooked
          ? 'the pre-tool hook did not fire for the probe call'
          : !reach.asked
            ? "the probe call's hook request did not reach this host"
            : resultType !== 'denied'
              ? `the probe call this host refused ended ${typeof resultType === 'string' ? resultType : 'with no result type'}, not denied`
              : null;
    if (missing !== null) return refuseOpen('copilot-gate-not-active', missing);
    if (closed) return;

    opened = true;
    output.push({
      kind: 'opened',
      sessionId: session.sessionId,
      model: startModel ?? model,
      agentMode: read.agentMode,
      tools: read.offeredTools,
      origin: resumeId === null ? 'new' : request.fork ? 'fork' : 'resume',
    });
    for (const text of held.splice(0)) send(text);
  }

  function refuseOpen(reason: RefusalReason, detail: string): void {
    gate?.raise(reason, detail, 'open');
    fail(`${reason}: ${detail}`);
  }

  function send(text: string): void {
    const session = live;
    if (session === null) {
      degrade('a prompt was not sent: the session is not open');
      return;
    }
    outstanding += 1;
    session.send({ prompt: text, mode: 'enqueue' }).catch((error: unknown) => {
      outstanding = Math.max(0, outstanding - 1);
      degrade(`a prompt was not sent: ${wordsOf(error)}`);
    });
  }

  function shutDown(): Promise<void> {
    closing ??= (async () => {
      closed = true;
      held.length = 0;
      decisions.abort();
      const session = live;
      live = null;
      // The turn ends first, while the hook and the handler still have their route. The runtime lets a call
      // proceed when its hook has none, so a session disconnected under a running turn could run a call
      // nobody was asked about; a call that arrives here instead is asked, and refused, since every
      // decision was just ended.
      let turnEnded = true;
      // A runtime that exited on its own has no turn to end, and its id names nothing of this session's
      // any more: the system may have given the number to another process. What it had started is not
      // reachable through it, and that is said rather than acted on.
      const exited = runtimeExited;
      if (exited !== null) {
        degrade(
          `the Copilot runtime exited on its own (${exited}), so this host ended no process tree by its id: a command or a server it had started may still be running`,
        );
      }
      // What the runtime started goes before the turn does. Ending the turn makes the runtime end its
      // shells, each without the command it is running: on Windows such a command is then the child of a
      // process that is gone, which no walk from the runtime finds, and elsewhere it is reparented.
      const running = client === null || exited !== null ? null : copilotRuntimePid(client);
      if (running !== null)
        await (runtime.killDescendants ?? killDescendants)(running).catch(() => undefined);
      if (session !== null && exited === null) {
        turnEnded = await within(
          Promise.all([session.abort(), session.rpc.cancelAllBackgroundAgents()]),
          grace,
          "the turn's end",
        ).then(
          () => true,
          (error: unknown) => {
            degrade(`the turn was not ended before the close: ${wordsOf(error)}`);
            return false;
          },
        );
      }
      const stopping = client;
      client = null;
      // The tree, while the runtime still roots it: whatever it started since ends with it.
      const endTree = async (): Promise<void> => {
        const pid = stopping === null || exited !== null ? null : copilotRuntimePid(stopping);
        if (pid !== null) await (runtime.killTree ?? killProcessTree)(pid).catch(() => undefined);
      };
      // A turn that would not end is never disconnected while it runs: its tree goes first.
      if (!turnEnded) await endTree();
      else if (session !== null && exited === null) {
        await within(session.disconnect(), grace, "the session's disconnect").catch((error: unknown) =>
          degrade(`the session did not disconnect: ${wordsOf(error)}`),
        );
      }
      if (stopping !== null) {
        if (turnEnded) await endTree();
        await within(stopping.forceStop(), grace, "the client's stop").catch((error: unknown) =>
          degrade(`the Copilot client did not stop: ${wordsOf(error)}`),
        );
      }
      if (home !== null && sessionId !== null) {
        const kept = carryCopilotStateOut(runtime.base, home.home, sessionId);
        if (!kept.ok) degrade(kept.refusal.detail);
      }
      removeHome();
      output.end();
    })();
    return closing;
  }

  async function call(what: string, run: (session: CopilotSession) => Promise<unknown>): Promise<void> {
    if (closed) return;
    const session = live;
    if (session === null || !opened) throw new Error(`${what}: the Copilot session is not open yet`);
    await within(run(session), COPILOT_CALL_DEADLINE_MS, what);
  }

  if (problem !== null) {
    failure = new Error(problem);
    void Promise.resolve().then(() => output.end());
  } else {
    void Promise.resolve()
      .then(() => open())
      .catch((error: unknown) =>
        fail(`runtime-unavailable: the Copilot session could not open: ${wordsOf(error)}`),
      );
  }

  async function* messages(): AsyncGenerator<CopilotMessage, void> {
    for await (const message of output) yield message;
    if (failure !== null) throw failure;
  }

  return {
    messages: messages(),
    prompt(text: string): boolean {
      if (closed || problem !== null || held.length + outstanding >= MAX_PENDING_PROMPTS) return false;
      if (!opened) held.push(text);
      else send(text);
      return true;
    },
    async interrupt(): Promise<void> {
      if (closed || !opened || live === null) return;
      // The turn's waiting decisions end with it: the runtime runs none of those calls, so none may be
      // answered later as if it had.
      gate?.endPending('the turn was interrupted while this decision was outstanding');
      await within(live.abort(), COPILOT_CALL_DEADLINE_MS, 'the abort').catch((error: unknown) =>
        degrade(`the turn was not aborted: ${wordsOf(error)}`),
      );
    },
    async setModel(selected: string | null): Promise<void> {
      const next = selected ?? model;
      if (next === null) return;
      if (route !== null && !route.models.includes(next)) {
        throw new Error(`model ${next} is not one the endpoint ${route.name} lists`);
      }
      await call('the model', (session) => session.setModel(next));
    },
    async setPermissionMode(requested: string): Promise<void> {
      if (!(COPILOT_PERMISSION_MODES as readonly string[]).includes(requested)) {
        throw new Error(`Copilot takes ${COPILOT_PERMISSION_MODES.join(', ')}, not ${requested}`);
      }
      const mode = requested === 'plan' ? 'plan' : 'interactive';
      await call('the agent mode', (session) => session.rpc.mode.set({ mode }));
    },
    setThinking(thinking: ThinkingConfig): Promise<void> {
      if (thinking.type === 'adaptive') return Promise.resolve();
      return Promise.reject(new Error('Copilot has no thinking switch; its reasoning is set by the effort'));
    },
    async setEffort(level: string): Promise<void> {
      if (!(COPILOT_EFFORTS as readonly string[]).includes(level)) {
        throw new Error(`Copilot takes ${COPILOT_EFFORTS.join(', ')}, not ${level}`);
      }
      await call('the effort', (session) => session.rpc.model.setReasoningEffort({ reasoningEffort: level }));
    },
    pluginsApplied(): Promise<boolean | null> {
      // The runtime reports the skills it loaded (`session.skills_loaded`), which the receipt carries; it
      // gives no answer for the set as a whole.
      return Promise.resolve(null);
    },
    close(): void {
      if (closed) return;
      void shutDown();
    },
  };
}
