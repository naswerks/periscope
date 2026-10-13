/**
 * The Claude fill: a Claude session's conversation, read into the wire's items from the SDK messages
 * this host already forwards, and from the one hook that reports the prompt.
 *
 * What each item is read from (the main thread only: a message a subagent's turn produced, with
 * `parent_tool_use_id` set, rides its native `agent_message` and fills no item, because an item has no
 * member naming the call that spawned it):
 *   - `turn` started and `user_text`: `UserPromptSubmit`, whose `prompt` is the prompt as the agent took
 *     it, at the moment its turn starts. A prompt sent while a turn runs is not marked started early.
 *   - `agent_text`: each assistant `text` block. Claude marks no text as a turn's answer, so `final` is
 *     null; the turn's answer is the last `agent_text` before the turn ends.
 *   - `thinking`: each `thinking` and `redacted_thinking` block, `summary` false; its text is empty when
 *     the agent keeps its reasoning to itself.
 *   - `tool_call`: each `tool_use` block, its kind by Claude's map (`claudeToolKind`).
 *   - `tool_result`: each `tool_result` block of a user message. `blocked` when this host's gate refused
 *     the call (`gateBlocked`), `declined` when the agent's own permission check refused it
 *     (`system/permission_denied`), `failed` when the result is an error, `completed` otherwise.
 *   - `turn` ended: each `result`, by its subtype and how the turn ended.
 *   - `notice`: each `system/compact_boundary`, and each `system/api_retry` (a retry the agent runs on
 *     its own).
 * Claude reports no turn id, so every item's `turnId` is null. An item id is the block's own id where
 * it has one (a tool use), a tool result is its call's id with `:result`, a block without one is its
 * message's id and index, and a prompt is the session's key with its count, so an id stays unique and
 * stable for the session whatever the agent's own session id does on a resume or a fork.
 *
 * Every message kind and every content block kind the SDK declares has a row below, filled or declined
 * with its reason: the coverage law, kept by the compiler.
 */
import type { AgentItem, JsonObject, NoticeItem, ToolResultStatus } from '../control/frames.js';
import { claudeToolKind } from '../gate/tool-kind.js';
import type { ItemFill } from '../sessions/item-fill.js';
import type { CoverageRow } from '../state/coverage.js';
import type {
  HookInput,
  HookJSONOutput,
  HookRegistrations,
  MessageDiscriminator,
  SDKMessage,
} from './agent-process.js';
import { discriminatorOf } from './agent-process.js';

type AssistantMessage = Extract<SDKMessage, { type: 'assistant' }>;
type UserMessage = Extract<SDKMessage, { type: 'user' }>;
type ResultMessage = Extract<SDKMessage, { type: 'result' }>;

/** Every content block kind an assistant message can carry, as the SDK's message type declares them. */
type AssistantBlockKind = AssistantMessage['message']['content'][number]['type'];

/** Every content block kind a user message can carry. */
type UserBlockKind = Exclude<UserMessage['message']['content'], string>[number]['type'];

/** No item: the message rides `agent_message` alone. */
const NATIVE_ONLY = 'no item: the message rides agent_message alone';

/** A server-side tool the Messages API runs itself; the agent CLI configures none of them. */
const SERVER_TOOL = 'no item: a server-side tool block, and the agent CLI configures no server-side tool';

