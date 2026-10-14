/**
 * The fact lifts: one per runtime, each reading that runtime's own messages into the wire's facts.
 *
 * A lift is created per session and holds what only a session can know: the last handle and receipt
 * it reported (so a re-sent one reports nothing), the model a turn's usage is filed under, the
 * windows the last result named, and the running tasks it composed. It reads; it never computes a
 * figure the runtime did not report.
 *
 * The forwarder asks it twice: once per message, for the facts and fragments that message carries,
 * and once per compaction the observer reports. Which lift a session gets is decided by its runtime,
 * here and nowhere else.
 */
import type { AgentFact, AgentFragmentDelta } from '../control/frames.js';
import type { SDKMessage } from '../host/agent-process.js';
import { ClaudeFactLift } from '../host/claude-facts.js';
import { CodexFactLift } from '../host/codex-facts.js';
import { QwenFactLift } from '../host/qwen-facts.js';
import { PiFactLift } from '../host/pi-facts.js';
import type { CompactionReport } from '../state/observer.js';

/** What one message carries: facts for the update lane and fragments for the delta lane, in order. */
export interface LiftedFacts {
  readonly facts: readonly AgentFact[];
  readonly fragments: readonly AgentFragmentDelta[];
}

/** One session's lift. `M` is what its runtime emits: the SDK's messages for Claude. */
export interface FactLift<M = SDKMessage> {
  /** The facts and fragments one native message yields; nothing for a message that carries none. */
  fromMessage(message: M): LiftedFacts;
  /** The facts one compaction report yields. */
  fromCompaction(report: CompactionReport): readonly AgentFact[];
}

/**
 * One lift factory per runtime this host can lift facts for, keyed by the runtime's name. Each reads
 * its own runtime's messages, and the composer pairs a session's lift with that session's process.
 */
export const FACT_LIFTS: Readonly<Record<string, () => FactLift<never>>> = {
  claude: () => new ClaudeFactLift(),
  codex: () => new CodexFactLift(),
  'qwen-code': () => new QwenFactLift(),
  pi: () => new PiFactLift(),
};

/** A new lift for one session on `runtime`, or null for a runtime with no lift: it then reports no facts. */
export function factLiftFor<M = SDKMessage>(runtime: string): FactLift<M> | null {
  if (!Object.hasOwn(FACT_LIFTS, runtime)) return null;
  const create = FACT_LIFTS[runtime];
  // The lift registered under a runtime reads that runtime's messages, which is what `M` names here;
  // each entry is typed for no message at all, so it reads as a lift over any.
  return create === undefined ? null : create();
}
