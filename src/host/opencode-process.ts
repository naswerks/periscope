/**
 * An opencode session's process: one host process per session (`opencode-host.ts`), started and driven over
 * its stdio (`opencode-relay.ts`), presented to the session as an `AgentProcess` whose messages are
 * `OpencodeMessage`s.
 *
 * One host process per session, so its home, its database, its configuration and its servers are its own, and
 * ending the process ends exactly one session. What it holds to:
 *
 * - **The SDK is the operator's.** The host process loads it from the directory the operator installed it
 *   into at the pinned version (`opencode-sdk.ts`), with this host's own Node, which must parse the SDK.
 * - **Nothing the server reads is discovered.** The host process runs with its home and its data,
 *   configuration, cache and state directories inside the session's fresh home under the runner's base
 *   (`opencode-home.ts`), with no project configuration, no `.claude` folder, no catalogue fetched and none
 *   of opencode's own hosted models; no plugin loads but the runtime's own and this host's pre-call gate
 *   (`periscope.gate`), and the built-ins that could act outside a call are off.
 * - **No credential in an environment.** The configuration, an endpoint's key among it, crosses into the host
 *   process in its `open` request. The host process's environment holds none, and the agent's shell is given
 *   the session's spawn environment as its own (`opencodeShellEnv`), so a command finds the operator's own
 *   home as with every runtime.
 * - **The open, proven before any prompt.** The session is created with this host's rules
 *   (`opencodeRuleset`): every action asks, the tools this host turns off are denied. Once the server's
 *   plugins are active (`model.list` waits for them), the server is read back (`opencodeReadBackProblem`):
 *   the session's and every agent's rules, saved approvals, plugins, servers, configuration and models. Any
 *   difference refuses the open (`opencode-gate-not-active`) and no prompt is ever sent. The pre-call gate
 *   counts only when the server states it `active` (`opencodeGateNotActive`); one missing, `failed` or with
 *   no state is named `gate-hook-missing`, and the session opens.
 * - **Queue semantics.** A prompt is sent as it comes, queued behind any run (`delivery: 'queue'`), up to
 *   `MAX_PENDING_PROMPTS` the server has not yet delivered. Prompts that arrive before the open is proven are
 *   held, in order, and sent after.
 * - **Setters apply now.** The model is the server's own call, and only a model the endpoint lists. The
 *   permission mode is the agent: `default` is `build` and `plan` is `plan`; the rules stay this host's.
 *   opencode sets reasoning through a model's variants and this host's endpoints declare none, so an effort
 *   is refused by name, and a request to turn thinking off too.
 * - **No form waits.** A form the server raises (the web search's provider choice, an MCP server's request for
 *   input) waits on an answer with no timeout, and this host attaches no interface to give one, so each is
 *   cancelled as it is raised: what asked fails with words, and the run goes on.
 * - **Close.** The session's run is interrupted, the host process's stdin ended (it closes the server, which
 *   ends what the server still runs, its terminals included), its process tree ended after a grace, the
 *   database kept for a later resume, and the home removed.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JsonObject, JsonValue } from '../control/frames.js';
import { AsyncQueue } from '../core/async-queue.js';
import type { RefusalReason } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import type { AgentInitFacts, AgentProcess, AgentProcessRequest, ThinkingConfig } from './agent-process.js';
import { MAX_PENDING_PROMPTS, isRuntimeDefaultPrompt } from './agent-process.js';
import type { OpencodeEndpointRoute } from './opencode-endpoints.js';
import { opencodeProvider, opencodeProviderId } from './opencode-endpoints.js';
import type { OpencodeAnswer, OpencodeAsked, OpencodeSessionGate } from './opencode-gate.js';
import { OPENCODE_HELD_TOOLS, opencodeAskedOf } from './opencode-gate.js';
import type { OpencodePostureRead, OpencodeSessionHome } from './opencode-home.js';
import {
  carryOpencodeStateIn,
  carryOpencodeStateOut,
  createOpencodeSessionHome,
  isOpencodeGatePlugin,
  opencodeConfig,
  opencodeConfigText,
  opencodeGateNotActive,
  opencodeHostEnv,
  opencodeReadBackProblem,
  opencodeRuleset,
  opencodeShellEnv,
  sweepOpencodeHomes,
} from './opencode-home.js';
import { opencodeMcpServers } from './opencode-mcp.js';
import { OpenBudget, OpenOverrun } from './open-budget.js';
import { opencodeSkillDirectories } from './opencode-pack.js';
import type {
  ConnectOpencode,
  OpencodeConnection,
  OpencodeHeldAnswer,
  OpencodeHeldCall,
} from './opencode-relay.js';
import { connectOpencodeHost } from './opencode-relay.js';
import type { OpencodeEvent, OpencodeInstall, OpencodeRule } from './opencode-sdk.js';
import { OPENCODE_SDK_PINNED_VERSION, nodeCanRunOpencode, readOpencodeInstall } from './opencode-sdk.js';
import type { OpencodeMessage } from './opencode-wire.js';
import { opencodeData, opencodeModelName, opencodeRecord, opencodeWord } from './opencode-wire.js';
import type { ChildExit } from './stdio-rpc.js';
import { describeExit } from './stdio-rpc.js';

/** The permission modes an opencode session takes: `default` is the agent `build`, `plan` is `plan`. */
export const OPENCODE_PERMISSION_MODES = ['default', 'plan'] as const;

