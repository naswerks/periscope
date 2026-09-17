/**
 * The agent SDK seam: the only module in this package that starts an agent process, and the one
 * that re-exports the SDK's types for every layer above.
 *
 * It is not the only file that names `@anthropic-ai/claude-agent-sdk`. Three others in
 * `src/host/` do (the MCP server builder, the store adapter and the telemetry reader), because
 * each bridges one SDK shape and none of them spawns anything. The rule the pin enforces is the
 * directory, not this file; what remains unique here is `query()`.
 *
 * It lives in `src/host/` because calling `query()` spawns a real CLI subprocess. The boundary this
 * directory holds is stated as "nothing outside `src/host/` touches the filesystem, spawns a
 * process, or reads the machine", and a package import that spawns is exactly as privileged as
 * `node:child_process` even though no lint rule would have noticed. Pinned by
 * src/pins/sdk-confinement.test.ts.
 *
 * Everything above this file works in the package's own vocabulary and never imports the SDK, so
 * "what starts a process, and with what?" has one answer. The SDK types the layer above genuinely
 * needs are re-exported here rather than imported there; a type-only import would still name the
 * specifier, and one place naming it is the whole point.
 *
 * `windowsHide` is not a knob this package has, and it does not need to be. Node's default is
 * `false` (the widespread "true since Node 15" belief is wrong), and where no ancestor process owns
 * a console there is none to inherit, so every un-hidden spawn allocates a real visible window. It
 * is absent from the SDK's `Options`, but the SDK's own `spawnLocalProcess` passes
 * `windowsHide: true`, so the default path is correct. The trap is `spawnClaudeCodeProcess`: a
 * custom spawn function replaces that path entirely, and one written without `windowsHide`
 * reintroduces a flashing window on every spawn.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  EffortLevel,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  Options,
  PermissionMode,
  Query,
  SDKMessage,
  SDKUserMessage,
  SdkPluginConfig,
  SessionStore,
  SessionStoreFlush,
  SettingSource,
  SpawnOptions,
  SpawnedProcess,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';

import { AsyncQueue } from '../core/async-queue.js';

export type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  SDKMessage,
  SDKUserMessage,
  SdkPluginConfig,
  SessionStore,
  SessionStoreFlush,
  SettingSource,
  SpawnOptions,
  SpawnedProcess,
  ThinkingConfig,
  EffortLevel,
  PermissionMode,
};

/** Exactly the shape `Options.hooks` takes, so a composer above cannot drift from it. */
export type HookRegistrations = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/**
 * The message union's discriminator, as one string per shape — `type`, or `type/subtype` for the
 * `system` family.
 *
 * Derived from the union rather than listed, so a message type the SDK adds shows up as a missing
 * key wherever this is used exhaustively instead of being silently absent.
 */
type SystemSubtype = Extract<SDKMessage, { type: 'system' }>['subtype'];
export type MessageDiscriminator = Exclude<SDKMessage['type'], 'system'> | `system/${SystemSubtype}`;

/** The discriminator of one message, in the same form `MessageDiscriminator` names. */
export function discriminatorOf(message: SDKMessage): MessageDiscriminator {
  return message.type === 'system' ? (`system/${message.subtype}` as MessageDiscriminator) : message.type;
}

/** How the agent's process is created. Replaces the SDK's own local spawn when supplied. */
export type SpawnAgentProcess = (options: SpawnOptions) => SpawnedProcess;

/**
 * What the layer above asks for. Deliberately NOT the SDK's `Options`: composing it is pure work
 * that belongs outside this directory, and keeping the SDK's shape on this side of the seam is what
 * lets the composition be unit-tested with no process anywhere near it.
 */
