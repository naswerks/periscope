/**
 * The one place a controller's `session_new.request` becomes a local `SessionRequest`.
 *
 * Why it is a file and not four lines in the dispatcher: everything crossing here arrived from
 * off-box and was validated only as JSON. The codec's job is to keep malformed bytes out, and it
 * says so; an empty `cwd`, an empty `text` and a non-ISO `at` all pass it. So a value that is
 * well-formed JSON and meaningless to the SDK reaches this line, and there are exactly two things to
 * do with one: refuse it by name before a process exists, or hand it to `query()` and let the
 * failure arrive later wearing a spawn error's clothes. This file is the first of those.
 *
 * What it narrows and what it deliberately does not, because the split is a judgement worth
 * stating rather than a gap. It narrows every value with a closed set this package can see (the
 * three setting sources, the plugin type, the thinking discriminator) because an unrecognised value
 * there silently does nothing, which is the failure mode with no symptom. It does not re-validate
 * the MCP server configs: that union is large, versioned with the SDK, and re-stating it here would
 * be a second copy that can disagree with the first. Those are shape-checked and handed on, and the
 * SDK is their validator.
 *
 * Nothing here can produce `sessionStore`, `sessionStoreFlush`, `spawn`, `onStderr` or `hooks`.
 * They have no JSON form, so the wire type has no member for them and this file has nothing to read.
 * Nor can it produce `hostEnv`, the variables the host sets itself: the request this file returns has
 * no such member. That is the boundary, and it is structural rather than a check somebody remembered
 * to write.
 */
import { EXTRA_ENV_FLOOR, envKeysBeneathFloor, envKeysUndeclared } from '../sessions/spawn-env.js';
import type {
  HostAgentEntry,
  HostAgentVocabularies,
  JsonObject,
  SessionNewEnv,
  SessionNewRequest,
} from '../control/frames.js';
import { DEFAULT_RUNTIME } from '../control/frames.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { SessionRequest } from '../sessions/registry.js';
import { CODEX_RUNTIME, wireApisFor } from '../sessions/runtimes.js';
import type { SpawnEnvPolicy } from '../sessions/spawn-env.js';
import type {
  McpServerConfig,
  PermissionMode,
  SdkPluginConfig,
  SettingSource,
  ThinkingConfig,
} from './agent-process.js';
import type { SessionConfigure } from '../control/frames.js';
import { codexMcpConfig } from './codex-mcp.js';
import type { ModelEndpoint } from './model-endpoints.js';
import { endpointModelProblem } from './model-endpoints.js';

/** What a controller may ask for, minus the three the composer supplies itself. */
export type ComposableRequest = Omit<SessionRequest, 'cwd' | 'hooks' | 'hostEnv'>;

/**
 * The three tiers the SDK understands, as data.
 *
 * Restated here rather than derived because the SDK ships them as a bare string union with no
 * runtime value to read — so this is the one place a copy is unavoidable. `wire-request.test.ts`
 * asserts each member against the shipped `sdk.d.ts`, the same way the permission pin does, so the
 * copy cannot quietly drift from what it copies.
 */
export const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];

/**
 * The thinking shapes this host passes to the agent, by discriminator. Same argument as above.
 *
 * The SDK declares a third, `enabled`, a fixed token budget, and it is refused by name: Opus 4.7
 * and later, Sonnet 5 and later and Fable 5 and later reject a fixed budget with a 400, so a session
 * that asked for one would open and then fail its first turn.
 */
export const THINKING_TYPES: readonly string[] = ['adaptive', 'disabled'];

/** What adaptive thinking's optional `display` may ask for: summarized prose, or the default's empty blocks. */
export const THINKING_DISPLAYS: readonly string[] = ['summarized', 'omitted'];

/** Null when a thinking shape is one this host passes on; otherwise why it is refused. */
function thinkingProblem(thinking: JsonObject): string | null {
  const type = thinking['type'];
  if (type === 'enabled') {
    return (
      'thinking.type is "enabled", a fixed token budget, which Opus 4.7 and later, Sonnet 5 and later ' +
      'and Fable 5 and later reject with a 400; ask for {"type":"adaptive"}, with "display":"summarized" ' +
      'to stream the reasoning, or for {"type":"disabled"}'
    );
  }
  if (typeof type !== 'string' || !THINKING_TYPES.includes(type)) {
    return `thinking.type is ${JSON.stringify(type)}; the shapes this host passes on are ${THINKING_TYPES.join(', ')}`;
  }
  const display = thinking['display'];
  if (
    type === 'adaptive' &&
    display !== undefined &&
    display !== null &&
    (typeof display !== 'string' || !THINKING_DISPLAYS.includes(display))
  ) {
    return `thinking.display is ${JSON.stringify(display)}; adaptive thinking takes ${THINKING_DISPLAYS.join(' or ')}`;
  }
  return null;
}

