/**
 * One Copilot session's gate: the joined route. The runtime's pre-tool hook answers `ask` for every call, at
 * once and with no I/O, and the `hook` permission request that raises is decided by the per-call decision
 * every runtime shares. Neither half gates every call and fails closed on its own: the hook is documented
 * as firing for every tool but fails open (the SDK turns a thrown handler into no answer, and the runtime
 * lets a call proceed when the hook times out or has no route), and the permission service asks only where
 * its own flow does. Joined, the hook makes every call ask, and the request waits on silence and is denied
 * when the handler fails.
 *
 * What the request carries: the call's id (`toolCallId`), the tool's name and arguments and the directory
 * it runs in. The decision request names the tool in this host's spelling: a built-in as Copilot names it,
 * an MCP tool as `mcp__{server}__{tool}`, mapped from Copilot's `{server}-{tool}` by the tools each attached
 * server lists, never by splitting on a hyphen (a server's name and a tool's may hold one). A name that
 * maps to no attached server's tool, or to more than one, keeps Copilot's spelling, so a controller holds it
 * as a stranger's.
 *
 * Only one-time answers are ever sent: one call approved, or refused with the outcome's words, which the
 * model is told. An allow that rewrites the input is refused: the rewrite lives only in the fail-open hook
 * (`canRewriteInput: false`). A call of a tool this host turns off (`COPILOT_EXCLUDED_TOOLS`) is refused
 * here without asking anyone.
 *
 * A `hook` request carries no session, so it is tied to the hook that raised it by the call id, the tool's
 * name and the arguments. Every hook announced under an id is kept until a request is tied to it: two calls
 * a provider gives one id (a sub-agent's and the session's own, running at once) are each decided on their
 * own hook. A request is refused, and nobody is asked, when no hook announced its id, when the one hook
 * under its id named another tool, or when several hooks under its id announced calls and none, or more
 * than one that differ, fits it.
 *
 * What it names, each a degrade raised once per (name, key):
 * - `gate-hook-missing`: a permission request of any kind but `hook` (the runtime's own flow, so the hook
 *   did not ask; the request is refused, never decided), a `hook` request that cannot be tied to one hook
 *   (above; refused), a `hook` request whose arguments are not the ones its one hook announced (the call is
 *   decided on the hook's, and this host's own gate reads the request's as well, so a refusal of either
 *   reading refuses the call), a
 *   pre-tool hook the runtime reports as failed, or a call that finished with no decision of this host's
 *   behind it: none at all, one still being awaited, or a refusal the call ran against. Each call's answer
 *   is kept by its thread (the session's own, or a sub-agent's) and its id until the call finishes and
 *   forgotten then, so a provider that hands out the same call id again starts with no answer;
 * - `gate-hook-foreign`: a hook this host did not install decided a request (`resolvedByHook`), or a
 *   machine-wide policy hook was found when the session opened;
 * - `gate-unhooked-call`: a provider-hosted tool ran (`assistant.server_tool_progress`), which no hook sees;
 * - `gate-mode-widened`: the runtime reports a permission mode other than `manual`, or an agent mode other
 *   than `interactive` and `plan`;
 * - `gate-tool-unnamed`: the runtime offers, or the model called, a built-in this host's tables do not name
 *   (`COPILOT_TOOL_KINDS`, `COPILOT_OTHER_TOOLS`, `COPILOT_EXCLUDED_TOOLS`). The session opens and the call is
 *   asked about as any other is, kind `other`; the name is said so the tables can learn it.
 */
import { isDeepStrictEqual } from 'node:util';

import type { RefusalReason } from '../core/refusal.js';
import type { CallDecision } from '../gate/call-decision.js';
import { createCallDecision } from '../gate/call-decision.js';
import type { Decider, DecisionRequest, ShellDialect } from '../gate/decision.js';
import type { LocalGate } from '../gate/local.js';
import type { GateOutcome, TerminalOutcome } from '../gate/outcome.js';
import {
  COPILOT_EXCLUDED_TOOLS,
  COPILOT_OTHER_TOOLS,
  COPILOT_TOOL_KINDS,
  copilotShellDialect,
  copilotToolKind,
} from '../gate/tool-kind.js';
import { COPILOT_RUNTIME } from '../sessions/runtimes.js';
import { HOOK_TIMEOUT_EVENT } from '../state/model.js';
import type { SpawnDegrade } from './codex-gate.js';
import type {
  CopilotEvent,
  CopilotPermissionAnswer,
  CopilotPermissionRequest,
  CopilotPreToolInput,
  CopilotPreToolOutput,
} from './copilot-sdk.js';

/** The one permission mode this host admits on Copilot: every call asks. */
export const COPILOT_ADMITTED_PERMISSION_MODE = 'manual';

