/**
 * The opencode lift: the facts a controller acts on, read out of what an opencode process yields, the
 * server's stream and the open this host proved.
 *
 * Every figure is one the server reported, or null; nothing is computed from another figure, and nothing is
 * summed. What each fact is read from:
 *   - `session_handle`: the session id the open names. A resume or a fork reports its own.
 *   - `agent_receipt`: the runtime's own (`source: 'runtime'`) once the session opens: the model the session
 *     runs on (`session.model.selected` after the open), the agent as its permission mode (`build` or
 *     `plan`), and the skills this host handed over; sent again whenever one of them moves.
 *   - `turn_record`: one per model call (`session.step.ended`, and a `session.step.failed` that reports
 *     tokens), the session's own or a subagent's session's, filed as that step's figure (`turnScope:
 *     'step'`), never as a running total, under the model the step started on (`session.step.started`),
 *     else the session's. Its cost is the server's, in US dollars, and is filed as the
 *     provider's (`provider-reported`) only when it is above zero: a session reaches no model but its own
 *     endpoint's, which opencode's catalogue does not price, so a cost above zero is the provider's own figure
 *     and a zero is no cost reported (`null`, `unreported`).
 *   - `tasks`: each subagent's session, named by the call that started it, running while it runs
 *     (`session.execution.started`) until its run ends; the settled ones start over with the session's own
 *     next run.
 *   - `compaction`: each compaction the observer reports.
 * And one fragment per streamed delta: text, thinking, or a piece of a tool call's input, each naming the call
 * that started the subagent speaking where there is one.
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
} from '../control/frames.js';
import { MAX_FACT_LIST_ENTRIES, MAX_FACT_WORD_LENGTH } from '../control/frames.js';
import { cutText, factText } from '../control/fact-text.js';
import { fitTasks } from '../control/tasks-budget.js';
import type { FactLift, LiftedFacts } from '../sessions/fact-lift.js';
import { OPENCODE_RUNTIME } from '../sessions/runtimes.js';
import type { CompactionReport } from '../state/observer.js';
import { OPENCODE_SDK_PINNED_VERSION } from './opencode-sdk.js';
import type { OpencodeMessage } from './opencode-wire.js';
import {
  opencodeCount,
  opencodeData,
  opencodeModelName,
  opencodeRecord,
  opencodeWord,
} from './opencode-wire.js';

const NOTHING: LiftedFacts = { facts: [], fragments: [] };

/** How many started steps' models one session keeps until their steps end. */
const MAX_OPEN_STEPS = 256;

/** The fragment each streamed delta is. */
const FRAGMENT_CHANNELS: Readonly<Record<string, AgentFragmentDelta['channel']>> = {
  'session.text.delta': 'text',
  'session.reasoning.delta': 'thinking',
  'session.tool.input.delta': 'tool_input',
};

export interface OpencodeFactLiftOptions {
  /** The plugin directories this host could not hand the session, reported among its plugin errors. */
  readonly undeliveredPlugins?: readonly ReceiptPluginError[];
  /** The skills this host handed over, by name. */
  readonly handedOverSkills?: readonly string[];
}

export class OpencodeFactLift implements FactLift<OpencodeMessage> {
  readonly #undelivered: readonly ReceiptPluginError[];
  readonly #skills: readonly string[] | null;
  #handle: string | null = null;
  /** The model register: what the session's usage is filed under. */
  #model: string | null = null;
  #agent: string | null = null;
  /** Whether the open was proven, so a receipt of the runtime's may be sent. */
  #opened = false;
  /** The receipt last sent, as its key: a receipt is sent only when a member moved. */
  #receiptSent = '';
  /** Whether the session's own run is running, so the settled tasks start over with the next one. */
  #running = false;
  /** Each subagent's session's model, by session id. */
  readonly #models = new Map<string, string>();
  /** The model each started step runs on, by the step's message id, until the step ends. */
  readonly #steps = new Map<string, string>();
  readonly #tasks = new Map<string, RunningTaskEntry>();
  #settled: SettledTaskEntry[] = [];

  constructor(options: OpencodeFactLiftOptions = {}) {
    this.#undelivered = options.undeliveredPlugins ?? [];
    this.#skills =
      options.handedOverSkills === undefined ? null : bounded(options.handedOverSkills.map(factText));
  }

