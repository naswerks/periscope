/**
 * The wire contract.
 *
 * Naming follows the Agent Client Protocol (agentclientprotocol.com, Zed Industries, Apache-2.0):
 * its method names, camelCase keys and snake_case discriminators. Names and conventions only;
 * every type here is written from scratch and derived from none of its artifacts.
 *
 * Two conventions this file holds to, both of which bite later if broken:
 *   - Absent is `null`, never `undefined`. JSON has no `undefined`, so an optional property makes
 *     "field omitted" and "field present and unset" indistinguishable across a round trip. The one
 *     exception is a member added inside the protocol window: it is optional (`?:`), because a peer
 *     one release behind omits it, and because a controller written in TypeScript that builds the
 *     frame would otherwise stop compiling at a minor release. Its absence reads as "not stated".
 *     Outside the window, absent is null.
 *   - Every discriminator begins with a noun from core/vocab.ts.
 */
import type { Refusal } from '../core/refusal.js';
import { isRefusalReason } from '../core/refusal.js';
import type { SessionTransition } from '../state/model.js';

/**
 * Bumped when a change is not backward-compatible. Exchanged in the hello handshake.
 *
 * The rule: a new payload kind, a new member on an existing kind, a member whose nullability
 * changed, or a new hello member is a bump, even when the change is additive in practice. The
 * handshake's job is to let a peer refuse a version it does not know rather than to guess whether
 * a difference happened to be survivable: every declared member is required on the wire, so a
 * peer one version behind refuses the whole frame, and because refusals are not acknowledged that
 * refusal would be a permanent silent wedge on the session lane. The handshake refuses by version
 * instead, by name, once. A member added inside the window is the exception: it is optional (see
 * this file's header), so a frame from a peer one version behind still decodes. A new value in the
 * open `capabilities` list is not a bump; a new `RefusalReason` is one, because a strict encoder on
 * the other side must learn it first.
 *
 * Every bump re-approves `contracts/wire-vectors/` (`npm run contracts:update`) and regenerates
 * any consumer's readers.
 */
export const PROTOCOL_VERSION = 15;

/**
 * The oldest protocol version this build still speaks. A hello advertises the window
 * `[PROTOCOL_VERSION_MIN, PROTOCOL_VERSION]` beside `protocolVersion`; the controller answers with
 * its choice inside the overlap and the host accepts any version in its own window. The window
 * is one minor wide: the version before the current one stays supported for one release. A hello
 * with no range does not decode, so a version older than the first negotiated one cannot be inside
 * the window.
 *
 * Version 15 adds the `agent_facts` update body (the facts a controller acts on, lifted out of the
 * agent's own messages into typed members), the `agent_fragment` delta body, and `runtime` on
 * `agent_message`. Each is a new body or an optional member, so a version-14 controller is still
 * spoken to: it reads the new bodies as open JSON it may ignore, and every frame it sends decodes
 * here unchanged. The narrowing of `session_new.request.env` that version 14 made (a key a
 * controller places in the spawn environment must be one this host's operator declared, above the
 * floor) holds at every version this host negotiates.
 */
export const PROTOCOL_VERSION_MIN = 14;

/** The versions a peer speaks, inclusive at both ends. */
export interface ProtocolRange {
  readonly min: number;
  readonly max: number;
}

/**
 * A frame larger than this is refused by the codec.
 *
 * This is the mechanical half of "commands only, never payloads": bulk bytes cannot ride the link
 * even by accident, because a frame carrying them will not encode. The refusal names the bulk lane
 * so the failure teaches the fix rather than just reporting a size.
 */
export const MAX_FRAME_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Session payloads — carried on a sequenced, replayable frame.
// ---------------------------------------------------------------------------

/**
 * What a session update carries. ACP: `session/update`, whose payload is likewise a union.
 *
 * Four members. A later kind of update adds a member here rather than a new payload kind, which
 * keeps `session_update` meaning "a settled fact about this session" (the non-droppable lane)
 * instead of splitting one idea across several discriminators.
 *
 * `WireRefusalUpdate` is a body member rather than a new payload kind for exactly that reason. A
 * host-side refusal that the controller must act on is a settled fact about the session, so it
 * belongs on the non-droppable lane beside a transition. Adding a kind would also have meant a
 * dispatcher change on both ends for a frame that carries no new idea.
 *
 * `AgentFactsUpdate` is the fourth: one fact the agent reported (its resumable handle, its receipt,
 * its spend, its context use, its running tasks, a compaction) lifted out of its own message into a
 * typed member, riding beside the message it came from.
 */
export type SessionUpdateBody =
  StateTransitionUpdate | AgentMessageUpdate | WireRefusalUpdate | AgentFactsUpdate;

/**
 * A declared state transition. The reason this lane is not droppable: losing one is not a repaint
 * that can be redone, it is a lie about what the session did.
 */
export interface StateTransitionUpdate {
  readonly update: 'state_transition';
  readonly transition: SessionTransition;
}

/**
 * One message the agent emitted, carried verbatim.
 *
 * Verbatim is the contract, not a shortcut. The SDK's own message shapes are this package's
 * vocabulary, so forwarding them unchanged means there is exactly one place SDK models become this
 * package's models: `state/observer.ts`, which says so in its first line. Normalizing here would be
 * a second translation site, sitting where drift is hardest to see, and it would not remove the
 * need to track the SDK anyway. A consumer reads `message.type` and gets the SDK's answer.
 *
 * Which messages ride here and which ride the delta lane is declared in `control/stream-routing.ts`,
 * one row per discriminator. It is not a judgement made at the call site.
 */
export interface AgentMessageUpdate {
  readonly update: 'agent_message';
  /** The SDK message as it arrived. Opaque to this layer; `message.type` is the discriminator. */
  readonly message: JsonObject;
  /**
   * When this host took the message off the agent's stream, ISO-8601 in UTC (protocol 12). A
   * consumer that used its own receipt time instead would run late after a reconnect replays what it
   * missed. Absent from a host one release behind; read it with `readObservedAt`.
   */
  readonly observedAt?: string | null;
  /**
   * The runtime that emitted the message (protocol 15). Absent means `claude` (`DEFAULT_RUNTIME`):
   * a Claude session's messages omit it, so their bodies are unchanged, and a session on any other
   * runtime names it here, the discriminator for reading `message`.
   */
  readonly runtime?: string | null;
}

/**
 * A settled fact about a session. ACP: `session/update`.
 *
 * `body` is structurally open and read through a typed pair, which is a deliberate choice rather
 * than a missing narrowing. Declaring `body: SessionUpdateBody` would reject a newer peer's richer
 * body at the type level while the codec is built to carry unknown keys across intact — the two
 * would disagree about the same field. So the contract lives in `stateTransitionUpdate` and
 * `readStateTransition`: a producer cannot build a malformed one, a consumer cannot read one
 * without checking, and the wire stays tolerant.
 */
export interface SessionUpdate {
  readonly kind: 'session_update';
  readonly body: JsonObject;
}

/** Build the update carrying a transition. The only supported way to put one on the wire. */
export function stateTransitionUpdate(transition: SessionTransition): SessionUpdate {
  const body: StateTransitionUpdate = { update: 'state_transition', transition };
  return { kind: 'session_update', body: body as unknown as JsonObject };
}

/**
 * Read a transition back out, or null when the body is some other kind of update.
 *
 * Null rather than a throw: an older host receiving a body it does not model must keep going, and
 * a consumer that gets null knows to leave the frame alone rather than to treat it as corrupt.
 */
export function readStateTransition(body: JsonObject): SessionTransition | null {
  const update = body as { update?: unknown; transition?: unknown };
  if (update.update !== 'state_transition') return null;
  const transition = update.transition as Partial<SessionTransition> | undefined;
  if (transition === undefined || typeof transition.seq !== 'number' || transition.cause === undefined) {
    return null;
  }
  return transition as SessionTransition;
}

/**
 * Build the update carrying an agent message. The only supported way to put one on the wire.
 *
 * `observedAt` is omitted when not given, so a caller that has no instant to state writes the same
 * body a host one release behind does. `runtime` is omitted the same way, which is how a Claude
 * session's message is written.
 */
export function agentMessageUpdate(
  message: JsonObject,
  observedAt?: string | null,
  runtime?: string | null,
): SessionUpdate {
  const body: AgentMessageUpdate = {
    update: 'agent_message',
    message,
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(runtime === undefined ? {} : { runtime }),
  };
  return { kind: 'session_update', body: body as unknown as JsonObject };
}

/** When the host saw a forwarded message, or null: a host one release behind does not say. */
export function readObservedAt(body: JsonObject): string | null {
  const observed = (body as { observedAt?: unknown }).observedAt;
  return typeof observed === 'string' && observed !== '' ? observed : null;
}

/** Read a forwarded message back out, or null when the body is some other kind of update. */
export function readAgentMessage(body: JsonObject): JsonObject | null {
  const update = body as { update?: unknown; message?: unknown };
  if (update.update !== 'agent_message') return null;
  const message = update.message;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  return message as JsonObject;
}

/**
 * A refusal the host decided about the controller's own traffic, sent back so the controller can act.
 *
 * The one this exists for is `seq-gap`, and it closes a hole that can only be seen from here.
 * The receiver's `SeqTracker` advances only on an exact `last + 1`, so a frame arriving with a hole
 * in front of it is dropped and `last` does not move; every later frame on that session is then
 * also a gap. There is no NACK, no retransmit request and no resync frame, so without this the only
 * signal is a host-local event: the sender, the single party able to fix it, is told nothing and
 * the lane simply goes quiet forever. A quiet lane and a healthy idle lane look identical.
 *
 * `expected` is not diagnostic; it is the instruction. It is the exact seq the receiver will
 * accept next, so a sender that re-sends from there heals the lane with no further protocol. That is
 * why this carries two numbers instead of a message: a refusal a peer can act on beats one it can
 * only log.
 *
 * It is not a new payload kind, deliberately. See `SessionUpdateBody`.
 */
export interface WireRefusalUpdate {
  readonly update: 'wire_refusal';
  readonly refusal: WireRefusal;
  /** The seq the receiver will accept next. Re-send from here. */
  readonly expected: number;
  /** What actually arrived, so the size of the hole is legible without arithmetic. */
  readonly received: number;
}

/** Build the update carrying a refusal about the peer's own traffic. The only supported way. */
export function wireRefusalUpdate(refusal: WireRefusal, expected: number, received: number): SessionUpdate {
  const body: WireRefusalUpdate = { update: 'wire_refusal', refusal, expected, received };
  return { kind: 'session_update', body: body as unknown as JsonObject };
}

