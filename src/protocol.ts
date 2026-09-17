/**
 * The wire contract, on its own subpath — `@naswerks/periscope/protocol`.
 *
 * This is the only import path into the package that structurally cannot reach `src/host/`, so a
 * controller written against it cannot transitively acquire `node:fs`, `node:child_process` or
 * `node:os`, and does not pull the Agent SDK. That turns the package's blast-radius claim into
 * something a consumer can verify at the package boundary instead of taking on trust from the
 * package's own test suite. Pinned by src/pins/protocol-closure.test.ts.
 *
 * The condition that keeps it true: `exports` in package.json has exactly these two entries and no
 * catch-all `"./*"`. A third subpath re-opens the boundary and is a decision, not a refactor.
 */
export type {
  AgentMessageUpdate,
  BulkDelivered,
  BulkFailed,
  BulkRequest,
  ControlFrame,
  ControlPayload,
  ControlPayloadKind,
  Frame,
  HostConfiguration,
  HostConfigure,
  HostConfigureEntry,
  HostConfigureResult,
  JsonObject,
  JsonValue,
  LinkAck,
  LinkBye,
  LinkHello,
  LinkPing,
  LinkPong,
  LinkWelcome,
  ProtocolRange,
  ReadRefusal,
  SessionCancel,
  SessionConfigure,
  SessionCursor,
  SessionDelta,
  SessionFrame,
  SessionList,
  SessionListEntry,
  SessionListResult,
  SessionNew,
  SessionNewEnv,
  SessionNewGate,
  SessionNewPlugin,
  SessionNewRequest,
  SessionPayload,
  SessionPayloadKind,
  SessionPrompt,
  SessionUpdate,
  SessionUpdateBody,
  StateTransitionUpdate,
  TranscriptFailed,
  TranscriptList,
  TranscriptListEntry,
  TranscriptListResult,
  TranscriptTail,
  TranscriptTailResult,
  WireRefusal,
  WireRefusalUpdate,
  RepositoryEntry,
  RepositoryList,
  RepositoryListResult,
  RepositoryRead,
  RepositoryReadResult,
  WorkspaceList,
  WorkspaceListEntry,
  WorkspaceListResult,
  WorkspaceRelease,
  WorkspaceReleaseBulk,
  WorkspaceReleaseBulkResult,
  WorkspaceReleaseEntry,
  WorkspaceReleaseEntryResult,
  WorkspaceReleaseFlags,
  WorkspaceReleaseResult,
} from './control/frames.js';

// The declared state model travels with the wire: a `session_update` carries a transition, so a
// consumer parsing frames needs the vocabulary to read one. This is the model's public home — the
// controller reads these types and builds whatever its own conventions mean on top of them.
export type {
  ActivityKind,
  AgedEntry,
  CauseEvent,
  CauseKind,
  EntryLane,
  HookEventName,
  OpenEntry,
  SessionActivity,
  SessionSnapshot,
  SessionState,
  SessionTransition,
  TransitionCause,
  TransitionWhere,
} from './state/model.js';
export {
  ACTIVITY_KINDS,
  CAUSE_KINDS,
  HOOK_EVENTS,
  HOST_ACTIVITY_KINDS,
  SDK_ACTIVITY_KINDS,
  SESSION_STATES,
  formatActivity,
  isCauseEvent,
  isCauseKind,
  sameActivity,
} from './state/model.js';

