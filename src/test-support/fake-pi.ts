/**
 * An in-process stand-in for pi in RPC mode, for the pi adapter's tests.
 *
 * It loads the extension the launch names (the second `-e`) the way pi does: it imports the file and
 * hands its activation an extension API, with the environment the child was spawned with. So every call
 * it makes goes through this package's real extension, over the session's real hook channel, and is
 * decided by the real gate. It holds to what the pinned release does where the adapter's guarantees rest
 * on it:
 * - Built-in extensions load before the `-e` files, so the extension's `tool_call` handler is the last
 *   word, and the object a handler is handed is the object the tool runs with.
 * - `session_start` fires once the extensions are loaded, before any command is read; the extension's
 *   hello rides it.
 * - A `prompt` while a run runs is taken only with `streamingBehavior`, and queued; one while none runs
 *   starts a run. A `follow_up` while none runs only queues.
 * - A run is `agent_start`, the user's `message_end`, then for each scripted call an assistant
 *   `message_end` carrying it, `tool_execution_start` (before the handlers), the handlers, and
 *   `tool_execution_end`; then the answer, streamed as one text `message_update` and ended by its
 *   `message_end`, and `agent_settled`.
 * - `abort` aborts the run's signal and answers once the run has settled.
 * - The `bash` command goes through the `user_bash` handlers, and a throw refuses it.
 * - Closing stdin ends the process.
 */
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';

import type { JsonObject } from '../control/frames.js';
import type {
  PiCommandInfo,
  PiExtensionApi,
  PiExtensionContext,
  PiMcpHttpServer,
  PiMcpStdioServer,
  PiSessionStartEvent,
  PiToolCallEvent,
  PiToolCallResult,
  PiToolInfo,
  PiUserBashEvent,
} from '../host/pi-extension-api.js';
import { PI_NAMES } from '../host/pi-names.js';
import { qwenHandedOverSkills } from '../host/qwen-pack.js';
import type { FakeChild } from './fake-child.js';
import { fakeChild, spawnerFor } from './fake-child.js';

/** One tool call a run makes. */
export interface FakePiCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  /** The text the call's result carries when it runs. */
  readonly output?: string;
}

/** A command or tool from somewhere other than this package's extension, as pi would list it. */
export interface FakePiForeign {
  readonly name: string;
  readonly path: string;
  readonly source?: string;
}

export interface FakePiOptions {
  readonly sessionId?: string;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: string;
  /** The calls a run makes, by its prompt. */
  readonly calls?: (prompt: string) => readonly FakePiCall[];
  /** A command another extension registered, which `get_commands` lists. */
  readonly foreignCommands?: readonly FakePiForeign[];
  /** A tool another extension registered, which the extension API lists. */
  readonly foreignTools?: readonly FakePiForeign[];
  /** Load no extension at all, so none says hello. */
  readonly loadNoExtension?: boolean;
  /** End at start, writing this to stderr, as pi does when it cannot start. */
  readonly startFailure?: { readonly stderr: string; readonly code: number };
  /** Answer every prompt with `success: false` and this error. */
  readonly promptError?: string;
  /** The answer's message ends on an error with this text. */
  readonly answerError?: string;
  /** The models `get_available_models` answers with. */
  readonly models?: readonly {
    readonly provider: string;
    readonly id: string;
    readonly reasoning?: boolean;
  }[];
  /** The usage each model call adds to the session's totals. */
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly cost: number;
  };
}

/** A call that ran: its tool and the input it ran with. */
export interface FakePiRun {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
}

/** A call a handler blocked, with the reason pi would tell the model. */
export interface FakePiBlock {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly reason: string;
}

const DEFAULT_SESSION = '01999999-0000-7000-8000-00000000f1de';

/** A member of a command line that is a string, or the empty string. */
const word = (value: unknown): string => (typeof value === 'string' ? value : '');

type Handler = (event: never, ctx: PiExtensionContext) => unknown;

export class FakePiCli {
  readonly #options: FakePiOptions;
  readonly #child: FakeChild;
  readonly #args: readonly string[];
  readonly #env: Readonly<Record<string, string>>;
  readonly #cwd: string;
  readonly #handlers = new Map<string, Handler[]>();
  readonly #commands: JsonObject[] = [];
  readonly #servers: { name: string; config: PiMcpHttpServer | PiMcpStdioServer }[] = [];
  readonly #queue: string[] = [];
  #loaded: Promise<void> = Promise.resolve();
  #running: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #thinkingLevel: string;
  #model: { readonly provider: string; readonly id: string };
  #tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  #cost = 0;
  #calls = 0;
  /** Every command line pi read, in order. */
  readonly received: JsonObject[] = [];
  /** Every call that ran, with the input it ran with. */
  readonly ran: FakePiRun[] = [];
  /** Every call a handler blocked. */
  readonly blocked: FakePiBlock[] = [];
  /** Every `bash` command that ran. */
  readonly bashRan: string[] = [];
  /** Whether an error escaped the extension's activation. */
  loadError: string | null = null;

