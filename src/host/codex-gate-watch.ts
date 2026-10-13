/**
 * The residual paths of a Codex session's gate, watched as they happen: each one a named degrade on the
 * session's state lane.
 *
 * It reads what Codex reports and compares it with what this host actually decided. A tool call Codex
 * starts, or its hook lets proceed, with no decision from this host for its call id is a call the gate
 * never saw, whatever the hook process says about itself: a hook that did not run, a hook command that
 * was replaced, or something that answered on the hook channel's name. That comparison is what makes the
 * gate's integrity checkable from outside the hook.
 *
 * - One of this host's hook runs that `failed`: the call ran. Codex's error entry names why: a timeout,
 *   an output it refused, or a command that could not run.
 * - A run that `completed` (the call proceeds), or a command, patch or MCP item that started, for a call
 *   id this host never decided: `gate-hook-missing`.
 * - A run that `blocked` for a call id this host never decided: the hook refused it on its own (no
 *   channel, a channel it could not reach, its own deadline). The call did not run; it is recorded as
 *   an outcome so the trace still says why.
 * - Input written to a running command that no decided approval covers, a hosted web search or an image
 *   generation: `gate-unhooked-call`.
 * - An approval Codex's own reviewer decided: `gate-approval-auto-reviewed`.
 */
import type { JsonObject } from '../control/frames.js';
import type { RefusalReason } from '../core/refusal.js';
import { samePath } from './codex-home.js';

/** The Codex event name of a `PreToolUse` hook run, as the app-server's notifications spell it. */
const PRE_TOOL_USE = 'preToolUse';

/** How a run's error entry opens, for each degrade it names. Anything else could not run. */
const TIMED_OUT = 'hook timed out after';
const OUTPUT_REJECTED = ['PreToolUse hook returned', 'hook returned invalid'] as const;

/** The item kinds whose calls pass through the hook. */
const HOOKED_ITEMS = ['commandExecution', 'fileChange', 'mcpToolCall'] as const;

/** The item kinds whose calls never reach any hook. */
const UNHOOKED_ITEMS = ['webSearch', 'imageGeneration'] as const;

export interface CodexGateWatchOptions {
  /** The hooks file periscope's hook is defined in: its runs carry it as their source. */
  readonly hooksPath: string;
  /** Whether this host decided the call `toolUseId`, on the hook channel or an approval. */
  readonly decided: (toolUseId: string) => boolean;
  /** A degrade, deduplicated by the caller per (name, key). */
  readonly raise: (name: RefusalReason, detail: string, key: string) => void;
  /** The hook blocked `toolUseId` on its own, with `reason`: recorded as an outcome. */
  readonly blockedByHook: (toolUseId: string, reason: string) => void;
  /** Consumes one decided approval that covers input written to the running command `itemId`. */
  readonly takeWrittenInput: (itemId: string) => boolean;
}

const record = (value: unknown): JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Watches one session's notifications. */
export class CodexGateWatch {
  readonly #options: CodexGateWatchOptions;

  constructor(options: CodexGateWatchOptions) {
    this.#options = options;
  }

  /** Told every notification the session's app-server sends, before it is forwarded. */
  observe(method: string, params: JsonObject): void {
    switch (method) {
      case 'hook/completed':
        this.#hookCompleted(record(params['run']));
        return;
      case 'item/started':
        this.#itemStarted(record(params['item']));
        return;
      case 'item/commandExecution/terminalInteraction': {
        const itemId = text(params['itemId']);
        if (itemId === null || this.#options.takeWrittenInput(itemId)) return;
        this.#options.raise(
          'gate-unhooked-call',
          `input was written to the running command ${itemId}, which no hook sees and no decided approval covered`,
          itemId,
        );
        return;
      }
      case 'item/autoApprovalReview/completed': {
        const reviewId = text(params['reviewId']) ?? text(params['targetItemId']) ?? 'unknown review';
        const action = text(record(params['action'])['type']) ?? 'an action';
        const status = text(record(params['review'])['status']) ?? 'decided';
        this.#options.raise(
          'gate-approval-auto-reviewed',
          `Codex's own reviewer decided an approval for ${action} (${status}), not this host`,
          reviewId,
        );
        return;
      }
      default:
        return;
    }
  }

  /** A hook run of this host's hook that ended. */
  #hookCompleted(run: JsonObject): void {
    if (text(run['eventName']) !== PRE_TOOL_USE) return;
    const sourcePath = text(run['sourcePath']);
    if (sourcePath === null || !samePath(sourcePath, this.#options.hooksPath)) return;
    const id = text(run['id']) ?? '';
    const order = typeof run['displayOrder'] === 'number' ? run['displayOrder'] : null;
    const prefix = `pre-tool-use:${order ?? ''}:${sourcePath}:`;
    const toolUseId = id.startsWith(prefix) ? id.slice(prefix.length) : null;
    const key = toolUseId ?? id;
    const entries = Array.isArray(run['entries']) ? (run['entries'] as unknown[]).map(record) : [];
    const entryText = (kind: string): string =>
      entries
        .filter((entry) => entry['kind'] === kind)
        .map((entry) => text(entry['text']) ?? '')
        .join('; ');
    switch (text(run['status'])) {
      case 'failed': {
        const why = entryText('error');
        const name: RefusalReason = why.startsWith(TIMED_OUT)
          ? 'gate-hook-timed-out'
          : OUTPUT_REJECTED.some((opening) => why.startsWith(opening))
            ? 'gate-hook-output-rejected'
            : 'gate-hook-unspawnable';
        this.#options.raise(name, `the hook failed for call ${key}, and Codex ran the call: ${why}`, key);
        return;
      }
      case 'completed':
        if (toolUseId !== null && !this.#options.decided(toolUseId)) {
          this.#options.raise(
            'gate-hook-missing',
            `the hook let call ${toolUseId} proceed without a decision from this host`,
            toolUseId,
          );
        }
        return;
      case 'blocked':
        if (toolUseId !== null && !this.#options.decided(toolUseId)) {
          this.#options.blockedByHook(toolUseId, entryText('feedback'));
        }
        return;
      default:
        return;
    }
  }

  /** A thread item that started. */
  #itemStarted(item: JsonObject): void {
    const type = text(item['type']);
    const id = text(item['id']);
    if (type === null || id === null) return;
    if ((HOOKED_ITEMS as readonly string[]).includes(type)) {
      // A command the user's shell or a running process produced is no model tool call.
      const source = text(item['source']);
      if (type === 'commandExecution' && source !== null && source !== 'agent') return;
      if (!this.#options.decided(id)) {
        this.#options.raise(
          'gate-hook-missing',
          `Codex started ${type} ${id} with no decision from this host for it`,
          id,
        );
      }
      return;
    }
    if ((UNHOOKED_ITEMS as readonly string[]).includes(type)) {
      this.#options.raise('gate-unhooked-call', `Codex ran ${type} ${id}, which no hook sees`, id);
    }
  }
}
