# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semantic versioning: patch
for no wire or API change, minor for a protocol bump (the previous version stays supported for one
minor), an agent SDK pin bump or an additive API, major for a wire change outside the window or a
removed export. The package version and the wire protocol version are separate numbers.

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
