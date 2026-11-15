# Contributing

Periscope hosts Claude Code sessions for a remote controller. Read `README.md` for what it does and
`SECURITY.md` for the permission model before changing anything under `src/gate/` or `src/identity/`.

## Proposing a change

- A bug or a gap in the documents: open an issue with the template, or a pull request straight
  away if the fix is small and the issue would only restate the diff.
- A new wire member, payload kind, refusal reason or exported name: open an issue first. Each is
  a versioned change with a consumer on the other end, and the conversation is cheaper before the
  code exists.
- A change to the gate or the identity layer: state in the pull request what the change lets an
  agent reach that it could not reach before, or what it stops. That sentence is the review.

Work on a branch of your fork and open a pull request against `main`. The template asks for the
checks below and for a `CHANGELOG.md` line when a consumer can see the change. Commit messages
state what the change does in the imperative (`refuse a relative agent home at boot`), one change
per commit where that is natural; there is no required prefix. Contributions are accepted under
the MIT licence of this repository; by opening a pull request you state that you have the right to
contribute the change under it. No contributor agreement is required, and a sign-off line is not.

## Requirements

- Node 22 or newer (the CI matrix runs 22 and 24 on Linux and Windows). The opencode SDK needs Node 24 or
  later: on Node 22, `src/host/opencode-local.test.ts` skips, saying why, and opencode is listed unavailable.
- `git` on the path (the workspace tests run it against a temporary repository).
- No Claude credentials are needed for the ordinary suite. The live probes are opt-in (below).

## Build and test

```sh
npm ci
npm run typecheck          # tsc --noEmit
npm run lint               # eslint, the type-checked rule set over src/ and examples/; needs a built dist/
npm run format:check       # prettier; `npm run format` writes
npm test                   # clean, compile to dist/, run every *.test.js
npm run check:pack         # publint and attw over the packed tarball, after a build
```

The formatter's config is committed, so an editor with the Prettier extension agrees with CI; the
`.editorconfig` covers editors without it.

`npm test` deletes and rebuilds `dist/`. If something is executing from `dist/` (a running host),
use the incremental lane, which is the same suite without the clean:

```sh
npx tsc && node --test "dist/**/*.test.js"
```

Read the four numbers the runner prints (tests, pass, fail, skipped). The skips are the live
probes and one platform-only case; a non-zero `cancelled` count means a test hung and was never
evaluated.

Targeted runs take a glob: `node --test "dist/gate/*.test.js"`.

## The kinds of tests

| Kind     | Where                                         | What it proves                                                                                                                                                                                                                                                            |
| -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit     | `src/**/*.test.ts` beside the source          | behaviour of one module, with fakes injected through constructor options                                                                                                                                                                                                  |
| Real I/O | `src/control/*.test.ts`, `src/host/*.test.ts` | the link against an in-process WebSocket server, the bulk lane against an in-process HTTP server, git against a temporary repository                                                                                                                                      |
| Process  | `src/bin/*.test.ts`                           | the built binary spawned as a child: exit codes, signals, what it prints                                                                                                                                                                                                  |
| Property | `src/**/*.property.test.ts`                   | invariants over generated inputs (`fast-check`): codec round-trips, parser totality, sequence and queue models                                                                                                                                                            |
|          |                                               | The suite pins a seed so a run is reproducible. `PERISCOPE_FC_SEED=random` explores with fresh seeds (the weekly job does this); `PERISCOPE_FC_SEED=<number>` reproduces a reported failure. A counterexample is evidence first: read it before touching the precondition |
| Pins     | `src/pins/*.test.ts`                          | structural rules over the source tree: import boundaries, the closed vocabulary, no emoji, no dangling citations, the wire vectors, the public API                                                                                                                        |
| Live     | `src/**/*.live.test.ts`                       | claims about a real agent; skipped unless `PERISCOPE_LIVE=1`, and they spend tokens                                                                                                                                                                                       |

Shared test helpers live in `src/test-support/`. They never ship: the `files` allowlist, the
coverage exclude and the boundary pins all exclude that directory.

