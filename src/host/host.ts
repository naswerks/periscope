/** How long to wait before re-offering held frames to the link. */
const HELD_RETRY_MS = 250;
/** How many refused undroppable frames one session may hold before the next is reported lost. */
const HELD_FRAMES_MAX = 512;

/**
 * The composer: the file that makes the parts a host.
 *
 * Why this file exists: every part of this package is built and proven through its own seam, and
 * something has to join them. Without this file a session created through the registry runs with
 * `hooks: null` (no gate, no observation) and the link decodes `session_new`, `session_prompt`,
 * `session_cancel` and `bulk_request` with nothing consuming them, so the host cannot be told to
 * do anything at all.
 *
 * Two things live here and the split is the testability.
 *   `composeSession` is the per-session assembly (machine, observer, gate, forwarding) and it
 *   takes everything as arguments, so it can be checked without a socket or a process.
 *   `PeriscopeHost` owns the link and the registry and turns inbound payloads into calls on it.
 *
 * It lives in `src/host/` for the ordinary reason: it wires the real path resolver, the real bulk
 * POST and the real MCP server, all of which are confined here. It imports no `node:` builtin of
 * its own; the boundary is satisfied by construction rather than by permission.
 *
 * The order of assembly is load-bearing and it is not obvious. Forwarding is attached before the
 * first transition is recorded, because the forwarder subscribes to the machine: attach it after
 * and the `spawning` record (the one that carries where the session is and that it exists at all)
 * is emitted to nobody. It is the first frame a controller ever sees for a session, so losing it
 * costs the session's whole opening.
 */
import type { Clock, Ticker } from '../core/time.js';
import { systemClock, systemTicker } from '../core/time.js';
import { KeyedTurns } from '../core/keyed-turns.js';
import type { Refusal, RefusalReason } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { ControllerCredential } from '../control/credential.js';
import type { BackoffOptions } from '../control/backoff.js';
import type { LinkHandlers } from '../control/link.js';
import { ControllerLink } from '../control/link.js';
import type { LinkTransition } from '../control/link-state.js';
import type {
  HostConfiguration,
  HostConfigure,
  HostConfigureEntry,
  SessionFrame,
  SessionList,
  SessionNew,
  WorkspaceList,
  RepositoryList,
  RepositoryListResult,
  RepositoryRead,
  RepositoryReadResult,
  WireRefusal,
  SessionNewGate,
  SessionPayload,
  TranscriptList,
  TranscriptTail,
  WorkspaceRelease,
  WorkspaceReleaseBulk,
  WorkspaceReleaseEntry,
  WorkspaceReleaseEntryResult,
} from '../control/frames.js';
import {
  WORKSPACE_PAGE_SIZE,
  hostConfigureResult,
  sessionListResult,
  workspaceListResult,
  answerRefused,
  transcriptFailed,
  transcriptListResult,
  transcriptTailResult,
  unsetHostConfiguration,
  workspaceReleaseBulkResult,
  workspaceReleaseEntryResult,
  workspaceReleaseResult,
  repositoryListResult,
  repositoryReadResult,
  stateTransitionUpdate,
} from '../control/frames.js';
import type { FrameSink } from '../control/stream.js';
import { forwardSession } from '../control/stream.js';
import type { Decider } from '../gate/decision.js';
import type { LocalGate } from '../gate/local.js';
import type { ToolFamilies } from '../gate/local.js';
import { localGate } from '../gate/local.js';
import type { GateOutcome } from '../gate/outcome.js';
import { recordGateOutcome } from '../gate/outcome.js';
import { deadlineOrderRefusal, permissionHooks } from '../gate/gate.js';
import type { McpServerOptions } from '../mcp/server.js';
import type { SessionRequest } from '../sessions/registry.js';
import { SessionRegistry } from '../sessions/registry.js';
import type { HostedSession, SessionDegrade, Unsubscribe } from '../sessions/session.js';
import { SessionStateMachine } from '../state/machine.js';
import type { SessionTransition, TransitionWhere } from '../state/model.js';
import { SessionObserver } from '../state/observer.js';
import type { WorkspaceEntry, WorkspaceInventory, WorkspaceProvider } from '../workspace/provider.js';
import { keyPreview, unusableKeyProblem } from '../workspace/git-worktree.js';
import type { McpServerConfig } from './agent-process.js';
import type { BulkPostReceipt } from './bulk-post.js';
import { bulkOriginFor, postBulk } from './bulk-post.js';
import { readWhere } from './git-facts.js';
import { normalizePath } from '../core/paths.js';
import { mergeHooks, observationHooks } from './hooks.js';
import { createToolServer } from './mcp-server.js';
import { listTranscripts, tailTranscript } from './claude-transcripts.js';
import { listRepositoryDirectory, readRepositoryFile } from './repository-read.js';
import { nodePathResolver } from './paths.js';
import { isBypassMode, mergeMcpServers, readSessionConfigure, readSessionRequest } from './wire-request.js';
import { isDroppable } from '../control/frames.js';

// ---------------------------------------------------------------------------
// The per-session assembly.
// ---------------------------------------------------------------------------

/** How long the gate waits, when it reports a call as held, and whether its allow takes effect. */
export interface GateTimings {
  readonly decisionTimeoutMs?: number;
  readonly holdAfterMs?: number;
  readonly matcherTimeoutSeconds?: number;
  /**
   * Make the gate's allow effective.
   *
   * Defaults to false, and leaving it there gives a gate that cannot say yes. Without it
   * this gate is a veto: it can refuse a call and cannot let one through. Observed on a real
   * session: the gate allowed a `Write`, the tool did not run, and the model was told "Claude
   * requested permissions to write to ..., but you haven't granted it yet", in a host with no user
   * to grant anything. `PeriscopeHost` sets it to `true` for exactly this reason; an embedder
   * calling `composeSession` by hand does not.
   *
   * The first allow that does not take effect raises a `gate-cannot-grant` degrade (see
   * `permissionHooks`), so an embedder who left it off is told by a named outcome rather than by
   * a comment.
   *
   * Setting it with `settingSources` non-empty is refused (`permission-grant-shadows-settings`).
   * Per the SDK's documented evaluation order a hook allow does not skip operator deny or ask
   * rules (it skips permission mode, allow rules and `canUseTool`), so the exposure is narrower
   * than a bypass. See `composeSession` for what the refusal does and does not cover.
   */
  readonly grantOnAllow?: boolean;
}

export interface ComposeSessionOptions {
  readonly registry: SessionRegistry;
  /** The controller's handle: the frame routing key, not the agent's id. See frames.ts. */
  readonly sessionKey: string;
  /** Where the session runs. Absolute; the registry refuses anything else. */
  readonly cwd: string;
  readonly sink: FrameSink;
  /** Who answers a permission escalation. Usually `escalatingDecider`. */
  readonly decide: Decider;
  /**
   * The host's own gate, consulted before the decider.
   *
   * Optional in the type, supplied by default by `PeriscopeHost`. Absent means a path escape or a
   * credential read waits `decisionTimeoutMs` for an unreachable controller and is reported as an
   * outage, instead of being refused locally by name; see `gate/local.ts`. Composing without one
   * is a decision, so it stays possible and is never the default.
   */
  readonly localGate?: LocalGate;
  readonly gate?: GateTimings;
  /** Read once, at composition. Carried by every transition until the agent moves itself. */
  readonly where?: TransitionWhere;
  /** Opaque and never interpreted here. The controller's own meaning handle. */
  readonly correlationId?: string | null;
  /** Everything else the session takes — MCP servers, a store, plugins, resume. */
  readonly request?: Omit<SessionRequest, 'cwd' | 'hooks'>;
  readonly clock?: Clock;
  readonly ticker?: Ticker;
  /** Every refusal the sink returned, every transition the machine would not record. */
  readonly onRefusal?: (refused: Refusal) => void;
  /**
   * Told about every gate outcome, in addition to the machine record, never instead of it.
   *
   * The record is what reaches the wire and it is not optional; this is for an embedder that also
   * wants to count, meter or log outcomes locally.
   */
  readonly onOutcome?: (outcome: GateOutcome) => void;
  /** A hook handler that threw. The CLI treats a throwing hook as absent, so it is never silent. */
  readonly onHookFailure?: (failure: { event: string; error: unknown }) => void;
}

/** One composed session: the handle, its machine, and how to take the wiring back down. */
export interface ComposedSession {
  readonly sessionKey: string;
  readonly session: HostedSession;
  readonly machine: SessionStateMachine;
  readonly observer: SessionObserver;
  /** Stops forwarding. Idempotent. Does not end the session; the registry owns lifetime. */
  readonly detach: Unsubscribe;
}

/**
 * Assemble one session: machine, observer, gate and forwarding, then start it.
 *
 * This is the wiring every consumer needs, written down where it can be used.
 */
