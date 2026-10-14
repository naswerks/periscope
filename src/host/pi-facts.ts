/**
 * The pi lift: the facts a controller acts on, read out of what a pi process yields, pi's events and its
 * answers to the commands the adapter sent.
 *
 * Every figure is one pi reported, or null; nothing is computed from another figure, and nothing is
 * summed. What each fact is read from:
 *   - `session_handle`: the session id the answer to `get_state` names.
 *   - `agent_receipt`: pi's own (`source: 'runtime'`) once the session opens: the model and thinking
 *     level its state names, the skills its command list names (`skill:<name>`, without the prefix) and
 *     the servers this host's extension registered, connected once their tools are listed; sent again
 *     whenever pi says its thinking level moved. A model this host set (pi writes no event for one) sends
 *     one composed by this host (`source: 'host'`), with the model pi answered with. pi has no permission
 *     mode, so the receipt states none.
 *   - `turn_record`: the answer to `get_session_stats`, asked after each run. `totals` is the session's
 *     tokens and cost as pi states them, every entry of the session file counted by pi (its compacted
 *     history, abandoned branches, failed retries and compaction calls included, so a total can exceed
 *     what the visible conversation used, and a resumed or forked session's includes the source
 *     session's). `turn` and `turnScope` are null: the totals carry the spend. The cost is pi's own
 *     estimate from its model catalogue (`catalogue-estimated`), in US dollars, never a bill.
 *     `inputTokens` is pi's own `input`, which pi counts without the cached input: the cache reads and
 *     writes are members of their own. pi's totals carry no reasoning figure.
 *   - `usage_sample`: the same answer's context usage: pi's own count of the context (null right after a
 *     compaction, until a new answer) and the model's window, with the last answer's cache reads.
 *   - `compaction`: each compaction the observer reports.
 * And one fragment per streamed delta: text, thinking, or a piece of a tool call's input.
 *
 * pi's messages carry no id of their own, so no fact names a source.
 */
import type {
  AgentFact,
  AgentFragmentDelta,
  AgentReceiptFact,
  JsonObject,
  ReceiptPluginError,
  SpendFacts,
} from '../control/frames.js';
import { MAX_FACT_LIST_ENTRIES, MAX_FACT_TEXT_LENGTH } from '../control/frames.js';
import type { FactLift, LiftedFacts } from '../sessions/fact-lift.js';
import { PI_RUNTIME } from '../sessions/runtimes.js';
import type { CompactionReport } from '../state/observer.js';
import { PI_PINNED_VERSION } from './pi-binary.js';
import type { PiHello } from './pi-extension.js';
import type { PiMessage } from './pi-wire.js';
import {
  PiCommands,
  PiMessageEnd,
  PiMessageUpdate,
  PiModel,
  PiSessionStats,
  PiState,
  PiThinkingLevelChanged,
  parsed,
  piTypeOf,
  responseData,
} from './pi-wire.js';
import type { z } from 'zod';

const NOTHING: LiftedFacts = { facts: [], fragments: [] };

/** The currency pi's model catalogue prices in. */
const PI_COST_CURRENCY = 'USD';

/** The fragment each streamed delta is. */
const FRAGMENT_CHANNELS: Readonly<Record<string, AgentFragmentDelta['channel']>> = {
  text_delta: 'text',
  thinking_delta: 'thinking',
  toolcall_delta: 'tool_input',
};

export interface PiFactLiftOptions {
  /** The plugin directories this host could not hand the session, reported among its plugin errors. */
  readonly undeliveredPlugins?: readonly ReceiptPluginError[];
}

/** An MCP server's tools as pi names them: `mcp__<server>__<tool>`, with every other character `_`. */
function mcpToolPrefix(server: string): string {
  return `mcp__${server}__`.replace(/[^A-Za-z0-9_]/g, '_');
}

