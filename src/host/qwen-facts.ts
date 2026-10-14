/**
 * The Qwen Code lift: the facts a controller acts on, read out of what a Qwen process yields, the CLI's
 * stream messages and the answers to the control requests the adapter sent.
 *
 * Every figure is one the CLI reported, or null; nothing is computed from another figure, and nothing is
 * summed. What each fact is read from:
 *   - `session_handle`: the session id the `initialize` answer names; again only when a `system/init`
 *     names another (a fork or a resume reports a new one).
 *   - `agent_receipt`: one composed by this host at the `initialize` answer (`source: 'host'`), stating
 *     the model and mode asked for and the skills handed over; then the CLI's own, once its context usage
 *     has listed the skills it found (`source: 'runtime'`), sent again whenever an init moves a member.
 *     The permission mode is Qwen's own word. A setter the CLI applied sends one composed by this host.
 *   - `turn_record`: each `result`. Its `usage` is the CLI's running total for the session, every model
 *     it used summed by the CLI, filed under the session's model register: so `totals` carries it, and
 *     `turn` and `turnScope` are null. A resumed or forked session's total includes the source session's
 *     tokens. `inputTokens` is the input minus the cached input, floored at zero: the CLI counts cached
 *     tokens inside its input, so this is its own split, and counts uncached input only, as on every
 *     runtime. The CLI reports no cache writes and no cost.
 *   - `usage_sample`: each answer to `get_context_usage`, sent after each result: the CLI's own count of
 *     the context and its window, and the last main-thread call's cache reads.
 *   - `tasks`: the background tasks the CLI reports started and settled; the settled ones are cleared at
 *     the next init, the start of the next turn.
 * And one fragment per content-block delta: text, thinking, or a tool's input.
 */
import type {
  AgentFact,
  AgentFragmentDelta,
  AgentReceiptFact,
  ModelSpendFact,
  ReceiptPluginError,
  RunningTaskEntry,
  SettledTaskEntry,
  SpendFacts,
  TaskSettlement,
} from '../control/frames.js';
import { MAX_FACT_LIST_ENTRIES, MAX_FACT_TEXT_LENGTH } from '../control/frames.js';
import type { FactLift, LiftedFacts } from '../sessions/fact-lift.js';
import { QWEN_RUNTIME } from '../sessions/runtimes.js';
import type { CompactionReport } from '../state/observer.js';
import type { QwenMessage } from './qwen-wire.js';
import {
  AssistantMessage,
  ContextUsageAnswer,
  InitializeAnswer,
  ResultMessage,
  StreamEventMessage,
  SystemInit,
  SystemMessage,
  TaskNotification,
  TaskStarted,
  parsed,
  qwenMessageKey,
} from './qwen-wire.js';
import type { z } from 'zod';

const NOTHING: LiftedFacts = { facts: [], fragments: [] };

/** The type every background task the CLI reports is listed under: it states none of its own. */
const BACKGROUND_TASK_TYPE = 'background';

/** The statuses that end a task, and how each says it ended. */
const SETTLED_TASK_STATUSES: Readonly<Record<string, TaskSettlement>> = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stopped',
  killed: 'stopped',
  stopped: 'stopped',
};

type Usage = NonNullable<z.infer<typeof ResultMessage>['usage']>;

export interface QwenFactLiftOptions {
  /** The plugin directories this host could not hand the session, reported among its plugin errors. */
  readonly undeliveredPlugins?: readonly ReceiptPluginError[];
  /** The skills this host handed the session, by the names the CLI lists them under. */
  readonly handedOverSkills?: readonly string[];
  /** The model the session was asked to start on, or null for the endpoint's default. */
  readonly startModel?: string | null;
  /** The approval mode the CLI was started in, in Qwen's own word. */
  readonly startMode?: string | null;
}

export class QwenFactLift implements FactLift<QwenMessage> {
  readonly #undelivered: readonly ReceiptPluginError[];
  readonly #handedOver: readonly string[];
  #handle: string | null = null;
  /** The model register: what the session's spend and usage are filed under. */
  #model: string | null;
  #runtimeVersion: string | null = null;
  #permissionMode: string | null;
  #effort: string | null = null;
  #effortReported = false;
  #skills: readonly string[] | null = null;
  #mcpServers: AgentReceiptFact['mcpServers'] = null;
  /** Whether the CLI has listed its skills, so a receipt of its own may be sent. */
  #runtimeOpened = false;
  /** The receipt last sent, as its key: a receipt is sent only when a member moved. */
  #receiptSent = '';
  /** The last main-thread model call's cache reads, for the next usage sample. */
  #lastCacheRead: number | null = null;
  readonly #running = new Map<string, RunningTaskEntry>();
  readonly #settled = new Map<string, SettledTaskEntry>();
  #tasksSent = JSON.stringify([[], []]);