/** The agent each permission mode runs as. */
export const OPENCODE_AGENTS: Readonly<Record<(typeof OPENCODE_PERMISSION_MODES)[number], string>> = {
  default: 'build',
  plan: 'plan',
};

/**
 * How long the open may take in all, from the host process's start to the read-back's last answer. Each step
 * is given what is left of it, and it ends before the session's start window, so an open slower than this
 * ends naming the step it was on.
 */
export const OPENCODE_OPEN_DEADLINE_MS = 50_000;
/** How long a setter, an interrupt, a reply or a read may take to be answered. */
export const OPENCODE_CALL_DEADLINE_MS = 30_000;
/** How long each step of the close may take before the next one runs. */
export const OPENCODE_CLOSE_GRACE_MS = 10_000;
/** How many of the host process's last stderr lines are kept, to say why it ended or its open did not finish. */
const OPENCODE_STDERR_KEPT = 20;
/** How much of one stderr line is kept. */
const OPENCODE_STDERR_LINE_MAX = 500;
/** How many request ids one session remembers having taken up. */
const MAX_TAKEN_UP = 8192;
/** How many sessions of an earlier process one resume reads from the database. */
const MAX_ADOPTED_SESSIONS = 1000;

/** What an opencode runtime is configured with, beside each session's own request. */
export interface OpencodeRuntimeConfig {
  /** `PERISCOPE_OPENCODE_SDK`: the directory the operator installed the SDK into. */
  readonly sdk: string;
  /** `PERISCOPE_OPENCODE_HOME`: the runner-owned base the sessions' homes and kept databases live under. */
  readonly base: string;
  /** The operator's model endpoints an opencode session may open on (`opencodeEndpointRoutes`). */
  readonly endpoints?: readonly OpencodeEndpointRoute[];
  /** How the install is checked; the default reads the operator's directory (`readOpencodeInstall`). */
  readonly readInstall?: (directory: string) => Result<OpencodeInstall>;
  /** Whether this Node can load the SDK; the default tests the syntax (`nodeCanRunOpencode`). */
  readonly nodeProblem?: () => string | null;
  /** How the host process is opened; the default starts this package's own program. */
  readonly connect?: ConnectOpencode;
  /** The shell the `shell` tool runs, by path; the default is the platform's (`opencodeShellPath`). */
  readonly shell?: string;
  readonly killTree?: (pid: number) => Promise<void>;
  readonly closeGraceMs?: number;
  readonly openDeadlineMs?: number;
}

/**
 * The shell this host names for the `shell` tool: Windows PowerShell at its fixed path on Windows, else
 * `cmd.exe`; `bash` elsewhere, else `sh`. Named rather than left to the runtime's own search, so each shell
 * decision's dialect says what runs.
 */
