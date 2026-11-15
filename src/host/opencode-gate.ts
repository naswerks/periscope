/**
 * One opencode session's gate. Every session this host creates on opencode carries permission rules that send
 * every action to ask (`opencodeRuleset`), and every request that raises reaches this gate as a
 * `permission.asked` event of the server's stream, the session's own or a subagent's alike. Each is decided by
 * the per-call decision every runtime shares, and answered over the session's host process.
 *
 * What a request carries: its own id, the session it asks for, its action, the resources it names (a path
 * relative to the session's location, an absolute one outside it, a command, a URL), and the call that raised
 * it (`source.id`). The decision request names the tool in this host's spelling: a built-in as its action, an
 * MCP tool as `mcp__{server}__{tool}`, read out of opencode's `{server}_{tool}` by the names of the servers the
 * session attached, which the open holds to be told apart in that form (`opencode-mcp.ts`), never by
 * splitting on an underscore. A name of no attached server keeps opencode's spelling, so a controller holds it
 * as a stranger's. Its input is the call's own, as the model sent it: an MCP request's `metadata.input`, else
 * the input the stream announced for the call (`session.tool.called`), else the request's resources. Each
 * path the request names is checked by this host's own gate, one at a time, before anyone is asked.
 *
 * One call can ask more than once (a path outside the location asks `external_directory`, then its own
 * action), so decisions are kept by the request's id. Only one-time answers are ever sent: `once`, or `reject`
 * with words, which the model reads and goes on from; a reject with no words would end the turn, so there are
 * always words. An allow that rewrites the input is refused (`canRewriteInput: false`).
 *
 * A `shell` call is decided before it runs, whole (`decideHeld`): the server holds every call of a tool in
 * `OPENCODE_HELD_TOOLS` at its pre-call hook, and this host's answer there lets it run or fails it with the
 * answer's words. The `shell` tool raises a request only for the commands the runtime's own reading finds in
 * a line, so a line it finds none in would otherwise run with nothing asked. A call allowed there is not
 * asked about again: each request it then raises is held to this host's own gate alone. A request whose action
 * this host turns off (`OPENCODE_DENIED_TOOLS`) is refused here without asking anyone, so a rule the runtime
 * loses later cannot run one. When this host refuses one request, the runtime refuses every other request of
 * that session still waiting, with the same words: each such decision still pending here is ended, recorded
 * as refused, and never answered twice.
 *
 * What is kept for a call (its announced input, whether it was decided, whether it runs) is kept by its
 * session and its id together: one server runs the session and its subagents, and a provider may hand two of
 * them the same call id.
 *
 * What it names, each a degrade raised once per (name, key):
 * - `gate-unhooked-call`: a tool the model's provider ran itself (`executed: true`), which raises no request;
 * - `gate-hook-missing`: a call the server began to run (`began`, from its pre-call hook) that this host
 *   decided nothing about, named when it succeeds, when it fails, when its turn is interrupted and when the
 *   session closes with it still running. A success for a call this process never saw begin is one an earlier
 *   process ran, stated again to a resumed session, and is not named;
 * - `gate-mode-widened`: the rules of one of the session's sessions are no longer this host's, or an answer
 *   this host never gave approved a request, one it had answered nothing about or one it was still deciding
 *   (whose wait then ends).
 *
 * A request the runtime settled while this host was deciding it (refused with another, dropped with an
 * interrupt, approved by another's answer) is answered for with `settledByRuntime`, so the reply that finds
 * it gone is not reported as an answer that failed to arrive.
 */
import type { RefusalReason } from '../core/refusal.js';
import type { CallDecision } from '../gate/call-decision.js';
import { createCallDecision } from '../gate/call-decision.js';
import type { Decider, DecisionRequest } from '../gate/decision.js';
import type { LocalGate } from '../gate/local.js';
import type { GateOutcome, TerminalOutcome } from '../gate/outcome.js';
import {
  OPENCODE_DENIED_TOOLS,
  OPENCODE_OTHER_TOOLS,
  OPENCODE_TOOL_KINDS,
  opencodeShellDialect,
  opencodeToolKind,
} from '../gate/tool-kind.js';
import { OPENCODE_RUNTIME } from '../sessions/runtimes.js';
import { HOOK_TIMEOUT_EVENT } from '../state/model.js';
import type { SpawnDegrade } from './codex-gate.js';
import { opencodeRuleset } from './opencode-home.js';
import type { OpencodeRule } from './opencode-sdk.js';
import type { OpencodeMessage } from './opencode-wire.js';
import { opencodeData, opencodeRecord, opencodeWord } from './opencode-wire.js';

