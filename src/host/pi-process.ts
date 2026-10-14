/**
 * A pi session's process: one `pi --mode rpc` child per session, presented to the session as an
 * `AgentProcess` whose messages are `PiMessage`s.
 *
 * One process per session, so its skill directories, its extension's configuration and its model are
 * its own, and closing its input ends exactly one session. What it holds to:
 *
 * - **The launch.** This host composes the whole command line; nothing is discovered. pi starts with no
 *   extension of its own finding (`--no-extensions`), no skill of its own finding (`--no-skills`) and the
 *   workspace untrusted (`--no-approve`), so a repository's own `.pi` settings, servers and extensions do
 *   not load. It loads this package's extension and its own MCP extension by name, and each plugin
 *   directory's skills. Its agent home, its sessions store and its run directory are the runner's own
 *   (`pi-home.ts`). A controller's system prompt rides a file, never the command line.
 * - **The open, proven before any prompt.** The session's channel listens, the extension's configuration
 *   is written, pi starts, and the session waits for the extension's hello over the channel. No hello in
 *   time, or pi refusing to load the extension, refuses the open (`pi-extension-not-active`) and no
 *   prompt is ever written: without the extension pi has no gate. Then pi's commands and state are read,
 *   and every source found that is not this host's is named (`gate-foreign-extension`) before the
 *   session's first `ready`.
 * - **Queue semantics.** pi takes a prompt while it runs only when told how; this host always tells it to
 *   queue the prompt behind the run (`followUp`), which starts a run when none is running. One prompt is
 *   in flight at a time, the next written once pi has answered the last, up to `MAX_PENDING_PROMPTS`.
 * - **Setters apply now.** The model and the thinking level are each a command pi applies to its next
 *   model call. Thinking and effort set the same level: off is `off`, on is the last level set, and the
 *   last call wins. pi has no permission modes, so a request to set one is refused by name.
 * - **Every turn is read when it ends.** After each run settles, pi is asked the session's totals.
 * - **Every extension dialog is answered,** cancelled, by the envelope: nobody here answers one.
 */
import type { JsonObject } from '../control/frames.js';
import { AsyncQueue } from '../core/async-queue.js';
import type { Refusal, RefusalReason } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { refuse } from '../core/result.js';
import type { AgentInitFacts, AgentProcess, AgentProcessRequest, ThinkingConfig } from './agent-process.js';
import { MAX_PENDING_PROMPTS, isRuntimeDefaultPrompt } from './agent-process.js';
import type { SpawnDegrade } from './codex-gate.js';
import { PI_PINNED_VERSION, piCommand, piExtensionPath } from './pi-binary.js';
import type { PiEndpointRoute } from './pi-endpoints.js';
import { piEndpointArgs } from './pi-endpoints.js';
import type { PiExtensionConfig, PiExtensionServer, PiHello, PiHelloEntry } from './pi-extension.js';
import type { PiSessionGate } from './pi-gate.js';
import { piForeignSources } from './pi-gate.js';
import type { PiPromptFile, PiSessionRun } from './pi-home.js';
import { createPiSessionRun, piBaseOf, resolvePiSession } from './pi-home.js';
import { piMcpServers } from './pi-mcp.js';
import { piSkillArgs, piSkillDirectories } from './pi-pack.js';
import { PiRpc } from './pi-rpc.js';
import type { PiHostCommand, PiMessage } from './pi-wire.js';
import { PiCommands, PiState, parsed, piTypeOf } from './pi-wire.js';
import { qwenHandedOverSkills } from './qwen-pack.js';
import type { SpawnChild } from './stdio-rpc.js';

/** How long the extension has, from pi's start, to say hello over its channel. */
export const PI_HELLO_DEADLINE_MS = 30_000;
/** How long a command may take to be answered. */
export const PI_COMMAND_DEADLINE_MS = 30_000;
/** How long `abort` may take: pi answers it once the run has stopped. */
export const PI_ABORT_DEADLINE_MS = 120_000;
/** How many of pi's last stderr lines are kept, to name why it ended before the session opened. */
const PI_STDERR_KEPT = 20;
/** What pi writes when an extension named with `-e` would not load. */
const EXTENSION_LOAD_FAILURE = 'Failed to load extension';

