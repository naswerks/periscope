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

Every Claude session is started refusing messages another session on this machine sends it
(`crossSessionInbound: 'refuse'`, the one setting the host composes, which no controller can change).
Left unset, the CLI delivers such a message when the two sessions' permission modes match, so a
bypass-mode session the operator runs elsewhere on the machine could reach a session this host runs in
bypass. The host's own prompts arrive on the agent's input and are not that lane. What the setting is
and that every session carries it is held by this package's tests; what the CLI then does with a
message that names another session is the live probe's to show
(`src/host/mid-turn-delivery.live.test.ts`), which needs a sign-in and runs with a release's live
probes, so it is not stated here as measured.

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
can never turn a "no" into a "yes". It refuses, locally and immediately: a write outside every place
the session may write (its own workspace, the temp folder this host's environment names, and its own
worktree of each further repository it named), a read of the credential set, and a git invocation whose
verb is not on the allow-list, by parsing the command rather than by matching strings. A temp folder a
controller places in a session's environment is never one of those places.

Claude is not given a further worktree as a working directory, because the Claude CLI reads plugin and
marketplace settings from any directory it is given. Its writes there are allowed by the gate, and the
path is in the session's environment (`PERISCOPE_WORKTREE_<NAME>`).

Two of those places are shared with something else, and that is stated rather than hidden. The temp
folder is shared by every session on the machine, so a session can read another's scratch files; the
protected set is what keeps credentials out of it, and a temp folder that would cover the home
directory, a protected path, a workspace or a repository checkout is no place to write at all. A
further worktree shares its repository's one `.git`, so a session holding one can read every branch
of that repository; that is why every `config` write stays refused (`core.hooksPath` or
`core.sshCommand` in the shared `.git/config` would run code in every worktree), and why the
operator's checkout of every served repository, and every other session's worktree, is never a place
a session may write. A boundary-crossing shape (a
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

The local gate matches on tool name, in five families (`DEFAULT_TOOL_FAMILIES`): writes are `Write`,
`Edit`, `MultiEdit`, `NotebookEdit`; reads are `Read`, `NotebookRead`; searches are `Grep`, `Glob`;
shells are `Bash`, `PowerShell`, `Monitor` (a `Monitor` call that watches a socket runs no command and
is no shell call; it reaches your controller as `web`, and no other tool's call is read that way);
and `Artifact` publishes. A publishing tool hands a service the local files its input names and saves
the files it fetches (`file_path`, each of `file_paths`, each source in `files`, `root`, `out_dir`):
each of those paths is held to the protected set and to nothing else, so it may read and save anywhere
a read may go, and a call naming none has no local opinion. Whether the content may leave the machine
is your controller's decision, as for every call. An
MCP tool arrives as `mcp__{server}__{tool}`, matches nothing, and
gets no local opinion, so the decision escalates to your controller. That is fail-closed and correct.

Within the families the credential-path denial is scoped, and the scope is what to review. Writes
are jailed to the session's workspace. Reads are not jailed: a read goes anywhere this host's OS user
can read, the agent's own tool output and installed packages included, and the protected set is what
stops it. A search is refused when its root (`path`, else the workspace) is at or beneath a protected
path, and also when a protected path sits beneath its root, because the search would read it. Each
path a tool names is placed first, where the operating system puts it for a tool running in the call's
directory, so the file the gate judges is the file the tool opens: on Windows a path with one leading
separator starts at the drive the call runs on and `C:name` on that drive is beneath the call's
directory, and on every system `~` is the home directory. A drive-relative path on another drive and
another user's home (`~name/...`) cannot be placed and are refused `path-unplaceable`. The
shell scan matches a protected path written literally, through a home-directory form (`~`, `$HOME`,
`${HOME}`, `$env:HOME`, `$env:USERPROFILE`, their braced `${env:...}` spellings, `%USERPROFILE%`),
or through a variable of the session's spawn environment whose value is one absolute path, spelled
`$NAME`, `${NAME}`, `$env:NAME`, `${env:NAME}` or `%NAME%`. Those variables are the ones each runtime
is started with: the homes this host sets (`CODEX_HOME`, `QWEN_HOME`, `QWEN_CODE_SYSTEM_SETTINGS_PATH`,
`PI_CODING_AGENT_DIR` and their kin) and the ones it passes through (`USERPROFILE`, `APPDATA`,
`CLAUDE_CONFIG_DIR` when you set it). A name is read as each shell reads it, PowerShell's and `cmd`'s
without regard to case and a POSIX shell's exactly, and every comparison folds case. A command that
only shows such a variable is refused like one that mentions the path itself:
`echo "$PI_CODING_AGENT_DIR"` is, since the whole pi home is protected.

Windows names one file several ways, and a read, a write, a patch and a search are checked under each
the gate can read. A device prefix (`\\?\C:\...`, `\\.\C:\...`) is the drive path after it, and so is
the NT namespace prefix (`\??\C:\...`), which Copilot's own file tools open (measured on the pinned
runtime: before this was read, a protected file was read through it). A share that
names this machine's own drive (`\\localhost\C$\...`, a loopback address, the machine's host name or
`COMPUTERNAME`) is that drive's path. The dots and spaces that end a name, and a stream named after a
colon (`id_rsa.`, `id_rsa::$DATA`), are folded away before the protected set is compared, as case is. A
path with a segment shaped like a generated short name (`CREDEN~1.JSO`) is compared as written and as
the file system says it is named. A rooted path whose first segment is one letter (`/c/Users/x`,
`/cygdrive/c/Users/x`) has two readings on Windows, the folder `c` at the root of the drive and the
drive that letter names, which is how Git Bash, Cygwin and the agent CLI's own tools read it; the
protected set is compared with both. A device or volume form that maps to no drive path
(`\\?\Volume{...}\`, `\\?\GLOBALROOT\...`, and the same after `\??\`) is refused `path-unplaceable`.

What falls through a read, a write, a patch or a search:

- symlink indirection, a junction included: the gate resolves a path as text and follows no link,
  except on a path it asks the file system about for a short name;
- a short name set by hand that has no generated shape (no `~` and digit);
- a share that reaches this machine by a name the host cannot know as its own (an alias, an address of
  one of its network cards), or a share an administrator made of a folder.

The shell scan reads a command as text, so of the spellings above it matches one only where the command
still contains the protected path as written: a device prefix or the NT namespace prefix before it, or a
dot or a stream name after it. It also matches a protected path on a drive written from the root, as a POSIX shell on Windows
writes it: `/c/Users/x` (Git Bash), `/cygdrive/c/Users/x` (Cygwin) and `/mnt/c/Users/x` (the Linux
subsystem). A dot or a space inside the path, a share of this machine's drive and a short name are not
matched in a command. What also falls through is a shell command that reaches a protected path without naming
it:

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
cache is your controller, not this gate. Closing them is a known open question: following every link
needs the filesystem on every check, which the gate consults only for a short name, and a computed
path cannot be read from a command's text.

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
> That paragraph is the documentation's. What the runtime does is measured by a probe in
> `gate.live.test.ts` (an operator deny rule is applied before any hook is asked). On Claude Code
> 2.1.325 a deny rule is applied before the hook is asked at all: a rule that names the whole tool
> takes the tool from the model, and a rule that names a path refuses the call with `PreToolUse`
> never firing, so a hook that allows everything overrode neither. A call your deny rule refuses
> therefore never reaches the gate, and your controller is asked nothing about it. A run in which the
> model called another tool, or none where a call was due, measured nothing and is reported as
> skipped; run the probe on a machine that is not itself an agent session.

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
  tool of the pinned release and every attached MCP server, with every hook off, and denies the one
  tool this host turns off: `autofix_pr`, whose pull-request helpers push a branch or post a reply under
  a decision request that names only the tool and a helper, which no reading of a command recognises as
  a push (a deny outranks every scope's rules, and the tool is then never offered). It also keeps code
  mode off, so the CLI never registers `exec`, whose script makes tool calls of its own. The host reads it
  back through the environment the CLI will start with before anything runs, and an open whose file
  does not read back that way is refused `qwen-ask-rules-not-active`. The file read back is the one
  the host wrote; what the CLI registered is read from the first list of tools it sends, and a tool the
  settings turn off that is listed all the same (`autofix_pr`, or `exec`) is named by the same reason on
  the session's state lane, the session going on, and a call to `autofix_pr` is refused before anyone
  is asked. `QWEN_CODE_SAFE_MODE`, which
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
  which pi runs without validating it again, as a Claude session does; pi's own session record keeps
  the input the model wrote. pi's `bash` command, which runs a command outside any tool call, is refused.
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
- **On Windows a program the agent's shell started can outlive the session.** Closing a session ends
  pi, and the shells pi still runs end with it. What ends a process tree on Windows walks the process
  table from parent to child, and pi's shell there is Git for Windows: measured on the pinned pi, a
  program that shell started was not under it in the table, its parent there a process already gone.
  So a command the shell put in the background and left (`some-command &`), and the program a command
  still running at the close was in the middle of, were both running after the close, until they
  ended by themselves. Nothing this host can walk reaches either. Every shell call is asked about
  before it runs, so a command that must not outlive its session is your controller's to refuse.

## Copilot sessions

Copilot is offered only when you set `PERISCOPE_COPILOT_SDK` and `PERISCOPE_COPILOT_HOME`
([configuration](docs/configuration.md#copilot)). Each session's runtime is started through the GitHub
Copilot SDK you installed, and its gate joins the runtime's two halves: its pre-tool hook answers `ask`
for every call, and the permission request that raises asks the same gate as a Claude call (the local
refusals above, then your controller). Its control tier is `intercepted-with-residual`, and the hello
says so ([gate.md](docs/gate.md), the Copilot gate). What holds, and what does not:

- **The SDK and its runtime are yours, not this package's.** periscope never installs `@github/copilot-sdk`
  and never depends on it; you install the pinned version into a directory of the runner's own, and
  the runtime it carries is a closed binary under the GitHub Copilot CLI License. The host checks the
  install's versions and files at start, starts the runtime by its path inside that install, and lists
  any other install unavailable. The whole directory is in the protected set, so a session cannot
  replace the runtime the next one starts.
- **No credential is in the runtime's environment.** The runtime hands its whole environment to every
  command the agent runs, so the host strips `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`,
  `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST` and every `COPILOT_` variable from it. Your GitHub token is read from
  `PERISCOPE_COPILOT_TOKEN_FILE` when the runtime asks for one, and handed over the SDK's own pipe; an
  endpoint's key rides the session's request the same way. Neither is ever on a command line.
- **Nothing of yours is what a session runs from.** Each session's runtime runs in a fresh home of its
  own under `PERISCOPE_COPILOT_HOME`, signed in as nobody until the token is handed over, with config
  discovery and custom instructions off, so your `~/.copilot` (its sign-in, its settings, its sessions)
  and a repository's own Copilot configuration are never read. Your `~/.copilot` and `COPILOT_HOME`, and
  the whole runner base, are in the protected set.
- **Proven before the first prompt.** The host reads the runtime back (the `manual` permission mode, the
  agent mode asked for, no approve-all grant, no approved path, no plugin, none of the tools it turns
  off) and runs one probe call through the hook and the request. A runtime that is not as the host
  started it refuses the open `copilot-gate-not-active`.
- **The runtime's own list of directories bounds no write.** The runtime allows its temp folder by
  itself, whatever it was asked. What holds a write is this host: the hook asks about every call, and
  the host's own gate holds a write to the session's write limits. So a directory the runtime allows
  that is none of the session's is named `gate-mode-widened` when the session opens, and the session
  opens. It was a reason to refuse the open, and a session whose temp folder is no write root of its
  own (one that covers its own directory, its home or a protected path) did not open at all.
- **The hook fails open; the gate does not depend on it alone.** A pre-tool hook that throws or times
  out lets a call proceed in the runtime. The host's hook does no I/O and answers at once. The host
  keeps what it answered for each call until that call finishes, and names `gate-hook-missing` a call
  that finished with no decision behind it: none at all, one the host was still waiting on, or a refusal
  the call ran against. A request the hook did not raise, and a hook the runtime reports as failed, are
  named the same way. A permission request this host did not raise through the hook is refused, never
  decided. What the naming cannot tell apart is two calls running at once under one call id, which a
  model's provider would have to hand out twice in the same turn; an id handed out again later is a new
  call.
- **What no hook sees is named.** A tool the model's provider runs itself is named
  `gate-unhooked-call`; a machine-wide policy hook, which runs whatever a session's settings say, is
  named `gate-hook-foreign` at the open; a permission or agent mode the host did not set is named
  `gate-mode-widened`. The look for a policy hook has two parts. On every platform the runtime is asked
  which hooks it finds and what the machine's managed settings hold, before the session is made. On
  Windows the host also reads the two places it knows one sits (`policy.d` under
  `%ProgramData%\GitHub\Copilot` and under `C:\ProgramData\GitHub\Copilot`, and the
  `HKLM\Software\Policies\GitHub\Copilot` key); off Windows it knows no such place, so the runtime's
  own answer is the whole look there. A source that could not be read (a key, a directory, a document
  the runtime could not load, a call it did not answer) is named the same way, as one that may hold a
  hook, and is never counted as holding none. The session opens either way. The runtime's answer was
  measured on the pinned runtime with no policy on the machine; a policy hook in it was not, since
  planting one means writing the machine's own policy.
- **A built-in the host does not know is named, not refused.** The session is offered every built-in
  the runtime has, less the three turned off. One the host's tables do not name has no kind but `other`
  and no local family, so neither the write limits nor the protected set read its input: what bounds it
  is your controller's decision, which every call of it still waits for. The host names it
  `gate-tool-unnamed` when the session opens, or at its first call. Two the tables do name act on more
  than their input says: `dynamic_workflows_manage` writes a workflow's code into the session's own
  extension and loads it, and `run_dynamic_workflow` runs one. Both are kind `other`, and both ask.
- **Three tools are turned off.** `write_powershell` and `write_bash`, which type into a shell already
  running, and `manage_schedule`, which runs a prompt later outside your queue, are never offered, and a
  call of one is refused.
- **No call runs unasked while a session closes.** The close ends the turn and its background sub-agents
  before it disconnects the session, while the hook still has its route, so a call that arrives as the
  turn winds down is asked and refused. A turn that will not end is not disconnected while it runs: its
  process tree is ended first.
- **A command detached on purpose outlives the session, and so does what a crashed runtime left.**
  Closing a session ends its runtime and every command its shell still runs. A command the agent
  detaches from its shell (on Windows, `Start-Process`) is in no process tree of the session, and keeps
  running. A runtime that exits on its own, a crash, leaves whatever it had started: its process id is
  gone, and may already be another process's, so the host ends no tree by it and says so on the
  session.
- **A keyring entry is not a file.** If you ran `copilot login` yourself on the runner, the token it
  stored in the Windows Credential Manager is outside the protected set, which holds files: a session's
  runtime never reads or writes the keyring, but a command the agent runs, as your user, can. Sign the
  runner's Copilot sessions in with `PERISCOPE_COPILOT_TOKEN_FILE` instead, and remove that entry.
- **No controller moves a session's route or its identity.** `COPILOT_*` is in `EXTRA_ENV_FLOOR`, so no
  controller can move a Copilot session's home, swap its runtime or hand it a credential. The host a
  sign-in is for is held twice: `GH_HOST` is taken out of the runtime's environment whoever set it, as
  the GitHub token variables are, and your token is given for `github.com` alone. Asked for a token for
  any other host, the host gives none, never reads the file, and says on the session which host asked.
  `GH_HOST` is not beneath the floor: a controller you let set it can still set it for another
  runtime's session, where only a command the agent runs reads it.

## opencode sessions

opencode is offered only when you set `PERISCOPE_OPENCODE_SDK` and `PERISCOPE_OPENCODE_HOME`
([configuration](docs/configuration.md#opencode)), and only on Node 24 or later. Each session's server runs
in a host process of its own, from the opencode SDK you installed, and its gate writes the rules the
session runs under: every action asks, and every request that raises asks the same gate as a Claude call
(the local refusals above, then your controller). Its control tier is `intercepted-with-residual`, and the
hello says so ([gate.md](docs/gate.md), the opencode gate). What holds, and what does not:

- **The SDK is yours, not this package's.** periscope never installs `@opencode/sdk` and never depends on
  it; you install the pinned version into a directory of the runner's own. The host checks the install's
  versions and files at start, loads it by its path inside that install, and lists any other install
  unavailable. The whole directory is in the protected set: a write, a patch or a search that names it
  is refused, and so is a shell line that names it, before it runs. A shell line that builds the path
  at run time names nothing the host can read, and is your controller's to refuse (below), so what
  keeps a session from replacing the server the next one runs is the two together, not the protected
  set alone.
- **No port.** The SDK hosts opencode's server in the process that loads it, so each session's server runs
  in a host process this package starts, spoken to over its stdio alone; it opens no listener. opencode's
  process daemon, which runs the shell's commands, accepts its owner over a Unix socket or a named pipe
  registered under the session's home, with a token, and opens no port either.
- **No credential is in an environment.** An endpoint's key is read when the session opens and crosses
  into the host process with the session's configuration, over its stdin, so it is never in an
  environment, a file or a command line. The host process's environment is written whole, and so is the
  agent's shell's: neither holds an `OPENCODE_` variable of yours, `NODE_OPTIONS`, or any variable of
  this host's but the further worktrees' paths.
- **Nothing of yours is what a session runs from.** Each session's server runs in a fresh home of its own
  under `PERISCOPE_OPENCODE_HOME`, with project configuration and the `.claude` folder off and its model
  catalogue never fetched (each by an option the server is created with), no update looked for (by the
  session's configuration) and opencode's own hosted models never offered (by the one environment
  switch the pinned SDK reads, `OPENCODE_DISABLE_FREE_MODELS`), so your opencode directories
  (their sign-ins, their settings, their sessions) and a repository's own opencode configuration are
  never read. Your opencode directories, opencode's machine-wide directory (which every opencode process
  reads and no setting turns off), and the whole runner base are in the protected set.
- **One provider.** A session's configuration allows no model provider but the endpoint it opened on, and
  the open is refused if the server offers a model of any other.
- **No reference in the configuration is followed.** opencode follows two references in its
  configuration's text, before it parses it and wherever they stand: `{env:NAME}` becomes a variable of
  the host process's, and `{file:path}` the content of any file the host process can read. What your
  controller hands a session's MCP servers (a URL, a header, an argument, a variable) is in that text,
  so a `{file:…}` in a header would have sent a file's content to the server the header goes to:
  measured on the pinned SDK. The host writes the text so that it holds neither reference (the opening
  brace of each as its JSON escape), and the server parses every value back exactly as your controller
  wrote it. Shown on the pinned SDK: the header reaches the MCP server as written.
- **Proven before the first prompt.** The host reads the server back (the session's rules, every agent's,
  no saved approval, only the runtime's own plugins, the host's own pre-call gate and none it turns off,
  only the session's MCP servers, no configuration but its own, no model but the endpoint's). A server
  that is not as the host created it refuses the open `opencode-gate-not-active`.
- **A shell call is decided before it runs, whole.** opencode's `shell` tool asks only about the
  commands its own reading finds in a line, and a line it finds none in raises no request at all: on
  Windows, where the shell is PowerShell, an assignment through a provider path
  (`${C:\path\file} = 'x'`) is such a line, and it writes a file. So the server is created with one
  plugin of this host's, whose pre-call hook holds every `shell` call, a subagent's included, until the
  host has decided the whole line (its own gate, then your controller); refused, the call fails with
  the refusal's words and never runs. Shown on the pinned SDK on Windows: such a line, refused, writes
  nothing. What a shell line can still do is what any shell line can: the host's own gate refuses a
  line that names a protected path, and reads a path only as text, so a line that builds a path at run
  time (from a variable, a substitution, an encoded string) is your controller's to refuse, and the
  controller is shown the whole line.
- **What runs undecided is named.** A tool the model's provider runs itself is named `gate-unhooked-call`;
  a call the server began with no decision of the host's behind it, `gate-hook-missing`, whether it
  succeeded, failed, was interrupted or was still running at the close (the same name says, at the open,
  that the host's pre-call gate is not among the server's plugins); rules that are no longer this host's, or an
  approval it never gave, `gate-mode-widened`; a plugin that is neither the runtime's own nor the host's
  gate, loaded after the open, `gate-foreign-extension`.
- **Tools that cannot be decided are turned off.** Code Mode's `execute`, `question`, image generation,
  the browser, and the session, worktree, model-catalogue, artifact and schedule tools that run without
  asking are denied in every session's rules, never offered, and a request naming one is refused. A form
  the server raises (a web search's provider choice, an MCP server's request for input) is cancelled.
- **A `webfetch` follows redirects.** The decision is about the URL asked for; opencode follows each
  redirect a site sends without asking again.
- **A workspace's `.opencode` and `.agents` folders are not protected.** The server never loads them,
  since project configuration is off, but a session may write there.
- **The runtime's route is beneath the floor.** `OPENCODE_*` is in `EXTRA_ENV_FLOOR`, so no controller can
  hand a session opencode's configuration, the program its terminals run through, or a credential.

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
  `ANTHROPIC_API_KEY`, the agent CLI's session-service credentials and remote route
  (`CLAUDE_CODE_SESSIONS_OAUTH_TOKEN`, `CLAUDE_BG_SESSION_CREDENTIAL`, `CLAUDE_CODE_REMOTE_SDK_URL`),
  its switch that lets dangerous `rm` commands run without a prompt in bypass mode
  (`CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS`), its switches that each turn off one check it
  guards a deletion or a command with (`CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT`,
  `CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT`, `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT`,
  `CLAUDE_CODE_DISABLE_POWERSHELL_CMD_RM_DENY`, `CLAUDE_CODE_DISABLE_EXPORTED_VARIABLE_PROMPT`), its
  switches that answer a workspace trust check or turn one off (`CLAUDE_CODE_SANDBOXED`,
  `CLAUDE_BG_WORKSPACE_TRUSTED`, `CLAUDE_CODE_DISABLE_ULTRAREVIEW_TRUST_CHECK`), the permission rules it
  takes from a background session's environment (`CLAUDE_BG_SESSION_PERMISSION_RULES`), Codex's home, model route, credentials and certificate authority (the eight
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
- **Remove directories.** `workspace_release` deletes a worktree under the workspace root, of the home
  repository or of any further repository the host serves, and the controller can set that root
  through `host_configure` (a root change is refused only while a session is live or opening).
- **Place a session's writes in every repository the host serves.** A `session_new` naming a further
  repository gets its own worktree of it, where the session's tools may write and commit; and the
  controller can set the list of repositories through `host_configure` (`PERISCOPE_REPOSITORY_ROOTS`,
  refused while a session is live or opening). The operator's checkout of each is never written.
- **Read files.** Any directory listing under the repository root, and any text file there: its
  head, whatever its size, and its first 512 KiB a page at a time (`repository_list` /
  `repository_read`, read-only and bounded), a root the controller can re-point through
  `host_configure`; and any text file up to 512 KiB inside a workspace this host provisioned, a page
  at a time (`workspace_read`, by the workspace's key). Each door is jailed to its root and honours
  the host's protected set: a path at or beneath a protected path refuses `credential-path-denied`
  whatever the root is, on the lexical resolution and on the real path.
- **Not transcripts.** The runner does not look for, read or keep the agents' transcript files
  (Claude Code's `<agent home>/projects`; Codex's `sessions`, `archived_sessions`, `history.jsonl`
  and thread database; Qwen Code's `projects` and `tmp`; pi's `sessions`), and its read doors and
  bulk lane refuse them whatever their root (`transcripts-not-served`).
- **Choose the agent's permission mode.** `session_new.request.permissionMode` and
  `session_configure` take the SDK's own vocabulary, `bypassPermissions` included. Under bypass the
  agent's allow and ask rules are off and the `PreToolUse` hook is the only control, so a controller
  that sets it is relying on its own decision endpoint entirely. A switch into bypass reaches only a
  session that was started in it.
- **Change a running session's model, thinking and effort.** Through `session_configure`. The effort
  reaches the SDK's flag settings with the one key `effortLevel` and nothing beside it, so none of
  that call's permission keys can ride along (`pins/permission-config.test.ts`).
- **Reconfigure the host.** The workspace root, the repository root, the repositories served beside
  it, the branch scheme, the agent home, the plugin directories and the two controller URLs through
  `host_configure`, written to the
  config file; the URLs and the agent home apply at the next start (the hello names them in
  `pendingRestart` until then), so the protected set always covers the agent home the host runs with.
- **Start a Codex session, where you configured Codex.** Its tool calls go through the gate by
  periscope's own hook, with the residual paths named, under Codex's sandbox and approval policy for
  the permission mode the controller names, `bypassPermissions` (no sandbox) included
  ([Codex sessions](#codex-sessions)).
- **Start sessions** that run the agent with the interactive prompt replaced by the gate, and
  answer every permission decision those sessions raise; and **end** one it no longer needs
  (`session_end`): the agent's process exits, and its session history stays where the agent CLI wrote
  it.

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

|                                  |                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `@anthropic-ai/claude-agent-sdk` | **0.3.325**, pinned exactly, no caret                                              |
| Bundled Claude Code CLI          | **2.1.325**                                                                        |
| Node                             | 22 or later, and CI runs 22 and 24 on both Linux and Windows                       |
| Codex app-server                 | **0.169.0**, pinned; any other version is listed unavailable                       |
| Qwen Code CLI                    | **0.27.3**, pinned; any other version is listed unavailable                        |
| pi                               | **1.5.2**, pinned; any other version is listed unavailable                         |
| `@github/copilot-sdk`            | **1.0.34**, your install, pinned; any other is listed unavailable                  |
| Copilot runtime                  | **1.0.112**, the one that SDK pins                                                 |
| `@opencode/sdk`                  | **2.3.0**, your install, pinned; any other is listed unavailable; Node 24 or later |

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
