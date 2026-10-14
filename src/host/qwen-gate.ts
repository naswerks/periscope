/**
 * One Qwen Code session's gate: every `can_use_tool` the CLI sends is decided by the per-call decision
 * every runtime shares, and the paths a call could still take without one are named on the session's
 * state lane.
 *
 * The CLI asks about every call its rules send to ask, and the session's settings send every built-in
 * tool and every attached server there (`qwen-home.ts`). It fails closed on its side: an error answer, a
 * timeout, an abort or a closed input cancels the call. This gate answers within the host's own decision
 * deadline, which sits inside the CLI's permission timeout (`qwenDeadlineOrderRefusal`), so the host's
 * deadline is the one that names an expiry.
 *
 * An allow is answered `{ behavior: 'allow' }` with no input of its own: the CLI runs the call it built
 * from the arguments it asked about, so an allow that rewrites them is refused rather than half applied
 * (`canRewriteInput: false`). A deny carries its reason, which the model is told.
 *
 * What it names, each a degrade raised once per (name, key):
 * - `gate-tool-unruled`: the CLI's first list of tools names one the ask rules do not, so a call to it
 *   that the CLI allows by default runs without asking;
 * - `gate-mode-widened`: the CLI reports a permission mode other than `default` or `plan`;
 * - `gate-credential-in-shell`, known when the session opens: a file of variables the CLI loads into its
 *   own environment, and so into every command the agent runs, is present.
 */
import type { JsonObject } from '../control/frames.js';
import type { RefusalReason } from '../core/refusal.js';
import type { CallDecision } from '../gate/call-decision.js';
import { createCallDecision } from '../gate/call-decision.js';
import type { Decider, DecisionRequest, ShellDialect } from '../gate/decision.js';
import type { LocalGate } from '../gate/local.js';
import { shellDirectoryOf } from '../gate/local.js';
import type { GateOutcome, TerminalOutcome } from '../gate/outcome.js';
import { qwenShellDialect, qwenToolKind } from '../gate/tool-kind.js';
import { QWEN_RUNTIME } from '../sessions/runtimes.js';
import { HOOK_TIMEOUT_EVENT } from '../state/model.js';
import type { SpawnDegrade } from './codex-gate.js';
import type { QwenControlAnswer } from './qwen-control.js';
import { CanUseToolRequest, parsed } from './qwen-wire.js';

/** The CLI's own ceiling for its permission timeout: a larger value is ignored and 60 seconds used. */
export const QWEN_MAX_PERMISSION_TIMEOUT_MS = 600_000;

/** How far the CLI's permission timeout sits above the host's decision deadline. */
export const QWEN_PERMISSION_MARGIN_MS = 5_000;

/** The permission modes this host admits on Qwen Code, in Qwen's own words. */
export const QWEN_ADMITTED_MODES: readonly string[] = ['default', 'plan'];

/** How many distinct degrades one session raises at most; past it, the host's own log still has each. */
const MAX_RAISED_DEGRADES = 4096;

/**
 * Why a Qwen session's decision deadline cannot sit inside the CLI's permission timeout: the timeout is
 * the deadline plus a margin, and the CLI ignores one above its ceiling, waiting its own 60 seconds
 * instead. Null when the order holds.
 */
export function qwenDeadlineOrderRefusal(decisionTimeoutMs: number): string | null {
  if (decisionTimeoutMs + QWEN_PERMISSION_MARGIN_MS <= QWEN_MAX_PERMISSION_TIMEOUT_MS) return null;
  return (
    `decisionTimeoutMs (${decisionTimeoutMs}ms) leaves no room inside Qwen Code's permission timeout: the ` +
    `timeout is it plus ${QWEN_PERMISSION_MARGIN_MS}ms, and the CLI ignores one above ` +
    `${QWEN_MAX_PERMISSION_TIMEOUT_MS}ms and waits 60000ms instead, which would expire first. Set ` +
    `decisionTimeoutMs at or below ${QWEN_MAX_PERMISSION_TIMEOUT_MS - QWEN_PERMISSION_MARGIN_MS}ms for a Qwen Code session.`
  );
}

/** The CLI's permission timeout for a session whose decision deadline is `decisionTimeoutMs`. */
export function qwenPermissionTimeoutMs(decisionTimeoutMs: number): number {
  return decisionTimeoutMs + QWEN_PERMISSION_MARGIN_MS;
}

/** One Qwen Code session's gate, as its process uses it. */
export interface QwenSessionGate {
  /** Marks this as a Qwen session's gate, for the registry's route. */
  readonly runtime: typeof QWEN_RUNTIME;
  /** The CLI's permission timeout, sent at `initialize`. */
  readonly permissionTimeoutMs: number;
  /** Answers one `can_use_tool` request. Never rejects. */
  decide(request: JsonObject, signal: AbortSignal): Promise<QwenControlAnswer>;
  /** Told the session's id once the CLI has named it. */
  identify(sessionId: string): void;
  /**
   * Told the environment the CLI is started with: it decides which shell the CLI's commands run in, and
   * the local gate reads its path variables.
   */
  spawnedWith(env: Readonly<Record<string, string | undefined>>): void;
  /** Told every `system/init`'s tools and mode; the first one's tools are checked against the rules. */
  observeInit(tools: readonly string[] | null, mode: string | null): void;
  /** A named degrade on the session's state lane, once per (name, key). */
  raise(name: RefusalReason, detail: string, key: string): void;
  /** The degrades known at the open, for the opening tier, each raised once with its detail. */
  stateSpawnDegrades(found: readonly SpawnDegrade[]): void;
}