## Contracts that are approved, not asserted

Two pins compare the package against committed snapshots:

- `contracts/wire-vectors/*.json` — every payload kind encoded byte for byte, plus the refusal and
  tolerance cases. A `PROTOCOL_VERSION` bump reddens every vector until it is re-approved.
- `contracts/public-api.txt` — every export of `@naswerks/periscope` and `@naswerks/periscope/protocol` with its
  signature, plus the directory barrels.

When a change is intended, regenerate and review the diff:

```sh
npm run contracts:update
```

## Mutation testing

`npm run test:mutation` runs Stryker over the codec, sequence, queue, backoff, command parser,
shell classifier, decision reader and state machine. It takes minutes and runs weekly in CI, not on
pull requests. A surviving mutant is a test that passes for a reason unrelated to the property it
names.

## Live probes

```sh
PERISCOPE_LIVE=1 npm run test:live
```

They start real sessions and cost money. Run them on a machine that is not itself inside an agent
session, or the tool surface of the enclosing session contaminates the measurement.

`src/host/agent-controls.live.test.ts` measures the controls this host reaches: a model switch,
thinking off and back on, the bypass flag, the per-turn init, the gate under plan mode, the model
catalog, effort, plugins over stdin, the four events measured not to fire, and the task-list tools.
Its output is stated as behaviour in the documents, so run it after every agent SDK bump. One probe
runs on its own by name:

```sh
npm run build && PERISCOPE_LIVE=1 node --test --test-name-pattern="model catalog" dist/host/agent-controls.live.test.js
```