export interface AgentProcessRequest {
  /** Absolute, always. The agent's working directory. */
  readonly cwd: string;
  /** The complete environment. Never merged with `process.env` — see sessions/spawn-env.ts. */
  readonly env: Record<string, string>;
  /**
   * Which on-disk settings tiers the agent may load. `[]` means none.
   *
   * The SDK loads ALL of them when this is omitted, so it is passed explicitly on every start: a
   * default that reads whatever files happen to be beside the working directory is not a default a
   * host can reason about.
   */
  readonly settingSources: readonly SettingSource[];
  readonly plugins: readonly SdkPluginConfig[] | null;
  /**
   * The hook callbacks this session runs. Passed straight through, never composed here.
   *
   * Each event maps to an ARRAY of matchers and the SDK runs every entry, so observation and
   * decision are separate registrations on the same event rather than one handler doing both. See
   * `hooks.ts` for the composer that merges them.
   */
  readonly hooks: HookRegistrations | null;
  /** A session id to continue. Null starts a new one. */
  readonly resume: string | null;
  /** With `resume`, continue into a NEW session id instead of extending the old one. */
  readonly fork: boolean;
  /**
   * Emit `stream_event` messages while the agent composes a turn.
   *
   * Nothing partial reaches the message stream without this: with it off there is no
   * `SDKPartialAssistantMessage` at all, so text arrives only when a block completes and a turn
   * cannot be rendered as it happens. It is also the precondition for any thinking prose.
   */
  readonly includePartialMessages: boolean;
  /**
   * How much of the agent's reasoning is emitted. `null` leaves the SDK's own default.
   *
   * `{type:'adaptive'}` fires `thinking_delta` events whose prose is EMPTY;
   * `{type:'adaptive', display:'summarized'}` streams real reasoning text — which costs tokens on
   * the wire and puts reasoning into transcripts and mirrors, so it is asked for rather than
   * assumed. Requires `includePartialMessages`.
   */
  readonly thinking: ThinkingConfig | null;
  /**
   * Forward a subagent's full conversation, not only its tool calls.
   *
   * Off, the stream carries a subagent's `tool_use`/`tool_result` blocks and nothing else — enough
   * to count activity, not enough to read. On, its text and thinking arrive as ordinary messages
   * with `parent_tool_use_id` set, which is the only way a nested turn can be rendered live.
   */
  readonly forwardSubagentText: boolean;
  /**
   * The agent process's stderr, line by line.
   *
   * Wired on every start because some conditions are reported here and NOWHERE else — an untrusted
   * workspace voids its permission rules with a stderr line and no error.
   */
  readonly onStderr: ((data: string) => void) | null;
  /**
   * In-process MCP servers this session may call, by server name.
   *
   * This key enlarges the set of tools the gate must decide about. It is safe for a structural
   * reason, stated at `TOOL_SURFACE_OPTION_KEYS` below, and not for the reason the streaming keys
   * are safe.
   */
  readonly mcpServers: Readonly<Record<string, McpServerConfig>> | null;
  /**
   * Use ONLY the servers above, ignoring project `.mcp.json`, user settings, plugin MCP and on-disk
   * agent frontmatter. `null` leaves the SDK's own default.
   *
   * The composer above defaults this on (see sessions/registry.ts). It is the workspace-MCP
   * attack-surface switch: without it, a repository the host provisioned as a workspace can declare
   * its own MCP servers and the agent picks them up, which means a directory's CONTENTS decide what
   * tools exist. That is the one lane where a workspace becomes a tool-registration channel.
   */
  readonly strictMcpConfig: boolean | null;
  /**
   * Mirror this session's transcript to a store the embedder supplies. `null` mirrors nowhere.
   *
   * This object receives every message the agent saw. It is a confidentiality and egress surface,
   * and it must not be filed with the streaming keys, which only widen what this host itself
   * observes.
   *
   * What makes it safe is structural, and it is the same shape as the gate's no-matcher argument:
   * a store is a live object with methods, so it cannot be expressed in JSON and cannot cross the
   * link. It can only be supplied by the code that composes this host, which is the embedder. No
   * controller, and nothing arriving over the wire, can name a destination for a transcript. Pinned
   * by pins/persistence-egress.test.ts rather than left as a sentence.
   *
   * The one documented incompatibility is unreachable by construction. A store may not be
   * combined with session persistence turned off, because the mirror runs after the local write
   * succeeds. `persistSession` is not composable through this type, so the SDK's own default stands
   * and the combination cannot be built here.
   */
  readonly sessionStore: SessionStore | null;
  /**
   * How eagerly mirrored entries are flushed. `null` leaves the SDK's own default of batching.
   *
   * Eager gives near-real-time delivery at the cost of one call per frame with no coalescing, so it
   * is asked for rather than assumed. Ignored entirely when no store is set.
   */
  readonly sessionStoreFlush: SessionStoreFlush | null;
  /**
   * Create the process yourself, for a VM, a container or a remote machine.
   *
   * Two things a custom spawn loses, and both are silent.
   * 1. `windowsHide`. The SDK's own spawn passes it; Node's default is `false`, so a custom spawn
   *    written without it allocates a real visible window per session wherever no ancestor process
   *    owns a console. See this file's header.
   * 2. stderr. `SpawnedProcess` carries only stdin and stdout, so a custom spawn that does not
   *    route the child's stderr somewhere loses `onStderr` entirely, and the untrusted-workspace
   *    condition is reported only there.
   */
  readonly spawn: SpawnAgentProcess | null;
  /**
   * Which model runs this session. `null` leaves the CLI's own default.
   *
   * Absent, not narrowed: `model` and `systemPrompt` were never among this type's keys, so adding
   * them filled a gap; it did not widen a security narrowing. The eight `SHADOWING_LANES` below are
   * a deliberate narrowing and they stay closed. Two different facts, and conflating them costs a
   * reader a whole cycle on the wrong objection.
   *
   * What made the gap expensive: a host that cannot state a model cannot run the same agent twice on
   * purpose, and every caller silently got whatever the installed CLI defaulted to.
   */
  readonly model: string | null;
  /**
   * What the agent is told at the start. `null` leaves the CLI's own preset.
   *
   * The one composable key that cannot be proven from the agent's own report. `AgentInitFacts`
   * below is lifted entirely out of the SDK's `system/init` message, and that message carries no
   * system prompt, so unlike `model`, `tools` or `mcpServers`, nothing coming back from the agent
   * confirms this took effect. It ships unproven-by-report, and that is stated here rather than left
   * for someone to discover while trying to write the assertion.
   *
   * Typed off the SDK's own option so it cannot drift from what `query()` accepts.
   */
  readonly systemPrompt: AgentSystemPrompt | null;
  /** The effort level. `null` leaves the SDK's own default. */
  readonly effort: EffortLevel | null;
  /**
   * The permission mode. `null` leaves the SDK's default. Deliberately opened: see
   * `CLI_PARITY_OPTION_KEYS` for the reason stated as data, and `SHADOWING_LANES` for what stays
   * closed. The gate's authority is the `PreToolUse` hook; a mode never pre-answers it.
   */
  readonly permissionMode: PermissionMode | null;
}

