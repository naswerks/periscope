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
| `configuration`   | the host's effective settings, reported and never negotiated (below)                                                                                                                                                                             |
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
`[9, 10]`: version 10 adds `answer_refused`, the three session refusals `session-cap-reached`,
`prompt-queue-full` and `env-key-refused`, and the welcome's range; a v9 controller meets none of
them unless it sends what they refuse.

Two close reasons carry meaning. A close with code 1002 whose reason starts with `seq gap` is a
replay request: the controller names the position it holds, and the host's next dial replays from
it (link cause `replay_requested`). Any other 1002 close is read as the version refusal above.

`configuration` is a `HostConfiguration`: seven strings, each `T | null`, in this order:
`repositoryRoot`, `workspaceRoot`, `branchScheme` (the effective scheme, `{repo}/{key}` when none is
configured), `transcriptsRoot` (derived from the agent home; reported, never settable on its own),
`controllerUrl`, `decisionUrl`, `agentHome` — each at most `MAX_CONFIGURATION_VALUE_LENGTH` — and,
from v11, `plugins`: the plugin directories the host loads into every session, each as
`{ name, version, path }` from its manifest (`version` null when the manifest declares none), at
most `MAX_PLUGIN_DIRS` entries. A controller that wants a session to have a plugin reads this list
before it opens one; a host with none configured reports an empty list.

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
lane and then the transitions that message caused, message first, so a consumer never sees a state
change referring to a message it does not have.

