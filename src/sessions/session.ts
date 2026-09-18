/**
 * A live agent session, and the handle every later layer attaches through.
 *
 * The ownership model, because more than one layer holds this object.
 * The registry owns a session's lifetime; everyone else borrows. Whoever attaches to observe a
 * session — a permission gate, a stream forwarder — holds this handle, reads it, subscribes to it,
 * and never ends it. `stop()` exists on the handle for the registry's convenience and takes the
 * session out of its registry when it runs, so there is exactly one way a session ends and exactly
 * one place that knows it has.
 *
 * This session reads the agent's output once and fans it out.
 * The SDK hands back a single-consumer stream, so if two layers both iterated it they would split
 * the messages between them and each would silently see half. The pump here is the only consumer;
 * everything else subscribes. A subscriber's callback runs synchronously in the pump, so a
 * subscriber that needs to do slow work must hand off to its own buffer rather than awaiting inside
 * the callback.
 *
 * What this deliberately does not do: it emits no frames and knows nothing about a controller
 * link. The declared state model — what an agent is at a moment, and why — belongs to the layer
 * above, and a session inventing its own status words would hand that layer a vocabulary it never
 * chose. The events below are local and small on purpose: something to translate from, not a model.
 *
 * An agent does not report itself until a turn starts, and the whole shape here follows from it.
 * Starting the process produces nothing — no id, no version, no tool list, no stderr, indefinitely.
 * The init message arrives about two seconds after the first turn is queued. Observed both ways: a
 * full-inheritance environment with no turn stayed silent for 45 seconds, and a filtered one with
 * a turn queued first reported in 2.5. So a session cannot be handed back "already identified" —
 * waiting for that before accepting a turn is a deadlock, because the turn is what causes it.
 * `create` therefore returns a session in `provisioning`, and `whenLive()` is how a caller that
 * needs the id or the version receipt waits for them.
 */
import type { AgentInitFacts, AgentProcess, SDKMessage } from '../host/agent-process.js';
import type { SessionConfigureChange } from '../host/wire-request.js';
import { readInitFacts } from '../host/agent-process.js';
import type { WorkspaceTrust } from '../host/workspace-trust.js';
import type { Clock } from '../core/time.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';

/**
 * Where the agent process is. Three values, because there are three genuinely different situations.
 *
 * This is not the declared state model and it is not a peer of it. `SessionState` in
 * state/model.ts answers "what is this session doing, and why". This answers the narrower question
 * "does the process exist, and has the agent named itself" — which is what `prompt`, `stop` and
 * `whenLive` branch on. The declared model subsumes these three: provisioning sits inside spawning,
 * live spans everything between, ended is ended. So this is an input to that machine, arriving
 * there as a cause of kind `process`. One declared model, one substrate feeding it.
 *
 * Do not restore symmetry between the two. They were never symmetric, and a second declared model
 * is exactly how one concept ends up with two names that drift.
 */
export type SessionLifecycle =
  /** Started, but the agent has not yet said what it is. No id, no version receipt. */
  | 'provisioning'
  /** The agent reported itself and is accepting turns. */
  | 'live'
  /** Over. `endCause` says why, and it is never inferred from silence. */
  | 'ended';

/**
 * Why a session ended. Local to this layer and stated as data so the set can be enumerated.
 *
 * Four values, all of them observed rather than assumed: nothing here means "the host stopped
 * hearing from it". The layer that owns the declared state model maps these onto its own causes.
 */
export const SESSION_END_CAUSES = [
  /** Someone asked. The only deliberate one. */
  'stop_requested',
  /** The agent's own stream completed — a normal end. */
  'process_ended',
  /** The stream threw. The process died in a way it did not choose. */
  'process_failed',
  /** It never reported itself inside the start window, so it never became live. */
  'start_timed_out',
] as const;

export type SessionEndCause = (typeof SESSION_END_CAUSES)[number];

export interface SessionEnded {
  readonly cause: SessionEndCause;
  readonly detail: string;
  readonly at: string;
}

