/**
 * An in-process stand-in for `@github/copilot-sdk` and the runtime it drives, for the Copilot adapter's
 * tests. It implements the structural interfaces `copilot-sdk.ts` declares, never the SDK's own types, and
 * holds to what the pinned runtime was measured doing where the adapter's guarantees rest on it:
 * - A call, a model's or one `tools.execute` runs, fires the session's pre-tool hook first. An `ask`
 *   answer raises a `hook` permission request, which the session's handler answers; any other answer, or
 *   none, lets the runtime's own flow decide, which raises a request of the tool's own kind (`read`,
 *   `write`, `shell`) instead.
 * - A call's start is sent before its hook fires and before its request is answered, as the runtime sends
 *   it; an approved call then completes, and a refused one completes, failed, with the handler's words.
 * - `session.start` is sent during `createSession`, before it resolves; `session.idle` ends each run.
 * - The posture reads answer what the options say, `manual` and `interactive` by default.
 * - A client answers its hook discovery and its read of the managed settings with no session: no hook and
 *   no managed setting by default, as the pinned runtime answers on a machine with neither.
 * Every call the adapter makes is recorded, so a test reads back what was asked.
 */
import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotConnection,
  CopilotDiscoveredHook,
  CopilotEvent,
  CopilotPermissionAnswer,
  CopilotPreToolOutput,
  CopilotSdk,
  CopilotSession,
  CopilotSessionConfig,
  CopilotSessionRpc,
} from '../host/copilot-sdk.js';

/** One call a run makes. */
export interface FakeCopilotCall {
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
  /** The call's id; one is minted when absent. */
  readonly toolCallId?: string;
  /** The text an approved call's result carries. */
  readonly output?: string;
  /** The spawning call, for a sub-agent's call. */
  readonly parentToolCallId?: string;
}

export interface FakeCopilotOptions {
  readonly sessionId?: string;
  readonly selectedModel?: string;
  /** The calls a run makes, by its prompt. */
  readonly calls?: (prompt: string) => readonly FakeCopilotCall[];
  /** The answer's text. */
  readonly answer?: string;
  /** What the hook's answer is read as: the default reads it; `skip` never calls the hook. */
  readonly hook?: 'read' | 'skip';
  /** The kind of request the runtime's own flow raises when the hook does not ask. */
  readonly ownFlowKind?: string;
  /** `tools.execute` runs the tool whatever the request's answer was. */
  readonly executeIgnoresAnswer?: boolean;
  readonly permissionMode?: string;
  readonly permissionModeResult?: { readonly success: boolean; readonly mode?: string } | null;
  readonly agentMode?: string;
  readonly allowAll?: Partial<Awaited<ReturnType<CopilotSessionRpc['permissions']['getAllowAll']>>>;
  readonly directories?: readonly string[];
  readonly sessionApprovedPaths?: readonly string[];
  readonly plugins?: readonly unknown[];
  /** The tools the session offers. Null until built, when `lazyTools` is set. */
  readonly offeredTools?: readonly string[];
  /** The offered tools an attached server brings: `{server}-{tool}` for each, listed beside the built-ins. */
  readonly offeredServerTools?: Readonly<Record<string, readonly string[]>>;
  readonly lazyTools?: boolean;
  /** Each attached server's tools, by name. */
  readonly serverTools?: Readonly<Record<string, readonly string[]>>;
  /** Each run fails before the runtime takes its prompt, as one with no sign-in does: no `user.message`. */
  readonly dropPrompt?: { readonly errorType: string; readonly message: string };
  /** The run fails with this `session.error` before it idles. */
  readonly runError?: { readonly errorType: string; readonly message: string };
  /** `createSession` rejects with this. */
  readonly createFailure?: string;
  /** `createSession` never settles. */
  readonly createHangs?: boolean;
  /** The runtime process's id, as the SDK's private member holds it; null for none. */
  readonly pid?: number | null;
  /** A call the turn still makes while it is being aborted, through the hook and the request as any other. */
  readonly callDuringAbort?: FakeCopilotCall;
  /** `abort` rejects with this: the turn would not end. */
  readonly abortFailure?: string;
  /** A sub-agent's own start, sent after the session's while it is created: the model it names. */
  readonly subAgentStartModel?: string;
  /** The hook rows the runtime's own discovery lists. */
  readonly discoveredHooks?: readonly unknown[];
  /** The sources the runtime's own discovery says it could not load. */
  readonly discoveryErrors?: readonly string[];
  /** The runtime's hook discovery rejects with this. */
  readonly discoveryFailure?: string;
  /** What the runtime's read of the machine's managed settings answers. */
  readonly managedSettings?: { readonly settingsJson?: unknown; readonly errorMessage?: string };
}

