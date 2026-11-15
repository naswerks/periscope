/**
 * A named model endpoint, as a Copilot session reaches it: the session's `provider` (bring your own key),
 * sent with `session.create` over the SDK's own pipe. The key is read when the session is created and is
 * never written into the runtime's environment, which the agent's shell inherits whole, nor onto a command
 * line.
 *
 * - An OpenAI-compatible chat endpoint is `{ type: 'openai', wireApi: 'completions' }`, OpenAI's Responses
 *   API `{ type: 'openai', wireApi: 'responses' }`, and Anthropic's Messages API `{ type: 'anthropic' }`.
 * - An endpoint's own `env` is not set for a Copilot session: the runtime reads its provider from the
 *   session, and a variable set in its environment would reach the agent's shell.
 */
import type { EndpointWireApi } from '../control/frames.js';
import { COPILOT_RUNTIME } from '../sessions/runtimes.js';
import type { CopilotProvider } from './copilot-sdk.js';
import type { ModelEndpoint } from './model-endpoints.js';

/** One endpoint a Copilot session can open on, its key read only when the session is created. */
export interface CopilotEndpointRoute {
  readonly name: string;
  readonly wireApi: EndpointWireApi;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly authToken: () => string;
}

/** The routes of the endpoints a Copilot session may open on: those the operator named Copilot on. */
export function copilotEndpointRoutes(endpoints: readonly ModelEndpoint[]): CopilotEndpointRoute[] {
  return endpoints
    .filter((endpoint) => endpoint.runtimes.includes(COPILOT_RUNTIME))
    .map((endpoint) => ({
      name: endpoint.name,
      wireApi: endpoint.wireApi,
      baseUrl: endpoint.baseUrl,
      models: endpoint.models,
      authToken: endpoint.authToken,
    }));
}

/** The session's provider for `route`. Reads the key. */
export function copilotProvider(route: CopilotEndpointRoute): CopilotProvider {
  const key = route.authToken();
  const apiKey = key === '' ? {} : { apiKey: key };
  switch (route.wireApi) {
    case 'anthropic-messages':
      return { type: 'anthropic', baseUrl: route.baseUrl, ...apiKey };
    case 'openai-responses':
      return { type: 'openai', wireApi: 'responses', baseUrl: route.baseUrl, ...apiKey };
    case 'openai-chat':
      return { type: 'openai', wireApi: 'completions', baseUrl: route.baseUrl, ...apiKey };
  }
}

/** The variables a Copilot session on `endpoint` is spawned with: none, the provider rides the session. */
export function copilotEndpointEnv(): Record<string, string> {
  return {};
}