/**
 * Read a wire refusal back out, or null when the body is some other kind of update.
 *
 * Null rather than a throw, for the same reason `readStateTransition` returns null: a peer that does
 * not model this member must keep going rather than treat the frame as corrupt. A v1 controller
 * reaching this body gets null from all three readers and leaves the frame alone — which is a
 * degraded outcome, not a broken one, and is the honest cost the version bump exists to announce.
 */
export function readWireRefusal(body: JsonObject): WireRefusalUpdate | null {
  const update = body as { update?: unknown; refusal?: unknown; expected?: unknown; received?: unknown };
  if (update.update !== 'wire_refusal') return null;
  if (typeof update.expected !== 'number' || typeof update.received !== 'number') return null;
  const refusal = update.refusal as Partial<WireRefusal> | undefined;
  if (refusal === undefined || typeof refusal.reason !== 'string' || typeof refusal.detail !== 'string') {
    return null;
  }
  return {
    update: 'wire_refusal',
    refusal: { reason: refusal.reason, detail: refusal.detail },
    expected: update.expected,
    received: update.received,
  };
}

/**
 * An incremental fragment: streamed tokens, thinking prose, progress tickers.
 *
 * The one droppable kind. A delta is superseded by the update that settles it, so losing one under
 * pressure costs a repaint and never a fact. Which messages ride here is declared per discriminator
 * in `control/stream-routing.ts`.
 *
 * The notify contract for consumers, which fails silently when broken: a consumer folding these
 * into view state must return a new top-level state reference for every fold that changes
 * anything, and the same reference for a true no-op. UI frameworks commonly bind rendered state
 * through a reference-equality check, so a fold that mutates its state in place and returns the
 * object it was given produces no notification: mid-turn painting stops dead and only resumes when
 * something else happens to replace the reference, typically the turn's own result. There is no
 * error, no dropped frame and nothing null; the frames arrive correctly and the view simply stops
 * moving, which reads as a hung session.
 *
 * This is stated here rather than left to the consumer because it is inherited by whoever renders
 * these frames; the symptom is a whole turn appearing in one lump.
 *
 * `body` is open JSON for the reason `SessionUpdate.body` is, and is read as a `SessionDeltaBody`
 * through its `update` discriminator.
 */
export interface SessionDelta {
  readonly kind: 'session_delta';
  readonly body: JsonObject;
}

/**
 * What a session delta carries: one message verbatim, or one fragment of a message lifted out of it.
 *
 * Both ride together. The fragment states what a consumer renders (text, thinking prose, a tool's
 * arguments as they arrive) without reading the runtime's own streaming shape; the message beside it
 * is unchanged.
 */
export type SessionDeltaBody = AgentMessageUpdate | AgentFragmentDelta;

/**
 * Build a delta carrying one message verbatim.
 *
 * The body is the same shape a `session_update` carries, deliberately: the lanes differ in what
 * losing a frame costs, not in what a frame says, so `readAgentMessage` reads either. A consumer
 * that had to parse two shapes for one idea would have been handed the drift this package's
 * vocabulary rules exist to prevent.
 */
export function agentMessageDelta(
  message: JsonObject,
  observedAt?: string | null,
  runtime?: string | null,
): SessionDelta {
  const body: SessionDeltaBody = {
    update: 'agent_message',
    message,
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(runtime === undefined ? {} : { runtime }),
  };
  return { kind: 'session_delta', body: body as unknown as JsonObject };
}

// ---------------------------------------------------------------------------
// The fact layer: what the agent reported, lifted into typed members.
//
// A controller acts on a handful of facts: which session it can resume, what the agent says it is
// running with, what a turn cost, how full the context is, which tasks are running, and when the
// context was compacted. Each runtime reports them in its own message shapes. These members state
// them once, typed, so a controller reads one shape whatever the runtime, and the native message
// still rides beside them for whoever wants it whole.
//
// Every figure is reported, never derived: a member the runtime did not report is null, and nothing
// here is computed from another figure (a total is never summed from turns, a turn is never
// differenced from totals). Every closed set is an exported array, so a reader in another language
// gets it as a vocabulary.
// ---------------------------------------------------------------------------

/** The runtime an `agent_message` with no `runtime` came from. */
export const DEFAULT_RUNTIME = 'claude';

/**
 * Where a cost figure came from: a runtime's own price list (`list`), a rate the operator set
 * (`managed`), a guess at a default model's rate (`guessed`), the provider's own figure
 * (`provider-reported`), an estimate from a model catalogue (`catalogue-estimated`), a model its
 * operator serves itself (`self-hosted`), or no cost reported at all (`unreported`).
 */
export const COST_BASES = [
  'list',
  'managed',
  'guessed',
  'provider-reported',
  'catalogue-estimated',
  'self-hosted',
  'unreported',
] as const;

export type CostBasis = (typeof COST_BASES)[number];

/** What a `turn_record`'s `turn` covers: a whole turn, or one model step inside a turn. */
export const TURN_SCOPES = ['turn', 'step'] as const;

export type TurnScope = (typeof TURN_SCOPES)[number];

/** Who composed an `agent_receipt`: the runtime's own report, or this host from its own delivery. */
export const RECEIPT_SOURCES = ['runtime', 'host'] as const;

export type ReceiptSource = (typeof RECEIPT_SOURCES)[number];

/** The lifetime a model call wrote the prompt cache for. */
export const CACHE_TTLS = ['5m', '1h'] as const;

export type CacheTtl = (typeof CACHE_TTLS)[number];

/** A compaction began, or it finished. */
export const COMPACTION_STATUSES = ['started', 'ended'] as const;

export type CompactionStatus = (typeof COMPACTION_STATUSES)[number];

/** Who asked for a compaction: a person (`manual`) or the runtime on its own (`auto`). */
export const COMPACTION_TRIGGERS = ['manual', 'auto'] as const;

export type CompactionTrigger = (typeof COMPACTION_TRIGGERS)[number];

/** What a fragment carries: reply text, thinking prose, or a tool's arguments as they stream. */
export const FRAGMENT_CHANNELS = ['text', 'thinking', 'tool_input'] as const;

export type FragmentChannel = (typeof FRAGMENT_CHANNELS)[number];

/** The most entries any list in an `agent_facts` body carries: skills, plugins, servers, models, tasks. */
export const MAX_FACT_LIST_ENTRIES = 256;

/** The longest free-text member of an `agent_facts` body: a name, an id, a path, a description. */
export const MAX_FACT_TEXT_LENGTH = 1000;

/** The longest word a fact or a fragment carries: a runtime, a mode, a vocabulary value, a version. */
export const MAX_FACT_WORD_LENGTH = 64;

/** One model's part of a spend figure, as the runtime reported it. */
export interface ModelSpendFact {
  /** The model the runtime keyed the figure by, aliases and provider-specific ids included. */
  readonly model: string;
  /** The id the runtime priced against, when it says. */
  readonly canonicalModel: string | null;
  /** Which API served the model, when the runtime says. */
  readonly provider: string | null;
  /** Uncached input only, on every runtime: cache reads and cache writes are counted apart. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Reasoning tokens, already counted inside `outputTokens`; null when the runtime did not say. */
  readonly reasoningTokens: number | null;
  /** In the enclosing figure's `currency`; null when the runtime reported no cost for the model. */
  readonly cost: number | null;
  readonly costBasis: CostBasis;
  /** The context window the model served with; null when not reported. */
  readonly contextWindow: number | null;
}

/**
 * A spend figure: a cost in a currency, where the cost came from, and its parts per model.
 *
 * `costBasis` is the basis of `cost`. Where a runtime reports a basis for each model, it is a roll-up
 * of the rows' bases: the weakest of them. Each row keeps the basis it was reported with, and a
 * consumer that prices money reads the rows.
 */
export interface SpendFacts {
  /** Null when the runtime reported no cost. */
  readonly cost: number | null;
  /** An ISO 4217 code; null when no cost was reported. */
  readonly currency: string | null;
  readonly costBasis: CostBasis;
  readonly byModel: readonly ModelSpendFact[];
}

/** A plugin the runtime says it loaded. */
export interface ReceiptPlugin {
  readonly name: string;
  readonly version: string | null;
  readonly path: string | null;
}

/** A plugin the runtime says it could not load, and why. */
export interface ReceiptPluginError {
  readonly plugin: string;
  readonly type: string;
  readonly message: string;
  readonly path: string | null;
}

/** An MCP server the runtime connected to, or tried to, with the status in the runtime's own word. */
export interface ReceiptMcpServer {
  readonly name: string;
  readonly status: string;
}

/** One task the runtime says is running. */
export interface RunningTaskEntry {
  readonly taskId: string;
  readonly type: string;
  readonly description: string | null;
}

/** The runtime's own resumable id for the session. A resume or a fork reports a new one. */
export interface SessionHandleFact {
  readonly kind: 'session_handle';
  readonly runtime: string;
  readonly handle: string;
}

/**
 * What the runtime says it is running with: its version, model, approval mode and effort, and the
 * skills, plugins and MCP servers it loaded. `permissionMode` and `effort` are the runtime's own words.
 */
export interface AgentReceiptFact {
  readonly kind: 'agent_receipt';
  readonly runtime: string;
  readonly runtimeVersion: string | null;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly effort: string | null;
  readonly skills: readonly string[] | null;
  readonly plugins: readonly ReceiptPlugin[] | null;
  readonly pluginErrors: readonly ReceiptPluginError[] | null;
  readonly mcpServers: readonly ReceiptMcpServer[] | null;
  readonly source: ReceiptSource;
}

/**
 * Spend as the runtime reported it when a turn or a step ended.
 *
 * `totals` is the runtime's running total for the session; `turn` is the figure for what `turnScope`
 * names. Either may be null, and neither is ever computed from the other: a consumer that wants a
 * turn's share of a running total differences two totals itself. `turnScope` is null exactly when
 * `turn` is.
 */
export interface TurnRecordFact {
  readonly kind: 'turn_record';
  readonly runtime: string;
  readonly totals: SpendFacts | null;
  readonly turn: SpendFacts | null;
  readonly turnScope: TurnScope | null;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  /** The runtime's session id as the record states it. */
  readonly sourceSessionId: string | null;
}

/**
 * How full one model call's context was, under the runtime's own counting rule, and the cache
 * lifetime the call wrote. `mainThread` is false for a call a subagent made in its own context.
 */
export interface UsageSampleFact {
  readonly kind: 'usage_sample';
  readonly runtime: string;
  readonly model: string | null;
  readonly contextTokens: number | null;
  readonly contextWindow: number | null;
  readonly cacheTtl: CacheTtl | null;
  readonly mainThread: boolean;
}

/** Every task the runtime says is running, whole: each one replaces the last. */
export interface TasksFact {
  readonly kind: 'tasks';
  readonly runtime: string;
  readonly running: readonly RunningTaskEntry[];
}