/**
 * A named condition that does not stop the session but changes what is true of it.
 *
 * `subscriber_failed` means a listener on this handle threw: the session and its process are fine,
 * and saying so distinctly is the point — a subscriber's bug must not wear an outage's name.
 *
 * `session_id_collision` means the agent named itself with an id the registry already holds, so
 * this session was refused registration and stopped. Its own kind because it is neither an outage
 * nor a bug: it is what a resume-without-fork legitimately produces.
 *
 * This union is local — not exported on `periscope/protocol`, not validated by any closed wire
 * enum — which is the only reason widening it is a safe, additive change. Putting it on the wire
 * would make an added kind decode-fatal to an older peer; re-decide the shape then, not by copy.
 */
export interface SessionDegrade {
  readonly kind: 'workspace_untrusted' | 'subscriber_failed' | 'session_id_collision';
  readonly detail: string;
  readonly at: string;
}

export type SessionListener = (message: SDKMessage) => void;
export type SessionEndListener = (ended: SessionEnded) => void;
export type SessionDegradeListener = (degrade: SessionDegrade) => void;

/** Drop a subscription. Calling it twice is harmless. */
export type Unsubscribe = () => void;

export interface HostedSessionFacts {
  /** The agent's own session id — the host owns identity, and this is where it comes from. */
  readonly id: string;
  readonly cwd: string;
  readonly startedAt: string;
  /** Read from this session's init message. Never cached across sessions — see agent-process.ts. */
  readonly cliVersion: string;
  readonly model: string;
  readonly permissionMode: string;
  /** Where the agent found credentials. `'oauth'` means the ambient credentials file resolved. */
  readonly apiKeySource: string;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly plugins: readonly {
    readonly name: string;
    readonly path: string;
    readonly version: string | null;
  }[];
  readonly capabilities: readonly string[];
  /**
   * The MCP servers the agent connected to, by name and status, as the agent reported them.
   *
   * The receipt for a registration, and the only one that can tell a failure apart from an empty
   * server. Reading `tools` for an `mcp__{server}__` prefix answers "did any tool arrive"; it cannot
   * answer "did the server connect", and those differ exactly when a server is reachable over a
   * network rather than living in this process. See `AgentInitFacts.mcpServers`.
   */
  readonly mcpServers: readonly { readonly name: string; readonly status: string }[];
  /** What was recorded about this directory at start. Reported, never acted on. */
  readonly workspaceTrust: WorkspaceTrust;
}

export class HostedSession {
  readonly #process: AgentProcess;
  readonly #clock: Clock;
  readonly #onReleased: (session: HostedSession) => void;
  readonly #messageListeners = new Set<SessionListener>();
  readonly #endListeners = new Set<SessionEndListener>();
  readonly #degradeListeners = new Set<SessionDegradeListener>();

  readonly #liveWaiters: ((result: Result<HostedSessionFacts>) => void)[] = [];
  readonly #cwd: string;
  readonly #trust: WorkspaceTrust;
  readonly #onLive: (session: HostedSession) => void;
  readonly #degrades: SessionDegrade[] = [];

  #state: SessionLifecycle = 'provisioning';
  #facts: HostedSessionFacts | null = null;
  #ended: SessionEnded | null = null;

  /**
   * Constructed by `SessionRegistry` only. Internal: an embedder borrows a handle from the registry
   * and never builds one, so the process seam stays out of the published API.
   * @internal
   */
  constructor(
    process: AgentProcess,
    clock: Clock,
    cwd: string,
    trust: WorkspaceTrust,
    onLive: (session: HostedSession) => void,
    onReleased: (session: HostedSession) => void,
  ) {
    this.#process = process;
    this.#clock = clock;
    this.#cwd = cwd;
    this.#trust = trust;
    this.#onLive = onLive;
    this.#onReleased = onReleased;
    // Reading starts immediately. The agent will say nothing until a turn is queued, but a consumer
    // attached later would miss whatever came before it.
    void this.#pump();
  }

  get state(): SessionLifecycle {
    return this.#state;
  }

  /** Null until the agent has reported itself. A caller past `create()` always has them. */
  get facts(): HostedSessionFacts | null {
    return this.#facts;
  }

  /** Null while the session is alive. Never inferred — an ended session always says why. */
  get ended(): SessionEnded | null {
    return this.#ended;
  }