/** The agent modes this host admits on Copilot. `autopilot` is refused: it continues turns by itself. */
export const COPILOT_ADMITTED_AGENT_MODES: readonly string[] = ['interactive', 'plan'];

/**
 * How long a permission request was measured to wait on this host with no runtime-side timeout: 240 seconds,
 * on runtime 1.0.112 (SDK 1.0.34). A deadline longer than that is not known to win, so a session
 * asking for one is refused (`copilotDeadlineOrderRefusal`).
 */
export const COPILOT_MEASURED_PERMISSION_WAIT_MS = 240_000;

/**
 * The longest a decision waits to learn an attached server's tools before the call is asked about under the
 * name the runtime gave it: this long, or a quarter of the decision's deadline when that is shorter. What
 * the wait takes comes out of the decision's deadline, so the two together never outlast it.
 */
export const COPILOT_TOOL_LIST_WAIT_MS = 10_000;

/** What the hook tells the runtime beside its `ask`, which the runtime carries on the request as `hookMessage`. */
export const COPILOT_HOOK_REASON = 'this host decides every call';

/** The tools that read what a command in the shell's background mode has written. */
const COPILOT_SHELL_READERS: readonly string[] = ['read_powershell', 'read_bash'];

/** The prefix of the call ids this host mints for its own probe call at the open. */
export const COPILOT_PROBE_ID_PREFIX = 'periscope-route-probe-';

/** How many call ids one session keeps hook inputs for while their requests are outstanding. */
const MAX_PENDING_HOOKS = 1024;
/** How many calls one call id keeps hook inputs for: a request matching none of them is refused. */
const MAX_HOOKS_PER_ID = 16;
/** How many calls' answers one session keeps while the calls have not finished. */
const MAX_DECIDED_IDS = 8192;
/**
 * How many distinct degrades one session raises on its state lane at most. One past it is handed to
 * `onDegradePastCap` instead, each time it occurs, so the host's own log still has it.
 */
export const MAX_RAISED_DEGRADES = 4096;

/**
 * Why a Copilot session's decision deadline is not known to sit inside the runtime's own wait for a
 * permission answer, or null when it is.
 */
export function copilotDeadlineOrderRefusal(decisionTimeoutMs: number): string | null {
  if (decisionTimeoutMs <= COPILOT_MEASURED_PERMISSION_WAIT_MS) return null;
  return (
    `decisionTimeoutMs (${decisionTimeoutMs}ms) is longer than Copilot's wait for a permission answer is ` +
    `known to be: a request was measured to wait ${COPILOT_MEASURED_PERMISSION_WAIT_MS}ms with no timeout of ` +
    `the runtime's own (runtime 1.0.112), and no longer wait has been measured. Set decisionTimeoutMs at or ` +
    `below ${COPILOT_MEASURED_PERMISSION_WAIT_MS}ms for a Copilot session.`
  );
}

/** What the runtime is told for one terminal outcome. A refusal's words are what the model reads. */
export function copilotAnswerOf(outcome: TerminalOutcome): CopilotPermissionAnswer {
  switch (outcome.kind) {
    case 'allow':
      return { kind: 'approve-once' };
    case 'deny':
      return { kind: 'reject', feedback: outcome.message };
    case 'refused':
      return { kind: 'reject', feedback: `${outcome.refusal.reason}: ${outcome.refusal.detail}` };
    case 'expired':
      return { kind: 'reject', feedback: `${HOOK_TIMEOUT_EVENT}: ${outcome.detail}` };
  }
}

/** Whether `name` is one of the runtime's own built-ins, as this host knows them. */
export function isCopilotBuiltin(name: string): boolean {
  return (
    Object.hasOwn(COPILOT_TOOL_KINDS, name) ||
    COPILOT_OTHER_TOOLS.includes(name) ||
    COPILOT_EXCLUDED_TOOLS.includes(name)
  );
}

/**
 * Copilot's name for an MCP tool in this host's spelling. `servers` maps each attached server's name to the
 * tools it lists. Exactly one (server, tool) pair whose `{server}-{tool}` equals `name` maps it to
 * `mcp__{server}__{tool}`; none, or more than one, keeps `name` as it came.
 */
export function copilotMcpToolName(name: string, servers: ReadonlyMap<string, readonly string[]>): string {
  const found: string[] = [];
  for (const [server, tools] of servers) {
    if (!name.startsWith(`${server}-`)) continue;
    const tool = name.slice(server.length + 1);
    if (tools.includes(tool)) found.push(`mcp__${server}__${tool}`);
  }
  return found.length === 1 ? (found[0] ?? name) : name;
}

