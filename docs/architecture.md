# Architecture

What the package is and how its parts compose. The wire is in [protocol.md](protocol.md), the
session's state model in [state-machine.md](state-machine.md), the permission gate in
[gate.md](gate.md).

## What it is

Periscope runs where the code lives, hosts Claude Code sessions through the Claude Agent SDK and,
when its operator configures them, Codex sessions through Codex's app-server, Qwen Code sessions
through the Qwen Code CLI's stream-json control protocol and pi sessions through pi's RPC mode, and
reports to a
controller anywhere else over one outbound WebSocket. The controller decides what a session means;
the host carries what it did. Three properties follow, each enforced rather than promised:

- Generic. Nothing on the wire is shaped to one product. The test for a new member or event: could
  a different controller make different meaning from it? If yes it belongs here; if it means
  something only under one controller's rules it stays with that controller.
- The SDK's words. The package says session, message, hook, tool, subagent, turn, result and
  permission as the SDK does. A controller's own vocabulary fails the build
  (`pins/vocabulary.test.ts`). One site translates SDK events into transitions:
  `src/state/observer.ts`.
- Auditable blast radius. Nothing outside `src/host/` imports `node:fs`, `node:fs/promises`,
  `node:child_process` or `node:os`, and nothing outside it names the SDK (ESLint
  `no-restricted-imports`, `pins/host-boundary.test.ts`, `pins/sdk-confinement.test.ts`). The
  `./protocol` subpath cannot reach `src/host/`, so a consumer of the wire types acquires nothing
  that can spawn a process.

Where a concept exists in the Agent Client Protocol, the name is ACP's (`session/new` style,
camelCase keys, snake_case discriminators). Periscope is not ACP-compatible and does not claim to
be; no ACP transport dials out. The names that are the package's own (`link`, `bulk`) are registered
in `HOST_NOUNS` (`src/core/vocab.ts`).

## Composition

Two things live in `src/host/host.ts`.

`composeSession(options)` assembles one session: machine, observer, gate, forwarding. It takes
everything as arguments, so it is checkable without a socket or a process, and returns
`{ sessionKey, session, machine, observer, detach }`.

- Forwarding is attached before the first transition is recorded. The forwarder subscribes to the
  machine; attached later, the `spawning` record goes to nobody, and it is the first frame a
  controller sees for a session.
- Forwarding carries the session's facts. `composeSession` hands `forwardSession` the fact lift for
  the session's runtime (`factLiftFor`, `src/sessions/fact-lift.ts`), and each message is followed on
  the wire by the facts and fragments it carries, then by the transitions it caused; a compaction's
  fact follows the transition that recorded it. A lift holds the session's last handle, receipt and
  running tasks, so an unchanged fact is not sent again ([protocol.md](protocol.md), the fact layer).
- Observation hooks are registered before the gate's:
  `mergeHooks(observationHooks(...), permissionHooks(...))`. Matchers dispatch in array order but
  are awaited concurrently, and a gate registered first would open a hold the observer closes in
  the same event. No pin enforces the order; it is stated at both sites.
- Every gate outcome is recorded on the machine unconditionally. `onOutcome` is an extra listener,
  never a substitute.
- The repository check is `PeriscopeHost`'s, not `composeSession`'s: the repository-tier settings check
  (`settingsRouteRefusal`, `settings-route-refused`) runs in the host's open, before it composes. An
  embedder that calls `composeSession` directly owns that check.

`PeriscopeHost` owns the link and the registry and turns inbound payloads into calls on them.

- It answers exactly the payload kinds its dispatch names (the session commands, `bulk_request` and
  the host-scoped asks in [protocol.md](protocol.md)) and refuses everything else
  `frame-malformed`. A command that vanished would read as a host that hung.
- Two `session_new` for one handle never replace each other silently: the duplicate guard is a
  synchronous reservation that holds across the workspace provider's await.
- A workspace claimed and then unusable is handed back on every failure path; provision and release
  stay balanced.
- Shutdown ends sessions first, then the link, so the end transitions have somewhere to go.
  `forgetSession` does not discard unacknowledged frames.
- `baseEnv` and `homeDir` build the agent's environment. Passing them beside a `registry` is refused
  at construction: the host reads them only to build its own registry, and the pair would otherwise
  be ignored in silence.
- `linkTimings` (`heartbeatIntervalMs`, `heartbeatTimeoutMs`, `connectTimeoutMs`) and `backoff`
  reach the default link; `link` replaces the link wholesale.
- With `agentCatalog`, `start()` reads the agent's versions and models first and dials once the
  read settles, because the hello is where a controller reads them.
  - `readAgentCatalog` is the real read. It starts the agent with a prompt stream that never
    yields, loads no settings and no MCP server, writes no session file, reads only the answer to
    the SDK's initialize request, and closes the agent on every path.
  - A failed read, or a catalog past the hello's bounds, rides as `agent: null`, reported as an
    `agent-catalog` event. It never fails a start.
  - The hello's runtimes list, `agents`, is built from the same read, so it is null when `agent` is
    null; a list past its own bounds takes the catalog with it.
  - A `stop()` before the read settles means the link never dials.
  - Every configure answer and later hello keep the catalog, though the file they are rebuilt from
    has none.
  - With `codex`, the same wait covers Codex's read (`readCodexRuntime`), with `qwen`, Qwen
    Code's (`readQwenRuntime`), and with `pi`, pi's (`readPiRuntime`); the runtimes list names Claude
    first, then Codex, then Qwen Code, then pi. An entry that would push the list past its byte budget rides
    with `models: []` and a `runtime-catalog` event, so one runtime's catalog never empties
    another's.
