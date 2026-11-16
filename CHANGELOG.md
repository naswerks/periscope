# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semantic versioning: patch
for no wire or API change, minor for a protocol bump (the previous version stays supported for one
minor), an agent SDK pin bump or an additive API, major for a wire change outside the window or a
removed export. The package version and the wire protocol version are separate numbers.

## [Unreleased]

## [1.11.0] - 2026-11-15

Protocol 20; the window is `[19, 20]`, so a version-19 controller is still spoken to, and a version-18
controller is refused at the handshake by name. Every member version 20 adds is optional and it adds no
payload kind: a version-19 controller reads each as an unknown key on a kind it already reads, and every
frame it sends decodes unchanged.

- Fixed: a Claude session no longer carries an open model request after its turn. Claude Code 2.1.325
  sends `system/status` with `status: 'requesting'` at the start of every model request and no status
  at its end (a null status arrives for a compaction's end and a permission-mode change), and the
  request entry was closed only by a null status, so after its first request a session showed
  `requesting` for good, through its tools and after the turn. The request is now closed by its
  answer, the session's own `assistant` message, in a transition whose cause is `assistant`; one that
  got no answer is closed by the turn's end, `Stop` or `result`. A sub-agent's message closes nothing,
  and with no request open none of the three names an entry.
- Fixed: a Claude session's `permission:<toolName>` entry is closed by what the CLI sends. Claude Code
  2.1.325 fires `PermissionRequest` for a call the hooks left to its own permission flow (an allow
  that does not grant, in a mode that asks), after that call's `PreToolUse`; it reports a denial as
  the `system/permission_denied` message with the `PermissionDenied` hook silent, and runs the tool
  when a hook grants. The entry was closed by the next `PreToolUse` of the same tool, which is
  another call's, so the trace said a permission had resolved when nobody had answered it, and a
  denied one stayed open. It is now closed by the denial, whichever of the message and the hook
  reports it, once; or by the end of a call of that tool. A session whose gate grants on allow, as
  `PeriscopeHost`'s do, opens no such entry and is unchanged.
- Changed: what an operator's deny rule does to a call a hook would allow is measured, where it was
  stated from the documentation alone. On Claude Code 2.1.325 a deny rule is applied before any hook is
  asked: a rule that names the whole tool takes the tool from the model, and a rule that names a path
  refuses the call with `PreToolUse` never firing, so a hook's allow overrides neither, and a call a
  deny rule refuses never reaches the gate. The live probe asserts it in three turns (no rule, the
  tool's rule, a path's rule), and reports itself skipped when the model did not make the one call it
  was asked to make.
- Changed: the live probe of a turn rendered as it happens asserts what its title says, that the
  last fragment of text arrives before the assistant message that carries the text. It counted every
  delta, and Claude Code 2.1.325 sends the markers that end a block and a message
  (`content_block_stop`, `message_delta`, `message_stop`) after that message; the probe prints them and
  [protocol.md](docs/protocol.md) says so. The probe of the thinking display runs both its turns at
  the highest effort, where adaptive thinking does think, and reports itself skipped, not failed, when
  neither turn produced a thinking block.
- Fixed: a live probe whose assertion fails no longer leaves its agent running. Four probe files
  stopped their sessions on the last line of each test, so a failed assertion left the agent up and
  the probe's own process could not exit; every probe now ends what it started in a `finally`, and a
  pin holds that for each probe file. The probe of the spawn environment looked for the search path
  as `PATH` exactly, which a shell on Windows hands over as `Path`; it now matches a variable's name
  without regard to case, as the host does.
- Fixed: the close of a Copilot session ends a command a turn started in the shell's background mode.
  The close ended the turn first, which makes the runtime end its shells, each without the command it
  is running; where the runtime's shell is PowerShell 7 the command was then under a process that was
  gone, which no tree kill from the runtime finds, and it outlived the session. The close now ends
  everything under the runtime first, while the runtime and its shells are there to root the walk, as
  the close of an opencode session does. Found by the live probe's first turns on a real model;
  held on the real runtime with a stub model.
- Changed: a Copilot call that ran with no decision is named with its tool, and the runtime's own
  read of a finished background command is named as that. When a command started in the shell's
  background mode ends, the pinned runtime reads its output with a `read_powershell` call of its own,
  under its own id, which reaches neither the hook nor the permission request. It was named
  `gate-hook-missing` by its id alone. The detail now carries the tool, which the runtime states at a
  call's start and not at its end, and says when the call is that read, with the shell it read.
  [SECURITY.md](SECURITY.md) and [gate.md](docs/gate.md) say what the runtime does.
- Changed: the Copilot live probe runs on an account that is offered no model by name.
  `PERISCOPE_COPILOT_MODEL=default` names no model, so each session opens on the runtime's own default,
  which is the only way an account on Copilot's free plan runs a turn: the runtime lists no model for
  it and refuses one that is named. A session that names no model already opened and ran; the
  documents now say so, and that the runtime reports such a session's model as `auto`. The probe no
  longer names the tool a write is made with, since the runtime picks a session's file tools by its
  model; it reads a command's environment from a file the command writes, since a model asked to print
  every variable declines; it waits for a background command itself and not for the turn's end, since
  a session is not idle while a command it started runs; and the sub-agent's leg reports alone, so
  that it alone is skipped where the plan gives a sub-agent no model.
- Changed: the trace live probe holds that the CLI sends no `requesting` status for a sub-agent's
  model requests. A status names no thread, so one sent for a sub-agent would open the session's own
  request entry and leave the session reading as requesting for the sub-agent's whole run. Claude
  Code 2.1.325 sends none, by its own code and by a recorded turn; the probe's sub-agent test now
  asserts it, and [state-machine.md](docs/state-machine.md) says it.
- Fixed: a live probe no longer leaves its scratch directory behind. The opencode probe's background
  test left its directory in the temp folder each run. What held it was the command the close had just
  ended, for under a second, as its working directory: on Windows such a directory cannot be removed,
  the removal fails at once, and the retry `rmSync` offers does not wait that failure out. The shared
  removal now tries again itself, for up to ten seconds, and says in a receipt when it had to wait.
- Fixed: a Copilot session opens where the runtime allows a directory that is none of the session's.
  The read-back refused the open `copilot-gate-not-active` for it, and the runtime allows its temp folder
  by itself, so a session whose temp folder is no write root of its own (one that covers the session's
  directory, its home or a protected path) never opened. The runtime's list bounds no write: the hook
  asks about every call, and the host's gate holds a write to the session's write limits. Such a
  directory is now named `gate-mode-widened`, once, and the session opens. Every other posture the
  read-back holds still refuses the open.
- Security: Copilot's `rg` is read as the search tool it is. Under some models (the `gpt-` family on
  the pinned runtime) a session is offered `rg` and `apply_patch` in place of `grep`, `create` and
  `edit`. `rg` was in none of the host's tables: its kind was `other`, and its `paths` were not read
  against the protected set, so a search under a protected directory had no local refusal (it was named
  `gate-tool-unnamed`, and still went to the controller). It is now kind `file_read` and in the search
  family, held by its `paths` as `grep` is, and a real-runtime test reads the tools a session is offered
  under each of the two families.
- Changed: what the Qwen Code live probe of a read counts. It counted the calls that reached the
  decider, and a read the protected set refuses never reaches it, so the probe failed on a refusal
  that held. It now asks for an ordinary read, which must be asked about, and a protected one, which
  must be refused with nobody asked.
- Changed: the pi live probe of a background command holds what was measured. It asserted that such a
  command does not outlive the session's close. On Windows a command the agent's shell puts in the
  background and leaves has no running parent, so nothing that walks the process table reaches it, and
  it outlives the close; so does the program a command still running at the close was in the middle
  of. Both were measured on the pinned pi. The probe now holds the first where it was measured, records
  what it found and ends it, and [SECURITY.md](SECURITY.md) and [gate.md](docs/gate.md) say what a
  close of a pi session does not end.
- Changed: the Qwen Code, opencode and Copilot live probes of a background command carry their marker
  as the command's own argument. It was a trailing comment, which a model drops, so the listing found
  nothing before the close or after it and the probe passed on a run that measured nothing. A command
  that was not running when the close came is now reported as skipped, not passed.
- Fixed: the trace live probe's process ends when its tests do. One test raced a three-minute timer
  and dropped its handle, so the probe's process stayed for three minutes after its last test. The
  timer is cleared when the wait is over, and a pin reads every probe file for a timer that is
  neither waited out nor kept.
- Fixed: a Qwen Code session holds the tools the CLI registered to the ones its settings turn off.
  The read-back before the CLI starts reads the file the host itself wrote, and nothing compared it with
  what the CLI then registered. The first list of tools the CLI sends is now read for the tools the
  settings deny (`autofix_pr`) and the one the CLI registers only in code mode (`exec`): one listed all
  the same is named `qwen-ask-rules-not-active` on the session's state lane, once a tool, and the
  session opens and goes on. A call to a tool the settings deny is refused by that name before anyone
  is asked; a call to `exec` is asked about like any other.
- Changed: the agent SDK is `@anthropic-ai/claude-agent-sdk` 0.3.325, pinned exactly, bundling Claude
  Code 2.1.325 (was 0.3.284 and 2.1.284). The hello's catalog is the one the new CLI offers. Its one new
  message, `system/session_writes_lost` (the CLI could not save transcript lines or its own
  configuration because the disk was full), rides the update lane and moves no state. Its one new
  built-in tool, `OfferChromeSetup`, names no path and runs no command, and is `other`. No hook event
  was added.
- Changed: `@anthropic-ai/sdk`, which only the agent SDK's type definitions read, is `>=0.93.0` (was
  `^0.129.0`): the range the agent SDK's own manifest asks, so a consumer on either major installs. This
  package's lockfile resolves 1.8.0, which is published under the Apache-2.0 licence and brings
  `@opentelemetry/api` with it.
- Security: the local gate places a path a tool names where the operating system puts it, then checks
  it. On Windows a path with one leading separator (`\Users\x`, `/Users/x`) is rooted at the drive the
  call runs on and `C:name` on that drive is beneath the call's directory; on every system `~` is the
  home directory for a read, a write and a patch, as it was for a search. Each was joined under the
  call's directory as text, so the gate judged a file inside the workspace while the tool opened
  another: a read of a protected file, or a write outside the session's roots, passed. Two forms cannot
  be placed and are refused with a new reason, `path-unplaceable`: a drive-relative path on another
  drive, and another user's home (`~name/...`). Under a POSIX call directory nothing new is refused.
- Security: a Claude session's relative read or search path is checked where the call runs. `Grep` and
  `Glob` take a relative `path`, and the local gate resolved it against the host process's own
  directory, so a path that climbed out of the session's directory into a protected folder was judged
  as some other folder and passed. `PeriscopeHost` now places it under the call's directory, as it does
  for every other runtime. A write is unchanged.
- Security: the local gate reads the NT namespace prefix. `\??\C:\...` is the system's own name for the
  drive path after it, and Windows opens it as that path when a program hands it over unchanged. The
  gate placed it as a folder named `??` at the root of the drive, so a protected file named that way had
  no local refusal: on the pinned Copilot runtime, whose `view` and `create` open that spelling, a
  protected file was read through it. It is now the drive path after it, as a device prefix is
  (`\??\UNC\server\share\...` is that share), so a protected file is refused, a write outside the
  session's roots is refused, and a file in the workspace named that way is written where it was refused
  as outside. A form under it that maps to no drive path (`\??\GLOBALROOT\...`, a volume) is refused
  `path-unplaceable`. With forward slashes it is no prefix and is read as before.
- Security: the local gate reads the other ways Windows spells one file. A device prefix
  (`\\?\C:\...`, `\\.\C:\...`) is the drive path after it, so a long-path spelling of a workspace file
  is now written where it was refused as outside the workspace, and one of a protected file is refused
  where it passed. A share that names this machine's own drive (`\\localhost\C$\...`, a loopback
  address, the host name or `COMPUTERNAME`) is that drive's path. The protected set is compared with
  trailing dots and spaces and a stream name (`id_rsa.`, `id_rsa::$DATA`) folded away, and a path with a
  segment shaped like a generated short name (`CREDEN~1.JSO`) is also compared as the file system names
  it. A device or volume form that maps to no drive path is refused `path-unplaceable`. Still outside
  the gate: a link, a short name set by hand, and a share reached by a name the host does not know as
  its own.
- Security: the local gate reads a drive path written from the root. On Windows `/c/Users/x` and
  `/cygdrive/c/Users/x` name drive C to Git Bash, Cygwin and the agent CLI's own tools, and the folder
  `c` at the root of the current drive to Windows itself. A read or a search is now compared with the
  protected set in both readings, and the shell scan matches a protected path on a drive written as
  `/c/...`, `/cygdrive/c/...` or `/mnt/c/...`; `cat /c/Users/x/.ssh/id_rsa` in a Git Bash shell named no
  protected path before. The write limits keep Windows' reading.
- Added: `LocalGateOptions.localNames` and `LocalGateOptions.realPath` (and the same two on
  `JailOptions`), with `machineNames` and `canonicalPath` exported to fill them: the names this machine
  answers to as a file server, and a path as the file system names it. `PeriscopeHost` passes both.
- Security: nothing a controller hands an opencode session's MCP servers is followed as a reference.
  opencode replaces `{file:path}` with a file's content, and `{env:NAME}` with a variable's value,
  in its configuration's text before it parses it, and a controller's MCP URL, headers, arguments and
  variables are in that text: on the pinned SDK a header naming a file was sent to its server as the
  file's content. The host now writes the text so it holds neither reference, and each value is
  parsed back as written.
- Security: an opencode `shell` call is decided before it runs, whole. The `shell` tool asks only about
  the commands the runtime's own reading finds in a line, so a line it finds none in ran with nothing
  asked: on Windows, a PowerShell assignment through a provider path writes a file that way. Each
  session's server is now created with one plugin of this host's, whose pre-call hook holds every
  `shell` call, a subagent's included, until the host's own gate and the controller have decided the
  whole line; refused, the call fails with the refusal's words and never runs. A call allowed there is
  asked about once: the requests it then raises are held to the host's own gate alone. The read-back
  admits that one plugin, by its id and its source.