/** One Copilot session's gate, as its process uses it. */
export interface CopilotSessionGate {
  /** Marks this as a Copilot session's gate, for the registry's route. */
  readonly runtime: typeof COPILOT_RUNTIME;
  /** The pre-tool hook. Synchronous, never throws, does no I/O: it records the call and answers `ask`. */
  preToolUse(input: CopilotPreToolInput): CopilotPreToolOutput;
  /** Answers one permission request. Never rejects. */
  decide(request: CopilotPermissionRequest, signal?: AbortSignal): Promise<CopilotPermissionAnswer>;
  /**
   * Ends every decision still waiting, in `why`'s words: each is refused now, and a call asked about after
   * this is decided afresh. For an interrupt, whose turn the runtime ends without any call running.
   */
  endPending(why: string): void;
  /** Told every session event: the degrades it can name are read here. */
  observe(event: CopilotEvent): void;
  /** Told the session's id once the runtime has named it. */
  identify(sessionId: string): void;
  /** Told the environment the runtime is started with, for the local gate's reading of path variables. */
  spawnedWith(env: Readonly<Record<string, string | undefined>>): void;
  /** Told an attached server's tools, as the runtime lists them, for the MCP spelling. */
  serverTools(server: string, tools: readonly string[]): void;
  /**
   * Told every tool the runtime offers the session at its open, and which of them an attached server
   * brings. A built-in among them that the tables do not name is named, once each.
   */
  toolsOffered(names: readonly string[], fromServers: readonly string[]): void;
  /** Told how to ask the runtime for an attached server's tools, when a decision needs them and none are known. */
  useToolLister(list: (server: string) => Promise<readonly string[] | null>): void;
  /** Spells a tool name as the decision requests and the items carry it. */
  toolName(copilotName: string): string;
  /** Mints the id of the probe call the open makes. `reach` reads how far the call got, at once. */
  probe(): { readonly id: string; reach(): CopilotProbeReach };
  /** A named degrade on the session's state lane, once per (name, key). */
  raise(name: RefusalReason, detail: string, key: string): void;
  /** The degrades known at the open, for the opening tier, each raised once with its detail. */
  stateSpawnDegrades(found: readonly SpawnDegrade[]): void;
}

/** How far the open's probe call got. */
export interface CopilotProbeReach {
  /** The pre-tool hook fired for it. */
  readonly hooked: boolean;
  /** A `hook` request for it reached this host, which refused it. */
  readonly asked: boolean;
  /** A request of another kind for it reached this host: the runtime's own flow. */
  readonly otherKind: string | null;
}

export interface CopilotSessionGateOptions {
  readonly sessionKey: string;
  /** The session's working directory: where a call that names none runs. */
  readonly cwd: string;
  readonly decide: Decider;
  readonly localGate?: LocalGate;
  readonly decisionTimeoutMs: number;
  readonly holdAfterMs: number;
  /** The names of the MCP servers the session attached. */
  readonly servers: readonly string[];
  /** Told every gate outcome: the session's machine, its items, the embedder. */
  readonly onOutcome: (outcome: GateOutcome) => void;
  /** A degrade for the session's state lane. */
  readonly onDegrade: (name: RefusalReason, detail: string) => void;
  /** A degrade the session's lane takes no more of: for the host's log alone. */
  readonly onDegradePastCap?: (name: RefusalReason, detail: string) => void;
  /** The degrades known at the open, for the opening tier. */
  readonly onSpawnDegrades: (names: readonly RefusalReason[]) => void;
  /** Told every environment the session's runtime is started with, for the local gate. */
  readonly spawnedWith?: (env: Readonly<Record<string, string | undefined>>) => void;
  /** Mints the probe's call id. Defaults to a random one. */
  readonly probeId?: () => string;
}

interface HookedCall {
  /** The runtime session the hook fired in: a sub-agent's call fires in the sub-agent's own. */
  readonly sessionId: string;
  readonly toolName: string;
  /** The arguments the hook announced the call with: what the runtime said it would run. */
  readonly toolArgs: unknown;
  readonly workingDirectory: string;
  readonly agentId: string | null;
  readonly agentType: string | null;
}

/** Whether two hooks announced the same call: the same session, thread, tool, arguments and directory. */
function sameAnnouncement(one: HookedCall, other: HookedCall): boolean {
  return (
    one.sessionId === other.sessionId &&
    one.agentId === other.agentId &&
    one.agentType === other.agentType &&
    one.toolName === other.toolName &&
    one.workingDirectory === other.workingDirectory &&
    isDeepStrictEqual(one.toolArgs, other.toolArgs)
  );
}

