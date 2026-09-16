# Security

Periscope runs Claude Code sessions on your machine on behalf of a remote controller. That is a
serious thing to install, and this document is written to be read _before_ you do. It states the
posture, what each control covers, and what it does not.

## The permission model

Periscope runs the agent headless under the Agent SDK, so there is no interactive prompt. It does
not pass `--dangerously-skip-permissions` and sets no permission mode; it registers a `PreToolUse`
hook on every session, and that hook is the only path to a yes: the host turns `grantOnAllow` on
for every session it opens, so the hook's allow is what lets a tool run and its deny, or its
silence, is what stops one. Read on its own that looks like the safety being switched off. It is
the opposite: the interactive prompt is replaced by a stricter gate, not removed.

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
push, a force, a remote change, a branch deletion, a merge) is recognised locally but escalated to
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

The local gate matches on tool name, in three families (`DEFAULT_TOOL_FAMILIES`): writes are `Write`,
`Edit`, `MultiEdit`, `NotebookEdit`; reads are `Read`, `NotebookRead`; shells are `Bash`,
`PowerShell`. An MCP tool
arrives as `mcp__{server}__{tool}`, matches nothing, and gets no local opinion, so the decision
escalates to your controller. That is fail-closed and correct.

The same fall-through applies to built-in tools the families do not name, and that scopes the
credential-path denial itself. The default read family is `Read`/`NotebookRead` only, so built-in
`Grep` and `Glob`, both read primitives, get no local opinion and escalate; the gate's own suite
pins that deliberately (`local.test.ts`, _"a tool outside every declared family gets no local
opinion"_, with `Grep` as the example). The shell scan matches a protected path written literally,
so expansion forms (`~`, `$HOME`, `%USERPROFILE%`) and symlink indirection escalate too. What this
means for fact 1's picture: offline, every one of those escalations is refused as an outage, which
is still fail-closed, a narrower control than a by-name denial rather than an open door; online, for
exactly those vectors, what stands between the agent and the token cache is your controller, not
this gate. Widening the local denial to cover them is a known open question, deliberately left open
rather than closed in passing: a `Grep` refused for carrying no path at all is the kind of
over-refusal a widening has to weigh, and that deserves its own decision.

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

> Three residuals.
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
- **Set the agent's environment.** `session_new.request.env.extraEnv` sets any variable in the
  spawn environment after the allow-list has run, `PATH` and `NODE_OPTIONS` included, and
  `extraAllowedKeys` re-admits keys of this host's own environment by name (the credential-shaped
  deny list still wins there); only the host-session markers are stripped after it.
- **Remove directories.** `workspace_release` deletes a worktree under the workspace root, and the
  controller can set that root through `host_configure` (a root change is refused only while a
  session is live or opening).
- **Read files.** Every transcript under the agent home (`<agent home>/projects`, by default
  `~/.claude/projects`), which includes sessions the operator ran from an editor or a terminal,
  not only sessions this host started; and any directory listing or text-file head under the
  repository root (`repository_list` / `repository_read`, read-only and bounded), a root the
  controller can re-point through `host_configure`. Both doors are jailed to their root, and the
  repository doors also honour the host's protected set: a path at or beneath a credential
  directory refuses `credential-path-denied` whatever the root is, on the lexical resolution and
  on the real path.
- **Reconfigure the host.** The workspace root, the repository root, the branch scheme, the agent
  home and the two controller URLs through `host_configure`, written to the config file; the URLs
  apply at the next start.
- **Start sessions** that run the agent with the interactive prompt replaced by the gate, and
  answer every permission decision those sessions raise.

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
| `@anthropic-ai/claude-agent-sdk` | **0.3.220**, pinned exactly, no caret                        |
| Bundled Claude Code CLI          | **2.1.220**                                                  |
| Node                             | 22 or later, and CI runs 22 and 24 on both Linux and Windows |

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
