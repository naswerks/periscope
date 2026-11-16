/**
 * The opencode SDK seam: the one module in this package that names `@opencode/sdk`, and the one that loads
 * it.
 *
 * The SDK is never a dependency of this package. The operator installs it, at the pinned version, into a
 * directory of the runner's own (`PERISCOPE_OPENCODE_SDK`, an `npm install --prefix` target), and a
 * session's host process imports it from there when it opens (`opencode-host.ts`). A missing or
 * off-version install lists `opencode` unavailable with the reason, as an off-version Codex binary is
 * listed. The SDK hosts opencode's whole server in the process that imports it and opens no listener, so
 * each session's host is a process of its own, started by this host with an environment it writes whole:
 * opencode reads its home directories from the environment when it loads.
 *
 * The SDK needs a Node that parses explicit resource management (`await using`), which its own tree uses
 * (`@opencode/util`): Node 24 and later. On an older Node it cannot load at all, so opencode is listed
 * unavailable there, by `nodeCanRunOpencode`, a test of the syntax itself rather than a version string.
 *
 * The rest of the adapter works through the structural interfaces below, never the SDK's own types, so no
 * declaration this package ships names a package a consumer may not have. The interfaces are held to the
 * SDK's declared types by a pin (`opencode-sdk-shape.test.ts`, over the exact development dependency).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';

/** The SDK release this host is built and tested against. An install of any other is refused. */
export const OPENCODE_SDK_PINNED_VERSION = '2.3.0';

/** The SDK's package name: the one place this package names it. */
export const OPENCODE_SDK_PACKAGE = '@opencode/sdk';

/** The packages of the SDK's own release an install must hold at the pin: the server and core it hosts. */
export const OPENCODE_RELEASE_PACKAGES: readonly string[] = [
  OPENCODE_SDK_PACKAGE,
  '@opencode/core',
  '@opencode/server',
  '@opencode/client',
];

/** One permission rule: an action and a resource, each a wildcard, and what a call matching both meets. */
export interface OpencodeRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: 'allow' | 'deny' | 'ask';
}

