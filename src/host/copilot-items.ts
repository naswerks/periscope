/**
 * The Copilot fill: a Copilot session's conversation, read into the wire's items from its session events.
 *
 * What each item is read from:
 *   - `turn` started and ended: a run, from the first prompt the runtime takes (`user.message`) to
 *     `session.idle`. It ended interrupted when the runtime says the run was aborted, failed when a
 *     `session.error` ended it, completed otherwise. A run is named by the session's key and its count.
 *   - `user_text`: each prompt the runtime takes, as it took it.
 *   - `agent_text`: each `assistant.message` that carries text. The runtime marks no answer, so `final` is
 *     null.
 *   - `thinking`: each `assistant.reasoning`, the reasoning text as the runtime reports it.
 *   - `tool_call`: each `tool.execution_start`, the tool named as the gate spells it (an MCP tool as
 *     `mcp__{server}__{tool}`), its kind by `copilotToolKind`, its arguments.
 *   - `tool_result`: each `tool.execution_complete`: `blocked` when this host's gate refused the call,
 *     `failed` when the runtime says it did not succeed, `completed` otherwise, with its output, its shell's
 *     exit code and the files it changed as reported.
 *   - `notice`: an error that ends a run, a warning, and a model call that failed.
 * A sub-agent's items carry the call that spawned it (`parentId`), and are filled only where they are wanted
 * (`spawnedItems`, which the host composes from the link's protocol); an event of a sub-agent that names no
 * spawning call fills nothing. Every item's `turnId` is null.
 */
import type { AgentItem, FileChangeEntry, JsonObject, NoticeItem } from '../control/frames.js';
import { copilotToolKind } from '../gate/tool-kind.js';
import type { ItemFill } from '../sessions/item-fill.js';
import { copilotErrorWords } from '../state/copilot-observer.js';
import type { CopilotMessage } from './copilot-wire.js';
import {
  copilotCount,
  copilotData,
  copilotRecord,
  copilotSpawnedBy,
  copilotWord,
  isCopilotMainThread,
} from './copilot-wire.js';

/** The file change each edit kind the runtime names is; a kind it adds later fills no entry. */
const FILE_CHANGES: Readonly<Record<string, FileChangeEntry['change']>> = {
  create: 'add',
  edit: 'update',
  delete: 'delete',
};

export interface CopilotItemFillOptions {
  /** Whether a sub-agent's events fill items now; by default they do not. */
  readonly spawnedItems?: () => boolean;
  /** Spells a tool name as the decision requests carry it; by default the name as the runtime sent it. */
  readonly toolName?: (copilotName: string) => string;
}

export class CopilotItemFill implements ItemFill<CopilotMessage> {
  readonly #sessionKey: string;
  readonly #spawnedItems: () => boolean;
  readonly #toolName: (copilotName: string) => string;
  readonly #blocked = new Set<string>();
  #runs = 0;
  #notices = 0;
  #running = false;
  /** The error the run failed on, or null while it has none. */
  #runFailure: string | null = null;

  /** `sessionKey` is the periscope session's own key: what a run's and a notice's item ids are made from. */
  constructor(sessionKey: string, options: CopilotItemFillOptions = {}) {
    this.#sessionKey = sessionKey;
    this.#spawnedItems = options.spawnedItems ?? (() => false);
    this.#toolName = options.toolName ?? ((name) => name);
  }

  /** This host's gate refused the call `toolUseId`, so its result is `blocked`. */
  gateBlocked(toolUseId: string): void {
    this.#blocked.add(toolUseId);
  }