- Each session's hooks are the observation hooks, the gate, then `modelSwitchHooks`, which answers
  every `PreModelSwitch` with allow. Claude Code 2.1.284 lets a headless `setModel` through with no
  answer at all. The allow keeps a controller's switch from ever meeting the interactive cache-miss
  confirm, which a session with nobody at a keyboard cannot answer.

A session refused at its open answers on the wire ([protocol.md](protocol.md), the refused open).

## The binary

`periscope` is six verbs (`src/bin/command.ts`): `serve` (the default: no arguments means `serve`),
`login`, `pair <code>`, `config`, `status` and `help`. An unrecognised first argument is `unknown`,
never `serve`; falling back would let a typo start a host. Every claim that the binary does not do
something is about the daemon; the other verbs are where interactive work lives.

- `serve` dials the controller and serves sessions. It refuses to start as root (an unattended
  agent as root has the whole machine on every tool call; refused by policy, before anything else is
  read) and refuses to start without `PERISCOPE_DECISION_URL` (a host that cannot ask is an open door or a
  session where nothing runs). It never signs anyone in: it presents credentials that are already
  there and refuses by name when they are not. It prints one `[host]` posture line, reads the agent's
  model catalog (bounded at 20 seconds, one `[agent]` line saying what the hello carries) and, with
  `PERISCOPE_CODEX_BIN` and `PERISCOPE_CODEX_HOME` set, Codex's (bounded at 20 seconds, one
  `[codex]` line), with `PERISCOPE_QWEN_BIN` and `PERISCOPE_QWEN_HOME` set, Qwen Code's (one
  `[qwen-code]` line), and with `PERISCOPE_PI_BIN` and `PERISCOPE_PI_HOME` set, pi's (one `[pi]`
  line), then dials, and writes the link's state to `link-state.json` beside the credentials on every
  transition. One of the two keys of any of the three without the other refuses start by name.
- `login` runs the sign-in and writes the token cache. `pair <code>`, with `--controller <origin>`
  and `--label <name>`, redeems a controller-minted code for a paired credential and writes the
  controller's addresses to the config file. `config` shows or edits `config.json`. `status` prints
  the whole posture from the link record, the credentials and the settings, and never dials.
- `config.json` lives beside the credentials under a closed key allowlist (`CONFIG_KEYS`: the two
  control-plane URLs, the host id, both roots, the branch scheme, the workspace key, the agent home,
  the plugin directories, the Codex binary and home, the Qwen Code CLI and base, the pi CLI and
  home;
  `PERISCOPE_CONFIG_DIR` is excluded, a file
  cannot move itself). `serve`, `login`, `pair` and
  `status` read the environment with the file filling its absences; the environment always wins. A
  corrupt file is fatal by name for all four. `config` itself reads the raw environment so it can
  still name a broken file.
- The agent home is the setting (`PERISCOPE_AGENT_HOME`, default `<home>/.claude`); its credential
  files join the gate's protected set.

## Sessions

`SessionRegistry` owns session lifetime as instance state, so two embedders in one process cannot
see each other's sessions; everyone else borrows a `HostedSession` handle.

- The agent emits nothing until a turn is queued. `create()` is synchronous provisioning with no id;
  `open(request & { prompt })` is the ordinary one-call shape. Waiting for output before prompting
  hangs with no diagnostic.
- The spawn environment is a derived allow-list, never inherited (`src/sessions/spawn-env.ts`):
  exact, prefix and suffix rules, case-insensitive, deny before allow, and the host-session strip
  (`HOST_SESSION_MARKERS`) runs last, after `extraEnv` and after the host's own lane (`hostEnv`, a
  model endpoint's variables, composed by `PeriscopeHost` from its operator's configuration and
  never screened by the floor), so the recorded hazards cannot be re-admitted. Product-specific keys come in through `extraAllowedKeys` and `extraEnv`. From a
  controller, over the wire, those two lanes carry only what the host's operator declared
  (`PeriscopeHostOptions.controllerEnvKeys`, `PERISCOPE_CONTROLLER_ENV_KEYS`), and never a key
  beneath the floor (`EXTRA_ENV_FLOOR`): the narrowing is `src/host/wire-request.ts`'s, before any
  process exists. An embedder composing a `SessionRequest` in process is not screened; it is the
  operator.
- Workspace trust is read, never granted (`src/host/workspace-trust.ts`). The package default is
  `settingSources: []`, the only setting under which the host can state what an agent's permissions
  are; what it costs is `CLAUDE.md` loading. The project tier loads only in a directory the CLI
  trusts, which a provisioned worktree is not.
- One consumer of the SDK stream: `HostedSession` pumps it once and fans out on `onMessage`,
  `onEnd` and `onDegrade`. Subscribe; never iterate the stream yourself. A throwing subscriber
  becomes a `subscriber_failed` degrade and cannot kill the pump.
- The CLI version is a per-spawn fact on `system/init`. `apiKeySource` is provenance, never an
  "is this authenticated" predicate: it reads `none` on a session that billed.
- `system/init` arrives on every turn, not once. The first one makes the session `ready`. A later
  one refreshes the handle's facts (model, permission mode, inventories) and keeps the id.
