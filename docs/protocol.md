# The wire protocol

The contract a controller implements: the frame envelope, the payload kinds, the sequence and
retention rules, the two lanes, the bulk lane, the host-scoped asks, the refusal vocabulary and the
handshake. The `./protocol` subpath ships these types and the codec without anything that can reach
a process or a disk; `contracts/wire-vectors/` is the same contract as bytes, one JSON document per
case, which a controller in any language can read.

The protocol version is `PROTOCOL_VERSION`; the versions a host still speaks run from
`PROTOCOL_VERSION_MIN` to it. Both are exported and both are mirrored into the vectors.

## The envelope

Every frame is `{ frame, at, payload }`, with `payload` discriminated on `kind`. Keys are camelCase
and discriminator values are snake_case. Session frames add `sessionId` and `seq`:

```ts
{ frame: 'session', sessionId: 's-1', seq: 4, at: '2026-08-03T12:00:00.000Z',
  payload: { kind: 'session_update', body: { ... } } }
```

Control frames (`link_hello`, `link_welcome`, `link_ack`, `link_ping`, `link_pong`, `link_bye`)
carry no `sessionId` and no `seq`: they describe the link, and a link that dropped has no history
worth resending.

Optionality on the wire is `T | null`, never an absent key: JSON has no `undefined`, and an omitted
member cannot be told from a member set to nothing after a round trip. Every member a kind declares
is required; a frame missing one is refused `frame-malformed` by whichever side sees it first.

The one exception is a member added inside the protocol window. It is optional (`?:` in
`src/control/frames.ts`), for two reasons: a peer one release behind omits it, and a controller
written in TypeScript that builds the frame would otherwise stop compiling at a minor release. Its
absence reads as "not stated". Outside the window the rule above holds, and absent is refused.

`encode` and `decode` validate the same shapes. A frame that would not decode does not encode
either, so a malformed frame is refused at its author and never occupies a sequence number.

## Sequence numbers

1. Per session, per direction. Two sessions on one link count independently; the two directions of
   one session count independently. The first frame is `1`; `0` means "nothing yet" and is refused.
2. Dense. Each frame is the previous plus one, so the receiver's expected next is always
   `last + 1` and a gap is arithmetic, never a heuristic.
3. Minted at the first write. A `seq` is assigned when its frame is first written to the socket,
   not when it is queued, so anything refused or dropped before that moment leaves no hole.
4. Reconnect is idempotent. The wire is at-least-once; the receiver's `SeqTracker` makes it
   exactly-once. A re-delivered frame is a silent duplicate. A missing frame is a gap, reported on
   the wire as a `wire_refusal` with reason `seq-gap` and the `expected` number the sender must
   resume from; a frame below the expected position is `seq-regressed`.

A frame is retained by its sender until the receiver acknowledges it with `link_ack`, which carries
one cursor `{ sessionId, seq }` per session. Being written is not being received: a frame in flight
when a socket dies is the one replay must produce. On reconnect the host sends `link_hello` with the
cursors it holds, the controller answers `link_welcome` with the cursors it holds, and each side
replays what the other has not acknowledged, with the original sequence numbers.

The sender's mechanics (`src/control/queue.ts`, `src/control/link.ts`): `send()` is admit then
drain. A payload is probe-encoded with the widest sequence number a frame can carry, then held
pending and unnumbered in `BoundedFrameQueue`; the drain stamps the oldest pending entry at the
moment of the socket write. FIFO through one queue means a later send never overtakes a waiting
frame. At capacity the ladder is: discard the incoming droppable, displace the oldest pending
droppable, refuse loudly (`queue-overflow-undroppable`). Written frames are never victims.

## The handshake

The host dials and sends `link_hello`:

| member            | meaning                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocolVersion` | the newest version the host speaks                                                                                                                                                                                                               |
| `protocolRange`   | `{ min, max }`, every version the host speaks, inclusive                                                                                                                                                                                         |
| `hostId`          | the id the host announces; a paired credential's host id when one is presented                                                                                                                                                                   |
| `capabilities`    | an open list of markers: `bulk-post` always; exactly one `workspace:<mode>` (`workspace:none`, `workspace:plain` or `workspace:git-worktree`) always; `workspace:branch-scheme` when a scheme is set. A controller ignores what it does not know |
| `cursors`         | the host's inbound positions, one per session                                                                                                                                                                                                    |
| `configuration`   | the host's configured settings, reported and never negotiated (below); `pendingRestart` names those not yet in effect                                                                                                                            |
| `pendingRestart`  | the setting keys written over the link that apply only at the host's next start                                                                                                                                                                  |

The controller answers `link_welcome` with `protocolVersion` set to the version it chose inside the
overlap of the two windows, its own `protocolRange` (from v10; a host reads its absence as null and
never refuses it, so a v9 controller is still spoken to), its own `capabilities`, and its inbound
`cursors`. The host accepts any
version inside its own window and refuses the rest, naming both windows. A controller that finds no
overlap sends no welcome and closes the socket with code 1002 and a reason naming both windows,
which the host reads as the same refusal (`protocol_version_rejected`, a link cause). The window
opens at `PROTOCOL_VERSION_MIN`; from the next bump on it is one minor wide, the version before the
current one staying supported for one release, so a controller and a host one release apart connect
and either can move first.

A hello with no range does not decode: `protocolRange` is a declared member there. A new value in
the open `capabilities` list needs no version bump; a new hello member does. The window today is
`[17, 18]`. Version 18 adds:

- paging to `repository_read`: an optional `offset` on the ask and an optional `nextOffset` on the
  answer, with `MAX_REPOSITORY_FILE_BYTES` the most of a file the pages reach
  ([Host-scoped asks](#host-scoped-asks));
- the refusal reason `transcripts-not-served`, the answer to the asks the host no longer serves
  ([Host-scoped asks](#host-scoped-asks), [The bulk lane](#the-bulk-lane)).

It adds no payload kind. A version-17 controller reads what this build sends: the reason rides kinds
it already reads, and a reason it does not know is read as such; `nextOffset` is never composed for
a link negotiated below 18, so the answer it reads has the members version 17's had (the cut lands
on a character boundary where 1.8.2's could split one). Every frame a
version-17 controller sends decodes here unchanged, the retired asks included, so such an ask is
answered by name and the channel it rode keeps its sequence; a `repository_read` with no `offset` is
the head read. Version 14 narrowed `session_new.request.env` (below), and the
narrowing holds at every version the host negotiates. `src/host/protocol-window.test.ts` holds both
directions over a real link: every frame this host sends, a Claude session's, a Codex session's, a
Qwen Code session's and a pi session's on one link, and its answers to the retired asks and to a
`repository_read`, decodes
with the protocol-17 decoder v1.8.2 shipped, and every decision request it posts reads as that
release's `DecisionRequest`; each answer vector version 18 adds (the four `repository_read_result`
vectors and the two `transcripts-not-served` ones) decodes with that decoder, while the paged ask and
the two `refused.*` vectors are not a version-17 controller's to read; and a version-17 controller's
`session_new` and `session_configure` decode here and apply.

Two close reasons carry meaning. A close with code 1002 whose reason starts with `seq gap` is a
replay request: the controller names the position it holds, and the host's next dial replays from
it (link cause `replay_requested`). Any other 1002 close is read as the version refusal above.

`configuration` is a `HostConfiguration`: seven strings, each `T | null`, in this order:
`repositoryRoot`, `workspaceRoot`, `branchScheme` (the effective scheme, `{repo}/{key}` when none is
configured), `transcriptsRoot` (always null; kept because a controller inside the window requires
it), `controllerUrl`, `decisionUrl`, `agentHome` — each at most `MAX_CONFIGURATION_VALUE_LENGTH` — and,
from v11, `plugins`: the plugin directories the host loads into every session, each as
`{ name, version, path }` from its manifest (`version` null when the manifest declares none), at
most `MAX_PLUGIN_DIRS` entries. A controller that wants a session to have a plugin reads this list
before it opens one; a host with none configured reports an empty list.

From v12, `configuration.agent` carries the agent this host runs sessions on, and is optional:

- `claudeCodeVersion` and `sdkVersion`: the Claude Code version the installed agent SDK bundles, and
  that SDK's version.
- `models`: the models the agent offers, each `{ value, resolvedModel, displayName, description,
supportedEffortLevels, supportsFastMode, supportsAutoMode, supportsAdaptiveThinking }`.
  - `value` is what `session_new` and `session_configure` take as `model`.
  - `resolvedModel` is the model id an alias stands for, so a stored explicit id can be matched to
    the alias that covers it.
  - The three `supports*` members are null when the agent did not say.

The host reads the catalog once at start, by starting the agent with a prompt stream that never
yields and reading its answer to the SDK's initialize request, so no model is called. Its bounds
are `MAX_AGENT_MODELS` entries and `MAX_AGENT_CATALOG_BYTES` of JSON. A hello past
`MAX_FRAME_BYTES` would not be sent at all, so a catalog past either bound rides as `agent: null`.

- **null:** the host asked and got nothing it can carry. It names the reason on its own trace.
- **Absent:** the host was composed without a catalog read, or runs one release behind.

A `host_configure_result` carries the same `agent`.

From v15, `configuration.agents` lists the runtimes the host can spawn sessions on, one
`HostAgentEntry` each, at most `MAX_AGENT_ENTRIES`, and is optional:

- `runtime`: the name a `session_new` names it by (`claude`, `codex`, `qwen-code`, `pi`).
- `version` and `sdkVersion`: the runtime's own version, and the version of the library the host
  drives it through, null when there is none. Claude's are `agent`'s `claudeCodeVersion` and
  `sdkVersion`; Codex's `version` is its app-server's, Qwen Code's and pi's their CLIs', and the
  `sdkVersion` of each is null.
- `models`: the models it offers, each a `HostModel` as above.
- `vocabularies`: `{ permissionModes, efforts, thinking }`, the words a `session_new` or
  `session_configure` may name for it, and whether it takes a thinking control.
- `controlTier`: the tier a session on it starts at (below).
- `available` and `unavailableReason`: a configured runtime that cannot run now (its binary absent
  or off its pinned version, its sign-in missing) is listed `available: false` with the reason, and a
  `session_new` naming it is refused `runtime-unavailable`. Claude is always available.

This host lists Claude, built from the same catalog read `agent` carries, then Codex, then Qwen
Code and then pi when its operator configured each ([configuration](configuration.md)), so `agents` is null when
`agent` is null and absent when it is absent. Codex's entry is its pinned version, the models its app-server
lists, the permission modes `default`, `dontAsk` and `bypassPermissions`, the efforts its models
list, `thinking` true only when a listed model takes the effort `none`, and the tier
`intercepted-with-residual`, with `gate-sandbox-absent` among its degrades where Windows reports no
sandbox ready. Qwen Code's entry is its pinned version, no models (a Qwen Code session's model is
an endpoint's, and the session names it), the permission modes `bypassPermissions`, `default` and
`plan`, the efforts `low`, `medium`, `high`, `xhigh` and `max`, `thinking` false, and the tier
`intercepted-with-residual`. pi's entry is its pinned version, the models it reaches as
`provider/id` (read at start from a pi with nothing of its own and no session; none when that read
fails or is past the hello's bounds), each listing the six efforts when it reasons and none when it
does not, no permission modes, the efforts `minimal`, `low`, `medium`, `high`, `xhigh` and `max`
(pi's thinking levels), `thinking` true, and the tier `intercepted`. The whole list is held to `MAX_AGENT_CATALOG_BYTES` as JSON. Claude's entry is placed first, and a later
entry that would push the list past the budget rides with `models: []`, named once, so one
runtime's catalog never empties another's; a list Claude's entry alone cannot fit takes the catalog
with it, both riding null. A `host_configure_result` carries the same `agents`.

From v15, `configuration.endpoints` lists the model endpoints the host's operator declared, one
`HostEndpoint` each, at most `MAX_ENDPOINTS`, and is optional:

- `name`: what `session_new.request.endpoint` names it by.
- `wireApi`: the API the endpoint speaks, one of `ENDPOINT_WIRE_APIS` (`anthropic-messages`,
  `openai-responses`, `openai-chat`). A wire API a newer peer adds is read; the host sends only the
  ones it declares.
- `runtimes`: the runtimes that can reach it. Each speaks the endpoint's wire API (Claude speaks
  `anthropic-messages`, Codex `openai-responses`, Qwen Code and pi all three), and the host refuses
  at start
  an endpoint naming
  one that does not, and lists a runtime only where it routes it and it speaks the API, so a
  controller filters its picker on `runtimes` with no table of its own.
- `models`: every model id a session may name on it, at most `MAX_ENDPOINT_MODELS`: the endpoint's
  own ids, as the agent sends them (a `[1m]` suffix included where the endpoint declares one), and
  the alias ids (`opus`, `sonnet`, `haiku`, `fable`) the endpoint maps to them.

An endpoint's address, its credential, and whether it is Anthropic's own route stay with the host,
and none of them is on the wire. The list is the operator's configuration (`PERISCOPE_MODEL_ENDPOINTS`,
[configuration](configuration.md)), so it is absent when none is declared, and it is held to its own
`MAX_ENDPOINT_CATALOG_BYTES` of JSON beside the catalog's budget: the host refuses at start a list past
it, rather than letting it push the runtimes list out of the hello. With every bound on the hello
filled, the hello still fits `MAX_FRAME_BYTES` (`src/control/codec-endpoints.test.ts`). A
`host_configure_result` carries the same `endpoints`.

From v16, `configuration.agentSkills` says how each runtime `agents` lists takes plugin directories,
one `HostAgentSkills` each, and is optional. It rides with `agents`: null when `agents` is null and
absent when it is absent. A runtime it does not list cannot take plugin directories.

- `runtime`: the runtime, as `agents` names it.
- `naming` (`SKILL_NAMINGS`): `namespaced` when the runtime lists a plugin's skills under the
  plugin's own name (`plugin:skill`), `bare` when it lists them by the skill's name alone.
- `delivery` (`SKILL_DELIVERIES`): `per-session` when the runtime takes the directories with each
  session's request, `per-process` when this host hands them to the runtime's process as it starts,
  `workspace` when the runtime takes only what is already in the session's directory.

Claude is `namespaced`, `per-session`: the agent CLI's plugin directories. Codex is `namespaced`,
`per-process`: each directory is a skill root of the session's own app-server. Qwen Code is `bare`,
`per-session`: each directory's `skills/` is a skill directory in the session's own settings, and the
CLI lists its skills by name alone. pi is `bare`, `per-session`: each directory's `skills/` is handed
to the session's pi as a skill directory on its command line, and pi lists its skills by name alone. A word a newer peer
adds is read; the host sends only the words it declares.

## The credential on the three transports

A host presents one credential, the same on every transport it uses, as an `Authorization` header:
`Authorization: Bearer <credential>` on the WebSocket upgrade request, on every decision POST and
on every bulk POST. What the bearer is depends on how the host was set up: a paired machine
credential (below), a signed-in user's access token, or nothing, in which case the host connects
with no header and says so at start-up.

What a controller does with it:

- At the upgrade, answer 401 or 403 to refuse the credential. The host reads either as
  `link-unauthorized`, which is terminal: the process exits non-zero naming the remedy (`periscope