export interface QwenSessionGateOptions {
  readonly sessionKey: string;
  /** The session's working directory: where a call that names none runs. */
  readonly cwd: string;
  readonly decide: Decider;
  readonly localGate?: LocalGate;
  readonly decisionTimeoutMs: number;
  readonly holdAfterMs: number;
  /** The ask rules the session's settings carry: a listed tool none of them names is unruled. */
  readonly askRules: readonly string[];
  /** Told every gate outcome: the session's machine, its items, the embedder. */
  readonly onOutcome: (outcome: GateOutcome) => void;
  /** A degrade for the session's state lane. */
  readonly onDegrade: (name: RefusalReason, detail: string) => void;
  /** The degrades known at the open, for the opening tier. */
  readonly onSpawnDegrades: (names: readonly RefusalReason[]) => void;
  /** Told every environment the session's process is started with, for the local gate. */
  readonly spawnedWith?: (env: Readonly<Record<string, string | undefined>>) => void;
  readonly platform?: string;
}

/** What the CLI is told for one terminal outcome. A deny's reason is what the model reads. */
export function qwenAnswerOf(outcome: TerminalOutcome): JsonObject {
  switch (outcome.kind) {
    case 'allow':
      return { behavior: 'allow' };
    case 'deny':
      return { behavior: 'deny', message: outcome.message };
    case 'refused':
      return { behavior: 'deny', message: `${outcome.refusal.reason}: ${outcome.refusal.detail}` };
    case 'expired':
      return { behavior: 'deny', message: `${HOOK_TIMEOUT_EVENT}: ${outcome.detail}` };
  }
}

/** Whether an ask rule names `tool`: the tool by name, or its MCP server by `mcp__{server}`. */
export function ruleNames(rules: ReadonlySet<string>, tool: string): boolean {
  if (rules.has(tool)) return true;
  if (!tool.startsWith('mcp__')) return false;
  for (const rule of rules) {
    if (rule.startsWith('mcp__') && tool.startsWith(`${rule}__`)) return true;
  }
  return false;
}

/** Build one Qwen Code session's gate. */
export function createQwenSessionGate(options: QwenSessionGateOptions): QwenSessionGate {
  const platform = options.platform ?? process.platform;
  // Read again from the CLI's own environment once it is spawned; this host's is the stand-in until then.
  let shellDialect: ShellDialect = qwenShellDialect(platform, process.env);
  const rules = new Set(options.askRules);
  const raised = new Set<string>();
  let sessionId = '';
  let toolsChecked = false;

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
    runtime: QWEN_RUNTIME,
    ...(options.localGate === undefined ? {} : { localGate: options.localGate }),
    decisionTimeoutMs: options.decisionTimeoutMs,
    holdAfterMs: options.holdAfterMs,
    // The CLI runs the call it built from the arguments it asked about, whatever an allow carries.
    canRewriteInput: false,
  });

  const requestOf = (raw: JsonObject): DecisionRequest | null => {
    const read = parsed(CanUseToolRequest, raw);
    if (read === null || read.tool_name === '' || read.tool_use_id === '') return null;
    const toolKind = qwenToolKind(read.tool_name);
    return {
      toolName: read.tool_name,
      toolUseId: read.tool_use_id,
      toolInput: read.input,
      sessionId,
      sessionKey: options.sessionKey,
      // A shell call runs in the directory it names; every other call where the session runs.
      cwd: shellDirectoryOf(read.input) ?? options.cwd,
      agentId: null,
      agentType: null,
      toolKind,
      runtime: QWEN_RUNTIME,
      ...(toolKind === 'shell' ? { shellDialect } : {}),
    };
  };

  return {
    runtime: QWEN_RUNTIME,
    permissionTimeoutMs: qwenPermissionTimeoutMs(options.decisionTimeoutMs),
    async decide(raw, signal) {
      // An unreadable request is refused by the shared decision, which records it; the CLI is told no.
      return { response: qwenAnswerOf(await decide(requestOf(raw), signal)) };
    },
    identify(id) {
      sessionId = id;
    },
    spawnedWith(env) {
      shellDialect = qwenShellDialect(platform, env);
      options.spawnedWith?.(env);
    },
    observeInit(tools, mode) {
      if (mode !== null && !QWEN_ADMITTED_MODES.includes(mode)) {
        raise(
          'gate-mode-widened',
          `Qwen Code reports permission mode ${mode}, which approves calls itself`,
          mode,
        );
      }
      if (toolsChecked || tools === null) return;
      toolsChecked = true;
      for (const tool of tools) {
        if (!ruleNames(rules, tool)) {
          raise(
            'gate-tool-unruled',
            `Qwen Code lists the tool ${tool}, which no ask rule names, so a call to it the CLI allows by default runs without asking this host`,
            tool,
          );
        }
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

/** Whether `value` is a Qwen Code session gate, as the registry carries it to the runtime's start. */
export function isQwenSessionGate(value: unknown): value is QwenSessionGate {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { runtime?: unknown }).runtime === QWEN_RUNTIME &&
    typeof (value as { decide?: unknown }).decide === 'function'
  );
}