/**
 * What the SDK accepts as a system prompt — a string, a list of strings, or a preset descriptor.
 *
 * Derived from `Options` rather than restated: this package's rule is that the types win, and a
 * hand-copied union is a second copy that can disagree with the first.
 */
export type AgentSystemPrompt = NonNullable<Options['systemPrompt']>;

/**
 * Every key `Options` is composed from, as data.
 *
 * This is the permission-config pin's subject, and it is why that pin is a compile error rather
 * than a grep. The SDK's `Options` carries nine lanes that alter permission outcomes:
 * `permissionMode`, `settings`, `managedSettings`, `toolAliases`, `permissionPromptToolName`,
 * `allowedTools`, `disallowedTools`, `canUseTool`, and the `permissions` block a settings object can
 * carry. Eight of them (`SHADOWING_LANES`) are unreachable, because a caller can only supply the
 * keys below and `startAgentProcess` composes `Options` from exactly these; `permissionMode` is the
 * one opened by name, in `CLI_PARITY_OPTION_KEYS`. Adding a composable option breaks this
 * declaration, and the pin fails at build time instead of when someone remembers to look.
 *
 * The composable set is declared as several lists, each with its own reason, because the moment two
 * different justifications share one constant, neither can be checked:
 *
 * - `STREAMING_OPTION_KEYS` select what the process emits, never what it may do. A widening for
 *   visibility is not a weakening for permission.
 * - `TOOL_SURFACE_OPTION_KEYS` change which tools exist. Read that list's note for why it is
 *   nonetheless safe.
 * - `PERSISTENCE_OPTION_KEYS` decide where the transcript goes: the egress lane. Its safety
 *   argument is structural and is pinned rather than stated.
 * - `AGENT_SELECTION_OPTION_KEYS` choose which agent runs and what it is told at the start.
 * - `CLI_PARITY_OPTION_KEYS` expose what the CLI itself exposes, including the one shadowing lane
 *   that is a posture rather than a rule file.
 *
 * The distinction that decides whether a widening is a weakening: `model` and `systemPrompt` were
 * absent, not narrowed. They were never among the composable keys, so opening them filled a gap.
 * The eight lanes in `SHADOWING_LANES` are a deliberate security narrowing and stay closed, and the
 * pin still asserts each one by name. A gap filled and a narrowing widened are different acts and
 * this file tells them apart.
 *
 * `toolAliases` is the one worth naming: it redirects tool names after the model emits them, so a
 * gate matching on `tool_name` would see the alias source while the target executed. A silent
 * mismatch, and unreachable here by construction.
 */