pair <code>` for a paired host, `periscope login` otherwise), because redialling a door that has
  refused the identity is a loop with no exit. Any other failure to open is retried with backoff.
- On a decision POST, answer non-2xx to refuse the credential. The host reads it as an outage, and
  an outage refuses the tool (`permission-decision-unavailable`); nothing is retried.
- On a bulk POST, answer non-2xx to refuse. The host reports `bulk_failed` with
  `bulk-delivery-failed`.
- A controller MAY bind the hello's `hostId` to the credential it minted and refuse a hello whose
  `hostId` is not the one the bearer speaks for. A paired host announces the id embedded in its
  credential, so the two agree unless the file was tampered with.

## Pairing

Pairing is how an unattended host gets a durable credential without a user's token expiring under
it. It is an HTTP exchange the controller serves beside the link; nothing about it rides the wire.

1. A signed-in user asks the controller for a short-lived, single-use pair code. How the code is
   minted is the controller's own (the reference controller serves `POST /api/periscope/pair-codes`;
   yours may differ).
2. The operator runs `periscope pair <code> --controller <origin> --label <name>` on the machine.
   The host POSTs to the redemption route: `--controller`'s origin plus `/api/periscope/pair` when
   the flag is given, else `PERISCOPE_PAIR_URL` verbatim, else the origin of `PERISCOPE_DECISION_URL`
   plus that route. Request: `content-type: application/json`, body `{ "code": string,
"machineLabel": string }` (`--label`, else `PERISCOPE_MACHINE_LABEL`, else the hostname).
3. The controller answers 2xx with a JSON object carrying `hostId` (string, non-empty) and
   `hostCredential` (string, the bearer), and optionally `controllerUrl` (`ws:`/`wss:`) and
   `decisionUrl` (`http:`/`https:`): the two addresses this host should dial. When both are present
   the host writes them to its config file, so `serve` needs nothing else. Any non-2xx is read as a
   refused code (unknown, expired and consumed answer identically; the remedy is a fresh code), except
   404 and 405, which the host names as a wrong door.
4. **The bearer has a shape, and it is an obligation:** `p1.<hostId>.<secret>`, where `<hostId>` is
   exactly the `hostId` in the same answer and `<secret>` is non-empty. The host reads its own id out
   of the credential at every start and refuses a file whose two copies disagree; `pair` refuses an
   answer outside this shape before writing anything. The controller stores a hash of the secret and
   this machine holds the one copy.
5. From then on the host presents `Authorization: Bearer p1.<hostId>.<secret>` on all three
   transports and announces `<hostId>` in its hello.

Revocation is the controller's: refuse the bearer at the upgrade (401/403) and close the link; the
host exits naming the remedy. Re-pairing mints a new bearer; a controller should invalidate the old
one when it does.

## Heartbeat and close

The host sends `link_ping` with a `nonce` every `heartbeatIntervalMs` (default 15 s) and expects
`link_pong` with the same nonce inside `heartbeatTimeoutMs` (default 45 s); a missed pong tears the
socket down and re-dials, as does a dial that produces no open inside `connectTimeoutMs` (default
15 s). The three are `PeriscopeHostOptions.linkTimings`; the defaults are `DEFAULTS` in
`src/control/link.ts`. The controller may ping too and the host answers. Control frames are written
ahead of any queued session frame, so a heartbeat is never delayed by a backed-up session lane.
`link_bye` carries a `cause` and ends the link on purpose.

The link's own states are `idle`, `connecting`, `open`, `accepted` (the welcome arrived), `backoff`
and `closed`; `LINK_CAUSES` (`src/control/link-state.ts`) is the closed list of what moves it. A
credential the controller refuses at the upgrade is the one cause that ends in `closed` without a
shutdown having been requested.

## The two lanes

`session_update` carries facts: an assistant message, a result with its usage, every state
transition the session machine records, the session's end, and a `wire_refusal`. It is retained
until acknowledged and replayed after a reconnect.

`session_delta` carries fragments something later restates: streamed text, thinking prose,
progress. It is the only droppable kind (`DROPPABLE_KINDS`): a full outbound queue discards deltas
and refuses to lose anything else. A delta that has already been numbered is still retransmitted
after a drop, because a minted number must be accounted for or the receiver holds a gap it can
never fill. A delta never enters a durable store; the two halves of that rule point opposite ways
and both are pinned (`stream-replay.test.ts`).

`MESSAGE_ROUTING` (`src/control/stream-routing.ts`) names the lane for every SDK message
discriminator: delta, update or declined with a reason. `forwardSession` puts each message on its
lane, then the facts and fragments it carries (below), then the transitions that message caused,
message first, so a consumer never sees a state change referring to a message it does not have, nor
a fact whose message it does not have.

`session_update.body` is an open JSON object read through typed readers: `readStateTransition`,
`readAgentMessage`, `readWireRefusal` (`{ refusal, expected, received }`; `expected` is the seq the
receiver will accept next on the refused party's own outbound lane), `readAgentFacts`,
`readAgentItem`.
`wire_refusal` is a body member, not a payload kind, so a refusal rides the same fact lane it
refuses. `session_delta.body` is open JSON in the same way, a `SessionDeltaBody` read through
`readAgentMessage` and `readAgentFragment`. A controller carries unknown keys through and must not
narrow the body. The codec checks the members the fact layer and the item stream declare (below)
and nothing else in a body.

`agent_message` carries `runtime`, the runtime that emitted the message, from v15. Absent means
`claude` (`DEFAULT_RUNTIME`): a Claude session's messages omit it, so their bodies are unchanged.
A Codex session's messages carry `runtime: "codex"`, and each `message` is what its app-server
sent: a notification as `{ method, params }`, a request it made of the host as
`{ id, method, params }`. The three text deltas (`item/agentMessage/delta`,
`item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`) ride the delta lane and everything
else the update lane; the answers to the host's own requests are not forwarded. Which notifications
move the session is `CODEX_COVERAGE` ([state-machine.md](state-machine.md)).

A Qwen Code session's messages carry `runtime: "qwen-code"`, and each `message` is what its CLI wrote
on stdout: a stream message as the CLI wrote it (`system`, `assistant`, `user`, `result`,
`stream_event`), and a control request it made of the host as
`{ type: 'control_request', request_id, request }`. A `stream_event` rides the delta lane and
everything else the update lane; the answers to the host's own control requests, and the prompts the
host wrote, are not forwarded. Which messages move the session is `QWEN_COVERAGE`
([state-machine.md](state-machine.md)). A session whose CLI has no model it can reach gets one error
`result` whose `num_turns` is 0 and whose `error.message` names the missing auth type or key, written
before the CLI answers `initialize`, and then the CLI exits: that result is a Qwen Code session's
sign-in marker.

A pi session's messages carry `runtime: "pi"`, and each `message` is what pi wrote on stdout in RPC
mode, or its answer to one of the host's commands: an event as pi wrote it (`agent_start`,
`message_end`, `tool_execution_start`, `agent_settled`, and the rest), a record (`extension_error`,
`extension_ui_request`), and pi's answers to the host's `get_commands`, `get_state`, `prompt`,
setters, `abort` and `get_session_stats` as `{ type: 'response', command, success, data }` or with
`error`. A `message_update` rides the delta lane, and only for a session that asked for partial
messages; everything else the update lane. Which messages move the session is `PI_COVERAGE`
([state-machine.md](state-machine.md)). pi writes no sign-in event; a session with no model it can
reach meets one of three markers: pi exits before the session opens (`No models available`, naming
`/login`), and the session ends with cause `process/process_failed`, its detail `the pi CLI exited
(...)` and the last line pi wrote to standard error, which for that message is the documentation
path pi prints after it; the answer to a `prompt` is `success: false` with an `error`
starting `No API key found for ` or `Authentication failed for `; or a run's answer is a
`message_end` whose `stopReason` is `error`, its `errorMessage` the provider's own refusal.

A forwarded message's body, on either lane, carries `observedAt` (v12): the instant, ISO-8601 in
UTC, this host took the message off the agent's stream. Date a message by it rather than by its
arrival: a message replayed after a reconnect arrives late, and a clock started at arrival runs
late with it. `readObservedAt` returns null for a host one release behind.

A consumer folding deltas into rendered state must return a new top-level reference for every real
change and the same reference for a true no-op. Hosts bind rendered state through a default
reference-equality check, so a fold that mutates in place and returns the object it was given
produces no notification at all: mid-turn painting stops, with no error and no missing frame, and
only resumes when something else replaces the reference. Stated at `SessionDelta` too, because it
fails silently.

Thinking is a per-session knob, and its default is deliberate. `includePartialMessages` is on, so a
turn can be rendered as it happens; `thinking` is left at the SDK's own default, which fires
`thinking_delta` events with empty prose. Ask for `{ type: 'adaptive', display: 'summarized' }` in
`session_new.request.thinking` and real reasoning prose streams (measured against the pinned SDK: 0
characters by default, 227 over 4 deltas with `summarized`, same prompt). It is opt-in because that
prose costs tokens on the wire and puts reasoning text into the session's history and mirrors;
whether a run is watched is not something the host can know, so it offers the knob instead of
guessing a policy.

## The fact layer

A controller acts on a handful of facts: which session it can resume, what the agent says it is
running with, what a turn cost, how full the context is, which tasks are running, and when the
context was compacted. Each runtime reports them in its own message shapes. From v15 the host lifts
them into typed members and puts each on the update lane as an `agent_facts` body,
`{ update: 'agent_facts', fact, sourceId?, observedAt? }`, right behind the message it came from.
The message still rides; a consumer that wants it whole still has it.

| `fact.kind`      | What it states                                                                                                             | Claude's source                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `session_handle` | `handle`: the runtime's own resumable id                                                                                   | `system/init.session_id`, when it first appears or changes                   |
| `agent_receipt`  | the version, model, approval mode, effort, skills, plugins, plugin errors and MCP servers                                  | `system/init`, when any member differs from the last receipt                 |
| `turn_record`    | `totals` and `turn`, each a `SpendFacts`, with `turnScope`, `numTurns`, `durationMs`                                       | each `result`                                                                |
| `usage_sample`   | `contextTokens`, `contextWindow`, `cacheTtl`, `cacheReadTokens` and `mainThread` for one model call                        | each main-thread `assistant` call, once per API message id                   |
| `tasks`          | `running`: every task running now, whole, and `settled`: the tasks ended since the turn began; each fact replaces the last | `background_tasks_changed` and the task edges, composed; `task_notification` |
| `compaction`     | `status` (`started`, `ended`), `trigger`, `tokensBefore`, `tokensAfter`                                                    | the observer's compaction entry opening and closing                          |

Codex's sources: `session_handle` is the thread id the opening answer names; `agent_receipt` is
built from the opening answers, so it rides before `ready`, and sent again on a reroute, a skills
change, an MCP server's status, and a setter applied on a `turn/start` (`source: 'host'`);
`turn_record` is each `turn/completed`, its `totals` the newest `thread/tokenUsage/updated` and its
`turn` and `turnScope` null, because Codex's per-call figure is not a turn; `usage_sample` is each
`thread/tokenUsage/updated`, the last call's total as the context; `tasks` is the running
sub-agents, and the sub-agents settled since the turn began. Codex's usage names no model, so its
figures are filed under the model the thread opened on, moved by a model a `turn/start` sends and by
a reroute.

Qwen Code's sources: `session_handle` is the session id the answer to the host's `initialize` names,
and again when an init names another (a resume or a fork); `agent_receipt` is composed by the host at
that answer (`source: 'host'`, the skills it handed over), then the CLI's own once its context usage
lists the skills it found (`source: 'runtime'`), and again whenever an init moves a member, the
permission mode in Qwen Code's own word; `turn_record` is each `result`, its `totals` the CLI's
running total for the session and its `turn` and `turnScope` null, a resumed or forked session's total
including the source's tokens, with no cost and no cache writes; `usage_sample` is each answer to the
context-usage request the host sends after each `result`; `tasks` is the background tasks the CLI
reports started and settled. `inputTokens` is the CLI's input less its cached input, floored at zero.

pi's sources: `session_handle` is the session id the answer to the host's `get_state` names;
`agent_receipt` is pi's own (`source: 'runtime'`) once the session opens: the model and thinking
level its state names (`effort` is the thinking level), the skills its command list names, and the
MCP servers the host's extension registered, with no permission mode. It is sent again when pi says
its thinking level moved, and one composed by the host (`source: 'host'`) follows a model the host
set, for which pi writes no event. `turn_record` is the answer to `get_session_stats`, which the host
asks after each run: its `totals` are pi's running totals for the session, tokens and a cost in US
dollars pi estimates from its own model catalogue (`costBasis: 'catalogue-estimated'`, never a bill),
and its `turn` and `turnScope` null. pi counts every entry of the session's file, its compacted
history, abandoned branches, failed retries and compaction calls included, so a total can exceed what
the visible conversation used, and a resumed or forked session's includes the source's.
`inputTokens` is pi's `input`, which pi counts without the cached input; pi states no reasoning
figure. `usage_sample` is the same answer's context usage; `compaction` is each compaction pi
reports, its `tokensAfter` null, since pi states only an estimate; `tasks` is not sent. pi's messages
carry no id, so a pi fact's `sourceId` is null.

Every fact carries `runtime`. `sourceId` is the id of the native message the fact was lifted from
(Claude: the message's `uuid`, the same id its `agent_message` carries) and null for a fact lifted
from a hook or the observer; ingest facts idempotently on it, so a replayed or re-sent fact lands
once. `observedAt` is the instant the host took the source off the stream.

**Reported, never derived.** Every figure is one the runtime reported, or null. Nothing is computed
from another figure: `totals` is never summed from turns and `turn` is never differenced from
totals. The one stated counting rule is Claude's `contextTokens`, the sum Claude Code itself counts
a call's context by: input, cache reads and cache writes.

`turn_record`:

- `totals` is the runtime's running total for the session; `turn` is the figure for what
  `turnScope` names: `turn` a whole turn, `step` one model step inside a turn. `turnScope` is null
  exactly when `turn` is.
- Claude's `totals` is the result's `total_cost_usd` in `USD`, with one row per `modelUsage` key.
  Claude's `turn` is the result's own `usage`, which covers the turn's main loop and names no model:
  the host files it under the model the latest `system/init` reported, as attribution, with no cost
  and the basis `unreported`. With no init seen yet, `turn` and `turnScope` are null; the host never
  invents a model key.
- A `SpendFacts` is `{ cost, currency, costBasis, byModel }`. `currency` is an ISO 4217 code.
  `ModelSpendFact.inputTokens` counts uncached input only, on every runtime: cache reads and cache
  writes are counted apart.
- `costBasis` on a row says where its cost came from: `list`, `managed`, `guessed`,
  `provider-reported`, `catalogue-estimated`, `self-hosted` or `unreported` (`COST_BASES`). Claude's
  `list` and `managed` are themselves, its `unknown` is `guessed`, and an absent basis is `list`, as
  the SDK says to read it. A figure's own `costBasis` is a roll-up: the weakest row basis, `guessed`
  over `managed` over `list`, and `list` with no rows. Every row keeps its exact basis, and a
  controller prices rows.

`usage_sample` states one main-thread model call: Claude's `contextTokens` is that call's input plus
cache reads plus cache writes; `contextWindow` is the window the latest result reported for the
call's model (a `modelUsage` key naming it exactly, with a bracketed selector such as `[1m]`, or
through its canonical model), and null until a result has named one; `cacheTtl` is `1h` when the
call wrote hour-long cache tokens, else `5m` when it wrote five-minute ones, else null. A call that
arrives as several messages is sampled once, by its API message id. From v16 `cacheReadTokens` is the
tokens the call read from the cache, as reported (Claude: the call's `cache_read_input_tokens`;
Codex: the last call's cached input), and null when not reported: a call that read the cache and
wrote none is told apart from one that touched it not at all.

`tasks` is a level: `running` is every task running now, so each fact replaces the last. Claude's is
composed from the level message and the task edges: the level replaces itself with its non-ambient
entries; a non-ambient `task_started` of type `local_agent` adds an edge when its id is absent; a
`task_notification` removes that edge and never a level entry; a `result` clears every edge; and
`running` is the level, then the edges the level lacks, by id. From v16 `settled` lists the tasks the
runtime says ended since the turn began, each `{ taskId, type, status }` with `status` one of
`TASK_SETTLEMENTS` (`completed`, `failed`, `stopped`) and `type` the one it started with, null when
the host never saw it start. Claude's is each `task_notification`'s status, cleared by the init the
next turn begins with; Codex's is each sub-agent a collaboration call reports settled (`errored` is
`failed`, `shutdown` and `notFound` are `stopped`) or its activity ends (`interrupted` is `stopped`),
cleared at the next `turn/started`. A fact whose only news is a settlement restates `running`
unchanged.

`agent_receipt` carries `effortReported` from v16: true when the runtime's report stated an effort at
all, so a null `effort` means no effort is in force; false when its report carried none, so a null
`effort` says nothing. Claude's init omits `effort` on a CLI that does not publish it and states null
when no effort will be sent; Codex's thread answer always states it.

`compaction` reports `started` when the observer's compaction entry opens and `ended` when it
closes, with what the source that moved it stated: the compaction hooks state the trigger, the
`compact_boundary` message the trigger and both token counts, the status message nothing.

**Whole numbers.** `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
`reasoningTokens`, `contextTokens`, `contextWindow`, `numTurns`, `durationMs`, `tokensBefore` and
`tokensAfter` are non-negative integers on the wire, and an item's `exitCode` an integer; the codec
refuses any other number there with `frame-malformed`. A cost is any non-negative number. The codec
spells each as `<member>: z.number().int()`, which a consumer generating its readers from the source
reads (`src/pins/wire-counts.test.ts`).