/** Whether two hooks would be decided alike: the same tool, arguments, directory and thread. */
function decidedAlike(one: HookedCall, other: HookedCall): boolean {
  return (
    one.agentId === other.agentId &&
    one.agentType === other.agentType &&
    one.toolName === other.toolName &&
    one.workingDirectory === other.workingDirectory &&
    isDeepStrictEqual(one.toolArgs, other.toolArgs)
  );
}

/** Whether a request fits a hook: the same tool, and the same arguments where both carry them. */
function fits(request: CopilotPermissionRequest, call: HookedCall): boolean {
  if (named(request.toolName) && request.toolName !== call.toolName) return false;
  return (
    request.toolArgs === undefined ||
    call.toolArgs === undefined ||
    isDeepStrictEqual(call.toolArgs, request.toolArgs)
  );
}

/** The key a call's answer and start are kept by: its thread (a sub-agent's id, or none) and its id. */
function callKey(agentId: string | null | undefined, id: string): string {
  return `${agentId ?? ''}\u0000${id}`;
}

/** How a request was tied to the hooks under its id: to one, or to none, with why. */
type Tie = { readonly call: HookedCall; readonly argumentsDiffer: boolean } | { readonly refused: string };

/**
 * The one hook a `hook` request is tied to among those announced under its id, or why there is none: no
 * hook at all, the one hook under the id naming another tool, or several hooks none of which fits the
 * request, or more than one of which fits it and differs in what the decision reads. One hook of the same
 * tool whose arguments differ is the call's own: it is decided on the hook's and named, and this host's own
 * gate reads the request's arguments as well as the hook's (`bothReadings`).
 */
function tie(request: CopilotPermissionRequest, id: string, calls: readonly HookedCall[]): Tie {
  const fitting = calls.filter((call) => fits(request, call));
  const first = fitting[0];
  if (first !== undefined) {
    if (fitting.every((call) => decidedAlike(call, first))) return { call: first, argumentsDiffer: false };
    return {
      refused: `Copilot asked about call ${id}, and more than one call announced under it fits the request; refused rather than decided on either`,
    };
  }
  const only = calls.length === 1 ? calls[0] : undefined;
  if (only === undefined) {
    return calls.length === 0
      ? { refused: `Copilot asked about call ${id}, which no pre-tool hook announced; refused` }
      : {
          refused: `Copilot asked about call ${id} with a tool and arguments none of the ${calls.length} calls announced under it carries; refused`,
        };
  }
  if (named(request.toolName) && request.toolName !== only.toolName) {
    return {
      refused: `Copilot asked about call ${id} as ${request.toolName}, which its pre-tool hook announced as ${only.toolName}; refused`,
    };
  }
  return { call: only, argumentsDiffer: true };
}

/**
 * What this host has said about one call that has not finished yet: it is still being asked about, it was
 * allowed, it was refused, or a hook this host did not install answered for it.
 */
type CallAnswer = 'awaited' | 'allowed' | 'refused' | 'foreign';

interface ProbeState {
  readonly id: string;
  hooked: boolean;
  asked: boolean;
  otherKind: string | null;
}

