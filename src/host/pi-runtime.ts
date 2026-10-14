/**
 * The pi runtime as this host offers it: the read at start that decides its entry in the hello, the
 * registry's way of starting a session on it, and how its messages reach the wire.
 *
 * The read at start, bounded, and never a model call: the base home is created if absent, the CLI's
 * `--version` is held to the pin, the two files this host owns in pi's agent home are written, and pi is
 * started once, with no extension and no session, to say which models it can reach (`get_available_models`).
 * A CLI that is absent, does not answer, reports another version, or whose home cannot be written is
 * listed `available: false` with the reason. A model list that cannot be read, or is past what the hello
 * carries, leaves the entry with no models and says why; a session still names its model.
 */
import type { HostAgentEntry, HostModel } from '../control/frames.js';
import { MAX_AGENT_MODELS, MAX_CONFIGURATION_VALUE_LENGTH } from '../control/frames.js';
import type { MessageBinding } from '../control/stream.js';
import type { NativeRuntime } from '../sessions/registry.js';
import { CONTROL_TIERS, PI_RUNTIME } from '../sessions/runtimes.js';
import type { RunVersion } from './codex-binary.js';
import { PI_PINNED_VERSION, piCommand, readPiVersion } from './pi-binary.js';
import type { PiEndpointRoute } from './pi-endpoints.js';
import { piFactSourceId } from './pi-facts.js';
import { isPiSessionGate } from './pi-gate.js';
import { PI_AGENT_DIR_VARIABLE, ensurePiBase, writePiAgentFiles } from './pi-home.js';
import type { PiRuntimeConfig } from './pi-process.js';
import { PI_EFFORTS, piInitFacts, startPiProcess } from './pi-process.js';
import { PiRpc } from './pi-rpc.js';
import type { PiMessage } from './pi-wire.js';
import { PiAvailableModels, parsed } from './pi-wire.js';
import type { SpawnChild } from './stdio-rpc.js';

/** How long the read at start waits for pi's model list. */
export const PI_MODELS_TIMEOUT_MS = 20_000;

/** What the read at start found. */
export interface PiRuntimeRead {
  /** The hello's entry for pi, available or not. */
  readonly entry: HostAgentEntry;
  /** Why the entry is unavailable, or why it lists no models, in words; null when nothing is wrong. */
  readonly detail: string | null;
}

/** Reads the models pi can reach; the real one starts pi. */
export type ReadPiModels = (
  binary: string,
  env: Readonly<Record<string, string>>,
) => Promise<{ readonly models: readonly HostModel[] } | { readonly error: string }>;

export interface ReadPiRuntimeOptions {
  readonly binary: string;
  readonly base: string;
  /** The environment the CLI runs in for the read. */
  readonly env: Readonly<Record<string, string>>;
  /** The endpoints a pi session may open on, written into the agent home's models file. */
  readonly endpoints?: readonly PiEndpointRoute[];
  readonly runVersion?: RunVersion;
  readonly readModels?: ReadPiModels;
}

/** The entry for a pi runtime, available or not, at its tier. */
function piEntry(
  version: string,
  available: boolean,
  reason: string | null,
  models: readonly HostModel[] = [],
): HostAgentEntry {
  return {
    runtime: PI_RUNTIME,
    version,
    sdkVersion: null,
    models: [...models],
    vocabularies: {
      // pi has no permission modes: every call asks this host.
      permissionModes: [],
      efforts: [...PI_EFFORTS],
      thinking: true,
    },
    controlTier: CONTROL_TIERS[PI_RUNTIME],
    available,
    unavailableReason: reason === null ? null : bounded(reason, MAX_CONFIGURATION_VALUE_LENGTH),
  };
}

/** The entry for a pi runtime that can run, with the models it reaches. */
export function availablePiEntry(version: string, models: readonly HostModel[] = []): HostAgentEntry {
  return piEntry(version, true, null, models);
}

/** The entry for a pi runtime that cannot run now, with why. */
export function unavailablePiEntry(version: string, reason: string): HostAgentEntry {
  return piEntry(version, false, reason);
}

/** One model pi reaches, as the hello lists it: `provider/id`, the form a session names it by. */
export function piHostModel(model: {
  readonly provider: string;
  readonly id: string;
  readonly name?: string | undefined;
  readonly reasoning?: boolean | undefined;
}): HostModel {
  return {
    value: `${model.provider}/${model.id}`,
    resolvedModel: null,
    displayName: model.name ?? model.id,
    description: null,
    supportedEffortLevels: model.reasoning === true ? [...PI_EFFORTS] : [],
    supportsFastMode: null,
    supportsAutoMode: null,
    supportsAdaptiveThinking: null,
  };
}

/**
 * The real model read: pi started with no extension, no skill, no session and no workspace trust, asked
 * `get_available_models`, and closed. No prompt is sent, so no model is called.
 */
