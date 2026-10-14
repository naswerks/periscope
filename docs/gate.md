# The gate

The permission mechanism: `options.hooks.PreToolUse`, fail-closed on every path, an offline local
refusal ahead of it, and a hold that makes "who is waiting on a decision" answerable. How the gate
is composed onto a session is in [architecture.md](architecture.md); how a decision travels is in
[protocol.md](protocol.md).

The invariant is absolute: no answer, any error, any timeout, any outage, any unrecognised decision
means the tool does not run. Everything downstream is designed around trusting that sentence, and
the SDK's default falsifies it: a hook handler that throws is treated by the CLI as absent, not as
a denial, so under `bypassPermissions` a bug in the gate's own code would be an open door.

## Why `PreToolUse`, never `canUseTool`

The hook fires on every tool call, MCP tools and subagent-internal calls included, carrying
`agent_id` and `agent_type`. `canUseTool` is skipped whenever a settings-file allow rule,
`options.allowedTools` or `bypassPermissions` covers the call, and those are embedder-chosen
configurations, so a hold built on `canUseTool` silently does not fire on somebody else's setup.
`Decision` is shaped as the SDK's `PermissionResult` field for field and the decider is an injected
async function, so wiring the `canUseTool` durable-hold lane later is a wiring job, not a redesign.
The SDK ships no `PermissionResultDeny` type; the deny shape is
`{ behavior: 'deny'; message: string; interrupt?: boolean }`.

## Fail-closed, in layers

- Every handler path returns an explicit `permissionDecision: 'deny'` on error. That is the
  difference between fail-closed and fail-open, not defensive style.
- A recovery path must not use the thing that broke. `readRequest` is total and returns `null`
  rather than a filled-in default: an unnameable call is not an authorizable one, so it blocks. A
  catch that re-read the hook input would throw inside the catch when reading the input is what
  threw, and the handler would escape as absent.
- A negative control against this invariant must remove every defence, or write a case only the
  outer one can satisfy. Removing one redundant defence leaves the suite green and measures the
  redundancy, not the invariant. Validate such a control by which tests go red, never by how many.
- An allow returns no opinion unless `grantOnAllow` is set (below). Without it the gate only ever
  adds a refusal, and allow output exists solely to carry `updatedInput`.

## What an explicit allow skips

