/**
 * A named model endpoint, as a Codex session reaches it: one model provider in the thread's own config,
 * named by this host, its key read from a variable this host sets in the app-server's environment.
 *
 * - The provider is defined per session, in `thread/start` (and `thread/resume`, `thread/fork`)
 *   `config`, and the thread opens on it by `modelProvider`. Nothing is written into the runner's
 *   Codex home, and only the session that named the endpoint sees the provider. A repository cannot
 *   choose one: Codex refuses a project's own `model_provider` and `model_providers`.
 * - The provider's id is this host's own (`codexProviderKey`), never the operator's name as written:
 *   Codex reserves some ids (`openai`, `ollama`, `lmstudio`, ...) and reads a `.` in a config key as a
 *   nested table, and a derived id meets neither. The provider's display name is the operator's.
 * - The key travels in one variable (`CODEX_ENDPOINT_KEY_VARIABLE`), set with the endpoint's own `env`
 *   in the app-server's environment and nowhere else, and every one of those names is excluded from
 *   the environment the agent's shell commands inherit (`shell_environment_policy.exclude`, by exact
 *   name). The variable is beneath the env floor, so no controller can set it.
 * - The endpoint's window becomes Codex's: `maxContextTokens` its `model_context_window`, and
 *   `autoCompactWindow` its `model_auto_compact_token_limit`.
 */
import type { JsonObject } from '../control/frames.js';
import { CODEX_RUNTIME } from '../sessions/runtimes.js';
import type { EndpointContextWindow, ModelEndpoint } from './model-endpoints.js';

/** The variable a Codex session's provider reads its key from. */
export const CODEX_ENDPOINT_KEY_VARIABLE = 'PERISCOPE_CODEX_ENDPOINT_KEY';

/** The prefix every provider id this host derives starts with. */
const PROVIDER_PREFIX = 'periscope-';

/** One endpoint a Codex session can open on: what the process needs, and no credential. */
export interface CodexEndpointRoute {
  /** The operator's name, as `session_new` names it and as the provider is displayed. */
  readonly name: string;
  /** The provider id this host derived for it. */
  readonly key: string;
  readonly baseUrl: string;
  readonly contextWindow: EndpointContextWindow | null;
  /** The names of the endpoint's own `env`, each excluded from the agent's shell. */
  readonly envNames: readonly string[];
}

/** A 32-bit FNV-1a hash of `text`'s UTF-16 units, as eight hex digits. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The provider id a Codex session reaches the endpoint `name` by: `periscope-`, the name lower-cased
 * with every character outside `[a-z0-9-]` made a `-`, then a hash of the name exactly as written. Two
 * names that read alike once slugged (`deepseek.v3`, `deepseek-v3`) take distinct ids.
 */
export function codexProviderKey(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `${PROVIDER_PREFIX}${slug}-${fnv1a(name)}`;
}

/** The routes of the endpoints a Codex session may open on: those the operator named Codex on. */
export function codexEndpointRoutes(endpoints: readonly ModelEndpoint[]): CodexEndpointRoute[] {
  return endpoints
    .filter((endpoint) => endpoint.runtimes.includes(CODEX_RUNTIME))
    .map((endpoint) => ({
      name: endpoint.name,
      key: codexProviderKey(endpoint.name),
      baseUrl: endpoint.baseUrl,
      contextWindow: endpoint.contextWindow,
      envNames: Object.keys(endpoint.env),
    }));
}

/** The variables a Codex session on `endpoint` is spawned with: its own `env`, then the key, which wins. */
export function codexEndpointEnv(endpoint: ModelEndpoint): Record<string, string> {
  return { ...endpoint.env, [CODEX_ENDPOINT_KEY_VARIABLE]: endpoint.authToken() };
}

/** Every variable a Codex session on `route` carries for it, each kept from the agent's shell. */
export function codexEndpointExcludes(route: CodexEndpointRoute): string[] {
  return [
    CODEX_ENDPOINT_KEY_VARIABLE,
    ...route.envNames.filter((name) => name !== CODEX_ENDPOINT_KEY_VARIABLE),
  ];
}

/** The thread config keys that define `route`'s provider and its window. */
export function codexProviderConfig(route: CodexEndpointRoute): JsonObject {
  const window = route.contextWindow;
  return {
    [`model_providers.${route.key}`]: {
      name: route.name,
      base_url: route.baseUrl,
      wire_api: 'responses',
      env_key: CODEX_ENDPOINT_KEY_VARIABLE,
    },
    ...(window === null
      ? {}
      : 'maxContextTokens' in window
        ? { model_context_window: window.maxContextTokens }
        : { model_auto_compact_token_limit: window.autoCompactWindow }),
  };
}
