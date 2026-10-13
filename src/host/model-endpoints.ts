/**
 * The model endpoints this host's operator declares: read from one JSON file at start, checked,
 * their credentials resolved, then offered in the hello by name and applied to a session that names
 * one.
 *
 * Why a file of its own and not entries in the config file: an endpoint is a structured record with
 * a credential reference, and the config file maps names to strings and is printed whole by
 * `periscope status`. The file is named by `PERISCOPE_MODEL_ENDPOINTS`, which a controller cannot
 * write (`host_configure` does not take the key), and the file and every credential file it names
 * join the protected set, so no session can read them.
 *
 * A controller names an endpoint and never writes one. What reaches the agent is composed here and
 * applied by the host after the controller's own lanes (`composeSpawnEnv`'s `hostEnv`), so the floor
 * that keeps a controller off the model route never sees it.
 *
 * Credentials are resolved once, at start, and held in memory; a rotated key takes a restart. A
 * helper command's output is never logged or repeated: a failure names the endpoint and how the
 * command ended, never what it printed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import type { EndpointWireApi, HostEndpoint } from '../control/frames.js';
import {
  DEFAULT_RUNTIME,
  ENDPOINT_WIRE_APIS,
  MAX_ENDPOINT_MODELS,
  MAX_ENDPOINTS,
  MAX_FACT_WORD_LENGTH,
} from '../control/frames.js';
import { hostEndpointsProblem } from '../control/codec.js';
import { isAbsolutePath } from '../core/paths.js';
import { STRIPPED_HOST_SESSION_KEYS } from '../sessions/spawn-env.js';
import { ENDPOINT_ROUTED_RUNTIMES, wireApisFor } from '../sessions/runtimes.js';

/** The model tiers an endpoint may map to its own ids, each read by the agent CLI from one variable. */
export const MODEL_ALIAS_TIERS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export type ModelAliasTier = (typeof MODEL_ALIAS_TIERS)[number];

/**
 * The tiers an endpoint that is not Anthropic's own route must map. The agent CLI resolves an
 * unmapped tier to a Claude model id, and it makes its own background calls on Haiku's, so a tier
 * left unmapped sends a Claude id to a provider that may answer it with its own model.
 */
export const REQUIRED_ALIAS_TIERS: readonly ModelAliasTier[] = ['opus', 'sonnet', 'haiku'];

/**
 * Every model alias the agent CLI accepts, in its own words: the tiers above, and `default`, `best`
 * and `opusplan`, which no endpoint variable maps. Each is also accepted with a `[1m]` suffix.
 */
export const AGENT_MODEL_ALIASES = [
  'default',
  'best',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'opusplan',
] as const;

/** The variable the agent CLI reads each tier's model from. */
const ALIAS_VARIABLES: Readonly<Record<ModelAliasTier, string>> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

/**
 * Every variable this host sets from an endpoint's own members. An endpoint's `env` may not name one:
 * the member is where its value comes from.
 */
export const ENDPOINT_MEMBER_VARIABLES: readonly string[] = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  ...Object.values(ALIAS_VARIABLES),
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
  // A Codex session's endpoint credential: the variable its provider reads the key from.
  'PERISCOPE_CODEX_ENDPOINT_KEY',
];

/** The most variables an endpoint's own `env` may set. */
const MAX_ENDPOINT_ENV_KEYS = 32;

/** The auto-compaction window the agent CLI accepts, in tokens, inclusive. */
const AUTO_COMPACT_WINDOW_RANGE = { min: 100_000, max: 1_000_000 } as const;

/** How long a credential helper may run at start before it is called failed. */
const HELPER_TIMEOUT_MS = 30_000;

/**
 * How an endpoint declares its model's window, in the form its vendor documents: the agent CLI's
 * auto-compaction window, or the context size it should assume. Never both on one endpoint.
 */
export type EndpointContextWindow =
  { readonly autoCompactWindow: number } | { readonly maxContextTokens: number };