The Claude Code documentation states that deny and ask rules are evaluated regardless of a hook's
allow, and that an explicit allow skips only the permission mode, the allow rules and `canUseTool`
(<https://code.claude.com/docs/en/permissions#extend-permissions-with-hooks>). The operator's deny
and ask rules survive it.

That claim is documented, not measured, and the package's standing rule is that the runtime beats
the documentation. The probe that would settle it is written in `gate.live.test.ts` (does a hook
allow override an operator deny rule) and is not exercised: run from inside an agent session it is
contaminated by the enclosing harness's tool surface, so it must be run on a machine that is not
itself an agent session. Do not upgrade the claim without that receipt.

## `grantOnAllow`

`GateTimings.grantOnAllow` defaults to false, and leaving it there gives a gate that cannot say
yes. Saying nothing leaves the agent's own permission mode as the decider, and an embedder loading
no settings files (the package default, and the only posture under which this host can state what
an agent's permissions are) has left nobody who can grant. On a real session the gate allowed a
`Write`, the tool did not run, and the model was told it had requested a permission nobody had
granted, in a host with no user to grant anything. The flag does not weaken the gate; it makes the
decision the gate already took take effect, one call at a time.

- `PeriscopeHost` sets it to true. By its own default it loads no settings files, so nothing sits
  behind the gate a grant could override.
- Setting it with `settingSources` non-empty is refused by name, `permission-grant-shadows-settings`,
  before any process exists. Not because a grant is a bypass (deny and ask survive it), but because
  two mechanisms then answer the same question from different places with no stated precedence.
  The exception is `permissionMode: 'bypassPermissions'` (`isBypassMode`): under bypass the mode
  already allows everything the grant skips, so the grant changes nothing and there is no second
  authority to shadow. A hook deny survives every mode. Every other mode keeps the refusal, and the
  refusal reaches the controller as a `spawning` to `ended` transition ([protocol.md](protocol.md),
  the refused open).
- That refusal is incomplete on its own logic, and says so: managed policy settings and
  `~/.claude.json` load regardless of `settingSources`. An empty list is not proof that no operator
  rule is live.
- The residual an embedder hits: composing by hand and leaving the flag off yields a gate whose
  every approval silently fails to happen. The first such allow raises a `gate-cannot-grant` degrade
  if `onDegrade` is passed (`composeSession` wires it from `onRefusal`, so a `PeriscopeHost` embedder
  gets it); a hand-composer who passes neither gets silence. The doc comment on the field is the
  primary defence.

## The host's own gate

`localGate` (`src/gate/local.ts`) is consulted before the decider, and that ordering is the offline
property: with the controller unreachable a locally refused call is refused immediately instead of
after `DEFAULT_DECISION_TIMEOUT_MS` reported as an outage. It is synchronous and total by contract;
an asynchronous local policy would be a second place a decision can hang.

What refuses locally, and only locally: a write that escapes the session's workspace
(`path-escapes-root`), a read, a write or a search that reaches the protected set
(`credential-path-denied`), and a git invocation whose verb is not on the allow-list. Reads are not
jailed: a read goes anywhere the host's OS user can read except the protected set. A search (`Grep`,
`Glob`) is refused when its root (`path`, else the workspace) is at or beneath a protected path and
also when a protected path sits beneath its root. The shell scan matches a protected path written
literally or through `~`, `$HOME`, `${HOME}`, `$env:HOME`, `$env:USERPROFILE` or `%USERPROFILE%`, and
every protected-path comparison folds case. A boundary-crossing shell shape (`shell-boundary-command`: a
push, a force, a remote change, a branch deletion, a hard reset, a merge) is classified locally and then
escalated like any other call, because a controller may hold it for a person to answer; refusing it
in-process would make that answer impossible to give. With the controller unreachable it refuses at
the decision deadline.

- It adds refusals and never removes one. No opinion returns `null` and the surrounding gate asks
  whoever it was going to ask. A locally-decided refusal is `refusal/<reason>`, and the fix for one
  lives with the embedder's policy.
- A throwing local gate refuses; it must not fall through (`askLocalGate` in `src/gate/call-decision.ts`).
- The vocabulary is owned locally, never received. The wire carries no policy in either direction;
  the embedder chooses tool families and protected paths at construction.
- Optional in the type, supplied by default by `PeriscopeHost`: writes jailed to the session's own
  workspace, with `credentialPaths(env, { agentHome, modelEndpointFiles, codexHome, qwenHome, piHome })` as the protected set and the home directory
  the shell scan expands from `homeDirectory(env)`. That set, stated once (`src/host/paths.ts`): the
  host's own config directory (`PERISCOPE_CONFIG_DIR` or `~/.periscope`, which holds the token
  cache, the paired credential and the config file); the agent CLI's token cache and configuration
  file (`.credentials.json` and `.claude.json`) in `~/.claude`, in `CLAUDE_CONFIG_DIR` when set and
  in the effective agent home, plus `~/.claude.json`; and `~/.aws`, `~/.config/gcloud`, `~/.azure`,
  `~/.ssh`; the model endpoints file (`PERISCOPE_MODEL_ENDPOINTS`) with every credential file it
  names; Codex's sign-in files (`auth.json` and `.credentials.json`) in the runner's Codex home
  (`PERISCOPE_CODEX_HOME`) and in `~/.codex`; and, in the runner's Codex home, the files that make
  periscope's hook the gate there (`hooks.json`, the `hooks` directory and `config.toml`, which records
  the hook's trust); Qwen Code's session homes (`sessions` beneath `PERISCOPE_QWEN_HOME`, each
  holding the session's settings and the endpoint's key); Qwen Code's sign-in, token, extension-secret,
  settings and variables files (`oauth_creds.json`, `mcp-oauth-tokens.json`,
  `mcp-oauth-tokens-v2.json`, `extension-secrets-v1.json`, `settings.json`, `.env`) in `~/.qwen` and
  in an operator's own `QWEN_HOME`; `~/.env`, which Qwen Code loads into its own environment
  whatever its home; the whole of pi's runner home (`PERISCOPE_PI_HOME`: its agent home with the
  sign-in and the endpoints' keys, the session store every pi session's file is kept in, and each
  session's run directory with its channel's token); and pi's sign-in, MCP token and models files
  (`auth.json`, `mcp-auth.json`, `models.json`) in `~/.pi/agent`. The rest of the CLI's home (its settings, skills and tool output) is the agent's to
  read, and so is the rest of the operator's own `~/.codex` and the runner home's rollouts and state,
  and the Qwen Code base's shared `runtime` directory, where the chats a resume reads are kept.
  The host's own cache location derives from the same function, so the two cannot disagree about
  what is protected. The repository and workspace read doors honour the same set.
