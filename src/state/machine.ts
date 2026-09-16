/**
 * The state machine for one session. It records; it never decides what a session means.
 *
 * The state is the record, and that is the whole design.
 * `state`, `activity` and `sessionId` are all derived from the last recorded transition and the
 * open-entry set. There is no separate field to assign, so a code path that skips the record also
 * fails to change the state — suppression is self-defeating instead of silent.
 *
 * That inversion is the point. With a separate state field, one early return can skip a publish
 * and a state stamp together: the control concern wins, and the observability loss is invisible —
 * no error, no null, just a column that stays `running` forever while every reader infers. Here
 * the same edit would leave the session stuck in its previous state, visibly, in the next thing
 * anyone read.
 *
 * What is deliberately not in scope here, so the suppressing branch cannot be written.
 * This module imports the pure core and its own model, and nothing else. It cannot see an observer
 * count, a controller link, a registry, or how a session was created — so there is no session-class
 * fact available to condition an emission on, whatever a later editor intends. Pinned by
 * pins/state-record.test.ts.
 *
 * It never throws. A transition that cannot name its cause is refused, counted, and reported on
 * `onRejected` — but not thrown, because these calls run inside hook handlers that are wrapped in
 * `try/catch` by contract, and a thrown rejection would be swallowed there. Silent loss is the one
 * failure this module exists to make impossible, so "loud" here means observable and counted.
 */
