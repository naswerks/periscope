/**
 * The Codex fill: a Codex session's conversation, read into the wire's items from the notifications its
 * app-server sends. The session's own thread fills items with no parent. A sub-agent runs on a thread of
 * its own, named by the `collabAgentToolCall` that spawned it (`receiverThreadIds`): when the fill is told
 * a sub-agent's items are wanted (`spawnedItems`, which the host composes from the link's protocol), that
 * thread's turns and items fill too, each naming the spawning call's item id as its `parentId`, so they
 * stay apart from the session's own; a sub-agent's own spawn names its child in the same way. A thread no
 * call is known to have spawned fills nothing, and with `spawnedItems` off no sub-agent's thread fills
 * anything: its turns and items ride their native messages alone.
 *
 * What each item is read from:
 *   - `turn`: `turn/started` (started) and `turn/completed` (completed, interrupted or failed, its
 *     error in `detail`); a turn completed in any other status fills none.
 *   - `user_text`, `agent_text`, `thinking`, `plan`: the completed `userMessage`, `agentMessage`,
 *     `reasoning` and `plan` items, and each `turn/plan/updated`. An agent message's `final` is read
 *     from its message stage: `final_answer` is the turn's answer, `commentary` and `partial_answer`
 *     are interim, and no stage, or a word this host does not know, says nothing (null). The turn's
 *     answer is the last `agent_text` with `final` true, else the last with `final` null: a consumer's
 *     reading, never this host's. A reasoning item's summary and its text are two items.
 *   - `tool_call` and `tool_result`: the tool items' start and completion, the call keyed by the
 *     item's id, which is the id Codex's hook and its approval requests name. A tool item that
 *     completes unseen at its start fills both at once.
 *   - `notice`: sub-agent activity, a compaction, context a hook added, and the `error`, `warning`,
 *     `configWarning`, `guardianWarning` and `deprecationNotice` notifications.
 * An item's id is Codex's own item id; an item read from the same source as another takes a suffix
 * (`:result`, `:raw`), and one with no native id is named for its turn and a count.
 */
import type {
  AgentItem,
  FileChangeEntry,
  FileChangeKind,
  JsonObject,
  NoticeItem,
  ToolResultStatus,
  TurnItemStatus,
} from '../control/frames.js';
import { FILE_CHANGE_KINDS } from '../control/frames.js';
import { codexItemToolName, codexToolKind } from '../gate/tool-kind.js';
import type { ItemFill } from '../sessions/item-fill.js';
import type { CODEX_ITEM_COVERAGE } from '../state/codex-coverage.js';
import type { CodexMessage } from './codex-wire.js';
import { ThreadOpenResponse, agentMessageStage, codexStartedThreads, parsed } from './codex-wire.js';

type Fields = Readonly<Record<string, unknown>>;

/** The item kinds each Codex item kind fills; a declined kind fills none. */
export const CODEX_ITEM_FILLS = {
  userMessage: ['user_text'],
  hookPrompt: ['notice'],
  agentMessage: ['agent_text'],
  functionCallOutput: [],
  plan: ['plan'],
  reasoning: ['thinking'],
  commandExecution: ['tool_call', 'tool_result'],
  fileChange: ['tool_call', 'tool_result'],
  mcpToolCall: ['tool_call', 'tool_result'],
  dynamicToolCall: [],
  collabAgentToolCall: ['tool_call', 'tool_result'],
  subAgentActivity: ['notice'],
  webSearch: ['tool_call', 'tool_result'],
  imageView: ['tool_call', 'tool_result'],
  sleep: [],
  imageGeneration: ['tool_call', 'tool_result'],
  enteredReviewMode: [],
  exitedReviewMode: [],
  contextCompaction: ['notice'],
} as const satisfies Readonly<Record<keyof typeof CODEX_ITEM_COVERAGE, readonly AgentItem['kind'][]>>;

/** Notifications that are the process's own: they name no thread. */
const PROCESS_NOTICES: ReadonlySet<string> = new Set(['configWarning', 'deprecationNotice']);

/** Notifications that are the process's own when they name no thread, and a thread's when they name one. */
const THREADLESS_NOTICES: ReadonlySet<string> = new Set(['warning', 'guardianWarning']);

/**
 * How many threads, and how many notifications each, are held while no spawn names them. A sub-agent's
 * thread can speak before the call that spawned it reports it; past the bound, a thread's later
 * notifications fill nothing and ride their native messages alone.
 */
const MAX_HELD_THREADS = 16;
const MAX_HELD_PER_THREAD = 64;

