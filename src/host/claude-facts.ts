/**
 * The Claude lift: the facts a controller acts on, read out of the Claude agent's own messages.
 *
 * In `src/host/` because it names the SDK's message union, the same reason `readInitFacts` and
 * `readTurnSpend` are here; it builds on both. Every figure it emits is one the agent reported, or
 * null. The one stated counting rule is `contextTokens`, the sum Claude Code itself counts a call's
 * context by: input, cache reads and cache writes.
 *
 * What each fact is read from:
 *   - `session_handle`: `system/init.session_id`, when it first appears and whenever it changes.
 *   - `agent_receipt`: `system/init`, when any member differs from the last receipt. The CLI re-sends
 *     its init at every turn, so an unchanged one reports nothing. `effortReported` says whether the
 *     init carried an `effort` at all: the SDK omits it on a CLI that does not publish it, and states
 *     null when no effort will be sent.
 *   - `turn_record`: each `result`. `totals` is the running total the result reports and `turn` is
 *     the result's own `usage`, which covers the turn's main loop and names no model; it is filed
 *     under the model the latest init reported, and is null until an init has been seen.
 *   - `usage_sample`: each main-thread `assistant` model call, once per API message id, with the
 *     cache reads the call reported.
 *   - `tasks`: the running set, composed from the level message and the task edges, and the tasks
 *     settled since the turn began, from each `task_notification`'s status; the next turn's init
 *     clears them.
 *   - `compaction`: the observer's report, not a message.
 * And one fragment per `content_block_delta` that carries text, thinking or a tool's arguments.
 */
import type {
  AgentFact,
  AgentFragmentDelta,
  AgentReceiptFact,
  CacheTtl,
  CostBasis,
  FragmentChannel,
  ModelSpendFact,
  RunningTaskEntry,
  SettledTaskEntry,
  SpendFacts,
  TaskSettlement,
  TurnRecordFact,
  UsageSampleFact,
} from '../control/frames.js';
import { DEFAULT_RUNTIME, TASK_SETTLEMENTS } from '../control/frames.js';
import type { FactLift, LiftedFacts } from '../sessions/fact-lift.js';
import type { CompactionReport } from '../state/observer.js';
import type { ModelSpend } from '../telemetry/usage.js';
import type { AgentInitFacts, SDKMessage } from './agent-process.js';
import { readInitFacts } from './agent-process.js';
import { readTurnSpend } from './telemetry.js';

/** Claude is the runtime an absent `runtime` names. */
const RUNTIME = DEFAULT_RUNTIME;

/** The SDK's `task_type` for a subagent the Task tool started; the only kind a start edge adds. */
const SUBAGENT_TASK_TYPE = 'local_agent';

/** The currency every figure Claude reports is in. */
const CLAUDE_CURRENCY = 'USD';

/**
 * Claude's own words for a figure's basis, as the wire's. `unknown` is a guess at a default model's
 * rate, so it is `guessed`; an absent basis is `list`, as the SDK says to read it.
 */
const CLAUDE_COST_BASES: Readonly<Record<string, CostBasis>> = {
  list: 'list',
  managed: 'managed',
  unknown: 'guessed',
};

/** The weakest first: a figure that holds a guess is a guess, one that holds a managed rate is managed. */
const BASIS_WEAKNESS: readonly CostBasis[] = ['guessed', 'managed', 'list'];

/**
 * The wire's basis for Claude's word. An absent word is `list`, the SDK's own reading. A word this
 * build does not know is read as `guessed`, so a figure whose basis cannot be named is never priced
 * as a list price.
 */
export function costBasisOf(reported: string | null | undefined): CostBasis {
  if (reported === null || reported === undefined) return 'list';
  return CLAUDE_COST_BASES[reported] ?? 'guessed';
}

/**
 * The basis of a figure made of per-model rows: the weakest row's, `guessed` over `managed` over
 * `list`, and `list` when there are no rows. A roll-up of what the rows report, never a basis of its own.
 */
export function rolledUpBasis(rows: readonly ModelSpendFact[]): CostBasis {
  for (const basis of BASIS_WEAKNESS) {
    if (rows.some((row) => row.costBasis === basis)) return basis;
  }
  return 'list';
}

/** One session's Claude lift. Its state is the session's: a new process starts a new lift. */
export class ClaudeFactLift implements FactLift {
  #handle: string | null = null;
  #receipt: string | null = null;
  /** The model the latest init reported: the key a turn's own usage is filed under. */
  #initModel: string | null = null;
  /** The latest result's per-model figures, where a call's context window is read. */
  #windows: readonly ModelSpend[] = [];
  /** The API message the last sample was read from, and that sample, for the call's later frames. */
  #sampledMessageId: string | null = null;
  #lastSample: string | null = null;
  /** The level the last `background_tasks_changed` reported, and the start edges it may lack. */
  #level: readonly RunningTaskEntry[] = [];
  #edges: readonly RunningTaskEntry[] = [];
  /** The tasks settled since the turn began, each with how it ended. */
  #settled: readonly SettledTaskEntry[] = [];
  /** The tasks fact last sent, as its key: none yet reads as nothing running and nothing settled. */
  #running = tasksKey([], []);

