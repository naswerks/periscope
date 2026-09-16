/**
 * The privileged module: the only place in this package that imports `node:fs`,
 * `node:fs/promises`, `node:child_process` or `node:os`.
 *
 * That is the package's central claim: a reviewer answers "what can this touch on my machine?" by
 * reading one directory. It is enforced twice — an ESLint rule for editor-time feedback, and a
 * tree-walking pin test that survives the lint config being changed or deleted.
 */
export type { MachineFacts } from './machine.js';
export { readMachineFacts } from './machine.js';

// The composer: the per-session assembly, and the host that owns a link and a registry. It reaches
// every other directory in the package, which is exactly what makes it the one place a consumer
// does not have to reproduce by hand.
export type {
  BulkResolver,
  ComposeSessionOptions,
  ComposedSession,
  GateTimings,
  HostEvent,
  PeriscopeHostOptions,
} from './host.js';
export { PeriscopeHost, composeSession } from './host.js';

export type { BulkPostReceipt, BulkPostRequest } from './bulk-post.js';
export { postBulk } from './bulk-post.js';

// The discovery door: read-only, jailed enumeration of the agent CLI's own transcripts. The root
// derivation ships beside the reader so the composition root derives and the module only reads.
export type { DiscoveredTranscript, TranscriptPage, TranscriptTailAnswer } from './claude-transcripts.js';
export { TRANSCRIPT_PAGE_SIZE, TRANSCRIPT_WHAT_PREFIX } from '../control/frames.js';
export { packageVersion } from './package-facts.js';
export {
  claudeProjectsRoot,
  defaultAgentHome,
  transcriptsRootUnder,
  claudeTranscriptResolver,
  isMatchingUserEntry,
  listTranscripts,
  resolveTranscriptPath,
  tailTranscript,
} from './claude-transcripts.js';

// The repository read: the same read-only, jailed posture over the repository root.
export type { RepositoryListing, RepositoryText } from './repository-read.js';
export {
  BINARY_PROBE_BYTES,
  listRepositoryDirectory,
  readRepositoryFile,
  resolveRepositoryPath,
} from './repository-read.js';

// The two impure inputs the host's own gate takes at construction, plus the derived location of
// this host's own credential material — `credentialPaths` covers it BECAUSE both come from here.
export {
  credentialPaths,
  nodePathResolver,
  pairedCredentialPath,
  periscopeCredentialDir,
  tokenCachePath,
} from './paths.js';
export type { ConfigFileReading, ConfigKey } from './config-file.js';
export {
  CONFIG_KEYS,
  configFilePath,
  isConfigKey,
  readConfigFile,
  withConfigFallback,
  writeConfigEntry,
} from './config-file.js';

// The impure halves of identity: the file the token lives in, and the port the callback arrives on.
export type { TokenCacheWrite } from './token-cache.js';
export { FileTokenCache, probeModeEnforcement } from './token-cache.js';

// The paired credential's file half — same directory, same modes, same verify-after-write.
export type { PairedCredentialWrite } from './paired-credential-store.js';
export { FilePairedCredential } from './paired-credential-store.js';

export type { DeviceCodeInstruction, SignInDeps } from './sign-in.js';
export { protocolFor, refresherFor, resolveEndpoints, signIn, signInWithDeviceCode } from './sign-in.js';

export type { LoopbackListener } from './loopback.js';
export { DEFAULT_SIGN_IN_TIMEOUT_MS, LOOPBACK_HOST, openLoopbackListener } from './loopback.js';

// The local JSONL mirror's effects, and the bridge that presents a transcript store to the SDK.
// Both are here for the two reasons this directory exists: one names `node:fs`, the other the SDK.
export { nodeStoreEffects } from './transcript-fs.js';
export { asSessionStore, readMirrorDrop, toSessionKey, toTranscriptKey } from './session-store.js';

// Cost and rate-limit facts, lifted off the agent's own stream. Nothing here polls anything.
export { readRateLimit, readTaskSpend, readTurnSpend } from './telemetry.js';
