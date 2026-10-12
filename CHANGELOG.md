# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semantic versioning: patch
for no wire or API change, minor for a protocol bump (the previous version stays supported for one
minor), an agent SDK pin bump or an additive API, major for a wire change outside the window or a
removed export. The package version and the wire protocol version are separate numbers.

## [Unreleased]

## [1.6.0] - 2026-10-11

Protocol 15; the window is `[14, 15]`, so a version-14 controller is still spoken to. Version 15
adds bodies, optional members and refusal reasons, no payload kind: a version-14 controller reads the
new bodies as open JSON it may ignore, carries the new members unread, never sends the members five
of the new reasons answer, and reads the sixth, `settings-route-refused`, as it reads any reason it
does not know; every frame it sends decodes unchanged.

- Added: the fact layer. A `session_update` may carry an `agent_facts` body: one fact the agent
  reported, typed, right behind the message it came from. Six kinds: `session_handle` (the resumable
  id), `agent_receipt` (version, model, approval mode, effort, skills, plugins, plugin errors, MCP
  servers), `turn_record` (the running total and the turn's own figure, each a `SpendFacts` with a
  currency and a cost basis per model, and `turnScope`), `usage_sample` (one model call's context
  and cache lifetime), `tasks` (every task running, whole) and `compaction`. Every figure is one the
  agent reported, or null; nothing is summed or differenced. `sourceId` is the `uuid` of the message
  a fact was lifted from, so an ingest can be idempotent on it. A Claude session sends each fact when
  it changes: a re-sent identical init sends nothing, a call that arrives as several messages is
  sampled once.
- Added: `agent_fragment` deltas. Each streamed content delta also rides the delta lane as a
  fragment on its channel (`text`, `thinking`, `tool_input`), with the tool call that spawned the
  subagent speaking as `parentId`; the `agent_message` delta it came from still rides. A delta body
  is read as a `SessionDeltaBody`.
- Added: `runtime` on `agent_message`, optional. Absent means `claude` (`DEFAULT_RUNTIME`), and a
  Claude session's messages omit it, so their bodies are unchanged. Transcript locators are the
  namespace `{runtime}-transcript:{...}`; `claude-transcript:` is the instance this host serves.
- Added exports: the fact types (`AgentFact` and its six arms, `AgentFactsUpdate`, `SpendFacts`,
  `ModelSpendFact`, `RunningTaskEntry` and the receipt's parts), `AgentFragmentDelta`,
  `SessionDeltaBody`, `agentFactsUpdate`, `readAgentFacts`, `agentFragmentDelta`,
  `readAgentFragment`, the vocabularies `COST_BASES`, `TURN_SCOPES`, `RECEIPT_SOURCES`, `CACHE_TTLS`,
  `COMPACTION_STATUSES`, `COMPACTION_TRIGGERS` and `FRAGMENT_CHANNELS`, the bounds
  `MAX_FACT_LIST_ENTRIES`, `MAX_FACT_TEXT_LENGTH` and `MAX_FACT_WORD_LENGTH`, and `DEFAULT_RUNTIME`.
  On the main entry: `FactLift`, `FACT_LIFTS` and `factLiftFor` (the fact lift per runtime),
  `ForwardSessionOptions.lift`, which `composeSession` fills with Claude's, and
  `SessionObserver.onCompaction` with `CompactionReport`.
- Added: `agents` on the hello's configuration and the configure answer, optional: one
  `HostAgentEntry` per runtime the host can spawn (its versions, models, the permission modes and
  effort levels it takes, whether it takes a thinking control, its control tier, and whether it is
  available), at most `MAX_AGENT_ENTRIES`. This host lists Claude, from the same read as `agent`; the
  two are null together.
- Added: `runtime` on `session_new.request`, optional. Null, absent and `claude` open as before; any
  other runtime is refused `runtime-unavailable` before anything is reserved. A composed session's
  runtime picks its fact lift, its control tier and the runtime its decision requests name
  (`SessionRequest.runtime`, read through `runtimeOf`).
- Added: the control tier. A session's first transition into `ready` carries
  `controlTier: { level, degrades }`, and each runtime entry carries the same; a Claude session is
  `intercepted` with no degrades. Levels are `CONTROL_TIER_LEVELS`; an undeclared level is refused on
  the way out and read on the way in.
- Added: `toolKind` and `runtime` on the decision request, optional, beside the unchanged
  `toolName`. Claude's tool names map to `shell`, `file_read`, `file_write`, `file_edit`, `mcp` or
  `web`, and any other name to `other` (`TOOL_KINDS`).
- Added refusal reasons: `runtime-unavailable`, `request-key-unsupported`, `endpoint-unknown`,
  `endpoint-incompatible` and `model-endpoint-mismatch`. This host raises the first and the three
  endpoint reasons (below); a session on Claude never meets the second.
- Added: `endpoints` on the hello's configuration and the configure answer, optional: one
  `HostEndpoint` per model endpoint the host's operator declared (its name, the wire API it speaks,
  the runtimes that can reach it, and every model id a session may name on it, alias ids included),
  at most `MAX_ENDPOINTS`, held to its own `MAX_ENDPOINT_CATALOG_BYTES` beside the catalog's budget.
  An endpoint's address, its credential and whether it is Anthropic's own route never ride the wire.
  Wire APIs are `ENDPOINT_WIRE_APIS`; an undeclared one is refused on the way out and read on the way
  in.
