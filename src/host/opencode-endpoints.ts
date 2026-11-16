/**
 * A named model endpoint, as an opencode session reaches it: a provider of the session's own in the
 * configuration this host writes for it, an OpenAI-compatible chat endpoint at the endpoint's base URL, its
 * key read when the session opens. The configuration crosses into the session's host process over its stdin,
 * so the key is never written into an environment, which the agent's shell inherits, nor into a file or onto
 * a command line.
 *
 * The provider is named `endpoint-<name>`, a name none of opencode's own catalogue providers has, so the
 * endpoint is never merged with one of them, and the session's configuration allows no provider but it.
 */
import type { EndpointWireApi } from '../control/frames.js';
import { OPENCODE_RUNTIME } from '../sessions/runtimes.js';
import type { ModelEndpoint } from './model-endpoints.js';

/** The provider package opencode reaches an OpenAI-compatible chat endpoint through. */
export const OPENCODE_OPENAI_COMPATIBLE_PACKAGE = '@opencode/ai/providers/openai-compatible';

/** One endpoint an opencode session can open on, its key read only when the session opens. */
export interface OpencodeEndpointRoute {
  readonly name: string;
  readonly wireApi: EndpointWireApi;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly authToken: () => string;
}

/** One provider entry of a session's configuration. */
export interface OpencodeProviderEntry {
  readonly name: string;
  readonly package: string;
  readonly settings: { readonly baseURL: string; readonly apiKey?: string };
  readonly models: Readonly<Record<string, { readonly name: string }>>;
}

/** The routes of the endpoints an opencode session may open on: those the operator named opencode on. */
export function opencodeEndpointRoutes(endpoints: readonly ModelEndpoint[]): OpencodeEndpointRoute[] {
  return endpoints
    .filter((endpoint) => endpoint.runtimes.includes(OPENCODE_RUNTIME))
    .map((endpoint) => ({
      name: endpoint.name,
      wireApi: endpoint.wireApi,
      baseUrl: endpoint.baseUrl,
      models: endpoint.models,
      authToken: endpoint.authToken,
    }));
}

/** The provider id a session's configuration names `route` by. */
export function opencodeProviderId(route: Pick<OpencodeEndpointRoute, 'name'>): string {
  return `endpoint-${route.name}`;
}

/** The session's provider entry for `route`. Reads the key. */
export function opencodeProvider(route: OpencodeEndpointRoute): OpencodeProviderEntry {
  const key = route.authToken();
  return {
    name: route.name,
    package: OPENCODE_OPENAI_COMPATIBLE_PACKAGE,
    settings: { baseURL: route.baseUrl, ...(key === '' ? {} : { apiKey: key }) },
    models: Object.fromEntries(route.models.map((model) => [model, { name: model }])),
  };
}

/** The variables an opencode session on an endpoint is spawned with: none, the provider rides the configuration. */
export function opencodeEndpointEnv(): Record<string, string> {
  return {};
}