**Vocabularies.** Every closed set a fact names is an exported array: `COST_BASES`, `TURN_SCOPES`,
`RECEIPT_SOURCES`, `CACHE_TTLS`, `COMPACTION_STATUSES`, `COMPACTION_TRIGGERS`, `FRAGMENT_CHANNELS`,
`TASK_SETTLEMENTS`.
A word outside one is read on the way in, so a newer peer's added word survives, and refused on the
way out: this host sends only the words it declares. A fact `kind` this build does not model decodes
and reads as null through `readAgentFacts`.

**Bounds.** A fact's lists hold at most `MAX_FACT_LIST_ENTRIES` entries, its free text at most
`MAX_FACT_TEXT_LENGTH` characters and its words at most `MAX_FACT_WORD_LENGTH`; `MAX_FRAME_BYTES`
stays the outer guard.

Every member a fact declares is optional on the wire: a peer that omits one is read as not stating
it. Only `fact` itself and its `kind` are required in an `agent_facts` body.

**Fragments.** From v15 a streamed message's content also rides the delta lane as `agent_fragment`
bodies, `{ update: 'agent_fragment', runtime, channel, text, parentId }`: one per content delta, on
the channel `text`, `thinking` or `tool_input` (a tool's arguments as they stream, which is partial
JSON and never prose). `parentId` names the tool call that spawned the subagent speaking, and is
null on the main thread. The `agent_message` delta it came from still rides beside it. A fragment is
a delta like any other: droppable, and never stored.