  constructor(
    options: FakePiOptions,
    child: FakeChild,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    cwd: string,
  ) {
    this.#options = options;
    this.#child = child;
    this.#args = args;
    this.#env = env;
    this.#cwd = cwd;
    this.#thinkingLevel = options.thinkingLevel ?? 'medium';
    this.#model = options.model ?? { provider: 'openrouter', id: 'example/model-1' };
    if (options.startFailure !== undefined) {
      const failure = options.startFailure;
      setImmediate(() => {
        child.stderr(`${failure.stderr}\n`);
        child.exit(failure.code);
      });
      return;
    }
    this.#loaded = this.#load();
  }

  /** The argument after `flag`, or null. */
  argAfter(flag: string): string | null {
    const index = this.#args.indexOf(flag);
    return index < 0 ? null : (this.#args[index + 1] ?? null);
  }

  /** Every argument after each `flag`. */
  argsAfter(flag: string): string[] {
    return this.#args.flatMap((arg, index) => (arg === flag ? [this.#args[index + 1] ?? ''] : []));
  }

  /** Lines pi read of the command `type`. */
  commandsOf(type: string): JsonObject[] {
    return this.received.filter((line) => line['type'] === type);
  }

  async #load(): Promise<void> {
    if (this.#options.loadNoExtension === true) return;
    const extensions = this.argsAfter('-e').filter((path) => !path.startsWith('builtin:'));
    for (const path of extensions) {
      try {
        const module = (await import(pathToFileURL(path).href)) as {
          activatePiExtension: (pi: PiExtensionApi, env: Record<string, string | undefined>) => void;
        };
        module.activatePiExtension(this.#api(path), { ...this.#env });
      } catch (error) {
        this.loadError = error instanceof Error ? error.message : String(error);
        this.#child.stderr(`Failed to load extension "${path}": ${this.loadError}\n`);
        setImmediate(() => this.#child.exit(1));
        return;
      }
    }
    await this.#emit('session_start', {
      type: 'session_start',
      reason: 'startup',
    } satisfies PiSessionStartEvent);
  }

  #api(path: string): PiExtensionApi {
    const on = (event: string, handler: Handler): (() => void) => {
      const list = this.#handlers.get(event) ?? [];
      list.push(handler);
      this.#handlers.set(event, list);
      return () => undefined;
    };
    return {
      on,
      registerCommand: (name, options) => {
        this.#commands.push({
          name,
          source: 'extension',
          sourceInfo: { path, source: 'cli', scope: 'temporary', origin: 'top-level' },
          ...(options.description === undefined ? {} : { description: options.description }),
        });
      },
      registerMcpServer: (name, config) => {
        this.#servers.push({ name, config });
      },
      getAllTools: () => this.#tools(path),
      getCommands: () => this.#commands as unknown as PiCommandInfo[],
      getMcpServers: () => this.#servers.map((server) => ({ name: server.name, extensionPath: path })),
    };
  }

  /** The servers the extension registered, as pi was handed them. */
  get servers(): readonly { name: string; config: PiMcpHttpServer | PiMcpStdioServer }[] {
    return this.#servers;
  }

  #tools(path: string): PiToolInfo[] {
    const builtins = PI_NAMES.tools
      .filter((tool) => tool !== 'powershell')
      .map((tool) => ({ name: tool, sourceInfo: { path: `builtin:${tool}`, source: 'builtin' } }));
    const mcp = this.#servers.flatMap((server) =>
      server.config.exposure === 'direct'
        ? [{ name: `mcp__${server.name}__echo`, sourceInfo: { path: 'builtin:mcp', source: 'builtin' } }]
        : [],
    );
    const foreign = (this.#options.foreignTools ?? []).map((tool) => ({
      name: tool.name,
      sourceInfo: { path: tool.path, source: tool.source ?? 'cli' },
    }));
    void path;
    return [...builtins, ...mcp, ...foreign];
  }

  #commandList(): JsonObject[] {
    // Each skill pi finds under a `--skill` directory is the command `skill:<name>`, its base the folder.
    const skills = this.argsAfter('--skill').flatMap((directory) =>
      qwenHandedOverSkills([directory]).map((name) => ({
        name: `skill:${name}`,
        source: 'skill',
        sourceInfo: {
          path: `${directory}/${name}/SKILL.md`,
          source: 'local',
          baseDir: `${directory}/${name}`,
        },
      })),
    );
    const foreign = (this.#options.foreignCommands ?? []).map((command) => ({
      name: command.name,
      source: 'extension',
      sourceInfo: { path: command.path, source: command.source ?? 'cli' },
    }));
    return [...this.#commands, ...foreign, ...skills];
  }

  async #emit(event: string, payload: object, ctx?: PiExtensionContext): Promise<unknown> {
    let result: unknown;
    for (const handler of this.#handlers.get(event) ?? []) {
      result = await handler(payload as never, ctx ?? { cwd: this.#cwd, signal: undefined });
      if (event === 'tool_call' && (result as PiToolCallResult | undefined)?.block === true) return result;
    }
    return result;
  }

  #send(message: JsonObject): void {
    this.#child.send(message);
  }

  #answer(line: JsonObject, data?: JsonObject): void {
    this.#send({
      ...(typeof line['id'] === 'string' ? { id: line['id'] } : {}),
      type: 'response',
      command: word(line['type']),
      success: true,
      ...(data === undefined ? {} : { data }),
    });
  }

  #refuse(line: JsonObject, error: string): void {
    this.#send({
      ...(typeof line['id'] === 'string' ? { id: line['id'] } : {}),
      type: 'response',
      command: word(line['type']),
      success: false,
      error,
    });
  }

  receive(line: JsonObject): void {
    this.received.push(line);
    void this.#loaded.then(() => this.#handle(line));
  }

  async #handle(line: JsonObject): Promise<void> {
    switch (line['type']) {
      case 'get_state':
        this.#answer(line, {
          sessionId: this.#options.sessionId ?? DEFAULT_SESSION,
          sessionFile: `${this.argAfter('--session-dir') ?? '.'}/2026-10-14T00-00-00-000Z_${this.#options.sessionId ?? DEFAULT_SESSION}.jsonl`,
          model: { provider: this.#model.provider, id: this.#model.id, contextWindow: 200_000 },
          thinkingLevel: this.#thinkingLevel,
          isStreaming: this.#running !== null,
        });
        return;
      case 'get_commands':
        this.#answer(line, { commands: this.#commandList() });
        return;
      case 'get_available_models':
        this.#answer(line, {
          models: (this.#options.models ?? []).map((model) => ({ ...model, name: model.id })),
        });
        return;
      case 'set_model': {
        const provider = word(line['provider']);
        const id = word(line['modelId']);
        this.#model = { provider, id };
        this.#answer(line, { provider, id, contextWindow: 100_000 });
        return;
      }
      case 'set_thinking_level': {
        const level = word(line['level']);
        this.#answer(line);
        if (level !== this.#thinkingLevel) {
          this.#thinkingLevel = level;
          this.#send({ type: 'thinking_level_changed', level });
        }
        return;
      }
      case 'get_session_stats':
        this.#answer(line, {
          sessionId: this.#options.sessionId ?? DEFAULT_SESSION,
          tokens: {
            ...this.#tokens,
            total:
              this.#tokens.input + this.#tokens.output + this.#tokens.cacheRead + this.#tokens.cacheWrite,
          },
          cost: this.#cost,
          contextUsage: { tokens: 1234, contextWindow: 200_000, percent: 0.6 },
        });
        return;
      case 'prompt':
        return this.#prompt(line);
      case 'follow_up':
        // Taken while no run runs, it only queues: nothing starts.
        this.#queue.push(word(line['message']));
        this.#answer(line, { disposition: 'queued' });
        return;
      case 'abort':
        this.#abort?.abort();
        await this.#running;
        this.#answer(line);
        return;
      case 'bash':
        return this.#bash(line);
      case 'extension_ui_response':
        return;
      default:
        this.#refuse(line, `Unknown command: ${word(line['type'])}`);
    }
  }

  #prompt(line: JsonObject): void {
    if (this.#options.promptError !== undefined) {
      this.#refuse(line, this.#options.promptError);
      return;
    }
    const message = word(line['message']);
    if (this.#running !== null) {
      if (line['streamingBehavior'] === undefined) {
        this.#refuse(
          line,
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        );
        return;
      }
      this.#queue.push(message);
      this.#answer(line, { disposition: 'queued' });
      return;
    }
    this.#answer(line, { disposition: 'started' });
    this.#running = this.#run(message);
  }

  async #run(first: string): Promise<void> {
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    this.#send({ type: 'agent_start' });
    let prompt: string | undefined = first;
    while (prompt !== undefined) {
      this.#send({ type: 'message_end', message: { role: 'user', content: prompt, timestamp: 0 } });
      for (const call of this.#options.calls?.(prompt) ?? []) {
        if (signal.aborted) break;
        this.#calls += 1;
        const toolCallId = `call_${this.#calls}`;
        this.#send({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: toolCallId, name: call.toolName, arguments: call.input as JsonObject },
            ],
            model: this.#model.id,
            provider: this.#model.provider,
            usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0 },
            stopReason: 'toolUse',
          },
        });
        this.#send({
          type: 'tool_execution_start',
          toolCallId,
          toolName: call.toolName,
          args: call.input as JsonObject,
        });
        // pi hands every handler the object it then runs the tool with.
        const input = structuredClone(call.input);
        const event: PiToolCallEvent = { type: 'tool_call', toolName: call.toolName, toolCallId, input };
        let result: PiToolCallResult | undefined;
        try {
          result = (await this.#emit('tool_call', event, { cwd: this.#cwd, signal })) as
            PiToolCallResult | undefined;
        } catch (error) {
          result = { block: true, reason: error instanceof Error ? error.message : String(error) };
        }
        if (result?.block === true) {
          const reason = result.reason ?? 'Tool execution was blocked';
          this.blocked.push({ toolName: call.toolName, toolCallId, reason });
          this.#send({
            type: 'tool_execution_end',
            toolCallId,
            toolName: call.toolName,
            result: { content: [{ type: 'text', text: reason }] },
            isError: true,
          });
          continue;
        }
        this.ran.push({ toolName: call.toolName, toolCallId, input });
        this.#send({
          type: 'tool_execution_end',
          toolCallId,
          toolName: call.toolName,
          result: { content: [{ type: 'text', text: call.output ?? 'done' }] },
          isError: false,
          durationMs: 7,
        });
      }
      const usage = this.#options.usage ?? {
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 5,
        cost: 0.0012,
      };
      this.#tokens = {
        input: this.#tokens.input + usage.input,
        output: this.#tokens.output + usage.output,
        cacheRead: this.#tokens.cacheRead + usage.cacheRead,
        cacheWrite: this.#tokens.cacheWrite + usage.cacheWrite,
      };
      this.#cost += usage.cost;
      const failed = this.#options.answerError;
      if (failed === undefined && !signal.aborted) {
        this.#send({
          type: 'message_update',
          message: { role: 'assistant', content: [] },
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `answered: ${prompt}` },
        });
      }
      this.#send({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: failed === undefined ? [{ type: 'text', text: `answered: ${prompt}` }] : [],
          model: this.#model.id,
          provider: this.#model.provider,
          usage: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          },
          stopReason: signal.aborted ? 'aborted' : failed === undefined ? 'stop' : 'error',
          ...(failed === undefined ? {} : { errorMessage: failed }),
        },
      });
      prompt = signal.aborted ? undefined : this.#queue.shift();
    }
    this.#send({ type: 'agent_settled', aborted: signal.aborted });
    this.#running = null;
    this.#abort = null;
  }

  async #bash(line: JsonObject): Promise<void> {
    const command = word(line['command']);
    const event: PiUserBashEvent = { type: 'user_bash', command, cwd: this.#cwd };
    try {
      await this.#emit('user_bash', event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#send({
        type: 'extension_error',
        extensionPath: this.argsAfter('-e').at(-1) ?? '',
        event: 'user_bash',
        error: message,
      });
      this.#refuse(line, message);
      return;
    }
    this.bashRan.push(command);
    this.#answer(line, { output: 'ran', exitCode: 0, cancelled: false, truncated: false });
  }

  /** Write one line onto pi's stdout, as pi would. */
  write(message: JsonObject): void {
    this.#send(message);
  }
}

