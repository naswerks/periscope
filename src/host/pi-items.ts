/**
 * The pi fill: a pi session's conversation, read into the wire's items from pi's events and records and
 * from its answers to this host's prompts.
 *
 * What each item is read from:
 *   - `turn` started and ended: a run, `agent_start` to `agent_settled`. A pi turn is one model call and
 *     its tools; the conversation's turn is the whole run a prompt starts. It ended interrupted when pi
 *     says the run was aborted, failed when the run's last answer stopped on an error, completed
 *     otherwise. pi has no turn id, so a run is named by the session's key and its count.
 *   - `user_text`: each user message pi ends, the prompt as pi took it.
 *   - `agent_text`, `thinking`, `tool_call`: each assistant message's text, thinking and tool-call blocks,
 *     a tool call's kind by `piToolKind`. pi marks no answer, so `final` is null.
 *   - `tool_result`: each `tool_execution_end` on the main thread: `blocked` when this host's gate refused
 *     the call, `failed` when the result is an error, `completed` otherwise, with pi's own duration. pi
 *     starts a call before its handlers decide it, so a blocked call has a start and an end too.
 *   - `notice`: a retry pi runs on its own, a compaction that failed, an extension's error, an extension's
 *     notification, and a prompt pi would not take.
 * Every item's `turnId` is null.
 */
import type { AgentItem, JsonObject, NoticeItem } from '../control/frames.js';
import { piToolKind } from '../gate/tool-kind.js';
import type { ItemFill } from '../sessions/item-fill.js';
import type { PiMessage } from './pi-wire.js';
import {
  PiCompactionEnd,
  PiExtensionError,
  PiMessageEnd,
  PiRetryEnd,
  PiRetryScheduled,
  PiToolEnd,
  PiUiRequest,
  parsed,
  piContentText,
  piTypeOf,
  responseError,
} from './pi-wire.js';

