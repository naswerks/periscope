# The session state machine

The declared state model every other part emits into: caused transitions, open entries with ages,
the durable append-only log they land in, and the coverage tables that make "every hook wired or
declined" auditable. The package overview is [architecture.md](architecture.md); how transitions
ride the wire is in [protocol.md](protocol.md).

## Two machines, two altitudes

Periscope's machine speaks the SDK's session lifecycle and lives in memory, per host, one per
session. A controller's machine speaks the controller's own vocabulary and consumes Periscope's
transitions as input. The host emits valid, caused transitions and detects unpaired entries; it
never learns a controller's word and never derives a controller's state. A consumer that finds
itself adding a status field has found a missing state in this model, not a local column.

## The vocabulary (`src/state/model.ts`)

Seven states: `spawning`, `ready`, `working`, `idle`, `errored`, `interrupted`, `ended`. `ready`
means the agent reported itself (`system/init`, the only source of the session id, the CLI version,
the model, the tool, skill and plugin inventory and `apiKeySource`). Init arrives mid-turn, so a
real trace reads `working` then `ready` then `working`: `UserPromptSubmit` fires before
`system/init`. A session created but never prompted sits in `spawning` until the start timeout;
that missing `ready` is what makes the emits-nothing-until-prompted behaviour legible instead of a
hang.

Two notes for a consumer of the `ended` edge:

- A refused open is emitted as `spawning` to `ended` with cause `{ kind: 'refusal', event: <reason> }`.
  No machine ever existed, so it is the one transition the host composes by hand: `sessionId: null`,
  `correlationId` the controller's handle, `seq: 1`, the refusal's detail carried whole. It rides
  the ordinary `StateTransitionUpdate` lane.
- The host's `ended` is the controller's fact. A controller ends its own record of the session on
  it, the refused open included, and never waits for a second signal.

Six activity kinds, structured `{ kind, name }` and never composed strings: `tool`, `subagent`,
`permission`, `elicitation`, `requesting`, `compacting`. `formatActivity()` makes the display
string; the structure is the truth. There is no activity for "escalated to a human": that is a
judgement the host cannot make.

`SessionLifecycle` (`provisioning`, `live`, `ended`, in `src/sessions/session.ts`) is an input to
this machine; lifecycle changes arrive as `cause.kind: 'process'`. It is not a peer model, and the
two are not symmetric.

## The transition record

```
{ sessionId, seq, at, from, to, activity,
  cause: { kind, event, detail },        // kind: hook | sdk-message | control | timeout | process | refusal
  where: { worktree, branch, cwd } }
```

- `cause` is compile-closed and required. `CauseEvent` is the union of the hook events, the message
  discriminators, `CONTROL_EVENTS`, `PROCESS_EVENTS`, `TIMEOUT_EVENTS` and `RefusalReason`; a
  transition that cannot name its cause does not compile.
- `refusal` is the sixth kind because a denial and an outage cannot be told apart with five: a deny
  is `control/permission_denied`, an outage is `refusal/permission-decision-unavailable`, different
  in kind and in event, never only in prose. `detail` is for people and is never branched on.
- `kind` and `event` are validated independently, never as a pair: `nameable()`
  (`src/state/machine.ts`) accepts `{ kind: 'hook', event: 'permission_denied' }` although it is
  incoherent. Coherence is the author's job, stated at `CONTROL_EVENTS`.
- `where` carries forward across transitions and updates on `CwdChanged`; `src/host/git-facts.ts`
  reads worktree and branch read-only and understands the linked-worktree `.git` file. The
  `spawning` transition's `where.cwd` is the workspace the session got, and that property is
  pinned.

## The state is the record

`SessionStateMachine` has no backing fields: `state`, `activity`, `sessionId` and `where` all derive
from the last recorded transition, and the commit has one assignment, no branches and one exit
(`pins/state-record.test.ts`). A path that skips the record therefore also fails to change the
state, so suppression is self-defeating instead of silent. Two laws follow: a state record and a
control signal never share a guard, and no state is inferred from the absence of something.

`record()` never throws, deliberately. Every hook handler is wrapped in `try/catch` (a throwing hook
is fail-open in the SDK), so a throw from the emitter would be swallowed by the safety wrapper and
the transition would vanish. Loud means refused, counted and reported on `onRejected`; emission
rides outside the deny path's wrapper.

## Open entries are aged, never silently reconciled