export function opencodeShellPath(
  platform: string = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform === 'win32') {
    const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows';
    const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(powershell)) return powershell;
    return join(root, 'System32', 'cmd.exe');
  }
  return exists('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

/** The init facts an opencode session goes live on: the open, proven. */
export function opencodeInitFacts(message: OpencodeMessage): AgentInitFacts | null {
  if (message.kind !== 'opened') return null;
  return {
    sessionId: message.sessionId,
    cliVersion: OPENCODE_SDK_PINNED_VERSION,
    cwd: '',
    model: message.model ?? '',
    permissionMode: message.agent,
    apiKeySource: 'none',
    tools: [],
    skills: [],
    plugins: [],
    capabilities: [],
    mcpServers: [],
  };
}

/** Why `request` cannot run on opencode, or null. Members with no opencode meaning are refused, never dropped. */
export function opencodeRequestProblem(request: AgentProcessRequest): string | null {
  if (request.hooks !== null) {
    return "hooks: in-process Claude hook callbacks have no opencode meaning; opencode's gate is its permission requests";
  }
  if (request.sessionStore !== null) return 'sessionStore: opencode keeps its own session database';
  if (request.sessionStoreFlush !== null) return 'sessionStoreFlush: opencode keeps its own session database';
  if (request.spawn !== null) {
    return "spawn: the agent SDK's spawner has no opencode meaning; this host starts opencode's host process itself";
  }
  if (request.settingSources.length > 0) {
    return "settingSources: Claude's settings tiers; an opencode session reads no settings of a workspace's or a user's";
  }
  if (request.strictMcpConfig === false) {
    return "strictMcpConfig: an opencode session attaches the session's servers alone; project configuration stays off";
  }
  if (request.fork && request.resume === null) return 'fork: a fork names the session it forks in resume';
  const mode = request.permissionMode;
  if (mode !== null && !(OPENCODE_PERMISSION_MODES as readonly string[]).includes(mode)) {
    return `permissionMode ${mode}: opencode takes ${OPENCODE_PERMISSION_MODES.join(', ')}`;
  }
  if (request.thinking !== null && request.thinking.type !== 'adaptive') {
    return 'thinking: opencode has no thinking switch; its reasoning is set by a model variant';
  }
  if (request.effort !== null) {
    return `effort ${request.effort}: opencode sets reasoning through a model's variants, and this host's endpoints declare none`;
  }
  const prompt = request.systemPrompt;
  if (prompt !== null && !isRuntimeDefaultPrompt(prompt)) {
    return "systemPrompt: opencode takes the runtime-default preset's append; replacing its base prompt removes the runtime's own guardrails";
  }
  return null;
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

/** A record of `value`, or a refusal-like error naming `what`. */
function recordOf(value: JsonValue, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} answered with no record`);
  }
  return value;
}

/** A list of records under `data`, or under the value itself when it is the list. */
function listOf(value: JsonValue): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : opencodeRecord(value)['data'];
  return Array.isArray(list) ? list.map((one) => opencodeRecord(one) as Record<string, unknown>) : [];
}

/** Rules read loosely. */
function rulesOf(value: unknown): OpencodeRule[] {
  return (Array.isArray(value) ? value : []).map((rule) => {
    const one = opencodeRecord(rule);
    return {
      action: String(one['action']),
      resource: String(one['resource']),
      effect: one['effect'] as OpencodeRule['effect'],
    };
  });
}

/**
 * Start one opencode session's host process. Never throws: what cannot run ends the session by name.
 * `writeRoots` are the session's further write roots, which reach the gate through the local gate.
 */
export function startOpencodeProcess(
  request: AgentProcessRequest,
  runtime: OpencodeRuntimeConfig,
  degrade: (detail: string) => void = () => undefined,
  endpoint: string | null = null,
  gate: OpencodeSessionGate | null = null,
): AgentProcess<OpencodeMessage> {
  const output = new AsyncQueue<OpencodeMessage>();
  const decisions = new AbortController();
  const grace = runtime.closeGraceMs ?? OPENCODE_CLOSE_GRACE_MS;
  let failure: Error | null = null;
  let closed = false;
  let opened = false;
  let closing: Promise<void> | null = null;
  const held: string[] = [];
  let outstanding = 0;
  let home: OpencodeSessionHome | null = null;
  let connection: OpencodeConnection | null = null;
  let sessionId: string | null = null;
  // The open's budget, from its start until it opened or ended; each of its steps is given what is left.
  let budget: OpenBudget | null = null;
  // The host process's last stderr lines, the endpoint's key never among them.
  const stderr: string[] = [];
  let agent = OPENCODE_AGENTS[request.permissionMode === 'plan' ? 'plan' : 'default'];
  // The sessions the session's own subagents started, with the call that started each.
  const family = new Map<string, string | null>();
  // The subagents' sessions with a run under way: an interrupt of the session reaches each.
  const runningChildren = new Set<string>();
  // The requests this process has taken up, by id: one raised before the stream was read is found again by
  // the open's own look, and is decided once.
  const takenUp = new Set<string>();
  // Settles once the open is proven, or has failed: a call the server holds before then waits on it.
  let settleProven: (proven: boolean) => void = () => undefined;
  const proven = new Promise<boolean>((resolve) => {
    settleProven = resolve;
  });

  const route =
    endpoint === null ? null : ((runtime.endpoints ?? []).find((one) => one.name === endpoint) ?? null);
  const skills = opencodeSkillDirectories((request.plugins ?? []).map((plugin) => plugin.path));
  const servers = opencodeMcpServers(request.mcpServers);
  const resumeId = request.resume;
  const model = request.model ?? (route === null ? null : (route.models[0] ?? null));
  const providerId = route === null ? null : opencodeProviderId(route);
  const problem = ((): string | null => {
    if (endpoint !== null && route === null) {
      return `endpoint-unknown: ${endpoint} is not one this opencode runtime routes`;
    }
    const found = opencodeRequestProblem(request);
    if (found !== null) return `request-key-unsupported: ${found}`;
    if (!servers.ok) return `${servers.refusal.reason}: ${servers.refusal.detail}`;
    if (route !== null && model !== null && !route.models.includes(model)) {
      return `request-key-unsupported: model ${model} is not one the endpoint ${route.name} lists`;
    }
    if (route === null && request.model !== null) {
      return `request-key-unsupported: model ${request.model} names no endpoint; an opencode session reaches a model only through one`;
    }
    if (gate === null) {
      return 'opencode-gate-not-active: this session has no gate, so no call could be decided';
    }
    return null;
  })();

  const fail = (detail: string): void => {
    budget?.finish();
    if (failure === null) failure = new Error(detail);
    void shutDown();
  };

  /** Keep one line the host process wrote to its stderr. */
  function keepStderr(line: string): void {
    if (line.trim() === '') return;
    const key = route === null ? '' : route.authToken();
    const kept = key === '' ? line : line.split(key).join('<the endpoint key>');
    stderr.push(kept.slice(0, OPENCODE_STDERR_LINE_MAX));
    if (stderr.length > OPENCODE_STDERR_KEPT) stderr.shift();
  }

  /** The host process's last stderr line, as a failure carries it after its own words; empty when none. */
  function lastWords(): string {
    const last = stderr.at(-1);
    return last === undefined ? '' : `; the host process last wrote: ${last}`;
  }

  async function call(
    method: string,
    input: JsonObject,
    deadlineMs = OPENCODE_CALL_DEADLINE_MS,
  ): Promise<JsonValue> {
    const live = connection;
    if (live === null) throw new Error(`${method}: the opencode host process is not open`);
    const answered = await live.call(method, input, deadlineMs);
    if (!answered.ok) throw new Error(answered.refusal.detail);
    return answered.value;
  }

  /**
   * One call the open itself makes, as `step` of it: given what the open has left, at most `boundMs`. One the
   * open's budget runs out on throws an `OpenOverrun` naming the step.
   */
  async function openCall(
    method: string,
    input: JsonObject,
    step: string = method,
    boundMs?: number,
  ): Promise<JsonValue> {
    const live = connection;
    const spending = budget;
    if (live === null || spending === null) return call(method, input, boundMs);
    const answered = await live.call(method, input, spending.enter(step, boundMs));
    if (answered.ok) return answered.value;
    if (spending.overran(answered.refusal.reason === 'rpc-request-timed-out')) {
      throw new OpenOverrun(spending.overrun(step));
    }
    throw new Error(answered.refusal.detail);
  }

  function sessionOf(event: OpencodeEvent): string | null {
    return opencodeWord(opencodeData(event)['sessionID']);
  }

  function ours(session: string | null): boolean {
    return session !== null && (session === sessionId || family.has(session));
  }

  function onEvent(raw: JsonObject): void {
    if (closed) return;
    const event = raw as unknown as OpencodeEvent;
    const data = opencodeData(event);
    const session = sessionOf(event);
    if (event.type === 'session.created') {
      const parent = opencodeWord(data['parentID']);
      if (session !== null && parent !== null && ours(parent) && !family.has(session)) {
        family.set(session, null);
        // The subagent's shell is given the same environment as the session's; until it lands, a command of
        // its runs with the host process's own, which holds no credential either.
        void call('session.environment', {
          sessionID: session,
          variables: opencodeShellEnv(request.env),
        }).catch((error: unknown) =>
          degrade(`a subagent's shell environment was not set: ${wordsOf(error)}`),
        );
      }
    }
    if (event.type === 'session.tool.progress') {
      const child = opencodeWord(opencodeRecord(data['metadata'])['sessionID']);
      const id = opencodeWord(data['id']);
      if (child !== null && id !== null && family.has(child) && family.get(child) === null)
        family.set(child, id);
    }
    if (session !== null && session !== sessionId) {
      if (event.type === 'session.execution.started') runningChildren.add(session);
      else if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) {
        runningChildren.delete(session);
      }
    }
    if (event.type === 'session.inbox.delivered' && session === sessionId) {
      outstanding = Math.max(0, outstanding - 1);
    }
    const message: OpencodeMessage = {
      kind: 'event',
      event,
      session,
      main: session !== null && session === sessionId,
      spawnedBy: session === null ? null : (family.get(session) ?? null),
    };
    try {
      gate?.observe(message);
    } catch {
      // A degrade the gate failed to name must not stop the event reaching the session.
    }
    if (event.type === 'permission.asked') {
      const asked = opencodeAskedOf(data);
      if (asked !== null) answerRequest(asked);
    }
    if (event.type === 'form.created') {
      // A form waits on an answer with no timeout, and this host attaches no interface to give one: the web
      // search's provider choice and an MCP server's request for input are each cancelled at once, so what
      // asked fails with the words below and the run goes on.
      const form = opencodeRecord(data['form']);
      const formID = opencodeWord(form['id']);
      const formSession = opencodeWord(form['sessionID']);
      if (formID !== null && formSession !== null) {
        void call('session.form.cancel', {
          sessionID: formSession,
          formID,
          message: 'this host answers no form: the session has no interface to show one',
        }).catch((error: unknown) => {
          if (!closed) degrade(`a form was not cancelled, so what asked it waits: ${wordsOf(error)}`);
        });
      }
    }
    if (event.type === 'session.execution.interrupted' && session !== null) {
      gate?.endPending(session, 'the turn was interrupted while this decision was outstanding');
    }
    if (event.type === 'plugin.updated' && opened) void checkPlugins();
    output.push(message);
  }

  /**
   * Decide one permission request and answer it. One server runs one session of this host's, so every
   * session in it is this host's to decide for: the session's own, a subagent's, and one an earlier process
   * of the same session started, which this process never saw created. A request raised before the open is
   * proven waits for the proof, and is refused where it does not hold.
   */
  function answerRequest(asked: OpencodeAsked): void {
    if (gate === null || takenUp.has(asked.id)) return;
    if (takenUp.size >= MAX_TAKEN_UP) {
      const oldest = takenUp.values().next().value;
      if (oldest !== undefined) takenUp.delete(oldest);
    }
    takenUp.add(asked.id);
    const decider = gate;
    void (async () => {
      const answer: OpencodeAnswer = (await proven)
        ? await decider.decide(asked, decisions.signal)
        : {
            decision: 'reject',
            message:
              'opencode-gate-not-active: the session is not open in the posture this host started it in, so the call did not run',
          };
      if (closed) return;
      await call('permission.reply', {
        sessionID: asked.sessionID,
        requestID: asked.id,
        decision: answer.decision,
        ...(answer.message === undefined ? {} : { message: answer.message }),
      }).catch((error: unknown) => {
        // The runtime settled this request itself before this host answered: an answer that finds the
        // request gone was never owed. One it still holds has now been refused.
        if (answer.settledByRuntime !== true) throw error;
      });
    })().catch((error: unknown) => {
      // A request the runtime already settled (refused with another, or its session ended) cannot be
      // answered; any other failure leaves the call waiting, which the runtime never runs.
      if (!closed) degrade(`a permission answer was not delivered: ${wordsOf(error)}`);
    });
  }

  /**
   * The sessions an earlier process of this session left in the database, taken as the session's own: each
   * whose line of parents reaches the session is given the shell's environment, as one this process sees
   * created is. Read once, when a kept session is opened again.
   */
  async function adoptEarlierSessions(id: string): Promise<void> {
    const listed = listOf(await openCall('session.list', { limit: MAX_ADOPTED_SESSIONS }));
    const parentOf = new Map<string, string>();
    for (const one of listed) {
      const child = opencodeWord(one['id']);
      const parent = opencodeWord(one['parentID']);
      if (child !== null && parent !== null) parentOf.set(child, parent);
    }
    for (const child of parentOf.keys()) {
      // Up the line of parents, a bounded number of steps, to the session itself.
      let at: string | undefined = child;
      for (let step = 0; step < 32 && at !== undefined && at !== id; step += 1) at = parentOf.get(at);
      if (at !== id || family.has(child)) continue;
      family.set(child, null);
      void call('session.environment', {
        sessionID: child,
        variables: opencodeShellEnv(request.env),
      }).catch((error: unknown) => degrade(`a subagent's shell environment was not set: ${wordsOf(error)}`));
    }
  }

  /** The requests raised before this process read the stream, each taken up as one the stream announced. */
  async function takeUpWaitingRequests(): Promise<void> {
    try {
      const waiting = listOf(await call('permission.request.list', { location: { directory: request.cwd } }));
      for (const one of waiting) {
        const asked = opencodeAskedOf(one);
        if (asked !== null) answerRequest(asked);
      }
    } catch (error) {
      degrade(`the requests waiting at the open could not be read: ${wordsOf(error)}`);
    }
  }

  /**
   * One call the server holds before it runs. The server restarts a run an earlier process left as soon as
   * it is created, so a call can be held before the open is proven: it waits for the proof, is decided like
   * any other once the proof holds, and is refused only where it does not.
   */
  async function onHeldCall(held: OpencodeHeldCall): Promise<OpencodeHeldAnswer> {
    if (gate === null || !(await proven) || closed) {
      return {
        allow: false,
        message:
          'opencode-gate-not-active: the session is not open in the posture this host started it in, so the call did not run',
      };
    }
    const answer = await gate.decideHeld(held, decisions.signal);
    return {
      allow: answer.decision === 'once',
      ...(answer.message === undefined ? {} : { message: answer.message }),
    };
  }

  async function checkPlugins(): Promise<void> {
    try {
      const plugins = listOf(await call('plugin.list', { location: { directory: request.cwd } }));
      const foreign = plugins.filter(
        (plugin) =>
          opencodeRecord(plugin['source'])['type'] !== 'builtin' &&
          !isOpencodeGatePlugin({
            ...(typeof plugin['id'] === 'string' ? { id: plugin['id'] } : {}),
            source: { type: String(opencodeRecord(plugin['source'])['type']) },
          }),
      );
      if (foreign.length > 0) {
        gate?.raise(
          'gate-foreign-extension',
          `plugins other than the runtime's own are now loaded: ${foreign.map((plugin) => opencodeWord(plugin['id']) ?? 'unnamed').join(', ')}`,
          foreign.map((plugin) => opencodeWord(plugin['id']) ?? 'unnamed').join(','),
        );
      }
    } catch {
      // A plugin list that could not be read leaves the last reading standing.
    }
  }

  async function readPosture(id: string, models: JsonValue): Promise<OpencodePostureRead> {
    const location = { location: { directory: request.cwd } };
    const step = 'the read-back';
    const bound = OPENCODE_CALL_DEADLINE_MS;
    const [session, agents, saved, plugins, mcp, config] = await Promise.all([
      openCall('session.get', { sessionID: id }, step, bound),
      openCall('agent.list', location, step, bound),
      // No project named: every saved approval the session's database holds.
      openCall('permission.saved.list', {}, step, bound),
      openCall('plugin.list', location, step, bound),
      openCall('mcp.list', location, step, bound),
      openCall('config.get', location, step, bound),
    ]);
    return {
      rules: rulesOf(recordOf(session, 'session.get')['permissions']),
      agents: listOf(agents).map((one) => ({ id: String(one['id']), rules: rulesOf(one['permissions']) })),
      saved: listOf(saved).map((one) => ({
        action: String(one['action']),
        resource: String(one['resource']),
      })),
      plugins: listOf(plugins).map((one) => {
        const state = opencodeRecord(one['state']);
        const status = state['status'];
        const error = state['error'];
        return {
          ...(typeof one['id'] === 'string' ? { id: one['id'] } : {}),
          source: { type: String(opencodeRecord(one['source'])['type']) },
          ...(typeof status === 'string'
            ? { state: { status, ...(typeof error === 'string' ? { error } : {}) } }
            : {}),
        };
      }),
      servers: listOf(mcp).map((one) => String(one['name'])),
      config: listOf(config).map((one) => ({
        type: String(one['type']),
        ...(typeof one['path'] === 'string' ? { path: one['path'] } : {}),
      })),
      models: listOf(models).map((one) => ({ id: String(one['id']), providerID: String(one['providerID']) })),
    };
  }

  function refuseOpen(reason: RefusalReason, detail: string): void {
    gate?.raise(reason, detail, 'open');
    fail(`${reason}: ${detail}`);
  }

  async function open(): Promise<void> {
    if (gate === null) return;
    const spending = new OpenBudget('opencode', runtime.openDeadlineMs ?? OPENCODE_OPEN_DEADLINE_MS);
    budget = spending;
    const nodeProblem = (runtime.nodeProblem ?? nodeCanRunOpencode)();
    if (nodeProblem !== null) return fail(`runtime-unavailable: ${nodeProblem}`);
    const install = (runtime.readInstall ?? readOpencodeInstall)(runtime.sdk);
    if (!install.ok) return fail(`${install.refusal.reason}: ${install.refusal.detail}`);

    // A home a host left behind when it did not close it is cleared now, its database kept for a resume.
    for (const problem of sweepOpencodeHomes(runtime.base).problems) degrade(problem);
    const made = createOpencodeSessionHome(runtime.base);
    if (!made.ok) return fail(`${made.refusal.reason}: ${made.refusal.detail}`);
    home = made.value;
    if (resumeId !== null) {
      const carried = carryOpencodeStateIn(runtime.base, home.database, resumeId);
      if (!carried.ok) return fail(`${carried.refusal.reason}: ${carried.refusal.detail}`);
    }
    const shell = runtime.shell ?? opencodeShellPath(process.platform, request.env);
    gate.useShell(shell);
    const env = opencodeHostEnv(request.env, home.env);
    // The agent's commands run with the shell's environment, not the host process's: the local gate reads
    // a command's variables as the shell will.
    gate.spawnedWith(opencodeShellEnv(request.env));
    const prompt = request.systemPrompt;
    const append = isRuntimeDefaultPrompt(prompt) ? (prompt.append ?? '') : '';
    const instructions: string[] = [];
    if (append !== '') {
      const file = join(home.home, 'instructions.md');
      writeFileSync(file, append, { mode: 0o600 });
      instructions.push(file);
    }
    const config = opencodeConfig({
      provider:
        route === null || providerId === null ? null : { id: providerId, entry: opencodeProvider(route) },
      model,
      servers: servers.ok ? servers.value : {},
      skills: skills.directories,
      instructions,
      shell,
    });
    if (closed) return;

    const connect = runtime.connect ?? connectOpencodeHost;
    const connected = await connect({
      cwd: request.cwd,
      env,
      install: runtime.sdk,
      database: home.database,
      configDirectory: home.configDirectory,
      config: opencodeConfigText(config),
      openDeadlineMs: spending.enter("the host process's open"),
      onEvent,
      gatedTools: OPENCODE_HELD_TOOLS,
      onHeldCall,
      onBegan: (call) => gate.began(call),
      onStreamEnd: (detail) => {
        if (!closed) fail(`runtime-unavailable: the opencode server's event stream ended (${detail})`);
      },
      onExit: (exit: ChildExit) => {
        // While the host process opens, the open's own answer says how it ended: an exit then, its own or
        // the one a refused open ends it with, would take the place of the step's name.
        if (connection === null) return;
        if (!closed && failure === null)
          failure = new Error(`the opencode host process exited (${describeExit(exit)})${lastWords()}`);
        if (!closed) void shutDown();
      },
      onStderr: (line: string) => {
        keepStderr(line);
        request.onStderr?.(`${line}\n`);
      },
      // A line of the host process's that this host dropped is something the session lost: it is said on
      // the session's state lane, once per reason, as well as in the host's log.
      onRefusal: (refusal) => {
        degrade(`${refusal.reason}: ${refusal.detail}`);
        gate.raise(refusal.reason, refusal.detail, 'transport');
      },
      ...(runtime.killTree === undefined ? {} : { killTree: runtime.killTree }),
      closeGraceMs: grace,
    });
    if (!connected.ok) {
      if (spending.overran(connected.refusal.reason === 'rpc-request-timed-out')) {
        return fail(`runtime-unavailable: ${spending.overrun()}${lastWords()}`);
      }
      return fail(`${connected.refusal.reason}: ${connected.refusal.detail}${lastWords()}`);
    }
    connection = connected.value;
    if (closed) {
      await connection.close();
      return;
    }

    // The plugins are active once the model list answers: every read after it sees the configured server.
    const location = { location: { directory: request.cwd } };
    const models = await openCall('model.list', location);
    const rules = opencodeRuleset();
    let info: Record<string, unknown>;
    if (resumeId === null) {
      info = recordOf(
        await openCall('session.create', {
          location: { directory: request.cwd },
          permissions: rules as unknown as JsonValue,
          agent,
          ...(providerId === null || model === null ? {} : { model: { id: model, providerID: providerId } }),
        }),
        'session.create',
      );
    } else if (request.fork) {
      info = recordOf(await openCall('session.fork', { sessionID: resumeId }), 'session.fork');
    } else {
      info = recordOf(await openCall('session.get', { sessionID: resumeId }), 'session.get');
    }
    const id = opencodeWord(info['id']);
    if (id === null) return fail('runtime-unavailable: the opencode server named no session');
    sessionId = id;
    home.holds(id);
    agent = opencodeWord(info['agent']) ?? agent;
    gate.identify(id);
    await openCall('session.environment', { sessionID: id, variables: opencodeShellEnv(request.env) });
    if (resumeId !== null) await adoptEarlierSessions(id);
    if (
      resumeId !== null &&
      opencodeWord(info['agent']) !== OPENCODE_AGENTS[request.permissionMode === 'plan' ? 'plan' : 'default']
    ) {
      const wanted = OPENCODE_AGENTS[request.permissionMode === 'plan' ? 'plan' : 'default'];
      await openCall('session.switchAgent', { sessionID: id, agent: wanted });
      agent = wanted;
    }
    if (closed) return;

    // The posture, read back before the first prompt.
    const read = await readPosture(id, models);
    const unread = opencodeReadBackProblem(read, {
      servers: Object.keys(servers.ok ? servers.value : {}),
      home: home.home,
      providerId,
    });
    if (unread !== null) return refuseOpen('opencode-gate-not-active', unread);
    // The gate counts only when the server states it active: one it lists as failed, or with no state, is
    // a hook that decides nothing.
    const gateMissing = opencodeGateNotActive(read.plugins);
    if (gateMissing !== null) {
      gate.preCallHook(false);
      // Named, and the session opens: every call that raises a request is still decided.
      gate.raise(
        'gate-hook-missing',
        `${gateMissing}, so a shell line the runtime reads no command in would run with no decision of this host's`,
        'open:gate-plugin',
      );
    }
    if (closed) return;

    opened = true;
    spending.finish();
    settleProven(true);
    output.push({
      kind: 'opened',
      sessionId: id,
      model: opencodeModelName(info['model']) ?? (model === null ? null : model),
      agent,
      origin: resumeId === null ? 'new' : request.fork ? 'fork' : 'resume',
    });
    // A run the server restarted at its creation may have asked before this process read the stream.
    void takeUpWaitingRequests();
    for (const text of held.splice(0)) send(text);
  }

  function send(text: string): void {
    const id = sessionId;
    if (id === null || connection === null) {
      degrade('a prompt was not sent: the session is not open');
      return;
    }
    outstanding += 1;
    call('session.prompt', { sessionID: id, text, delivery: 'queue' }).catch((error: unknown) => {
      outstanding = Math.max(0, outstanding - 1);
      degrade(`a prompt was not sent: ${wordsOf(error)}`);
    });
  }

  function shutDown(): Promise<void> {
    closing ??= (async () => {
      closed = true;
      budget?.finish();
      held.length = 0;
      // A call still waiting on the open's proof ends refused: the session never opened, or is closing.
      settleProven(false);
      try {
        gate?.closing();
      } catch {
        // A degrade the gate failed to name must not stop the close.
      }
      decisions.abort();
      const live = connection;
      connection = null;
      if (live !== null) {
        if (sessionId !== null) {
          // The run ends first, while the server can still say so; the session stays in the database.
          const interrupted = await live
            .call('session.interrupt', { sessionID: sessionId }, grace)
            .catch(() => null);
          if (interrupted !== null && !interrupted.ok)
            degrade(`the run was not interrupted: ${interrupted.refusal.detail}`);
        }
        // The connection's close ends what the process started, then the process: it closes its server and
        // exits when its stdin ends, and one that does not exit within the grace has its tree ended.
        await live.close();
      }
      if (home !== null && sessionId !== null) {
        const kept = carryOpencodeStateOut(runtime.base, home.database, sessionId);
        if (!kept.ok) degrade(kept.refusal.detail);
      }
      const removing = home;
      home = null;
      if (removing !== null) {
        const removed = removing.remove();
        if (!removed.ok) degrade(removed.refusal.detail);
      }
      output.end();
    })();
    return closing;
  }

  async function control(what: string, run: (id: string) => Promise<unknown>): Promise<void> {
    if (closed) return;
    const id = sessionId;
    if (id === null || !opened) throw new Error(`${what}: the opencode session is not open yet`);
    await within(run(id), OPENCODE_CALL_DEADLINE_MS, what);
  }

  if (problem !== null) {
    failure = new Error(problem);
    void Promise.resolve().then(() => output.end());
  } else {
    void Promise.resolve()
      .then(() => open())
      .catch((error: unknown) =>
        fail(
          error instanceof OpenOverrun
            ? `runtime-unavailable: ${error.message}${lastWords()}`
            : `runtime-unavailable: the opencode session could not open: ${wordsOf(error)}${lastWords()}`,
        ),
      );
  }

  async function* messages(): AsyncGenerator<OpencodeMessage, void> {
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
      if (closed || !opened || sessionId === null) return;
      // A subagent runs in a session of its own, which the server does not interrupt with its parent's: the
      // interrupt reaches the session and every subagent with a run under way, and ends the decisions each
      // of the session's sessions still waits on.
      const running = [sessionId, ...runningChildren];
      for (const one of new Set([...running, ...family.keys()])) {
        gate?.endPending(one, 'the turn was interrupted while this decision was outstanding');
      }
      await Promise.all(
        running.map((one) =>
          call('session.interrupt', { sessionID: one }).catch((error: unknown) =>
            degrade(
              `${one === sessionId ? 'the turn' : `the subagent session ${one}`} was not interrupted: ${wordsOf(error)}`,
            ),
          ),
        ),
      );
    },
    async setModel(selected: string | null): Promise<void> {
      const next = selected ?? model;
      if (next === null) return;
      if (route === null || providerId === null) {
        throw new Error(
          `model ${next} names no endpoint; an opencode session reaches a model only through one`,
        );
      }
      if (!route.models.includes(next))
        throw new Error(`model ${next} is not one the endpoint ${route.name} lists`);
      await control('the model', (id) =>
        call('session.switchModel', { sessionID: id, model: { id: next, providerID: providerId } }),
      );
    },
    async setPermissionMode(requested: string): Promise<void> {
      if (!(OPENCODE_PERMISSION_MODES as readonly string[]).includes(requested)) {
        throw new Error(`opencode takes ${OPENCODE_PERMISSION_MODES.join(', ')}, not ${requested}`);
      }
      const wanted = OPENCODE_AGENTS[requested as (typeof OPENCODE_PERMISSION_MODES)[number]];
      await control('the agent', (id) => call('session.switchAgent', { sessionID: id, agent: wanted }));
      agent = wanted;
    },
    setThinking(thinking: ThinkingConfig): Promise<void> {
      if (thinking.type === 'adaptive') return Promise.resolve();
      return Promise.reject(
        new Error('opencode has no thinking switch; its reasoning is set by a model variant'),
      );
    },
    setEffort(level: string): Promise<void> {
      return Promise.reject(
        new Error(
          `effort ${level}: opencode sets reasoning through a model's variants, and this host's endpoints declare none`,
        ),
      );
    },
    pluginsApplied(): Promise<boolean | null> {
      // The skills handed over are read by the server itself; it gives no answer for the set as a whole.
      return Promise.resolve(null);
    },
    openStep(): string | null {
      return budget?.describe() ?? null;
    },
    close(): void {
      if (closed) return;
      void shutDown();
    },
  };
}