/** The thinking levels pi's thinking control takes, below `off`: the effort words a session names. */
export const PI_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The level thinking turns back on at when none was set before: pi's own default. */
export const PI_DEFAULT_THINKING_LEVEL = 'medium';

/** What a pi runtime is configured with, beside each session's own request. */
export interface PiRuntimeConfig {
  /** `PERISCOPE_PI_BIN`: the CLI's JavaScript entry, or a program that runs it. */
  readonly binary: string;
  /** `PERISCOPE_PI_HOME`: the runner-owned base the agent home, the sessions and the runs live under. */
  readonly base: string;
  /** How pi is started; the default starts it with no shell. */
  readonly spawn?: SpawnChild;
  readonly killTree?: (pid: number) => Promise<void>;
  readonly closeGraceMs?: number;
  /** The operator's model endpoints a pi session may open on (`piEndpointRoutes`). */
  readonly endpoints?: readonly PiEndpointRoute[];
  /** How long the extension has to say hello. Defaults to `PI_HELLO_DEADLINE_MS`. */
  readonly helloDeadlineMs?: number;
  /** The extension pi loads; this package's own (`piExtensionPath`) unless a test names another. */
  readonly extensionPath?: string;
  readonly platform?: string;
}

/** The init facts a pi session goes live on: the answer to `get_state`, once the open is proven. */
export function piInitFacts(message: PiMessage): AgentInitFacts | null {
  if (message.kind !== 'response' || message.command !== 'get_state') return null;
  if (message.response['success'] !== true) return null;
  const state = parsed(PiState, message.response['data']);
  if (state === null) return null;
  return {
    sessionId: state.sessionId,
    cliVersion: PI_PINNED_VERSION,
    cwd: '',
    model:
      state.model === null || state.model === undefined ? '' : `${state.model.provider}/${state.model.id}`,
    permissionMode: '',
    apiKeySource: 'none',
    tools: [],
    skills: [],
    plugins: [],
    capabilities: [],
    mcpServers: [],
  };
}

/** Why `request` cannot run on pi, or null. Members with no pi meaning are refused, never dropped. */
export function piRequestProblem(request: AgentProcessRequest): string | null {
  if (request.hooks !== null) {
    return "hooks: in-process Claude hook callbacks have no pi meaning; pi's gate is this host's own extension";
  }
  if (request.sessionStore !== null)
    return 'sessionStore: pi keeps its own session files, in its sessions store';
  if (request.sessionStoreFlush !== null)
    return 'sessionStoreFlush: pi keeps its own session files, in its sessions store';
  if (request.spawn !== null) {
    return "spawn: the agent SDK's spawner returns no pid and no stderr, so the child's tree could not be ended";
  }
  if (request.settingSources.length > 0) {
    return "settingSources: Claude's settings tiers; pi reads its runner-owned agent home and no workspace's settings";
  }
  if (request.forwardSubagentText) return 'forwardSubagentText: pi has no built-in sub-agents';
  if (request.permissionMode !== null) {
    return `permissionMode ${request.permissionMode}: pi has no permission modes; every call asks this host`;
  }
  if (request.effort !== null && !(PI_EFFORTS as readonly string[]).includes(request.effort)) {
    return `effort ${request.effort}: pi takes ${PI_EFFORTS.join(', ')}`;
  }
  const prompt = request.systemPrompt;
  if (prompt !== null && typeof prompt !== 'string' && !isRuntimeDefaultPrompt(prompt)) {
    return 'systemPrompt: pi takes a string, which replaces its base prompt, or the runtime-default preset';
  }
  return null;
}

/** The system prompt a session hands pi, as a file and the flag that names it, or null for none. */
export function piPromptFile(request: AgentProcessRequest): PiPromptFile | null {
  const prompt = request.systemPrompt;
  if (typeof prompt === 'string') return { flag: '--system-prompt', text: prompt };
  if (isRuntimeDefaultPrompt(prompt) && prompt.append !== undefined && prompt.append !== '') {
    return { flag: '--append-system-prompt', text: prompt.append };
  }
  return null;
}