  fromMessage(message: CopilotMessage): readonly AgentItem[] {
    if (message.kind !== 'event') return [];
    const event = message.event;
    const main = isCopilotMainThread(event);
    const parentId = copilotSpawnedBy(event);
    if (!main && (parentId === null || !this.#spawnedItems())) return [];
    const parent = parentId === null ? {} : { parentId };
    const data = copilotData(event);
    const itemId = copilotWord(event.id);
    switch (event.type) {
      case 'user.message': {
        const items: AgentItem[] = [];
        if (main && !this.#running) {
          this.#running = true;
          this.#runFailure = null;
          this.#runs += 1;
          items.push({
            kind: 'turn',
            itemId: `${this.#sessionKey}:run:${this.#runs}`,
            turnId: null,
            status: 'started',
            detail: null,
            truncated: false,
          });
        }
        const text = copilotWord(data['content']);
        if (itemId !== null && text !== null) {
          items.push({ kind: 'user_text', itemId, turnId: null, ...parent, text, truncated: false });
        }
        return items;
      }
      case 'assistant.message': {
        const text = copilotWord(data['content']);
        if (itemId === null || text === null) return [];
        return [{ kind: 'agent_text', itemId, turnId: null, ...parent, text, final: null, truncated: false }];
      }
      case 'assistant.reasoning': {
        if (itemId === null) return [];
        const text = typeof data['content'] === 'string' ? data['content'] : '';
        return [
          { kind: 'thinking', itemId, turnId: null, ...parent, text, summary: false, truncated: false },
        ];
      }
      case 'tool.execution_start': {
        const id = copilotWord(data['toolCallId']);
        const name = copilotWord(data['toolName']);
        if (id === null || name === null) return [];
        const spelled = this.#toolName(name);
        const input = data['arguments'];
        return [
          {
            kind: 'tool_call',
            itemId: id,
            turnId: null,
            ...parent,
            toolUseId: id,
            toolName: spelled,
            toolKind: copilotToolKind(spelled),
            input:
              typeof input === 'object' && input !== null && !Array.isArray(input)
                ? (input as JsonObject)
                : null,
            truncated: false,
          },
        ];
      }
      case 'tool.execution_complete':
        return this.#fromToolEnd(data, parent);
      case 'session.error': {
        if (!main) return [];
        const words = copilotErrorWords(data);
        this.#runFailure = words;
        return this.#notice('error', words, parent);
      }
      case 'session.warning': {
        const words = copilotWord(data['message']);
        return words === null ? [] : this.#notice('warning', words, parent);
      }
      case 'model.call_failure': {
        const kind = copilotWord(data['errorType']) ?? copilotWord(data['failureKind']);
        const words = copilotWord(data['errorMessage']) ?? 'no message';
        return this.#notice(
          'warning',
          `a model call failed${kind === null ? '' : ` (${kind})`}: ${words}`,
          parent,
        );
      }
      case 'session.idle': {
        if (!main) return [];
        const failed = this.#runFailure;
        this.#runFailure = null;
        // A run that failed before the runtime took its prompt never started a turn: its error's notice is
        // all there is of it.
        if (!this.#running) return [];
        this.#running = false;
        const status: 'completed' | 'interrupted' | 'failed' =
          data['aborted'] === true ? 'interrupted' : failed !== null ? 'failed' : 'completed';
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
      default:
        return [];
    }
  }

  #fromToolEnd(data: Readonly<Record<string, unknown>>, parent: { readonly parentId?: string }): AgentItem[] {
    const id = copilotWord(data['toolCallId']);
    if (id === null) return [];
    const result = copilotRecord(data['result']);
    const error = copilotRecord(data['error']);
    const output = copilotWord(result['content']) ?? copilotWord(error['message']);
    const edits = Array.isArray(data['fileEdits']) ? data['fileEdits'] : null;
    const changes =
      edits === null
        ? null
        : edits
            .map((edit) => copilotRecord(edit))
            .flatMap((edit): FileChangeEntry[] => {
              const path = copilotWord(edit['path']);
              const kind = copilotWord(edit['kind']);
              const change =
                kind !== null && Object.hasOwn(FILE_CHANGES, kind) ? FILE_CHANGES[kind] : undefined;
              return path === null || change === undefined
                ? []
                : [{ path, change, movePath: null, diff: null }];
            });
    return [
      {
        kind: 'tool_result',
        itemId: `${id}:result`,
        turnId: null,
        ...parent,
        toolUseId: id,
        status: this.#blocked.has(id) ? 'blocked' : data['success'] === false ? 'failed' : 'completed',
        output,
        exitCode: copilotCount(copilotRecord(data['shellExecution'])['exitCode']),
        durationMs: null,
        changes,
        truncated: false,
      },
    ];
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
