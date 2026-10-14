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
   value that should outlive the shell. Only the thirteen keys marked "config-file key" below may live
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

| Variable                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERISCOPE_CONTROLLER_URL`           | Required by `serve`. The WebSocket URL the host dials (`ws:`/`wss:`). Config-file key; settable over the link, in effect at the next start.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PERISCOPE_DECISION_URL`             | Required by `serve`. The HTTP endpoint the host POSTs each permission escalation to (`http:`/`https:`; settable over the link, in effect at the next start). Its origin is also where `pair` derives the redemption URL when `PERISCOPE_PAIR_URL` is unset. Config-file key.                                                                                                                                                                                                                                                                                                                              |
| `PERISCOPE_HOST_ID`                  | The id announced in `link_hello`. Defaults to the machine hostname (an empty value counts as unset); a paired credential's host id overrides it, and the override is logged when the two differ. Config-file key.                                                                                                                                                                                                                                                                                                                                                                                         |
| `PERISCOPE_WORKSPACE_ROOT`           | When set, every session gets a directory beneath it instead of the `cwd` the controller named. Config-file key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PERISCOPE_REPOSITORY_ROOT`          | With `PERISCOPE_WORKSPACE_ROOT`, sessions get a linked git worktree of this repository on their own branch instead of a plain directory. Config-file key.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PERISCOPE_BRANCH_SCHEME`            | The branch-name template those worktrees use; placeholders are `{key}` and `{repo}` (the repository directory's name). Default `{repo}/{key}`. Needs both roots. Screened at start-up. Config-file key.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PERISCOPE_WORKSPACE_KEY`            | The workspace key an unkeyed `session_new` provisions at. Needs `PERISCOPE_WORKSPACE_ROOT`. Screened at start-up. Config-file key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PERISCOPE_AGENT_HOME`               | The agent's home: the folder the agent CLI keeps its state in. Transcripts are read from `<home>/projects` (derived, reported in the hello, never set on its own). Default: the CLI's own, `<user home>/.claude`. Must be absolute. Config-file key.                                                                                                                                                                                                                                                                                                                                                      |
| `PERISCOPE_PLUGIN_DIRS`              | Plugin directories every session loads, a path list in the platform's delimiter (`;` on Windows, `:` elsewhere), at most `MAX_PLUGIN_DIRS`. Each is a plugin root: absolute, present, carrying `.claude-plugin/plugin.json` with a `name`; refused by name at start and at every open otherwise. The manifests' names and versions ride the hello as `configuration.plugins`. A controller's own `session_new.request.plugins` are added after these. Config-file key.                                                                                                                                    |
| `PERISCOPE_CONTROLLER_ENV_KEYS`      | The names a controller may place in a session's environment through `session_new.request.env`: `extraEnv` sets one, `extraAllowedKeys` re-admits one this host holds. Comma-separated, matched case-insensitively. Unset declares nothing, and then a `session_new` whose `env` adds any key refuses `env-key-refused`. A name beneath the floor (the model route and its credentials, the proxies, the certificates trusted; `SECURITY.md` lists it) or one that is not a variable name refuses start, because no controller could set it. Read at start. Config-file key; never settable over the link. |
| `PERISCOPE_MODEL_ENDPOINTS`          | The absolute path of the model endpoints file ([model endpoints](#model-endpoints)). Read, checked and its credentials resolved at start; a file this host could not honour refuses start. The file and every credential file it names join the gate's protected set. Config-file key; never settable over the link.                                                                                                                                                                                                                                                                                      |
| `PERISCOPE_CODEX_BIN`                | The Codex binary sessions naming `codex` run, by absolute path: the native `codex` binary, or the npm package's `bin/codex.js`, which runs under this Node. A batch file (`.cmd`, `.bat`) is refused, because it runs only through a shell. Set with `PERISCOPE_CODEX_HOME` or not at all; one without the other refuses start. Read at start ([Codex](#codex)). Config-file key; never settable over the link.                                                                                                                                                                                           |
| `PERISCOPE_CODEX_HOME`               | The Codex home every Codex session runs from (`CODEX_HOME`), by absolute path: the runner's own, never the operator's `~/.codex`. Created when absent. Its sign-in files, and the files that make periscope's hook the gate there (`hooks.json`, `hooks/`, `config.toml`), join the gate's protected set. A path holding a space or any of `&                                                                                                                                                                                                                                                             | < > ^ % ! ( ) ; , = ' "`or a backtick cannot carry the hook's line, so Codex is listed unavailable, naming the character; the host still starts. Set with`PERISCOPE_CODEX_BIN`. Config-file key; never settable over the link. |
| `PERISCOPE_QWEN_BIN`                 | The Qwen Code CLI sessions naming `qwen-code` run, by absolute path: the npm package's `cli-entry.js`, which runs under this Node. A batch file (`.cmd`, `.bat`) is refused, because it runs only through a shell. Set with `PERISCOPE_QWEN_HOME` or not at all; one without the other refuses start. Read at start ([Qwen Code](#qwen-code)). Config-file key; never settable over the link.                                                                                                                                                                                                             |
| `PERISCOPE_QWEN_HOME`                | The base every Qwen Code session's home is made beneath, by absolute path: the runner's own, never the operator's `~/.qwen`. Created when absent. Each session runs from `<base>/sessions/<id>`, made at its open and removed at its close, and every session shares `<base>/runtime`, where the CLI keeps the chats a resume reads. `<base>/sessions` joins the gate's protected set. Set with `PERISCOPE_QWEN_BIN`. Config-file key; never settable over the link.                                                                                                                                      |
| `PERISCOPE_CODEX_ENDPOINT_KEY`       | Never read from this host's own environment, and not a config-file key: the host sets it, in the app-server environment of a Codex session opened on a [model endpoint](#model-endpoints), to that endpoint's credential, and the session's provider reads its key from it. Kept out of the agent's shell, and beneath the env floor, so no controller can set it.                                                                                                                                                                                                                                        |
| `PERISCOPE_HOOK_CHANNEL`             | Never read from this host's own environment, and not a config-file key: the host sets it, in a Codex session's app-server environment, to the address of that session's hook channel (a named pipe on Windows, a Unix socket elsewhere), and `periscope hook codex` reads it. Kept out of the agent's shell, and beneath the env floor, so no controller can set it.                                                                                                                                                                                                                                      |
| `PERISCOPE_HOOK_TOKEN`               | Never read from this host's own environment, and not a config-file key: the host sets it, in a Codex session's app-server environment, to that session's random token for its hook channel, and `periscope hook codex` presents it and verifies the host's answer by it. Kept out of the agent's shell, and beneath the env floor, so no controller can set it.                                                                                                                                                                                                                                           |
| `PERISCOPE_HOOK_DEADLINE_MS`         | Never read from this host's own environment, and not a config-file key: the host sets it, in a Codex session's app-server environment, to how long `periscope hook codex` waits for the host's answer: the session's decision deadline plus `HOOK_DEADLINE_MARGIN_MS`, inside the hook's timeout. Kept out of the agent's shell, and beneath the env floor.                                                                                                                                                                                                                                               |
| `PERISCOPE_CONFIG_DIR`               | The directory holding the token cache, the paired credential and the config file. Default `<home>/.periscope`, where home is `USERPROFILE` or `HOME`. The whole directory is in the gate's protected set. Deliberately not a config-file key.                                                                                                                                                                                                                                                                                                                                                             |
| `PERISCOPE_PAIR_URL`                 | Where `periscope pair` redeems a code when no `--controller` is given. Default: the origin of `PERISCOPE_DECISION_URL` plus the controller's pair route.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PERISCOPE_MACHINE_LABEL`            | The label sent with a pair request when no `--label` is given, shown in the controller's listings. Default: the hostname.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PERISCOPE_IDENTITY_AUTHORITY`       | The OIDC issuer URL; https is required, `localhost` included. With `PERISCOPE_IDENTITY_CLIENT_ID` it enables identity; one without the other refuses start.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PERISCOPE_IDENTITY_CLIENT_ID`       | The public-client id registered with the provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PERISCOPE_IDENTITY_SCOPES`          | Space- or comma-separated scopes. Default `openid profile offline_access`. Set to nothing, it refuses start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PERISCOPE_IDENTITY_AUTHORIZE_URL`   | The authorization endpoint. Set together with `PERISCOPE_IDENTITY_TOKEN_URL` or not at all; when both are unset they are discovered from the authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PERISCOPE_IDENTITY_TOKEN_URL`       | The token endpoint. Same rule as above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PERISCOPE_IDENTITY_DEVICE_CODE_URL` | The device-authorization endpoint. Read only when the two endpoints above are set; on its own it is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PERISCOPE_IDENTITY_REDIRECT_PORT`   | The loopback listener's port, an integer 0-65535. Default 0 (an ephemeral port).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PERISCOPE_IDENTITY_DEVICE_CODE`     | `1` enables the device-code fallback. Off otherwise, and never reached by falling back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PERISCOPE_LIVE`                     | Tests only. `1` runs the probes that need a real agent (`npm run test:live`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PERISCOPE_PROOF_OUT`                | Examples only. A file path the parallel-run proof writes its full report to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PERISCOPE_FC_SEED`                  | Tests only. The property-test seed: a number reproduces a reported failure, `random` explores.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PERISCOPE_UPDATE_CONTRACTS`         | Tests only. Set by `npm run contracts:update` while it re-approves the snapshots under `contracts/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The agent CLI's token cache and configuration file in `CLAUDE_CONFIG_DIR`, when set, and in
`PERISCOPE_AGENT_HOME`, when it is not the default, are added to the gate's protected paths, and so are
the model endpoints file and every credential file it names, and `auth.json` and `.credentials.json`
in `PERISCOPE_CODEX_HOME` and in `<user home>/.codex`, and the session homes beneath
`PERISCOPE_QWEN_HOME`, Qwen Code's sign-in, token and settings files in `<user home>/.qwen` and in an
operator's own `QWEN_HOME`, and `<user home>/.env`; the full set is listed in [the gate](gate.md).

## What a controller can set over the link

`host_configure` accepts seven of the config-file keys: `PERISCOPE_WORKSPACE_ROOT`,
`PERISCOPE_REPOSITORY_ROOT`, `PERISCOPE_BRANCH_SCHEME`, `PERISCOPE_AGENT_HOME`,
`PERISCOPE_PLUGIN_DIRS`, `PERISCOPE_CONTROLLER_URL`, `PERISCOPE_DECISION_URL`. A written plugin
directory is loaded by the next open; the answer's `configuration.plugins` says what each one names. The host screens the whole set before writing,
refuses a change to a workspace root while any session is live or opening, and answers with the
effective values plus the keys its environment shadows. The two addresses are written but never
applied to the live link: the host keeps dialling what it dialled, names them as pending in its
answer and in every hello, and the next start reads the file. The host id is never settable over the
link, and neither are the names a controller may place in a session's environment
(`PERISCOPE_CONTROLLER_ENV_KEYS`): a controller able to write that list would declare its own. Nor is
the model endpoints file (`PERISCOPE_MODEL_ENDPOINTS`): a controller able to point it elsewhere would
choose where a session's model calls go, and with which credential. Nor are the Codex binary and
home (`PERISCOPE_CODEX_BIN`, `PERISCOPE_CODEX_HOME`): a controller able to point them elsewhere would
choose what runs as a session, and whose sign-in it runs under; and the Qwen Code CLI and base
(`PERISCOPE_QWEN_BIN`, `PERISCOPE_QWEN_HOME`), for the same reason. A controller can also list one directory or read the head of one text file under the
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

| Member          | Meaning                                                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | What a `session_new` names the endpoint by, and what the hello lists. Letters, digits, `.`, `_` and `-`, at most 64; unique in the file, ignoring case.                                                                                                                                                                   |
| `wireApi`       | The API the endpoint speaks: `anthropic-messages`, `openai-responses` or `openai-chat`.                                                                                                                                                                                                                                   |
| `runtimes`      | The runtimes that may reach it. Each must speak `wireApi`: Claude speaks `anthropic-messages`, Codex `openai-responses`.                                                                                                                                                                                                  |
| `baseUrl`       | Where the agent's model calls go, as an `http` or `https` URL. Never in the hello.                                                                                                                                                                                                                                        |
| `credential`    | Exactly one of `{ "env": NAME }`, `{ "file": PATH }` or `{ "helper": { "command": PATH, "args": [...] } }` (below). Required.                                                                                                                                                                                             |
| `models`        | The model ids a session may name on the endpoint, as the agent sends them, a `[1m]` suffix included where the vendor documents one.                                                                                                                                                                                       |
| `modelAliases`  | The model each tier (`opus`, `sonnet`, `haiku`, `fable`) resolves to on the endpoint, each one of `models`. The hello lists the mapped tiers as model ids too. Read only on an endpoint Claude reaches.                                                                                                                   |
| `contextWindow` | Optional. `{ "autoCompactWindow": N }` (100000 to 1000000 tokens), or `{ "maxContextTokens": N }`, in the form the vendor documents; never both.                                                                                                                                                                          |
| `env`           | Optional. Up to 32 more variables for sessions on the endpoint, such as `API_TIMEOUT_MS`, `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL`. Not a variable the members set, and not one the host strips from every session.                                                                                     |
| `firstParty`    | Optional, default `false`. `true` marks Anthropic's own route, where a Claude model id may be named. It changes which model ids may be named, never how the credential is sent: the key always reaches the agent as `ANTHROPIC_AUTH_TOKEN`, the bearer form. Never in the hello. Read only on an endpoint Claude reaches. |

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

**The window.** Vendors document one of two forms. A `[1m]` suffix on a model id tells the agent the
model holds a million tokens, and `autoCompactWindow` says where it compacts; `maxContextTokens` tells
it the window of an id it does not know. A `[1m]` id beside `maxContextTokens` is refused, because
the suffix overrides the stated window.

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
  "models": ["gpt-6-sol"],
  "contextWindow": { "maxContextTokens": 400000 }
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
- `contextWindow` becomes Codex's: `maxContextTokens` its `model_context_window`, the window of a
  model it does not know, and `autoCompactWindow` its `model_auto_compact_token_limit`.
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

- **The version is pinned.** This release runs Codex 0.162.1 (`CODEX_PINNED_VERSION`). Install that
  version (`npm install -g @openai/codex@0.162.1`, or the release's native binary) and point
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

- **The version is pinned.** This release runs Qwen Code 0.25.1 (`QWEN_PINNED_VERSION`). Install that
  version (`npm install -g @qwen-code/qwen-code@0.25.1`) and point `PERISCOPE_QWEN_BIN` at the
  package's `cli-entry.js`. A CLI that reports another version, or none, is listed unavailable with
  the path, the version it reports and the version pinned; the host still starts, and a session naming
  `qwen-code` is refused `runtime-unavailable` with that reason. Nothing installs or updates it.
- **The model is an endpoint's.** Qwen Code has no sign-in of its own here: a session reaches its
  model through a [model endpoint](#model-endpoints) whose `runtimes` name `qwen-code`, over any of the
  three wire APIs. The endpoint's credential is written only into the session's settings file, never
  into the CLI's environment or onto its command line. A session opened on no endpoint starts, and its
  first turn ends in an error naming the missing auth type or key (the sign-in marker
  [the wire protocol](protocol.md) names), unless a variables file the CLI loads (below) names a
  route of its own. The hello's entry carries no model catalog; a session names
  its model.
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
a model without mapping it, which a session naming it is refused (`model-endpoint-mismatch`). A host
offering Codex prints `[codex] codex 0.162.1, 6 model(s) in the hello, control tier
intercepted-with-residual`, or `[codex] codex is listed unavailable` with the reason, and then whether
periscope's hook was written to the runner's home and answered its probe. A host offering Qwen Code
prints `[qwen-code] qwen-code 0.25.1, 0 model(s) in the hello, control tier intercepted-with-residual`,
or `[qwen-code] qwen-code is listed unavailable` with the reason.

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
  pinned version, a base that cannot be created) does not refuse start: it is listed unavailable.

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
