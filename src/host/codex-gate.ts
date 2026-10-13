/**
 * One Codex session's gate: its hook channel, the per-call decision every Codex caller shares, the
 * decisions kept for the approvals that follow them, the approval answers, and the watch over the paths
 * that still run undecided.
 *
 * The session's composer builds it before the process starts, because the channel's address and token
 * ride the app-server's environment, and hands it to the process, which runs the trust check at its open,
 * answers Codex's approval requests through it and tells it every notification. Everything it decides is
 * recorded on the session's machine through the same outcome record as a Claude call, and every residual
 * it names lands on the session's state lane.
 */
import type { JsonObject } from '../control/frames.js';
import type { Refusal, RefusalReason } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import type { CallDecision } from '../gate/call-decision.js';
import { createCallDecision, unreadableRequest } from '../gate/call-decision.js';
import { codexHookTurn, readCodexHookRequest } from '../gate/codex-request.js';
import type { Decider } from '../gate/decision.js';
import type { HookDecision } from '../gate/hook-exchange.js';
import {
  HOOK_CHANNEL_VARIABLE,
  HOOK_DEADLINE_MARGIN_MS,
  HOOK_DEADLINE_VARIABLE,
  HOOK_EXPIRY_EVENT,
  HOOK_TOKEN_VARIABLE,
  MAX_HOOK_DEADLINE_MS,
} from '../gate/hook-exchange.js';
import type { LocalGate } from '../gate/local.js';
import type { GateOutcome, TerminalOutcome } from '../gate/outcome.js';
import { codexShellDialect } from '../gate/tool-kind.js';
import { CODEX_RUNTIME } from '../sessions/runtimes.js';
import { HOOK_TIMEOUT_EVENT } from '../state/model.js';
import { CodexApprovals, CodexDecisionCache } from './codex-approvals.js';
import { CodexGateWatch } from './codex-gate-watch.js';
import { openHookChannel } from './hook-channel.js';
import type { RpcAnswer, RpcId } from './stdio-rpc.js';

/** The variables a Codex session's app-server carries for its hook, by name: kept out of the agent's shell. */
export const CODEX_HOOK_VARIABLES = [
  HOOK_CHANNEL_VARIABLE,
  HOOK_TOKEN_VARIABLE,
  HOOK_DEADLINE_VARIABLE,
] as const;

/** How many distinct degrades one session raises at most; past it, the host's own log still has each. */
const MAX_RAISED_DEGRADES = 4096;

/** A degrade known when the session opens: named in its opening tier and raised once with its detail. */
export interface SpawnDegrade {
  readonly name: RefusalReason;
  readonly detail: string;
}

/** One Codex session's gate, as its process uses it. */
export interface CodexSessionGate {
  /** The variables the app-server's environment carries for the hook. */
  readonly env: Readonly<Record<string, string>>;
  /** Their names, written into the shell's exclusions. */
  readonly excludedVariables: readonly string[];
  /** Settles once the hook channel is listening, or refuses with why it could not. */
  ready(): Promise<Result<void>>;
  /** Answers one request the app-server sent. Never rejects. */
  answer(method: string, params: JsonObject, id: RpcId): Promise<RpcAnswer>;
  /** Told every notification the app-server sends, before it is forwarded. */
  observe(method: string, params: JsonObject): void;
  /** A named degrade on the session's state lane, once per (name, key). */
  raise(name: RefusalReason, detail: string, key: string): void;
  /** The degrades known at the open, for the opening tier, each raised once with its detail. */
  stateSpawnDegrades(found: readonly SpawnDegrade[]): void;
  /** Ends the channel and every decision still outstanding. Idempotent. */
  close(): void;
}

export interface CodexSessionGateOptions {
  readonly sessionKey: string;
  /** The session's working directory. */
  readonly cwd: string;
  readonly decide: Decider;
  readonly localGate?: LocalGate;
  readonly decisionTimeoutMs: number;
  readonly holdAfterMs: number;
  /** Periscope's hooks file in the runner's Codex home: its runs carry it as their source. */
  readonly hooksPath: string;
  /** This package's version, answered on the channel. */
  readonly version: string;
  /** Told every gate outcome: the session's machine, its items, the embedder. */
  readonly onOutcome: (outcome: GateOutcome) => void;
  /** A degrade for the session's state lane. */
  readonly onDegrade: (name: RefusalReason, detail: string) => void;
  /** The degrades known at the open, for the opening tier. */
  readonly onSpawnDegrades: (names: readonly RefusalReason[]) => void;
  /** A request the channel refused before deciding anything, for the host's log. */
  readonly onChannelRefused?: (detail: string) => void;
  /** Told every event the hook sent, as Codex wrote it, before it is decided. An observation only. */
  readonly onHookEvent?: (event: unknown) => void;
  readonly platform?: string;
}

/**
 * Why a Codex session's decision deadline cannot sit inside its hook's: the hook waits the decision
 * deadline plus a margin, and must still answer inside Codex's own timeout for the hook. Null when the
 * order holds.
 */