/** One model endpoint, checked and with its credential resolved. */
export interface ModelEndpoint {
  /** What a `session_new` names it by, and what the hello lists. */
  readonly name: string;
  readonly wireApi: EndpointWireApi;
  /** The runtimes that can reach it, each of which speaks `wireApi`. */
  readonly runtimes: readonly string[];
  /** Where the agent's model calls go. Never on the wire. */
  readonly baseUrl: string;
  /** The model ids a session may name on it, as the agent CLI sends them. */
  readonly models: readonly string[];
  /** The model each mapped tier resolves to on this endpoint. */
  readonly modelAliases: Readonly<Partial<Record<ModelAliasTier, string>>>;
  readonly contextWindow: EndpointContextWindow | null;
  /** Further variables the operator sets for sessions on this endpoint. */
  readonly env: Readonly<Record<string, string>>;
  /** Anthropic's own route: a Claude model id may be named on it. Never on the wire. */
  readonly firstParty: boolean;
  /** The credential, resolved at start. A function, so the value never serializes with the record. */
  readonly authToken: () => string;
}

/** An endpoint's members that no runtime reaching it reads, left out of what the host applies. */
export interface IgnoredEndpointMembers {
  readonly endpoint: string;
  readonly members: readonly string[];
}

/** What reading the endpoints file produced: the endpoints, and every file the protected set takes. */
export interface ModelEndpointsReading {
  readonly endpoints: readonly ModelEndpoint[];
  /** The endpoints file and every credential file it names, as absolute paths. */
  readonly files: readonly string[];
  /**
   * Members an endpoint states that no runtime reaching it reads (a model alias or the first-party
   * marker on an endpoint only Codex reaches), each endpoint's once. Reported, never refused.
   */
  readonly ignored: readonly IgnoredEndpointMembers[];
  /**
   * Agent aliases an endpoint lists in its `models` and does not map, each endpoint's once. A session
   * naming one is refused `model-endpoint-mismatch` at its open, so it never reaches the wrong model;
   * the listing is reported at start, never refused.
   */
  readonly unmappedAliases: readonly IgnoredEndpointMembers[];
}

export interface ModelEndpointsReadOptions {
  /** The platform the helper's command is checked against. Defaults to this process's. */
  readonly platform?: NodeJS.Platform;
  /** How long a helper may run. Defaults to 30 seconds. */
  readonly helperTimeoutMs?: number;
}

/** A credential reference, as the file states it. */
type CredentialReference =
  | { readonly env: string }
  | { readonly file: string }
  | { readonly helper: { readonly command: string; readonly args: readonly string[] } };

/** One endpoint as the file declares it, checked, before its credential is resolved. */
interface DeclaredEndpoint extends Omit<ModelEndpoint, 'authToken'> {
  readonly credential: CredentialReference;
  /** The members it states that no runtime reaching it reads. */
  readonly ignored: readonly string[];
  /** The agent aliases its `models` lists and its `modelAliases` does not map. */
  readonly unmappedAliases: readonly string[];
}

const ENDPOINT_KEYS = [
  'name',
  'wireApi',
  'runtimes',
  'baseUrl',
  'credential',
  'models',
  'modelAliases',
  'contextWindow',
  'env',
  'firstParty',
] as const;

const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VARIABLE_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_MODEL_ID_LENGTH = 200;

/**
 * Read, check and resolve the endpoints file at `path`, or say why it cannot be used. `env` is the
 * process environment an `env` credential is read from. Every check runs before any credential is
 * resolved, so a file that is wrong in shape runs no helper.
 */