export function composeSession(options: ComposeSessionOptions): Result<ComposedSession> {
  // The one combination this function will not assemble, and this is the only place that can see
  // it: the gate knows whether it grants and the request knows which settings tiers load, and
  // neither knows the other. Refused before any process exists, by name, rather than resolved by a
  // precedence that would surprise one of them.
  //
  // The ground for the refusal is narrow. Per the documented permission rules, deny and ask are
  // evaluated whatever a hook returns, so a grant skips only mode, allow rules and `canUseTool`; an
  // effective allow does not short-circuit every later permission check. The refusal stands on the
  // narrower ground that the two mechanisms answer the same question from different places, and a
  // session that both grants and loads operator rules has two authorities with no stated
  // precedence. See `gate.ts` for the full order and for why the claim is documented rather than
  // measured.
  //
  // And `settingSources: []` does not mean "no operator rules live". Managed policy settings and
  // `~/.claude.json` load regardless of this field, precisely on the managed corporate laptop this
  // package's threat model is written for. So this refusal is incomplete on its own logic: it
  // catches the tiers named here and cannot see the two that are always on.
  const settingSources = options.request?.settingSources ?? [];
  // The pair is refused, except under bypassPermissions. What the grant skips is "permission
  // mode, allow rules and canUseTool"; under bypass the mode already allows all of that, so the
  // grant changes nothing and there is no second authority to shadow. A hook deny survives every
  // mode, so the gate's boundary set still holds. The precedence is therefore stated by the mode
  // itself: the operator asked for bypass, and got exactly the CLI's bypass plus this gate's
  // refusals. Every other mode keeps the refusal below, unchanged.
  if (
    (options.gate?.grantOnAllow ?? false) &&
    settingSources.length > 0 &&
    !isBypassMode(options.request?.permissionMode)
  ) {
    return refuse<ComposedSession>(
      'permission-grant-shadows-settings',
      `grantOnAllow makes this gate's allow effective, and this session also loads operator settings ` +
        `(${settingSources.join(', ')}) — two authorities over the same call with no stated ` +
        `precedence. Per the SDK's documented evaluation order a hook allow does NOT skip deny or ` +
        `ask rules, so those survive the grant; what it skips is permission mode, allow rules and ` +
        `canUseTool. Load no settings, do not grant, or run bypassPermissions — where the grant ` +
        `changes nothing because the mode already allows what it would. Note that managed policy and ` +
        `~/.claude.json load regardless of settingSources, so an empty list is not proof that no ` +
        `operator rule is live.`,
    );
  }

  // The second combination this function will not assemble. `permissionHooks` throws when the
  // host's own deadline does not expire before the matcher's, and that throw is right: the pair is
  // checkable, the failure it prevents is a block nobody can explain, and an embedder calling
  // `permissionHooks` directly should meet it loudly. But gate timings ride `session_new`, so a
  // controller can send the pair, and a throw from here would escape the payload dispatcher's
  // `void this.#open(…)` as an unhandled rejection, which means the controller gets no answer at
  // all. A command that vanishes reads as a host that hung, which is precisely what refusing every
  // unknown payload by name exists to prevent. Caught here rather than by relaxing the throw: the
  // check keeps its teeth, and the composer keeps its contract of returning a Result for
  // everything it declines to build.
  const inverted = deadlineOrderRefusal(options.gate?.decisionTimeoutMs, options.gate?.matcherTimeoutSeconds);
  if (inverted !== null) return refuse<ComposedSession>('gate-deadlines-inverted', inverted);

  const clock = options.clock ?? systemClock;
  const ticker = options.ticker ?? systemTicker;

  const machine = new SessionStateMachine({
    where: options.where ?? unknownWhere(options.cwd),
    clock,
    ticker,
    correlationId: options.correlationId ?? null,
  });
  const observer = new SessionObserver(machine);

  // The gate records every outcome on the machine. That emission is what makes a deny, an outage and
  // an expiry visible off-box at all, so it is unconditional and the embedder's listener is extra.
  const gate = permissionHooks({
    decide: options.decide,
    // The escalation body carries the controller's handle. This function is the one place that
    // holds both the handle and the gate, so it is where the two transports are tied together.
    sessionKey: options.sessionKey,
    onOutcome: (outcome) => {
      recordGateOutcome(machine, outcome);
      options.onOutcome?.(outcome);
    },
    ...(options.localGate === undefined ? {} : { localGate: options.localGate }),
    ...(options.gate?.decisionTimeoutMs === undefined
      ? {}
      : { decisionTimeoutMs: options.gate.decisionTimeoutMs }),
    ...(options.gate?.holdAfterMs === undefined ? {} : { holdAfterMs: options.gate.holdAfterMs }),
    ...(options.gate?.matcherTimeoutSeconds === undefined
      ? {}
      : { matcherTimeoutSeconds: options.gate.matcherTimeoutSeconds }),
    ...(options.gate?.grantOnAllow === undefined ? {} : { grantOnAllow: options.gate.grantOnAllow }),
    // The `gate-cannot-grant` residual reaches the same lane every other named degrade uses, so an
    // embedder who already subscribes to refusals learns about it without opting in to anything new.
    ...(options.onRefusal === undefined
      ? {}
      : {
          onDegrade: (degrade: { name: RefusalReason; detail: string }): void =>
            options.onRefusal?.(refusal(degrade.name, degrade.detail)),
        }),
  });

  // Observation first, the gate second. The order is a convention rather than a race guard (see
  // permissionHooks' own note), but it is the one both files state, so it is written once here.
  const hooks = mergeHooks(
    observationHooks({
      observer,
      ...(options.onHookFailure === undefined ? {} : { onHandlerFailure: options.onHookFailure }),
    }),
    gate,
  );

  const created = options.registry.create({ ...(options.request ?? {}), cwd: options.cwd, hooks });
  if (!created.ok) return refuse<ComposedSession>(created.refusal.reason, created.refusal.detail);
  const session = created.value;

  // Before the first record. See this file's header: the forwarder subscribes to the machine, so
  // anything recorded ahead of this line is emitted to nobody.
  const detach = forwardSession({
    sessionKey: options.sessionKey,
    session,
    observer,
    sink: options.sink,
    ...(options.onRefusal === undefined ? {} : { onRefusal: options.onRefusal }),
  });

  observer.created(`a session was requested in ${options.cwd}`);

  return ok({ sessionKey: options.sessionKey, session, machine, observer, detach });
}

/**
 * The `where` for a directory nobody has read git facts for.
 *
 * Stated rather than left null: a transition whose `where` is absent cannot be told apart from one
 * whose repository could not be determined, and only the second is a fact worth reporting.
 */
function unknownWhere(cwd: string): TransitionWhere {
  return { cwd, worktree: null, branch: null, unknownReason: 'the repository was not read for this session' };
}

/**
 * A controller's per-session timings, as a partial the composer can spread.
 *
 * Absent keys rather than nulls: `GateTimings` reads an absent key as "use the default", and a
 * present `undefined` would spread over a value the embedder deliberately set. The difference is
 * invisible until an embedder configures a timeout and a controller sends `gate: {…, holdAfterMs:
 * null}` — at which point the embedder's value either survives or silently does not.
 *
 * Nothing validates the pair here, deliberately. `permissionHooks` throws at construction when the
 * host's own deadline does not expire before the matcher's, and that check must stay the only one:
 * a second copy of the rule is a second thing to keep in step. The throw surfaces as a refused
 * composition before any process exists, which is where a controller wants to learn it.
 */
function readGateTimings(gate: SessionNewGate | null): Partial<GateTimings> {
  if (gate === null) return {};
  return {
    ...(gate.decisionTimeoutMs === null ? {} : { decisionTimeoutMs: gate.decisionTimeoutMs }),
    ...(gate.holdAfterMs === null ? {} : { holdAfterMs: gate.holdAfterMs }),
    ...(gate.matcherTimeoutSeconds === null ? {} : { matcherTimeoutSeconds: gate.matcherTimeoutSeconds }),
  };
}

// ---------------------------------------------------------------------------
// The host.
// ---------------------------------------------------------------------------

/** Turns the opaque `what` of a bulk request into a file this host will POST. */
export type BulkResolver = (what: string, sessionKey: string) => Result<string>;

/**
 * The link surface a host uses. `ControllerLink` satisfies it.
 *
 * It is structural so the host's own rules can be checked without a socket: that an unknown
 * handle is refused rather than dropped, that two `session_new` for one handle do not silently
 * replace each other, that a failed delivery still sends a receipt, that a finished session is
 * released in an order which keeps its last frames. It is not a way to test the transport: a
 * substitute proves the substitute, and everything this package claims about reconnect, replay and
 * `seq` is proven against the real link in `control/`.
 */
export interface HostLink extends FrameSink {
  start(): void;
  stop(detail?: string): void;
  forgetSession(sessionId: string): void;
  /** The version the controller chose at the last accepted handshake; optional because a test link negotiates nothing. */
  readonly negotiatedVersion?: number | null;
  /** Replace what the next `link_hello` declares; optional because a test link declares nothing. */
  announce?(
    capabilities: readonly string[],
    configuration: HostConfiguration,
    pendingRestart: readonly string[],
  ): void;
}

/**
 * What a reconfigure produced: the pieces the host swaps in place of the ones it was composed with.
 * `undefined` members mean the same as an omitted option at composition (no provider, no root).
 */
export interface HostReconfigured {
  readonly workspaces: WorkspaceProvider | undefined;
  readonly transcriptsRoot: string | undefined;
  readonly bulk: BulkResolver | undefined;
  readonly linkCapabilities: readonly string[];
  readonly configuration: HostConfiguration;
  readonly overriddenByEnvironment: readonly string[];
  /** The keys written but not in effect until the next start. */
  readonly pendingRestart: readonly string[];
}

/**
 * The configuration seam a `host_configure` ask runs through. The composition root supplies it,
 * because writing the config file and rebuilding a provider both read the environment, which is
 * that file's job alone. `hostBusy` is true while any session is live or opening; the seam refuses
 * a roots change by name in that state rather than writing a file the running host cannot honour.
 */
export type HostReconfigurer = (
  entries: readonly HostConfigureEntry[],
  hostBusy: boolean,
) => Result<HostReconfigured>;