- `perTaskStopAffordance` is deliberately left unset. Unset, an interrupt (`session_cancel`) also
  stops the session's background agents and workflows, which is the fail-closed choice when nobody
  is watching. Declaring it would promise a per-task stop control this package does not offer.

A `session_prompt` arriving while its session is still opening is held, not refused. `session_new`
awaits the workspace provider, and a git worktree takes seconds; the host acknowledges no controller
frame, so the sender cannot know the open finished. A held turn is delivered when the session
registers, refused in the open's `finally` on every failure path, or withdrawn by a `session_cancel`
during the open; it is never dropped. The hold is bounded at `MAX_HELD_TURNS`; overflow refuses
`session-unknown` with the bound in its detail. A cancel during the open withdraws the turn and does
not stop the open. `HostEvent` reports `prompt-held`, `prompt-delivered` and `prompt-withdrawn`.

A `session_configure` arriving while its session is still opening is refused, never applied: the
session's settings are not yet its own. The refusal (`session-unknown`) is reported at once and held,
up to the turns' own bound, and once the session registers it is recorded on the session's own state
lane as a same-state refusal, so the controller hears it on that session.

## Codex

A session naming `runtime: "codex"` runs Codex's app-server (`codex app-server --listen stdio://`)
in the session's worktree, and the host speaks JSON-RPC to it over stdio. Codex is offered only when
the operator sets `PERISCOPE_CODEX_BIN` and `PERISCOPE_CODEX_HOME` ([configuration.md](configuration.md)).
Its control tier is `intercepted-with-residual`: periscope's own `PreToolUse` hook asks the host for
each decision over a per-session channel, Codex's approvals are decided by the same gate, and every
path that can still run undecided is named on the session's state lane ([gate.md](gate.md), the Codex
gate).

- **The gate.** `composeCodexSession` builds the session's gate (`createCodexSessionGate`,
  `src/host/codex-gate.ts`) before the process starts: the hook channel
  (`src/host/hook-channel.ts`), whose address, token and deadline ride the app-server's environment;
  the per-call decision every runtime shares (`createCallDecision`); the approval answers
  (`src/host/codex-approvals.ts`); and the watch over the residual (`src/host/codex-gate-watch.ts`). It
  reaches the process through the registry's route (`SessionRequest.nativeGate`, internal). The
  process holds the open until the channel listens and periscope's hook is trusted
  (`src/host/codex-hook.ts`), answers every server request through the gate, and tells it every
  notification first. The host writes the hook into the runner's Codex home and probes it at start.
- **The hook command.** `periscope hook codex` (`src/bin/hook.ts`) is dispatched by
  `bin/periscope.ts` before the composition root loads, because Codex runs it once per tool call; it
  imports nothing of this package but itself and `src/gate/hook-exchange.ts`.

- The transport is runtime-neutral (`StdioRpcPeer`, `startStdioRpc`, `src/host/stdio-rpc.ts`) and
  knows no Codex word. One JSON message per line, `\n` or `\r\n`; a line past `MAX_RPC_LINE_BYTES`
  (8 MiB) is dropped whole and named. Ids out are integers; every request has a deadline the host
  sets; notifications are delivered in arrival order; a server request with no handler is answered
  `-32601`. The child is spawned with `shell: false`, and a batch file is refused by name. Close ends
  stdin, waits a grace, then kills the process tree (`taskkill /T /F` on Windows, the process group
  elsewhere).
- The binary is pinned (`CODEX_PINNED_VERSION`, `src/host/codex-binary.ts`). Its `--version` and the
  `initialize` answer's user agent must both name the pinned release, or Codex is listed unavailable
  with the path, the version found and the version pinned. A `.js` path is the npm launcher and runs
  under this Node. Nothing installs it.
- The home is the runner's own (`src/host/codex-home.ts`). `CODEX_HOME` is set on every app-server
  and created when absent; its sign-in is the operator's `codex login` with `CODEX_HOME` set to it.
  Every app-server starts with the session flags as root `-c` overrides under `--strict-config`: the
  approvals reviewer is the user, web search is off, hooks are on, `approval_policy` and
  `sandbox_mode` follow the permission mode (`CODEX_MODE_MAP`, `src/host/wire-request.ts`), and each
  credential variable the host places in the app-server's environment is excluded from the agent's
  shell by its exact name, which Codex matches as a glob without regard to case.
- No thread or turn request carries a `cwd`; the app-server's process cwd is the worktree. Codex
  writes a project trust entry only for a thread request that names a cwd, so the host never trusts
  a project on the operator's behalf: the repository's `.codex/` layer stays closed and its
  `AGENTS.md` still loads ([SECURITY.md](../SECURITY.md)).
- At start the host reads Codex once (`readCodexRuntime`, `src/host/codex-runtime.ts`, bounded at 20
  seconds): the version, the account and the model catalog, then the app-server is closed. A home
  with no sign-in is unavailable with the sign-in step named. A catalog that cannot be read leaves
  Codex available with `models: []`. `vocabularies.thinking` is true only when a listed model takes
  the effort `none`.
- The process (`startCodexProcess`, `src/host/codex-process.ts`) is an `AgentProcess<CodexMessage>`.
  A prompt is queued in the host and sent as `turn/start` only while no turn runs; the model, mode,
  effort and thinking setters apply at the next turn; thinking off is the effort `none`, refused by
  name where the model does not list it; an interrupt names the running turn. Server requests are
  answered by `codexServerRequestAnswer` (`src/host/codex-answers.ts`): a command or a file change is
  declined, a permissions request is granted nothing for the turn, an elicitation is declined, a
  question gets no answers, anything else is `-32601`. Nothing is ever granted for the session.