`src/host/further-writes.live.test.ts` holds that a Claude session's writes outside its own directory,
under its temp folder and in its worktree of a further repository, land where the gate allows them,
written by its Write tool and no shell command (the session's own tool calls say so). Its control
withholds the further repository from the session: that write is refused as outside the session's
roots, and the same check fails. Claude is handed neither place as a directory, so only a real turn
shows the gate's allow is enough; run it before tagging a release that moves where a session may write:

```sh
npm run build && PERISCOPE_LIVE=1 node --test dist/host/further-writes.live.test.js
```

`src/host/copilot.live.test.ts` holds Copilot under the gate against the SDK an operator installed,
signed in with a token file, on a real model: every call of a Copilot session asks this host (a read, a
refused write that does not run, an MCP call, a sub-agent's read), silence holds to the decision deadline,
an approved command's environment names no credential, and nothing the shell still runs outlives the
close. Run it before tagging any release that moves the Copilot SDK; the variables it needs are in its
header:

```sh
npm install --prefix <sdk directory> @github/copilot-sdk@1.0.34
npm run build && PERISCOPE_LIVE=1 PERISCOPE_COPILOT_SDK=<sdk directory> PERISCOPE_COPILOT_TOKEN_FILE=<token file> PERISCOPE_COPILOT_MODEL=<model> node --test dist/host/copilot.live.test.js
```

`src/host/opencode.live.test.ts` holds opencode under the gate against the SDK an operator installed, on a
real model behind an OpenAI-compatible endpoint, its key in a file: every call of an opencode session asks
this host (a read, a refused write that does not run, an MCP call, a subagent's read), a key the endpoint
refuses fails the run in the provider's words, silence holds to the decision deadline, an approved
command's environment holds no copy of the key, and nothing the shell still runs outlives the close. It
prints the receipts the facts are read from: the spend per model call, the first and last events of a run,
whether the skill handed over was loaded. Run it on Node 24 or later before tagging any release that
moves the opencode SDK; the variables it needs are in its header:

```sh
npm install --prefix <sdk directory> @opencode/sdk@2.3.0
npm run build && PERISCOPE_LIVE=1 PERISCOPE_OPENCODE_SDK=<sdk directory> PERISCOPE_OPENCODE_BASE_URL=<base url> PERISCOPE_OPENCODE_KEY_FILE=<key file> PERISCOPE_OPENCODE_MODEL=<model> node --test dist/host/opencode.live.test.js
```

`src/host/mid-turn-delivery.live.test.ts` records what the agent does with a message pushed on its input
while a turn runs: one plain, as this host sends every prompt, and two naming another session as their
origin, under the session's refusal of other sessions' messages. It asserts that each was pushed while
the turn's shell call was still running, that it lands inside that turn, that the model reads it and
names no other session as its sender, and that the session's transcript, found and holding the pushed
word, keeps no other session as its origin; a turn that never ran or a transcript that was not found is
a red of its own. A red on what the agent did is a change to record. It needs a Claude sign-in outside
an agent session. Run it with the release's live probes and after every agent SDK bump:

```sh
npm run build && PERISCOPE_LIVE=1 node --test dist/host/mid-turn-delivery.live.test.js
```

## Moving the agent SDK

The SDK is pinned exactly, and a bump is a minor release. In order:

1. Move `@anthropic-ai/claude-agent-sdk` in `package.json`, and its peer `@anthropic-ai/sdk` to the
   range the new manifest asks for, then `npm install`. Read the lockfile diff.
2. `npm run check:drift -- --update`, and read the type diff it reports.
3. Set `contracts/cli-version.txt` to the manifest's `claudeCodeVersion`; a pin derives it and fails
   while they differ.
4. Give every new hook event and message discriminator its coverage row (`src/state/coverage.ts`)
   and its lane (`src/control/stream-routing.ts`); the build fails until each has one.
5. `npm run contracts:update`, then update the version table in `README.md` and `SECURITY.md`.
6. Run the live probes above and bring the documents into line with what they print.

## Moving a pinned binary

Codex, Qwen Code and pi are binaries the operator installs, each pinned exactly
(`CODEX_PINNED_VERSION` in `src/host/codex-binary.ts`, `QWEN_PINNED_VERSION` in `qwen-binary.ts`,
`PI_PINNED_VERSION` in `pi-binary.ts`); a binary at any other version is listed unavailable. A move is a
minor release, one binary at a time, in order:

1. Pick the release: the newest that has been out a few days, and not deprecated (`npm view <package> time
--json` and `npm view <package>@<version> deprecated`, for `@openai/codex`, `@qwen-code/qwen-code` and
   `@earendil-works/pi-coding-agent`).
2. Clone the upstream repository at the old tag and at the new one, anywhere outside this checkout. A
   shallow clone carrying the blobs under 1 MB is enough (`git clone --depth=1 --filter=blob:limit=1m
--no-checkout --branch <tag> <url> <dir>`): the scripts read the tag with `git show`, and no install or
   build is needed. Codex tags its releases `rust-v<version>`, Qwen Code and pi `v<version>`.
3. Run the derive script against the old tag first: `node scripts/derive-codex-names.mjs <clone> <tag>`,
   `derive-qwen-names.mjs` or `derive-pi-names.mjs`. It must write the committed contract
   (`contracts/codex-protocol-names.json`, `qwen-code-names.json`, `pi-names.json`) byte for byte. If it
   does not, the script has drifted from the source and the diff in the next step would be its own; fix
   the script first. Codex's script needs Node 23.8 or later (`zlib.zstdDecompressSync`). Qwen Code's
   reads the system subtypes from the stream-json path's own files and from the service modules they
   import, because a service the path drives (the mod session) writes on it too.
4. Run it against the new tag and read the contract's diff: every notification, request, item kind, event,
   control request and tool the release added, renamed or dropped. That list is the work.
5. Move the constant. Every test that names the pinned version reads the constant; the version tests keep
   the old number as the one refused by name. Move the version in `README.md`'s and `SECURITY.md`'s
   tables, `docs/configuration.md`'s install line and the start line it quotes, the derive script's usage
   example, and `CHANGELOG.md`.
6. Give every name the release added its coverage row (`src/state/codex-coverage.ts`, `qwen-coverage.ts`,
   `pi-coverage.ts`), wired or declined with its reason, and remove the row of every name it dropped; the
   coverage pins (`src/pins/codex-coverage.test.ts`, `qwen-coverage.test.ts`, `pi-coverage.test.ts`) fail
   until each is placed. A stable Codex notification declined there is opted out at `initialize`.
7. Give every tool the release added its kind (`CODEX_TOOL_KINDS`, `QWEN_TOOL_KINDS`, `PI_TOOL_KINDS` in
   `src/gate/tool-kind.ts`) and, where it reads or writes a path or runs a command, its family
   (`src/gate/local.ts`), or state it `other` by name: the census in `src/gate/qwen-local.test.ts` and
   `pi-local.test.ts` names every tool of the release. A Qwen Code tool gets its ask rule from the contract
   (`qwenAskRules`); a tool the local gate cannot read the effect of, such as one that publishes under a
   name no reading of a command recognises, is denied in the session's settings (`QWEN_DENIED_TOOLS`).
8. Read the files each gate stands on at both tags, and carry what moved into the adapter and its tests.
   Each residual stays a named degrade; a new one is named, never absorbed.
   - Codex: the `PreToolUse` hook's input and output schemas
     (`codex-rs/hooks/schema/generated/pre-tool-use.command.*.schema.json`), what the hook's `cwd` is
     (`codex-rs/hooks/src/events/pre_tool_use.rs` and `common.rs`), hook trust and the Windows command
     line (`codex-rs/hooks/src/engine/discovery.rs`, `config_rules.rs`), the approval kinds and requests
     (`CommandExecutionApprovalKind` and the `*RequestApproval*` types under
     `codex-rs/app-server-protocol/schema/typescript/v2/`), every key the runner's home pins under
     `--strict-config` (`codex-rs/core/config.schema.json`), and the collaboration and sub-agent items
     (`ThreadItem.ts`).
   - Qwen Code: the settings scopes, their merge order and the rule lists' merge
     (`packages/cli/src/config/settings.ts`, `settingsSchema.ts`), how a deny, an ask and an allow are
     weighed (`packages/core/src/permissions/permission-manager.ts`), the approval modes, the
     `can_use_tool` request (`packages/cli/src/nonInteractive/control/controllers/permissionController.ts`),
     each new tool's source under `packages/core/src/tools/`, the results the stream writes, a
     sub-agent's included (`packages/cli/src/nonInteractive/io/BaseJsonOutputAdapter.ts`), and the
     Windows shell (`packages/core/src/utils/shell-utils.ts`).
   - pi: the extension `tool_call` event, its block and its rewrite
     (`packages/coding-agent/src/core/extensions/types.ts`, `runner.ts`, `loader.ts`), the launch flags
     and project trust (`packages/coding-agent/src/cli/args.ts`, `src/core/project-trust.ts`), the
     built-in tools' schemas (`src/core/tools/`), the RPC types (`src/modes/rpc/rpc-types.ts`), and how
     bash is found on Windows (`src/utils/shell.ts`).
9. Write any test of a new shape from the upstream source at the new tag, and say in the test which file
   it read. A shape only a live run can confirm is named for the probes below.
10. `npm run contracts:update` if a wire vector or the public API moved, then the whole gate (§ Build and
    test, then `npm run typecheck:examples`, `check:drift`, `check:publish`).
11. Run the binary's live probes from a plain terminal, with the new version installed (§ Live probes):
    Codex `src/host/codex-names.live.test.ts` (`PERISCOPE_CODEX_BIN`) and `codex-gate.live.test.ts`
    (`PERISCOPE_CODEX_HOME`, signed in, beside it); Qwen Code `src/host/qwen.live.test.ts`
    (`PERISCOPE_QWEN_BIN` and an endpoint); pi `src/host/pi-names.live.test.ts` (`PERISCOPE_PI_BIN`) and
    `pi.live.test.ts` (and an endpoint). Each runs as `npm run build && PERISCOPE_LIVE=1 node --test
dist/host/<probe>.js`, and the variables each needs are in its header.

## Moving the Copilot SDK

`@github/copilot-sdk` is the operator's install, never a dependency of this package: a development
dependency at exactly the pinned version (`COPILOT_SDK_PINNED_VERSION` in `src/host/copilot-sdk.ts`), for
its types and the tests. Each SDK release pins one Copilot runtime (`copilotRuntime.version` in its
manifest; `COPILOT_RUNTIME_PINNED_VERSION`), so a move is the SDK and its runtime together, a minor
release, in order:

1. Pick the release: the newest that has been out a few days, and not deprecated (`npm view
@github/copilot-sdk time --json`, `npm view @github/copilot-sdk@<version> deprecated`), and read its
   manifest's `copilotRuntime.version`.
2. Run the derive script against the install you have first: `node scripts/derive-copilot-names.mjs .`
   must write `contracts/copilot-names.json` byte for byte. If it does not, the script has drifted from
   the SDK's declarations; fix it first.
3. Move the development dependency (`npm install --save-dev --save-exact @github/copilot-sdk@<version>`)
   and both constants, then run the derive script again and read the contract's diff: every session event
   the release added, renamed or dropped. That list is the work.
4. `npm run build`. `src/pins/copilot-sdk-shape.test.ts` holds the seam's structural types to the SDK's
   own: a member renamed, a parameter narrowed or an export dropped fails the build there, by line. Fix
   the seam, never the pin.
5. Give every event the release added its row in `src/state/copilot-coverage.ts`, wired or declined with
   its reason, and remove the row of every event it dropped; `pins/copilot-coverage.test.ts` names each
   one missing or invented.
6. Run `src/host/copilot-local.test.ts`. It starts the new runtime with no model and no credential and
   holds what the gate leans on: the hook asks for a shell, a read, a write, an MCP tool and a skill, and
   the request is the hook's; `allow-all` still asks while the hook does; the session-start hook is not
   called at create; the census of built-in tools against `COPILOT_TOOL_KINDS`, `COPILOT_OTHER_TOOLS` and
   `COPILOT_EXCLUDED_TOOLS`; the open's read-back and probe; a sub-agent's call through the hook, driven by
   a stub model; and nothing alive after close. A red here is a property the gate depends on that moved:
   stop and decide it before anything else.
7. Measure what the docs state as measured: how long the runtime holds a permission request
   (`COPILOT_MEASURED_PERMISSION_WAIT_MS`), and move the constant and its date only to a longer wait that
   was measured.
8. Move the versions in `README.md`'s and `SECURITY.md`'s tables, `docs/configuration.md`'s install line
   and `CHANGELOG.md`, then `npm run contracts:update` and the whole gate.
9. Run the live probe (§ Live probes) with the new SDK installed into a directory of its own.

## Moving the opencode SDK

`@opencode/sdk` is the operator's install, never a dependency of this package: a development dependency at
exactly the pinned version (`OPENCODE_SDK_PINNED_VERSION` in `src/host/opencode-sdk.ts`), for its types and
the tests. Each release of it is one release of opencode: its server, core and client move with it, and an
install of the SDK at the pin whose server, core or client is of another version is refused. A move is a minor
release, in order:

1. Pick the release: the newest that has been out a few days, and not deprecated (`npm view @opencode/sdk
time --json`, `npm view @opencode/sdk@<version> deprecated`), and check that it still parses on the
   Node this package's opencode tests run on: the SDK's tree needs Node 24 today.
2. Run the derive script against the install you have first: `node scripts/derive-opencode-names.mjs .`
   must write `contracts/opencode-names.json` byte for byte. If it does not, the script has drifted from the
   SDK's declarations; fix it first.
3. Move the development dependency (`npm install --save-dev --save-exact @opencode/sdk@<version>`) and the
   constant, then run the derive script again and read the contract's diff: every event the release added,
   renamed or dropped. That list is the work.
4. `npm run build`, then `src/pins/opencode-sdk-shape.test.ts`, which compiles the seam's structural types
   against the SDK's own in a program of its own: a member renamed, a parameter narrowed or an export
   dropped fails there, by entry, and so does a type of the SDK's that stopped resolving. Fix the seam, never
   the pin.
5. Give every event the release added its row in `src/state/opencode-coverage.ts`, wired or declined with
   its reason, and remove the row of every event it dropped; `pins/opencode-coverage.test.ts` names each one
   missing or invented.
6. Read the release's tools and plugins: a new tool that runs without asking, or that waits on a form, is
   turned off (`OPENCODE_DENIED_TOOLS`) or given a kind; a new built-in plugin that can act outside a call
   is turned off (`OPENCODE_OFF_PLUGINS`).
7. Run `src/host/opencode-local.test.ts`. It runs the new SDK with a stub model on loopback and no
   credential, and holds what the gate leans on: the open's read-back on the real server and its refusal of
   a planted allow and a second provider; the census of the tools the model is offered against
   `OPENCODE_TOOL_KINDS`, `OPENCODE_OTHER_TOOLS` and `OPENCODE_DENIED_TOOLS`; a refused write, a shell call's
   dialect, a subagent's and a fork's calls, an MCP server's spelling, a write outside the roots and the
   deadline; the environments a command and the host process run with; no port; and nothing alive after
   close. A red here is a property the gate depends on that moved: stop and decide it before anything else.
8. Move the versions in `README.md`'s and `SECURITY.md`'s tables, `docs/configuration.md`'s install line,
   the live probe's install line and `CHANGELOG.md`, then `npm run contracts:update` and the whole gate.
9. Run the live probe (§ Live probes) with the new SDK installed into a directory of its own.

## Boundaries the pins enforce

- Only `src/host/` may import `node:fs`, `node:child_process`, `node:os`, or the Agent SDK.
- Nothing imports the Copilot SDK: `src/host/copilot-sdk.ts` loads it from the operator's install by
  path, and a test imports its types alone. It is a development dependency, never a dependency.
- `src/core/` imports nothing outside itself.
- `@naswerks/periscope/protocol` reaches no file under `src/host/` and no Node builtin.
- No comment or string carries an emoji, a tracking id from some other project, or a citation of a
  test file that does not exist.
- The vocabulary is the SDK's: no controller-side word appears anywhere in the package;
  `src/pins/vocabulary.test.ts` holds the list.

If a pin turns red on your change, fix the change; widen a pin only with a stated reason in the
pin's own comment.

## Writing comments

State what the code does and why it must, in one or two sentences. No history, no attribution, no
dates, no emphasis markers. A test name is a behavioural sentence; prefix it with `regression: `
when it pins a defect that once shipped and `control: ` when it proves a detector can fire.

## Runtime

The package's contract is the Node the Claude Code CLI runs under: the host spawns that CLI through
the SDK, reads its home directory and signals its process. `engines` names Node alone, `.nvmrc`
holds the floor, and a pull request that adds a Bun, Deno or other runtime shim, lockfile or
publish target is declined by policy rather than reviewed on its merits.

## Versioning

The package follows semantic versioning; the wire protocol version is a separate number and has its
own window (`docs/protocol.md`). Patch: no wire or API change. Minor: a protocol bump (the previous
protocol version stays supported for one minor), an agent SDK pin bump, or an additive API. Major: a
wire change outside the window, or a removed or changed export. `contracts/public-api.txt` is what
"export" means; a diff in it decides the bump.

## Releasing

`CHANGELOG.md` is the hand-written record in Keep a Changelog shape; there is no changeset directory
and no release bot, and the entry is written by whoever made the change. At release the
`## [Unreleased]` block becomes `## [x.y.z] - date`, `package.json` `version` moves to match, and a
`vx.y.z` tag on that commit runs `.github/workflows/release.yml`: `npm ci`, the suite, the lint and
format checks, the pack checks, the publish gate (`npm run check:publish`, which lists anything a
publish still owes), a check that the tag names the manifest version, then `npm publish` with
provenance through npm trusted publishing (no token lives in this repository) and a GitHub Release
whose notes are the matching changelog section, extracted rather than retyped.

While `package.json` carries `private: true` the same workflow runs every check and rehearses the
pack instead of publishing, and says so in its log; nothing leaves the runner.
