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
 * That is the boundary, and it is structural rather than a check somebody remembered to write.
 */
import { EXTRA_ENV_FLOOR, extraEnvKeyBeneathFloor } from '../sessions/spawn-env.js';
import type { JsonObject, SessionNewRequest } from '../control/frames.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { SessionRequest } from '../sessions/registry.js';
import type { SpawnEnvPolicy } from '../sessions/spawn-env.js';
import type {
  McpServerConfig,
  PermissionMode,
  SdkPluginConfig,
  SettingSource,
  ThinkingConfig,
} from './agent-process.js';
import type { SessionConfigure } from '../control/frames.js';

/** What a controller may ask for, minus the two the composer supplies itself. */
export type ComposableRequest = Omit<SessionRequest, 'cwd' | 'hooks'>;

/**
 * The three tiers the SDK understands, as data.
 *
 * Restated here rather than derived because the SDK ships them as a bare string union with no
 * runtime value to read — so this is the one place a copy is unavoidable. `wire-request.test.ts`
 * asserts each member against the shipped `sdk.d.ts`, the same way the permission pin does, so the
 * copy cannot quietly drift from what it copies.
 */
export const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];

/** The thinking shapes the SDK declares, by discriminator. Same argument as above. */
export const THINKING_TYPES: readonly string[] = ['adaptive', 'enabled', 'disabled'];

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
 * The one mode under which a granting gate and loaded operator settings are NOT two authorities: the
 * mode already allows everything the grant would, and a hook deny survives every mode. Named here, in
 * the one module that holds the vocabulary, so nothing else has to spell the mode.
 */
export function isBypassMode(mode: string | null | undefined): boolean {
  return mode === PERMISSION_MODES[2];
}

/** What a `session_configure` frame asked for, narrowed to the SDK's own types. */
export interface SessionConfigureChange {
  readonly model?: string | null;
  readonly permissionMode?: PermissionMode;
  readonly thinking?: ThinkingConfig;
}

/**
 * Narrow a `session_configure` payload. Same discipline as `readSessionRequest`: a value the SDK does
 * not declare is REFUSED by name — a mode nobody recognises must never become "the default" silently.
 */
export function readSessionConfigure(payload: SessionConfigure): Result<SessionConfigureChange> {
  const change: { model?: string | null; permissionMode?: PermissionMode; thinking?: ThinkingConfig } = {};
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
    const type = payload.thinking['type'];
    if (typeof type !== 'string' || !THINKING_TYPES.includes(type)) {
      return refuse<SessionConfigureChange>(
        'frame-malformed',
        `thinking.type is ${JSON.stringify(type)}; the shapes this SDK declares are ${THINKING_TYPES.join(', ')}`,
      );
    }
    change.thinking = payload.thinking as unknown as ThinkingConfig;
  }
  return ok(change);
}

/**
 * Turn a controller's request into a local one, or refuse it by name.
 *
 * `null` in means "every default", which is byte-for-byte the behaviour before this payload grew —
 * so a controller that sends nothing new is unaffected by any of this.
 */
export function readSessionRequest(
  request: SessionNewRequest | null,
  extraEnvFloor: readonly string[] = EXTRA_ENV_FLOOR,
): Result<ComposableRequest> {
  if (request === null) return ok({});

  const composed: Record<string, unknown> = {};

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
    const type = request.thinking['type'];
    if (typeof type !== 'string' || !THINKING_TYPES.includes(type)) {
      return refuse<ComposableRequest>(
        'frame-malformed',
        `thinking.type is ${JSON.stringify(type)}; the shapes this SDK declares are ` +
          `${THINKING_TYPES.join(', ')}`,
      );
    }
    composed['thinking'] = request.thinking;
  }

  if (request.effort !== null) {
    if (!EFFORT_LEVELS.includes(request.effort)) {
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
    // Beneath the floor, refused by name before anything is reserved: the allow-list protects
    // against accidental inheritance, this protects against the controller.
    const beneath = extraEnvKeyBeneathFloor(request.env.extraEnv ?? undefined, extraEnvFloor);
    if (beneath !== null) {
      return refuse<ComposableRequest>(
        'env-key-refused',
        `extraEnv sets ${beneath}, which is beneath this host's floor (${extraEnvFloor.join(', ')})`,
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
    composed['mcpServers'] = servers.value;
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
