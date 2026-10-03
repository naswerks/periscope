# Configuration

Everything the host reads at start, where it comes from, and what it prints. The short version: a
paired host needs nothing set by hand. `periscope pair <code> --controller <origin>` writes the two
addresses the controller answers with, and `periscope` reads them. Everything below is for a host
set up by a supervisor's environment, for sessions that need a repository and a worktree each, and
for the questions a running host answers.

A setting arrives one of three ways, and the order is the rule:

1. **The environment** always wins, per key.
2. **The config file** (`<config dir>/config.json`) fills absences. `periscope config <key> <value>`
   writes one key, `periscope config --unset <key>` removes it, `periscope config` lists the file and
   marks every value the environment is currently overriding. On Windows this is the way to set a
   value that should outlive the shell. Only the nine keys marked "config-file key" below may live
   in the file; a value the host would refuse at start (an `https:` controller address, a `ws:`
   decision address, a relative root) is refused by `periscope config` before it is written.
3. **The controller, over the link** (`host_configure`) writes seven of those keys to the file; see
   [what a controller can set](#what-a-controller-can-set-over-the-link).

## The two addresses

`PERISCOPE_CONTROLLER_URL` is the WebSocket the host dials (`ws:` or `wss:`).
`PERISCOPE_DECISION_URL` is the HTTP endpoint it POSTs every permission decision to (`http:` or
`https:`). Both are required by `serve`; a host with nowhere to send a decision would be an open
door or a session where nothing runs, so it refuses to start instead. `pair` writes both when the
controller's answer names them, which every controller built on the reference does.

A controller on a development certificate (a local build serving `https://localhost:…`) is refused by
Node's certificate check like any other self-signed server: `pair` reports the certificate by its
code (`DEPTH_ZERO_SELF_SIGNED_CERT`), and `serve` reports it on the link. Export the certificate
as PEM and point Node at the file with `NODE_EXTRA_CA_CERTS`, set for the user so every new terminal
carries it. For the ASP.NET Core development certificate:

```powershell
dotnet dev-certs https --export-path "$env:USERPROFILE\.periscope\aspnet-dev.pem" --format PEM --no-password
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', "$env:USERPROFILE\.periscope\aspnet-dev.pem", 'User')
```

```sh
dotnet dev-certs https --export-path ~/.periscope/aspnet-dev.pem --format PEM --no-password
export NODE_EXTRA_CA_CERTS=~/.periscope/aspnet-dev.pem   # in the shell profile
```

The export writes the private key beside the certificate (`aspnet-dev.key`); delete it, only the
certificate is read. Then run `pair` and `serve` in a new terminal. Node's `--use-system-ca` does not accept the
development certificate even when the operating system trusts it. `NODE_TLS_REJECT_UNAUTHORIZED=0`
also works and trusts every certificate the host meets; prefer the file.

## Where sessions run

Which directory a session runs in is the one choice worth making deliberately:

| Roots set                                                | Where a session runs                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| neither                                                  | the `cwd` the controller names, verbatim; a `session_new` with `cwd: null` is refused                                    |
| `PERISCOPE_WORKSPACE_ROOT`                               | a plain directory beneath it, one per workspace key (the session key unless the controller names one)                    |
| `PERISCOPE_WORKSPACE_ROOT` + `PERISCOPE_REPOSITORY_ROOT` | a linked git worktree of the repository on its own branch (`PERISCOPE_BRANCH_SCHEME`, default `{repo}/{key}`); needs git |

From a terminal on the host:

```sh
periscope config PERISCOPE_REPOSITORY_ROOT /srv/checkouts/my-repo
periscope config PERISCOPE_WORKSPACE_ROOT /srv/workspaces
```

Restart the host; `periscope status` reports `workspace git-worktree` and the branch scheme. A
controller can set the same two keys over the link (`host_configure`) and the host rebuilds its
workspace provider live, except while a session is open or opening.

## Environment

| Variable                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERISCOPE_CONTROLLER_URL`           | Required by `serve`. The WebSocket URL the host dials (`ws:`/`wss:`). Config-file key; settable over the link, in effect at the next start.                                                                                                                                                                                                                                                                                                                            |
| `PERISCOPE_DECISION_URL`             | Required by `serve`. The HTTP endpoint the host POSTs each permission escalation to (`http:`/`https:`; settable over the link, in effect at the next start). Its origin is also where `pair` derives the redemption URL when `PERISCOPE_PAIR_URL` is unset. Config-file key.                                                                                                                                                                                           |
| `PERISCOPE_HOST_ID`                  | The id announced in `link_hello`. Defaults to the machine hostname (an empty value counts as unset); a paired credential's host id overrides it, and the override is logged when the two differ. Config-file key.                                                                                                                                                                                                                                                      |
| `PERISCOPE_WORKSPACE_ROOT`           | When set, every session gets a directory beneath it instead of the `cwd` the controller named. Config-file key.                                                                                                                                                                                                                                                                                                                                                        |
| `PERISCOPE_REPOSITORY_ROOT`          | With `PERISCOPE_WORKSPACE_ROOT`, sessions get a linked git worktree of this repository on their own branch instead of a plain directory. Config-file key.                                                                                                                                                                                                                                                                                                              |
| `PERISCOPE_BRANCH_SCHEME`            | The branch-name template those worktrees use; placeholders are `{key}` and `{repo}` (the repository directory's name). Default `{repo}/{key}`. Needs both roots. Screened at start-up. Config-file key.                                                                                                                                                                                                                                                                |
| `PERISCOPE_WORKSPACE_KEY`            | The workspace key an unkeyed `session_new` provisions at. Needs `PERISCOPE_WORKSPACE_ROOT`. Screened at start-up. Config-file key.                                                                                                                                                                                                                                                                                                                                     |
| `PERISCOPE_AGENT_HOME`               | The agent's home: the folder the agent CLI keeps its state in. Transcripts are read from `<home>/projects` (derived, reported in the hello, never set on its own). Default: the CLI's own, `<user home>/.claude`. Must be absolute. Config-file key.                                                                                                                                                                                                                   |
| `PERISCOPE_PLUGIN_DIRS`              | Plugin directories every session loads, a path list in the platform's delimiter (`;` on Windows, `:` elsewhere), at most `MAX_PLUGIN_DIRS`. Each is a plugin root: absolute, present, carrying `.claude-plugin/plugin.json` with a `name`; refused by name at start and at every open otherwise. The manifests' names and versions ride the hello as `configuration.plugins`. A controller's own `session_new.request.plugins` are added after these. Config-file key. |
| `PERISCOPE_CONFIG_DIR`               | The directory holding the token cache, the paired credential and the config file. Default `<home>/.periscope`, where home is `USERPROFILE` or `HOME`. The whole directory is in the gate's protected set. Deliberately not a config-file key.                                                                                                                                                                                                                          |
| `PERISCOPE_PAIR_URL`                 | Where `periscope pair` redeems a code when no `--controller` is given. Default: the origin of `PERISCOPE_DECISION_URL` plus the controller's pair route.                                                                                                                                                                                                                                                                                                               |
| `PERISCOPE_MACHINE_LABEL`            | The label sent with a pair request when no `--label` is given, shown in the controller's listings. Default: the hostname.                                                                                                                                                                                                                                                                                                                                              |
| `PERISCOPE_IDENTITY_AUTHORITY`       | The OIDC issuer URL; https is required, `localhost` included. With `PERISCOPE_IDENTITY_CLIENT_ID` it enables identity; one without the other refuses start.                                                                                                                                                                                                                                                                                                            |
| `PERISCOPE_IDENTITY_CLIENT_ID`       | The public-client id registered with the provider.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PERISCOPE_IDENTITY_SCOPES`          | Space- or comma-separated scopes. Default `openid profile offline_access`. Set to nothing, it refuses start.                                                                                                                                                                                                                                                                                                                                                           |
| `PERISCOPE_IDENTITY_AUTHORIZE_URL`   | The authorization endpoint. Set together with `PERISCOPE_IDENTITY_TOKEN_URL` or not at all; when both are unset they are discovered from the authority.                                                                                                                                                                                                                                                                                                                |
| `PERISCOPE_IDENTITY_TOKEN_URL`       | The token endpoint. Same rule as above.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PERISCOPE_IDENTITY_DEVICE_CODE_URL` | The device-authorization endpoint. Read only when the two endpoints above are set; on its own it is ignored.                                                                                                                                                                                                                                                                                                                                                           |
| `PERISCOPE_IDENTITY_REDIRECT_PORT`   | The loopback listener's port, an integer 0-65535. Default 0 (an ephemeral port).                                                                                                                                                                                                                                                                                                                                                                                       |
| `PERISCOPE_IDENTITY_DEVICE_CODE`     | `1` enables the device-code fallback. Off otherwise, and never reached by falling back.                                                                                                                                                                                                                                                                                                                                                                                |
| `PERISCOPE_LIVE`                     | Tests only. `1` runs the probes that need a real agent (`npm run test:live`).                                                                                                                                                                                                                                                                                                                                                                                          |
| `PERISCOPE_PROOF_OUT`                | Examples only. A file path the parallel-run proof writes its full report to.                                                                                                                                                                                                                                                                                                                                                                                           |
| `PERISCOPE_FC_SEED`                  | Tests only. The property-test seed: a number reproduces a reported failure, `random` explores.                                                                                                                                                                                                                                                                                                                                                                         |
| `PERISCOPE_UPDATE_CONTRACTS`         | Tests only. Set by `npm run contracts:update` while it re-approves the snapshots under `contracts/`.                                                                                                                                                                                                                                                                                                                                                                   |

The agent CLI's token cache and configuration file in `CLAUDE_CONFIG_DIR`, when set, and in
`PERISCOPE_AGENT_HOME`, when it is not the default, are added to the gate's protected paths; the full
set is listed in [the gate](gate.md).

## What a controller can set over the link

`host_configure` accepts seven of the config-file keys: `PERISCOPE_WORKSPACE_ROOT`,
`PERISCOPE_REPOSITORY_ROOT`, `PERISCOPE_BRANCH_SCHEME`, `PERISCOPE_AGENT_HOME`,
`PERISCOPE_PLUGIN_DIRS`, `PERISCOPE_CONTROLLER_URL`, `PERISCOPE_DECISION_URL`. A written plugin
directory is loaded by the next open; the answer's `configuration.plugins` says what each one names. The host screens the whole set before writing,
refuses a change to a workspace root while any session is live or opening, and answers with the
effective values plus the keys its environment shadows. The two addresses are written but never
applied to the live link: the host keeps dialling what it dialled, names them as pending in its
answer and in every hello, and the next start reads the file. The host id is never settable over the
link. A controller can also list one directory or read the head of one text file under the
repository root (`repository_list` / `repository_read`), jailed to that root and to the protected
set, bounded, and text-only; and read a text file inside a workspace this host provisioned, a page at
a time, by the workspace's key (`workspace_read`), under the same jail and protected set. [The wire
protocol](protocol.md) states the three doors.

## The agent: models, effort, thinking, plugins and tools

What follows was measured on Claude Code 2.1.284 by `src/host/agent-controls.live.test.ts`, run from
inside an agent session. Re-measure it after an agent SDK bump.

**The model catalog.** Before it dials, `serve` asks the agent which models it offers.

- It starts the agent with no prompt, reads the models from the agent's answer to the SDK's
  initialize request, and closes it. That took under a second, wrote no transcript and left no
  process running; the read is bounded at 20 seconds.
- The hello carries the list as `configuration.agent` ([the wire protocol](protocol.md)).
- A session takes a model by the catalog's `value`: an alias (`default`, `opus`, `sonnet`, `haiku`)
  or a full id. `resolvedModel` names the model the alias runs today.

**Switching the model.** `session_configure.model` switches a running session.

- The host answers the SDK's `PreModelSwitch` with allow, so a controller's switch never waits on
  the interactive cache-miss confirm. A headless switch after a warm turn went through with that
  answer and without it.
- The switch is recorded when it happens (`PostModelSwitch`), with the estimated cost of re-caching
  the context on the new model.

**Effort.** `session_new.request.effort` sets it at start, and `session_configure.effort` changes it
mid-session.

- The levels are `low`, `medium`, `high`, `xhigh` and `max`; the catalog's `supportedEffortLevels`
  says which a model takes.
- A `sonnet` session started at `low` ran its next turn at `high` after a change, as its `Stop`
  hook reported.
- `max` runs as `high` on a model without it, and never above the organisation's limit.
- The SDK turns ultracode off on any change of level sent without an `ultracode` key, and the host
  never sends one.

**Thinking.**

- A session streams thinking prose only when started with `{ type: 'adaptive', display:
'summarized' }`; Opus 5.5, Fable 5.1 and Sonnet 5.5 each did, at `max` effort.
- `{ type: 'disabled' }` starts normally on all three but does not stop them thinking: at `max`
  effort every turn still carried a thinking block, with no prose. Read it as "no prose", not "no
  thinking".
- On a session started disabled, a `session_configure` asking for `{ type: 'adaptive', display:
'summarized' }` brings the prose back from its next turn. The host sends the SDK a positive
  thinking cap (`THINKING_ON_CAP`) for this, because a cleared cap did not bring it back on any of
  the three.
- A fixed budget (`{ type: 'enabled' }`) is refused by name.

**Plugins.** Plugins reach the agent over stdin, not as one command-line flag each, so several
directories stay clear of the Windows command-line limit. A custom `spawn` must run a CLI of 2.1.261
or later.

- The agent names a directory that did not load in its init message's `plugin_errors`, with its path
  (type `path-not-found` for a missing one).
- `HostedSessionFacts.pluginsApplied` is the agent's own answer, and it read `true` with a missing
  directory in the list, so `plugin_errors` is where a failure shows.
- A session's `plugins` also lists the agent's built-in plugins, with the path `builtin`.
- The host refuses a configured directory that is missing before any process starts, so only a
  controller's own `session_new.request.plugins` can reach the agent missing.

**The task-list tools.** A Sonnet 5.5 session's tools do not include `TaskCreate`, `TaskGet`,
`TaskList` and `TaskUpdate` by default. `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the session's
environment adds them; a controller sets it through `session_new.request.env.extraEnv`.

## What the host prints

Every line of output is `<ISO timestamp> [channel] message`, with a detail after a dash when there
is one. The first lines of a host with no identity configured look like this:

```
2026-09-08T12:00:00.000Z [host] periscope 1.3.0 · host build-box · credential absent · workspace none · config file /home/agent/.periscope/config.json
2026-09-08T12:00:00.000Z [credential] absent - no identity is configured, so this host will dial without authentication
2026-09-08T12:00:00.900Z [agent] Claude Code 2.1.284 (agent SDK 0.3.284), 12 model(s) in the hello
2026-09-08T12:00:00.910Z [link] idle -> connecting (start_requested)
2026-09-08T12:00:01.150Z [link] connecting -> open (socket_connected)
2026-09-08T12:00:01.210Z [link] open -> accepted (hello_completed)
```

The `[agent]` line comes from the model catalog the host reads before it dials (below). When the read
fails it says `the hello carries no model catalog` with the reason, and the host dials anyway.

A paired host prints `[credential] paired as <hostId> - the paired credential is presented on every
dial` instead; a host on a signed-in token prints its first `[credential]` line (`cache-hit`,
`refreshed` or `refused`) when the first dial presents it. `open` is the socket; `accepted` is the
controller's welcome, and the link stays there. A rejected handshake, a dropped socket or a missed
heartbeat moves it to `backoff` with the cause named.

`periscope status` prints the same posture whole, from the record `serve` keeps beside the
credentials, so it answers even when the link is down and never dials: the version, the link's state
and last transition, the credential kind and its expiry or none, the host id and whether the paired
credential overrides the configured one, the workspace mode and branch scheme, the config file's
path, and every setting with the source it came from (environment, config file, default, or unset).

## Why the host refuses to start

With the reason on stderr and a non-zero exit, when:

- the effective uid is 0 (an unattended agent as root has the whole machine on every tool call, and
  a container built the obvious way runs as root; refused by policy, before anything else is read);
- the config file exists but is not usable (not JSON, not one object of strings, or carrying a key
  outside the closed set);
- `PERISCOPE_CONTROLLER_URL` is unset, or `PERISCOPE_DECISION_URL` is unset, or either carries a
  scheme it cannot use;
- the workspace posture is inconsistent: `PERISCOPE_WORKSPACE_KEY` without `PERISCOPE_WORKSPACE_ROOT`,
  `PERISCOPE_BRANCH_SCHEME` without both roots, a scheme with an unknown placeholder or an unmatched
  brace, a scheme whose literal text renders an illegal branch name, a relative root or agent home,
  or a default key that fails the same screen a wire-supplied key must pass;
- a paired-credential file exists but cannot be read;
- the identity configuration is partial or wrong: one of the authority/client-id pair without the
  other, a non-https authority, one of the authorize/token endpoints without the other, a redirect
  port outside 0-65535, or a scopes variable set to nothing;
- identity is configured but there is nowhere to keep the token cache (no home directory and no
  `PERISCOPE_CONFIG_DIR`);
- `PERISCOPE_PLUGIN_DIRS` names more than `MAX_PLUGIN_DIRS` directories, or one that is absent or
  carries no readable manifest.

After start-up, one link event is fatal: `credential_rejected`. The controller or its identity
provider has refused the host's material, so the process stops its sessions, prints the remedy
(`periscope pair <code>` for a paired host, `periscope login` otherwise) and exits non-zero.

## Running unattended

Run the host under a supervisor (systemd, a Windows service, a container's init) and let it restart.
It exits 0 on SIGTERM or SIGINT after ending its sessions, and 1 when its credential is refused
(`credential_rejected`, above) or when its configuration refuses at start; every other failure is
retried with backoff, forever, and `periscope status` says where it is. In a container, do not run
as root, `exec` the process so it receives SIGTERM, and keep the shebang LF (`SECURITY.md` says why
each fails confusingly otherwise).

## Bounds

A host holds at most `maxSessions` sessions at once, live and opening together (the binary's
default is 8; an embedder sets its own): a `session_new` past it is refused `session-cap-reached`
before anything is reserved, and the remedy is another session ending. Each live session queues at
most 16 turns the agent has not yet read; a `session_prompt` past that is refused
`prompt-queue-full` and the session is untouched. Both are wire refusals a controller sees by name.

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