- Added: `endpoint` on `session_new.request`, optional. Null and absent take the runtime's own route.
  For a declared endpoint the host sets, in the spawn environment, its address and credential
  (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`), the model each mapped tier resolves to, its window,
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, after the
  controller's lanes and never through the floor that screens them. A name the operator did not
  declare refuses `endpoint-unknown`; an endpoint that cannot carry the session's runtime,
  `endpoint-incompatible`; and on an endpoint not marked as Anthropic's own route, a `claude-` model
  id or an alias the endpoint does not map refuses `model-endpoint-mismatch`, at the open and on a
  `session_configure` that switches to one.
- Added: `PERISCOPE_MODEL_ENDPOINTS`, a config-file key never settable over the link, naming the
  operator's endpoints file. Each entry: a name, a wire API, its runtimes, a base URL, a credential
  read from an environment variable, a file or a helper command (an absolute executable, run with no
  shell; a Windows batch file is refused), its models, the tiers it maps, its window in the vendor's
  form, more variables, and `firstParty`. The file is read, checked and its credentials resolved at
  start, and an entry this host could not honour refuses start by name. The file and every credential
  file it names join the protected set.
- Added: `settings-route-refused`. A session that loads the `project` or `local` settings tier is
  refused before the agent starts when the repository's `.claude/settings.json` or
  `.claude/settings.local.json` names, in its `env`, a key beneath the env floor; the detail names the
  file and the keys.
- Added exports: `EndpointWireApi`, `ENDPOINT_WIRE_APIS`, `HostEndpoint`, `MAX_ENDPOINTS`,
  `MAX_ENDPOINT_MODELS` and `MAX_ENDPOINT_CATALOG_BYTES`. On the main entry: `ModelEndpoint`,
  `ModelAliasTier`, `EndpointContextWindow`, `ModelEndpointsReading`, `ModelEndpointsReadOptions`,
  `readModelEndpoints`, `PeriscopeHostOptions.endpoints`, `SessionRequest.endpoint`,
  `SessionRequest.hostEnv`, `RUNTIME_WIRE_APIS`, `wireApisFor`, `spawnableRuntimes`, and the
  `modelEndpointFiles` option of `credentialPaths`.
- Changed: `composeSpawnEnv` takes an optional third input, the host's own variables, applied after
  the policy's literals and before the host-session strip.
- Added exports: `ControlTier`, `ControlTierLevel`, `CONTROL_TIER_LEVELS`, `HostAgentEntry`,
  `HostAgentVocabularies`, `MAX_AGENT_ENTRIES`, `ToolKind` and `TOOL_KINDS`. On the main entry:
  `CONTROL_TIERS`, `controlTierFor`, `runtimeOf`, `SessionObserverOptions` (the observer's tier),
  `TransitionRequest.controlTier`, `SessionRequest.runtime` and `PermissionGateOptions.runtime`.
- Changed: `agentMessageUpdate` and `agentMessageDelta` take an optional `runtime`.
- Changed: the codec checks the members the new bodies declare, and only those. A count in a fact
  (tokens, a context window, turns, a duration) must be a non-negative whole number, or the frame is
  refused `frame-malformed`; a vocabulary word a newer peer adds is read, and one this host does not
  declare is refused on the way out. Every other body is open JSON, as before.

## [1.5.0] - 2026-10-10

Protocol 14; the window is `[13, 14]`, so a version-13 controller is still spoken to. Protocol 14
changes no shape. It narrows what `session_new.request.env` may carry, and the narrowing holds at
every version the host negotiates, 13 included.

- Closed: a paired controller could change where a session's model traffic went. `SECURITY.md`
  promised a floor of environment keys beneath every controller, and the floor did not hold. It was
  checked against `extraEnv` only, so `extraAllowedKeys` could re-admit `ANTHROPIC_BASE_URL`, or any
  other key the host's own environment held. And it was a list of eleven names, so `extraEnv` could
  set the agent CLI's other routing variables: `ANTHROPIC_AUTH_TOKEN`, a provider switch such as
  `CLAUDE_CODE_USE_BEDROCK` with its base URL, `HTTPS_PROXY` with `SSL_CERT_FILE`. A controller
  could point a session's model calls, and everything the agent had read, at a server of its
  choosing.
- `session_new.request.env` is absent unless declared. A key a controller places in the agent's
  environment, by `extraEnv` or `extraAllowedKeys`, must be one the host's operator declared:
  `PERISCOPE_CONTROLLER_ENV_KEYS` (comma-separated, from the environment or the config file, never
  settable over the link) or `PeriscopeHostOptions.controllerEnvKeys`. Nothing is declared by
  default, so **a controller that sends `extraEnv` or `extraAllowedKeys` is refused
  `env-key-refused` until the operator declares the keys**, and the refusal names each one.
  `extraDeniedKeys` is unchanged.
- The floor beneath the declaration covers both lanes and every name of the families the agent CLI
  routes by: beside its eleven names, `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*_AUTH`,
  `CLAUDE_CODE_CLIENT_*`, `SSL_CERT_*` and `*_PROXY`. A floor entry may be a pattern in which `*`
  stands for any run of characters; `extraEnvFloor` keeps its type. No declaration opens the floor,
  and a declared name beneath it refuses `serve` at start and `periscope config` before it writes.
  What a session inherits from the host's own environment is unchanged: a proxy the host sets still
  reaches every session.
- Setting `CLAUDE_CODE_ENABLE_TODO_TOOLS` from a controller now needs the host to declare it
  (`docs/configuration.md`).

## [1.4.0] - 2026-10-01

Protocol 13; the window is `[12, 13]`, so a version-12 controller is still spoken to. Protocol 13 adds
two asks and one answer and no member to an existing kind: a version-12 controller sends neither ask,
so it is sent nothing it does not know, and every frame it sends still decodes.

- `session_end`: a controller ends a session it no longer needs. The agent's process exits, the end is
  reported as the session's transition to `ended` with cause `stop_requested`, and the workspace the
  session held is free. An end that arrives while the session is opening withdraws the turns waiting
  for it and ends the session as it opens. `session_cancel` still ends a turn and never a session.
- `workspace_read` and `workspace_read_result`: a controller reads a text file inside a workspace this
  host provisioned, by the workspace's key and a path relative to its directory, a page at a time
  (`MAX_WORKSPACE_READ_BYTES` per page, files up to `MAX_WORKSPACE_FILE_BYTES`). Each answer says
  where the next page starts. The repository read's jail and protected set apply over the
  workspace's directory, and the ask is host-scoped, so a workspace whose sessions have all ended can
  still be read. Two refusals, `workspace-path-escape` and `workspace-read-failed`. A provider locates
  a workspace through the new optional `WorkspaceProvider.pathFor`, which both shipped providers
  implement; `readWorkspaceFile` is the reader.
- The local gate's read policy. What an agent can now reach: reads are no longer jailed to the
  session's workspace, so `Read` and `NotebookRead` go anywhere the host's OS user can read (installed
  packages, the agent's own tool output, the agent CLI's settings and skills) except the protected
  set. What it can no longer reach: the search family, `Grep` and `Glob` by default
  (`ToolFamilies.search`, optional), is refused by name when its root is at or beneath a protected
  path or holds one beneath it, where before those tools had no local opinion; a shell command naming
  a protected path through `~`, `$HOME`, `${HOME}`, `$env:HOME`, `$env:USERPROFILE` or
  `%USERPROFILE%` is refused by name (`LocalGateOptions.home`, `PeriscopeHostOptions.home`,
  `homeDirectory`); and every protected-path comparison folds case, so another spelling of a
  protected path no longer passes. Writes stay jailed to the workspace.
- `credentialPaths` names credential material rather than the directories it sits in: the agent CLI's
  `.credentials.json` and `.claude.json` in `~/.claude`, in `CLAUDE_CONFIG_DIR` and in the effective
  agent home, plus `~/.claude.json`, replace the whole `~/.claude`, `CLAUDE_CONFIG_DIR` and agent home.
  The host's own config directory and `~/.aws`, `~/.config/gcloud`, `~/.azure` and `~/.ssh` stay
  protected whole.
- `docs/identity.md` states the `extraEnv` floor: `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`
  passed through `session_new.request.env.extraEnv` refuse `env-key-refused`.

## [1.3.0] - 2026-09-29

Protocol 12; the window is `[11, 12]`, so a version-11 controller is still spoken to. Every member
protocol 12 adds is optional, so a version-11 controller, which reads none of them, decodes this host's
frames, and its own frames, which carry none, still decode here.

- The agent SDK is 0.3.284, bundling Claude Code 2.1.284 (from 0.3.220 and 2.1.220), so a session can
  run the models that CLI knows; `@anthropic-ai/sdk`, the SDK's peer, is `^0.129.0`.
- The SDK's two new hook events are in the cause vocabulary (`HOOK_EVENTS`, `CauseEvent`).
  `PostModelSwitch` is recorded: a same-state transition whose detail names the models on either
  side, who asked, whether the prompt cache was warm and on which TTL, and the estimated cost of
  re-caching the context. `PreModelSwitch` is answered, not recorded: `modelSwitchHooks` allows every
  switch, so a switch a controller asks for is never left to the interactive cache-miss confirm, which
  a session with nobody at a keyboard cannot answer. `composeSession` registers it. Claude Code
  2.1.284 lets a headless switch through without the answer too; the allow keeps it that way.
- `deltaSpend(previous, next)`: a result's spend is a running total (it accumulates across a
  session's turns, continues across a resume or a fork, and resets at `/clear`), so one turn's spend
  is the difference of two results; a drop in any counter starts a new series. Seed a resumed or
  forked session's first result with its parent's last one, or the parent's spend counts twice.
  `foldSpend` folds deltas.
- `ModelSpend` gains `thinkingTokens` and `costBasis` (`list`, `managed` or `unknown`, the last
  meaning the cost is a guess), null when the agent did not report them and optional in the type,
  so code that builds a `ModelSpend` still compiles.
- `readTaskSpend` is deprecated and returns null: no agent SDK declares the fields it read, and a
  subagent's cost is already inside the parent's results.
- A refusal with no fallback reaches the trace: `system/model_refusal_no_fallback` is a declared
  cause event. The observer recorded it before, but the machine refused every such transition as
  `transition-cause-unnamed`, so only the forwarded message said the model refused. The detail names
  the model and, when the agent reports one, the refusal category.
- Thinking is `adaptive`, with an optional `display` of `summarized` or `omitted`, or `disabled`. A
  fixed budget (`{type:'enabled', budgetTokens}`) is refused by name at `session_new` and
  `session_configure` (`frame-malformed`), because Opus 4.7 and later, Sonnet 5 and later and Fable 5
  and later reject it with a 400: a session that took it would open and then fail its first turn. The
  models that still accept a fixed budget lose that knob here. The `session_new.full` wire vector now
  carries `{type:'adaptive', display:'summarized'}`.
- A `session_configure` that turns thinking on sends the SDK a positive thinking cap
  (`THINKING_ON_CAP`) instead of clearing the cap. On Claude Code 2.1.284 a cleared cap left a
  session started with thinking disabled without its thinking prose on Opus 5.5, Fable 5.1 and
  Sonnet 5.5, and a positive cap brought it back. On those models any positive cap means adaptive;
  a model that still takes a fixed budget reads it as one.
- A `session_configure` that fails answers on the wire, as a same-state transition on the session's
  state lane with cause kind `refusal`. `session-configure-failed`, a new `RefusalReason`, is sent when
  the agent refuses a live setter, and its detail names the member and carries the agent's text.
  `frame-malformed` is sent when this host refuses a value. Before, both reached only the host's own
  report, as `session-unknown`, and the controller heard nothing. A model switch can now be refused,
  for a model the account cannot run.
- A message whose discriminator the routing table does not know, such as a subtype the CLI emits
  before the SDK's types declare it, rides `update`, the table's stated default. The lookup used to
  throw inside the forwarder, and the message was lost behind a `subscriber_failed` degrade.
- Plugins reach the agent over stdin (`pluginDelivery: 'initialize'`) rather than as one
  `--plugin-dir` flag each, so a host with several plugin directories stays clear of the Windows
  command-line limit. A custom `spawn` that loads plugins must run a CLI of 2.1.261 or later.
  `HostedSessionFacts.pluginsApplied` carries the agent's own answer to whether every plugin loaded;
  Claude Code 2.1.284 answers true with a missing directory in the list. The agent names a plugin
  directory that did not load, with its path, in its init message's `plugin_errors`, which reaches
  the controller forwarded. The host still refuses a missing configured directory itself, before a
  process exists.
- `permissionPrompts` joins the closed lanes: a controller cannot set it, so its `none`, which denies
  every call that would have prompted, cannot answer ahead of the gate. `updateSettings`, a new call
  that writes settings files mid-session, is among the calls the process handle keeps unreachable.
- A session asked to run under `bypassPermissions` starts with the SDK's
  `allowDangerouslySkipPermissions`, which the SDK requires before it enters that mode. A session in
  any other mode starts without it. The host still passes no `--dangerously-skip-permissions` and
  chooses no mode of its own. Claude Code 2.1.284 refuses a switch into bypass mid-session for a
  session started in another mode, by name, and the controller hears `session-configure-failed`.
- Only a session's first `system/init` records `ready`. The CLI re-sends its init with current values
  at every later turn, and recording each one moved a working session back to `ready` in the middle
  of its turn. A later init refreshes the session's facts instead: the model, the permission mode and
  the inventories it reports replace the first ones, and the id stays.
- The hello's `configuration` gains `agent` (`HostAgent`): the Claude Code version the installed agent
  SDK bundles, that SDK's version, and the models the agent offers (`HostModel`: the value a session
  takes as `model`, the model id an alias resolves to, the effort levels and what else it supports).
  It is read once at start by starting the agent with a prompt stream that never yields, so no model
  is called (`readAgentCatalog`, `PeriscopeHostOptions.agentCatalog`), and the link dials once the read
  settles, so the first hello carries it. `periscope serve` reads it bounded at 20 seconds and prints
  it on an `[agent]` line. A read that fails, or a catalog past `MAX_AGENT_MODELS` or
  `MAX_AGENT_CATALOG_BYTES`, rides as `agent: null` with the reason reported; it never fails a start.
  A `host_configure_result` carries it too.
- `session_configure` gains `effort`, in `session_new`'s vocabulary, applied after the model, the
  permission mode and thinking. An unknown level is refused `frame-malformed`. It reaches the SDK's
  flag settings with that one key and nothing beside it; as the SDK documents, a change of level also
  turns ultracode off.
- A forwarded message's body gains `observedAt`: when this host took it off the agent's stream,
  ISO-8601 in UTC, so a consumer does not date a message replayed after a reconnect by its arrival.
  `readObservedAt` returns null for a host one release behind. `agentMessageUpdate` and
  `agentMessageDelta` take it as an optional second argument, and `forwardSession` stamps it from its
  new `clock` option, the system clock when none is given.

## [1.2.0] - 2026-09-20

Protocol 11; the window is `[10, 11]`, so a version-10 controller is still spoken to.

- `PERISCOPE_PLUGIN_DIRS`: plugin directories the host loads into every session, a path list of
  plugin roots (each carrying `.claude-plugin/plugin.json`). Settable over the link; refused by name
  at start, at configure and at every open when a directory is absent or its manifest unreadable,
  because the agent SDK skips a missing plugin path without a word. A controller's own
  `session_new.request.plugins` are added after the host's.
- The hello's `configuration` gains `plugins`: each configured directory's manifest name, version
  and path, so a controller knows what a session on this host can invoke before it opens one.

## [1.1.0] - 2026-09-18

Protocol 10; the window is `[9, 10]`, so a version-9 controller is still spoken to.

- A live session queues at most 16 turns the agent has not read; a `session_prompt` past that is
  refused `prompt-queue-full` and the session is untouched. The queue a controller could grow without
  bound now has one, as every other buffer here does.
- `extraEnv` has a floor: `PATH`, `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`,
  `NODE_EXTRA_CA_CERTS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`,
  `DYLD_LIBRARY_PATH`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`. A
  `session_new` naming one is refused `env-key-refused` before a process exists;
  `PeriscopeHostOptions.extraEnvFloor` lets an embedder pass a shorter list.
- A host holds at most `maxSessions` sessions, live and opening together (`DEFAULT_MAX_SESSIONS`,
  8); a `session_new` past it is refused `session-cap-reached` before anything is reserved.
- `answer_refused`: a host-scoped answer the link refused (over the frame cap) is followed by this
  small kind carrying the request id and the refusal, so a controller learns by name rather than by
  timeout.
- `link_welcome` carries the controller's own `protocolRange`; a host reads its absence as null.
- `git reset --hard` is a boundary shape: classified locally, escalated like a push.
- The reference and minimal controllers send their range.

## [1.0.3] - 2026-09-18

- A worktree for a new branch is created with `git worktree add -b`, never `-B`. `-b` refuses when
  the branch exists, so a branch probe that failed for any reason other than the branch being absent
  now refuses the provision by name instead of hard-resetting the branch and discarding its commits.
  No wire or API change.

## [1.0.2] - 2026-09-18

- `SECURITY.md` states the permission mode as it is: the controller's to set per session, in the
  SDK's own vocabulary, `bypassPermissions` included, under which the `PreToolUse` hook is the only
  control; it is listed among the things a pairing extends. The README's naming sentence says what
  does ride the wire under the agent's names, and its safety paragraph points at that reach.
- The agent home and the transcripts root are reported in the home directory's own separator, so a
  Windows path reads as one on the controller's side. No wire or API change.

## [1.0.1] - 2026-09-17

- The package carries `src/` (without its tests) and `contracts/wire-vectors/`, so a controller in
  another language, and a consumer that generates types from the wire, read the contract from the
  installed package rather than from the repository. No wire or API change.

## [1.0.0] - 2026-09-17

Initial public release.

- One outbound WebSocket, commands only. Bulk content leaves by HTTP on a lane the controller names.
  Sequence numbers are dense per session per direction, minted at the first write; frames are
  retained until acknowledged and replayed from the controller's cursors after a reconnect.
- A fail-closed permission gate on every session: a `PreToolUse` hook with no permission prompt
  anywhere, local refusals for path escapes, credential reads and unrecognised git verbs, then an
  HTTP decision endpoint for everything else; no answer is a refusal.
- Workspaces: a plain directory or a git worktree per session, a branch scheme, list and release
  over the wire, and a repository read door jailed to the root and to the protected set.
- Identity: a generic OIDC client (authorization code with PKCE over loopback; device code opt-in)
  or a paired machine credential shaped `p1.<hostId>.<secret>`, presented on the upgrade, the
  decision POST and the bulk POST.
- The `periscope` binary: `serve`, `login`, `pair`, `config`, `status`, `version`.
- The contracts a second implementer proves against: the wire vectors under
  `contracts/wire-vectors/`, the public-API snapshot, and the installed agent SDK's type hash.

Protocol v9; the negotiated window opens at v9. Tested against `@anthropic-ai/claude-agent-sdk`
0.3.220 (Claude Code 2.1.220) on ubuntu and windows with node 22 and 24: 1485 tests, 1462 passing,
0 failing, 23 skipped on every leg (the skips are the live probes and one platform-only case),
measured by this repository's CI on the commit `v1.0.0` names.