export function readModelEndpoints(
  path: string,
  env: NodeJS.ProcessEnv,
  options: ModelEndpointsReadOptions = {},
): ModelEndpointsReading | string {
  const where = `the endpoints file at ${path}`;
  if (!isAbsolutePath(path)) return `PERISCOPE_MODEL_ENDPOINTS must be an absolute path — got '${path}'`;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return `${where} cannot be read (${errorCode(error)})`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    return `${where} is not JSON: ${error instanceof Error ? error.message : String(error)}`;
  }

  const declared = declaredEndpoints(parsed, where, options.platform ?? process.platform);
  if (typeof declared === 'string') return declared;

  const endpoints: ModelEndpoint[] = [];
  const files = [path];
  const ignored: IgnoredEndpointMembers[] = [];
  const unmappedAliases: IgnoredEndpointMembers[] = [];
  for (const entry of declared) {
    if (entry.ignored.length > 0) ignored.push({ endpoint: entry.name, members: entry.ignored });
    if (entry.unmappedAliases.length > 0)
      unmappedAliases.push({ endpoint: entry.name, members: entry.unmappedAliases });
    const token = resolveCredential(entry, env, options.helperTimeoutMs ?? HELPER_TIMEOUT_MS);
    if (!token.ok) return `${where}: endpoint "${entry.name}" ${token.problem}`;
    if ('file' in entry.credential && !files.includes(entry.credential.file))
      files.push(entry.credential.file);
    const value = token.value;
    endpoints.push({
      name: entry.name,
      wireApi: entry.wireApi,
      runtimes: entry.runtimes,
      baseUrl: entry.baseUrl,
      models: entry.models,
      modelAliases: entry.modelAliases,
      contextWindow: entry.contextWindow,
      env: entry.env,
      firstParty: entry.firstParty,
      authToken: () => value,
    });
  }
  return { endpoints, files, ignored, unmappedAliases };
}

/** The endpoints a parsed file declares, checked, or the first problem with them. */
function declaredEndpoints(
  parsed: unknown,
  where: string,
  platform: NodeJS.Platform,
): DeclaredEndpoint[] | string {
  if (!isPlainObject(parsed)) return `${where} must hold one JSON object with an "endpoints" list`;
  for (const key of Object.keys(parsed)) {
    if (key !== 'endpoints') return `${where} carries an unknown key '${key}' — it holds "endpoints" alone`;
  }
  const list = parsed['endpoints'];
  if (!Array.isArray(list)) return `${where} must hold an "endpoints" list`;
  if (list.length > MAX_ENDPOINTS)
    return `${where} declares ${list.length} endpoints; at most ${MAX_ENDPOINTS}`;

  const declared: DeclaredEndpoint[] = [];
  const names = new Set<string>();
  for (const [index, value] of list.entries()) {
    const entry = declaredEndpoint(value, where, index, platform);
    if (typeof entry === 'string') return entry;
    if (names.has(entry.name.toLowerCase())) return `${where} names the endpoint "${entry.name}" twice`;
    names.add(entry.name.toLowerCase());
    declared.push(entry);
  }
  const problem = hostEndpointsProblem(hostEndpointsOf(declared));
  if (problem !== null) return `${where}: ${problem}`;
  return declared;
}

