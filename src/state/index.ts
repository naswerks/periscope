/** The declared state model: what a session is, what caused it, and what is still open. */
export type {
  ActivityKind,
  AgedEntry,
  CauseEvent,
  CauseKind,
  ControlEventName,
  EntryLane,
  HookEventName,
  MessageEventName,
  OpenEntry,
  ProcessEventName,
  SessionActivity,
  SessionSnapshot,
  SessionState,
  SessionTransition,
  TimeoutEventName,
  TransitionCause,
  TransitionWhere,
} from './model.js';
export {
  ACTIVITY_KINDS,
  CAUSE_KINDS,
  CONTROL_EVENTS,
  HOOK_EVENTS,
  HOST_ACTIVITY_KINDS,
  MESSAGE_EVENTS,
  PROCESS_EVENTS,
  SDK_ACTIVITY_KINDS,
  SESSION_STATES,
  TIMEOUT_EVENTS,
  formatActivity,
  isCauseEvent,
  isCauseKind,
  sameActivity,
} from './model.js';

export type {
  EntryOp,
  RejectedTransition,
  RejectionListener,
  StateMachineOptions,
  TransitionListener,
  TransitionRequest,
} from './machine.js';
export { SessionStateMachine } from './machine.js';

export type { TransitionStoreOptions } from './store.js';
export { TransitionStore } from './store.js';

export { SessionObserver } from './observer.js';

export { SessionStateReporter } from './reporter.js';

// The coverage table. Exported because it is the contract: a later layer checks its own event
// wiring against these rows rather than rediscovering which events exist.
export type { CoverageHandling, CoverageRow } from './coverage.js';
export { HOOK_COVERAGE, MESSAGE_COVERAGE, coverageTally } from './coverage.js';
