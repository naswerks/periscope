/**
 * The Copilot lift: the facts a controller acts on, read out of what a Copilot process yields, its session
 * events and the open this host proved.
 *
 * Every figure is one the runtime reported, or null; nothing is computed from another figure but the one
 * split every runtime's spend makes (uncached input), and nothing is summed. What each fact is read from:
 *   - `session_handle`: the session id the open names. A resume or a fork reports its own.
 *   - `agent_receipt`: the runtime's own (`source: 'runtime'`) once the session opens: the model and effort
 *     `session.start` or `session.resume` named, the agent mode as its permission mode (`interactive` or
 *     `plan`; the permission mode itself is always `manual`), the skills `session.skills_loaded` names (the
 *     ones this host handed over until then) and the servers `session.mcp_servers_loaded` names, each with
 *     its status in the runtime's word; sent again whenever one of them moves.
 *   - `turn_record`: one per model call (`assistant.usage`), filed as that step's figure (`turnScope:
 *     'step'`), never as a running total; and the session's totals per model when it shuts down
 *     (`session.shutdown`). Neither is priced: the runtime's `cost` is a multiplier and its credit totals a
 *     unit of its own, so `cost` is null and the basis `unreported`. `inputTokens` is the input minus the
 *     cache reads, floored at zero: the runtime counts the cached input inside its input, as the providers
 *     it calls do.
 *   - `usage_sample`: each `session.usage_info`: the context's tokens and the model's window, as the runtime
 *     counts them, with the last model call's cache reads.
 *   - `tasks`: each sub-agent the runtime starts (`subagent.started`), named by the call that spawned it,
 *     running until `subagent.completed` or `subagent.failed` settles it; the settled ones start over with
 *     each run.
 *   - `compaction`: each compaction the observer reports.
 * And one fragment per streamed delta: text, thinking, or a piece of a tool call's input, each naming the
 * call that spawned the sub-agent speaking where the runtime names it.
 *
 * A fact lifted from an event names the event's own id as its source.
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
} from '../control/frames.js';
import { cutText } from '../control/fact-text.js';
import { MAX_FACT_LIST_ENTRIES, MAX_FACT_TEXT_LENGTH, MAX_FACT_WORD_LENGTH } from '../control/frames.js';
import { fitTasks } from '../control/tasks-budget.js';
import type { FactLift, LiftedFacts } from '../sessions/fact-lift.js';
import { COPILOT_RUNTIME } from '../sessions/runtimes.js';
import type { CompactionReport } from '../state/observer.js';
import type { CopilotEvent } from './copilot-sdk.js';
import { COPILOT_RUNTIME_PINNED_VERSION } from './copilot-sdk.js';
import type { CopilotMessage } from './copilot-wire.js';
import {
  copilotCount,
  copilotData,
  copilotRecord,
  copilotSpawnedBy,
  copilotWord,
  isCopilotMainThread,
} from './copilot-wire.js';

const NOTHING: LiftedFacts = { facts: [], fragments: [] };

/** The fragment each streamed delta is, and the member its text rides in. */
const FRAGMENT_CHANNELS: Readonly<
  Record<string, { readonly channel: AgentFragmentDelta['channel']; readonly member: string }>
> = {
  'assistant.message_delta': { channel: 'text', member: 'deltaContent' },
  'assistant.reasoning_delta': { channel: 'thinking', member: 'deltaContent' },
  'assistant.tool_call_delta': { channel: 'tool_input', member: 'inputDelta' },
};

export interface CopilotFactLiftOptions {
  /** The plugin directories this host could not hand the session, reported among its plugin errors. */
  readonly undeliveredPlugins?: readonly ReceiptPluginError[];
  /** The skills this host handed over, by name: the receipt's until the runtime names its own. */
  readonly handedOverSkills?: readonly string[];
}

/** What one sub-agent's own events said of it. */
interface AgentRegisters {
  model: string | null;
  lastCacheRead: number | null;
}

export class CopilotFactLift implements FactLift<CopilotMessage> {
  readonly #undelivered: readonly ReceiptPluginError[];
  #handle: string | null = null;
  /** The model register: what the session's usage is filed under. */
  #model: string | null = null;
  #effort: string | null = null;
  #effortReported = false;
  #agentMode: string | null = null;
  #skills: readonly string[] | null;
  #servers = new Map<string, string>();
  #serversReported = false;
  /** Whether the open was proven, so a receipt of the runtime's may be sent. */
  #opened = false;
  /** The receipt last sent, as its key: a receipt is sent only when a member moved. */
  #receiptSent = '';
  /** The last model call's cache reads, for the next usage sample. */
  #lastCacheRead: number | null = null;
  /**
   * What each sub-agent's own events said of it, by its id: its model, and its last model call's cache
   * reads. A sub-agent's events carry the session-scoped kinds too, and none of them moves a register of
   * the session's.
   */
  readonly #agents = new Map<string, AgentRegisters>();
  /** Whether a run is running, so the settled tasks start over with the next one. */
  #running = false;
  readonly #tasks = new Map<string, RunningTaskEntry>();
  #settled: SettledTaskEntry[] = [];