import type { Clock, Ticker } from '../core/time.js';
import type { Refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type {
  AgedEntry,
  OpenEntry,
  SessionActivity,
  SessionSnapshot,
  SessionState,
  SessionTransition,
  TransitionCause,
  TransitionWhere,
} from './model.js';
import { isCauseEvent, isCauseKind } from './model.js';

/** Opens, closes or backgrounds one entry. `null` on a request means the entry set is untouched. */
export type EntryOp =
  | {
      readonly op: 'open';
      readonly entryId: string;
      readonly activity: SessionActivity;
      /** Set when the entry belongs to a subagent rather than the main thread. */
      readonly agentId?: string | null;
    }
  | { readonly op: 'close'; readonly entryId: string }
  | { readonly op: 'background'; readonly entryId: string }
  /** Mark every still-open entry abandoned. Marks — never erases. */
  | { readonly op: 'abandon-open'; readonly reason: string };

export interface TransitionRequest {
  readonly to: SessionState;
  readonly cause: TransitionCause;
  readonly entry?: EntryOp | null;
  /** Supplied once, when the agent reports itself. Carried forward automatically after that. */
  readonly sessionId?: string | null;
  /**
   * A new `where`, when this transition is what changed it.
   *
   * The agent can change its own working directory mid-session, and every later transition has to
   * carry the new one — a trace whose `where` silently describes a directory the session left is
   * worse than one with no `where` at all. Carried forward automatically when absent, so it is
   * derived from the record like everything else rather than living in a field of its own.
   */
  readonly where?: TransitionWhere | null;
  /** Overrides the clock. For a caller that already stamped the originating event. */
  readonly at?: string | null;
}

export interface RejectedTransition {
  readonly refusal: Refusal;
  readonly at: string;
  readonly attempted: TransitionRequest;
}

export type TransitionListener = (transition: SessionTransition) => void;
export type RejectionListener = (rejected: RejectedTransition) => void;
export type Unsubscribe = () => void;

export interface StateMachineOptions {
  readonly where: TransitionWhere;
  readonly clock: Clock;
  readonly ticker: Ticker;
  /** Opaque and never interpreted. See SessionTransition.correlationId. */
  readonly correlationId?: string | null;
}

/**
 * The state a machine holds before anything has been recorded.
 *
 * A machine is constructed at the moment a process is asked for, and the first record is the
 * `spawning` one. Until then `from` has to be something, and `spawning` is the honest answer: the
 * caller has already decided to start a session.
 */
const INITIAL_STATE: SessionState = 'spawning';

export class SessionStateMachine {
  /** Only until the first record. After that `where` is derived like everything else. */
  readonly #initialWhere: TransitionWhere;
  readonly #clock: Clock;
  readonly #ticker: Ticker;
  readonly #correlationId: string | null;

  readonly #entries = new Map<string, OpenEntry>();
  readonly #listeners = new Set<TransitionListener>();
  readonly #rejectionListeners = new Set<RejectionListener>();

  /** The last recorded transition. The only mutable state, assigned in exactly one place. */
  #current: SessionTransition | null = null;
  #seq = 0;
  #rejectedCount = 0;

  constructor(options: StateMachineOptions) {
    this.#initialWhere = options.where;
    this.#clock = options.clock;
    this.#ticker = options.ticker;
    this.#correlationId = options.correlationId ?? null;
  }

  /** Derived from the last transition. There is no field to set. */
  get state(): SessionState {
    return this.#current?.to ?? INITIAL_STATE;
  }

  /** Derived from the open-entry set. There is no field to set. */
  get activity(): SessionActivity | null {
    return foregroundActivity(this.#entries);
  }

  /** Null until the agent reports itself; carried forward after. There is no field to set. */
  get sessionId(): string | null {
    return this.#current?.sessionId ?? null;
  }

  get correlationId(): string | null {
    return this.#correlationId;
  }

  /** Derived from the last transition. There is no field to set. */
  get where(): TransitionWhere {
    return this.#current?.where ?? this.#initialWhere;
  }

  get transitionCount(): number {
    return this.#seq;
  }

  /** How many transitions were refused for an unnameable cause. Never silently zero. */
  get rejectedCount(): number {
    return this.#rejectedCount;
  }

  /** Every entry that has not exited, with the number a human wants: how long it has been open. */
  openEntries(): AgedEntry[] {
    const now = this.#ticker();
    return [...this.#entries.values()].map((entry) => ({
      ...entry,
      ageMs: Math.max(0, now - Date.parse(entry.openedAt)),
    }));
  }

  onTransition(listener: TransitionListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onRejected(listener: RejectionListener): Unsubscribe {
    this.#rejectionListeners.add(listener);
    return () => this.#rejectionListeners.delete(listener);
  }

  /**
   * Record a transition. The only way a session's state changes.
   *
   * The only thing this branches on is whether the cause can be named. Nothing about which
   * session this is, how it was created, or whether anyone is listening is reachable from here —
   * see this file's header. `#commit` below is straight-line by construction.
   */
  record(request: TransitionRequest): Result<SessionTransition> {
    const named = nameable(request.cause);
    if (named !== null) return this.#reject(named, request);
    return ok(this.#commit(request));
  }

  /** What this host can say about this session. Raw material for a controller — not a roster. */
  snapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      correlationId: this.#correlationId,
      state: this.state,
      activity: this.activity,
      where: this.where,
      openEntries: this.openEntries(),
      lastTransitionAt: this.#current?.at ?? null,
      transitionCount: this.#seq,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * The single mutation point. Straight-line: every call that reaches here records.
   *
   * Do not add a guard to this method. A condition here is a session whose state changed without
   * saying so, which is the defect this whole module exists to prevent.
   */
  #commit(request: TransitionRequest): SessionTransition {
    const carried = carryForward(request, this.#current, this.#initialWhere, this.#clock);
    const entryId = applyEntryOp(this.#entries, carried.entry, carried.at, request.cause);

    this.#seq += 1;
    const transition: SessionTransition = {
      sessionId: carried.sessionId,
      seq: this.#seq,
      at: carried.at,
      from: carried.from,
      to: request.to,
      activity: foregroundActivity(this.#entries),
      entryId,
      cause: request.cause,
      where: carried.where,
      correlationId: this.#correlationId,
    };
    this.#current = transition;

    for (const listener of this.#listeners) listener(transition);
    return transition;
  }

  #reject(detail: string, attempted: TransitionRequest): Result<SessionTransition> {
    this.#rejectedCount += 1;
    const refusal: Refusal = { reason: 'transition-cause-unnamed', detail };
    const rejected: RejectedTransition = { refusal, at: this.#clock(), attempted };
    for (const listener of this.#rejectionListeners) listener(rejected);
    return refuse<SessionTransition>('transition-cause-unnamed', detail);
  }
}

/**
 * The four values a transition inherits from the one before it, resolved in one place.
 *
 * They are lifted out of `#commit` deliberately. Each is a defaulting expression — "use what was
 * given, else what the last transition carried" — and a defaulting expression is still a branch in
 * the shape of one. Keeping them here leaves the commit path with no conditional of any kind, so
 * "the record cannot be skipped" is a claim a reader can check by looking rather than by trusting.
 */
function carryForward(
  request: TransitionRequest,
  current: SessionTransition | null,
  initialWhere: TransitionWhere,
  clock: Clock,
): {
  at: string;
  from: SessionState;
  sessionId: string | null;
  where: TransitionWhere;
  entry: EntryOp | null;
} {
  return {
    at: request.at ?? clock(),
    from: current?.to ?? INITIAL_STATE,
    sessionId: request.sessionId ?? current?.sessionId ?? null,
    where: request.where ?? current?.where ?? initialWhere,
    entry: request.entry ?? null,
  };
}

/**
 * Null when the cause is nameable, otherwise why it is not.
 *
 * The compiler already closes `CauseEvent`, so this only fires for a value that never met the
 * compiler — a cause rebuilt from a decoded frame, or a caller in plain JavaScript.
 */
function nameable(cause: TransitionCause | undefined | null): string | null {
  if (cause === undefined || cause === null) return 'a transition carried no cause at all';
  if (!isCauseKind(cause.kind)) return `cause.kind "${String(cause.kind)}" is not a declared cause kind`;
  if (typeof cause.event !== 'string' || cause.event.length === 0) return 'cause.event is empty';
  if (!isCauseEvent(cause.event)) return `cause.event "${String(cause.event)}" is not a declared cause event`;
  return null;
}

/**
 * What holds the session right now: the most recently opened foreground entry.
 *
 * Background entries are excluded by construction — that is the whole point of the lane. Abandoned
 * entries are excluded too: they are still recorded and still ageing, but a session is not blocked
 * on work that has been marked as never coming back.
 *
 * Most-recent rather than oldest, because `activity` answers "what is it doing now". "What has it
 * been stuck on longest" is a different question, and `openEntries()` with its ages answers it
 * without this field having to mean two things.
 */
function foregroundActivity(entries: ReadonlyMap<string, OpenEntry>): SessionActivity | null {
  let held: OpenEntry | null = null;
  for (const entry of entries.values()) {
    if (entry.lane !== 'foreground') continue;
    if (entry.abandonedAt !== null) continue;
    held = entry;
  }
  return held?.activity ?? null;
}

/** Applies one entry operation and returns the entry it touched, or null. Pure over the map. */
function applyEntryOp(
  entries: Map<string, OpenEntry>,
  op: EntryOp | null,
  at: string,
  cause: TransitionCause,
): string | null {
  if (op === null) return null;

  if (op.op === 'open') {
    // Re-opening the same entry keeps the original openedAt. Two sources can report the same
    // condition (the compaction hook and the status message both say "compacting"), and taking the
    // later timestamp would silently reset the age — which is the one number an unpaired entry
    // exists to carry. The transition still records either way; only the clock is protected.
    const existing = entries.get(op.entryId);
    const sameThing = existing !== undefined && existing.activity.kind === op.activity.kind;
    entries.set(op.entryId, {
      entryId: op.entryId,
      activity: op.activity,
      lane: 'foreground',
      openedAt: sameThing ? existing.openedAt : at,
      backgroundedAt: null,
      abandonedAt: null,
      abandonReason: null,
      cause,
      agentId: op.agentId ?? null,
    });
    return op.entryId;
  }

  if (op.op === 'close') {
    entries.delete(op.entryId);
    return op.entryId;
  }

  if (op.op === 'background') {
    const open = entries.get(op.entryId);
    // A background report for an entry this host never saw open is not an error and not a state
    // change: the transition still records, naming the id, and the entry set is simply unchanged.
    if (open === undefined) return op.entryId;
    entries.set(op.entryId, { ...open, lane: 'background', backgroundedAt: at });
    return op.entryId;
  }

  // abandon-open: mark, never erase. An entry that never exited is the most useful thing this
  // model can report, and a cleanup that deleted it would destroy exactly that signal.
  for (const [entryId, entry] of entries) {
    if (entry.abandonedAt !== null) continue;
    entries.set(entryId, { ...entry, abandonedAt: at, abandonReason: op.reason });
  }
  return null;
}
