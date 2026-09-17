/** The PreToolUse hook and the permission decision path. */
export type { Decider, Decision, DecisionReading, DecisionRequest } from './decision.js';
export { describeRaw, readDecision } from './decision.js';

export type { GateOutcome } from './outcome.js';
export { gateTransitions, recordGateOutcome } from './outcome.js';

export type { OutcomeListener, PermissionGateOptions } from './gate.js';
/**
 * The PreToolUse gate itself.
 *
 * `composeSession` is a convenience that refuses, not a boundary. `composeSession` declines to
 * assemble `grantOnAllow` together with a non-empty `settingSources`
 * (`permission-grant-shadows-settings`), and it is the only place that can see both facts. But
 * every part it composes is exported, including this one, so four lines reach the refused pair
 * without going near it:
 *
 * ```ts
 * const hooks = mergeHooks(observationHooks({ observer }), permissionHooks({ decide, onOutcome, grantOnAllow: true }));
 * registry.create({ cwd, hooks, settingSources: ['project'] });   // no refusal fires
 * ```
 *
 * This is stated rather than closed, deliberately. Hand-composition is a supported posture — the
 * gate is usable without the host — and un-exporting it would remove a legitimate capability to
 * discourage a combination that, per the SDK's documented evaluation order, does not actually
 * override operator deny rules (see `gate.ts` for the order, and for why that is documented rather
 * than measured). An embedder who assembles the pair on purpose should know they have done it;
 * an embedder who expected `composeSession`'s refusal to be a package-wide guarantee should know
 * it is not.
 */
export { permissionHooks } from './gate.js';

export type { EscalationOptions, EscalationResponse, EscalationTransport } from './escalate.js';
export { EscalationUnavailable, escalatingDecider } from './escalate.js';

// The host's own gate — the offline-provable local refusal.
export type { LocalGate, LocalGateOptions, ToolFamilies } from './local.js';
export { DEFAULT_TOOL_FAMILIES, localGate } from './local.js';

export type { JailOptions, PathResolver } from './jail.js';
export { checkPath, checkShellForProtectedPaths, commandFromToolInput, pathFromToolInput } from './jail.js';

export { classifyShellCommand } from './shell.js';

export type { GlobalFlag, Invocation, ParsedCommand } from './command.js';
export {
  INTERPRETER_NAMES,
  isInertLiteral,
  parseCommand,
  programNameOf,
  stripComments,
  tokenize,
} from './command.js';