- A session's plugin directories reach its app-server as skill roots before its thread opens
  (`skills/extraRoots/set`, `codexSkillRoots`, `src/host/codex-pack.ts`): each the plugin root, so
  Codex names its skills `plugin:skill` from the manifest. A directory the host cannot hand over is
  left out and named among the receipt's plugin errors, and Codex refusing the call ends the open
  `plugins-undeliverable`. Its MCP servers ride the thread's config (`codexMcpConfig`,
  `src/host/codex-mcp.ts`): an HTTP server's headers as static `http_headers`, every server's tools
  asked about before each call. A member that is Claude's alone (`settingSources`,
  `forwardSubagentText`, the `claude_code` preset) or a value Codex's vocabularies lack is refused
  `request-key-unsupported`, naming the member.
- A named endpoint reaches Codex as a provider of the session's own (`src/host/codex-endpoints.ts`):
  defined in its thread's config under an id the host derives (`codexProviderKey`), opened on by
  `modelProvider`, its key in the app-server's environment as `PERISCOPE_CODEX_ENDPOINT_KEY` and kept
  from the agent's shell. `ENDPOINT_ROUTED_RUNTIMES` (`src/sessions/runtimes.ts`) is Claude and Codex.
- Its messages ride as Codex wrote them (`CODEX_MESSAGE_BINDING`): each notification and server
  request is an `agent_message` with `runtime: "codex"`, the three text deltas on the delta lane;
  the answers to the host's own requests are not forwarded. The observer arm
  (`src/state/codex-observer.ts`) records the transitions they cause under `agent-event` events
  (`AGENT_EVENTS`: `codex:` and the notification's method), and `CodexFactLift`
  (`src/host/codex-facts.ts`) lifts the same facts Claude's lift does. `CodexItemFill`
  (`src/host/codex-items.ts`) fills the conversation items from the session's own thread, as
  `ClaudeItemFill` (`src/host/claude-items.ts`) does from Claude's messages and its prompt hook; the
  forwarder holds each to the item budget (`fitAgentItem`) and puts it behind its message's facts.
- What Codex's protocol declares is pinned name by name. `contracts/codex-protocol-names.json`,
  regenerated by `scripts/derive-codex-names.mjs` from the pinned release's source, holds every
  notification, server request, item kind and client method; `CODEX_COVERAGE`
  (`src/state/codex-coverage.ts`) holds a row for each (`pins/codex-coverage.test.ts`), and a live
  test holds the snapshot to the installed binary.

## Qwen Code

A session naming `runtime: "qwen-code"` runs the Qwen Code CLI in the session's worktree with
`--input-format stream-json --output-format stream-json --channel=SDK`, and the host speaks its
control protocol over stdio: one JSON value per line each way, `control_request` and
`control_response` in both directions. Qwen Code is offered only when the operator sets
`PERISCOPE_QWEN_BIN` and `PERISCOPE_QWEN_HOME` ([configuration.md](configuration.md)). Its control
tier is `intercepted-with-residual`: the settings the host writes send every call to ask, the CLI
asks the host before each, and every path that can still run undecided is named on the session's
state lane ([gate.md](gate.md), the Qwen Code gate).

- The transport is runtime-neutral (`StdioLinePeer`, `startStdioLines`, `src/host/stdio-lines.ts`):
  one JSON value per line, the line reader, the bound, the batch-file refusal and the close (stdin
  end, a grace, the process tree) the JSON-RPC transport uses, and no id discipline of its own. The
  control protocol rides it (`QwenControl`, `src/host/qwen-control.ts`): the host's requests carry ids
  it mints and deadlines it sets, a request the CLI makes is answered by a handler or with an error,
  a cancel aborts the handler, and a line that is not JSON is dropped and named
  (`rpc-line-malformed`). `initialize` is the first line the host writes.
- The CLI is pinned (`QWEN_PINNED_VERSION`, `src/host/qwen-binary.ts`). Its `--version` must name the
  pinned release, or Qwen Code is listed unavailable with the path, the version found and the version
  pinned. The path is the npm package's `cli-entry.js`, run under this Node. Nothing installs it. At
  start the host reads that version once (`readQwenRuntime`, `src/host/qwen-runtime.ts`) and never
  starts a session to do so, so the entry lists no models.
- Each session has a home of its own (`createQwenSessionHome`, `src/host/qwen-home.ts`) beneath the
  base: `QWEN_HOME`, the system-scope settings file and its defaults, the trusted-folders and MCP
  approvals files, all set in the CLI's environment and removed at close; `QWEN_RUNTIME_DIR` is the
  base's shared `runtime`, where the chats a resume reads are kept. The settings are read back before
  the CLI starts, and an open whose settings do not read back is refused `qwen-ask-rules-not-active`.
- The process (`startQwenProcess`, `src/host/qwen-process.ts`) is an `AgentProcess<QwenMessage>`. A
  prompt is a user line on stdin, held until the CLI answers `initialize` and bounded in the host;
  the model, mode and effort setters are control requests (`set_model`, `set_permission_mode`,
  `set_effort`), applied as they arrive; thinking has no switch and is refused by name; an interrupt is
  `interrupt`. After each `result` the host asks the CLI's context usage (`get_context_usage`). A
  request member Qwen Code cannot honour (Claude's settings tiers, its hooks and spawner,
  `forwardSubagentText`, a store) is refused `request-key-unsupported`, naming it.
- The gate (`createQwenSessionGate`, `src/host/qwen-gate.ts`) answers each `can_use_tool` through the
  per-call decision every runtime shares (`createCallDecision`), with `canRewriteInput: false`: an
  allow is answered as asked. The CLI's own wait for the answer is set in `initialize` beyond the
  host's deadline. The shell a call runs in is read from the CLI's environment at spawn
  (`qwenShellDialect`, `src/gate/tool-kind.ts`), and on a link negotiated below 17 a request whose
  dialect is `cmd` is sent with none (`decideAtLinkVersion`, `src/host/host.ts`).
- A session's plugin directories reach its settings as skill directories, each directory's `skills/`
  (`qwenSkillDirectories`, `src/host/qwen-pack.ts`), its skills listed by name alone. Its MCP servers
  ride `initialize` (`qwenMcpServers`, `src/host/qwen-mcp.ts`): an HTTP server's headers beside its
  URL, never in the CLI's environment or on its command line, and each server's tools asked about.
  A named endpoint reaches the CLI as its auth type and base URL, on the command line and in the
  session's settings, and its key, in those settings alone (`src/host/qwen-endpoints.ts`). `ENDPOINT_ROUTED_RUNTIMES` is
  Claude, Codex and Qwen Code.
- Its messages ride as the CLI wrote them (`QWEN_MESSAGE_BINDING`): each stream message and each
  control request it made is an `agent_message` with `runtime: "qwen-code"`, a `stream_event` on the
  delta lane; the answers to the host's own requests and the prompts it wrote are not forwarded. The
  observer arm (`src/state/qwen-observer.ts`) records the transitions they cause under `agent-event`
  events (`AGENT_EVENTS`: `qwen-code:` and the message's type and subtype, or the answered request's
  subtype), `QwenFactLift` (`src/host/qwen-facts.ts`) lifts the facts, and `QwenItemFill`
  (`src/host/qwen-items.ts`) fills the conversation items with the same block tables Claude's do.
- What the pinned release declares is pinned name by name. `contracts/qwen-code-names.json`,
  regenerated by `scripts/derive-qwen-names.mjs` from the release's source, holds every built-in tool,
  message type, result and system subtype, stream event, delta, content block and control request in
  each direction; `QWEN_COVERAGE` (`src/state/qwen-coverage.ts`) holds a row for each
  (`pins/qwen-coverage.test.ts`), and the ask rules are built from the same tool list.

## pi

A session naming `runtime: "pi"` runs pi in RPC mode (`--mode rpc`) in the session's worktree, under a
launch rule that loads periscope's own extension and pi's built-in MCP extension and nothing else of
pi's finding, and the host speaks its RPC over stdio: one JSON value per line each way, commands in,
events, answers and records out. pi is offered only when the operator sets `PERISCOPE_PI_BIN` and
`PERISCOPE_PI_HOME` ([configuration.md](configuration.md)). pi has no permission system; its gate is
periscope's extension, which asks the host about every tool call before it runs. Its control tier is
`intercepted` ([gate.md](gate.md), the pi gate).

- The RPC rides the same line transport (`PiRpc`, `src/host/pi-rpc.ts`, over `startStdioLines`): the
  host's commands carry ids it mints and deadlines it sets, an answer is matched to its command by id,
  an extension's dialog request is answered cancelled, and a line that is not JSON is dropped and
  named (`rpc-line-malformed`).
- The CLI is pinned (`PI_PINNED_VERSION`, `src/host/pi-binary.ts`). Its `--version` must name the
  pinned release, or pi is listed unavailable with the path, the version found and the version
  pinned. The path is the npm package's `dist/bundle/cli.js`, run under this Node. Nothing installs
  it. At start the host reads that version, writes the agent home's `models.json` and `mcp.json`, and
  runs pi once with nothing of its own and no session to list the models it reaches
  (`readPiRuntime`, `src/host/pi-runtime.ts`), closing it without a prompt.
- The base is the runner's own (`src/host/pi-home.ts`): `agent` is pi's agent home
  (`PI_CODING_AGENT_DIR`), `sessions` the store every session's file is kept in, and `run/<id>` one
  session's run directory, holding its extension's configuration (written only the runner can read,
  deleted once the extension has said hello) and its system prompt file, removed at close. A resume
  is resolved to the file in the store that carries its id and the session's working directory.
- The process (`startPiProcess`, `src/host/pi-process.ts`) is an `AgentProcess<PiMessage>`. The open
  runs in order: the session's hook channel listens, the run directory is written, pi starts, the
  extension's hello arrives (`PI_HELLO_DEADLINE_MS`), the configuration is deleted, `get_commands`
  and `get_state` are read, and the sources they and the hello name are checked; only then is the
  session ready and the first prompt written. A prompt is `prompt` with `streamingBehavior:
'followUp'`, one in flight at a time, held until the open and bounded in the host. The model and
  effort setters are `set_model` and `set_thinking_level`, thinking switches between `off` and the
  last level, and an interrupt is `abort`. After each run settles the host asks the session's
  totals (`get_session_stats`). A request member pi cannot honour (Claude's settings tiers, its hooks
  and spawner, `forwardSubagentText`, a store, a permission mode) is refused `request-key-unsupported`,
  naming it.
- The gate (`createPiSessionGate`, `src/host/pi-gate.ts`) answers the extension's asks through the
  per-call decision every runtime shares (`createCallDecision`), with `canRewriteInput: true`: the
  extension applies a rewrite to the call's input in place. Its hello is handed to the gate by the
  channel (`onHello`, `src/host/hook-channel.ts`), and the open's check (`piForeignSources`) names
  any other code `gate-foreign-extension`, lowering the opening tier (`stateSpawnDegrades`,
  `src/state/observer.ts`, with the level). A `bash` call is read as `posix` and a `powershell` call as
  `powershell` (`piShellDialect`, `src/gate/tool-kind.ts`).
- The extension (`src/host/pi-extension.ts`, built to `dist/host/pi-extension.js`) imports nothing
  from pi; its types are declared locally (`src/host/pi-extension-api.ts`, types only), and what it
  loads at run time is itself, the hook exchange (`src/gate/hook-exchange.ts`) and Node's own modules
  (`host/pi-extension.test.ts` pins that closure). It is neither a command of the package nor an
  entry point; the host finds it beside its own module (`piExtensionPath`).
- A session's plugin directories reach pi as `--skill` directories, each directory's `skills/`
  (`piSkillDirectories`, `src/host/pi-pack.ts`), its skills listed by name alone. Its MCP servers ride
  the extension's configuration (`piMcpServers`, `src/host/pi-mcp.ts`) and are registered with
  `direct` exposure. A named endpoint is written into `models.json` as a provider, its key in that
  file alone, and named on the command line by `--provider` (`src/host/pi-endpoints.ts`).
  `ENDPOINT_ROUTED_RUNTIMES` is Claude, Codex, Qwen Code and pi.
- Its messages ride as pi wrote them (`PI_MESSAGE_BINDING`): each event and record, and the answers to
  the host's own commands, is an `agent_message` with `runtime: "pi"`, a `message_update` on the delta
  lane and only for a session that asked for partial messages; the extension's hello is not
  forwarded. The observer arm (`src/state/pi-observer.ts`) records the transitions they cause under
  `agent-event` events (`AGENT_EVENTS`: `pi:` and the event's type, or the answered command's),
  `PiFactLift` (`src/host/pi-facts.ts`) lifts the facts, and `PiItemFill` (`src/host/pi-items.ts`)
  fills the conversation items, one turn from `agent_start` to `agent_settled`.
- What the pinned release declares is pinned name by name. `contracts/pi-names.json`, regenerated by
  `scripts/derive-pi-names.mjs` from the release's source, holds every event, RPC command, RPC record,
  extension UI method, message delta and built-in tool; `PI_COVERAGE` (`src/state/pi-coverage.ts`)
  holds a row for each (`pins/pi-coverage.test.ts`), and a live test holds the snapshot to the
  installed package.

## The read-only door

`src/host/repository-read.ts` is the door through which the binary serves a controller the text of
a file: under the repository root, and inside a workspace this host provisioned. Nothing in it can
write. Read-only is a property: the module's whole filesystem surface is `createReadStream`,
`readdir`, `stat` and `realpath`, held by `pins/read-door-readonly.test.ts`. Two fences hold
whatever the root is, on the lexical resolution and again on the real path: the protected set
(`credentialPaths`, the files the gate keeps from the agent) refuses `credential-path-denied`, and the
agent's projects folders (`agentTranscriptPaths`: `projects` under every agent home the protected set
names) refuse `transcripts-not-served`, so a root pointed at the agent home or the user's home reads
neither. A listing of a directory that holds a projects folder names everything else and leaves the
folder out; a protected file in a listed directory is still named, and refused when read. The asks
the wire retired are answered by name ([protocol.md](protocol.md)).