export interface FakePi {
  readonly child: FakeChild;
  /** The fake CLI, once spawned. */
  readonly cli: FakePiCli;
  /** Whether pi was spawned at all. */
  readonly spawned: boolean;
  /** Pass as the runtime's `spawn`. */
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  ) => ChildProcess;
}

/** A fake pi on an in-process child. It exits when its input ends, as pi does. */
export function fakePi(options: FakePiOptions = {}): FakePi {
  const child = fakeChild();
  const spawnChild = spawnerFor(child);
  let cli: FakePiCli | null = null;
  child.onLine((message) => cli?.receive(message));
  return {
    child,
    get cli(): FakePiCli {
      if (cli === null) throw new Error('the fake pi has not been spawned');
      return cli;
    },
    get spawned(): boolean {
      return cli !== null;
    },
    spawn: (command, args, spawnOptions) => {
      const started = spawnChild(command, args, spawnOptions);
      cli = new FakePiCli(options, child, args, spawnOptions.env, spawnOptions.cwd);
      const watch = setInterval(() => {
        if (!child.stdinEnded) return;
        clearInterval(watch);
        child.exit(0);
      }, 5);
      watch.unref();
      return started;
    },
  };
}

/** The tool calls a `PiToolCallEvent` handler type accepts, for tests that drive the extension alone. */
export type { PiToolCallEvent, PiUserBashEvent };