export function readPiModelsWith(options: {
  readonly spawn?: SpawnChild;
  readonly killTree?: (pid: number) => Promise<void>;
  readonly closeGraceMs?: number;
  readonly cwd: string;
  readonly timeoutMs?: number;
}): ReadPiModels {
  return async (binary, env) => {
    const command = piCommand(binary, [
      '--mode',
      'rpc',
      '--no-extensions',
      '--no-skills',
      '--no-approve',
      '--no-session',
    ]);
    const stderr: string[] = [];
    const started = PiRpc.start({
      command: command.command,
      args: command.args,
      cwd: options.cwd,
      env,
      onEvent: () => undefined,
      onRecord: () => undefined,
      onStderr: (line) => {
        stderr.push(line);
        if (stderr.length > 5) stderr.shift();
      },
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.killTree === undefined ? {} : { killTree: options.killTree }),
      ...(options.closeGraceMs === undefined ? {} : { closeGraceMs: options.closeGraceMs }),
    });
    if (!started.ok) return { error: started.refusal.detail };
    const rpc = started.value;
    try {
      const answered = await rpc.request(
        'get_available_models',
        {},
        options.timeoutMs ?? PI_MODELS_TIMEOUT_MS,
      );
      if (!answered.ok) {
        const last = stderr.at(-1);
        return { error: `${answered.refusal.detail}${last === undefined ? '' : `: ${last}`}` };
      }
      if (answered.value['success'] !== true) {
        const error = answered.value['error'];
        return {
          error: `pi refused get_available_models: ${typeof error === 'string' ? error : 'no reason'}`,
        };
      }
      const read = parsed(PiAvailableModels, answered.value['data']);
      if (read === null) return { error: 'pi answered get_available_models with no model list' };
      return { models: read.models.map(piHostModel) };
    } finally {
      await rpc.close();
    }
  };
}

/** Read the pi runtime at start. Never throws. */
export async function readPiRuntime(options: ReadPiRuntimeOptions): Promise<PiRuntimeRead> {
  const base = ensurePiBase(options.base);
  if (!base.ok) {
    return { entry: unavailablePiEntry(PI_PINNED_VERSION, base.refusal.detail), detail: base.refusal.detail };
  }
  const version = await readPiVersion(options.binary, options.env, options.runVersion);
  if (!version.ok) {
    return {
      entry: unavailablePiEntry(PI_PINNED_VERSION, version.refusal.detail),
      detail: version.refusal.detail,
    };
  }
  const written = writePiAgentFiles(options.base, options.endpoints ?? []);
  if (!written.ok) {
    return {
      entry: unavailablePiEntry(version.value, written.refusal.detail),
      detail: written.refusal.detail,
    };
  }
  const readModels = options.readModels ?? readPiModelsWith({ cwd: base.value.agent });
  const env = {
    ...options.env,
    [PI_AGENT_DIR_VARIABLE]: base.value.agent,
    PI_TELEMETRY: '0',
    PI_SKIP_VERSION_CHECK: '1',
  };
  let models: Awaited<ReturnType<ReadPiModels>>;
  try {
    models = await readModels(options.binary, env);
  } catch (error) {
    models = { error: error instanceof Error ? error.message : String(error) };
  }
  if ('error' in models) {
    return {
      entry: availablePiEntry(version.value),
      detail: `the hello lists no pi models: they could not be read (${models.error}); a session names its model`,
    };
  }
  if (models.models.length > MAX_AGENT_MODELS) {
    return {
      entry: availablePiEntry(version.value),
      detail: `the hello lists no pi models: pi reaches ${models.models.length}, past the ${MAX_AGENT_MODELS} the hello carries; a session names its model`,
    };
  }
  return { entry: availablePiEntry(version.value, models.models), detail: null };
}

function bounded(text: string, length: number): string {
  return text.length <= length ? text : text.slice(0, length);
}

/**
 * How a pi session's messages reach the wire: each event rides as pi wrote it, naming the runtime, a
 * `message_update` on the delta lane and every other on the update lane; each extension record and each
 * answer to this host's commands rides on the update lane as pi wrote it, so a refused prompt (how pi
 * says a model cannot be reached) is on the wire whole. The extension's hello rides nowhere: its facts
 * ride beside it.
 */
export const PI_MESSAGE_BINDING: MessageBinding<PiMessage> = {
  runtime: PI_RUNTIME,
  route(message) {
    switch (message.kind) {
      case 'event':
        return { lane: message.event['type'] === 'message_update' ? 'delta' : 'update', body: message.event };
      case 'record':
        return { lane: 'update', body: message.record };
      case 'response':
        return { lane: 'update', body: message.response };
      default:
        return null;
    }
  },
  sourceIdOf() {
    return piFactSourceId();
  },
  observe(observer, message) {
    return observer.observePiMessage(message);
  },
};

/** The registry's way of starting a session on pi. */
export function piNativeRuntime(config: PiRuntimeConfig): NativeRuntime<PiMessage> {
  return {
    start(request, degrade, route) {
      return startPiProcess(
        request,
        config,
        degrade,
        route.endpoint,
        isPiSessionGate(route.gate) ? route.gate : null,
      );
    },
    readInit(message) {
      return piInitFacts(message);
    },
  };
}
