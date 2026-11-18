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
   value that should outlive the shell. Only the twenty-four keys marked "config-file key" below (`CONFIG_KEYS`) may live
   in the file; a value the host would refuse at start (an `https:` controller address, a `ws:`
   decision address, a relative root) is refused by `periscope config` before it is written.
3. **The controller, over the link** (`host_configure`) writes eight of those keys to the file (`WIRE_CONFIGURABLE_KEYS`); see
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

A host can serve further repositories beside its home one, for sessions that also write in them:

```sh
periscope config PERISCOPE_REPOSITORY_ROOTS "/srv/checkouts/tools:/srv/checkouts/docs"
```

Each is a git work tree, named by its folder (`tools`, `docs`). A `session_new` that names one in
`additionalRepositories` gets its own worktree of it at its workspace key, at
`<workspace root>/.repositories/<name>/<key>`, on the branch the scheme renders for that repository, and
finds its path in `PERISCOPE_WORKTREE_<NAME>`; its writes are admitted there as in its own directory. The
session still runs in its home worktree. The operator's checkout of each repository is never a place a
session's tools may write.

## Environment

| Variable                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERISCOPE_CONTROLLER_URL`           | Required by `serve`. The WebSocket URL the host dials (`ws:`/`wss:`). Config-file key; settable over the link, in effect at the next start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PERISCOPE_DECISION_URL`             | Required by `serve`. The HTTP endpoint the host POSTs each permission escalation to (`http:`/`https:`; settable over the link, in effect at the next start). Its origin is also where `pair` derives the redemption URL when `PERISCOPE_PAIR_URL` is unset. Config-file key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PERISCOPE_HOST_ID`                  | The id announced in `link_hello`. Defaults to the machine hostname (an empty value counts as unset); a paired credential's host id overrides it, and the override is logged when the two differ. Config-file key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PERISCOPE_WORKSPACE_ROOT`           | When set, every session gets a directory beneath it instead of the `cwd` the controller named. Config-file key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PERISCOPE_REPOSITORY_ROOT`          | With `PERISCOPE_WORKSPACE_ROOT`, sessions get a linked git worktree of this repository on their own branch instead of a plain directory. Config-file key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PERISCOPE_REPOSITORY_ROOTS`         | The repositories a session may also write in, beside the one `PERISCOPE_REPOSITORY_ROOT` names: a path list in the platform's delimiter, at most `MAX_REPOSITORIES` (8), each an absolute git work tree, each named by its folder's name. A session that names one in `session_new.additionalRepositories` gets its own worktree of it at its workspace key, under `<workspace root>/.repositories/<name>`; the hello lists them as `configuration.repositories`. Needs both roots. Screened at start-up. Config-file key; settable over the link while no session is live or opening.                                                                                                                                                                                                                                                                                                                     |
| `PERISCOPE_WORKTREE_<NAME>`          | Never read from this host's own environment, and not a config-file key: the host sets it in a session's environment to the path of that session's own worktree of the repository `<NAME>` names (upper-cased, every character outside `A-Z0-9` an underscore), never the repository's root. Every variable starting `PERISCOPE_WORKTREE_` is beneath the env floor, so no controller can set one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PERISCOPE_BRANCH_SCHEME`            | The branch-name template those worktrees use; placeholders are `{key}` and `{repo}` (the repository directory's name). Default `{repo}/{key}`. Needs both roots. Screened at start-up. Config-file key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PERISCOPE_WORKSPACE_KEY`            | The workspace key an unkeyed `session_new` provisions at. Needs `PERISCOPE_WORKSPACE_ROOT`. Screened at start-up. Config-file key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PERISCOPE_AGENT_HOME`               | The agent's home: the folder the agent CLI keeps its state and its sign-in in. Its credential files join the gate's protected set, out of reach of the agent's own tools, and the read doors refuse its `projects` folder whatever their root. Reported in the hello. Default: the CLI's own, `<user home>/.claude`. Must be absolute. Config-file key; settable over the link, in effect at the next start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PERISCOPE_PLUGIN_DIRS`              | Plugin directories every session loads, a path list in the platform's delimiter (`;` on Windows, `:` elsewhere), at most `MAX_PLUGIN_DIRS`. Each is a plugin root: absolute, present, carrying `.claude-plugin/plugin.json` with a `name`; refused by name at start and at every open otherwise. The manifests' names and versions ride the hello as `configuration.plugins`. A controller's own `session_new.request.plugins` are added after these. Config-file key.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PERISCOPE_CONTROLLER_ENV_KEYS`      | The names a controller may place in a session's environment through `session_new.request.env`: `extraEnv` sets one, `extraAllowedKeys` re-admits one this host holds. Comma-separated, matched case-insensitively. Unset declares nothing, and then a `session_new` whose `env` adds any key refuses `env-key-refused`. A name beneath the floor (the model route and its credentials, the proxies, the certificates trusted; `SECURITY.md` lists it) or one that is not a variable name refuses start, because no controller could set it. Read at start. Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                                  |
| `PERISCOPE_MODEL_ENDPOINTS`          | The absolute path of the model endpoints file ([model endpoints](#model-endpoints)). Read, checked and its credentials resolved at start; a file this host could not honour refuses start. The file and every credential file it names join the gate's protected set. Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PERISCOPE_CODEX_BIN`                | The Codex binary sessions naming `codex` run, by absolute path: the native `codex` binary, or the npm package's `bin/codex.js`, which runs under this Node. A batch file (`.cmd`, `.bat`) is refused, because it runs only through a shell. Set with `PERISCOPE_CODEX_HOME` or not at all; one without the other refuses start. Read at start ([Codex](#codex)). Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PERISCOPE_CODEX_HOME`               | The Codex home every Codex session runs from (`CODEX_HOME`), by absolute path: the runner's own, never the operator's `~/.codex`. Created when absent. Its sign-in files, and the files that make periscope's hook the gate there (`hooks.json`, `hooks/`, `config.toml`), join the gate's protected set. A path holding a space or any of `&                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | < > ^ % ! ( ) ; , = ' "`or a backtick cannot carry the hook's line, so Codex is listed unavailable, naming the character; the host still starts. Set with`PERISCOPE_CODEX_BIN`. Config-file key; never settable over the link. |
| `PERISCOPE_QWEN_BIN`                 | The Qwen Code CLI sessions naming `qwen-code` run, by absolute path: the npm package's `cli-entry.js`, which runs under this Node. A batch file (`.cmd`, `.bat`) is refused, because it runs only through a shell. Set with `PERISCOPE_QWEN_HOME` or not at all; one without the other refuses start. Read at start ([Qwen Code](#qwen-code)). Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PERISCOPE_QWEN_HOME`                | The base every Qwen Code session's home is made beneath, by absolute path: the runner's own, never the operator's `~/.qwen`. Created when absent. Each session runs from `<base>/sessions/<id>`, made at its open and removed at its close, and every session shares `<base>/runtime`, where the CLI keeps the chats a resume reads. `<base>/sessions` joins the gate's protected set. Set with `PERISCOPE_QWEN_BIN`. Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PERISCOPE_PI_BIN`                   | The pi CLI sessions naming `pi` run, by absolute path: the npm package's `dist/bundle/cli.js`, which runs under this Node. A batch file (`.cmd`, `.bat`) is refused, because it runs only through a shell. Set with `PERISCOPE_PI_HOME` or not at all; one without the other refuses start. Read at start ([pi](#pi)). Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PERISCOPE_PI_HOME`                  | The base pi runs from, by absolute path: the runner's own, never the operator's `~/.pi`. Created when absent. `<base>/agent` is pi's agent home, `<base>/sessions` the store of every session's file, and `<base>/run/<id>` one session's run directory, made at its open and removed at its close. The whole base joins the gate's protected set. Set with `PERISCOPE_PI_BIN`. Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PERISCOPE_COPILOT_SDK`              | The directory the GitHub Copilot SDK is installed into, by absolute path: an `npm install --prefix` target of the operator's own, holding `@github/copilot-sdk` at the pinned version and its runtime for this platform. A session's runtime is started from it by path. Set with `PERISCOPE_COPILOT_HOME` or not at all; one without the other refuses start. Read at start ([Copilot](#copilot)). The whole directory joins the gate's protected set. Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PERISCOPE_COPILOT_HOME`             | The base every Copilot session's home is made beneath, by absolute path: the runner's own, never the operator's `~/.copilot`. Created when absent. Each session runs from `<base>/sessions/<id>`, made at its open and removed at its close, and a closed session's state is kept in `<base>/state/<session id>` for a resume. The whole base joins the gate's protected set. Set with `PERISCOPE_COPILOT_SDK`. Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PERISCOPE_COPILOT_TOKEN_FILE`       | A file holding the GitHub token Copilot sessions sign in with, by absolute path. Read when the runtime asks for a token, never at start, so a rotated token is taken without a restart; it reaches the runtime over the SDK's own pipe, never in its environment. Unset, a session not on a model endpoint opens and its first turn fails on the runtime's own words. Set only with the two keys above. The file joins the gate's protected set. Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PERISCOPE_OPENCODE_SDK`             | The directory the opencode SDK is installed into, by absolute path: an `npm install --prefix` target of the operator's own, holding `@opencode/sdk` at the pinned version and the server, core and client of its release. Each session's host process loads it from there by path. Set with `PERISCOPE_OPENCODE_HOME` or not at all; one without the other refuses start. Read at start ([opencode](#opencode)). The whole directory joins the gate's protected set. Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                                                                                                                        |
| `PERISCOPE_OPENCODE_HOME`            | The base every opencode session's home is made beneath, by absolute path: the runner's own, never the operator's opencode directories. Created when absent. Each session runs from `<base>/sessions/<id>`, made at its open and removed at its close, and a closed session's database is kept in `<base>/state/<session id>` for a resume. The whole base joins the gate's protected set. Set with `PERISCOPE_OPENCODE_SDK`. Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PERISCOPE_AGENT_PROGRESS_SUMMARIES` | Whether a Claude session asks for its subagents' progress summaries: `on` (the default when unset) or `off`; any other word refuses start. On, a running subagent states what it is doing about every 30 seconds and the summary rides its task's entry in the `tasks` fact; by the agent SDK's own account each summary is one more model call, on the subagent's own model and prompt cache, so a session with several long-running subagents pays for one call per subagent about every 30 seconds for as long as each runs. Off, the task list, each task's usage and each task's end are reported as before, without the running summary. The operator's alone: read from the environment or the config file at start, never settable by a controller over the link and never named by a session. An embedder sets `agentProgressSummaries` on `PeriscopeHost` or `SessionRegistry`. Config-file key. |
| `PERISCOPE_CODEX_ENDPOINT_KEY`       | Never read from this host's own environment, and not a config-file key: the host sets it, in the app-server environment of a Codex session opened on a [model endpoint](#model-endpoints), to that endpoint's credential, and the session's provider reads its key from it. Kept out of the agent's shell, and beneath the env floor, so no controller can set it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PERISCOPE_HOOK_CHANNEL`             | Never read from this host's own environment, and not a config-file key: the host sets it, in a Codex session's app-server environment, to the address of that session's hook channel (a named pipe on Windows, a Unix socket elsewhere), and `periscope hook codex` reads it. Kept out of the agent's shell, and beneath the env floor, so no controller can set it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PERISCOPE_HOOK_TOKEN`               | Never read from this host's own environment, and not a config-file key: the host sets it, in a Codex session's app-server environment, to that session's random token for its hook channel, and `periscope hook codex` presents it and verifies the host's answer by it. Kept out of the agent's shell, and beneath the env floor, so no controller can set it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PERISCOPE_HOOK_DEADLINE_MS`         | Never read from this host's own environment, and not a config-file key: the host sets it, in a Codex session's app-server environment, to how long `periscope hook codex` waits for the host's answer: the session's decision deadline plus `HOOK_DEADLINE_MARGIN_MS`, inside the hook's timeout. Kept out of the agent's shell, and beneath the env floor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PERISCOPE_PI_EXTENSION_CONFIG`      | Never read from this host's own environment, and not a config-file key: the host sets it, in a pi session's environment, to the path of that session's extension configuration (its channel's address and token, its deadline, its MCP servers), a file only the runner can read. periscope's pi extension reads it and takes it out of pi's environment, and the host deletes the file once the extension has said hello. Beneath the env floor.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PERISCOPE_CONFIG_DIR`               | The directory holding the token cache, the paired credential and the config file. Default `<home>/.periscope`, where home is `USERPROFILE` or `HOME`. The whole directory is in the gate's protected set. Deliberately not a config-file key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PERISCOPE_PAIR_URL`                 | Where `periscope pair` redeems a code when no `--controller` is given. Default: the origin of `PERISCOPE_DECISION_URL` plus the controller's pair route.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PERISCOPE_MACHINE_LABEL`            | The label sent with a pair request when no `--label` is given, shown in the controller's listings. Default: the hostname.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PERISCOPE_IDENTITY_AUTHORITY`       | The OIDC issuer URL; https is required, `localhost` included. With `PERISCOPE_IDENTITY_CLIENT_ID` it enables identity; one without the other refuses start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PERISCOPE_IDENTITY_CLIENT_ID`       | The public-client id registered with the provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PERISCOPE_IDENTITY_SCOPES`          | Space- or comma-separated scopes. Default `openid profile offline_access`. Set to nothing, it refuses start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PERISCOPE_IDENTITY_AUTHORIZE_URL`   | The authorization endpoint. Set together with `PERISCOPE_IDENTITY_TOKEN_URL` or not at all; when both are unset they are discovered from the authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PERISCOPE_IDENTITY_TOKEN_URL`       | The token endpoint. Same rule as above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PERISCOPE_IDENTITY_DEVICE_CODE_URL` | The device-authorization endpoint. Read only when the two endpoints above are set; on its own it is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PERISCOPE_IDENTITY_REDIRECT_PORT`   | The loopback listener's port, an integer 0-65535. Default 0 (an ephemeral port).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PERISCOPE_IDENTITY_DEVICE_CODE`     | `1` enables the device-code fallback. Off otherwise, and never reached by falling back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PERISCOPE_LIVE`                     | Tests only. `1` runs the probes that need a real agent (`npm run test:live`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PERISCOPE_PROOF_OUT`                | Examples only. A file path the parallel-run proof writes its full report to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PERISCOPE_FC_SEED`                  | Tests only. The property-test seed: a number reproduces a reported failure, `random` explores.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PERISCOPE_UPDATE_CONTRACTS`         | Tests only. Set by `npm run contracts:update` while it re-approves the snapshots under `contracts/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The agent CLI's token cache and configuration file in `CLAUDE_CONFIG_DIR`, when set, and in
`PERISCOPE_AGENT_HOME`, when it is not the default, are added to the gate's protected paths, and so are
the model endpoints file and every credential file it names, and `auth.json` and `.credentials.json`
in `PERISCOPE_CODEX_HOME` and in `<user home>/.codex`, and the session homes beneath
`PERISCOPE_QWEN_HOME`, Qwen Code's sign-in, token and settings files in `<user home>/.qwen` and in an
operator's own `QWEN_HOME`, `<user home>/.env`, the whole of `PERISCOPE_PI_HOME`, pi's sign-in, MCP
token and models files in `<user home>/.pi/agent`, the whole of `PERISCOPE_COPILOT_HOME`,
`PERISCOPE_COPILOT_SDK` and `PERISCOPE_COPILOT_TOKEN_FILE`, and the operator's own `<user home>/.copilot`
and `COPILOT_HOME`, the whole of `PERISCOPE_OPENCODE_HOME` and `PERISCOPE_OPENCODE_SDK`, the operator's own
opencode directories (`<user home>/.local/share/opencode`, `<user home>/.config/opencode`,
`<user home>/.local/state/opencode`, and each under `XDG_DATA_HOME`, `XDG_CONFIG_HOME` and `XDG_STATE_HOME`
when set) and the machine-wide opencode directory every opencode process reads (`%ProgramData%\opencode`,
`/Library/Application Support/opencode`, `/etc/opencode`); the full set is listed in [the gate](gate.md).

## What a controller can set over the link

`host_configure` accepts eight of the config-file keys: `PERISCOPE_WORKSPACE_ROOT`,
`PERISCOPE_REPOSITORY_ROOT`, `PERISCOPE_REPOSITORY_ROOTS`, `PERISCOPE_BRANCH_SCHEME`, `PERISCOPE_AGENT_HOME`,
`PERISCOPE_PLUGIN_DIRS`, `PERISCOPE_CONTROLLER_URL`, `PERISCOPE_DECISION_URL`. A written plugin
directory is loaded by the next open; the answer's `configuration.plugins` says what each one names. The host screens the whole set before writing,
refuses a change to a workspace root while any session is live or opening, and answers with the
effective values plus the keys its environment shadows. The two addresses and the agent home are
written but never applied live: the host keeps dialling what it dialled and protecting the agent home
it started with, names them as pending in its answer and in every hello, and the next start reads
the file. A session's gate holds the protected set it opened with, so an agent home applied live
would be reported before its credential files were protected. The host id is never settable over the
link, and neither are the names a controller may place in a session's environment
(`PERISCOPE_CONTROLLER_ENV_KEYS`): a controller able to write that list would declare its own. Nor is
the model endpoints file (`PERISCOPE_MODEL_ENDPOINTS`): a controller able to point it elsewhere would
choose where a session's model calls go, and with which credential. Nor are the Codex binary and
home (`PERISCOPE_CODEX_BIN`, `PERISCOPE_CODEX_HOME`): a controller able to point them elsewhere would
choose what runs as a session, and whose sign-in it runs under; and the Qwen Code CLI and base
(`PERISCOPE_QWEN_BIN`, `PERISCOPE_QWEN_HOME`), the pi CLI and home (`PERISCOPE_PI_BIN`,
`PERISCOPE_PI_HOME`) and Copilot's SDK, home and token file (`PERISCOPE_COPILOT_SDK`,
`PERISCOPE_COPILOT_HOME`, `PERISCOPE_COPILOT_TOKEN_FILE`) and opencode's SDK and home (`PERISCOPE_OPENCODE_SDK`,
`PERISCOPE_OPENCODE_HOME`), for the same reason. Nor is whether subagents write progress summaries
(`PERISCOPE_AGENT_PROGRESS_SUMMARIES`): each summary is a model call the operator pays for. A controller can also list one directory or read one
text file under the repository root (`repository_list` / `repository_read`: the head of any file,
and its first 512 KiB a page at a time), jailed to that root, to the protected set and away from the
agents' session records (Claude Code's `projects`, Codex's rollouts and history, Qwen Code's `projects`
and `tmp`, pi's `sessions`, Copilot's session states, opencode's session databases, under every home of each the host knows), bounded, and text-only; and read a text file inside a workspace this host provisioned, a page at
a time, by the workspace's key (`workspace_read`), under the same jail and protected set. [The wire
protocol](protocol.md) states the three doors.

## The agent: models, effort, thinking, plugins and tools

What follows was measured on Claude Code 2.1.284 by `src/host/agent-controls.live.test.ts`, run from
inside an agent session. Re-measure it after an agent SDK bump.

**The model catalog.** Before it dials, `serve` asks the agent which models it offers.

- It starts the agent with no prompt, reads the models from the agent's answer to the SDK's
  initialize request, and closes it. That took under a second, wrote no session file and left no
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
environment adds them. A controller sets it through `session_new.request.env.extraEnv` on a host
that declares it (`periscope config PERISCOPE_CONTROLLER_ENV_KEYS CLAUDE_CODE_ENABLE_TODO_TOOLS`).

## Model endpoints

An operator can point sessions at model endpoints other than the agent CLI's own route: an
open-weight vendor's Anthropic-format endpoint, a gateway, a model server on the machine. The
operator declares each endpoint by name in one file; the hello lists the names; a controller names
one in `session_new.request.endpoint`; and the host sets the endpoint's address, credential and model
variables in the agent's environment itself. A controller chooses an endpoint and can never write
one: the route's address, credential and model variables (`ANTHROPIC_*`) are beneath the env floor,
so no controller lane can set them even when declared, and `host_configure` cannot touch the file. The
four `CLAUDE_CODE_*` switches an endpoint may set (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`,
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`,
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) are above the floor: a controller can place one only when you name
it in `PERISCOPE_CONTROLLER_ENV_KEYS`. Whatever a controller places, an endpoint's own variables win on
a session that opens on it, because the host applies them last; a session on no endpoint keeps the
controller's value.

`PERISCOPE_MODEL_ENDPOINTS` names the file, by absolute path. It holds one JSON object with an
`endpoints` list of at most `MAX_ENDPOINTS` entries. Two entries, each in the form its vendor's own
Claude Code guide documents, one credential read from an environment variable and one from a
helper command:

```json
{
  "endpoints": [
    {
      "name": "deepseek",
      "wireApi": "anthropic-messages",
      "runtimes": ["claude"],
      "baseUrl": "https://api.deepseek.com/anthropic",
      "credential": { "env": "DEEPSEEK_API_KEY" },
      "models": ["deepseek-flash[1m]", "deepseek-flash"],
      "modelAliases": {
        "opus": "deepseek-flash[1m]",
        "sonnet": "deepseek-flash[1m]",
        "haiku": "deepseek-flash"
      },
      "contextWindow": { "autoCompactWindow": 786432 }
    },
    {
      "name": "zai",
      "wireApi": "anthropic-messages",
      "runtimes": ["claude"],
      "baseUrl": "https://api.z.ai/api/anthropic",
      "credential": {
        "helper": {
          "command": "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\python.exe",
          "args": [
            "-IBm",
            "azure.cli",
            "keyvault",
            "secret",
            "show",
            "--vault-name",
            "<your-vault>",
            "--name",
            "<your-secret>",
            "--query",
            "value",
            "-o",
            "tsv"
          ]
        }
      },
      "models": ["GLM-5.3", "glm-5.3-flash"],
      "modelAliases": { "opus": "GLM-5.3", "sonnet": "GLM-5.3", "haiku": "glm-5.3-flash" },
      "contextWindow": { "autoCompactWindow": 1000000 },
      "env": { "API_TIMEOUT_MS": "3000000" }
    }
  ]
}
```

| Member          | Meaning                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | What a `session_new` names the endpoint by, and what the hello lists. Letters, digits, `.`, `_` and `-`, at most 64; unique in the file, ignoring case.                                                                                                                                                                                  |
| `wireApi`       | The API the endpoint speaks: `anthropic-messages`, `openai-responses` or `openai-chat`.                                                                                                                                                                                                                                                  |
| `runtimes`      | The runtimes that may reach it. Each must speak `wireApi`: Claude speaks `anthropic-messages`, Codex `openai-responses`.                                                                                                                                                                                                                 |
| `baseUrl`       | Where the agent's model calls go, as an `http` or `https` URL. Never in the hello.                                                                                                                                                                                                                                                       |
| `credential`    | Exactly one of `{ "env": NAME }`, `{ "file": PATH }` or `{ "helper": { "command": PATH, "args": [...] } }` (below). Required.                                                                                                                                                                                                            |
| `models`        | The model ids a session may name on the endpoint, as the agent sends them, a `[1m]` suffix included where the vendor documents one.                                                                                                                                                                                                      |
| `modelAliases`  | The model each tier (`opus`, `sonnet`, `haiku`, `fable`) resolves to on the endpoint, each one of `models`. The hello lists the mapped tiers as model ids too. Read only on an endpoint Claude reaches.                                                                                                                                  |
| `contextWindow` | Optional. `{ "autoCompactWindow": N }` or `{ "maxContextTokens": N }`, in the form the vendor documents. On an endpoint Claude reaches, exactly one, and `autoCompactWindow` is 100000 to 1000000 tokens. On any other, both may be stated: the context size, and the point at or below it where the agent compacts.                     |
| `modelWindows`  | Optional. Read by Codex alone: `{ "<model id>": { "maxContextTokens": N, "autoCompactWindow": N } }`, each key one of `models`, `autoCompactWindow` optional and at most `maxContextTokens`. A Codex session takes its model's entry ahead of `contextWindow`. On an endpoint Codex does not reach it is ignored, and the start says so. |
| `env`           | Optional. Up to 32 more variables for sessions on the endpoint, such as `API_TIMEOUT_MS`, `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL`. Not a variable the members set, and not one the host strips from every session.                                                                                                    |
| `firstParty`    | Optional, default `false`. `true` marks Anthropic's own route, where a Claude model id may be named. It changes which model ids may be named, never how the credential is sent: the key always reaches the agent as `ANTHROPIC_AUTH_TOKEN`, the bearer form. Never in the hello. Read only on an endpoint Claude reaches.                |

**Credentials** are resolved once, at start, and held in memory: a rotated key takes a restart.

- `env` reads the variable from the host's own process environment, never from the config file. The
  agent never sees that variable; it sees the value as `ANTHROPIC_AUTH_TOKEN`.
- `file` reads an absolute path, trimmed, one line.
- `helper` runs an absolute path to an executable with its arguments, with no shell, for at most 30
  seconds, and takes the one line it prints. Its output is never logged or repeated: a failure names
  the endpoint and how the command ended (its exit code, a timeout), never what it printed. On
  Windows a `.cmd` or `.bat` is refused, because Node runs a batch file only through a shell and this
  host never builds a shell command from configuration: name the program the batch file runs. The
  Azure CLI's `az.cmd` runs its own `python.exe` with `-IBm azure.cli`, as the example shows.

The endpoints file and every `file` credential join the gate's protected set, so no session can read
them.

**An endpoint not marked `firstParty`** must map `opus`, `sonnet` and `haiku`, and may list no
`claude-` id: the agent resolves an unmapped tier to a Claude model id, its own background calls on
`haiku` included, and a provider that maps Claude ids answers with its own model while the run reads,
and is priced, as Claude. On such an endpoint a session naming a `claude-` id, or an alias the
endpoint does not map (`default`, `best`, `opusplan`, an unmapped `fable`, with or without `[1m]`), is
refused `model-endpoint-mismatch`, at the open and on a later `session_configure`. A session that
names no model is not refused; every such endpoint maps the three tiers the agent works on.

**The window**, on an endpoint Claude reaches. Vendors document one of two forms. A `[1m]` suffix
on a model id tells the agent the model holds a million tokens, and `autoCompactWindow` says where it
compacts; `maxContextTokens` tells it the window of an id it does not know. A `[1m]` id beside
`maxContextTokens` is refused, because the suffix overrides the stated window.

**What a session on an endpoint is spawned with**, after the controller's own literals, so none of
them can be overridden from the link:

- `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`: the address and the credential, so the agent's own
  sign-in is never the credential sent to the endpoint;
- `ANTHROPIC_DEFAULT_OPUS_MODEL`, `_SONNET_`, `_HAIKU_` and `_FABLE_` for each mapped tier;
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, from `contextWindow`;
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, so the agent sends no pre-release request field an
  endpoint may refuse;
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which keeps the credential out of the environments of the
  commands, hooks and stdio tool servers the agent starts;
- the entry's `env`.

Nothing else is set or blanked: no other model-route variable reaches a session, because the host's
inherited environment carries none and the floor refuses them on the controller's lanes. A user-tier
Claude settings file (`<home>/.claude/settings.json`) still loads for a session that asks for the `user`
tier, and its `env` can set the same variables: keep a vendor route out of the user settings of a
runner that declares endpoints. The catalog read at start runs on the agent's own route, so the
hello's `agent` and `agents` list Claude's models; an endpoint's models come from `models` alone.

An endpoint that answers every call with a rate-limit or balance error makes the agent retry each call
for minutes before it fails; `CLAUDE_CODE_MAX_RETRIES` in the entry's `env` lowers that.

**An endpoint Codex reaches** speaks `openai-responses` and names `codex` in `runtimes`:

```json
{
  "name": "gateway",
  "wireApi": "openai-responses",
  "runtimes": ["codex"],
  "baseUrl": "https://gateway.example/v1",
  "credential": { "env": "GATEWAY_API_KEY" },
  "models": ["gpt-6-sol", "open-coder"],
  "contextWindow": { "maxContextTokens": 400000 },
  "modelWindows": { "open-coder": { "maxContextTokens": 262144, "autoCompactWindow": 180000 } }
}
```

- A Codex session naming it opens on a model provider of its own, defined in its thread's config
  (`model_providers.<id>`, `base_url`, `wire_api = "responses"`) and named by the host: `periscope-`,
  the endpoint's name made safe for a config key, and a hash of the name, so no endpoint name can be
  a provider id Codex reserves or read as two keys. The provider's display name is the endpoint's.
  Nothing is written into the runner's Codex home, and a repository's own Codex configuration cannot
  choose a provider.
- The credential is set in the session's app-server environment as `PERISCOPE_CODEX_ENDPOINT_KEY`,
  which the provider reads (`env_key`), and the entry's `env` beside it. Every one of those names is
  kept out of the environment the agent's shell commands run with (`shell_environment_policy.exclude`,
  by exact name). `PERISCOPE_CODEX_ENDPOINT_KEY` is beneath the env floor: no controller can set it.
- The window becomes Codex's: `maxContextTokens` its `model_context_window`, the window of a model it
  does not know, and `autoCompactWindow` its `model_auto_compact_token_limit`, the point it compacts
  at; a window stating both sets both. It is the window of the model the session opens on, the one it
  names or Codex's default when it names none: that model's entry in `modelWindows`, else the
  endpoint's `contextWindow`, else nothing, and the session runs on the window Codex itself assumes for
  the id. It is set once, in the thread's config, so a model switch later in the session keeps the
  window the session opened with. A model listed with neither is named at start, once per endpoint, as
  an `[endpoint]` line.
- State the window the provider lets the input fill, not the model's nominal size. A provider that
  holds part of the window back for the reply leaves the input less, and an agent told the whole
  window compacts too late or never: for a 262144-token model whose provider reserves 65536 tokens for
  output, state `"maxContextTokens": 196608`, or the full size with an `autoCompactWindow` below 196608.
- Claude's rules do not apply: no model tier is mapped, any model id may be listed, and
  `model-endpoint-mismatch` is never raised. `modelAliases` and `firstParty` on such an endpoint are
  ignored, and the start says so once, as an `[endpoint]` line naming them.

**A repository's own settings.** A session whose `settingSources` include `project` or `local` has the
agent read the repository's `.claude/settings.json` or `.claude/settings.local.json` from its
directory and apply each file's `env` to itself. The host reads the same files when the session's
directory is known, and a file whose `env` names a key beneath the floor (the names and patterns
`SECURITY.md` lists, matched case-insensitively) refuses the session `settings-route-refused`, naming
each file and its keys. A file read neither as strict JSON nor with its comments and trailing commas
removed passes, as the agent skips it; so does a missing file. The check runs when a session opens or
resumes, and the agent reloads its settings files while it runs, so a file a session writes for itself
is caught at its next open or resume.

## Codex

A host offers Codex beside Claude when `PERISCOPE_CODEX_BIN` and `PERISCOPE_CODEX_HOME` are both set.
Then a `session_new` naming `runtime: "codex"` runs Codex's app-server in the session's directory,
and the hello's `agents` lists Codex after Claude ([the wire protocol](protocol.md)).

- **The version is pinned.** This release runs Codex 0.169.0 (`CODEX_PINNED_VERSION`). Install that
  version (`npm install -g @openai/codex@0.169.0`, or the release's native binary) and point
  `PERISCOPE_CODEX_BIN` at it. A binary that reports another version, or none, is listed unavailable
  with the path, the version it reports and the version pinned; the host still starts, and a session
  naming `codex` is refused `runtime-unavailable` with that reason. Nothing installs or updates it.
- **The home is the runner's own.** `PERISCOPE_CODEX_HOME` is `CODEX_HOME` for every Codex process
  the host starts, so the operator's own `~/.codex` (its sign-in, its history, its project trust) is
  never what a session runs from. Sign the runner's home in once, as the user the host runs as:

  ```sh
  CODEX_HOME=/srv/periscope/codex-home codex login
  ```

  ```powershell
  $env:CODEX_HOME = 'C:\periscope\codex-home'; codex login
  ```

  A home with no sign-in is listed unavailable with this step named. A provider that needs no sign-in
  is available without one.

- **Its control tier is `intercepted-with-residual`.** Periscope's own `PreToolUse` hook decides every
  Codex tool call it sees through the same gate as a Claude call, and Codex's approvals are decided by
  that gate too; the paths that can still run undecided are named on the session's state lane as they
  happen ([gate.md](gate.md), the Codex gate; [SECURITY.md](../SECURITY.md)). Its sandbox and approval
  policy follow the session's permission mode (`default`, `dontAsk` or `bypassPermissions`).
- **The hook.** At start the host writes its hook into the runner's home (`hooks.json`, and the shim
  `hooks/periscope-hook.cmd` the Windows line runs) and probes it through the shell Codex will run it
  under; a probe that fails is printed, and every Codex open tries it again and is refused
  `codex-hook-not-active` while it fails. Other hooks in `hooks.json` are kept. At every open the host
  trusts its own hook over the wire, as Codex's interface does, so nothing is needed by hand; a home
  whose `hooks.state` disables periscope's hook refuses every Codex open by name. Keep other hooks out
  of the runner's home: one that would run is named `gate-hook-foreign` on each session.
- **The deadlines.** A Codex session waits for each decision for its `decisionTimeoutMs`, and the hook
  for that plus `HOOK_DEADLINE_MARGIN_MS`, inside the hook's own timeout of `CODEX_HOOK_TIMEOUT_SECONDS`.
  A session whose `decisionTimeoutMs` leaves no room inside it is refused `gate-deadlines-inverted`.
  `matcherTimeoutSeconds` is Claude's and does not apply to Codex.
- **The read at start.** The host starts the app-server once before it dials, bounded at 20 seconds,
  reads its version, account and model catalog, and closes it. The hello's Codex entry is that read;
  a catalog that cannot be read leaves Codex available with no models, and a session naming no model
  runs on Codex's default.
- **Plugins.** The configured plugin directories (`PERISCOPE_PLUGIN_DIRS`) and a session's own
  `plugins` reach its app-server as skill roots before its thread opens. Each directory is a plugin
  root, the parent of `.claude-plugin/plugin.json`, and its skills list as `plugin:skill`, as the agent
  CLI lists them. A directory a session names that is not there is left out and named in the session's
  receipt; Codex refusing the roots ends the open `plugins-undeliverable`.
- **MCP servers.** A session's servers ride its thread's config: an HTTP server's headers as static
  headers, never in the app-server's environment or on its command line, and a stdio server's command.
  Each server's tool calls are asked about first, and the session's gate decides each ask.
- **Endpoints.** An endpoint whose `runtimes` name `codex` (above, [Model endpoints](#model-endpoints)).

## Qwen Code

A host offers Qwen Code beside Claude when `PERISCOPE_QWEN_BIN` and `PERISCOPE_QWEN_HOME` are both
set. Then a `session_new` naming `runtime: "qwen-code"` runs the Qwen Code CLI in the session's
directory, driven over its stream-json control protocol on stdin and stdout, and the hello's `agents`
lists Qwen Code after Claude and Codex ([the wire protocol](protocol.md)).

- **The version is pinned.** This release runs Qwen Code 0.27.3 (`QWEN_PINNED_VERSION`). Install that
  version (`npm install -g @qwen-code/qwen-code@0.27.3`) and point `PERISCOPE_QWEN_BIN` at the
  package's `cli-entry.js`. A CLI that reports another version, or none, is listed unavailable with
  the path, the version it reports and the version pinned; the host still starts, and a session naming
  `qwen-code` is refused `runtime-unavailable` with that reason. Nothing installs or updates it.
- **The model is an endpoint's.** Qwen Code has no sign-in of its own here: a session reaches its
  model through a [model endpoint](#model-endpoints) whose `runtimes` name `qwen-code`, over any of the
  three wire APIs. The endpoint's credential is written only into the session's settings file, never
  into the CLI's environment or onto its command line. A session opened on no endpoint is started, and
  the CLI writes one error result naming the missing auth type or key (the sign-in marker
  [the wire protocol](protocol.md) names) before it answers `initialize`, then exits: no turn runs,
  and the session ends with the CLI's exit. A variables file the CLI loads (below) that names a route
  of its own is the exception. The hello's entry carries no model catalog; a session names its model.
- **The home is the runner's own, one per session.** The host writes each session's home beneath
  `PERISCOPE_QWEN_HOME` and points the CLI at it, so the operator's own `~/.qwen` (its sign-in, its
  settings, its trusted folders) is never what a session runs from. The home's settings file sits at
  the system scope, which the CLI applies over every user and project settings file: it asks about
  every tool the CLI ships and every attached MCP server, turns hooks and usage statistics off, and
  carries the endpoint. The host reads it back before the CLI starts, and a file that does not ask
  about every tool, or does not turn hooks off, refuses the open `qwen-ask-rules-not-active`.
- **Its control tier is `intercepted-with-residual`.** Every call the CLI asks about is decided by
  the session's gate, through the same gate as a Claude call, and the gate's answer is the CLI's: an
  allow runs the call as the CLI asked it, never rewritten. The paths that can still run undecided are
  named on the session's state lane as they are found ([gate.md](gate.md), the Qwen Code gate;
  [SECURITY.md](../SECURITY.md)). The permission modes are `default` and `plan`; `bypassPermissions`
  runs as `default`, every call still asked.
- **The deadlines.** A Qwen Code session waits for each decision for its `decisionTimeoutMs`, and the
  CLI for that plus `QWEN_PERMISSION_MARGIN_MS`, at most `QWEN_MAX_PERMISSION_TIMEOUT_MS` (ten
  minutes). A session whose `decisionTimeoutMs` leaves no room inside that is refused
  `gate-deadlines-inverted`.
- **The read at start.** The host creates the base, asks the CLI its version, and lists it in the
  hello; it never starts a session to do so.
- **The shell.** On Windows the CLI runs its shell calls through `cmd.exe` unless the host itself was
  started from Git Bash (`bash`) or with `ComSpec` naming PowerShell; the gate reads each call in the
  grammar of the shell it will run in, worked out per session from the environment the CLI starts
  with.
- **Plugins.** The configured plugin directories (`PERISCOPE_PLUGIN_DIRS`) and a session's own
  `plugins` reach its CLI as skill directories in its settings file: each directory's `skills/`, its
  skills listed by their bare names. A directory without one is named in the session's receipt.
- **MCP servers.** A session's servers ride its first control message on stdin: an HTTP server's
  headers beside its URL, never in the CLI's environment or on its command line, and a stdio server's
  command. Each server's tool calls are asked about, and the session's gate decides each ask.
- **A variables file the CLI loads.** The CLI loads `<user home>/.env` (and `<user home>/.qwen/.env`)
  into its own environment, whatever its home. Both are in the protected set, so no agent reads them,
  but a key in either reaches the CLI's shell; a session that opens while one exists names the
  variables it holds, never their values, as `gate-credential-in-shell`. Keep credentials out of them
  on a runner.

## pi

A host offers pi beside Claude when `PERISCOPE_PI_BIN` and `PERISCOPE_PI_HOME` are both set. Then a
`session_new` naming `runtime: "pi"` runs pi in RPC mode in the session's directory, driven by JSON
lines on stdin and stdout, and the hello's `agents` lists pi after Claude, Codex and Qwen Code
([the wire protocol](protocol.md)).

- **The version is pinned.** This release runs pi 1.5.2 (`PI_PINNED_VERSION`). Install that version
  (`npm install -g @earendil-works/pi-coding-agent@1.5.2`, which needs Node 22.19 or later) and point
  `PERISCOPE_PI_BIN` at the package's `dist/bundle/cli.js`. A CLI that reports another version, or
  none, is listed unavailable with the path, the version it reports and the version pinned; the host
  still starts, and a session naming `pi` is refused `runtime-unavailable` with that reason. Nothing
  installs or updates it.
- **The home is the runner's own.** pi runs with `PI_CODING_AGENT_DIR` set to `<base>/agent`, so the
  operator's own `~/.pi` (its sign-in, its settings, its extensions) is never what a session runs from.
  Sign pi in there once, from a plain terminal: run pi with `PI_CODING_AGENT_DIR` set to that directory
  and use `/login`. At start the host writes `models.json` (the endpoints below) and an empty
  `mcp.json` there, rewriting each only when it changed.
- **The models.** At start the host runs pi once with nothing of its own loaded and no session, asks
  which models it reaches, and closes it without a prompt. The hello lists them as `provider/id`, the
  form a session names one by. A list that cannot be read, or that is past what the hello carries, is
  no list: the entry carries none and the `[pi]` line says why. A session opened with no model pi can
  reach ends as pi's own exit, which names `/login` (the sign-in marker
  [the wire protocol](protocol.md) names).
- **Endpoints.** An endpoint whose `runtimes` name `pi`, over any of the three wire APIs, is written
  into `models.json` as a provider of that name, its key in that file alone, never in pi's environment
  or on its command line; a session opened on it runs it as pi's provider. An endpoint's own variables
  are set in pi's environment, which every command the agent runs inherits, so a session opened on one
  names them as `gate-credential-in-shell` and opens at `intercepted-with-residual`.
- **The launch rule.** pi loads no extension, skill, settings file or MCP configuration of its own
  finding: the host starts it with `--no-extensions --no-skills --no-approve`, then names pi's built-in
  MCP extension and periscope's own extension, the skills it hands over, the session store, the model
  and the system prompt file. Nothing a controller wrote reaches pi's command line: a system prompt
  rides a file in the session's run directory.
- **The open.** No prompt is written until periscope's extension has said hello over the session's
  channel, within `PI_HELLO_DEADLINE_MS` (thirty seconds). An extension that does not, or that pi
  refuses to load, refuses the open `pi-extension-not-active`; pi exiting for another reason first ends
  the open as that exit. Then the host reads pi's commands and state, and code this host did not load
  (a command, a tool or an MCP server from any other source) lowers the session's tier and is named
  `gate-foreign-extension`.
- **Its control tier is `intercepted`.** pi has no permission system of its own: periscope's extension
  asks the session's gate about every tool call before it runs, through the same gate as a Claude
  call, and runs after every other handler, so the input it decides is the input that runs. A deny,
  the extension's own deadline, an interrupt or a broken channel blocks the call; an allow may rewrite
  its input. pi's own `bash` command, which runs a command outside any tool call, is refused and never
  runs. pi has no permission modes, and a session asking for one is refused `request-key-unsupported`
  ([gate.md](gate.md), the pi gate; [SECURITY.md](../SECURITY.md)).
- **The deadlines.** A pi session waits for each decision for its `decisionTimeoutMs`, and the
  extension blocks the call at that plus `HOOK_DEADLINE_MARGIN_MS`.
- **Resume and fork.** A resumed session is the file in the session store that carries the id the
  request names and the session's own working directory; any other is refused
  `request-key-unsupported` naming `resume`. A fork opens a copy of that file in the session's
  directory.
- **The shell.** pi runs its `bash` tool through bash: on Windows, Git for Windows at its default path
  (`%ProgramFiles%\Git\bin\bash.exe`), and without it the first `bash.exe` on `PATH`, which can be
  WSL's. Install Git for Windows on a Windows runner. Its `powershell` tool runs PowerShell. The gate
  reads a `bash` call as `posix` and a `powershell` call as `powershell`.
- **Plugins.** The configured plugin directories (`PERISCOPE_PLUGIN_DIRS`) and a session's own
  `plugins` reach pi as skill directories on its command line: each directory's `skills/`, its skills
  listed by their bare names. A directory without one is named in the session's receipt.
- **MCP servers.** A session's servers ride its extension's configuration, a file only the runner can
  read: an HTTP server's headers beside its URL, written so pi expands nothing in them, and a stdio
  server's command. Their tools are named `mcp__<server>__<tool>` and asked about like every other
  call. An SSE server is refused `mcp-descriptor-invalid`.
- **Spend.** pi states each model call's tokens and cost as the call ends, and a session's running totals
  after each run: its tokens, and its cost in US dollars at its own catalogue's rates, never a bill. Each
  call is filed as it is made, so a run that never settles still reports what it spent. The totals cover
  every entry of the session's file, compacted history and failed retries included, so a total can exceed
  what the visible conversation used.

## Copilot

A host offers GitHub Copilot beside Claude when `PERISCOPE_COPILOT_SDK` and `PERISCOPE_COPILOT_HOME` are
both set. Then a `session_new` naming `runtime: "copilot"` runs one Copilot runtime for the session,
started and driven through the SDK the operator installed, and the hello's `agents` lists Copilot after
the other runtimes ([the wire protocol](protocol.md)).

- **The SDK is the operator's install, at the pinned version.** This release runs `@github/copilot-sdk`
  1.0.34 (`COPILOT_SDK_PINNED_VERSION`), which pins the Copilot runtime 1.0.112. periscope never
  installs it and never depends on it. Install it into a directory of the runner's own
  (`npm install --prefix <directory> @github/copilot-sdk@1.0.34`) and point `PERISCOPE_COPILOT_SDK` at
  that directory. The SDK carries the runtime as a closed binary under the GitHub Copilot CLI License,
  one platform package per platform; npm installs the one for the machine. At start the host reads the
  install's files, starting nothing: an install that is absent, of another version, pinning another
  runtime, or missing this platform's runtime is listed unavailable with what it found and what is
  pinned; the host still starts, and a session naming `copilot` is refused `runtime-unavailable` with
  that reason. The hello lists no models: Copilot lists its models only once signed in. A session
  that names no model opens on the runtime's own default: the runtime reports the session's model as
  `auto` and picks a model for each turn, which each step's usage names. An account on Copilot's free
  plan is offered no model by name (the runtime lists none for it and refuses one that is named), so
  naming none is how a session of such an account runs.
- **The home is the runner's own.** Each session's runtime runs with a fresh home under
  `<base>/sessions`, its caches pointed inside it on every platform (`COPILOT_CACHE_HOME`, which the
  runtime reads before the platform's own cache directory, and on Windows `LOCALAPPDATA` and `APPDATA`
  as well), in the SDK's `empty`
  mode, signed in as nobody (`useLoggedInUser: false`), so the operator's own `~/.copilot` (its sign-in,
  its settings, its sessions) is never what a session runs from. The home is removed when the session
  closes; its state moves to `<base>/state/<session id>`, which a resume copies back.
- **The sign-in.** A session signs in with the token in `PERISCOPE_COPILOT_TOKEN_FILE`, read each time
  the runtime asks and handed over the SDK's own pipe. The token is given for `github.com` alone: a
  runtime that asks for a token for another GitHub host is given none, and `GH_HOST` never reaches the
  runtime's environment. A sign-in to an enterprise host is not offered. The token is said to last eight hours, the
  lifetime the SDK gives production tokens, and the runtime asks again before then; a file that is
  empty or gone when it asks refuses the session's open, since the runtime never falls back to another
  sign-in. No token is ever placed in the runtime's
  environment, which every command the agent runs inherits: the host strips `GH_TOKEN`, `GITHUB_TOKEN`,
  `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` and every `COPILOT_` variable from it. A session with
  no token and no endpoint opens, and its first turn fails on the runtime's own words (`No GitHub OAuth
token or Copilot HMAC key provided`).
- **Endpoints.** An endpoint whose `runtimes` name `copilot`, over any of the three wire APIs, is the
  session's own provider (bring your own key): its address and key ride the session's request over the
  SDK's pipe, never the runtime's environment or a command line, and the session needs no GitHub
  sign-in. An endpoint's own `env` is set nowhere for a Copilot session, and an endpoint only Copilot
  reaches reports it among its ignored members.
- **Nothing is discovered.** A session's runtime reads no configuration, custom instructions, MCP
  servers or skills of a workspace's or the user's: the session is created with discovery off, its
  skills are the plugin directories' alone and its servers the ones it attaches.
- **What the model is told of the machine.** The session's working directory, in the runtime's own
  environment section (with the directory's git root, the operating system and the tools found), and
  nothing of the runner's home under `<base>`. A sub-agent is told the same, and by the runtime itself
  the session folder under the session's home, which no option removes: a call that names it is
  refused `credential-path-denied` ([gate.md](gate.md), the Copilot gate).
- **The open.** Before any prompt the host reads the runtime back: its permission mode is `manual`, its
  agent mode `interactive` (or `plan` for a session opened in plan mode), no approve-all grant of any
  kind, no path approved for the session, no plugin, and none of the tools this host turns off
  offered. A directory the runtime allows that is none of the session's (its own, a further worktree,
  the temp folder where that is one of its write roots, or inside its home) refuses nothing: it is
  named `gate-mode-widened` and the session opens, since the host's own gate is what holds a write to
  the write limits. Then one probe call runs through it, under an id the host minted: the pre-tool hook must
  fire and its request reach the host, which refuses it, so nothing runs. Anything else refuses the
  open `copilot-gate-not-active`, naming what differed. A machine-wide policy hook
  (`%ProgramData%\GitHub\Copilot\policy.d\*.json`, or the `HKLM\Software\Policies\GitHub\Copilot`
  key) is named at the open (`gate-hook-foreign`) and lowers the session's tier.
- **Its control tier is `intercepted-with-residual`.** The runtime's pre-tool hook answers `ask` for
  every call, and the permission request that raises is decided by the session's gate, the same gate a
  Claude call meets. The residual paths are named as they occur ([gate.md](gate.md), the Copilot gate;
  [SECURITY.md](../SECURITY.md)).
- **The deadlines.** A Copilot session waits for each decision for its `decisionTimeoutMs`, which may
  be at most 240,000ms (`COPILOT_MEASURED_PERMISSION_WAIT_MS`): the runtime was measured holding a
  permission request that long with no timeout of its own, and no longer wait has been measured. A
  session asking for more is refused `gate-deadlines-inverted`.
- **Modes, effort, thinking.** A session takes `default` (Copilot's `interactive` agent mode) or
  `plan`; the permission mode is always `manual`. Its effort is one of `low`, `medium`, `high`,
  `xhigh` and `max`, as the model takes it. Copilot has no thinking switch, so a session asking to turn
  thinking off is refused.
- **Resume and fork.** A resume names a session whose state this host kept; any other is refused
  `request-key-unsupported` naming `resume`. A fork forks that state into a new session.
- **The shell.** Copilot runs its `powershell` tool on Windows and its `bash` tool elsewhere. The gate
  reads each in its own grammar.
- **Plugins.** The configured plugin directories and a session's own `plugins` reach Copilot as skill
  directories: each directory's `skills/`, its skills listed by their bare names. A directory without
  one is named in the session's receipt.
- **MCP servers.** A session's servers ride its request over the SDK's pipe: an HTTP server's headers
  beside its URL, and a stdio server's command. Copilot names their tools `<server>-<tool>`; the host
  names them `mcp__<server>__<tool>` by the tools each server lists, and asks about them like every
  other call. An SSE server is refused `mcp-descriptor-invalid`.
- **Spend.** Copilot reports each model call's tokens, filed as that step's figure, and at the
  session's end its totals per model. Neither is priced: Copilot's cost is a multiplier and its credit
  totals a unit of its own, so the cost is stated as not reported.

## opencode

A host offers opencode beside Claude when `PERISCOPE_OPENCODE_SDK` and `PERISCOPE_OPENCODE_HOME` are both
set. Then a `session_new` naming `runtime: "opencode"` runs one opencode server for the session, in a host
process of its own, and the hello's `agents` lists opencode after the other runtimes ([the wire
protocol](protocol.md)).

- **opencode needs Node 24 or later.** The SDK's own tree uses explicit resource management (`await
using`), which Node 22 cannot parse, so on Node 22 the SDK cannot load at all. The host tests the syntax
  itself, never a version string, and on a Node that fails the test lists opencode unavailable, naming the
  Node and why; everything else this package does still runs on Node 22.
- **The SDK is the operator's install, at the pinned version.** This release runs `@opencode/sdk` 2.3.0
  (`OPENCODE_SDK_PINNED_VERSION`). periscope never installs it and never depends on it. Install it into a
  directory of the runner's own (`npm install --prefix <directory> @opencode/sdk@2.3.0`) and point
  `PERISCOPE_OPENCODE_SDK` at that directory. At start the host reads the install's files, starting
  nothing: an install that is absent, of another version, or whose release's server, core or client is of
  another version is listed unavailable with what it found and what is pinned; the host still starts, and
  a session naming `opencode` is refused `runtime-unavailable` with that reason. The hello lists no
  models: an opencode session reaches a model only through an endpoint.
- **One host process per session, with no listener.** The SDK hosts opencode's whole server in the process
  that loads it, so each session's server runs in a process of its own: this package's
  `dist/host/opencode-host.js`, started with this host's own Node, with no shell and no window, and spoken
  to over its stdio. It opens no port. Its environment is written whole: the session's spawn environment
  without any `OPENCODE_` variable, `NODE_OPTIONS` or variable of this host's but `PERISCOPE_WORKTREE_*`,
  its home and data, configuration, cache and state directories inside the session's home, and the one
  switch the pinned SDK reads, `OPENCODE_DISABLE_FREE_MODELS`, which keeps opencode's own hosted models
  from being offered. What keeps it from fetching its model catalogue, and from reading a project's
  configuration or a `.claude` folder, is an option the server is created with; what keeps it from
  looking for an update is the session's configuration.
- **The open is bounded as a whole.** From the host process's start to the read-back's last answer the
  open has 50 seconds (`OPENCODE_OPEN_DEADLINE_MS`), below the session's start window, and each step is
  given what is left: the host process's own open, `model.list`, `session.create` (or the resume's read),
  the session's environment and the read-back. An open that runs it out ends the session
  `runtime-unavailable`, naming the step:
  `the opencode open did not finish session.create within 50000ms`. A failure of the open or of the
  host process carries the last line the host process wrote to its stderr, with the endpoint's key never
  in it.
- **The home is the runner's own.** Each session runs with a fresh home under `<base>/sessions`, so the
  operator's own opencode directories (their sign-ins, their settings, their sessions) are never what a
  session runs from. The home is removed when the session closes; its database moves to
  `<base>/state/<session id>`, which a resume copies back. A host that does not close a session (it
  crashed, or was killed) leaves the home behind. Each home says which process made it and which
  session it holds (`owner.json`), and the next opencode session to open clears every home whose
  process is gone: its database is kept for a resume first, then the home is removed. A home whose
  process is still there is another live session's and is left alone. A home whose removal fails part
  way, a file of it still held open, is given its owner file again marked as being removed, and the next
  session to open removes it whoever made it; nothing is kept from it, since its database was kept before
  the removal began.
- **Endpoints.** An opencode session reaches a model only through an endpoint whose `runtimes` name
  `opencode`, over `openai-chat`: the session's one provider, `endpoint-<name>`, and the only one its
  configuration allows. The key is read when the session opens and crosses into the host process with the
  session's configuration, over its stdin, so it is never in an environment, a file or a command line. An
  endpoint's own `env` is set nowhere for an opencode session, and an endpoint only opencode reaches
  reports it among its ignored members. A session naming no endpoint opens and can call no model.
- **Nothing is discovered.** A session's server reads no configuration, instructions, plugins, MCP servers
  or skills of a workspace's or the user's: project configuration and the `.claude` folder are off, its
  skills are the plugin directories' alone and its servers the ones it attaches.
- **The open.** Every session is created with this host's permission rules: every action asks, and each
  tool this host turns off is denied. Once the server's plugins are active, before any prompt, the host
  reads it back: the session's rules are exactly those; every agent's rules end with them; no approval is
  saved; every plugin is the runtime's own or this host's pre-call gate (`periscope.gate`), and none this
  host turns off runs; the gate is stated `active` (one stated `failed`, or with no state, is named
  `gate-hook-missing` and the session opens); the MCP servers are the
  session's; no configuration but this host's is loaded; and no model but the endpoint's is offered.
  Anything else refuses the open `opencode-gate-not-active`, naming what differed.
- **Its control tier is `intercepted-with-residual`.** Every permission request the server raises, the
  session's own or a subagent's, is decided by the session's gate, the same gate a Claude call meets. The
  residual paths are named as they occur ([gate.md](gate.md), the opencode gate; [SECURITY.md](../SECURITY.md)).
- **Modes, effort, thinking.** A session takes `default` (opencode's `build` agent) or `plan` (its
  `plan` agent); either way every call asks this host. opencode sets reasoning through a model's variants
  and this host's endpoints declare none, so an effort is refused, and so is a request to turn thinking
  off. A model or a mode set mid-session applies from the session's next model call, mid-run included.
- **Resume and fork.** A resume names a session whose database this host kept; any other is refused
  `request-key-unsupported` naming `resume`. A fork forks it into a new session.
- **The shell.** opencode's `shell` tool runs the shell this host names: Windows PowerShell at its fixed
  path on Windows, else `cmd.exe`; `bash` elsewhere, else `sh`. The gate reads each in its own grammar.
  A command runs with the session's spawn environment, the operator's own home among it, and with
  `OPENCODE_SESSION_ID` and `OPENCODE_TERMINAL`, which opencode sets.
- **Forms.** opencode waits on a form with no timeout: a web search asks which provider to use, and an MCP
  server can ask for input. This host attaches no interface to answer one, so each form is cancelled as it
  is raised; what asked fails with words, and the run goes on.
- **Plugins.** The configured plugin directories and a session's own `plugins` reach opencode as skill
  directories: each directory's `skills/`, its skills listed by their bare names. A directory without one
  is named in the session's receipt.
- **MCP servers.** A session's servers ride its configuration: an HTTP server's headers beside its URL,
  with no OAuth flow offered, and a stdio server's command line. opencode names their tools
  `<server>_<tool>`; the host names them `mcp__<server>__<tool>` by the names of the servers the session
  attached, so a name opencode would rewrite, or one that with an `_` begins another's, is refused
  `mcp-descriptor-invalid`, as is an SSE server.
- **Spend.** opencode reports each model call's tokens, its input uncached, and its cost, filed as that
  call's figure. A cost is the provider's only when it is above zero: opencode prices a call from its own
  catalogue, which does not know an endpoint's models, so a zero is no cost reported. The model call a
  compaction makes is counted in the session's running total, which rides its native message alone, and
  is in no step's figure; the title opencode would name a session with is turned off, so it makes no call.

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
fails it says `the hello carries no model catalog` with the reason, and the host dials anyway. A host
that declares model endpoints prints `[endpoints] 2 model endpoint(s) declared: deepseek, zai`, names
only, and `[endpoint] deepseek: default listed and not mapped` for an agent alias an endpoint lists as
a model without mapping it, which a session naming it is refused (`model-endpoint-mismatch`), and
`[endpoint] gateway: open-coder with no window` for a model an endpoint Codex reaches lists with no
window of its own and no `contextWindow`. A host offering Codex prints `[codex] codex 0.169.0, 6
model(s) in the hello, control tier intercepted-with-residual`, or `[codex] codex is listed
unavailable` with the reason, and then whether
periscope's hook was written to the runner's home and answered its probe. A host offering Qwen Code
prints `[qwen-code] qwen-code 0.27.3, 0 model(s) in the hello, control tier intercepted-with-residual`,
or `[qwen-code] qwen-code is listed unavailable` with the reason. A host offering pi prints `[pi] pi
1.5.2, 3 model(s) in the hello, control tier intercepted`, or `[pi] pi is listed unavailable` with the
reason. A host offering Copilot prints `[copilot] copilot 1.0.112, 0 model(s) in the hello, control tier
intercepted-with-residual`, or `[copilot] copilot is listed unavailable` with the reason. A host offering
opencode prints `[opencode] opencode 2.3.0, 0 model(s) in the hello, control tier intercepted-with-residual`,
or `[opencode] opencode is listed unavailable` with the reason.

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
- the repositories served beside the home one cannot be served: `PERISCOPE_REPOSITORY_ROOTS` without
  both roots or past `MAX_REPOSITORIES`, an entry that is relative, is the home repository or is not a
  git work tree, a name (its folder's) that cannot name a branch or a directory, two names whose
  `PERISCOPE_WORKTREE_<NAME>` variables are one, or names and roots past the hello's
  `MAX_REPOSITORY_CATALOG_BYTES`;
- a paired-credential file exists but cannot be read;
- the identity configuration is partial or wrong: one of the authority/client-id pair without the
  other, a non-https authority, one of the authorize/token endpoints without the other, a redirect
  port outside 0-65535, or a scopes variable set to nothing;
- identity is configured but there is nowhere to keep the token cache (no home directory and no
  `PERISCOPE_CONFIG_DIR`);
- `PERISCOPE_PLUGIN_DIRS` names more than `MAX_PLUGIN_DIRS` directories, or one that is absent or
  carries no readable manifest;
- `PERISCOPE_CONTROLLER_ENV_KEYS` names something that is not a variable name, or a name beneath the
  floor, which no declaration can open;
- `PERISCOPE_MODEL_ENDPOINTS` is not an absolute path, or names a file that cannot be read, is not
  JSON, or declares an endpoint this host could not honour: a name declared twice, an unknown wire
  API, a runtime it cannot spawn or one that does not speak the endpoint's API, a credential it cannot
  resolve, a `firstParty` that is not `true` or `false`, an unmapped tier or a Claude id on an endpoint
  that is not first-party, a window in both forms, or a list past what the hello carries;
- one of `PERISCOPE_CODEX_BIN` and `PERISCOPE_CODEX_HOME` is set without the other, either is not
  an absolute path, or the binary is a batch file. A Codex that is set up but cannot run (absent,
  off its pinned version, not signed in) does not refuse start: it is listed unavailable;
- one of `PERISCOPE_QWEN_BIN` and `PERISCOPE_QWEN_HOME` is set without the other, either is not an
  absolute path, or the CLI is a batch file. A Qwen Code that is set up but cannot run (absent, off its
  pinned version, a base that cannot be created) does not refuse start: it is listed unavailable;
- one of `PERISCOPE_PI_BIN` and `PERISCOPE_PI_HOME` is set without the other, either is not an
  absolute path, or the CLI is a batch file. A pi that is set up but cannot run (absent, off its pinned
  version, a home that cannot be written) does not refuse start: it is listed unavailable;
- one of `PERISCOPE_COPILOT_SDK` and `PERISCOPE_COPILOT_HOME` is set without the other,
  `PERISCOPE_COPILOT_TOKEN_FILE` is set without them, or any of the three is not an absolute path. A
  Copilot that is set up but cannot run (no install, another version, no runtime for the platform, a
  base that cannot be created) does not refuse start: it is listed unavailable;
- one of `PERISCOPE_OPENCODE_SDK` and `PERISCOPE_OPENCODE_HOME` is set without the other, or either is not
  an absolute path. An opencode that is set up but cannot run (no install, another version, a Node older
  than 24, a base that cannot be created) does not refuse start: it is listed unavailable.

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