/** A model, as a session names it. */
export interface OpencodeModelRef {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

/** What the runtime says about one session. */
export interface OpencodeSessionInfo {
  readonly id: string;
  readonly parentID?: string;
  readonly agent?: string;
  readonly model?: OpencodeModelRef;
  readonly permissions?: readonly OpencodeRule[];
  readonly location: { readonly directory: string };
}

/** Where a read is answered from: the session's own location. */
export interface OpencodeLocation {
  readonly location?: { readonly directory?: string };
}

/** One event of the runtime's stream: a `type` and its `data`, read loosely. */
export interface OpencodeEvent {
  readonly id: string;
  readonly type: string;
  readonly data?: unknown;
}

/** The members of a host this package calls, and nothing else. */
export interface OpencodeHost {
  readonly session: {
    create(input: {
      location: { directory: string };
      permissions: readonly OpencodeRule[];
      model?: OpencodeModelRef;
      agent?: string;
    }): Promise<OpencodeSessionInfo>;
    get(input: { sessionID: string }): Promise<OpencodeSessionInfo>;
    /** Every session the server's database holds: the session's own and each subagent's. */
    list(input?: { readonly limit?: number }): Promise<{ readonly data: readonly OpencodeSessionInfo[] }>;
    prompt(input: { sessionID: string; text: string; delivery?: 'queue' | 'steer' }): Promise<unknown>;
    interrupt(input: { sessionID: string }): Promise<{ readonly interrupted: boolean }>;
    remove(input: { sessionID: string }): Promise<void>;
    fork(input: { sessionID: string }): Promise<OpencodeSessionInfo>;
    switchModel(input: { sessionID: string; model: OpencodeModelRef }): Promise<void>;
    switchAgent(input: { sessionID: string; agent: string }): Promise<void>;
    /** Sets the environment the session's commands run with, in place of the server's own. */
    environment(input: { sessionID: string; variables: Record<string, string> }): Promise<void>;
    readonly form: {
      /** Cancels a form the server is waiting on an answer to, with words for whatever asked it. */
      cancel(input: { sessionID: string; formID: string; message?: string }): Promise<void>;
    };
  };
  readonly permission: {
    reply(input: {
      sessionID: string;
      requestID: string;
      decision: 'once' | 'reject';
      message?: string;
    }): Promise<void>;
    readonly request: {
      /** Every request still waiting on an answer, whichever session raised it. */
      list(input?: OpencodeLocation): Promise<{ readonly data: readonly unknown[] }>;
    };
    readonly saved: {
      /** Every saved approval the server holds; with no project named, every project's. */
      list(input?: {
        readonly projectID?: string;
      }): Promise<readonly { readonly action: string; readonly resource: string }[]>;
    };
  };
  readonly agent: {
    list(input?: OpencodeLocation): Promise<{
      readonly data: readonly {
        readonly id: string;
        readonly mode: string;
        readonly permissions: readonly OpencodeRule[];
      }[];
    }>;
  };
  readonly plugin: {
    list(input?: OpencodeLocation): Promise<{
      readonly data: readonly {
        readonly id?: string;
        readonly source: { readonly type: string };
        readonly state: { readonly status: string };
      }[];
    }>;
  };
  readonly mcp: {
    list(input?: OpencodeLocation): Promise<{
      readonly data: readonly { readonly name: string; readonly status: unknown }[];
    }>;
  };
  readonly config: {
    get(input?: OpencodeLocation): Promise<readonly { readonly type: string; readonly path?: string }[]>;
  };
  readonly model: {
    list(input?: OpencodeLocation): Promise<{
      readonly data: readonly { readonly id: string; readonly providerID: string }[];
    }>;
  };
  readonly event: {
    /** Every event of the server's stream until `signal` aborts. */
    subscribe(options?: { readonly signal?: AbortSignal }): AsyncIterable<OpencodeEvent>;
  };
  close(): Promise<void>;
}

/** One call about to run, as the server hands it to a pre-call hook. */
export interface OpencodeExecuteBefore {
  /** The tool's name, as the server registered it. */
  readonly tool: string;
  readonly sessionID: string;
  /** The call's own id, the one its permission requests name as their source. */
  readonly id: string;
  /** The call's input, as the model sent it. */
  readonly input: unknown;
}

/** What a plugin's setup is handed, as far as this package reads it. */
export interface OpencodePluginContext {
  readonly tool: {
    /**
     * Registers a callback the server runs before every tool call it runs itself, a subagent's included. A
     * callback that rejects fails that call alone, with the rejection's words; the call's tool never runs.
     */
    hook(
      name: 'execute.before',
      callback: (event: OpencodeExecuteBefore) => Promise<void> | void,
    ): Promise<unknown>;
  };
}

/** A plugin handed to a host at its creation as an object, so it is set up before any run starts. */
export interface OpencodePlugin {
  readonly id: string;
  setup(context: OpencodePluginContext): Promise<void> | void;
}

/** The options a host is created with: where it keeps its database and the configuration it loads. */
export interface OpencodeCreateOptions {
  readonly database: { readonly path: string };
  readonly config: {
    readonly directory: string;
    readonly project: false;
    readonly claude: false;
    readonly content: string;
  };
  readonly models: { readonly fetch: false };
  readonly fs: { readonly filewatcher: false; readonly fff: false };
  /** The plugins the host is created with, beside the runtime's own: this package's pre-call gate alone. */
  readonly plugins?: readonly OpencodePlugin[];
}

/** The one export this host takes from the SDK. */
export interface OpencodeSdk {
  readonly create: (options: OpencodeCreateOptions) => Promise<OpencodeHost>;
}

/** What a checked install holds. */
export interface OpencodeInstall {
  /** The operator's directory, as named. */
  readonly directory: string;
  /** The SDK's ES module entry. */
  readonly entry: string;
  readonly sdkVersion: string;
}

/** Read a manifest's `version`, or null when it cannot be read. */
function versionOf(path: string): unknown {
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version ?? null;
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
 * The manifest of `name` as the SDK installed under `directory` resolves it: in the SDK's own `node_modules`
 * first, then beside it, as Node looks a dependency up.
 */
function manifestPath(directory: string, name: string): string {
  const beside = join(directory, 'node_modules', ...name.split('/'), 'package.json');
  if (name === OPENCODE_SDK_PACKAGE) return beside;
  const own = join(
    directory,
    'node_modules',
    ...OPENCODE_SDK_PACKAGE.split('/'),
    'node_modules',
    ...name.split('/'),
    'package.json',
  );
  return existsSync(own) ? own : beside;
}

/**
 * Check the operator's install at `directory` against the pin: the SDK and the server, core and client of its
 * release are each installed at the pinned version, where the SDK resolves them. Refuses
 * `runtime-unavailable` with what was found and what is pinned. Reads files only: no process is started and
 * nothing is fetched.
 */
export function readOpencodeInstall(directory: string): Result<OpencodeInstall> {
  const pin = `this host is pinned to ${OPENCODE_SDK_PACKAGE} ${OPENCODE_SDK_PINNED_VERSION}`;
  if (!isAbsolute(directory)) {
    return refuse('runtime-unavailable', `the opencode SDK directory ${directory} is not an absolute path`);
  }
  for (const name of OPENCODE_RELEASE_PACKAGES) {
    const version = versionOf(manifestPath(directory, name));
    if (version === null) {
      return refuse('runtime-unavailable', `no ${name} is installed under ${directory}; ${pin}`);
    }
    if (version !== OPENCODE_SDK_PINNED_VERSION) {
      const found = typeof version === 'string' ? version : JSON.stringify(version);
      return refuse('runtime-unavailable', `${directory} holds ${name} ${found}; ${pin}`);
    }
  }
  const entry = join(directory, 'node_modules', ...OPENCODE_SDK_PACKAGE.split('/'), 'dist', 'index.js');
  if (!nonEmptyFile(entry)) {
    return refuse(
      'runtime-unavailable',
      `${OPENCODE_SDK_PACKAGE} under ${directory} has no ${entry}; ${pin}`,
    );
  }
  return ok({ directory, entry, sdkVersion: OPENCODE_SDK_PINNED_VERSION });
}

/**
 * Whether this Node can load the SDK: whether it parses explicit resource management (`await using`), which
 * the SDK's own tree uses. Tested by compiling the syntax, never by reading a version: the source is parsed
 * and never run. Null when it can, else why not.
 */
export function nodeCanRunOpencode(
  compile: (source: string) => void = (source) => {
    new Script(source);
  },
): string | null {
  try {
    compile('(async () => { await using held = null; return held; });');
    return null;
  } catch {
    return (
      `this host runs Node ${process.versions.node}, which cannot parse explicit resource management ` +
      `(\`await using\`), and ${OPENCODE_SDK_PACKAGE} ${OPENCODE_SDK_PINNED_VERSION} uses it in its own ` +
      'tree; opencode needs Node 24 or later'
    );
  }
}

/**
 * Import the SDK from a checked install. Refuses `runtime-unavailable` when the module does not load or lacks
 * what this host calls. Called in a session's host process alone: the SDK reads its home directories from
 * the environment of the process that loads it.
 */
export async function loadOpencodeSdk(install: OpencodeInstall): Promise<Result<OpencodeSdk>> {
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(install.entry).href)) as Record<string, unknown>;
  } catch (error) {
    return refuse(
      'runtime-unavailable',
      `${OPENCODE_SDK_PACKAGE} could not be loaded from ${install.entry}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const namespace = module['OpenCode'] as { create?: unknown } | undefined;
  if (typeof namespace?.create !== 'function') {
    return refuse(
      'runtime-unavailable',
      `${OPENCODE_SDK_PACKAGE} at ${install.entry} exports no OpenCode.create`,
    );
  }
  return ok(namespace as unknown as OpencodeSdk);
}
