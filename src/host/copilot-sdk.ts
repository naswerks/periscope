/**
 * The Copilot SDK seam: the one module in this package that names `@github/copilot-sdk`, and the one that
 * loads it.
 *
 * The SDK is never a dependency of this package. The operator installs it, at the pinned version, into a
 * directory of the runner's own (`PERISCOPE_COPILOT_SDK`, an `npm install --prefix` target), and a session
 * imports it from there when it opens. A missing or off-version install lists `copilot` unavailable with
 * the reason, as an off-version Codex binary is listed. The SDK carries the runtime it drives as an
 * optional platform package (a closed binary under the GitHub Copilot CLI License), and each SDK release
 * pins exactly one runtime, so the SDK's version is the runtime's.
 *
 * The rest of the adapter works through the structural interfaces below, never the SDK's own types, so no
 * declaration this package ships names a package a consumer may not have. The interfaces are held to the
 * SDK's declared types by a pin (`copilot-sdk-shape.test.ts`, over the exact development dependency).
 *
 * The runtime is started by its explicit path inside the operator's install, so the SDK never resolves
 * another one (it would otherwise read `COPILOT_CLI_PATH`, which the adapter also strips from the runtime's
 * environment). The SDK spawns it with `windowsHide` and no shell.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';

/** The SDK release this host is built and tested against. An install of any other is refused. */
export const COPILOT_SDK_PINNED_VERSION = '1.0.34';

/** The runtime that SDK release pins: its `copilotRuntime.version`, which the session reports. */
export const COPILOT_RUNTIME_PINNED_VERSION = '1.0.112';

/** The SDK's package name: the one place this package names it. */
export const COPILOT_SDK_PACKAGE = '@github/copilot-sdk';

/** A value the runtime sends or takes as JSON. */
export type CopilotJson = null | boolean | number | string | CopilotJson[] | { [key: string]: CopilotJson };

/** One session event, as the SDK delivers it: every kind carries these members beside its `data`. */
export interface CopilotEvent {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly type: string;
  /** The sub-agent the event belongs to; absent for the session's own events. */
  readonly agentId?: string;
  readonly ephemeral?: boolean;
  readonly data?: unknown;
}

/** What the pre-tool hook is given for one call. */
export interface CopilotPreToolInput {
  readonly sessionId: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly workingDirectory: string;
  readonly agentId?: string;
  readonly agentType?: string;
  readonly parentAgentId?: string;
}

/** What the pre-tool hook answers. This host only ever answers `ask`. */
export interface CopilotPreToolOutput {
  readonly permissionDecision: 'ask';
  readonly permissionDecisionReason: string;
}

/** What the session-start hook is given. */
export interface CopilotSessionStartInput {
  readonly sessionId: string;
  readonly source: 'startup' | 'resume' | 'new';
}

/** One permission request, read loosely: its `kind` decides which members it carries. */
export interface CopilotPermissionRequest {
  readonly kind: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolArgs?: unknown;
  readonly hookMessage?: string;
  readonly workingDirectory?: string;
}

/** The only answers this host gives a permission request: one call approved, or refused with words. */
export type CopilotPermissionAnswer =
  { readonly kind: 'approve-once' } | { readonly kind: 'reject'; readonly feedback?: string };

/** What the session-level token provider is asked for. */
export interface CopilotTokenRequest {
  readonly host: string;
  readonly sessionId?: string;
  readonly reason: string;
}

/** What it answers: a token, or nothing to give. */
export type CopilotTokenAnswer =
  | { readonly kind: 'token'; readonly accessToken: string; readonly expiresIn: number }
  | { readonly kind: 'cancelled' };

/** An MCP server, as a session takes it. */
export type CopilotMcpServer =
  | {
      readonly type: 'local';
      readonly command: string;
      readonly args?: string[];
      readonly env?: Record<string, string>;
      readonly workingDirectory?: string;
      readonly tools: string[];
    }
  | {
      readonly type: 'http' | 'sse';
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly tools: string[];
    };