export const AGENT_PROCESS_REQUEST_KEYS = {
  cwd: true,
  env: true,
  settingSources: true,
  plugins: true,
  hooks: true,
  resume: true,
  fork: true,
  onStderr: true,
  spawn: true,
  includePartialMessages: true,
  thinking: true,
  forwardSubagentText: true,
  mcpServers: true,
  strictMcpConfig: true,
  sessionStore: true,
  sessionStoreFlush: true,
  model: true,
  systemPrompt: true,
  effort: true,
  permissionMode: true,
} as const satisfies Record<keyof AgentProcessRequest, true>;

/**
 * The eight closed lanes, as data: the subject both permission pins are about.
 *
 * The defect this guards against: the lanes were once written out twice, once per pin, and the two
 * copies disagreed. The scan pin listed `permissionPrompt`, which does not exist in `sdk.d.ts` at
 * all, and omitted `permissions`, which does. So the "two mechanisms, one invariant" argument (a
 * type cannot see a module that reaches past the composer, a scan cannot see a type) was being made
 * by two lists guarding different sets, with the real option covered by only one of them.
 *
 * One declaration now, derived by both, and every name checked against the shipped types.
 */
export const SHADOWING_LANES: readonly string[] = [
  // `permissionMode` was deliberately removed from this list (CLI parity); see
  // `CLI_PARITY_OPTION_KEYS`. It is the one lane that is a posture the operator chooses in the open,
  // not a rule file or a pre-answer; the eight below are the latter and stay closed.
  'settings',
  'managedSettings',
  'toolAliases',
  'permissionPromptToolName',
  'allowedTools',
  'disallowedTools',
  'canUseTool',
  'permissions',
];

/**
 * The keys that widened the composable set for visibility, kept as data so the reason is checkable
 * rather than remembered.
 *
 * One reason covers all three: each selects what the process emits. None appears in any permission
 * evaluation path, so none can change whether a tool runs, only how much of the run is visible.
 * That is why widening the set here does not weaken the boundary above.
 *
 * The pin asserts every member is composable and is none of the eight shadowing lanes, so a later
 * addition cannot join this list by assertion alone.
 */
export const STREAMING_OPTION_KEYS = [
  'includePartialMessages',
  'thinking',
  'forwardSubagentText',
] as const satisfies readonly (keyof AgentProcessRequest)[];

