/**
 * What the gate did, and the transitions that say so.
 *
 * This file is pure, and that is the point. Turning an outcome into transitions has no clock, no
 * machine and no SDK in it, so the mapping every emitted trace depends on can be checked exhaustively
 * without a session anywhere near it. `recordGateOutcome` below is the two-line impure half.
 *
 * The gate declares no status of its own. Every outcome here lands on the declared state model's
 * existing states, activities and causes. A gate that found itself wanting a status word would have
 * found a state missing from that model — a finding for it, never a column here.
 *
 * Five outcomes, three cause kinds, and the separation is the whole value. A denial is
 * `control/permission_denied` — somebody decided. An outage and an unrecognised answer are
 * `refusal/…` — nobody decided, and the two are different investigations. An expiry is
 * `timeout/hook_timed_out`. Every one of them blocks the tool, so the invariant is identical and
 * only the story differs; conflating an outage with a deliberate "no" is an expensive failure, and
 * it is why the kinds are separate rather than one kind with a different string in `detail`.
 */
import type { Refusal } from '../core/refusal.js';
import type { SessionActivity, TransitionCause } from '../state/model.js';
import { HOOK_TIMEOUT_EVENT } from '../state/model.js';
import type { SessionStateMachine, TransitionRequest } from '../state/machine.js';
import type { Result } from '../core/result.js';
import type { SessionTransition } from '../state/model.js';
import type { DecisionRequest } from './decision.js';

/**
 * What happened to one tool call.
 *
 * `held` says whether a permission entry was opened for this call — i.e. whether the decision took
 * long enough to be worth reporting as a session that is waiting. It is carried on every terminal
 * outcome because the close is only correct when there was an open.
 */
export type GateOutcome =
  /** The decision is taking long enough to be a hold. Opens the permission entry. */
  | { readonly kind: 'holding'; readonly request: DecisionRequest }
  | {
      readonly kind: 'allow';
      readonly request: DecisionRequest;
      readonly updatedInput?: Record<string, unknown>;
      readonly held: boolean;
    }
  | {
      readonly kind: 'deny';
      readonly request: DecisionRequest;
      readonly message: string;
      readonly held: boolean;
    }
  /** Nobody decided: the decider threw, the escalation failed, or the answer was not understood. */
  | {
      readonly kind: 'refused';
      readonly request: DecisionRequest;
      readonly refusal: Refusal;
      readonly held: boolean;
    }
  /** The host's own deadline passed before an answer arrived. */
  | {
      readonly kind: 'expired';
      readonly request: DecisionRequest;
      readonly detail: string;
      readonly held: boolean;
    };

const permissionActivity = (toolName: string): SessionActivity => ({ kind: 'permission', name: toolName });

/**
 * How the gate keys its hold entry: by `tool_use_id`, which every `PreToolUse` carries.
 *
 * Deliberately not the observer's name-keyed `permission:<toolName>`. The observer's `PreToolUse`
 * branch closes any open name-keyed permission entry — the allow-path exit for its own
 * `PermissionRequest` lane — so a name-keyed hold could be closed by the next `PreToolUse` for the
 * same tool while this call's decision is still outstanding, recording a resolution that never
 * happened. Two writers, two key spaces: the observer owns `permission:<toolName>`, the gate owns
 * `permission:<toolUseId>`, and two simultaneous holds for one tool are two entries. The
 * `permission:` prefix is kept so this key can never collide with the observer's `tool` entry,
 * which is the raw tool_use_id from the same event.
 */
const holdEntryId = (toolUseId: string): string => `permission:${toolUseId}`;

/**
 * The transitions one outcome produces. Pure, total, and often empty.
 *
 * An ordinary allow emits nothing, deliberately. The observer's own `PreToolUse` record already
 * says the tool started, and a second transition saying it was permitted would be one fact recorded
 * twice — which is how a trace stops being countable. A held allow is different: an entry was
 * opened, so it has to be closed, and that close is a real event with a real duration behind it.
 */
export function gateTransitions(outcome: GateOutcome): TransitionRequest[] {
  const { request } = outcome;
  const entryId = holdEntryId(request.toolUseId);

  // The event that fired is `PreToolUse`. Naming `PermissionRequest` or `PermissionDenied` here
  // would be truer to the concept and false about the world — observed, neither of those hooks fires
  // for a hook-authored decision — and a trace that names an event which never happened teaches its
  // next reader something untrue.
  const onTheHook = (detail: string): TransitionCause => ({ kind: 'hook', event: 'PreToolUse', detail });

  if (outcome.kind === 'holding') {
    return [
      {
        to: 'working',
        entry: {
          op: 'open',
          entryId,
          activity: permissionActivity(request.toolName),
          agentId: request.agentId,
        },
        cause: onTheHook(`a permission decision for ${request.toolName} is outstanding`),
      },
    ];
  }

  const closeIfHeld = outcome.held ? ({ op: 'close', entryId } as const) : null;

  if (outcome.kind === 'allow') {
    if (!outcome.held) return [];
    return [
      {
        to: 'working',
        entry: closeIfHeld,
        cause: onTheHook(`the permission for ${request.toolName} resolved: allowed`),
      },
    ];
  }

  if (outcome.kind === 'deny') {
    return [
      {
        to: 'working',
        entry: closeIfHeld,
        // A call the host made on itself — which is what `control` means here, and what a
        // hook-authored deny literally is. See CONTROL_EVENTS' own note: kind and event are
        // validated independently and never as a pair, so this pairing is an authorial choice.
        cause: { kind: 'control', event: 'permission_denied', detail: outcome.message },
      },
    ];
  }

  if (outcome.kind === 'refused') {
    return [
      {
        to: 'working',
        entry: closeIfHeld,
        cause: { kind: 'refusal', event: outcome.refusal.reason, detail: outcome.refusal.detail },
      },
    ];
  }

  return [
    {
      to: 'working',
      entry: closeIfHeld,
      cause: { kind: 'timeout', event: HOOK_TIMEOUT_EVENT, detail: outcome.detail },
    },
  ];
}

/** The impure half: put an outcome's transitions on a machine. Returns what it recorded. */
export function recordGateOutcome(
  machine: SessionStateMachine,
  outcome: GateOutcome,
): Result<SessionTransition>[] {
  return gateTransitions(outcome).map((request) => machine.record(request));
}