export {
  DROPPABLE_KINDS,
  MAX_CONFIGURATION_VALUE_LENGTH,
  MAX_BULK_RELEASES,
  MAX_CONFIGURE_ENTRIES,
  MAX_FRAME_BYTES,
  MAX_REPOSITORY_ENTRIES,
  MAX_REPOSITORY_READ_BYTES,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MIN,
  TRANSCRIPT_PAGE_SIZE,
  TRANSCRIPT_WHAT_PREFIX,
  WORKSPACE_PAGE_SIZE,
  agentMessageDelta,
  agentMessageUpdate,
  bulkDelivered,
  frameId,
  hostConfigure,
  hostConfigureResult,
  isControlFrame,
  isDroppable,
  isSessionFrame,
  readAgentMessage,
  readRefusal,
  readStateTransition,
  readWireRefusal,
  repositoryList,
  repositoryListResult,
  repositoryRead,
  repositoryReadResult,
  sessionList,
  sessionListResult,
  sessionNew,
  sessionNewRequest,
  stateTransitionUpdate,
  transcriptFailed,
  transcriptList,
  transcriptListResult,
  transcriptTail,
  transcriptTailResult,
  unsetHostConfiguration,
  wireRefusalUpdate,
  workspaceList,
  workspaceListResult,
  workspaceRelease,
  workspaceReleaseBulk,
  workspaceReleaseBulkResult,
  workspaceReleaseEntryResult,
  workspaceReleaseResult,
} from './control/frames.js';

// `control/stream-routing.ts` is not exported here, deliberately. It is keyed off the SDK's own
// message union, so it reaches `host/` and would drag the privileged module into this subpath's
// closure — the one thing this file exists to prevent. What a wire consumer needs is already here:
// `DROPPABLE_KINDS` and `isDroppable` say which payload kinds may be lost. The routing table is the
// host's emission policy, and it ships from the main barrel.

export { decode, encode } from './control/codec.js';

export type { InboundCheck } from './control/seq.js';
export { SeqTracker } from './control/seq.js';

// The refusal vocabulary travels with the wire: a `bulk_failed` frame carries one, so a consumer
// parsing frames needs the type to read it.
export type { Refusal, RefusalReason } from './core/refusal.js';
export { REFUSAL_REASONS, isRefusalReason } from './core/refusal.js';

export type { Result } from './core/result.js';

// ---------------------------------------------------------------------------
// The permission surface — the one thing a controller is required to implement, so the one thing
// this subpath must be able to type.
//
// The package's headline safety claim is that `@naswerks/periscope/protocol` structurally cannot reach
// `src/host/`. Without these re-exports, a stranger writing a controller would have to import the
// permission types from the main barrel — forfeiting the boundary the subpath exists to provide —
// or hand-copy them, or resort to `ReturnType<typeof …>`. The one surface they cannot avoid
// implementing would be the one surface the safe import path did not carry.
//
// These cost the boundary nothing, which is why they can ship here. `gate/decision.ts` has zero
// imports and `gate/escalate.ts` imports only `./decision.js`; both are type-only from this file's
// point of view. `src/pins/protocol-closure.test.ts` is the arbiter, and it stays green: no `host/`
// reach, no `node:` builtin, no Node-only global.
//
// Note what is not here, because the omission is deliberate. `SessionStore` and `SessionKey` are
// re-exports of the Agent SDK's own types (`host/session-store.ts`), and `readTurnSpend` is a
// runtime function in `host/telemetry.ts`. Routing any of the three through here would either drag
// `host/` into this closure or make the wire subpath import the Agent SDK — contradicting this
// file's own header claim that it does not. Whether the wire should grow its own session/spend
// types, independent of the SDK's, is a wire-vocabulary decision and belongs to whoever designs
// the API. It is deliberately not taken here.
// ---------------------------------------------------------------------------

export type { Decider, Decision, DecisionReading, DecisionRequest } from './gate/decision.js';
export { describeRaw, readDecision } from './gate/decision.js';

export type { EscalationOptions, EscalationResponse, EscalationTransport } from './gate/escalate.js';

// `EscalationOptions` names a credential, so the credential's own types have to be reachable from
// the same import path or the option is untypeable by the consumer it exists for. They cost the
// closure nothing: `control/credential.ts` imports `core/result.ts` and nothing else — no `host/`
// reach, no `node:` builtin, no Node-only global — so `pins/protocol-closure.test.ts` stays the
// arbiter and stays green. The one implementation is deliberately not re-exported here: it refuses
// by name, and a wire consumer types against the interface rather than instantiating the package's.
export type { Authorization, ControllerCredential } from './control/credential.js';
