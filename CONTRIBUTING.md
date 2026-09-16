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

- Node 22 or newer (the CI matrix runs 22 and 24 on Linux and Windows).
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

## Boundaries the pins enforce

- Only `src/host/` may import `node:fs`, `node:child_process`, `node:os`, or the Agent SDK.
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
