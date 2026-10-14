/**
 * What this host states about each runtime it composes sessions for, beside its fact lift: the
 * control tier a session on it starts at, the wire APIs it speaks, and which runtime a session
 * request names.
 *
 * Each lookup has two readers. The tier: the hello's entry for the runtime and the composer that puts
 * the tier on a session's first `ready`, so a hello and a session state the same level by construction,
 * and a session adds only the degrades known for it alone. The wire APIs: the check an operator's endpoints meet at start and
 * the check a session's endpoint meets at open, so an endpoint the hello offers a runtime is one that
 * runtime can open on.
 */
import type { EndpointWireApi, HostAgentSkills, SkillDelivery, SkillNaming } from '../control/frames.js';
import { DEFAULT_RUNTIME } from '../control/frames.js';
import type { ControlTier } from '../state/model.js';

/** Codex's name on the wire: the runtime this host drives through `codex app-server`. */
export const CODEX_RUNTIME = 'codex';

/**
 * Qwen Code's name on the wire: the runtime this host drives through the `qwen` CLI's stream-json control
 * protocol (protocol 17). Not `qwen`, which names the models, run on any runtime through an endpoint.
 */
export const QWEN_RUNTIME = 'qwen-code';

/**
 * pi's name on the wire: the runtime this host drives as a `pi --mode rpc` child, gated by an extension
 * of this host's own that it loads into it.
 */
export const PI_RUNTIME = 'pi';

/**
 * The control tier a session starts at, per runtime, keyed by the runtime's name: what holds for every
 * session on it. A session's own opening transition adds the degrades known for it alone when it opens
 * (its sandbox, a hook this host did not install, the workspace's own configuration), so a hello and a
 * session state the same level and the session may name more paths beneath it.
 */
export const CONTROL_TIERS = {
  // Every tool call reaches the `PreToolUse` gate before it runs, under every permission mode, and
  // the gate's answer holds: no path falls below it.
  [DEFAULT_RUNTIME]: { level: 'intercepted', degrades: [] },
  // Every Codex tool call its hook sees is decided by this host's gate before it runs, and the approvals
  // Codex asks for are decided by the same gate. Codex runs its hook fail-open on the hook's own failure
  // and a few calls never reach any hook, so each such path is named as a degrade when it occurs.
  [CODEX_RUNTIME]: { level: 'intercepted-with-residual', degrades: [] },
  // Every call Qwen Code's rules send to ask is decided by this host's gate before it runs, and the
  // session's settings send every built-in tool and attached server there. A tool the CLI lists that no
  // rule names, or a mode in which the CLI approves calls itself, is named as a degrade when it occurs.
  [QWEN_RUNTIME]: { level: 'intercepted-with-residual', degrades: [] },
  // Every pi tool call reaches this host's extension before it runs, and the extension's answer holds:
  // the runtime is launched so that no other extension loads, and its own MCP extension only waits for
  // its servers. A session in which code this host did not load is found running starts below this.
  [PI_RUNTIME]: { level: 'intercepted', degrades: [] },
} as const satisfies Readonly<Record<string, ControlTier>>;

/**
 * The wire APIs each runtime speaks, keyed by the runtime's name, with the same keys as the tiers: a
 * model endpoint is reachable by a runtime only when the runtime speaks the endpoint's API.
 */
export const RUNTIME_WIRE_APIS = {
  // Claude Code calls its model through Anthropic's Messages API, whichever server answers it.
  [DEFAULT_RUNTIME]: ['anthropic-messages'],
  // Codex calls its model through OpenAI's Responses API only.
  [CODEX_RUNTIME]: ['openai-responses'],
  // Qwen Code calls an OpenAI-compatible chat endpoint, OpenAI's Responses API or Anthropic's Messages API.
  [QWEN_RUNTIME]: ['openai-chat', 'openai-responses', 'anthropic-messages'],
  // pi calls an OpenAI-compatible chat endpoint, OpenAI's Responses API or Anthropic's Messages API.
  [PI_RUNTIME]: ['openai-chat', 'openai-responses', 'anthropic-messages'],
} as const satisfies Readonly<Record<keyof typeof CONTROL_TIERS, readonly EndpointWireApi[]>>;

/**
 * How each runtime takes plugin directories, keyed like the tiers. Claude and Codex name a plugin's
 * skills under the plugin's own name; Qwen Code names each by its own `name`, bare. Claude takes them
 * with each session's request (the agent CLI's plugin directories); Codex takes them when its app-server
 * starts, as skill roots, and this host starts one app-server per session; Qwen Code takes them with each
 * session's request too, as the skill directories of the settings this host writes for that session; pi
 * takes them with each session's process, as the skill directories on its command line, and this host
 * starts one process per session.
 */
export const AGENT_SKILLS = {
  [DEFAULT_RUNTIME]: { naming: 'namespaced', delivery: 'per-session' },
  [CODEX_RUNTIME]: { naming: 'namespaced', delivery: 'per-process' },
  [QWEN_RUNTIME]: { naming: 'bare', delivery: 'per-session' },
  [PI_RUNTIME]: { naming: 'bare', delivery: 'per-session' },
} as const satisfies Readonly<
  Record<keyof typeof CONTROL_TIERS, { readonly naming: SkillNaming; readonly delivery: SkillDelivery }>
>;

/** The hello's `agentSkills` for `runtimes`: one entry for each that takes plugin directories, in order. */
export function agentSkillsFor(runtimes: readonly string[]): HostAgentSkills[] {
  const table = AGENT_SKILLS as Readonly<Record<string, Omit<HostAgentSkills, 'runtime'> | undefined>>;
  return runtimes.flatMap((runtime) => {
    const row = Object.hasOwn(table, runtime) ? table[runtime] : undefined;
    return row === undefined ? [] : [{ runtime, ...row }];
  });
}

/**
 * The runtimes a model endpoint may name: the ones this host builds an endpoint's route for. A runtime
 * outside it is refused at start, so the hello never offers an endpoint no session on that runtime
 * could use.
 */
export const ENDPOINT_ROUTED_RUNTIMES: readonly string[] = [
  DEFAULT_RUNTIME,
  CODEX_RUNTIME,
  QWEN_RUNTIME,
  PI_RUNTIME,
];

/** The wire APIs `runtime` speaks; empty for a runtime this host does not spawn. */
export function wireApisFor(runtime: string): readonly EndpointWireApi[] {
  if (!Object.hasOwn(RUNTIME_WIRE_APIS, runtime)) return [];
  return (RUNTIME_WIRE_APIS as Readonly<Record<string, readonly EndpointWireApi[]>>)[runtime] ?? [];
}

/** The runtimes this host spawns sessions on, by name. */
export function spawnableRuntimes(): readonly string[] {
  return Object.keys(RUNTIME_WIRE_APIS);
}

/** The control tier a session on `runtime` starts at, or null for a runtime with none declared. */
export function controlTierFor(runtime: string): ControlTier | null {
  if (!Object.hasOwn(CONTROL_TIERS, runtime)) return null;
  return (CONTROL_TIERS as Readonly<Record<string, ControlTier>>)[runtime] ?? null;
}

/** The runtime a session request names: its own `runtime`, or `DEFAULT_RUNTIME` when it names none. */
export function runtimeOf(request: { readonly runtime?: string } | null | undefined): string {
  return request?.runtime ?? DEFAULT_RUNTIME;
}