  constructor(options: QwenFactLiftOptions = {}) {
    this.#undelivered = options.undeliveredPlugins ?? [];
    this.#handedOver = options.handedOverSkills ?? [];
    this.#model = options.startModel ?? null;
    this.#permissionMode = options.startMode ?? null;
  }

  fromMessage(message: QwenMessage): LiftedFacts {
    if (message.kind === 'answer') return this.#fromAnswer(message);
    if (message.kind !== 'message') return NOTHING;
    const body = message.message;
    switch (qwenMessageKey(body)) {
      case 'system/init':
        return this.#fromInit(body);
      case 'assistant': {
        const assistant = parsed(AssistantMessage, body);
        if (assistant === null || (assistant.parent_tool_use_id ?? null) !== null) return NOTHING;
        if (typeof assistant.message.model === 'string' && assistant.message.model !== '') {
          this.#model = assistant.message.model;
        }
        const read = assistant.message.usage?.cache_read_input_tokens;
        if (assistant.message.usage !== undefined) this.#lastCacheRead = wholeOrNull(read ?? null);
        return NOTHING;
      }
      case 'result':
        return this.#fromResult(body);
      case 'system/task_started':
        return this.#fromTaskStarted(body);
      case 'system/task_notification':
        return this.#fromTaskNotification(body);
      case 'system/model_fallback': {
        const data = parsed(SystemMessage, body)?.data;
        const to =
          typeof data === 'object' && data !== null ? (data as { toModel?: unknown }).toModel : undefined;
        if (typeof to !== 'string' || to === '') return NOTHING;
        this.#model = to;
        return facts(this.#receiptIfChanged('runtime'));
      }
      case 'stream_event':
        return this.#fragment(body);
      default:
        return NOTHING;
    }
  }

  fromCompaction(report: CompactionReport): readonly AgentFact[] {
    return [
      {
        kind: 'compaction',
        runtime: QWEN_RUNTIME,
        status: report.status,
        trigger: report.trigger,
        tokensBefore: report.tokensBefore,
        tokensAfter: report.tokensAfter,
      },
    ];
  }

  #fromAnswer(message: Extract<QwenMessage, { kind: 'answer' }>): LiftedFacts {
    const out: AgentFact[] = [];
    switch (message.subtype) {
      case 'initialize': {
        const answer = parsed(InitializeAnswer, message.response);
        if (answer === null) break;
        out.push(...this.#handleIfChanged(answer.session_id));
        const status = answer.effort_status;
        if (status !== undefined && status !== null) {
          this.#effort = status.effort ?? null;
          this.#effortReported = true;
        }
        // The hand-over: what this host gave the session, said as its own until the CLI lists its own.
        out.push(...this.#receiptIfChanged('host'));
        break;
      }
      case 'set_model': {
        const model = message.request['model'];
        if (typeof model !== 'string') break;
        this.#model = model;
        out.push(...this.#receiptIfChanged('host'));
        break;
      }
      case 'set_permission_mode': {
        const mode = message.request['mode'];
        if (typeof mode !== 'string') break;
        this.#permissionMode = mode;
        out.push(...this.#receiptIfChanged('host'));
        break;
      }
      case 'set_effort': {
        const effort = message.response['effort'] ?? message.request['effort'];
        if (typeof effort !== 'string') break;
        this.#effort = effort;
        this.#effortReported = true;
        out.push(...this.#receiptIfChanged('host'));
        break;
      }
      case 'get_context_usage': {
        const usage = parsed(ContextUsageAnswer, message.response);
        if (usage === null) break;
        if (usage.skills !== undefined) {
          this.#skills = bounded(usage.skills.map((skill) => text(skill.name)));
          this.#runtimeOpened = true;
          out.push(...this.#receiptIfChanged('runtime'));
        }
        out.push({
          kind: 'usage_sample',
          runtime: QWEN_RUNTIME,
          model: typeof usage.modelName === 'string' ? text(usage.modelName) : this.#modelText(),
          contextTokens: wholeOrNull(usage.totalTokens ?? null),
          contextWindow: wholeOrNull(usage.contextWindowSize ?? null),
          cacheTtl: null,
          mainThread: true,
          cacheReadTokens: this.#lastCacheRead,
        });
        break;
      }
      default:
        break;
    }
    return facts(out);
  }

  #fromInit(body: Readonly<Record<string, unknown>>): LiftedFacts {
    const init = parsed(SystemInit, body);
    if (init === null) return NOTHING;
    const out: AgentFact[] = [...this.#handleIfChanged(init.session_id)];
    if (typeof init.model === 'string' && init.model !== '') this.#model = init.model;
    if (typeof init.permission_mode === 'string') this.#permissionMode = init.permission_mode;
    if (typeof init.qwen_code_version === 'string') this.#runtimeVersion = init.qwen_code_version;
    if (init.mcp_servers !== undefined) {
      this.#mcpServers = bounded(
        init.mcp_servers.map((server) => ({ name: text(server.name), status: server.status })),
      );
    }
    out.push(...this.#receiptIfChanged('runtime'));
    // A new turn: a task settled in the turn before no longer stands; said once, when one had settled.
    if (this.#settled.size > 0) {
      this.#settled.clear();
      out.push(...this.#tasksIfChanged());
    }
    return facts(out);
  }

  #handleIfChanged(id: string): AgentFact[] {
    if (id === '' || id === this.#handle) return [];
    this.#handle = id;
    return [{ kind: 'session_handle', runtime: QWEN_RUNTIME, handle: id }];
  }

  #modelText(): string | null {
    return this.#model === null ? null : text(this.#model);
  }

  /** The receipt as it stands, from `source`. */
  #receiptFact(source: 'runtime' | 'host'): AgentReceiptFact {
    return {
      kind: 'agent_receipt',
      runtime: QWEN_RUNTIME,
      runtimeVersion: this.#runtimeVersion,
      model: this.#modelText(),
      permissionMode: this.#permissionMode,
      effort: this.#effort,
      // The CLI's own list once it has given one; until then, what this host handed over.
      skills: this.#runtimeOpened ? this.#skills : this.#handedOver,
      // The plugin directories reach a Qwen Code session as skill directories; no plugin itself loads.
      plugins: null,
      pluginErrors:
        this.#undelivered.length === 0
          ? null
          : bounded(
              this.#undelivered.map((error) => ({
                plugin: text(error.plugin),
                type: error.type,
                message: text(error.message),
                path: error.path === null ? null : text(error.path),
              })),
            ),
      mcpServers: this.#mcpServers,
      source,
      effortReported: this.#effortReported,
    };
  }

  /** The receipt, or nothing when no member moved since the last one sent. The CLI's own waits for its skills. */
  #receiptIfChanged(source: 'runtime' | 'host'): AgentFact[] {
    if (source === 'runtime' && !this.#runtimeOpened) return [];
    const receipt = this.#receiptFact(source);
    const { source: _source, ...members } = receipt;
    const key = JSON.stringify(members);
    if (key === this.#receiptSent) return [];
    this.#receiptSent = key;
    return [receipt];
  }

  #fromResult(body: Readonly<Record<string, unknown>>): LiftedFacts {
    const result = parsed(ResultMessage, body);
    if (result === null) return NOTHING;
    return facts([
      {
        kind: 'turn_record',
        runtime: QWEN_RUNTIME,
        // No model in the register means none was named or reported: no model key is invented.
        totals:
          result.usage === undefined || this.#model === null ? null : this.#spend(result.usage, this.#model),
        turn: null,
        turnScope: null,
        numTurns: wholeOrNull(result.num_turns ?? null),
        durationMs: wholeOrNull(result.duration_ms ?? null),
        sourceSessionId: result.session_id ?? this.#handle,
      },
    ]);
  }

  #spend(usage: Usage, model: string): SpendFacts {
    const cached = whole(usage.cache_read_input_tokens ?? 0);
    const row: ModelSpendFact = {
      model: text(model),
      canonicalModel: null,
      provider: null,
      inputTokens: Math.max(0, whole(usage.input_tokens) - cached),
      outputTokens: whole(usage.output_tokens),
      cacheReadTokens: cached,
      // The CLI never reports a cache write; the member takes no null.
      cacheWriteTokens: 0,
      reasoningTokens: null,
      cost: null,
      costBasis: 'unreported',
      contextWindow: null,
    };
    return { cost: null, currency: null, costBasis: 'unreported', byModel: [row] };
  }

  #fromTaskStarted(body: Readonly<Record<string, unknown>>): LiftedFacts {
    const task = parsed(TaskStarted, parsed(SystemMessage, body)?.data);
    if (task === null) return NOTHING;
    this.#running.set(task.task_id, {
      taskId: text(task.task_id),
      type: BACKGROUND_TASK_TYPE,
      description: typeof task.description === 'string' ? text(task.description) : null,
    });
    return facts(this.#tasksIfChanged());
  }

  #fromTaskNotification(body: Readonly<Record<string, unknown>>): LiftedFacts {
    const task = parsed(TaskNotification, parsed(SystemMessage, body)?.data);
    if (task === null) return NOTHING;
    const settled = Object.hasOwn(SETTLED_TASK_STATUSES, task.status)
      ? SETTLED_TASK_STATUSES[task.status]
      : undefined;
    if (settled === undefined) {
      if (task.status === 'running' && !this.#running.has(task.task_id)) {
        this.#running.set(task.task_id, {
          taskId: text(task.task_id),
          type: BACKGROUND_TASK_TYPE,
          description: null,
        });
      }
      return facts(this.#tasksIfChanged());
    }
    const was = this.#running.get(task.task_id);
    this.#running.delete(task.task_id);
    if (!this.#settled.has(task.task_id)) {
      this.#settled.set(task.task_id, {
        taskId: text(task.task_id),
        type: was?.type ?? null,
        status: settled,
      });
    }
    return facts(this.#tasksIfChanged());
  }

  #tasksIfChanged(): AgentFact[] {
    const running = bounded([...this.#running.values()]);
    const settled = bounded([...this.#settled.values()]);
    const key = JSON.stringify([running, settled]);
    if (key === this.#tasksSent) return [];
    this.#tasksSent = key;
    return [{ kind: 'tasks', runtime: QWEN_RUNTIME, running, settled }];
  }

  #fragment(body: Readonly<Record<string, unknown>>): LiftedFacts {
    const streamed = parsed(StreamEventMessage, body);
    if (streamed === null || streamed.event.type !== 'content_block_delta') return NOTHING;
    const delta = (streamed.event as { delta?: unknown }).delta;
    if (typeof delta !== 'object' || delta === null) return NOTHING;
    const read = delta as Record<string, unknown>;
    const [channel, value] =
      read['type'] === 'text_delta'
        ? (['text', read['text']] as const)
        : read['type'] === 'thinking_delta'
          ? (['thinking', read['thinking']] as const)
          : read['type'] === 'input_json_delta'
            ? (['tool_input', read['partial_json']] as const)
            : ([null, null] as const);
    if (channel === null || typeof value !== 'string' || value === '') return NOTHING;
    const fragment: AgentFragmentDelta = {
      update: 'agent_fragment',
      runtime: QWEN_RUNTIME,
      channel,
      text: value,
      // A sub-agent's call names the tool call that started it; the main thread names none.
      parentId: streamed.parent_tool_use_id ?? null,
    };
    return { facts: [], fragments: [fragment] };
  }
}

function facts(list: readonly AgentFact[]): LiftedFacts {
  return list.length === 0 ? NOTHING : { facts: list, fragments: [] };
}

function bounded<T>(list: readonly T[]): T[] {
  return list.slice(0, MAX_FACT_LIST_ENTRIES);
}

function text(value: string): string {
  return value.length <= MAX_FACT_TEXT_LENGTH ? value : value.slice(0, MAX_FACT_TEXT_LENGTH);
}

/** A reported count as the wire carries it: a non-negative integer. */
function whole(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function wholeOrNull(value: number | null): number | null {
  return value === null || !Number.isFinite(value) || value < 0 ? null : Math.floor(value);
}

/**
 * The native id a fact lifted from `message` names: the stream message's own `uuid`. Never the
 * `system/init`'s, whose `uuid` is the session id, and never an answer's, which has none.
 */
export function qwenFactSourceId(message: QwenMessage): string | null {
  if (message.kind !== 'message') return null;
  if (qwenMessageKey(message.message) === 'system/init') return null;
  const uuid = message.message['uuid'];
  return typeof uuid === 'string' && uuid !== '' ? uuid : null;
}