/** A compaction began or finished, with what its source reported. */
export interface CompactionFact {
  readonly kind: 'compaction';
  readonly runtime: string;
  readonly status: CompactionStatus;
  readonly trigger: CompactionTrigger | null;
  readonly tokensBefore: number | null;
  readonly tokensAfter: number | null;
}

/** One fact, tagged by `kind`. */
export type AgentFact =
  SessionHandleFact | AgentReceiptFact | TurnRecordFact | UsageSampleFact | TasksFact | CompactionFact;

/** The fact kinds this build reads; a newer peer's other kinds cross the wire and read as null here. */
const AGENT_FACT_KINDS: ReadonlySet<string> = new Set<AgentFact['kind']>([
  'session_handle',
  'agent_receipt',
  'turn_record',
  'usage_sample',
  'tasks',
  'compaction',
]);

/**
 * One fact the agent reported, on the update lane (protocol 15).
 *
 * `sourceId` is the id of the native message the fact was lifted from (Claude: the message's
 * `uuid`, the id that message carries on its own `agent_message`), and null for a fact lifted from a
 * hook or from the observer. A consumer's ingest is idempotent on it, so a replayed or re-sent fact
 * lands once. `observedAt` is the instant this host took the source off the agent's stream.
 */
export interface AgentFactsUpdate {
  readonly update: 'agent_facts';
  readonly fact: AgentFact;
  readonly sourceId?: string | null;
  readonly observedAt?: string | null;
}

/** Build the update carrying one fact. The only supported way to put one on the wire. */
export function agentFactsUpdate(
  fact: AgentFact,
  sourceId: string | null,
  observedAt?: string | null,
): SessionUpdate {
  const body: AgentFactsUpdate = {
    update: 'agent_facts',
    fact,
    sourceId,
    ...(observedAt === undefined ? {} : { observedAt }),
  };
  return { kind: 'session_update', body: body as unknown as JsonObject };
}

/**
 * Read a fact back out, or null when the body is some other kind of update or carries a fact kind
 * this build does not model. Null rather than a throw, for the reason `readStateTransition` gives.
 */
export function readAgentFacts(body: JsonObject): AgentFactsUpdate | null {
  const update = body as { update?: unknown; fact?: unknown };
  if (update.update !== 'agent_facts') return null;
  const fact = update.fact as { kind?: unknown; runtime?: unknown } | null | undefined;
  if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) return null;
  if (typeof fact.kind !== 'string' || !AGENT_FACT_KINDS.has(fact.kind)) return null;
  if (typeof fact.runtime !== 'string') return null;
  return body as unknown as AgentFactsUpdate;
}

/**
 * One fragment of a streaming message, on the delta lane (protocol 15): a piece of the reply text, of
 * the thinking prose, or of a tool's arguments. `parentId` names the tool call that spawned the
 * subagent speaking, and is null on the main thread. Superseded by the message that settles it, like
 * every delta.
 */
export interface AgentFragmentDelta {
  readonly update: 'agent_fragment';
  readonly runtime: string;
  readonly channel: FragmentChannel;
  readonly text: string;
  readonly parentId: string | null;
}

/** Build the delta carrying one fragment. The only supported way to put one on the wire. */
export function agentFragmentDelta(
  runtime: string,
  channel: FragmentChannel,
  text: string,
  parentId: string | null,
): SessionDelta {
  const body: AgentFragmentDelta = { update: 'agent_fragment', runtime, channel, text, parentId };
  return { kind: 'session_delta', body: body as unknown as JsonObject };
}

/** Read a fragment back out, or null when the body is some other kind of delta. */
export function readAgentFragment(body: JsonObject): AgentFragmentDelta | null {
  const delta = body as { update?: unknown; runtime?: unknown; channel?: unknown; text?: unknown };
  if (delta.update !== 'agent_fragment') return null;
  if (typeof delta.runtime !== 'string' || typeof delta.channel !== 'string') return null;
  if (typeof delta.text !== 'string') return null;
  return body as unknown as AgentFragmentDelta;
}

/*
 * There is no `session_started` or `session_ended` kind, deliberately.
 *
 * Each would be a second name for something a transition already carries: a `-> spawning`
 * transition carries `where.cwd`, and a `-> ended` transition carries the cause that ended it. Two
 * names for one fact is how a vocabulary drifts apart.
 */

/**
 * Start a session. ACP: `session/new`.
 *
 * This payload carries more than `cwd` so that a controller can ask for a session to be resumed,
 * forked, given tools, or told which model to run over the wire, rather than having to bypass the
 * link and call the in-process composer.
 *
 * The test for what belongs here, so the next addition is decided rather than argued: is this a
 * decision about the session (resume this one, fork it, register these tools, use that model), or a
 * capability handle (a store, a spawn function, a hook)? Decisions travel. Handles stay with the
 * code that composes this host; see `SessionNewRequest`'s note on the five that stay refused.
 *
 * Every added field is `T | null` and null means "decide as you did before". A controller that
 * sends only `cwd` gets the previous behaviour, which is what makes a widening safe to land under a
 * host already running.
 */
export interface SessionNew {
  readonly kind: 'session_new';
  /**
   * Where the session runs. Absolute when stated; null means "no ask".
   *
   * Advisory when the host has a workspace provider: the provider decides, and the session's
   * first `spawning` transition carries `where.cwd`, the directory it actually got. A controller
   * learns where its session is from that transition rather than assuming this value was honoured.
   * Deliberately not echoed a second time anywhere: two names for one fact is how a vocabulary
   * drifts apart, and this file has no `session_started` kind for exactly that reason.
   *
   * Null is "the provider decides", and nothing else. Under a provider it changes nothing;
   * the ask was already ignored. With no provider there is nowhere honest to fall back to (the
   * controller's own cwd is the weakest isolation this host knows, and recreating it as a default
   * would smuggle a policy through an absence), so the host refuses `path-input-missing` by name.
   */
  readonly cwd: string | null;
  /**
   * The key the workspace provider provisions AT, when it should not be the session key.
   *
   * Null is "use the session key", and nothing else: the 1:1 topology exactly as it was, so
   * every existing caller is unchanged. A non-null key is what makes a shared workspace
   * expressible: two sessions naming the same key resolve to the same directory (and, under the git
   * provider, the same branch), which is the one-worktree-per-unit-of-work shape a session key can
   * never spell because it is unique per session by construction.
   *
   * It becomes a git branch component and a directory segment, so the host validates it against
   * the same union-of-two-rules screen the provider applies to a session key (`rejectUnusableId`),
   * before any workspace is claimed; a key that passes a loose guard and dies inside git on every
   * open is the defect class this prevents. With no workspace provider a non-null key is refused by
   * name: there is nothing to provision at any key, and running in the controller's cwd instead
   * would be the silent-wrong-topology failure this field exists to end (the `path-input-missing`
   * posture's mirror image).
   */
  readonly workspaceKey: string | null;
  /**
   * The controller's own meaning handle for this session, carried onto every transition.
   *
   * Never interpreted by the host. It exists so a controller can tie a session back to whatever
   * it means on its side, and the moment the host parsed it, this package would know something about
   * one product and stop being general. See the three-ids warning on `SessionFrame`.
   */
  readonly correlationId: string | null;
  /** Everything else the session is being asked for. Null means every default. */
  readonly request: SessionNewRequest | null;
  /** Per-session gate timings. Null means the host's own defaults. */
  readonly gate: SessionNewGate | null;
}

/**
 * The JSON-expressible subset of what a session can be asked for.
 *
 * Five keys of the in-process API are refused here and stay refused: the transcript mirror and
 * its flush mode, the custom process spawner, the stderr callback and the hook registrations. That
 * is a boundary, not an omission, and it is structural rather than enforced: every one of them is an
 * object with methods or a function, so none has a JSON representation and none can cross a wire
 * even in principle. The mirror is the sharpest: it receives every message the agent saw, so a
 * controller able to name one could name a destination for a transcript. Nothing here can.
 *
 * They are described here and spelled out in `host/wire-request.ts`, which is deliberate rather
 * than coy. `pins/persistence-egress.test.ts` scans this file's text for the mirror's key names and
 * fails on a hit, so that a wire field for one cannot be added without the pin firing. Writing the
 * names here, even inside a comment forbidding them, would trip that scan, and a pin loosened to
 * tell prose from code is a pin with a new way to be wrong. The list lives one file over, at the
 * only place that converts a wire request into a local one, and the pin keeps its teeth.
 */