Entry operations are `open`, `close`, `background` and `abandon-open`. Every entry gets an exit or
is surfaced open with an age. A session sitting in `tool:Bash` for forty minutes is the most useful
thing this layer can say, and cleanup may mark an entry abandoned but never erase that it happened.
Backgrounding: an entry moves to the background set at the moment it backgrounds, with a cause
(`task_updated`'s `is_backgrounded`), still owes an exit (`task_notification`), and a session with
only background work is `idle`; it can take a new prompt while a build runs.

For a denied tool call `PostToolUse` does not fire; `PostToolBatch` is the entry backstop (its
`tool_calls` includes denied ids) and it records "closed by the end of its batch". It never says
denied. The denial itself is the gate's own `control/permission_denied` transition
([gate.md](gate.md)).

A transition recorded before `system/init` has `sessionId: null`, and a `SessionFrame` requires a
non-empty id; the frame's `sessionId` is the controller's handle for exactly this reason. The one
pre-init transition that rides the wire is the refused open above: the frame carries the
controller's handle, the body carries `sessionId: null`.

## Where a transition ends up

Three destinations, not interchangeable:

| Destination                                           | What it holds                                         | The rule                                                                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `TransitionStore` (`src/state/store.ts`)              | A bounded in-memory ring, rejections included         | It drops its oldest once a session outruns the window; never the record of anything                                              |
| The wire                                              | Every recorded transition, whichever lane produced it | `forwardSession` subscribes to `machine.onTransition`, so a hold, a deny, an outage and a local refusal all reach the controller |
| The durable log (`src/persistence/transition-log.ts`) | The keepable record                                   | Append-only; the single point of truth for locally-decided refusals                                                              |

Append-only is load-bearing. The ring overwrites and the wire is delivery, not storage, so the
durable log is the only place a path-jail denial, a boundary command, a credential-path read or an
unconvertible tool descriptor survives at all. A tidy-up here does not lose a log line; it loses
the only evidence that the gate ever ran.

- `markAbandoned` appends, never edits. It writes a new record carrying the reason; a reconciler
  that quietly closed the entry would destroy the forty-minute sentence above.
- The cause survives the round trip or the read refuses. The encoder writes all three parts and the
  decoder rejects an entry that lost any of them rather than substituting a plausible default.
- Deltas never enter it (declared in `MESSAGE_ROUTING`), and that half of the replay rule points
  the opposite way from retransmission ([protocol.md](protocol.md)). Both halves are pinned.

## The coverage tables

`src/state/coverage.ts` lists every hook event and every `SDKMessage` discriminator as wired or
declined, each row carrying its reason. Count the tables; never carry the numbers. They are kept
honest three ways: `satisfies Record<HookEvent, CoverageRow>` breaks the build when the SDK adds an
event; `pins/hook-coverage.test.ts` parses the unions out of the installed `sdk.d.ts` itself, with a
positive control on the parser; and `observationHooks()` derives its registrations from the table,
pinned to match. An event absent from the table is a gap, not a default.

The table answers "does this move the machine". `MESSAGE_ROUTING` (`src/control/stream-routing.ts`)
answers "does this go on the wire". They disagree in both directions on purpose (`assistant` is
declined here and forwarded there; `session_state_changed` is wired here and declined there) and
must never be merged.

The runtime wins over the types. Four wired events are measured not to fire under an SDK-hosted
session: `SessionStart` (take the start receipt from `system/init`), `PermissionRequest` and
`PermissionDenied` (a hook-authored deny blocks while both stay silent), and
`system/session_state_changed` (`Stop` and `result` are the observed turn boundaries). The rows stay
wired, because "wired and not observed" is a question and "declined" closes one, and each says
"measured not to fire" at the row. Re-measure before relying on any of the four.

## The reporter is not a roster

`SessionStateReporter` enumerates this host's sessions with state, activity and open-entry ages:
the raw material a controller's roster aggregates. It has no predicate, no search and no notion of
which sessions are interesting; a host that judges gets rebuilt per product. Do not grow it one.

## Where things live

| Path                                | What                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/state/model.ts`                | States, activities, the closed cause vocabularies, `SessionTransition`, `OpenEntry`            |
| `src/state/machine.ts`              | `SessionStateMachine`: derive from the last transition; `record`, `onTransition`, `onRejected` |
| `src/state/observer.ts`             | The one translation site from SDK hooks and messages to transition requests                    |
| `src/state/store.ts`                | `TransitionStore`, the bounded in-memory ring that retains rejections and drops its oldest     |
| `src/persistence/transition-log.ts` | The durable append-only log; `markAbandoned`; the cause-survives-or-refuse decoder             |
| `src/state/coverage.ts`             | `HOOK_COVERAGE` and `MESSAGE_COVERAGE`, wired or declined with reasons                         |
| `src/state/reporter.ts`             | Enumeration of this host's sessions                                                            |
| `src/host/hooks.ts`                 | `observationHooks()`, derived from the table, and `mergeHooks()`                               |
| `src/host/git-facts.ts`             | Read-only `where`, including the linked-worktree `.git` file                                   |
| `src/pins/state-record.test.ts`     | The no-suppressing-branch structural pin                                                       |
