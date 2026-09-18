# Periscope

[![npm](https://img.shields.io/npm/v/%40naswerks%2Fperiscope.svg)](https://www.npmjs.com/package/@naswerks/periscope)
[![ci](https://github.com/naswerks/periscope/actions/workflows/ci.yml/badge.svg)](https://github.com/naswerks/periscope/actions/workflows/ci.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

Self-hosted runner for agent sessions: dials out to your controller, then spawns, gates, observes,
prompts and streams. It runs where the code is; the controller runs wherever you put it.

```sh
npm install -g @naswerks/periscope     # the host, on the machine that runs sessions
npm install @naswerks/periscope        # the library: wire types, codec, and the host as a module
```

The process on your machine dials out to the controller and takes its orders from there. What it
hosts is a live conversation you can steer mid-turn, not a job you collect at the end. It opens no
port and carries no opinion about what a session _means_: it emits what happened, and the
controller decides what to do about it. The agent it hosts is Claude Code, through the Claude Agent
SDK, behind a seam whose own vocabulary names no agent; the agent's hook and message names ride
the wire as `cause.event`, and the transcript locator is `claude-transcript:`.

## Run a host

You have a controller's address and a pair code from whoever runs it.

```sh
npm install -g @naswerks/periscope
npm install -g @anthropic-ai/claude-code && claude auth login
periscope pair <code> --controller https://controller.example --label "build box"
periscope
```

The second line signs the agent in, once, as the OS user that runs the host (`claude auth status`
says whether it already is): the host runs the Claude Code CLI headless, and it authenticates
through the credential under `~/.claude` that `claude auth login` writes. `ANTHROPIC_API_KEY` in
your shell is not inherited by a session.

The third line answers with the host's new id and writes the credential and the two addresses the
host dials, so nothing else needs setting:

```
paired as ph-8cb226ae…; credential written to ~/.periscope/paired-credential.json
this host now dials with the paired credential - the sign-in token expiry no longer applies to it
PERISCOPE_CONTROLLER_URL and PERISCOPE_DECISION_URL written to the config file - serve needs nothing else
```

The fourth starts the host, in the foreground, until you stop it:

```
[host] periscope 1.0.2 · host ph-8cb226ae… (paired; configured build-box) · credential paired · workspace none · config file ~/.periscope/config.json
[credential] paired as ph-8cb226ae… - the paired credential is presented on every dial
[link] idle -> connecting (start_requested)
[link] connecting -> open (socket_connected)
[link] open -> accepted (hello_completed) — protocol v9
```

`periscope status` prints the same posture from any terminal and never dials. A controller on a
development certificate (`https://localhost:…`) is refused by Node until Node is pointed at that
certificate: [configuration](docs/configuration.md#the-two-addresses).

To give sessions a repository and a git worktree each, from the terminal or from the controller, to
run under a supervisor, or to set anything by hand: [configuration](docs/configuration.md). To pair
with a signed-in identity instead of a machine credential: [identity](docs/identity.md).

## Write a controller

A controller serves two transports: the WebSocket the host dials, and an HTTP endpoint the host
POSTs each permission decision to. The second is easy to miss, because nothing on the wire announces
it. `@naswerks/periscope/protocol` ships the wire types and the codec without anything that can
reach a process or a disk; `contracts/wire-vectors/`, shipped in the package, is the same contract
as bytes, for a controller in any language.

```sh
git clone https://github.com/naswerks/periscope && cd periscope && npm ci && npm run build
node examples/test-controller/serve.ts
```

That runs the reference controller and prints the exact `periscope pair` line that redeems a code
against it. [The wire protocol](docs/protocol.md) is the contract: the envelope, the sequence rules,
the handshake, pairing, the decision endpoint's request and answer, and a checklist of what a
controller owes. [`examples/`](examples/README.md) holds the smallest controller that completes a
link (forty lines) and the reference.

## How it works

**One socket out, nothing in.** The host opens a single WebSocket to the controller and keeps it
alive: a heartbeat both ways, jittered backoff, a bounded offline queue. Frames carry commands and
facts (every state transition the machine records rides the wire); bulk content leaves by an HTTP
POST the controller asks for. Sequence numbers are dense per session per direction, so a reconnect
replays exactly what was missed. [protocol](docs/protocol.md)

**The gate fails closed.** There is no permission prompt: the host runs the agent headless, does not
pass `--dangerously-skip-permissions`, and registers a `PreToolUse` hook on every session that is
the only path to a yes. That is a stricter gate than the prompt, not a weaker one: path escapes,
credential reads and unrecognised git verbs are refused locally before the controller is asked,
everything else is the controller's decision, and no answer is a refusal. The gate is the host's
one control; the rest is the controller's trust: it chooses the permission mode (`bypassPermissions`
included), it can run a command at session start, set the agent's environment, remove worktrees and
read transcripts. [`SECURITY.md`](SECURITY.md) states that reach exactly; read it before you install
this.
[gate](docs/gate.md)

**Workspaces are the host's.** A session runs in the directory the controller names, or in a plain
directory per workspace key, or in a linked git worktree of a repository on its own branch, and the
controller can list and release them over the wire. [configuration](docs/configuration.md)

**Identity is paired or signed in.** A paired machine credential has no clock and dies only when the
controller revokes it; a signed-in user's token goes through a generic OIDC client with no provider
baked in. The agent's own sign-in is a separate credential. [identity](docs/identity.md)

**The session is a state machine.** Every message, hook and gate outcome is a recorded transition
with a cause from a closed vocabulary, so an unattended night is readable afterwards.
[state machine](docs/state-machine.md)

## Does it work, and against what

`npm test` is a clean build then `node --test` over the compiled output; CI runs it on
`{ubuntu-latest, windows-latest}` x node `{22, 24}` on every change, ratchets line coverage against
`coverage.floor`, packs the tarball and installs it into an empty project, and runs mutation testing
weekly. Both operating systems are load-bearing: Windows is where `USERPROFILE`, case-insensitive
env matching and path handling are observable, and Linux is the only place POSIX file modes mean
anything. The figure for a release is in [`CHANGELOG.md`](CHANGELOG.md).

|                                  |                                       |
| -------------------------------- | ------------------------------------- |
| `@anthropic-ai/claude-agent-sdk` | **0.3.220**, pinned exactly, no caret |
| Claude Code CLI                  | **2.1.220** (bundled with that SDK)   |
| Node                             | 22 or later; CI proves 22 and 24      |

The SDK is pre-1.0, so the SHA-256 of its installed type definitions is kept in
`contracts/sdk.sha256` and CI fails on any drift; a bump cannot land without someone reading what
changed. The package follows semantic versioning; the wire protocol version is a separate number
with its own window ([versioning](CONTRIBUTING.md#versioning)).

## Naming

Method and field naming follows the [Agent Client Protocol](https://agentclientprotocol.com) (Zed
Industries, Apache-2.0): `session/new`, `session/prompt`, `session/cancel`, `session/update`, its
camelCase keys and snake_case discriminators. This is not ACP compatibility, and Periscope must not
be described as ACP-compatible: ACP points the connection inbound, Periscope dials out, and every
type here is written from scratch. Elsewhere the vocabulary is the SDK's own.

## Documents

[architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[configuration](docs/configuration.md) · [identity](docs/identity.md) · [gate](docs/gate.md) ·
[state machine](docs/state-machine.md) · [`examples/`](examples/README.md) ·
[`SECURITY.md`](SECURITY.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CHANGELOG.md`](CHANGELOG.md) ·
licence [MIT](LICENSE).
