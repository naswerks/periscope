/**
 * A Codex session's process: one `codex app-server` per session, driven over the stdio JSON-RPC
 * transport, presented to the session as an `AgentProcess` whose messages are `CodexMessage`s.
 *
 * One process per session, so the skill roots and the session flags are per session and closing
 * stdin ends exactly one session. What it holds to:
 *
 * - **The opening.** `initialize` (no experimental API; the declined stable notifications opted out),
 *   the version the `userAgent` names held to the pin and the `codexHome` it answers held to the
 *   configured home, then `initialized`, the model catalog, and the thread: `thread/start`, or
 *   `thread/resume` / `thread/fork` for a resume. No request names a working directory: the
 *   app-server runs in the session's worktree, so Codex takes that as its cwd and never records the
 *   project as trusted, which keeps the repository's own `.codex/` layer closed and still loads its
 *   `AGENTS.md`. Then the skills and the MCP servers, and only then what arrived meanwhile, in arrival
 *   order: the receipt is built before the thread's `ready`.
 * - **Queue semantics.** A `turn/start` while a turn is running steers that turn, so a prompt is held
 *   here, in order, up to `MAX_PENDING_PROMPTS`, and sent only once no turn is running or starting.
 *   An interrupt stops the running turn; held prompts stay held and run after it.
 * - **Setters apply at the next turn.** The model, the permission mode, the effort and thinking are
 *   held and sent on the next `turn/start`; thinking off is effort `none`, where the model lists it.
 * - **Every request from the server is answered, fail closed.** Nothing decides a call for this
 *   runtime here: a command or a patch is declined, a permission widening gets an empty grant for the
 *   turn, an elicitation is declined, a question for the user gets no answers, anything else is
 *   `-32601`. Never a session-wide grant, never an amendment, and never `thread/shellCommand` or
 *   `command/exec`, which run a string with full access.
 */