export class PiFactLift implements FactLift<PiMessage> {
  readonly #undelivered: readonly ReceiptPluginError[];
  #handle: string | null = null;
  /** The model register: what the session's spend and usage are filed under. */
  #model: string | null = null;
  #provider: string | null = null;
  #effort: string | null = null;
  #skills: readonly string[] | null = null;
  #mcpServers: AgentReceiptFact['mcpServers'] = null;
  /** Whether pi's state has been read, so a receipt of its own may be sent. */
  #runtimeOpened = false;
  /** The receipt last sent, as its key: a receipt is sent only when a member moved. */
  #receiptSent = '';
  /** The last main-thread answer's cache reads, for the next usage sample. */
  #lastCacheRead: number | null = null;

  constructor(options: PiFactLiftOptions = {}) {
    this.#undelivered = options.undeliveredPlugins ?? [];
  }

  fromMessage(message: PiMessage): LiftedFacts {
    switch (message.kind) {
      case 'hello':
        this.#mcpServers = serversOf(message.hello);
        return NOTHING;
      case 'response':
        return this.#fromResponse(message);
      case 'event':
        return this.#fromEvent(message.event);
      default:
        return NOTHING;
    }
  }

  fromCompaction(report: CompactionReport): readonly AgentFact[] {
    return [
      {
        kind: 'compaction',
        runtime: PI_RUNTIME,
        status: report.status,
        trigger: report.trigger,
        tokensBefore: report.tokensBefore,
        tokensAfter: report.tokensAfter,
      },
    ];
  }

  #fromResponse(message: Extract<PiMessage, { kind: 'response' }>): LiftedFacts {
    const data = responseData(message);
    if (data === null) return NOTHING;
    switch (message.command) {
      case 'get_commands': {
        const commands = parsed(PiCommands, data);
        if (commands === null) return NOTHING;
        this.#skills = bounded(
          commands.commands
            .filter((command) => command.source === 'skill' && command.name.startsWith('skill:'))
            .map((command) => text(command.name.slice('skill:'.length))),
        );
        return NOTHING;
      }
      case 'get_state': {
        const state = parsed(PiState, data);
        if (state === null) return NOTHING;
        const out: AgentFact[] = [...this.#handleIfChanged(state.sessionId)];
        if (state.model !== null && state.model !== undefined) {
          this.#model = state.model.id;
          this.#provider = state.model.provider;
        }
        if (typeof state.thinkingLevel === 'string') this.#effort = state.thinkingLevel;
        this.#runtimeOpened = true;
        out.push(...this.#receiptIfChanged('runtime'));
        return facts(out);
      }
      case 'set_model': {
        const model = parsed(PiModel, data);
        if (model === null) return NOTHING;
        this.#model = model.id;
        this.#provider = model.provider;
        return facts(this.#receiptIfChanged('host'));
      }
      case 'get_session_stats': {
        const stats = parsed(PiSessionStats, data);
        if (stats === null) return NOTHING;
        return facts([
          {
            kind: 'turn_record',
            runtime: PI_RUNTIME,
            // No model in the register means none was reported: no model key is invented.
            totals: this.#model === null ? null : this.#spend(stats, this.#model),
            turn: null,
            turnScope: null,
            numTurns: null,
            durationMs: null,
            sourceSessionId: stats.sessionId,
          },
          {
            kind: 'usage_sample',
            runtime: PI_RUNTIME,
            model: this.#modelText(),
            contextTokens: wholeOrNull(stats.contextUsage?.tokens ?? null),
            contextWindow: wholeOrNull(stats.contextUsage?.contextWindow ?? null),
            cacheTtl: null,
            mainThread: true,
            cacheReadTokens: this.#lastCacheRead,
          },
        ]);
      }
      default:
        return NOTHING;
    }
  }

  #fromEvent(event: JsonObject): LiftedFacts {
    switch (piTypeOf(event)) {
      case 'message_end': {
        const read = parsed(PiMessageEnd, event);
        if (read === null || read.message.role !== 'assistant') return NOTHING;
        if (typeof read.message.model === 'string' && read.message.model !== '')
          this.#model = read.message.model;
        if (typeof read.message.provider === 'string' && read.message.provider !== '') {
          this.#provider = read.message.provider;
        }
        if (read.message.usage !== undefined) this.#lastCacheRead = wholeOrNull(read.message.usage.cacheRead);
        return NOTHING;
      }
      case 'thinking_level_changed': {
        const read = parsed(PiThinkingLevelChanged, event);
        if (read === null) return NOTHING;
        this.#effort = read.level;
        return facts(this.#receiptIfChanged('runtime'));
      }
      case 'message_update':
        return this.#fragment(event);
      default:
        return NOTHING;
    }
  }

  #handleIfChanged(id: string): AgentFact[] {
    if (id === '' || id === this.#handle) return [];
    this.#handle = id;
    return [{ kind: 'session_handle', runtime: PI_RUNTIME, handle: id }];
  }

  #modelText(): string | null {
    return this.#model === null ? null : text(this.#model);
  }

