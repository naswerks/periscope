/**
 * Codex's approval requests, answered by the same per-call decision as its hook.
 *
 * Codex raises an approval from a tool's handler, after its hook, and waits for an answer with no deadline
 * of its own. So each approval is answered here, under the host's decision deadline:
 *
 * - from the decision this host already made for that call on the hook channel, when there is one and it
 *   is about the same call: one decision per call;
 * - with a fresh decision otherwise, which is exactly the case where the hook did not decide it;
 * - `decline` at the host's deadline, raising `gate-approval-unanswered`.
 *
 * An allow is `accept` and nothing wider: never a grant for the session, never an amendment to Codex's own
 * rules, never a root it may write under. A permission widening is never granted, a form or a link an MCP
 * server asks for is declined, and a question for a person gets no answers, because nobody sits on this
 * lane to type one.
 *
 * Two shapes cannot be answered from the hook's decision. Input written to a running command reaches
 * Codex as an approval carrying the command's own item id, which the hook decided as a launch, so it is
 * always decided fresh. And an MCP tool approval names no call: it is tied to the call that started on
 * the same server, and when several are pending there, each is decided and the approval is accepted only
 * if every one of them was allowed.
 */
import type { JsonObject } from '../control/frames.js';
import type { RefusalReason } from '../core/refusal.js';
import type { CallDecision } from '../gate/call-decision.js';
import type { DecisionRequest, ShellDialect } from '../gate/decision.js';
import { patchInputPaths } from '../gate/local.js';
import type { TerminalOutcome } from '../gate/outcome.js';
import { codexToolKind } from '../gate/tool-kind.js';
import { codexServerRequestAnswer } from './codex-answers.js';
import { samePath } from './codex-home.js';
import type { RpcAnswer, RpcId } from './stdio-rpc.js';
import { RPC_INTERNAL_ERROR, RPC_METHOD_NOT_FOUND } from './stdio-rpc.js';

/** How many of the hook's decisions are kept for the approvals that follow them. */
export const MAX_CACHED_DECISIONS = 256;

/** How many decided call ids are remembered for the degrade watch. */
export const MAX_DECIDED_IDS = 1024;

const record = (value: unknown): JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The hook channel's decisions, kept for the approval that may follow each one, keyed by the turn and the
 * call id, and the call ids this host decided at all.
 */
export class CodexDecisionCache {
  readonly #entries = new Map<string, TerminalOutcome>();
  readonly #decided = new Set<string>();

  static #key(turnId: string | null, toolUseId: string): string {
    return `${turnId ?? ''}\u0000${toolUseId}`;
  }

  /** A decision made for `outcome.request` in `turnId`. A later decision for the same call replaces it. */
  record(turnId: string | null, outcome: TerminalOutcome): void {
    const key = CodexDecisionCache.#key(turnId, outcome.request.toolUseId);
    this.#entries.delete(key);
    this.#entries.set(key, outcome);
    while (this.#entries.size > MAX_CACHED_DECISIONS) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    this.decided(outcome.request.toolUseId);
  }

  /** Marks `toolUseId` as decided by this host. */
  decided(toolUseId: string): void {
    this.#decided.delete(toolUseId);
    this.#decided.add(toolUseId);
    while (this.#decided.size > MAX_DECIDED_IDS) {
      const oldest = this.#decided.values().next().value;
      if (oldest === undefined) break;
      this.#decided.delete(oldest);
    }
  }

  /** Whether this host decided `toolUseId`. */
  wasDecided(toolUseId: string): boolean {
    return this.#decided.has(toolUseId);
  }

  /** The decision for the call, removed: an approval consumes it. */
  take(turnId: string | null, toolUseId: string): TerminalOutcome | null {
    const key = CodexDecisionCache.#key(turnId, toolUseId);
    const found = this.#entries.get(key) ?? null;
    this.#entries.delete(key);
    return found;
  }

  /** The call ended: nothing can ask about it again. */
  dropCall(toolUseId: string): void {
    for (const key of [...this.#entries.keys()]) {
      if (key.endsWith(`\u0000${toolUseId}`)) this.#entries.delete(key);
    }
  }

  /** The turn ended: no approval can follow any of its decisions. */
  dropTurn(turnId: string): void {
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(`${turnId}\u0000`)) this.#entries.delete(key);
    }
  }
}

/** A tool item an approval may be about, as it started. */
interface PendingItem {
  readonly type: string;
  readonly item: JsonObject;
}

export interface CodexApprovalsOptions {
  readonly decide: CallDecision;
  readonly cache: CodexDecisionCache;
  readonly sessionKey: string;
  readonly runtime: string;
  readonly shellDialect: ShellDialect;
  /** The session's working directory: where a call names none, it runs here. */
  readonly cwd: string;
  /** A degrade, deduplicated by the caller per (name, key). */
  readonly raise: (name: RefusalReason, detail: string, key: string) => void;
}

