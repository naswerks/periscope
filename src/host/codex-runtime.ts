/**
 * The Codex runtime as this host offers it: the read at start that decides its entry in the hello,
 * the registry's way of starting a session on it, and how its messages reach the wire.
 *
 * The read at start, bounded, and never a model call:
 * - the home is created if absent;
 * - the binary's `--version` is held to the pin;
 * - a short-lived app-server answers `initialize` (its version and its home held to the configuration),
 *   `account/read` (a home with no sign-in makes the runtime unavailable, naming the sign-in step) and
 *   `model/list` (the models a session may name), and is closed.
 * A runtime that fails any of the first three is listed `available: false` with the reason; one whose
 * catalog could not be read is listed with no models and the reason named once, and a session naming
 * no model still runs on it.
 */
import type { HostAgentEntry, HostModel, JsonObject } from '../control/frames.js';
import { MAX_AGENT_MODELS, MAX_CONFIGURATION_VALUE_LENGTH } from '../control/frames.js';
import type { NativeRuntime } from '../sessions/registry.js';
import { CODEX_RUNTIME, CONTROL_TIERS } from '../sessions/runtimes.js';
import type { MessageBinding } from '../control/stream.js';
import type { RunVersion } from './codex-binary.js';
import {
  CODEX_PINNED_VERSION,
  codexCommand,
  codexVersionProblem,
  readCodexVersion,
  runVersion,
  userAgentVersion,
} from './codex-binary.js';
import { codexFactSourceId } from './codex-facts.js';
import { codexAppServerArgs, codexSessionFlags, ensureCodexHome, samePath } from './codex-home.js';
import type { CodexMessage } from './codex-wire.js';
import {
  AccountReadResponse,
  CodexModel,
  InitializeResponse,
  ModelListResponse,
  parsed,
} from './codex-wire.js';
import type { CodexRuntimeConfig } from './codex-process.js';
import { codexInitFacts, startCodexProcess } from './codex-process.js';
import { isCodexSessionGate } from './codex-gate.js';
import type { CodexHookReport } from './codex-hook.js';
import { codexHomePathProblem, installCodexHook, probeCodexHook } from './codex-hook.js';
import { ok, refuse } from '../core/result.js';
import type { ControlTier } from '../state/model.js';
import type { SpawnChild, StdioRpcPeer } from './stdio-rpc.js';
import { startStdioRpc } from './stdio-rpc.js';
import { CODEX_PERMISSION_MODES } from './wire-request.js';

/** How long the whole read at start may take. */
export const CODEX_CATALOG_TIMEOUT_MS = 20_000;
/** The most effort words an entry lists, and the longest each may be: the hello's vocabulary bounds. */
const MAX_VOCABULARY_WORDS = 16;
const MAX_VOCABULARY_WORD_LENGTH = 32;
/** The deltas that ride the delta lane: the completed item restates each. */
const DELTA_METHODS: ReadonlySet<string> = new Set([
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
]);
/** The effort word that turns reasoning off: a model that lists it honours thinking off. */
const THINKING_OFF_EFFORT = 'none';

/** What the read at start found. */
export interface CodexRuntimeRead {
  /** The hello's entry for Codex, available or not. */
  readonly entry: HostAgentEntry;
  /** Why the entry is unavailable or has no models, in words, or null when nothing is wrong. */
  readonly detail: string | null;
  /** Periscope's hook, written and probed, when the read was asked to install it. */
  readonly hook?: CodexHookReport;
}

export interface ReadCodexRuntimeOptions {
  readonly binary: string;
  readonly home: string;
  /** The environment the binary runs in; `CODEX_HOME` is set to `home` over it. */
  readonly env: Readonly<Record<string, string>>;
  readonly clientVersion: string;
  readonly timeoutMs?: number;
  readonly runVersion?: RunVersion;
  readonly spawn?: SpawnChild;
  readonly killTree?: (pid: number) => Promise<void>;
  readonly closeGraceMs?: number;
  /**
   * Write periscope's hook into the home and probe it through the shell Codex will run it under. Off
   * unless asked: the daemon asks, once per start.
   */
  readonly installHook?: boolean;
}

/**
 * The entry for a Codex runtime that cannot run now. `version` is the one the binary reported, or the
 * pinned one when no binary answered; the reason says which.
 */
export function unavailableCodexEntry(version: string, reason: string): HostAgentEntry {
  return {
    runtime: CODEX_RUNTIME,
    version,
    sdkVersion: null,
    models: [],
    vocabularies: { permissionModes: [...CODEX_PERMISSION_MODES], efforts: [], thinking: false },
    controlTier: CONTROL_TIERS[CODEX_RUNTIME],
    available: false,
    unavailableReason: bounded(reason, MAX_CONFIGURATION_VALUE_LENGTH),
  };
}

