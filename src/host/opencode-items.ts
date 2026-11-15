/**
 * The opencode fill: an opencode session's conversation, read into the wire's items from the server's stream.
 *
 * What each item is read from:
 *   - `turn` started and ended: a run of the session's own, from `session.execution.started` to its end. It
 *     ended interrupted when the run was interrupted, failed when it failed, completed otherwise. A run is
 *     named by the session's key and its count.
 *   - `user_text`: each prompt as the server queued it (`session.inbox.enqueued`, a user's).
 *   - `agent_text`: each finished text part (`session.text.ended`). The server marks no answer, so `final` is
 *     null.
 *   - `thinking`: each finished reasoning part (`session.reasoning.ended`).
 *   - `tool_call`: each call the server announces (`session.tool.called`), the tool named as the gate spells
 *     it (an MCP tool as `mcp__{server}__{tool}`), its kind by `opencodeToolKind`, its input.
 *   - `tool_result`: each call's end (`session.tool.success`, `session.tool.failed`): `blocked` when this host's
 *     gate refused the call, `failed` when the server says it failed, `completed` otherwise, with its text.
 *   - `notice`: a run's failure, a model call that failed, and a model call retried.
 * A subagent's items carry the call that started its session (`parentId`), and are filled only where they are
 * wanted (`spawnedItems`, which the host composes from the link's protocol); an event of a subagent's session
 * whose starting call is not known fills nothing. Every item's `turnId` is null.
 */
import type { AgentItem, JsonObject, NoticeItem } from '../control/frames.js';
import { opencodeToolKind } from '../gate/tool-kind.js';
import type { ItemFill } from '../sessions/item-fill.js';
import type { OpencodeMessage } from './opencode-wire.js';
import { opencodeData, opencodeErrorWords, opencodeRecord, opencodeWord } from './opencode-wire.js';

export interface OpencodeItemFillOptions {
  /** Whether a subagent's events fill items now; by default they do not. */
  readonly spawnedItems?: () => boolean;
  /** Spells a tool name as the decision requests carry it; by default the name as the server sent it. */
  readonly toolName?: (name: string) => string;
}

/** A tool result's text: its text parts, joined, or null when it has none. */
function contentText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const texts = value
    .map((part) => opencodeRecord(part))
    .filter((part) => part['type'] === 'text' && typeof part['text'] === 'string')
    .map((part) => part['text'] as string);
  return texts.length === 0 ? null : texts.join('\n');
}

/** What a call is kept under: its session and its id together. */
function callKey(session: string, id: string): string {
  return `${session}\u0000${id}`;
}

export class OpencodeItemFill implements ItemFill<OpencodeMessage> {
  readonly #sessionKey: string;
  readonly #spawnedItems: () => boolean;
  readonly #toolName: (name: string) => string;
  /**
   * The calls this host's gate refused, and each call's tool name from its input's start. Both are kept by
   * the call's session and its id together, since one server runs a session and its subagents and a provider
   * may hand two of them the same id, and both are forgotten when the call ends, whether or not its items
   * are filled.
   */
  readonly #blocked = new Set<string>();
  readonly #names = new Map<string, string>();
  #runs = 0;
  #notices = 0;
  #running = false;

  /** `sessionKey` is the periscope session's own key: what a run's and a notice's item ids are made from. */
  constructor(sessionKey: string, options: OpencodeItemFillOptions = {}) {
    this.#sessionKey = sessionKey;
    this.#spawnedItems = options.spawnedItems ?? (() => false);
    this.#toolName = options.toolName ?? ((name) => name);
  }

  /**
   * This host's gate refused the call `toolUseId`, so its result is `blocked`. `session` is the subagent's
   * session the call ran in; null, or absent, for the session's own.
   */
  gateBlocked(toolUseId: string, session: string | null = null): void {
    this.#blocked.add(callKey(session ?? '', toolUseId));
  }

