/**
 * A named model endpoint, as a pi session reaches it: a provider of its own in the runner-owned agent
 * home's `models.json`, written by this host at start, and the session opened on it by name.
 *
 * - Each endpoint whose runtimes name pi is one provider, keyed by the endpoint's name: its base URL, the
 *   wire API pi calls it through, its models and its key. The key is written into that file, which sits
 *   in the protected set, as a literal pi reads as written, and nowhere else: not in pi's environment,
 *   which every command the agent runs inherits, and not on its command line, which any process listing
 *   shows.
 * - A session on the endpoint names the provider and the model on pi's command line
 *   (`--provider <name> --model <id>`): names, never a credential.
 * - The endpoint's own `env` is set in pi's environment, where the agent's shell can read it; the session
 *   names those variables in a degrade (`gate-credential-in-shell`).
 */
import type { EndpointWireApi, JsonObject } from '../control/frames.js';
import { PI_RUNTIME } from '../sessions/runtimes.js';
import type { ModelEndpoint } from './model-endpoints.js';
import { escapePiConfigValue } from './pi-extension.js';

/** Each wire API as pi names the API a provider is called through. */
export const PI_ENDPOINT_APIS = {
  'openai-chat': 'openai-completions',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
} as const satisfies Readonly<Record<EndpointWireApi, string>>;

/** One endpoint a pi session can open on, its key read only when the home's models file is written. */
export interface PiEndpointRoute {
  readonly name: string;
  readonly wireApi: EndpointWireApi;
  readonly baseUrl: string;
  readonly models: readonly string[];
  /** The endpoint's own variables, set in pi's environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly authToken: () => string;
}

/** The routes of the endpoints a pi session may open on: those the operator named pi on. */
export function piEndpointRoutes(endpoints: readonly ModelEndpoint[]): PiEndpointRoute[] {
  return endpoints
    .filter((endpoint) => endpoint.runtimes.includes(PI_RUNTIME))
    .map((endpoint) => ({
      name: endpoint.name,
      wireApi: endpoint.wireApi,
      baseUrl: endpoint.baseUrl,
      models: endpoint.models,
      env: endpoint.env,
      authToken: endpoint.authToken,
    }));
}

/** The agent home's `models.json` for `routes`: one provider per endpoint. Reads every key. */
export function piModelsDocument(routes: readonly PiEndpointRoute[]): JsonObject {
  const providers: JsonObject = {};
  for (const route of routes) {
    providers[route.name] = {
      baseUrl: route.baseUrl,
      api: PI_ENDPOINT_APIS[route.wireApi],
      apiKey: escapePiConfigValue(route.authToken()),
      models: route.models.map((id) => ({ id })),
    };
  }
  return { providers };
}

/** The flags that open a session on `route` with `model`: the provider's name and the model's id. */
export function piEndpointArgs(route: PiEndpointRoute, model: string): string[] {
  return ['--provider', route.name, '--model', model];
}

/** The variables a pi session on `endpoint` is spawned with: its own `env`, never its key. */
export function piEndpointEnv(endpoint: ModelEndpoint): Record<string, string> {
  return { ...endpoint.env };
}
