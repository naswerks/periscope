/**
 * A Qwen Code session's process: one `qwen` CLI per session, driven over its stream-json control
 * protocol, presented to the session as an `AgentProcess` whose messages are `QwenMessage`s.
 *
 * One process per session, so the session's settings, its home and its skill directories are its own,
 * and closing the CLI's input ends exactly one session. What it holds to:
 *
 * - **The settings, before anything runs.** The session's home is written first (`qwen-home.ts`), with
 *   an ask rule for every built-in tool and every attached server, and read back. A file that does not
 *   read back whole refuses the open (`qwen-ask-rules-not-active`) before the CLI is started.
 * - **The opening.** `initialize` is the first line the CLI reads: without it the CLI runs in a mode
 *   with no control requests at all, where an asked call is never answered. It carries the permission
 *   timeout, above this host's decision deadline; the effort; and the MCP servers, so their headers ride
 *   the CLI's input rather than its command line. Its answer names the session's id, and the session goes
 *   live on it. Prompts that arrive before it are held, in order, and written after.
 * - **The environment.** The CLI runs with the session's spawn environment and the home's variables,
 *   never this host's own environment. It is told not to restart itself under a supervisor, so the child
 *   this host ends is the one that runs the tools. A variable that would drop every permission rule
 *   (`QWEN_CODE_SAFE_MODE`) is never passed.
 * - **Queue semantics.** The CLI queues a prompt that arrives during a turn and runs it after, so each
 *   prompt is written as it comes, up to `MAX_PENDING_PROMPTS` not yet answered by a result.
 * - **Setters apply now.** The model, the permission mode and the effort are each a control request
 *   the CLI applies at once. Only Qwen's `default` and `plan` are ever sent. Qwen Code has no thinking
 *   switch, so a request to turn thinking off or on is refused by name.
 * - **Every request from the CLI is answered.** A permission request is decided by the session's gate;
 *   with no gate it is denied. Anything else is answered with an error.
 */
