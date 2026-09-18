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
   value that should outlive the shell. Only the eight keys marked "config-file key" below may live
   in the file; a value the host would refuse at start (an `https:` controller address, a `ws:`
   decision address, a relative root) is refused by `periscope config` before it is written.
3. **The controller, over the link** (`host_configure`) writes six of those keys to the file; see
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
the gate's protected paths; the full set is listed in [the gate](gate.md).

## What a controller can set over the link

`host_configure` accepts six of the config-file keys: `PERISCOPE_WORKSPACE_ROOT`,
`PERISCOPE_REPOSITORY_ROOT`, `PERISCOPE_BRANCH_SCHEME`, `PERISCOPE_AGENT_HOME`,
`PERISCOPE_CONTROLLER_URL`, `PERISCOPE_DECISION_URL`. The host screens the whole set before writing,
refuses a change to a workspace root while any session is live or opening, and answers with the
effective values plus the keys its environment shadows. The two addresses are written but never
applied to the live link: the host keeps dialling what it dialled, names them as pending in its
answer and in every hello, and the next start reads the file. The host id is never settable over the
link. A controller can also list one directory or read the head of one text file under the
repository root (`repository_list` / `repository_read`), jailed to that root and to the protected
set, bounded, and text-only. [The wire protocol](protocol.md) states both doors.

## What the host prints

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
  `PERISCOPE_CONFIG_DIR`).

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