export interface SessionNewRequest {
  /** A session id to continue. Null starts a new one. */
  readonly resume: string | null;
  /** With `resume`, continue into a NEW session id instead of extending the old one. */
  readonly fork: boolean | null;
  /**
   * Which on-disk settings tiers the agent may load. `[]` means none, which is the host's default.
   *
   * Asking for any tier can be refused before a process exists. A host that grants what its gate
   * approves plus loaded operator settings is two authorities over one question with no stated
   * precedence, so the composer refuses the pair by name (`permission-grant-shadows-settings`). The
   * refusal arrives at start-up, naming the tiers, never as a session that runs with rules silently
   * in conflict.
   *
   * Carried as plain strings: the narrow union lives with the SDK, on the far side of a boundary
   * this file is not allowed to reach, so the host narrows and refuses an unknown value by name.
   */
  readonly settingSources: readonly string[] | null;
  readonly plugins: readonly SessionNewPlugin[] | null;
  /**
   * MCP servers this session may call, by server name.
   *
   * Every tool these add is decided by the same gate as `Bash`: the permission hook registers
   * `PreToolUse` with no matcher, so a tool nobody predicted reaches the same handler. That is why
   * a controller may register tools at all: coverage is by construction, not by enumeration.
   *
   * Carried opaquely because the config union is the SDK's. The host narrows it, and a name that
   * collides with a server the host itself registered is refused rather than silently resolved.
   */
  readonly mcpServers: JsonObject | null;
  /**
   * Ignore every MCP server the host did not declare. Null leaves the host's default, which is true.
   *
   * True is the default and turning it off is a real decision. With it off the agent also loads
   * project `.mcp.json`, user settings, plugin MCP and on-disk agent frontmatter — so a repository
   * a provider checked out becomes a tool-registration channel, in exactly the case where nobody
   * reviewed what is in it.
   */
  readonly strictMcpConfig: boolean | null;
  /** Stream turns as they compose. Null leaves the host's default, which is ON. */
  readonly includePartialMessages: boolean | null;
  /**
   * How much reasoning this session emits. Null leaves the SDK's own default. Opaque here; the host
   * passes `adaptive` (with an optional `display`) and `disabled` on and refuses a fixed budget
   * (`enabled`) by name, because the current models reject it with a 400.
   */
  readonly thinking: JsonObject | null;
  /**
   * The effort level (`low` · `medium` · `high` · `xhigh` · `max`). Null leaves the SDK's own default.
   * A plain string here; the host narrows it and refuses an unknown level by name.
   */
  readonly effort: string | null;
  /**
   * The permission mode (`default` · `acceptEdits` · `bypassPermissions` · `plan` · `dontAsk` · `auto`).
   * Null leaves the SDK's default. This lane is open by design (CLI parity): a session exposes what
   * `claude` exposes. The gate's authority never rides the mode; it rides the `PreToolUse` hook,
   * which the SDK fires under every mode, so the boundary set (push · remote surgery · branch
   * delete · `gh pr merge`) is still held for a decision under bypass. What stays closed:
   * `settings`, `managedSettings`, `allowedTools`, `disallowedTools`, `canUseTool`, `permissions`,
   * `toolAliases`, `permissionPromptToolName`, `permissionPrompts`. A mode is a posture the operator
   * chooses in the open; those are rule files and pre-answers nobody can see.
   */
  readonly permissionMode: string | null;
  /** Forward a subagent's whole conversation rather than only its tool calls. Null means OFF. */
  readonly forwardSubagentText: boolean | null;
  /**
   * Extra allow / deny / literal declarations on top of the host's spawn environment.
   *
   * Two of the three lanes add to what the agent sees: `extraAllowedKeys` re-admits keys of the
   * host's own environment that the allow-list left out, and `extraEnv` sets values outright, after
   * the allow-list has run. Both are screened by the host before anything is reserved, and a key
   * either names is refused `env-key-refused`, naming every such key, unless it passes two screens:
   *
   * - The host's operator declared it (`PeriscopeHostOptions.controllerEnvKeys`;
   *   `PERISCOPE_CONTROLLER_ENV_KEYS` for the binary). Nothing is declared by default, so a host
   *   that declared nothing refuses every key in both lanes. The declaration is the operator's and
   *   is never settable over the link.
   * - It is above the floor (`EXTRA_ENV_FLOOR`, or the embedder's `extraEnvFloor`), which no
   *   declaration opens: `PATH`, the Node loader and TLS keys, the dynamic-linker keys, and the
   *   families that decide which server the model call goes to and as whom, which proxy carries the
   *   traffic and which certificates are trusted.
   *
   * `extraDeniedKeys` only removes keys, so it is never screened. Two facts in
   * `sessions/spawn-env.ts` still hold after the screens: an extra allowed key cannot override a
   * denied one (`DENIED_PATTERNS`, against inheritance), and the 15 `HOST_SESSION_MARKERS` are
   * stripped last and unconditionally, so a spawned agent is never told it is a continuation of the
   * host process, whatever any of these three arrays says.
   */
  readonly env: SessionNewEnv | null;
  /**
   * Which model runs. Null leaves the CLI's default.
   *
   * This and `systemPrompt` select what the process emits; neither can answer a permission, so
   * carrying them does not widen a security narrowing. The nine `SHADOWING_LANES` that can answer
   * a permission before the gate does are a deliberate narrowing and they stay closed. Two different
   * facts; see `AGENT_SELECTION_OPTION_KEYS` in host/agent-process.ts for the checked version of
   * this sentence.
   */
  readonly model: string | null;
  /**
   * What the agent is told at the start. Null leaves the CLI's own preset.
   *
   * Not provable from the host's report. The SDK's init message carries `model`, `tools`,
   * `mcp_servers`, `skills`, `plugins` and more, and no system prompt, so unlike every other field
   * here, a controller cannot confirm from the host's own report that this took effect. It ships
   * unproven-by-report, stated rather than discovered. Carried opaquely because the SDK accepts a
   * string, a list of strings, or a preset object.
   */
  readonly systemPrompt: JsonValue | null;
}

/**
 * Build a `session_new`. The only supported way to put one on the wire.
 *
 * It exists for the reason `stateTransitionUpdate` does, and for one more. The wire's rule is that
 * absent is `null` and never an omitted property, but a hand-written literal makes that a
 * discipline every author has to remember, and the moment one is forgotten the frame carries
 * `undefined`, which `JSON.stringify` deletes. The field then arrives absent, and "absent" and
 * "explicitly unset" are the two states this file spends its opening paragraph refusing to
 * conflate. Passing `asked` as a partial and filling every remaining key with `null` here makes
 * the rule a property of construction instead of a rule in a comment.
 *
 * The argument is a partial of the wire type; what comes out is fully populated. So a caller writes
 * only what it means, and no caller can produce a frame that says nothing where it meant nothing.
 */
export function sessionNew(
  cwd: string | null,
  asked: Partial<Omit<SessionNew, 'kind' | 'cwd'>> = {},
): SessionNew {
  return {
    kind: 'session_new',
    cwd,
    workspaceKey: asked.workspaceKey ?? null,
    correlationId: asked.correlationId ?? null,
    request: asked.request ?? null,
    gate: asked.gate ?? null,
  };
}

/**
 * Build a `session_new.request`. Same argument as `sessionNew`: every unstated key becomes `null`.
 *
 * The partial is the convenience and the full object is the contract. Nothing about the wire is
 * relaxed here: a controller in another language builds the whole object, and this is the shortcut
 * for the one that happens to be written in this one.
 */
export function sessionNewRequest(asked: Partial<SessionNewRequest> = {}): SessionNewRequest {
  return {
    resume: asked.resume ?? null,
    fork: asked.fork ?? null,
    settingSources: asked.settingSources ?? null,
    plugins: asked.plugins ?? null,
    mcpServers: asked.mcpServers ?? null,
    strictMcpConfig: asked.strictMcpConfig ?? null,
    includePartialMessages: asked.includePartialMessages ?? null,
    thinking: asked.thinking ?? null,
    forwardSubagentText: asked.forwardSubagentText ?? null,
    env: asked.env ?? null,
    model: asked.model ?? null,
    systemPrompt: asked.systemPrompt ?? null,
    effort: asked.effort ?? null,
    permissionMode: asked.permissionMode ?? null,
  };
}

/**
 * Every key a `session_new.request` carries, as data, so a check can enumerate them at run time.
 *
 * It exists so a pin cannot quietly stop covering something. The egress pin walks a populated
 * request looking for a field that could name a transcript destination, and a walk is only as
 * complete as the object it is handed: a hand-built fixture silently stops being full the moment a
 * later change adds a key, and the pin then passes while covering less, with nothing to say so.
 *
 * `satisfies Record<keyof SessionNewRequest, true>` makes the compiler the enforcer: adding a field
 * to the type without adding it here does not build. So the pin's fixture is checked against a list
 * that cannot fall behind the type it describes.
 */
export const SESSION_NEW_REQUEST_KEYS = {
  resume: true,
  fork: true,
  settingSources: true,
  plugins: true,
  mcpServers: true,
  strictMcpConfig: true,
  includePartialMessages: true,
  thinking: true,
  forwardSubagentText: true,
  env: true,
  model: true,
  systemPrompt: true,
  effort: true,
  permissionMode: true,
} as const satisfies Record<keyof SessionNewRequest, true>;

/** The same, for the payload itself. Same argument, one level up. */
export const SESSION_NEW_KEYS = {
  kind: true,
  cwd: true,
  workspaceKey: true,
  correlationId: true,
  request: true,
  gate: true,
} as const satisfies Record<keyof SessionNew, true>;

/** A plugin the session should load. Mirrors the SDK's shape; the host narrows it. */
export interface SessionNewPlugin {
  readonly type: string;
  readonly path: string;
  readonly skipMcpDiscovery: boolean | null;
}

/** Extra environment declarations for the spawn. See `SessionNewRequest.env`. */
export interface SessionNewEnv {
  readonly extraAllowedKeys: readonly string[] | null;
  readonly extraDeniedKeys: readonly string[] | null;
  readonly extraEnv: Readonly<Record<string, string>> | null;
}

/**
 * Per-session gate timings. Three timeouts, and deliberately nothing else.
 *
 * `grantOnAllow` is not here, and its absence is a decision rather than an oversight. It is a
 * permission posture, not a timing: turned off it yields a gate that can refuse a call and cannot
 * approve one, so a controller able to set it could disable its own session's tools from off-box
 * while every check still reported healthy. Timings decide how long the host waits; this decides
 * whether an answer means anything. Different questions, and only the first travels.
 *
 * The two-deadline invariant is enforced: the host's own deadline must expire before the
 * matcher's, and a pair that inverts it is refused at composition. It is reachable from the wire,
 * which is why the refusal happens before any process exists rather than at the first tool call.
 */
export interface SessionNewGate {
  readonly decisionTimeoutMs: number | null;
  readonly holdAfterMs: number | null;
  readonly matcherTimeoutSeconds: number | null;
}

/** Send a turn into a session. ACP: `session/prompt`. */
export interface SessionPrompt {
  readonly kind: 'session_prompt';
  readonly text: string;
}

/** Interrupt the current turn. ACP: `session/cancel`. */
export interface SessionCancel {
  readonly kind: 'session_cancel';
}

/**
 * End a session the controller no longer needs: the agent's process exits, the end is reported as the
 * session's transition to `ended`, and the workspace the session held is free for its next ask. A
 * cancel ends a turn; this ends the session. A session still opening ends as soon as it opens; a
 * handle this host does not hold is refused like any other session command.
 */
export interface SessionEnd {
  readonly kind: 'session_end';
}

/**
 * Change a running session's model, permission mode, thinking or effort: the SDK's streaming-input
 * setters (`setModel` · `setPermissionMode` · `setMaxThinkingTokens`) and its flag settings for
 * effort, reached over the wire. Each member is "not asked" when null; the host applies the asked
 * ones in that order and reports a failure by name.
 */
export interface SessionConfigure {
  readonly kind: 'session_configure';
  /** The model id to switch to. Null = not asked. */
  readonly model: string | null;
  /** The permission mode to switch to — the same vocabulary as `SessionNewRequest.permissionMode`. */
  readonly permissionMode: string | null;
  /**
   * `{type:'adaptive'}`, optionally with `display` (`summarized` or `omitted`), or `{type:'disabled'}`.
   * The SDK also declares a fixed budget, `{type:'enabled', budgetTokens}`; the host refuses it by
   * name, because the current models reject it with a 400.
   */
  readonly thinking: JsonObject | null;
  /**
   * The effort level to switch to (protocol 12), the same vocabulary as `SessionNewRequest.effort`.
   * Null or absent = not asked; a controller one release behind never sends it.
   */
  readonly effort?: string | null;
}

/**
 * Ask for bulk content. The link carries this locator, never the content.
 *
 * The host answers with an outbound HTTP POST to `postUrl` and reports the outcome back over the
 * link. `bulk` is this package's noun, not ACP's; ACP has no equivalent concept, so nothing is
 * being renamed.
 */
