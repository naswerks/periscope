/**
 * The public surface of the package.
 *
 * Everything a consumer may depend on is named here or on the `./protocol` subpath. A module not
 * re-exported from one of the two is internal, whatever its file path suggests.
 */

// The wire contract, re-exported so `@naswerks/periscope` alone is enough for a host-side consumer. A
// controller that wants only the wire should import `@naswerks/periscope/protocol` instead — that path
// cannot reach the privileged module.
export * from './protocol.js';

// The outbound link.
export type { LinkHandlers, LinkOptions } from './control/link.js';
export { ControllerLink } from './control/link.js';

// Forwarding a session's live output onto the link, and the table that declares which lane each
// message rides. Not on `./protocol` — the table is keyed off the SDK's own message union, so it
// reaches the privileged module by construction.
export type { ForwardSessionOptions, FrameSink } from './control/stream.js';
export { forwardSession } from './control/stream.js';
export type { RoutingRow, StreamLane } from './control/stream-routing.js';
export { MESSAGE_ROUTING, discriminatorsOn, laneFor } from './control/stream-routing.js';

export type { LinkCause, LinkState, LinkTransition } from './control/link-state.js';
export { LINK_CAUSES, LinkStateMachine } from './control/link-state.js';

export type { BackoffOptions } from './control/backoff.js';
export { DEFAULT_BACKOFF, nextDelayMs } from './control/backoff.js';

export type { QueueStats } from './control/queue.js';
export { BoundedFrameQueue } from './control/queue.js';

export type { Authorization, ControllerCredential } from './control/credential.js';
export { UnconfiguredCredential } from './control/credential.js';

// The pure core.
export {
  HOST_NOUNS,
  SDK_NOUNS,
  isAbsolutePath,
  isContainedBy,
  isDeclaredNoun,
  isOk,
  nounOf,
  normalizePath,
  ok,
  refuse,
  refusal,
  requireAbsolute,
  systemClock,
  systemTicker,
  valueOr,
} from './core/index.js';
export type { Clock, HostNoun, SdkNoun, Ticker } from './core/index.js';

// The declared state model, its machine, its store and the coverage table.
export * from './state/index.js';

// The agent session lifecycle and the registry of live sessions.
export * from './sessions/index.js';

// The privileged module, exported deliberately: a host-side embedder needs it, and naming it here
// keeps the boundary visible rather than hiding it behind a deep import.
export type { BulkPostReceipt, BulkPostRequest, MachineFacts } from './host/index.js';
export {
  credentialPaths,
  nodePathResolver,
  periscopeCredentialDir,
  postBulk,
  readMachineFacts,
  tokenCachePath,
} from './host/index.js';

// The composer. Everything above this line is a part; this is the one export that assembles them
// into a session that is gated, observed, persisted and on the wire. An embedder writing
// `registry.create({cwd})` by hand gets a correct-looking session with no gate and no observation,
// which is why the assembly ships rather than living in a document.
export type {
  BulkResolver,
  ComposeSessionOptions,
  ComposedSession,
  GateTimings,
  HostEvent,
  PeriscopeHostOptions,
} from './host/index.js';
export { PeriscopeHost, composeSession } from './host/index.js';

// Identity — the pure flows, plus the two impure halves that live in `host/` by the same rule as
// everything else that touches the machine.
export * from './identity/index.js';
export type { DeviceCodeInstruction, LoopbackListener, SignInDeps, TokenCacheWrite } from './host/index.js';
export {
  DEFAULT_SIGN_IN_TIMEOUT_MS,
  FileTokenCache,
  LOOPBACK_HOST,
  openLoopbackListener,
  probeModeEnforcement,
  protocolFor,
  refresherFor,
  resolveEndpoints,
  signIn,
  signInWithDeviceCode,
} from './host/index.js';

export type { HookFailureListener, ObservationHookOptions } from './host/hooks.js';
export { mergeHooks, observationHooks, wiredHookEvents } from './host/hooks.js';
export { readWhere } from './host/git-facts.js';

// The permission gate. Registered after observationHooks — see permissionHooks' own note on why the
// order is load-bearing.
export * from './gate/index.js';

// Workspace provisioning — the directory a session runs in. The two providers ship; the interesting
// policies (a shared directory per task, a branch naming rule, a cleanup schedule) are the
// embedder's and are written against `WorkspaceProvider` rather than added here.
export * from './workspace/index.js';
export { nodeCommandEffects, nodeWorkspaceEffects } from './host/workspace-fs.js';

// The generic tool mechanism: descriptors in, an in-process MCP server out. The host validates a
// call against the schema it was handed, attaches session identity, forwards, and returns — it never
// learns what any tool means. `createToolServer` sits in `host/` because it names the SDK.
export * from './mcp/index.js';
export { createToolServer } from './host/mcp-server.js';

// Durability. The pure half — the store contract, the receipt read path, the transition log's
// encoding and the retention policy — plus the two impure halves in `host/`: the local JSONL
// effects, and the bridge that presents a store to the SDK.
export * from './persistence/index.js';
export {
  asSessionStore,
  nodeStoreEffects,
  readMirrorDrop,
  toSessionKey,
  toTranscriptKey,
} from './host/index.js';

// Cost, usage and rate limits — read from the agent's own result, never computed from a price table.
export * from './telemetry/index.js';
export { readRateLimit, readTaskSpend, readTurnSpend } from './host/index.js';