- Shell commands are parsed before they are judged (`src/gate/command.ts`, `src/gate/shell.ts`):
  the classifier sees a parsed shape, never text. An interpreter payload (`bash -c "..."`) is
  scanned as the nested command it is, with the interpreter's own delimiter closing it, so a nested
  quote of the other kind and a `#` inside the payload are the nested command's own syntax.
  `src/gate/shell.property.test.ts` holds totality, determinism and monotone refusal under quoting
  and composition.

## The five outcomes that must never blur

| Outcome                                                                                | Cause on the transition                                                        | Fix lives with                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------- |
| A deliberate denial                                                                    | `control/permission_denied`                                                    | nobody; it worked             |
| A locally-decided refusal, taken before anyone was asked                               | `refusal/<reason>` (for example `path-escapes-root`, `credential-path-denied`) | the embedder's policy         |
| An outage (the decider threw, the transport failed, a non-2xx status, a non-JSON body) | `refusal/permission-decision-unavailable`                                      | the controller's availability |
| A decision this build does not know (valid JSON, unknown `behavior`)                   | `refusal/permission-decision-unrecognised`                                     | the controller's version      |
| The host's own deadline passed                                                         | `timeout/hook_timed_out`                                                       | the configuration             |

Beside them is one degrade, which reports on the gate's own configuration rather than on a request:
`gate-cannot-grant`, raised at most once per gate on the first allow that does not take effect. It
is a `RefusalReason` declared in `src/core/refusal.ts`, not a free string, so a degrade cannot be
invented at a call site.

The unknown decision is never an allow. Its raw payload is preserved into the emitted transition
(bounded, marked when truncated) and it is refused by the gate, not the transport:
`escalatingDecider` returns well-formed nonsense intact so the tool's fate is a policy act with a
receipt, not a parse error. Malformed JSON is an outage because version skew produces a different
decision, never a broken one. `cause.event` is `permission_denied` in `CONTROL_EVENTS`; naming the
SDK's `PermissionDenied` hook would write into the trace the name of an event that does not fire.

## Two deadlines, the inner one the host's

- The matcher's `timeout` (per matcher, in seconds, fail-closed; `DEFAULT_MATCHER_TIMEOUT_SECONDS`)
  is CLI-enforced; the handler never learns it fired, so a block would read as a hang.
- The host's `decisionTimeoutMs` (`DEFAULT_DECISION_TIMEOUT_MS`) fires first, blocks, and names the
  expiry; the matcher remains the backstop for the case where this code is what hung. A decision
  still open after `holdAfterMs` (`DEFAULT_HOLD_AFTER_MS`) opens the hold described below. `permissionHooks()` throws at construction
  when `decisionTimeoutMs >= matcherTimeoutSeconds * 1000`; equal is refused too, because two timers
  racing at the same instant is a coin flip, not an ordering.
- A controller that holds a decision for a person keeps its own budget strictly inside
  `decisionTimeoutMs` and answers with a non-2xx status when the budget passes. An unanswered hold
  that runs into the host's deadline reports as a timeout, and one that runs past the matcher's
  reads as a hang.

A per-session `gate` in `session_new` (`decisionTimeoutMs`, `holdAfterMs`, `matcherTimeoutSeconds`)
overrides the host defaults; an inverted pair answers the named refusal `gate-deadlines-inverted`
rather than a throw, enforced in two places from one declaration (`deadlineOrderRefusal`).

## The hold

A decision taking longer than `holdAfterMs` opens a `permission:<toolUseId>` entry through the
state machine and closes it at resolution; a synchronous allow or deny opens nothing, because an
entry opened and closed in one tick is noise in the one signal it carries. It is keyed by
`tool_use_id`, so a second `PreToolUse` for the same tool name cannot close a live hold; the
observer's `permission:<toolName>` lane is single-writer and effectively dormant (only the
never-firing `PermissionRequest` opens it). Emission rides outside the deny path's `try/catch`: a
gate that fails closed still says it did.

