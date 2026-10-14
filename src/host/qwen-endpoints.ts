/**
 * A named model endpoint, as a Qwen Code session reaches it: the auth the session's settings state, and
 * the command-line flags that hold the route against anything else the CLI would read.
 *
 * - The key is written into the session's own settings (`security.auth.apiKey`), a file in the protected
 *   set, and nowhere else: not in the CLI's environment, which every command the agent runs inherits
 *   (Qwen Code keeps no variable from its shell), and not on its command line, which any process listing
 *   shows.
 * - The auth type rides `--auth-type`, which the CLI reads ahead of every setting. An OpenAI-compatible
 *   endpoint's base URL rides `--openai-base-url` too, which the CLI reads ahead of any variable a `.env`
 *   file sets. An Anthropic endpoint's base URL rides a provider entry per model in the same settings,
 *   which the CLI reads first of all.
 * - The endpoint's own `env` is set in the CLI's environment, where the agent's shell can read it; the
 *   session names those variables in a degrade (`gate-credential-in-shell`).
 */
import type { EndpointWireApi } from '../control/frames.js';
import { QWEN_RUNTIME } from '../sessions/runtimes.js';
import type { ModelEndpoint } from './model-endpoints.js';
import type { QwenSettingsAuth } from './qwen-home.js';

/** Each wire API as the CLI's auth type. */
export const QWEN_AUTH_TYPES = {
  'openai-chat': 'openai',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic',
} as const satisfies Readonly<Record<EndpointWireApi, string>>;

/** One endpoint a Qwen Code session can open on, its key read only when the session is written. */
export interface QwenEndpointRoute {
  readonly name: string;
  readonly wireApi: EndpointWireApi;
  readonly baseUrl: string;
  readonly models: readonly string[];
  /** The endpoint's own variables, set in the CLI's environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly authToken: () => string;
}

/** The routes of the endpoints a Qwen Code session may open on: those the operator named Qwen Code on. */
export function qwenEndpointRoutes(endpoints: readonly ModelEndpoint[]): QwenEndpointRoute[] {
  return endpoints
    .filter((endpoint) => endpoint.runtimes.includes(QWEN_RUNTIME))
    .map((endpoint) => ({
      name: endpoint.name,
      wireApi: endpoint.wireApi,
      baseUrl: endpoint.baseUrl,
      models: endpoint.models,
      env: endpoint.env,
      authToken: endpoint.authToken,
    }));
}

/** The auth a session on `route` states in its settings. Reads the key. */
export function qwenSettingsAuth(route: QwenEndpointRoute): QwenSettingsAuth {
  return {
    selectedType: QWEN_AUTH_TYPES[route.wireApi],
    apiKey: route.authToken(),
    baseUrl: route.baseUrl,
    anthropicModels: route.wireApi === 'anthropic-messages' ? [...route.models] : [],
  };
}

/** The flags that hold a session on `route` to it, ahead of any setting or variable. */
export function qwenEndpointArgs(route: QwenEndpointRoute): string[] {
  const type = QWEN_AUTH_TYPES[route.wireApi];
  return route.wireApi === 'anthropic-messages'
    ? ['--auth-type', type]
    : ['--auth-type', type, '--openai-base-url', route.baseUrl];
}

/** The variables a Qwen Code session on `endpoint` is spawned with: its own `env`, never its key. */
export function qwenEndpointEnv(endpoint: ModelEndpoint): Record<string, string> {
  return { ...endpoint.env };
}