/**
 * The keys that change which tools exist: a different class from the streaming three, kept
 * separate so the two reasons cannot be confused for one.
 *
 * These are not data keys. `mcpServers` introduces tools, and `PreToolUse` fires for MCP tools and
 * inside subagents (observed, not assumed). So this widening enlarges the surface the gate must
 * cover, and the streaming keys' reason ("it only selects what is emitted") is false of it.
 *
 * Nor are they shadowing lanes. The closed lanes share one property: they can answer a permission
 * before the gate does. These answer nothing. What makes them safe is structural: `permissionHooks`
 * registers `PreToolUse` with no `matcher`, so a tool this host has never heard of reaches exactly
 * the same handler as `Bash`. Coverage is by construction rather than by enumeration, which is why a
 * tool set the host cannot predict is still a tool set the host decides about.
 *
 * If a `matcher` were ever introduced, this classification stops being true, and these two keys
 * become the first way to add a tool nothing decides about. That sentence is the whole reason this
 * list exists as data instead of as a decision somebody made once.
 *
 * `strictMcpConfig` belongs here because it acts on the same surface, but it moves the opposite
 * way: it only ever removes servers the host did not declare. It is the safe direction of the same
 * lane, and grouping them keeps that visible.
 */
export const TOOL_SURFACE_OPTION_KEYS = [
  'mcpServers',
  'strictMcpConfig',
] as const satisfies readonly (keyof AgentProcessRequest)[];

/**
 * The keys that decide where a transcript goes: a third class again, and the reason is not the
 * other two lists' reason.
 *
 * These are a confidentiality and egress surface. The streaming keys widen what this host observes
 * about its own session. The tool-surface keys widen what the agent may do, and are covered because
 * the gate has no matcher. These do neither: they hand a live object every message the agent saw,
 * and a store is by definition somewhere else. Filing them under "it only selects what is emitted"
 * would put a false sentence inside the constant whose entire job is to make the reason checkable.
 *
 * Nor are they shadowing lanes. The closed lanes share one property: they can answer a permission
 * before the gate does. A store answers nothing and is never consulted about whether a tool runs.
 *
 * What makes them safe is that a destination cannot be named from off-box, and it is structural
 * rather than enforced: `SessionStore` is an object with methods, so it has no JSON representation
 * and cannot arrive over the link. The only code that can supply one is the code that composes this
 * host. That is the same shape of argument as the gate's no-matcher coverage (a property of what
 * the type is, not of a check somebody remembered to write) and it is pinned by
 * pins/persistence-egress.test.ts.
 *
 * If a store ever becomes constructible from data (a URL, a connection string, a descriptor the
 * host resolves into a client), this classification stops being true, and these become the first
 * way a transcript can be sent somewhere the operator did not choose. That sentence is why this list
 * is data instead of a decision somebody made once.
 */
export const PERSISTENCE_OPTION_KEYS = [
  'sessionStore',
  'sessionStoreFlush',
] as const satisfies readonly (keyof AgentProcessRequest)[];

/**
 * The keys that choose which agent runs and what it is told at the start: a fourth class, and its
 * reason is not any of the other three's.
 *
 * These were absent, not narrowed, and that is the whole classification. `model` and
 * `systemPrompt` were simply not in this type, so nothing was ever protecting them; there was no
 * decision to reverse, only a capability nobody had wired. The eight `SHADOWING_LANES` are the
 * opposite case: each was considered and closed. Opening a gap and re-opening a closed lane look
 * identical in a diff, and this list is how they stop looking identical.
 *
 * Neither appears in any permission evaluation path. They do not pre-answer a call, do not
 * redirect a tool name, do not load a rule file and are never consulted about whether a tool runs,
 * which is exactly the property the closed lanes share and these do not. What they change is which
 * weights answer and what standing instructions those weights start with.
 *
 * The cost, because a widening with no stated cost is a widening nobody checked: a controller that
 * can set a system prompt can give the agent standing instructions this host will never see the
 * effect of, since the SDK's init message does not report one. The gate still decides every tool
 * call, so the boundary is unmoved, but "the host can state what this agent was told" is not a
 * property this package has; `AgentInitFacts` is where that can be verified.
 *
 * The pin asserts every member is composable and is none of the eight, exactly as the other lists
 * do.
 */