/** Every message kind, filled or declined. */
export const CLAUDE_ITEM_COVERAGE = {
  'system/init': { handling: 'declined', note: `${NATIVE_ONLY}; the turn starts at UserPromptSubmit` },
  'system/status': {
    handling: 'declined',
    note: `${NATIVE_ONLY}; a status moves the state, not the conversation`,
  },
  'system/session_state_changed': {
    handling: 'declined',
    note: `${NATIVE_ONLY}; a state, not the conversation`,
  },
  'system/compact_boundary': {
    handling: 'wired',
    note: 'a notice (info): the context was compacted, with its trigger',
  },
  'system/task_started': { handling: 'declined', note: `${NATIVE_ONLY}; the tasks fact carries it` },
  'system/task_updated': { handling: 'declined', note: `${NATIVE_ONLY}; the tasks fact carries it` },
  'system/task_notification': {
    handling: 'declined',
    note: `${NATIVE_ONLY}; the tasks fact carries how it settled`,
  },
  'system/worker_shutting_down': { handling: 'declined', note: `${NATIVE_ONLY}; a process event` },
  'system/model_refusal_no_fallback': {
    handling: 'declined',
    note: `${NATIVE_ONLY}; the result that follows ends the turn`,
  },
  result: {
    handling: 'wired',
    note: 'a turn item: completed, interrupted or failed, by subtype and how the turn ended',
  },
  assistant: {
    handling: 'wired',
    note: 'its text, thinking and tool_use blocks, each an item, on the main thread only (CLAUDE_BLOCK_ITEMS)',
  },
  user: {
    handling: 'wired',
    note: 'its tool_result blocks, each a tool_result item, on the main thread only; the prompt rides UserPromptSubmit',
  },
  stream_event: { handling: 'declined', note: `${NATIVE_ONLY}; streaming text rides the fragments` },
  tool_progress: { handling: 'declined', note: `${NATIVE_ONLY}; progress of a call whose result follows` },
  tool_use_summary: {
    handling: 'declined',
    note: `${NATIVE_ONLY}; the calls it summarizes are items already`,
  },
  auth_status: { handling: 'declined', note: `${NATIVE_ONLY}; a sign-in state` },
  rate_limit_event: { handling: 'declined', note: `${NATIVE_ONLY}; a rate-limit state` },
  prompt_suggestion: { handling: 'declined', note: `${NATIVE_ONLY}; a suggestion nobody sent` },
  conversation_reset: { handling: 'declined', note: `${NATIVE_ONLY}; the next prompt starts a turn as ever` },
  'system/api_retry': {
    handling: 'wired',
    note: 'a notice (warning): a model call failed and the agent retries it',
  },
  'system/control_request_progress': {
    handling: 'declined',
    note: `${NATIVE_ONLY}; a control request's progress`,
  },
  'system/model_refusal_fallback': {
    handling: 'declined',
    note: `${NATIVE_ONLY}; the reply that follows is an item`,
  },
  'system/local_command_output': { handling: 'declined', note: `${NATIVE_ONLY}; a local command's output` },
  'system/hook_started': { handling: 'declined', note: `${NATIVE_ONLY}; a hook's run` },
  'system/hook_progress': { handling: 'declined', note: `${NATIVE_ONLY}; a hook's run` },
  'system/hook_response': { handling: 'declined', note: `${NATIVE_ONLY}; a hook's run` },
  'system/plugin_install': { handling: 'declined', note: `${NATIVE_ONLY}; the receipt carries the plugins` },
  'system/task_progress': { handling: 'declined', note: `${NATIVE_ONLY}; a task's progress` },
  'system/background_tasks_changed': {
    handling: 'declined',
    note: `${NATIVE_ONLY}; the tasks fact carries it`,
  },
  'system/thinking_tokens': { handling: 'declined', note: `${NATIVE_ONLY}; a count, not text` },
  'system/commands_changed': { handling: 'declined', note: `${NATIVE_ONLY}; the commands on offer` },
  'system/notification': {
    handling: 'declined',
    note: `${NATIVE_ONLY}; a notification for an interactive user`,
  },
  'system/files_persisted': { handling: 'declined', note: `${NATIVE_ONLY}; a storage event` },
  'system/memory_recall': { handling: 'declined', note: `${NATIVE_ONLY}; context the agent loaded` },
  'system/elicitation_complete': {
    handling: 'declined',
    note: `${NATIVE_ONLY}; the call it belonged to is an item`,
  },
  'system/permission_denied': {
    handling: 'wired',
    note: "no item of its own: the call it names ends in a tool_result declined, the agent's own permission check having refused it",
  },
  'system/mirror_error': { handling: 'declined', note: `${NATIVE_ONLY}; a transcript store event` },
  'system/informational': { handling: 'declined', note: `${NATIVE_ONLY}; a message for an interactive user` },
} as const satisfies Readonly<Record<MessageDiscriminator, CoverageRow>>;