/** One entry, checked member by member, or the first problem with it. */
function declaredEndpoint(
  value: unknown,
  where: string,
  index: number,
  platform: NodeJS.Platform,
): DeclaredEndpoint | string {
  const at = `${where}: endpoints[${index}]`;
  if (!isPlainObject(value)) return `${at} is not an object`;
  for (const key of Object.keys(value)) {
    if (!(ENDPOINT_KEYS as readonly string[]).includes(key)) {
      return `${at} carries an unknown key '${key}' — an endpoint takes ${ENDPOINT_KEYS.join(', ')}`;
    }
  }

  const name = value['name'];
  if (typeof name !== 'string' || name.length > MAX_FACT_WORD_LENGTH || !NAME_SHAPE.test(name)) {
    return `${at} needs a name of letters, digits, '.', '_' and '-', at most ${MAX_FACT_WORD_LENGTH} characters`;
  }
  const the = `${where}: endpoint "${name}"`;

  const wireApi = value['wireApi'];
  if (typeof wireApi !== 'string' || !(ENDPOINT_WIRE_APIS as readonly string[]).includes(wireApi)) {
    return `${the} names the wire API ${JSON.stringify(wireApi)}, which is not one this host knows — the APIs are ${ENDPOINT_WIRE_APIS.join(', ')}`;
  }
  const api = wireApi as EndpointWireApi;

  const runtimes = value['runtimes'];
  if (
    !Array.isArray(runtimes) ||
    runtimes.length === 0 ||
    !runtimes.every((one) => typeof one === 'string')
  ) {
    return `${the} needs a non-empty "runtimes" list of runtime names`;
  }
  const routed = ENDPOINT_ROUTED_RUNTIMES;
  for (const runtime of runtimes) {
    if (!routed.includes(runtime)) {
      return `${the} names the runtime ${JSON.stringify(runtime)}, which this host routes no model endpoint for — it routes ${routed.join(', ')}`;
    }
    if (!wireApisFor(runtime).includes(api)) {
      return `${the} names the runtime ${runtime}, which does not speak ${api} — ${runtime} speaks ${wireApisFor(runtime).join(', ')}`;
    }
  }
  if (new Set(runtimes).size !== runtimes.length) return `${the} names a runtime twice`;
  // Claude's rules (the model tiers, the first-party route, the window a [1m] id implies) are the agent
  // CLI's, and hold only on an endpoint Claude reaches. On any other, what only they read is ignored.
  const reachesClaude = runtimes.includes(DEFAULT_RUNTIME);
  const ignored: string[] = [];

  const baseUrl = value['baseUrl'];
  if (typeof baseUrl !== 'string' || !isHttpUrl(baseUrl)) {
    return `${the} needs a "baseUrl" that is an absolute http or https URL`;
  }

  const credential = credentialReference(value['credential'], the, platform);
  if (typeof credential === 'string') return credential;

  const models = value['models'];
  if (!Array.isArray(models) || models.length === 0) return `${the} needs a non-empty "models" list`;
  for (const model of models) {
    if (typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_ID_LENGTH) {
      return `${the} lists a model id that is not a string of 1 to ${MAX_MODEL_ID_LENGTH} characters`;
    }
  }
  if (new Set(models).size !== models.length) return `${the} lists a model id twice`;
  const modelIds = models as string[];

  const aliases = reachesClaude ? (value['modelAliases'] ?? {}) : {};
  if (!reachesClaude && value['modelAliases'] !== undefined) ignored.push('modelAliases');
  if (!isPlainObject(aliases)) return `${the} has a "modelAliases" that is not an object`;
  const modelAliases: Partial<Record<ModelAliasTier, string>> = {};
  for (const [tier, target] of Object.entries(aliases)) {
    if (!(MODEL_ALIAS_TIERS as readonly string[]).includes(tier)) {
      return `${the} maps the alias '${tier}' — the aliases an endpoint maps are ${MODEL_ALIAS_TIERS.join(', ')}`;
    }
    if (typeof target !== 'string' || !modelIds.includes(target)) {
      return `${the} maps ${tier} to ${JSON.stringify(target)}, which its "models" list does not name`;
    }
    modelAliases[tier as ModelAliasTier] = target;
  }
  if (
    modelIds.length + Object.keys(modelAliases).filter((tier) => !modelIds.includes(tier)).length >
    MAX_ENDPOINT_MODELS
  ) {
    return `${the} offers more than ${MAX_ENDPOINT_MODELS} model ids, its alias ids included`;
  }

  const marked = value['firstParty'] ?? false;
  if (typeof marked !== 'boolean') return `${the} has a "firstParty" that is not true or false`;
  if (marked && !reachesClaude) ignored.push('firstParty');
  const firstParty = marked && reachesClaude;
  if (!firstParty && reachesClaude) {
    const unmapped = REQUIRED_ALIAS_TIERS.filter((tier) => modelAliases[tier] === undefined);
    if (unmapped.length > 0) {
      return (
        `${the} maps no model for ${unmapped.join(', ')}: on an endpoint that is not Anthropic's own route ` +
        `the agent CLI would send a Claude model id for an unmapped tier, including its own background ` +
        `calls on haiku. Map ${REQUIRED_ALIAS_TIERS.join(', ')} in "modelAliases"`
      );
    }
    const claudeId = modelIds.find(isClaudeModelId);
    if (claudeId !== undefined) {
      return `${the} lists ${claudeId}, a Claude model id, and is not marked "firstParty": a provider that maps Claude ids answers with its own model`;
    }
  }

  // An agent alias listed as a model and not mapped cannot be opened on: the open refuses it by name.
  const unmappedAliases =
    reachesClaude && !firstParty
      ? modelIds.filter((id) => {
          const alias = id.toLowerCase().replace(/\[1m\]$/, '');
          return (
            (AGENT_MODEL_ALIASES as readonly string[]).includes(alias) &&
            modelAliases[alias as ModelAliasTier] === undefined
          );
        })
      : [];

  const window = contextWindowOf(value['contextWindow'], the);
  if (typeof window === 'string') return window;
  if (reachesClaude && window !== null && 'maxContextTokens' in window) {
    const suffixed = [...modelIds, ...Object.values(modelAliases)].find((id) => /\[1m\]$/i.test(id));
    if (suffixed !== undefined) {
      return (
        `${the} declares "maxContextTokens" and lists ${suffixed}: a [1m] id is assumed to hold a million ` +
        `tokens, so the two window forms are never combined. Use "autoCompactWindow" with [1m] ids, or ` +
        `"maxContextTokens" without them`
      );
    }
  }

  const extra = value['env'] ?? {};
  if (!isPlainObject(extra)) return `${the} has an "env" that is not an object`;
  const keys = Object.keys(extra);
  if (keys.length > MAX_ENDPOINT_ENV_KEYS)
    return `${the} sets ${keys.length} variables in "env"; at most ${MAX_ENDPOINT_ENV_KEYS}`;
  const owned = new Set(ENDPOINT_MEMBER_VARIABLES.map((key) => key.toUpperCase()));
  const markers = new Set(STRIPPED_HOST_SESSION_KEYS.map((key) => key.toUpperCase()));
  for (const key of keys) {
    if (!VARIABLE_SHAPE.test(key))
      return `${the} sets '${key}' in "env", which is not an environment variable name`;
    if (owned.has(key.toUpperCase())) {
      return `${the} sets ${key} in "env", which this host sets from the endpoint's own members`;
    }
    if (markers.has(key.toUpperCase())) {
      return `${the} sets ${key} in "env", a variable this host strips from every session`;
    }
    if (typeof extra[key] !== 'string')
      return `${the} sets ${key} in "env" to something that is not a string`;
  }

  return {
    name,
    wireApi: api,
    runtimes: [...runtimes],
    baseUrl,
    credential,
    models: modelIds,
    modelAliases,
    contextWindow: window,
    env: { ...(extra as Record<string, string>) },
    firstParty,
    ignored,
    unmappedAliases,
  };
}

