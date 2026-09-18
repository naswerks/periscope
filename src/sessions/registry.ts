/**
 * The live sessions this host is running, and the only thing that starts or ends one.
 *
 * Instance state on a class, never module globals, and that is the whole reason this is a class
 * at all. A module-level map would make the package a singleton for its process: two embedders in
 * one host — a test beside a running host, two controllers, one library used twice — would share a
 * session table and end each other's work. Every piece of per-session state here is a private
 * field, and a test runs two registries side by side to prove they cannot see each other.
 *
 * The ownership model in one line: this object owns lifetime, everything else borrows a handle.
 * `create` mints, `get` borrows, `stop`/`stopAll` end. A session removes itself from here the
 * moment it ends, whichever way it ended, so "in the registry" and "alive" are the same fact rather
 * than two that can drift.
 */
import type {
  AgentProcess,
  AgentProcessRequest,
  AgentSystemPrompt,
  HookRegistrations,
  McpServerConfig,
  SdkPluginConfig,
  SessionStore,
  SessionStoreFlush,
  SettingSource,
  SpawnAgentProcess,
  ThinkingConfig,
  EffortLevel,
  PermissionMode,
} from '../host/agent-process.js';
import { startAgentProcess } from '../host/agent-process.js';
import type { WorkspaceTrust } from '../host/workspace-trust.js';
import { isUntrustedWorkspaceWarning, readWorkspaceTrust, trustConfigPath } from '../host/workspace-trust.js';
import type { Clock } from '../core/time.js';
import { systemClock } from '../core/time.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import { requireAbsolute } from '../core/paths.js';
import type { SpawnEnvPolicy } from './spawn-env.js';
import { composeSpawnEnv } from './spawn-env.js';
import { HostedSession } from './session.js';

