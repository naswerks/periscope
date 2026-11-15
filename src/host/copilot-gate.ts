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
 * What it names, each a degrade raised once per (name, key):
 * - `gate-hook-missing`: a permission request of any kind but `hook` (the runtime's own flow, so the hook
 *   did not ask; the request is refused, never decided), a `hook` request no pre-tool hook announced, a
 *   pre-tool hook the runtime reports as failed, or a call that finished with no decision of this host's
 *   behind it: none at all, one still being awaited, or a refusal the call ran against. Each call's answer
 *   is kept until the call finishes and forgotten then, so a provider that hands out the same call id
 *   again starts with no answer;
 * - `gate-hook-foreign`: a hook this host did not install decided a request (`resolvedByHook`), or a
 *   machine-wide policy hook was found when the session opened;
 * - `gate-unhooked-call`: a provider-hosted tool ran (`assistant.server_tool_progress`), which no hook sees;
 * - `gate-mode-widened`: the runtime reports a permission mode other than `manual`, or an agent mode other
 *   than `interactive` and `plan`;
 * - `gate-tool-unnamed`: the runtime offers, or the model called, a built-in this host's tables do not name
 *   (`COPILOT_TOOL_KINDS`, `COPILOT_OTHER_TOOLS`, `COPILOT_EXCLUDED_TOOLS`). The session opens and the call is
 *   asked about as any other is, kind `other`; the name is said so the tables can learn it.
 */
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
 * on runtime 1.0.112 (SDK 1.0.34), 2026-11-15. A deadline longer than that is not known to win, so a session
 * asking for one is refused (`copilotDeadlineOrderRefusal`).
 */
export const COPILOT_MEASURED_PERMISSION_WAIT_MS = 240_000;

/** What the hook tells the runtime beside its `ask`, which the runtime carries on the request as `hookMessage`. */
export const COPILOT_HOOK_REASON = 'this host decides every call';

/** The prefix of the call ids this host mints for its own probe call at the open. */
export const COPILOT_PROBE_ID_PREFIX = 'periscope-route-probe-';

/** How many calls' hook inputs one session keeps while their requests are outstanding. */
const MAX_PENDING_HOOKS = 1024;
/** How many calls' answers one session keeps while the calls have not finished. */
const MAX_DECIDED_IDS = 8192;
/** How many distinct degrades one session raises at most; past it, the host's own log still has each. */
const MAX_RAISED_DEGRADES = 4096;

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
  /** The degrades known at the open, for the opening tier. */
  readonly onSpawnDegrades: (names: readonly RefusalReason[]) => void;
  /** Told every environment the session's runtime is started with, for the local gate. */
  readonly spawnedWith?: (env: Readonly<Record<string, string | undefined>>) => void;
  /** Mints the probe's call id. Defaults to a random one. */
  readonly probeId?: () => string;
}

interface HookedCall {
  readonly toolName: string;
  readonly workingDirectory: string;
  readonly agentId: string | null;
  readonly agentType: string | null;
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
  const hooked = new Map<string, HookedCall>();
  // Each unfinished call's answer, by its call id. One runtime serves one session, so the id alone names the
  // call; an entry leaves when its call finishes, so an id a provider hands out again is a new call.
  const answers = new Map<string, CallAnswer>();
  const servers = new Map<string, readonly string[]>(options.servers.map((server) => [server, []]));
  // The offered tools the runtime says an attached server brings: never a built-in, whatever their names.
  const fromServers = new Set<string>();
  // One for each decision still waiting, so the waiting ones can be ended without ending the session's.
  const waiting = new Set<AbortController>();
  let sessionId = '';
  let probe: ProbeState | null = null;
  let listTools: ((server: string) => Promise<readonly string[] | null>) | null = null;

  // A name that could be an attached server's tool, for a server whose tools are not known yet: ask for them
  // once, so the spelling is decided from what the server lists.
  const learnServers = async (name: string): Promise<void> => {
    if (listTools === null || isCopilotBuiltin(name)) return;
    for (const [server, tools] of servers) {
      if (tools.length > 0 || !name.startsWith(`${server}-`)) continue;
      try {
        const listed = await listTools(server);
        if (listed !== null) servers.set(server, [...listed]);
      } catch {
        // An unanswered list leaves the server's tools unknown, so the name keeps Copilot's spelling.
      }
    }
  };

  const raise = (name: RefusalReason, detail: string, key: string): void => {
    const id = `${name}\u0000${key}`;
    if (raised.has(id) || raised.size >= MAX_RAISED_DEGRADES) return;
    raised.add(id);
    try {
      options.onDegrade(name, detail);
    } catch {
      // A listener that throws must not stop the gate answering the call it was raised beside.
    }
  };