import type { JsonObject } from '../control/frames.js';
import { AsyncQueue } from '../core/async-queue.js';
import type { Refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { DEFAULT_DECISION_TIMEOUT_MS } from '../gate/gate.js';
import type { AgentInitFacts, AgentProcess, AgentProcessRequest, ThinkingConfig } from './agent-process.js';
import { MAX_PENDING_PROMPTS, isRuntimeDefaultPrompt } from './agent-process.js';
import type { SpawnDegrade } from './codex-gate.js';
import { QWEN_PINNED_VERSION, qwenCommand } from './qwen-binary.js';
import type { QwenControlAnswer } from './qwen-control.js';
import { QwenControl } from './qwen-control.js';
import type { QwenEndpointRoute } from './qwen-endpoints.js';
import { qwenEndpointArgs, qwenSettingsAuth } from './qwen-endpoints.js';
import type { QwenSessionGate } from './qwen-gate.js';
import { qwenPermissionTimeoutMs } from './qwen-gate.js';
import type { QwenSessionHome } from './qwen-home.js';
import {
  QWEN_SAFE_MODE_VARIABLE,
  createQwenSessionHome,
  inheritedEnvFiles,
  readBackQwenSettings,
} from './qwen-home.js';
import { qwenMcpServers } from './qwen-mcp.js';
import { qwenSkillDirectories } from './qwen-pack.js';
import type { QwenHostRequest, QwenMessage } from './qwen-wire.js';
import { InitializeAnswer, SystemInit, parsed, qwenMessageKey } from './qwen-wire.js';
import type { SpawnChild } from './stdio-rpc.js';
import type { QwenPermissionMode } from './wire-request.js';
import { QWEN_MODE_MAP, QWEN_PERMISSION_MODES, isQwenPermissionMode } from './wire-request.js';

/** How long `initialize` may take to be answered: the CLI answers it before it loads its configuration. */
export const QWEN_HANDSHAKE_DEADLINE_MS = 60_000;
/** How long a setter, an interrupt or a context-usage read may take to be answered. */
export const QWEN_CONTROL_DEADLINE_MS = 30_000;
/**
 * The longest system-prompt text this host passes, in characters. It rides the CLI's command line,
 * which Windows bounds at 32,767 characters whole.
 */
export const QWEN_MAX_PROMPT_ARGUMENT_CHARS = 16_384;
/**
 * The server name `--allowed-mcp-server-names` carries when the session attaches none and takes no
 * other: a name no server carries, so the filter admits none.
 */
export const QWEN_NO_SERVER = 'periscope-attaches-none';

/** What a Qwen Code runtime is configured with, beside each session's own request. */
export interface QwenRuntimeConfig {
  /** `PERISCOPE_QWEN_BIN`: the CLI's JavaScript entry, or a program that runs it. */
  readonly binary: string;
  /** `PERISCOPE_QWEN_HOME`: the runner-owned base the sessions' homes are written under. */
  readonly base: string;
  /** The operator's home directory, where the `.env` files the CLI loads whatever its home live. */
  readonly operatorHome: string;
  /** How the CLI is started; the default starts it with no shell. */
  readonly spawn?: SpawnChild;
  readonly killTree?: (pid: number) => Promise<void>;
  readonly closeGraceMs?: number;
  /** The operator's model endpoints a Qwen Code session may open on (`qwenEndpointRoutes`). */
  readonly endpoints?: readonly QwenEndpointRoute[];
  /** How the session's settings are read back; the default reads the file. */
  readonly readSettings?: (path: string) => string;
}

/** The init facts a Qwen Code session goes live and refreshes on: the `initialize` answer, then each init. */
export function qwenInitFacts(message: QwenMessage): AgentInitFacts | null {
  if (message.kind === 'answer') {
    if (message.subtype !== 'initialize') return null;
    const answer = parsed(InitializeAnswer, message.response);
    if (answer === null) return null;
    return {
      sessionId: answer.session_id,
      cliVersion: QWEN_PINNED_VERSION,
      cwd: '',
      model: '',
      permissionMode: '',
      apiKeySource: 'none',
      tools: [],
      skills: [],
      plugins: [],
      capabilities: [],
      mcpServers: [],
    };
  }
  if (message.kind !== 'message') return null;
  const init = parsed(SystemInit, message.message);
  if (init === null) return null;
  return {
    sessionId: init.session_id,
    cliVersion: init.qwen_code_version ?? QWEN_PINNED_VERSION,
    cwd: init.cwd ?? '',
    model: init.model ?? '',
    permissionMode: init.permission_mode ?? '',
    apiKeySource: 'none',
    tools: init.tools ?? [],
    skills: [],
    plugins: [],
    capabilities: [],
    mcpServers: (init.mcp_servers ?? []).map((server) => ({ name: server.name, status: server.status })),
  };
}

/** Why `request` cannot run on Qwen Code, or null. Members with no Qwen Code meaning are refused, never dropped. */
export function qwenRequestProblem(request: AgentProcessRequest): string | null {
  if (request.hooks !== null) return 'hooks: in-process Claude hook callbacks have no Qwen Code meaning';
  if (request.sessionStore !== null)
    return 'sessionStore: Qwen Code keeps its own chats in its runtime directory';
  if (request.sessionStoreFlush !== null)
    return 'sessionStoreFlush: Qwen Code keeps its own chats in its runtime directory';
  if (request.spawn !== null) {
    return "spawn: the agent SDK's spawner returns no pid and no stderr, so the child's tree could not be ended";
  }
  if (request.settingSources.length > 0)
    return "settingSources: Claude's settings tiers; Qwen Code's are the ones this host writes for the session";
  if (request.forwardSubagentText)
    return "forwardSubagentText: Qwen Code reports a sub-agent's calls, not its conversation";
  const mode = request.permissionMode;
  if (mode !== null && !isQwenPermissionMode(mode)) {
    return `permissionMode ${mode}: Qwen Code takes ${QWEN_PERMISSION_MODES.join(', ')}`;
  }
  if (request.thinking !== null && request.thinking.type !== 'adaptive') {
    return 'thinking: Qwen Code has no thinking switch, and its effort has no off level';
  }
  const prompt = request.systemPrompt;
  if (prompt !== null && typeof prompt !== 'string' && !isRuntimeDefaultPrompt(prompt)) {
    return 'systemPrompt: Qwen Code takes a string, which replaces its base prompt, or the runtime-default preset';
  }
  const text =
    typeof prompt === 'string' ? prompt : isRuntimeDefaultPrompt(prompt) ? (prompt.append ?? '') : '';
  if (text.length > QWEN_MAX_PROMPT_ARGUMENT_CHARS) {
    return `systemPrompt: ${text.length} characters is past the ${QWEN_MAX_PROMPT_ARGUMENT_CHARS} this host passes on Qwen Code's command line`;
  }
  return null;
}

/** The CLI's arguments for a session: stream-json both ways, the mode, the model, the prompt, the route. */
export function qwenArgs(
  request: AgentProcessRequest,
  mode: QwenPermissionMode,
  route: QwenEndpointRoute | null,
): string[] {
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--channel=SDK',
    '--approval-mode',
    QWEN_MODE_MAP[mode],
  ];
  if (request.model !== null) args.push('--model', request.model);
  const prompt = request.systemPrompt;
  if (typeof prompt === 'string') args.push('--system-prompt', prompt);
  else if (isRuntimeDefaultPrompt(prompt) && prompt.append !== undefined && prompt.append !== '') {
    args.push('--append-system-prompt', prompt.append);
  }
  if (request.includePartialMessages) args.push('--include-partial-messages');
  if (request.resume !== null) {
    args.push('--resume', request.resume);
    if (request.fork) args.push('--fork-session');
  }
  if (request.strictMcpConfig !== false) {
    const names = Object.keys(request.mcpServers ?? {});
    for (const name of names.length === 0 ? [QWEN_NO_SERVER] : names) {
      args.push('--allowed-mcp-server-names', name);
    }
  }
  if (route !== null) args.push(...qwenEndpointArgs(route));
  return args;
}