/** What one terminal outcome answers, as Codex's approval decision word. */
function decisionWord(outcome: TerminalOutcome): 'accept' | 'decline' | 'cancel' {
  if (outcome.kind === 'allow') return 'accept';
  if (outcome.kind === 'deny' && outcome.interrupt === true) return 'cancel';
  return 'decline';
}

/** Answers one session's approval requests. */
export class CodexApprovals {
  readonly #options: CodexApprovalsOptions;
  /** Tool items started and not yet completed, by item id, on every thread. */
  readonly #pending = new Map<string, PendingItem>();
  /** Decided approvals for input written to a running command, counted by the command's item id. */
  readonly #writtenInput = new Map<string, number>();
  /** Decisions still outstanding, by the request they answer. */
  readonly #outstanding = new Map<string, AbortController>();
  #closed = false;

  constructor(options: CodexApprovalsOptions) {
    this.#options = options;
  }

  /** Told every notification, before it is forwarded: the items approvals refer to, and closures. */
  observe(method: string, params: JsonObject): void {
    if (method === 'item/started') {
      const item = record(params['item']);
      const id = text(item['id']);
      const type = text(item['type']);
      if (id !== null && (type === 'fileChange' || type === 'mcpToolCall'))
        this.#pending.set(id, { type, item });
    } else if (method === 'item/completed') {
      const id = text(record(params['item'])['id']);
      if (id !== null) {
        this.#pending.delete(id);
        this.#options.cache.dropCall(id);
      }
    } else if (method === 'turn/completed') {
      const turnId = text(record(params['turn'])['id']);
      if (turnId !== null) this.#options.cache.dropTurn(turnId);
    } else if (method === 'serverRequest/resolved') {
      const requestId = params['requestId'];
      if (typeof requestId === 'string' || typeof requestId === 'number') {
        this.#outstanding.get(String(requestId))?.abort();
      }
    }
  }

  /** Consumes one decided approval covering input written to the running command `itemId`. */
  takeWrittenInput(itemId: string): boolean {
    const count = this.#writtenInput.get(itemId) ?? 0;
    if (count === 0) return false;
    if (count === 1) this.#writtenInput.delete(itemId);
    else this.#writtenInput.set(itemId, count - 1);
    return true;
  }