The hold reaches the wire. `forwardSession` subscribes to `machine.onTransition` and emits every
recorded transition whatever caused it, so a hold, a deny, an outage and an expiry are all visible
off-box. That is also why `system/hook_started` and `system/hook_response` are declined in
`MESSAGE_ROUTING`: the decision's transition already rides the wire, and forwarding the hook
messages too would invite a consumer to count one decision twice.

Register the gate after the observer: `mergeHooks(observationHooks(...), permissionHooks(...))`.
Matchers are dispatched in array order but awaited concurrently, and a gate registered first would
open a hold the observer closes in the same event. No test pins the order; it lives at both sites.

## Escalation

`escalatingDecider()` asks the controller over HTTP and discriminates the status before reading the
body: a 500 with a parseable body must never impersonate a human "no". An `EscalationUnavailable`
keeps its own detail so an outage says which lane failed.

`DecisionRequest` carries `sessionKey`, the controller's handle for the session, so a decision can
be correlated without re-deriving it from transport state. It also carries `toolKind`, one of
`TOOL_KINDS`, read from `toolName` by Claude's map (`src/gate/tool-kind.ts`), and `runtime`, the
session's runtime, which the composer passes in beside `sessionKey` (`PermissionGateOptions.runtime`).
A decider can hold one policy per kind across runtimes; `toolName` is unchanged and still says
exactly which tool it is. The map names the shell, file and web tools and every `mcp__` tool; a tool
it does not name is `other`, whatever its input carries, and never left without a kind. A shell call
also carries `shellDialect` (`SHELL_DIALECTS`: `posix` or `powershell`), the grammar its command runs
in: Claude's `Bash` is `posix` and its `PowerShell` is `powershell`; Qwen Code's `run_shell_command`
is `cmd` on Windows, unless the environment the CLI starts with names Git Bash (`posix`) or PowerShell
(`powershell`) as its shell, and `posix` elsewhere. For Claude it is data for the decider only; the
local gate reads Claude's commands as it always has. Both are
filled where the hook input becomes a request (`readRequest`), so the local gate, an in-process
decider and the escalated body see the same request; an input the gate cannot read is refused with
a request that states `other`. The POST presents a credential per
request (`EscalationOptions.credential`, resolved at call time), and a refusing credential is an
outage, the deliberate opposite of the link's posture: a prompt that cannot be delivered is
retried; a gate that cannot authenticate must not proceed. Resolving per request makes this lane a
second caller of `authorize()`, so a busy session reports one `cache-hit` per decision; read a
stream of them as the gate working, never as a credential problem.

## The Codex gate

Codex is gated by a `PreToolUse` command hook, periscope's own, that asks the session's host for each
decision. The host decides it with the same per-call decision a Claude call gets
(`createCallDecision`, `src/gate/call-decision.ts`): the local gate, the decider under the host's
deadline, the hold, and one recorded outcome. Its three callers are Claude's `PreToolUse` callback, the
hook channel, and Codex's approval channel.

- **Two outputs, and nothing else.** Codex lets a call proceed whenever its hook fails: a timeout, a
  crash, a non-zero exit, output it cannot parse, a shape it does not support (a bare allow, `ask`,
  `continue: false`, a stop reason, an unknown key). So `periscope hook codex` (`src/bin/hook.ts`)
  writes either nothing (proceed) or a deny with a non-empty reason, and exits 0 and writes nothing to
  standard error on every path. It fails closed itself: no channel, a channel it cannot reach, an
  answer that does not verify, unreadable input, an error, or its own deadline each writes the deny.
  `src/gate/hook-exchange.test.ts` states, shape by shape, what Codex does with each output and shows
  every answer the host can give reaches Codex as one of the two.
- **The hook channel** (`src/host/hook-channel.ts`): a named pipe on Windows and a Unix socket in a
  directory only this user can enter elsewhere, never a TCP port, one per session. The hook finds it,
  and proves it belongs to the session, through `PERISCOPE_HOOK_CHANNEL` and `PERISCOPE_HOOK_TOKEN`
  in the app-server's environment, which Codex's shell exclusion keeps from the agent's tools. A
  request with the wrong token is refused without asking anyone; every answer carries an HMAC keyed by
  the token, which the hook verifies, so a process that takes over the channel's name cannot answer
  allow.