/** The entry for a Codex runtime that can run, offering `models`, at `controlTier`. */
export function availableCodexEntry(
  version: string,
  models: readonly HostModel[],
  controlTier: ControlTier = CONTROL_TIERS[CODEX_RUNTIME],
): HostAgentEntry {
  const efforts = [...new Set(models.flatMap((model) => model.supportedEffortLevels))].slice(
    0,
    MAX_VOCABULARY_WORDS,
  );
  return {
    runtime: CODEX_RUNTIME,
    version,
    sdkVersion: null,
    models: [...models],
    vocabularies: {
      permissionModes: [...CODEX_PERMISSION_MODES],
      efforts,
      // Codex has no thinking switch of its own: off is the effort `none`, honoured only by a model
      // that lists it. Reported from the catalog, so no catalog is no thinking control.
      thinking: models.some((model) => model.supportedEffortLevels.includes(THINKING_OFF_EFFORT)),
    },
    controlTier,
    available: true,
    unavailableReason: null,
  };
}

/** A Codex model as the hello carries one; the hello's bounds applied, nothing invented. */
export function codexHostModel(model: {
  id: string;
  displayName: string;
  description?: string | null | undefined;
  supportedReasoningEfforts?: readonly { reasoningEffort: string }[] | undefined;
}): HostModel {
  return {
    value: bounded(model.id, 200),
    resolvedModel: null,
    displayName: bounded(model.displayName, 200),
    description:
      model.description === undefined || model.description === null
        ? null
        : bounded(model.description, MAX_CONFIGURATION_VALUE_LENGTH),
    supportedEffortLevels: (model.supportedReasoningEfforts ?? [])
      .map((effort) => effort.reasoningEffort)
      .filter((effort) => effort !== '' && effort.length <= MAX_VOCABULARY_WORD_LENGTH)
      .slice(0, MAX_VOCABULARY_WORDS),
    supportsFastMode: null,
    supportsAutoMode: null,
    supportsAdaptiveThinking: null,
  };
}

