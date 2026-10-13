/**
 * The item fills: one per runtime, each reading that runtime's own messages into the wire's
 * conversation items.
 *
 * A fill is created per session and holds what only a session can know: the session's own thread, the
 * tool calls it has seen start, the calls a gate refused. It reports; it never invents a member the
 * runtime did not report.
 *
 * The forwarder asks it once per message, for the items that message carries, and hands it a lane at
 * the start for the items it learns off the message stream (a prompt the runtime took, reported by a
 * hook). Every item it yields is held to the item budget on its way to the wire (`fitAgentItem`).
 */
import type { AgentItem } from '../control/frames.js';
import type { SDKMessage } from '../host/agent-process.js';

/** One session's fill. `M` is what its runtime emits: the SDK's messages for Claude. */
export interface ItemFill<M = SDKMessage> {
  /** The items one native message carries, in order; nothing for a message that carries none. */
  fromMessage(message: M): readonly AgentItem[];
  /**
   * The lane for items the fill learns off the message stream, called once when forwarding starts.
   * A fill that reads only messages leaves it out.
   */
  attach?(push: (item: AgentItem) => void): void;
}
