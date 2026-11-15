/**
 * The Copilot runtime as this host offers it: the read at start that decides its entry in the hello, the
 * registry's way of starting a session on it, and how its messages reach the wire.
 *
 * The read at start reads files only: the base home is created if absent, and the operator's SDK install is
 * held to the pin (`readCopilotInstall`: the SDK's version, the runtime version it pins, and this platform's
 * runtime present). No runtime is started, no model is called and nothing is fetched. An install that is
 * absent, off the pin or incomplete is listed `available: false` with the reason. No model list is read:
 * Copilot lists its models only once signed in, so the hello lists none, and a session names its model, or
 * its endpoint's.
 */
import type { HostAgentEntry, JsonObject } from '../control/frames.js';
import { MAX_CONFIGURATION_VALUE_LENGTH } from '../control/frames.js';
import type { MessageBinding } from '../control/stream.js';
import type { Result } from '../core/result.js';
import type { NativeRuntime } from '../sessions/registry.js';
import { CONTROL_TIERS, COPILOT_RUNTIME } from '../sessions/runtimes.js';
import { copilotFactSourceId } from './copilot-facts.js';
import { isCopilotSessionGate } from './copilot-gate.js';
import { ensureCopilotBase } from './copilot-home.js';
import type { CopilotRuntimeConfig } from './copilot-process.js';
import {
  COPILOT_EFFORTS,
  COPILOT_PERMISSION_MODES,
  copilotInitFacts,
  startCopilotProcess,
} from './copilot-process.js';
import type { CopilotInstall } from './copilot-sdk.js';
import {
  COPILOT_RUNTIME_PINNED_VERSION,
  COPILOT_SDK_PINNED_VERSION,
  readCopilotInstall,
} from './copilot-sdk.js';
import type { CopilotMessage } from './copilot-wire.js';
import { COPILOT_DELTA_EVENTS } from './copilot-wire.js';

/** What the read at start found. */
export interface CopilotRuntimeRead {
  /** The hello's entry for Copilot, available or not. */
  readonly entry: HostAgentEntry;
  /** Why the entry is unavailable, in words, or null when nothing is wrong. */
  readonly detail: string | null;
}

export interface ReadCopilotRuntimeOptions {
  /** `PERISCOPE_COPILOT_SDK`. */
  readonly sdk: string;
  /** `PERISCOPE_COPILOT_HOME`. */
  readonly base: string;
  readonly readInstall?: (directory: string) => Result<CopilotInstall>;
}

/** The entry for a Copilot runtime, available or not, at its tier. */
function copilotEntry(available: boolean, reason: string | null): HostAgentEntry {
  return {
    runtime: COPILOT_RUNTIME,
    version: COPILOT_RUNTIME_PINNED_VERSION,
    sdkVersion: COPILOT_SDK_PINNED_VERSION,
    models: [],
    vocabularies: {
      permissionModes: [...COPILOT_PERMISSION_MODES],
      efforts: [...COPILOT_EFFORTS],
      // Copilot has no thinking switch; its reasoning is set by the effort.
      thinking: false,
    },
    controlTier: CONTROL_TIERS[COPILOT_RUNTIME],
    available,
    unavailableReason: reason === null ? null : bounded(reason, MAX_CONFIGURATION_VALUE_LENGTH),
  };
}

/** The entry for a Copilot runtime that can run. */
export function availableCopilotEntry(): HostAgentEntry {
  return copilotEntry(true, null);
}

/** The entry for a Copilot runtime that cannot run now, with why. */
export function unavailableCopilotEntry(reason: string): HostAgentEntry {
  return copilotEntry(false, reason);
}

/** Read the Copilot runtime at start. Never throws, and starts nothing. */
export function readCopilotRuntime(options: ReadCopilotRuntimeOptions): Promise<CopilotRuntimeRead> {
  const base = ensureCopilotBase(options.base);
  if (!base.ok) {
    return Promise.resolve({
      entry: unavailableCopilotEntry(base.refusal.detail),
      detail: base.refusal.detail,
    });
  }
  const install = (options.readInstall ?? readCopilotInstall)(options.sdk);
  if (!install.ok) {
    return Promise.resolve({
      entry: unavailableCopilotEntry(install.refusal.detail),
      detail: install.refusal.detail,
    });
  }
  return Promise.resolve({ entry: availableCopilotEntry(), detail: null });
}

function bounded(text: string, length: number): string {
  return text.length <= length ? text : text.slice(0, length);
}

/**
 * How a Copilot session's messages reach the wire: each session event rides as the runtime sent it, naming
 * the runtime, a streamed delta on the delta lane and every other on the update lane; the open rides
 * nowhere, since its facts ride beside it.
 */
export const COPILOT_MESSAGE_BINDING: MessageBinding<CopilotMessage> = {
  runtime: COPILOT_RUNTIME,
  route(message) {
    if (message.kind !== 'event') return null;
    return {
      lane: COPILOT_DELTA_EVENTS.includes(message.event.type) ? 'delta' : 'update',
      // The event arrived as JSON over the SDK's pipe, so it is JSON.
      body: message.event as unknown as JsonObject,
    };
  },
  sourceIdOf(message) {
    return copilotFactSourceId(message);
  },
  observe(observer, message) {
    return observer.observeCopilotMessage(message);
  },
};

/** The registry's way of starting a session on Copilot. */
export function copilotNativeRuntime(config: CopilotRuntimeConfig): NativeRuntime<CopilotMessage> {
  return {
    start(request, degrade, route) {
      return startCopilotProcess(
        request,
        config,
        degrade,
        route.endpoint,
        isCopilotSessionGate(route.gate) ? route.gate : null,
        route.writeRoots ?? [],
      );
    },
    readInit(message) {
      return copilotInitFacts(message);
    },
  };
}