/** Every content block kind an assistant message can carry, filled or declined. */
export const CLAUDE_BLOCK_ITEMS = {
  text: { handling: 'wired', note: 'an agent_text item, final null' },
  thinking: {
    handling: 'wired',
    note: 'a thinking item, summary false; empty when the agent keeps its reasoning',
  },
  redacted_thinking: { handling: 'wired', note: 'a thinking item, summary false, with no text' },
  tool_use: { handling: 'wired', note: "a tool_call item, its kind by Claude's map" },
  server_tool_use: { handling: 'declined', note: SERVER_TOOL },
  web_search_tool_result: { handling: 'declined', note: SERVER_TOOL },
  web_fetch_tool_result: { handling: 'declined', note: SERVER_TOOL },
  advisor_tool_result: { handling: 'declined', note: SERVER_TOOL },
  code_execution_tool_result: { handling: 'declined', note: SERVER_TOOL },
  bash_code_execution_tool_result: { handling: 'declined', note: SERVER_TOOL },
  text_editor_code_execution_tool_result: { handling: 'declined', note: SERVER_TOOL },
  tool_search_tool_result: { handling: 'declined', note: SERVER_TOOL },
  mcp_tool_use: {
    handling: 'declined',
    note: `${SERVER_TOOL}; the agent's own MCP calls are tool_use blocks`,
  },
  mcp_tool_result: { handling: 'declined', note: SERVER_TOOL },
  mcp_tool_listing: { handling: 'declined', note: SERVER_TOOL },
  container_upload: { handling: 'declined', note: SERVER_TOOL },
  compaction: {
    handling: 'declined',
    note: 'no item: the agent reports compaction as system/compact_boundary',
  },
  fallback: { handling: 'declined', note: 'no item: a placeholder for a block the API could not return' },
} as const satisfies Readonly<Record<AssistantBlockKind, CoverageRow>>;

/** Every content block kind a user message can carry, filled or declined. */
export const CLAUDE_USER_BLOCK_ITEMS = {
  tool_result: { handling: 'wired', note: 'a tool_result item: blocked, declined, failed or completed' },
  text: {
    handling: 'declined',
    note: 'no item: the prompt rides UserPromptSubmit, and other user text is the agent injecting context or replaying history',
  },
  image: { handling: 'declined', note: 'no item: an image the prompt carried' },
  document: { handling: 'declined', note: 'no item: a document the prompt carried' },
  search_result: { handling: 'declined', note: 'no item: a search result the prompt carried' },
  thinking: { handling: 'declined', note: 'no item: reasoning is an assistant block' },
  redacted_thinking: { handling: 'declined', note: 'no item: reasoning is an assistant block' },
  tool_use: { handling: 'declined', note: 'no item: a tool call is an assistant block' },
  server_tool_use: { handling: 'declined', note: SERVER_TOOL },
  web_search_tool_result: { handling: 'declined', note: SERVER_TOOL },
  web_fetch_tool_result: { handling: 'declined', note: SERVER_TOOL },
  code_execution_tool_result: { handling: 'declined', note: SERVER_TOOL },
  bash_code_execution_tool_result: { handling: 'declined', note: SERVER_TOOL },
  text_editor_code_execution_tool_result: { handling: 'declined', note: SERVER_TOOL },
  tool_search_tool_result: { handling: 'declined', note: SERVER_TOOL },
  container_upload: { handling: 'declined', note: SERVER_TOOL },
} as const satisfies Readonly<Record<UserBlockKind, CoverageRow>>;

/** The turn-ending reasons that mean the turn was stopped, not that it finished. */
const INTERRUPTED_REASONS: readonly string[] = ['aborted_streaming', 'aborted_tools'];