  constructor(options: CopilotFactLiftOptions = {}) {
    this.#undelivered = options.undeliveredPlugins ?? [];
    this.#skills =
      options.handedOverSkills === undefined ? null : bounded(options.handedOverSkills.map(text));
  }

  fromMessage(message: CopilotMessage): LiftedFacts {
    if (message.kind === 'opened') {
      const out: AgentFact[] = [...this.#handleIfChanged(message.sessionId)];
      if (message.model !== null) this.#model = message.model;
      this.#agentMode = message.agentMode;
      this.#opened = true;
      out.push(...this.#receiptIfChanged());
      return facts(out);
    }
    return this.#fromEvent(message.event);
  }

  fromCompaction(report: CompactionReport): readonly AgentFact[] {
    return [
      {
        kind: 'compaction',
        runtime: COPILOT_RUNTIME,
        status: report.status,
        trigger: report.trigger,
        tokensBefore: report.tokensBefore,
        tokensAfter: report.tokensAfter,
        ...(report.outcome === undefined ? {} : { outcome: report.outcome }),
      },
    ];
  }

  /** The registers of the sub-agent an event belongs to; null for the session's own event. */
  #agentOf(event: CopilotEvent): AgentRegisters | null {
    if (isCopilotMainThread(event)) return null;
    const id = copilotWord(event.agentId) ?? copilotSpawnedBy(event) ?? '';
    const known = this.#agents.get(id);
    if (known !== undefined) return known;
    if (this.#agents.size >= MAX_FACT_LIST_ENTRIES) {
      const oldest = this.#agents.keys().next().value;
      if (oldest !== undefined) this.#agents.delete(oldest);
    }
    const made: AgentRegisters = { model: null, lastCacheRead: null };
    this.#agents.set(id, made);
    return made;
  }

  #fromEvent(event: CopilotEvent): LiftedFacts {
    const data = copilotData(event);
    const main = isCopilotMainThread(event);
    const agent = this.#agentOf(event);
    switch (event.type) {
      case 'session.start':
      case 'session.resume': {
        if (agent !== null) {
          agent.model = copilotWord(data['selectedModel']) ?? agent.model;
          return NOTHING;
        }
        this.#model = copilotWord(data['selectedModel']) ?? this.#model;
        if (Object.hasOwn(data, 'reasoningEffort')) {
          this.#effort = copilotWord(data['reasoningEffort']);
          this.#effortReported = true;
        }
        return facts(this.#receiptIfChanged());
      }
      case 'session.model_change': {
        if (agent !== null) {
          agent.model = copilotWord(data['newModel']) ?? agent.model;
          return NOTHING;
        }
        this.#model = copilotWord(data['newModel']) ?? this.#model;
        if (Object.hasOwn(data, 'reasoningEffort')) {
          this.#effort = copilotWord(data['reasoningEffort']);
          this.#effortReported = true;
        }
        return facts(this.#receiptIfChanged());
      }
      case 'session.mode_changed': {
        if (!main) return NOTHING;
        this.#agentMode = copilotWord(data['newMode']) ?? this.#agentMode;
        return facts(this.#receiptIfChanged());
      }
      case 'session.skills_loaded': {
        if (!main) return NOTHING;
        const skills = Array.isArray(data['skills']) ? data['skills'] : [];
        this.#skills = bounded(
          skills
            .map((skill) => copilotRecord(skill))
            .filter((skill) => skill['enabled'] !== false)
            .map((skill) => copilotWord(skill['name']))
            .filter((name): name is string => name !== null)
            .map(text),
        );
        return facts(this.#receiptIfChanged());
      }
      case 'session.mcp_servers_loaded': {
        if (!main) return NOTHING;
        const servers = Array.isArray(data['servers']) ? data['servers'] : [];
        this.#servers = new Map();
        for (const server of servers.map((one) => copilotRecord(one))) {
          const name = copilotWord(server['name']);
          if (name !== null) this.#servers.set(name, copilotWord(server['status']) ?? 'unknown');
        }
        this.#serversReported = true;
        return facts(this.#receiptIfChanged());
      }
      case 'session.mcp_server_status_changed': {
        const name = copilotWord(data['serverName']);
        if (name === null || !main) return NOTHING;
        this.#servers.set(name, copilotWord(data['status']) ?? 'unknown');
        this.#serversReported = true;
        return facts(this.#receiptIfChanged());
      }
      case 'assistant.usage':
        return this.#fromUsage(data, agent);
      case 'session.usage_info': {
        // A sub-agent's sample is filed under its own model where it named one, and its own cache reads.
        const model = agent === null ? this.#model : (agent.model ?? this.#model);
        return facts([
          {
            kind: 'usage_sample',
            runtime: COPILOT_RUNTIME,
            model: model === null ? null : text(model),
            contextTokens: copilotCount(data['currentTokens']),
            contextWindow: copilotCount(data['tokenLimit']),
            cacheTtl: null,
            mainThread: main,
            cacheReadTokens: agent === null ? this.#lastCacheRead : agent.lastCacheRead,
          },
        ]);
      }
      case 'session.shutdown':
        return this.#fromShutdown(data);
      case 'user.message': {
        if (!main || this.#running) return NOTHING;
        this.#running = true;
        // A sub-agent settled in the run before no longer stands; said once, when one had settled.
        if (this.#settled.length === 0) return NOTHING;
        this.#settled = [];
        return facts([this.#tasksFact()]);
      }
      case 'session.idle':
        if (main) this.#running = false;
        return NOTHING;
      case 'subagent.started':
        return this.#taskStarted(data);
      case 'subagent.completed':
        return this.#taskSettled(data, data['cancelled'] === true ? 'stopped' : 'completed');
      case 'subagent.failed':
        return this.#taskSettled(data, 'failed');
      default:
        return this.#fragment(event, data);
    }
  }

  #fromUsage(data: Readonly<Record<string, unknown>>, agent: AgentRegisters | null): LiftedFacts {
    const model = copilotWord(data['model']) ?? agent?.model ?? this.#model;
    const cacheRead = copilotCount(data['cacheReadTokens']);
    if (agent === null) this.#lastCacheRead = cacheRead;
    else agent.lastCacheRead = cacheRead;
    if (model === null) return NOTHING;
    const row: ModelSpendFact = {
      model: text(model),
      canonicalModel: textOrNull(copilotWord(data['responseModel'])),
      provider: wordOrNull(copilotWord(data['modelProvider'])),
      inputTokens: Math.max(0, (copilotCount(data['inputTokens']) ?? 0) - (cacheRead ?? 0)),
      outputTokens: copilotCount(data['outputTokens']) ?? 0,
      cacheReadTokens: cacheRead ?? 0,
      cacheWriteTokens: copilotCount(data['cacheWriteTokens']) ?? 0,
      reasoningTokens: copilotCount(data['reasoningTokens']),
      cost: null,
      costBasis: 'unreported',
      contextWindow: null,
    };
    return facts([
      {
        kind: 'turn_record',
        runtime: COPILOT_RUNTIME,
        totals: null,
        turn: unpriced([row]),
        turnScope: 'step',
        numTurns: null,
        durationMs: copilotCount(data['duration']),
        sourceSessionId: this.#handle,
      },
    ]);
  }

  #fromShutdown(data: Readonly<Record<string, unknown>>): LiftedFacts {
    const metrics = copilotRecord(data['modelMetrics']);
    const rows: ModelSpendFact[] = [];
    for (const [model, metric] of Object.entries(metrics)) {
      const usage = copilotRecord(copilotRecord(metric)['usage']);
      const cacheRead = copilotCount(usage['cacheReadTokens']) ?? 0;
      rows.push({
        model: text(model),
        canonicalModel: null,
        provider: null,
        inputTokens: Math.max(0, (copilotCount(usage['inputTokens']) ?? 0) - cacheRead),
        outputTokens: copilotCount(usage['outputTokens']) ?? 0,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: copilotCount(usage['cacheWriteTokens']) ?? 0,
        reasoningTokens: copilotCount(usage['reasoningTokens']),
        cost: null,
        costBasis: 'unreported',
        contextWindow: null,
      });
    }
    if (rows.length === 0) return NOTHING;
    return facts([
      {
        kind: 'turn_record',
        runtime: COPILOT_RUNTIME,
        totals: unpriced(bounded(rows)),
        turn: null,
        turnScope: null,
        numTurns: null,
        durationMs: copilotCount(data['totalApiDurationMs']),
        sourceSessionId: this.#handle,
      },
    ]);
  }

  #taskStarted(data: Readonly<Record<string, unknown>>): LiftedFacts {
    const id = copilotWord(data['toolCallId']);
    if (id === null) return NOTHING;
    this.#tasks.set(id, {
      taskId: text(id),
      type: word(copilotWord(data['agentName']) ?? copilotWord(data['agentType']) ?? 'agent'),
      description: textOrNull(copilotWord(data['agentDescription'])),
      toolUseId: text(id),
    });
    return facts([this.#tasksFact()]);
  }

  #taskSettled(data: Readonly<Record<string, unknown>>, status: SettledTaskEntry['status']): LiftedFacts {
    const id = copilotWord(data['toolCallId']);
    if (id === null) return NOTHING;
    const started = this.#tasks.get(id);
    this.#tasks.delete(id);
    const usage = {
      tokens: copilotCount(data['totalTokens']),
      toolUses: copilotCount(data['totalToolCalls']),
      durationMs: copilotCount(data['durationMs']),
    };
    const reported = Object.values(usage).some((value) => value !== null);
    this.#settled = [
      ...this.#settled.filter((task) => task.taskId !== id),
      {
        taskId: text(id),
        type: started?.type ?? null,
        status,
        toolUseId: text(id),
        ...(reported ? { usage } : {}),
        ...(status === 'failed' && copilotWord(data['error']) !== null
          ? { summary: text(copilotWord(data['error']) ?? '') }
          : {}),
      },
    ].slice(-MAX_FACT_LIST_ENTRIES);
    return facts([this.#tasksFact()]);
  }

  #tasksFact(): AgentFact {
    const { running, settled } = fitTasks([...this.#tasks.values()], this.#settled);
    return { kind: 'tasks', runtime: COPILOT_RUNTIME, running, settled };
  }

  #fragment(event: CopilotEvent, data: Readonly<Record<string, unknown>>): LiftedFacts {
    const reading = Object.hasOwn(FRAGMENT_CHANNELS, event.type) ? FRAGMENT_CHANNELS[event.type] : undefined;
    if (reading === undefined) return NOTHING;
    const delta = data[reading.member];
    if (typeof delta !== 'string' || delta === '') return NOTHING;
    const parentId = copilotSpawnedBy(event);
    // A sub-agent's delta that names no spawning call cannot be told from the session's own: it rides its
    // native message alone, rather than as the session's own text.
    if (parentId === null && copilotWord(event.agentId) !== null) return NOTHING;
    const fragment: AgentFragmentDelta = {
      update: 'agent_fragment',
      runtime: COPILOT_RUNTIME,
      channel: reading.channel,
      text: delta,
      parentId,
    };
    return { facts: [], fragments: [fragment] };
  }

  #handleIfChanged(id: string): AgentFact[] {
    if (id === '' || id === this.#handle) return [];
    this.#handle = id;
    return [{ kind: 'session_handle', runtime: COPILOT_RUNTIME, handle: text(id) }];
  }

  #receiptFact(): AgentReceiptFact {
    return {
      kind: 'agent_receipt',
      runtime: COPILOT_RUNTIME,
      runtimeVersion: COPILOT_RUNTIME_PINNED_VERSION,
      model: this.#model === null ? null : text(this.#model),
      permissionMode: this.#agentMode === null ? null : word(this.#agentMode),
      effort: this.#effort === null ? null : word(this.#effort),
      skills: this.#skills,
      // The plugin directories reach a Copilot session as skill directories; no plugin itself loads.
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
      mcpServers: this.#serversReported
        ? bounded([...this.#servers].map(([name, status]) => ({ name: text(name), status: word(status) })))
        : null,
      source: 'runtime',
      effortReported: this.#effortReported,
    };
  }

  /** The receipt, or nothing when no member moved since the last one sent, or before the open is proven. */
  #receiptIfChanged(): AgentFact[] {
    if (!this.#opened) return [];
    const receipt = this.#receiptFact();
    const key = JSON.stringify(receipt);
    if (key === this.#receiptSent) return [];
    this.#receiptSent = key;
    return [receipt];
  }
}

/** A figure with no cost: the runtime prices nothing in money. */
function unpriced(byModel: readonly ModelSpendFact[]): SpendFacts {
  return { cost: null, currency: null, costBasis: 'unreported', byModel };
}

function facts(list: readonly AgentFact[]): LiftedFacts {
  return list.length === 0 ? NOTHING : { facts: list, fragments: [] };
}

function bounded<T>(list: readonly T[]): T[] {
  return list.slice(0, MAX_FACT_LIST_ENTRIES);
}

function text(value: string): string {
  return cutText(value, MAX_FACT_TEXT_LENGTH);
}

function textOrNull(value: string | null): string | null {
  return value === null ? null : text(value);
}

function word(value: string): string {
  return cutText(value, MAX_FACT_WORD_LENGTH);
}

function wordOrNull(value: string | null): string | null {
  return value === null ? null : word(value);
}

/** The native id a fact lifted from a Copilot message names: an event's own id; the open has none. */
export function copilotFactSourceId(message: CopilotMessage): string | null {
  return message.kind === 'event' ? (copilotWord(message.event.id) ?? null) : null;
}