`session_update.body` is an open JSON object read through typed readers: `readStateTransition`,
`readAgentMessage`, `readWireRefusal` (`{ refusal, expected, received }`; `expected` is the seq the
receiver will accept next on the refused party's own outbound lane). `wire_refusal` is a body
member, not a payload kind, so a refusal rides the same fact lane it refuses. A controller carries
unknown keys through and must not narrow the body.

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
prose costs tokens on the wire and puts reasoning text into transcripts and mirrors; whether a run is
watched is not something the host can know, so it offers the knob instead of guessing a policy.

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
| `session_configure` | apply the live setters (`model`, `permissionMode`, `thinking`), each null when not asked                                                                                                                                                                                                                                                       |
| `bulk_request`      | ask for bulk content (below)                                                                                                                                                                                                                                                                                                                   |

A `session_new` past the host's session bound (`PeriscopeHostOptions.maxSessions`) refuses
`session-cap-reached` before anything is reserved; one naming an `extraEnv` key beneath the host's
floor (`EXTRA_ENV_FLOOR`: `PATH`, `NODE_OPTIONS`, TLS verification, the model endpoint, the
credentials) refuses `env-key-refused` before a process exists.

`session_new.request` carries `resume`, `fork`, `settingSources`, `plugins`, `mcpServers`,
`strictMcpConfig`, `includePartialMessages`, `thinking`, `forwardSubagentText`, `env`, `model`,
`systemPrompt`, `effort` and `permissionMode` (the SDK's own vocabularies). The narrowing site from
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

`env` is `{ extraAllowedKeys, extraDeniedKeys, extraEnv }`, each nullable: names of the host's own
environment to re-admit into the spawn (the credential-shaped deny list still wins), names to deny,
and values to set outright after the allow-list has run.

Three ids ride a session and are never interchangeable: the frame's `sessionId` is the controller's
handle and the routing key for the session's whole life; `SessionTransition.sessionId` is the
agent's own id, a fact, null until the agent reports it; `correlationId` is the controller's opaque
meaning handle. The host never derives one from another, and a controller that uses one string for
the first and third must not expect the host to assume it.

A `session_new` the host will not honour answers on the wire as a `session_update` carrying a
transition `spawning` to `ended` with cause kind `refusal` and the reason as its event, `seq: 1`,
`sessionId: null` in the body and the controller's handle on the frame. Every refusal on the open
path rides it (`permission-grant-shadows-settings`, `workspace-provision-failed`,
`resume-cwd-not-honoured`, an unusable key); the consumer's job is to end its record of the session and
show the cause. A `session_prompt` that arrives while its session is still opening is held, then delivered,
refused or withdrawn; it is never dropped.

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

| ask                      | answer                          | refusal reasons the answer may carry                                                    |
| ------------------------ | ------------------------------- | --------------------------------------------------------------------------------------- |
| `session_list`           | `session_list_result`           | none; `transcript_failed` on failure                                                    |
| `transcript_list`        | `transcript_list_result`        | `transcript_failed`                                                                     |
| `transcript_tail`        | `transcript_tail_result`        | `transcript_failed`                                                                     |
| `workspace_list`         | `workspace_list_result`         | `workspace-list-failed`                                                                 |
| `workspace_release`      | `workspace_release_result`      | `workspace-release-failed`, `branch-not-merged`                                         |
| `workspace_release_bulk` | `workspace_release_bulk_result` | one receipt per entry, in ask order, never aborted                                      |
| `host_configure`         | `host_configure_result`         | `config-key-unknown`, `config-value-invalid`, `config-host-busy`, `config-write-failed` |
| `repository_list`        | `repository_list_result`        | `repository-path-escape`, `repository-read-failed`                                      |
| `repository_read`        | `repository_read_result`        | `repository-path-escape`, `repository-read-failed`                                      |

On every result kind that carries `refusal`, `refusal: null` is the good answer. `transcript_failed`
is the one failure kind for the three transcript asks; a reader discriminates on the echoed
`requestId`, never on the kind. An answer of any kind that the host composed and could not send
(over the frame cap, most often) arrives instead as `answer_refused` — `{ requestId, refusal }`,
always small — so a controller learns by name rather than by timeout; match it on `requestId`
like every other answer. A `transcript_list_result` entry carries the `cwd` the CLI recorded
on the transcript, null when its head carries none.

Bounds: `TRANSCRIPT_PAGE_SIZE` transcripts per page, `WORKSPACE_PAGE_SIZE` worktrees per page,
`MAX_BULK_RELEASES` entries per bulk release, `MAX_CONFIGURE_ENTRIES` entries per configure,
`MAX_REPOSITORY_ENTRIES` names per directory listing, `MAX_REPOSITORY_READ_BYTES` per file head, cut
on a character boundary with the file's whole size in the answer.

`workspace_release` names exactly one of `workspaceKey` or `path`, with `deleteBranch` and `force`;
the receipt states `directoryRemoved` and `branchDeleted` separately, and released or already
absent is the same answer. `host_configure` accepts the keys in `WIRE_CONFIGURABLE_KEYS`, exactly
these six: `PERISCOPE_WORKSPACE_ROOT`, `PERISCOPE_REPOSITORY_ROOT`, `PERISCOPE_BRANCH_SCHEME`,
`PERISCOPE_AGENT_HOME`, `PERISCOPE_CONTROLLER_URL`, `PERISCOPE_DECISION_URL`. It writes them to the
host's config file, rebuilds the workspace provider, and answers with the effective values, the
keys the environment shadows (`overriddenByEnvironment`), and the keys that apply only at the next
start.
The two URLs are written but never applied to the live link. A root cannot change while a session
is open or opening (`config-host-busy`).

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
byte offset to start from) and `postUrl`. The locator namespace this package resolves is the
agent CLI's own transcripts: `claude-transcript:{projectSlug}/{sessionId}`, where the prefix is
`TRANSCRIPT_WHAT_PREFIX`, `projectSlug` is the directory name a `transcript_list_result` entry
reports (opaque; the CLI's flattening of a path is not invertible) and `sessionId` is the entry's
id. A locator outside the namespace is refused `bulk-target-invalid`. An embedder may add
resolvers for other namespaces.

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

| reason                                                                                  | names                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frame-not-json`, `frame-malformed`, `frame-too-large`                                  | the codec's three; the last names the bulk lane                                                                                                                                       |
| `seq-gap`, `seq-regressed`                                                              | the receiver's inbound lane; the refusal's `expected` is where to resume                                                                                                              |
| `link-unauthorized`                                                                     | the peer refused this host's identity at the door; terminal, never retried. Not `link-send-failed`, which names a transport that faltered                                             |
| `session-unknown`                                                                       | a handle that does not and never will exist, or a held turn over the bound                                                                                                            |
| `permission-decision-unavailable`, `permission-decision-unrecognised`                   | an outage, and a decision this build does not know; neither is an allow                                                                                                               |
| `transcript-path-escape`                                                                | a caller-supplied name that failed one of the discovery jail's three layers; the refusal names the layer                                                                              |
| `bulk-target-not-controller`, `bulk-target-invalid`                                     | a well-formed target that is not the controller's origin, and a garbled one; a configuration mistake and an exfiltration attempt are kept apart                                       |
| `resume-cwd-not-honoured`                                                               | a resume naming a directory the workspace provider would not honour; the same resume at the repository root runs                                                                      |
| `config-key-unknown`, `config-value-invalid`, `config-host-busy`, `config-write-failed` | a key the host does not accept over the link, a value it cannot use, a root change while a session is open, a config file that could not be written (nothing applied)                 |
| `workspace-list-failed`, `workspace-release-failed`, `branch-not-merged`                | the inventory failed (an empty disk is an empty list, not a refusal); a removal was attempted and failed; a branch the default does not contain, nothing removed, repeat with `force` |
| `repository-path-escape`, `repository-read-failed`                                      | a path that left the repository root under either containment check; a path inside it that could not be read as text                                                                  |

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
- [ ] The host's `ended` ends the controller's record of the session, the refused open included.

## Where things live

| Path                                                                 | What                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/protocol.ts`                                                    | The subpath barrel: types and runtime values (`encode`, `decode`, `SeqTracker`, `REFUSAL_REASONS`, `PROTOCOL_VERSION`, `PROTOCOL_VERSION_MIN`, `readDecision`, the permission shapes) |
| `src/control/frames.ts`                                              | The envelope, the payload union, the sequence semantics, `DROPPABLE_KINDS`, the three ids                                                                                             |
| `src/control/codec.ts`                                               | The one edge between bytes and types; tolerant decode, strict encode                                                                                                                  |
| `src/control/seq.ts`                                                 | `SeqTracker`: dense minting, gap and duplicate judgement                                                                                                                              |
| `src/control/queue.ts`                                               | `BoundedFrameQueue`: pending and written entries, the eviction ladder                                                                                                                 |
| `src/control/link.ts`                                                | `ControllerLink`: the dial-out socket, admit then drain, backoff with jitter, heartbeat, the connect timeout, replay, acks, the version window                                        |
| `src/control/link-state.ts`                                          | The link's own state machine and `LINK_CAUSES`                                                                                                                                        |
| `src/control/stream-routing.ts`                                      | `MESSAGE_ROUTING`: the lane for each SDK message                                                                                                                                      |
| `src/host/bulk-post.ts`                                              | The streamed outbound POST behind `bulk_request` and its origin bind                                                                                                                  |
| `src/gate/decision.ts`                                               | The permission types the subpath re-exports                                                                                                                                           |
| `src/host/wire-request.ts`                                           | The single narrowing from `session_new.request` and `session_configure` to local requests                                                                                             |
| `contracts/wire-vectors/`                                            | The byte-level contract                                                                                                                                                               |
| `src/pins/wire-vectors.test.ts`, `src/pins/protocol-closure.test.ts` | The corpus check; the proof that the subpath reaches no `host/` file and no `node:` builtin                                                                                           |
| `examples/minimal-controller/`, `examples/test-controller/`          | The smallest controller that accepts a host, and the reference controller that drives every ask                                                                                       |
