# Security

Periscope runs Claude Code sessions on your machine on behalf of a remote controller, and Codex,
Qwen Code and pi sessions when you configure them. That is a serious thing to install, and this
document is written to be read _before_ you do. It states the posture, what each control covers, and
what it does not. Everything about the gate below is about Claude sessions; a Codex session is gated
through its own hook, a Qwen Code session through its CLI's own permission requests and a pi session
through an extension of periscope's own, each with residual paths named as they happen, and
[Codex sessions](#codex-sessions), [Qwen Code sessions](#qwen-code-sessions) and
[pi sessions](#pi-sessions) say what holds and what does not.

## The permission model

Periscope runs the agent headless under the Agent SDK, so there is no interactive prompt. It does
not pass `--dangerously-skip-permissions` and sets no permission mode of its own; it registers a
`PreToolUse` hook on every session, and that hook is the only path to a yes: the host turns
`grantOnAllow` on for every session it opens, so the hook's allow is what lets a tool run and its
deny, or its silence, is what stops one. Read on its own that looks like the safety being switched
off. It is the opposite: the interactive prompt is replaced by a stricter gate, not removed.

The permission mode is the controller's to set, per session, in the SDK's own vocabulary
(`session_new.request.permissionMode`, and `session_configure` mid-session), and that includes
`bypassPermissions`. The hook's deny survives every mode; what changes under bypass is that the
agent's own allow and ask rules no longer apply, so the hook is then the only control there is. A
controller that sets bypass is choosing that, and this document counts it among the things a
pairing extends (below). The one thing the host refuses on its own is a grant layered over loaded
settings files in any other mode, `permission-grant-shadows-settings`, because two mechanisms
would then answer one question with no stated precedence.

A session started in `bypassPermissions` is started with the SDK's `allowDangerouslySkipPermissions`
(the CLI's `--allow-dangerously-skip-permissions`), which the SDK names as the mode's requirement.
A session started in any other mode is started without it, and the CLI then refuses a switch into
bypass, by name: "the session was not launched with --dangerously-skip-permissions". That refusal
reaches the controller as `session-configure-failed`, measured on Claude Code 2.1.284 from inside an
agent session ([gate.md](docs/gate.md)). So bypass is chosen when a session opens, never added to a
running session that did not start in it.

The interactive prompt asks a human sitting at the terminal. That is a fine control when someone is
sitting there. Periscope exists for the case where nobody is, so the question has to be answered by
something that is still awake at 3am, and the options are _a stricter gate_ or _no gate_.

|                               | The interactive prompt     | Periscope's gate                                                                                                         |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Who decides**               | whoever is at the keyboard | your controller, or a rule that runs locally                                                                             |
| **When nobody answers**       | the session blocks forever | the tool does not run: every timeout, error and outage is a refusal                                                      |
| **Is the decision recorded**  | no                         | yes: every call, decision and reason is a state transition on the wire                                                   |
| **Can it be checked offline** | n/a                        | partly: the local gate refuses path escapes, credential reads and unrecognised git verbs with the controller unreachable |
| **What a crash does**         | n/a                        | refuses. A hook that _throws_ is treated by the SDK as absent, so every handler is wrapped and returns an explicit deny  |

The invariant is absolute: no answer, any error, any timeout, any outage means the tool does not
run. It is fail-closed on every path; the suite exercises each path rather than reading it off the
types.

### The gate has a local half, and that is what makes it provable offline

Before anything is asked of your controller, a local rule runs. It only ever _adds_ refusals; it
can never turn a "no" into a "yes". It refuses, locally and immediately: a path that escapes the
session's workspace, a read of the credential set, and a git invocation whose verb is not on the
allow-list, by parsing the command rather than by matching strings. A boundary-crossing shape (a
push, a force, a remote change, a branch deletion, a merge on GitHub or the completion of an Azure
DevOps pull request) is recognised locally, from the parsed command, but escalated to
the controller like any other call, so a person can answer it; with the controller unreachable it
refuses when the decision deadline passes. So the answer to _"what happens if the controller is
compromised or unreachable?"_ is: the local classes are refused before the question is asked, and
everything else refuses because nobody answered.

## What this can touch on your machine

Nothing outside `src/host/` imports `node:fs`, `node:fs/promises`, `node:child_process` or
`node:os`. One directory. You can answer _"what can this touch?"_ by reading it, and the rule is
enforced twice: an ESLint rule for editor feedback, and a tree-walking test that survives the lint
config being edited, disabled or deleted.

`@naswerks/periscope/protocol`, the subpath a controller imports, structurally cannot reach that directory,
does not pull the Agent SDK, and uses no Node-only global. Importing the wire contract does not hand
you a package that can read your disk.

## The posture: five facts that are one picture

What you actually get: two facts about credentials, two about the tool surface, and one about what
the gate's decision is worth. Stated together rather than scattered, because taken singly each one
reads milder than the situation is.

### 1. On Windows the token cache has no OS-level protection at all

POSIX modes are inert on win32. Measured on win32 with node v24.16.0: a file written `0o600`, a file
`chmod`ed to `0o600`, and a deliberately world-readable `0o666` all report `666`. Only the write bit
is real: `chmod 0444` does read back as `444`.

The genuine controls on Windows would be NTFS ACLs, and both routes to them were rejected
deliberately: a native module would be the first compiled code in a dependency set that is
otherwise plain JavaScript, and shelling out to `icacls` on every credential write puts a
`child_process` call in the credential path, inside the boundary that exists to keep that surface
small.

> So on Windows, the controls over your token cache are: the gate's credential-path denial (scoped
> as fact 3 states, not total), your controller's decisions, and your OS user account. That is a
> real degradation from the POSIX story. If you assumed file permissions were protecting that file,
> they are not.

### 2. And on Windows the host cannot even measure that protection

This is a _different_ fact from the one above, and collapsing the two would be misleading. Above is
_there is no protection_; this is _the instrument cannot see it_. A `0600` assertion on win32 cannot
distinguish an owner-only file from a world-readable one, so a check written the obvious way would
pass vacuously and report a privacy it never confirmed.

Periscope therefore probes what the filesystem actually records and reports one of three outcomes,
never two:

|                  |                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `enforced`       | modes are honoured; the file is verified, and one wider than requested is refused        |
| `write-bit-only` | only writability is recorded, so privacy is unconfirmable. A named degrade, not a pass   |
| `unobservable`   | not even clearing the write bit changed anything: inconclusive, and reported differently |

The third outcome exists because an instrument with no inconclusive state reports confidence it has
not earned. `chmod 0444` is used as a positive control, proving the probe can observe _something_
before it reports that it cannot observe privacy.

A Linux CI leg closes the second of these two and not the first. Being able to measure protection
on POSIX does not create protection on Windows.

### 3. The gate has no opinion about MCP tools you register, or about built-in tools outside its families

The local gate matches on tool name, in four families (`DEFAULT_TOOL_FAMILIES`): writes are `Write`,
`Edit`, `MultiEdit`, `NotebookEdit`; reads are `Read`, `NotebookRead`; searches are `Grep`, `Glob`;
shells are `Bash`, `PowerShell`. An MCP tool arrives as `mcp__{server}__{tool}`, matches nothing, and
gets no local opinion, so the decision escalates to your controller. That is fail-closed and correct.

Within the families the credential-path denial is scoped, and the scope is what to review. Writes
are jailed to the session's workspace. Reads are not jailed: a read goes anywhere this host's OS user
can read, the agent's own tool output and installed packages included, and the protected set is what
stops it. A search is refused when its root (`path`, else the workspace) is at or beneath a protected
path, and also when a protected path sits beneath its root, because the search would read it. The
shell scan matches a protected path written literally, through a home-directory form (`~`, `$HOME`,
`${HOME}`, `$env:HOME`, `$env:USERPROFILE`, their braced `${env:...}` spellings, `%USERPROFILE%`),
or through a variable of the session's spawn environment whose value is one absolute path, spelled
`$NAME`, `${NAME}`, `$env:NAME`, `${env:NAME}` or `%NAME%`. Those variables are the ones each runtime
is started with: the homes this host sets (`CODEX_HOME`, `QWEN_HOME`, `QWEN_CODE_SYSTEM_SETTINGS_PATH`,
`PI_CODING_AGENT_DIR` and their kin) and the ones it passes through (`USERPROFILE`, `APPDATA`,
`CLAUDE_CONFIG_DIR` when you set it). A name is read as each shell reads it, PowerShell's and `cmd`'s
without regard to case and a POSIX shell's exactly, and every comparison folds case. A command that
only shows such a variable is refused like one that mentions the path itself:
`echo "$PI_CODING_AGENT_DIR"` is, since the whole pi home is protected. What falls through is
symlink indirection (the gate resolves paths as text and follows no link) and a shell command that
reaches a protected path without naming it:

- a recursive search of an ancestor directory;
- a path the command builds at run time, from several variables (`%HOMEDRIVE%%HOMEPATH%`) or from a
  variable it sets itself;
- a variable the runtime sets in its own shell, whose value this host never sees (pi's
  `PI_SESSION_FILE`, Qwen Code's `QWEN_CODE_PROJECT_DIR`);
- a variable read through a command (`$(printenv NAME)`, `Get-Item env:NAME`) or an expansion
  operator (`${NAME:-...}`, `${NAME%...}`, `%NAME:~...%`, `cmd`'s delayed `!NAME!`);
- a list variable such as `PATH`, which is never spelled out.

What this means for fact 1's picture: offline, those calls escalate and are refused as outages, which
is still fail-closed; online, for exactly those vectors, what stands between the agent and the token
cache is your controller, not this gate. Closing them is a known open question: a link needs the
filesystem the gate deliberately does not consult, and a computed path cannot be read from a
command's text.

Name what is lost, because "no opinion" undersells it. With the controller unreachable, such a call
is refused as an outage rather than by name, which is precisely the distinction the local gate was
built to make. The cost is the kind of refusal, not the delay, and the by-name half of that is a
measurement: with both of the controller's transports dead, a built-in naming the token cache was
refused 5s after the turn was queued, by name (`credential-path-denied`), against an escalation
deadline of 15s, so the answer was the local gate's, not a timeout expiring. A call with no local
opinion in the same outage is refused as exactly that, an outage. A refused connection fails fast;
the decision timeout is only paid when the controller _accepts_ and does not answer. An outage
cannot be told apart from a failure on the controller's side, and that is what is lost. So:

> If you register MCP tools and never touch `ToolFamilies`, your gate is offline-provable for
> `Bash` and not for your own tools.

The mechanism to close it is `PeriscopeHostOptions.toolFamilies`: `ToolFamilies` is embedder-supplied
data, so naming your tool in the right family gives it the same local treatment as the built-in it
resembles. The git verb allow-list inside the shell family is not configurable; an unrecognised verb
refuses locally and a boundary shape escalates, whoever the embedder is.
Periscope deliberately does not guess which of your tools are dangerous. It cannot know, and a host
that guessed would be wrong in exactly the cases that matter.

### 4. `strictMcpConfig` defaults ON, and turning it off re-admits servers that can fail silently

Periscope registers MCP servers in-process. There is no stdio child, no connect race, and nothing
for the CLI to fail to reconnect, which is why the absence of a status/reconnect surface is harmless
rather than a gap. That sentence is about the server this package registers itself; a server the
controller declares in `session_new.request.mcpServers` is whatever it declares, a stdio child
included (see _What a paired controller can reach_ below). The reasoning holds only while
`strictMcpConfig` is on, which excludes servers nobody declared: project `.mcp.json`, user settings,
plugin MCP, agent frontmatter.

> Turn `strictMcpConfig` off and you re-admit process-transport servers that can fail, with no
> status or reconnect surface to notice or recover. It is one flag, and it is the whole residual.

### 5. A composed host grants what its gate approves, and a hand-composed one does not

The gate returns _no opinion_ on an allow by default, so that it can only ever add a refusal and
never delete one the operator configured. On its own that makes it a veto rather than a gate: the
agent's own permission mode is then the decider, and in a host with nobody at a keyboard there is
nobody to answer it. Measured on real sessions, three, identical but for the decision:

| Decision               | File on disk | What the model was told                                                         |
| ---------------------- | ------------ | ------------------------------------------------------------------------------- |
| **deny**               | no           | _"the probe controller refuses this write"_: your reason, verbatim              |
| **allow**, not granted | **no**       | _"Claude requested permissions to write to ... but you haven't granted it yet"_ |
| **allow**, granted     | **yes**      | _"File created successfully at: ..."_                                           |

So `PeriscopeHost` sets `grantOnAllow`: it makes the decision your gate already took take effect,
one call at a time, for exactly the calls it approved. It is not `bypassPermissions`; nothing is
disabled wholesale.

> Four residuals.
> **(1)** The flag defaults OFF. An embedder who calls `composeSession` by hand and does not set it
> gets a gate that cannot say yes: the tool simply does not run and the agent reports a permission
> it was never going to be granted. This raises a `gate-cannot-grant` degrade on the first allow
> that does not take effect, and the consequence is stated on `GateTimings.grantOnAllow` itself,
> where an embedder actually reads it.
> **(2)** `grantOnAllow` with settings files loaded is refused by name
> (`permission-grant-shadows-settings`). Load no settings, or do not grant.
> **(3)** That refusal is incomplete on its own logic, and knowing why matters more than the rule:
> `settingSources: []` does _not_ mean no operator rules are live. Managed policy settings and
> `~/.claude.json` load regardless of that field, and a managed machine is exactly where such a
> policy exists. The refusal sees the tiers you name and cannot see the two that are always on.
> **(4)** A hand-composed session's shell scan spells out the home-directory forms only. The
> session's path variables reach the local gate through `PeriscopeHost`'s own composition, so a
> session composed by hand names a protected path through `$NAME`, `$env:NAME` or `%NAME%` past the
> scan.

> **What an effective allow actually skips.** The [Claude Code permissions
> documentation](https://code.claude.com/docs/en/permissions#extend-permissions-with-hooks) states
> that a hook's decision does not bypass permission rules: deny and ask rules are evaluated whatever
> a `PreToolUse` hook returns. So a grant skips only the permission mode, the allow rules and
> `canUseTool`; the operator's deny and ask rules survive it. A veto-only gate still cannot say yes
> (that was measured, above), so the default is still correct; the residual exposure of a grant is
> smaller than a full bypass, and the refusal in (2) rests on "two authorities, no stated
> precedence" rather than on a bypass.
>
> That paragraph is documented, not measured. The probe that would settle it exists in
> `gate.live.test.ts` (does a hook allow override an operator deny rule?) and has not been
> exercised cleanly: run from inside an agent session, the child inherits the enclosing session's
> tool surface, satisfies the prompt with a tool the deny rule did not name, and never calls the
> denied one. Run it on a machine that is not itself an agent session before treating any of this
> as observed.

## Model endpoints and the agent's own settings

An endpoint is yours: you write it into the file `PERISCOPE_MODEL_ENDPOINTS` names, and nothing on the
link can add or change one ([configuration](docs/configuration.md#model-endpoints)). Its credential is
resolved when the host starts and held in the host's memory; a helper command's output is never
logged. A session on the endpoint carries the credential as `ANTHROPIC_AUTH_TOKEN` in the agent's own
environment, so the agent's sign-in is never the credential sent to a third party, and
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` keeps it out of the environments of the commands, hooks and stdio
tool servers the agent starts. The agent's own process still holds it: a tool that reads another
process's environment from the operating system is not stopped by the scrub. That is documented, not
measured.

Three settings files can change what the agent does, and the host treats each by whose it is:

- **Managed settings** are read whatever `settingSources` says. They are the machine administrator's
  file, and they can set the model route.
- **The user tier** (`~/.claude/settings.json` in the agent home) is yours, and the host does not read
  it. Its `env` can set the same variables an endpoint sets, for a session that asks for the `user`
  tier; keep a vendor's route out of the user settings of a runner that declares endpoints.
- **The repository tiers** (`.claude/settings.json` and `.claude/settings.local.json` in the session's
  working directory) are the repository's, and a repository a session works in is not you. A session
  that loads either tier is refused `settings-route-refused` before the agent starts when the file's
  `env` names a key beneath the floor, naming the file and the key: otherwise a repository could set
  the model route, its credentials or a proxy past every screen the host runs. The check reads the
  files whether or not the agent trusts the folder, which only ever refuses more. It runs when a
  session opens or resumes, and the agent reloads its settings files while it runs, so a session that
  writes its own `.claude/settings.local.json` mid-session is caught at its next open or resume, not
  before. Whether a reloaded `env` moves a running agent's model route is not documented and not
  measured. A repository tier can also name an `apiKeyHelper`, a command the agent CLI runs to fetch
  its credential: the check reads only `env`, so a session that loads that tier runs the repository's
  command outside the gate and authenticates with what it prints. Load the repository tiers only for a
  repository you trust.

## Codex sessions

Codex is offered only when you set `PERISCOPE_CODEX_BIN` and `PERISCOPE_CODEX_HOME`
([configuration](docs/configuration.md#codex)). A Codex session's control tier is
`intercepted-with-residual`, and the hello says so: every tool call Codex's `PreToolUse` hook sees is
decided by the same gate as a Claude call (the local refusals above, then your controller), and the
paths that can still run undecided are named, one by one, as they happen ([gate.md](docs/gate.md),
the Codex gate). What holds, and what does not:

- **Periscope's hook decides each call, and fails closed itself.** Codex runs the `periscope hook codex`
  command before each tool call; it asks this host over a per-session named pipe or Unix socket (never
  a TCP port) and writes either nothing (proceed) or a deny. Codex lets a call proceed whenever a hook
  fails (times out, crashes, writes output it does not accept), so the command answers deny on every
  failure of its own, inside Codex's timeout. A session opens only when periscope's hook is listed
  trusted and enabled for it (`codex-hook-not-active` otherwise), and the host trusts it over the wire
  exactly as Codex's own interface does.
- **The hook runs unsandboxed, with the app-server's whole environment.** It is a plain child process,
  and Codex hands it every variable the app-server has, the session's channel token
  (`PERISCOPE_HOOK_TOKEN`) included; Codex's shell exclusion keeps the token from the agent's own
  commands. The agent shares this host's OS user, so it could read the token out of the app-server's
  memory: what the token buys is asking the gate about a call, which runs nothing and grants nothing.
  Every answer carries an HMAC keyed by the token, so a process that takes over the channel's name
  cannot answer allow. The controller's credential never leaves the host.
- **The residual, named.** A call can still run undecided: when the hook fails (`gate-hook-timed-out`,
  `gate-hook-unspawnable`, `gate-hook-output-rejected`) in a mode that asks no approval (in one that
  does, the call reaches the approval channel, which the gate decides afresh), when a call starts or proceeds with no decision
  from this host (`gate-hook-missing`), and on the calls no hook sees: input written to a running
  command, a hosted web search, an image generation (`gate-unhooked-call`). An approval Codex's own
  reviewer decided is `gate-approval-auto-reviewed`. A hook periscope did not install
  (`gate-hook-foreign`), the workspace's own Codex configuration (`gate-project-config-active`) and a
  mode with no operating-system sandbox (`gate-sandbox-absent`) are named when the session opens. Each
  is an observation on the session's record; none stops a session.
- **Codex's approvals are decided by the same gate.** An approval Codex asks for is answered from the
  hook's decision for that call, or decided fresh, or declined at this host's deadline
  (`gate-approval-unanswered`). It is never granted for the rest of the session, never an amendment to
  Codex's rules and never a root it may write under; a request for wider permissions is granted
  nothing, and a question for the user gets no answers. The approvals reviewer is pinned to the user,
  web search is off, and Codex's hook layer is forced on. The host never asks the app-server to run a
  command itself.
- **Codex's own sandbox, from the session's permission mode.** `default` is `on-request` approval in
  the `workspace-write` sandbox; `dontAsk` is `never` in `workspace-write`; `bypassPermissions` is
  `never` with `danger-full-access`, no sandbox at all, and then no approval is ever asked, so the hook
  is the only decision. On Windows with no sandbox backend configured, `workspace-write` is not
  enforced by the operating system (`gate-sandbox-absent`), and `default` asks for an approval on every
  command and patch, a second decision behind the hook. The sandbox is Codex's; this package neither
  implements nor measures it. On Windows Codex runs the agent's commands through PowerShell, which
  loads the user's PowerShell profile whenever Codex runs a call as a login shell: its default, unless
  the call asks otherwise, in which case the command runs with `-NoProfile`.
- **The gate's own files are protected; the gate's code is not.** The runner home's `hooks.json`, its
  `hooks` directory and its `config.toml` join the protected set beside its sign-in files: the hook is
  all that stands between the agent's shell and those credentials, and rewriting the shim (whose trust
  covers its path, not its bytes) or the recorded trust would take it away. The shim's bytes are also
  rewritten at every open when they differ. That protects the files Codex reads to find the gate, and
  nothing more: the shim runs this package's `dist/bin/periscope.js` under the Node binary on every
  call, and neither is in the protected set. The agent shares this host's OS user, so a command that
  rewrites either ungates every later Codex call on this runner. It is the same-user residual this
  package names throughout, wider for Codex because Codex alone re-reads its gate from disk on every
  call; keep the package and Node where the runner's user cannot write, or accept it.
- **A home of the runner's own.** `CODEX_HOME` is `PERISCOPE_CODEX_HOME` for every Codex process, so
  a session never runs from your own `~/.codex`, its sign-in or its history. The sign-in files in both
  homes (`auth.json`, `.credentials.json`) are in the protected set, named literally, through a
  home-directory form or through `CODEX_HOME` itself, and `CODEX_HOME` is kept from the agent's shell
  (below). A home whose path holds a space or a shell metacharacter cannot carry the hook's line, so
  Codex is listed unavailable there, naming the character; the host itself still starts.
- **No project is trusted on your behalf.** The host sends no working directory on any thread or turn
  request; the app-server's own working directory is the session's. Codex records a project as
  trusted only when a thread request names a directory, so the host never writes a trust entry, and
  the repository's own Codex layer (its `.codex/` configuration, hooks and exec policies) stays
  disabled. Its `AGENTS.md` instructions still load, as they do for any project not marked untrusted.
  The one residual: a trust entry already in the runner home's `config.toml` that covers the
  session's repository opens that layer; keep the runner home's trust list empty.
- **The model route and identity are beneath the floor.** `CODEX_HOME`, `CODEX_SQLITE_HOME`,
  `CODEX_OSS_BASE_URL`, `CODEX_OSS_PORT`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_ACCESS_TOKEN`,
  `CODEX_CA_CERTIFICATE`, `PERISCOPE_CODEX_ENDPOINT_KEY` and the hook's own `PERISCOPE_HOOK_CHANNEL`,
  `PERISCOPE_HOOK_TOKEN` and `PERISCOPE_HOOK_DEADLINE_MS` are exact names in `EXTRA_ENV_FLOOR`, so no
  controller can move a Codex session's home, model server, credential, certificate authority or hook.
- **An endpoint's credential is kept from the agent's shell.** A Codex session on a named endpoint
  reads its key from `PERISCOPE_CODEX_ENDPOINT_KEY`, which the host sets, with the endpoint's own
  `env`, in the app-server's environment only. Codex hands a shell command the app-server's whole
  environment unless told otherwise, and its own exclusion of `*KEY*`, `*SECRET*` and `*TOKEN*` names
  is off unless asked for, so the host names each of those variables, the hook's three and
  `CODEX_HOME`, in `shell_environment_policy.exclude`, exactly; Codex matches each entry as a glob
  without regard to case, so each removes that one variable. Codex's hooks still receive the whole
  environment.
- **A tool server's ticket stays out of the environment and off the command line.** A session's HTTP
  MCP servers ride its thread's config, sent over the app-server's stdin, with their headers as
  static `http_headers`: never `env_http_headers`, which reads a header from the app-server's
  environment where the agent's shell could read it too, and never a `-c` argument, which a process
  listing shows. Each server's tools are asked about before every call, and the gate decides each ask
  for the call pending on that server.
- **A pinned binary.** The host runs one Codex release (`CODEX_PINNED_VERSION`), checks its
  `--version` and the version its app-server reports, and lists any other version unavailable. It
  never installs or updates Codex, and it never runs a batch file.

## Qwen Code sessions

Qwen Code is offered only when you set `PERISCOPE_QWEN_BIN` and `PERISCOPE_QWEN_HOME`
([configuration](docs/configuration.md#qwen-code)). A Qwen Code session's control tier is
`intercepted-with-residual`, and the hello says so: every call the CLI asks about is decided by the
same gate as a Claude call (the local refusals above, then your controller), the settings the host
writes send every call to ask, and the paths that can still run undecided are named as they are found
([gate.md](docs/gate.md), the Qwen Code gate). What holds, and what does not:

- **Every call asks, and the host checks that it will.** The CLI runs a call without asking only when
  its rules allow it. Each session's settings file sits at the CLI's system scope, which it applies
  over your user settings and the repository's `.qwen/settings.json`, and asks about every built-in
  tool of the pinned release and every attached MCP server, with every hook off. The host reads it
  back through the environment the CLI will start with before anything runs, and an open whose file
  does not read back that way is refused `qwen-ask-rules-not-active`. `QWEN_CODE_SAFE_MODE`, which
  drops every rule, is removed from the CLI's environment.
- **An allow runs the call as asked.** The CLI does not run a rewritten input, so an allow that
  carries one is refused (`permission-decision-unrecognised`). At its own deadline, set past the
  host's, the CLI cancels the call.
- **What still runs undecided is named.** A tool the CLI lists that no ask rule names (a tool a newer
  CLI adds, or an extension's) runs without asking when the CLI allows it by default:
  `gate-tool-unruled`, once per tool. A mode the CLI reports that approves calls itself:
  `gate-mode-widened`. Both are degrades on the session's state lane, never a stop.
- **Your `~/.env` reaches the agent's shell.** The CLI loads `~/.env`, and `~/.qwen/.env`, into its own
  environment whatever its home, and every command the agent runs inherits that environment. Both
  files are in the protected set, so a session's tools and shell commands are refused them, named
  literally, through a home-directory form or through a variable such as `$USERPROFILE`, and so are
  Claude's and Codex's: a session on any runtime is refused reading `~/.env`. A Qwen Code session
  that opens while one exists names the variables it adds, never their values, as
  `gate-credential-in-shell` in its opening tier, and so does a session whose endpoint sets variables
  of its own. Keep credentials out of both files on a runner.
- **A home of the runner's own, one per session.** Each session runs from a home beneath
  `PERISCOPE_QWEN_HOME`, made at its open and removed at its close, so a session never runs from your
  own `~/.qwen`, its sign-in or its settings. The sessions' homes are in the protected set, and so are
  the sign-in, token, extension-secret, settings and variables files in `~/.qwen` and in a `QWEN_HOME`
  you set yourself. The CLI's shell inherits the variables naming the session's home and settings file
  (`QWEN_HOME`, `QWEN_CODE_SYSTEM_SETTINGS_PATH` and their kin), and a command naming them is refused as
  if it named the path. The base's shared `runtime` directory, where the chats a resume reads are
  kept, is not protected: a session can read another session's chat there.
- **An endpoint's credential is written once, outside the environment.** A Qwen Code session reaches
  its model only through an endpoint you declared, and the endpoint's key is written into the
  session's settings file alone: never the CLI's environment, which the agent's shell inherits, and
  never its command line, which a process listing shows. The endpoint's base URL and auth type ride
  the command line.
- **A tool server's ticket stays out of the environment and off the command line.** A session's HTTP
  MCP servers ride the first control message on the CLI's stdin, their headers beside their URLs. Each
  server's tools are asked about before every call.
- **The model route and identity are beneath the floor.** `QWEN_*` (the CLI's home, runtime
  directory, settings files, relaunch and safe-mode switches, sign-in, model and prompt files),
  `OPENAI_MODEL`, `GEMINI_*`, `GOOGLE_API_KEY`, `GOOGLE_MODEL`, `GOOGLE_CLOUD_PROJECT`,
  `GOOGLE_CLOUD_LOCATION`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_APPLICATION_CREDENTIALS`,
  `DASHSCOPE_*`, `BAILIAN_*` and `OPENROUTER_API_KEY` are in `EXTRA_ENV_FLOOR`, so no controller can
  move a Qwen Code session's home, settings, model server or credential.
- **The shell on Windows is `cmd.exe`.** Unless the host was started from Git Bash, or with `ComSpec`
  naming PowerShell, the CLI runs the agent's commands through `cmd.exe`. The local gate reads each
  command in `cmd`'s grammar and as POSIX, and refuses when either reading refuses; the decision
  request names the dialect to a controller that reads protocol 17.
- **A pinned CLI.** The host runs one Qwen Code release (`QWEN_PINNED_VERSION`), checks its
  `--version`, and lists any other version unavailable. It never installs or updates Qwen Code, and it
  never runs a batch file.

## pi sessions

pi is offered only when you set `PERISCOPE_PI_BIN` and `PERISCOPE_PI_HOME`
([configuration](docs/configuration.md#pi)). pi has no permission system of its own; a pi session is
gated by an extension of periscope's, which asks the same gate as a Claude call (the local refusals
above, then your controller) about every tool call before it runs. Its control tier is
`intercepted`, and the hello says so ([gate.md](docs/gate.md), the pi gate). What holds, and what
does not:

- **Only periscope's code is loaded, and the host checks.** pi starts with its own discovery of
  extensions and skills off and the workspace untrusted, so a repository's `.pi/extensions`,
  `.pi/settings.json` (which could choose the shell pi runs) and `.pi/mcp.json` are not read; it loads
  pi's built-in MCP extension and periscope's, named by path. No prompt is written until periscope's
  extension has said hello over the session's channel; one that does not, or that pi will not load,
  refuses the open `pi-extension-not-active`. At the open the host holds every tool, command and MCP
  server pi lists to those sources, and names anything else `gate-foreign-extension`, lowering the
  session's tier to `intercepted-with-residual`.
- **An extension that registers nothing is invisible to that check.** The check sees an extension by
  the tools, commands and servers it registers. One that registers none of them would not be seen;
  under the launch rule nothing of pi's own finding loads, so such code would have to come from a
  changed pi or a changed launch, not from the workspace.
- **Every call is decided, and the decision is the last word.** pi runs its built-in extensions'
  handlers before the ones it was handed, so periscope's handler is the last a call meets: the input
  it decides is the input that runs. A deny, the extension's own deadline, an interrupt, a reply that
  does not verify, or anything the handler throws blocks the call. An allow may rewrite the input,
  which pi runs without validating it again, as a Claude session does; pi's own transcript keeps the
  input the model wrote. pi's `bash` command, which runs a command outside any tool call, is refused.
- **The whole pi home is protected.** `PERISCOPE_PI_HOME` holds pi's agent home (your sign-in and the
  endpoints' keys), the session store and each session's run directory (the channel's token and the
  MCP servers' tickets), and all of it is in the protected set, named literally, through a
  home-directory form or through `PI_CODING_AGENT_DIR`, which pi's shell inherits: the session store
  is shared by every pi session, and a session that could read it could read another's conversation.
  One way in stays: pi sets `PI_SESSION_FILE` in its own shell on every command, naming the session's
  own file in that store, and this host never sees its value, so `cat "$PI_SESSION_FILE"` reads the
  session's own conversation. pi's `read` tool has no limit of its own; the protected set and the
  write jail are what bound it. Your own `~/.pi/agent/auth.json`, `mcp-auth.json` and
  `models.json` are protected on every host.
- **The extension's configuration never reaches the agent's shell.** It is a file only the runner can
  read, named by `PERISCOPE_PI_EXTENSION_CONFIG`; the extension takes that variable out of pi's
  environment before any command runs, and the host deletes the file once the hello arrives. A tool
  server's headers ride that file, written so pi neither expands a `$` in them nor runs one starting
  `!` as a command; they are never in pi's environment or on its command line.
- **An endpoint's key is written once, outside the environment.** An endpoint you declared for pi is
  written into the agent home's `models.json` as a provider, its key in that file alone. Its own
  variables, if it has any, are set in pi's environment, which every command the agent runs inherits,
  and a session opened on it names them, never their values, as `gate-credential-in-shell`, at the
  tier `intercepted-with-residual`.
- **pi's MCP client cannot be told a server has no sign-in.** A server that answers 401 is marked as
  needing a sign-in, and its tools are not listed until one happens; a ticket a server refuses leaves
  the session without that server's tools rather than with another route to them. A token such a
  sign-in writes is kept in the agent home's `mcp-auth.json`, inside the protected base.
- **The shell on Windows is Git Bash, and without it can be WSL's.** pi runs its `bash` tool through
  Git for Windows at its default path, and without it through the first `bash.exe` on `PATH`, which
  can be WSL's. A command run in WSL names your files under `/mnt/c/...`, a spelling the protected set,
  written in Windows paths, does not match. Install Git for Windows at its default path on a Windows
  runner.
- **The model route and identity are beneath the floor.** `PI_*` (pi's agent home, sessions store,
  package directory, telemetry and network switches), `PERISCOPE_PI_EXTENSION_CONFIG`, and the
  provider names pi reads beside them (`DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`,
  `XAI_API_KEY`, `HF_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GOOGLE_CLOUD_API_KEY` and the rest, and the
  families `AWS_*`, `AZURE_OPENAI_*`, `CLOUDFLARE_*`, `MINIMAX_*`, `XIAOMI_*` and `ZAI_*`) are in
  `EXTRA_ENV_FLOOR`, so no controller can move a pi session's home, its extension's configuration,
  its model server or its credential.
- **A pinned CLI, quiet at start.** The host runs one pi release (`PI_PINNED_VERSION`), checks its
  `--version`, and lists any other version unavailable. It never installs or updates pi, never runs a
  batch file, and starts pi with its version check and telemetry off.

## The outbound-only posture

There is no inbound port anywhere in this package. Periscope dials out to your controller over a
single WebSocket and keeps it alive. Nothing can connect _to_ it, which is what lets it run on a
machine behind a firewall that would never allow a listener.

One exception, and it is bounded: during an interactive sign-in a loopback listener binds
`127.0.0.1` explicitly, accepts exactly one callback, and times out. Because the agent shares this
host's OS user, any local process could reach that listener, so `state` is verified on every
callback, always. PKCE protects the code exchange; `state` protects the callback. They are not
substitutes for each other.

## Pairing and revocation

The credential a running host presents is, in the shipped configuration, a **paired bearer**: an
string shaped `p1.<hostId>.<secret>` minted by your controller when a signed-in user redeems a
short-lived pair code (`periscope pair <code>`); the shape is the contract, because the host reads
its own id out of it. A controller should keep only a hash of the secret, so that this machine
holds the one copy, in `paired-credential.json` under the config directory (`~/.periscope`
or `PERISCOPE_CONFIG_DIR`), written `0600` and verified after the write. It has no expiry and no
rotation schedule. On POSIX the mode is enforced and a wider file is refused; on Windows the mode is
not real (fact 1 above), the host reports `write-bit-only` or `unobservable`, and the file's only
protections are the gate's credential-path denial, your controller, and your OS account.

Revocation is the controller's, per machine: it refuses the bearer at the upgrade (401 or 403) and
closes the link, and the host reads that refusal as `link-unauthorized`, which is terminal: it exits
non-zero naming the remedy. Rotation is re-pairing: mint a new code, run `periscope pair` again, and
a controller should invalidate the old bearer when the new one is issued. Nothing in this package
rotates the bearer on its own, and a copied bearer works from any machine until it is revoked.

The signed-in alternative (`periscope login`) presents a real user's own access token: nothing about
the provider is baked in, its revocation is the provider's, and a wrong identity configuration refuses
to start rather than authenticating as nobody. A provider may let its refresh token lapse after a
period of inactivity, which is why the paired bearer is the shipped default for an unattended host.

### What a paired controller can reach on this machine

Pairing extends trust, and this is its exact extent. A controller holding this host's bearer can,
over the link and without a further credential:

- **Run a command on this machine at session start.** `session_new.request.mcpServers` is passed
  to the agent as declared; a stdio server declaration (`{ type: 'stdio', command, args }`) is a
  process the CLI spawns as this host's OS user, before the gate sees a single tool call. The host
  screens the shape of the declaration, not what the command does.
- **Set the agent's environment, only where you declared it.** `session_new.request.env.extraEnv`
  sets variables in the spawn environment after the allow-list has run, and `extraAllowedKeys`
  re-admits keys of this host's own environment by name (the credential-shaped deny list still
  wins there); the host-session markers are stripped after both. A key reaches the agent by either
  lane only when you declared it (`PERISCOPE_CONTROLLER_ENV_KEYS`, or
  `PeriscopeHostOptions.controllerEnvKeys`), and nothing is declared by default, so out of the box
  a controller adds nothing to the agent's environment. The declaration is yours: a controller
  cannot write it over the link. Beneath the floor no declaration reaches: `PATH`, `NODE_OPTIONS`,
  `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`,
  `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_API_KEY`, Codex's home, model route, credentials and certificate authority (the eight
  names [Codex sessions](#codex-sessions) lists), Qwen Code's own variables and the model routes it
  reads (the names [Qwen Code sessions](#qwen-code-sessions) lists), pi's own variables, its
  extension's configuration and the model routes it reads (the names [pi sessions](#pi-sessions)
  lists), and the families `ANTHROPIC_*` (the model endpoint, its tokens and headers,
  every provider's base URL), `CLAUDE_CODE_USE_*` (the provider switches),
  `CLAUDE_CODE_SKIP_*_AUTH`, `CLAUDE_CODE_CLIENT_*` (the client certificate), `SSL_CERT_*` and
  `*_PROXY` (`EXTRA_ENV_FLOOR`). So a controller cannot change which server the model call goes
  to, as whom, or through which proxy and certificate authority. A `session_new` naming an
  undeclared key, or one beneath the floor, in either lane refuses `env-key-refused` before a
  process exists, naming the keys. Declaring a name beneath the floor refuses start. An embedder may
  pass a shorter floor; the binary never does. What the host's own environment passes to a session
  is untouched by either screen: a proxy you set is still inherited.
- **Choose a model endpoint, never write one.** `session_new.request.endpoint` names one of the
  endpoints you declared (`PERISCOPE_MODEL_ENDPOINTS`), and the host then sets that endpoint's
  address, credential and model variables in the agent's environment itself, after the controller's
  lanes and never through the floor that screens them. A controller cannot add an endpoint, change
  one, or learn its address or credential: neither is on the wire, `host_configure` does not take the
  file's key, and the file and every credential file it names are in the protected set. On an
  endpoint you did not mark as Anthropic's own route, a Claude model id, or an alias the endpoint does
  not map, is refused (`model-endpoint-mismatch`), at the open and on a later switch, so a provider
  that maps Claude ids to its own model never answers as Claude.
- **Remove directories.** `workspace_release` deletes a worktree under the workspace root, and the
  controller can set that root through `host_configure` (a root change is refused only while a
  session is live or opening).
- **Read files.** Any directory listing under the repository root, and any text file there: its
  head, whatever its size, and on a link at protocol 18 its first 512 KiB a page at a time
  (`repository_list` / `repository_read`, read-only and bounded), a root the controller can re-point
  through `host_configure`; and any text file up to 512 KiB inside a workspace this host provisioned,
  a page at a time (`workspace_read`, by the workspace's key). Each door is jailed to its root and
  honours the host's protected set: a path at or beneath a protected path refuses
  `credential-path-denied` whatever the root is, on the lexical resolution and on the real path.
- **Not transcripts.** The runner does not look for, read or keep the agent's transcript files
  (`<agent home>/projects`).
- **Choose the agent's permission mode.** `session_new.request.permissionMode` and
  `session_configure` take the SDK's own vocabulary, `bypassPermissions` included. Under bypass the
  agent's allow and ask rules are off and the `PreToolUse` hook is the only control, so a controller
  that sets it is relying on its own decision endpoint entirely. A switch into bypass reaches only a
  session that was started in it.
- **Change a running session's model, thinking and effort.** Through `session_configure`. The effort
  reaches the SDK's flag settings with the one key `effortLevel` and nothing beside it, so none of
  that call's permission keys can ride along (`pins/permission-config.test.ts`).
- **Reconfigure the host.** The workspace root, the repository root, the branch scheme, the agent
  home, the plugin directories and the two controller URLs through `host_configure`, written to the
  config file; the URLs apply at the next start.
- **Start a Codex session, where you configured Codex.** Its tool calls go through the gate by
  periscope's own hook, with the residual paths named, under Codex's sandbox and approval policy for
  the permission mode the controller names, `bypassPermissions` (no sandbox) included
  ([Codex sessions](#codex-sessions)).
- **Start sessions** that run the agent with the interactive prompt replaced by the gate, and
  answer every permission decision those sessions raise; and **end** one it no longer needs
  (`session_end`): the agent's process exits, and its transcript stays where the agent CLI wrote it.

None of this is a defect to be closed: a runner that could not run a tool server, set a session's
environment or clean up its worktrees would not be a runner. It is the trust a pairing extends, so
pair a host only with a controller you would trust with all of it, and revoke the pairing when that
stops being true.

## Running in a container

- **Do not run as root.** An unattended agent running as root has the whole machine on every tool
  call, and a container built the obvious way runs as root. Periscope refuses to start as uid 0 by
  policy, before anything else runs, so this arrives as one clear line at start-up rather than as a
  session that can reach everything.
- **`exec` the process so it receives SIGTERM.** PID 1 gets no default signal dispositions, so
  without `exec` every `docker stop` is a SIGKILL that runs no cleanup path and abandons credential
  files mid-write.
- **Keep the shebang LF.** A CRLF shebang fails as _"no such file or directory"_ naming the
  interpreter rather than the line ending. `.gitattributes` pins it.

## Versions this was tested against

|                                  |                                                              |
| -------------------------------- | ------------------------------------------------------------ |
| `@anthropic-ai/claude-agent-sdk` | **0.3.284**, pinned exactly, no caret                        |
| Bundled Claude Code CLI          | **2.1.284**                                                  |
| Node                             | 22 or later, and CI runs 22 and 24 on both Linux and Windows |
| Codex app-server                 | **0.162.1**, pinned; any other version is listed unavailable |
| Qwen Code CLI                    | **0.25.1**, pinned; any other version is listed unavailable  |
| pi                               | **1.2.0**, pinned; any other version is listed unavailable   |

The SDK is pre-1.0 and its surface moves without semver protection, so a SHA-256 of the installed
type definitions is kept in `contracts/sdk.sha256` and a CI job fails on any drift between the installed
types and that baseline; the SDK's own files are not redistributed. A bump cannot land without someone
reading what changed.

## Supported versions

The latest minor of the current major receives fixes; older minors do not. The wire protocol has
its own window, stated in [the wire protocol](docs/protocol.md): a controller and a host one
protocol release apart connect. `periscope version` prints the running version.

## Reporting a vulnerability

Report it through the repository's private security advisory form (GitHub Security Advisories:
<https://github.com/naswerks/periscope/security/advisories/new>) rather than a public issue. If you
are unsure whether something is a vulnerability, report it anyway: a false alarm costs a reply, and
the alternative costs more.

Please include the version (`periscope version`), the operating system, and what you observed. A
reproduction is welcome but not required; a clear description of the mechanism is worth more than a
script that only runs on your machine.

Expect an acknowledgement within seven days. A confirmed report is fixed in a release before it is
described publicly, with credit to the reporter unless they ask otherwise; a report that turns out
not to be a vulnerability gets an explanation of why.