It reads the repository under `PERISCOPE_REPOSITORY_ROOT`: `repository_list` (names, sorted,
capped at `MAX_REPOSITORY_ENTRIES`) and `repository_read` (a page of text capped at
`MAX_REPOSITORY_READ_BYTES`, cut on a character boundary, with the whole size: the head of any file
at offset 0, and pages through its first `MAX_REPOSITORY_FILE_BYTES` after it); and a workspace's
directory for `workspace_read` (pages of a file up to `MAX_WORKSPACE_FILE_BYTES`). Both reads take a
page through one reader, `readTextPage`, so they cut and refuse alike: a byte is inside a character
only when a UTF-8 lead byte before it claims it, so offset 0 is never refused and text in another
encoding is walked by its `nextOffset` to the end. The jail is lexical (join,
resolve, contain) and physical (`realpath` both sides, contain again); a file whose head holds a NUL
byte refuses `repository-read-failed` rather than shipping binary as text. The listing does not
follow links; the reads do.

A repository page's `nextOffset` is composed only for a link negotiated at 18 or above, or before any
handshake (`pagedAtLinkVersion` in `src/host/host.ts`, the shape `decideAtLinkVersion` gives a
decision request): on a link at 17 the answer is the head read that version made.

## Workspaces

`WorkspaceProvider` is the seam the SDK does not have: what a workspace is. Two implementations
ship, `PlainDirProvider` and `GitWorktreeProvider`; policies (a shared directory per piece of work, a
cleanup schedule) belong to the embedder. Every result is a named refusal, never an exception.

