# Architecture

What the package is and how its parts compose. The wire is in [protocol.md](protocol.md), the
session's state model in [state-machine.md](state-machine.md), the permission gate in
[gate.md](gate.md).

## What it is

Periscope runs where the code lives, hosts Claude Code sessions through the Claude Agent SDK, and
reports to a controller anywhere else over one outbound WebSocket. The controller decides what a
session means; the host carries what it did. Three properties follow, each enforced rather than
promised:

- Generic. Nothing on the wire is shaped to one product. The test for a new member or event: could
  a different controller make different meaning from it? If yes it belongs here; if it means
  something only under one controller's rules it stays with that controller.
- The SDK's words. The package says session, message, hook, tool, subagent, turn, result and
  permission as the SDK does. A controller's own vocabulary fails the build
  (`pins/vocabulary.test.ts`). One site translates SDK events into transitions:
  `src/state/observer.ts`.
- Auditable blast radius. Nothing outside `src/host/` imports `node:fs`, `node:fs/promises`,
  `node:child_process` or `node:os`, and nothing outside it names the SDK (ESLint
  `no-restricted-imports`, `pins/host-boundary.test.ts`, `pins/sdk-confinement.test.ts`). The
  `./protocol` subpath cannot reach `src/host/`, so a consumer of the wire types acquires nothing
  that can spawn a process.

Where a concept exists in the Agent Client Protocol, the name is ACP's (`session/new` style,
camelCase keys, snake_case discriminators). Periscope is not ACP-compatible and does not claim to
be; no ACP transport dials out. The names that are the package's own (`link`, `bulk`) are registered
in `HOST_NOUNS` (`src/core/vocab.ts`).

## Composition

Two things live in `src/host/host.ts`.

`composeSession(options)` assembles one session: machine, observer, gate, forwarding. It takes
everything as arguments, so it is checkable without a socket or a process, and returns
`{ sessionKey, session, machine, observer, detach }`.

- Forwarding is attached before the first transition is recorded. The forwarder subscribes to the
  machine; attached later, the `spawning` record goes to nobody, and it is the first frame a
  controller sees for a session.
- Observation hooks are registered before the gate's:
  `mergeHooks(observationHooks(...), permissionHooks(...))`. Matchers dispatch in array order but
  are awaited concurrently, and a gate registered first would open a hold the observer closes in
  the same event. No pin enforces the order; it is stated at both sites.
- Every gate outcome is recorded on the machine unconditionally. `onOutcome` is an extra listener,
  never a substitute.

`PeriscopeHost` owns the link and the registry and turns inbound payloads into calls on them.

- It answers exactly the payload kinds its dispatch names (the session commands, `bulk_request` and
  the host-scoped asks in [protocol.md](protocol.md)) and refuses everything else
  `frame-malformed`. A command that vanished would read as a host that hung.
- Two `session_new` for one handle never replace each other silently: the duplicate guard is a
  synchronous reservation that holds across the workspace provider's await.
- A workspace claimed and then unusable is handed back on every failure path; provision and release
  stay balanced.
- Shutdown ends sessions first, then the link, so the end transitions have somewhere to go.
  `forgetSession` does not discard unacknowledged frames.
- `baseEnv` and `homeDir` build the agent's environment. Passing them beside a `registry` is refused
  at construction: the host reads them only to build its own registry, and the pair would otherwise
  be ignored in silence.
- `linkTimings` (`heartbeatIntervalMs`, `heartbeatTimeoutMs`, `connectTimeoutMs`) and `backoff`
  reach the default link; `link` replaces the link wholesale.

A session refused at its open answers on the wire ([protocol.md](protocol.md), the refused open).

## The binary

`periscope` is six verbs (`src/bin/command.ts`): `serve` (the default: no arguments means `serve`),
`login`, `pair <code>`, `config`, `status` and `help`. An unrecognised first argument is `unknown`,
never `serve`; falling back would let a typo start a host. Every claim that the binary does not do
something is about the daemon; the other verbs are where interactive work lives.

- `serve` dials the controller and serves sessions. It refuses to start as root (an unattended
  agent as root has the whole machine on every tool call; refused by policy, before anything else is
  read) and refuses to start without `PERISCOPE_DECISION_URL` (a host that cannot ask is an open door or a
  session where nothing runs). It never signs anyone in: it presents credentials that are already
  there and refuses by name when they are not. It prints one `[host]` posture line before dialling
  and writes the link's state to `link-state.json` beside the credentials on every transition.
- `login` runs the sign-in and writes the token cache. `pair <code>`, with `--controller <origin>`
  and `--label <name>`, redeems a controller-minted code for a paired credential and writes the
  controller's addresses to the config file. `config` shows or edits `config.json`. `status` prints
  the whole posture from the link record, the credentials and the settings, and never dials.