/** The message stages Codex marks an agent message with, and what each says of the turn's answer. */
const STAGE_FINAL: Readonly<Record<string, boolean>> = {
  final_answer: true,
  commentary: false,
  partial_answer: false,
};

/** A turn's end status, as an item states it. Any other word fills no item. */
const TURN_END: Readonly<Record<string, TurnItemStatus>> = {
  completed: 'completed',
  interrupted: 'interrupted',
  failed: 'failed',
};

/** How a tool item ended, as a result states it. `inProgress`, or a word this host does not know, fills none. */
const TOOL_END: Readonly<Record<string, ToolResultStatus>> = {
  completed: 'completed',
  failed: 'failed',
  declined: 'declined',
  // A collaboration call that was interrupted did not finish.
  interrupted: 'failed',
};

const record = (value: unknown): Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : {};

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A table's own entry for `key`, or undefined: a word like `constructor` is never read off the prototype. */
function entryOf<T>(table: Readonly<Record<string, T>>, key: string | null): T | undefined {
  return key !== null && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** A whole number as a count, or null: the codec holds both counts to integers. */
const integerOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;

/** The error a turn or an error notification carries, in words: its message, its class, its details. */
function errorText(error: Fields): string {
  const parts = [textOrNull(error['message']) ?? 'no message'];
  const info = error['codexErrorInfo'];
  if (typeof info === 'string') parts.push(`(${info})`);
  else if (info !== null && info !== undefined) parts.push(`(${JSON.stringify(info)})`);
  const details = textOrNull(error['additionalDetails']);
  if (details !== null && details !== '') parts.push(`- ${details}`);
  return parts.join(' ');
}

export interface CodexItemFillOptions {
  /**
   * Whether a sub-agent's thread fills items now, read as each is composed. Absent, it does not: a
   * sub-agent's turns ride their native messages alone.
   */
  readonly spawnedItems?: () => boolean;
}

export class CodexItemFill implements ItemFill<CodexMessage> {
  readonly #spawnedItems: () => boolean;
  /** The session's own thread, from the answer that opened it. */
  #thread: string | null = null;
  /** A sub-agent's thread, mapped to the item id of the call that spawned it. */
  readonly #spawnedBy = new Map<string, string>();
  /** Notifications from threads no spawn has named yet, by thread, while a sub-agent's items are wanted. */
  readonly #held = new Map<string, { readonly method: string; readonly params: Fields }[]>();
  /** The tool items whose call this fill has stated. */
  readonly #called = new Set<string>();
  /** How many items with no native id each source has filled, for their names. */
  readonly #counts = new Map<string, number>();
  /** Calls this host's gate refused, by item id, which is the hook's call id. */
  readonly #blocked = new Set<string>();

  constructor(options: CodexItemFillOptions = {}) {
    this.#spawnedItems = options.spawnedItems ?? (() => false);
  }

  /** This host's gate refused the call `toolUseId`, so its result is `blocked`, whatever Codex reports. */
  gateBlocked(toolUseId: string): void {
    this.#blocked.add(toolUseId);
  }

  fromMessage(message: CodexMessage): readonly AgentItem[] {
    if (message.kind === 'answer') {
      if (
        message.method === 'thread/start' ||
        message.method === 'thread/resume' ||
        message.method === 'thread/fork'
      ) {
        const opened = parsed(ThreadOpenResponse, message.result);
        if (opened !== null) this.#thread = opened.thread.id;
      }
      return [];
    }
    if (message.kind !== 'notification') return [];
    return this.#fromNotification(message.method, message.params as Fields);
  }

  /** The items one notification fills, then those of every thread it names a spawn for. */
  #fromNotification(method: string, params: Fields): AgentItem[] {
    const named = this.#learn(params);
    const items = this.#placed(method, params);
    return named.length === 0 ? items : [...items, ...this.#release(named)];
  }

  /**
   * The items `method` fills, placed by its thread: the session's own thread fills them with no parent,
   * a sub-agent's thread whose spawn is known fills them naming it, and one whose spawn is not yet known
   * is held until a spawn names it. A notification naming no thread is the process's own.
   */
  #placed(method: string, params: Fields): AgentItem[] {
    const thread = params['threadId'];
    if (
      PROCESS_NOTICES.has(method) ||
      ((thread === null || thread === undefined) && THREADLESS_NOTICES.has(method))
    ) {
      return this.#compose(method, params, this.#thread ?? 'thread');
    }
    if (this.#thread === null || typeof thread !== 'string') return [];
    if (thread === this.#thread) {
      // A sub-agent no spawn has named by the time the session's own turn ends is never named.
      if (method === 'turn/completed') this.#held.clear();
      return this.#compose(method, params, thread);
    }
    if (!this.#spawnedItems()) return [];
    const parent = this.#spawnedBy.get(thread);
    if (parent === undefined) {
      this.#hold(thread, method, params);
      return [];
    }
    return this.#compose(method, params, thread).map((item) => ({ ...item, parentId: parent }));
  }

  #compose(method: string, params: Fields, anchor: string): AgentItem[] {
    switch (method) {
      case 'turn/started':
        return this.#turnStarted(params);
      case 'turn/completed':
        return this.#turnCompleted(params);
      case 'item/started':
        return this.#itemStarted(params);
      case 'item/completed':
        return this.#itemCompleted(params);
      case 'turn/plan/updated':
        return this.#planUpdated(params, anchor);
      case 'error':
        return this.#errorNotice(params, anchor);
      case 'warning':
      case 'guardianWarning':
        return this.#warning(method, params, anchor);
      case 'configWarning':
      case 'deprecationNotice':
        return this.#summaryNotice(method, params);
      default:
        return [];
    }
  }

  /**
   * The threads an item on a thread this fill follows says a call started, named for the first time, each
   * mapped to that call's item id (`codexStartedThreads`). The first call that names a thread stands; a
   * later call about the same agent never moves it.
   */
  #learn(params: Fields): string[] {
    const thread = params['threadId'];
    if (this.#thread === null || typeof thread !== 'string') return [];
    if (thread !== this.#thread && !this.#spawnedBy.has(thread)) return [];
    const item = record(params['item']);
    const id = textOrNull(item['id']);
    if (id === null) return [];
    const fresh = codexStartedThreads(item).filter(
      (agent) => agent !== this.#thread && !this.#spawnedBy.has(agent),
    );
    for (const agent of fresh) this.#spawnedBy.set(agent, id);
    return fresh;
  }

  /** Keep a notification from a thread no spawn has named yet, within the bounds. */
  #hold(thread: string, method: string, params: Fields): void {
    const held = this.#held.get(thread);
    if (held !== undefined) {
      if (held.length < MAX_HELD_PER_THREAD) held.push({ method, params });
      return;
    }
    if (this.#held.size < MAX_HELD_THREADS) this.#held.set(thread, [{ method, params }]);
  }

  /** The items the notifications held for each newly named thread fill, in the order they arrived. */
  #release(threads: readonly string[]): AgentItem[] {
    const items: AgentItem[] = [];
    for (const thread of threads) {
      const held = this.#held.get(thread) ?? [];
      this.#held.delete(thread);
      for (const { method, params } of held) items.push(...this.#fromNotification(method, params));
    }
    return items;
  }

  /** A name for an item with no native id: its anchor, its source and the source's count. */
  #named(anchor: string, source: string): string {
    const key = `${anchor}:${source}`;
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    return `${key}:${count}`;
  }

  #turnStarted(params: Fields): AgentItem[] {
    const id = textOrNull(record(params['turn'])['id']);
    if (id === null) return [];
    return [
      {
        kind: 'turn',
        itemId: `${id}:started`,
        turnId: id,
        status: 'started',
        detail: null,
        truncated: false,
      },
    ];
  }

  #turnCompleted(params: Fields): AgentItem[] {
    const turn = record(params['turn']);
    const id = textOrNull(turn['id']);
    const status = entryOf(TURN_END, textOrNull(turn['status']));
    if (id === null || status === undefined) return [];
    const error = turn['error'];
    return [
      {
        kind: 'turn',
        itemId: `${id}:completed`,
        turnId: id,
        status,
        detail: typeof error === 'object' && error !== null ? errorText(record(error)) : null,
        truncated: false,
      },
    ];
  }

  #itemStarted(params: Fields): AgentItem[] {
    const item = record(params['item']);
    const call = this.#call(item, textOrNull(params['turnId']));
    return call === null ? [] : [call];
  }

  #itemCompleted(params: Fields): AgentItem[] {
    const item = record(params['item']);
    const id = textOrNull(item['id']);
    if (id === null) return [];
    const turnId = textOrNull(params['turnId']);
    switch (item['type']) {
      case 'userMessage': {
        const content = Array.isArray(item['content']) ? (item['content'] as unknown[]) : [];
        const text = content
          .map(record)
          .filter((part) => part['type'] === 'text' && typeof part['text'] === 'string')
          .map((part) => part['text'] as string)
          .join('\n');
        return [{ kind: 'user_text', itemId: id, turnId, text, truncated: false }];
      }
      case 'agentMessage': {
        const stage = agentMessageStage(item as JsonObject);
        const final = entryOf(STAGE_FINAL, stage) ?? null;
        return [
          {
            kind: 'agent_text',
            itemId: id,
            turnId,
            text: textOrNull(item['text']) ?? '',
            final,
            truncated: false,
          },
        ];
      }
      case 'reasoning':
        return reasoningItems(id, turnId, item);
      case 'plan':
        return [{ kind: 'plan', itemId: id, turnId, text: textOrNull(item['text']) ?? '', truncated: false }];
      case 'subAgentActivity': {
        const kind = textOrNull(item['kind']) ?? 'reported';
        const agent = textOrNull(item['agentThreadId']) ?? 'a sub-agent';
        return [notice(id, turnId, 'info', `sub-agent ${agent} ${kind}`)];
      }
      case 'contextCompaction':
        return [notice(id, turnId, 'info', 'the context was compacted')];
      case 'hookPrompt': {
        const fragments = Array.isArray(item['fragments']) ? (item['fragments'] as unknown[]) : [];
        const text = fragments
          .map((fragment) => textOrNull(record(fragment)['text']))
          .filter((one): one is string => one !== null)
          .join('\n');
        return [notice(id, turnId, 'info', text)];
      }
      default: {
        // A tool item completing unseen at its start states its call first; a status that is no end
        // (or a word this host does not know) fills no result.
        const call = this.#call(item, turnId);
        const result = this.#result(item, turnId);
        return [call, result].filter((one): one is AgentItem => one !== null);
      }
    }
  }

  /** The call a tool item states, once; null for an item that is no tool call, or one already stated. */
  #call(item: Fields, turnId: string | null): AgentItem | null {
    const id = textOrNull(item['id']);
    const toolName = codexItemToolName(item);
    if (id === null || toolName === null || this.#called.has(id)) return null;
    this.#called.add(id);
    return {
      kind: 'tool_call',
      itemId: id,
      turnId,
      toolUseId: id,
      toolName,
      toolKind: codexToolKind(toolName),
      input: callInput(item),
      truncated: false,
    };
  }

  /** How a tool item ended, as its completion reports it; null for an item that is no tool call. */
  #result(item: Fields, turnId: string | null): AgentItem | null {
    const id = textOrNull(item['id']);
    if (id === null || codexItemToolName(item) === null) return null;
    const ended = (
      status: ToolResultStatus | undefined,
      output: string | null,
      changes: FileChangeEntry[] | null = null,
      truncated = false,
    ): AgentItem | null =>
      status === undefined
        ? null
        : {
            kind: 'tool_result',
            itemId: `${id}:result`,
            turnId,
            toolUseId: id,
            // A call this host's gate refused ended because of that, however Codex words its end.
            status: this.#blocked.has(id) ? 'blocked' : status,
            output,
            exitCode: item['type'] === 'commandExecution' ? integerOrNull(item['exitCode']) : null,
            durationMs: integerOrNull(item['durationMs']),
            changes,
            truncated,
          };
    const status = entryOf(TOOL_END, textOrNull(item['status']));
    switch (item['type']) {
      case 'commandExecution':
        return ended(status, textOrNull(item['aggregatedOutput']));
      case 'fileChange': {
        const listed = Array.isArray(item['changes']) ? (item['changes'] as unknown[]) : [];
        const changes = listed.map((entry) => fileChange(record(entry)));
        const known = changes.filter((entry): entry is FileChangeEntry => entry !== null);
        return ended(status, null, known, known.length !== changes.length);
      }
      case 'mcpToolCall': {
        const error = textOrNull(record(item['error'])['message']);
        const result = item['result'];
        const content = typeof result === 'object' && result !== null ? record(result)['content'] : undefined;
        return ended(status, error ?? (content === undefined ? null : JSON.stringify(content)));
      }
      case 'collabAgentToolCall':
        return ended(status, null);
      case 'imageView':
        return ended('completed', null);
      case 'webSearch': {
        const results = item['results'];
        return ended('completed', Array.isArray(results) ? JSON.stringify(results) : null);
      }
      case 'imageGeneration': {
        const failure = item['failure'];
        return typeof failure === 'object' && failure !== null
          ? ended('failed', textOrNull(record(failure)['type']))
          : ended('completed', textOrNull(item['savedPath']));
      }
      default:
        return null;
    }
  }

  #planUpdated(params: Fields, anchor: string): AgentItem[] {
    const turnId = textOrNull(params['turnId']);
    const lines: string[] = [];
    const explanation = textOrNull(params['explanation']);
    if (explanation !== null && explanation !== '') lines.push(explanation);
    for (const step of Array.isArray(params['plan']) ? (params['plan'] as unknown[]) : []) {
      const entry = record(step);
      const text = textOrNull(entry['step']);
      if (text !== null) lines.push(`- [${textOrNull(entry['status']) ?? 'pending'}] ${text}`);
    }
    return [
      {
        kind: 'plan',
        itemId: this.#named(turnId ?? anchor, 'plan'),
        turnId,
        text: lines.join('\n'),
        truncated: false,
      },
    ];
  }

  #errorNotice(params: Fields, anchor: string): AgentItem[] {
    const turnId = textOrNull(params['turnId']);
    const level = params['willRetry'] === true ? 'warning' : 'error';
    return [
      notice(this.#named(turnId ?? anchor, 'error'), turnId, level, errorText(record(params['error']))),
    ];
  }

  #warning(method: string, params: Fields, anchor: string): AgentItem[] {
    const text = textOrNull(params['message']) ?? '';
    return [notice(this.#named(anchor, method), null, 'warning', text)];
  }

  #summaryNotice(method: string, params: Fields): AgentItem[] {
    const summary = textOrNull(params['summary']) ?? '';
    const details = textOrNull(params['details']);
    const text = details === null || details === '' ? summary : `${summary}: ${details}`;
    const level = method === 'configWarning' ? 'warning' : 'info';
    return [notice(this.#named(this.#thread ?? 'thread', method), null, level, text)];
  }
}

function notice(itemId: string, turnId: string | null, level: NoticeItem['level'], text: string): NoticeItem {
  return { kind: 'notice', itemId, turnId, level, text, truncated: false };
}

/** A reasoning item's summary and its text, each an item where non-empty; one empty item where both are. */
function reasoningItems(id: string, turnId: string | null, item: Fields): AgentItem[] {
  const joined = (value: unknown): string =>
    (Array.isArray(value) ? value : []).filter((one): one is string => typeof one === 'string').join('\n\n');
  const summary = joined(item['summary']);
  const content = joined(item['content']);
  const items: AgentItem[] = [];
  if (summary !== '')
    items.push({ kind: 'thinking', itemId: id, turnId, text: summary, summary: true, truncated: false });
  if (content !== '')
    items.push({
      kind: 'thinking',
      itemId: `${id}:raw`,
      turnId,
      text: content,
      summary: false,
      truncated: false,
    });
  if (items.length === 0)
    items.push({ kind: 'thinking', itemId: id, turnId, text: '', summary: false, truncated: false });
  return items;
}

/** The arguments a tool item states, as an object; null where it states none. */
function callInput(item: Fields): JsonObject | null {
  const pick = (keys: readonly string[]): JsonObject | null => {
    const out: JsonObject = {};
    for (const key of keys) {
      const value = item[key];
      if (value !== undefined) out[key] = value as JsonObject[string];
    }
    return Object.keys(out).length === 0 ? null : out;
  };
  switch (item['type']) {
    case 'commandExecution':
      return pick(['command', 'cwd']);
    case 'fileChange': {
      const changes = Array.isArray(item['changes']) ? (item['changes'] as unknown[]) : [];
      const paths = changes
        .map((entry) => textOrNull(record(entry)['path']))
        .filter((one): one is string => one !== null);
      return { paths };
    }
    case 'mcpToolCall': {
      const args = item['arguments'];
      return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as JsonObject) : null;
    }
    case 'imageView':
      return pick(['path']);
    case 'webSearch':
      return pick(['query', 'action']);
    case 'imageGeneration':
      return pick(['revisedPrompt']);
    case 'collabAgentToolCall':
      return pick(['prompt', 'model', 'receiverThreadIds']);
    default:
      return null;
  }
}

/** One file change as an entry; null for a change kind this host does not know. */
function fileChange(entry: Fields): FileChangeEntry | null {
  const kind = record(entry['kind']);
  const change = textOrNull(kind['type']);
  if (change === null || !(FILE_CHANGE_KINDS as readonly string[]).includes(change)) return null;
  return {
    path: textOrNull(entry['path']) ?? '',
    change: change as FileChangeKind,
    movePath: textOrNull(kind['move_path']),
    diff: textOrNull(entry['diff']),
  };
}