- **Installed and trusted over the wire.** The host writes the hook into the runner's Codex home at
  start (`hooks.json` and a `.cmd` shim) and probes it through the shell Codex will run it under. At
  every Codex session's open it lists the hooks (`hooks/list`), records periscope's as trusted the way
  Codex's own interface does (`config/batchWrite` on `hooks.state`) when it is not, lists them again,
  and lists them once more after the thread opens. Unless periscope's hook is trusted, enabled and
  unchanged, the open is refused `codex-hook-not-active`: without the hook nothing enforces the
  protected set on Codex.
- **Approvals through the same decision** (`src/host/codex-approvals.ts`). Codex asks for an approval
  after its hook, and waits with no deadline of its own. An approval for a call the hook decided is
  answered from that decision; one the hook did not decide is decided fresh; at the host's deadline it
  is declined and `gate-approval-unanswered` is raised. Input written to a running command is always
  decided fresh. An MCP tool approval names no call, so it is tied to the call pending on that server;
  with several pending, each is decided and the approval is accepted only when every one was allowed
  (`gate-approval-ambiguous` otherwise). The answers are `accept`, `decline` and `cancel`, never a
  grant for the session, an amendment to Codex's rules, or a root.
- **An allow that rewrites the input is refused on Codex** (`permission-decision-unrecognised`):
  Codex's hook can only let a call proceed as asked or block it, and running half the decision would
  run arguments nobody approved.
- **Codex's tools in the local gate** (`CODEX_TOOL_FAMILIES`): `Bash` through the shell rules,
  `apply_patch` with every file its patch names (`src/gate/patch.ts`) through the jail, `view_image`
  through the protected set, relative paths resolved where the call runs. Codex's `Bash` runs
  PowerShell on Windows, so its commands are read both ways and refused when either reading refuses
  (`readsShellDialect`): the POSIX reading of `<# note #> git push` hides the push behind what it takes
  for a comment.
- **The deadline order**: the host's decision deadline, then the hook's own
  (`PERISCOPE_HOOK_DEADLINE_MS`, the decision deadline plus `HOOK_DEADLINE_MARGIN_MS`), then the hook's
  timeout in `hooks.json` (`CODEX_HOOK_TIMEOUT_SECONDS`), which Codex enforces and on which it goes on as if
  the hook had allowed the call: the call runs where the session's mode asks no approval, and otherwise
  reaches the approval channel, which the gate decides afresh. A Codex session whose decision deadline leaves no room inside the hook's is refused
  `gate-deadlines-inverted`. `matcherTimeoutSeconds` does not apply to Codex.
- **The residual, named as it happens** (`src/host/codex-gate-watch.ts`). Each is a degrade on the
  session's state lane, never a refusal: a call went on undecided, or the session lost a guarantee.
  `gate-hook-timed-out`, `gate-hook-unspawnable` and `gate-hook-output-rejected` (a hook run that
  failed); `gate-hook-missing` (a call Codex started, or its hook let proceed, that the host never
  decided); `gate-unhooked-call` (input written to a running command, a hosted web search, an image
  generation); `gate-approval-auto-reviewed`. Known when the session opens, and named in its opening
  tier: `gate-hook-foreign` (a hook periscope did not install would run), `gate-project-config-active`
  and `gate-sandbox-absent`. A degrade is raised once per call.

Codex is advertised at `intercepted-with-residual` (`CONTROL_TIERS`).

## The Qwen Code gate

Qwen Code is gated by its own permission request: in stream-json mode the CLI asks the host
(`can_use_tool`, a control request on its stdout) before every call its rules send to ask, and runs
the call only on the host's allow. So what decides coverage is which calls are sent to ask, and that
is the settings file this host writes for each session (`src/host/qwen-home.ts`).

- **Every call asks.** The session's settings sit at the system scope
  (`QWEN_CODE_SYSTEM_SETTINGS_PATH`), which the CLI applies over every user and project settings
  file, so a repository's own `.qwen/settings.json` cannot widen them. Their `permissions.ask` names
  every built-in tool of the pinned release (`contracts/qwen-code-names.json`, derived by
  `scripts/derive-qwen-names.mjs`) and `mcp__<server>` for each attached server; `disableAllHooks`
  turns off every hook a settings file could add. The operator's own `~/.qwen` is never the session's
  home.
- **Read back before the CLI starts.** The host reads the file back through the environment the CLI
  will start with: the environment names it, it parses, its ask rules cover every name, and its hooks
  are off. Anything else refuses the open `qwen-ask-rules-not-active`, and no process starts.
  `QWEN_CODE_SAFE_MODE`, which would drop every rule, is removed from the CLI's environment.