- The binary selects the git provider on the presence of `PERISCOPE_REPOSITORY_ROOT`
  (`src/bin/workspaces.ts`). `PERISCOPE_WORKSPACE_ROOT` alone gives plain directories. Neither gives
  no provider and the controller's `cwd` verbatim, and a directory nobody created fails the spawn.
- The workspace key resolves `session_new.workspaceKey ?? PERISCOPE_WORKSPACE_KEY ?? sessionKey`,
  each a default for an absence. It is screened before any claim (`src/core/workspace-id.ts`: the
  union of git refname law and path-segment law, plus `MAX_WORKSPACE_ID_LENGTH`; the refusal names
  the character and which law rejects it), and a non-null key with no provider refuses
  `workspace-provision-failed`. Sessions can share a key; the in-use guard holds until the last
  closes, inside the per-key turn (`src/core/keyed-turns.ts` serialises provision, release and
  close per key, and different keys interleave freely).
- The branch scheme is the caller's template: `PERISCOPE_BRANCH_SCHEME` with `{key}` and `{repo}`,
  default `{repo}/{key}`. The posture is screened at start-up, fatally, by name: an unknown
  placeholder, an illegal literal, a brace that survives substitution, a dependent setting absent.
- `inventory()` lists the worktrees contained by the workspace root (never the operator's checkout),
  newest tip first, with branch, head, merged (git's answer: a squash merge reads unmerged),
  `aheadCount` and `lastCommitAt`.
- `release(key, { remove, deleteBranch, force })`: `remove` alone leaves the branch; `deleteBranch`
  deletes a merged branch; an unmerged branch refuses `branch-not-merged` and removes nothing unless
  `force`. The receipt states `directoryRemoved` and `branchDeleted` separately. A session ending
  leaves its directory; the reap is the one path that removes one.
- `host_configure` reconfigures the running host (`src/bin/reconfigure.ts`): the two roots, the
  branch scheme, the agent home and the two control-plane URLs. A root change while a session is
  open or opening refuses `config-host-busy`. The URLs and the agent home are written but apply at
  the next start, and are named in `pendingRestart` on every hello and answer until then: a session's
  gate holds the protected set it opened with, so a home applied live would be reported before its
  credential files were protected.
- Under a provider the controller's `cwd` is advisory; the `spawning` transition carries the
  directory the session got. One exception: a `cwd` equal to the provider's own `repositoryRoot`
  runs there, the operator's trusted checkout, claiming no key. A resume runs in the session's own
  working directory (the agent CLI keeps a session per directory) or refuses `resume-cwd-not-honoured`
  on the wire.

## MCP

The host's own MCP server registers tool descriptors the embedder supplies: JSON in, Zod inside
(`src/mcp/schema.ts`). An unconvertible construct is refused at registration, never widened to
`z.any()`, never skipped. No payload kind carries a descriptor. A controller declares MCP servers
through `session_new.request.mcpServers` (a name colliding with a host-registered server is
refused), and every tool they add is decided by the same gate as `Bash`. `identity` is filled by
the host at call time.

## Identity

The host signs in a real user through a generic OIDC client and presents that user's token; a
paired machine credential is the alternative for a host meant to stay up.

- The authority and client id are configuration (`PERISCOPE_IDENTITY_AUTHORITY`,
  `PERISCOPE_IDENTITY_CLIENT_ID`), never a constant; absence is a named refusal at start-up.
  Loopback with PKCE is the primary flow; the device-code flow is opt-in. `offline_access` is in
  the default scope set so an unattended host can refresh.
- `readCredential` prefers the paired credential (`p1.<hostId>.<secret>`, beside the token cache)
  over the token cache even when both exist: a refresh token dies after inactivity and a paired
  credential has no clock. A missing paired file falls through; a corrupt one is fatal, never a
  fallback. The paired credential's host id outranks `PERISCOPE_HOST_ID` at the hello.
- A controller that refuses the credential at the door (401 or 403) is `link-unauthorized`, and it
  is terminal: the process exits 1 naming it, because redialling a door that refused the identity
  is a loop with no exit.
- The token cache and the paired credential are protected by derivation: `credentialPaths(env)` is
  the one source of the gate's protected set and the cache's own location.
- File-mode privacy is measured, never assumed from the platform: `enforced`, `write-bit-only`
  (the Windows shape) or `unobservable`. A mode that is not enforced is said by name as a degrade.
- `signIn` and `signInWithDeviceCode` are exported for an embedder; the daemon does not call them.

## Persistence and telemetry

- A delivery receipt is read from raw stored entries, never from the SDK's conversation reader:
  compaction relinks `parentUuid`, so a walk cannot reach pre-compaction turns. Three defences hold
  the receipt: raw entries, a uuid anchor (never a numeric offset), and compaction-produced entries
  excluded as candidates.
- The transition log is append-only, and that is load-bearing ([state-machine.md](state-machine.md)).
- Spend is consumed as the agent reports it, per model. Nothing multiplies tokens by a rate.
- A result's spend is a running total. It accumulates across a session's turns, continues across
  a resume or a fork, and resets at `/clear`, so one turn's spend is `deltaSpend(previous, next)`.
- Seed a resumed or forked session's first result with its parent's last one, or the parent's
  spend counts twice. `costBasis` says whether a cost is list price, managed pricing, or a guess.
- The facts a controller acts on are lifted here and ride the wire typed, beside the messages they
  came from: the handle, the receipt, each result's spend, each main-thread call's context, the
  running tasks, each compaction. Reported, never derived: the Claude lift
  (`src/host/claude-facts.ts`) copies what the agent said, building on `readInitFacts` and
  `readTurnSpend`, and takes the compaction fact from the observer's `onCompaction` report. One lift
  per runtime is registered in `FACT_LIFTS`; a runtime with none sends messages and transitions only.

## What ships

- Exports are exactly `.` and `./protocol`; a third subpath would reopen the boundary
  (`pins/package-shape.test.ts`, `pins/protocol-closure.test.ts`).
- `files` is an allowlist: `dist/` and `src/` without tests, maps, pins and test support, plus
  `docs/`, `examples/`, the wire vectors, the Codex names snapshot, README, SECURITY, CHANGELOG and
  LICENSE. `npm pack` is gated against it.
- `contracts/` holds the approved snapshots: `wire-vectors/` (every payload kind byte for byte, the
  refusal and tolerance cases), `public-api.txt` (every export of both barrels with its signature),
  the installed SDK's type hash with its version, and `codex-protocol-names.json` (the names Codex's
  app-server declares at the pinned release). The wire vectors and the names snapshot ship in the
  tarball, the names because the host reads them at load; the rest stay in the repository.
  `npm run contracts:update` re-approves the vectors and the API after an intended change;
  `npm run check:drift` compares the SDK.
- The suite is `npm test`: a clean build, then every `*.test.js`. Its figure is four numbers per
  platform (tests, pass, fail, skipped) with the invocation. Live probes skip loudly unless
  `PERISCOPE_LIVE=1`.

## How not to use it

- Do not compose by hand and leave `grantOnAllow` off: the gate can refuse and cannot approve, and
  every allowed call silently fails to happen. Use `PeriscopeHost`, or set the flag and pass
  `onRefusal` and `onDegrade`.
- Do not assume the daemon signs anyone in. `login` writes the token cache; `pair` writes the
  paired credential.
- Do not assume a host's id is what its config says; the paired credential's id wins.
- Do not point a bulk `postUrl` outside the controller's own origin; it refuses
  `bulk-target-not-controller`.
- Do not expect one transport. A controller serves the WebSocket and an HTTP decision endpoint.
- Do not add an inbound port, a payload lane or a second stream consumer. Dial-out, commands only
  and a single pump are the design.
- Do not teach it a controller's vocabulary, a roster, or an interpretation of `correlationId`.
- Do not make retransmission skip deltas, and do not put deltas in a durable store; both halves are
  pinned.
- One controller and one replica per host.

## Where things live

| Path                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                       | The public barrel; anything not exported here or from `protocol.ts` is internal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/protocol.ts`                    | The `./protocol` subpath: types and runtime values whose closure reaches no `host/` file and no `node:` builtin                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/bin/`                           | The binary: `command.ts` (the verbs), `main.ts` (dispatch through `Io`), `serve.ts` (the daemon), `login.ts`, `pair.ts`, `config.ts`, `status.ts`, `posture.ts`, `workspaces.ts` (the provider selector and the scheme), `reconfigure.ts`                                                                                                                                                                                                                                                                                                                                                     |
| `src/host/`                          | The only importer of the SDK and the process-reaching builtins: `host.ts`, `agent-process.ts` (the SDK seam), `hooks.ts`, `paths.ts`, `config-file.ts`, `link-state-file.ts`, `claude-facts.ts` (the Claude fact lift), `repository-read.ts`, `bulk-post.ts`, `wire-request.ts`, `model-endpoints.ts` (the operator's model endpoints), `repository-settings.ts` (the repository-tier settings check), `sign-in.ts`, `stdio-rpc.ts` (the runtime-neutral JSON-RPC transport), `codex-*.ts` (the Codex binary, home, process, answers, wire shapes, names reader, fact lift and start-up read) |
| `src/control/`                       | The wire: `frames.ts`, `codec.ts`, `seq.ts`, `queue.ts`, `link.ts`, `link-state.ts`, `stream.ts`, `stream-routing.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/sessions/`                      | `registry.ts`, `session.ts`, `spawn-env.ts`, `fact-lift.ts` (the fact lift per runtime), `runtimes.ts` (the tier and the wire APIs per runtime)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/state/`                         | `model.ts`, `machine.ts`, `observer.ts`, `store.ts`, `coverage.ts`, `reporter.ts`, `codex-coverage.ts` (`CODEX_COVERAGE`), `codex-observer.ts` (the Codex observer arm)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/gate/`                          | `gate.ts`, `decision.ts`, `outcome.ts`, `local.ts`, `jail.ts`, `shell.ts`, `command.ts`, `escalate.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/workspace/`                     | `provider.ts`, `plain-dir.ts`, `git-worktree.ts`, `worktree-porcelain.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/identity/`                      | Generic OIDC: config, PKCE, authorize, device code, the token store, the file-mode measurement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/mcp/`                           | JSON Schema to Zod, the descriptor, the server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/persistence/`, `src/telemetry/` | The receipt, the transition log, per-model spend                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/pins/`                          | The structural tests; `walk.ts` is the tree walker they share                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `examples/`                          | The minimal controller, the reference controller with its runnable entry, and the parallel-run proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `contracts/`                         | The approved snapshots; `scripts/derive-codex-names.mjs` regenerates the Codex names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