export class ClaudeItemFill implements ItemFill<SDKMessage> {
  readonly #sessionKey: string;
  #prompts = 0;
  #push: ((item: AgentItem) => void) | null = null;
  /** Calls this host's gate refused, by tool use id. */
  readonly #blocked = new Set<string>();
  /** Calls the agent's own permission check refused, by tool use id. */
  readonly #declined = new Set<string>();

  /** `sessionKey` is the periscope session's own key: what a prompt's item id is made from. */
  constructor(sessionKey: string) {
    this.#sessionKey = sessionKey;
  }

  attach(push: (item: AgentItem) => void): void {
    this.#push = push;
  }

  /** This host's gate refused the call `toolUseId`, so its result is `blocked`. */
  gateBlocked(toolUseId: string): void {
    this.#blocked.add(toolUseId);
  }

  /** The hook that reports each prompt the agent takes. Never throws, never decides. */
  hooks(onFailure?: (error: unknown) => void): HookRegistrations {
    const handler = (input: HookInput): Promise<HookJSONOutput> => {
      try {
        if (input.hook_event_name === 'UserPromptSubmit') this.#prompted(input.prompt);
      } catch (error) {
        try {
          onFailure?.(error);
        } catch {
          // Nothing further can be reported; the handler still answers.
        }
      }
      return Promise.resolve({});
    };
    return { UserPromptSubmit: [{ hooks: [handler] }] };
  }

  #prompted(prompt: string): void {
    this.#prompts += 1;
    const itemId = `${this.#sessionKey}:prompt:${this.#prompts}`;
    this.#push?.({
      kind: 'turn',
      itemId: `${itemId}:turn`,
      turnId: null,
      status: 'started',
      detail: null,
      truncated: false,
    });
    this.#push?.({ kind: 'user_text', itemId, turnId: null, text: prompt, truncated: false });
  }

  fromMessage(message: SDKMessage): readonly AgentItem[] {
    switch (discriminatorOf(message)) {
      case 'assistant':
        return this.#fromAssistant(message as AssistantMessage);
      case 'user':
        return this.#fromUser(message as UserMessage);
      case 'result':
        return [turnEnded(message as ResultMessage)];
      case 'system/compact_boundary':
        return [compacted(message)];
      case 'system/api_retry':
        return [retried(message)];
      case 'system/permission_denied': {
        const id = (message as { tool_use_id?: unknown }).tool_use_id;
        if (typeof id === 'string' && id !== '') this.#declined.add(id);
        return [];
      }
      default:
        return [];
    }
  }

  #fromAssistant(message: AssistantMessage): AgentItem[] {
    if (onSubagent(message.parent_tool_use_id)) return [];
    const items: AgentItem[] = [];
    for (const [index, block] of message.message.content.entries()) {
      const itemId = `${message.uuid}:${index}`;
      if (block.type === 'text') {
        items.push({
          kind: 'agent_text',
          itemId,
          turnId: null,
          text: block.text,
          final: null,
          truncated: false,
        });
      } else if (block.type === 'thinking') {
        items.push({
          kind: 'thinking',
          itemId,
          turnId: null,
          text: block.thinking,
          summary: false,
          truncated: false,
        });
      } else if (block.type === 'redacted_thinking') {
        items.push({ kind: 'thinking', itemId, turnId: null, text: '', summary: false, truncated: false });
      } else if (block.type === 'tool_use') {
        items.push({
          kind: 'tool_call',
          itemId: block.id,
          turnId: null,
          toolUseId: block.id,
          toolName: block.name,
          toolKind: claudeToolKind(block.name),
          input: isObject(block.input) ? (block.input as JsonObject) : null,
          truncated: false,
        });
      }
    }
    return items;
  }

  #fromUser(message: UserMessage): AgentItem[] {
    if (onSubagent(message.parent_tool_use_id)) return [];
    if ((message as { isReplay?: unknown }).isReplay === true) return [];
    const content = message.message.content;
    if (typeof content === 'string') return [];
    const items: AgentItem[] = [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const toolUseId = block.tool_use_id;
      items.push({
        kind: 'tool_result',
        itemId: `${toolUseId}:result`,
        turnId: null,
        toolUseId,
        status: this.#statusOf(toolUseId, block.is_error === true),
        output: outputOf(block.content),
        exitCode: null,
        durationMs: null,
        changes: null,
        truncated: false,
      });
    }
    return items;
  }

  #statusOf(toolUseId: string, isError: boolean): ToolResultStatus {
    if (this.#blocked.has(toolUseId)) return 'blocked';
    if (this.#declined.has(toolUseId)) return 'declined';
    return isError ? 'failed' : 'completed';
  }
}