/** What a caller asks for when starting a session. */
export interface SessionRequest {
  /** Absolute. Refused otherwise — a relative cwd means "relative to something you cannot see". */
  readonly cwd: string;
  /**
   * Which on-disk settings tiers the agent may load. Defaults to none.
   *
   * Reading no settings files is the default because it is the only setting under which the host
   * can state what an agent's permissions are. Loading the project tier also brings the trust
   * problem back: its rules are silently void in a workspace nobody accepted. A caller that wants
   * project instructions loaded must ask, and gets told what it costs.
   */
  readonly settingSources?: readonly SettingSource[];
  readonly plugins?: readonly SdkPluginConfig[];
  /** Hook callbacks for this session. Carried to the process untouched — see host/hooks.ts. */
  readonly hooks?: HookRegistrations;
  /** Extra allow/deny/literal declarations on top of the general spawn environment. */
  readonly env?: SpawnEnvPolicy;
  /** A session id to continue. The controller decides when; the host only carries it out. */
  readonly resume?: string;
  /** With `resume`, continue into a new id instead of extending the old session. */
  readonly fork?: boolean;
  /**
   * Stream this session's turns as they compose. Defaults to on.
   *
   * On because the incremental lane is droppable by construction — a delta never enters the replay
   * ring or the durable store, so what it costs under pressure is a repaint. Off, a turn can only
   * be rendered after it is over, which is a different product.
   */
  readonly includePartialMessages?: boolean;
  /**
   * How much reasoning this session emits. Defaults to the SDK's own default (deltas fire, prose
   * is empty), so summarized prose is something a caller asks for.
   *
   * Why the default is not "on when someone is watching": that rule cannot be written in this
   * package. Whether a run is watched is a judgement about what the session is for, and this host
   * has no fact that distinguishes one — inventing one would be a name earned by observation, which
   * is the failure the declared model exists to end. The caller knows; the host offers the knob.
   * The asymmetry in the defaults carries the intent instead: the cheap half is on, and the half
   * that costs tokens on the wire and puts reasoning text into transcripts and mirrors is opt-in.
   */
  readonly thinking?: ThinkingConfig;
  /** Forward a subagent's whole conversation rather than only its tool calls. Defaults to off. */
  readonly forwardSubagentText?: boolean;
  /**
   * In-process MCP servers this session may call, by server name. Build them with `mcp/`.
   *
   * Every tool these add is decided by the same gate as `Bash` — `PreToolUse` is registered with
   * no matcher, so coverage does not depend on the host recognising the tool. What the host's own
   * gate does with them is a different question: see `gate/local.ts`, which matches on tool name and
   * therefore has no opinion about an `mcp__…` tool unless the embedder names it in `ToolFamilies`.
   */
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  /**
   * Ignore every MCP server this host did not declare. Defaults to true.
   *
   * On by default, and this is the one place a workspace's contents could otherwise decide what
   * tools exist. Without it the agent also loads project `.mcp.json`, user settings, plugin MCP and
   * on-disk agent frontmatter — so a repository the host checked out into a workspace can register
   * its own servers, and a `WorkspaceProvider` that clones untrusted code becomes a tool-registration
   * channel. The host provisions those directories programmatically, which is exactly the case where
   * nobody reviewed what is in them.
   *
   * Turning it off is legitimate and costs something named. A consumer whose own repository
   * declares the servers it wants needs this off, and forcing them to fork the package would be
   * worse. But the cost is not only a wider tool surface: an in-process server cannot fail to
   * connect, while the stdio and HTTP servers this re-admits can — and this package deliberately
   * does not expose the SDK's `mcpServerStatus()` / `reconnectMcpServer()`, because reaching them
   * means handing out the query object whose narrowing is a pinned security property. So with strict
   * off, a failed server is neither detectable nor recoverable through this package. Strict on is
   * what makes that absence harmless.
   */
  readonly strictMcpConfig?: boolean;
  /**
   * Mirror this session's transcript to a store. Defaults to none.
   *
   * The store receives every message the agent saw, so supplying one is an egress decision and it
   * is deliberately the embedder's — this type is the local API, not the wire. Nothing arriving over
   * the link can reach this field: a store is an object with methods and has no JSON form, so a
   * controller cannot name a destination for a transcript even in principle. Pinned by
   * pins/persistence-egress.test.ts.
   *
   * Local disk remains the primary record whatever is set here. The subprocess writes locally
   * first and the mirror runs after that write succeeds, so a store can legitimately lag — and when
   * a batch is dropped it stays behind, silently. See host/session-store.ts on reading that report.
   */
  readonly sessionStore?: SessionStore;
  /** How eagerly the mirror flushes. Defaults to the SDK's batching. Ignored with no store. */
  readonly sessionStoreFlush?: SessionStoreFlush;
  /** Create the process yourself — a VM, a container, a remote machine. See agent-process.ts. */
  readonly spawn?: SpawnAgentProcess;
  /**
   * Which model runs this session. Defaults to the CLI's own.
   *
   * Absent, not narrowed — this and `systemPrompt` were simply not composable before, so they fill
   * a gap rather than widen the permission narrowing. See `AGENT_SELECTION_OPTION_KEYS`.
   *
   * Whether it took effect is provable: the agent reports `model` on its own `system/init`, so a
   * caller reads it back off `HostedSession`'s facts rather than trusting the request.
   */
  readonly model?: string;
  /**
   * What the agent is told at the start. Defaults to the CLI's own preset.
   *
   * This one is not provable the same way. The init message carries no system prompt, so nothing
   * the agent says back confirms it. Asking for it is a decision made blind, by construction.
   */
  readonly systemPrompt?: AgentSystemPrompt;
  /** The effort level. Defaults to the SDK's own. */
  readonly effort?: EffortLevel;
  /** The permission mode. Defaults to the SDK's own. See `CLI_PARITY_OPTION_KEYS`. */
  readonly permissionMode?: PermissionMode;
}

/** How many sessions one host holds at once, live and opening together, unless told otherwise. */
export const DEFAULT_MAX_SESSIONS = 8;

export interface SessionRegistryOptions {
  /**
   * The bound on sessions held at once, live and opening together. A `create` past it refuses
   * `session-cap-reached` before anything is started; the remedy is another session ending. The
   * offline frame queue is shared by every session on the link, so the bound is what keeps one host's
   * share of it finite. Defaults to `DEFAULT_MAX_SESSIONS`.
   */
  readonly maxSessions?: number;
  /** The environment sessions are filtered from. The composition root passes `process.env`. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** Absolute path to the user's home, for the trust read. */
  readonly homeDir: string;
  readonly clock?: Clock;
  /** How long the agent has to report itself before the start is called failed. */
  readonly startTimeoutMs?: number;
  /**
   * How a process is started. Defaults to the real one.
   *
   * What this is for, stated because it would otherwise be misused. It exists so the registry's
   * own rules — that a session leaves the table however it ends, that an unknown id is refused, that
   * two registries share nothing — can be checked without a process. It is not a way to test the
   * agent's behaviour: a substitute proves the substitute, and everything this package claims about
   * the SDK is proven against a real session instead (see the `.live.test.ts` files).
   *
   * Internal: the process seam is the package's own and is not part of the published API, so the
   * shape a runtime supplies can change without a major version.
   * @internal
   */
  readonly startProcess?: (request: AgentProcessRequest) => AgentProcess;
}

