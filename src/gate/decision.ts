/**
 * What a decision about a tool call is, and how an unrecognised one is read.
 *
 * The shape is the SDK's `PermissionResult`, field for field. Not a shape of this package's own
 * that happens to mean the same thing: the host's own local gate returns the same type, and a
 * `canUseTool` implementation would return it directly, so a second spelling would need a
 * translation in the one place a translation buys nothing. The SDK's word wins, exactly.
 *
 * The SDK documentation page names `PermissionResultDeny`, which the shipped `sdk.d.ts` does not
 * declare (`grep -c PermissionResultDeny` returns 0). The docs page additionally states
 * `{allow: false, reason}`, which does not exist either. Anything written that way fails to
 * compile or, worse, type-widens.
 *
 * A decider returns `unknown`, deliberately. A decision arriving from a controller was never seen
 * by this build's compiler — it is a value off a wire, from a peer that may be newer than this host.
 * Typing the decider as returning a `Decision` would make the compiler assert a fact only the
 * runtime can establish, and the unknown-decision rule below exists precisely because that fact is
 * sometimes false. So the type says `unknown` and `readDecision` is the total function that narrows
 * it — the honesty is in the signature, not in a comment.
 */

/**
 * What a decision about one tool call says.
 *
 * `allow` may rewrite the call's arguments through `updatedInput`. The model is never told that
 * happened — observed on a real session — so a rewrite is invisible from the transcript's side.
 */
export type Decision =
  | { readonly behavior: 'allow'; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string; readonly interrupt?: boolean };

/** What a decider is asked about. Everything the hook knows, in this package's own terms. */
export interface DecisionRequest {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: unknown;
  /**
   * The agent's own session id, read off the hook input. Not the controller's handle.
   *
   * Read `sessionKey` below before using this to correlate anything. This value is minted by the
   * agent at `system/init`; every frame on the link is keyed by the controller's handle instead. So
   * a decision request identified only by this arrives naming an id the controller may never have
   * seen — a session that dies during start-up never mints one at all, and the first transitions of
   * every session carry `null` here. Correlating on it is a correlation that silently fails exactly
   * when the session is in trouble, which is when a decision matters most.
   */
  readonly sessionId: string;
  /**
   * The controller's handle — the same string every wire frame for this session is keyed by.
   *
   * This is the field to correlate on, and it exists because nothing else here could. The gate is
   * the second transport: it is an ordinary HTTP POST to a URL nothing on the wire announces, so the
   * body is the only place the two transports can be tied together. Without it a controller has to
   * build an agent-id index and answer non-2xx for any id it has not seen yet.
   *
   * The host supplies it; it is never read from the agent's input, because the agent has no idea
   * what its controller calls it.
   */
  readonly sessionKey: string;
  readonly cwd: string;
  /**
   * The subagent this call came from, or null on the main thread.
   *
   * `agent_id` is the field that distinguishes a subagent call — `agent_type` is also present on the
   * main thread of a session started with `--agent`, so branching on the type alone would read a
   * main-thread call as a subagent one.
   */
  readonly agentId: string | null;
  readonly agentType: string | null;
}

/**
 * Answers one tool call. Returns `unknown` — see this file's header.
 *
 * The `signal` aborts when the surrounding turn is cancelled. A decider that reaches a controller
 * passes it through so a cancelled turn does not leave a request in flight.
 */
export type Decider = (request: DecisionRequest, signal: AbortSignal) => Promise<unknown>;

/**
 * A decision read from an untrusted value: either one this build understands, or the raw payload.
 *
 * The raw payload is preserved rather than discarded. A host that silently drops what it did not
 * understand makes a controller-side bug invisible on the only side that could have seen it — the
 * controller believes it answered, the tool is blocked, and nothing anywhere says why.
 */
export type DecisionReading =
  | { readonly recognised: true; readonly decision: Decision }
  | { readonly recognised: false; readonly raw: string };

/**
 * How much of an unrecognised payload is carried into the trace.
 *
 * Bounded because the value goes into a transition that is retained and may cross the wire, and an
 * unbounded field there is a way for a peer to fill this host's memory. Truncation is marked, so a
 * reader can tell a short payload from a clipped one.
 */
const RAW_PAYLOAD_LIMIT = 512;

/** The raw value as one line, bounded and marked. Never throws — a cyclic value is still evidence. */
export function describeRaw(raw: unknown): string {
  let text: string;
  try {
    text = raw === undefined ? 'undefined' : JSON.stringify(raw);
    if (text === undefined) text = String(raw);
  } catch {
    // A cyclic or otherwise unserialisable payload still tells the reader its type, which is more
    // than nothing and is the whole point of preserving it.
    text = `[unserialisable ${typeof raw}]`;
  }
  return text.length > RAW_PAYLOAD_LIMIT ? `${text.slice(0, RAW_PAYLOAD_LIMIT)}…[truncated]` : text;
}

/**
 * Read an untrusted value as a decision. Total: every input produces a reading.
 *
 * A value this build has never seen is never an allow. A controller running ahead of a host, a
 * decision tier added later, a rolled-back deploy — each produces a `behavior` this code does not
 * know, and the only safe reading of "I do not understand your answer" is that no answer was given.
 * Borrowed from the Agent Client Protocol's `RequestPermissionOutcome::Other`, whose rule is that an
 * agent which does not understand an outcome MUST NOT treat it as approval.
 *
 * It is refused here, by the gate, rather than at the transport. A strict codec could reject the
 * frame instead — but then the gate never runs, and the tool's fate depends on a parse error rather
 * than on a policy act with a receipt.
 */
export function readDecision(raw: unknown): DecisionReading {
  if (typeof raw !== 'object' || raw === null) return { recognised: false, raw: describeRaw(raw) };

  const candidate = raw as {
    behavior?: unknown;
    message?: unknown;
    updatedInput?: unknown;
    interrupt?: unknown;
  };

  if (candidate.behavior === 'allow') {
    const updatedInput = candidate.updatedInput;
    // An `allow` whose updatedInput is present but not an object is not an allow with the field
    // dropped: it is a decision this build cannot carry out, and carrying out the half it
    // understood would run the tool with arguments nobody approved.
    if (updatedInput === undefined) return { recognised: true, decision: { behavior: 'allow' } };
    if (typeof updatedInput !== 'object' || updatedInput === null || Array.isArray(updatedInput)) {
      return { recognised: false, raw: describeRaw(raw) };
    }
    return {
      recognised: true,
      decision: { behavior: 'allow', updatedInput: updatedInput as Record<string, unknown> },
    };
  }

  if (candidate.behavior === 'deny') {
    // `message` is required on a deny by the SDK's own type. A deny without one would reach the
    // model as a blocked call with no stated reason, which is the silent refusal this package
    // forbids everywhere else — so it is unrecognised rather than quietly given a default.
    if (typeof candidate.message !== 'string' || candidate.message.length === 0) {
      return { recognised: false, raw: describeRaw(raw) };
    }
    const interrupt = candidate.interrupt;
    if (interrupt !== undefined && typeof interrupt !== 'boolean')
      return { recognised: false, raw: describeRaw(raw) };
    return {
      recognised: true,
      decision: {
        behavior: 'deny',
        message: candidate.message,
        ...(interrupt === undefined ? {} : { interrupt }),
      },
    };
  }

  return { recognised: false, raw: describeRaw(raw) };
}
