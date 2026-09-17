/** The agent session lifecycle and the registry of live sessions. */
export type { EnvSource, SpawnEnvPolicy } from './spawn-env.js';
export {
  DECLARED_EXACT_KEYS,
  DECLARED_PREFIXES,
  DECLARED_SUFFIXES,
  STRIPPED_HOST_SESSION_KEYS,
  composeSpawnEnv,
  isDeclaredSpawnEnvKey,
  redactProxyCredential,
} from './spawn-env.js';

export type {
  HostedSessionFacts,
  SessionDegrade,
  SessionDegradeListener,
  SessionEndCause,
  SessionEndListener,
  SessionEnded,
  SessionLifecycle,
  SessionListener,
  Unsubscribe,
} from './session.js';
export { SESSION_END_CAUSES, HostedSession } from './session.js';

export type { SessionRegistryOptions, SessionRequest } from './registry.js';
export { SessionRegistry } from './registry.js';
