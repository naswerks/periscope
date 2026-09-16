/**
 * The link's own state, as transitions that carry why.
 *
 * Reconnects are the most common thing that happens to an unattended run, so the trace has to show
 * them — and a state change without a cause is exactly as useful as no state change at all when
 * you are reading back a night nobody watched. `cause` is required by the type, so a transition
 * without one does not compile.
 */
/**
 * `open` is the socket; `accepted` is the controller's welcome. They are two states because they are
 * two facts an operator asks about separately: a link that opens and is never welcomed is a version
 * or credential problem, not a network one, and a reporter that saw only `open` could not tell them
 * apart.
 */
export type LinkState = 'idle' | 'connecting' | 'open' | 'accepted' | 'backoff' | 'closed';

export const LINK_CAUSES = [
  'start_requested',
  'socket_connected',
  'hello_completed',
  'socket_error',
  'socket_closed',
  'heartbeat_timeout',
  // The dial never completed its upgrade inside `connectTimeoutMs`; abandoned and retried.
  'connect_timeout',
  'protocol_version_rejected',
  // The controller closed the socket because a session's seq jumped past what it holds; the next
  // dial replays from the cursor it reports. Distinct from a version rejection, which a retry cannot heal.
  'replay_requested',
  'credential_unavailable',
  // Not the same event as `credential_unavailable`; the difference is whether a retry can help.
  // `credential_unavailable` means this attempt had no header to present and the next one may;
  // `credential_rejected` means the identity provider has refused the material outright and will
  // keep refusing until a person signs in. The first belongs in `backoff`. The second is the only
  // cause on this list that ends in `closed` without a shutdown having been requested, because
  // retrying it is a loop with no exit that reports success when the process finally drains.
  'credential_rejected',
  'retry_scheduled',
  'shutdown_requested',
] as const;

export type LinkCause = (typeof LINK_CAUSES)[number];

export interface LinkTransition {
  readonly from: LinkState;
  readonly to: LinkState;
  readonly cause: LinkCause;
  readonly at: string;
  /** Free text for a human reading a log. Never branched on. */
  readonly detail: string | null;
}

export class LinkStateMachine {
  #state: LinkState = 'idle';

  get state(): LinkState {
    return this.#state;
  }

  /** Moves, and returns the transition. Returns null when already in `to` — no self-loops. */
  to(next: LinkState, cause: LinkCause, at: string, detail: string | null = null): LinkTransition | null {
    if (this.#state === next) return null;
    const transition: LinkTransition = { from: this.#state, to: next, cause, at, detail };
    this.#state = next;
    return transition;
  }
}