- Fixed: a new run of an opencode or a Copilot session says the subagents settled in the run before
  stand no longer. The settled list was cleared and no `tasks` fact was sent, so a controller went on
  showing them until some later task moved. The cleared fact is sent once, and only when one had
  settled, as it is for a Claude, a Codex and a Qwen Code session.
- Fixed: a session home an opencode host left behind when it did not close its session is cleared by
  the next opencode session to open, its database kept for a resume first. It stayed under the base
  for good, and the session in it could not be resumed.
- Fixed: a closing opencode session's database replaces the older copy the base keeps without deleting
  it first, so a copy that fails leaves the older one for a resume.
- Fixed: an opencode host process is started with the one environment switch the pinned SDK reads,
  `OPENCODE_DISABLE_FREE_MODELS`. Four more were set that no file of the SDK reads; they did nothing and
  are gone, and the documents say what turns each of those things off (an option the server is created
  with, or the session's configuration).
- Fixed: an approval an opencode session's server takes from an answer this host did not give is named
  `gate-mode-widened` when the host is still deciding that request too, and the wait ends; it was named
  only when no decision was pending. An answer sent for a request the server had already settled (one
  refused with another, or dropped with an interrupt) is no longer reported as an answer that was not
  delivered.
- Fixed: the close of an opencode session ends what its commands started. The server's own close ends
  its shells and not their children, and the host process then exits by itself, so on Windows a process
  a background command had started was under nothing a tree kill could find, and outlived the session.
  The close now ends everything under the host process before it asks the process to exit.
- Fixed: an opencode request too large for one line is no longer lost. A line over 8 MiB from the host
  process was dropped whole and named nowhere, and an edit's request carries the whole text it writes,
  so a large write could wait unseen for good. The host process now cuts the longest texts of a line
  that would be too long, marking each cut, so the request arrives and is decided; a held `shell` call
  whose line is too long to send whole is refused by name; and a line that is dropped is named
  `rpc-line-too-large` on the session.
- Fixed: an opencode interrupt reaches the session's subagents. It reached the session's own run alone,
  and a subagent with a run under way went on, its pending decision with it. An interrupt now goes to
  every subagent session with a run under way and ends the decisions the session's sessions wait on.
- Fixed: an opencode request is decided whichever of the server's sessions raised it. One from a session
  the process did not see created was dropped, never decided and never named, and its call waited for
  good: after a resume that was every subagent of the earlier run, which the server restarts by itself
  as soon as it is created. A request raised before the open is proven now waits for the proof, one
  raised before the stream was read is found at the open, and a resumed session takes the earlier
  process's subagent sessions as its own.
- Fixed: an opencode call that ran with no decision is named however it leaves. It was named only when
  it succeeded; one that failed, was interrupted or was still running at the close was never named.
  The pre-call hook now tells the host of every call the server begins, so each is named
  `gate-hook-missing` when it leaves undecided, and a success the server states again to a resumed
  session for a call an earlier process ran is not named as this one's.
- Fixed: what the opencode gate keeps for a call is kept by its session and its id together. It was
  kept by the bare call id, so a subagent's call that shared an id with one of the session's could be
  decided on the other's input, or pass as decided when it was not.
- Added: `outcome` on an ended `compaction` fact, optional, on protocol 20: `completed` or `failed`
  (`COMPACTION_OUTCOMES`), where the source that ended the compaction says how it came out. A failed
  compaction was reported `ended`, the same as one that worked, and the fact had no member to tell
  them apart. Claude, Copilot, pi and opencode state it; Codex states neither and its fact carries no
  `outcome`. A controller on an older version ignores the member.
- Security: Claude's `Artifact` tool is in a family of the local gate. It publishes the local files its
  input names and saves the files it fetches, and it was in no family, so a credential file could be
  named as the page, as an upload or as the place a fetched file is saved and no local check read the
  path. Every path its input names is now held to the protected set, and to nothing else: the write
  limits do not bound it. `ToolFamilies` gains the optional `publish` family for an embedder's own
  such tools.
- Security: Claude's `Monitor` tool is a shell tool. It runs the command its input names, so the local
  gate reads that command as it reads `Bash`'s (a push, a protected path) and a decision request names
  it `shell` with the `posix` dialect; it reached the gate as `other` and its command was never read. A
  `Monitor` call that watches a socket runs no command and is `web`, since it opens a connection to an
  address the model chose. Only `Monitor` is read that way: a shell call of any other tool, on any
  runtime, that carries a `ws` and no command is refused `shell-command-missing` as before this
  release. Which shell `Monitor` runs on a Windows host whose shell tool is PowerShell is not measured.
- Security: the env floor holds the agent CLI's session-service credentials and remote route,
  `CLAUDE_CODE_SESSIONS_OAUTH_TOKEN`, `CLAUDE_BG_SESSION_CREDENTIAL` and `CLAUDE_CODE_REMOTE_SDK_URL`,
  so no controller can set them. A `PERISCOPE_CONTROLLER_ENV_KEYS` that declares one now refuses the
  start, by name.
- Security: the env floor holds `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS`, the agent CLI's
  switch that lets its dangerous `rm` commands run without a prompt in bypass mode, and nine more of
  its switches, each of which its own code shows turning off a prompt, a refusal or a trust check: the
  `rm` prompts (`CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT`, `CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT`,
  `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT`), `CLAUDE_CODE_DISABLE_POWERSHELL_CMD_RM_DENY`,
  `CLAUDE_CODE_DISABLE_EXPORTED_VARIABLE_PROMPT`, the trust switches (`CLAUDE_CODE_SANDBOXED`,
  `CLAUDE_BG_WORKSPACE_TRUSTED`, `CLAUDE_CODE_DISABLE_ULTRAREVIEW_TRUST_CHECK`) and
  `CLAUDE_BG_SESSION_PERMISSION_RULES`. No controller can set one. A `PERISCOPE_CONTROLLER_ENV_KEYS`
  that declares one now refuses the start, by name.
- Added: `parentId` on every conversation item (`AgentItem`), optional: the call that spawned the agent
  whose turn the item is from. A Claude subagent's messages now fill items, each naming its spawning
  call's `tool_use` id; an item of the session's own thread names none, which reads as null, so it is
  the item 1.10.0 sent. A link negotiated below 20 is sent no subagent's item, since its controller
  reads no parent: there they ride `agent_message` alone, as before.
- Added: what a task reported of itself, on each `tasks` entry, running or settled (`TaskReport`, all
  optional): the call that started it (`toolUseId`), its latest `summary`, its `usage` (`TaskUsage`:
  `tokens`, `toolUses`, `durationMs`, each optional and nullable, so a usage can state its tokens alone)
  and its `outputFile`, each stated only where the runtime reported it. Claude's are read from `task_started`, `task_progress` and `task_notification`; every text a
  Claude entry carries, its `description` included, is now cut at `MAX_FACT_TEXT_LENGTH`, on a code
  point boundary, where an over-long description made a frame the codec refused.
- Changed: a `tasks` fact is sent at once when a task starts, ends or changes its summary, and a change
  in a task's usage alone is sent at most once in five seconds for the session
  (`TASKS_USAGE_PACE_MS`). Every `task_progress` message re-sent the whole list on the lane that is
  never dropped, because a running subagent's usage moves with each one. Held figures go out with the
  first message after the pace and with the turn's result, and a task's end carries its last figures.
- Fixed: a `tasks` fact always fits a frame. Its lists are held to `MAX_TASKS_FACT_BYTES` on every
  runtime (`fitTasks`): text is cut first, the longest first, and entries are left out last, the oldest
  settled first. A session with many settled tasks made a fact past the frame limit, which the codec
  refused, so nothing about any task arrived for the rest of the turn; a Claude session's lists also
  had no entry bound.
- Added: every Claude session asks for its subagents' progress summaries (`agentProgressSummaries`): a
  running subagent states what it is doing about every 30 seconds, on its own model, and the summary
  rides its task's entry. Each summary is one more model call, so the operator can turn them off:
  `PERISCOPE_AGENT_PROGRESS_SUMMARIES=off` in the environment or the config file (a new config-file
  key; `on` is the default, any other word refuses start), or `agentProgressSummaries: false` on
  `PeriscopeHost` or `SessionRegistry`. No controller and no session can set it.
- Security: every Claude session is started refusing messages another session on the machine sends it
  (`crossSessionInbound: 'refuse'`). Unset, the CLI delivered one when the two sessions' modes matched,
  so a bypass-mode session elsewhere on the machine could reach a session this host runs in bypass.
  This host's own prompts are not that lane. The live probe of what the CLI does with a message that
  names another session (`mid-turn-delivery.live.test.ts`) now fails when the turn never ran, the
  message was not pushed mid-turn or the transcript was not found; it runs with the release's live
  probes.
- Fixed: a Claude compaction that fails ends. The status message that says so
  (`compact_result: 'failed'`) closes the compaction entry, so the `compaction` fact reports `ended`
  and the next compaction reports `started`; the entry stayed open, no `ended` was sent and the next
  `started` was suppressed. A compaction that succeeds still ends at its boundary, with its token
  counts.
- Changed: Codex is pinned at 0.169.0 (was 0.162.1); a binary that reports any other version, 0.162.1
  included, is listed unavailable by name, so the operator installs `@openai/codex@0.169.0` before a Codex
  session runs. `contracts/codex-protocol-names.json` is the 0.169.0 release's. Its two new
  notifications are declined: `thread/section/changed` is opted out at `initialize`, and
  `thread/readState/changed` is experimental. Its new client methods are not called.
- Changed: a Codex shell call's decision request carries the command's own working directory as its
  `cwd`, where it carried the session's: Codex 0.169.0 names a local shell call's working directory in its
  hook's input, and the call's input carries the command alone.
- Security: a Codex shell command that runs inside the protected set is refused there, whatever its
  command names: the local gate reads the directory a Codex shell call runs in as it reads a Qwen Code
  shell call's `directory` (`checksShellCwd`). Either directory is read in every spelling a path is: a
  relative one is placed under the session's directory, and one the call does not state is read as the
  session's. Neither is refused for its form, only for where it lands. The directory is read as text,
  as every path is: one that reaches the protected set through a link is not seen
  ([SECURITY.md](SECURITY.md) says what falls through).
- Security: a Codex command approval of the kind `humanCommand`, a command Codex's own requirements mark
  for a fresh decision, is decided fresh and never answered from the hook's decision for the same call.
  The app-server sends one only to a connection that opted into experimental API, which this host never
  does, and with none it refuses the call itself.
- Added: a Codex sub-agent's thread fills conversation items, each naming as its `parentId` the call
  that started the thread: the `collabAgentToolCall` that spawned or resumed it, or the `subAgentActivity`
  that started it, whose id is the spawning call's. A sub-agent's own spawn names its child the same way. A
  sub-agent that speaks before the call that spawned it reports it is held, a bounded while, and filled
  once the call names it; one no call names fills nothing. Its turns stay apart from the session's own: a
  sub-agent's turn ending moves none of the session's state and records no turn of the session's. As for
  Claude, a link negotiated below 20 is sent none of a sub-agent's items.
- Added: a Codex `tasks` entry names the call that started its sub-agent (`toolUseId`), and a settled
  entry carries the message Codex reported for its end as its `summary` (a completed agent's final
  answer, an errored one's error), cut at `MAX_FACT_TEXT_LENGTH` on a code point boundary. No `usage` is
  stated: a sub-agent's thread reports a token total, but one spawned with its parent's context
  (`fork_context`) counts on from the parent's running total, and nothing the host receives says which
  spawn did. Codex reports no output file for a sub-agent, so none is stated.
- Fixed: a Codex sub-agent's fragments name the call that started its thread and keep it: a later call
  about the same agent (a message, a wait, a close) no longer takes the parent over.
- Changed: Qwen Code is pinned at 0.27.3 (was 0.25.1); a CLI that reports any other version, 0.25.1
  included, is listed unavailable by name, so the operator installs `@qwen-code/qwen-code@0.27.3` before a
  Qwen Code session runs. `contracts/qwen-code-names.json` is the 0.27.3 release's: its new system message
  `mod_prompt` rides the native message only, its two new control requests (`get_workflow_mode`,
  `set_workflow_mode`) are never sent, and its new tool `autofix_pr` has an ask rule like every other and
  reads as `other`.
- Security: a Qwen Code session's settings deny `autofix_pr`, which runs the CLI's own pull-request helpers
  by name and so pushes a branch or posts a reply under a decision request no reading of a command
  recognises as a push. A deny outranks every scope's ask and allow, so no repository's rule turns it back
  on, and the read-back refuses the open `qwen-ask-rules-not-active` when the deny is missing. Turning it
  back on is a later release's change to `QWEN_DENIED_TOOLS`.
- Security: the read-back of a Qwen Code session's settings also refuses the open
  `qwen-ask-rules-not-active` when they do not keep code mode off (`tools.codeModeOnly: false`). Code mode
  is the only way the 0.27.3 CLI registers `exec`, whose script makes tool calls of its own, so no session
  is offered it.
- Added: a Qwen Code sub-agent's tool calls and their results, the only messages of a sub-agent the CLI
  writes, fill conversation items, each naming its spawning call's `tool_use` id as its `parentId`; a link
  negotiated below 20 is sent none of them.
- Added: a Qwen Code `tasks` entry names the call that started its task (`toolUseId`) where the CLI says
  which, and a settled agent task carries its `usage` (`tokens`, `toolUses`, `durationMs`) when the CLI
  reports all three counts. The CLI reports no summary and no output file for a task, so neither is
  stated.
- Fixed: a failing foreground Qwen Code sub-agent no longer ends the session's turn. When a foreground sub-agent
  fails or is cancelled the CLI writes a `result` of its own that names no call (the error subtype, no
  turns and no time); while the main thread's `agent` call is still open that `result` now moves none of
  the session's state, closes none of its tool entries, fills no turn item, records no `turn_record` and
  frees no queued prompt, where it errored the session and filed a zero running total. A background
  sub-agent writes no `result` of its own: the 0.27.3 CLI tells its end, a failure included, as a
  `task_notification`, which the `tasks` fact carries.
- Changed: pi is pinned at 1.5.2 (was 1.2.0); a CLI that reports any other version, 1.2.0 included, is
  listed unavailable by name, so the operator installs `@earendil-works/pi-coding-agent@1.5.2` (Node 22.19
  or later) before a pi session runs. `contracts/pi-names.json` is the 1.5.2 release's, and it names the
  same events, commands, records, dialogs, deltas and tools as 1.2.0's.
- Fixed: `scripts/derive-qwen-names.mjs` also reads the service modules the CLI's stream-json path
  imports, so the contract keeps `ui_log`, which the 0.27.3 CLI still emits from its mod session there.
- Added: GitHub Copilot as a fifth runtime. With `PERISCOPE_COPILOT_SDK` (a directory the operator
  installed `@github/copilot-sdk` 1.0.34 into, which pins the Copilot runtime 1.0.112) and
  `PERISCOPE_COPILOT_HOME` (a base of the runner's own) set, the hello's `agents` lists `copilot` after pi,
  at `intercepted-with-residual`, with its runtime and SDK versions, the permission modes `default` and
  `plan`, the efforts `low` to `max` and no thinking switch; its pack row is `bare`, `per-session`. A
  `session_new` naming `runtime: "copilot"` runs one Copilot runtime for the session, in a fresh home under
  the base, signed in as nobody until the host hands it a token. The read at start reads the install's
  files and starts nothing; an install that is absent, off the pin or missing this platform's runtime is
  listed unavailable with the reason.
- Added: the SDK is the operator's, never this package's. It is a development dependency at exactly
  1.0.34, for its types and the tests, and the published package neither carries nor resolves it: a
  session imports it from the operator's directory by path when it opens. `src/host/copilot-sdk.ts` is
  the one module that names it; its structural types are held to the SDK's own by a pin.
- Added: the Copilot gate joins the runtime's two halves. Its pre-tool hook answers `ask` for every
  call, at once, and the `hook` permission request that raises is decided by the gate every runtime
  shares, with one-time answers only and no input rewrite. A sub-agent's call takes the same route.
  Before the first prompt the runtime is read back (the `manual` permission mode, the agent mode asked
  for, no approve-all grant, no approved path, only the session's own directories, no plugin, none of
  the tools turned off) and one probe call is run through the hook and the request; an open that does
  not hold is refused with the new reason `copilot-gate-not-active`. Mid-session the gate names
  `gate-hook-missing`, `gate-hook-foreign`, `gate-unhooked-call` and `gate-mode-widened` with Copilot's
  meanings ([gate.md](docs/gate.md)); a machine-wide policy hook is named `gate-hook-foreign` at the open.
  The look asks the runtime itself which hooks it finds, on every platform, beside the host's own read
  of the Windows policy directory and key, and a source that could not be read is named as one that may
  hold a hook, never counted as none. A session's home also holds the runtime's cache directory on
  every platform (`COPILOT_CACHE_HOME`), so off Windows the runtime's caches no longer stay in the
  operator's own.
- Docs: [protocol.md](docs/protocol.md) says where a sub-agent's tokens are counted. A Codex
  sub-agent's are in no total a controller is sent; a Claude task's are already inside the session's
  `totals`, so its entry's `usage` is a part of that figure and is not added to it.
- Fixed: a state transition always fits a frame. A cause's `detail` was unbounded, and a failure whose
  own words ran past a frame made its transition one the codec refused, so the `errored` that carried
  it never arrived. Such a detail is now cut by as much as the transition is over and says it was cut;
  a transition that fits is sent as before.
- Fixed: a text or a word a fact carries is never cut inside a character that takes two code units.
- Fixed: a degrade past the 4096 a Codex, a Qwen Code, a pi or an opencode session's state lane keeps
  reaches the host's log, each time it occurs, as a Copilot session's does. It was dropped before
  anything heard of it.
- Fixed, in a Copilot session:
  - a degrade past the 4096 a session's state lane keeps reaches the host's log, each time it occurs;
    it was dropped before anything heard of it;
  - a call is decided on the arguments its pre-tool hook announced, and a permission request that
    carries others is named `gate-hook-missing` (the call is still decided);
  - an MCP call's item is named `mcp__server__tool` from the server and tool its own start event
    states, the first call to a server included;
  - a sub-agent's events no longer move the session's registers: its model change, mode change, skill
    and server lists leave the session's receipt alone, and its cache reads are reported on its own
    usage samples, not the session's;
  - a model provider named in more than 64 characters no longer makes that step's spend unsendable;
  - a command's exit code is stated when it is negative;
  - an SDK import that failed is tried again by the next session, without a restart;
  - a closing session's kept state replaces the older copy without deleting it first, so a move that
    fails leaves the older copy for a resume;
  - what the runtime writes to its standard error reaches the session's `onStderr` lane.
- Fixed: a Copilot decision is never held past `decisionTimeoutMs`. Learning an attached server's tool
  list, which a call's `mcp__server__tool` spelling is read from, ran before the decision's deadline
  began and could take 30 seconds a server. The tools are now learned at the open from the runtime's
  own list; a server that had listed none is asked inside the decision's deadline, for at most 10
  seconds or a quarter of it, and the wait ends with the decision.
- Added: a new degrade, `gate-tool-unnamed`. A Copilot session is offered every built-in the runtime
  has, and one the host's tables do not name reached the gate as `other`, in no family, with nothing
  said. It is now named once per tool, when the session opens or at its first call. The session opens
  and the call is decided like any other; nothing is refused or turned off for it.
- Added: `write_powershell`, `write_bash` and `manage_schedule` are turned off in every Copilot session:
  left out of its tools, read back absent at the open, and refused at the gate.
- Added: a Copilot session's `decisionTimeoutMs` may be at most 240,000ms, the wait the runtime was
  measured holding a permission request with no timeout of its own; a longer one is refused
  `gate-deadlines-inverted`.
- Security: a Copilot session signs in to `github.com` alone. The operator's token is given only when
  the runtime asks for that host, and `GH_HOST` is taken out of the runtime's environment as the GitHub
  token variables are, so a controller an operator lets set `GH_HOST` cannot have the token sent to a
  host of its choosing.
- Added: `PERISCOPE_COPILOT_SDK`, `PERISCOPE_COPILOT_HOME` and `PERISCOPE_COPILOT_TOKEN_FILE`, config-file
  keys never settable over the link. The token is read from the file when the runtime asks for it and
  handed over the SDK's pipe; an endpoint whose `runtimes` name `copilot` is the session's own provider,
  its key in the session's request. Neither is ever in the runtime's environment, from which every GitHub
  token variable and every `COPILOT_` variable are stripped.
- Added: Copilot's session events are covered name by name. `contracts/copilot-names.json`, derived by
  `scripts/derive-copilot-names.mjs` from an install of the release, lists the 158 events SDK 1.0.34
  declares; `COPILOT_COVERAGE` wires or declines each, and `AGENT_EVENTS` gains the 31 `copilot:` names its
  wired rows cause. A Copilot session's events ride as `agent_message` with `runtime: "copilot"`; its
  facts (`session_handle`, `agent_receipt`, a `turn_record` per model call and its totals at the end,
  unpriced, `usage_sample`, `tasks` for its sub-agents, `compaction`) and its items are lifted from them.
- Changed: the protected set gains the whole of `PERISCOPE_COPILOT_HOME`, `PERISCOPE_COPILOT_SDK` and
  `PERISCOPE_COPILOT_TOKEN_FILE`, and the operator's own `~/.copilot` and `COPILOT_HOME`; the agents'
  records gain Copilot's session states. `credentialPaths` and `agentTranscriptPaths` take the new
  options.
- Changed: `EXTRA_ENV_FLOOR` gains `COPILOT_*`.
- Changed: a search tool that names its roots in `paths` (Copilot's `grep` and `glob`), as one string or
  as a list, is read as searching under each of them, and a patch tool whose whole input is the patch
  (Copilot's `apply_patch`) is held to the files the patch names.
- Changed: an endpoint only Copilot reaches reports its `env` among its ignored members: Copilot reads
  its provider from the session, and the variables would reach the agent's shell.
- Added: opencode as a sixth runtime. With `PERISCOPE_OPENCODE_SDK` (a directory the operator installed
  `@opencode/sdk` 2.3.0 into) and `PERISCOPE_OPENCODE_HOME` (a base of the runner's own) set, the hello's
  `agents` lists `opencode` after Copilot, at `intercepted-with-residual`, with its SDK version, the
  permission modes `default` and `plan`, no efforts and no thinking switch; its pack row is `bare`,
  `per-session`. A `session_new` naming `runtime: "opencode"` runs one opencode server for the session, in
  a host process of its own and a fresh home under the base, and reaches a model only through an endpoint
  whose `runtimes` name `opencode`, over `openai-chat`. The read at start reads the install's files and
  starts nothing; an install that is absent, off the pin or whose release's server, core or client is of
  another version is listed unavailable with the reason.
- Added: opencode needs Node 24 or later. The SDK's own tree uses explicit resource management (`await
using`), which Node 22 cannot parse, so the SDK cannot load there at all. The host tests the syntax, never
  a version string, and on a Node that fails the test lists opencode unavailable, naming the Node and why.
  Everything else this package does still runs on Node 22, which stays the floor; the opencode tests that
  run the SDK skip on Node 22, saying why.
- Added: the SDK is the operator's, never this package's. It is a development dependency at exactly 2.3.0,
  for its types and the tests, and the published package neither carries nor resolves it: a session's host
  process imports it from the operator's directory by path. `src/host/opencode-sdk.ts` is the one module
  that names it; its structural types are held to the SDK's own by a pin that compiles a program of its
  own, since the SDK's declarations import one another without extensions, which this package's resolution
  does not follow, and reference a library that would change this package's own types.
- Added: each session's server runs in a host process this package starts (`dist/host/opencode-host.js`),
  with its own Node, no shell and no window, spoken to over its stdio; it opens no listener. Its environment
  is written whole, its home and data directories inside the session's home, and the session's
  configuration, an endpoint's key among it, crosses its stdin into its memory, never an environment, a
  file or a command line.
- Added: the opencode gate. Every session is created with rules that ask for every action and deny each
  tool this host turns off; every permission request the server raises, the session's own or a subagent's,
  is decided by the gate every runtime shares and answered once, `once` or `reject` with words. Before the
  first prompt the server is read back (the session's rules, every agent's, no saved approval, only the
  runtime's own plugins and none turned off, only the session's MCP servers, no configuration outside the
  session's home, no model but the endpoint provider's); an open that does not hold is refused with the new
  reason `opencode-gate-not-active`. Mid-session the gate names `gate-unhooked-call`, `gate-hook-missing`,
  `gate-mode-widened` and `gate-foreign-extension` with opencode's meanings ([gate.md](docs/gate.md)).
- Added: `execute` (Code Mode), `question`, `experimental_image_generate`, `browser`, the session, worktree
  and model-catalogue tools that run without asking, and the artifact and schedule tools are denied in every
  opencode session's rules, and refused at the gate; the browser, image, schedule, artifact and MCP-event
  plugins are turned off. The title opencode names a session with is turned off, so no model call is made
  outside a run, and every form the server raises (a web search's provider choice, an MCP server's request
  for input) is cancelled as it is raised, since no interface of this host answers one.
- Added: `PERISCOPE_OPENCODE_SDK` and `PERISCOPE_OPENCODE_HOME`, config-file keys never settable over the
  link. The agent's shell runs with the session's spawn environment, none of the operator's `OPENCODE_`
  variables, `NODE_OPTIONS` or this host's variables but `PERISCOPE_WORKTREE_*` among it.
- Added: opencode's events are covered name by name. `contracts/opencode-names.json`, derived by
  `scripts/derive-opencode-names.mjs` from an install of the release, lists the 100 events SDK 2.3.0's stream
  declares; `OPENCODE_COVERAGE` wires or declines each, and `AGENT_EVENTS` gains the 31 `opencode:` names
  its wired rows cause. An opencode session's events ride as `agent_message` with `runtime: "opencode"`; its
  facts (`session_handle`, `agent_receipt`, a `turn_record` per model call, its input uncached and priced
  only where opencode reports a cost above zero, `tasks` for its subagents, `compaction`) and its items are
  lifted from them.
- Changed: a decision its caller ends with words is refused `permission-decision-unavailable` with those
  words; any other abort keeps the words it had. On opencode, a request the runtime refused together with
  another this host refused is recorded so.
- Changed: the protected set gains the whole of `PERISCOPE_OPENCODE_HOME` and `PERISCOPE_OPENCODE_SDK`, the
  operator's own opencode data, configuration and state directories (under the home and under
  `XDG_DATA_HOME`, `XDG_CONFIG_HOME` and `XDG_STATE_HOME`), and opencode's machine-wide configuration
  directory; the agents' records gain opencode's session databases. `credentialPaths` and
  `agentTranscriptPaths` take the new options.
- Changed: `EXTRA_ENV_FLOOR` gains `OPENCODE_*`.
- Changed: an endpoint only Copilot or opencode reaches reports its `env` among its ignored members.

## [1.10.0] - 2026-11-11

Protocol 19; the window is `[18, 19]`, so a version-18 controller is still spoken to. Version 19 lets a
host serve several repositories and gives a session its own worktree of each it names; every member it
adds is optional and it adds no payload kind. A version-18 controller names no further repository, so
the members reach it only as unknown keys on kinds it already reads, and every frame it sends decodes
unchanged. A `session_new` that names no further repository is byte for byte the one 1.9.2 sent, and a
host serving its home repository alone sends the hello and the inventory it sent.

- Added: a session may write in more than its own directory. The local gate admits a write inside any
  of the session's roots, the protected set checked first, as before: its own directory; the temp folder
  this host's environment names (`TEMP`, then `TMP`, on Windows; `TMPDIR`, else `/tmp`, elsewhere), with
  its real path beside when it is spelled otherwise; and its own worktree of each further repository it
  named. A temp folder is no root when it would cover the home directory, a protected path, a workspace
  or a served checkout, or sit inside a workspace or a checkout. A refusal with one root reads as it
  always did; with more it names each. `JailOptions.writeRoots` and `LocalGateOptions.writeRoots`
  (optional) carry the further roots.
- Added: `PERISCOPE_REPOSITORY_ROOTS`, the repositories a host serves beside the one
  `PERISCOPE_REPOSITORY_ROOT` names: a path list in the platform's delimiter, at most `MAX_REPOSITORIES`
  (8), each an absolute git work tree named by its folder's name. A config-file key, settable over the
  link while no session is live or opening. The start refuses, by name, a list without both roots, an
  entry that is relative or no work tree, a name that cannot be a branch or a folder, two names whose
  variables collide, and the home repository's name or root. `PeriscopeHostOptions.repositories` is the
  embedder's form.
- Added: `session_new.additionalRepositories`, the further repositories a session also writes in. Each
  is provisioned, or attached to, at the session's workspace key under
  `<workspace root>/.repositories/<name>`, in the same turn as its own worktree; the session finds each
  path in `PERISCOPE_WORKTREE_<NAME>`, which this host sets and every controller is refused; each rides
  the session's transitions as `where.repositories` (`TransitionWhereRepository`). A name the host does
  not serve, the home repository's own name, or any name on a host serving no other is refused
  `repository-unknown`, a new reason, before anything is claimed; a name given twice is refused at the
  codec. A resumed session names its further repositories again and attaches to the worktrees there.
- Added: the hello's and the configure answer's `configuration.repositories`, one `HostRepository`
  (`name`, `root`, `defaultBranch`) per served repository, the home one first, held to
  `MAX_REPOSITORY_CATALOG_BYTES`; absent on a host serving its home repository alone.
  `MAX_REPOSITORY_NAME_LENGTH` bounds a name.
- Added: on a host serving several repositories, `workspace_list_result` lists every repository's
  worktrees, each entry naming its `repository` (null for the home one), and `workspace_release`, its
  entries and `WorkspaceReleaseFlags` take an optional `repository`; a path resolves through whichever
  repository's workspace holds it. A further worktree is in use while any session holding its key is
  live.
- Added: Codex's sandbox is handed each further worktree as a writable root, at start, in the thread's
  configuration and on every `workspace-write` turn, and on Windows the temp folder too, which its
  `workspace-write` otherwise admits only through `TMPDIR`. Off Windows a session naming nothing beyond
  its own directory starts Codex with the arguments 1.9.2 gave it. Claude is handed no further
  directory: the CLI reads plugin and marketplace settings from any directory it is given, so its
  writes there are the gate's to allow.
- Added: `WorkspaceProvider.workspaceRoot` and `WorkspaceProvider.defaultBranch` (optional, both
  providers); `WorkspaceEffects.realPath` (optional, on the node effects).
- Changed: the shell allow-list admits the local git that publishes nothing: `read-tree`,
  `checkout-index`, `show-ref`, `clone`, `archive` of a local tree, and `worktree add` beside
  `worktree list`. Still refused: `archive` with `--remote` or `--exec` in any abbreviation, every other
  `worktree` subcommand, every `config` write, `send-pack` and the push family.
- Changed: a command that opens with `NAME=value` words is also read with them stepped over, so
  `GIT_INDEX_FILE=x git read-tree HEAD` flows and `X=1 git push origin main` escalates as a push. The
  reading only adds refusals.
- Security: a heredoc fed to something that is neither a shell nor a data sink is read whole by the
  shell backstop, its `#` comments blanked, so a push written into an interpreter's script
  (`python - <<EOF … git push … EOF`) is recognised.
- Fixed: a relative `PERISCOPE_WORKSPACE_ROOT` or `PERISCOPE_REPOSITORY_ROOT` refuses the start by
  name, as the configuration document said it did; the start did not check it.
- Fixed: a workspace root given in a Windows short form (`C:/Users/RUNNER~1/…`) lists, guards and
  cleans its worktrees. git records a worktree under its long path, so the inventory listed nothing and
  a release deleted the branch the scheme names rather than the one the worktree is on.

## [1.9.2] - 2026-10-31

A security patch to the shell backstop: no wire or API change. Protocol 18; the window is `[17, 18]`, as in 1.9.1.

### Security

- The shell backstop reads an interpreter's double-quoted script as the shell hands it to the interpreter. Inside
  double quotes a POSIX shell turns `\\` into one backslash, so `bash -c "echo a\\ # ; git push origin main"` gives
  bash the script `echo a\ # ; git push origin main`: an escaped blank, a `#` inside its word, and then the push,
  which runs. 1.9.1 read the `#` as a comment and let it through; it is now refused as `git-push`, and the same shape
  is refused for `sh -c` and for an `az repos pr update … --status completed` merge. A runner whose controller
  classifies shell calls itself was already held on it; a local-only gate let it run.
- Unchanged: a real comment still hides what follows it, as the shell reads it. `bash -c 'echo a\\ # ; git push'` and
  `bash -c "echo a\\\\ # ; git push"` hand the interpreter a backslash pair, so the `#` opens a comment and nothing
  after it runs; both still flow.

## [1.9.1] - 2026-10-31

A security patch: no wire, API or behaviour change. Protocol 18; the window is `[17, 18]`, as in 1.9.0.

### Security

- The runtime dependencies' minimums rise so no install can resolve a version with a known advisory:
  `@modelcontextprotocol/sdk` `^1.32.2` (was `^1.30.0`) and `zod` `^4.6.7` (was `^4.4.3`).
- The lockfile moves the transitive runtime packages to their patched releases: `proxy-addr` (critical),
  `body-parser` (high), `fast-uri`, `ip-address` and `qs`. `npm audit --omit=dev` reports none.
- CI's gates job fails on any High or Critical advisory in the runtime dependencies
  (`npm audit --omit=dev --audit-level=high`). The dev toolchain's advisories are Dependabot's, which now opens
  their security updates on its own.

## [1.9.0] - 2026-10-22

Protocol 18; the window is `[17, 18]`, so a version-17 controller is still spoken to. Version 18 adds
paging to `repository_read` (an optional `offset` on the ask, an optional `nextOffset` on the answer)
and one refusal reason, `transcripts-not-served`, and no payload kind. A version-17 controller reads
the reason on kinds it already reads (`transcript_failed`, `bulk_failed`) as a reason it does not know;
`nextOffset` is never composed for a link negotiated below 18, so the answer it reads has the members
version 17's had; the cut lands on a character boundary where 1.8.2's could split one. Every frame it
sends decodes unchanged. The shell backstop reads more publish and
merge shapes: a runner whose controller classifies shell calls itself was already held on them; a
local-only gate, or one linked to a controller that does not, let them run.

- Changed: the runner no longer looks for, reads or keeps the agents' transcript files. `transcript_list` and `transcript_tail` still decode and are answered
  `transcript_failed` with the new reason `transcripts-not-served`, so an older controller's ask is
  answered by name and its channel keeps its sequence; a `bulk_request` whose `what` names the
  `claude-transcript:` namespace is answered `bulk_failed` with the same reason, before any resolver is
  asked. The repository and workspace reads refuse a path at or beneath an agent's session records
  with the same reason, whatever their root, on the lexical resolution and on the real path, so a
  root pointed at an agent's home or the user's home serves none of them; a listing of the directory
  that holds one names everything else in it and leaves the record out. The records are
  `agentTranscriptPaths`, verified against each pinned release's own source:
  - Claude Code's `projects` under the CLI's default home, under `CLAUDE_CONFIG_DIR` when set, and under
    the effective agent home, the homes whose credential files the protected set names;
  - Codex's `sessions` (the rollouts), `archived_sessions`, `history.jsonl` and
    `thread_history_1.sqlite`, under `~/.codex`, `CODEX_HOME` when set and the runner's own Codex
    home, the database also under `CODEX_SQLITE_HOME`;
  - Qwen Code's `projects` (the chats) and `tmp` (the prompt log and saved chats), under `~/.qwen`,
    `QWEN_HOME` and `QWEN_RUNTIME_DIR` when set, and the runner's own base's `runtime`;
  - pi's `sessions` under `~/.pi/agent` and `PI_CODING_AGENT_DIR` when set; the runner's own pi home is
    in the protected set whole. The
    hello's `configuration.transcriptsRoot` is always null, whatever configuration an embedder composes
    (a required member inside the window, so it is still sent). The agent home itself is unchanged: its
    credential files stay in the gate's protected set, and the hello still reports it.
- Changed: the bulk lane checks the file a resolver names against both of the read doors' fences
  before it posts it, on the lexical resolution and on the real path: a file at or beneath a protected
  path answers `bulk_failed` with `credential-path-denied`, and one at or beneath an agent's session
  records with `transcripts-not-served`, whatever the namespace. The lane is otherwise as it was:
  `BulkResolver`, `PeriscopeHostOptions.bulk`, `postBulk`, the `bulk-post` capability and the receipts
  behave as before, and an embedder's resolver still delivers through the bulk POST any other file it
  gives meaning to. The binary composes no resolver, so every other `bulk_request` to it answers
  `bulk-target-invalid`, as a host with no resolver always has.
- Deprecated: `TRANSCRIPT_PAGE_SIZE`, `TRANSCRIPT_WHAT_PREFIX`, the `transcript_list`,
  `transcript_list_result`, `transcript_tail` and `transcript_tail_result` types and builders;
  `PeriscopeHostOptions.transcriptsRoot`, never read and now fenced (a root given there joins the
  folders the read doors and the bulk lane refuse), and the `transcriptsRoot` member a reconfigure
  seam may return (`HostReconfigured`, kept as optional), ignored. `HostConfiguration.transcriptsRoot` is
  always null. The names the transcript reader exported through the host module (`listTranscripts`,
  `tailTranscript`, `resolveTranscriptPath`, `claudeTranscriptResolver`, `isMatchingUserEntry`,
  `transcriptsRootUnder`, `claudeProjectsRoot` and their three types) are kept and inert: the readers
  list nothing or refuse `transcripts-not-served`, and the path helpers still derive a path. Each goes
  at the next major version. `transcript-path-escape` stays in the vocabulary and is never raised.
- Added: `repository_read` pages, like `workspace_read`. `repository_read.offset` (optional; absent or
  null is 0) starts a page and `repository_read_result.nextOffset` (optional) says where the next one
  starts, null at the end of the file or at the new `MAX_REPOSITORY_FILE_BYTES` (512 KiB, beside
  `MAX_REPOSITORY_READ_BYTES`). Offset 0 is the head of a file of any size, the read version 17 made,
  with the cut on a character boundary where 1.8.2's could split one; the pages after it reach the
  bound, or at most three bytes past it when the last page carries a character that straddles it,
  and `truncated` stays "bytes remain". An offset
  past the end, past the bound or inside a character is refused `repository-read-failed`, naming why.
  The host honours an `offset` at either version; `nextOffset` is composed only for a link negotiated
  at 18 or above, so on a link at 17 the answer has the same members; the cut lands on a character
  boundary where 1.8.2's could split one. `repositoryRead` takes an optional `offset` and
  `repositoryReadResult` an optional `nextOffset`; `readRepositoryFile` takes an optional trailing
  `offset`, and `RepositoryText` gains `nextOffset`.
- Changed: the repository read and the workspace read cut a page through one reader. A byte is inside a
  character only when a UTF-8 lead byte at most three bytes before it claims it, so offset 0 is never
  refused, and a file in another encoding is served from offset 0 and walked by its `nextOffset` to
  the end. For the workspace read that changes only such a file: one whose first byte
  continues no character was refused at offset 0, and one with more continuation bytes than its lead
  byte claims could be refused at the `nextOffset` its previous page gave; UTF-8 text reads as before.
  A repository head read asked for fewer bytes than its first character now carries that character
  whole (at most three bytes over `maxBytes`), where it answered empty text, because a page must make
  progress.
- Added: `agentTranscriptPaths(env, { agentHome, codexHome, qwenHome })`, beside `credentialPaths`,
  and `PeriscopeHostOptions.transcriptPaths`, which the read doors and the bulk lane refuse; absent,
  the host computes it from the process environment. `listRepositoryDirectory`, `readRepositoryFile` and `readWorkspaceFile`
  take it as an optional trailing parameter.
- Fixed: an agent home written over the link (`host_configure`) is pending until the next start, as
  the two controller URLs are: it is written to the config file and named in `pendingRestart` in the
  answer and every hello, and the protected set keeps the agent home the host started with. Applied
  live, the host ran with a home whose credential files the protected set did not yet name, since a
  session's gate keeps the set it opened with.
- Changed: `defaultAgentHome` is defined in the host's paths module; its export and behaviour are
  unchanged.
- Fixed: a repository read with `maxBytes` of 8 KiB or more could end inside a multibyte character,
  whose bytes before the cut decoded as a replacement character: the cut was stepped back only over
  bytes read past it, and at that size none were. The cut now lands on a character boundary, as the
  workspace read's always did, so such a page carries up to three bytes fewer and no replacement
  character; the default `maxBytes` (48 KiB) is in that range.
- Fixed: a `#` after a backslash-escaped blank is part of the word, as a POSIX shell reads it, so the
  command after it is classified. `echo a\ # ; git push origin main` refuses as `git-push`, inside
  `bash -c "…"` too, where the comment stripper took the `#` for a comment and the push flowed. The
  escaped reading only adds refusals, and a backslash before a quote is still not read as an escape, so
  `echo \" # " ; git push origin main` keeps refusing.
- Fixed: a POSIX command word is read after quote removal, as bash reads the name it runs, so
  `g''it push origin main`, `"g"it push origin main` and `g\it push origin main` refuse as `git-push`
  and `b''ash -c "git send-pack origin main"` inverts as `bash -c` does. Inside a double-quoted span a
  backslash escapes `"`, `\`, `$` and a backtick, so `echo "a \" # " ; git push origin main` reads the
  push, inside `bash -c "…"` too. Both are read in the escaped reading, beside the split one, so they
  only add refusals: the split reading keeps a backslash as a path separator (`C:\Git\bin\git.exe` is
  git there), and outside a quote a backslash before a quote is still not an escape.
- Fixed: completing an Azure DevOps pull request is held in four more forms: a quoted option name
  (`az repos pr update --id 5 "--status" completed`), a repeated option where any occurrence completes
  (`--status active --status completed`, as `az` keeps the last), a word that starts with `-` and holds
  no space once its quotes are removed ending a `--description` run
  (`--description "notes" "--status" completed`, while `"- fixed it"` stays prose), and the `.cmd` and
  `.bat` shims below.
- Fixed: a program named through `.cmd` or `.bat`, in any case, is that program, as one named through
  `.exe` is. `az.cmd`, `git.cmd`, `git.bat` and `gh.cmd` are read by every rule:
  `git.cmd push origin main` refuses as `git-push`, `gh.cmd pr merge 5` as `gh-pr-merge`, and the verb
  allow-list reads `git.cmd`. A shim's prose and data are read as its program's are, so these flow where
  they refused: `az.cmd repos pr create --description "git push origin main"`,
  `gh.cmd pr create --body "git push origin main"`, `git.cmd commit -m "git push origin main"`, a
  heredoc into `git.cmd commit -F -`, and a heredoc into `cat.cmd` or `tee.bat`. Behind a launcher a shim
  does not take a git word after it out of the allow-list.
- Fixed: a command word an expansion supplies is read as the program the command line names for it: a
  substitution of `echo`, `printf`, `which`, `command`, `type` or `where` whose last word is the name
  (`$(echo git) push origin x`, `` `echo git` push ``, `"$(which git)" push`, `$(command -v gh) pr merge 5`),
  or a variable the line assigned earlier (`G=git; $G push origin main`, `export G=git && $G push`). That
  word is read by both layers, as the program written out is, and only once every other reading has
  flowed, so it adds a refusal where nothing else refuses and never changes the reason of one. An
  expansion whose program the line does not name is not guessed and flows as before: `$DOCKER push`,
  `$(which docker) push img`, `$1 push`, `"$@" push`, `$X reset --hard`, `$PKG branch -d x`,
  `g$(echo it) push`. Only a POSIX reading reads one: PowerShell takes a line that starts with `$(…)` or
  `$G` for an expression, and `cmd` expands neither. In that reading a redirection's word names a file
  and `do`, `then`, `else` and `elif` open a command only as its first word, so `G=git; echo hi > $G`
  and `G=git; echo then $G push` flow and `> out $(echo git) push origin main` refuses as `git-push`.
  `docs/gate.md` lists the shell shapes that flow.
- Fixed: a git command named inside another program's words reads git's `-c key=value` as `-c`'s pair,
  so the verb after it is read: `ssh h "git -c user.name=x push origin main"` and
  `docker exec c git -c a=b push origin main` refuse as `git-push`, as `git -c a=b push origin main`
  does at a command position, and a branch deletion, a hard reset and remote surgery behind a `-c` pair
  refuse under their rules.
- Fixed: a `git branch` option's value is its value. `ssh build-host "git branch --sort=-committerdate"`,
  `git branch --sort -committerdate`, `git branch --contains -d topic` and `--format=-d` inside another
  program's words flow, where `git-branch-delete` refused them. A deletion cluster is made of
  `git branch`'s own short options: `-dr`, `-rD` and `-fd` still refuse, and `-dx`, an unknown switch to
  git, flows. In another program's words an option's `=value` stays its value, so
  `ssh build-host git --exec-path=/x push origin main` refuses as `git-push`.
- Added: `scripts/classifier-diff.mjs` (not shipped, and run by hand: nothing in `package.json` or CI
  runs it) classifies one corpus with two builds, prints every answer that moved, and checks named
  controls against the later build, exiting 1 when one does not hold: 40 that must flow (expansions
  whose program the line does not name, `$(echo git) push` in the PowerShell and `cmd` readings, a
  redirection's word, a Windows path to a read) and 8 that must refuse (`git push`, `gh pr merge`,
  `az repos pr update --status completed`, `git branch -D`, `git reset --hard`, `git remote add`,
  `git send-pack`, and `git push` inside `ssh`'s words). Against 1.8.2, over 37,155 commands in the
  POSIX, PowerShell and `cmd` readings, 1,380 answers changed, each in a form above, and all 48 controls
  hold. 1,322 flow to refused: 945 through a `.cmd` or `.bat` shim (873 of them on the allow-list, each
  with a git shim word); 303 a command word an expansion supplies whose line names git, `gh` or `az`, in
  the POSIX reading (271 on the allow-list, `$(echo git) send-pack origin main` among them); 23 a command
  word read after quote removal; 17 the four `az` forms; 15 a `-c` pair inside another program's words;
  12 an escaped blank before a `#`; 3 an escaped quote inside a double-quoted span; 3 the `--exec-path=`
  push; and 1 a redirection before a named command word. 48 refused to flows: 11 `git branch` option
  values and clusters in each of the three readings, and 15 shim forms whose prose or data is now read
  as their program's: `az.cmd`'s description, `gh.cmd`'s body, and `git.cmd`'s and `git.bat`'s
  messages in each reading, and the heredocs into `cat.cmd`, `tee.bat` and `git.cmd commit -F -` in the
  POSIX reading. 10 allow-list refusals keep their reason and name `git.cmd`'s verb in the detail.
- Docs: `SECURITY.md` states the limit as its own bullet ("Not transcripts.") and the repository read's
  paging; the README, configuration, architecture, gate and protocol documents and the reference
  controller (which no longer offers the transcript asks as doors) follow, and the documents name the
  agent's own session files in neutral words.

## [1.8.2] - 2026-10-21

No wire or API change: the protocol, the window `[16, 17]` and the public exports are as they were, so a
runner on 1.8.2 links to every controller a 1.8.1 runner links to.

- Fixed: the shell backstop's boundary rules read the parsed invocation — the program, its subcommand and
  its option tokens — instead of a word anywhere in the command, so a word inside a path no longer
  completes a rule. `git diff -- src/app/fields/edit-remote-work` and `git status && tail logs/pre-push.log`
  flow, where `git-remote-surgery` and `git-push` refused them; `git status && git push origin main` still
  refuses. A command named inside another program's words (`ssh host "git push"`, a pager set with
  `git -c core.pager=…`) is still read and still refuses. The rule names are unchanged.
- Fixed: both layers read git wherever it runs. Behind a launcher (`env`, `sudo`, `doas`, `nohup`,
  `nice`, `ionice`, `time`, `timeout`, `stdbuf`, `command`, `exec`, `xargs`, `watch`, `start`) git is
  read as git, and git's dashed binaries (`git-push`, `.../git-core/git-send-pack.exe`) read as git with
  their subcommand. `env git send-pack origin main` and the dashed `git-send-pack.exe` were classified as
  benign shell and are now refused by the verb allow-list.
- Fixed: a POSIX command with a backslash-escaped space is also read as a POSIX shell reads it, the
  escaped space joined into its word, and refused when either reading refuses. So
  `C:/Program\ Files/Git/mingw64/libexec/git-core/git-send-pack.exe origin main`, one path to bash, refuses
  as its quoted form does. The second reading only adds refusals; PowerShell and `cmd` read a backslash
  as an ordinary character and are read as before.
- Added: completing an Azure DevOps pull request is a boundary beside `gh-pr-merge`.
  `az-repos-pr-complete` holds `az repos pr update` with a status other than `abandoned` or `active`, and
  `az repos pr create|update` with `--auto-complete` set to anything but `false`; a bare option or a
  value that could expand holds too. `az repos pr list` and `show`, an abandon, and `--auto-complete false`
  flow. The title, the description (every word up to the next flag), `-d` and the merge message of
  `az repos pr create|update` are prose, as a commit message is. A raw REST call (`az rest`,
  `az devops invoke`) is not parsed, as a raw `gh api` call is not.
- Fixed: read-only git that publishes nothing flows: `git for-each-ref`, `git merge-tree`, `git worktree
list`, a bare `git config section.key` read, and git 2.46's `git config get` and `git config list`.
  `git worktree add`, `remove`, `prune`, `move` and `lock`, `git config edit`, `set`, `unset`,
  `rename-section`, `remove-section` and a value still refuse.
- Fixed: a branch deletion refuses in a short cluster (`git branch -dr`) and an abbreviated long option
  (`--del`), and a hard reset as `--har`.
- Fixed: a session the host opened is held to the start timeout from its first turn, as
  `registry.open()` holds one: an agent given a turn that never reports itself ends `start_timed_out`
  instead of sitting in `spawning`. A session never prompted, the interactive session a controller opens
  for a person to type into, is not ended. `docs/state-machine.md` says so.

## [1.8.1] - 2026-10-14

No wire or API change: the protocol, the window and the public exports are as they were.

- Fixed: the shell scan reads a protected path named through a variable of the session's spawn
  environment. Each variable whose value is one absolute path is spelled out before the scan, written
  `$NAME`, `${NAME}`, `$env:NAME`, `${env:NAME}` or `%NAME%`, its name read as each shell reads it:
  the homes this host sets for Codex, Qwen Code and pi (`CODEX_HOME`, `QWEN_HOME`,
  `QWEN_CODE_SYSTEM_SETTINGS_PATH`, `PI_CODING_AGENT_DIR` and their kin) and the variables it passes
  through (`USERPROFILE`, and `CLAUDE_CONFIG_DIR` when it is set). So each of
  `cat "$QWEN_CODE_SYSTEM_SETTINGS_PATH"`, `cat "$PI_CODING_AGENT_DIR/models.json"`,
  `Get-Content "$env:CODEX_HOME\auth.json"` and `cat "$USERPROFILE/.env"` is refused
  `credential-path-denied`, as the literal path is. A command that only shows such a variable is
  refused like one that mentions the path (`echo "$PI_CODING_AGENT_DIR"`). The home forms gain
  PowerShell's braced `${env:HOME}` and `${env:USERPROFILE}`. A session composed by hand scans the
  home forms only: the variables reach the local gate through `PeriscopeHost`'s own composition.
  `SECURITY.md` and `docs/gate.md` name what the scan still cannot see.
- Fixed: a Codex session's `CODEX_HOME` is excluded from the agent's shell, beside the hook's and
  the endpoint's variables; the app-server and its hooks still receive it.
- Fixed: a Codex prompt longer than Codex takes is answered as not taken (`prompt()` returns false),
  and is still named in the host's log.
- Fixed: periscope's own Codex hook is recognised by its whole line, its POSIX line for any Node and
  any install of this package or its shim in the runner home. A foreign hook that only contains its
  words, or a shim of the same name elsewhere, is kept in the hooks file rather than replaced.
- Changed: the wire vectors that list Codex (`link_hello.agents-codex.json`,
  `link_hello.agents-qwen-code.json`, `link_hello.agents-pi.json`, `link_hello.agent-skills.json`)
  state its tier as its hello does, `intercepted-with-residual`.
- Changed: `SECURITY.md` names the Codex gate's own code (`dist/bin/periscope.js` and the Node
  binary, run from disk on every call) as outside the protected set, and Codex's coverage row says a
  resumed or forked thread's totals include its source thread's tokens. The docs say that Codex and
  pi read no `strictMcpConfig`, that pi's spawn exit ends a session `process/process_failed` with
  pi's last line, that Qwen Code with no endpoint exits before it answers `initialize`, and that
  version 17 adds pi's words beside Qwen Code's.
- Changed: the test MCP server records every request's headers, so a live probe reads a ticket back
  as it arrived.

## [1.8.0] - 2026-10-14

Protocol 17; the window is `[16, 17]`, so a version-16 controller is still spoken to. Version 17 adds
two runtimes, their causes, refusal reasons and a dialect word, and no payload kind or member. A
version-16 controller reads a runtime as a word, a cause unnarrowed and a reason it does not know as
such; the one word it does not declare, the dialect `cmd`, is never sent to it: a decision request
naming it goes to a controller at 16 with no `shellDialect`. Every frame it sends decodes unchanged.

- Added: Qwen Code as a third runtime. With `PERISCOPE_QWEN_BIN` (the npm package's `cli-entry.js`)
  and `PERISCOPE_QWEN_HOME` (a base of the runner's own) set, the hello's `agents` lists Qwen Code
  after Codex: its version, no models, the permission modes `bypassPermissions`, `default` and
  `plan`, the efforts `low` to `max`, no thinking control, and the tier `intercepted-with-residual`;
  `agentSkills` lists it `bare`, `per-session`. A `session_new` naming `runtime: "qwen-code"` runs the
  CLI over its stream-json control protocol on stdio, in the session's directory, from a home of its
  own beneath the base. The CLI is pinned to Qwen Code 0.25.1: another version or an absent CLI is
  listed unavailable with its reason, and a session naming it is refused `runtime-unavailable`. Its
  messages ride as the CLI wrote them, with `runtime: "qwen-code"`, a `stream_event` on the delta
  lane; its events move the session as `qwen-code:*` causes (`AGENT_EVENTS` gains sixteen), it fills
  the facts and the conversation items, and `QWEN_COVERAGE` holds every name the pinned release
  declares (`contracts/qwen-code-names.json`, derived by `scripts/derive-qwen-names.mjs`).
- Added: Qwen Code's gate. Each session's settings sit at the CLI's system scope and send every
  built-in tool, and every attached MCP server's, to ask, with every hook off; the CLI asks the host
  before each such call, and the host decides it through the same per-call decision as a Claude call
  and answers as asked, never rewritten. The settings are read back before the CLI starts, and an open
  whose settings do not read back that way is refused with the new reason
  `qwen-ask-rules-not-active`. The new degrades `gate-tool-unruled` (a tool no ask rule names) and
  `gate-mode-widened` (a mode that approves calls itself) ride the state lane, and
  `gate-credential-in-shell` (a variables file the CLI loads, or an endpoint's variables, reaching the
  agent's shell) rides the opening tier. A Qwen Code session whose `decisionTimeoutMs` leaves no room
  inside the CLI's own ten-minute bound is refused `gate-deadlines-inverted`.
- Added: model endpoints for Qwen Code. An endpoint whose `runtimes` name `qwen-code` may speak any
  of the three wire APIs; its key is written into the session's settings file alone, never the CLI's
  environment or command line.
- Added: `cmd` in `SHELL_DIALECTS`, the grammar of a shell call Qwen Code runs through `cmd.exe` on
  Windows, and its reading in the local gate (carets unescaped outside double quotes, no comment, no
  heredoc). A Qwen Code session's command is read in its dialect and as POSIX, and refused when either
  reading refuses. `LocalGateOptions` gains `checksShellDirectory`, which holds the directory a
  command runs in to the protected set.
- Added: `PERISCOPE_QWEN_BIN` and `PERISCOPE_QWEN_HOME`, config-file keys never settable over the
  link; one without the other refuses start. The host reads Qwen Code's version once at start and
  prints one `[qwen-code]` line.
- Changed: the protected set gains every Qwen Code session's home, Qwen Code's sign-in, token,
  extension-secret, settings and variables files in `~/.qwen` and in an operator's `QWEN_HOME`, and
  `~/.env`, which Qwen Code loads whatever its home. `~/.env` is protected on every host, so a Claude
  or Codex session is now refused reading it too. `credentialPaths` takes `qwenHome`.
- Changed: `EXTRA_ENV_FLOOR` gains `QWEN_*`, `OPENAI_MODEL`, `GEMINI_*`, `GOOGLE_API_KEY`,
  `GOOGLE_MODEL`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_GENAI_USE_VERTEXAI`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `DASHSCOPE_*`, `BAILIAN_*` and `OPENROUTER_API_KEY`. A
  `PERISCOPE_CONTROLLER_ENV_KEYS` that declares one now refuses start, a `session_new` whose `env`
  names one refuses `env-key-refused`, and a repository settings file whose `env` names one refuses
  `settings-route-refused`.
- Changed: `CONTROL_TIERS`, `RUNTIME_WIRE_APIS` and `AGENT_SKILLS` gain a `qwen-code` row, and
  `SessionObserver` gains `observeQwenMessage`.
- Added: pi as a fourth runtime. With `PERISCOPE_PI_BIN` (the npm package's `dist/bundle/cli.js`)
  and `PERISCOPE_PI_HOME` (a home of the runner's own) set, the hello's `agents` lists pi after Qwen
  Code: its version, the models it reaches as `provider/id`, no permission modes, the efforts
  `minimal` to `max`, a thinking control, and the tier `intercepted`; `agentSkills` lists it `bare`,
  `per-session`. A `session_new` naming `runtime: "pi"` runs pi in RPC mode on stdio, in the
  session's directory, from the home's own agent directory. pi is pinned to 1.2.0: another version or
  an absent CLI is listed unavailable with its reason, and a session naming it is refused
  `runtime-unavailable`. Its events, records and answers ride as pi wrote them, with
  `runtime: "pi"`, a `message_update` on the delta lane; its events and the host's commands move the
  session as `pi:*` causes (`AGENT_EVENTS` gains twenty), it fills the facts (its spend as pi's own
  running totals, `catalogue-estimated`) and the conversation items (a turn from `agent_start` to
  `agent_settled`), and `PI_COVERAGE` holds every name the pinned release declares
  (`contracts/pi-names.json`, derived by `scripts/derive-pi-names.mjs`).
- Added: pi's gate. pi has no permission system, so the package ships an extension pi loads
  (`dist/host/pi-extension.js`, neither a command nor an entry point) whose handler asks the host
  about every tool call over the session's hook channel, runs after pi's own handlers, and blocks the
  call on a deny, its own deadline, an interrupt or a reply that does not verify; an allow may rewrite
  the input. pi starts under a launch rule that loads nothing of its own finding, and no prompt is
  written until the extension says hello: an open where it does not, or where pi will not load it, is
  refused with the new reason `pi-extension-not-active`. Code found at the open that this host did
  not load is named by the new degrade `gate-foreign-extension` and lowers the opening tier to
  `intercepted-with-residual`. pi's own `bash` command is refused.
- Added: model endpoints for pi. An endpoint whose `runtimes` name `pi` may speak any of the three
  wire APIs; it is written into pi's `models.json` as a provider, its key in that file alone, never in
  pi's environment or on its command line. An endpoint with variables of its own sets them in pi's
  environment, and a session opened on it names them `gate-credential-in-shell` at the residual tier.
- Added: `PERISCOPE_PI_BIN` and `PERISCOPE_PI_HOME`, config-file keys never settable over the link;
  one without the other refuses start. The host reads pi's version and models at start and prints one
  `[pi]` line.
- Changed: the protected set gains the whole of `PERISCOPE_PI_HOME` (pi's agent home, its session
  store and every session's run directory), and pi's sign-in, MCP token and models files in
  `~/.pi/agent` on every host. `credentialPaths` takes `piHome`.
- Changed: `EXTRA_ENV_FLOOR` gains `PI_*`, `PERISCOPE_PI_EXTENSION_CONFIG`, the provider names pi
  reads (`ANT_LING_API_KEY`, `DEEPSEEK_API_KEY`, `NVIDIA_API_KEY`, `COPILOT_GITHUB_TOKEN`,
  `MISTRAL_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, `AI_GATEWAY_API_KEY`,
  `OPENCODE_API_KEY`, `RADIUS_API_KEY`, `TYPESAFE_API_KEY`, `HF_TOKEN`, `FIREWORKS_API_KEY`,
  `TOGETHER_API_KEY`, `BASETEN_API_KEY`, `KIMI_API_KEY`, `META_API_KEY`, `MOONSHOT_API_KEY`,
  `GOOGLE_CLOUD_API_KEY`, `GCLOUD_PROJECT`) and the families `ZAI_*`, `MINIMAX_*`, `XIAOMI_*`,
  `AZURE_OPENAI_*`, `AWS_*` and `CLOUDFLARE_*`. A `PERISCOPE_CONTROLLER_ENV_KEYS` that declares one
  now refuses start, a `session_new` whose `env` names one refuses `env-key-refused`, and a
  repository settings file whose `env` names one refuses `settings-route-refused`. The floor holds for
  every runtime, so neither a controller nor a repository's settings can now set `AWS_*` for a Claude
  session either; a value in this host's own environment still passes as before.
- Changed: `CONTROL_TIERS`, `RUNTIME_WIRE_APIS` and `AGENT_SKILLS` gain a `pi` row,
  `SessionObserver` gains `observePiMessage` and its `stateSpawnDegrades` takes the level the
  opening tier drops to, and `LocalGateOptions` gains `resolvesWritesAgainstCallCwd`, which places a
  relative write path where the call runs.
- Fixed: a `session_configure` that arrives while its session is still opening is refused
  `session-unknown` at once, and once the session opens the refusal is recorded on that session's own
  state lane, so the controller hears it there; nothing is applied.

## [1.7.0] - 2026-10-13

Protocol 16; the window is `[15, 16]`, so a version-15 controller is still spoken to. Version 16
adds a runtime, a cause kind, a preset value and refusal reasons, and optional members only: the
conversation item stream's `agent_item` body, the hello's `agentSkills`, three fact members and the
decision request's `shellDialect`. A
version-15 controller reads a transition's cause unnarrowed, a runtime as a word, the preset as a
value of a member that already carries any JSON, and a reason it does not know as such; it leaves an
`agent_item` body alone as an update it does not model and carries the other members without reading
them; every frame it sends decodes unchanged.

- Added: Codex as a second runtime. With `PERISCOPE_CODEX_BIN` and `PERISCOPE_CODEX_HOME` set, the
  hello's `agents` lists Codex after Claude (its version, the models its app-server lists, the
  permission modes `default`, `dontAsk` and `bypassPermissions`, its efforts, `thinking` when a
  listed model takes `none`, and its control tier), and a `session_new` naming
  `runtime: "codex"` runs `codex app-server` over stdio in the session's directory. The binary is
  pinned to Codex 0.162.1: another version, an absent binary or a home with no sign-in is listed
  unavailable with its reason, and a session naming it is refused `runtime-unavailable`. A Codex
  session's messages ride as its app-server sent them, with `runtime: "codex"`, the text deltas on
  the delta lane, and its facts are lifted as Claude's are.
- Added: the cause kind `agent-event`, whose events are a runtime's own notifications named
  `{runtime}:{native name}` (`AGENT_EVENTS`, exported with `AgentEventName`). A Codex session moves
  by them: `codex:thread/started` makes it `ready`, `codex:turn/started` and `codex:turn/completed`
  bound a turn.
- Added: the `runtime-default` preset for `session_new.request.systemPrompt`,
  `{ type: 'preset', preset: 'runtime-default', append? }`: every runtime keeps its own base
  instructions and adds the append (Claude's `claude_code` preset; Codex's developer instructions).
- Added refusal reasons: `rpc-line-malformed`, `rpc-line-too-large`, `rpc-request-timed-out`,
  `rpc-request-failed` and `rpc-server-overloaded`, for a runtime's JSON-RPC peer.
- Added: `request-key-unsupported` is raised. A Codex session naming a member that is Claude's alone
  (`settingSources`, `forwardSubagentText`, the `claude_code` preset) or a value Codex's vocabularies
  lack is refused before anything is spawned, naming the member.
- Added: the conversation item stream. Every Claude and Codex session's conversation also rides the
  update lane as `agent_item` bodies, `{ update: 'agent_item', runtime, item, observedAt? }`, read
  through `readAgentItem`: a turn's start and end, the prompt, the agent's text and thinking, each
  tool call and its result, the plan, and the notices the runtime reports, one shape for every
  runtime (`AgentItem`; `TURN_ITEM_STATUSES`, `TOOL_RESULT_STATUSES`, `FILE_CHANGE_KINDS`,
  `NOTICE_LEVELS`). Each is reported, never synthesized; an item past `MAX_AGENT_ITEM_BYTES` (32 KiB)
  is cut and says so in `truncated`, and a tool call's input is left out whole rather than cut. Every
  frame a Claude session sent before is unchanged; the native messages ride beside the items. Only
  the session's own thread fills items.
- Added: the hello's `agentSkills`, one `HostAgentSkills` per runtime that takes plugin directories:
  how it names their skills (`SKILL_NAMINGS`) and when it takes them (`SKILL_DELIVERIES`). Claude is
  `namespaced` and `per-session`, Codex `namespaced` and `per-process`.
- Added: three fact members. `tasks.settled` lists the tasks ended since the turn began, each with how
  it ended (`TASK_SETTLEMENTS`: `completed`, `failed`, `stopped`); `usage_sample.cacheReadTokens` is
  the tokens a call read from the cache; `agent_receipt.effortReported` says whether the runtime's
  report stated an effort at all, so a null `effort` can be read.
- Added: a Codex session takes its plugin directories and MCP servers. The directories reach its
  app-server as skill roots before its thread opens, so their skills list as `plugin:skill`; one that
  is not there is named among the receipt's `pluginErrors`, and Codex refusing the roots ends the open
  with the new refusal reason `plugins-undeliverable`. MCP servers ride the thread's config, an HTTP
  server's headers as static headers, never in the app-server's environment or on its command line;
  a server Codex has no form for is refused `mcp-descriptor-invalid`. Each server's tool calls are
  asked about first, and the session's gate decides each ask.
- Added: model endpoints for Codex. An `openai-responses` endpoint whose `runtimes` name `codex` is
  offered to Codex in the hello, and a Codex session naming it opens on a provider of its own,
  defined in its thread's config under an id the host derives from the endpoint's name, its key read
  from `PERISCOPE_CODEX_ENDPOINT_KEY` in the app-server's environment and kept from the agent's shell,
  its window from `contextWindow`. On an endpoint only Codex reaches, Claude's rules (the model tiers,
  the first-party marker, `model-endpoint-mismatch`) do not apply; a stated `modelAliases` or
  `firstParty` is ignored and reported once as a `endpoint-members-ignored` host event.
- Changed: the endpoint boot refusal for a runtime outside the routed set names it as one "this host
  routes no model endpoint for"; the routed runtimes are Claude and Codex, and the hello lists a
  runtime on an endpoint only where it speaks the endpoint's wire API.
- Changed: a Codex session's credential variables are excluded from the agent's shell by exact name
  (`shell_environment_policy.exclude`), the form Codex matches: as a glob, without regard to case.
- Added: `PERISCOPE_CODEX_BIN` and `PERISCOPE_CODEX_HOME`, config-file keys never settable over the
  link: both or neither, each absolute, and the binary not a batch file, or start is refused. The
  host reads Codex once at start, bounded at 20 seconds, and prints one `[codex]` line.
- Added: Codex's sign-in files (`auth.json`, `.credentials.json`) in the runner's Codex home and in
  `~/.codex` join the protected set; `credentialPaths` takes `codexHome`.
- Changed: `EXTRA_ENV_FLOOR` gains nine exact names: `CODEX_HOME`, `CODEX_SQLITE_HOME`,
  `CODEX_OSS_BASE_URL`, `CODEX_OSS_PORT`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_ACCESS_TOKEN`,
  `CODEX_CA_CERTIFICATE` and `PERISCOPE_CODEX_ENDPOINT_KEY`. A `PERISCOPE_CONTROLLER_ENV_KEYS` that declares one now refuses start,
  a `session_new` whose `env` names one refuses `env-key-refused`, and a repository settings file
  whose `env` names one refuses `settings-route-refused`.
- Changed: the hello's runtimes list places Claude's entry first, and a later entry that would push
  the list past its byte budget rides with `models: []` and a `runtime-catalog` host event, so
  another runtime's catalog never empties Claude's.
- Changed: `HostedSession`, `FactLift`, `ForwardSessionOptions`, `SessionListener` and `factLiftFor`
  take the runtime's message type as a parameter, `SDKMessage` by default, so a Claude embedder's code
  is unchanged; each `FACT_LIFTS` entry is typed `FactLift<never>`, read through `factLiftFor`.
  `SessionRequest.effort` is a runtime's own word (`string`); a Claude process refuses a word the SDK
  does not declare. `SessionDegrade.kind` gains `runtime_degraded`, `HostEvent` gains
  `runtime-catalog`, `CompactionReport` gains an optional `sourceId`, and `CONTROL_TIERS` and
  `RUNTIME_WIRE_APIS` gain a `codex` row.
- Added: `ItemFill`, a runtime's item fill, and `ForwardSessionOptions.items`, which forwards a
  session's items behind each message's facts; `AGENT_SKILLS` and `agentSkillsFor`; `HostEvent` gains
  `endpoint-members-ignored`, and a model endpoints reading carries `ignored`. `endpointModelProblem`
  holds only on an endpoint Claude reaches.
- Added: Codex's gate. A Codex session's tool calls are decided by its decider and local gate, as
  Claude's are, through two channels. The first is `periscope hook codex`, a command hook the host
  installs in the runner's Codex home (a shim under `hooks/` and a group in `hooks.json`) and trusts
  over the app-server's wire at every open: it asks the host over a channel of the session's own (a
  named pipe on Windows, a Unix socket elsewhere, never TCP) and writes only the two answers Codex
  honours, nothing to proceed or a deny with its reason, failing closed. The channel takes a random
  per-session token, and each answer carries an HMAC keyed by it. The second is Codex's approval
  requests: a command or a patch is answered from the hook's decision for the same call or decided
  afresh, an MCP tool call is decided by the call Codex has pending on that server, and nothing is
  ever granted for the session. A hook that cannot be made active refuses the open with the new
  reason `codex-hook-not-active`. Codex's control tier is `intercepted-with-residual`.
- Added: the gate's degrade reasons, each raised on the state lane as a same-state transition, once
  per call: `gate-hook-timed-out`, `gate-hook-unspawnable`, `gate-hook-output-rejected`,
  `gate-hook-missing`, `gate-hook-foreign`, `gate-unhooked-call`, `gate-approval-unanswered`,
  `gate-approval-auto-reviewed`, `gate-approval-ambiguous`, `gate-project-config-active` and
  `gate-sandbox-absent`. The three known at spawn (`gate-sandbox-absent`,
  `gate-project-config-active`, `gate-hook-foreign`) also join the session's opening tier.
- Added: the decision request's `shellDialect` (`SHELL_DIALECTS`: `posix`, `powershell`), present on
  a shell call. Claude's `Bash` is `posix` and its `PowerShell` is `powershell`, carried as data:
  Claude's local gate reads a command as before. A Codex session's local gate reads a PowerShell
  command both ways and refuses it if either reading does.
- Changed: an allow carrying `updatedInput` on a Codex session is refused
  `permission-decision-unrecognised`, a decision Codex cannot apply.
- Changed: a Codex session whose `decisionTimeoutMs` is 110000 or more is refused
  `gate-deadlines-inverted`: the hook waits for the decision plus `HOOK_DEADLINE_MARGIN_MS` inside its
  fixed 120-second timeout. `matcherTimeoutSeconds` does not apply to Codex.
- Changed: a Codex home whose path holds a space or a shell metacharacter lists Codex unavailable,
  naming the character; the host still starts.
- Added: `hooks.json`, `hooks/` and `config.toml` in the runner's Codex home join the protected set.
- Changed: `EXTRA_ENV_FLOOR` gains `PERISCOPE_HOOK_CHANNEL`, `PERISCOPE_HOOK_TOKEN` and
  `PERISCOPE_HOOK_DEADLINE_MS`, which the host sets in a Codex session's app-server environment and
  keeps from the agent's shell.
- Added: `createCallDecision`, `CallDecision` and `CallDecisionOptions`, the one per-call decision
  Claude's hook and Codex's channels share; `TerminalOutcome`; a deny outcome's optional `interrupt`;
  `CODEX_TOOL_FAMILIES`, the local gate's reading of Codex's tool names, `apply_patch`'s paths among
  them, through `ToolFamilies.patch`; `LocalGateOptions.readsShellDialect` and
  `resolvesAgainstCallCwd`; `parseCommand`'s optional dialect; `SessionObserver.stateSpawnDegrades`.
- Added: `HostEvent` gains `endpoint-aliases-unmapped`, once at start for each endpoint listing an
  agent alias as a model without mapping it, and a model endpoints reading carries `unmappedAliases`.
- Changed: the host's `codex` option and `PeriscopeCodexOptions` stay internal.
- Changed: the publish gate reads a `## [Unreleased]` heading, and `contracts:update` re-approves the
  Claude wire replay.

## [1.6.0] - 2026-10-11

Protocol 15; the window is `[14, 15]`, so a version-14 controller is still spoken to. Version 15
adds bodies, optional members and refusal reasons, no payload kind: a version-14 controller reads the
new bodies as open JSON it may ignore, carries the new members unread, never sends the members five
of the new reasons answer, and reads the sixth, `settings-route-refused`, as it reads any reason it
does not know; every frame it sends decodes unchanged.

- Added: the fact layer. A `session_update` may carry an `agent_facts` body: one fact the agent
  reported, typed, right behind the message it came from. Six kinds: `session_handle` (the resumable
  id), `agent_receipt` (version, model, approval mode, effort, skills, plugins, plugin errors, MCP
  servers), `turn_record` (the running total and the turn's own figure, each a `SpendFacts` with a
  currency and a cost basis per model, and `turnScope`), `usage_sample` (one model call's context
  and cache lifetime), `tasks` (every task running, whole) and `compaction`. Every figure is one the
  agent reported, or null; nothing is summed or differenced. `sourceId` is the `uuid` of the message
  a fact was lifted from, so an ingest can be idempotent on it. A Claude session sends each fact when
  it changes: a re-sent identical init sends nothing, a call that arrives as several messages is
  sampled once.
- Added: `agent_fragment` deltas. Each streamed content delta also rides the delta lane as a
  fragment on its channel (`text`, `thinking`, `tool_input`), with the tool call that spawned the
  subagent speaking as `parentId`; the `agent_message` delta it came from still rides. A delta body
  is read as a `SessionDeltaBody`.
- Added: `runtime` on `agent_message`, optional. Absent means `claude` (`DEFAULT_RUNTIME`), and a
  Claude session's messages omit it, so their bodies are unchanged. Transcript locators are the
  namespace `{runtime}-transcript:{...}`; `claude-transcript:` is the instance this host serves.
- Added exports: the fact types (`AgentFact` and its six arms, `AgentFactsUpdate`, `SpendFacts`,
  `ModelSpendFact`, `RunningTaskEntry` and the receipt's parts), `AgentFragmentDelta`,
  `SessionDeltaBody`, `agentFactsUpdate`, `readAgentFacts`, `agentFragmentDelta`,
  `readAgentFragment`, the vocabularies `COST_BASES`, `TURN_SCOPES`, `RECEIPT_SOURCES`, `CACHE_TTLS`,
  `COMPACTION_STATUSES`, `COMPACTION_TRIGGERS` and `FRAGMENT_CHANNELS`, the bounds
  `MAX_FACT_LIST_ENTRIES`, `MAX_FACT_TEXT_LENGTH` and `MAX_FACT_WORD_LENGTH`, and `DEFAULT_RUNTIME`.
  On the main entry: `FactLift`, `FACT_LIFTS` and `factLiftFor` (the fact lift per runtime),
  `ForwardSessionOptions.lift`, which `composeSession` fills with Claude's, and
  `SessionObserver.onCompaction` with `CompactionReport`.
- Added: `agents` on the hello's configuration and the configure answer, optional: one
  `HostAgentEntry` per runtime the host can spawn (its versions, models, the permission modes and
  effort levels it takes, whether it takes a thinking control, its control tier, and whether it is
  available), at most `MAX_AGENT_ENTRIES`. This host lists Claude, from the same read as `agent`; the
  two are null together.
- Added: `runtime` on `session_new.request`, optional. Null, absent and `claude` open as before; any
  other runtime is refused `runtime-unavailable` before anything is reserved. A composed session's
  runtime picks its fact lift, its control tier and the runtime its decision requests name
  (`SessionRequest.runtime`, read through `runtimeOf`).
- Added: the control tier. A session's first transition into `ready` carries
  `controlTier: { level, degrades }`, and each runtime entry carries the same; a Claude session is
  `intercepted` with no degrades. Levels are `CONTROL_TIER_LEVELS`; an undeclared level is refused on
  the way out and read on the way in.
- Added: `toolKind` and `runtime` on the decision request, optional, beside the unchanged
  `toolName`. Claude's tool names map to `shell`, `file_read`, `file_write`, `file_edit`, `mcp` or
  `web`, and any other name to `other` (`TOOL_KINDS`).
- Added refusal reasons: `runtime-unavailable`, `request-key-unsupported`, `endpoint-unknown`,
  `endpoint-incompatible` and `model-endpoint-mismatch`. This host raises the first and the three
  endpoint reasons (below); a session on Claude never meets the second.
- Added: `endpoints` on the hello's configuration and the configure answer, optional: one
  `HostEndpoint` per model endpoint the host's operator declared (its name, the wire API it speaks,
  the runtimes that can reach it, and every model id a session may name on it, alias ids included),
  at most `MAX_ENDPOINTS`, held to its own `MAX_ENDPOINT_CATALOG_BYTES` beside the catalog's budget.
  An endpoint's address, its credential and whether it is Anthropic's own route never ride the wire.
  Wire APIs are `ENDPOINT_WIRE_APIS`; an undeclared one is refused on the way out and read on the way
  in.
- Added: `endpoint` on `session_new.request`, optional. Null and absent take the runtime's own route.
  For a declared endpoint the host sets, in the spawn environment, its address and credential
  (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`), the model each mapped tier resolves to, its window,
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, after the
  controller's lanes and never through the floor that screens them. A name the operator did not
  declare refuses `endpoint-unknown`; an endpoint that cannot carry the session's runtime,
  `endpoint-incompatible`; and on an endpoint not marked as Anthropic's own route, a `claude-` model
  id or an alias the endpoint does not map refuses `model-endpoint-mismatch`, at the open and on a
  `session_configure` that switches to one.
- Added: `PERISCOPE_MODEL_ENDPOINTS`, a config-file key never settable over the link, naming the
  operator's endpoints file. Each entry: a name, a wire API, its runtimes, a base URL, a credential
  read from an environment variable, a file or a helper command (an absolute executable, run with no
  shell; a Windows batch file is refused), its models, the tiers it maps, its window in the vendor's
  form, more variables, and `firstParty`. The file is read, checked and its credentials resolved at
  start, and an entry this host could not honour refuses start by name. The file and every credential
  file it names join the protected set.
- Added: `settings-route-refused`. A session that loads the `project` or `local` settings tier is
  refused before the agent starts when the repository's `.claude/settings.json` or
  `.claude/settings.local.json` names, in its `env`, a key beneath the env floor; the detail names the
  file and the keys.
- Added exports: `EndpointWireApi`, `ENDPOINT_WIRE_APIS`, `HostEndpoint`, `MAX_ENDPOINTS`,
  `MAX_ENDPOINT_MODELS` and `MAX_ENDPOINT_CATALOG_BYTES`. On the main entry: `ModelEndpoint`,
  `ModelAliasTier`, `EndpointContextWindow`, `ModelEndpointsReading`, `ModelEndpointsReadOptions`,
  `readModelEndpoints`, `PeriscopeHostOptions.endpoints`, `SessionRequest.endpoint`,
  `SessionRequest.hostEnv`, `RUNTIME_WIRE_APIS`, `wireApisFor`, `spawnableRuntimes`, and the
  `modelEndpointFiles` option of `credentialPaths`.
- Changed: `composeSpawnEnv` takes an optional third input, the host's own variables, applied after
  the policy's literals and before the host-session strip.
- Added exports: `ControlTier`, `ControlTierLevel`, `CONTROL_TIER_LEVELS`, `HostAgentEntry`,
  `HostAgentVocabularies`, `MAX_AGENT_ENTRIES`, `ToolKind` and `TOOL_KINDS`. On the main entry:
  `CONTROL_TIERS`, `controlTierFor`, `runtimeOf`, `SessionObserverOptions` (the observer's tier),
  `TransitionRequest.controlTier`, `SessionRequest.runtime` and `PermissionGateOptions.runtime`.
- Changed: `agentMessageUpdate` and `agentMessageDelta` take an optional `runtime`.
- Changed: the codec checks the members the new bodies declare, and only those. A count in a fact
  (tokens, a context window, turns, a duration) must be a non-negative whole number, or the frame is
  refused `frame-malformed`; a vocabulary word a newer peer adds is read, and one this host does not
  declare is refused on the way out. Every other body is open JSON, as before.

## [1.5.0] - 2026-10-10

Protocol 14; the window is `[13, 14]`, so a version-13 controller is still spoken to. Protocol 14
changes no shape. It narrows what `session_new.request.env` may carry, and the narrowing holds at
every version the host negotiates, 13 included.

- Closed: a paired controller could change where a session's model traffic went. `SECURITY.md`
  promised a floor of environment keys beneath every controller, and the floor did not hold. It was
  checked against `extraEnv` only, so `extraAllowedKeys` could re-admit `ANTHROPIC_BASE_URL`, or any
  other key the host's own environment held. And it was a list of eleven names, so `extraEnv` could
  set the agent CLI's other routing variables: `ANTHROPIC_AUTH_TOKEN`, a provider switch such as
  `CLAUDE_CODE_USE_BEDROCK` with its base URL, `HTTPS_PROXY` with `SSL_CERT_FILE`. A controller
  could point a session's model calls, and everything the agent had read, at a server of its
  choosing.
- `session_new.request.env` is absent unless declared. A key a controller places in the agent's
  environment, by `extraEnv` or `extraAllowedKeys`, must be one the host's operator declared:
  `PERISCOPE_CONTROLLER_ENV_KEYS` (comma-separated, from the environment or the config file, never
  settable over the link) or `PeriscopeHostOptions.controllerEnvKeys`. Nothing is declared by
  default, so **a controller that sends `extraEnv` or `extraAllowedKeys` is refused
  `env-key-refused` until the operator declares the keys**, and the refusal names each one.
  `extraDeniedKeys` is unchanged.
- The floor beneath the declaration covers both lanes and every name of the families the agent CLI
  routes by: beside its eleven names, `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*_AUTH`,
  `CLAUDE_CODE_CLIENT_*`, `SSL_CERT_*` and `*_PROXY`. A floor entry may be a pattern in which `*`
  stands for any run of characters; `extraEnvFloor` keeps its type. No declaration opens the floor,
  and a declared name beneath it refuses `serve` at start and `periscope config` before it writes.
  What a session inherits from the host's own environment is unchanged: a proxy the host sets still
  reaches every session.
- Setting `CLAUDE_CODE_ENABLE_TODO_TOOLS` from a controller now needs the host to declare it
  (`docs/configuration.md`).

## [1.4.0] - 2026-10-01

Protocol 13; the window is `[12, 13]`, so a version-12 controller is still spoken to. Protocol 13 adds
two asks and one answer and no member to an existing kind: a version-12 controller sends neither ask,
so it is sent nothing it does not know, and every frame it sends still decodes.

- `session_end`: a controller ends a session it no longer needs. The agent's process exits, the end is
  reported as the session's transition to `ended` with cause `stop_requested`, and the workspace the
  session held is free. An end that arrives while the session is opening withdraws the turns waiting
  for it and ends the session as it opens. `session_cancel` still ends a turn and never a session.
- `workspace_read` and `workspace_read_result`: a controller reads a text file inside a workspace this
  host provisioned, by the workspace's key and a path relative to its directory, a page at a time
  (`MAX_WORKSPACE_READ_BYTES` per page, files up to `MAX_WORKSPACE_FILE_BYTES`). Each answer says
  where the next page starts. The repository read's jail and protected set apply over the
  workspace's directory, and the ask is host-scoped, so a workspace whose sessions have all ended can
  still be read. Two refusals, `workspace-path-escape` and `workspace-read-failed`. A provider locates
  a workspace through the new optional `WorkspaceProvider.pathFor`, which both shipped providers
  implement; `readWorkspaceFile` is the reader.
- The local gate's read policy. What an agent can now reach: reads are no longer jailed to the
  session's workspace, so `Read` and `NotebookRead` go anywhere the host's OS user can read (installed
  packages, the agent's own tool output, the agent CLI's settings and skills) except the protected
  set. What it can no longer reach: the search family, `Grep` and `Glob` by default
  (`ToolFamilies.search`, optional), is refused by name when its root is at or beneath a protected
  path or holds one beneath it, where before those tools had no local opinion; a shell command naming
  a protected path through `~`, `$HOME`, `${HOME}`, `$env:HOME`, `$env:USERPROFILE` or
  `%USERPROFILE%` is refused by name (`LocalGateOptions.home`, `PeriscopeHostOptions.home`,
  `homeDirectory`); and every protected-path comparison folds case, so another spelling of a
  protected path no longer passes. Writes stay jailed to the workspace.
- `credentialPaths` names credential material rather than the directories it sits in: the agent CLI's
  `.credentials.json` and `.claude.json` in `~/.claude`, in `CLAUDE_CONFIG_DIR` and in the effective
  agent home, plus `~/.claude.json`, replace the whole `~/.claude`, `CLAUDE_CONFIG_DIR` and agent home.
  The host's own config directory and `~/.aws`, `~/.config/gcloud`, `~/.azure` and `~/.ssh` stay
  protected whole.
- `docs/identity.md` states the `extraEnv` floor: `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`
  passed through `session_new.request.env.extraEnv` refuse `env-key-refused`.

## [1.3.0] - 2026-09-29

Protocol 12; the window is `[11, 12]`, so a version-11 controller is still spoken to. Every member
protocol 12 adds is optional, so a version-11 controller, which reads none of them, decodes this host's
frames, and its own frames, which carry none, still decode here.

- The agent SDK is 0.3.284, bundling Claude Code 2.1.284 (from 0.3.220 and 2.1.220), so a session can
  run the models that CLI knows; `@anthropic-ai/sdk`, the SDK's peer, is `^0.129.0`.
- The SDK's two new hook events are in the cause vocabulary (`HOOK_EVENTS`, `CauseEvent`).
  `PostModelSwitch` is recorded: a same-state transition whose detail names the models on either
  side, who asked, whether the prompt cache was warm and on which TTL, and the estimated cost of
  re-caching the context. `PreModelSwitch` is answered, not recorded: `modelSwitchHooks` allows every
  switch, so a switch a controller asks for is never left to the interactive cache-miss confirm, which
  a session with nobody at a keyboard cannot answer. `composeSession` registers it. Claude Code
  2.1.284 lets a headless switch through without the answer too; the allow keeps it that way.
- `deltaSpend(previous, next)`: a result's spend is a running total (it accumulates across a
  session's turns, continues across a resume or a fork, and resets at `/clear`), so one turn's spend
  is the difference of two results; a drop in any counter starts a new series. Seed a resumed or
  forked session's first result with its parent's last one, or the parent's spend counts twice.
  `foldSpend` folds deltas.
- `ModelSpend` gains `thinkingTokens` and `costBasis` (`list`, `managed` or `unknown`, the last
  meaning the cost is a guess), null when the agent did not report them and optional in the type,
  so code that builds a `ModelSpend` still compiles.
- `readTaskSpend` is deprecated and returns null: no agent SDK declares the fields it read, and a
  subagent's cost is already inside the parent's results.
- A refusal with no fallback reaches the trace: `system/model_refusal_no_fallback` is a declared
  cause event. The observer recorded it before, but the machine refused every such transition as
  `transition-cause-unnamed`, so only the forwarded message said the model refused. The detail names
  the model and, when the agent reports one, the refusal category.
- Thinking is `adaptive`, with an optional `display` of `summarized` or `omitted`, or `disabled`. A
  fixed budget (`{type:'enabled', budgetTokens}`) is refused by name at `session_new` and
  `session_configure` (`frame-malformed`), because Opus 4.7 and later, Sonnet 5 and later and Fable 5
  and later reject it with a 400: a session that took it would open and then fail its first turn. The
  models that still accept a fixed budget lose that knob here. The `session_new.full` wire vector now
  carries `{type:'adaptive', display:'summarized'}`.
- A `session_configure` that turns thinking on sends the SDK a positive thinking cap
  (`THINKING_ON_CAP`) instead of clearing the cap. On Claude Code 2.1.284 a cleared cap left a
  session started with thinking disabled without its thinking prose on Opus 5.5, Fable 5.1 and
  Sonnet 5.5, and a positive cap brought it back. On those models any positive cap means adaptive;
  a model that still takes a fixed budget reads it as one.
- A `session_configure` that fails answers on the wire, as a same-state transition on the session's
  state lane with cause kind `refusal`. `session-configure-failed`, a new `RefusalReason`, is sent when
  the agent refuses a live setter, and its detail names the member and carries the agent's text.
  `frame-malformed` is sent when this host refuses a value. Before, both reached only the host's own
  report, as `session-unknown`, and the controller heard nothing. A model switch can now be refused,
  for a model the account cannot run.
- A message whose discriminator the routing table does not know, such as a subtype the CLI emits
  before the SDK's types declare it, rides `update`, the table's stated default. The lookup used to
  throw inside the forwarder, and the message was lost behind a `subscriber_failed` degrade.
- Plugins reach the agent over stdin (`pluginDelivery: 'initialize'`) rather than as one
  `--plugin-dir` flag each, so a host with several plugin directories stays clear of the Windows
  command-line limit. A custom `spawn` that loads plugins must run a CLI of 2.1.261 or later.
  `HostedSessionFacts.pluginsApplied` carries the agent's own answer to whether every plugin loaded;
  Claude Code 2.1.284 answers true with a missing directory in the list. The agent names a plugin
  directory that did not load, with its path, in its init message's `plugin_errors`, which reaches
  the controller forwarded. The host still refuses a missing configured directory itself, before a
  process exists.
- `permissionPrompts` joins the closed lanes: a controller cannot set it, so its `none`, which denies
  every call that would have prompted, cannot answer ahead of the gate. `updateSettings`, a new call
  that writes settings files mid-session, is among the calls the process handle keeps unreachable.
- A session asked to run under `bypassPermissions` starts with the SDK's
  `allowDangerouslySkipPermissions`, which the SDK requires before it enters that mode. A session in
  any other mode starts without it. The host still passes no `--dangerously-skip-permissions` and
  chooses no mode of its own. Claude Code 2.1.284 refuses a switch into bypass mid-session for a
  session started in another mode, by name, and the controller hears `session-configure-failed`.
- Only a session's first `system/init` records `ready`. The CLI re-sends its init with current values
  at every later turn, and recording each one moved a working session back to `ready` in the middle
  of its turn. A later init refreshes the session's facts instead: the model, the permission mode and
  the inventories it reports replace the first ones, and the id stays.
- The hello's `configuration` gains `agent` (`HostAgent`): the Claude Code version the installed agent
  SDK bundles, that SDK's version, and the models the agent offers (`HostModel`: the value a session
  takes as `model`, the model id an alias resolves to, the effort levels and what else it supports).
  It is read once at start by starting the agent with a prompt stream that never yields, so no model
  is called (`readAgentCatalog`, `PeriscopeHostOptions.agentCatalog`), and the link dials once the read
  settles, so the first hello carries it. `periscope serve` reads it bounded at 20 seconds and prints
  it on an `[agent]` line. A read that fails, or a catalog past `MAX_AGENT_MODELS` or
  `MAX_AGENT_CATALOG_BYTES`, rides as `agent: null` with the reason reported; it never fails a start.
  A `host_configure_result` carries it too.
- `session_configure` gains `effort`, in `session_new`'s vocabulary, applied after the model, the
  permission mode and thinking. An unknown level is refused `frame-malformed`. It reaches the SDK's
  flag settings with that one key and nothing beside it; as the SDK documents, a change of level also
  turns ultracode off.
- A forwarded message's body gains `observedAt`: when this host took it off the agent's stream,
  ISO-8601 in UTC, so a consumer does not date a message replayed after a reconnect by its arrival.
  `readObservedAt` returns null for a host one release behind. `agentMessageUpdate` and
  `agentMessageDelta` take it as an optional second argument, and `forwardSession` stamps it from its
  new `clock` option, the system clock when none is given.

## [1.2.0] - 2026-09-20

Protocol 11; the window is `[10, 11]`, so a version-10 controller is still spoken to.

- `PERISCOPE_PLUGIN_DIRS`: plugin directories the host loads into every session, a path list of
  plugin roots (each carrying `.claude-plugin/plugin.json`). Settable over the link; refused by name
  at start, at configure and at every open when a directory is absent or its manifest unreadable,
  because the agent SDK skips a missing plugin path without a word. A controller's own
  `session_new.request.plugins` are added after the host's.
- The hello's `configuration` gains `plugins`: each configured directory's manifest name, version
  and path, so a controller knows what a session on this host can invoke before it opens one.

## [1.1.0] - 2026-09-18

Protocol 10; the window is `[9, 10]`, so a version-9 controller is still spoken to.

- A live session queues at most 16 turns the agent has not read; a `session_prompt` past that is
  refused `prompt-queue-full` and the session is untouched. The queue a controller could grow without
  bound now has one, as every other buffer here does.
- `extraEnv` has a floor: `PATH`, `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`,
  `NODE_EXTRA_CA_CERTS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`,
  `DYLD_LIBRARY_PATH`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`. A
  `session_new` naming one is refused `env-key-refused` before a process exists;
  `PeriscopeHostOptions.extraEnvFloor` lets an embedder pass a shorter list.
- A host holds at most `maxSessions` sessions, live and opening together (`DEFAULT_MAX_SESSIONS`,
  8); a `session_new` past it is refused `session-cap-reached` before anything is reserved.
- `answer_refused`: a host-scoped answer the link refused (over the frame cap) is followed by this
  small kind carrying the request id and the refusal, so a controller learns by name rather than by
  timeout.
- `link_welcome` carries the controller's own `protocolRange`; a host reads its absence as null.
- `git reset --hard` is a boundary shape: classified locally, escalated like a push.
- The reference and minimal controllers send their range.

## [1.0.3] - 2026-09-18

- A worktree for a new branch is created with `git worktree add -b`, never `-B`. `-b` refuses when
  the branch exists, so a branch probe that failed for any reason other than the branch being absent
  now refuses the provision by name instead of hard-resetting the branch and discarding its commits.
  No wire or API change.

## [1.0.2] - 2026-09-18

- `SECURITY.md` states the permission mode as it is: the controller's to set per session, in the
  SDK's own vocabulary, `bypassPermissions` included, under which the `PreToolUse` hook is the only
  control; it is listed among the things a pairing extends. The README's naming sentence says what
  does ride the wire under the agent's names, and its safety paragraph points at that reach.
- The agent home and the transcripts root are reported in the home directory's own separator, so a
  Windows path reads as one on the controller's side. No wire or API change.

## [1.0.1] - 2026-09-17

- The package carries `src/` (without its tests) and `contracts/wire-vectors/`, so a controller in
  another language, and a consumer that generates types from the wire, read the contract from the
  installed package rather than from the repository. No wire or API change.

## [1.0.0] - 2026-09-17

Initial public release.

- One outbound WebSocket, commands only. Bulk content leaves by HTTP on a lane the controller names.
  Sequence numbers are dense per session per direction, minted at the first write; frames are
  retained until acknowledged and replayed from the controller's cursors after a reconnect.
- A fail-closed permission gate on every session: a `PreToolUse` hook with no permission prompt
  anywhere, local refusals for path escapes, credential reads and unrecognised git verbs, then an
  HTTP decision endpoint for everything else; no answer is a refusal.
- Workspaces: a plain directory or a git worktree per session, a branch scheme, list and release
  over the wire, and a repository read door jailed to the root and to the protected set.
- Identity: a generic OIDC client (authorization code with PKCE over loopback; device code opt-in)
  or a paired machine credential shaped `p1.<hostId>.<secret>`, presented on the upgrade, the
  decision POST and the bulk POST.
- The `periscope` binary: `serve`, `login`, `pair`, `config`, `status`, `version`.
- The contracts a second implementer proves against: the wire vectors under
  `contracts/wire-vectors/`, the public-API snapshot, and the installed agent SDK's type hash.

Protocol v9; the negotiated window opens at v9. Tested against `@anthropic-ai/claude-agent-sdk`
0.3.220 (Claude Code 2.1.220) on ubuntu and windows with node 22 and 24: 1485 tests, 1462 passing,
0 failing, 23 skipped on every leg (the skips are the live probes and one platform-only case),
measured by this repository's CI on the commit `v1.0.0` names.