export interface PeriscopeHostOptions {
  readonly controllerUrl: string;
  readonly hostId: string;
  /**
   * The identity this host presents outbound, on the link's upgrade and on every bulk POST
   * (resolved per delivery; a refusing credential posts headerless, and the receiver's refusal
   * comes back as `bulk-delivery-failed`). Omitted means every outbound surface is anonymous.
   */
  readonly credential?: ControllerCredential;
  readonly backoff?: BackoffOptions;
  /**
   * The default link's clocks: the heartbeat's interval and timeout, and how long a dial may sit
   * without an open before it is abandoned and retried. Ignored when `link` supplies the link.
   */
  readonly linkTimings?: {
    readonly heartbeatIntervalMs?: number;
    readonly heartbeatTimeoutMs?: number;
    readonly connectTimeoutMs?: number;
  };
  /** Who answers a permission escalation. Required: a host with no decider gates nothing. */
  readonly decide: Decider;
  /**
   * Absolute paths the agent may never read or write, whatever its workspace.
   *
   * `host/paths.ts`'s `credentialPaths(env)` computes the default set; the composition root passes
   * it in, because reading the environment is that file's job and only that file's.
   */
  readonly protectedPaths: readonly string[];
  /**
   * Which tool names the local gate treats as path writes, path reads and shell commands.
   *
   * Defaults to the SDK's own tools (`DEFAULT_TOOL_FAMILIES`). An MCP tool the embedder registers
   * arrives as `mcp__{server}__{tool}`, matches nothing, and escalates with no local opinion; naming
   * it here gives it the same local treatment as the built-in it resembles. Data, never guessed:
   * the host cannot know which of an embedder's tools are dangerous.
   */
  readonly toolFamilies?: ToolFamilies;
  /**
   * The `extraEnv` keys a controller may not set; a `session_new` naming one refuses
   * `env-key-refused` before a process exists. Defaults to `EXTRA_ENV_FLOOR` (`PATH`,
   * `NODE_OPTIONS`, TLS verification, the model endpoint, the credentials); an embedder that trusts
   * its controller with more passes a shorter list, and the binary never does.
   */
  readonly extraEnvFloor?: readonly string[];
  /**
   * How many sessions this host holds at once, live and opening together; a `session_new` past it
   * refuses `session-cap-reached`. Defaults to `DEFAULT_MAX_SESSIONS`. Ignored when a `registry` is
   * supplied, which carries its own bound.
   */
  readonly maxSessions?: number;
  /**
   * Where sessions run. With a provider the controller's `cwd` is advisory: the provider decides,
   * and the session's `spawning` transition carries the directory it actually got, so the
   * controller learns where its session is rather than assuming.
   */
  readonly workspaces?: WorkspaceProvider;
  /**
   * The key an unkeyed `session_new` provisions at, when it should not be the session key
   * (protocol v5).
   *
   * A default for an absence, never an override: resolution is exactly
   * `opening.workspaceKey ?? defaultWorkspaceKey ?? sessionKey`, so a controller that names a key
   * never has this consulted and no precedence question exists. It is what lets a library user
   * with no controller at all get a shared tree: every unkeyed session lands in one workspace.
   * The composition root screens the configured value at startup (same union screen as a wire
   * key); the per-frame validation below still covers an embedder that passes one here directly.
   */
  readonly defaultWorkspaceKey?: string;
  /**
   * In-process tools this host offers every session. See the note on registration below.
   *
   * `identity` is not the embedder's to supply: it must be read at CALL time and only this host
   * knows which session is calling, so it is filled in here and omitted from the type rather than
   * accepted and ignored.
   */
  readonly tools?: Omit<McpServerOptions, 'identity'>;
  readonly bulk?: BulkResolver;
  /**
   * Where the agent CLI's transcripts live (`~/.claude/projects`), for the discovery door.
   *
   * The composition root derives it (`claudeProjectsRoot(env)` in `host/claude-transcripts.ts`),
   * because reading the environment is that layer's job. Absent means the door answers every
   * `transcript_list` / `transcript_tail` with a named failure rather than guessing a root;
   * `session_list` needs no filesystem and always answers.
   */
  readonly transcriptsRoot?: string;
  readonly gate?: GateTimings;
  /**
   * Capability markers this host declares in its `link_hello`, beside the built-in `bulk-post`,
   * never replacing it.
   *
   * The workspace mode rides here: the composition root computes
   * `workspaceCapabilitiesOf(config)` (`bin/workspaces.ts`) because only it knows which provider
   * it chose; the mode is deliberately erased from `WorkspaceProvider` itself. Markers are values
   * in an existing open string list, so declaring a new one is not a protocol change and bumps no
   * version; a controller that does not know a marker ignores it by construction. Values a marker
   * cannot carry (which repository root, which scheme text) are a payload-member conversation, a
   * version bump, and deliberately not smuggled in here.
   */
  readonly linkCapabilities?: readonly string[];
  /**
   * The values behind those markers: which roots, which scheme, which transcripts root,
   * which controller. The composition root computes `hostConfigurationOf(config, ...)` beside the
   * markers, from the same reading, so the two cannot disagree. Omitted, the hello reports every
   * value as null.
   */
  readonly configuration?: HostConfiguration;
  /** The wire-settable keys the environment sets, reported on a configure answer. */
  readonly overriddenByEnvironment?: readonly string[];
  /** The keys the file names differently from what this process dialled; empty at a fresh start. */
  readonly pendingRestart?: readonly string[];
  /** How a `host_configure` ask is applied. Omitted, every such ask refuses `config-write-failed`. */
  readonly reconfigure?: HostReconfigurer;
  readonly registry?: SessionRegistry;
  /** How the link is built. Defaults to the real `ControllerLink`. See `HostLink`. */
  readonly link?: (handlers: LinkHandlers) => HostLink;
  /** The environment sessions are filtered from, when this builds its own registry. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly clock?: Clock;
  readonly ticker?: Ticker;
  /** Every named thing that happened. A host with no reporter is a host nobody can debug. */
  readonly report?: (event: HostEvent) => void;
}

/** What a host reports. Data rather than log lines, so an embedder decides the format. */
export type HostEvent =
  | { readonly kind: 'link'; readonly transition: LinkTransition }
  | { readonly kind: 'refusal'; readonly refusal: Refusal; readonly sessionKey: string | null }
  | {
      readonly kind: 'gap';
      readonly sessionKey: string;
      readonly expected: number;
      readonly received: number;
    }
  | { readonly kind: 'session-opened'; readonly sessionKey: string; readonly cwd: string }
  | { readonly kind: 'session-closed'; readonly sessionKey: string }
  | { readonly kind: 'prompt-held'; readonly sessionKey: string; readonly held: number }
  | { readonly kind: 'prompt-delivered'; readonly sessionKey: string; readonly delivered: number }
  | { readonly kind: 'prompt-withdrawn'; readonly sessionKey: string; readonly withdrawn: number }
  | { readonly kind: 'transition'; readonly sessionKey: string; readonly transition: SessionTransition }
  /**
   * A named condition that changed what is true of a session without ending it.
   *
   * Every degrade the sessions layer raises arrives here. The registry names its conditions (an
   * untrusted workspace whose settings rules are silently void, an id collision whose own detail
   * says how to resolve it) into a listener set, and a listener set with no subscribers would
   * mean the one message that answers the operator's question is raised and never received. The
   * subscription in `#compose` is the audience; a pin in `host.test.ts` holds every kind to it.
   */
  | { readonly kind: 'degrade'; readonly sessionKey: string; readonly degrade: SessionDegrade };

/**
 * How many turns may wait for one still-opening session before the rest are refused.
 *
 * The bound exists because the buffer is fed from the wire, not because anyone expects to reach it:
 * a controller sends one seed per `session_new`, so the ordinary depth is 1. An unbounded per-handle
 * buffer that a peer can grow is the shape this package refuses everywhere else, and the window it
 * lives in is exactly as long as a workspace provider takes, which is seconds, not microseconds, and
 * is the whole reason this queue exists.
 */
const MAX_HELD_TURNS = 8;

/**
 * A host: one outbound link, one registry, and the dispatcher between them.
 *
 * It interprets exactly the payload kinds its `#dispatch` switch names and refuses the rest by
 * name: the session commands (`session_new`, `session_prompt`, `session_cancel`,
 * `session_configure`), `bulk_request`, and the host-scoped asks (the discovery, workspace,
 * configure and repository asks). Derive the count from the switch below; never carry it from
 * prose. Anything else arriving inbound is
 * either a frame this host produces (an update, a delta, a receipt) or a kind a newer controller
 * invented, and both are reported rather than ignored; a command that vanishes reads to the
 * controller as a host that hung.
 */
export class PeriscopeHost {
  readonly #options: PeriscopeHostOptions;
  readonly #link: HostLink;
  readonly #registry: SessionRegistry;
  /** Keyed by the controller's handle, which is the only id present when `session_new` arrives. */
  readonly #sessions = new Map<string, ComposedSession>();
  /**
   * Handles whose open is still in flight. `#open` awaits the workspace provider before it can
   * populate `#sessions`, so the map alone cannot make the duplicate guard hold across that await;
   * the reservation is taken synchronously and released in the same call, whatever the outcome.
   */
  readonly #opening = new Set<string>();

  /**
   * regression: an undroppable frame the link's queue refused at capacity — a turn-end transition, a
   * result — was reported here and dropped, so the controller never learned the turn ended and the
   * session read as still working until its next turn. The queue's refusal is backpressure; the
   * caller has to hold the frame and offer it again. Held per session, in order; while a session holds
   * frames its later undroppable frames queue behind them, so the controller sees the session's order.
   */
  readonly #heldFrames = new Map<string, SessionPayload[]>();
  #heldFramesTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Turns that arrived while their session was still opening, in order.
   *
   * A controller sends `session_new` then `session_prompt`, and that ordering is real on the wire,
   * but a send returning Ok means written to the socket, not accepted, because the host
   * acknowledges no controller frame (the reason `OutboundRetention` exists). Here the open is
   * asynchronous: it awaits the workspace provider, and a real `GitWorktreeProvider` is a
   * `git worktree add`, which takes seconds (measured at 13 s once). A seed landing in that window
   * would be refused `session-unknown`, and the session would then open and sit idle forever.
   * Nothing downstream could say why: a born session with no first turn looks exactly like a slow
   * one.
   *
   * With `PlainDirProvider` (a `mkdir`) the window never opens, so only the git provider, which
   * is what a session needs in order to commit or push at all, exposes this.
   *
   * The invariant, and it is the whole point: a held turn is answered, never dropped. Delivered
   * when the session opens (`#compose`), refused if the open failed (`#open`'s `finally`, which runs
   * on every path including a throw), or withdrawn because the controller cancelled it (`#withdraw`).
   * Three exits, all of them reported. A queue that silently discarded on any one of them would be
   * the same defect wearing a fix's clothes.
   *
   * It is deliberately not consulted for a handle this host has never heard of. `session-unknown`
   * stays the honest, immediate answer for an id that does not exist and never will; retrying that
   * is futile and `core/refusal.ts` says so. Only a handle already reserved in `#opening` can hold.
   */
  readonly #held = new Map<string, string[]>();
  /**
   * Which workspace key each live-or-opening session provisioned at (protocol v5).
   *
   * Two consumers, and both exist because keys can alias. The release sites read it so a session
   * provisioned at a shared key releases that key rather than its own session key; without it,
   * `provision('shared-1')` paired with `release(sessionKey)` would leak the claim on every
   * aliased session. And the reap's in-use guard scans its values: N sessions can share one key,
   * each holding its own entry here, so "is this key in use" stays true until the last of them
   * closes; a single-mapping guard would clear on the first close and let a reap delete a tree
   * other sessions are still working in.
   *
   * Written synchronously before the provision await (so an opening session already guards its
   * key); cleared in `#open`'s finally when the open produced no session, and in `#close`.
   */
  readonly #workspaceKeyFor = new Map<string, string>();
  /**
   * Every provider call rides a per-key turn. `#dispatch` never awaits a handler, and the work
   * behind these verbs is seconds long and mutually destructive on one key: a `git worktree add`
   * measured at 13 to 18 s, a `git worktree remove --force` the same order. The reachable
   * interleavings: a `session_new` provisioning into a directory the reap is mid-deleting (the
   * in-use scan happened before the multi-second await), and a reap starting inside `#close`'s
   * window (the map entry is deleted before its release settles). One serial queue per key closes
   * every direction at the only chokepoint all three verbs share; keys that differ never wait on
   * each other.
   */
  readonly #workspaceTurns = new KeyedTurns();
  /**
   * The pieces a `host_configure` may replace, held apart from the frozen options so a reconfigure
   * swaps them in one place and every handler reads the current one. Initialised from the options.
   */
  #workspaces: WorkspaceProvider | undefined;
  #transcriptsRoot: string | undefined;
  #bulk: BulkResolver | undefined;
  #linkCapabilities: readonly string[];
  #configuration: HostConfiguration;
  #overriddenByEnvironment: readonly string[];
  #pendingRestart: readonly string[];