/** The thinking level a session starts at: off when thinking is off, else its effort, else pi's own. */
export function piStartLevel(request: AgentProcessRequest): string | null {
  if (request.thinking?.type === 'disabled') return 'off';
  return request.effort;
}

/** What the command line names beside the fixed launch: the files and the session to open. */
export interface PiLaunch {
  readonly extensionPath: string;
  readonly skillDirectories: readonly string[];
  readonly sessions: string;
  readonly session: { readonly flag: '--session' | '--fork'; readonly path: string } | null;
  readonly route: PiEndpointRoute | null;
  readonly prompt: { readonly flag: PiPromptFile['flag']; readonly file: string } | null;
}

/**
 * pi's arguments for a session: RPC mode; no extension, skill or workspace configuration of pi's own
 * finding; this package's extension and pi's MCP extension by name; the session's skills, its store, the
 * session to open, its model, its thinking level and its prompt file.
 */
export function piArgs(request: AgentProcessRequest, launch: PiLaunch): string[] {
  const args = [
    '--mode',
    'rpc',
    '--no-extensions',
    '--no-skills',
    '--no-approve',
    '-e',
    'builtin:mcp',
    '-e',
    launch.extensionPath,
    ...piSkillArgs(launch.skillDirectories),
    '--session-dir',
    launch.sessions,
  ];
  if (launch.session !== null) args.push(launch.session.flag, launch.session.path);
  const route = launch.route;
  if (route !== null) {
    const model = request.model ?? route.models[0];
    if (model !== undefined) args.push(...piEndpointArgs(route, model));
  } else if (request.model !== null) {
    args.push('--model', request.model);
  }
  const level = piStartLevel(request);
  if (level !== null) args.push('--thinking', level);
  if (launch.prompt !== null) args.push(launch.prompt.flag, launch.prompt.file);
  return args;
}

/** A `get_commands` answer's entries, as a hello's, or null when the answer carries none. */
function commandEntries(data: unknown): PiHelloEntry[] | null {
  const read = parsed(PiCommands, data);
  if (read === null) return null;
  return read.commands.map((command) => ({
    name: command.name,
    kind: command.source,
    source: command.sourceInfo.source,
    path: command.sourceInfo.path,
    ...(command.sourceInfo.baseDir === undefined ? {} : { baseDir: command.sourceInfo.baseDir }),
  }));
}

/** The model `selected` names on pi: a provider and an id. */
function modelOf(
  selected: string,
  route: PiEndpointRoute | null,
  provider: string | null,
): { readonly provider: string; readonly modelId: string } | null {
  if (route !== null) return { provider: route.name, modelId: selected };
  const slash = selected.indexOf('/');
  if (slash > 0) return { provider: selected.slice(0, slash), modelId: selected.slice(slash + 1) };
  return provider === null ? null : { provider, modelId: selected };
}