export interface BulkRequest {
  readonly kind: 'bulk_request';
  readonly deliveryId: string;
  readonly what: string; // opaque to this layer; the bulk resolver gives it meaning
  readonly fromOffset: number;
  readonly postUrl: string;
}

/**
 * The bytes were POSTed. A receipt, so it is not droppable.
 *
 * `sizeBytes` / `mtimeMs`: the delivered file's stat at the moment it was streamed, so a
 * caller pulling a transcript can detect the CLI rewriting the file under it. The CLI rewrites
 * transcripts on compaction, which makes a byte-offset resume across a rewrite invalid. Both are
 * `T | null` (the wire's optionality rule): null means the deliverer did not read a stat, which is
 * exactly what an older host sends, so a v3 receipt decodes as a v4 receipt with the two unknowns
 * stated rather than invented.
 */
export interface BulkDelivered {
  readonly kind: 'bulk_delivered';
  readonly deliveryId: string;
  readonly byteCount: number;
  /** The file's total size when the delivery was read. Null when the deliverer did not stat it. */
  readonly sizeBytes: number | null;
  /** The file's mtime (integer epoch ms) when the delivery was read. Null when unknown. */
  readonly mtimeMs: number | null;
}

/** Build a `bulk_delivered`. Fills the stat pair with null so an absent value is stated, not deleted. */
export function bulkDelivered(
  deliveryId: string,
  byteCount: number,
  stat: { sizeBytes?: number; mtimeMs?: number } = {},
): BulkDelivered {
  return {
    kind: 'bulk_delivered',
    deliveryId,
    byteCount,
    sizeBytes: stat.sizeBytes ?? null,
    mtimeMs: stat.mtimeMs ?? null,
  };
}

/** The delivery did not happen, and this says which named way it failed. */
export interface BulkFailed {
  readonly kind: 'bulk_failed';
  readonly deliveryId: string;
  readonly refusal: WireRefusal;
}

// ---------------------------------------------------------------------------
// Discovery payloads: ask the host what is running, and what the agent CLI
// has on this machine. Requests travel; content that is bulk stays on the bulk lane.
// ---------------------------------------------------------------------------

/*
 * The test that admits these, so the next addition is decided rather than argued: a list, a
 * probe or a read request is a decision about sessions and travels; the transcript bytes are bulk
 * content and ride the bulk-post lane (`bulk_request` with a `claude-transcript:` locator), never
 * the link. Every request carries a `requestId` the answer echoes (the `deliveryId` model) so a
 * controller can have several in flight without guessing which answer is whose.
 *
 * None of these are droppable, deliberately. The results are receipts: losing one under pressure
 * would be an answer that silently never arrived, on a link whose whole doctrine is that silence
 * and health must not look alike. A lost result is survivable only because the request is
 * re-askable, which is also why these are safe to serve to a handle no session ever claimed.
 */

/** Ask which sessions this host is running. */
export interface SessionList {
  readonly kind: 'session_list';
  readonly requestId: string;
}

/**
 * One running session, as this host knows it.
 *
 * `sessionKey` is the controller's own routing handle (see the three-ids note on `SessionFrame`),
 * the one id the asker can act on. `sessionId` is the agent's own id, null until the agent has
 * named itself; `state` is the session lifecycle word as the host holds it, carried as a plain
 * string so a newer host's added state survives the crossing.
 */
export interface SessionListEntry {
  readonly sessionKey: string;
  readonly sessionId: string | null;
  readonly state: string;
  readonly cwd: string | null;
  readonly startedAt: string | null;
}

/** The answer: every session behind a handle, plus the registry's own two counts. */
export interface SessionListResult {
  readonly kind: 'session_list_result';
  readonly requestId: string;
  readonly sessions: readonly SessionListEntry[];
  readonly liveCount: number;
  /** Sessions started but not yet self-named. Counted, not listable: they have no agent id yet. */
  readonly provisioningCount: number;
}

/** Ask which Claude sessions exist on this machine, from `fromIndex`, newest first. */
export interface TranscriptList {
  readonly kind: 'transcript_list';
  readonly requestId: string;
  readonly fromIndex: number;
}

/**
 * One transcript on disk: an opaque project slug, the session id, the stat pair, and the working directory
 * the CLI recorded on it — the cwd a resume of this transcript must run in (transcripts live per cwd).
 * Null when the file's head carries none.
 */
export interface TranscriptListEntry {
  readonly projectSlug: string;
  readonly sessionId: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly cwd: string | null;
}

/**
 * One page of the enumeration. Paged because the answer must fit `MAX_FRAME_BYTES`: a machine's
 * corpus reaches hundreds of sessions, and one frame carrying all of them would be refused by the
 * very codec that carries it. `nextIndex` null means this page ends the listing; re-ask from it
 * otherwise. An empty first page is a fresh machine, not an error.
 */
export interface TranscriptListResult {
  readonly kind: 'transcript_list_result';
  readonly requestId: string;
  readonly entries: readonly TranscriptListEntry[];
  readonly totalCount: number;
  readonly nextIndex: number | null;
}

/**
 * Probe one transcript's tail: has a matching user entry landed at or past `fromOffset`?
 *
 * `needle` null means "any user-text entry". The answer carries the file's current size as the
 * offset to resume from, plus the stat pair for rewrite detection.
 */
export interface TranscriptTail {
  readonly kind: 'transcript_tail';
  readonly requestId: string;
  readonly projectSlug: string;
  readonly sessionId: string;
  readonly fromOffset: number;
  readonly needle: string | null;
}

/**
 * The probe's answer. `absent` is a value, not a failure: a transcript that does not exist is a
 * real negative the asker may trust, and it must not wear a refusal's clothes; a refusal here
 * names a malformed request, never a missing file. When `absent` is true the stat pair is null.
 */
export interface TranscriptTailResult {
  readonly kind: 'transcript_tail_result';
  readonly requestId: string;
  readonly found: boolean;
  readonly absent: boolean;
  /** The file's current size — resume the next probe from here. 0 when absent. */
  readonly newOffset: number;
  readonly sizeBytes: number | null;
  readonly mtimeMs: number | null;
}

/**
 * A discovery request that could not be answered, and which named way it failed. The `bulk_failed`
 * model: a request that dies in the host must say so on the wire, because to the asker a swallowed
 * failure and a host that hung are the same silence.
 */
export interface TranscriptFailed {
  readonly kind: 'transcript_failed';
  readonly requestId: string;
  readonly refusal: WireRefusal;
}

/**
 * A host-scoped ask whose answer could not be sent: the answer was composed and refused at the
 * link (over the frame cap, most often), and instead of the controller learning by timeout it
 * learns by name, with the request id, in a frame that always fits. One kind for every ask, so a
 * controller matches it on `requestId` alone and never needs a per-kind refusal shape.
 */
export interface AnswerRefused {
  readonly kind: 'answer_refused';
  readonly requestId: string;
  readonly refusal: WireRefusal;
}

/** Build an `answer_refused`. */
export function answerRefused(requestId: string, refusal: WireRefusal): AnswerRefused {
  return { kind: 'answer_refused', requestId, refusal };
}

/**
 * Ask this host to remove a workspace's directory from disk. Host-scoped, like the discovery
 * asks: the routing key is a channel the controller chose, and no session needs to exist behind it.
 *
 * This is the one production path to `release(remove: true)`, and it is on-demand by design. A
 * session ending does not remove its directory; `ReleaseOptions.remove` defaults false because a
 * session that ended badly is one whose directory somebody wants to look at. Removal is something a
 * caller asks for (a UI control, a PR-close hook), never something that happens because a session
 * ended, so it arrives as its own command rather than as a flag remembered from `session_new`;
 * a flag would spend the decision at session start, where no button and no webhook can ever act.
 *
 * The branch is deleted only when the ask says so (`deleteBranch`), and an unmerged branch only
 * when the ask also says `force`; that is the provider's own rule. Removing a directory is
 * reversible (the commits are still on the branch); deleting a branch is not, so it is opt-in per
 * ask and never a standing setting.
 *
 * A worktree is addressed by its key OR by its path — exactly one. A key is what the controller
 * asked for at `session_new`; a path is what the host observed, and the one name a controller holds
 * for a worktree whose session asked for no key. The host resolves a path to the key of the
 * directory directly under its workspace root, and refuses any other path by name.
 */
export interface WorkspaceRelease {
  readonly kind: 'workspace_release';
  readonly requestId: string;
  /** The key the workspace was provisioned at, or null when `path` names it. */
  readonly workspaceKey: string | null;
  /** The worktree's absolute path, or null when `workspaceKey` names it. */
  readonly path: string | null;
  /** Delete the branch the worktree is on, after the directory. */
  readonly deleteBranch: boolean;
  /** Delete the branch even when it is not merged into the repository's default branch. */
  readonly force: boolean;
}

/**
 * The reap's answer, and every exit is this one kind.
 *
 * `refusal: null` means the workspace was released and its directory removed; a named refusal
 * rides the same kind otherwise: an unusable key, a workspace still backing a live session, a
 * provider failure, a host with no provider at all. One kind for every exit is deliberate rather
 * than the bulk lane's success/failure pair: an ask whose answer dies inside the host is a silent
 * failure on this lane, and a single result kind makes "every exit is a wire answer" a property of
 * the shape instead of a discipline across two builders. It also keeps the answer one small frame,
 * nowhere near the size cap: keys are bounded at `MAX_WORKSPACE_ID_LENGTH` and every refusal echoes
 * at most `keyPreview`, so no key, however degenerate, can inflate this answer toward the cap.
 */
/**
 * What one release did, entry by entry. The two flags are the receipt: a refusal with
 * `directoryRemoved: true` is a partial (the directory went, the branch stayed), stated rather
 * than hidden. `refusal: null` with both flags false is the idempotent answer — already absent.
 */
export interface WorkspaceReleaseEntryResult {
  /** The key the ask resolved to; null when it named nothing this host could resolve. */
  readonly workspaceKey: string | null;
  /** The worktree's path as the provider knows it; null when unknown. */
  readonly path: string | null;
  /** A directory existed and is gone. */
  readonly directoryRemoved: boolean;
  readonly branchDeleted: boolean;
  /** Null = released, or already absent. Otherwise the named reason, `branch-not-merged` included. */
  readonly refusal: WireRefusal | null;
}

export interface WorkspaceReleaseResult extends WorkspaceReleaseEntryResult {
  readonly kind: 'workspace_release_result';
  readonly requestId: string;
}

/** One release in a `workspace_release_bulk`: the single ask's members without the envelope. */
export interface WorkspaceReleaseEntry {
  readonly workspaceKey: string | null;
  readonly path: string | null;
  readonly deleteBranch: boolean;
  readonly force: boolean;
}

/**
 * The most releases one `workspace_release_bulk` may carry: one inventory page, so a controller
 * can clean what it was just shown in one ask, and an answer of that size stays well under the
 * frame cap.
 */
