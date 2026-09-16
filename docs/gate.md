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

What refuses locally, and only locally: a path that escapes the session's workspace
(`path-escapes-root`), a read of the protected set (`credential-path-denied`), and a git invocation
whose verb is not on the allow-list. A boundary-crossing shell shape (`shell-boundary-command`: a
push, a force, a remote change, a branch deletion, a merge) is classified locally and then
escalated like any other call, because a controller may hold it for a person to answer; refusing it
in-process would make that answer impossible to give. With the controller unreachable it refuses at
the decision deadline.

- It adds refusals and never removes one. No opinion returns `null` and the surrounding gate asks
  whoever it was going to ask. A locally-decided refusal is `refusal/<reason>`, and the fix for one
  lives with the embedder's policy.
- A throwing local gate refuses; it must not fall through (`askLocalGate` in `src/gate/gate.ts`).
- The vocabulary is owned locally, never received. The wire carries no policy in either direction;
  the embedder chooses tool families and protected paths at construction.
- Optional in the type, supplied by default by `PeriscopeHost`: jailed to the session's own
  workspace, with `credentialPaths(env, { agentHome })` as the protected set. That set, stated once
  (`src/host/paths.ts`): the host's own config directory (`PERISCOPE_CONFIG_DIR` or
  `~/.periscope`, which holds the token cache, the paired credential and the config file);
  `~/.claude` and `~/.claude.json`; `~/.aws`, `~/.config/gcloud`, `~/.azure`, `~/.ssh`;
  `CLAUDE_CONFIG_DIR` when set; and the effective agent home when it is not the default. The
  host's own cache location derives from the same function, so the two cannot disagree about what
  is protected. The repository read doors honour the same set.
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
be correlated without re-deriving it from transport state. The POST presents a credential per
request (`EscalationOptions.credential`, resolved at call time), and a refusing credential is an
outage, the deliberate opposite of the link's posture: a prompt that cannot be delivered is
retried; a gate that cannot authenticate must not proceed. Resolving per request makes this lane a
second caller of `authorize()`, so a busy session reports one `cache-hit` per decision; read a
stream of them as the gate working, never as a credential problem.

## What is deliberately not covered

- `bypassPermissions` is composable, as the SDK's own `permissionMode` vocabulary. It travels wire
  to `readSessionRequest` to `src/host/agent-process.ts` and nowhere else, and
  `pins/permission-config.test.ts` holds three things: no settings-file or rule-list option
  anywhere, `permissionMode` only on that path, and `setPermissionMode` called from one module (by
  `session_configure`) while the other mid-session mutators stay uncalled. The gate keeps its
  authority through `PreToolUse` in every mode; the package's own measurement of a hook deny
  surviving bypass is the unexercised probe above.
- `permissionDecision: 'defer'` was evaluated and not adopted: it ends the query for a later
  resume, a different lifecycle from "hold, then continue with everything you knew".
- `outputFor` cannot render a hold: `holding` is excluded by the type, not by a branch. A branch
  that returned `{}` for it would be no opinion, which the CLI reads as allow, so the one state that
  could open the door is made unrepresentable rather than handled.

## Where things live

| Path                                       | What                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/gate/gate.ts`                         | `permissionHooks()`: registration, the fail-closed wrappers, both deadlines, the hold                             |
| `src/gate/decision.ts`                     | `Decision` (the SDK's `PermissionResult`) and `readDecision`, the total parser                                    |
| `src/gate/outcome.ts`                      | `GateOutcome` (`holding`, `allow`, `deny`, `refused`, `expired`) to transitions, pure; `recordGateOutcome`        |
| `src/gate/escalate.ts`                     | `escalatingDecider()`: status before body, `EscalationUnavailable`; the HTTP lane the link does not carry         |
| `src/gate/local.ts`                        | `localGate()`: the host's own offline refusal; pure, synchronous, total                                           |
| `src/gate/jail.ts`                         | The path jail and the protected-path check; `pathFromToolInput`, `commandFromToolInput`                           |
| `src/gate/shell.ts`, `src/gate/command.ts` | `classifyShellCommand` over `parseCommand`'s parsed shape                                                         |
| `src/host/paths.ts`                        | `credentialPaths(env)` and `nodePathResolver`: the one source of the protected set and the token cache's location |
| `src/host/host.ts`                         | Where the gate is composed onto a session, and the `grantOnAllow` and `settingSources` refusal                    |
| `src/pins/permission-config.test.ts`       | The shadowing-lane pin, compile and scan halves                                                                   |
| `src/gate/gate.live.test.ts`               | The live probes, skipped unless `PERISCOPE_LIVE=1`                                                                |