  const remember = (id: string, answer: CallAnswer): void => {
    if (!answers.has(id) && answers.size >= MAX_DECIDED_IDS) {
      const oldest = answers.keys().next().value;
      if (oldest !== undefined) answers.delete(oldest);
    }
    answers.set(id, answer);
  };

  const decideCall: CallDecision = createCallDecision({
    decide: options.decide,
    onOutcome: options.onOutcome,
    sessionKey: options.sessionKey,
    runtime: COPILOT_RUNTIME,
    ...(options.localGate === undefined ? {} : { localGate: options.localGate }),
    decisionTimeoutMs: options.decisionTimeoutMs,
    holdAfterMs: options.holdAfterMs,
    // The rewrite lives only in the fail-open hook; the request can only approve or refuse the call asked.
    canRewriteInput: false,
  });

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
    const name = named(raw.toolName) ? raw.toolName : call.toolName;
    if (!named(name)) return null;
    const spelled = toolName(name);
    const toolKind = copilotToolKind(spelled);
    const dialect: ShellDialect | null = toolKind === 'shell' ? copilotShellDialect(name) : null;
    return {
      toolName: spelled,
      toolUseId: toolCallId,
      toolInput: raw.toolArgs ?? null,
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
          if (hooked.size >= MAX_PENDING_HOOKS) {
            const oldest = hooked.keys().next().value;
            if (oldest !== undefined) hooked.delete(oldest);
          }
          hooked.set(id, {
            toolName: named(input.toolName) ? input.toolName : '',
            workingDirectory: named(input.workingDirectory) ? input.workingDirectory : '',
            agentId: named(input.agentId) ? input.agentId : null,
            agentType: named(input.agentType) ? input.agentType : null,
          });
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
        if (id !== null) remember(id, 'refused');
        return {
          kind: 'reject',
          feedback: `gate-hook-missing: this host decides a call only through its pre-tool hook, and this ${kind} request did not come through it`,
        };
      }
      if (id === null) {
        raise('gate-hook-missing', 'Copilot asked about a call that carries no call id; refused', 'no-id');
        return { kind: 'reject', feedback: 'gate-hook-missing: the request names no call' };
      }
      const call = hooked.get(id);
      hooked.delete(id);
      // Refused until an answer says otherwise: every way out of here but an allow is a refusal.
      remember(id, 'refused');
      if (call === undefined) {
        raise(
          'gate-hook-missing',
          `Copilot asked about call ${id}, which no pre-tool hook announced; refused`,
          id,
        );
        return { kind: 'reject', feedback: 'gate-hook-missing: no pre-tool hook announced this call' };
      }
      const asked = named(raw.toolName) ? raw.toolName : call.toolName;
      if (COPILOT_EXCLUDED_TOOLS.includes(asked)) {
        // Left out of every session's tools and read back absent at the open; refused here as well, so a
        // list the runtime widens later cannot run one.
        return {
          kind: 'reject',
          feedback: `${asked} is turned off in every session this host runs: no decision request can say what it runs`,
        };
      }
      await learnServers(asked);
      nameIfUnnamed(asked, 'was asked to run');
      const request = requestOf(raw, call, id);
      remember(id, 'awaited');
      // The decision ends with the session's signal or with its own, which an interrupt ends.
      const own = new AbortController();
      const forward = (): void => own.abort(signal?.reason);
      if (signal?.aborted === true) forward();
      else signal?.addEventListener('abort', forward, { once: true });
      waiting.add(own);
      try {
        const outcome = await decideCall(request, own.signal);
        // Written once the answer is known and before the runtime is told, so a call that finishes after
        // this is read against what it was told.
        remember(id, outcome.kind === 'allow' ? 'allowed' : 'refused');
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
            if (id !== null) remember(id, 'foreign');
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
        case 'tool.execution_complete': {
          // Read when the call finishes: the decision follows the call's start.
          const id = named(data['toolCallId']) ? data['toolCallId'] : null;
          // Only the probe this gate minted is its own; another id that merely starts the same is a call.
          if (id === null || (probe !== null && id === probe.id)) return;
          const answer = answers.get(id);
          answers.delete(id);
          if (answer === 'allowed' || answer === 'foreign') return;
          const ran = data['success'] === true;
          // A refused call that did not run is what a refusal is.
          if (answer === 'refused' && !ran) return;
          const call = `call ${id}${named(data['toolName']) ? ` (${data['toolName']})` : ''}`;
          raise(
            'gate-hook-missing',
            answer === 'refused'
              ? `Copilot ran ${call} although this host refused it`
              : answer === 'awaited'
                ? `Copilot finished ${call} while this host was still deciding it, so no decision of this host's stood behind it`
                : ran
                  ? `Copilot ran ${call} with no decision from this host for it`
                  : `Copilot finished ${call}, which failed, with no decision from this host for it`,
            // Its own key: what a call did at its end is said beside whatever was said of its request.
            `finished:${id}`,
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
