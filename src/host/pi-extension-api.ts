/**
 * The part of pi's extension API that this host's extension uses, declared here in this package's own
 * words, so the extension imports nothing from pi and pi stays the operator's install, never a
 * dependency. pi hands the API to the extension as the one argument of its default export.
 *
 * Every member below is one pi's extension API declares at the pinned release, with the members this
 * extension reads and nothing more. A member pi adds is invisible here; a member it removes is found by
 * the live probe, which loads this extension into the installed CLI.
 *
 * Types only: nothing here exists when the extension runs.
 */

/** Where a tool, a command or an extension came from, as pi records it. */
export interface PiSourceInfo {
  /** A file path, or a name such as `builtin:read` or `builtin:mcp` for what ships inside pi. */
  readonly path: string;
  /** `builtin`, `cli`, `local`, `sdk`, or a package's kind. */
  readonly source: string;
  readonly scope?: string;
  readonly origin?: string;
  readonly baseDir?: string;
}

/**
 * A tool call about to run. `input` is the object pi runs the tool with: changing it in place changes
 * what runs, and nothing checks it again after the last handler.
 */
export interface PiToolCallEvent {
  readonly type: 'tool_call';
  readonly toolName: string;
  readonly toolCallId: string;
  /** Set when another tool made this call. */
  readonly parentToolCallId?: string;
  readonly input: Record<string, unknown>;
}

/** What a `tool_call` handler answers: nothing lets the call run, a block stops it. */
export interface PiToolCallResult {
  readonly block?: boolean;
  readonly reason?: string;
}

/** A shell command sent outside the agent's tool calls: an operator's `!` line, or the RPC `bash` command. */
export interface PiUserBashEvent {
  readonly type: 'user_bash';
  readonly command: string;
  readonly cwd: string;
}

/** A session started, loaded or reloaded. */
export interface PiSessionStartEvent {
  readonly type: 'session_start';
  readonly reason: string;
}

/** What a handler is told about the session it runs in. */
export interface PiExtensionContext {
  readonly cwd: string;
  /** The running turn's abort signal; absent when no turn runs. */
  readonly signal: AbortSignal | undefined;
}

/** A tool as pi lists it. */
export interface PiToolInfo {
  readonly name: string;
  readonly sourceInfo: PiSourceInfo;
}

/** A command as pi lists it: an extension's, a prompt template, or a skill. */
export interface PiCommandInfo {
  readonly name: string;
  readonly source: string;
  readonly sourceInfo: PiSourceInfo;
}

/** An MCP server an extension registered. */
export interface PiRegisteredMcpServer {
  readonly name: string;
  readonly extensionPath: string;
}

/** How a tool server's tools reach the model: `direct` declares each to the model by name. */
export type PiMcpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden';

/** An MCP server over streamable HTTP. Header values are resolved as pi resolves config values. */
export interface PiMcpHttpServer {
  readonly type: 'http';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly exposure: PiMcpExposure;
}

/** An MCP server pi starts as a child process. Environment values are resolved as pi resolves config values. */
export interface PiMcpStdioServer {
  readonly type: 'stdio';
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly exposure: PiMcpExposure;
}

/** A command an extension registers. */
export interface PiCommandOptions {
  readonly description?: string;
  readonly handler: (args: string, ctx: unknown) => Promise<void>;
}

/** The API pi hands an extension. */
export interface PiExtensionApi {
  on(
    event: 'tool_call',
    handler: (
      event: PiToolCallEvent,
      ctx: PiExtensionContext,
    ) => Promise<PiToolCallResult | undefined> | PiToolCallResult | undefined,
  ): () => void;
  on(event: 'user_bash', handler: (event: PiUserBashEvent, ctx: PiExtensionContext) => never): () => void;
  on(
    event: 'session_start',
    handler: (event: PiSessionStartEvent, ctx: PiExtensionContext) => Promise<void>,
  ): () => void;
  registerCommand(name: string, options: PiCommandOptions): void;
  registerMcpServer(name: string, config: PiMcpHttpServer | PiMcpStdioServer): void;
  /** Valid from `session_start` on; it throws while extensions load. */
  getAllTools(): readonly PiToolInfo[];
  /** Valid from `session_start` on; it throws while extensions load. */
  getCommands(): readonly PiCommandInfo[];
  getMcpServers(): readonly PiRegisteredMcpServer[];
}