/** The SDK's effort levels, by name. An unknown level is refused, never dropped. */
export const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The SDK's permission modes, by name (protocol v6, CLI parity). */
export const PERMISSION_MODES: readonly string[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
];

/**
 * The permission modes a Codex session admits: three of the six, by name. Named here, in the one
 * module that holds the mode vocabulary, beside the map that reads each one as Codex's own words: one
 * table in one place, so a later gate over this runtime changes a row and nothing else.
 */
export const CODEX_PERMISSION_MODES = ['default', 'dontAsk', 'bypassPermissions'] as const;

export type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number];

/**
 * Each admitted mode as Codex's own approval policy and sandbox, with the reviewer pinned to the
 * client so no approval is ever handed to a Codex sub-agent.
 *
 * - `default`: asks on request in a workspace-write sandbox. With no sandbox backend on Windows every
 *   command and every patch raises an approval.
 * - `dontAsk`: never asks, in a workspace-write sandbox. With no backend on Windows, commands and
 *   patches outside the roots are forbidden.
 * - `bypassPermissions`: never asks, full access.
 *
 * The other three are refused by name: `acceptEdits` because workspace-write already applies patches
 * inside the roots, so it would be `default` or a lie; `plan` because it needs experimental API;
 * `auto` because it would hand approvals to a reviewing agent.
 */