/** A model endpoint of the operator's, as a session takes it (bring your own key). */
export interface CopilotProvider {
  readonly type: 'openai' | 'anthropic';
  readonly wireApi?: 'completions' | 'responses';
  readonly baseUrl: string;
  readonly apiKey?: string;
}

/** The members of a session's configuration this host composes, and nothing else. */
export interface CopilotSessionConfig {
  readonly workingDirectory: string;
  readonly availableTools: string[];
  readonly excludedTools: string[];
  readonly permissionMode: 'manual';
  readonly enableConfigDiscovery: false;
  readonly skipCustomInstructions: true;
  readonly enableSessionTelemetry: false;
  readonly enableSkills: boolean;
  readonly skillDirectories?: string[];
  readonly mcpServers?: Record<string, CopilotMcpServer>;
  readonly streaming: boolean;
  readonly includeSubAgentStreamingEvents: boolean;
  readonly systemMessage?: { readonly mode: 'append'; readonly content: string };
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly provider?: CopilotProvider;
  readonly gitHubTokenProvider?: (request: CopilotTokenRequest) => Promise<CopilotTokenAnswer>;
  readonly hooks: {
    readonly onPreToolUse: (input: CopilotPreToolInput) => CopilotPreToolOutput;
    readonly onSessionStart: (input: CopilotSessionStartInput) => void;
  };
  readonly onPermissionRequest: (request: CopilotPermissionRequest) => Promise<CopilotPermissionAnswer>;
  readonly onEvent: (event: CopilotEvent) => void;
}

/** The session RPC reads and writes this host uses. Each is the runtime's own, answered over the SDK's pipe. */
export interface CopilotSessionRpc {
  readonly permissions: {
    getMode(): Promise<{ readonly mode: string }>;
    setMode(params: { mode: 'manual' }): Promise<{ readonly success: boolean; readonly mode?: string }>;
    getAllowAll(): Promise<{
      readonly active: boolean;
      readonly autoApproval: boolean;
      readonly storedAutoApproval?: boolean;
      readonly runtimeOverride?: boolean;
      readonly baseline?: { readonly tools?: boolean; readonly paths?: boolean; readonly urls?: boolean };
    }>;
    readonly paths: {
      list(): Promise<{ readonly directories: string[]; readonly sessionApprovedPaths?: string[] }>;
    };
  };
  readonly mode: {
    get(): Promise<string>;
    set(params: { mode: 'interactive' | 'plan' }): Promise<unknown>;
  };
  readonly plugins: { list(): Promise<{ readonly plugins: readonly unknown[] }> };
  readonly tools: {
    execute(params: { name: string; arguments: CopilotJson; toolCallId?: string }): Promise<unknown>;
    /** Every built-in the runtime has for the session, offered or not. */
    getBuiltinDescriptors(
      params: Record<string, never>,
    ): Promise<{ readonly tools: readonly { readonly name: string }[] }>;
    /** The tools the session offers now; `tools` is null until the runtime has built its list. */
    getCurrentMetadata(): Promise<{ readonly tools: readonly { readonly name: string }[] | null }>;
    /** Has the runtime build its tool list now, before the first prompt. */
    initializeAndValidate(): Promise<unknown>;
  };
  readonly mcp: {
    listTools(params: {
      serverName: string;
    }): Promise<{ readonly tools: readonly { readonly name: string }[] }>;
  };
  readonly model: {
    setReasoningEffort(params: { reasoningEffort: string }): Promise<unknown>;
  };
}