  constructor(options: PeriscopeHostOptions) {
    this.#options = options;
    this.#workspaces = options.workspaces;
    this.#transcriptsRoot = options.transcriptsRoot;
    this.#bulk = options.bulk;
    this.#linkCapabilities = options.linkCapabilities ?? [];
    this.#configuration = options.configuration ?? unsetHostConfiguration();
    this.#overriddenByEnvironment = options.overriddenByEnvironment ?? [];
    this.#pendingRestart = options.pendingRestart ?? [];
    if (options.registry !== undefined && (options.baseEnv !== undefined || options.homeDir !== undefined)) {
      // A registry carries its own environment and home; a second pair beside it would be read by
      // nothing, and an embedder who passed both would believe the pair was in effect.
      throw new Error(
        'PeriscopeHostOptions: baseEnv and homeDir are ignored when a registry is supplied; pass them to the registry',
      );
    }
    this.#registry =
      options.registry ??
      new SessionRegistry({
        baseEnv: options.baseEnv ?? {},
        homeDir: options.homeDir ?? '',
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
      });

    const handlers: LinkHandlers = {
      onTransition: (transition) => this.#report({ kind: 'link', transition }),
      onSessionFrame: (frame) => this.#dispatch(frame),
      onGap: (sessionKey, expected, received) =>
        this.#report({ kind: 'gap', sessionKey, expected, received }),
      onRefusal: (refused) => this.#report({ kind: 'refusal', refusal: refused, sessionKey: null }),
    };

    this.#link =
      options.link?.(handlers) ??
      new ControllerLink({
        url: options.controllerUrl,
        hostId: options.hostId,
        handlers,
        ...(options.credential === undefined ? {} : { credential: options.credential }),
        ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.ticker === undefined ? {} : { ticker: options.ticker }),
        ...(options.linkCapabilities === undefined ? {} : { capabilities: options.linkCapabilities }),
        ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
        ...(options.pendingRestart === undefined ? {} : { pendingRestart: options.pendingRestart }),
        ...(options.linkTimings?.heartbeatIntervalMs === undefined
          ? {}
          : { heartbeatIntervalMs: options.linkTimings.heartbeatIntervalMs }),
        ...(options.linkTimings?.heartbeatTimeoutMs === undefined
          ? {}
          : { heartbeatTimeoutMs: options.linkTimings.heartbeatTimeoutMs }),
        ...(options.linkTimings?.connectTimeoutMs === undefined
          ? {}
          : { connectTimeoutMs: options.linkTimings.connectTimeoutMs }),
      });
  }

  get link(): HostLink {
    return this.#link;
  }

  get registry(): SessionRegistry {
    return this.#registry;
  }

  /** The composed session behind a controller handle, or a refusal naming the handle. */
  session(sessionKey: string): Result<ComposedSession> {
    const composed = this.#sessions.get(sessionKey);
    if (composed === undefined) {
      return refuse<ComposedSession>('session-unknown', `no session for controller handle ${sessionKey}`);
    }
    return ok(composed);
  }

  start(): void {
    this.#link.start();
  }

  /** Ends every session first, then the link — so the end transitions still have somewhere to go. */
  stop(detail = 'host shutting down'): void {
    if (this.#heldFramesTimer !== null) {
      clearTimeout(this.#heldFramesTimer);
      this.#heldFramesTimer = null;
    }
    for (const composed of [...this.#sessions.values()]) composed.session.stop(detail);
    this.#registry.stopAll(detail);
    this.#link.stop(detail);
  }

  // -------------------------------------------------------------------------

  #dispatch(frame: SessionFrame): void {
    const payload: SessionPayload = frame.payload;
    switch (payload.kind) {
      case 'session_new':
        void this.#open(frame.sessionId, payload);
        return;
      case 'session_prompt': {
        // A turn for a session whose open is still in flight waits for it rather than being refused.
        // The reservation it tests is the one `#open` already takes; see `#held`.
        if (!this.#sessions.has(frame.sessionId) && this.#opening.has(frame.sessionId)) {
          return this.#hold(frame.sessionId, payload.text);
        }
        const composed = this.session(frame.sessionId);
        if (!composed.ok) return this.#refuse(frame.sessionId, composed.refusal);
        return this.#prompt(frame.sessionId, composed.value, payload.text);
      }
      case 'session_cancel': {
        // The same race, the other frame. A cancel arriving while the session is still opening
        // stops the turn that is waiting, the only turn that can exist yet. It does not stop the
        // open: `session_cancel` ends a turn, never a session, and that contract is pinned.
        if (!this.#sessions.has(frame.sessionId) && this.#opening.has(frame.sessionId)) {
          return this.#withdraw(frame.sessionId);
        }
        const composed = this.session(frame.sessionId);
        if (!composed.ok) return this.#refuse(frame.sessionId, composed.refusal);
        composed.value.observer.interrupted('the controller cancelled the turn');
        void composed.value.session.interrupt().catch((error: unknown) => {
          this.#refuse(
            frame.sessionId,
            refusal('session-unknown', `the interrupt failed: ${describe(error)}`),
          );
        });
        return;
      }
      case 'session_configure': {
        // Protocol v6: the SDK's live setters. A session still opening has no query to configure yet; the
        // controller is told so by name rather than left to assume the change landed.
        const composed = this.session(frame.sessionId);
        if (!composed.ok) return this.#refuse(frame.sessionId, composed.refusal);
        const change = readSessionConfigure(payload);
        if (!change.ok) return this.#refuse(frame.sessionId, change.refusal);
        void composed.value.session.configure(change.value).catch((error: unknown) => {
          this.#refuse(
            frame.sessionId,
            refusal('session-unknown', `the configure failed: ${describe(error)}`),
          );
        });
        return;
      }
      case 'bulk_request':
        void this.#deliver(
          frame.sessionId,
          payload.deliveryId,
          payload.what,
          payload.postUrl,
          payload.fromOffset,
        );
        return;
      // The discovery requests are host-scoped, not session-scoped. The routing key on these
      // frames is a channel the controller chose; no session needs to exist behind it, so none of
      // the session-existence machinery above applies. The answer rides back on the same key.
      case 'session_list':
        return this.#answerSessionList(frame.sessionId, payload);
      case 'transcript_list':
        void this.#answerTranscriptList(frame.sessionId, payload);
        return;
      case 'transcript_tail':
        void this.#answerTranscriptTail(frame.sessionId, payload);
        return;
      case 'workspace_release':
        void this.#answerWorkspaceRelease(frame.sessionId, payload);
        return;
      case 'workspace_release_bulk':
        void this.#answerWorkspaceReleaseBulk(frame.sessionId, payload);
        return;
      case 'host_configure':
        return this.#answerHostConfigure(frame.sessionId, payload);
      case 'workspace_list':
        void this.#answerWorkspaceList(frame.sessionId, payload);
        return;
      case 'repository_list':
        void this.#answerRepositoryList(frame.sessionId, payload);
        return;
      case 'repository_read':
        void this.#answerRepositoryRead(frame.sessionId, payload);
        return;
      default:
        // A kind this host produces, or one a newer controller invented. Named either way.
        this.#refuse(
          frame.sessionId,
          refusal('frame-malformed', `this host takes no inbound "${payload.kind}" — it is not a command`),
        );
        return;
    }
  }

  /**
   * Send one turn at a live session and record that it happened.
   *
   * One path for both arrivals. A turn that waited and a turn that walked straight in must reach the
   * agent identically and leave the same trace, or "it was queued" would become a second, quieter
   * grade of delivery that nothing downstream could tell apart from the first.
   */
  #prompt(sessionKey: string, composed: ComposedSession, text: string): void {
    const sent = composed.session.prompt(text);
    if (!sent.ok) return this.#refuse(sessionKey, sent.refusal);
    composed.observer.promptSubmitted('the controller sent a turn');
  }

  /** Hold a turn for a session still opening, or refuse it when the bound is already reached. */
  #hold(sessionKey: string, text: string): void {
    const waiting = this.#held.get(sessionKey) ?? [];
    if (waiting.length >= MAX_HELD_TURNS) {
      // Named rather than dropped, and `session-unknown` rather than a new reason: from the sender's
      // side this handle still holds no session, and the vocabulary in `core/refusal.ts` is closed on
      // purpose; a reason minted for one call site is one nobody else can branch on.
      return this.#refuse(
        sessionKey,
        refusal(
          'session-unknown',
          `${MAX_HELD_TURNS} turns are already waiting for ${sessionKey} to open — this one was not taken`,
        ),
      );
    }
    waiting.push(text);
    this.#held.set(sessionKey, waiting);
    this.#report({ kind: 'prompt-held', sessionKey, held: waiting.length });
  }

  /** Every held turn, in arrival order, the moment the session exists. */
  #drain(sessionKey: string, composed: ComposedSession): void {
    const waiting = this.#held.get(sessionKey);
    if (waiting === undefined) return;
    this.#held.delete(sessionKey);
    for (const text of waiting) this.#prompt(sessionKey, composed, text);
    this.#report({ kind: 'prompt-delivered', sessionKey, delivered: waiting.length });
  }

  /**
   * The controller withdrew the turns it was waiting on. The third answer, and the only one the
   * sender asked for.
   *
   * It is reported rather than silent, which is what keeps it inside the invariant instead of
   * being the exception that swallows it: a withdrawn turn and a dropped one are the same absence on
   * the wire, and only one of them is something to investigate.
   *
   * The limit: no session exists yet, so there is no machine to record an `interrupted`
   * transition on; this is reported by the host, not by the session's own state log. A cancel that
   * lands after the open takes the ordinary path and is recorded there.
   */
  #withdraw(sessionKey: string): void {
    const waiting = this.#held.get(sessionKey) ?? [];
    this.#held.delete(sessionKey);
    this.#report({ kind: 'prompt-withdrawn', sessionKey, withdrawn: waiting.length });
  }

  /**
   * The open ended without a session: every turn still waiting is refused, one refusal each.
   *
   * This is the half that keeps the queue honest. Holding a turn is a promise to answer it, and the
   * only failure worse than refusing a turn that could have been served is accepting one and saying
   * nothing, which is the defect this whole queue exists to end, relocated one layer in.
   */
  #abandon(sessionKey: string): void {
    const waiting = this.#held.get(sessionKey);
    if (waiting === undefined) return;
    this.#held.delete(sessionKey);
    for (const _text of waiting) {
      this.#refuse(
        sessionKey,
        refusal('session-unknown', `${sessionKey} never opened, so a turn held for it cannot be delivered`),
      );
    }
  }

  async #open(sessionKey: string, opening: SessionNew): Promise<void> {
    if (this.#sessions.has(sessionKey) || this.#opening.has(sessionKey)) {
      // Two `session_new` for one handle: the second must not silently replace the first, which
      // would leave a live agent running with nothing routed to it. The `#opening` half of the
      // check is what makes this hold for two frames in flight: with a workspace provider
      // configured there is an await between here and the map write, and a guard that reads only
      // the map lets both frames through it: double spawn, one leaked agent, one handle.
      return this.#refuse(
        sessionKey,
        refusal('session-unknown', `${sessionKey} is already a live or opening session here`),
      );
    }

    this.#opening.add(sessionKey);
    try {
      await this.#compose(sessionKey, opening);
    } catch (error) {
      // Every exit from an open is a wire answer. The dispatcher calls this as
      // `void this.#open(…)`, so without this catch a throw anywhere in `#compose` would become an
      // unhandled rejection: the controller gets nothing at all, its record of the session reads
      // `open` forever, and on a host with no unhandledRejection handler the process could die
      // outright. A command that vanishes reads as a host that hung, the exact failure refusing
      // every unknown payload by name exists to prevent, arriving through the one door that was not
      // refusing.
      //
      // Caught here rather than at each throw site, deliberately. Guarding a named list of throw
      // sources leaves the next one unguarded; this arm cannot be outrun by a source nobody has
      // written yet.
      //
      // The `finally` below still runs for the queue: held turns are answered by `#abandon`, so a
      // throw during an open does not silently strand the turns waiting on it.
      this.#refuseOpen(
        sessionKey,
        null,
        refusal(
          'session-spawn-failed',
          `opening ${sessionKey} threw rather than returning a refusal: ${describe(error)}`,
        ),
      );
    } finally {
      this.#opening.delete(sessionKey);
      // A successful open drained and cleared the queue already, so this finds nothing. Anything still
      // here means the open did not produce a session (a refused request, a failed provision, a
      // `giveBack`, or a throw) and each waiting turn is answered rather than forgotten. It sits in
      // `finally` so no failure path can skip it, including one nobody has written yet.
      this.#abandon(sessionKey);
      // An open that produced no session holds no workspace claim, so its key entry goes too: in
      // `finally` for the same reason as the queue, and guarded so a successful open keeps the
      // entry the release sites and the in-use guard read for the session's whole life.
      if (!this.#sessions.has(sessionKey)) this.#workspaceKeyFor.delete(sessionKey);
    }
  }

  async #compose(sessionKey: string, opening: SessionNew): Promise<void> {
    // Narrowed before the workspace is claimed, and the order is the point. A request this host
    // cannot use is refused while it still owns nothing: provisioning first would take a directory,
    // find the request unusable, and have to hand it back, a claim/release round trip on every
    // malformed frame, in the one path a stranger can drive.
    const requested = readSessionRequest(opening.request, this.#options.extraEnvFloor);
    if (!requested.ok) return this.#refuseOpen(sessionKey, null, requested.refusal);

    const provider = this.#workspaces;

    // Where the workspace key resolves: each `??` is a default for an absence, never an
    // override, so a controller that names a key never has the host's configured default consulted.
    // Validated before the workspace is claimed, same order and same reason as the request
    // narrowing above: a key this host cannot use must refuse while it still owns nothing.
    const askedKey = opening.workspaceKey ?? this.#options.defaultWorkspaceKey ?? null;
    if (askedKey !== null) {
      const source =
        opening.workspaceKey !== null
          ? 'session_new.workspaceKey'
          : "this host's configured default workspace key";
      if (provider === undefined) {
        // The `path-input-missing` posture's mirror image: with no provider there is nothing to
        // provision at any key, and running in the controller's cwd instead would deliver the
        // wrong topology silently, the exact failure an explicit key exists to end.
        return this.#refuseOpen(
          sessionKey,
          null,
          refusal(
            'workspace-provision-failed',
            `${source} names ${askedKey} and this host has no workspace provider — there is nothing to provision at that key, so the ask cannot be honoured`,
          ),
        );
      }
      const problem = unusableKeyProblem(askedKey);
      if (problem !== null) {
        // An unusable key is refused by the host's own guard with the field named, never left to
        // die inside git as an unnamed provision failure.
        // `keyPreview`, never the raw key: an over-length key's refusal must itself stay sendable.
        return this.#refuseOpen(
          sessionKey,
          null,
          refusal('workspace-provision-failed', `${source} ${keyPreview(askedKey)} ${problem}`),
        );
      }
    }
    const workspaceKey = askedKey ?? sessionKey;

    let cwd = opening.cwd;
    // The provider decides, except for the repository it clones from. A named cwd is advisory
    // under a provider, with one exception: the provider's own repository root, the operator's
    // checkout, trusted in their ~/.claude.json, where the CLI they know runs and every settings
    // tier loads. There is no isolation to protect when the operator asks for the source itself,
    // and no worktree could be more "the repo" than the repo. Any other named directory still gets
    // a provisioned workspace. The workspace guard's root follows the cwd either way; the
    // operator's checkout claims no workspace key, so the reap never touches it.
    const operatorsCheckout =
      provider !== undefined &&
      cwd !== null &&
      provider.repositoryRoot !== undefined &&
      normalizePath(cwd).toLowerCase() === normalizePath(provider.repositoryRoot).toLowerCase();
    // A resume runs where its transcript lives, or not at all. The CLI keeps transcripts per cwd;
    // a resume moved into a provisioned workspace finds nothing and becomes a fresh session that
    // says nothing. A named cwd the provider would not honour is therefore refused by name, on the
    // wire, instead of being quietly overruled.
    if (provider !== undefined && !operatorsCheckout && cwd !== null && opening.request?.resume) {
      return this.#refuseOpen(
        sessionKey,
        null,
        refusal(
          'resume-cwd-not-honoured',
          `the resume names ${cwd}, but this host provisions workspaces and honours only its own repository root (${provider.repositoryRoot ?? 'none configured'}) — the transcript would not be found anywhere else, so the session is not started`,
        ),
      );
    }
    let claimed = false;
    if (provider !== undefined && !operatorsCheckout) {
      // Before the await, so the reap's in-use guard already covers a session whose open is still
      // in flight. `#open`'s finally clears it again when the open produced no session.
      this.#workspaceKeyFor.set(sessionKey, workspaceKey);
      // The turn, not a bare await: a provision arriving while this key's reap (or a closing
      // session's release) is still running waits for it to settle instead of racing the removal.
      const provisioned = await this.#workspaceTurns.run(workspaceKey, () =>
        provider.provision(workspaceKey),
      );
      if (!provisioned.ok) return this.#refuseOpen(sessionKey, null, provisioned.refusal);
      cwd = provisioned.value.path;
      claimed = true;
    } else if (cwd === null) {
      // A null cwd is "the provider decides", and this host has no provider, so there is no
      // decider and nowhere honest to fall back to. Not `process.cwd()`: sharing the host's own
      // directory is the weakest isolation `bin/workspaces.ts` knows, and it is a posture an embedder
      // chooses, never one a frame's absence smuggles in. Refused before anything is claimed, with
      // the same name a path-taking tool uses for a pathless input.
      return this.#refuseOpen(
        sessionKey,
        null,
        refusal(
          'path-input-missing',
          'session_new carries cwd: null and this host has no workspace provider — there is no decider to defer to, so the session has nowhere to run',
        ),
      );
    }

    // A workspace this host asked for and then could not use is handed back, on every failure path
    // below. The provider's default is to leave the directory alone, so this is a release of the
    // claim rather than a deletion, but a host that never releases makes `provision` and `release`
    // unbalanced, and a provider counting sessions would leak one per refused start.
    const giveBack = async (refused: Refusal): Promise<void> => {
      this.#refuseOpen(sessionKey, cwd, refused);
      if (!claimed || provider === undefined) return;
      // The claim was taken at the workspace key, so it is handed back at the workspace key;
      // releasing the session key here would release nothing the moment keys alias.
      const released = await provider.release(workspaceKey);
      if (!released.ok) this.#refuse(sessionKey, released.refusal);
    };

    const tools = this.#toolServer(sessionKey);
    if (!tools.ok) return giveBack(tools.refusal);

    // The one throw source in this function, named. `readWhere` walks up from `cwd` looking for
    // a `.git`, so it touches the filesystem with a path the controller chose: a malformed `cwd`
    // (an illegal segment, a path the OS refuses to stat) throws out of here rather than
    // returning. The catch in `#open` would turn that into a refusal anyway; this exists so the
    // refusal says where, instead of naming the whole open.
    //
    // Its two neighbours are not throw sources and are not guarded: `localGate({…})` builds a
    // closure and touches nothing at construction, and `nodePathResolver` is only stored here; its
    // one throw fires later, inside the gate's decide path, which is a different surface with a
    // different answer.
    let where: TransitionWhere;
    try {
      where = readWhere(cwd);
    } catch (error) {
      return giveBack(
        refusal(
          'session-spawn-failed',
          `reading git facts for ${cwd} threw, so this session has no honest 'where': ${describe(error)}`,
        ),
      );
    }

    const servers = mergeMcpServers(requested.value.mcpServers, tools.value);
    if (!servers.ok) return giveBack(servers.refusal);

    const composed = composeSession({
      registry: this.#registry,
      sessionKey,
      cwd,
      sink: this.#link,
      decide: this.#options.decide,
      // Jailed to its own workspace by default, and the default is the whole point: a host whose
      // local gate is opt-in is a host most embedders run without one.
      localGate: localGate({
        workspaceRoot: cwd,
        resolve: nodePathResolver,
        protectedPaths: this.#options.protectedPaths,
        ...(this.#options.toolFamilies === undefined ? {} : { toolFamilies: this.#options.toolFamilies }),
      }),
      where,
      // The controller's own handle when it sent one, the routing key otherwise. The key stays the
      // fallback rather than null: a transition with no correlation at all is strictly less useful
      // than one correlated to the handle the controller is already using. The two are still
      // different contracts (one is interpreted by construction, the other never) and nothing here
      // derives one from the other in the direction that would matter.
      correlationId: opening.correlationId ?? sessionKey,
      // This host grants what its gate approves, and that is a posture rather than an inherited
      // default. It loads no settings files, so nothing sits behind the gate that a grant could
      // override, and without it the gate would be a veto: able to refuse a call, unable to let one
      // through. An embedder who wants the silent-allow posture sets `grantOnAllow: false` and gets
      // a host whose agent cannot run a tool, which is a legitimate thing to want and a surprising
      // thing to get by accident. Recorded in SECURITY.md, not only here.
      // Three layers, and the order is a decision. The host's posture is the floor, the embedder's
      // configuration overrides it, and the controller's per-session timings win last, because a
      // timing is a statement about how long that controller is willing to wait, and it is the only
      // party that knows. `grantOnAllow` is deliberately not reachable from the wire and so cannot be
      // overridden by the last spread; see `SessionNewGate`.
      gate: { grantOnAllow: true, ...(this.#options.gate ?? {}), ...readGateTimings(opening.gate) },
      request: { ...requested.value, ...(servers.value === null ? {} : { mcpServers: servers.value }) },
      ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
      ...(this.#options.ticker === undefined ? {} : { ticker: this.#options.ticker }),
      onRefusal: (refused) => this.#refuse(sessionKey, refused),
      onHookFailure: (failure) =>
        this.#refuse(
          sessionKey,
          refusal('transition-cause-unnamed', `a ${failure.event} handler threw: ${describe(failure.error)}`),
        ),
    });
    if (!composed.ok) return giveBack(composed.refusal);

    this.#sessions.set(sessionKey, composed.value);
    composed.value.machine.onTransition((transition) =>
      this.#report({ kind: 'transition', sessionKey, transition }),
    );
    composed.value.session.onEnd(() => this.#close(sessionKey));
    // `onDegrade` replays what was raised before this line ran, which is what makes the
    // create-time degrades (an untrusted workspace is reported during `create()`) reachable at
    // all; the collision degrade arrives live later, when the agent reports an id already held.
    composed.value.session.onDegrade((degrade) => this.#report({ kind: 'degrade', sessionKey, degrade }));
    this.#report({ kind: 'session-opened', sessionKey, cwd });
    // After the open is reported, so the trace reads in causal order: held, opened, delivered. The
    // gap between the first and the last is the provisioning window, stated rather than inferred.
    this.#drain(sessionKey, composed.value);
  }

  /**
   * Everything a finished session holds, released in the order that keeps its last frames.
   *
   * `forgetSession` deliberately does not discard unacked frames: a session's final transitions are
   * its most important and are exactly the ones still in flight if the link is down when it ends.
   */
  #close(sessionKey: string): void {
    const composed = this.#sessions.get(sessionKey);
    if (composed === undefined) return;
    this.#sessions.delete(sessionKey);
    composed.detach();
    this.#link.forgetSession(sessionKey);
    // Released at the key the workspace was provisioned at: for an aliased session the two
    // differ, and releasing the session key would leak the claim. Deleted from the map first so
    // the in-use guard stops counting this session the moment it is gone.
    const workspaceKey = this.#workspaceKeyFor.get(sessionKey) ?? sessionKey;
    this.#workspaceKeyFor.delete(sessionKey);
    const provider = this.#workspaces;
    // The release rides the key's turn: the map entry above is gone synchronously, so a reap
    // arriving now already sees the key as free; serializing the release behind the same turn is
    // what keeps that reap from removing the tree while this release still runs.
    if (provider !== undefined) {
      void this.#workspaceTurns
        .run(workspaceKey, () => provider.release(workspaceKey))
        .then(
          (released) => {
            if (!released.ok) this.#refuse(sessionKey, released.refusal);
          },
          // A provider that throws instead of returning a refusal must land in the same place: the
          // named-refusal contract for a quiet release leak exists precisely because the failure is
          // invisible until a disk fills, and an unhandled rejection here was the one path around it.
          (error: unknown) => this.#refuse(sessionKey, refusal('workspace-release-failed', describe(error))),
        );
    }
    this.#report({ kind: 'session-closed', sessionKey });
  }

  /**
   * The in-process MCP server for a session, or null when this host offers no tools.
   *
   * The descriptors are the embedder's, not the controller's, and that is forced rather than
   * chosen: no payload kind registers an in-process tool, so there is no way for a controller to
   * declare one over the link. (A controller can name an HTTP or stdio MCP server through
   * `session_new.request.mcpServers`; see `wire-request.ts`.)
   */
  #toolServer(sessionKey: string): Result<Readonly<Record<string, McpServerConfig>> | null> {
    const tools = this.#options.tools;
    if (tools === undefined) return ok(null);

    const built = createToolServer({
      ...tools,
      // Read at call time, never captured: the agent has no id until its first turn is queued.
      identity: () => ({ sessionId: this.#sessions.get(sessionKey)?.machine.sessionId ?? null }),
    });
    if (!built.ok) {
      return refuse<Readonly<Record<string, McpServerConfig>> | null>(
        built.refusal.reason,
        built.refusal.detail,
      );
    }
    return ok({ [tools.name]: built.value });
  }

  /**
   * Answer `session_list` from what this host holds: every handle it routes, plus the registry's
   * two counts. Synchronous: no filesystem, no process, nothing to await.
   */
  #answerSessionList(channelKey: string, asked: SessionList): void {
    const sessions = [...this.#sessions.entries()].map(([sessionKey, composed]) => ({
      sessionKey,
      sessionId: composed.session.id,
      state: composed.session.state,
      cwd: composed.machine.where.cwd,
      startedAt: composed.session.facts?.startedAt ?? null,
    }));
    this.#send(
      channelKey,
      sessionListResult(asked.requestId, sessions, {
        liveCount: this.#registry.liveCount,
        provisioningCount: this.#registry.provisioningCount,
      }),
    );
  }

  /**
   * Answer `transcript_list` from the discovery door, one page per request.
   *
   * Every exit sends a wire answer. A missing root, a failed walk and a thrown error all become a
   * `transcript_failed` naming the reason; an answer that dies inside the host would read to the
   * asker as a host that hung, which is the exact failure the closed dispatch set exists to end.
   * (`#send` reports a send the link refused locally; the attempt is what every exit guarantees.)
   */
  async #answerTranscriptList(channelKey: string, asked: TranscriptList): Promise<void> {
    const root = this.#transcriptsRoot;
    if (root === undefined) {
      return this.#failDiscovery(
        channelKey,
        asked.requestId,
        refusal(
          'path-input-missing',
          'this host has no transcripts root configured — the discovery door cannot look',
        ),
      );
    }
    try {
      const page = await listTranscripts(root, { fromIndex: asked.fromIndex });
      this.#send(
        channelKey,
        transcriptListResult(asked.requestId, page.entries, {
          totalCount: page.totalCount,
          ...(page.nextIndex === null ? {} : { nextIndex: page.nextIndex }),
        }),
      );
    } catch (error) {
      this.#failDiscovery(channelKey, asked.requestId, refusal('transcript-read-failed', describe(error)));
    }
  }

  /** Answer `transcript_tail`. Same exit discipline as the listing: every path answers. */
  async #answerTranscriptTail(channelKey: string, asked: TranscriptTail): Promise<void> {
    const root = this.#transcriptsRoot;
    if (root === undefined) {
      return this.#failDiscovery(
        channelKey,
        asked.requestId,
        refusal(
          'path-input-missing',
          'this host has no transcripts root configured — the discovery door cannot look',
        ),
      );
    }
    try {
      const answer = await tailTranscript(root, asked.projectSlug, asked.sessionId, {
        fromOffset: asked.fromOffset,
        needle: asked.needle,
      });
      if (!answer.ok) return this.#failDiscovery(channelKey, asked.requestId, answer.refusal);
      this.#send(
        channelKey,
        transcriptTailResult(asked.requestId, {
          found: answer.value.found,
          absent: answer.value.absent,
          newOffset: answer.value.newOffset,
          ...(answer.value.sizeBytes === null ? {} : { sizeBytes: answer.value.sizeBytes }),
          ...(answer.value.mtimeMs === null ? {} : { mtimeMs: answer.value.mtimeMs }),
        }),
      );
    } catch (error) {
      this.#failDiscovery(channelKey, asked.requestId, refusal('transcript-read-failed', describe(error)));
    }
  }

  /**
   * Answer `repository_list`: one directory of the repository this host provisions from,
   * names only, jailed to the repository root by `listRepositoryDirectory`. Every exit is the one
   * result kind; a host with no repository root has nothing to read under and says so by name.
   */
  async #answerRepositoryList(channelKey: string, asked: RepositoryList): Promise<void> {
    const refused = (why: Refusal): void =>
      this.#refuseRepository(
        channelKey,
        repositoryListResult(asked.requestId, [], false, wireRefusalOf(why)),
        why,
      );
    const root = this.#workspaces?.repositoryRoot;
    if (root === undefined) return refused(noRepositoryRoot());
    try {
      const listed = await listRepositoryDirectory(root, asked.path, undefined, this.#options.protectedPaths);
      if (!listed.ok) return refused(listed.refusal);
      this.#send(
        channelKey,
        repositoryListResult(asked.requestId, listed.value.entries, listed.value.truncated),
      );
    } catch (error) {
      refused(refusal('repository-read-failed', describe(error)));
    }
  }

  /** Answer `repository_read`: the head of one text file under the repository root. */
  async #answerRepositoryRead(channelKey: string, asked: RepositoryRead): Promise<void> {
    const nothing = { text: null, sizeBytes: 0, truncated: false };
    const refused = (why: Refusal): void =>
      this.#refuseRepository(
        channelKey,
        repositoryReadResult(asked.requestId, nothing, wireRefusalOf(why)),
        why,
      );
    const root = this.#workspaces?.repositoryRoot;
    if (root === undefined) return refused(noRepositoryRoot());
    try {
      const read = await readRepositoryFile(root, asked.path, asked.maxBytes, this.#options.protectedPaths);
      if (!read.ok) return refused(read.refusal);
      this.#send(channelKey, repositoryReadResult(asked.requestId, read.value));
    } catch (error) {
      refused(refusal('repository-read-failed', describe(error)));
    }
  }

  /** A refused repository ask goes on the wire as its result kind, and is reported locally too. */
  #refuseRepository(
    channelKey: string,
    answer: RepositoryListResult | RepositoryReadResult,
    why: Refusal,
  ): void {
    this.#send(channelKey, answer);
    this.#refuse(channelKey, why);
  }

  /** A discovery request that could not be answered says so on the wire; the `#failDelivery` twin. */
  #failDiscovery(channelKey: string, requestId: string, refused: Refusal): void {
    this.#send(channelKey, transcriptFailed(requestId, { reason: refused.reason, detail: refused.detail }));
    this.#refuse(channelKey, refused);
  }

  /**
   * Answer `workspace_release` (protocol v5): remove a workspace's directory, on demand, by name.
   *
   * Every exit is the one result kind: `refusal: null` is the released answer, a named refusal
   * is every other, so "every exit sends a wire answer" is a property of the shape here rather than
   * a discipline across two builders. The answer is one small frame, nowhere near the frame cap,
   * unconditionally, since the key screen is length-bounded and the detail echoes `keyPreview`,
   * never the raw key.
   *
   * The in-use guard is many-to-one, because keys alias: N sessions can share one workspace key,
   * each with its own entry in `#workspaceKeyFor`, so the guard scans values and holds until the
   * last session on the key is gone. A guard that cleared on the first close would delete a tree
   * the other sessions are still working in, the exact conditions the shared-worktree topology
   * exists to create. Opening sessions count too: their entry is written before the provision
   * await.
   *
   * `ReleaseOptions.remove` stays default-false everywhere else. This is the one production path
   * that passes it, and it passes it because a caller asked; a session ending still leaves its
   * directory for whoever wants to look at it.
   */
  async #answerWorkspaceRelease(channelKey: string, asked: WorkspaceRelease): Promise<void> {
    const outcome = await this.#releaseOne(asked, false);
    this.#send(channelKey, workspaceReleaseResult(asked.requestId, outcome.result));
    if (outcome.refused !== null) this.#refuse(channelKey, outcome.refused);
  }

  /**
   * Every entry is judged and released on its own — different keys interleave, the same key
   * serialises under its turn — and a refusal on one never aborts the rest. Duplicates are judged
   * on the name as asked: the second entry naming a key or a path already in this ask does nothing
   * and says so.
   */
  async #answerWorkspaceReleaseBulk(channelKey: string, asked: WorkspaceReleaseBulk): Promise<void> {
    const named = new Set<string>();
    const outcomes = await Promise.all(
      asked.releases.map((entry) => {
        const name = entry.workspaceKey ?? entry.path;
        const duplicate = name !== null && named.has(name);
        if (name !== null) named.add(name);
        return this.#releaseOne(entry, duplicate);
      }),
    );
    this.#send(
      channelKey,
      workspaceReleaseBulkResult(
        asked.requestId,
        outcomes.map((outcome) => outcome.result),
      ),
    );
    for (const outcome of outcomes) {
      if (outcome.refused !== null) this.#refuse(channelKey, outcome.refused);
    }
  }

  /**
   * One release: resolve the address to a key, screen it, then under the key's turn run the in-use
   * guard and the provider's release with the ask's flags. Every exit is a result; `refused` is the
   * same refusal for the log.
   */
  async #releaseOne(
    ask: WorkspaceReleaseEntry,
    duplicate: boolean,
  ): Promise<{ result: WorkspaceReleaseEntryResult; refused: Refusal | null }> {
    const provider = this.#workspaces;
    const refused = (
      reason: RefusalReason,
      detail: string,
      partial: Partial<WorkspaceReleaseEntryResult> = {},
    ): { result: WorkspaceReleaseEntryResult; refused: Refusal } => {
      const problem = refusal(reason, detail);
      return {
        result: workspaceReleaseEntryResult({
          ...partial,
          refusal: { reason: problem.reason, detail: problem.detail },
        }),
        refused: problem,
      };
    };

    if (provider === undefined) {
      return refused(
        'workspace-release-failed',
        'this host has no workspace provider — there is no workspace to release',
      );
    }
    if (ask.workspaceKey !== null && ask.path !== null) {
      return refused(
        'workspace-release-failed',
        'workspace_release names both a workspaceKey and a path — name exactly one',
      );
    }
    let workspaceKey: string;
    if (ask.path !== null) {
      if (provider.keyForPath === undefined) {
        return refused(
          'workspace-release-failed',
          "this host's workspace provider cannot address a worktree by path — name its workspaceKey",
          { path: ask.path },
        );
      }
      const resolved = provider.keyForPath(ask.path);
      if (resolved === null) {
        return refused(
          'workspace-release-failed',
          `workspace_release.path ${keyPreview(ask.path)} is not a directory directly under this host's workspace root`,
          { path: ask.path },
        );
      }
      workspaceKey = resolved;
    } else if (ask.workspaceKey !== null) {
      workspaceKey = ask.workspaceKey;
    } else {
      return refused(
        'workspace-release-failed',
        'workspace_release names neither a workspaceKey nor a path — name exactly one',
      );
    }
    const address: Partial<WorkspaceReleaseEntryResult> = { workspaceKey, path: ask.path };
    const problem = unusableKeyProblem(workspaceKey);
    if (problem !== null) {
      return refused(
        'workspace-release-failed',
        `workspace_release.workspaceKey ${keyPreview(workspaceKey)} ${problem}`,
        address,
      );
    }
    if (duplicate) {
      return refused(
        'workspace-release-failed',
        `workspace ${workspaceKey} is named twice in one ask — this entry does nothing`,
        address,
      );
    }
    // The scan and the removal ride one turn. The in-use guard is check-then-act across a
    // multi-second `git worktree remove`; scanned outside the turn, a `session_new` on this key
    // could pass its own guard mid-removal and provision into a dying directory while this answer
    // reads released. Inside the turn the scan runs after any queued provision or close-release
    // settles, so it reads the map the other verbs have finished writing.
    return this.#workspaceTurns.run(workspaceKey, async () => {
      const inUse = [...this.#workspaceKeyFor.values()].includes(workspaceKey);
      if (inUse) {
        return refused(
          'workspace-release-failed',
          `workspace ${workspaceKey} still backs a live or opening session on this host — close every session on it before asking for its removal`,
          address,
        );
      }
      try {
        const released = await provider.release(workspaceKey, {
          remove: true,
          deleteBranch: ask.deleteBranch,
          force: ask.force,
        });
        if (!released.ok) return refused(released.refusal.reason, released.refusal.detail, address);
        const receipt = released.value;
        // A provider that answers no receipt vouches for nothing beyond "released or absent".
        if (receipt === undefined) return { result: workspaceReleaseEntryResult(address), refused: null };
        const partial = {
          workspaceKey,
          path: receipt.path,
          directoryRemoved: receipt.directoryRemoved,
          branchDeleted: receipt.branchDeleted,
        };
        if (receipt.refusal !== null) return refused(receipt.refusal.reason, receipt.refusal.detail, partial);
        return { result: workspaceReleaseEntryResult(partial), refused: null };
      } catch (error) {
        // A provider that throws instead of refusing lands in the same named place, the contract
        // the ordinary release path already holds.
        return refused('workspace-release-failed', describe(error), address);
      }
    });
  }

  /**
   * List the worktrees under the workspace root, read from disk now. Paged like the transcript
   * listing; every exit is one `workspace_list_result`, refusal or page, so a host that cannot look
   * says so by name rather than going quiet.
   */
  async #answerWorkspaceList(channelKey: string, asked: WorkspaceList): Promise<void> {
    const answer = (
      page: {
        entries: readonly WorkspaceEntry[];
        totalCount: number;
        nextIndex?: number;
        defaultBranch: string | null;
      },
      refused?: Refusal,
    ): void => {
      this.#send(
        channelKey,
        workspaceListResult(
          asked.requestId,
          page.entries,
          page,
          refused === undefined ? undefined : { reason: refused.reason, detail: refused.detail },
        ),
      );
      if (refused !== undefined) this.#refuse(channelKey, refused);
    };
    const empty = { entries: [], totalCount: 0, defaultBranch: null };

    const provider = this.#workspaces;
    if (provider === undefined) {
      return answer(
        empty,
        refusal('workspace-list-failed', 'this host has no workspace provider — there is nothing to list'),
      );
    }
    if (provider.inventory === undefined) {
      return answer(
        empty,
        refusal('workspace-list-failed', "this host's workspace provider keeps no inventory"),
      );
    }
    let inventory: Result<WorkspaceInventory>;
    try {
      inventory = await provider.inventory();
    } catch (error) {
      return answer(empty, refusal('workspace-list-failed', describe(error)));
    }
    if (!inventory.ok) return answer(empty, inventory.refusal);

    const all = inventory.value.entries;
    const from = Math.max(0, asked.fromIndex);
    const end = Math.min(all.length, from + WORKSPACE_PAGE_SIZE);
    return answer({
      entries: all.slice(from, end),
      totalCount: all.length,
      ...(end < all.length ? { nextIndex: end } : {}),
      defaultBranch: inventory.value.defaultBranch,
    });
  }

  /**
   * Apply a configuration change. Every exit is one `host_configure_result` carrying the
   * effective configuration, so a controller always learns what this host runs with, refused or
   * not. The seam validates and writes; this method only decides whether the host is busy and swaps
   * the rebuilt pieces in, then tells the link what its next hello declares.
   */
  #answerHostConfigure(channelKey: string, asked: HostConfigure): void {
    const answer = (refused?: Refusal): void => {
      this.#send(
        channelKey,
        hostConfigureResult(
          asked.requestId,
          this.#configuration,
          this.#overriddenByEnvironment,
          refused === undefined ? undefined : { reason: refused.reason, detail: refused.detail },
          this.#pendingRestart,
        ),
      );
      if (refused !== undefined) this.#refuse(channelKey, refused);
    };

    const reconfigure = this.#options.reconfigure;
    if (reconfigure === undefined) {
      return answer(
        refusal(
          'config-write-failed',
          'this host was composed without a configuration seam, so nothing can be written',
        ),
      );
    }
    // Busy means a workspace is claimed or being claimed: a session releases through the provider
    // that provisioned it, so the roots cannot move under one. The seam refuses only when the ask
    // actually changes a root; a scheme or transcripts-root change applies live regardless.
    const hostBusy = this.#sessions.size > 0 || this.#opening.size > 0;
    let outcome: Result<HostReconfigured>;
    try {
      outcome = reconfigure(asked.entries, hostBusy);
    } catch (error) {
      return answer(refusal('config-write-failed', describe(error)));
    }
    if (!outcome.ok) return answer(outcome.refusal);

    const rebuilt = outcome.value;
    this.#workspaces = rebuilt.workspaces;
    this.#transcriptsRoot = rebuilt.transcriptsRoot;
    this.#bulk = rebuilt.bulk;
    this.#linkCapabilities = rebuilt.linkCapabilities;
    this.#configuration = rebuilt.configuration;
    this.#overriddenByEnvironment = rebuilt.overriddenByEnvironment;
    // The control-plane addresses are never applied to the live link: the host keeps dialling what it
    // dialled, names the keys as pending, and the next start reads the file.
    this.#pendingRestart = rebuilt.pendingRestart;
    this.#link.announce?.(this.#linkCapabilities, this.#configuration, this.#pendingRestart);
    return answer();
  }

  async #deliver(
    sessionKey: string,
    deliveryId: string,
    what: string,
    postUrl: string,
    fromOffset: number,
  ): Promise<void> {
    const resolve = this.#bulk;
    if (resolve === undefined) {
      return this.#failDelivery(
        sessionKey,
        deliveryId,
        refusal('bulk-target-invalid', 'this host resolves no bulk content — nothing can be delivered'),
      );
    }

    const filePath = resolve(what, sessionKey);
    if (!filePath.ok) return this.#failDelivery(sessionKey, deliveryId, filePath.refusal);

    // The one origin this host will POST to, derived from the link it already dials. Resolved per
    // delivery rather than cached so a reconfigured controller URL cannot leave a stale trusted
    // origin behind it.
    const allowedOrigin = bulkOriginFor(this.#options.controllerUrl);
    if (!allowedOrigin.ok) return this.#failDelivery(sessionKey, deliveryId, allowedOrigin.refusal);

    // The same credential the link and the decision POST present, resolved per delivery. A
    // credential that refuses posts headerless rather than not at all: this lane is a read-back the
    // controller itself asked for, and the receiver's refusal comes back loud on the wire as
    // `bulk-delivery-failed` naming the status, which beats a silent no-request.
    let headers: Readonly<Record<string, string>> | undefined;
    const credential = this.#options.credential;
    if (credential !== undefined) {
      const authorized = await credential.authorize();
      if (authorized.ok) headers = { [authorized.value.header]: authorized.value.value };
    }

    let receipt: Result<BulkPostReceipt>;
    try {
      receipt = await postBulk({
        deliveryId,
        postUrl,
        allowedOrigin: allowedOrigin.value,
        filePath: filePath.value,
        fromOffset,
        ...(headers === undefined ? {} : { headers }),
      });
    } catch (error) {
      receipt = refuse<BulkPostReceipt>('bulk-delivery-failed', describe(error));
    }
    if (!receipt.ok) return this.#failDelivery(sessionKey, deliveryId, receipt.refusal);

    this.#send(sessionKey, {
      kind: 'bulk_delivered',
      deliveryId,
      byteCount: receipt.value.byteCount,
      // The stat pair rides the receipt so a transcript puller can detect a rewrite. See
      // `BulkDelivered` in frames.ts.
      sizeBytes: receipt.value.sizeBytes,
      mtimeMs: receipt.value.mtimeMs,
    });
  }

  /** A delivery that did not happen says so on the wire; it is a receipt, not a silence. */
  #failDelivery(sessionKey: string, deliveryId: string, refused: Refusal): void {
    this.#send(sessionKey, {
      kind: 'bulk_failed',
      deliveryId,
      refusal: { reason: refused.reason, detail: refused.detail },
    });
    this.#refuse(sessionKey, refused);
  }

  /**
   * Send one payload. A refusal other than queue overflow is reported locally, since there is no
   * wire to tell; an overflow refusal of an undroppable frame holds the frame for a retry instead.
   */
  #send(sessionKey: string, payload: SessionPayload): void {
    const pending = this.#heldFrames.get(sessionKey);
    if (pending !== undefined && pending.length > 0) {
      if (isDroppable(payload.kind)) {
        this.#refuse(
          sessionKey,
          refusal(
            'queue-dropped-droppable',
            `frames are held for this session; discarded an incoming ${payload.kind}`,
          ),
        );
        return;
      }
      this.#holdFrame(sessionKey, payload);
      return;
    }
    const sent = this.#link.send(sessionKey, payload);
    if (sent.ok) return;
    if (sent.refusal.reason === 'queue-overflow-undroppable' && !isDroppable(payload.kind)) {
      this.#holdFrame(sessionKey, payload);
      return;
    }
    // An answer the link refused as too large is answered by name (v10): the controller matches
    // `answer_refused` on the request id instead of waiting for a timeout that names nothing. The
    // substitute is small by construction, so it cannot meet the same refusal.
    if (
      sent.refusal.reason === 'frame-too-large' &&
      payload.kind !== 'answer_refused' &&
      'requestId' in payload &&
      typeof payload.requestId === 'string'
    ) {
      const refused = this.#link.send(sessionKey, answerRefused(payload.requestId, sent.refusal));
      if (!refused.ok) this.#refuse(sessionKey, refused.refusal);
    }
    this.#refuse(sessionKey, sent.refusal);
  }

  #holdFrame(sessionKey: string, payload: SessionPayload): void {
    const pending = this.#heldFrames.get(sessionKey) ?? [];
    if (pending.length >= HELD_FRAMES_MAX) {
      this.#refuse(
        sessionKey,
        refusal(
          'queue-overflow-undroppable',
          `${HELD_FRAMES_MAX} frames are already held for this session; ${payload.kind} could not be held`,
        ),
      );
      return;
    }
    pending.push(payload);
    this.#heldFrames.set(sessionKey, pending);
    this.#scheduleHeldFrames();
  }

  #scheduleHeldFrames(): void {
    if (this.#heldFramesTimer !== null) return;
    // Ref'd on purpose: a held turn-end is work this process has promised to deliver.
    this.#heldFramesTimer = setTimeout(() => {
      this.#heldFramesTimer = null;
      this.#retryHeldFrames();
    }, HELD_RETRY_MS);
  }

  #retryHeldFrames(): void {
    let remaining = false;
    for (const [sessionKey, pending] of this.#heldFrames) {
      while (pending.length > 0) {
        const head = pending[0];
        if (head === undefined) break;
        const sent = this.#link.send(sessionKey, head);
        if (sent.ok) {
          pending.shift();
          continue;
        }
        if (sent.refusal.reason !== 'queue-overflow-undroppable') {
          this.#refuse(sessionKey, sent.refusal);
          pending.shift();
          continue;
        }
        break;
      }
      if (pending.length === 0) this.#heldFrames.delete(sessionKey);
      else remaining = true;
    }
    if (remaining) this.#scheduleHeldFrames();
  }

  #refuse(sessionKey: string, refused: Refusal): void {
    this.#report({ kind: 'refusal', refusal: refused, sessionKey });
  }

  /**
   * A refused open goes on the wire. Reported locally only, the controller would keep a session
   * record nobody could talk to and the operator would watch a session that "did nothing" while
   * the refusal sat in this host's log. The session never had a machine, so this is the one
   * transition composed by hand: spawning to ended, cause `refusal` with the reason as its event
   * and the whole detail; the controller stores it, ends its record, and can show why. Local
   * report first, then the wire.
   */
  #refuseOpen(sessionKey: string, cwd: string | null, refused: Refusal): void {
    this.#refuse(sessionKey, refused);
    let where: TransitionWhere;
    try {
      where =
        cwd === null
          ? { cwd: '', worktree: null, branch: null, unknownReason: 'the session never had a workspace' }
          : readWhere(cwd);
    } catch {
      where = { cwd: cwd ?? '', worktree: null, branch: null, unknownReason: 'git facts could not be read' };
    }
    const transition: SessionTransition = {
      sessionId: null,
      // The controller's own handle is the only correlation this session ever had.
      correlationId: sessionKey,
      seq: 1,
      at: new Date(this.#options.clock?.() ?? Date.now()).toISOString(),
      from: 'spawning',
      to: 'ended',
      activity: null,
      entryId: null,
      cause: { kind: 'refusal', event: refused.reason, detail: refused.detail },
      where,
    };
    const sent = this.#link.send(sessionKey, stateTransitionUpdate(transition));
    if (!sent.ok) this.#report({ kind: 'refusal', refusal: sent.refusal, sessionKey });
  }

  #report(event: HostEvent): void {
    try {
      this.#options.report?.(event);
    } catch {
      // The reporter is the failure channel; reporting a reporter would recurse.
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The repository asks on a host composed without a repository root: nothing to read under. */
function noRepositoryRoot(): Refusal {
  return refusal(
    'repository-path-escape',
    'this host has no repository root configured, so there is nothing to read under',
  );
}

/** A local refusal as the wire carries it. */
function wireRefusalOf(why: Refusal): WireRefusal {
  return { reason: why.reason, detail: why.detail };
}