- **One decision per call** (`src/host/qwen-gate.ts`). A `can_use_tool` request becomes a
  `DecisionRequest` (`toolName`, `tool_use_id`, the input, the session id, the call's own directory
  where the input names one, `toolKind`, `shellDialect`) and goes through the same call decision as
  a Claude call: the local gate, then the decider, with the session's deadline and hold. An allow is
  answered with no `updatedInput`, so the call runs exactly as the CLI asked it.
- **An allow that rewrites the input is refused on Qwen Code** (`permission-decision-unrecognised`):
  the CLI does not run a rewritten input, and running half the decision would run arguments nobody
  approved.
- **Qwen Code's tools in the local gate** (`QWEN_TOOL_FAMILIES`): `write_file`, `edit` and
  `notebook_edit` through the jail; `read_file`, `zoom_image`, `display_image` and `list_directory`
  through the protected set; `run_shell_command` and `monitor` through the shell rules, the
  `directory` a command runs in through the protected set (`checksShellDirectory`); `glob` and
  `grep_search` through the protected set, relative paths placed where the call runs. A `cmd` command
  is read both ways, in `cmd`'s grammar (`readCmdCommand`, `src/gate/command.ts`: carets are escapes
  outside double quotes, a `#` is no comment, and there is no heredoc) and as POSIX, and refused when
  either reading refuses: the POSIX reading of `echo #& git push` takes the push for a comment.
- **The deadline order**: the host's decision deadline, then the CLI's own wait for the answer
  (`timeout.canUseTool` in `initialize`: the decision deadline plus `QWEN_PERMISSION_MARGIN_MS`, at
  most `QWEN_MAX_PERMISSION_TIMEOUT_MS`), at which the CLI cancels the call. A Qwen Code session whose
  decision deadline leaves no room inside that is refused `gate-deadlines-inverted`.
  `matcherTimeoutSeconds` does not apply to Qwen Code.
- **The modes.** `default` and `plan` are the CLI's own; `bypassPermissions` runs as `default`, every
  call still asked. The CLI's other modes (`auto-edit`, `auto`, `yolo`) approve calls themselves, so
  the host never asks for them, and a session that reports one is named.
- **The residual, named as it happens.** Each is a degrade on the session's state lane, never a
  refusal: `gate-tool-unruled` (the CLI's first init lists a tool no ask rule names, so a call to it
  the CLI allows by default runs without asking), `gate-mode-widened` (the CLI reports a mode other
  than `default` or `plan`). Known when the session opens, and named in its opening tier:
  `gate-credential-in-shell` (a variables file the CLI loads into its own environment, `~/.env` or
  `~/.qwen/.env`, or the endpoint's own variables, would reach every command the agent runs; the
  detail names the variables, never their values). Each is raised once per tool, mode or session.

Qwen Code is advertised at `intercepted-with-residual` (`CONTROL_TIERS`).

## The pi gate

pi has no permission system. What it has is an extension's `tool_call` handler, which every tool call
passes through before it runs and which can block it. So the gate is an extension of periscope's own
(`src/host/pi-extension.ts`, built to `dist/host/pi-extension.js`), and what decides coverage is that
it is loaded, that it is the last handler a call meets, and that nothing else is loaded beside it.

- **The launch rule** (`piArgs`, `src/host/pi-process.ts`). pi is started with `--mode rpc
--no-extensions --no-skills --no-approve`, then `-e builtin:mcp` and `-e` naming this package's
  extension by absolute path, the session's skill directories (`--skill`), the session store
  (`--session-dir`), the session to open, the model and the system prompt file. `--no-extensions` and
  `--no-skills` keep pi from finding any of its own; `--no-approve` leaves the workspace untrusted, so
  a repository's `.pi/settings.json` (which could name the shell binary), `.pi/mcp.json` and
  `.pi/extensions` are not read. pi loads its built-in extensions before the ones `-e` names, so
  periscope's handler runs after pi's MCP extension's: the input it decides is the input that runs.