/** An entry's credential reference, checked, or the problem with it. */
function credentialReference(
  value: unknown,
  the: string,
  platform: NodeJS.Platform,
): CredentialReference | string {
  const forms =
    'exactly one of {"env": NAME}, {"file": PATH} or {"helper": {"command": PATH, "args": [...]}}';
  if (!isPlainObject(value)) return `${the} needs a "credential": ${forms}`;
  const keys = Object.keys(value);
  if (keys.length !== 1) return `${the} needs a "credential" of ${forms}`;
  const form = keys[0];
  const inner = value[form ?? ''];
  if (form === 'env') {
    if (typeof inner !== 'string' || !VARIABLE_SHAPE.test(inner)) {
      return `${the} names a credential variable that is not an environment variable name`;
    }
    return { env: inner };
  }
  if (form === 'file') {
    if (typeof inner !== 'string' || !isAbsolutePath(inner))
      return `${the} needs a credential file that is an absolute path`;
    return { file: inner };
  }
  if (form === 'helper') {
    if (!isPlainObject(inner)) return `${the} needs a credential helper of {"command": PATH, "args": [...]}`;
    for (const key of Object.keys(inner)) {
      if (key !== 'command' && key !== 'args')
        return `${the} carries an unknown helper key '${key}' — a helper takes command and args`;
    }
    const command = inner['command'];
    if (typeof command !== 'string' || !isAbsolutePath(command)) {
      return `${the} needs a helper command that is an absolute path to an executable`;
    }
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
      return (
        `${the} names the helper ${command}, a Windows batch file: Node runs one only through a shell, and ` +
        `this host never builds a shell command from configuration. Name the program the batch file runs, ` +
        `with its arguments; the Azure CLI's az.cmd, for one, runs its own python.exe with -IBm azure.cli`
      );
    }
    const args = inner['args'] ?? [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
      return `${the} needs helper "args" that is a list of strings`;
    }
    return { helper: { command, args: [...args] } };
  }
  return `${the} names the credential form '${String(form)}' — ${forms}`;
}