/** One `permission.asked` event's data, read loosely. */
export interface OpencodeAsked {
  readonly id: string;
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  /** The call that raised it, or null. */
  readonly callId: string | null;
}

/**
 * The tools whose every call the server holds at its pre-call hook until this host has decided it. The
 * `shell` tool asks only about the commands the runtime's own reading finds in a line, and a line it finds
 * none in (an assignment to a file through a provider path, a bare redirection) raises no request at all, so
 * the whole line is decided here, before it runs.
 */
export const OPENCODE_HELD_TOOLS: readonly string[] = ['shell'];

/** One call the server holds before it runs: the tool, the session it runs in, its id and its input. */
export interface OpencodeHeld {
  readonly tool: string;
  readonly sessionID: string;
  readonly callId: string;
  readonly input: unknown;
}

/** What this host answers one request with. */
export interface OpencodeAnswer {
  readonly decision: 'once' | 'reject';
  readonly message?: string;
  /**
   * Set when the runtime settled the request before this host answered: it refused it together with
   * another of the session's, dropped it with an interrupt, or took an answer this host did not give. The
   * request may be there no longer, so an answer that finds it gone is no failure to deliver one.
   */
  readonly settledByRuntime?: true;
}

/** How many calls' announced inputs one session keeps. */
const MAX_KNOWN_CALLS = 2048;
/** How many decided call ids one session keeps, to tell a decided call from an undecided one. */
const MAX_DECIDED_IDS = 8192;
/** How many distinct degrades one session raises at most; past it, the host's own log still has each. */
const MAX_RAISED_DEGRADES = 4096;

/** What the runtime is told for one terminal outcome. There are always words, so the turn goes on. */
export function opencodeAnswerOf(outcome: TerminalOutcome): OpencodeAnswer {
  switch (outcome.kind) {
    case 'allow':
      return { decision: 'once' };
    case 'deny':
      return {
        decision: 'reject',
        message: outcome.message === '' ? 'this call was denied' : outcome.message,
      };
    case 'refused':
      return { decision: 'reject', message: `${outcome.refusal.reason}: ${outcome.refusal.detail}` };
    case 'expired':
      return { decision: 'reject', message: `${HOOK_TIMEOUT_EVENT}: ${outcome.detail}` };
  }
}

/** Read one `permission.asked` event's data, or null when it names no request. */
export function opencodeAskedOf(data: Readonly<Record<string, unknown>>): OpencodeAsked | null {
  const id = opencodeWord(data['id']);
  const sessionID = opencodeWord(data['sessionID']);
  const action = opencodeWord(data['action']);
  if (id === null || sessionID === null || action === null) return null;
  const resources = Array.isArray(data['resources'])
    ? data['resources'].filter((one): one is string => typeof one === 'string')
    : [];
  return {
    id,
    sessionID,
    action,
    resources,
    metadata: opencodeRecord(data['metadata']),
    callId: opencodeWord(opencodeRecord(data['source'])['id']),
  };
}

/** Whether `action` is one of the runtime's own, as this host knows them. */
export function isOpencodeBuiltin(action: string): boolean {
  return (
    Object.hasOwn(OPENCODE_TOOL_KINDS, action) ||
    OPENCODE_OTHER_TOOLS.includes(action) ||
    OPENCODE_DENIED_TOOLS.includes(action)
  );
}

/**
 * opencode's name for an MCP tool in this host's spelling. Exactly one attached server whose name, with an
 * `_`, begins `action` maps it to `mcp__{server}__{rest}`; none, or more than one, keeps `action` as it came.
 */
export function opencodeMcpToolName(action: string, servers: readonly string[]): string {
  const found = servers.filter(
    (server) => action.startsWith(`${server}_`) && action.length > server.length + 1,
  );
  if (found.length !== 1) return action;
  const server = found[0] ?? '';
  return `mcp__${server}__${action.slice(server.length + 1)}`;
}

/** A path a request names, as the local gate reads it: a directory request's `<dir>/*` as the directory. */
function requestPath(action: string, resource: string): string {
  if (action !== 'external_directory') return resource;
  return resource.replace(/[\\/]\*$/, '') || resource;
}