  fromMessage(message: SDKMessage): LiftedFacts {
    const facts: AgentFact[] = [];
    const fragments: AgentFragmentDelta[] = [];

    const init = readInitFacts(message);
    if (init !== null) this.#fromInit(message, init, facts);

    const spend = readTurnSpend(message);
    if (spend !== null && message.type === 'result') {
      facts.push(this.#turnRecord(message, spend.totalCostUsd, spend.byModel));
      this.#windows = spend.byModel;
      this.#edges = [];
      this.#tasksIfChanged(facts);
    }

    if (message.type === 'assistant') this.#sample(message, facts);

    if (message.type === 'system') {
      if (message.subtype === 'background_tasks_changed') {
        this.#level = (message.tasks ?? [])
          .filter((task) => task.ambient !== true)
          .map((task) => runningTask(task.task_id, task.task_type, task.description))
          .filter((task): task is RunningTaskEntry => task !== null);
        this.#tasksIfChanged(facts);
      } else if (message.subtype === 'task_started') {
        const started = runningTask(message.task_id, message.task_type, message.description);
        if (
          started !== null &&
          message.ambient !== true &&
          started.type === SUBAGENT_TASK_TYPE &&
          !this.#edges.some((edge) => edge.taskId === started.taskId)
        ) {
          this.#edges = [...this.#edges, started];
          this.#tasksIfChanged(facts);
        }
      } else if (message.subtype === 'task_notification') {
        this.#settle(message.task_id, message.status);
        this.#edges = this.#edges.filter((edge) => edge.taskId !== message.task_id);
        this.#tasksIfChanged(facts);
      }
    }

    if (message.type === 'stream_event') {
      const fragment = fragmentOf(message);
      if (fragment !== null) fragments.push(fragment);
    }

    return { facts, fragments };
  }

  fromCompaction(report: CompactionReport): readonly AgentFact[] {
    return [
      {
        kind: 'compaction',
        runtime: RUNTIME,
        status: report.status,
        trigger: report.trigger,
        tokensBefore: report.tokensBefore,
        tokensAfter: report.tokensAfter,
      },
    ];
  }

  #fromInit(message: SDKMessage, init: AgentInitFacts, facts: AgentFact[]): void {
    this.#initModel = textOrNull(init.model);

    if (init.sessionId !== '' && init.sessionId !== this.#handle) {
      this.#handle = init.sessionId;
      facts.push({ kind: 'session_handle', runtime: RUNTIME, handle: init.sessionId });
    }

    const receipt = receiptOf(message, init);
    const written = JSON.stringify(receipt);
    if (written !== this.#receipt) {
      this.#receipt = written;
      facts.push(receipt);
    }

    // The CLI sends its init as each turn begins, so a task settled in the turn before no longer
    // stands; the tasks fact says so once, and only when one had settled.
    if (this.#settled.length > 0) {
      this.#settled = [];
      this.#tasksIfChanged(facts);
    }
  }