/** An entry's window, checked, or the problem with it. Absent or null is no window. */
function contextWindowOf(value: unknown, the: string): EndpointContextWindow | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value) || Object.keys(value).length !== 1) {
    return `${the} needs a "contextWindow" of exactly one of {"autoCompactWindow": N} or {"maxContextTokens": N}`;
  }
  if ('autoCompactWindow' in value) {
    const tokens = value['autoCompactWindow'];
    if (
      typeof tokens !== 'number' ||
      !Number.isInteger(tokens) ||
      tokens < AUTO_COMPACT_WINDOW_RANGE.min ||
      tokens > AUTO_COMPACT_WINDOW_RANGE.max
    ) {
      return `${the} needs an "autoCompactWindow" that is a whole number of tokens from ${AUTO_COMPACT_WINDOW_RANGE.min} to ${AUTO_COMPACT_WINDOW_RANGE.max}`;
    }
    return { autoCompactWindow: tokens };
  }
  if ('maxContextTokens' in value) {
    const tokens = value['maxContextTokens'];
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens <= 0) {
      return `${the} needs a "maxContextTokens" that is a positive whole number of tokens`;
    }
    return { maxContextTokens: tokens };
  }
  return `${the} needs a "contextWindow" of exactly one of {"autoCompactWindow": N} or {"maxContextTokens": N}`;
}

type Resolved =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly problem: string };

/**
 * The credential an entry references, read now. The value is one non-empty line; a reference that
 * yields nothing, or more than one line, is a missing credential. Nothing read is ever repeated in a
 * problem.
 */