import type { JsonObject } from '../control/frames.js';
import { AsyncQueue } from '../core/async-queue.js';
import type { Refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import type { AgentInitFacts, AgentProcess, AgentProcessRequest, ThinkingConfig } from './agent-process.js';
import { MAX_PENDING_PROMPTS, isRuntimeDefaultPrompt } from './agent-process.js';
import { CODEX_PINNED_VERSION, codexCommand, codexVersionProblem, userAgentVersion } from './codex-binary.js';
import { codexAppServerArgs, codexSessionFlags, samePath } from './codex-home.js';
import { CODEX_NAMES } from './codex-names.js';
import type { CodexMessage } from './codex-wire.js';
import {
  CodexModel,
  InitializeResponse,
  ModelListResponse,
  ThreadOpenResponse,
  TurnStartResponse,
  parsed,
} from './codex-wire.js';
import { CODEX_COVERAGE } from '../state/codex-coverage.js';
import { codexServerRequestAnswer } from './codex-answers.js';
import type { RpcAnswer, RpcId, SpawnChild, StdioRpcPeer } from './stdio-rpc.js';
import { startStdioRpc } from './stdio-rpc.js';
import type { CodexPermissionMode } from './wire-request.js';
import {
  CODEX_APPROVALS_REVIEWER,
  CODEX_MODE_MAP,
  CODEX_PERMISSION_MODES,
  isCodexPermissionMode,
} from './wire-request.js';

/** How long the opening requests may take: `initialize` and the queries around the thread. */
export const CODEX_HANDSHAKE_DEADLINE_MS = 20_000;
/** How long opening the thread may take: a cold start loads the config, the skills and the MCP servers. */
export const CODEX_OPEN_DEADLINE_MS = 60_000;
/** How long a turn's start or its interrupt may take to be answered. */
export const CODEX_TURN_DEADLINE_MS = 30_000;
/** The longest prompt Codex takes, in characters. */
export const CODEX_MAX_INPUT_CHARS = 1_048_576;
/** The most model-catalog pages read: a catalog past this many pages is read no further. */
const MODEL_LIST_PAGES = 16;

/** The deltas a session that asked for no partial messages opts out of. */
const DELTA_METHODS = [
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
];

/** What a Codex runtime is configured with, beside each session's own request. */
export interface CodexRuntimeConfig {
  /** `PERISCOPE_CODEX_BIN`: the native binary, or the npm launcher. */
  readonly binary: string;
  /** `PERISCOPE_CODEX_HOME`: the runner-owned home, already created. */
  readonly home: string;
  /** This package's version, as the client's version at `initialize`. */
  readonly clientVersion: string;
  /** How the app-server child is started; the default starts the binary with no shell. */
  readonly spawn?: SpawnChild;
  readonly killTree?: (pid: number) => Promise<void>;
  readonly closeGraceMs?: number;
}

/** The stable notifications a Codex session opts out of: every declined row a stable connection receives. */
export function codexOptOuts(includePartialMessages: boolean): string[] {
  const experimental = new Set(
    CODEX_NAMES.notifications.filter((entry) => entry.experimental).map((entry) => entry.method),
  );
  const declined = Object.entries(CODEX_COVERAGE.notifications)
    .filter(([method, row]) => row.handling === 'declined' && !experimental.has(method))
    .map(([method]) => method);
  return includePartialMessages ? declined : [...declined, ...DELTA_METHODS];
}

/** The init facts a Codex session goes live on: the answer that opened its thread. */
export function codexInitFacts(message: CodexMessage): AgentInitFacts | null {
  if (message.kind !== 'answer') return null;
  if (
    message.method !== 'thread/start' &&
    message.method !== 'thread/resume' &&
    message.method !== 'thread/fork'
  ) {
    return null;
  }
  const opened = parsed(ThreadOpenResponse, message.result);
  if (opened === null) return null;
  return {
    sessionId: opened.thread.id,
    cliVersion: opened.thread.cliVersion ?? CODEX_PINNED_VERSION,
    cwd: opened.cwd ?? '',
    model: opened.model,
    permissionMode: typeof opened.approvalPolicy === 'string' ? opened.approvalPolicy : '',
    apiKeySource: 'none',
    tools: [],
    skills: [],
    plugins: [],
    capabilities: [],
    mcpServers: [],
  };
}

/** Why `request` cannot run on Codex, or null. In-process members with no Codex meaning are refused, never dropped. */
export function codexRequestProblem(request: AgentProcessRequest): string | null {
  if (request.hooks !== null) return 'hooks: in-process Claude hook callbacks have no Codex meaning';
  if (request.sessionStore !== null) return 'sessionStore: Codex keeps its own rollouts in its home';
  if (request.sessionStoreFlush !== null)
    return 'sessionStoreFlush: Codex keeps its own rollouts in its home';
  if (request.spawn !== null) {
    return "spawn: the agent SDK's spawner returns no pid and no stderr, so the child's tree could not be ended";
  }
  if (request.settingSources.length > 0)
    return "settingSources: Claude's settings tiers; Codex's are its home's";
  if (request.forwardSubagentText)
    return 'forwardSubagentText: a Codex sub-agent runs on a thread of its own';
  const mode = request.permissionMode;
  if (mode !== null && !isCodexPermissionMode(mode)) {
    return `permissionMode ${mode}: Codex takes ${CODEX_PERMISSION_MODES.join(', ')}`;
  }
  const prompt = request.systemPrompt;
  if (prompt !== null && typeof prompt !== 'string' && !isRuntimeDefaultPrompt(prompt)) {
    return 'systemPrompt: Codex takes a string, which replaces its base instructions, or the runtime-default preset';
  }
  return null;
}

interface Held {
  model: string | null;
  mode: CodexPermissionMode | null;
  effort: string | null;
}

/** Start one Codex session's app-server. Never throws: what cannot run ends the session by name. */
export function startCodexProcess(
  request: AgentProcessRequest,
  runtime: CodexRuntimeConfig,
  degrade: (detail: string) => void = () => undefined,
): AgentProcess<CodexMessage> {
  const output = new AsyncQueue<CodexMessage>();
  let failure: Error | null = null;
  let closed = false;
  let opened = false;
  const arrived: CodexMessage[] = [];
  const held: string[] = [];
  const pending: Held = { model: null, mode: null, effort: null };
  let thread: string | null = null;
  let model: string | null = request.model;
  let effort: string | null = request.effort;
  let effortBeforeThinkingOff: string | null = null;
  let turn: string | null = null;
  let starting = false;
  let interruptWhenStarted = false;
  const settled = new Set<string>();
  const efforts = new Map<string, readonly string[]>();
  /** The catalog's default model: what a thread naming none opens on. */
  let catalogDefault: string | null = null;
  let resolvePlugins: (applied: boolean | null) => void = () => undefined;
  const plugins = new Promise<boolean | null>((settle) => {
    resolvePlugins = settle;
  });

  const fail = (detail: string): void => {
    if (failure === null) failure = new Error(detail);
    resolvePlugins(null);
    void shutDown();
  };

  const emit = (message: CodexMessage): void => {
    if (opened) output.push(message);
    else arrived.push(message);
  };

  const problem = codexRequestProblem(request);
  const mode: CodexPermissionMode =
    request.permissionMode !== null && isCodexPermissionMode(request.permissionMode)
      ? request.permissionMode
      : CODEX_PERMISSION_MODES[0];
  const command = codexCommand(runtime.binary, codexAppServerArgs(codexSessionFlags(mode)));

  let peer: StdioRpcPeer | null = null;
  if (problem === null) {
    const started = startStdioRpc({
      command: command.command,
      args: command.args,
      cwd: request.cwd,
      env: { ...request.env, CODEX_HOME: runtime.home },
      onNotification: (method, params) => onNotification(method, params),
      onRequest: (method, params, id) => onRequest(method, params, id),
      onStderr: (line) => request.onStderr?.(line),
      onRefusal: (refusal: Refusal) => degrade(`${refusal.reason}: ${refusal.detail}`),
      onExit: (exit) => {
        if (!closed && failure === null) {
          failure = new Error(
            `the Codex app-server exited (${exit.error ?? (exit.signal === null ? `exit code ${String(exit.code)}` : `signal ${exit.signal}`)})`,
          );
        }
        resolvePlugins(null);
        output.end();
      },
      ...(runtime.spawn === undefined ? {} : { spawn: runtime.spawn }),
      ...(runtime.killTree === undefined ? {} : { killTree: runtime.killTree }),
      ...(runtime.closeGraceMs === undefined ? {} : { closeGraceMs: runtime.closeGraceMs }),
    });
    if (started.ok) peer = started.value;
    else failure = new Error(`${started.refusal.reason}: ${started.refusal.detail}`);
  } else {
    failure = new Error(`request-key-unsupported: ${problem}`);
  }
  if (peer === null) {
    resolvePlugins(null);
    output.end();
  }

  async function ask(method: string, params: JsonObject, deadlineMs: number): Promise<Result<JsonObject>> {
    if (peer === null)
      return { ok: false, refusal: { reason: 'rpc-request-failed', detail: `${method}: no app-server` } };
    const answered = await peer.request(method, params, deadlineMs);
    if (!answered.ok) return answered;
    const result = answered.value;
    return typeof result === 'object' && result !== null && !Array.isArray(result)
      ? { ok: true, value: result }
      : { ok: true, value: {} };
  }

  function onNotification(method: string, params: JsonObject): void {
    if (method === 'turn/started' && params['threadId'] === thread) {
      const id = (params['turn'] as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string' && !settled.has(id)) turn = id;
    }
    if (method === 'turn/completed' && params['threadId'] === thread) {
      const id = (params['turn'] as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string') settled.add(id);
      turn = null;
    }
    emit({ kind: 'notification', method, params });
    if (method === 'turn/completed' && params['threadId'] === thread) next();
    if (method === 'skills/changed' && opened) void readSkills();
    // The thread is gone: nothing more can run on this process, so it ends with it.
    if (method === 'thread/closed' && params['threadId'] === thread) void shutDown();
  }

  function onRequest(method: string, params: JsonObject, id: RpcId): RpcAnswer {
    const answer = codexServerRequestAnswer(method);
    const record: JsonObject =
      'result' in answer ? { result: answer.result } : { error: { ...answer.error } };
    emit({ kind: 'server_request', id, method, params, answer: record });
    return answer;
  }

  async function readSkills(): Promise<boolean> {
    const params: JsonObject = { cwds: [request.cwd], forceReload: true };
    const listed = await ask('skills/list', params, CODEX_HANDSHAKE_DEADLINE_MS);
    if (!listed.ok) degrade(`${listed.refusal.reason}: ${listed.refusal.detail}`);
    output.push({ kind: 'answer', method: 'skills/list', params, result: listed.ok ? listed.value : {} });
    if (!listed.ok) return false;
    const data = listed.value['data'];
    return (
      Array.isArray(data) &&
      data.every((entry) => {
        const errors = (entry as { errors?: unknown }).errors;
        return !Array.isArray(errors) || errors.length === 0;
      })
    );
  }

  async function open(): Promise<void> {
    const initParams: JsonObject = {
      clientInfo: { name: 'periscope', title: null, version: runtime.clientVersion },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: codexOptOuts(request.includePartialMessages),
      },
    };
    const initialized = await ask('initialize', initParams, CODEX_HANDSHAKE_DEADLINE_MS);
    if (!initialized.ok) return fail(`${initialized.refusal.reason}: ${initialized.refusal.detail}`);
    const answer = parsed(InitializeResponse, initialized.value);
    if (answer === null)
      return fail('rpc-request-failed: initialize answered with no userAgent or codexHome');
    const versionProblem = codexVersionProblem('the Codex app-server', userAgentVersion(answer.userAgent));
    if (versionProblem !== null) return fail(`runtime-unavailable: ${versionProblem}`);
    if (!samePath(answer.codexHome, runtime.home)) {
      return fail(
        `runtime-unavailable: the Codex app-server runs from home ${answer.codexHome}, not the configured ${runtime.home}`,
      );
    }
    output.push({ kind: 'answer', method: 'initialize', params: initParams, result: initialized.value });
    peer?.notify('initialized', {});

    await readCatalog();
    if (closed) return;

    const selected = request.model ?? null;
    // Thinking off at the start is the effort `none`, which only a model listing it takes.
    if (request.thinking?.type === 'disabled') {
      const target = selected ?? catalogDefault;
      const listed = target === null ? null : (efforts.get(target) ?? null);
      if (listed === null || !listed.includes('none')) {
        return fail(
          `request-key-unsupported: thinking off is effort none, which ${target ?? 'the default model'} does not list`,
        );
      }
      effort = 'none';
    }
    const flags = {
      ...codexSessionFlags(mode),
      ...(effort === null ? {} : { model_reasoning_effort: effort }),
    };
    const overrides: JsonObject = {
      ...(selected === null ? {} : { model: selected }),
      approvalPolicy: CODEX_MODE_MAP[mode].approvalPolicy,
      sandbox: CODEX_MODE_MAP[mode].sandbox,
      approvalsReviewer: CODEX_APPROVALS_REVIEWER,
      config: flags,
      ...instructions(request.systemPrompt),
    };
    const [method, params]: [string, JsonObject] =
      request.resume === null
        ? ['thread/start', { ...overrides, ephemeral: false }]
        : request.fork
          ? ['thread/fork', { threadId: request.resume, ...overrides, ephemeral: false }]
          : ['thread/resume', { threadId: request.resume, ...overrides }];
    const threadOpened = await ask(method, params, CODEX_OPEN_DEADLINE_MS);
    if (!threadOpened.ok) return fail(`${threadOpened.refusal.reason}: ${threadOpened.refusal.detail}`);
    const openAnswer = parsed(ThreadOpenResponse, threadOpened.value);
    if (openAnswer === null) return fail(`rpc-request-failed: ${method} answered with no thread`);
    if (openAnswer.cwd !== undefined && !samePath(openAnswer.cwd, request.cwd)) {
      return fail(
        `runtime-unavailable: the thread runs in ${openAnswer.cwd}, not the session's ${request.cwd}`,
      );
    }
    thread = openAnswer.thread.id;
    model = openAnswer.model;
    effort = openAnswer.reasoningEffort ?? effort;
    output.push({ kind: 'answer', method, params, result: threadOpened.value });

    const skillsLoaded = await readSkills();
    const mcpParams: JsonObject = { threadId: thread };
    const servers = await ask('mcpServerStatus/list', mcpParams, CODEX_HANDSHAKE_DEADLINE_MS);
    if (!servers.ok) degrade(`${servers.refusal.reason}: ${servers.refusal.detail}`);
    output.push({
      kind: 'answer',
      method: 'mcpServerStatus/list',
      params: mcpParams,
      result: servers.ok ? servers.value : {},
    });
    resolvePlugins(skillsLoaded);

    opened = true;
    for (const message of arrived.splice(0)) output.push(message);
    next();
  }

  async function readCatalog(): Promise<void> {
    let cursor: string | null = null;
    for (let page = 0; page < MODEL_LIST_PAGES; page += 1) {
      const listed = await ask('model/list', cursor === null ? {} : { cursor }, CODEX_HANDSHAKE_DEADLINE_MS);
      if (!listed.ok) {
        degrade(`${listed.refusal.reason}: ${listed.refusal.detail}`);
        return;
      }
      const catalog = parsed(ModelListResponse, listed.value);
      if (catalog === null) return;
      for (const entry of catalog.data) {
        const known = parsed(CodexModel, entry);
        if (known !== null) {
          efforts.set(
            known.id,
            (known.supportedReasoningEfforts ?? []).map((one) => one.reasoningEffort),
          );
          if ((entry as { isDefault?: unknown }).isDefault === true) catalogDefault = known.id;
        }
      }
      cursor = catalog.nextCursor ?? null;
      if (cursor === null) return;
    }
  }

  /** Start the next held prompt, when no turn is running or starting. */
  function next(): void {
    if (!opened || closed || turn !== null || starting || thread === null) return;
    const text = held.shift();
    if (text === undefined) return;
    starting = true;
    const sent: JsonObject = {
      threadId: thread,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(pending.model === null ? {} : { model: pending.model }),
      ...(pending.effort === null ? {} : { effort: pending.effort }),
      ...(pending.mode === null
        ? {}
        : {
            approvalPolicy: CODEX_MODE_MAP[pending.mode].approvalPolicy,
            sandboxPolicy: CODEX_MODE_MAP[pending.mode].sandboxPolicy,
            approvalsReviewer: CODEX_APPROVALS_REVIEWER,
          }),
    };
    const applied = { ...pending };
    pending.model = null;
    pending.mode = null;
    pending.effort = null;
    void ask('turn/start', sent, CODEX_TURN_DEADLINE_MS).then((answered) => {
      starting = false;
      if (!answered.ok) {
        degrade(`${answered.refusal.reason}: ${answered.refusal.detail}`);
        next();
        return;
      }
      if (applied.model !== null) model = applied.model;
      if (applied.effort !== null) effort = applied.effort;
      const started = parsed(TurnStartResponse, answered.value);
      const id = started?.turn.id ?? null;
      if (id !== null && !settled.has(id)) turn = id;
      output.push({ kind: 'answer', method: 'turn/start', params: sent, result: answered.value });
      if (interruptWhenStarted) {
        interruptWhenStarted = false;
        void interruptTurn();
      }
      if (turn === null) next();
    });
  }

  async function interruptTurn(): Promise<void> {
    if (thread === null || turn === null) return;
    const asked = await ask('turn/interrupt', { threadId: thread, turnId: turn }, CODEX_TURN_DEADLINE_MS);
    if (!asked.ok) degrade(`${asked.refusal.reason}: ${asked.refusal.detail}`);
  }

  async function shutDown(): Promise<void> {
    closed = true;
    held.length = 0;
    if (turn !== null) await interruptTurn();
    await peer?.close();
    output.end();
  }

  /** The efforts the current or pending model lists, or null when the catalog does not name it. */
  function effortsNow(): readonly string[] | null {
    const current = pending.model ?? model;
    return current === null ? null : (efforts.get(current) ?? null);
  }

  if (peer !== null) {
    void open().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
  }

  async function* messages(): AsyncGenerator<CodexMessage, void> {
    for await (const message of output) yield message;
    if (failure !== null) throw failure;
  }

  return {
    messages: messages(),
    prompt(text: string): boolean {
      if (closed || peer === null || held.length >= MAX_PENDING_PROMPTS) return false;
      if (text.length > CODEX_MAX_INPUT_CHARS) {
        // Codex refuses a longer input outright; said here by name rather than sent to fail there.
        degrade(
          `a prompt of ${text.length} characters is past the ${CODEX_MAX_INPUT_CHARS} Codex takes, and was not sent`,
        );
        return true;
      }
      held.push(text);
      next();
      return true;
    },
    async interrupt(): Promise<void> {
      if (closed) return;
      if (starting && turn === null) {
        interruptWhenStarted = true;
        return;
      }
      await interruptTurn();
    },
    setModel(selected: string | null): Promise<void> {
      if (!closed) pending.model = selected ?? model;
      return Promise.resolve();
    },
    setPermissionMode(requested: string): Promise<void> {
      if (!isCodexPermissionMode(requested)) {
        return Promise.reject(
          new Error(`Codex takes ${CODEX_PERMISSION_MODES.join(', ')}, not ${requested}`),
        );
      }
      if (!closed) pending.mode = requested;
      return Promise.resolve();
    },
    setThinking(thinking: ThinkingConfig): Promise<void> {
      if (closed) return Promise.resolve();
      if (thinking.type === 'disabled') {
        const listed = effortsNow();
        if (listed === null || !listed.includes('none')) {
          return Promise.reject(
            new Error(
              `thinking off is effort none, which ${pending.model ?? model ?? 'this model'} does not list`,
            ),
          );
        }
        effortBeforeThinkingOff = pending.effort ?? effort;
        pending.effort = 'none';
        return Promise.resolve();
      }
      if (effortBeforeThinkingOff !== null) {
        pending.effort = effortBeforeThinkingOff;
        effortBeforeThinkingOff = null;
      }
      return Promise.resolve();
    },
    setEffort(level: string): Promise<void> {
      const listed = effortsNow();
      if (listed !== null && !listed.includes(level)) {
        return Promise.reject(
          new Error(
            `effort ${level} is not one ${pending.model ?? model ?? 'this model'} lists: ${listed.join(', ')}`,
          ),
        );
      }
      if (!closed) pending.effort = level;
      return Promise.resolve();
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

/** The instructions a request names, in Codex's two lanes: the base replaced, or an append. */
function instructions(prompt: AgentProcessRequest['systemPrompt']): JsonObject {
  if (prompt === null) return {};
  if (typeof prompt === 'string') return { baseInstructions: prompt };
  if (isRuntimeDefaultPrompt(prompt))
    return prompt.append === undefined ? {} : { developerInstructions: prompt.append };
  return {};
}