- **Proven before the first prompt.** The extension's configuration (the channel's address and token,
  its deadline, the session's MCP servers) is a file only the runner can read, named by
  `PERISCOPE_PI_EXTENSION_CONFIG`; the extension reads it, takes the variable out of pi's environment,
  and says hello over the session's hook channel (`src/host/hook-channel.ts`) once pi's session has
  started, with what it can see: every tool and command pi lists and where each came from, and the
  MCP servers registered. The host deletes the file once the hello arrives. No prompt is written
  before it; one that does not arrive within `PI_HELLO_DEADLINE_MS`, or a pi that refuses to load the
  extension, refuses the open `pi-extension-not-active`.
- **Nothing else loaded, checked at the open** (`piForeignSources`, `src/host/pi-gate.ts`). Every
  tool, command and MCP server the hello names, and every command `get_commands` lists, must come from
  this package's extension, from one of pi's built-in tools (`builtin:<tool>`, the pinned release's
  list), from pi's MCP extension, or from a skill directory the host handed over. Anything else, and a
  list the extension could not read or had to cut, is named `gate-foreign-extension` and drops the
  opening tier to `intercepted-with-residual`. An extension that registers neither a tool nor a command
  is invisible to the check; the launch rule is what keeps one from loading.
- **One decision per call.** The extension asks the host about each `tool_call` over the channel, the
  answer verified by the session's token (`src/gate/hook-exchange.ts`), and the host reads it as a
  `DecisionRequest` (`readPiToolCall`, `src/gate/pi-request.ts`: the tool's name, the call id, the
  input, the session, the call's own directory, `toolKind`, `shellDialect`) through the same call
  decision as a Claude call: the local gate, then the decider, with the session's deadline and hold.
- **What blocks.** A deny blocks the call with its reason. So do the extension's own deadline (the
  decision deadline plus `HOOK_DEADLINE_MARGIN_MS`), an interrupt (the run's signal blocks at once and
  closes the exchange, which ends the host's decision rather than leaving pi's abort to wait on it), a
  reply that does not verify, and anything the handler throws.
- **An allow may rewrite the input** (`canRewriteInput`). The rewrite is applied to the call's input in
  place, and pi runs that object, unvalidated again; pi's transcript and its `tool_execution_start`
  still show the input the model wrote.
- **pi's own `bash` command is refused.** It runs a command outside any tool call, and its handler has
  no way to block one but to throw, so the extension's handler throws: the command does not run, and
  the answer says so.
- **pi's tools in the local gate** (`PI_TOOL_FAMILIES`): `write` and `edit` through the jail, with a
  relative path placed where the session runs (`resolvesWritesAgainstCallCwd`); `read` through the
  protected set; `bash` and `powershell` through the shell rules, read in their own grammars (`posix`
  and `powershell`); `grep`, `find` and `ls` through the protected set, relative paths placed where the
  call runs.
- **MCP.** The session's servers are registered by the extension with `direct` exposure, so each tool
  is its own `mcp__<server>__<tool>` and asked about like every other call. Every header and variable
  value is escaped first, so pi neither runs a value starting `!` as a command nor expands a `$` in it.
- **The residual known at the open.** `gate-foreign-extension` (above), and `gate-credential-in-shell`
  when the session's endpoint has variables of its own, which pi's environment carries to every
  command the agent runs; the detail names the variables, never their values.

pi is advertised at `intercepted` (`CONTROL_TIERS`); a session with either degrade known at its open
opens at `intercepted-with-residual`.

## What is deliberately not covered

- `bypassPermissions` is composable, as the SDK's own `permissionMode` vocabulary. It travels wire
  to `readSessionRequest` to `src/host/agent-process.ts` and nowhere else, and
  `pins/permission-config.test.ts` holds three things:
  - no settings-file or rule-list option anywhere;
  - `permissionMode` only on that path;
  - `setPermissionMode` called from one module (by `session_configure`), and the other mid-session
    mutators uncalled, except one: `applyFlagSettings` is called once, by `setEffort`, with the
    single key `effortLevel`.

  The gate keeps its authority through `PreToolUse` in every mode. The package's own measurement of
  a hook deny surviving bypass is the unexercised probe above.