export const AGENT_SELECTION_OPTION_KEYS = [
  'model',
  'systemPrompt',
] as const satisfies readonly (keyof AgentProcessRequest)[];

/**
 * The CLI-parity keys, and the list that re-opens a closed lane on purpose. `effort` was absent (a
 * gap, like `model`). `permissionMode` was once a shadowing lane, considered and closed, and it is
 * opened here by name, with the reason:
 *
 *   a session through this host must expose what `claude` exposes, and bypass is a common default
 *   for an operator. The gate never depended on the mode: `PreToolUse` fires under every mode, so
 *   the boundary set is still held under `bypassPermissions`. What the mode changes is the CLI's
 *   own prompt flow, which this host's gate already answers.
 *
 * The other eight stay closed: they are rule files and pre-answers, which is a different thing from a
 * posture chosen in the open. Pinned by `pins/permission-config.test.ts`.
 */
export const CLI_PARITY_OPTION_KEYS = [
  'effort',
  'permissionMode',
] as const satisfies readonly (keyof AgentProcessRequest)[];

/** A started agent process, in this package's terms. */
export interface AgentProcess {
  /**
   * Everything the agent emits, in order. One consumer.
   *
   * This is a narrowing wrapper, not the SDK's `Query`, and that is load-bearing. `query()`
   * returns an object that IS an async generator AND carries `setPermissionMode`,
   * `applyFlagSettings`, `setMcpServers` and `setMcpPermissionModeOverride` — four calls that change
   * permission outcomes mid-session, after any construction-time check has run. Handing that object
   * out under an `AsyncGenerator` annotation hides them from the compiler and from nobody else: one
   * cast, or any plain JavaScript, reaches all four. So it is wrapped rather than annotated, and
   * "the composed options cannot ship a shadowing setting" stays true without the words "unless you
   * cast" attached to it.
   *
   * Where a mid-session control goes instead: a named method on this handle, beside `prompt`,
   * `interrupt` and `close`. Never by widening this property back to the `Query`, and never by
   * casting it; the point is that one file decides which of the SDK's controls this package
   * offers.
   */
  readonly messages: AsyncGenerator<SDKMessage, void>;
  /** Queue a turn. Returns false once the process is closed. */
  prompt(text: string): boolean;
  /** Stop the current turn in band, leaving the session alive. */
  interrupt(): Promise<void>;
  /**
   * The named mid-session controls this package offers (the doc above says where they go): the
   * three members of `session_configure`, each the SDK's own streaming-input setter behind a method.
   * `setPermissionMode` is here deliberately: the one permission mutator that is a posture, reached
   * only from the wire through `readSessionConfigure`; the other three stay unreachable.
   */
  setModel(model: string | null): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setThinking(thinking: ThinkingConfig): Promise<void>;
  /** End the process and release everything it holds. Idempotent. */
  close(): void;
}

/**
 * Facts the agent states about itself at start, lifted out of the SDK's init message.
 *
 * This is the per-spawn version receipt, and its shape is why it cannot rot: `cliVersion` arrives
 * on the session's own stream, so there is no place to cache it even by accident. The CLI can
 * auto-update underneath a long-running host, and a value read once at startup would then be a
 * confident lie on every later session — which is the failure this receipt exists to catch.
 *
 * Absent is `null`, never an omitted property: this record is destined for the wire, where JSON has
 * no `undefined` and an optional field makes "not reported" and "reported as unset" the same thing.
 */
