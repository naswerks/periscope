# Periscope

[![ci](https://github.com/naswerks/periscope/actions/workflows/ci.yml/badge.svg)](https://github.com/naswerks/periscope/actions/workflows/ci.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

Self-hosted runner for agent sessions: dials out to your controller, then spawns, gates, observes,
prompts and streams. It runs where the code is; the controller runs wherever you put it.

```sh
npm install @naswerks/periscope
```

Like a CI runner, the process on your machine dials out and the intelligence lives at the server;
unlike one, what it hosts is a conversation you can steer mid-turn, not a job you collect at the
end. The agent it hosts is Claude Code, through the Claude Agent SDK, behind a seam that names no
agent on the wire. It opens no port and carries no opinion about what a session _means_: it emits what happened, and the
controller decides what to do about it. Three properties hold, each enforced by a test rather than
promised:

- **The controller decides.** Every permission decision is the controller's, or a local rule's. The
  host cannot say yes on its own.
- **The gate fails closed.** No answer, any error, any timeout, any outage: the tool does not run.
- **The blast radius is one directory.** Nothing outside `src/host/` can reach the filesystem, a
  process, or the agent SDK; a controller that imports only `@naswerks/periscope/protocol` acquires
  none of it.

Two audiences read this. An **operator** installs the binary on a machine and pairs it to a
controller somebody else runs; a **controller author** implements the other end. The package's
documents are the contract: [architecture](docs/architecture.md), [the wire protocol](docs/protocol.md),
[the state machine](docs/state-machine.md), [the gate](docs/gate.md) and [identity](docs/identity.md).
This README is the walkthrough.

## Quick start for an operator

You have a controller's address and a pair code from whoever runs it. Four commands, no
configuration file to write.

1. **Install the binary.**

   ```sh
   npm install -g @naswerks/periscope
   periscope version
   ```

2. **Give the agent its own credential, once, as the same OS user.** The host runs the Claude Code
   CLI headless, and that CLI authenticates through the credential under `~/.claude`, which
   `claude auth login` writes. `ANTHROPIC_API_KEY` in your shell is not inherited by a session (the
   spawn environment is an allow-list), so this step is not optional.

   ```sh
   npm install -g @anthropic-ai/claude-code
   claude auth login
   claude auth status
   ```

3. **Pair the machine.** The controller's operator mints a short-lived, single-use code and gives
   you the command to run; it has this shape, with `--controller` naming the controller's http(s)
   origin:

   ```sh
   periscope pair <code> --controller https://controller.example --label "build box"
   ```

   The controller's answer carries the two addresses the host dials, and `pair` writes them to the
   config file beside the credential, so nothing else needs setting.

4. **Start it, and ask it.**

   ```sh
   periscope
   ```

   In another shell, `periscope status` prints the whole posture: the version, the link's state and
   last transition, the credential kind, the host id, the workspace mode, and every setting with the
   source it came from. It reads what `serve` left behind and never dials, so it answers even when
   the link is down.

Run the host under a supervisor (systemd, a Windows service, a container's init) so it restarts;
[Running unattended](#running-unattended) says what to expect from it. To give sessions a
repository and a worktree each instead of a bare directory, see [Configuration](#configuration).

## Quick start for a controller author

A host needs two things on the other end: a WebSocket it dials and an HTTP endpoint it sends
permission decisions to. Install the package for the wire types (`@naswerks/periscope/protocol`
reaches no filesystem or process code) and `ws` for the socket:

```sh
npm install @naswerks/periscope ws
```

### The minimal controller

This is the smallest controller that provides both transports; it welcomes the host, answers its
heartbeat, acks every frame and denies every tool call. It is
[`examples/minimal-controller/controller.ts`](examples/minimal-controller/controller.ts), verbatim:

```ts
// The smallest controller that completes a link: the WebSocket the host dials, answering the hello,
// the heartbeat and every session frame's ack, and the HTTP endpoint that denies every tool call.
// Both transports are required; a host with nowhere to send a decision refuses to start.
import { createServer } from 'node:http';
import { WebSocketServer, type RawData } from 'ws';
import { PROTOCOL_VERSION, decode, encode, type ControlPayload } from '@naswerks/periscope/protocol';

const text = (data: RawData): string =>
  Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data as ArrayBuffer)]).toString('utf8');

new WebSocketServer({ port: 8790, path: '/link' }).on('connection', (socket) => {
  const control = (payload: ControlPayload): void => {
    const frame = encode({ frame: 'control', at: new Date().toISOString(), payload });
    if (frame.ok) socket.send(frame.value);
  };
  socket.on('message', (data) => {
    const frame = decode(text(data));
    if (!frame.ok) return;
    if (frame.value.frame === 'session') {
      control({ kind: 'link_ack', cursors: [{ sessionId: frame.value.sessionId, seq: frame.value.seq }] });
    } else if (frame.value.payload.kind === 'link_hello') {
      control({ kind: 'link_welcome', protocolVersion: PROTOCOL_VERSION, capabilities: [], cursors: [] });
    } else if (frame.value.payload.kind === 'link_ping') {
      control({ kind: 'link_pong', nonce: frame.value.payload.nonce });
    }
  });
});

createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({ behavior: 'deny', message: 'the minimal controller denies every tool call' }),
  );
}).listen(8791);

console.log(
  'PERISCOPE_CONTROLLER_URL=ws://127.0.0.1:8790/link PERISCOPE_DECISION_URL=http://127.0.0.1:8791/decisions',
);
```

Run it with `node examples/minimal-controller/controller.ts` from a clone of this repository after
`npm ci && npm run build` (Node 22.18 or later strips the types itself), export the two URLs it
prints, and start a host with `periscope`. A controller that decides, serves tools, receives bulk
content, pairs hosts and drives every host-scoped ask is the reference under
[`examples/test-controller/`](examples/README.md); `node examples/test-controller/serve.ts` runs it
and prints the exact `periscope pair` line that redeems a code against it. From there,
[the wire protocol](docs/protocol.md) is the contract: the envelope, the sequence rules, the
handshake, pairing, the decision endpoint's request and answer, and a checklist of what a controller
owes. `contracts/wire-vectors/` is the same contract as bytes, for a controller in any language.

> **A controller serves two transports, and the second one is easy to miss.** Frames ride the
> WebSocket. The permission gate does not: when a tool call needs a decision, the host sends an
> ordinary HTTP POST to a URL you configure (`PERISCOPE_DECISION_URL`) and waits for the decision in
> the response body. Nothing on the wire announces that URL, so a controller that implements only
> the link will connect, stream, and then silently fail to answer the one question that blocks an
> agent. `@naswerks/periscope/protocol` exports `Decision`, `DecisionRequest`, `Decider` and
> `EscalationTransport`, so the endpoint is typed without the privileged entry point.

## Point it at a controller

The long form of the operator quick start, for a host set up by hand or by a supervisor's
environment rather than by `pair`.

1. Set the two URLs. `PERISCOPE_CONTROLLER_URL` is the WebSocket the host dials;
   `PERISCOPE_DECISION_URL` is the HTTP endpoint it POSTs permission escalations to. Either can go
   in the environment or the config file (`periscope config PERISCOPE_CONTROLLER_URL wss://...`);
   the environment wins per key. A value the host would refuse at start (an `https:` controller
   URL, a `ws:` decision URL, a relative root) is refused by `periscope config` before it is
   written.
2. Choose a credential, or none:
   - `periscope pair <code> --controller <origin> --label <name>` trades a short-lived code minted by
     the controller for this machine's durable credential and writes the two URLs the controller
     answers with (see [identity](docs/identity.md)); or
   - set `PERISCOPE_IDENTITY_AUTHORITY` and `PERISCOPE_IDENTITY_CLIENT_ID` and run
     `periscope login` to sign in as a user; or
   - set neither, and the host dials without authentication and says so.
3. Start it: `periscope` with no arguments is `periscope serve`.
4. Ask it: `periscope status`.

Every line of output is `<ISO timestamp> [channel] message`, with a detail after a dash when there
is one. The first lines of a host with no identity configured look like this:

```
2026-09-08T12:00:00.000Z [host] periscope 1.0.0 · host build-box · credential absent · workspace none · config file /home/agent/.periscope/config.json
2026-09-08T12:00:00.000Z [credential] absent - no identity is configured, so this host will dial without authentication
2026-09-08T12:00:00.010Z [link] idle -> connecting (start_requested)
2026-09-08T12:00:00.250Z [link] connecting -> open (socket_connected)
2026-09-08T12:00:00.310Z [link] open -> accepted (hello_completed)
```

A paired host prints `[credential] paired as <hostId> - the paired credential is presented on every
dial` instead; a host on a signed-in token prints its first `[credential]` line (`cache-hit`,
`refreshed` or `refused`) when the first dial presents it. `open` is the socket; `accepted` is the
controller's welcome, and the link stays there. A rejected handshake, a dropped socket or a missed
heartbeat moves it to `backoff` with the cause named.

The host refuses to start, with the reason on stderr and a non-zero exit, when:

- the effective uid is 0 (an unattended agent as root has the whole machine on every tool call, and
  a container built the obvious way runs as root; refused by policy, before anything else is read);
- the config file exists but is not usable (not JSON, not one object of strings, or carrying a key
  outside the closed set);
- `PERISCOPE_CONTROLLER_URL` is unset, or `PERISCOPE_DECISION_URL` is unset (a host with nowhere to
  send a permission decision would either be an open door or a session where nothing runs), or
  either carries a scheme it cannot use;
- the workspace posture is inconsistent: `PERISCOPE_WORKSPACE_KEY` without `PERISCOPE_WORKSPACE_ROOT`,
  `PERISCOPE_BRANCH_SCHEME` without both roots, a scheme with an unknown placeholder or an unmatched
  brace, a scheme whose literal text renders an illegal branch name, a relative root or agent home,
  or a default key that fails the same screen a wire-supplied key must pass;
- a paired-credential file exists but cannot be read;
- the identity configuration is partial or wrong: one of the authority/client-id pair without the
  other, a non-https authority, one of the authorize/token endpoints without the other, a redirect
  port outside 0-65535, or a scopes variable set to nothing;
- identity is configured but there is nowhere to keep the token cache (no home directory and no
  `PERISCOPE_CONFIG_DIR`).

After start-up, one link event is fatal: `credential_rejected`. The controller or its identity
provider has refused the host's material, so the process stops its sessions, prints the remedy
(`periscope pair <code>` for a paired host, `periscope login` otherwise) and exits non-zero.

## Configuration

Every setting is an environment variable. The eight marked "config-file key" below can also live in
the config file (`<config dir>/config.json`, written by `periscope config <key> <value>`, removed by
`periscope config --unset <key>`, listed by `periscope config`); the file fills absences only, so a
value set in the environment is never shadowed by it, and the listing says which values the
environment is currently overriding. On Windows, `periscope config` is the way to set a value that
should outlive the shell.

Which directory a session runs in is the one choice worth making deliberately:

| Roots set                                                | Where a session runs                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| neither                                                  | the `cwd` the controller names, verbatim; a `session_new` with `cwd: null` is refused                                    |
| `PERISCOPE_WORKSPACE_ROOT`                               | a plain directory beneath it, one per workspace key (the session key unless the controller names one)                    |
| `PERISCOPE_WORKSPACE_ROOT` + `PERISCOPE_REPOSITORY_ROOT` | a linked git worktree of the repository on its own branch (`PERISCOPE_BRANCH_SCHEME`, default `{repo}/{key}`); needs git |

### Environment

| Variable                             | Meaning                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERISCOPE_CONTROLLER_URL`           | Required by `serve`. The WebSocket URL the host dials (`ws:`/`wss:`). Config-file key; settable over the link, in effect at the next start.                                                                                                                                  |
| `PERISCOPE_DECISION_URL`             | Required by `serve`. The HTTP endpoint the host POSTs each permission escalation to (`http:`/`https:`; settable over the link, in effect at the next start). Its origin is also where `pair` derives the redemption URL when `PERISCOPE_PAIR_URL` is unset. Config-file key. |
| `PERISCOPE_HOST_ID`                  | The id announced in `link_hello`. Defaults to the machine hostname (an empty value counts as unset); a paired credential's host id overrides it, and the override is logged when the two differ. Config-file key.                                                            |
| `PERISCOPE_WORKSPACE_ROOT`           | When set, every session gets a directory beneath it instead of the `cwd` the controller named. Config-file key.                                                                                                                                                              |
| `PERISCOPE_REPOSITORY_ROOT`          | With `PERISCOPE_WORKSPACE_ROOT`, sessions get a linked git worktree of this repository on their own branch instead of a plain directory. Config-file key.                                                                                                                    |
| `PERISCOPE_BRANCH_SCHEME`            | The branch-name template those worktrees use; placeholders are `{key}` and `{repo}` (the repository directory's name). Default `{repo}/{key}`. Needs both roots. Screened at start-up. Config-file key.                                                                      |
| `PERISCOPE_WORKSPACE_KEY`            | The workspace key an unkeyed `session_new` provisions at. Needs `PERISCOPE_WORKSPACE_ROOT`. Screened at start-up. Config-file key.                                                                                                                                           |
| `PERISCOPE_AGENT_HOME`               | The agent's home: the folder the agent CLI keeps its state in. Transcripts are read from `<home>/projects` (derived, reported in the hello, never set on its own). Default: the CLI's own, `<user home>/.claude`. Must be absolute. Config-file key.                         |
| `PERISCOPE_CONFIG_DIR`               | The directory holding the token cache, the paired credential and the config file. Default `<home>/.periscope`, where home is `USERPROFILE` or `HOME`. The whole directory is in the gate's protected set. Deliberately not a config-file key.                                |
| `PERISCOPE_PAIR_URL`                 | Where `periscope pair` redeems a code when no `--controller` is given. Default: the origin of `PERISCOPE_DECISION_URL` plus the controller's pair route.                                                                                                                     |
| `PERISCOPE_MACHINE_LABEL`            | The label sent with a pair request when no `--label` is given, shown in the controller's listings. Default: the hostname.                                                                                                                                                    |
| `PERISCOPE_IDENTITY_AUTHORITY`       | The OIDC issuer URL; https is required, `localhost` included. With `PERISCOPE_IDENTITY_CLIENT_ID` it enables identity; one without the other refuses start.                                                                                                                  |
| `PERISCOPE_IDENTITY_CLIENT_ID`       | The public-client id registered with the provider.                                                                                                                                                                                                                           |
| `PERISCOPE_IDENTITY_SCOPES`          | Space- or comma-separated scopes. Default `openid profile offline_access`. Set to nothing, it refuses start.                                                                                                                                                                 |
| `PERISCOPE_IDENTITY_AUTHORIZE_URL`   | The authorization endpoint. Set together with `PERISCOPE_IDENTITY_TOKEN_URL` or not at all; when both are unset they are discovered from the authority.                                                                                                                      |
| `PERISCOPE_IDENTITY_TOKEN_URL`       | The token endpoint. Same rule as above.                                                                                                                                                                                                                                      |
| `PERISCOPE_IDENTITY_DEVICE_CODE_URL` | The device-authorization endpoint. Read only when the two endpoints above are set; on its own it is ignored.                                                                                                                                                                 |
| `PERISCOPE_IDENTITY_REDIRECT_PORT`   | The loopback listener's port, an integer 0-65535. Default 0 (an ephemeral port).                                                                                                                                                                                             |
| `PERISCOPE_IDENTITY_DEVICE_CODE`     | `1` enables the device-code fallback. Off otherwise, and never reached by falling back.                                                                                                                                                                                      |
| `PERISCOPE_LIVE`                     | Tests only. `1` runs the probes that need a real agent (`npm run test:live`).                                                                                                                                                                                                |
| `PERISCOPE_PROOF_OUT`                | Examples only. A file path the parallel-run proof writes its full report to.                                                                                                                                                                                                 |
| `PERISCOPE_FC_SEED`                  | Tests only. The property-test seed: a number reproduces a reported failure, `random` explores.                                                                                                                                                                               |
| `PERISCOPE_UPDATE_CONTRACTS`         | Tests only. Set by `npm run contracts:update` while it re-approves the snapshots under `contracts/`.                                                                                                                                                                         |

`CLAUDE_CONFIG_DIR`, when set, and `PERISCOPE_AGENT_HOME`, when it is not the default, are added to
the gate's protected paths; the full set is listed in [the gate](docs/gate.md).

A controller can set six of the config-file keys over the link (`host_configure`): the two roots,
the branch scheme, the agent home, and the two controller URLs. The host screens the whole set
before writing, refuses a change to a workspace root while any session is live or opening, and
answers with the effective values plus the keys its environment shadows. The two URLs are written
but never applied to the live link: the host keeps dialling what it dialled, names them as pending
in its answer and in every hello, and the next start reads the file. The host id is never settable
over the link. A controller can also list one directory or read the head of one text file under the
repository root (`repository_list` / `repository_read`), jailed to that root and to the protected
set, bounded, and text-only. [The wire protocol](docs/protocol.md) states both doors.

## Identity

Three postures, and the one to choose for an unattended host is the first:

- **Paired.** `periscope pair <code>` trades a controller-minted code for this machine's own
  credential, which has no clock and dies only when the controller revokes it. Revocation is the
  controller refusing the bearer at the upgrade; the host exits naming the remedy.
- **Signed in.** `periscope login` signs a real user in through a generic OIDC client (loopback
  with PKCE; device code opt-in) and presents that user's own token. A provider may let the refresh
  token lapse after a period of inactivity, which is the wrong shape for a machine nobody sits at.
- **None.** The host dials without a header and says so at start-up.

The credential files live under the config directory, written `0600` and verified. On Windows that
mode is not real: the host measures what the filesystem records and reports `write-bit-only` or
`unobservable` rather than claiming a privacy it cannot verify, and the file's protections there are
the gate's credential-path denial, your controller and your OS account. The agent's own sign-in is
a separate credential, under the agent home; [identity](docs/identity.md) states all of it.

## Why there is no permission prompt

Periscope runs the agent headless under the Agent SDK, and a headless session has no interactive
prompt. Periscope does not pass `--dangerously-skip-permissions` and sets no permission mode; it
registers a `PreToolUse` hook on every session, and that hook is the only path to a yes. Read on
its own that looks like the safety being turned off. It is the opposite: the interactive prompt is
replaced by a stricter gate, not removed.

The prompt asks a human at the keyboard, which is a fine control while someone is sitting there.
Periscope exists for when nobody is, so the choice is _a stricter gate_ or _no gate_, and the gate
it ships is:

- **Fail-closed on every path.** No answer, any error, any timeout, any outage: the tool does not
  run. A hook that _throws_ is treated by the SDK as absent, so every handler is wrapped and
  returns an explicit deny.
- **Offline-provable, for the local classes.** A local rule refuses path escapes, reads of the
  credential set and unrecognised git verbs _before_ your controller is consulted, by parsing the
  command rather than matching strings, so a compromised or unreachable controller cannot turn those
  into a yes. A boundary-crossing command (a push, a force, a branch deletion) is escalated to the
  controller like any other call, and with the controller unreachable it refuses at the deadline.
- **Auditable.** Every call, decision and reason is a state transition on the wire. The prompt
  records nothing.

The gate has no opinion about `mcp__*` tools by default. The local rule matches on tool name, your
tool matches nothing, and the decision escalates: fail-closed and correct, but it means your gate is
offline-provable for `Bash` and not for your own tools. Naming them in
`PeriscopeHostOptions.toolFamilies` (embedder-supplied data) closes it. `strictMcpConfig` defaults
on, so only the MCP servers a controller declared exist for a session. [`SECURITY.md`](SECURITY.md)
states the posture in full, including what a paired controller can reach on the machine; read it
before you install this. [The gate](docs/gate.md) is the mechanism.

## The connection and the frame contract

The host dials out. The daemon listens on no port, which is what lets it run on a machine behind a
firewall that would never allow one (the one listener in the package is the loopback that an
interactive `periscope login` opens for a single callback). It opens a single WebSocket to the
controller and keeps it alive: a heartbeat in both directions, exponential jittered backoff, a
bounded offline queue, and backpressure that slows the host rather than growing its heap. The link
carries commands and facts, never bulk content: a transcript leaves by an HTTP POST the controller
asks for, and a frame over `MAX_FRAME_BYTES` is refused, never truncated.

Every frame is `{ frame, at, payload }`, with `payload` discriminated on `kind`. Session frames add
`sessionId` and `seq`, and `seq` is dense per session per direction, minted at the first write, so a
gap is arithmetic and a re-delivered frame is a silent duplicate. A frame is held until the
controller acknowledges it and replayed after a reconnect from the cursors the controller reports.
Two lanes ride the link: `session_update` carries facts (the assistant message, the result, every
state transition the machine records, the session's end) and is never dropped; `session_delta`
carries streamed fragments and is the one droppable kind. The `sessionId` on a frame is the
controller's handle, not the agent's id; the two are never interchangeable.

[The wire protocol](docs/protocol.md) is the contract: the sequence rules, the handshake, pairing,
the two lanes, every command and host-scoped ask, the bulk lane, the decision endpoint, the refusal
vocabulary, the vectors, and the controller's obligations as a checklist.

## Running unattended

Run the host under a supervisor and let it restart. It exits 0 on SIGTERM or SIGINT after ending
its sessions, and 1 when its credential is refused (`credential_rejected`, above) or when its
configuration refuses at start; every other failure is retried with backoff, forever, and
`periscope status` says where it is.

## Two constraints, before you deploy

**One controller, one replica.** The sequence and retention model assumes one controller process on
the other end of the link: sequence numbers are dense per session per direction, a frame is held
until that controller acks it, and the host-scoped channel is numbered per link. Two replicas behind
one address would each see the other's frames as gaps. Run one controller instance per host.

**The handshake is a protocol version window.** The host's `link_hello` carries `protocolRange`
beside `protocolVersion`; the controller answers with the version it chose inside the overlap, and
the host accepts any version in its own window. From the next protocol bump on, the version before
the current one stays supported for one release, so a controller and a host one release apart still
connect and either can upgrade first. A controller outside the window is refused by name
(`protocol_version_rejected`, naming both windows) and the host retries with backoff, forever, until
one side moves.

## Does it work, and against what

`npm test` is a clean build followed by `node --test` over the compiled output, and it prints four
numbers per platform: tests, pass, fail, skipped. The skips are the live probes, which need a real
agent (`PERISCOPE_LIVE=1 npm run test:live`; on PowerShell, `$env:PERISCOPE_LIVE = '1'` first) and
spend tokens, plus one platform-only case. CI runs the suite on `{ubuntu-latest, windows-latest}`
x node `{22, 24}` on every change, ratchets line coverage against `coverage.floor` (a floor set from
what the suite achieved, never chosen in advance), packs the tarball and installs it into an empty
project, and runs mutation testing weekly. Both operating systems are load-bearing: Windows is
where `USERPROFILE`, `windowsHide`, case-insensitive env matching and path handling are observable,
and Linux is the only place POSIX file modes mean anything at all. The figure for a release is
recorded in `CHANGELOG.md`.

### Versions tested

|                                  |                                       |
| -------------------------------- | ------------------------------------- |
| `@anthropic-ai/claude-agent-sdk` | **0.3.220**, pinned exactly, no caret |
| Claude Code CLI                  | **2.1.220** (bundled with that SDK)   |
| Node                             | 22 or later; CI proves 22 and 24      |

The SDK is pre-1.0 and its surface moves without semver protection, so the SHA-256 of the installed
`sdk.d.ts` is kept in `contracts/sdk.sha256` and a CI job fails on any difference between the
installed types and that baseline; the SDK's own files are not redistributed. A bump cannot land
without someone reading what changed (`npm run check:drift -- --update` accepts a new baseline).

## Versioning

The package follows semantic versioning; the wire protocol version is a separate number with its
own window. Patch: no wire or API change. Minor: a protocol bump, an SDK pin bump, or an additive
API. Major: a wire change outside the window, or a removed or changed export.
`contracts/public-api.txt` is what "export" means.

## Naming

Method and field naming follows the [Agent Client Protocol](https://agentclientprotocol.com) (Zed
Industries, Apache-2.0): `session/new`, `session/prompt`, `session/cancel`, `session/update`, plus
its camelCase keys and snake_case discriminators, so that an ACP adapter would be a translation
layer rather than a re-modelling.

This is not ACP compatibility, and Periscope must not be described as ACP-compatible. ACP points
the connection inbound; Periscope dials out, so no ACP client can reach it. The names are borrowed;
every type here is written from scratch and derived from none of ACP's artifacts.

Elsewhere the vocabulary is the SDK's own: session, message, hook, tool, subagent, turn, result.
Controller-side vocabulary has no place in this package, and a test enforces it.

## Documents

- [architecture](docs/architecture.md), [the wire protocol](docs/protocol.md),
  [the state machine](docs/state-machine.md), [the gate](docs/gate.md),
  [identity](docs/identity.md): the contract.
- [`examples/`](examples/README.md): the minimal controller, the reference controller, the proof.
- [`SECURITY.md`](SECURITY.md): the posture, and where to report a vulnerability.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): building, the kinds of tests, the pins, releasing.
- [`CHANGELOG.md`](CHANGELOG.md). Licence: [MIT](LICENSE).