  /** Every degrade so far, oldest first. What a subscriber replay delivers, readable directly. */
  get degrades(): readonly SessionDegrade[] {
    return [...this.#degrades];
  }

  /** The agent's id, or a refusal while it is still provisioning. */
  get id(): string | null {
    return this.#facts?.id ?? null;
  }

  /**
   * How many observers are attached right now.
   *
   * A long-running host has to be able to answer "is anything accumulating?", and this is the one
   * number that says so per session. It is also what makes the release at the end of a session a
   * checkable fact rather than a line of code nobody can see run — an assertion that a dead session
   * emits nothing would pass whether or not the listeners were ever dropped.
   */
  get observerCount(): number {
    return this.#messageListeners.size + this.#endListeners.size + this.#degradeListeners.size;
  }

  /** Send a turn. Refuses on a session that has ended rather than swallowing the text. */
  prompt(text: string): Result<void> {
    if (this.#state === 'ended') {
      return refuse('session-unknown', `session has ended (${this.#ended?.cause ?? 'unknown'})`);
    }
    if (!this.#process.prompt(text)) {
      return refuse(
        'prompt-queue-full',
        'the session already holds every turn it can queue; this one was not taken',
      );
    }
    return ok(undefined);
  }

  /** Stop the current turn without ending the session. */
  interrupt(): Promise<void> {
    if (this.#state === 'ended') return Promise.resolve();
    return this.#process.interrupt();
  }

  /** Apply a `session_configure` — the asked members, in order, through the SDK's live setters. */
  async configure(change: SessionConfigureChange): Promise<void> {
    if (this.#state === 'ended') return;
    if (change.model !== undefined) await this.#process.setModel(change.model);
    if (change.permissionMode !== undefined) await this.#process.setPermissionMode(change.permissionMode);
    if (change.thinking !== undefined) await this.#process.setThinking(change.thinking);
  }

  /** End the session and release it from its registry. Idempotent. `#finish` closes the process. */
  stop(detail = 'stop requested'): void {
    if (this.#state === 'ended') return;
    this.#finish('stop_requested', detail);
  }

  onMessage(listener: SessionListener): Unsubscribe {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  /** Fires exactly once. A listener added after the end is called immediately with the same value. */
  onEnd(listener: SessionEndListener): Unsubscribe {
    if (this.#ended !== null) {
      listener(this.#ended);
      return () => undefined;
    }
    this.#endListeners.add(listener);
    return () => this.#endListeners.delete(listener);
  }

  /**
   * Replays every degrade so far to the new listener, then keeps it current. Replay is what makes
   * a degrade raised inside `create()` — before any caller could possibly subscribe — observable
   * at all; without it that emission has structurally no audience.
   */
  onDegrade(listener: SessionDegradeListener): Unsubscribe {
    for (const degrade of this.#degrades) {
      try {
        listener(degrade);
      } catch {
        // The failure channel is best-effort by construction: reporting a reporter would recurse.
      }
    }
    this.#degradeListeners.add(listener);
    return () => this.#degradeListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Internal — driven by the registry, which is the only thing that constructs one of these.
  // -------------------------------------------------------------------------

  /** Report a named condition that changes what is true without ending anything. */
  degrade(kind: SessionDegrade['kind'], detail: string): void {
    const degrade: SessionDegrade = { kind, detail, at: this.#clock() };
    this.#degrades.push(degrade);
    for (const listener of this.#degradeListeners) {
      try {
        listener(degrade);
      } catch {
        // Terminal by design: this is the failure channel, so a listener of it that throws has
        // nowhere further to be reported without recursing. Every other fan-out reports here.
      }
    }
  }

  /**
   * Wait until the agent has reported itself, so the id and the version receipt are known.
   *
   * This only completes once a turn has been queued. Awaiting it before prompting waits forever,
   * because the turn is what makes the agent initialize — see this file's header. A caller that
   * wants both usually wants `prompt()` first and this second.
   *
   * The timeout is not optional comfort: a start that never completes is the worst failure here —
   * no error, no message, and a caller waiting on a process that may not even be running.
   */
  whenLive(timeoutMs: number): Promise<Result<HostedSessionFacts>> {
    if (this.#facts !== null) return Promise.resolve(ok(this.#facts));
    if (this.#ended !== null) {
      return Promise.resolve(
        refuse<HostedSessionFacts>(
          'session-spawn-failed',
          `the session ended before reporting itself (${this.#ended.cause}: ${this.#ended.detail})`,
        ),
      );
    }

    return new Promise<Result<HostedSessionFacts>>((resolve) => {
      let settled = false;
      const settle = (result: Result<HostedSessionFacts>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // Ref'd, for the same reason as the gate's deadline (`gate/gate.ts`): this timer is the
      // property. An `unref()`d timer would let the event loop drain in the one state where the
      // timeout is needed — a host waiting on an agent that will never speak, with nothing else
      // pending — so the timer would never fire and the wait would hang forever, which is the exact
      // behaviour the timeout exists to prevent.
      //
      // `settle` clears the timer on every path, so a session that does report itself pays nothing.
      const timer = setTimeout(() => {
        const detail = `the agent did not report itself within ${timeoutMs}ms`;
        this.#finish('start_timed_out', detail);
        settle(refuse<HostedSessionFacts>('session-spawn-failed', detail));
      }, timeoutMs);

      this.#liveWaiters.push(settle);
    });
  }

  async #pump(): Promise<void> {
    try {
      for await (const message of this.#process.messages) {
        const facts = readInitFacts(message);
        if (facts !== null && this.#facts === null) this.#adopt(facts);
        for (const listener of this.#messageListeners) {
          try {
            listener(message);
          } catch (error) {
            // A subscriber's bug is not a process outage. The pump keeps reading, the other
            // subscribers keep receiving, and the failure is named for what it is — under its own
            // kind, so it cannot impersonate the process dying.
            this.degrade('subscriber_failed', `an onMessage subscriber threw: ${describe(error)}`);
          }
        }
      }
      this.#finish('process_ended', 'the agent process ended');
    } catch (error) {
      // The stream is what this cause is for, but it is not the only thing that can land here.
      // `readInitFacts` runs above, outside the per-listener guard, so a bug in this package's own
      // reader arrives here too and is reported as the agent process dying. That misattribution is
      // the real residual — the throw is loud, and it is loud under the wrong name. It is named here
      // rather than caught separately because a reader fault genuinely does end the session, and
      // inventing a second end cause would tell an operator less, not more: what they need is the
      // message text in the detail, which `describe` carries.
      this.#finish('process_failed', describe(error));
    }
  }

  #adopt(facts: AgentInitFacts): void {
    this.#facts = {
      id: facts.sessionId,
      // The agent's own cwd is preferred over the one that was requested: if they ever disagree,
      // the one the agent is actually in is the true answer.
      cwd: facts.cwd === '' ? this.#cwd : facts.cwd,
      startedAt: this.#clock(),
      cliVersion: facts.cliVersion,
      model: facts.model,
      permissionMode: facts.permissionMode,
      apiKeySource: facts.apiKeySource,
      tools: facts.tools,
      skills: facts.skills,
      plugins: facts.plugins,
      capabilities: facts.capabilities,
      mcpServers: facts.mcpServers,
      workspaceTrust: this.#trust,
    };
    this.#state = 'live';
    // Keyed by the agent's own id only now, because only now is there one.
    this.#onLive(this);
    while (this.#liveWaiters.length > 0) this.#liveWaiters.shift()?.(ok(this.#facts));
  }

  #finish(cause: SessionEndCause, detail: string): void {
    if (this.#state === 'ended') return;
    this.#state = 'ended';
    this.#ended = { cause, detail, at: this.#clock() };
    // Closed on every ending path, not only the deliberate ones — close() is idempotent, and a
    // pump-failure path that skipped it would leave a live process with nobody reading its stream.
    this.#process.close();
    this.#onReleased(this);
    for (const listener of this.#endListeners) {
      try {
        listener(this.#ended);
      } catch (error) {
        // An end listener that throws must not take the host down with an unhandled rejection —
        // this fan-out runs inside the pump's own promise, which nothing awaits by design.
        this.degrade('subscriber_failed', `an onEnd listener threw: ${describe(error)}`);
      }
    }
    // A session that ends before reporting itself must release anyone waiting on it, with the
    // reason. Leaving them pending is the same silent hang the timeout exists to prevent.
    const ending = this.#ended;
    while (this.#liveWaiters.length > 0) {
      this.#liveWaiters.shift()?.(
        refuse<HostedSessionFacts>(
          'session-spawn-failed',
          `the session ended before reporting itself (${ending.cause}: ${ending.detail})`,
        ),
      );
    }
    // Nothing keyed by a session may outlive it. A long-running host that keeps listeners alive per
    // dead session dies of something no single session can be blamed for.
    this.#messageListeners.clear();
    this.#endListeners.clear();
    this.#degradeListeners.clear();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