/** What the fake recorded. */
export interface FakeCopilotRecord {
  readonly clients: CopilotClientOptions[];
  readonly connections: { path: string; env: Record<string, string> }[];
  readonly configs: CopilotSessionConfig[];
  readonly resumed: string[];
  readonly forked: string[];
  readonly prompts: string[];
  readonly modes: string[];
  readonly models: string[];
  readonly efforts: string[];
  readonly executed: { name: string; toolCallId: string | undefined }[];
  readonly answers: { toolCallId: string; kind: string; answer: CopilotPermissionAnswer }[];
  readonly hookAnswers: { toolCallId: string; answer: CopilotPreToolOutput | undefined }[];
  readonly lifecycle: string[];
  /** Each server whose tool list a session was asked for. */
  readonly listedServers: string[];
  /** Each hook discovery asked of a client, by its parameters. */
  readonly discoveries: { excludeHostHooks?: boolean }[];
  /** Exit the runtime process, as if it died. */
  exit(code: number): void;
  /** Have the runtime process write to its standard error. */
  writeStderr(text: string): void;
  /** Send one event to the live session, as the runtime would. */
  emit(type: string, data: Record<string, unknown>, envelope?: Partial<CopilotEvent>): void;
}

/** A fake SDK and what it records. */
export function fakeCopilot(options: FakeCopilotOptions = {}): {
  sdk: CopilotSdk;
  record: FakeCopilotRecord;
} {
  const exitListeners: ((code: number) => void)[] = [];
  const stderrReaders: ((chunk: unknown) => void)[] = [];
  let live: { config: CopilotSessionConfig; id: string } | null = null;
  let events = 0;
  let calls = 0;

  const emitTo = (
    config: CopilotSessionConfig,
    type: string,
    data: Record<string, unknown>,
    envelope: Partial<CopilotEvent> = {},
  ): void => {
    events += 1;
    config.onEvent({
      id: `event-${events}`,
      parentId: null,
      timestamp: '2026-11-15T00:00:00.000Z',
      type,
      data,
      ...envelope,
    });
  };

  const record: FakeCopilotRecord = {
    clients: [],
    connections: [],
    configs: [],
    resumed: [],
    forked: [],
    prompts: [],
    modes: [],
    models: [],
    efforts: [],
    executed: [],
    answers: [],
    hookAnswers: [],
    lifecycle: [],
    listedServers: [],
    discoveries: [],
    exit(code) {
      for (const listener of exitListeners.splice(0)) listener(code);
    },
    writeStderr(text) {
      for (const reader of stderrReaders) reader(Buffer.from(text, 'utf8'));
    },
    emit(type, data, envelope) {
      if (live !== null) emitTo(live.config, type, data, envelope);
    },
  };

  let agentMode = options.agentMode ?? 'interactive';

  /** One call through the hook and the request, as the runtime runs it. Resolves whether it ran. */
  const runCall = async (
    config: CopilotSessionConfig,
    sessionId: string,
    call: FakeCopilotCall,
    ignoreAnswer: boolean,
  ): Promise<{ ran: boolean; answer: CopilotPermissionAnswer | null }> => {
    calls += 1;
    const toolCallId = call.toolCallId ?? `call-${calls}`;
    const envelope =
      call.parentToolCallId === undefined ? {} : { agentId: `agent-of-${call.parentToolCallId}` };
    const parent = call.parentToolCallId === undefined ? {} : { parentToolCallId: call.parentToolCallId };
    emitTo(
      config,
      'tool.execution_start',
      { toolCallId, toolName: call.toolName, arguments: call.toolArgs, ...parent },
      envelope,
    );
    let hookAnswer: CopilotPreToolOutput | undefined;
    if (options.hook !== 'skip') {
      hookAnswer = config.hooks.onPreToolUse({
        sessionId,
        toolCallId,
        toolName: call.toolName,
        toolArgs: call.toolArgs,
        workingDirectory: config.workingDirectory,
      });
      record.hookAnswers.push({ toolCallId, answer: hookAnswer });
    }
    const asked = (hookAnswer as { permissionDecision?: unknown } | undefined)?.permissionDecision === 'ask';
    const kind = asked ? 'hook' : (options.ownFlowKind ?? 'read');
    const request = {
      kind,
      toolCallId,
      toolName: call.toolName,
      toolArgs: call.toolArgs,
      ...(asked ? { hookMessage: hookAnswer?.permissionDecisionReason ?? '' } : {}),
      workingDirectory: config.workingDirectory,
    };
    emitTo(
      config,
      'permission.requested',
      { requestId: `request-${toolCallId}`, permissionRequest: request },
      envelope,
    );
    const answer = await config.onPermissionRequest(request);
    record.answers.push({ toolCallId, kind, answer });
    emitTo(
      config,
      'permission.completed',
      { requestId: `request-${toolCallId}`, toolCallId, result: answer },
      envelope,
    );
    const ran = answer.kind === 'approve-once' || ignoreAnswer;
    emitTo(
      config,
      'tool.execution_complete',
      ran
        ? { toolCallId, success: true, result: { content: call.output ?? 'done' }, ...parent }
        : {
            toolCallId,
            success: false,
            error: { message: answer.kind === 'reject' ? (answer.feedback ?? 'refused') : 'refused' },
            ...parent,
          },
      envelope,
    );
    return { ran, answer };
  };

  const sessionOf = (config: CopilotSessionConfig, sessionId: string): CopilotSession => {
    let toolsBuilt = false;
    const rpc: CopilotSessionRpc = {
      permissions: {
        getMode: () => Promise.resolve({ mode: options.permissionMode ?? 'manual' }),
        setMode: (params) => Promise.resolve({ success: true, mode: params.mode }),
        getAllowAll: () =>
          Promise.resolve({
            active: false,
            autoApproval: false,
            storedAutoApproval: false,
            runtimeOverride: false,
            baseline: { tools: false, paths: false, urls: false },
            ...options.allowAll,
          }),
        paths: {
          list: () =>
            Promise.resolve({
              directories: [...(options.directories ?? [config.workingDirectory])],
              sessionApprovedPaths: [...(options.sessionApprovedPaths ?? [])],
            }),
        },
      },
      mode: {
        get: () => Promise.resolve(agentMode),
        set: (params) => {
          record.modes.push(params.mode);
          agentMode = params.mode;
          emitTo(config, 'session.mode_changed', { newMode: params.mode, previousMode: 'interactive' });
          return Promise.resolve({ modeApplied: true });
        },
      },
      plugins: { list: () => Promise.resolve({ plugins: [...(options.plugins ?? [])] }) },
      tools: {
        async execute(params) {
          record.executed.push({ name: params.name, toolCallId: params.toolCallId });
          const done = await runCall(
            config,
            sessionId,
            {
              toolName: params.name,
              toolArgs: (params.arguments ?? {}) as Record<string, unknown>,
              ...(params.toolCallId === undefined ? {} : { toolCallId: params.toolCallId }),
            },
            options.executeIgnoresAnswer === true,
          );
          return { resultType: done.ran ? 'success' : 'denied' };
        },
        getBuiltinDescriptors: () => Promise.resolve({ tools: [] }),
        getCurrentMetadata: () =>
          Promise.resolve({
            tools:
              options.lazyTools === true && !toolsBuilt
                ? null
                : [
                    ...(options.offeredTools ?? ['powershell', 'view', 'create', 'edit', 'grep', 'glob']).map(
                      (name) => ({ name }),
                    ),
                    ...Object.entries(options.offeredServerTools ?? {}).flatMap(([server, tools]) =>
                      tools.map((tool) => ({
                        name: `${server}-${tool}`,
                        mcpServerName: server,
                        mcpToolName: tool,
                      })),
                    ),
                  ],
          }),
        initializeAndValidate: () => {
          toolsBuilt = true;
          return Promise.resolve({});
        },
      },
      mcp: {
        listTools: (params) => {
          record.listedServers.push(params.serverName);
          return Promise.resolve({
            tools: (options.serverTools?.[params.serverName] ?? []).map((name) => ({ name })),
          });
        },
      },
      model: {
        setReasoningEffort: (params) => {
          record.efforts.push(params.reasoningEffort);
          return Promise.resolve({});
        },
      },
      cancelAllBackgroundAgents: () => {
        record.lifecycle.push('cancelAllBackgroundAgents');
        return Promise.resolve({ cancelledCount: 0 });
      },
    };
    return {
      sessionId,
      permissionModeResult:
        options.permissionModeResult === undefined
          ? { success: true, mode: 'manual' }
          : (options.permissionModeResult ?? undefined),
      rpc,
      async send(message) {
        record.prompts.push(message.prompt);
        await Promise.resolve();
        void (async () => {
          if (options.dropPrompt !== undefined) {
            emitTo(config, 'session.error', { ...options.dropPrompt });
            emitTo(config, 'session.idle', {});
            return;
          }
          emitTo(config, 'user.message', { content: message.prompt });
          for (const call of options.calls?.(message.prompt) ?? [])
            await runCall(config, sessionId, call, false);
          if (options.runError !== undefined) emitTo(config, 'session.error', { ...options.runError });
          else {
            emitTo(config, 'assistant.message', {
              messageId: 'message-1',
              content: options.answer ?? 'done',
            });
            emitTo(config, 'assistant.usage', {
              model: options.selectedModel ?? 'fake-model',
              inputTokens: 120,
              outputTokens: 7,
              cacheReadTokens: 20,
            });
          }
          emitTo(config, 'session.idle', {});
        })();
        return 'message-1';
      },
      async abort() {
        record.lifecycle.push('abort');
        if (options.abortFailure !== undefined) throw new Error(options.abortFailure);
        if (options.callDuringAbort !== undefined) {
          await runCall(config, sessionId, options.callDuringAbort, false);
        }
      },
      setModel(model) {
        record.models.push(model);
        return Promise.resolve();
      },
      disconnect() {
        record.lifecycle.push('disconnect');
        live = null;
        return Promise.resolve();
      },
    };
  };

  class FakeClient implements CopilotClient {
    readonly cliProcess: {
      pid: number;
      /** Null while the process runs, as a child process's is; its code once it has exited. */
      exitCode: number | null;
      once(event: 'exit', handler: (code: unknown, signal: unknown) => void): void;
      /** The process's standard error, which hands each reader the bytes written, as a stream does. */
      stderr: { on(event: 'data', handler: (chunk: unknown) => void): void };
    } | null;
    readonly rpc = {
      sessions: {
        fork: (params: { sessionId: string }): Promise<{ readonly sessionId: string }> => {
          record.forked.push(params.sessionId);
          return Promise.resolve({ sessionId: `${params.sessionId}-fork` });
        },
      },
      hooks: {
        discover: (params: {
          excludeHostHooks?: boolean;
        }): ReturnType<CopilotClient['rpc']['hooks']['discover']> => {
          record.discoveries.push(params);
          if (options.discoveryFailure !== undefined) {
            return Promise.reject(new Error(options.discoveryFailure));
          }
          return Promise.resolve({
            hooks: (options.discoveredHooks ?? []) as readonly CopilotDiscoveredHook[],
            errors: options.discoveryErrors ?? [],
          });
        },
      },
      managedSettings: {
        read: (): ReturnType<CopilotClient['rpc']['managedSettings']['read']> =>
          Promise.resolve(options.managedSettings ?? {}),
      },
    };

    constructor(clientOptions: CopilotClientOptions) {
      record.clients.push(clientOptions);
      const pid = options.pid === undefined ? 4242 : options.pid;
      this.cliProcess =
        pid === null
          ? null
          : {
              pid,
              exitCode: null,
              once: (_event, handler) => {
                exitListeners.push((code) => handler(code, null));
              },
              stderr: { on: (_event, handler) => void stderrReaders.push(handler) },
            };
      const child = this.cliProcess;
      if (child !== null) {
        // The process keeps its id after it exits, as the SDK's member does, and says it has exited.
        exitListeners.push((code) => {
          child.exitCode = code;
        });
      }
    }

    start(): Promise<void> {
      record.lifecycle.push('start');
      return Promise.resolve();
    }

    stop(): Promise<Error[]> {
      record.lifecycle.push('stop');
      return Promise.resolve([]);
    }

    forceStop(): Promise<void> {
      record.lifecycle.push('forceStop');
      return Promise.resolve();
    }

    createSession(config: CopilotSessionConfig): Promise<CopilotSession> {
      record.configs.push(config);
      if (options.createFailure !== undefined) return Promise.reject(new Error(options.createFailure));
      if (options.createHangs === true) return new Promise<never>(() => undefined);
      const id = options.sessionId ?? 'copilot-session-1';
      live = { config, id };
      emitTo(config, 'session.start', {
        sessionId: id,
        selectedModel: options.selectedModel ?? 'fake-model',
        copilotVersion: '1.0.112',
        producer: 'fake',
        startTime: '2026-11-15T00:00:00.000Z',
        version: 1,
      });
      if (options.subAgentStartModel !== undefined) {
        emitTo(
          config,
          'session.start',
          { sessionId: id, selectedModel: options.subAgentStartModel },
          { agentId: 'agent-1' },
        );
      }
      return Promise.resolve(sessionOf(config, id));
    }

    resumeSession(sessionId: string, config: CopilotSessionConfig): Promise<CopilotSession> {
      record.configs.push(config);
      record.resumed.push(sessionId);
      live = { config, id: sessionId };
      emitTo(config, 'session.resume', {
        selectedModel: options.selectedModel ?? 'fake-model',
        eventCount: 3,
        resumeTime: '',
      });
      return Promise.resolve(sessionOf(config, sessionId));
    }
  }

  const sdk: CopilotSdk = {
    CopilotClient: FakeClient,
    RuntimeConnection: {
      forStdio(connection): CopilotConnection {
        record.connections.push({ path: connection.path, env: { ...connection.env } });
        return { kind: 'stdio' };
      },
    },
  };
  return { sdk, record };
}
