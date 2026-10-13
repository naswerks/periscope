/**
 * The Codex lift: the facts a controller acts on, read out of what a Codex process yields, the
 * server's notifications and the answers to the requests the adapter made.
 *
 * Every figure is one the server reported, or null; nothing is computed from another figure. What
 * each fact is read from:
 *   - `session_handle`: the thread id the answer to `thread/start` (or `thread/resume`,
 *     `thread/fork`) names. Valid only against the same Codex home.
 *   - `agent_receipt`: built when the opening answers are in (initialize, the thread, the skills, the
 *     MCP servers), so it rides before the session reports `ready`; sent again whenever a member
 *     changes (a reroute, a skills change, an MCP server's status). The version is the one the
 *     `userAgent` names, the permission mode is Codex's own approval word, the effort is the thread's.
 *     A setter applied on a `turn/start` sends one composed by this host (`source: 'host'`).
 *   - `turn_record`: each `turn/completed` on the session's own thread. `totals` is the newest
 *     `thread/tokenUsage/updated` for that turn: Codex's running total for the thread. `turn` and
 *     `turnScope` are null: Codex's `last` is one model call, not the turn, and the totals carry the
 *     spend. `inputTokens` is the input minus the cached input, floored at zero, by Codex's own split,
 *     so it counts uncached input only, as on every runtime.
 *   - `usage_sample`: each `thread/tokenUsage/updated`. The context is the last call's total, Codex's
 *     own counting rule; cached tokens are part of input there, not added to it. The cache reads are
 *     the last call's cached input.
 *   - `tasks`: the running sub-agents, composed from collaboration tool calls and sub-agent activity,
 *     and the sub-agents settled since the turn began, with how each ended where the item says; the
 *     next `turn/started` clears them.
 *   - `compaction`: the observer's report of the compaction entry, as for every runtime.
 * And one fragment per text or reasoning delta.
 *
 * The usage notification names no model, so every spend and usage figure is filed under the session's
 * model register: the model the thread opened on, moved by a model a `turn/start` sends and by a
 * reroute's `toModel`.
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
import { CODEX_RUNTIME } from '../sessions/runtimes.js';
import type { CompactionReport } from '../state/observer.js';
import { userAgentVersion } from './codex-binary.js';
import type { CodexMessage } from './codex-wire.js';
import {
  ContentDelta,
  ItemNotification,
  McpServerStartupStatus,
  McpServerStatusListResponse,
  ModelRerouted,
  SkillsListResponse,
  ThreadOpenResponse,
  ThreadTokenUsageUpdated,
  TokenUsageBreakdown,
  TurnNotification,
  parsed,
} from './codex-wire.js';
import type { z } from 'zod';

const NOTHING: LiftedFacts = { facts: [], fragments: [] };

/** The type every running Codex sub-agent is reported under. */
const SUBAGENT_TASK_TYPE = 'subagent';

/** Collaboration states that end a sub-agent, and how each says it ended. */
const SETTLED_AGENT_STATES: Readonly<Record<string, TaskSettlement>> = {
  completed: 'completed',
  errored: 'failed',
  shutdown: 'stopped',
  notFound: 'stopped',
};

/** Sub-agent activity that ends a sub-agent, and how each says it ended. */
const SETTLED_ACTIVITY: Readonly<Record<string, TaskSettlement>> = {
  completed: 'completed',
  interrupted: 'stopped',
};

type Breakdown = z.infer<typeof TokenUsageBreakdown>;

/** The newest usage reported for one turn: the thread's running total, and the window. */
interface TurnUsage {
  readonly total: Breakdown;
  readonly window: number | null;
}

export class CodexFactLift implements FactLift<CodexMessage> {
  /** The plugin directories this host could not hand the session, reported among its plugin errors. */
  readonly #undelivered: readonly ReceiptPluginError[];

  constructor(options: { readonly undeliveredPlugins?: readonly ReceiptPluginError[] } = {}) {
    this.#undelivered = options.undeliveredPlugins ?? [];
  }

