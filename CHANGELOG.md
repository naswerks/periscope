# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semantic versioning: patch
for no wire or API change, minor for a protocol bump (the previous version stays supported for one
minor), an agent SDK pin bump or an additive API, major for a wire change outside the window or a
removed export. The package version and the wire protocol version are separate numbers.

## [Unreleased]

## [1.0.0] - unreleased

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
0.3.220 (Claude Code 2.1.220) on ubuntu and windows with node 22 and 24; the four numbers per
platform are recorded here from the first green run of this repository's CI before the tag.