  fromMessage(message: OpencodeMessage): LiftedFacts {
    if (message.kind === 'opened') {
      const out: AgentFact[] = [...this.#handleIfChanged(message.sessionId)];
      if (message.model !== null) this.#model = message.model;
      this.#agent = message.agent;
      this.#opened = true;
      out.push(...this.#receiptIfChanged());
      return facts(out);
    }
    const event = message.event;
    const data = opencodeData(event);
    switch (event.type) {
      case 'session.created': {
        const model = opencodeModelName(data['model']);
        const session = message.session;
        if (session !== null && model !== null && !message.main) this.#models.set(session, model);
        return NOTHING;
      }
      case 'session.model.selected': {
        const model = opencodeModelName(data['model']);
        if (model === null) return NOTHING;
        if (!message.main) {
          if (message.session !== null) this.#models.set(message.session, model);
          return NOTHING;
        }
        this.#model = model;
        return facts(this.#receiptIfChanged());
      }
      case 'session.agent.selected': {
        if (!message.main) return NOTHING;
        this.#agent = opencodeWord(data['agent']) ?? this.#agent;
        return facts(this.#receiptIfChanged());
      }
      case 'session.step.started': {
        const model = opencodeModelName(data['model']);
        const step = opencodeWord(data['assistantMessageID']);
        if (model === null || step === null) return NOTHING;
        if (this.#steps.size >= MAX_OPEN_STEPS) {
          const oldest = this.#steps.keys().next().value;
          if (oldest !== undefined) this.#steps.delete(oldest);
        }
        this.#steps.set(step, model);
        return NOTHING;
      }
      case 'session.step.ended':
      case 'session.step.failed':
        return this.#fromStep(message, data);
      case 'session.execution.started':
        return this.#runStarted(message);
      case 'session.execution.succeeded':
        return this.#runEnded(message, 'completed');
      case 'session.execution.failed':
        return this.#runEnded(message, 'failed', data);
      case 'session.execution.interrupted':
        return this.#runEnded(message, 'stopped');
      default:
        return this.#fragment(message, data);
    }
  }

  fromCompaction(report: CompactionReport): readonly AgentFact[] {
    return [
      {
        kind: 'compaction',
        runtime: OPENCODE_RUNTIME,
        status: report.status,
        trigger: report.trigger,
        tokensBefore: report.tokensBefore,
        tokensAfter: report.tokensAfter,
        ...(report.outcome === undefined ? {} : { outcome: report.outcome }),
      },
    ];
  }

  #fromStep(
    message: Extract<OpencodeMessage, { kind: 'event' }>,
    data: Readonly<Record<string, unknown>>,
  ): LiftedFacts {
    const step = opencodeWord(data['assistantMessageID']);
    const started = step === null ? undefined : this.#steps.get(step);
    if (step !== null) this.#steps.delete(step);
    const tokens = opencodeRecord(data['tokens']);
    if (Object.keys(tokens).length === 0) return NOTHING;
    const model =
      started ?? (message.main ? this.#model : (this.#models.get(message.session ?? '') ?? this.#model));
    if (model === null) return NOTHING;
    const cache = opencodeRecord(tokens['cache']);
    const reported = typeof data['cost'] === 'number' && Number.isFinite(data['cost']) && data['cost'] > 0;
    const cost = reported ? (data['cost'] as number) : null;
    const row: ModelSpendFact = {
      model: factText(model),
      canonicalModel: null,
      provider: null,
      inputTokens: opencodeCount(tokens['input']) ?? 0,
      outputTokens: opencodeCount(tokens['output']) ?? 0,
      cacheReadTokens: opencodeCount(cache['read']) ?? 0,
      cacheWriteTokens: opencodeCount(cache['write']) ?? 0,
      reasoningTokens: opencodeCount(tokens['reasoning']),
      cost,
      costBasis: reported ? 'provider-reported' : 'unreported',
      contextWindow: null,
    };
    return facts([
      {
        kind: 'turn_record',
        runtime: OPENCODE_RUNTIME,
        totals: null,
        turn: {
          cost,
          currency: reported ? 'USD' : null,
          costBasis: reported ? 'provider-reported' : 'unreported',
          byModel: [row],
        },
        turnScope: 'step',
        numTurns: null,
        durationMs: null,
        sourceSessionId: message.session ?? this.#handle,
      },
    ]);
  }

  #runStarted(message: Extract<OpencodeMessage, { kind: 'event' }>): LiftedFacts {
    if (message.main) {
      if (!this.#running) {
        this.#running = true;
        this.#settled = [];
      }
      return NOTHING;
    }
    const session = message.session;
    const spawnedBy = message.spawnedBy;
    if (session === null || spawnedBy === null) return NOTHING;
    this.#tasks.set(session, {
      taskId: factText(session),
      type: 'subagent',
      description: null,
      toolUseId: factText(spawnedBy),
    });
    return facts([this.#tasksFact()]);
  }

  #runEnded(
    message: Extract<OpencodeMessage, { kind: 'event' }>,
    status: SettledTaskEntry['status'],
    data?: Readonly<Record<string, unknown>>,
  ): LiftedFacts {
    if (message.main) {
      this.#running = false;
      return NOTHING;
    }
    const session = message.session;
    if (session === null) return NOTHING;
    const started = this.#tasks.get(session);
    if (started === undefined) return NOTHING;
    this.#tasks.delete(session);
    const error = data === undefined ? null : opencodeRecord(data['error']);
    const words = error === null ? null : opencodeWord(error['message']);
    this.#settled = [
      ...this.#settled.filter((task) => task.taskId !== started.taskId),
      {
        taskId: started.taskId,
        type: started.type,
        status,
        toolUseId: started.toolUseId ?? null,
        ...(status === 'failed' && words !== null ? { summary: factText(words) } : {}),
      },
    ].slice(-MAX_FACT_LIST_ENTRIES);
    return facts([this.#tasksFact()]);
  }

  #tasksFact(): AgentFact {
    const { running, settled } = fitTasks([...this.#tasks.values()], this.#settled);
    return { kind: 'tasks', runtime: OPENCODE_RUNTIME, running, settled };
  }

  #fragment(
    message: Extract<OpencodeMessage, { kind: 'event' }>,
    data: Readonly<Record<string, unknown>>,
  ): LiftedFacts {
    const channel = Object.hasOwn(FRAGMENT_CHANNELS, message.event.type)
      ? FRAGMENT_CHANNELS[message.event.type]
      : undefined;
    if (channel === undefined) return NOTHING;
    const delta = data['delta'];
    if (typeof delta !== 'string' || delta === '') return NOTHING;
    // A subagent's delta whose starting call is not known cannot be told from the session's own: it rides
    // its native message alone, rather than as the session's own text.
    if (!message.main && message.spawnedBy === null) return NOTHING;
    const fragment: AgentFragmentDelta = {
      update: 'agent_fragment',
      runtime: OPENCODE_RUNTIME,
      channel,
      text: delta,
      parentId: message.main ? null : message.spawnedBy,
    };
    return { facts: [], fragments: [fragment] };
  }

  #handleIfChanged(id: string): AgentFact[] {
    if (id === '' || id === this.#handle) return [];
    this.#handle = id;
    return [{ kind: 'session_handle', runtime: OPENCODE_RUNTIME, handle: factText(id) }];
  }

  #receiptFact(): AgentReceiptFact {
    return {
      kind: 'agent_receipt',
      runtime: OPENCODE_RUNTIME,
      runtimeVersion: OPENCODE_SDK_PINNED_VERSION,
      model: this.#model === null ? null : factText(this.#model),
      permissionMode: this.#agent === null ? null : word(this.#agent),
      // opencode sets reasoning through a model's variants, and this host's endpoints declare none.
      effort: null,
      skills: this.#skills,
      // The plugin directories reach an opencode session as skill paths; no plugin itself loads.
      plugins: null,
      pluginErrors:
        this.#undelivered.length === 0
          ? null
          : bounded(
              this.#undelivered.map((error) => ({
                plugin: factText(error.plugin),
                type: error.type,
                message: factText(error.message),
                path: error.path === null ? null : factText(error.path),
              })),
            ),
      mcpServers: null,
      source: 'runtime',
      effortReported: false,
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

function facts(list: readonly AgentFact[]): LiftedFacts {
  return list.length === 0 ? NOTHING : { facts: list, fragments: [] };
}

function bounded<T>(list: readonly T[]): T[] {
  return list.slice(0, MAX_FACT_LIST_ENTRIES);
}

function word(value: string): string {
  return cutText(value, MAX_FACT_WORD_LENGTH);
}

/** The native id a fact lifted from an opencode message names: an event's own id; the open has none. */
export function opencodeFactSourceId(message: OpencodeMessage): string | null {
  return message.kind === 'event' ? opencodeWord(message.event.id) : null;
}