/**
 * 60 seconds. The process is a large native binary starting cold, and a loaded host has been
 * observed holding a trivial invocation of it past ten. Too short turns a slow machine into a
 * spurious outage; there is no upper bound that is too generous for a case that otherwise hangs.
 */
const DEFAULT_START_TIMEOUT_MS = 60_000;

export class SessionRegistry {
  readonly #live = new Map<string, HostedSession>();
  readonly #maxSessions: number;
  readonly #provisioning = new Set<HostedSession>();
  readonly #baseEnv: Readonly<Record<string, string | undefined>>;
  readonly #homeDir: string;
  readonly #clock: Clock;
  readonly #startTimeoutMs: number;
  readonly #startProcess: (request: AgentProcessRequest) => AgentProcess;

  constructor(options: SessionRegistryOptions) {
    this.#baseEnv = options.baseEnv;
    this.#homeDir = options.homeDir;
    this.#clock = options.clock ?? systemClock;
    this.#startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.#startProcess = options.startProcess ?? startAgentProcess;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /** Every live session. A copy — a caller iterating this cannot be surprised by one ending. */
  list(): HostedSession[] {
    return [...this.#live.values()];
  }

  get liveCount(): number {
    return this.#live.size;
  }

  /** Sessions that have started but not yet reported themselves. Separate because they have no id. */
  get provisioningCount(): number {
    return this.#provisioning.size;
  }

  get(sessionId: string): Result<HostedSession> {
    const session = this.#live.get(sessionId);
    if (session === undefined) {
      return refuse<HostedSession>('session-unknown', `no live session ${sessionId} in this registry`);
    }
    return ok(session);
  }

  /**
   * Start a session. Returns as soon as the process exists — synchronously, and without an id.
   *
   * Why there is no id yet, and why this is not an oversight. The agent reports itself only once
   * a turn has been queued; before that it emits nothing at all, for as long as you care to wait
   * (observed: 45 seconds of silence with no turn, 2.5 seconds with one). So a `create` that
   * waited for the id would deadlock against the `prompt` that causes it.
   *
   * The shape a caller wants is therefore: create, prompt, then `whenLive()` if it needs the id, the
   * version receipt or the tool list. Until then the session is in `provisioning` — held by this
   * registry, counted by `provisioningCount`, stopped by `stopAll`, but not yet reachable by id
   * because there is no id to reach it by.
   */
  create(request: SessionRequest): Result<HostedSession> {
    const cwd = requireAbsolute(request.cwd);
    if (!cwd.ok) return refuse<HostedSession>(cwd.refusal.reason, cwd.refusal.detail);

    const held = this.#live.size + this.#provisioning.size;
    if (held >= this.#maxSessions) {
      return refuse<HostedSession>(
        'session-cap-reached',
        `this host holds ${held} session(s), its bound of ${this.#maxSessions}; end one before opening another`,
      );
    }

    const settingSources = request.settingSources ?? [];
    const trust = readWorkspaceTrust(trustConfigPath(this.#homeDir), cwd.value);

    const session = new HostedSession(
      this.#startProcess({
        cwd: cwd.value,
        env: composeSpawnEnv(this.#baseEnv, request.env ?? {}),
        settingSources,
        plugins: request.plugins ?? null,
        hooks: request.hooks ?? null,
        resume: request.resume ?? null,
        fork: request.fork ?? false,
        // The two defaults that carry the streaming policy are these two lines. See SessionRequest
        // for why the rule is stated as an asymmetry rather than as attendedness.
        includePartialMessages: request.includePartialMessages ?? true,
        thinking: request.thinking ?? null,
        forwardSubagentText: request.forwardSubagentText ?? false,
        mcpServers: request.mcpServers ?? null,
        // The default is strict, and it is stated rather than left to the SDK. Omitting the key
        // lets a provisioned workspace's own files register servers — see SessionRequest.
        strictMcpConfig: request.strictMcpConfig ?? true,
        // No default destination, and there must never be one: a host that mirrored somewhere by
        // default would be sending transcripts off-box without anyone choosing to.
        sessionStore: request.sessionStore ?? null,
        sessionStoreFlush: request.sessionStoreFlush ?? null,
        spawn: request.spawn ?? null,
        // No default for either: naming a model here would make this package's own choice look like
        // the CLI's, and the CLI's default is the one an operator can actually see and change.
        model: request.model ?? null,
        systemPrompt: request.systemPrompt ?? null,
        effort: request.effort ?? null,
        permissionMode: request.permissionMode ?? null,
        // The untrusted-workspace condition is reported here and nowhere else in the SDK, so the
        // callback is wired on every start rather than only when it is expected.
        onStderr: (data: string) => {
          if (isUntrustedWorkspaceWarning(data)) {
            session.degrade('workspace_untrusted', data.trim());
          }
        },
      }),
      this.#clock,
      cwd.value,
      trust,
      (live) => this.#adopt(live),
      (finished) => this.#release(finished),
    );

    this.#provisioning.add(session);

    // Stated before the first message, because a caller that asked for settings files in a
    // workspace nobody trusted has already lost its rules by the time anything runs — and the only
    // other notice is a line on stderr.
    if (settingSources.length > 0 && trust !== 'trusted') {
      session.degrade(
        'workspace_untrusted',
        `settings sources ${settingSources.join(', ')} were requested but this workspace is ` +
          `${trust}: permission rules from settings files will be ignored`,
      );
    }

    return ok(session);
  }

  /**
   * Start a session, send its first turn, and wait until it has reported itself.
   *
   * The ordinary shape, offered as one call because getting it wrong deadlocks: the turn must be
   * queued before the wait, since it is what makes the agent initialize.
   */
  async open(request: SessionRequest & { readonly prompt: string }): Promise<Result<HostedSession>> {
    const created = this.create(request);
    if (!created.ok) return created;

    const sent = created.value.prompt(request.prompt);
    if (!sent.ok) {
      created.value.stop('the first turn could not be queued');
      return refuse<HostedSession>(sent.refusal.reason, sent.refusal.detail);
    }

    const live = await created.value.whenLive(this.#startTimeoutMs);
    if (!live.ok) return refuse<HostedSession>(live.refusal.reason, live.refusal.detail);
    return ok(created.value);
  }

  /** End one session. Refuses an id this registry does not hold rather than succeeding quietly. */
  stop(sessionId: string, detail = 'stop requested'): Result<void> {
    const session = this.#live.get(sessionId);
    if (session === undefined) {
      return refuse<void>('session-unknown', `no live session ${sessionId} in this registry`);
    }
    session.stop(detail);
    return ok(undefined);
  }

  /**
   * End everything this registry holds, including sessions still provisioning.
   *
   * Provisioning sessions are included deliberately: they hold a real process even though they have
   * no id yet, and a shutdown that only walked the keyed map would leave those running.
   */
  stopAll(detail = 'host shutting down'): void {
    for (const session of [...this.#live.values(), ...this.#provisioning]) {
      session.stop(detail);
    }
  }

  /**
   * The agent has named itself, so the session becomes reachable by that id and stops provisioning.
   *
   * An id already held is not overwritten, and the reason is an observed SDK property: a resume
   * without `fork` keeps the same session id. So resuming a session this registry is already
   * running produces two live handles claiming one key. Overwriting would make the older one
   * untracked-but-alive — invisible to `list`, unreachable by `get`, missed by `stopAll`, still
   * holding a process — and then its eventual end would evict the newer session's entry, so a live
   * session would become unreachable because a different one finished. Both losses are silent, and
   * both falsify this file's own rule that "in the registry" and "alive" are the same fact.
   *
   * The newcomer is refused rather than the incumbent evicted: the incumbent is the one already
   * being observed, and a degrade names the collision on the session that is about to be dropped —
   * whose caller is the one that can do something about it.
   */
  #adopt(session: HostedSession): void {
    const id = session.facts?.id;
    if (id === undefined) return;
    this.#provisioning.delete(session);

    const incumbent = this.#live.get(id);
    if (incumbent !== undefined && incumbent !== session) {
      session.degrade(
        'session_id_collision',
        `the agent reported session id ${id}, which this registry already holds — a resume without ` +
          `fork keeps the original id. This session stays unregistered; stop the one that holds the ` +
          `id, or resume with fork so the agent mints a new one`,
      );
      session.stop(`session id ${id} is already held by a live session in this registry`);
      return;
    }

    this.#live.set(id, session);
  }

  /** Only the holder of an id may release it — a colliding session must not evict the incumbent. */
  #release(session: HostedSession): void {
    this.#provisioning.delete(session);
    const id = session.facts?.id;
    if (id !== undefined && this.#live.get(id) === session) this.#live.delete(id);
  }
}

export type { WorkspaceTrust };