- `config.json` lives beside the credentials under a closed key allowlist (`CONFIG_KEYS`: the two
  control-plane URLs, the host id, both roots, the branch scheme, the workspace key, the agent home;
  `PERISCOPE_CONFIG_DIR` is excluded, a file cannot move itself). `serve`, `login`, `pair` and
  `status` read the environment with the file filling its absences; the environment always wins. A
  corrupt file is fatal by name for all four. `config` itself reads the raw environment so it can
  still name a broken file.
- The agent home is the setting (`PERISCOPE_AGENT_HOME`, default `<home>/.claude`); the transcripts
  root derives from it.

## Sessions

`SessionRegistry` owns session lifetime as instance state, so two embedders in one process cannot
see each other's sessions; everyone else borrows a `HostedSession` handle.

- The agent emits nothing until a turn is queued. `create()` is synchronous provisioning with no id;
  `open(request & { prompt })` is the ordinary one-call shape. Waiting for output before prompting
  hangs with no diagnostic.
- The spawn environment is a derived allow-list, never inherited (`src/sessions/spawn-env.ts`):
  exact, prefix and suffix rules, case-insensitive, deny before allow, and the host-session strip
  (`HOST_SESSION_MARKERS`) runs last, after `extraEnv`, so the recorded hazards cannot be
  re-admitted. Product-specific keys come in through `extraAllowedKeys` and `extraEnv`.
- Workspace trust is read, never granted (`src/host/workspace-trust.ts`). The package default is
  `settingSources: []`, the only setting under which the host can state what an agent's permissions
  are; what it costs is `CLAUDE.md` loading. The project tier loads only in a directory the CLI
  trusts, which a provisioned worktree is not.
- One consumer of the SDK stream: `HostedSession` pumps it once and fans out on `onMessage`,
  `onEnd` and `onDegrade`. Subscribe; never iterate the stream yourself. A throwing subscriber
  becomes a `subscriber_failed` degrade and cannot kill the pump.
- The CLI version is a per-spawn fact on `system/init`. `apiKeySource` is provenance, never an
  "is this authenticated" predicate: it reads `none` on a session that billed.

A `session_prompt` arriving while its session is still opening is held, not refused. `session_new`
awaits the workspace provider, and a git worktree takes seconds; the host acknowledges no controller
frame, so the sender cannot know the open finished. A held turn is delivered when the session
registers, refused in the open's `finally` on every failure path, or withdrawn by a `session_cancel`
during the open; it is never dropped. The hold is bounded at `MAX_HELD_TURNS`; overflow refuses
`session-unknown` with the bound in its detail. A cancel during the open withdraws the turn and does
not stop the open. `HostEvent` reports `prompt-held`, `prompt-delivered` and `prompt-withdrawn`.

## The two read-only doors

`src/host/claude-transcripts.ts` enumerates and tails the agent CLI's own transcript directory
(`<agentHome>/projects`), so a controller can list and open sessions the machine ran outside this
host. `src/host/paths.ts` names the same directory, the configured agent home included, to
protect it from the sessions this host runs;
the two postures do not touch, and nothing here can write. Read-only is a property: the modules'
whole filesystem surface is `createReadStream`, `readdir`, `stat` and `realpath`, held by
`pins/transcript-readonly.test.ts`.

- Every caller-supplied name passes three layers: a strict allowlist, an explicit `.` and `..`
  reject, and resolve-then-containment. A violation refuses `transcript-path-escape` naming the
  layer. An absent transcript is a value, never a refusal.
- Project slugs are opaque; the CLI's flattening of a path is not invertible and nothing here tries.
- The CLI rewrites a transcript on compaction, so every answer carrying an offset also carries the
  file's size and mtime; a caller seeing either move re-reads whole.
- Each listed transcript carries the `cwd` the CLI recorded, because the CLI keeps transcripts per
  directory: a resume must run there or it becomes a fresh session that says nothing.

`src/host/repository-read.ts` reads the repository under `PERISCOPE_REPOSITORY_ROOT`:
`repository_list` (names, sorted, capped at `MAX_REPOSITORY_ENTRIES`) and `repository_read` (a text
head capped at `MAX_REPOSITORY_READ_BYTES`, cut on a character boundary, with the whole size). The
jail is lexical (join, resolve, contain) and physical (`realpath` both sides, contain again); a file
whose head holds a NUL byte refuses `repository-read-failed` rather than shipping binary as text.
The listing does not follow links; the read does.

## Workspaces

`WorkspaceProvider` is the seam the SDK does not have: what a workspace is. Two implementations
ship, `PlainDirProvider` and `GitWorktreeProvider`; policies (a shared directory per piece of work, a
cleanup schedule) belong to the embedder. Every result is a named refusal, never an exception.