export const CODEX_MODE_MAP = {
  default: {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite' },
  },
  dontAsk: { approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
  bypassPermissions: {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
  },
} as const satisfies Readonly<
  Record<
    CodexPermissionMode,
    { readonly approvalPolicy: string; readonly sandbox: string; readonly sandboxPolicy: JsonObject }
  >
>;

/** The reviewer every thread and turn names: the client, never a reviewing agent. */
export const CODEX_APPROVALS_REVIEWER = 'user';

export function isCodexPermissionMode(mode: string): mode is CodexPermissionMode {
  return (CODEX_PERMISSION_MODES as readonly string[]).includes(mode);
}

/**
 * The one mode under which a granting gate and loaded operator settings are NOT two authorities: the
 * mode already allows everything the grant would, and a hook deny survives every mode. Named here, in
 * the one module that holds the vocabulary, so nothing else has to spell the mode.
 */
export function isBypassMode(mode: string | null | undefined): boolean {
  return mode === PERMISSION_MODES[2];
}

/**
 * What a `session_configure` frame asked for, narrowed to the SDK's own types. `effort` is the
 * session's runtime's own word: one of the SDK's levels for Claude.
 */
export interface SessionConfigureChange {
  readonly model?: string | null;
  readonly permissionMode?: PermissionMode;
  readonly thinking?: ThinkingConfig;
  readonly effort?: string;
}

/**
 * Narrow a `session_configure` payload. Same discipline as `readSessionRequest`: a value the SDK does
 * not declare is REFUSED by name — a mode nobody recognises must never become "the default" silently.
 *
 * `vocabulary` is the session's runtime's own when it is not Claude: an effort is then read as that
 * runtime's word, from its list. A mode or a level the runtime does not take is its process's to refuse,
 * which answers `session-configure-failed` naming the member.
 */
export function readSessionConfigure(
  payload: SessionConfigure,
  vocabulary: HostAgentVocabularies | null = null,
): Result<SessionConfigureChange> {
  const change: {
    model?: string | null;
    permissionMode?: PermissionMode;
    thinking?: ThinkingConfig;
    effort?: string;
  } = {};
  if (payload.model !== null) change.model = payload.model;
  if (payload.permissionMode !== null) {
    if (!PERMISSION_MODES.includes(payload.permissionMode)) {
      return refuse<SessionConfigureChange>(
        'frame-malformed',
        `permissionMode is ${JSON.stringify(payload.permissionMode)}; the modes this SDK declares are ` +
          `${PERMISSION_MODES.join(', ')}`,
      );
    }
    change.permissionMode = payload.permissionMode as PermissionMode;
  }
  if (payload.thinking !== null) {
    const problem = thinkingProblem(payload.thinking);
    if (problem !== null) return refuse<SessionConfigureChange>('frame-malformed', problem);
    change.thinking = payload.thinking as unknown as ThinkingConfig;
  }
  // Protocol 12. Absent from a controller one release behind, which reads the same as null.
  if (payload.effort !== undefined && payload.effort !== null) {
    const levels = vocabulary === null ? EFFORT_LEVELS : vocabulary.efforts;
    if (!levels.includes(payload.effort)) {
      return refuse<SessionConfigureChange>(
        'frame-malformed',
        vocabulary === null
          ? `effort is ${JSON.stringify(payload.effort)}; the levels this SDK declares are ${EFFORT_LEVELS.join(', ')}`
          : `effort is ${JSON.stringify(payload.effort)}; the levels this runtime declares are ${levels.join(', ')}`,
      );
    }
    change.effort = payload.effort;
  }
  return ok(change);
}

/**
 * The first member of a request that the runtime `entry` describes does not honour, in words naming
 * the key, or null. The members that are Claude's alone (its settings tiers, its sub-agent text
 * forwarding, its own system-prompt preset) and a value outside the runtime's own vocabularies.
 */
function unsupportedKey(request: SessionNewRequest, entry: HostAgentEntry): string | null {
  const runtime = entry.runtime;
  if (request.settingSources !== null && request.settingSources.length > 0) {
    return `settingSources: Claude's settings tiers, which runtime ${runtime} does not load`;
  }
  if (request.forwardSubagentText === true) {
    return `forwardSubagentText: runtime ${runtime} runs a sub-agent on a thread of its own`;
  }
  const prompt = request.systemPrompt;
  if (prompt !== null && typeof prompt !== 'string') {
    const preset = typeof prompt === 'object' && !Array.isArray(prompt) ? prompt['preset'] : undefined;
    if (preset !== RUNTIME_DEFAULT_PRESET) {
      return (
        `systemPrompt: runtime ${runtime} takes a string, which replaces its base instructions, or ` +
        `{ "type": "preset", "preset": "${RUNTIME_DEFAULT_PRESET}", "append": ... }; ${JSON.stringify(preset ?? null)} is not either`
      );
    }
  }
  const vocabulary = entry.vocabularies;
  if (request.permissionMode !== null && !vocabulary.permissionModes.includes(request.permissionMode)) {
    return `permissionMode: runtime ${runtime} takes ${vocabulary.permissionModes.join(', ')}, not ${request.permissionMode}`;
  }
  if (request.effort !== null && !vocabulary.efforts.includes(request.effort)) {
    return `effort: runtime ${runtime} takes ${vocabulary.efforts.length === 0 ? 'no level' : vocabulary.efforts.join(', ')}, not ${request.effort}`;
  }
  const thinking = request.thinking;
  if (thinking !== null && !vocabulary.thinking && thinking['type'] !== 'adaptive') {
    return `thinking: runtime ${runtime} honours no thinking control; omit the key`;
  }
  return null;
}

/** The system-prompt preset every runtime reads: its own base instructions and an append. */
const RUNTIME_DEFAULT_PRESET = 'runtime-default';

/**
 * The keys a controller's `env` places in the spawn environment, by lane: `extraAllowedKeys`
 * re-admits keys this host holds, and `extraEnv` sets values. `extraDeniedKeys` only removes keys,
 * so it is not a lane in here and is never screened.
 */
function envLanes(env: SessionNewEnv): ReadonlyArray<readonly [string, readonly string[]]> {
  return [
    ['extraAllowedKeys names', env.extraAllowedKeys ?? []],
    ['extraEnv sets', Object.keys(env.extraEnv ?? {})],
  ];
}

/** "extraAllowedKeys names A and extraEnv sets B, C" for the keys `select` picks, or null for none. */
function namedInLanes(
  lanes: ReadonlyArray<readonly [string, readonly string[]]>,
  select: (keys: readonly string[]) => readonly string[],
): string | null {
  const named = lanes.flatMap(([lane, keys]) => {
    const picked = select(keys);
    return picked.length === 0 ? [] : [`${lane} ${picked.join(', ')}`];
  });
  return named.length === 0 ? null : named.join(' and ');
}

/**
 * Turn a controller's request into a local one, or refuse it by name.
 *
 * `null` in means "every default", which is byte-for-byte the behaviour before this payload grew —
 * so a controller that sends nothing new is unaffected by any of this.
 *
 * `controllerEnvKeys` is what this host's operator declared a controller may place in the spawn
 * environment; it defaults to nothing, so a request whose `env` adds any key is refused unless the
 * operator declared that key.
 *
 * `endpoints` are the model endpoints this host's operator declared; a request may name one, and
 * nothing it carries can describe one.
 *
 * `runtimes` are the hello's entries for the runtimes this host offers beside Claude. A request may name
 * one that is available; its members are then read against that runtime's own vocabularies, and a
 * member that is Claude's alone is refused `request-key-unsupported`, naming it.
 */
export function readSessionRequest(
  request: SessionNewRequest | null,
  extraEnvFloor: readonly string[] = EXTRA_ENV_FLOOR,
  controllerEnvKeys: readonly string[] = [],
  endpoints: readonly ModelEndpoint[] = [],
  runtimes: readonly HostAgentEntry[] = [],
): Result<ComposableRequest> {
  if (request === null) return ok({});

  // The runtime first: every other member is read as that runtime's own, so a session on a runtime
  // this host cannot spawn is refused before any of them is. Null or absent is the host's default and
  // composes nothing; the composer reads the default through `runtimeOf`.
  const runtime = request.runtime ?? null;
  const entry =
    runtime === null || runtime === DEFAULT_RUNTIME
      ? null
      : (runtimes.find((one) => one.runtime === runtime) ?? null);
  if (runtime !== null && runtime !== DEFAULT_RUNTIME && entry === null) {
    return refuse<ComposableRequest>(
      'runtime-unavailable',
      runtimes.length === 0
        ? `runtime is ${JSON.stringify(runtime)}; this host spawns sessions on ${DEFAULT_RUNTIME} only, the ` +
            `one runtime its hello lists in agents`
        : `runtime is ${JSON.stringify(runtime)}; this host spawns sessions on ` +
            `${[DEFAULT_RUNTIME, ...runtimes.map((one) => one.runtime)].join(', ')}, the runtimes its hello lists in agents`,
    );
  }
  if (entry !== null && !entry.available) {
    return refuse<ComposableRequest>(
      'runtime-unavailable',
      `runtime ${entry.runtime} is listed unavailable: ${entry.unavailableReason ?? 'no reason was given'}`,
    );
  }
  if (entry !== null) {
    const unsupported = unsupportedKey(request, entry);
    if (unsupported !== null) return refuse<ComposableRequest>('request-key-unsupported', unsupported);
  }

  const composed: Record<string, unknown> = {};
  if (runtime !== null) composed['runtime'] = runtime;

  if (request.resume !== null) composed['resume'] = request.resume;
  if (request.fork !== null) composed['fork'] = request.fork;
  if (request.includePartialMessages !== null) {
    composed['includePartialMessages'] = request.includePartialMessages;
  }
  if (request.forwardSubagentText !== null) composed['forwardSubagentText'] = request.forwardSubagentText;
  if (request.strictMcpConfig !== null) composed['strictMcpConfig'] = request.strictMcpConfig;
  if (request.model !== null) composed['model'] = request.model;
  // Handed on as the SDK's own option type. A string, a list of strings and a preset object are all
  // legal, so there is no closed set to check and inventing one would refuse valid requests.
  if (request.systemPrompt !== null) composed['systemPrompt'] = request.systemPrompt;

  if (request.settingSources !== null) {
    // A tier nobody declared is refused, not dropped. Dropping it would start a session the
    // controller believes loads its project settings, silently without them — and the permission
    // rules it expected to be in force would simply not be. Nothing would say so.
    const unknown = request.settingSources.filter(
      (source) => !(SETTING_SOURCES as readonly string[]).includes(source),
    );
    if (unknown.length > 0) {
      return refuse<ComposableRequest>(
        'frame-malformed',
        `settingSources names ${unknown.map((source) => `"${source}"`).join(', ')}, which this host ` +
          `does not know — the tiers are ${SETTING_SOURCES.join(', ')}. Refused rather than ignored: a ` +
          `session started without a tier its controller asked for runs with permission rules nobody ` +
          `told it were absent`,
      );
    }
    composed['settingSources'] = [...request.settingSources] as SettingSource[];
  }

  if (request.plugins !== null) {
    const plugins: SdkPluginConfig[] = [];
    for (const plugin of request.plugins) {
      // Same argument as the tiers: the SDK supports exactly one plugin type today, and a value it
      // does not recognise loads nothing while looking like it asked for something.
      if (plugin.type !== 'local') {
        return refuse<ComposableRequest>(
          'frame-malformed',
          `a plugin declares type "${plugin.type}"; this host passes only "local" plugins to the agent`,
        );
      }
      plugins.push({
        type: 'local',
        path: plugin.path,
        ...(plugin.skipMcpDiscovery === null ? {} : { skipMcpDiscovery: plugin.skipMcpDiscovery }),
      });
    }
    composed['plugins'] = plugins;
  }

  if (request.thinking !== null) {
    const problem = thinkingProblem(request.thinking);
    if (problem !== null) return refuse<ComposableRequest>('frame-malformed', problem);
    composed['thinking'] = request.thinking;
  }

  if (request.effort !== null) {
    // A runtime beside Claude names its own levels, already held to its list above.
    if (entry === null && !EFFORT_LEVELS.includes(request.effort)) {
      return refuse<ComposableRequest>(
        'frame-malformed',
        `effort is ${JSON.stringify(request.effort)}; the levels this SDK declares are ${EFFORT_LEVELS.join(', ')}`,
      );
    }
    composed['effort'] = request.effort;
  }

  if (request.permissionMode !== null) {
    // The lane that was closed, opened by name (protocol v6). Narrowed like every other member: an
    // unknown mode is refused, never dropped and never defaulted.
    if (!PERMISSION_MODES.includes(request.permissionMode)) {
      return refuse<ComposableRequest>(
        'frame-malformed',
        `permissionMode is ${JSON.stringify(request.permissionMode)}; the modes this SDK declares are ` +
          `${PERMISSION_MODES.join(', ')}`,
      );
    }
    composed['permissionMode'] = request.permissionMode;
  }

  if (request.env !== null) {
    // Both lanes are screened by name before anything is reserved, in two steps, and every key a
    // step refuses is named. The floor first: no declaration admits a key beneath it. Then the
    // operator's declaration: a key reaches the spawn by a controller's lane only when it is
    // declared. The allow-list protects against accidental inheritance; this protects against the
    // controller.
    const lanes = envLanes(request.env);
    const beneath = namedInLanes(lanes, (keys) => envKeysBeneathFloor(keys, extraEnvFloor));
    if (beneath !== null) {
      return refuse<ComposableRequest>(
        'env-key-refused',
        `${beneath}: beneath this host's floor (${extraEnvFloor.join(', ')}), where no declaration ` +
          `admits a key`,
      );
    }
    const undeclared = namedInLanes(lanes, (keys) => envKeysUndeclared(keys, controllerEnvKeys));
    if (undeclared !== null) {
      return refuse<ComposableRequest>(
        'env-key-refused',
        `${undeclared}, which this host's operator has not declared for a controller to set. A key ` +
          `reaches the agent's environment by these lanes only when it is declared: ` +
          `PERISCOPE_CONTROLLER_ENV_KEYS on the host, or PeriscopeHostOptions.controllerEnvKeys`,
      );
    }
    const policy: SpawnEnvPolicy = {
      ...(request.env.extraAllowedKeys === null
        ? {}
        : { extraAllowedKeys: [...request.env.extraAllowedKeys] }),
      ...(request.env.extraDeniedKeys === null ? {} : { extraDeniedKeys: [...request.env.extraDeniedKeys] }),
      ...(request.env.extraEnv === null ? {} : { extraEnv: { ...request.env.extraEnv } }),
    };
    composed['env'] = policy;
  }

  if (request.mcpServers !== null) {
    const servers = readMcpServers(request.mcpServers);
    if (!servers.ok) return refuse<ComposableRequest>(servers.refusal.reason, servers.refusal.detail);
    // Codex takes a server only in a form it has a setting for; one it has none for is refused here,
    // by name, before anything is reserved.
    if (runtime === CODEX_RUNTIME) {
      const codex = codexMcpConfig(servers.value);
      if (!codex.ok) return refuse<ComposableRequest>(codex.refusal.reason, codex.refusal.detail);
    }
    composed['mcpServers'] = servers.value;
  }

  // The endpoint last, read against the runtime the session runs on and the model it names: a name
  // the operator did not declare, an endpoint that cannot carry this runtime, and a model this endpoint
  // must not be sent are each refused by name before anything is reserved. Null or absent is the
  // runtime's own route.
  const endpointName = request.endpoint ?? null;
  if (endpointName !== null) {
    const endpoint = endpoints.find((one) => one.name === endpointName);
    if (endpoint === undefined) {
      return refuse<ComposableRequest>(
        'endpoint-unknown',
        `endpoint ${JSON.stringify(endpointName)} is not one this host declares; the endpoints its hello ` +
          `lists are ${endpoints.length === 0 ? 'none' : endpoints.map((one) => one.name).join(', ')}`,
      );
    }
    const sessionRuntime = runtime ?? DEFAULT_RUNTIME;
    if (!endpoint.runtimes.includes(sessionRuntime)) {
      return refuse<ComposableRequest>(
        'endpoint-incompatible',
        `endpoint "${endpoint.name}" does not carry runtime ${sessionRuntime}; it carries ` +
          endpoint.runtimes.join(', '),
      );
    }
    if (!wireApisFor(sessionRuntime).includes(endpoint.wireApi)) {
      return refuse<ComposableRequest>(
        'endpoint-incompatible',
        `endpoint "${endpoint.name}" speaks ${endpoint.wireApi}, which runtime ${sessionRuntime} does not ` +
          `speak`,
      );
    }
    const mismatch = endpointModelProblem(request.model, endpoint);
    if (mismatch !== null) return refuse<ComposableRequest>('model-endpoint-mismatch', mismatch);
    composed['endpoint'] = endpointName;
  }

  return ok(composed as ComposableRequest);
}

/**
 * Shape-check the server map. Each value must be an object; beyond that the SDK is the validator.
 *
 * See this file's header for why the config union is not re-stated here.
 */
function readMcpServers(servers: JsonObject): Result<Record<string, McpServerConfig>> {
  const read: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (name === '') {
      return refuse<Record<string, McpServerConfig>>(
        'mcp-descriptor-invalid',
        'an MCP server was declared under an empty name; a tool reaches the model as ' +
          '`mcp__{server}__{tool}` and an unnamed server has no reachable tools',
      );
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      return refuse<Record<string, McpServerConfig>>(
        'mcp-descriptor-invalid',
        `MCP server "${name}" is declared as ${config === null ? 'null' : typeof config}, not an object`,
      );
    }
    read[name] = config as unknown as McpServerConfig;
  }
  return ok(read);
}