  /** The receipt as it stands, from `source`. */
  #receiptFact(source: 'runtime' | 'host'): AgentReceiptFact {
    return {
      kind: 'agent_receipt',
      runtime: PI_RUNTIME,
      runtimeVersion: PI_PINNED_VERSION,
      model: this.#modelText(),
      permissionMode: null,
      effort: this.#effort,
      skills: this.#skills,
      // The plugin directories reach a pi session as skill directories; no plugin itself loads.
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
      effortReported: this.#effort !== null,
    };
  }

  /** The receipt, or nothing when no member moved since the last one sent. pi's own waits for its state. */
  #receiptIfChanged(source: 'runtime' | 'host'): AgentFact[] {
    if (!this.#runtimeOpened) return [];
    const receipt = this.#receiptFact(source);
    const { source: _source, ...members } = receipt;
    const key = JSON.stringify(members);
    if (key === this.#receiptSent) return [];
    this.#receiptSent = key;
    return [receipt];
  }

  #spend(stats: z.infer<typeof PiSessionStats>, model: string): SpendFacts {
    const cost = costOrNull(stats.cost);
    return {
      cost,
      currency: cost === null ? null : PI_COST_CURRENCY,
      costBasis: 'catalogue-estimated',
      byModel: [
        {
          model: text(model),
          canonicalModel: null,
          provider: this.#provider === null ? null : text(this.#provider),
          inputTokens: whole(stats.tokens.input),
          outputTokens: whole(stats.tokens.output),
          cacheReadTokens: whole(stats.tokens.cacheRead),
          cacheWriteTokens: whole(stats.tokens.cacheWrite),
          reasoningTokens: null,
          cost,
          costBasis: 'catalogue-estimated',
          contextWindow: wholeOrNull(stats.contextUsage?.contextWindow ?? null),
        },
      ],
    };
  }

  #fragment(event: JsonObject): LiftedFacts {
    const read = parsed(PiMessageUpdate, event);
    if (read === null) return NOTHING;
    const delta = read.assistantMessageEvent;
    const channel = Object.hasOwn(FRAGMENT_CHANNELS, delta.type) ? FRAGMENT_CHANNELS[delta.type] : undefined;
    if (channel === undefined || typeof delta.delta !== 'string' || delta.delta === '') return NOTHING;
    const fragment: AgentFragmentDelta = {
      update: 'agent_fragment',
      runtime: PI_RUNTIME,
      channel,
      text: delta.delta,
      // pi streams the main thread only: a call another tool made writes no model output of its own.
      parentId: null,
    };
    return { facts: [], fragments: [fragment] };
  }
}

/** The servers the extension registered, connected once pi lists a tool of theirs. */
function serversOf(hello: PiHello): AgentReceiptFact['mcpServers'] {
  if (hello.servers === null) return null;
  const tools = (hello.tools ?? []).map((tool) => tool.name);
  return bounded(
    hello.servers.map((server) => ({
      name: text(server.name),
      status: tools.some((tool) => tool.startsWith(mcpToolPrefix(server.name))) ? 'connected' : 'pending',
    })),
  );
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

/** A reported cost as the wire carries it: a finite, non-negative amount, or null. */
function costOrNull(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The native id a fact lifted from a pi message names: none, since pi's messages carry no id of their own. */
export function piFactSourceId(): string | null {
  return null;
}