- The binary selects the git provider on the presence of `PERISCOPE_REPOSITORY_ROOT`
  (`src/bin/workspaces.ts`). `PERISCOPE_WORKSPACE_ROOT` alone gives plain directories. Neither gives
  no provider and the controller's `cwd` verbatim, and a directory nobody created fails the spawn.
- The workspace key resolves `session_new.workspaceKey ?? PERISCOPE_WORKSPACE_KEY ?? sessionKey`,
  each a default for an absence. It is screened before any claim (`src/core/workspace-id.ts`: the
  union of git refname law and path-segment law, plus `MAX_WORKSPACE_ID_LENGTH`; the refusal names
  the character and which law rejects it), and a non-null key with no provider refuses
  `workspace-provision-failed`. Sessions can share a key; the in-use guard holds until the last
  closes, inside the per-key turn (`src/core/keyed-turns.ts` serialises provision, release and
  close per key, and different keys interleave freely).
- The branch scheme is the caller's template: `PERISCOPE_BRANCH_SCHEME` with `{key}` and `{repo}`,
  default `{repo}/{key}`. The posture is screened at start-up, fatally, by name: an unknown
  placeholder, an illegal literal, a brace that survives substitution, a dependent setting absent.
- `inventory()` lists the worktrees contained by the workspace root (never the operator's checkout),
  newest tip first, with branch, head, merged (git's answer: a squash merge reads unmerged),
  `aheadCount` and `lastCommitAt`.
- `release(key, { remove, deleteBranch, force })`: `remove` alone leaves the branch; `deleteBranch`
  deletes a merged branch; an unmerged branch refuses `branch-not-merged` and removes nothing unless
  `force`. The receipt states `directoryRemoved` and `branchDeleted` separately. A session ending
  leaves its directory; the reap is the one path that removes one.
- `host_configure` reconfigures the running host (`src/bin/reconfigure.ts`): the two roots, the
  branch scheme, the agent home and the two control-plane URLs. A root change while a session is
  open or opening refuses `config-host-busy`. The URLs are written but apply at the next start, and
  are named in `pendingRestart` on every hello and answer until then.
- Under a provider the controller's `cwd` is advisory; the `spawning` transition carries the
  directory the session got. One exception: a `cwd` equal to the provider's own `repositoryRoot`
  runs there, the operator's trusted checkout, claiming no key. A resume runs where its transcript
  lives or refuses `resume-cwd-not-honoured` on the wire.

## MCP

The host's own MCP server registers tool descriptors the embedder supplies: JSON in, Zod inside
(`src/mcp/schema.ts`). An unconvertible construct is refused at registration, never widened to
`z.any()`, never skipped. No payload kind carries a descriptor. A controller declares MCP servers
through `session_new.request.mcpServers` (a name colliding with a host-registered server is
refused), and every tool they add is decided by the same gate as `Bash`. `identity` is filled by
the host at call time.

## Identity

The host signs in a real user through a generic OIDC client and presents that user's token; a
paired machine credential is the alternative for a host meant to stay up.

- The authority and client id are configuration (`PERISCOPE_IDENTITY_AUTHORITY`,
  `PERISCOPE_IDENTITY_CLIENT_ID`), never a constant; absence is a named refusal at start-up.
  Loopback with PKCE is the primary flow; the device-code flow is opt-in. `offline_access` is in
  the default scope set so an unattended host can refresh.
- `readCredential` prefers the paired credential (`p1.<hostId>.<secret>`, beside the token cache)
  over the token cache even when both exist: a refresh token dies after inactivity and a paired
  credential has no clock. A missing paired file falls through; a corrupt one is fatal, never a
  fallback. The paired credential's host id outranks `PERISCOPE_HOST_ID` at the hello.
- A controller that refuses the credential at the door (401 or 403) is `link-unauthorized`, and it
  is terminal: the process exits 1 naming it, because redialling a door that refused the identity
  is a loop with no exit.
- The token cache and the paired credential are protected by derivation: `credentialPaths(env)` is
  the one source of the gate's protected set and the cache's own location.
- File-mode privacy is measured, never assumed from the platform: `enforced`, `write-bit-only`
  (the Windows shape) or `unobservable`. A mode that is not enforced is said by name as a degrade.
- `signIn` and `signInWithDeviceCode` are exported for an embedder; the daemon does not call them.

## Persistence and telemetry

- A delivery receipt is read from raw stored entries, never from the SDK's conversation reader:
  compaction relinks `parentUuid`, so a walk cannot reach pre-compaction turns. Three defences hold
  the receipt: raw entries, a uuid anchor (never a numeric offset), and compaction-produced entries
  excluded as candidates.
- The transition log is append-only, and that is load-bearing ([state-machine.md](state-machine.md)).
- Spend is consumed as the agent reports it, per model. Nothing multiplies tokens by a rate.

## What ships

- Exports are exactly `.` and `./protocol`; a third subpath would reopen the boundary
  (`pins/package-shape.test.ts`, `pins/protocol-closure.test.ts`).
- `files` is an allowlist: `dist/` without tests, maps, pins and test support, plus README,
  SECURITY and LICENSE. `npm pack` is gated against it.
- `contracts/` holds the approved snapshots, in the repository and not the tarball: `wire-vectors/`
  (every payload kind byte for byte, the refusal and tolerance cases), `public-api.txt` (every
  export of both barrels with its signature), and the installed SDK's type hash with its version.
  `npm run contracts:update` re-approves the first two after an intended change;
  `npm run check:drift` compares the SDK.
- The suite is `npm test`: a clean build, then every `*.test.js`. Its figure is four numbers per
  platform (tests, pass, fail, skipped) with the invocation. Live probes skip loudly unless
  `PERISCOPE_LIVE=1`.

## How not to use it

- Do not compose by hand and leave `grantOnAllow` off: the gate can refuse and cannot approve, and
  every allowed call silently fails to happen. Use `PeriscopeHost`, or set the flag and pass
  `onRefusal` and `onDegrade`.
- Do not assume the daemon signs anyone in. `login` writes the token cache; `pair` writes the
  paired credential.
- Do not assume a host's id is what its config says; the paired credential's id wins.
- Do not point a bulk `postUrl` outside the controller's own origin; it refuses
  `bulk-target-not-controller`.
- Do not expect one transport. A controller serves the WebSocket and an HTTP decision endpoint.
- Do not add an inbound port, a payload lane or a second stream consumer. Dial-out, commands only
  and a single pump are the design.
- Do not teach it a controller's vocabulary, a roster, or an interpretation of `correlationId`.
- Do not make retransmission skip deltas, and do not put deltas in a durable store; both halves are
  pinned.
- One controller and one replica per host.

## Where things live

| Path                                 | What                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                       | The public barrel; anything not exported here or from `protocol.ts` is internal                                                                                                                                                                                              |
| `src/protocol.ts`                    | The `./protocol` subpath: types and runtime values whose closure reaches no `host/` file and no `node:` builtin                                                                                                                                                              |
| `src/bin/`                           | The binary: `command.ts` (the verbs), `main.ts` (dispatch through `Io`), `serve.ts` (the daemon), `login.ts`, `pair.ts`, `config.ts`, `status.ts`, `posture.ts`, `workspaces.ts` (the provider selector and the scheme), `reconfigure.ts`                                    |
| `src/host/`                          | The only importer of the SDK and the process-reaching builtins: `host.ts`, `agent-process.ts` (the SDK seam), `hooks.ts`, `paths.ts`, `config-file.ts`, `link-state-file.ts`, `claude-transcripts.ts`, `repository-read.ts`, `bulk-post.ts`, `wire-request.ts`, `sign-in.ts` |
| `src/control/`                       | The wire: `frames.ts`, `codec.ts`, `seq.ts`, `queue.ts`, `link.ts`, `link-state.ts`, `stream.ts`, `stream-routing.ts`                                                                                                                                                        |
| `src/sessions/`                      | `registry.ts`, `session.ts`, `spawn-env.ts`                                                                                                                                                                                                                                  |
| `src/state/`                         | `model.ts`, `machine.ts`, `observer.ts`, `store.ts`, `coverage.ts`, `reporter.ts`                                                                                                                                                                                            |
| `src/gate/`                          | `gate.ts`, `decision.ts`, `outcome.ts`, `local.ts`, `jail.ts`, `shell.ts`, `command.ts`, `escalate.ts`                                                                                                                                                                       |
| `src/workspace/`                     | `provider.ts`, `plain-dir.ts`, `git-worktree.ts`, `worktree-porcelain.ts`                                                                                                                                                                                                    |
| `src/identity/`                      | Generic OIDC: config, PKCE, authorize, device code, the token store, the file-mode measurement                                                                                                                                                                               |
| `src/mcp/`                           | JSON Schema to Zod, the descriptor, the server                                                                                                                                                                                                                               |
| `src/persistence/`, `src/telemetry/` | The receipt, the transition log, per-model spend                                                                                                                                                                                                                             |
| `src/pins/`                          | The structural tests; `walk.ts` is the tree walker they share                                                                                                                                                                                                                |
| `examples/`                          | The minimal controller, the reference controller with its runnable entry, and the parallel-run proof                                                                                                                                                                         |
| `contracts/`                         | The approved snapshots                                                                                                                                                                                                                                                       |