/**
 * Merge the controller's servers with the ones this host registers itself.
 *
 * A colliding name is refused rather than resolved, and either precedence would have been wrong.
 * Letting the controller win lets a remote peer replace the host's OWN tool server — the one that
 * carries the host's identity into every call — with something it supplies. Letting the host win
 * silently discards a registration the controller believes it made, and its tools then simply do not
 * exist, with nothing anywhere saying why. So the pair is refused, before any process exists, naming
 * the server both sides claimed.
 */
export function mergeMcpServers(
  fromController: Readonly<Record<string, McpServerConfig>> | undefined,
  fromHost: Readonly<Record<string, McpServerConfig>> | null,
): Result<Readonly<Record<string, McpServerConfig>> | null> {
  if (fromHost === null) return ok(fromController ?? null);
  if (fromController === undefined) return ok(fromHost);

  const collisions = Object.keys(fromHost).filter((name) =>
    Object.prototype.hasOwnProperty.call(fromController, name),
  );
  if (collisions.length > 0) {
    return refuse<Readonly<Record<string, McpServerConfig>> | null>(
      'mcp-descriptor-invalid',
      `MCP server ${collisions.map((name) => `"${name}"`).join(', ')} is declared by both this host ` +
        `and the controller. Refused rather than resolved: letting the controller win replaces this ` +
        `host's own tool server, and letting the host win discards a registration the controller ` +
        `believes it made. Rename one`,
    );
  }
  return ok({ ...fromHost, ...fromController });
}