/** The level each notification type pi names is said at. */
const NOTIFY_LEVELS: Readonly<Record<string, NoticeItem['level']>> = {
  info: 'info',
  warning: 'warning',
  error: 'error',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class PiItemFill implements ItemFill<PiMessage> {
  readonly #sessionKey: string;
  readonly #blocked = new Set<string>();
  #runs = 0;
  #prompts = 0;
  #messages = 0;
  #notices = 0;
  /** The error the run's last answer stopped on, or null while it has none. */
  #runFailure: string | null = null;

  /** `sessionKey` is the periscope session's own key: what a run's and a prompt's item ids are made from. */
  constructor(sessionKey: string) {
    this.#sessionKey = sessionKey;
  }

  /** This host's gate refused the call `toolUseId`, so its result is `blocked`. */
  gateBlocked(toolUseId: string): void {
    this.#blocked.add(toolUseId);
  }

  fromMessage(message: PiMessage): readonly AgentItem[] {
    switch (message.kind) {
      case 'event':
        return this.#fromEvent(message.event);
      case 'record':
        return this.#fromRecord(message.record);
      case 'response': {
        if (message.command !== 'prompt') return [];
        const error = responseError(message);
        return error === null ? [] : this.#notice('error', `pi did not take the prompt: ${error}`);
      }
      default:
        return [];
    }
  }

  #fromEvent(event: JsonObject): AgentItem[] {
    switch (piTypeOf(event)) {
      case 'agent_start':
        this.#runs += 1;
        this.#runFailure = null;
        return [
          {
            kind: 'turn',
            itemId: `${this.#sessionKey}:run:${this.#runs}`,
            turnId: null,
            status: 'started',
            detail: null,
            truncated: false,
          },
        ];
      case 'message_end':
        return this.#fromMessageEnd(event);
      case 'tool_execution_end':
        return this.#fromToolEnd(event);
      case 'agent_settled': {
        const failed = this.#runFailure;
        this.#runFailure = null;
        const status: 'completed' | 'interrupted' | 'failed' =
          event['aborted'] === true ? 'interrupted' : failed !== null ? 'failed' : 'completed';
        return [
          {
            kind: 'turn',
            itemId: `${this.#sessionKey}:run:${this.#runs}:end`,
            turnId: null,
            status,
            detail: status === 'failed' ? failed : status === 'interrupted' ? 'the run was aborted' : null,
            truncated: false,
          },
        ];
      }
      case 'auto_retry_start': {
        const retry = parsed(PiRetryScheduled, event);
        if (retry === null) return [];
        return this.#notice(
          'warning',
          `the model call is retried (attempt ${retry.attempt} of ${retry.maxAttempts})${retry.errorMessage === undefined ? '' : `: ${retry.errorMessage}`}`,
        );
      }
      case 'auto_retry_end': {
        const ended = parsed(PiRetryEnd, event);
        if (ended === null) return [];
        return ended.success
          ? this.#notice('info', `the model call succeeded on attempt ${ended.attempt}`)
          : this.#notice(
              'error',
              `the model call's retries ran out after attempt ${ended.attempt}${ended.finalError === undefined ? '' : `: ${ended.finalError}`}`,
            );
      }
      case 'summarization_retry_scheduled': {
        const retry = parsed(PiRetryScheduled, event);
        if (retry === null) return [];
        return this.#notice(
          'warning',
          `a summary's model call is retried (attempt ${retry.attempt} of ${retry.maxAttempts})${retry.errorMessage === undefined ? '' : `: ${retry.errorMessage}`}`,
        );
      }
      case 'compaction_end': {
        const ended = parsed(PiCompactionEnd, event);
        if (ended?.errorMessage === undefined) return [];
        return this.#notice('warning', `the compaction failed: ${ended.errorMessage}`);
      }
      default:
        return [];
    }
  }

  #fromMessageEnd(event: JsonObject): AgentItem[] {
    const read = parsed(PiMessageEnd, event);
    if (read === null) return [];
    const message = read.message;
    if (message.role === 'user') {
      this.#prompts += 1;
      return [
        {
          kind: 'user_text',
          itemId: `${this.#sessionKey}:prompt:${this.#prompts}`,
          turnId: null,
          text: piContentText(message.content),
          truncated: false,
        },
      ];
    }
    if (message.role !== 'assistant') return [];
    this.#messages += 1;
    if (message.stopReason === 'error') {
      this.#runFailure = message.errorMessage ?? 'the model call ended on an error';
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    const items: AgentItem[] = [];
    blocks.forEach((block, index) => {
      const itemId = `${this.#sessionKey}:message:${this.#messages}:${index}`;
      const read = block as Record<string, unknown>;
      if (read['type'] === 'text' && typeof read['text'] === 'string') {
        items.push({
          kind: 'agent_text',
          itemId,
          turnId: null,
          text: read['text'],
          final: null,
          truncated: false,
        });
      } else if (read['type'] === 'thinking') {
        items.push({
          kind: 'thinking',
          itemId,
          turnId: null,
          text: typeof read['thinking'] === 'string' ? read['thinking'] : '',
          summary: false,
          truncated: false,
        });
      } else if (
        read['type'] === 'toolCall' &&
        typeof read['id'] === 'string' &&
        typeof read['name'] === 'string'
      ) {
        const input = read['arguments'];
        items.push({
          kind: 'tool_call',
          itemId: read['id'],
          turnId: null,
          toolUseId: read['id'],
          toolName: read['name'],
          toolKind: piToolKind(read['name']),
          input: isRecord(input) ? (input as JsonObject) : null,
          truncated: false,
        });
      }
    });
    return items;
  }

  #fromToolEnd(event: JsonObject): AgentItem[] {
    const ended = parsed(PiToolEnd, event);
    if (ended === null || ended.parentToolCallId !== undefined) return [];
    const result = isRecord(ended.result) ? ended.result : {};
    return [
      {
        kind: 'tool_result',
        itemId: `${ended.toolCallId}:result`,
        turnId: null,
        toolUseId: ended.toolCallId,
        status: this.#blocked.has(ended.toolCallId) ? 'blocked' : ended.isError ? 'failed' : 'completed',
        output: piContentText(result['content']),
        exitCode: null,
        durationMs:
          ended.durationMs === undefined || !Number.isFinite(ended.durationMs) || ended.durationMs < 0
            ? null
            : Math.floor(ended.durationMs),
        changes: null,
        truncated: false,
      },
    ];
  }

  #fromRecord(record: JsonObject): AgentItem[] {
    const type = piTypeOf(record);
    if (type === 'extension_error') {
      const failed = parsed(PiExtensionError, record);
      if (failed === null) return [];
      return this.#notice(
        'error',
        `the extension ${failed.extensionPath ?? '(unnamed)'} failed on ${failed.event ?? 'an event'}: ${failed.error ?? 'no message'}`,
      );
    }
    if (type === 'extension_ui_request') {
      const asked = parsed(PiUiRequest, record);
      if (asked === null || asked.method !== 'notify' || asked.message === undefined) return [];
      const level =
        asked.notifyType !== undefined && Object.hasOwn(NOTIFY_LEVELS, asked.notifyType)
          ? (NOTIFY_LEVELS[asked.notifyType] ?? 'info')
          : 'info';
      return this.#notice(level, asked.message);
    }
    return [];
  }

  #notice(level: NoticeItem['level'], text: string): AgentItem[] {
    this.#notices += 1;
    return [
      {
        kind: 'notice',
        itemId: `${this.#sessionKey}:notice:${this.#notices}`,
        turnId: null,
        level,
        text,
        truncated: false,
      },
    ];
  }
}