export const MAX_BULK_RELEASES = 25;

/**
 * Release several worktrees in one ask. Each entry is judged and released on its own; one refusal
 * never aborts the rest, and the answer carries one result per entry in the ask's order. A key
 * named twice in one ask is refused on its second entry.
 */
export interface WorkspaceReleaseBulk {
  readonly kind: 'workspace_release_bulk';
  readonly requestId: string;
  readonly releases: readonly WorkspaceReleaseEntry[];
}

export interface WorkspaceReleaseBulkResult {
  readonly kind: 'workspace_release_bulk_result';
  readonly requestId: string;
  readonly results: readonly WorkspaceReleaseEntryResult[];
}

/** The two per-ask flags, both defaulting to the safe side. */
export interface WorkspaceReleaseFlags {
  readonly deleteBranch?: boolean;
  readonly force?: boolean;
}

/** Build a `workspace_release`. A string target is a key; `{ path }` addresses by path. */
export function workspaceRelease(
  requestId: string,
  target: string | { readonly path: string },
  flags: WorkspaceReleaseFlags = {},
): WorkspaceRelease {
  return {
    kind: 'workspace_release',
    requestId,
    workspaceKey: typeof target === 'string' ? target : null,
    path: typeof target === 'string' ? null : target.path,
    deleteBranch: flags.deleteBranch ?? false,
    force: flags.force ?? false,
  };
}

/** Build a `workspace_release_result`. Every omitted member takes the released-or-absent value. */
export function workspaceReleaseResult(
  requestId: string,
  outcome: Partial<WorkspaceReleaseEntryResult> = {},
): WorkspaceReleaseResult {
  return { kind: 'workspace_release_result', requestId, ...workspaceReleaseEntryResult(outcome) };
}

/** Build one entry result with the released-or-absent defaults. */
export function workspaceReleaseEntryResult(
  outcome: Partial<WorkspaceReleaseEntryResult> = {},
): WorkspaceReleaseEntryResult {
  return {
    workspaceKey: outcome.workspaceKey ?? null,
    path: outcome.path ?? null,
    directoryRemoved: outcome.directoryRemoved ?? false,
    branchDeleted: outcome.branchDeleted ?? false,
    refusal: outcome.refusal ?? null,
  };
}

/** Build a `workspace_release_bulk`. */
export function workspaceReleaseBulk(
  requestId: string,
  releases: readonly WorkspaceReleaseEntry[],
): WorkspaceReleaseBulk {
  return { kind: 'workspace_release_bulk', requestId, releases };
}

/** Build a `workspace_release_bulk_result`. */
export function workspaceReleaseBulkResult(
  requestId: string,
  results: readonly WorkspaceReleaseEntryResult[],
): WorkspaceReleaseBulkResult {
  return { kind: 'workspace_release_bulk_result', requestId, results };
}

/**
 * The most entries one `host_configure` may carry: the closed config key set is smaller than this,
 * so a legal ask never meets the bound and an ask past it is malformed rather than large.
 */
export const MAX_CONFIGURE_ENTRIES = 8;

/**
 * One setting in a `host_configure` ask. `value: null` removes the key from the host's config
 * file; the wire has no `undefined`, and a list of entries carries exactly what was asked, so no
 * sentinel is needed for "not mentioned".
 */
export interface HostConfigureEntry {
  readonly key: string;
  readonly value: string | null;
}

/**
 * Ask this host to change its own configuration. Host-scoped, like the discovery asks and the
 * reap: the routing key is a channel the controller chose.
 *
 * The host validates every entry before it touches disk (the keys it takes over the wire, the
 * shape of each value, the posture the whole set produces), writes its config file through the
 * same module `periscope config` uses, and rebuilds what can be rebuilt live. A change to the
 * workspace roots is refused while any session is live or opening: a session releases through
 * the provider that provisioned it, and swapping roots under one turns that release into a guess.
 * The environment still wins per key; a written value the environment shadows is reported as
 * overridden rather than silently inert.
 */
export interface HostConfigure {
  readonly kind: 'host_configure';
  readonly requestId: string;
  readonly entries: readonly HostConfigureEntry[];
}

/**
 * The configure's answer, and every exit is this one kind.
 *
 * `configuration` is the EFFECTIVE view after the act, refused or not: on a refusal it is the
 * unchanged view, so a controller always learns what the host runs with. `overriddenByEnvironment`
 * names the wire-settable keys the host's environment sets, whose file values are unreachable.
 */
export interface HostConfigureResult {
  readonly kind: 'host_configure_result';
  readonly requestId: string;
  readonly configuration: HostConfiguration;
  readonly overriddenByEnvironment: readonly string[];
  /** The keys written but not in effect until the next start: the two control-plane URLs. */
  readonly pendingRestart: readonly string[];
  /** Null = every entry applied. Otherwise the named reason nothing was written. */
  readonly refusal: WireRefusal | null;
}

/**
 * How many worktrees one `workspace_list_result` carries. A path is bounded at 1000 characters, a
 * branch at 400 and a key at 200, so a full page stays under the frame cap with the same margin
 * the transcript page keeps.
 */
export const WORKSPACE_PAGE_SIZE = 25;

/**
 * How many entries one `transcript_list_result` carries.
 *
 * Bounded so the frame stays well under `MAX_FRAME_BYTES` (64 KiB): an entry is a slug (measured
 * up to about 80 characters on one real 139-slug corpus), a 36-character session id and two
 * integers, comfortably under 300 bytes of JSON each, so 100 entries is under half the cap even
 * with slugs twice as long as any measured one.
 */
export const TRANSCRIPT_PAGE_SIZE = 100;

/**
 * The bulk-lane locator namespace for a transcript read: `claude-transcript:{projectSlug}/{sessionId}`.
 * A `bulk_request.what` that a host resolves to the agent CLI's own transcript files starts with
 * this prefix; the slug is the CLI's flattened project directory name and is opaque.
 *
 * It is the one instance of the namespace `{runtime}-transcript:{...}`: a runtime's transcripts are
 * addressed under that runtime's name, so a locator says whose files it reads. This host serves the
 * `claude` instance and refuses every other prefix `bulk-target-invalid`.
 */
export const TRANSCRIPT_WHAT_PREFIX = 'claude-transcript:';

/**
 * One worktree under the host's workspace root, as git reports it. `key` is the directory's
 * last segment, which is the workspace key the host provisioned it at, so a controller can address
 * it by key; `path` is what the host's transitions carry as `where.worktree`, so a controller can
 * address it by path as well. `merged` says whether the branch's tip is already in the
 * repository's default branch, null when no default branch could be named.
 */
export interface WorkspaceListEntry {
  readonly key: string;
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly merged: boolean | null;
  /**
   * How many commits the branch holds past the default branch (`rev-list --count <default>..<branch>`).
   * Zero with `merged: true` is "nothing here yet", not "merged work"; null when detached or when no
   * default branch could be named.
   */
  readonly aheadCount: number | null;
  readonly lastCommitAt: string | null;
}

/**
 * Ask this host what worktrees exist under its workspace root, from disk. Host-scoped and paged
 * like `transcript_list`. Only what the host provisioned is listed: the repository itself and any
 * checkout outside the workspace root never appear, so no cleanup a controller composes from this
 * answer can name them.
 */
export interface WorkspaceList {
  readonly kind: 'workspace_list';
  readonly requestId: string;
  readonly fromIndex: number;
}

/** The inventory's answer; every exit is this one kind. `refusal` non-null = the host could not look. */
export interface WorkspaceListResult {
  readonly kind: 'workspace_list_result';
  readonly requestId: string;
  readonly entries: readonly WorkspaceListEntry[];
  readonly totalCount: number;
  readonly nextIndex: number | null;
  readonly defaultBranch: string | null;
  readonly refusal: WireRefusal | null;
}

/** Build a `workspace_list`. The only supported way to put one on the wire. */
export function workspaceList(requestId: string, fromIndex = 0): WorkspaceList {
  return { kind: 'workspace_list', requestId, fromIndex };
}

/** Build a `workspace_list_result`. Fills `refusal` with null, the answered page. */
export function workspaceListResult(
  requestId: string,
  entries: readonly WorkspaceListEntry[],
  page: { readonly totalCount: number; readonly nextIndex?: number; readonly defaultBranch?: string | null },
  refusal?: WireRefusal,
): WorkspaceListResult {
  return {
    kind: 'workspace_list_result',
    requestId,
    entries,
    totalCount: page.totalCount,
    nextIndex: page.nextIndex ?? null,
    defaultBranch: page.defaultBranch ?? null,
    refusal: refusal ?? null,
  };
}

/** Build a `host_configure`. The only supported way to put one on the wire. */
export function hostConfigure(requestId: string, entries: readonly HostConfigureEntry[]): HostConfigure {
  return { kind: 'host_configure', requestId, entries };
}

/** Build a `host_configure_result`. Fills `refusal` with null, the applied answer. */
export function hostConfigureResult(
  requestId: string,
  configuration: HostConfiguration,
  overriddenByEnvironment: readonly string[],
  refusal?: WireRefusal,
  pendingRestart: readonly string[] = [],
): HostConfigureResult {
  return {
    kind: 'host_configure_result',
    requestId,
    configuration,
    overriddenByEnvironment,
    pendingRestart,
    refusal: refusal ?? null,
  };
}

/** Build a `session_list`. The only supported way to put one on the wire. */
export function sessionList(requestId: string): SessionList {
  return { kind: 'session_list', requestId };
}

/** Build a `session_list_result`. */
export function sessionListResult(
  requestId: string,
  sessions: readonly SessionListEntry[],
  counts: { liveCount: number; provisioningCount: number },
): SessionListResult {
  return {
    kind: 'session_list_result',
    requestId,
    sessions,
    liveCount: counts.liveCount,
    provisioningCount: counts.provisioningCount,
  };
}

/** Build a `transcript_list`. `fromIndex` defaults to the start. */
export function transcriptList(requestId: string, fromIndex = 0): TranscriptList {
  return { kind: 'transcript_list', requestId, fromIndex };
}

/** Build a `transcript_list_result`. Fills `nextIndex` with null so absence is stated, not deleted. */
export function transcriptListResult(
  requestId: string,
  entries: readonly TranscriptListEntry[],
  totals: { totalCount: number; nextIndex?: number },
): TranscriptListResult {
  return {
    kind: 'transcript_list_result',
    requestId,
    entries,
    totalCount: totals.totalCount,
    nextIndex: totals.nextIndex ?? null,
  };
}

/** Build a `transcript_tail`. Fills `needle` with null, meaning "any user-text entry". */
export function transcriptTail(
  requestId: string,
  projectSlug: string,
  sessionId: string,
  fromOffset: number,
  needle?: string,
): TranscriptTail {
  return { kind: 'transcript_tail', requestId, projectSlug, sessionId, fromOffset, needle: needle ?? null };
}