/** Whether `value` is a non-empty string. */
function named(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** A record of `value`, or an empty one. */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Whose report an event is: the session's own, or a sub-agent's. A sub-agent's events carry its id, the
 * session-scoped kinds among them, so a mode one of them reports is said of that sub-agent and never of
 * the session.
 */
function whose(event: CopilotEvent): string {
  return named(event.agentId) ? `A sub-agent of the Copilot session (${event.agentId})` : 'Copilot';
}

/** What an event's thread adds to a degrade's key: nothing for the session's own, the sub-agent's id for one of its. */
function threadKey(event: CopilotEvent): string {
  return named(event.agentId) ? `@${event.agentId}` : '';
}

/** Build one Copilot session's gate. */
export function createCopilotSessionGate(options: CopilotSessionGateOptions): CopilotSessionGate {
  const raised = new Set<string>();
  // Every hook announced under a call id whose request has not come, in the order announced. A provider may
  // hand two calls running at once (a sub-agent's and the session's own) one id, so an id holds a list.
  const hooked = new Map<string, HookedCall[]>();
  // Each unfinished call's answer, by its thread and its call id (`callKey`): the hook names a sub-agent's
  // call by the sub-agent's id, as its events do. An entry leaves when its call finishes, so an id a
  // provider hands out again is a new call.
  const answers = new Map<string, CallAnswer>();
  // What each running call's start said of it, by its thread and its call id, until it finishes: the
  // runtime names a call's tool when it starts and not when it ends.
  const started = new Map<string, { readonly tool: string | null; readonly shell: string | null }>();
  // The background commands the runtime has said ended, by their shell ids.
  const endedShells = new Set<string>();
  const servers = new Map<string, readonly string[]>(options.servers.map((server) => [server, []]));
  // The offered tools the runtime says an attached server brings: never a built-in, whatever their names.
  const fromServers = new Set<string>();
  // One for each decision still waiting, so the waiting ones can be ended without ending the session's.
  const waiting = new Set<AbortController>();
  let sessionId = '';
  let probe: ProbeState | null = null;
  let listTools: ((server: string) => Promise<readonly string[] | null>) | null = null;

  // Each server whose tools are being asked for now, so one is asked once however many calls name it.
  const asking = new Map<string, Promise<void>>();

  // A name that could be an attached server's tool, for a server whose tools are not known yet: ask for them,
  // so the spelling is decided from what the server lists. The wait is the decision's own: it ends with the
  // decision's signal, and after `COPILOT_TOOL_LIST_WAIT_MS` or a quarter of the decision's deadline,
  // whichever is shorter. A list that arrives later is kept for the next call. True when it waited at all.
  const learnServers = async (name: string, signal: AbortSignal): Promise<boolean> => {
    if (listTools === null || isCopilotBuiltin(name) || signal.aborted) return false;
    const list = listTools;
    const unknown = [...servers]
      .filter(([server, tools]) => tools.length === 0 && name.startsWith(`${server}-`))
      .map(([server]) => server);
    if (unknown.length === 0) return false;
    const answered = Promise.all(
      unknown.map((server) => {
        const running = asking.get(server);
        if (running !== undefined) return running;
        const one = (async (): Promise<void> => {
          try {
            const listed = await list(server);
            if (listed !== null) servers.set(server, [...listed]);
          } catch {
            // An unanswered list leaves the server's tools unknown, so the name keeps Copilot's spelling.
          } finally {
            asking.delete(server);
          }
        })();
        asking.set(server, one);
        return one;
      }),
    );
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(COPILOT_TOOL_LIST_WAIT_MS, options.decisionTimeoutMs / 4));
      signal.addEventListener('abort', done, { once: true });
      void answered.then(done);
    });
    return true;
  };

  const raise = (name: RefusalReason, detail: string, key: string): void => {
    const id = `${name}\u0000${key}`;
    if (raised.has(id)) return;
    if (raised.size >= MAX_RAISED_DEGRADES) {
      try {
        options.onDegradePastCap?.(name, detail);
      } catch {
        // A log that throws must not stop the gate answering the call this was raised beside.
      }
      return;
    }
    raised.add(id);
    try {
      options.onDegrade(name, detail);
    } catch {
      // A listener that throws must not stop the gate answering the call it was raised beside.
    }
  };

  const remember = (key: string, answer: CallAnswer): void => {
    if (!answers.has(key) && answers.size >= MAX_DECIDED_IDS) {
      const oldest = answers.keys().next().value;
      if (oldest !== undefined) answers.delete(oldest);
    }
    answers.set(key, answer);
  };

  // Lets go of the hooks a request was tied to; an id with none left leaves the map.
  const forget = (id: string, tied: readonly HookedCall[]): void => {
    const left = (hooked.get(id) ?? []).filter((call) => !tied.includes(call));
    if (left.length === 0) hooked.delete(id);
    else hooked.set(id, left);
  };

  // This host's own gate over both readings of a call whose request carries other arguments than its hook
  // announced: the hook's, which the call is decided on, and the request's own. Which of the two the runtime
  // then runs is not this host's to know, so a refusal of either refuses the call, and a difference that
  // changes nothing the gate reads changes no answer.
  const bothReadings = (requested: unknown): LocalGate | undefined => {
    const local = options.localGate;
    if (local === undefined) return undefined;
    return (request) => local(request) ?? local({ ...request, toolInput: requested ?? null });
  };

  // The decision for a call that has already waited `spentMs` of its deadline, behind `local`.
  const decisionAfter = (spentMs: number, local: LocalGate | undefined = options.localGate): CallDecision =>
    createCallDecision({
      decide: options.decide,
      onOutcome: options.onOutcome,
      sessionKey: options.sessionKey,
      runtime: COPILOT_RUNTIME,
      ...(local === undefined ? {} : { localGate: local }),
      decisionTimeoutMs: Math.max(1, options.decisionTimeoutMs - spentMs),
      holdAfterMs: Math.max(0, options.holdAfterMs - spentMs),
      // The rewrite lives only in the fail-open hook; the request can only approve or refuse the call asked.
      canRewriteInput: false,
    });
  const decideCall: CallDecision = decisionAfter(0);

  const toolName = (copilotName: string): string =>
    isCopilotBuiltin(copilotName) ? copilotName : copilotMcpToolName(copilotName, servers);

  // A tool that is no built-in the tables hold, no server's tool by the runtime's own list and no name an
  // attached server's tools could carry: a built-in this host has no row for. Said once per tool.
  const nameIfUnnamed = (name: string, when: string): void => {
    if (!named(name) || isCopilotBuiltin(name) || fromServers.has(name)) return;
    if (toolName(name) !== name) return;
    for (const server of servers.keys()) if (name.startsWith(`${server}-`)) return;
    raise(
      'gate-tool-unnamed',
      `Copilot ${when} the tool ${name}, which this host's tables do not name: it has no kind but other and no local family, so each of its calls is asked about like any other and nothing here bounds what it does`,
      name,
    );
  };

  const requestOf = (
    raw: CopilotPermissionRequest,
    call: HookedCall,
    toolCallId: string,
  ): DecisionRequest | null => {
    // The request was tied to this hook by its tool's name, so the two name the same tool when both do.
    const name = named(raw.toolName) ? raw.toolName : call.toolName;
    if (!named(name)) return null;
    const spelled = toolName(name);
    const toolKind = copilotToolKind(spelled);
    const dialect: ShellDialect | null = toolKind === 'shell' ? copilotShellDialect(name) : null;
    return {
      toolName: spelled,
      toolUseId: toolCallId,
      // The arguments the hook announced are the call's own; the request's stand in where it announced none.
      toolInput: (call.toolArgs === undefined ? raw.toolArgs : call.toolArgs) ?? null,
      sessionId,
      sessionKey: options.sessionKey,
      // A call runs in the directory the runtime names for it; the session's own when it names none.
      cwd: /^([A-Za-z]:[\\/]|[\\/])/.test(call.workingDirectory) ? call.workingDirectory : options.cwd,
      agentId: call.agentId,
      agentType: call.agentType,
      toolKind,
      runtime: COPILOT_RUNTIME,
      ...(dialect === null ? {} : { shellDialect: dialect }),
    };
  };

  return {
    runtime: COPILOT_RUNTIME,
    preToolUse(input) {
      try {
        const id = input.toolCallId;
        if (named(id)) {
          const call: HookedCall = {
            sessionId: named(input.sessionId) ? input.sessionId : '',
            toolName: named(input.toolName) ? input.toolName : '',
            toolArgs: input.toolArgs,
            workingDirectory: named(input.workingDirectory) ? input.workingDirectory : '',
            agentId: named(input.agentId) ? input.agentId : null,
            agentType: named(input.agentType) ? input.agentType : null,
          };
          const calls = hooked.get(id);
          if (calls === undefined) {
            if (hooked.size >= MAX_PENDING_HOOKS) {
              const oldest = hooked.keys().next().value;
              if (oldest !== undefined) hooked.delete(oldest);
            }
            hooked.set(id, [call]);
          } else if (!calls.some((one) => sameAnnouncement(one, call))) {
            // A hook the runtime fires again for the same call adds nothing; another call under the id is kept
            // beside the first, and past the bound the oldest is let go (its request is then refused).
            if (calls.length >= MAX_HOOKS_PER_ID) calls.shift();
            calls.push(call);
          }
          if (probe !== null && probe.id === id) probe.hooked = true;
        }
      } catch {
        // The hook answers `ask` whatever happened above: an answer it failed to give is a call let through.
      }
      return { permissionDecision: 'ask', permissionDecisionReason: COPILOT_HOOK_REASON };
    },
    async decide(raw, signal) {
      const kind = typeof raw.kind === 'string' ? raw.kind : '(none)';
      const id = named(raw.toolCallId) ? raw.toolCallId : null;
      if (probe !== null && id === probe.id) {
        // The open's own probe: refused here, never asked of anyone, and never run.
        if (kind === 'hook') probe.asked = true;
        else probe.otherKind = kind;
        return { kind: 'reject', feedback: 'this host checks its route before the first prompt' };
      }
      if (kind !== 'hook') {
        raise(
          'gate-hook-missing',
          `Copilot asked for a ${kind} permission${id === null ? '' : ` for call ${id}`} through its own flow, so the pre-tool hook did not ask; refused rather than decided`,
          id ?? kind,
        );
        if (id !== null) {
          // The hooks this request is the runtime's own question about are answered by its refusal.
          const own = (hooked.get(id) ?? []).filter((call) => fits(raw, call));
          forget(id, own);
          for (const call of own.length > 0 ? own : [null]) remember(callKey(call?.agentId, id), 'refused');
        }
        return {
          kind: 'reject',
          feedback: `gate-hook-missing: this host decides a call only through its pre-tool hook, and this ${kind} request did not come through it`,
        };
      }
      if (id === null) {
        raise('gate-hook-missing', 'Copilot asked about a call that carries no call id; refused', 'no-id');
        return { kind: 'reject', feedback: 'gate-hook-missing: the request names no call' };
      }
      const calls = hooked.get(id) ?? [];
      const tied = tie(raw, id, calls);
      if ('refused' in tied) {
        // The hooks under the id are other calls' and stay for their own requests.
        remember(callKey(calls.length === 1 ? calls[0]?.agentId : null, id), 'refused');
        raise('gate-hook-missing', tied.refused, id);
        return {
          kind: 'reject',
          feedback:
            calls.length === 0
              ? 'gate-hook-missing: no pre-tool hook announced this call'
              : 'gate-hook-missing: this request cannot be tied to the one call its pre-tool hook announced',
        };
      }
      const call = tied.call;
      forget(id, [call]);
      const key = callKey(call.agentId, id);
      // Refused until an answer says otherwise: every way out of here but an allow is a refusal.
      remember(key, 'refused');
      const asked = named(raw.toolName) ? raw.toolName : call.toolName;
      if (COPILOT_EXCLUDED_TOOLS.includes(asked)) {
        // Left out of every session's tools and read back absent at the open; refused here as well, so a
        // list the runtime widens later cannot run one.
        return {
          kind: 'reject',
          feedback: `${asked} is turned off in every session this host runs: no decision request can say what it runs`,
        };
      }
      if (tied.argumentsDiffer) {
        raise(
          'gate-hook-missing',
          `Copilot asked about call ${id} with other arguments than its pre-tool hook announced for it; the call is decided on the arguments the hook announced, and this host's own gate reads both`,
          `arguments:${id}`,
        );
      }
      remember(key, 'awaited');
      // The decision ends with the session's signal or with its own, which an interrupt ends.
      const own = new AbortController();
      const forward = (): void => own.abort(signal?.reason);
      if (signal?.aborted === true) forward();
      else signal?.addEventListener('abort', forward, { once: true });
      waiting.add(own);
      try {
        // Learning a server's tools is part of the decision: what it takes comes out of the deadline.
        const began = Date.now();
        const waited = await learnServers(asked, own.signal);
        nameIfUnnamed(asked, 'was asked to run');
        const request = requestOf(raw, call, id);
        // A request whose arguments are not its hook's is held to this host's own gate in both readings.
        const decideNow = tied.argumentsDiffer
          ? decisionAfter(waited ? Date.now() - began : 0, bothReadings(raw.toolArgs))
          : waited
            ? decisionAfter(Date.now() - began)
            : decideCall;
        const outcome = await decideNow(request, own.signal);
        // Written once the answer is known and before the runtime is told, so a call that finishes after
        // this is read against what it was told.
        remember(key, outcome.kind === 'allow' ? 'allowed' : 'refused');
        return copilotAnswerOf(outcome);
      } finally {
        waiting.delete(own);
        signal?.removeEventListener('abort', forward);
      }
    },
    endPending(why) {
      for (const own of [...waiting]) own.abort(why);
    },
    observe(event) {
      const data = recordOf(event.data);
      switch (event.type) {
        case 'permission.requested': {
          if (data['resolvedByHook'] === true) {
            const inner = recordOf(data['permissionRequest']);
            const id = named(inner['toolCallId']) ? inner['toolCallId'] : null;
            if (id !== null) remember(callKey(event.agentId, id), 'foreign');
            raise(
              'gate-hook-foreign',
              `a hook this host did not install answered Copilot's ${named(inner['kind']) ? inner['kind'] : 'unnamed'} request${id === null ? '' : ` for call ${id}`} before this host was asked`,
              id ?? (named(data['requestId']) ? data['requestId'] : 'request'),
            );
          }
          return;
        }
        case 'hook.end': {
          if (data['hookType'] === 'preToolUse' && data['success'] === false) {
            const error = recordOf(data['error']);
            const words = named(error['message']) ? error['message'] : 'with no reason given';
            raise(
              'gate-hook-missing',
              `Copilot reports this host's pre-tool hook failed (${words}); the runtime lets such a call proceed through its own flow`,
              named(data['hookInvocationId']) ? data['hookInvocationId'] : words,
            );
          }
          return;
        }
        case 'system.notification': {
          const kind = recordOf(data['kind']);
          if (kind['type'] !== 'shell_completed' || !named(kind['shellId'])) return;
          if (endedShells.size >= MAX_DECIDED_IDS) {
            const oldest = endedShells.values().next().value;
            if (oldest !== undefined) endedShells.delete(oldest);
          }
          endedShells.add(kind['shellId']);
          return;
        }
        case 'tool.execution_start': {
          const id = named(data['toolCallId']) ? data['toolCallId'] : null;
          if (id === null || (probe !== null && id === probe.id)) return;
          const key = callKey(event.agentId, id);
          if (!started.has(key) && started.size >= MAX_DECIDED_IDS) {
            const oldest = started.keys().next().value;
            if (oldest !== undefined) started.delete(oldest);
          }
          const shell = recordOf(data['arguments'])['shellId'];
          started.set(key, {
            tool: named(data['toolName']) ? data['toolName'] : null,
            shell: named(shell) ? shell : null,
          });
          return;
        }
        case 'tool.execution_complete': {
          // Read when the call finishes: the decision follows the call's start.
          const id = named(data['toolCallId']) ? data['toolCallId'] : null;
          // Only the probe this gate minted is its own; another id that merely starts the same is a call.
          if (id === null || (probe !== null && id === probe.id)) return;
          const key = callKey(event.agentId, id);
          const answer = answers.get(key);
          answers.delete(key);
          const start = started.get(key);
          started.delete(key);
          if (answer === 'allowed' || answer === 'foreign') return;
          const ran = data['success'] === true;
          // A refused call that did not run is what a refusal is.
          if (answer === 'refused' && !ran) return;
          const tool = named(data['toolName']) ? data['toolName'] : (start?.tool ?? null);
          const call = `call ${id}${tool === null ? '' : ` (${tool})`}`;
          // When a command started in the shell's background mode ends, the runtime reads its output by a
          // call of its own, which reaches no hook and no request: said as what it is.
          const ownRead =
            answer === undefined &&
            tool !== null &&
            COPILOT_SHELL_READERS.includes(tool) &&
            start?.shell != null &&
            endedShells.has(start.shell)
              ? `: the runtime's own read of the output of a background command that had ended (shell ${start.shell}), which it asks nobody about`
              : '';
          raise(
            'gate-hook-missing',
            answer === 'refused'
              ? `Copilot ran ${call} although this host refused it`
              : answer === 'awaited'
                ? `Copilot finished ${call} while this host was still deciding it, so no decision of this host's stood behind it`
                : ran
                  ? `Copilot ran ${call} with no decision from this host for it${ownRead}`
                  : `Copilot finished ${call}, which failed, with no decision from this host for it${ownRead}`,
            // Its own key: what a call did at its end is said beside whatever was said of its request.
            `finished:${key}`,
          );
          return;
        }
        case 'assistant.server_tool_progress': {
          const kind = named(data['kind']) ? data['kind'] : 'a provider tool';
          raise(
            'gate-unhooked-call',
            `the model's provider ran ${kind} itself; no hook sees a provider-hosted tool`,
            kind,
          );
          return;
        }
        case 'session.permissions_changed': {
          const mode = data['mode'];
          if (named(mode) && mode !== COPILOT_ADMITTED_PERMISSION_MODE) {
            raise(
              'gate-mode-widened',
              `${whose(event)} reports permission mode ${mode}, in which it approves calls itself`,
              `permission:${mode}${threadKey(event)}`,
            );
          }
          return;
        }
        case 'session.mode_changed': {
          const mode = data['newMode'];
          if (named(mode) && !COPILOT_ADMITTED_AGENT_MODES.includes(mode)) {
            raise(
              'gate-mode-widened',
              `${whose(event)} reports agent mode ${mode}, which this host does not admit`,
              `agent:${mode}${threadKey(event)}`,
            );
          }
          return;
        }
        default:
          return;
      }
    },
    identify(id) {
      sessionId = id;
    },
    spawnedWith(env) {
      options.spawnedWith?.(env);
    },
    serverTools(server, tools) {
      if (servers.has(server)) servers.set(server, [...tools]);
    },
    toolsOffered(names, brought) {
      for (const name of brought) fromServers.add(name);
      for (const name of names) nameIfUnnamed(name, 'offers');
    },
    useToolLister(list) {
      listTools = list;
    },
    toolName,
    probe() {
      const id = `${COPILOT_PROBE_ID_PREFIX}${options.probeId?.() ?? globalThis.crypto.randomUUID()}`;
      const state: ProbeState = { id, hooked: false, asked: false, otherKind: null };
      probe = state;
      return {
        id,
        reach: () => ({ hooked: state.hooked, asked: state.asked, otherKind: state.otherKind }),
      };
    },
    raise,
    stateSpawnDegrades(found) {
      try {
        options.onSpawnDegrades(found.map((one) => one.name));
      } catch {
        // The tier is a statement; failing to make it must not end the open.
      }
      for (const one of found) raise(one.name, one.detail, 'open');
    },
  };
}

/** Whether `value` is a Copilot session gate, as the registry carries it to the runtime's start. */
export function isCopilotSessionGate(value: unknown): value is CopilotSessionGate {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { runtime?: unknown }).runtime === COPILOT_RUNTIME &&
    typeof (value as { decide?: unknown }).decide === 'function'
  );
}