  #turnRecord(
    message: Extract<SDKMessage, { type: 'result' }>,
    totalCostUsd: number,
    rows: readonly ModelSpend[],
  ): TurnRecordFact {
    const byModel = rows.map(modelSpendFact);
    const totals: SpendFacts = {
      cost: typeof totalCostUsd === 'number' ? totalCostUsd : null,
      currency: CLAUDE_CURRENCY,
      costBasis: rolledUpBasis(byModel),
      byModel,
    };
    const turn = turnOf(message, this.#initModel);
    const raw = message as { num_turns?: unknown; duration_ms?: unknown; session_id?: unknown };
    return {
      kind: 'turn_record',
      runtime: RUNTIME,
      totals,
      turn,
      turnScope: turn === null ? null : 'turn',
      numTurns: typeof raw.num_turns === 'number' ? raw.num_turns : null,
      durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : null,
      sourceSessionId: textOrNull(raw.session_id),
    };
  }

  /**
   * One sample per main-thread API call. The CLI delivers a call as one message per content block,
   * each carrying the call's usage, so a call is sampled on its first frame and its later frames,
   * which share its `message.id`, report nothing. A frame with no id is sampled when its figures
   * differ from the last sample's.
   */
  #sample(message: Extract<SDKMessage, { type: 'assistant' }>, facts: AgentFact[]): void {
    if (typeof message.parent_tool_use_id === 'string' && message.parent_tool_use_id !== '') return;
    const call = message.message as { id?: unknown; model?: unknown; usage?: unknown } | undefined;
    if (call === undefined || typeof call.usage !== 'object' || call.usage === null) return;

    const id = textOrNull(call.id);
    if (id !== null && id === this.#sampledMessageId) return;

    const model = textOrNull(call.model);
    const usage = call.usage as UsageCounts;
    const sample: UsageSampleFact = {
      kind: 'usage_sample',
      runtime: RUNTIME,
      model,
      contextTokens: contextTokensOf(usage),
      contextWindow: windowFor(model, this.#windows),
      cacheTtl: cacheTtlOf(usage),
      mainThread: true,
      cacheReadTokens: wholeOrNull(usage.cache_read_input_tokens),
    };
    const written = JSON.stringify(sample);
    if (id === null && written === this.#lastSample) return;

    this.#sampledMessageId = id;
    this.#lastSample = written;
    facts.push(sample);
  }

  /**
   * A task ended, as `status` says: the settled set takes it, with the type it started with where this
   * lift saw it start. A status this build does not know is not stated.
   */
  #settle(taskId: string, status: string): void {
    if (taskId === '' || !(TASK_SETTLEMENTS as readonly string[]).includes(status)) return;
    const started = [...this.#edges, ...this.#level].find((task) => task.taskId === taskId);
    const entry: SettledTaskEntry = {
      taskId,
      type: started === undefined || started.type === '' ? null : started.type,
      status: status as TaskSettlement,
    };
    this.#settled = [...this.#settled.filter((task) => task.taskId !== taskId), entry];
  }

  /**
   * The running set (the level, then each start edge the level lacks, by id) and the settled set.
   * Reported when either changed.
   */
  #tasksIfChanged(facts: AgentFact[]): void {
    const listed = new Set(this.#level.map((task) => task.taskId));
    const running = [...this.#level, ...this.#edges.filter((edge) => !listed.has(edge.taskId))];
    const written = tasksKey(running, this.#settled);
    if (written === this.#running) return;
    this.#running = written;
    facts.push({ kind: 'tasks', runtime: RUNTIME, running, settled: this.#settled });
  }
}

/** What a tasks fact states, as one string: the running and the settled sets. */
function tasksKey(running: readonly RunningTaskEntry[], settled: readonly SettledTaskEntry[]): string {
  return JSON.stringify([running, settled]);
}

/** The receipt an init message states. `effort` and `pluginErrors` are absent from `readInitFacts`. */
function receiptOf(message: SDKMessage, init: AgentInitFacts): AgentReceiptFact {
  const raw = message as { effort?: unknown; plugin_errors?: unknown };
  return {
    kind: 'agent_receipt',
    runtime: RUNTIME,
    runtimeVersion: textOrNull(init.cliVersion),
    model: textOrNull(init.model),
    permissionMode: textOrNull(init.permissionMode),
    effort: textOrNull(raw.effort),
    skills: [...init.skills],
    plugins: init.plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      path: textOrNull(plugin.path),
    })),
    // Absent is null, not an empty list: the SDK omits the key both for a clean load and for a
    // session whose frames are persisted elsewhere, so an absent key does not say nothing failed.
    pluginErrors: Array.isArray(raw.plugin_errors)
      ? raw.plugin_errors.map(
          (entry: { plugin?: unknown; type?: unknown; message?: unknown; path?: unknown }) => ({
            plugin: typeof entry.plugin === 'string' ? entry.plugin : '',
            type: typeof entry.type === 'string' ? entry.type : '',
            message: typeof entry.message === 'string' ? entry.message : '',
            path: textOrNull(entry.path),
          }),
        )
      : null,
    mcpServers: init.mcpServers.map((server) => ({ name: server.name, status: server.status })),
    source: 'runtime',
    effortReported: Object.hasOwn(raw, 'effort'),
  };
}

/** One `modelUsage` row as the wire's: every figure copied, the basis mapped. */
function modelSpendFact(row: ModelSpend): ModelSpendFact {
  return {
    model: row.model,
    canonicalModel: row.canonicalModel,
    provider: row.provider,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadInputTokens,
    cacheWriteTokens: row.cacheCreationInputTokens,
    reasoningTokens: row.thinkingTokens ?? null,
    cost: row.costUsd,
    costBasis: costBasisOf(row.costBasis),
    contextWindow: row.contextWindow,
  };
}

/**
 * The result's own `usage`, tokens only, filed under `model`; null when the result carries no usage
 * whose four counts are numbers, or when no init has named a model yet. It carries no cost: Claude
 * prices the session, not the turn, and the turn's cost is never derived from the totals here.
 */
function turnOf(message: Extract<SDKMessage, { type: 'result' }>, model: string | null): SpendFacts | null {
  if (model === null) return null;
  const usage = (message as { usage?: unknown }).usage as UsageCounts | undefined;
  if (typeof usage !== 'object' || usage === null) return null;
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = usage;
  if (
    typeof input_tokens !== 'number' ||
    typeof output_tokens !== 'number' ||
    typeof cache_read_input_tokens !== 'number' ||
    typeof cache_creation_input_tokens !== 'number'
  ) {
    return null;
  }
  return {
    cost: null,
    currency: null,
    costBasis: 'unreported',
    byModel: [
      {
        model,
        canonicalModel: null,
        provider: null,
        inputTokens: input_tokens,
        outputTokens: output_tokens,
        cacheReadTokens: cache_read_input_tokens,
        cacheWriteTokens: cache_creation_input_tokens,
        reasoningTokens: null,
        cost: null,
        costBasis: 'unreported',
        contextWindow: null,
      },
    ],
  };
}

/** The counters a model call's `usage` carries, as this file reads them. */
interface UsageCounts {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
  readonly cache_creation?: {
    readonly ephemeral_1h_input_tokens?: unknown;
    readonly ephemeral_5m_input_tokens?: unknown;
  };
}

/**
 * Claude Code's own count of a call's context: input plus cache reads plus cache writes, an absent
 * counter counting nothing. Null when the call reported none of the three.
 */
function contextTokensOf(usage: UsageCounts): number | null {
  const counts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens];
  const reported = counts.filter((count): count is number => typeof count === 'number');
  return reported.length === 0 ? null : reported.reduce((total, count) => total + count, 0);
}

/** The lifetime a call wrote the cache for: an hour when it wrote any hour-long tokens, else five minutes. */
function cacheTtlOf(usage: UsageCounts): CacheTtl | null {
  const written = usage.cache_creation;
  if (isPositive(written?.ephemeral_1h_input_tokens)) return '1h';
  if (isPositive(written?.ephemeral_5m_input_tokens)) return '5m';
  return null;
}

function isPositive(value: unknown): boolean {
  return typeof value === 'number' && value > 0;
}

/** A reported count as the wire carries it, a non-negative whole number, or null when none was reported. */
function wholeOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The context window the latest result reported for `model`, the API's id for the call. A
 * `modelUsage` key names a model exactly, with a bracketed selector (`claude-opus-5[1m]`), or through
 * its canonical model, tried in that order. Null with no result yet, or when no single row names it.
 */
function windowFor(model: string | null, rows: readonly ModelSpend[]): number | null {
  if (model === null) return null;
  const ranks: ((row: ModelSpend) => boolean)[] = [
    (row) => row.model === model,
    (row) => withoutSelector(row.model) === model,
    (row) => row.canonicalModel !== null && withoutSelector(row.canonicalModel) === model,
  ];
  for (const names of ranks) {
    const named = rows.filter(names);
    if (named.length === 1) return named[0]?.contextWindow ?? null;
    if (named.length > 1) return null;
  }
  return null;
}

/** An id without a trailing bracketed selector: `claude-opus-5[1m]` reads `claude-opus-5`. */
function withoutSelector(id: string): string {
  if (!id.endsWith(']')) return id;
  const open = id.lastIndexOf('[');
  return open > 0 ? id.slice(0, open) : id;
}

/** One running task, or null for an entry with no id. */
function runningTask(taskId: unknown, type: unknown, description: unknown): RunningTaskEntry | null {
  if (typeof taskId !== 'string' || taskId.trim() === '') return null;
  return {
    taskId,
    type: typeof type === 'string' ? type : '',
    description: typeof description === 'string' ? description : null,
  };
}

/** The fragment a streamed content delta carries, or null for every other stream event. */
function fragmentOf(message: Extract<SDKMessage, { type: 'stream_event' }>): AgentFragmentDelta | null {
  const event = message.event as { type?: unknown; delta?: unknown } | undefined;
  if (event?.type !== 'content_block_delta') return null;
  const delta = event.delta as { type?: unknown; text?: unknown; thinking?: unknown; partial_json?: unknown };
  let channel: FragmentChannel;
  let text: unknown;
  switch (delta?.type) {
    case 'text_delta':
      channel = 'text';
      text = delta.text;
      break;
    case 'thinking_delta':
      channel = 'thinking';
      text = delta.thinking;
      break;
    case 'input_json_delta':
      channel = 'tool_input';
      text = delta.partial_json;
      break;
    default:
      return null;
  }
  return {
    update: 'agent_fragment',
    runtime: RUNTIME,
    channel,
    text: typeof text === 'string' ? text : '',
    parentId: textOrNull(message.parent_tool_use_id),
  };
}

/** A non-empty string, else null: an empty or absent value states nothing. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