/** Build a `transcript_tail_result`. Fills the stat pair with null so absence is stated. */
export function transcriptTailResult(
  requestId: string,
  answer: { found: boolean; absent: boolean; newOffset: number; sizeBytes?: number; mtimeMs?: number },
): TranscriptTailResult {
  return {
    kind: 'transcript_tail_result',
    requestId,
    found: answer.found,
    absent: answer.absent,
    newOffset: answer.newOffset,
    sizeBytes: answer.sizeBytes ?? null,
    mtimeMs: answer.mtimeMs ?? null,
  };
}

/** Build a `transcript_failed`. */
export function transcriptFailed(requestId: string, refusal: WireRefusal): TranscriptFailed {
  return { kind: 'transcript_failed', requestId, refusal };
}

// ---------------------------------------------------------------------------
// The repository read: a controller reading the operator's checkout, jailed and bounded.
// ---------------------------------------------------------------------------

/**
 * How many entries one `repository_list_result` carries. A directory with more than this many
 * children is listed to the cap and marked `truncated`; names are bounded by the filesystem, so a
 * full page stays well under the frame cap.
 */
export const MAX_REPOSITORY_ENTRIES = 500;

/**
 * The most text one `repository_read_result` carries. The frame cap is 64 KiB and the envelope plus
 * JSON escaping must fit inside it, so the text is bounded below the cap with margin; a longer file
 * is answered to this many bytes and marked `truncated`.
 */
export const MAX_REPOSITORY_READ_BYTES = 48 * 1024;

/**
 * Ask this host to list one directory of its repository, by a path relative to the repository root
 * (`''` is the root itself). Host-scoped like `transcript_list`. The host answers names only and
 * never leaves the root: a path that resolves outside it is refused by name, so a controller can
 * show a checkout's shape and pick a file to read without the host ever serving another directory.
 */
export interface RepositoryList {
  readonly kind: 'repository_list';
  readonly requestId: string;
  readonly path: string;
}