/** Start one pi session's process. Never throws: what cannot run ends the session by name. */
export function startPiProcess(
  request: AgentProcessRequest,
  runtime: PiRuntimeConfig,
  degrade: (detail: string) => void = () => undefined,
  endpoint: string | null = null,
  gate: PiSessionGate | null = null,
): AgentProcess<PiMessage> {
  const output = new AsyncQueue<PiMessage>();
  let failure: Error | null = null;
  let closed = false;
  let opened = false;
  const held: string[] = [];
  let inFlight = false;
  /** Prompts pi took and has not finished a run past: what the pending bound counts beside the held. */
  let accepted = 0;
  let rpc: PiRpc | null = null;
  let run: PiSessionRun | null = null;
  const stderr: string[] = [];
  /** How pi ended, once it has. */
  let exitDetail: string | null = null;
  /** The provider of the model in force, from pi's own state. */
  let provider: string | null = null;
  /** The last thinking level other than off: where thinking turns back on. */
  let lastLevel: string | null = request.effort;
  let resolvePlugins: (applied: boolean | null) => void = () => undefined;
  let pluginsSettled = false;
  const plugins = new Promise<boolean | null>((settle) => {
    resolvePlugins = (applied) => {
      if (pluginsSettled) return;
      pluginsSettled = true;
      settle(applied);
    };
  });

  const route =
    endpoint === null ? null : ((runtime.endpoints ?? []).find((one) => one.name === endpoint) ?? null);
  const paths = piBaseOf(runtime.base);
  const skills = piSkillDirectories((request.plugins ?? []).map((plugin) => plugin.path));
  const servers = piMcpServers(request.mcpServers);
  const session: Result<PiLaunch['session']> =
    request.resume === null
      ? { ok: true, value: null }
      : (() => {
          const found = resolvePiSession(paths.sessions, request.resume, request.cwd, {
            fork: request.fork,
            ...(runtime.platform === undefined ? {} : { platform: runtime.platform }),
          });
          return found.ok
            ? { ok: true, value: { flag: request.fork ? '--fork' : '--session', path: found.value } }
            : found;
        })();
  const problem =
    endpoint !== null && route === null
      ? `endpoint-unknown: ${endpoint} is not one this pi runtime routes`
      : gate === null
        ? 'pi-extension-not-active: this session has no gate for pi to ask'
        : (() => {
            const found = piRequestProblem(request);
            if (found !== null) return `request-key-unsupported: ${found}`;
            if (!servers.ok) return `${servers.refusal.reason}: ${servers.refusal.detail}`;
            if (!session.ok) return `${session.refusal.reason}: ${session.refusal.detail}`;
            return null;
          })();

  const shutDown = async (): Promise<void> => {
    closed = true;
    held.length = 0;
    await rpc?.close();
    removeRun();
    output.end();
  };

  const fail = (detail: string): void => {
    if (failure === null) failure = new Error(detail);
    resolvePlugins(null);
    void shutDown();
  };

  /** The open refused by name: said on the session's state lane, then the session ends with it. */
  const refuseOpen = (reason: RefusalReason, detail: string): void => {
    gate?.raise(reason, detail, 'open');
    fail(`${reason}: ${detail}`);
  };

  function removeRun(): void {
    const removing = run;
    run = null;
    if (removing === null) return;
    const removed = removing.remove();
    if (!removed.ok) degrade(removed.refusal.detail);
  }

  const push = (message: PiMessage): void => {
    if (!closed) output.push(message);
  };

  function ask(
    command: PiHostCommand,
    payload: JsonObject,
    deadlineMs: number = PI_COMMAND_DEADLINE_MS,
  ): Promise<Result<JsonObject>> {
    if (rpc === null) return Promise.resolve(refuse('rpc-request-failed', `${command}: pi is not running`));
    return rpc.request(command, payload, deadlineMs);
  }

  function onEvent(event: JsonObject): void {
    const type = piTypeOf(event);
    if (type === 'message_update' && !request.includePartialMessages) return;
    if (type === 'thinking_level_changed' && typeof event['level'] === 'string' && event['level'] !== 'off') {
      lastLevel = event['level'];
    }
    push({ kind: 'event', event });
    if (type === 'agent_settled') {
      accepted = 0;
      void readStats();
    }
  }

  async function readStats(): Promise<void> {
    if (closed) return;
    const read = await ask('get_session_stats', {});
    if (!read.ok) {
      degrade(`${read.refusal.reason}: get_session_stats: ${read.refusal.detail}`);
      return;
    }
    push({ kind: 'response', command: 'get_session_stats', request: {}, response: read.value });
  }

  async function open(live: PiSessionGate): Promise<void> {
    const listening = await live.ready();
    if (!listening.ok) return refuseOpen('pi-extension-not-active', listening.refusal.detail);
    if (closed) return;

    const config: PiExtensionConfig = {
      v: 1,
      runtime: 'pi',
      channel: live.address,
      token: live.token,
      deadlineMs: live.extensionDeadlineMs,
      servers: servers.ok ? servers.value : ([] as PiExtensionServer[]),
    };
    const written = createPiSessionRun(runtime.base, config, piPromptFile(request));
    if (!written.ok) return refuseOpen('pi-extension-not-active', written.refusal.detail);
    run = written.value;
    if (closed) {
      removeRun();
      return undefined;
    }

    const extensionPath = runtime.extensionPath ?? piExtensionPath();
    const env = { ...request.env, ...run.env };
    const command = piCommand(
      runtime.binary,
      piArgs(request, {
        extensionPath,
        skillDirectories: skills.directories,
        sessions: paths.sessions,
        session: session.ok ? session.value : null,
        route,
        prompt: run.prompt,
      }),
    );
    const started = PiRpc.start({
      command: command.command,
      args: command.args,
      cwd: request.cwd,
      env,
      onEvent,
      onRecord: (record) => push({ kind: 'record', record }),
      onStderr: (line) => {
        stderr.push(line);
        if (stderr.length > PI_STDERR_KEPT) stderr.shift();
        request.onStderr?.(line);
      },
      onRefusal: (refused: Refusal) => {
        degrade(`${refused.reason}: ${refused.detail}`);
        live.raise(refused.reason, refused.detail, 'transport');
      },
      onExit: (exit) => {
        const how =
          exit.error ?? (exit.signal === null ? `exit code ${String(exit.code)}` : `signal ${exit.signal}`);
        const last = stderr.at(-1);
        exitDetail = `the pi CLI exited (${how})${last === undefined ? '' : `: ${last}`}`;
        // While the session opens, the open names how it ended: an exit then may be pi refusing the
        // extension, which is a refusal of its own.
        if (!opened) return;
        if (!closed && failure === null) failure = new Error(exitDetail);
        resolvePlugins(null);
        removeRun();
        output.end();
      },
      ...(runtime.spawn === undefined ? {} : { spawn: runtime.spawn }),
      ...(runtime.killTree === undefined ? {} : { killTree: runtime.killTree }),
      ...(runtime.closeGraceMs === undefined ? {} : { closeGraceMs: runtime.closeGraceMs }),
    });
    if (!started.ok) return fail(`${started.refusal.reason}: ${started.refusal.detail}`);
    rpc = started.value;

    // No prompt is written until the extension has said it is loaded, over its own channel.
    const deadline = runtime.helloDeadlineMs ?? PI_HELLO_DEADLINE_MS;
    const exited = rpc.exited.then(() => 'exited' as const);
    const hello: PiHello | null | 'exited' = await Promise.race([live.hello(deadline), exited]);
    if (closed) return;
    if (hello === 'exited') {
      const refused = stderr.find((line) => line.includes(EXTENSION_LOAD_FAILURE));
      if (refused !== undefined) {
        return refuseOpen('pi-extension-not-active', `pi would not load this host's extension: ${refused}`);
      }
      return fail(exitDetail ?? 'the pi CLI exited before the session opened');
    }
    if (hello === null) {
      return refuseOpen(
        'pi-extension-not-active',
        `this host's extension did not say hello over its channel within ${deadline}ms, so pi may be running with no gate`,
      );
    }
    // The channel's token and the session's servers are read; nothing more needs the file.
    const removed = run.removeConfig();
    if (!removed.ok) degrade(removed.refusal.detail);

    const commands = await ask('get_commands', {});
    if (!commands.ok) {
      return fail(exitDetail ?? `${commands.refusal.reason}: get_commands: ${commands.refusal.detail}`);
    }
    const state = await ask('get_state', {});
    if (!state.ok) return fail(exitDetail ?? `${state.refusal.reason}: get_state: ${state.refusal.detail}`);
    if (closed) return;
    const stateRead = state.value['success'] === true ? parsed(PiState, state.value['data']) : null;
    if (stateRead === null) return fail('rpc-request-failed: get_state answered with no session id');
    provider = stateRead.model?.provider ?? null;
    live.identify(stateRead.sessionId);

    const listed = commandEntries(commands.value['success'] === true ? commands.value['data'] : null);
    const found = piForeignSources(hello, listed, {
      extensionPath,
      skillDirectories: skills.directories,
      ...(runtime.platform === undefined ? {} : { platform: runtime.platform }),
    });
    const degrades: SpawnDegrade[] = [];
    if (found.length > 0) {
      degrades.push({
        name: 'gate-foreign-extension',
        detail: `code this host did not load is in this pi session, outside its gate: ${found.join('; ')}`,
      });
    }
    const endpointNames = route === null ? [] : Object.keys(route.env);
    if (route !== null && endpointNames.length > 0) {
      degrades.push({
        name: 'gate-credential-in-shell',
        detail: `pi puts these in its environment, which every command the agent runs inherits: the endpoint ${route.name}'s own variables (${endpointNames.join(', ')})`,
      });
    }
    // Before the message that makes the session ready, so the first `ready` states them.
    live.stateSpawnDegrades(degrades);

    const listedNames = new Set((listed ?? []).map((entry) => entry.name));
    resolvePlugins(
      skills.problems.length === 0 &&
        qwenHandedOverSkills(skills.directories).every((name) => listedNames.has(`skill:${name}`)),
    );

    push({ kind: 'hello', hello });
    push({ kind: 'response', command: 'get_commands', request: {}, response: commands.value });
    push({ kind: 'response', command: 'get_state', request: {}, response: state.value });
    opened = true;
    pump();
  }

  /** Write the next held prompt once pi has answered the last. */
  function pump(): void {
    if (closed || !opened || inFlight) return;
    const text = held.shift();
    if (text === undefined) return;
    inFlight = true;
    const payload = { message: text, streamingBehavior: 'followUp' };
    void ask('prompt', payload).then((answered) => {
      inFlight = false;
      if (answered.ok) {
        if (answered.value['success'] === true) accepted += 1;
        push({ kind: 'response', command: 'prompt', request: payload, response: answered.value });
      } else {
        degrade(`a prompt was not taken: ${answered.refusal.reason}: ${answered.refusal.detail}`);
      }
      pump();
    });
  }

  /** Reject a setter with pi's own refusal, or settle it, its answer handed on. */
  async function applied(command: PiHostCommand, payload: JsonObject): Promise<void> {
    const answered = await ask(command, payload);
    if (!answered.ok) throw new Error(`${answered.refusal.reason}: ${answered.refusal.detail}`);
    if (answered.value['success'] !== true) {
      const error = answered.value['error'];
      throw new Error(`${command}: pi refused it: ${typeof error === 'string' ? error : 'no reason given'}`);
    }
    push({ kind: 'response', command, request: payload, response: answered.value });
  }

  if (problem !== null) {
    failure = new Error(problem);
    resolvePlugins(null);
  }

  void Promise.resolve()
    .then(() => {
      if (failure !== null || gate === null) {
        output.end();
        return undefined;
      }
      return open(gate);
    })
    .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

  async function* messages(): AsyncGenerator<PiMessage, void> {
    for await (const message of output) yield message;
    if (failure !== null) throw failure;
  }

  return {
    messages: messages(),
    prompt(text: string): boolean {
      if (closed || failure !== null) return false;
      if (held.length + (inFlight ? 1 : 0) + accepted >= MAX_PENDING_PROMPTS) return false;
      held.push(text);
      pump();
      return true;
    },
    async interrupt(): Promise<void> {
      if (closed || !opened) return;
      const asked = await ask('abort', {}, PI_ABORT_DEADLINE_MS);
      if (!asked.ok) degrade(`${asked.refusal.reason}: ${asked.refusal.detail}`);
      else push({ kind: 'response', command: 'abort', request: {}, response: asked.value });
    },
    async setModel(selected: string | null): Promise<void> {
      if (closed) return;
      const model = selected ?? request.model ?? (route === null ? null : (route.models[0] ?? null));
      if (model === null) return;
      const named = modelOf(model, route, provider);
      if (named === null)
        throw new Error(`pi needs a provider for the model ${model}: name it as provider/id`);
      await applied('set_model', { provider: named.provider, modelId: named.modelId });
      provider = named.provider;
    },
    setPermissionMode(mode: string): Promise<void> {
      return Promise.reject(
        new Error(`pi has no permission modes, so ${mode} cannot be set; every call asks this host`),
      );
    },
    async setThinking(thinking: ThinkingConfig): Promise<void> {
      if (closed) return;
      const level = thinking.type === 'disabled' ? 'off' : (lastLevel ?? PI_DEFAULT_THINKING_LEVEL);
      await applied('set_thinking_level', { level });
    },
    async setEffort(level: string): Promise<void> {
      if (!(PI_EFFORTS as readonly string[]).includes(level)) {
        throw new Error(`pi takes ${PI_EFFORTS.join(', ')}, not ${level}`);
      }
      if (closed) return;
      lastLevel = level;
      await applied('set_thinking_level', { level });
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