/** A started session, as this host drives it. */
export interface CopilotSession {
  readonly sessionId: string;
  readonly permissionModeResult?: { readonly success: boolean; readonly mode?: string } | undefined;
  readonly rpc: CopilotSessionRpc;
  send(options: { prompt: string; mode: 'enqueue' }): Promise<string>;
  abort(): Promise<void>;
  setModel(model: string): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * The connection a client is built with: the runtime by path, over stdio, with the environment whole. Only
 * its kind is read here; the SDK builds the rest (`RuntimeConnection.forStdio`).
 */
export interface CopilotConnection {
  readonly kind: 'stdio';
}

/** The client options this host composes. */
export interface CopilotClientOptions {
  readonly mode: 'empty';
  readonly useLoggedInUser: false;
  readonly baseDirectory: string;
  readonly workingDirectory: string;
  readonly logLevel: 'error';
  readonly connection: CopilotConnection;
}

/** One client: one runtime process, one session. */
export interface CopilotClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
  createSession(config: CopilotSessionConfig): Promise<CopilotSession>;
  resumeSession(sessionId: string, config: CopilotSessionConfig): Promise<CopilotSession>;
  readonly rpc: {
    readonly sessions: {
      fork(params: { sessionId: string }): Promise<{ readonly sessionId: string }>;
    };
  };
}

/** The two exports this host takes from the SDK. */
export interface CopilotSdk {
  readonly CopilotClient: new (options: CopilotClientOptions) => CopilotClient;
  readonly RuntimeConnection: {
    forStdio(options: { path: string; env: Record<string, string> }): CopilotConnection;
  };
}

/** What a checked install holds. */
export interface CopilotInstall {
  /** The operator's directory, as named. */
  readonly directory: string;
  /** The SDK's ES module entry. */
  readonly entry: string;
  /** The runtime binary this host starts, by path. */
  readonly runtime: string;
  readonly sdkVersion: string;
  readonly runtimeVersion: string;
}

/** The platform word the SDK's runtime packages carry: `win32-x64`, `linux-arm64`, `linuxmusl-x64`, … */
export function copilotPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
  musl: boolean = isMusl(),
): string | null {
  if (arch !== 'x64' && arch !== 'arm64') return null;
  if (platform === 'linux') return `${musl ? 'linuxmusl' : 'linux'}-${arch}`;
  if (platform === 'darwin' || platform === 'win32') return `${platform}-${arch}`;
  return null;
}

function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined;
  return report?.header?.glibcVersionRuntime === undefined;
}

/** Read a manifest's `version` and `copilotRuntime.version`, or null when it cannot be read. */
function manifestOf(path: string): { version: unknown; runtime: unknown } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      version?: unknown;
      copilotRuntime?: { version?: unknown };
    };
    return { version: parsed.version, runtime: parsed.copilotRuntime?.version };
  } catch {
    return null;
  }
}

function nonEmptyFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

/**
 * Check the operator's install at `directory` against the pin: the SDK's manifest names the pinned SDK and
 * runtime versions, and this platform's runtime package is installed at the same version with its binary
 * and its library present. Refuses `runtime-unavailable` with what was found and what is pinned. Reads
 * files only: no process is started and nothing is fetched.
 */
