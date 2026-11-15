/**
 * The opencode runtime as this host offers it: the read at start that decides its entry in the hello, the
 * registry's way of starting a session on it, and how its messages reach the wire.
 *
 * The read at start reads files only: the base home is created if absent, the operator's SDK install is held to
 * the pin (`readOpencodeInstall`: the SDK and its release's server, core and client at the pinned version), and
 * this host's Node is tested for the syntax the SDK needs (`nodeCanRunOpencode`). No process is started, no
 * model is called and nothing is fetched. An install that is absent, off the pin or incomplete, or a Node that
 * cannot load it, is listed `available: false` with the reason. The entry lists no models: an opencode session
 * reaches a model only through an endpoint, and the hello's `endpoints` name each one's.
 */
import type { HostAgentEntry, JsonObject } from '../control/frames.js';
import { MAX_CONFIGURATION_VALUE_LENGTH } from '../control/frames.js';
import type { MessageBinding } from '../control/stream.js';
import type { Result } from '../core/result.js';
import type { NativeRuntime } from '../sessions/registry.js';
import { CONTROL_TIERS, OPENCODE_RUNTIME } from '../sessions/runtimes.js';
import { opencodeFactSourceId } from './opencode-facts.js';
import { isOpencodeSessionGate } from './opencode-gate.js';
import { ensureOpencodeBase } from './opencode-home.js';
import type { OpencodeRuntimeConfig } from './opencode-process.js';
import { OPENCODE_PERMISSION_MODES, opencodeInitFacts, startOpencodeProcess } from './opencode-process.js';
import type { OpencodeInstall } from './opencode-sdk.js';
import { OPENCODE_SDK_PINNED_VERSION, nodeCanRunOpencode, readOpencodeInstall } from './opencode-sdk.js';
import type { OpencodeMessage } from './opencode-wire.js';
import { OPENCODE_DELTA_EVENTS } from './opencode-wire.js';

/** What the read at start found. */
export interface OpencodeRuntimeRead {
  /** The hello's entry for opencode, available or not. */
  readonly entry: HostAgentEntry;
  /** Why the entry is unavailable, in words, or null when nothing is wrong. */
  readonly detail: string | null;
}

export interface ReadOpencodeRuntimeOptions {
  /** `PERISCOPE_OPENCODE_SDK`. */
  readonly sdk: string;
  /** `PERISCOPE_OPENCODE_HOME`. */
  readonly base: string;
  readonly readInstall?: (directory: string) => Result<OpencodeInstall>;
  readonly nodeProblem?: () => string | null;
}

/** The entry for an opencode runtime, available or not, at its tier. */
function opencodeEntry(available: boolean, reason: string | null): HostAgentEntry {
  return {
    runtime: OPENCODE_RUNTIME,
    version: OPENCODE_SDK_PINNED_VERSION,
    sdkVersion: OPENCODE_SDK_PINNED_VERSION,
    models: [],
    vocabularies: {
      permissionModes: [...OPENCODE_PERMISSION_MODES],
      // opencode sets reasoning through a model's variants, and this host's endpoints declare none.
      efforts: [],
      thinking: false,
    },
    controlTier: CONTROL_TIERS[OPENCODE_RUNTIME],
    available,
    unavailableReason: reason === null ? null : bounded(reason, MAX_CONFIGURATION_VALUE_LENGTH),
  };
}

/** The entry for an opencode runtime that can run. */
export function availableOpencodeEntry(): HostAgentEntry {
  return opencodeEntry(true, null);
}

/** The entry for an opencode runtime that cannot run now, with why. */
export function unavailableOpencodeEntry(reason: string): HostAgentEntry {
  return opencodeEntry(false, reason);
}

/** Read the opencode runtime at start. Never throws, and starts nothing. */
export function readOpencodeRuntime(options: ReadOpencodeRuntimeOptions): Promise<OpencodeRuntimeRead> {
  const unavailable = (detail: string): Promise<OpencodeRuntimeRead> =>
    Promise.resolve({ entry: unavailableOpencodeEntry(detail), detail });
  const node = (options.nodeProblem ?? nodeCanRunOpencode)();
  if (node !== null) return unavailable(node);
  const base = ensureOpencodeBase(options.base);
  if (!base.ok) return unavailable(base.refusal.detail);
  const install = (options.readInstall ?? readOpencodeInstall)(options.sdk);
  if (!install.ok) return unavailable(install.refusal.detail);
  return Promise.resolve({ entry: availableOpencodeEntry(), detail: null });
}

function bounded(text: string, length: number): string {
  return text.length <= length ? text : text.slice(0, length);
}

/**
 * How an opencode session's messages reach the wire: each event of the server's stream rides as it came,
 * naming the runtime, a streamed delta on the delta lane and every other on the update lane; the open rides
 * nowhere, since its facts ride beside it.
 */
export const OPENCODE_MESSAGE_BINDING: MessageBinding<OpencodeMessage> = {
  runtime: OPENCODE_RUNTIME,
  route(message) {
    if (message.kind !== 'event') return null;
    return {
      lane: OPENCODE_DELTA_EVENTS.includes(message.event.type) ? 'delta' : 'update',
      // The event arrived as JSON over the host process's stdout, so it is JSON.
      body: message.event as unknown as JsonObject,
    };
  },
  sourceIdOf(message) {
    return opencodeFactSourceId(message);
  },
  observe(observer, message) {
    return observer.observeOpencodeMessage(message);
  },
};

/** The registry's way of starting a session on opencode. */
export function opencodeNativeRuntime(config: OpencodeRuntimeConfig): NativeRuntime<OpencodeMessage> {
  return {
    start(request, degrade, route) {
      return startOpencodeProcess(
        request,
        config,
        degrade,
        route.endpoint,
        isOpencodeSessionGate(route.gate) ? route.gate : null,
      );
    },
    readInit(message) {
      return opencodeInitFacts(message);
    },
  };
}
