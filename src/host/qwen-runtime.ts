/**
 * The Qwen Code runtime as this host offers it: the read at start that decides its entry in the hello,
 * the registry's way of starting a session on it, and how its messages reach the wire.
 *
 * The read at start, bounded, and never a model call: the base home is created if absent, and the CLI's
 * `--version` is held to the pin. A CLI that is absent, does not answer or reports another version is
 * listed `available: false` with the reason. No model list is read: Qwen Code reaches a model only
 * through the endpoint a session names, so the hello lists no models of its own, and a session's models
 * are its endpoint's.
 */
import type { HostAgentEntry } from '../control/frames.js';
import { MAX_CONFIGURATION_VALUE_LENGTH } from '../control/frames.js';
import type { MessageBinding } from '../control/stream.js';
import type { NativeRuntime } from '../sessions/registry.js';
import { CONTROL_TIERS, QWEN_RUNTIME } from '../sessions/runtimes.js';
import type { RunVersion } from './codex-binary.js';
import { QWEN_PINNED_VERSION, readQwenVersion } from './qwen-binary.js';
import { qwenFactSourceId } from './qwen-facts.js';
import { isQwenSessionGate } from './qwen-gate.js';
import { ensureQwenBase } from './qwen-home.js';
import type { QwenRuntimeConfig } from './qwen-process.js';
import { qwenInitFacts, startQwenProcess } from './qwen-process.js';
import type { QwenMessage } from './qwen-wire.js';
import { QWEN_PERMISSION_MODES } from './wire-request.js';

/** The effort words Qwen Code's `set_effort` takes: the same five the controller's vocabulary holds. */
export const QWEN_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** What the read at start found. */
export interface QwenRuntimeRead {
  /** The hello's entry for Qwen Code, available or not. */
  readonly entry: HostAgentEntry;
  /** Why the entry is unavailable, in words, or null when nothing is wrong. */
  readonly detail: string | null;
}

export interface ReadQwenRuntimeOptions {
  readonly binary: string;
  readonly base: string;
  /** The environment the CLI's `--version` runs in. */
  readonly env: Readonly<Record<string, string>>;
  readonly runVersion?: RunVersion;
}

/** The entry for a Qwen Code runtime, available or not, at its tier. */
function qwenEntry(version: string, available: boolean, reason: string | null): HostAgentEntry {
  return {
    runtime: QWEN_RUNTIME,
    version,
    sdkVersion: null,
    models: [],
    vocabularies: {
      permissionModes: [...QWEN_PERMISSION_MODES],
      efforts: [...QWEN_EFFORTS],
      // Qwen Code has no thinking switch, and its effort has no off level.
      thinking: false,
    },
    controlTier: CONTROL_TIERS[QWEN_RUNTIME],
    available,
    unavailableReason: reason === null ? null : bounded(reason, MAX_CONFIGURATION_VALUE_LENGTH),
  };
}

/** The entry for a Qwen Code runtime that can run. */
export function availableQwenEntry(version: string): HostAgentEntry {
  return qwenEntry(version, true, null);
}

/** The entry for a Qwen Code runtime that cannot run now, with why. */
export function unavailableQwenEntry(version: string, reason: string): HostAgentEntry {
  return qwenEntry(version, false, reason);
}

/** Read the Qwen Code runtime at start. Never throws. */
export async function readQwenRuntime(options: ReadQwenRuntimeOptions): Promise<QwenRuntimeRead> {
  const base = ensureQwenBase(options.base);
  if (!base.ok) {
    return {
      entry: unavailableQwenEntry(QWEN_PINNED_VERSION, base.refusal.detail),
      detail: base.refusal.detail,
    };
  }
  const version = await readQwenVersion(options.binary, options.env, options.runVersion);
  if (!version.ok) {
    return {
      entry: unavailableQwenEntry(QWEN_PINNED_VERSION, version.refusal.detail),
      detail: version.refusal.detail,
    };
  }
  return { entry: availableQwenEntry(version.value), detail: null };
}

function bounded(text: string, length: number): string {
  return text.length <= length ? text : text.slice(0, length);
}

/**
 * How a Qwen Code session's messages reach the wire: each stream message rides as the CLI wrote it,
 * naming the runtime, a `stream_event` on the delta lane and every other on the update lane; each
 * control request the CLI sent rides as it arrived; the answers to the host's own requests and the
 * prompts it wrote ride nowhere, since their facts and items ride beside them.
 */
export const QWEN_MESSAGE_BINDING: MessageBinding<QwenMessage> = {
  runtime: QWEN_RUNTIME,
  route(message) {
    if (message.kind === 'message') {
      return { lane: message.message['type'] === 'stream_event' ? 'delta' : 'update', body: message.message };
    }
    if (message.kind === 'control_request') {
      return {
        lane: 'update',
        body: { type: 'control_request', request_id: message.requestId, request: message.request },
      };
    }
    return null;
  },
  sourceIdOf(message) {
    return qwenFactSourceId(message);
  },
  observe(observer, message) {
    return observer.observeQwenMessage(message);
  },
};

/** The registry's way of starting a session on Qwen Code. */
export function qwenNativeRuntime(config: QwenRuntimeConfig): NativeRuntime<QwenMessage> {
  return {
    start(request, degrade, route) {
      return startQwenProcess(
        request,
        config,
        degrade,
        route.endpoint,
        isQwenSessionGate(route.gate) ? route.gate : null,
      );
    },
    readInit(message) {
      return qwenInitFacts(message);
    },
  };
}