export interface AgentInitFacts {
  readonly sessionId: string;
  readonly cliVersion: string;
  readonly cwd: string;
  readonly model: string;
  readonly permissionMode: string;
  /** Where the agent found its credentials. The evidence that ambient auth actually resolved. */
  readonly apiKeySource: string;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly plugins: readonly AgentPluginFact[];
  readonly capabilities: readonly string[];
  /**
   * The MCP servers this agent actually connected to, and what happened to each.
   *
   * The agent reports this on the init message. Without it, "did my server register?" is answered
   * by inferring it from tool names, which cannot tell a server that failed to connect from one that
   * connected and exposed no tools, and an HTTP or stdio server, unlike an in-process one, can fail
   * to connect. With it, the answer is the agent's own word, per server, by name and status.
   *
   * The status string is carried verbatim and never interpreted here. It is the agent's vocabulary,
   * not this package's, and mapping it onto this package's words would be a second translation
   * site, the thing `state/observer.ts` exists to be the only one of.
   */
  readonly mcpServers: readonly AgentMcpServerFact[];
}

/** One MCP server as the agent reported it at start. `status` is the SDK's word, carried as-is. */
export interface AgentMcpServerFact {
  readonly name: string;
  readonly status: string;
}

export interface AgentPluginFact {
  readonly name: string;
  readonly path: string;
  readonly version: string | null;
}

/**
 * The init message's facts, or null for every other message.
 *
 * Reading it here rather than above the seam keeps the SDK's message union on this side; the layer
 * above branches on a plain record.
 */
export function readInitFacts(message: SDKMessage): AgentInitFacts | null {
  if (message.type !== 'system' || message.subtype !== 'init') return null;
  return {
    sessionId: message.session_id,
    cliVersion: message.claude_code_version,
    cwd: message.cwd,
    model: message.model,
    permissionMode: message.permissionMode,
    apiKeySource: message.apiKeySource,
    tools: message.tools,
    skills: message.skills,
    // Guarded for the same reason as `mcp_servers` below: `plugins` is declared required and read
    // with `.map(…)`, the identical shape, the identical runtime-wins argument, the identical
    // `TypeError`. Every member of this class is guarded, not only the one observed failing.
    plugins: (message.plugins ?? []).map((plugin) => ({
      name: plugin.name,
      path: plugin.path,
      version: plugin.version ?? null,
    })),
    capabilities: message.capabilities ?? [],
    // Guarded though the type says required. `mcp_servers` is declared non-optional on the init
    // message, so `message.mcp_servers.map(…)` typechecks, and this package's rule is that the
    // runtime wins over the types. An init message without the field would throw a TypeError inside
    // `readInitFacts`, and the pump's own catch would convert the throw into `process_failed`: the
    // session ends, and the reader's bug is reported as the agent process dying. `capabilities` one
    // line up is guarded for the same reason, and it at least has `?` in the type as a warning.
    //
    // The cost of an unguarded read is misattribution, not silence. This read has exactly one
    // caller, `HostedSession.#pump`, which calls it before and outside the per-listener try/catch,
    // so nothing swallows it: the enclosing catch finishes the session as `process_failed`, closes
    // the process, releases the registry entry, refuses every `whenLive` waiter and puts a
    // transition to `ended` on the wire. `state/observer.ts` contains no catch at all, so no
    // observer wrapper can eat the throw.
    mcpServers: (message.mcp_servers ?? []).map((server) => ({ name: server.name, status: server.status })),
  };
}

/**
 * The message stream, and ONLY the message stream.
 *
 * `return` and `throw` are delegated, not just `next`. `for await…of` calls `iterator.return()`
 * when the loop leaves early — a `break`, a `return`, or a throw inside the body — and that call is
 * what lets the underlying query release the subprocess. A wrapper implementing only `next` would
 * swallow it, leaking a session per abandoned loop with no error, no log and nothing null: exactly
 * the silent-loss shape this package is built against. Pinned by agent-process.test.ts.
 *
 * Exported for that pin. It is not part of the package's public surface.
 */