  /** Every decision still outstanding is abandoned: the process is closing. */
  close(): void {
    this.#closed = true;
    for (const abort of this.#outstanding.values()) abort.abort();
    this.#outstanding.clear();
  }

  /** Answer one request from the app-server. Never rejects. */
  async answer(method: string, params: JsonObject, id: RpcId): Promise<RpcAnswer> {
    const abort = new AbortController();
    if (this.#closed) abort.abort();
    this.#outstanding.set(String(id), abort);
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval':
          return { result: { decision: await this.#command(params, abort.signal) } };
        case 'item/fileChange/requestApproval':
          return { result: { decision: await this.#fileChange(params, abort.signal) } };
        case 'mcpServer/elicitation/request':
          return {
            result: {
              action: await this.#elicitation(params, String(id), abort.signal),
              content: null,
              _meta: null,
            },
          };
        case 'item/permissions/requestApproval':
        case 'item/tool/requestUserInput':
          return codexServerRequestAnswer(method);
        default:
          return { error: { code: RPC_METHOD_NOT_FOUND, message: `${method} is not answered by this host` } };
      }
    } catch (error) {
      // Codex reads an error answer to an approval as a refusal; said by name rather than thrown.
      return {
        error: { code: RPC_INTERNAL_ERROR, message: `${method} could not be decided: ${String(error)}` },
      };
    } finally {
      this.#outstanding.delete(String(id));
    }
  }

  /** A decision request for a call this host builds from an approval. */
  #request(toolName: string, toolUseId: string, toolInput: unknown, cwd: string | null): DecisionRequest {
    const toolKind = codexToolKind(toolName);
    return {
      toolName,
      toolUseId,
      toolInput,
      sessionId: '',
      sessionKey: this.#options.sessionKey,
      cwd: cwd ?? this.#options.cwd,
      agentId: null,
      agentType: null,
      toolKind,
      runtime: this.#options.runtime,
      ...(toolKind === 'shell' ? { shellDialect: this.#options.shellDialect } : {}),
    };
  }

  /** Decide fresh, and name the deadline when it is what answered. */
  async #fresh(request: DecisionRequest, signal: AbortSignal): Promise<TerminalOutcome> {
    const outcome = await this.#options.decide(request, signal);
    this.#options.cache.decided(request.toolUseId);
    if (outcome.kind === 'expired') {
      this.#options.raise(
        'gate-approval-unanswered',
        `Codex's approval for ${request.toolName} ${request.toolUseId} outlived this host's deadline and was declined; the call did not run`,
        request.toolUseId,
      );
    }
    return outcome;
  }

  async #command(params: JsonObject, signal: AbortSignal): Promise<'accept' | 'decline' | 'cancel'> {
    const itemId = text(params['itemId']) ?? '';
    const turnId = text(params['turnId']);
    const command = text(params['command']);
    const cwd = text(params['cwd']);
    if (params['kind'] === 'writeStdin') {
      // Input for a command already running: the hook decided the launch, never this.
      const approvalId = text(params['approvalId']) ?? itemId;
      const outcome = await this.#fresh(
        this.#request('write_stdin', approvalId, { command, cwd, itemId }, cwd),
        signal,
      );
      const word = decisionWord(outcome);
      if (word === 'accept') this.#writtenInput.set(itemId, (this.#writtenInput.get(itemId) ?? 0) + 1);
      return word;
    }
    const cached = this.#options.cache.take(turnId, itemId);
    if (cached !== null && cached.request.toolName === 'Bash') return decisionWord(cached);
    return decisionWord(await this.#fresh(this.#request('Bash', itemId, { command, cwd }, cwd), signal));
  }

  async #fileChange(params: JsonObject, signal: AbortSignal): Promise<'accept' | 'decline' | 'cancel'> {
    const itemId = text(params['itemId']) ?? '';
    const turnId = text(params['turnId']);
    const pending = this.#pending.get(itemId);
    const listed = Array.isArray(pending?.item['changes'])
      ? (pending.item['changes'] as unknown[]).map(record)
      : [];
    const changes = listed.map((change) => ({
      path: text(change['path']) ?? '',
      movePath: text(record(change['kind'])['move_path']),
    }));
    const cached = this.#options.cache.take(turnId, itemId);
    if (
      cached !== null &&
      (cached.request.toolName === 'apply_patch' || cached.request.toolName === 'Bash')
    ) {
      if (changes.length > 0 && namesEveryPath(cached.request, changes)) return decisionWord(cached);
    }
    // `grantRoot` is never honoured: the patch's own files are what is decided.
    const toolInput = {
      changes: changes.map((change) => (change.movePath === null ? { path: change.path } : change)),
    };
    return decisionWord(await this.#fresh(this.#request('apply_patch', itemId, toolInput, null), signal));
  }

  async #elicitation(
    params: JsonObject,
    requestId: string,
    signal: AbortSignal,
  ): Promise<'accept' | 'decline' | 'cancel'> {
    const meta = record(params['_meta']);
    if (meta['codex_approval_kind'] !== 'mcp_tool_call') return 'decline';
    const server = text(params['serverName']);
    if (server === null) return 'decline';
    const turnId = text(params['turnId']);
    let candidates = [...this.#pending.entries()].filter(
      ([, pending]) => pending.type === 'mcpToolCall' && pending.item['server'] === server,
    );
    if (candidates.length > 1 && meta['tool_params'] !== undefined) {
      const wanted = canonical(meta['tool_params']);
      const matching = candidates.filter(([, pending]) => canonical(pending.item['arguments']) === wanted);
      if (matching.length > 0) candidates = matching;
    }
    if (candidates.length === 0) return 'decline';
    const decisions: TerminalOutcome[] = [];
    for (const [callId, pending] of candidates) {
      const tool = text(pending.item['tool']) ?? '';
      const toolName = `mcp__${server}__${tool}`;
      const cached = this.#options.cache.take(turnId, callId);
      decisions.push(
        cached !== null && cached.request.toolName === toolName
          ? cached
          : await this.#fresh(
              this.#request(toolName, callId, pending.item['arguments'] ?? null, null),
              signal,
            ),
      );
    }
    if (decisions.length === 1) return decisionWord(decisions[0] as TerminalOutcome);
    if (decisions.every((outcome) => outcome.kind === 'allow')) return 'accept';
    this.#options.raise(
      'gate-approval-ambiguous',
      `an MCP tool approval from ${server} could not be tied to one of its ${decisions.length} pending calls, and not every one was allowed, so it was declined`,
      `${server}:${requestId}`,
    );
    return 'decline';
  }
}

/** Whether the decided call's input names every file the change lists, its move targets included. */
function namesEveryPath(
  request: DecisionRequest,
  changes: readonly { readonly path: string; readonly movePath: string | null }[],
): boolean {
  const named = patchInputPaths(request.toolInput);
  if (named === null) return false;
  const base = request.cwd;
  const resolved = named.map((path) => (base === '' ? path : `${base}/${path}`));
  const covers = (path: string): boolean =>
    named.some((one) => one === path) ||
    resolved.some((one) => samePath(one, path)) ||
    named.some((one) => samePath(one, path));
  return changes.every(
    (change) => covers(change.path) && (change.movePath === null || covers(change.movePath)),
  );
}

/** A JSON value with its object keys in order, so two equal values compare equal as text. */
function canonical(value: unknown): string {
  const sorted = (inner: unknown): unknown => {
    if (Array.isArray(inner)) return inner.map(sorted);
    if (typeof inner === 'object' && inner !== null) {
      return Object.fromEntries(
        Object.keys(inner)
          .sort()
          .map((key) => [key, sorted((inner as Record<string, unknown>)[key])]),
      );
    }
    return inner;
  };
  return JSON.stringify(sorted(value ?? null));
}