  fromMessage(message: OpencodeMessage): readonly AgentItem[] {
    if (message.kind !== 'event') return [];
    const event = message.event;
    const data = opencodeData(event);
    // The session a call is kept under: the session's own as the empty name, a subagent's by its id.
    const scope = message.main ? '' : (message.session ?? '');
    if (event.type === 'session.tool.input.started') {
      const id = opencodeWord(data['id']);
      const name = opencodeWord(data['name']);
      if (id !== null && name !== null) this.#names.set(callKey(scope, id), name);
      return [];
    }
    // A call that has ended is forgotten here, before anything decides whether its items are filled.
    const ended = event.type === 'session.tool.success' || event.type === 'session.tool.failed';
    const endedKey = ended ? callKey(scope, opencodeWord(data['id']) ?? '') : null;
    const wasBlocked = endedKey !== null && this.#blocked.has(endedKey);
    if (endedKey !== null) {
      this.#blocked.delete(endedKey);
      this.#names.delete(endedKey);
    }
    if (!message.main && (message.spawnedBy === null || !this.#spawnedItems())) return [];
    if (message.session === null) return [];
    const parent = message.main || message.spawnedBy === null ? {} : { parentId: message.spawnedBy };
    const eventId = opencodeWord(event.id);
    switch (event.type) {
      case 'session.execution.started': {
        if (!message.main || this.#running) return [];
        this.#running = true;
        this.#runs += 1;
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
      }
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted': {
        if (!message.main) return [];
        const items: AgentItem[] = [];
        const words = event.type === 'session.execution.failed' ? opencodeErrorWords(data['error']) : null;
        if (words !== null) items.push(...this.#notice('error', words, parent));
        if (!this.#running) return items;
        this.#running = false;
        const status =
          event.type === 'session.execution.succeeded'
            ? ('completed' as const)
            : event.type === 'session.execution.failed'
              ? ('failed' as const)
              : ('interrupted' as const);
        items.push({
          kind: 'turn',
          itemId: `${this.#sessionKey}:run:${this.#runs}:end`,
          turnId: null,
          status,
          detail: status === 'failed' ? words : status === 'interrupted' ? 'the run was interrupted' : null,
          truncated: false,
        });
        return items;
      }
      case 'session.inbox.enqueued': {
        const item = opencodeRecord(data['item']);
        const text = opencodeWord(opencodeRecord(item['payload'])['text']);
        const inboxId = opencodeWord(data['inboxID']) ?? eventId;
        if (item['type'] !== 'user' || text === null || inboxId === null) return [];
        return [{ kind: 'user_text', itemId: inboxId, turnId: null, ...parent, text, truncated: false }];
      }
      case 'session.text.ended': {
        const text = opencodeWord(data['text']);
        if (eventId === null || text === null) return [];
        return [
          {
            kind: 'agent_text',
            itemId: eventId,
            turnId: null,
            ...parent,
            text,
            final: null,
            truncated: false,
          },
        ];
      }
      case 'session.reasoning.ended': {
        if (eventId === null) return [];
        const text = typeof data['text'] === 'string' ? data['text'] : '';
        return [
          {
            kind: 'thinking',
            itemId: eventId,
            turnId: null,
            ...parent,
            text,
            summary: false,
            truncated: false,
          },
        ];
      }
      case 'session.tool.called': {
        const id = opencodeWord(data['id']);
        if (id === null) return [];
        const name = this.#names.get(callKey(scope, id)) ?? 'tool';
        const spelled = this.#toolName(name);
        const input = data['input'];
        return [
          {
            kind: 'tool_call',
            itemId: id,
            turnId: null,
            ...parent,
            toolUseId: id,
            toolName: spelled,
            toolKind: opencodeToolKind(spelled),
            input:
              typeof input === 'object' && input !== null && !Array.isArray(input)
                ? (input as JsonObject)
                : null,
            truncated: false,
          },
        ];
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = opencodeWord(data['id']);
        if (id === null) return [];
        const failed = event.type === 'session.tool.failed';
        const output = contentText(data['content']) ?? (failed ? opencodeErrorWords(data['error']) : null);
        return [
          {
            kind: 'tool_result',
            itemId: `${id}:result`,
            turnId: null,
            ...parent,
            toolUseId: id,
            status: wasBlocked ? 'blocked' : failed ? 'failed' : 'completed',
            output,
            exitCode: null,
            durationMs: null,
            changes: null,
            truncated: false,
          },
        ];
      }
      case 'session.step.failed':
        return this.#notice('warning', `a model call failed: ${opencodeErrorWords(data['error'])}`, parent);
      case 'session.retry.scheduled':
        return this.#notice(
          'warning',
          `a model call is retried: ${opencodeErrorWords(data['error'])}`,
          parent,
        );
      default:
        return [];
    }
  }

  #notice(level: NoticeItem['level'], text: string, parent: { readonly parentId?: string }): AgentItem[] {
    this.#notices += 1;
    return [
      {
        kind: 'notice',
        itemId: `${this.#sessionKey}:notice:${this.#notices}`,
        turnId: null,
        ...parent,
        level,
        text,
        truncated: false,
      },
    ];
  }
}