/** One opencode session's gate, as its process uses it. */
export interface OpencodeSessionGate {
  /** Marks this as an opencode session's gate, for the registry's route. */
  readonly runtime: typeof OPENCODE_RUNTIME;
  /** Answers one request. Never rejects. */
  decide(asked: OpencodeAsked, signal?: AbortSignal): Promise<OpencodeAnswer>;
  /**
   * Answers one call the server holds before it runs: the call whole, by this host's own gate and then the
   * decider. An allow is kept for the call until it ends, so each request the call then raises is held to
   * this host's own gate alone and nobody is asked about the same call twice. Never rejects.
   */
  decideHeld(held: OpencodeHeld, signal?: AbortSignal): Promise<OpencodeAnswer>;
  /** Told every message the session's process yields: the inputs, the subagents and the degrades are read here. */
  observe(message: OpencodeMessage): void;
  /** Told the session's own id once the server has named it. */
  identify(sessionId: string): void;
  /** Told the environment the host process is started with, for the local gate's reading of path variables. */
  spawnedWith(env: Readonly<Record<string, string | undefined>>): void;
  /** Told the shell the `shell` tool runs, by path, for each shell decision's dialect. */
  useShell(shell: string): void;
  /** Spells an action as the decision requests and the items carry it. */
  toolName(action: string): string;
  /**
   * Told each call the server begins to run that it does not hold for an answer: the tool, the session and
   * the call's id, from the server's pre-call hook. A call that began and ends, is interrupted or is still
   * running at the close with no decision of this host's behind it is named.
   */
  began(call: { readonly tool: string; readonly sessionID: string; readonly callId: string }): void;
  /**
   * Told whether the server's pre-call hook is this host's to hear from. Without it no call is known to
   * have begun, so a call that succeeds with no decision behind it is named on its success alone.
   */
  preCallHook(loaded: boolean): void;
  /** Told the session is closing: every call still running with no decision behind it is named. */
  closing(): void;
  /** Ends every decision still pending for `sessionId` (its turn was interrupted), with why. */
  endPending(sessionId: string, why: string): void;
  /** A named degrade on the session's state lane, once per (name, key). */
  raise(name: RefusalReason, detail: string, key: string): void;
  /** The degrades known at the open, for the opening tier, each raised once with its detail. */
  stateSpawnDegrades(found: readonly SpawnDegrade[]): void;
}

export interface OpencodeSessionGateOptions {
  readonly sessionKey: string;
  /** The session's location: where a call that names no directory runs, and what a relative path is under. */
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
  /** Told every environment the session's host process is started with, for the local gate. */
  readonly spawnedWith?: (env: Readonly<Record<string, string | undefined>>) => void;
}

interface KnownCall {
  name: string | null;
  input: Readonly<Record<string, unknown>> | null;
}

/** Whether two rule lists are the same rules in the same order. */
function sameRules(read: readonly unknown[], expected: readonly OpencodeRule[]): boolean {
  return (
    read.length === expected.length &&
    read.every((rule, index) => {
      const one = opencodeRecord(rule);
      const want = expected[index];
      return (
        want !== undefined &&
        one['action'] === want.action &&
        one['resource'] === want.resource &&
        one['effect'] === want.effect
      );
    })
  );
}