export function readCopilotInstall(
  directory: string,
  platform: string | null = copilotPlatform(),
): Result<CopilotInstall> {
  const pin = `this host is pinned to ${COPILOT_SDK_PACKAGE} ${COPILOT_SDK_PINNED_VERSION} (runtime ${COPILOT_RUNTIME_PINNED_VERSION})`;
  if (!isAbsolute(directory)) {
    return refuse('runtime-unavailable', `the Copilot SDK directory ${directory} is not an absolute path`);
  }
  const root = join(directory, 'node_modules', ...COPILOT_SDK_PACKAGE.split('/'));
  const manifest = manifestOf(join(root, 'package.json'));
  if (manifest === null) {
    return refuse('runtime-unavailable', `no ${COPILOT_SDK_PACKAGE} is installed under ${directory}; ${pin}`);
  }
  if (
    manifest.version !== COPILOT_SDK_PINNED_VERSION ||
    manifest.runtime !== COPILOT_RUNTIME_PINNED_VERSION
  ) {
    return refuse(
      'runtime-unavailable',
      `${directory} holds ${COPILOT_SDK_PACKAGE} ${String(manifest.version)} (runtime ${String(manifest.runtime)}); ${pin}`,
    );
  }
  if (platform === null) {
    return refuse(
      'runtime-unavailable',
      `the Copilot runtime has no build for ${process.platform}-${process.arch}; ${pin}`,
    );
  }
  const platformRoot = join(directory, 'node_modules', '@github', `copilot-sdk-${platform}`);
  const platformManifest = manifestOf(join(platformRoot, 'package.json'));
  if (platformManifest === null || platformManifest.version !== COPILOT_SDK_PINNED_VERSION) {
    return refuse(
      'runtime-unavailable',
      `the Copilot runtime for ${platform} is not installed at ${COPILOT_SDK_PINNED_VERSION} under ${directory}; ${pin}`,
    );
  }
  const prebuilds = join(platformRoot, 'prebuilds', platform);
  const runtime = join(prebuilds, platform.startsWith('win32') ? 'copilot-runtime.exe' : 'copilot-runtime');
  if (!nonEmptyFile(runtime) || !nonEmptyFile(join(prebuilds, 'runtime.node'))) {
    return refuse('runtime-unavailable', `the Copilot runtime under ${prebuilds} is incomplete; ${pin}`);
  }
  const entry = join(root, 'dist', 'index.js');
  if (!nonEmptyFile(entry)) {
    return refuse('runtime-unavailable', `${COPILOT_SDK_PACKAGE} under ${directory} has no ${entry}; ${pin}`);
  }
  return ok({
    directory,
    entry,
    runtime,
    sdkVersion: COPILOT_SDK_PINNED_VERSION,
    runtimeVersion: COPILOT_RUNTIME_PINNED_VERSION,
  });
}

const loaded = new Map<string, Promise<Result<CopilotSdk>>>();

/**
 * Import the SDK from a checked install. The module is loaded once per entry and kept: a later session
 * reuses it. Refuses `runtime-unavailable` when the module does not load or lacks what this host calls.
 */
export function loadCopilotSdk(install: CopilotInstall): Promise<Result<CopilotSdk>> {
  const known = loaded.get(install.entry);
  if (known !== undefined) return known;
  const loading = (async (): Promise<Result<CopilotSdk>> => {
    let module: Record<string, unknown>;
    try {
      module = (await import(pathToFileURL(install.entry).href)) as Record<string, unknown>;
    } catch (error) {
      return refuse(
        'runtime-unavailable',
        `${COPILOT_SDK_PACKAGE} could not be loaded from ${install.entry}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const client = module['CopilotClient'];
    const connection = module['RuntimeConnection'] as { forStdio?: unknown } | undefined;
    if (typeof client !== 'function' || typeof connection?.forStdio !== 'function') {
      return refuse(
        'runtime-unavailable',
        `${COPILOT_SDK_PACKAGE} at ${install.entry} exports no CopilotClient or RuntimeConnection.forStdio`,
      );
    }
    return ok(module as unknown as CopilotSdk);
  })();
  loaded.set(install.entry, loading);
  return loading;
}

/**
 * The runtime process's id, or null. The SDK keeps the child it spawned in a member of its own, which this
 * host reads only to end the child's whole process tree after `stop()`; its presence is pinned on the real
 * runtime, so a release that renames it turns that pin red rather than leaving a tree behind silently.
 */
export function copilotRuntimePid(client: CopilotClient): number | null {
  const child = (client as unknown as { cliProcess?: { pid?: unknown } | null }).cliProcess;
  return typeof child?.pid === 'number' ? child.pid : null;
}

/**
 * Be told once when the runtime process exits, read from the same member as its pid. False when the member
 * is not there to watch: the session then learns of an exit only from a call that fails.
 */
export function onCopilotRuntimeExit(client: CopilotClient, listener: (detail: string) => void): boolean {
  const child = (client as unknown as { cliProcess?: { once?: unknown } | null }).cliProcess;
  if (typeof child?.once !== 'function') return false;
  (child as { once(event: 'exit', handler: (code: unknown, signal: unknown) => void): void }).once(
    'exit',
    (code, signal) => listener(typeof signal === 'string' ? `signal ${signal}` : `exit code ${String(code)}`),
  );
  return true;
}