/** `env` without the variable that would drop every permission rule, matched as Windows matches. */
function withoutSafeMode(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toUpperCase() !== QWEN_SAFE_MODE_VARIABLE),
  );
}

/** Start one Qwen Code session's CLI. Never throws: what cannot run ends the session by name. */
export function startQwenProcess(
  request: AgentProcessRequest,
  runtime: QwenRuntimeConfig,
  degrade: (detail: string) => void = () => undefined,
  endpoint: string | null = null,
  gate: QwenSessionGate | null = null,
): AgentProcess<QwenMessage> {
  const output = new AsyncQueue<QwenMessage>();
  let failure: Error | null = null;
  let closed = false;
  let opened = false;
  const held: string[] = [];
  let outstanding = 0;
  let home: QwenSessionHome | null = null;
  let control: QwenControl | null = null;
  let resolvePlugins: (applied: boolean | null) => void = () => undefined;
  let pluginsSettled = false;
  const plugins = new Promise<boolean | null>((settle) => {
    resolvePlugins = (applied) => {
      if (pluginsSettled) return;
      pluginsSettled = true;
      settle(applied);
    };
  });

  const fail = (detail: string): void => {
    if (failure === null) failure = new Error(detail);
    resolvePlugins(null);
    void shutDown();
  };
  // What the open names on the session's state lane. This runs inside the registry's start, before the
  // session's forwarder exists, so each is raised once the start has returned, never here.
  const raises: (() => void)[] = [];

  const route =
    endpoint === null ? null : ((runtime.endpoints ?? []).find((one) => one.name === endpoint) ?? null);
  const mode: QwenPermissionMode =
    request.permissionMode !== null && isQwenPermissionMode(request.permissionMode)
      ? request.permissionMode
      : 'default';
  const skills = qwenSkillDirectories((request.plugins ?? []).map((plugin) => plugin.path));
  const servers = qwenMcpServers(request.mcpServers);
  const problem =
    endpoint !== null && route === null
      ? `endpoint-unknown: ${endpoint} is not one this Qwen Code runtime routes`
      : (() => {
          const found = qwenRequestProblem(request);
          if (found !== null) return `request-key-unsupported: ${found}`;
          if (!servers.ok) return `${servers.refusal.reason}: ${servers.refusal.detail}`;
          return null;
        })();

  if (problem !== null) {
    failure = new Error(problem);
  } else {
    const written = createQwenSessionHome(runtime.base, {
      servers: Object.keys(request.mcpServers ?? {}),
      skillDirectories: skills.directories,
      auth: route === null ? null : qwenSettingsAuth(route),
    });
    if (!written.ok) {
      const detail = written.refusal.detail;
      raises.push(() => gate?.raise('qwen-ask-rules-not-active', detail, 'open'));
      failure = new Error(`qwen-ask-rules-not-active: ${detail}`);
    } else {
      home = written.value;
      const env = withoutSafeMode({ ...request.env, ...home.env });
      // The rules are proven before the CLI exists: a file that does not read back whole ends the open.
      const unread = readBackQwenSettings(home, env, runtime.readSettings);
      if (unread !== null) {
        raises.push(() => gate?.raise('qwen-ask-rules-not-active', unread, 'open'));
        failure = new Error(`qwen-ask-rules-not-active: ${unread}`);
      } else {
        const found = spawnDegrades(runtime, env, route);
        raises.push(() => gate?.stateSpawnDegrades(found));
        gate?.spawnedWith(env);
        const command = qwenCommand(runtime.binary, qwenArgs(request, mode, route));
        const started = QwenControl.start({
          command: command.command,
          args: command.args,
          cwd: request.cwd,
          env,
          onMessage: (message) => onMessage(message),
          onControlRequest: (subtype, payload, requestId, signal) =>
            onControlRequest(subtype, payload, requestId, signal),
          onStderr: (line) => request.onStderr?.(line),
          onRefusal: (refusal: Refusal) => {
            degrade(`${refusal.reason}: ${refusal.detail}`);
            gate?.raise(refusal.reason, refusal.detail, 'transport');
          },
          onExit: (exit) => {
            if (!closed && failure === null) {
              failure = new Error(
                `the Qwen Code CLI exited (${exit.error ?? (exit.signal === null ? `exit code ${String(exit.code)}` : `signal ${exit.signal}`)})`,
              );
            }
            resolvePlugins(null);
            removeHome();
            output.end();
          },
          ...(runtime.spawn === undefined ? {} : { spawn: runtime.spawn }),
          ...(runtime.killTree === undefined ? {} : { killTree: runtime.killTree }),
          ...(runtime.closeGraceMs === undefined ? {} : { closeGraceMs: runtime.closeGraceMs }),
        });
        if (started.ok) control = started.value;
        else failure = new Error(`${started.refusal.reason}: ${started.refusal.detail}`);
      }
    }
  }
  if (control === null) resolvePlugins(null);

  function removeHome(): void {
    const removing = home;
    home = null;
    if (removing === null) return;
    const removed = removing.remove();
    if (!removed.ok) degrade(removed.refusal.detail);
  }

  async function ask(
    subtype: QwenHostRequest,
    payload: JsonObject,
    deadlineMs: number = QWEN_CONTROL_DEADLINE_MS,
  ): Promise<Result<JsonObject>> {
    if (control === null) {
      return { ok: false, refusal: { reason: 'rpc-request-failed', detail: `${subtype}: no CLI` } };
    }
    const answered = await control.request(subtype, payload, deadlineMs);
    if (answered.ok) output.push({ kind: 'answer', subtype, request: payload, response: answered.value });
    return answered;
  }

  function onMessage(message: JsonObject): void {
    const key = qwenMessageKey(message);
    if (key === 'system/init') {
      const init = parsed(SystemInit, message);
      if (init !== null) {
        gate?.observeInit(init.tools ?? null, init.permission_mode ?? null);
        // The first init says whether the session's plugins and servers are in.
        const attached = Object.keys(request.mcpServers ?? {});
        const listed = new Map((init.mcp_servers ?? []).map((server) => [server.name, server.status]));
        resolvePlugins(
          skills.problems.length === 0 && attached.every((name) => listed.get(name) === 'connected'),
        );
      }
    }
    output.push({ kind: 'message', message });
    if (key === 'result') {
      outstanding = Math.max(0, outstanding - 1);
      void readContextUsage();
    }
  }

  async function onControlRequest(
    subtype: string,
    payload: JsonObject,
    requestId: string,
    signal: AbortSignal,
  ): Promise<QwenControlAnswer> {
    let answer: QwenControlAnswer;
    if (subtype === 'can_use_tool') {
      answer =
        gate === null
          ? { response: { behavior: 'deny', message: 'this host has no gate for this session' } }
          : await gate.decide(payload, signal);
    } else {
      answer = {
        error: `${subtype === '' ? 'a request with no subtype' : subtype} is not one this host answers`,
      };
    }
    output.push({
      kind: 'control_request',
      requestId,
      subtype,
      request: payload,
      answer: 'response' in answer ? { response: answer.response } : { error: answer.error },
    });
    return answer;
  }

  async function readContextUsage(): Promise<void> {
    if (closed) return;
    const read = await ask('get_context_usage', {});
    if (!read.ok) degrade(`${read.refusal.reason}: get_context_usage: ${read.refusal.detail}`);
  }

  async function open(): Promise<void> {
    const mcpServers = servers.ok ? servers.value : {};
    const initParams: JsonObject = {
      timeout: {
        canUseTool: gate?.permissionTimeoutMs ?? qwenPermissionTimeoutMs(DEFAULT_DECISION_TIMEOUT_MS),
      },
      ...(request.effort === null ? {} : { effort: request.effort }),
      ...(Object.keys(mcpServers).length === 0 ? {} : { mcpServers }),
    };
    const initialized = await ask('initialize', initParams, QWEN_HANDSHAKE_DEADLINE_MS);
    if (!initialized.ok) return fail(`${initialized.refusal.reason}: ${initialized.refusal.detail}`);
    const answer = parsed(InitializeAnswer, initialized.value);
    if (answer === null) return fail('rpc-request-failed: initialize answered with no session_id');
    gate?.identify(answer.session_id);
    opened = true;
    for (const text of held.splice(0)) send(text);
  }

  function send(text: string): void {
    if (control?.sendUser(text) === true) {
      outstanding += 1;
      output.push({ kind: 'prompt', text });
    } else {
      degrade("a prompt was not written: the CLI's input is closed");
    }
  }

  async function shutDown(): Promise<void> {
    closed = true;
    held.length = 0;
    await control?.close();
    removeHome();
    output.end();
  }

  /** Reject a setter with the CLI's own refusal, or settle it. */
  async function applied(subtype: QwenHostRequest, payload: JsonObject): Promise<void> {
    const answered = await ask(subtype, payload);
    if (!answered.ok) throw new Error(`${answered.refusal.reason}: ${answered.refusal.detail}`);
  }

  void Promise.resolve()
    .then(() => {
      for (const raise of raises) raise();
      if (control !== null) return open();
      // Nothing was started: the home goes, and the session ends with the failure named above.
      removeHome();
      output.end();
      return undefined;
    })
    .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

  async function* messages(): AsyncGenerator<QwenMessage, void> {
    for await (const message of output) yield message;
    if (failure !== null) throw failure;
  }

  return {
    messages: messages(),
    prompt(text: string): boolean {
      if (closed || control === null || held.length + outstanding >= MAX_PENDING_PROMPTS) return false;
      if (!opened) held.push(text);
      else send(text);
      return true;
    },
    async interrupt(): Promise<void> {
      if (closed || !opened) return;
      const asked = await ask('interrupt', {});
      if (!asked.ok) degrade(`${asked.refusal.reason}: ${asked.refusal.detail}`);
    },
    async setModel(selected: string | null): Promise<void> {
      if (closed) return;
      const model = selected ?? request.model;
      if (model === null) return;
      await applied('set_model', { model });
    },
    async setPermissionMode(requested: string): Promise<void> {
      if (!isQwenPermissionMode(requested)) {
        throw new Error(`Qwen Code takes ${QWEN_PERMISSION_MODES.join(', ')}, not ${requested}`);
      }
      if (closed) return;
      await applied('set_permission_mode', { mode: QWEN_MODE_MAP[requested] });
    },
    setThinking(thinking: ThinkingConfig): Promise<void> {
      if (thinking.type === 'adaptive') return Promise.resolve();
      return Promise.reject(new Error('Qwen Code has no thinking switch, and its effort has no off level'));
    },
    async setEffort(level: string): Promise<void> {
      if (closed) return;
      await applied('set_effort', { effort: level });
    },
    pluginsApplied(): Promise<boolean | null> {
      return plugins;
    },
    close(): void {
      if (closed) return;
      void shutDown();
    },
  };
}

/**
 * The degrades a session carries from its open: the files and the endpoint variables the CLI puts in
 * the environment every command the agent runs inherits.
 */
function spawnDegrades(
  runtime: QwenRuntimeConfig,
  env: Readonly<Record<string, string>>,
  route: QwenEndpointRoute | null,
): SpawnDegrade[] {
  const sources: string[] = [];
  for (const file of inheritedEnvFiles(runtime.operatorHome, env)) {
    sources.push(`${file.file}${file.names.length === 0 ? '' : ` (${file.names.join(', ')})`}`);
  }
  const endpointNames = route === null ? [] : Object.keys(route.env);
  if (route !== null && endpointNames.length > 0) {
    sources.push(`the endpoint ${route.name}'s own variables (${endpointNames.join(', ')})`);
  }
  if (sources.length === 0) return [];
  return [
    {
      name: 'gate-credential-in-shell',
      detail: `Qwen Code puts these in its environment, which every command the agent runs inherits: ${sources.join('; ')}`,
    },
  ];
}