function resolveCredential(entry: DeclaredEndpoint, env: NodeJS.ProcessEnv, timeoutMs: number): Resolved {
  const reference = entry.credential;
  if ('env' in reference) {
    const value = env[reference.env]?.trim() ?? '';
    if (value === '')
      return {
        ok: false,
        problem: `names the credential variable ${reference.env}, which is unset or empty`,
      };
    return oneLine(value, `the variable ${reference.env}`);
  }
  if ('file' in reference) {
    let text: string;
    try {
      text = readFileSync(reference.file, 'utf8');
    } catch (error) {
      return {
        ok: false,
        problem: `names the credential file ${reference.file}, which cannot be read (${errorCode(error)})`,
      };
    }
    const value = text.trim();
    if (value === '')
      return { ok: false, problem: `names the credential file ${reference.file}, which is empty` };
    return oneLine(value, `the credential file ${reference.file}`);
  }
  const { command, args } = reference.helper;
  let output: string;
  try {
    output = execFileSync(command, [...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    return {
      ok: false,
      problem: `has a credential helper (${command}) that ${helperFailure(error, timeoutMs)}`,
    };
  }
  const value = output.trim();
  if (value === '')
    return { ok: false, problem: `has a credential helper (${command}) that printed nothing` };
  return oneLine(value, `the credential helper (${command})`);
}

function oneLine(value: string, source: string): Resolved {
  if (/[\r\n]/.test(value))
    return { ok: false, problem: `reads more than one line from ${source}; a credential is one line` };
  return { ok: true, value };
}

/**
 * How a helper ended, in words that carry none of its output: the exit code, the signal, the timeout,
 * or the error code it could not start with. A child process error's message repeats the command's
 * own output, so it is never used.
 */
function helperFailure(error: unknown, timeoutMs: number): string {
  const failed = error as { status?: unknown; signal?: unknown; code?: unknown };
  if (failed.code === 'ETIMEDOUT') return `did not finish within ${timeoutMs / 1000} seconds`;
  if (typeof failed.status === 'number') return `exited with code ${failed.status}`;
  if (typeof failed.signal === 'string') return `was ended by ${failed.signal}`;
  if (typeof failed.code === 'string') return `could not be started (${failed.code})`;
  return 'failed';
}

/**
 * The endpoints as the hello lists them: names, wire APIs, runtimes, and every model id a session may
 * name, the alias ids each maps included. No address, no credential, no first-party marker. A runtime
 * is listed only where this host routes it and it speaks the endpoint's wire API, so an endpoint the
 * hello offers a runtime is one a session on that runtime can open on.
 */
export function hostEndpointsOf(endpoints: readonly Omit<ModelEndpoint, 'authToken'>[]): HostEndpoint[] {
  return endpoints.map((endpoint) => {
    const models = [...endpoint.models];
    for (const tier of MODEL_ALIAS_TIERS) {
      if (endpoint.modelAliases[tier] !== undefined && !models.includes(tier)) models.push(tier);
    }
    const runtimes = endpoint.runtimes.filter(
      (runtime) =>
        ENDPOINT_ROUTED_RUNTIMES.includes(runtime) && wireApisFor(runtime).includes(endpoint.wireApi),
    );
    return { name: endpoint.name, wireApi: endpoint.wireApi, runtimes, models };
  });
}

/**
 * The variables a Claude session on `endpoint` is spawned with: the address and the credential, the
 * model each mapped tier resolves to, the window in the form the endpoint declares, the switch that
 * stops the agent CLI sending pre-release request fields an endpoint may refuse, the switch that keeps
 * the credential out of the environments of the commands, hooks and tool servers the agent starts,
 * and the operator's own `env`. The members win over `env`.
 */
export function endpointSpawnEnv(endpoint: ModelEndpoint): Record<string, string> {
  const env: Record<string, string> = { ...endpoint.env };
  env['ANTHROPIC_BASE_URL'] = endpoint.baseUrl;
  env['ANTHROPIC_AUTH_TOKEN'] = endpoint.authToken();
  for (const tier of MODEL_ALIAS_TIERS) {
    const target = endpoint.modelAliases[tier];
    if (target !== undefined) env[ALIAS_VARIABLES[tier]] = target;
  }
  const window = endpoint.contextWindow;
  if (window !== null) {
    if ('maxContextTokens' in window) env['CLAUDE_CODE_MAX_CONTEXT_TOKENS'] = String(window.maxContextTokens);
    else env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'] = String(window.autoCompactWindow);
  }
  env['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'] = '1';
  env['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'] = '1';
  return env;
}

/**
 * Why `model` cannot be named on `endpoint`, or null: on an endpoint that is not Anthropic's own
 * route, a Claude model id, or an alias the endpoint does not map (which the agent CLI resolves to a
 * Claude model id). A provider that maps Claude ids to its own model would answer in its place, while
 * the run reads, and is priced, as the Claude model it named. No model named is not refused: every such
 * endpoint maps the opus, sonnet and haiku tiers. The rule is the agent CLI's, so it holds only on an
 * endpoint Claude reaches: a session on any other runtime never meets it.
 */
export function endpointModelProblem(
  model: string | null | undefined,
  endpoint: ModelEndpoint,
): string | null {
  if (endpoint.firstParty || model === null || model === undefined) return null;
  if (!endpoint.runtimes.includes(DEFAULT_RUNTIME)) return null;
  const route = `endpoint "${endpoint.name}", which is not marked as Anthropic's own route`;
  if (isClaudeModelId(model)) {
    return `model ${model} named for ${route}: a provider that maps Claude ids to its own model would answer in its place`;
  }
  const alias = model.toLowerCase().replace(/\[1m\]$/, '');
  if (
    (AGENT_MODEL_ALIASES as readonly string[]).includes(alias) &&
    endpoint.modelAliases[alias as ModelAliasTier] === undefined
  ) {
    return (
      `model ${model} named for endpoint "${endpoint.name}", which maps no ${alias} and is not marked as ` +
      `Anthropic's own route: the agent CLI resolves an unmapped alias to a Claude model id`
    );
  }
  return null;
}

function isClaudeModelId(model: string): boolean {
  return model.toLowerCase().startsWith('claude-');
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'unknown error';
}
