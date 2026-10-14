/**
 * The Qwen Code fill: a Qwen session's conversation, read into the wire's items from the CLI's stream
 * messages and from the prompts this host wrote.
 *
 * Qwen Code's assistant and user messages are shaped like Claude's, so their content blocks are read by
 * the Claude fill (`ClaudeItemFill`), and this fill is the guard around it: it hands that fill only the
 * two message kinds, from the main thread, whose blocks carry the members it reads; it reads every tool
 * call's kind by Qwen's own map, never Claude's; and it reads everything else itself, from members Qwen
 * fills. What each item is read from:
 *   - `turn` started and `user_text`: the CLI never echoes a prompt, so each prompt this host wrote is
 *     held, in order, and marked started at the next main-thread `system/init`, where the CLI takes the
 *     next queued prompt. The CLI runs its queued prompts before anything else it queues, so the order
 *     holds. An init with no prompt waiting (a turn the CLI started on its own) marks a turn started
 *     with no `user_text`.
 *   - `agent_text`, `thinking`, `tool_call`: each assistant `text`, `thinking` and `tool_use` block, as
 *     the Claude fill reads them; a tool call's kind by `qwenToolKind`. Qwen marks no answer, so `final`
 *     is null.
 *   - `tool_result`: each user `tool_result` block, `blocked` when this host's gate refused the call,
 *     `failed` when the result is an error, `completed` otherwise.
 *   - `turn` ended: each `result`, interrupted when its error is the CLI's cancellation, failed when it is
 *     another error, completed otherwise.
 *   - `notice`: a retry or a model fallback the CLI runs on its own, and a chat it could not record.
 * Qwen reports no turn id, so every item's `turnId` is null. A prompt's id is the session's key with its
 * count, as the Claude fill makes it.
 */
import type { AgentItem, NoticeItem } from '../control/frames.js';
import { qwenToolKind } from '../gate/tool-kind.js';
import type { ItemFill } from '../sessions/item-fill.js';
import { QWEN_INTERRUPTED_MESSAGE } from '../state/qwen-observer.js';
import type { SDKMessage } from './agent-process.js';
import { ClaudeItemFill } from './claude-items.js';
import type { QwenMessage } from './qwen-wire.js';
import { ResultMessage, SystemMessage, parsed, qwenMessageKey } from './qwen-wire.js';

/** The system subtypes that are a notice, and at what level. */
const NOTICES: Readonly<Record<string, NoticeItem['level']>> = {
  'system/retry': 'warning',
  'system/model_fallback': 'warning',
  'system/session_recording_degraded': 'warning',
};

export class QwenItemFill implements ItemFill<QwenMessage> {
  readonly #sessionKey: string;
  readonly #claude: ClaudeItemFill;
  readonly #waiting: string[] = [];
  #prompts = 0;
  #turns = 0;

  /** `sessionKey` is the periscope session's own key: what a prompt's item id is made from. */
  constructor(sessionKey: string) {
    this.#sessionKey = sessionKey;
    this.#claude = new ClaudeItemFill(sessionKey);
  }

  /** This host's gate refused the call `toolUseId`, so its result is `blocked`. */
  gateBlocked(toolUseId: string): void {
    this.#claude.gateBlocked(toolUseId);
  }

  fromMessage(message: QwenMessage): readonly AgentItem[] {
    if (message.kind === 'prompt') {
      this.#waiting.push(message.text);
      return [];
    }
    if (message.kind !== 'message') return [];
    const body = message.message;
    const key = qwenMessageKey(body);
    switch (key) {
      case 'system/init':
        return this.#turnStarted();
      case 'assistant':
      case 'user':
        // The Claude fill reads these two kinds' blocks; a sub-agent's message it leaves alone itself.
        return this.#claude
          .fromMessage(body as unknown as SDKMessage)
          .map((item) =>
            item.kind === 'tool_call' ? { ...item, toolKind: qwenToolKind(item.toolName) } : item,
          );
      case 'result':
        return this.#turnEnded(body);
      default:
        return key !== null && Object.hasOwn(NOTICES, key) ? this.#notice(key, body) : [];
    }
  }

  #turnStarted(): AgentItem[] {
    this.#turns += 1;
    const prompt = this.#waiting.shift();
    if (prompt === undefined) {
      return [
        {
          kind: 'turn',
          itemId: `${this.#sessionKey}:turn:${this.#turns}`,
          turnId: null,
          status: 'started',
          detail: null,
          truncated: false,
        },
      ];
    }
    this.#prompts += 1;
    const itemId = `${this.#sessionKey}:prompt:${this.#prompts}`;
    return [
      {
        kind: 'turn',
        itemId: `${itemId}:turn`,
        turnId: null,
        status: 'started',
        detail: null,
        truncated: false,
      },
      { kind: 'user_text', itemId, turnId: null, text: prompt, truncated: false },
    ];
  }

  #turnEnded(body: Readonly<Record<string, unknown>>): AgentItem[] {
    const result = parsed(ResultMessage, body);
    if (result === null) return [];
    const error = result.error?.message ?? null;
    const status: 'completed' | 'interrupted' | 'failed' = !result.is_error
      ? 'completed'
      : error !== null && error.startsWith(QWEN_INTERRUPTED_MESSAGE)
        ? 'interrupted'
        : 'failed';
    return [
      {
        kind: 'turn',
        itemId: result.uuid ?? `${this.#sessionKey}:result:${this.#turns}`,
        turnId: null,
        status,
        detail: status === 'completed' ? null : (error ?? result.subtype),
        truncated: false,
      },
    ];
  }

  #notice(key: string, body: Readonly<Record<string, unknown>>): AgentItem[] {
    const system = parsed(SystemMessage, body);
    if (system === null) return [];
    const data =
      typeof system.data === 'object' && system.data !== null ? (system.data as Record<string, unknown>) : {};
    const text =
      key === 'system/model_fallback'
        ? `the model fell back${typeof data['fromModel'] === 'string' ? ` from ${data['fromModel']}` : ''}${typeof data['toModel'] === 'string' ? ` to ${data['toModel']}` : ''}`
        : key === 'system/retry'
          ? `the model call is retried${typeof data['attempt'] === 'number' ? ` (attempt ${data['attempt']}${typeof data['maxRetries'] === 'number' ? ` of ${data['maxRetries']}` : ''})` : ''}`
          : 'the CLI could not record the session, so a later resume may find nothing';
    return [
      {
        kind: 'notice',
        itemId: system.uuid ?? `${this.#sessionKey}:${key}:${this.#turns}`,
        turnId: null,
        level: NOTICES[key] ?? 'info',
        text,
        truncated: false,
      },
    ];
  }
}