export function codexDeadlineOrderRefusal(decisionTimeoutMs: number): string | null {
  if (decisionTimeoutMs + HOOK_DEADLINE_MARGIN_MS < MAX_HOOK_DEADLINE_MS) return null;
  return (
    `decisionTimeoutMs (${decisionTimeoutMs}ms) leaves no room inside Codex's hook: the hook waits it plus ` +
    `${HOOK_DEADLINE_MARGIN_MS}ms and must answer by ${MAX_HOOK_DEADLINE_MS}ms, inside the hook timeout Codex ` +
    'enforces, after which Codex lets the call run. Set decisionTimeoutMs below ' +
    `${MAX_HOOK_DEADLINE_MS - HOOK_DEADLINE_MARGIN_MS}ms for a Codex session.`
  );
}

/** What the hook is told for one terminal outcome: the same reason Claude's hook output carries. */
export function hookDecisionOf(outcome: TerminalOutcome): HookDecision {
  switch (outcome.kind) {
    case 'allow':
      return outcome.updatedInput === undefined
        ? { allow: true }
        : { allow: true, updatedInput: outcome.updatedInput };
    case 'deny':
      return { allow: false, reason: outcome.message };
    case 'refused':
      return { allow: false, reason: `${outcome.refusal.reason}: ${outcome.refusal.detail}` };
    case 'expired':
      return { allow: false, reason: `${HOOK_TIMEOUT_EVENT}: ${outcome.detail}` };
  }
}

/** Build one Codex session's gate. The channel starts listening at once. */
export function createCodexSessionGate(options: CodexSessionGateOptions): CodexSessionGate {
  const platform = options.platform ?? process.platform;
  const shellDialect = codexShellDialect(platform);
  const raised = new Set<string>();

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

  const decide: CallDecision = createCallDecision({
    decide: options.decide,
    onOutcome: options.onOutcome,
    sessionKey: options.sessionKey,
    runtime: CODEX_RUNTIME,
    ...(options.localGate === undefined ? {} : { localGate: options.localGate }),
    decisionTimeoutMs: options.decisionTimeoutMs,
    holdAfterMs: options.holdAfterMs,
    // Codex's hook can only let a call proceed as asked or block it.
    canRewriteInput: false,
  });

  const cache = new CodexDecisionCache();

  const channel = openHookChannel({
    runtime: CODEX_RUNTIME,
    version: options.version,
    platform,
    ...(options.onChannelRefused === undefined ? {} : { onRefused: options.onChannelRefused }),
    decide: async (event, signal) => {
      try {
        options.onHookEvent?.(event);
      } catch {
        // An observer that throws must not decide the call.
      }
      const request = readCodexHookRequest(event, {
        sessionKey: options.sessionKey,
        runtime: CODEX_RUNTIME,
        shellDialect,
      });
      const outcome = await decide(request, signal);
      if (request !== null) cache.record(codexHookTurn(event), outcome);
      return hookDecisionOf(outcome);
    },
  });

  const approvals = new CodexApprovals({
    decide,
    cache,
    sessionKey: options.sessionKey,
    runtime: CODEX_RUNTIME,
    shellDialect,
    cwd: options.cwd,
    raise,
  });

  const watch = new CodexGateWatch({
    hooksPath: options.hooksPath,
    decided: (toolUseId) => cache.wasDecided(toolUseId),
    raise,
    takeWrittenInput: (itemId) => approvals.takeWrittenInput(itemId),
    blockedByHook: (toolUseId, reason) => {
      // The hook blocked a call it never asked about: no channel, a channel it could not reach, or its
      // own deadline. The call did not run; the outcome says which of those it was.
      const request = { ...unreadableRequest(options.sessionKey, CODEX_RUNTIME), toolUseId };
      const expired = reason.startsWith(`${HOOK_EXPIRY_EVENT}:`);
      const blocked: Refusal = refusal(
        'permission-decision-unavailable',
        `the hook blocked call ${toolUseId} without a decision from this host: ${reason}`,
      );
      cache.decided(toolUseId);
      try {
        options.onOutcome(
          expired
            ? { kind: 'expired', request, held: false, detail: reason }
            : { kind: 'refused', request, held: false, refusal: blocked },
        );
      } catch {
        // Losing one record must not take the watch down.
      }
    },
  });

  return {
    env: {
      [HOOK_CHANNEL_VARIABLE]: channel.address,
      [HOOK_TOKEN_VARIABLE]: channel.token,
      [HOOK_DEADLINE_VARIABLE]: String(options.decisionTimeoutMs + HOOK_DEADLINE_MARGIN_MS),
    },
    excludedVariables: CODEX_HOOK_VARIABLES,
    ready: () => channel.ready(),
    answer: (method, params, id) => approvals.answer(method, params, id),
    observe: (method, params) => {
      approvals.observe(method, params);
      watch.observe(method, params);
    },
    raise,
    stateSpawnDegrades: (found) => {
      try {
        options.onSpawnDegrades(found.map((one) => one.name));
      } catch {
        // The tier is a statement; failing to make it must not end the open.
      }
      for (const one of found) raise(one.name, one.detail, 'open');
    },
    close: () => {
      approvals.close();
      channel.close();
    },
  };
}

/** Whether `value` is a Codex session gate, as the registry carries it to the runtime's start. */
export function isCodexSessionGate(value: unknown): value is CodexSessionGate {
  if (typeof value !== 'object' || value === null) return false;
  const gate = value as Partial<Record<keyof CodexSessionGate, unknown>>;
  return (
    typeof gate.answer === 'function' &&
    typeof gate.observe === 'function' &&
    typeof gate.ready === 'function'
  );
}