  /** The session's own thread, from the answer that opened it. */
  #thread: string | null = null;
  #handleSent = false;
  /** The model register: what the session's spend and usage are filed under. */
  #model: string | null = null;
  #runtimeVersion: string | null = null;
  #permissionMode: string | null = null;
  #effort: string | null = null;
  #skills: readonly string[] | null = null;
  #pluginErrors: AgentReceiptFact['pluginErrors'] = null;
  #mcpServers = new Map<string, string>();
  #mcpReported = false;
  /** Whether the opening answers are all in, so a receipt may be sent. */
  #opened = false;
  #receipt = '';
  readonly #usage = new Map<string, TurnUsage>();
  readonly #running = new Map<string, RunningTaskEntry>();
  /** The sub-agents settled since the turn began, by thread. */
  readonly #settled = new Map<string, SettledTaskEntry>();
  /** The tasks fact last sent, as its key: none yet reads as nothing running and nothing settled. */
  #runningSent = JSON.stringify([[], []]);
  /** A sub-agent's thread, mapped to the collaboration call that started it. */
  readonly #spawnedBy = new Map<string, string>();

  fromMessage(message: CodexMessage): LiftedFacts {
    if (message.kind === 'answer') return this.#fromAnswer(message);
    if (message.kind !== 'notification') return NOTHING;
    const { method, params } = message;
    switch (method) {
      case 'thread/tokenUsage/updated':
        return this.#fromUsage(params);
      case 'turn/started': {
        // A sub-agent settled in the turn before no longer stands; said once, when one had settled.
        const thread = params['threadId'];
        if (typeof thread !== 'string' || !this.#onThread(thread) || this.#settled.size === 0) return NOTHING;
        this.#settled.clear();
        return facts(this.#tasksIfChanged());
      }
      case 'turn/completed':
        return this.#fromTurnCompleted(params);
      case 'model/rerouted': {
        const rerouted = parsed(ModelRerouted, params);
        if (rerouted === null || !this.#onThread(rerouted.threadId)) return NOTHING;
        this.#model = rerouted.toModel;
        return facts(this.#receiptIfChanged('runtime'));
      }
      case 'mcpServer/startupStatus/updated': {
        const status = parsed(McpServerStartupStatus, params);
        if (status === null) return NOTHING;
        this.#mcpServers.set(status.name, status.status);
        this.#mcpReported = true;
        return facts(this.#receiptIfChanged('runtime'));
      }
      case 'item/started':
      case 'item/completed':
        return this.#fromItem(method, params);
      case 'item/agentMessage/delta':
        return this.#fragment('text', params);
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        return this.#fragment('thinking', params);
      default:
        return NOTHING;
    }
  }

  fromCompaction(report: CompactionReport): readonly AgentFact[] {
    return [
      {
        kind: 'compaction',
        runtime: CODEX_RUNTIME,
        status: report.status,
        trigger: report.trigger,
        tokensBefore: report.tokensBefore,
        tokensAfter: report.tokensAfter,
      },
    ];
  }

  #onThread(threadId: string): boolean {
    return this.#thread !== null && threadId === this.#thread;
  }

  #fromAnswer(message: Extract<CodexMessage, { kind: 'answer' }>): LiftedFacts {
    const out: AgentFact[] = [];
    switch (message.method) {
      case 'initialize': {
        const userAgent = message.result['userAgent'];
        this.#runtimeVersion = typeof userAgent === 'string' ? userAgentVersion(userAgent) : null;
        break;
      }
      case 'thread/start':
      case 'thread/resume':
      case 'thread/fork': {
        const opened = parsed(ThreadOpenResponse, message.result);
        if (opened === null) break;
        this.#thread = opened.thread.id;
        this.#model = opened.model;
        this.#permissionMode = typeof opened.approvalPolicy === 'string' ? opened.approvalPolicy : null;
        this.#effort = opened.reasoningEffort ?? null;
        if (!this.#handleSent) {
          this.#handleSent = true;
          out.push({ kind: 'session_handle', runtime: CODEX_RUNTIME, handle: opened.thread.id });
        }
        break;
      }
      case 'skills/list': {
        const listed = parsed(SkillsListResponse, message.result);
        this.#skills =
          listed === null
            ? null
            : bounded(listed.data.flatMap((entry) => entry.skills.map((skill) => text(skill.name))));
        // The directories this host left out first, then what Codex reported for the ones it took.
        const undelivered = this.#undelivered.map((error) => ({
          plugin: text(error.plugin),
          type: error.type,
          message: text(error.message),
          path: error.path === null ? null : text(error.path),
        }));
        this.#pluginErrors =
          listed === null
            ? undelivered.length === 0
              ? null
              : bounded(undelivered)
            : bounded([
                ...undelivered,
                ...listed.data.flatMap((entry) =>
                  entry.errors.map((error) => ({
                    plugin: text(error.path),
                    type: 'skill',
                    message: text(error.message),
                    path: text(error.path),
                  })),
                ),
              ]);
        if (this.#opened) out.push(...this.#receiptIfChanged('runtime'));
        break;
      }
      case 'mcpServerStatus/list': {
        const listed = parsed(McpServerStatusListResponse, message.result);
        if (listed !== null) {
          this.#mcpReported = true;
          for (const server of listed.data)
            this.#mcpServers.set(server.name, server.runtimeStatus ?? 'unknown');
        }
        // The last of the opening answers: the receipt the session opens with goes out here.
        this.#opened = true;
        out.push(...this.#receiptIfChanged('runtime'));
        break;
      }
      case 'turn/start': {
        const sent = message.params;
        let applied = false;
        if (typeof sent['model'] === 'string') {
          this.#model = sent['model'];
          applied = true;
        }
        if (typeof sent['effort'] === 'string') {
          this.#effort = sent['effort'];
          applied = true;
        }
        if (typeof sent['approvalPolicy'] === 'string') {
          this.#permissionMode = sent['approvalPolicy'];
          applied = true;
        }
        if (applied && this.#opened) out.push(...this.#receiptIfChanged('host'));
        break;
      }
      default:
        break;
    }
    return facts(out);
  }

  /** The receipt as it stands, or nothing when no member moved since the last one sent. */
  #receiptIfChanged(source: 'runtime' | 'host'): AgentFact[] {
    if (!this.#opened) return [];
    const receipt: AgentReceiptFact = {
      kind: 'agent_receipt',
      runtime: CODEX_RUNTIME,
      runtimeVersion: this.#runtimeVersion,
      model: this.#model === null ? null : text(this.#model),
      permissionMode: this.#permissionMode,
      effort: this.#effort,
      skills: this.#skills,
      // The configured plugin directories reach a Codex session through its skill roots; until a
      // session is given them, none are reported.
      plugins: null,
      pluginErrors: this.#pluginErrors,
      mcpServers: this.#mcpReported
        ? bounded([...this.#mcpServers].map(([name, status]) => ({ name: text(name), status })))
        : null,
      source,
      // The thread's answer always states its effort, null when none is in force.
      effortReported: true,
    };
    const { source: _source, ...members } = receipt;
    const key = JSON.stringify(members);
    if (key === this.#receipt) return [];
    this.#receipt = key;
    return [receipt];
  }

  #fromUsage(params: Readonly<Record<string, unknown>>): LiftedFacts {
    const usage = parsed(ThreadTokenUsageUpdated, params);
    if (usage === null) return NOTHING;
    const window = usage.tokenUsage.modelContextWindow ?? null;
    const main = this.#onThread(usage.threadId);
    if (main) this.#usage.set(usage.turnId, { total: usage.tokenUsage.total, window });
    return facts([
      {
        kind: 'usage_sample',
        runtime: CODEX_RUNTIME,
        model: this.#model === null ? null : text(this.#model),
        contextTokens: wholeOrNull(usage.tokenUsage.last.totalTokens),
        contextWindow: wholeOrNull(window),
        cacheTtl: null,
        mainThread: main,
        cacheReadTokens: wholeOrNull(usage.tokenUsage.last.cachedInputTokens),
      },
    ]);
  }

  #fromTurnCompleted(params: Readonly<Record<string, unknown>>): LiftedFacts {
    const completed = parsed(TurnNotification, params);
    if (completed === null || !this.#onThread(completed.threadId)) return NOTHING;
    const usage = this.#usage.get(completed.turn.id) ?? null;
    this.#usage.delete(completed.turn.id);
    return facts([
      {
        kind: 'turn_record',
        runtime: CODEX_RUNTIME,
        // No model in the register means no thread answer was read: no model key is invented.
        totals: usage === null || this.#model === null ? null : this.#spend(usage, this.#model),
        turn: null,
        turnScope: null,
        numTurns: null,
        durationMs: wholeOrNull(completed.turn.durationMs ?? null),
        sourceSessionId: completed.threadId,
      },
    ]);
  }

  #spend(usage: TurnUsage, model: string): SpendFacts {
    const total = usage.total;
    const row: ModelSpendFact = {
      model: text(model),
      canonicalModel: null,
      provider: null,
      inputTokens: Math.max(0, whole(total.inputTokens) - whole(total.cachedInputTokens)),
      outputTokens: whole(total.outputTokens),
      cacheReadTokens: whole(total.cachedInputTokens),
      cacheWriteTokens: whole(total.cacheWriteInputTokens ?? 0),
      reasoningTokens: whole(total.reasoningOutputTokens),
      cost: null,
      costBasis: 'unreported',
      contextWindow: wholeOrNull(usage.window),
    };
    return { cost: null, currency: null, costBasis: 'unreported', byModel: [row] };
  }

  #fromItem(method: string, params: Readonly<Record<string, unknown>>): LiftedFacts {
    const notification = parsed(ItemNotification, params);
    if (notification === null) return NOTHING;
    const item = notification.item as Readonly<Record<string, unknown>> & { type: string; id: string };
    const started = method === 'item/started';
    if (item.type === 'collabAgentToolCall') {
      const receivers = Array.isArray(item['receiverThreadIds'])
        ? item['receiverThreadIds'].filter((id): id is string => typeof id === 'string')
        : [];
      const tool = item['tool'];
      if (started) {
        for (const receiver of receivers) this.#spawnedBy.set(receiver, item.id);
        return NOTHING;
      }
      if (tool === 'spawnAgent') {
        const prompt = typeof item['prompt'] === 'string' ? text(item['prompt']) : null;
        for (const receiver of receivers) {
          this.#spawnedBy.set(receiver, item.id);
          this.#running.set(receiver, { taskId: receiver, type: SUBAGENT_TASK_TYPE, description: prompt });
        }
      }
      if (tool === 'closeAgent') for (const receiver of receivers) this.#running.delete(receiver);
      const states = item['agentsStates'];
      if (typeof states === 'object' && states !== null) {
        for (const [agent, state] of Object.entries(states as Record<string, unknown>)) {
          const status = (state as { status?: unknown } | null)?.status;
          const settled = typeof status === 'string' ? settlementOf(SETTLED_AGENT_STATES, status) : null;
          if (settled === null) continue;
          this.#running.delete(agent);
          this.#settle(agent, settled);
        }
      }
      return facts(this.#tasksIfChanged());
    }
    if (item.type === 'subAgentActivity') {
      const agent = item['agentThreadId'];
      const kind = item['kind'];
      if (typeof agent !== 'string') return NOTHING;
      if (kind === 'started' && !this.#running.has(agent)) {
        this.#running.set(agent, { taskId: agent, type: SUBAGENT_TASK_TYPE, description: null });
      }
      const settled = typeof kind === 'string' ? settlementOf(SETTLED_ACTIVITY, kind) : null;
      if (settled !== null) {
        this.#running.delete(agent);
        this.#settle(agent, settled);
      }
      return facts(this.#tasksIfChanged());
    }
    return NOTHING;
  }

  /** A sub-agent ended, as `status` says; the first ending the turn reports for it stands. */
  #settle(agent: string, status: TaskSettlement): void {
    if (!this.#settled.has(agent))
      this.#settled.set(agent, { taskId: agent, type: SUBAGENT_TASK_TYPE, status });
  }

  #tasksIfChanged(): AgentFact[] {
    const running = bounded([...this.#running.values()]);
    const settled = bounded([...this.#settled.values()]);
    const key = JSON.stringify([running, settled]);
    if (key === this.#runningSent) return [];
    this.#runningSent = key;
    return [{ kind: 'tasks', runtime: CODEX_RUNTIME, running, settled }];
  }

  #fragment(channel: 'text' | 'thinking', params: Readonly<Record<string, unknown>>): LiftedFacts {
    const delta = parsed(ContentDelta, params);
    if (delta === null) return NOTHING;
    // A sub-agent speaks on a thread of its own; its fragment names the collaboration call that
    // started it where Codex said which, and null otherwise. Never the delta's own item.
    const parentId = this.#onThread(delta.threadId) ? null : (this.#spawnedBy.get(delta.threadId) ?? null);
    const fragment: AgentFragmentDelta = {
      update: 'agent_fragment',
      runtime: CODEX_RUNTIME,
      channel,
      text: delta.delta,
      parentId,
    };
    return { facts: [], fragments: [fragment] };
  }
}

/** How a word in `table` says a sub-agent ended, or null for a word that ends none. */
function settlementOf(table: Readonly<Record<string, TaskSettlement>>, word: string): TaskSettlement | null {
  return Object.hasOwn(table, word) ? (table[word] ?? null) : null;
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

/** The native id a fact lifted from `message` names: the turn's for a record, the item's for tasks. */
export function codexFactSourceId(message: CodexMessage, fact: AgentFact): string | null {
  if (message.kind !== 'notification') return null;
  if (fact.kind === 'turn_record') {
    const turn = parsed(TurnNotification, message.params);
    return turn?.turn.id ?? null;
  }
  if (fact.kind === 'tasks') {
    const item = parsed(ItemNotification, message.params);
    return item?.item.id ?? null;
  }
  return null;
}