export function messagesOf(source: AsyncGenerator<SDKMessage, void>): AsyncGenerator<SDKMessage, void> {
  return {
    next: (...args) => source.next(...args),
    return: (value) => source.return(value),
    throw: (error) => source.throw(error),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<SDKMessage, void>;
}

/** Start an agent process. The subprocess exists when this returns. */
export function startAgentProcess(request: AgentProcessRequest): AgentProcess {
  const input = new AsyncQueue<SDKUserMessage>();

  const options: Options = {
    cwd: request.cwd,
    env: request.env,
    settingSources: [...request.settingSources],
    includePartialMessages: request.includePartialMessages,
    forwardSubagentText: request.forwardSubagentText,
    ...(request.thinking === null ? {} : { thinking: request.thinking }),
    ...(request.mcpServers === null ? {} : { mcpServers: { ...request.mcpServers } }),
    ...(request.strictMcpConfig === null ? {} : { strictMcpConfig: request.strictMcpConfig }),
    // `persistSession` is deliberately never composed: the mirror runs after the local write, so a
    // store cannot be combined with local persistence off. Leaving the SDK's default in place is
    // what makes that combination unbuildable here rather than merely undocumented.
    ...(request.sessionStore === null ? {} : { sessionStore: request.sessionStore }),
    ...(request.sessionStoreFlush === null ? {} : { sessionStoreFlush: request.sessionStoreFlush }),
    ...(request.plugins === null ? {} : { plugins: [...request.plugins] }),
    ...(request.hooks === null ? {} : { hooks: request.hooks }),
    ...(request.resume === null ? {} : { resume: request.resume, forkSession: request.fork }),
    ...(request.onStderr === null ? {} : { stderr: request.onStderr }),
    ...(request.spawn === null ? {} : { spawnClaudeCodeProcess: request.spawn }),
    // Omitted rather than passed as null when unset, like every other optional above: the SDK reads
    // an absent key as "use the default" and a present-but-null one as a value it must interpret.
    ...(request.model === null ? {} : { model: request.model }),
    ...(request.systemPrompt === null ? {} : { systemPrompt: request.systemPrompt }),
    ...(request.effort === null ? {} : { effort: request.effort }),
    ...(request.permissionMode === null ? {} : { permissionMode: request.permissionMode }),
  };

  const running: Query = query({ prompt: input, options });
  let closed = false;

  return {
    messages: messagesOf(running),
    prompt(text: string): boolean {
      if (closed) return false;
      // `session_id` and `uuid` are optional on this type and deliberately left off: the agent
      // stamps its own. Sending an empty string would be a PRESENT id that is blank, which is a
      // different and worse thing than an absent one.
      const message: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
      };
      input.push(message);
      return true;
    },
    async interrupt(): Promise<void> {
      if (closed) return;
      // The SDK's receipt names which queued messages survived the interrupt. Not surfaced here:
      // acting on it needs the turn model, which belongs to the layer that owns turns.
      await running.interrupt();
    },
    async setModel(model: string | null): Promise<void> {
      if (closed) return;
      // `undefined`, never null: the SDK reads undefined as "the default" and null as a model named null.
      await running.setModel(model ?? undefined);
    },
    async setPermissionMode(mode: PermissionMode): Promise<void> {
      if (closed) return;
      await running.setPermissionMode(mode);
    },
    async setThinking(thinking: ThinkingConfig): Promise<void> {
      if (closed) return;
      // The SDK's LIVE setter is the token cap, and on current models it is on/off: 0 = disabled,
      // null = the default (adaptive). A fixed budget is REJECTED by Opus 5 / Sonnet 5 / Fable, so an
      // `enabled` ask maps to adaptive rather than to a 400. The DISPLAY rides along: `summarized` when
      // asked, because the models' default (`omitted`) streams thinking blocks with empty text — the
      // "no thinking" an operator sees while paying for it.
      const cap = thinking.type === 'disabled' ? 0 : null;
      const display = thinking.type === 'disabled' ? undefined : thinking.display;
      await running.setMaxThinkingTokens(cap, display);
    },
    close(): void {
      if (closed) return;
      closed = true;
      input.end();
      running.close();
    },
  };
}
