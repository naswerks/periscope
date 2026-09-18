# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semantic versioning: patch
for no wire or API change, minor for a protocol bump (the previous version stays supported for one
minor), an agent SDK pin bump or an additive API, major for a wire change outside the window or a
removed export. The package version and the wire protocol version are separate numbers.

## [Unreleased]

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