/** Whether a message belongs to a subagent's turn rather than the main thread. */
function onSubagent(parent: string | null | undefined): boolean {
  return typeof parent === 'string' && parent !== '';
}

/** The text a tool result reported: a string as it is, or its text blocks joined; null when none. */
function outputOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = (content as readonly { type?: unknown; text?: unknown }[])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string);
  return texts.length === 0 ? null : texts.join('\n');
}

/** A turn ended: by its subtype, the error flag the result carries, and how the agent says it ended. */
function turnEnded(message: ResultMessage): AgentItem {
  const raw = message as {
    uuid?: unknown;
    is_error?: unknown;
    terminal_reason?: unknown;
    errors?: unknown;
    result?: unknown;
  };
  const reason = typeof raw.terminal_reason === 'string' ? raw.terminal_reason : null;
  const errors = Array.isArray(raw.errors)
    ? raw.errors.filter((error): error is string => typeof error === 'string' && error !== '')
    : [];
  let status: 'completed' | 'interrupted' | 'failed' = 'completed';
  let detail: string | null = null;
  if (message.subtype !== 'success') {
    status = 'failed';
    detail = errors.length > 0 ? `${message.subtype}: ${errors.join('; ')}` : message.subtype;
  } else if (reason !== null && INTERRUPTED_REASONS.includes(reason)) {
    status = 'interrupted';
    detail = reason;
  } else if (raw.is_error === true) {
    status = 'failed';
    detail = typeof raw.result === 'string' && raw.result !== '' ? raw.result : reason;
  }
  return {
    kind: 'turn',
    itemId: typeof raw.uuid === 'string' ? raw.uuid : `${message.session_id}:result`,
    turnId: null,
    status,
    detail,
    truncated: false,
  };
}

/** A compaction the agent reports, with its trigger. */
function compacted(message: SDKMessage): NoticeItem {
  const raw = message as { uuid?: unknown; compact_metadata?: { trigger?: unknown } };
  const trigger = typeof raw.compact_metadata?.trigger === 'string' ? raw.compact_metadata.trigger : null;
  return {
    kind: 'notice',
    itemId: typeof raw.uuid === 'string' ? raw.uuid : 'compact_boundary',
    turnId: null,
    level: 'info',
    text: trigger === null ? 'the context was compacted' : `the context was compacted (${trigger})`,
    truncated: false,
  };
}

/** A model call that failed and that the agent retries on its own. */
function retried(message: SDKMessage): NoticeItem {
  const raw = message as {
    uuid?: unknown;
    attempt?: unknown;
    max_retries?: unknown;
    error_status?: unknown;
    error?: unknown;
  };
  const status = typeof raw.error_status === 'number' ? ` (status ${raw.error_status})` : '';
  const error = typeof raw.error === 'string' ? `: ${raw.error}` : '';
  const attempt =
    typeof raw.attempt === 'number' && typeof raw.max_retries === 'number'
      ? `; retry ${raw.attempt} of ${raw.max_retries}`
      : '';
  return {
    kind: 'notice',
    itemId: typeof raw.uuid === 'string' ? raw.uuid : 'api_retry',
    turnId: null,
    level: 'warning',
    text: `a model call failed${status}${error}${attempt}`,
    truncated: false,
  };
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