/** Build one opencode session's gate. */
export function createOpencodeSessionGate(options: OpencodeSessionGateOptions): OpencodeSessionGate {
  const raised = new Set<string>();
  // One server runs every session of this host's session, a subagent's among them, and a model's provider
  // hands out call ids: what is kept for a call is kept by its session and its id together.
  const callKey = (session: string, id: string): string => `${session}\u0000${id}`;
  const calls = new Map<string, KnownCall>();
  const decided = new Set<string>();
  // Each call the server began to run, with its tool's name, until it ends.
  const running = new Map<string, { readonly session: string; readonly id: string; readonly tool: string }>();
  let hookLoaded = true;
  const answered = new Set<string>();
  const pending = new Map<string, { readonly sessionID: string; readonly controller: AbortController }>();
  // The requests the runtime settled while this host was still deciding them, until each is answered for.
  const settledByRuntime = new Set<string>();
  const agentOf = new Map<string, string>();
  const ruleset = opencodeRuleset();
  const resourcesOf = new WeakMap<DecisionRequest, OpencodeAsked>();
  // The calls allowed whole before they ran, by session and call id, until each ends.
  const allowedHeld = new Set<string>();
  let sessionId = '';
  let shell: string | null = null;

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

  const remember = (set: Set<string>, id: string): void => {
    if (set.size >= MAX_DECIDED_IDS) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
    set.add(id);
  };

  const known = (session: string, id: string): KnownCall => {
    const key = callKey(session, id);
    let call = calls.get(key);
    if (call === undefined) {
      if (calls.size >= MAX_KNOWN_CALLS) {
        const oldest = calls.keys().next().value;
        if (oldest !== undefined) calls.delete(oldest);
      }
      call = { name: null, input: null };
      calls.set(key, call);
    }
    return call;
  };

  const runs = (session: string, id: string, tool: string): void => {
    if (running.size >= MAX_KNOWN_CALLS) {
      const oldest = running.keys().next().value;
      if (oldest !== undefined) running.delete(oldest);
    }
    running.set(callKey(session, id), { session, id, tool });
  };

  /** A call that began, by how it left, when this host decided nothing about it. */
  const nameUndecided = (
    call: { readonly session: string; readonly id: string; readonly tool: string | null },
    how: string,
  ): void => {
    raise(
      'gate-hook-missing',
      `opencode call ${call.id}${call.tool === null ? '' : ` (${call.tool})`} ${how} with no decision of this host's behind it: no permission request was raised for it`,
      callKey(call.session, call.id),
    );
  };

  // The host's own gate, asked about each path the request names: a request about several files is checked
  // file by file, and the decision request still carries the call's own input.
  const local: LocalGate | undefined =
    options.localGate === undefined
      ? undefined
      : (request) => {
          const gate = options.localGate;
          if (gate === undefined) return null;
          const asked = resourcesOf.get(request);
          const pathAction =
            asked !== undefined &&
            (asked.action === 'edit' || asked.action === 'read' || asked.action === 'external_directory');
          if (!pathAction) return gate(request);
          for (const resource of asked.resources) {
            const refused = gate({ ...request, toolInput: { path: requestPath(asked.action, resource) } });
            if (refused !== null) return refused;
          }
          return asked.resources.length === 0 ? gate({ ...request, toolInput: {} }) : null;
        };

  const decideCall: CallDecision = createCallDecision({
    decide: options.decide,
    onOutcome: options.onOutcome,
    sessionKey: options.sessionKey,
    runtime: OPENCODE_RUNTIME,
    ...(local === undefined ? {} : { localGate: local }),
    decisionTimeoutMs: options.decisionTimeoutMs,
    holdAfterMs: options.holdAfterMs,
    // A permission answer can only approve or refuse the call asked.
    canRewriteInput: false,
  });

  // What a call already allowed whole asks afterwards: held to this host's own gate, and asked of nobody.
  const decideFollowUp: CallDecision = createCallDecision({
    decide: () => Promise.resolve({ behavior: 'allow' }),
    onOutcome: options.onOutcome,
    sessionKey: options.sessionKey,
    runtime: OPENCODE_RUNTIME,
    ...(local === undefined ? {} : { localGate: local }),
    decisionTimeoutMs: options.decisionTimeoutMs,
    holdAfterMs: options.holdAfterMs,
    canRewriteInput: false,
  });

  const toolName = (action: string): string =>
    isOpencodeBuiltin(action) ? action : opencodeMcpToolName(action, options.servers);

  // A shell call runs in the directory its input names, under the session's location when relative.
  const directoryOf = (toolKind: string, toolInput: unknown): string => {
    const workdir = toolKind === 'shell' ? opencodeWord(opencodeRecord(toolInput)['workdir']) : null;
    return workdir === null
      ? options.cwd
      : /^([A-Za-z]:[\\/]|[\\/])/.test(workdir)
        ? workdir
        : `${options.cwd}/${workdir}`;
  };

  const heldRequestOf = (held: OpencodeHeld): DecisionRequest => {
    const spelled = toolName(held.tool);
    const toolKind = opencodeToolKind(spelled);
    const toolInput =
      typeof held.input === 'object' && held.input !== null && !Array.isArray(held.input) ? held.input : {};
    const child = held.sessionID !== sessionId && sessionId !== '';
    return {
      toolName: spelled,
      toolUseId: held.callId,
      toolInput,
      sessionId,
      sessionKey: options.sessionKey,
      cwd: directoryOf(toolKind, toolInput),
      agentId: child ? held.sessionID : null,
      agentType: child ? (agentOf.get(held.sessionID) ?? null) : null,
      toolKind,
      runtime: OPENCODE_RUNTIME,
      ...(toolKind === 'shell' && shell !== null ? { shellDialect: opencodeShellDialect(shell) } : {}),
    };
  };

  const requestOf = (asked: OpencodeAsked): DecisionRequest => {
    const spelled = toolName(asked.action);
    const toolKind = opencodeToolKind(spelled);
    const call = asked.callId === null ? undefined : calls.get(callKey(asked.sessionID, asked.callId));
    const announced = call?.input ?? null;
    const metadataInput = asked.metadata['input'];
    const toolInput =
      typeof metadataInput === 'object' && metadataInput !== null && !Array.isArray(metadataInput)
        ? metadataInput
        : (announced ?? { resources: [...asked.resources] });
    const cwd = directoryOf(toolKind, toolInput);
    const child = asked.sessionID !== sessionId && sessionId !== '';
    return {
      toolName: spelled,
      toolUseId: asked.callId ?? asked.id,
      toolInput,
      sessionId,
      sessionKey: options.sessionKey,
      cwd,
      agentId: child ? asked.sessionID : null,
      agentType: child ? (agentOf.get(asked.sessionID) ?? null) : null,
      toolKind,
      runtime: OPENCODE_RUNTIME,
      ...(toolKind === 'shell' && shell !== null ? { shellDialect: opencodeShellDialect(shell) } : {}),
    };
  };

  return {
    runtime: OPENCODE_RUNTIME,
    async decide(asked, signal) {
      if (asked.callId !== null) remember(decided, callKey(asked.sessionID, asked.callId));
      if (OPENCODE_DENIED_TOOLS.includes(asked.action)) {
        // Denied in every session's rules, so never offered; refused here as well, so rules the runtime loses
        // later cannot run one.
        remember(answered, asked.id);
        return {
          decision: 'reject',
          message: `${asked.action} is turned off in every session this host runs: no decision request can say what it does`,
        };
      }
      const request = requestOf(asked);
      resourcesOf.set(request, asked);
      const controller = new AbortController();
      const forward = (): void => controller.abort(signal?.reason);
      signal?.addEventListener('abort', forward, { once: true });
      pending.set(asked.id, { sessionID: asked.sessionID, controller });
      // A call this host allowed whole before it ran is not asked about again: what it asks now is held to
      // this host's own gate, which reads each path the request names.
      const wholeCallAllowed =
        asked.callId !== null && allowedHeld.has(callKey(asked.sessionID, asked.callId));
      try {
        const outcome = await (wholeCallAllowed ? decideFollowUp : decideCall)(request, controller.signal);
        return settledByRuntime.delete(asked.id)
          ? { ...opencodeAnswerOf(outcome), settledByRuntime: true }
          : opencodeAnswerOf(outcome);
      } finally {
        pending.delete(asked.id);
        settledByRuntime.delete(asked.id);
        signal?.removeEventListener('abort', forward);
        remember(answered, asked.id);
      }
    },
    async decideHeld(held, signal) {
      const key = callKey(held.sessionID, held.callId);
      remember(decided, key);
      runs(held.sessionID, held.callId, held.tool);
      const request = heldRequestOf(held);
      // The held input is the call's own: a request the call raises afterwards is read with it.
      known(held.sessionID, held.callId).input = opencodeRecord(request.toolInput);
      const controller = new AbortController();
      const forward = (): void => controller.abort(signal?.reason);
      if (signal?.aborted === true) forward();
      else signal?.addEventListener('abort', forward, { once: true });
      const waitingAs = `held:${key}`;
      pending.set(waitingAs, { sessionID: held.sessionID, controller });
      try {
        const outcome = await decideCall(request, controller.signal);
        if (outcome.kind === 'allow') remember(allowedHeld, key);
        return opencodeAnswerOf(outcome);
      } finally {
        pending.delete(waitingAs);
        signal?.removeEventListener('abort', forward);
      }
    },
    observe(message) {
      if (message.kind !== 'event') return;
      const event = message.event;
      const data = opencodeData(event);
      switch (event.type) {
        case 'session.created': {
          const id = opencodeWord(data['sessionID']);
          const agent = opencodeWord(data['agent']);
          if (id !== null && agent !== null) agentOf.set(id, agent);
          return;
        }
        case 'session.tool.input.started': {
          const id = opencodeWord(data['id']);
          if (id !== null) known(opencodeWord(data['sessionID']) ?? '', id).name = opencodeWord(data['name']);
          return;
        }
        case 'session.tool.called': {
          const id = opencodeWord(data['id']);
          if (id === null) return;
          const session = opencodeWord(data['sessionID']) ?? '';
          const call = known(session, id);
          call.input = opencodeRecord(data['input']);
          // `executed` is the provider's: a call the model's provider ran itself, which the runtime does not run.
          if (data['executed'] === true) {
            const name = call.name ?? 'a tool';
            raise(
              'gate-unhooked-call',
              `the model's provider ran ${name} itself; no permission request is raised for a call the runtime does not run`,
              callKey(session, id),
            );
          }
          return;
        }
        case 'session.tool.failed':
        case 'session.tool.success': {
          const id = opencodeWord(data['id']);
          if (id === null) return;
          const session = opencodeWord(data['sessionID']) ?? '';
          const key = callKey(session, id);
          const began = running.get(key);
          running.delete(key);
          allowedHeld.delete(key);
          if (data['executed'] === true || decided.has(key)) return;
          const tool = began?.tool ?? calls.get(key)?.name ?? null;
          if (began !== undefined) {
            nameUndecided(
              { session, id, tool },
              event.type === 'session.tool.success' ? 'ran' : 'ran and failed',
            );
            return;
          }
          // A call this process never saw begin: one an earlier process ran, whose end the server states again
          // to a resumed session, where the pre-call hook is there to tell; and a call that ran, where it is not.
          if (!hookLoaded && event.type === 'session.tool.success')
            nameUndecided({ session, id, tool }, 'ran');
          return;
        }
        case 'session.execution.interrupted': {
          const session = opencodeWord(data['sessionID']);
          if (session === null) return;
          for (const [key, call] of [...running]) {
            if (call.session !== session) continue;
            running.delete(key);
            if (!decided.has(key)) nameUndecided(call, 'was running when its turn was interrupted,');
          }
          return;
        }
        case 'session.permissions': {
          const id = opencodeWord(data['sessionID']);
          const reported = Array.isArray(data['permissions']) ? data['permissions'] : [];
          if (!sameRules(reported, ruleset)) {
            raise(
              'gate-mode-widened',
              `the rules of session ${id ?? 'unnamed'} changed after it opened, and are no longer the ones this host wrote`,
              `rules:${id ?? 'unnamed'}`,
            );
          }
          return;
        }
        case 'permission.replied': {
          const requestId = opencodeWord(data['requestID']);
          const reply = opencodeWord(data['reply']);
          if (requestId === null) return;
          const waiting = pending.get(requestId);
          if (reply === 'reject' && waiting !== undefined) {
            // Another request of the session was refused, and the runtime refused this one with it.
            remember(settledByRuntime, requestId);
            waiting.controller.abort(
              'the runtime refused this request together with another of the same session that was refused; the call did not run',
            );
            return;
          }
          if (reply !== 'reject' && waiting !== undefined) {
            // The request this host is still deciding was approved by an answer it did not give: said, and
            // the wait ended, since nothing this host decides now can stop the call.
            raise(
              'gate-mode-widened',
              `an answer this host never gave approved request ${requestId} while this host was still deciding it (${reply ?? 'no reply named'})`,
              `reply:${requestId}`,
            );
            remember(settledByRuntime, requestId);
            waiting.controller.abort(
              'the runtime took an answer this host did not give for this request, so this host decided nothing about it',
            );
            return;
          }
          if (reply !== 'reject' && !answered.has(requestId)) {
            raise(
              'gate-mode-widened',
              `an answer this host never gave approved request ${requestId} (${reply ?? 'no reply named'})`,
              `reply:${requestId}`,
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
    useShell(path) {
      shell = path;
    },
    toolName,
    began(call) {
      runs(call.sessionID, call.callId, call.tool);
    },
    preCallHook(loaded) {
      hookLoaded = loaded;
    },
    closing() {
      for (const [key, call] of [...running]) {
        running.delete(key);
        if (!decided.has(key)) nameUndecided(call, 'was still running when the session closed,');
      }
    },
    endPending(session, why) {
      for (const [id, waiting] of pending) {
        if (waiting.sessionID !== session) continue;
        // The runtime drops a session's waiting requests with its interrupt.
        remember(settledByRuntime, id);
        waiting.controller.abort(why);
      }
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

/** Whether `value` is an opencode session gate, as the registry carries it to the runtime's start. */
export function isOpencodeSessionGate(value: unknown): value is OpencodeSessionGate {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { runtime?: unknown }).runtime === OPENCODE_RUNTIME &&
    typeof (value as { decide?: unknown }).decide === 'function'
  );
}