## The conversation item stream

From v16 the session's conversation also rides the update lane as items, one shape for every
runtime: `{ update: 'agent_item', runtime, item, observedAt? }`, read through `readAgentItem`. A
consumer folds every runtime's conversation with one reader; the native message still rides
`agent_message` beside the items, for a session store and anyone who wants it whole. Items are
an addition: every other frame a session sends is the same with them or without them
(`src/host/claude-wire-replay.test.ts` holds Claude's recorded wire both ways).

An item is tagged by `kind`, and every item carries `itemId`, `turnId` and `truncated`:

| `item.kind`   | Its members                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `turn`        | `status` (`started`, `completed`, `interrupted`, `failed`), `detail`: why it ended, where stated                       |
| `user_text`   | `text`: the prompt as the runtime received it                                                                          |
| `agent_text`  | `text`, `final`: true where the runtime marks the text as the turn's answer, false interim, null where it does not say |
| `thinking`    | `text`, `summary`: true for a reasoning summary, false for the reasoning itself; empty where kept back                 |
| `tool_call`   | `toolUseId`, `toolName`, `toolKind` (one of `TOOL_KINDS`, the gate's tool kinds), `input`                              |
| `tool_result` | `toolUseId`, `status` (`completed`, `failed`, `declined`, `blocked`), `output`, `exitCode`, `durationMs`, `changes`    |
| `plan`        | `text`: the agent's plan                                                                                               |
| `notice`      | `level` (`info`, `warning`, `error`), `text`: a warning, a retry, an error the runtime reported                        |

- `tool_result.status` is `blocked` when this host's gate refused the call, and `declined` when the
  runtime's own approval or permission check answered no. `changes` lists the files a call changed,
  each `{ path, change, movePath, diff }` with `change` one of `add`, `delete`, `update`.
- **Reported, never synthesized.** A runtime fills only the kinds its events carry, and a member it
  did not report is null: Claude states no exit code, duration or `final`; Codex states `final` only
  where it gives a message stage. Nothing is computed.
- **Which text is the turn's answer** is the consumer's reading: the last `agent_text` of the turn
  with `final` true, else the last with `final` null. Claude marks none, so its answer is the turn's
  last `agent_text`.
- **Once, complete.** An item is emitted once, when what it states is known: a `tool_call` when the
  call is known, its `tool_result` when it ends. Streaming text rides the fragments.
- **Ids.** `itemId` is unique within the session, so ingest is idempotent on it: the runtime's own id
  where it has one (a tool use, a Codex item), with a suffix where one source yields two items
  (`:result`, `:raw`, `:started`, `:completed`), and otherwise its message's id and the block's index,
  or, for a Claude prompt, the periscope session's key and the prompt's count. `turnId` is the
  runtime's turn id, and null where it has none (every Claude item).
- **The budget.** An item takes at most `MAX_AGENT_ITEM_BYTES` as JSON. A text member past it is cut
  at a character and the item says so in `truncated`; a tool call's `input` past it is left out whole
  (`input: null`, `truncated: true`), never cut. The codec refuses an item past the budget.
- **The main thread.** Items state the session's own conversation. A subagent's (Claude) or a
  sub-agent thread's (Codex) messages ride `agent_message` and fill no item; its call and result in
  the main conversation do.

Claude's items come from `UserPromptSubmit` (the turn's start and its prompt), each assistant
`text`, `thinking`, `redacted_thinking` and `tool_use` block, each `tool_result` block, each `result`
(the turn's end), `system/compact_boundary` and `system/api_retry` (`CLAUDE_ITEM_COVERAGE`,
`src/host/claude-items.ts`, keyed by the SDK's own message and block kinds). Codex's come from its
turn and item notifications, its plan updates and its notices (`CODEX_ITEM_FILLS`,
`src/host/codex-items.ts`, and each `CODEX_COVERAGE` row's note). pi's come from its runs, the turn
running from `agent_start` to `agent_settled` (a pi turn is one model call, so the conversation's turn
is the whole run a prompt starts), its user and assistant `message_end`s, each `tool_execution_end`,
and its retries, failed compactions, extension errors and notifications (`PiItemFill`,
`src/host/pi-items.ts`, and each `PI_COVERAGE` row's note); a pi item's `turnId` is null.

A kind or a vocabulary word a newer peer adds is read on the way in and refused on the way out; an
item kind this build does not model decodes and reads as null through `readAgentItem`. Every member
an item declares is optional on the wire, beside `item` and its `kind`.

## The control tier

How much of a session's tool use the host can see and stop is stated as its control tier,
`ControlTier { level, degrades }`, from v15. `level` is one of `CONTROL_TIER_LEVELS`, strongest
first:

- `intercepted`: every tool call reaches the gate before it runs, and the gate's answer holds;
- `intercepted-with-residual`: the same, except for the paths `degrades` names;
- `cooperative`: the agent reports its calls and asks, but nothing stops one it does not ask about;
- `none`: the session is observed and driven, and no call is held for a decision.

`degrades` names the paths that fall below the level, each a word, and is empty when none does.
The tier rides `controlTier` on the session's first transition into `ready`, the one where the agent
reports itself, and on no other transition; and in each `HostAgentEntry` of the hello. Both come
from one lookup per runtime, so they state the same level; a session's own `degrades` add what is
known for it alone when it opens. A Claude session is `{ level: 'intercepted', degrades: [] }`: every
tool call reaches the `PreToolUse` gate under every permission mode. A Codex session is
`intercepted-with-residual`: every call Codex's hook sees, and every approval it asks for, is decided
by the gate, and its opening `degrades` name `gate-hook-foreign`, `gate-project-config-active` and
`gate-sandbox-absent` when they hold for it. A Qwen Code session is `intercepted-with-residual`:
the settings the host writes for it send every tool the CLI ships, and each attached MCP server's,
to ask, and the gate decides every ask; its opening `degrades` name `gate-credential-in-shell` when a
variables file the CLI loads, or the endpoint's own variables, would reach the agent's shell. A pi
session is `intercepted`: pi has no permission system, and periscope's extension, the last handler
every tool call meets, asks the gate about each before it runs; its opening `degrades` name
`gate-foreign-extension` when code this host did not load is in the session, and
`gate-credential-in-shell` when the endpoint's own variables would reach the agent's shell, and
either lowers its level to `intercepted-with-residual`. The tier is stated, never negotiated, and the
host decides nothing by it.

**Degrades raised mid-session.** A degrade is a `RefusalReason` that names a path where a call ran
undecided, or where the session lost a guarantee; it never means the call was stopped, and it never
stops the session. One raised after the opening transition rides the session's state lane as a
same-state transition with cause `{ kind: 'refusal', event: <the degrade>, detail }`, once per call.
Codex's are `gate-hook-timed-out`, `gate-hook-unspawnable`, `gate-hook-output-rejected`,
`gate-hook-missing`, `gate-unhooked-call`, `gate-approval-unanswered` (the approval was declined at
the host's deadline), `gate-approval-auto-reviewed` and `gate-approval-ambiguous` (an MCP approval
that could not be tied to one call, declined); the three known at the open are also raised once each,
with their detail. A Codex session's transport refusals (`rpc-*`) ride the same lane, once per reason.
Qwen Code's are `gate-tool-unruled` (its first init lists a tool no ask rule names, so a call to it
the CLI allows by default runs without asking; once per tool) and `gate-mode-widened` (the CLI reports
a mode other than `default` or `plan`; once per mode); the one known at the open is also raised once,
with its detail. pi's two are known at the open, and each is raised once, with its detail. None of these is `permission-decision-unavailable`, which means the tool did not run.
A Codex open whose hook is not trusted and enabled is refused `codex-hook-not-active`, and a Qwen Code
open whose settings could not be written, or do not read back asking about every built-in tool with
every hook off, is refused `qwen-ask-rules-not-active`, and a pi open whose extension did not say
hello in time, or that pi would not load, is refused `pi-extension-not-active`: a refusal transition
on this lane, then the session's end.

A level outside `CONTROL_TIER_LEVELS` is read on the way in, so a newer peer's added level survives,
and refused on the way out. The codec checks a transition's `controlTier` and nothing else in it.
Its level and each degrade are at most `MAX_FACT_WORD_LENGTH` characters, with at most
`MAX_FACT_LIST_ENTRIES` degrades.

## Under load, and overnight

|                                           |                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backoff**                               | Exponential and jittered. Without the jitter, a controller restart brings every host back in lockstep and knocks it over again                                                                                                                                                                                                                                                                                    |
| **Offline queue**                         | Bounded. What it drops is a decision: `session_delta` is droppable; transitions and receipts are not, and a forced drop of one is a named refusal rather than a silent loss. Only entries awaiting their first write can be dropped; a frame that has touched the wire is retained until acked, and every drop is reported, never counted silently                                                                |
| **Backpressure**                          | Above the high-water mark the link stops writing and queues. A slow controller slows the host down; it never grows its heap. The drain resumes the flow the moment the buffer empties: delivery never waits for a reconnect, and a later send never overtakes a queued frame                                                                                                                                      |
| **Control frames bypass backpressure**    | Deliberate. `link_ping`, `link_pong` and `link_bye` are written immediately whatever the buffer holds, because they are how the link's own health is judged: a heartbeat queued behind a backed-up session lane does not arrive late, it arrives after the peer has concluded the socket is dead. They are small, bounded, unsequenced and never replayed, so they cannot displace a session frame or leave a gap |
| **Admission is conservative by 15 bytes** | A payload within 15 bytes of `MAX_FRAME_BYTES` is refused although its real frame would have fitted, because admission probes with the widest `seq` a frame could ever carry. The alternative lets a frame pass admission and then fail to encode at write time, with the caller long gone. A rejection someone can act on beats a hole nobody can see                                                            |
| **Heartbeat**                             | Both directions. A half-open socket looks alive to TCP and reads as a hung session to a human                                                                                                                                                                                                                                                                                                                     |
| **Link state**                            | Every transition carries a cause from a closed vocabulary (`LINK_CAUSES`). A reconnect nobody can attribute makes an unattended night unreadable afterwards                                                                                                                                                                                                                                                       |

## Commands to a session

| kind                | meaning                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_new`       | open a session: `cwd` (nullable; the workspace provider decides when null), `workspaceKey` (nullable; the key sessions share a tree under), `correlationId` (opaque, echoed, never interpreted), `gate` (per-session deadlines or null), `request` (the JSON-expressible subset of a session request or null). Every member of `request` is `T | null`. |
| `session_prompt`    | queue a turn; a session already holding every turn it can queue refuses `prompt-queue-full` and is otherwise untouched                                                                                                                                                                                                                         |
| `session_cancel`    | interrupt the current turn; never ends the session                                                                                                                                                                                                                                                                                             |
| `session_end`       | end the session: the agent's process exits, the end is reported as the transition to `ended` with cause `stop_requested`, and the workspace it held is free. One that arrives while the session is opening ends it as it opens; on a handle this host does not hold it is refused like any session command                                     |
| `session_configure` | apply the live controls in this order: `model`, `permissionMode`, `thinking`, and from v12 `effort`. Each is null when not asked, and `effort` may also be absent                                                                                                                                                                              |
| `bulk_request`      | ask for bulk content (below)                                                                                                                                                                                                                                                                                                                   |

A `session_new` past the host's session bound (`PeriscopeHostOptions.maxSessions`) refuses
`session-cap-reached` before anything is reserved. One whose `env` names, in `extraEnv` or
`extraAllowedKeys`, a key the host's operator did not declare (`PERISCOPE_CONTROLLER_ENV_KEYS`), or
a key beneath the host's floor (`EXTRA_ENV_FLOOR`: `PATH`, `NODE_OPTIONS`, TLS verification and the
certificates trusted, the model endpoint, provider and credentials, every proxy), refuses
`env-key-refused` before a process exists, naming every such key.

`session_new.request` carries `resume`, `fork`, `settingSources`, `plugins`, `mcpServers`,
`strictMcpConfig`, `includePartialMessages`, `thinking`, `forwardSubagentText`, `env`, `model`,
`systemPrompt`, `effort` and `permissionMode` (the SDK's own vocabularies), and from v15 `runtime`
and `endpoint`, which are optional. From v16 `systemPrompt` may also be the preset every runtime
reads, `{ type: 'preset', preset: 'runtime-default', append? }`: the runtime keeps its own base
instructions and adds `append` in its own lane (Claude's `claude_code` preset with the append;
Codex's developer instructions). The narrowing site from
a wire request to a local one is `src/host/wire-request.ts`; the members of the in-process API that
have no JSON form are structurally absent.

`mcpServers` is how a controller gives a session its tools. It is an object keyed by server name,
each value in the agent SDK's own `McpServerConfig` shape, passed to the agent as declared (a name
colliding with a server the host registers itself is refused). The two shapes a controller uses:

```json
{
  "mcpServers": {
    "controller": {
      "type": "http",
      "url": "https://controller.example/mcp",
      "headers": { "Authorization": "Bearer <a per-session token the controller minted>" }
    },
    "linter": { "type": "stdio", "command": "npx", "args": ["-y", "some-mcp-server"] }
  }
}
```

The HTTP form is how a controller hands a session its own tool surface with a per-session bearer;
the stdio form runs the named command on the host's machine, as the host's OS user, before the gate
sees a single tool call (see `SECURITY.md`, the reach a pairing extends). Every tool either server
adds is decided by the same gate as `Bash`. `strictMcpConfig` is null-for-default and the default is
on: only what the controller declared exists, and nothing from the machine's `.mcp.json`, user
settings, plugins or agent frontmatter is loaded. In-process tool descriptors are the embedder's
(`PeriscopeHostOptions.tools`) and have no wire lane; the `periscope` binary registers none.

`runtime` names the runtime the session runs on. Null or absent is the host's default, `claude`
(`DEFAULT_RUNTIME`); `claude` itself opens exactly as null does. A name the hello's `agents` does
not list, or lists `available: false`, is refused `runtime-unavailable` before anything is reserved
and before any other member is read, the detail naming the runtime and what the host offers, or the
listed reason. The hello's `agents` is the list a controller picks from.

On `codex`, every other member is read as Codex's own:

- `permissionMode`, `effort` and `thinking` take the words Codex's entry lists; another word is
  refused `request-key-unsupported`, the detail naming the member and the words it takes. Thinking
  off is the effort `none`, which the model must list.
- A member that is Claude's alone is refused `request-key-unsupported`, naming it: `settingSources`,
  `forwardSubagentText`, and a `systemPrompt` that is the `claude_code` preset. A string
  `systemPrompt` replaces Codex's base instructions.
- `plugins` are handed to the session's app-server as skill roots before its thread opens
  (`skills/extraRoots/set`): each directory the root that holds `.claude-plugin/plugin.json`, so its
  skills list as `plugin:skill`. A directory that is not there is left out and named among the
  receipt's `pluginErrors`; Codex refusing the call ends the open `plugins-undeliverable`.
- `mcpServers` ride the thread's own config, one `mcp_servers.<name>` table each: an HTTP server's
  `headers` as static `http_headers`, a stdio server's command, arguments and environment. Every
  server's tools are asked about before each call, and the session's gate decides each ask for the
  call pending on that server. A server Codex has no form for
  (SSE, an in-process server, a key it has no setting for, a name with a `.`) is refused
  `mcp-descriptor-invalid`, naming it. Codex has no setting `strictMcpConfig` maps to, and the host
  reads it for no Codex session: either value is accepted and changes nothing.
- `endpoint` opens the session on a provider of its own, defined in its thread's config and named by
  the host. The endpoint must carry `codex` and speak `openai-responses`; otherwise it is refused
  `endpoint-unknown` or `endpoint-incompatible`. `model-endpoint-mismatch` is Claude's rule and a
  Codex session never meets it.

On `qwen-code`, every other member is read as Qwen Code's own:

- `permissionMode` takes `default`, `plan` or `bypassPermissions`, which runs as `default`, every
  call still asked; another word is refused `request-key-unsupported`. `effort` takes the entry's
  words. `thinking` other than adaptive is refused: Qwen Code has no thinking switch.
- A member that is Claude's alone is refused `request-key-unsupported`, naming it: `settingSources`,
  `forwardSubagentText`, and a `systemPrompt` that is the `claude_code` preset. A string
  `systemPrompt` replaces Qwen Code's base prompt, the `runtime-default` preset's `append` is added to
  it, and either is held to `QWEN_MAX_PROMPT_ARGUMENT_CHARS`, since it rides the CLI's command line.
- `plugins` reach the session's settings as skill directories, each directory's `skills/`. A
  directory without one is named among the receipt's `pluginErrors`.
- `mcpServers` ride the first control message on the CLI's stdin: an HTTP server's `headers` beside
  its URL, a stdio server's command, arguments and environment. Every server's tools are asked about,
  and the session's gate decides each ask. A server Qwen Code has no form for (SSE, an in-process
  server, a name outside letters, digits, `-` and `_`) is refused `mcp-descriptor-invalid`, naming it.
  `strictMcpConfig` on (the default) admits only those servers.
- `endpoint` opens the session on that endpoint, over any of the three wire APIs; its credential is
  written only into the session's settings file. A Qwen Code session opened on no endpoint meets the
  sign-in marker (above) and ends with the CLI's exit.

On `pi`, every other member is read as pi's own:

- `permissionMode` is refused `request-key-unsupported`: pi has no permission modes, and every call
  asks this host. `effort` takes the entry's words, pi's thinking levels; `thinking` disabled starts
  the session at `off`.
- A member that is Claude's alone is refused `request-key-unsupported`, naming it: `settingSources`,
  `forwardSubagentText`, `hooks`, `spawn`, a store, and a `systemPrompt` that is the `claude_code`
  preset. A string `systemPrompt` replaces pi's base prompt and the `runtime-default` preset's
  `append` is added to it; either reaches pi as a file in the session's run directory, never on its
  command line.
- `resume` names a session in the host's store whose working directory is the session's own; any
  other is refused `request-key-unsupported`, naming `resume`. `fork` opens a copy of it in the
  session's directory.
- `plugins` reach pi as skill directories on its command line, each directory's `skills/`. A
  directory without one is named among the receipt's `pluginErrors`.
- `mcpServers` ride the extension's configuration file: an HTTP server's `headers` beside its URL, a
  stdio server's command, arguments and environment, each value written so pi expands nothing in it.
  The extension registers each server's tools by name (`mcp__<server>__<tool>`), and the session's
  gate decides every call. A server pi has no form for (SSE, an in-process server, a name outside
  letters, digits, `-` and `_`) is refused `mcp-descriptor-invalid`, naming it. pi reads no MCP file
  of the workspace's, and the agent home's is empty, so a session has only those servers whatever
  `strictMcpConfig` says: the host reads it for no pi session, and either value is accepted and
  changes nothing.
- `endpoint` opens the session on that endpoint as pi's provider, over any of the three wire APIs;
  its credential is written only into the agent home's `models.json`.

`endpoint` names the model endpoint the session's model traffic goes to, by a name the hello's
`endpoints` lists. Null or absent is the runtime's own route. A controller names an endpoint and
never describes one: the host sets the endpoint's address, credential and model variables in the
agent's environment itself, from its operator's configuration, after the controller's own `env` lanes
and never through the floor that screens them. Refused before anything is reserved, each with one
meaning:

- `endpoint-unknown`: a name the operator did not declare. The detail names it and the endpoints the
  hello lists.
- `endpoint-incompatible`: the endpoint cannot carry the session's runtime, because its `runtimes`
  exclude it or it speaks a wire API the runtime does not.
- `model-endpoint-mismatch`: on an endpoint the operator did not mark as Anthropic's own route, a
  `model` beginning `claude-`, or an alias the endpoint does not map (`default`, `best`, `opusplan`,
  an unmapped `fable`, each with or without `[1m]`), which the agent resolves to a Claude model id. A
  provider that maps Claude ids to its own model would answer in its place while the run reads, and
  is priced, as the Claude model it named. The detail names the model and the endpoint. A session
  that names no model is not refused; every such endpoint maps `opus`, `sonnet` and `haiku`.

A session whose `settingSources` include `project` or `local` loads the repository's own
`.claude/settings.json` or `.claude/settings.local.json` from its working directory, and the agent
applies a settings file's `env` to itself after every screen the host runs. So the host reads those
files when the session's directory is known, and a file whose `env` names a key beneath the floor
(`EXTRA_ENV_FLOOR`, its names and its patterns, matched case-insensitively) refuses the session
`settings-route-refused`, the detail naming each file and its keys. A file the host can read neither
as strict JSON nor with its comments and trailing commas removed carries nothing the agent would
apply, and passes, as does a missing one; the user tier is the operator's own file and is not read.

`env` is `{ extraAllowedKeys, extraDeniedKeys, extraEnv }`, each nullable: names of the host's own
environment to re-admit into the spawn (the credential-shaped deny list still wins), names to deny,
and values to set outright after the allow-list has run. The two lanes that add a key are screened:
a key in `extraAllowedKeys` or `extraEnv` must be one the host's operator declared, and must be
above the floor, which no declaration opens. A host declares nothing by default, so its controller
sends `env` as null, or only `extraDeniedKeys`, unless its operator said otherwise. The
declaration is the operator's and has no wire lane.

Three ids ride a session and are never interchangeable: the frame's `sessionId` is the controller's
handle and the routing key for the session's whole life; `SessionTransition.sessionId` is the
agent's own id, a fact, null until the agent reports it; `correlationId` is the controller's opaque
meaning handle. The host never derives one from another, and a controller that uses one string for
the first and third must not expect the host to assume it.

A `session_new` the host will not honour answers on the wire as a `session_update` carrying a
transition `spawning` to `ended` with cause kind `refusal` and the reason as its event, `seq: 1`,
`sessionId: null` in the body and the controller's handle on the frame. Every refusal on the open
path rides it (`permission-grant-shadows-settings`, `workspace-provision-failed`,
`resume-cwd-not-honoured`, `runtime-unavailable`, the three endpoint reasons, `settings-route-refused`, an unusable key); the consumer's job is to end its record of the session and
show the cause. A `session_prompt` that arrives while its session is still opening is held, then delivered,
refused or withdrawn; it is never dropped.

A `session_configure` that fails answers on the session's own state lane, as a transition from its
state to the same state with cause kind `refusal`. There are three reasons:

- **`session-configure-failed`:** the agent refused a control. The detail names the member and
  carries the agent's text; the members before it were applied, and the ones after it were not.
  The CLI refuses a switch into `bypassPermissions` for a session that was not started in it, and
  that refusal arrives this way ([gate.md](gate.md)).
- **`frame-malformed`:** the host refused a value, such as an unknown mode or effort level, or a
  fixed thinking budget.
- **`model-endpoint-mismatch`:** a switch, on a session opened on an endpoint not marked as
  Anthropic's own route, to a model the open would have refused there. Nothing was applied.

A configure for a handle this host does not hold, or for a session still opening, is reported on the
host's own trace only.

## Host-scoped asks

These address the host, not a session. Their `sessionId` is a channel the controller mints, and the
answer rides back on the same channel carrying the ask's `requestId`; the controller's rendezvous
keys on that id alone. The channel is numbered per link, not persisted: the host's counters for it
live for the host process, so across a reconnect they continue and across a host restart they begin
again at 1. A controller therefore numbers its outbound on the channel from the cursor the host
reports for it in the hello (1 when the hello reports none), seeds its inbound from the first frame
after each hello rather than from a stored cursor, and never persists either. The reference
controller does exactly this (`examples/test-controller/controller.ts`), and the end-to-end test
proves an ask after a reconnect is answered.

An answer that would exceed `MAX_FRAME_BYTES` is reported locally as a refusal and never sent, so
every ask must be bounded by the caller: page a listing, cap a read, and expect no answer at all
rather than a truncated one when a bound is missed.

| ask                      | answer                          | refusal reasons the answer may carry                                                                   |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `session_list`           | `session_list_result`           | none                                                                                                   |
| `transcript_list`        | `transcript_failed`             | `transcripts-not-served`, always                                                                       |
| `transcript_tail`        | `transcript_failed`             | `transcripts-not-served`, always                                                                       |
| `workspace_list`         | `workspace_list_result`         | `workspace-list-failed`                                                                                |
| `workspace_release`      | `workspace_release_result`      | `workspace-release-failed`, `branch-not-merged`                                                        |
| `workspace_release_bulk` | `workspace_release_bulk_result` | one receipt per entry, in ask order, never aborted                                                     |
| `host_configure`         | `host_configure_result`         | `config-key-unknown`, `config-value-invalid`, `config-host-busy`, `config-write-failed`                |
| `repository_list`        | `repository_list_result`        | `repository-path-escape`, `repository-read-failed`, `credential-path-denied`, `transcripts-not-served` |
| `repository_read`        | `repository_read_result`        | `repository-path-escape`, `repository-read-failed`, `credential-path-denied`, `transcripts-not-served` |
| `workspace_read`         | `workspace_read_result`         | `workspace-path-escape`, `workspace-read-failed`, `credential-path-denied`, `transcripts-not-served`   |

On every result kind that carries `refusal`, `refusal: null` is the good answer; a reader
discriminates on the echoed `requestId`, never on the kind. An answer of any kind that the host
composed and could not send (over the frame cap, most often) arrives instead as `answer_refused` —
`{ requestId, refusal }`, always small — so a controller learns by name rather than by timeout;
match it on `requestId` like every other answer.

`transcript_list` and `transcript_tail` are retired: the host does not look for, read or keep the
agent's transcript files. Both still decode, so an ask from an older controller is answered rather
than dropped, always `transcript_failed` with `transcripts-not-served`; `transcript_list_result` and
`transcript_tail_result` still decode and are never sent.

Bounds: `WORKSPACE_PAGE_SIZE` worktrees per page, `MAX_BULK_RELEASES` entries per bulk release,
`MAX_CONFIGURE_ENTRIES` entries per configure, `MAX_REPOSITORY_ENTRIES` names per directory listing,
`MAX_REPOSITORY_READ_BYTES` per repository page, cut on a character boundary with the file's whole
size in the answer, and `MAX_REPOSITORY_FILE_BYTES` of a repository file paged through.
`MAX_WORKSPACE_READ_BYTES` per workspace page and `MAX_WORKSPACE_FILE_BYTES` per workspace file.

`repository_read` names a file by a path relative to the repository root, with `maxBytes` and, from
v18, `offset` (absent or null is 0; otherwise the `nextOffset` of the answer before). The answer
carries the page as text, cut on a character boundary, the file's whole size, `truncated` (true while
bytes of the file remain past the page) and, from v18, `nextOffset`: where the next page starts, null
when the page reached the end of the file or `MAX_REPOSITORY_FILE_BYTES`. Offset 0 is the head of a
file of any size, the read v17 made, with the cut on a character boundary where 1.8.2's could split
one; the pages after it reach `MAX_REPOSITORY_FILE_BYTES`, or at most three bytes past it when the
last page carries a character that straddles it, so a longer file is read to that bound and its
answers say `truncated`.
A page that would end inside its first character carries that character whole, so every page moves
forward. An offset past the end of the file, past `MAX_REPOSITORY_FILE_BYTES` or inside a character,
a binary file, and a path that is not a file each refuse `repository-read-failed` by name. A byte is
inside a character only when a UTF-8 lead byte at most three bytes before it claims it, for both
reads: offset 0 is never refused, and a file in another encoding is walked by its `nextOffset` to the
end.

`nextOffset` is composed only for a link negotiated at 18 or above (and before the first
handshake): an answer composed for a link at 17 carries no `nextOffset`, and an ask with no `offset`
is answered with the members v17's answer had; the cut lands on a character boundary where 1.8.2's
could split one. The host honours an `offset` whatever the version; only the
member that names the next page is shaped by it. The shape is fixed when the answer is composed. A
frame retained for replay and replayed on a link renegotiated at another version keeps it: one
composed at 18 and replayed at 17 carries `nextOffset`, which a version-17 decoder carries as an
unknown member and does not read; one composed at 17 and replayed at 18 carries none, which reads as
not stated, so a controller pages on only from an answer that states a `nextOffset`.

`workspace_read` names a workspace by the key it was provisioned at and a file by a path relative to
that workspace's directory, with `offset` (0, or the `nextOffset` of the answer before) and
`maxBytes`. The answer carries the page as text, cut on a character boundary, the file's whole size,
and `nextOffset`, null on the last page. A page that would end inside its first character carries
that character whole, so every page moves forward; an offset inside a character or past the end, a
file over `MAX_WORKSPACE_FILE_BYTES`, a binary file and a provider that cannot locate a workspace by
key each refuse `workspace-read-failed` by name. The ask is host-scoped, so a workspace whose
sessions have all ended can still be read.

`workspace_release` names exactly one of `workspaceKey` or `path`, with `deleteBranch` and `force`;
the receipt states `directoryRemoved` and `branchDeleted` separately, and released or already
absent is the same answer. `host_configure` accepts the keys in `WIRE_CONFIGURABLE_KEYS`, exactly
these seven: `PERISCOPE_WORKSPACE_ROOT`, `PERISCOPE_REPOSITORY_ROOT`, `PERISCOPE_BRANCH_SCHEME`,
`PERISCOPE_AGENT_HOME`, `PERISCOPE_PLUGIN_DIRS`, `PERISCOPE_CONTROLLER_URL`,
`PERISCOPE_DECISION_URL`. It writes them to the host's config file, rebuilds the workspace
provider, and answers with the effective values, the keys the environment shadows
(`overriddenByEnvironment`), and the keys that apply only at the next start.
The two URLs and the agent home are written but never applied live: the host dials what it dialled,
and protects the agent home it started with, until its next start. A root cannot change while a
session is open or opening (`config-host-busy`).

## The bulk lane

A frame is at most `MAX_FRAME_BYTES`, refused on encode and on decode, so bulk content never rides
the link and a tool result over the cap is refused (`frame-too-large`), never truncated. The
controller sends `bulk_request` with a `deliveryId`, what it wants and where to POST it; the host
answers with a streamed HTTP POST and then `bulk_delivered` (with `byteCount` and the source's
`sizeBytes` and `mtimeMs` at the moment of the read) or `bulk_failed` (a named refusal). The POST
target's origin must be the controller's own (`bulk-target-not-controller` otherwise; a garbled URL
is `bulk-target-invalid`), because the host's credential rides on it; the bind is derived from
`PERISCOPE_CONTROLLER_URL`, never separately configured. A source whose size or modification time
moved between two reads must be re-read whole from zero, once; still moving, the read is refused.
The POST body is bounded to the declared `content-length`, never drained to EOF.

A frame budgeted against the limit must allow 15 bytes: admission is probed with the widest sequence
number a frame can carry, so a payload within 15 bytes of the limit is refused although its real
frame would fit.

`bulk_request` carries `deliveryId` (echoed on the receipt), `what` (a locator), `fromOffset` (a
byte offset to start from) and `postUrl`. What a locator names is the embedder's: a host resolves
`what` through the resolver it was composed with (`PeriscopeHostOptions.bulk`), which gives meaning
to the namespaces its controller asks for, and a locator no resolver serves is refused
`bulk-target-invalid`. The binary composes none, so every `bulk_request` to it is refused. A locator
in the retired `claude-transcript:` namespace (`TRANSCRIPT_WHAT_PREFIX`) is refused
`transcripts-not-served` before any resolver is asked. The file a resolver names meets the read
doors' two fences before it is posted, on the lexical resolution and on the real path: a protected
path refuses `credential-path-denied`, and a folder of an agent's session records
(`agentTranscriptPaths`) `transcripts-not-served`.

The POST the host sends:

| header           | value                                                                              |
| ---------------- | ---------------------------------------------------------------------------------- |
| `content-type`   | `application/octet-stream`                                                         |
| `content-length` | the byte count promised, from the source's size at the read minus `fromOffset`     |
| `x-delivery-id`  | the `deliveryId` from the request                                                  |
| `Authorization`  | the host's bearer, when it has one (the credential on the three transports, above) |

The body is the source's bytes from `fromOffset`, streamed, bounded to the declared length. A
2xx answer is `bulk_delivered`; any other status, or a transport failure, is `bulk_failed` with
`bulk-delivery-failed`.

## Permission decisions are not on the wire

A permission decision travels as an HTTP POST from the host to a URL the host is configured with,
and the decision comes back in the response body. Nothing on the wire announces that URL. A
controller therefore serves two transports: the WebSocket the host dials and an HTTP endpoint that
answers decisions. The request and decision shapes (`DecisionRequest`, `Decision`, `Decider`,
`EscalationTransport`) ship on the protocol subpath so the endpoint can be typed without importing
the main entry. A `Decision` follows the agent SDK's own permission result: `{ behavior: 'allow',
updatedInput? }` or `{ behavior: 'deny', message, interrupt? }`; its optional members are omitted
when absent, never written as null, and an explicit null is read as an unrecognised decision, which
is never an allow. The host reads the status before the body: a non-2xx, a transport failure or a
body that is not JSON is an outage, and an outage refuses the tool.

The request is `POST <PERISCOPE_DECISION_URL>` with `content-type: application/json`, the host's
bearer as `Authorization` when it has one, and a JSON body that is a `DecisionRequest`:

| member       | meaning                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolName`   | the tool the agent is calling, as the SDK names it (`Bash`, `Write`, `mcp__{server}__{tool}`)                                                                                               |
| `toolUseId`  | the call's id, unique within the session; the hold the state machine opens is keyed by it                                                                                                   |
| `toolInput`  | the call's input, verbatim, whatever the tool takes                                                                                                                                         |
| `sessionKey` | **the controller's handle**, the same string every wire frame for this session is keyed by. Correlate on this and nothing else                                                              |
| `sessionId`  | the agent's own id as the hook input carries it; a fact, not a key. The empty string when the input carries none, so a controller indexing on it fails exactly when a session is in trouble |
| `cwd`        | the directory the call runs in                                                                                                                                                              |
| `agentId`    | the subagent this call came from, or null on the main thread                                                                                                                                |
| `agentType`  | the agent type when one is set, or null; present on the main thread too, so branch on `agentId`                                                                                             |
| `toolKind`   | from v15: what kind of call this is, one of `TOOL_KINDS` (`shell`, `file_read`, `file_write`, `file_edit`, `mcp`, `web`, `other`), read from `toolName` by the runtime's map                |
| `runtime`    | from v15: the runtime the session runs on (`claude`)                                                                                                                                        |

`toolName` stays the tool's own name; `toolKind` lets a decider hold one policy per kind across
runtimes. Claude's map: `Bash` and `PowerShell` are `shell`; `Read`, `Grep`, `Glob` and
`NotebookRead` are `file_read`; `Write` is `file_write`; `Edit`, `MultiEdit` and `NotebookEdit` are
`file_edit`; every `mcp__{server}__{tool}` is `mcp`; `WebFetch` and `WebSearch` are `web`; any other
name is `other`, stated and never left out. Both members are absent from a host one release behind.

The answer is the `Decision` above, as JSON, within the session's `decisionTimeoutMs`
(`DEFAULT_DECISION_TIMEOUT_MS`, 50 s); a controller that holds a decision for a person keeps its
own budget inside that and answers non-2xx when the budget passes. The request carries the turn's
abort: a cancelled turn aborts an in-flight decision request.

An in-process tool call is not on the wire either: the host's own MCP server registers the
embedder's descriptors, and a controller declares MCP servers, not inline tools, through
`session_new.request.mcpServers`.

## Refusals

`REFUSAL_REASONS` (`src/core/refusal.ts`) is a closed vocabulary. The codec decodes tolerantly, so
an unknown inbound reason survives as information (a `bulk_failed` is a receipt, and making it
unreadable because the failure had a newer name loses the outcome), and encodes strictly, so this
package never emits a reason it does not declare, on any kind that carries one, the `wire_refusal`
body included. Adding a reason is a versioned change: a controller that encodes strictly too must
learn it before it can answer with it. Count the entries in the file; never carry the number.

The reasons a controller meets most, and what each is not:

| reason                                                                                                                                                                                                                                                                                 | names                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frame-not-json`, `frame-malformed`, `frame-too-large`                                                                                                                                                                                                                                 | the codec's three; the last names the bulk lane                                                                                                                                                                                                                                                                                                                                                                       |
| `seq-gap`, `seq-regressed`                                                                                                                                                                                                                                                             | the receiver's inbound lane; the refusal's `expected` is where to resume                                                                                                                                                                                                                                                                                                                                              |
| `link-unauthorized`                                                                                                                                                                                                                                                                    | the peer refused this host's identity at the door; terminal, never retried. Not `link-send-failed`, which names a transport that faltered                                                                                                                                                                                                                                                                             |
| `session-unknown`                                                                                                                                                                                                                                                                      | a handle that does not and never will exist, or a held turn over the bound                                                                                                                                                                                                                                                                                                                                            |
| `session-configure-failed`                                                                                                                                                                                                                                                             | the agent refused one of a `session_configure`'s controls; the detail names the member, and the members before it were applied. Not `frame-malformed`, which is the host refusing a value                                                                                                                                                                                                                             |
| `permission-decision-unavailable`, `permission-decision-unrecognised`                                                                                                                                                                                                                  | an outage, and a decision this build does not know; neither is an allow                                                                                                                                                                                                                                                                                                                                               |
| `transcripts-not-served`                                                                                                                                                                                                                                                               | the answer to a `transcript_list`, a `transcript_tail` and a `claude-transcript:` locator, and to a repository or workspace read, or a resolver's bulk file, at or beneath an agent's session records (`agentTranscriptPaths`), whatever the root: the host does not serve them. Not `bulk-target-invalid`, which names a locator no resolver serves, and not `credential-path-denied`, which names the protected set |
| `bulk-target-not-controller`, `bulk-target-invalid`                                                                                                                                                                                                                                    | a well-formed target that is not the controller's origin, and a garbled one; a configuration mistake and an exfiltration attempt are kept apart                                                                                                                                                                                                                                                                       |
| `resume-cwd-not-honoured`                                                                                                                                                                                                                                                              | a resume naming a directory the workspace provider would not honour; the same resume at the repository root runs                                                                                                                                                                                                                                                                                                      |
| `runtime-unavailable`                                                                                                                                                                                                                                                                  | a `session_new` naming a runtime the host cannot spawn: unknown, or listed `available: false`; the detail names it and what the host offers                                                                                                                                                                                                                                                                           |
| `codex-hook-not-active`                                                                                                                                                                                                                                                                | a Codex open whose periscope hook is not trusted and enabled, whose hook channel could not listen, or whose hook command fails its probe; the detail says what to fix. Without the hook nothing enforces the protected set on Codex                                                                                                                                                                                   |
| `gate-hook-timed-out`, `gate-hook-unspawnable`, `gate-hook-output-rejected`, `gate-hook-missing`, `gate-hook-foreign`, `gate-unhooked-call`, `gate-approval-unanswered`, `gate-approval-auto-reviewed`, `gate-approval-ambiguous`, `gate-project-config-active`, `gate-sandbox-absent` | degrades on a Codex session's state lane: a call went on undecided, or the session lost a guarantee ([The control tier](#the-control-tier)). Never a stop                                                                                                                                                                                                                                                             |
| `qwen-ask-rules-not-active`                                                                                                                                                                                                                                                            | a Qwen Code open whose settings could not be written, or do not read back asking about every built-in tool and every attached MCP server with every hook off; the detail names the file and what it lacks. Without them a call the CLI allows by default runs undecided                                                                                                                                               |
| `gate-tool-unruled`, `gate-mode-widened`, `gate-credential-in-shell`                                                                                                                                                                                                                   | degrades on a Qwen Code session's state lane: a tool no ask rule names, a mode that approves calls itself, a variables file or endpoint variable that reaches the agent's shell ([The control tier](#the-control-tier)). Never a stop                                                                                                                                                                                 |
| `pi-extension-not-active`                                                                                                                                                                                                                                                              | a pi open whose extension did not say hello over the session's channel within `PI_HELLO_DEADLINE_MS`, or that pi would not load, or whose channel or configuration could not be made; no prompt was written. Without it every pi tool call would run undecided                                                                                                                                                        |
| `gate-foreign-extension`                                                                                                                                                                                                                                                               | a degrade on a pi session's state lane, known at the open: a command, tool or MCP server from code this host did not load, which lowers the opening tier ([The control tier](#the-control-tier)). Never a stop                                                                                                                                                                                                        |
| `request-key-unsupported`                                                                                                                                                                                                                                                              | a `session_new` member the named runtime does not honour, or a value of one its vocabularies lack; the detail names the key. Every member is Claude's own, so a session on Claude never meets it                                                                                                                                                                                                                      |
| `plugins-undeliverable`                                                                                                                                                                                                                                                                | the runtime refused the call that hands it a session's plugin directories (Codex's `skills/extraRoots/set`); the open ends before `ready`, the detail carrying the runtime's answer. A directory that is not there is not this: it is named among the receipt's `pluginErrors`                                                                                                                                        |
| `rpc-line-malformed`, `rpc-line-too-large`, `rpc-request-timed-out`, `rpc-request-failed`, `rpc-server-overloaded`                                                                                                                                                                     | a runtime's JSON-RPC peer: a line that is no JSON-RPC message, a line past what the host reads (dropped whole), a request with no answer by the host's deadline, an error answer, and the peer's own overload code. They reach a controller in a cause's detail, never as a wire refusal                                                                                                                              |
| `endpoint-unknown`, `endpoint-incompatible`, `model-endpoint-mismatch`                                                                                                                                                                                                                 | a model endpoint the host's operator did not declare; one whose runtimes or wire API exclude the session's runtime; a `claude-` model id, or an alias the endpoint does not map, on an endpoint not marked as Anthropic's own route, at the open or on a later switch                                                                                                                                                 |
| `settings-route-refused`                                                                                                                                                                                                                                                               | a repository settings file the session loads names a key beneath the env floor in its `env`; the detail names the file and the keys. Not `env-key-refused`, which is the controller's own lanes                                                                                                                                                                                                                       |
| `config-key-unknown`, `config-value-invalid`, `config-host-busy`, `config-write-failed`                                                                                                                                                                                                | a key the host does not accept over the link, a value it cannot use, a root change while a session is open, a config file that could not be written (nothing applied)                                                                                                                                                                                                                                                 |
| `workspace-list-failed`, `workspace-release-failed`, `branch-not-merged`                                                                                                                                                                                                               | the inventory failed (an empty disk is an empty list, not a refusal); a removal was attempted and failed; a branch the default does not contain, nothing removed, repeat with `force`                                                                                                                                                                                                                                 |
| `repository-path-escape`, `repository-read-failed`                                                                                                                                                                                                                                     | a path that left the repository root under either containment check; a path inside it that could not be read as text                                                                                                                                                                                                                                                                                                  |
| `workspace-path-escape`, `workspace-read-failed`                                                                                                                                                                                                                                       | the same two over a workspace's directory; the second also names an unusable key, an offset inside a character or past the end, and a file larger than the read serves                                                                                                                                                                                                                                                |

`protocol_version_rejected` is not a refusal reason but a link cause: the windows did not overlap,
and the link's state reports it.

## The vectors

`contracts/wire-vectors/*.json` is the normative byte-level contract. Each file is
`{ name, protocolVersion, frame, wire, expect, decoded? }`:

- `expect: { decode: 'ok' }` with a `frame` and a `wire`: `encode(frame)` must reproduce `wire` byte
  for byte, and `decode(wire)` must give back `frame`, or `decoded` where the codec deliberately
  differs (an unknown key carried through, a defaulted member, a dropped `__proto__`). A vector
  with `frame: null` is an authored wire no frame of this build encodes to: a tolerance case.
- `expect: { decode: 'refused', reason }` with a `wire` and no frame: `decode(wire)` must refuse with
  that reason.
- `expect: { encode: 'refused', reason }` with a `frame` and `wire: null`: `encode(frame)` must refuse
  with that reason; nothing reaches the wire.

Every vector is recorded at `PROTOCOL_VERSION`; a bump reddens the corpus until it is re-approved
with `npm run contracts:update`. A second implementer proves its codec against these files, not
against this document; `pins/wire-vectors.test.ts` is this package's own proof.

## The controller's obligations

The wire types do not enforce these; a conforming controller does them anyway. Each is one thing to
build, in the order a first controller meets them.

Over HTTP, beside the link:

- [ ] Serve the WebSocket upgrade at the address the host dials; read `Authorization` and answer
      401 or 403 to refuse an identity (terminal for the host), anything else to let it in.
- [ ] Serve the decision endpoint at the address the host is configured with: read a
      `DecisionRequest`, answer a `Decision` as JSON with a 2xx inside the session's
      `decisionTimeoutMs`, or non-2xx to refuse. Correlate on `sessionKey`.
- [ ] Serve one or more bulk sinks on the controller's own origin: accept a streamed POST with
      `x-delivery-id`, `content-length` and the bearer; answer 2xx once the bytes are stored.
- [ ] To pair hosts, mint short-lived single-use codes for signed-in users and serve the redemption
      route: read `{ code, machineLabel }`, answer `{ hostId, hostCredential, controllerUrl,
decisionUrl }` with the bearer shaped `p1.<hostId>.<secret>`; store the secret's hash;
      revoke by refusing the bearer at the upgrade.

Over the link:

- [ ] Answer `link_hello` with `link_welcome` carrying the chosen protocol version inside the overlap
      of the two windows, or close 1002 naming both windows. Answer every `link_ping` with
      `link_pong`. Send `link_ack` for every session frame received; the host sends no `link_ack`,
      ever, and its retention is released only by the controller's acks.
- [ ] `link_welcome.cursors` reports the controller's durable inbound positions; a session with no
      stored cursor is omitted, never reported as 0.
- [ ] `link_hello.cursors` is the host's inbound set: prune outbound retention with it; never seed
      an inbound tracker from it.
- [ ] Seed the inbound tracker from the first frame when no cursor is held for a session key, keyed
      off absence, never `== 0`.
- [ ] Persist both directions durably for session channels; the outbound clock must continue across
      a restart, because restarting at 1 reads as duplicates and is silently discarded. The
      host-scoped channel is the exception: number it per link from the cursor the hello reports, and
      seed its inbound from the first frame after each hello.
- [ ] `wire_refusal.expected` is a resync instruction about the receiver's own outbound lane:
      re-send retained frames from that seq with their original seqs.
- [ ] Budget frames against `MAX_FRAME_BYTES` minus 15, and bound every host-scoped ask so its answer
      fits.
- [ ] A `session_delta` produces no durable content row.
- [ ] An `agent_facts` ingest is idempotent on `sourceId`, and stores a fact's figures as reported:
      a turn's spend read from `totals` is the difference of two totals the consumer holds, never a
      figure the host sent.
- [ ] The host's `ended` ends the controller's record of the session, the refused open included.

## Where things live

| Path                                                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/protocol.ts`                                                    | The subpath barrel: types and runtime values (`encode`, `decode`, `SeqTracker`, `REFUSAL_REASONS`, `PROTOCOL_VERSION`, `PROTOCOL_VERSION_MIN`, `readDecision`, the permission shapes)                                                                                                                                                                                                                                |
| `src/control/frames.ts`                                              | The envelope, the payload union, the sequence semantics, `DROPPABLE_KINDS`, the three ids                                                                                                                                                                                                                                                                                                                            |
| `src/control/codec.ts`                                               | The one edge between bytes and types; tolerant decode, strict encode                                                                                                                                                                                                                                                                                                                                                 |
| `src/control/seq.ts`                                                 | `SeqTracker`: dense minting, gap and duplicate judgement                                                                                                                                                                                                                                                                                                                                                             |
| `src/control/queue.ts`                                               | `BoundedFrameQueue`: pending and written entries, the eviction ladder                                                                                                                                                                                                                                                                                                                                                |
| `src/control/link.ts`                                                | `ControllerLink`: the dial-out socket, admit then drain, backoff with jitter, heartbeat, the connect timeout, replay, acks, the version window                                                                                                                                                                                                                                                                       |
| `src/control/link-state.ts`                                          | The link's own state machine and `LINK_CAUSES`                                                                                                                                                                                                                                                                                                                                                                       |
| `src/control/stream-routing.ts`                                      | `MESSAGE_ROUTING`: the lane for each SDK message                                                                                                                                                                                                                                                                                                                                                                     |
| `src/sessions/fact-lift.ts`                                          | `FACT_LIFTS`: the fact lift for each runtime, and `factLiftFor`                                                                                                                                                                                                                                                                                                                                                      |
| `src/host/claude-facts.ts`                                           | The Claude lift: the fact layer read out of the agent's own messages                                                                                                                                                                                                                                                                                                                                                 |
| `src/sessions/item-fill.ts`                                          | `ItemFill`: what a runtime's conversation item fill is                                                                                                                                                                                                                                                                                                                                                               |
| `src/control/item-budget.ts`                                         | `fitAgentItem`: an item held to `MAX_AGENT_ITEM_BYTES`, its cut said in `truncated`                                                                                                                                                                                                                                                                                                                                  |
| `src/host/claude-items.ts`                                           | The Claude fill, `CLAUDE_ITEM_COVERAGE` and `CLAUDE_BLOCK_ITEMS`: the items read out of the agent's messages and its prompt hook                                                                                                                                                                                                                                                                                     |
| `src/host/codex-items.ts`                                            | The Codex fill and `CODEX_ITEM_FILLS`: the items read out of the app-server's notifications                                                                                                                                                                                                                                                                                                                          |
| `src/host/bulk-post.ts`                                              | The streamed outbound POST behind `bulk_request` and its origin bind                                                                                                                                                                                                                                                                                                                                                 |
| `src/gate/decision.ts`                                               | The permission types the subpath re-exports, and `TOOL_KINDS`                                                                                                                                                                                                                                                                                                                                                        |
| `src/gate/tool-kind.ts`                                              | Claude's and Codex's maps from a tool name to its `toolKind`                                                                                                                                                                                                                                                                                                                                                         |
| `src/sessions/runtimes.ts`                                           | `CONTROL_TIERS`, the tier per runtime; `RUNTIME_WIRE_APIS`, the wire APIs each runtime speaks; `AGENT_SKILLS`, how each takes plugin directories; and `runtimeOf`, the runtime a session request names                                                                                                                                                                                                               |
| `src/host/model-endpoints.ts`                                        | The operator's model endpoints: the file read and checked at start, the hello's entries, the variables a session on one is spawned with, and the model rule                                                                                                                                                                                                                                                          |
| `src/host/repository-settings.ts`                                    | The repository's own settings tiers, read before a session that loads them starts                                                                                                                                                                                                                                                                                                                                    |
| `src/host/claude-runtime.ts`                                         | Claude's entry in the hello's `agents`                                                                                                                                                                                                                                                                                                                                                                               |
| `src/host/wire-request.ts`                                           | The single narrowing from `session_new.request` and `session_configure` to local requests                                                                                                                                                                                                                                                                                                                            |
| `contracts/wire-vectors/`                                            | The byte-level contract                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/pins/wire-vectors.test.ts`, `src/pins/protocol-closure.test.ts` | The corpus check; the proof that the subpath reaches no `host/` file and no `node:` builtin                                                                                                                                                                                                                                                                                                                          |
| `src/host/protocol-window.test.ts`                                   | The window's two directions over a real link: this host's frames (a Claude, a Codex, a Qwen Code and a pi session's on one link, and its answers to the retired asks and to a `repository_read`) through the protocol-17 decoder v1.8.2 shipped (`V17`, built on the protocol-16 schemas frozen from v1.7.0, `V16`, since that release's codec is v1.7.0's), and a version-17 controller's frames through this build |
| `src/host/codex-wire.ts`                                             | `CodexMessage`, what a Codex session yields, and the shapes of the app-server answers the host reads                                                                                                                                                                                                                                                                                                                 |
| `src/host/codex-runtime.ts`                                          | Codex's entry in the hello's `agents`, and `CODEX_MESSAGE_BINDING`, the lane for each Codex message                                                                                                                                                                                                                                                                                                                  |
| `src/host/codex-pack.ts`, `src/host/codex-mcp.ts`                    | A Codex session's plugin directories as skill roots, and its MCP servers as thread config                                                                                                                                                                                                                                                                                                                            |
| `src/host/codex-endpoints.ts`                                        | A named endpoint as a Codex session reaches it: the derived provider id, the provider config, the key's variable                                                                                                                                                                                                                                                                                                     |
| `examples/minimal-controller/`, `examples/test-controller/`          | The smallest controller that accepts a host, and the reference controller that drives every ask                                                                                                                                                                                                                                                                                                                      |