- The bypass flag is set only for a bypass start. A session started in `bypassPermissions` gets the
  SDK's `allowDangerouslySkipPermissions`, which the SDK names as the mode's requirement; a session
  started in any other mode does not. On Claude Code 2.1.284 the CLI refuses a switch into bypass
  for a session started without it ("the session was not launched with
  --dangerously-skip-permissions"), and the controller hears `session-configure-failed`. With the
  flag at start, the same switch is accepted. A controller that wants bypass asks for it when it
  opens the session.
- Plan mode does not move the decision. On Claude Code 2.1.284 a `PreToolUse` deny held under
  `plan` exactly as under `default`: the hook was asked for the call, the call did not run, and the
  model was told why.
- Both measurements above come from `agent-controls.live.test.ts`, run from inside an agent session.
  They are the CLI's own answers (a named refusal, and this hook's deny holding), not the enclosing
  session's; rerun them outside an agent session before relying on them for more than that.
- `permissionDecision: 'defer'` was evaluated and not adopted: it ends the query for a later
  resume, a different lifecycle from "hold, then continue with everything you knew".
- `outputFor` cannot render a hold: `holding` is excluded by the type, not by a branch. A branch
  that returned `{}` for it would be no opinion, which the CLI reads as allow, so the one state that
  could open the door is made unrepresentable rather than handled.

## Where things live

| Path                                       | What                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/gate/gate.ts`                         | `permissionHooks()`: registration, the fail-closed wrappers, both deadlines                                       |
| `src/gate/call-decision.ts`                | `createCallDecision()`: the per-call decision every runtime's gate asks through, and the hold                     |
| `src/gate/decision.ts`                     | `Decision` (the SDK's `PermissionResult`) and `readDecision`, the total parser; `TOOL_KINDS`; `SHELL_DIALECTS`    |
| `src/gate/tool-kind.ts`                    | `claudeToolKind`, `codexToolKind`, and each runtime's shell dialect                                               |
| `src/gate/codex-request.ts`                | Codex's hook event read as a decision request                                                                     |
| `src/gate/patch.ts`                        | The files a patch's header lines name                                                                             |
| `src/gate/hook-exchange.ts`                | The hook channel's exchange, and the hook's two outputs                                                           |
| `src/bin/hook.ts`                          | `periscope hook codex`, the command Codex runs as its hook                                                        |
| `src/host/hook-channel.ts`                 | The per-session pipe or socket a runtime's hook asks over                                                         |
| `src/host/codex-hook.ts`                   | The hook in the Codex home: its lines, its shim, its probe, its listing and its trust write                       |
| `src/host/codex-gate.ts`                   | One Codex session's gate                                                                                          |
| `src/host/codex-approvals.ts`              | Codex's approvals through the per-call decision                                                                   |
| `src/host/qwen-home.ts`                    | A Qwen Code session's home and system-scope settings, their ask rules, and the read-back                          |
| `src/host/qwen-gate.ts`                    | One Qwen Code session's gate: the ask, its answer, the deadline order and the residual                            |
| `src/host/pi-extension.ts`                 | The extension pi loads: its configuration, its hello, its MCP servers and its call handlers                       |
| `src/host/pi-gate.ts`                      | One pi session's gate: the channel, the hello, the check for code this host did not load                          |
| `src/gate/pi-request.ts`                   | pi's `tool_call` event read as a decision request                                                                 |
| `src/host/pi-home.ts`                      | The pi base: its agent home's files, a session's run directory, a resume resolved to its file                     |
| `src/host/codex-gate-watch.ts`             | The residual, watched and named as it happens                                                                     |
| `src/gate/outcome.ts`                      | `GateOutcome` (`holding`, `allow`, `deny`, `refused`, `expired`) to transitions, pure; `recordGateOutcome`        |
| `src/gate/escalate.ts`                     | `escalatingDecider()`: status before body, `EscalationUnavailable`; the HTTP lane the link does not carry         |
| `src/gate/local.ts`                        | `localGate()`: the host's own offline refusal; pure, synchronous, total                                           |
| `src/gate/jail.ts`                         | The path jail and the protected-path check; `pathFromToolInput`, `commandFromToolInput`                           |
| `src/gate/shell.ts`, `src/gate/command.ts` | `classifyShellCommand` over `parseCommand`'s parsed shape                                                         |
| `src/host/paths.ts`                        | `credentialPaths(env)` and `nodePathResolver`: the one source of the protected set and the token cache's location |
| `src/host/host.ts`                         | Where the gate is composed onto a session, and the `grantOnAllow` and `settingSources` refusal                    |
| `src/pins/permission-config.test.ts`       | The shadowing-lane pin, compile and scan halves                                                                   |
| `src/gate/gate.live.test.ts`               | The live probes, skipped unless `PERISCOPE_LIVE=1`                                                                |