/** Read the Codex runtime at start. Never throws, and settles within the bound. */
export async function readCodexRuntime(options: ReadCodexRuntimeOptions): Promise<CodexRuntimeRead> {
  const timeoutMs = options.timeoutMs ?? CODEX_CATALOG_TIMEOUT_MS;
  const started: { peer: StdioRpcPeer | null } = { peer: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<CodexRuntimeRead>((resolve) => {
    timer = setTimeout(() => {
      // The child is ended with the read, so nothing the read started outlives its bound.
      void started.peer?.close();
      const reason = `the Codex runtime did not answer its start-up read within ${timeoutMs} ms`;
      resolve({ entry: unavailableCodexEntry(CODEX_PINNED_VERSION, reason), detail: reason });
    }, timeoutMs);
  });
  try {
    return await Promise.race([readOnce(options, started), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function readOnce(
  options: ReadCodexRuntimeOptions,
  started: { peer: StdioRpcPeer | null },
): Promise<CodexRuntimeRead> {
  // A home Codex cannot run periscope's hook from makes Codex unavailable here, never the host's start.
  const pathProblem = codexHomePathProblem(options.home);
  if (pathProblem !== null) return unavailable(CODEX_PINNED_VERSION, pathProblem);
  const home = ensureCodexHome(options.home);
  if (!home.ok) return unavailable(CODEX_PINNED_VERSION, home.refusal.detail);
  const env = { ...options.env, CODEX_HOME: options.home };
  let hook: CodexHookReport | undefined;
  if (options.installHook === true) {
    const installed = installCodexHook(options.home);
    hook = {
      installed: installed.ok ? ok(undefined) : installed,
      probed: installed.ok
        ? await probeCodexHook(installed.value, { env, version: options.clientVersion })
        : refuse('codex-hook-not-active', 'the hook was not written, so it was not probed'),
    };
  }
  const read = await readServer(options, env, started);
  return hook === undefined || !read.entry.available ? read : { ...read, hook };
}

/** The read over the app-server itself: its version, its sign-in, its catalog and, on Windows, its sandbox. */
async function readServer(
  options: ReadCodexRuntimeOptions,
  env: Readonly<Record<string, string>>,
  started: { peer: StdioRpcPeer | null },
): Promise<CodexRuntimeRead> {
  const version = await readCodexVersion(options.binary, env, options.runVersion ?? runVersion);
  if (!version.ok) return unavailable(CODEX_PINNED_VERSION, version.refusal.detail);

  const command = codexCommand(
    options.binary,
    codexAppServerArgs(codexSessionFlags(CODEX_PERMISSION_MODES[0])),
  );
  const peerStarted = startStdioRpc({
    command: command.command,
    args: command.args,
    cwd: options.home,
    env,
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.killTree === undefined ? {} : { killTree: options.killTree }),
    ...(options.closeGraceMs === undefined ? {} : { closeGraceMs: options.closeGraceMs }),
  });
  if (!peerStarted.ok) return unavailable(version.value, peerStarted.refusal.detail);
  const peer = peerStarted.value;
  started.peer = peer;
  try {
    const initialized = await peer.request(
      'initialize',
      {
        clientInfo: { name: 'periscope', title: null, version: options.clientVersion },
        capabilities: { experimentalApi: false },
      },
      CODEX_CATALOG_TIMEOUT_MS,
    );
    if (!initialized.ok)
      return unavailable(version.value, `the Codex app-server did not start: ${initialized.refusal.detail}`);
    const answer = parsed(InitializeResponse, initialized.value);
    if (answer === null)
      return unavailable(version.value, 'the Codex app-server answered initialize with no userAgent');
    const served = codexVersionProblem('the Codex app-server', userAgentVersion(answer.userAgent));
    if (served !== null) return unavailable(version.value, served);
    if (!samePath(answer.codexHome, options.home)) {
      return unavailable(
        version.value,
        `the Codex app-server runs from home ${answer.codexHome}, not the configured ${options.home}`,
      );
    }
    peer.notify('initialized', {});

    const account = await peer.request('account/read', {}, CODEX_CATALOG_TIMEOUT_MS);
    const signedIn = account.ok ? parsed(AccountReadResponse, account.value) : null;
    if (signedIn === null) {
      return unavailable(version.value, `the Codex home ${options.home} could not report its sign-in`);
    }
    if (signedIn.account === null && signedIn.requiresOpenaiAuth) {
      return unavailable(
        version.value,
        `the Codex home ${options.home} has no sign-in: run codex login with CODEX_HOME set to it`,
      );
    }

    const models: HostModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_AGENT_MODELS; page += 1) {
      const listed = await peer.request(
        'model/list',
        cursor === null ? {} : { cursor },
        CODEX_CATALOG_TIMEOUT_MS,
      );
      const catalog = listed.ok ? parsed(ModelListResponse, listed.value) : null;
      if (catalog === null) {
        const why = listed.ok ? 'an answer of another shape' : listed.refusal.detail;
        return {
          entry: availableCodexEntry(version.value, []),
          detail: `the Codex model catalog could not be read: ${why}`,
        };
      }
      for (const entry of catalog.data) {
        const model = parsed(CodexModel, entry as JsonObject);
        if (model !== null && model.hidden !== true && models.length < MAX_AGENT_MODELS)
          models.push(codexHostModel(model));
      }
      cursor = catalog.nextCursor ?? null;
      if (cursor === null) break;
    }
    return { entry: availableCodexEntry(version.value, models, await hostCodexTier(peer)), detail: null };
  } finally {
    await peer.close();
  }
}

/**
 * The tier the hello states for Codex on this host: its level, with `gate-sandbox-absent` where Windows
 * reports no sandbox ready, which holds for every session here whatever its mode.
 */
async function hostCodexTier(peer: StdioRpcPeer): Promise<ControlTier> {
  const tier = CONTROL_TIERS[CODEX_RUNTIME];
  if (process.platform !== 'win32') return tier;
  const readiness = await peer.request('windowsSandbox/readiness', null, CODEX_CATALOG_TIMEOUT_MS);
  const answer =
    readiness.ok && typeof readiness.value === 'object' && readiness.value !== null ? readiness.value : {};
  const status = (answer as { status?: unknown }).status;
  return status === 'ready' ? tier : { level: tier.level, degrades: ['gate-sandbox-absent'] };
}

function unavailable(version: string, reason: string): CodexRuntimeRead {
  return { entry: unavailableCodexEntry(version, reason), detail: reason };
}

function bounded(text: string, length: number): string {
  return text.length <= length ? text : text.slice(0, length);
}

/**
 * How a Codex session's messages reach the wire: each notification and each request from the server
 * rides as the native message it was, naming the runtime; the three content deltas ride the delta
 * lane; the answers to the adapter's own requests ride nowhere, since their facts ride beside them.
 */
export const CODEX_MESSAGE_BINDING: MessageBinding<CodexMessage> = {
  runtime: CODEX_RUNTIME,
  route(message) {
    if (message.kind === 'answer') return null;
    if (message.kind === 'notification') {
      return {
        lane: DELTA_METHODS.has(message.method) ? 'delta' : 'update',
        body: { method: message.method, params: message.params },
      };
    }
    return { lane: 'update', body: { id: message.id, method: message.method, params: message.params } };
  },
  sourceIdOf(message, fact) {
    return codexFactSourceId(message, fact);
  },
  observe(observer, message) {
    return observer.observeCodexMessage(message);
  },
};

/** The registry's way of starting a session on Codex. */
export function codexNativeRuntime(config: CodexRuntimeConfig): NativeRuntime<CodexMessage> {
  return {
    start(request, degrade, route) {
      return startCodexProcess(
        request,
        config,
        degrade,
        route.endpoint,
        isCodexSessionGate(route.gate) ? route.gate : null,
      );
    },
    readInit(message) {
      return codexInitFacts(message);
    },
  };
}