/** One child of a listed directory: its name, whether it is a directory, and its stat pair. */
export interface RepositoryEntry {
  readonly name: string;
  readonly directory: boolean;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/** The listing's answer; every exit is this one kind. `refusal` non-null = nothing was listed. */
export interface RepositoryListResult {
  readonly kind: 'repository_list_result';
  readonly requestId: string;
  /** Sorted by name, at most `MAX_REPOSITORY_ENTRIES`. */
  readonly entries: readonly RepositoryEntry[];
  /** True when the directory held more than the cap. */
  readonly truncated: boolean;
  readonly refusal: WireRefusal | null;
}

/**
 * Ask this host for the text of one file of its repository, by a path relative to the repository
 * root, at most `maxBytes` of it (1 to `MAX_REPOSITORY_READ_BYTES`). Text files only: a file with a
 * NUL byte in its head is refused rather than served, because the answer is a string.
 */
export interface RepositoryRead {
  readonly kind: 'repository_read';
  readonly requestId: string;
  readonly path: string;
  readonly maxBytes: number;
}

/** The read's answer; every exit is this one kind. `text` is null exactly when `refusal` is not. */
export interface RepositoryReadResult {
  readonly kind: 'repository_read_result';
  readonly requestId: string;
  /** UTF-8 text, the first `maxBytes` of the file at most. */
  readonly text: string | null;
  /** The file's whole size, so a caller can see how much `truncated` left behind. */
  readonly sizeBytes: number;
  readonly truncated: boolean;
  readonly refusal: WireRefusal | null;
}

/** Build a `repository_list`. The only supported way to put one on the wire. */
export function repositoryList(requestId: string, path = ''): RepositoryList {
  return { kind: 'repository_list', requestId, path };
}

/** Build a `repository_list_result`. Fills `refusal` with null, the listed answer. */
export function repositoryListResult(
  requestId: string,
  entries: readonly RepositoryEntry[],
  truncated = false,
  refusal?: WireRefusal,
): RepositoryListResult {
  return { kind: 'repository_list_result', requestId, entries, truncated, refusal: refusal ?? null };
}

/** Build a `repository_read`. Fills `maxBytes` with the cap. */
export function repositoryRead(
  requestId: string,
  path: string,
  maxBytes = MAX_REPOSITORY_READ_BYTES,
): RepositoryRead {
  return { kind: 'repository_read', requestId, path, maxBytes };
}

/** Build a `repository_read_result`. Fills `refusal` with null, the read answer. */
export function repositoryReadResult(
  requestId: string,
  read: { readonly text: string | null; readonly sizeBytes: number; readonly truncated: boolean },
  refusal?: WireRefusal,
): RepositoryReadResult {
  return {
    kind: 'repository_read_result',
    requestId,
    text: read.text,
    sizeBytes: read.sizeBytes,
    truncated: read.truncated,
    refusal: refusal ?? null,
  };
}

// ---------------------------------------------------------------------------
// The workspace read: a controller reading a text file inside a workspace this host provisioned.
// ---------------------------------------------------------------------------

/**
 * The most text one `workspace_read_result` carries, with the repository read's margin under the
 * frame cap. A longer file is read in pages: each answer says where the next one starts.
 */
export const MAX_WORKSPACE_READ_BYTES = 48 * 1024;

/**
 * The largest file the workspace read serves. Pages keep every frame under the cap; this bound keeps
 * the link a command lane rather than a file transfer, so a larger file is refused by name.
 */
export const MAX_WORKSPACE_FILE_BYTES = 512 * 1024;

/**
 * Ask this host for the text of one file inside a workspace it provisioned: the workspace by its key,
 * the file by a path relative to the workspace's directory, from byte `offset` and at most `maxBytes`
 * of it (1 to `MAX_WORKSPACE_READ_BYTES`). Host-scoped like `repository_read`, so it needs no live
 * session; a workspace outlives the sessions that worked in it. The repository read's jail and
 * protected set apply, over the workspace's directory. Text files only, at most
 * `MAX_WORKSPACE_FILE_BYTES` of them.
 */
export interface WorkspaceRead {
  readonly kind: 'workspace_read';
  readonly requestId: string;
  readonly workspaceKey: string;
  readonly path: string;
  /** Where the page starts, in bytes: 0, or the `nextOffset` of the answer before it. */
  readonly offset: number;
  readonly maxBytes: number;
}

/** The read's answer; every exit is this one kind. `text` is null exactly when `refusal` is not. */
export interface WorkspaceReadResult {
  readonly kind: 'workspace_read_result';
  readonly requestId: string;
  /** UTF-8 text from `offset`, at most `maxBytes` of it, cut on a character boundary. */
  readonly text: string | null;
  /** The file's whole size in bytes. */
  readonly sizeBytes: number;
  /** Where the next page starts, or null when this page reached the end of the file. */
  readonly nextOffset: number | null;
  readonly refusal: WireRefusal | null;
}

/** Build a `workspace_read`. Fills `offset` with 0 and `maxBytes` with the cap. */
export function workspaceRead(
  requestId: string,
  workspaceKey: string,
  path: string,
  offset = 0,
  maxBytes = MAX_WORKSPACE_READ_BYTES,
): WorkspaceRead {
  return { kind: 'workspace_read', requestId, workspaceKey, path, offset, maxBytes };
}

/** Build a `workspace_read_result`. Fills `refusal` with null, the read answer. */
export function workspaceReadResult(
  requestId: string,
  read: { readonly text: string | null; readonly sizeBytes: number; readonly nextOffset: number | null },
  refusal?: WireRefusal,
): WorkspaceReadResult {
  return {
    kind: 'workspace_read_result',
    requestId,
    text: read.text,
    sizeBytes: read.sizeBytes,
    nextOffset: read.nextOffset,
    refusal: refusal ?? null,
  };
}

/**
 * A refusal as it arrives from the wire: `reason` is a plain string, not the closed enum.
 *
 * Strict out, tolerant in, and the asymmetry is deliberate. Nothing this host writes can
 * carry an undeclared reason: `encode` validates it on the way out, so the guarantee is enforced at
 * the one place a frame becomes bytes rather than resting on a type a cast defeats. But a frame
 * arriving with a reason this build has never seen is a newer peer, not a corrupt frame, and
 * rejecting it would destroy a delivery receipt (the outcome, the delivery id, the detail) over a
 * word. `codec.ts`'s own header already promises "unknown fields survive… an older host relaying a
 * frame does not quietly destroy information it did not understand"; a closed enum value is that
 * same information one level in.
 *
 * Read it with `readRefusal`. Same shape and same argument as `SessionUpdate.body` above: a
 * producer cannot build a malformed one, a consumer cannot read one without checking, and the wire
 * stays tolerant.
 */
export interface WireRefusal {
  /** A `RefusalReason` when this build knows it; any string when the peer is newer. */
  readonly reason: string;
  readonly detail: string;
}

/**
 * A refusal read off the wire: recognised and narrowed, or unrecognised with the raw value kept.
 *
 * The raw string travels. An unrecognised reason is never mapped onto a known one and never
 * dropped: a consumer that discards what it did not understand makes a newer peer's failure
 * invisible on the only side that could have reported it. This is the gate's unknown-decision rule
 * in the transport: an unrecognised value is a named outcome, not a silent conversion.
 */
export type ReadRefusal =
  | { readonly recognised: true; readonly refusal: Refusal }
  | { readonly recognised: false; readonly raw: string; readonly detail: string };

export function readRefusal(wire: WireRefusal): ReadRefusal {
  if (isRefusalReason(wire.reason)) {
    return { recognised: true, refusal: { reason: wire.reason, detail: wire.detail } };
  }
  return { recognised: false, raw: wire.reason, detail: wire.detail };
}

export type SessionPayload =
  | SessionUpdate
  | SessionDelta
  | SessionNew
  | SessionPrompt
  | SessionCancel
  | SessionEnd
  | SessionConfigure
  | BulkRequest
  | BulkDelivered
  | BulkFailed
  | SessionList
  | SessionListResult
  | TranscriptList
  | TranscriptListResult
  | TranscriptTail
  | TranscriptTailResult
  | TranscriptFailed
  | WorkspaceRelease
  | WorkspaceReleaseResult
  | WorkspaceReleaseBulk
  | WorkspaceReleaseBulkResult
  | HostConfigure
  | HostConfigureResult
  | WorkspaceList
  | WorkspaceListResult
  | RepositoryList
  | RepositoryListResult
  | RepositoryRead
  | RepositoryReadResult
  | WorkspaceRead
  | WorkspaceReadResult
  | AnswerRefused;

export type SessionPayloadKind = SessionPayload['kind'];

/**
 * What may be dropped when the offline queue is full, stated as data so the decision lives in one
 * place instead of inside a queue method. Everything absent from this list is a transition or a
 * receipt, and losing one of those is a lie about what happened.
 */
export const DROPPABLE_KINDS: readonly SessionPayloadKind[] = ['session_delta'];

export function isDroppable(kind: SessionPayloadKind): boolean {
  return DROPPABLE_KINDS.includes(kind);
}

// ---------------------------------------------------------------------------
// Control payloads — the link's own lifecycle. Never sequenced, never replayed.
// ---------------------------------------------------------------------------

/**
 * The longest value `HostConfiguration` carries. Paths and URLs are host-controlled text on a
 * frame the controller must accept before anything else, so each is bounded here rather than
 * trusted; a controller stores them under the same cap.
 */
export const MAX_CONFIGURATION_VALUE_LENGTH = 1000;

/** The most plugin directories a configuration names: a list, not a catalogue. */
export const MAX_PLUGIN_DIRS = 8;

/**
 * One plugin this host loads into every session: its manifest's name (the namespace its skills
 * carry), its version when the manifest declares one, and the directory as configured. Reported in
 * the hello so a controller knows what a session on this host can invoke before it opens one.
 */
export interface HostPlugin {
  readonly name: string;
  readonly version: string | null;
  readonly path: string;
}

/** The most models a catalog lists. The agent offers a handful; a hello is not a registry. */
export const MAX_AGENT_MODELS = 32;

/**
 * The most bytes the catalog may take on the hello, as JSON. Each member is bounded on its own, but
 * a hello past `MAX_FRAME_BYTES` is never sent at all, so the whole is bounded too: a host whose
 * catalog is past this sends `agent: null` rather than a hello it cannot encode.
 */
export const MAX_AGENT_CATALOG_BYTES = 16 * 1024;

/**
 * One model the agent offers, as its answer to the SDK's initialize request lists it. `value` is
 * what `session_new` and `session_configure` take as `model`; `resolvedModel` is the model id an
 * alias stands for, so a controller holding an explicit id can find the alias that covers it. The
 * `supports*` members are null when the agent did not say.
 */
export interface HostModel {
  readonly value: string;
  readonly resolvedModel: string | null;
  readonly displayName: string;
  readonly description: string | null;
  /** The effort levels this model takes; empty when it takes none. */
  readonly supportedEffortLevels: readonly string[];
  readonly supportsFastMode: boolean | null;
  readonly supportsAutoMode: boolean | null;
  readonly supportsAdaptiveThinking: boolean | null;
}

/**
 * The agent this host runs sessions on: the Claude Code version the installed agent SDK bundles,
 * that SDK's version, and the models the agent offers. Read once at start, by asking the agent
 * without sending it a prompt, so no model is called.
 */
export interface HostAgent {
  readonly claudeCodeVersion: string;
  readonly sdkVersion: string;
  readonly models: readonly HostModel[];
}

/**
 * How this host is configured, as values: the read half of `periscope config`.
 *
 * The `workspace:*` capability markers say which mode a host is in; these say what it is pointed
 * at. Every member but `agent` is `T | null` (absent is null, never undefined), and null means the
 * setting is not set on the host, not that the host declined to say. `agent` was added inside the
 * protocol window and is optional (see this file's header). `controllerUrl` is what the host
 * dialled to deliver this frame, reported so a controller can show it beside the rest; nothing here
 * is an ask, so nothing here can be refused.
 */
export interface HostConfiguration {
  readonly repositoryRoot: string | null;
  readonly workspaceRoot: string | null;
  readonly branchScheme: string | null;
  /** Where the agent keeps its transcripts: derived from `agentHome`. Reported, never set on its own. */
  readonly transcriptsRoot: string | null;
  /**
   * The controller link URL the host's configuration names. Settable over the link; the value
   * in effect is the one dialled at start, so a change rides `pendingRestart` until the next start.
   */
  readonly controllerUrl: string | null;
  /** The decision endpoint the host's configuration names. Settable over the link, same rule. */
  readonly decisionUrl: string | null;
  /** Where the agent CLI keeps its state. Settable over the link; the transcripts root derives from it. */
  readonly agentHome: string | null;
  /**
   * The plugins every session on this host loads, from `PERISCOPE_PLUGIN_DIRS`. Settable over the
   * link and applied to the next open; empty when none are configured.
   */
  readonly plugins: readonly HostPlugin[];
  /**
   * The agent's versions and model catalog (protocol 12). Null when the host asked and got no
   * usable answer; absent when the host was composed without a catalog read, and from a host one
   * release behind. Never settable.
   */
  readonly agent?: HostAgent | null;
}

/** A `HostConfiguration` with nothing set: what a host composed without one reports. */
export function unsetHostConfiguration(): HostConfiguration {
  return {
    repositoryRoot: null,
    workspaceRoot: null,
    branchScheme: null,
    transcriptsRoot: null,
    controllerUrl: null,
    decisionUrl: null,
    agentHome: null,
    plugins: [],
  };
}

/** The host's opening frame. Capability negotiation at hello, borrowed from ACP. */
export interface LinkHello {
  readonly kind: 'link_hello';
  readonly protocolVersion: number;
  readonly hostId: string;
  readonly capabilities: readonly string[];
  /** What the host already holds per session, so the controller knows what can be replayed. */
  readonly cursors: readonly SessionCursor[];
  /** The values this host runs with. Reported, never negotiated. */
  readonly configuration: HostConfiguration;
  /**
   * The keys whose configured value is not the one in effect: written to the file, dialled
   * only at the next start. Empty on a host that runs what its file says.
   */
  readonly pendingRestart: readonly string[];
  /**
   * The versions this host speaks. `protocolVersion` stays the newest of them; the controller
   * answers with its choice inside the overlap of the two windows.
   */
  readonly protocolRange: ProtocolRange;
}

/**
 * The controller's answer. `protocolVersion` is the version the controller chose inside the overlap
 * of the two windows; the host accepts any version in its own window and refuses the rest, naming
 * both windows.
 */
export interface LinkWelcome {
  readonly kind: 'link_welcome';
  readonly protocolVersion: number;
  /**
   * The versions the controller speaks, so the host can report the overlap it was offered. Null
   * from a controller that predates it; the negotiated `protocolVersion` is the fact either way.
   */
  readonly protocolRange: ProtocolRange | null;
  readonly capabilities: readonly string[];
  /** The last `seq` the controller received per session — the host replays past these. */
  readonly cursors: readonly SessionCursor[];
}

export interface SessionCursor {
  readonly sessionId: string;
  readonly seq: number;
}

/**
 * What the controller has durably received, per session.
 *
 * Without this the host cannot know when a frame is safe to forget, so it would either discard on
 * write — losing anything in flight when a socket dies — or retain forever. The ack is what makes
 * the retention window finite AND replay complete.
 */
export interface LinkAck {
  readonly kind: 'link_ack';
  readonly cursors: readonly SessionCursor[];
}

/** Heartbeat, both directions. A half-open socket answers neither. */
export interface LinkPing {
  readonly kind: 'link_ping';
  readonly nonce: string;
}

export interface LinkPong {
  readonly kind: 'link_pong';
  readonly nonce: string;
}

/** A deliberate close, carrying why. A silent disconnect is the thing this exists to distinguish. */
export interface LinkBye {
  readonly kind: 'link_bye';
  readonly cause: string;
}

export type ControlPayload = LinkHello | LinkWelcome | LinkAck | LinkPing | LinkPong | LinkBye;

export type ControlPayloadKind = ControlPayload['kind'];

// ---------------------------------------------------------------------------
// The envelope.
// ---------------------------------------------------------------------------

/**
 * A sequenced, replayable frame belonging to one session.
 *
 * `seq` is monotonic per session per direction, from 1, dense (+1 per frame). Dense is what makes
 * a gap detectable by arithmetic alone: the receiver's expected next is always `last + 1`.
 *
 * A seq is minted only when its frame is first written to the wire. Anything refused or dropped
 * before that moment never had one, so designed loss (an oversized payload, a discard or a
 * displacement under pressure) cannot put a hole in the numbering. That is what lets "dense" be
 * a construction rather than a hope.
 *
 * ---------------------------------------------------------------------------------------------
 * There are three session ids in this package and they are not interchangeable. Conflating any
 * pair produces a trace that lies, so all three are named here, once:
 *
 *   `SessionFrame.sessionId`         The routing and ordering key. The controller chooses it, and
 *                                    it must, because `session_new` addresses a session that does
 *                                    not exist yet. It is what `seq` is dense per, and it is
 *                                    stable for the session's whole life. The host maps and orders
 *                                    by it; interpreting it is this field's job.
 *
 *   `SessionTransition.sessionId`    The agent's own id, and a fact rather than a key. The agent
 *                                    mints it at `system/init`; it is `null` before that and never
 *                                    null again. The host carries it and never invents one.
 *
 *   `SessionTransition.correlationId` The controller's meaning handle, and opaque. Never
 *                                    interpreted here; see its own comment in state/model.ts.
 *
 * A controller will very likely pass the same string as the routing key and the correlation id.
 * That is fine and expected. The host must still never assume it, derive one from the other, or
 * fall back from one to the other: they differ in contract even when they coincide in value. One
 * is interpreted by construction, the other is forbidden to be.
 *
 * The consequence that makes this load-bearing rather than tidy: a session's first transitions are
 * recorded before the agent has named itself (`UserPromptSubmit` fires ahead of `system/init`), and
 * a session that dies in start-up never names itself at all. Keying frames by the agent's id would
 * make exactly those frames unsendable, and they are the ones that explain the failure.
 * ---------------------------------------------------------------------------------------------
 */
export interface SessionFrame {
  readonly frame: 'session';
  readonly sessionId: string;
  readonly seq: number;
  readonly at: string; // ISO-8601 UTC
  readonly payload: SessionPayload;
}

/** An unsequenced frame about the link itself. */
export interface ControlFrame {
  readonly frame: 'control';
  readonly at: string; // ISO-8601 UTC
  readonly payload: ControlPayload;
}

export type Frame = SessionFrame | ControlFrame;

export function isSessionFrame(frame: Frame): frame is SessionFrame {
  return frame.frame === 'session';
}

export function isControlFrame(frame: Frame): frame is ControlFrame {
  return frame.frame === 'control';
}

/**
 * A frame's identity, and the reason `seq` is shaped this way: this string is exactly what an SSE
 * `Last-Event-ID` header carries. Moving to one stream per session later needs no change to the
 * frame; the cursor set decomposes into per-stream ids one for one.
 */
export function frameId(frame: SessionFrame): string {
  return `${frame.sessionId}/${frame.seq}`;
}

// ---------------------------------------------------------------------------

/** JSON, as a type. Bodies are parsed but not interpreted here. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
