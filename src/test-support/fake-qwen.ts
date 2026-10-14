/**
 * An in-process stand-in for Qwen Code's CLI speaking its stream-json control protocol, for the Qwen
 * adapter's tests.
 *
 * It holds to what the pinned CLI does where the adapter's guarantees rest on it:
 * - `initialize` must be the first line: a user message first puts it in a mode with no control
 *   requests, where an asked call is never answered (`directMode`).
 * - Each user message is a turn, run one at a time in arrival order: a `system/init`, then for each
 *   scripted call the assistant message carrying its `tool_use`, then, for a call the session's rules
 *   send to ask, a `can_use_tool` request and the wait for its answer, then the call's `tool_result`,
 *   then the `result` with the session's running usage.
 * - Whether a call asks is read the way the CLI reads it: from the `permissions.ask` of the system
 *   settings file its environment names. A call to a tool its default allows (`defaultAllowed`) and no
 *   rule names runs without asking, and is recorded as having run undecided.
 * - An allow runs the call with the arguments it was asked about, whatever the answer carries.
 */
import { readFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

import type { JsonObject } from '../control/frames.js';
import { QWEN_NAMES } from '../host/qwen-names.js';
import type { FakeChild } from './fake-child.js';
import { fakeChild, spawnerFor } from './fake-child.js';

/** One tool call a turn makes. */
export interface FakeQwenCall {
  readonly name: string;
  readonly input: JsonObject;
  /** Whether the CLI allows this call by default, before any rule (a read, a read-only command). */
  readonly defaultAllowed?: boolean;
  /** The text the call's result carries when it runs. */
  readonly output?: string;
}

export interface FakeQwenOptions {
  readonly sessionId?: string;
  /** The tools the init lists. Defaults to every built-in tool of the pinned release. */
  readonly tools?: readonly string[];
  /** The mode the init reports. Defaults to the one `--approval-mode` names. */
  readonly mode?: string;
  /** The calls a turn makes, by its prompt. */
  readonly calls?: (prompt: string) => readonly FakeQwenCall[];
  /** The usage each model call adds to the session's running total. */
  readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead: number };
  /** The status each MCP server the session attached reports. Defaults to connected. */
  readonly mcpStatus?: Readonly<Record<string, string>>;
  /** The skills `get_context_usage` lists. */
  readonly skills?: readonly string[];
  /** Answer `initialize` with an error. */
  readonly refuseInitialize?: string;
  /** Write an auth failure's result before anything else, then exit 1, as the CLI does with no auth. */
  readonly authFailure?: string;
  /** Hold every `can_use_tool` answer until released, to test an interrupt or a close mid-call. */
  readonly holdDecisions?: boolean;
}

/** A call that ran: whether the session's rules asked about it first, and with what input. */
export interface FakeQwenRun {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly asked: boolean;
  readonly input: JsonObject;
}

const DEFAULT_SESSION = '5f6e2a1c-0000-4000-8000-00000000c0de';

/** A member's text, or nothing when it is not text. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class FakeQwenCli {
  readonly #options: FakeQwenOptions;
  readonly #child: FakeChild;
  readonly #args: readonly string[];
  readonly #env: Readonly<Record<string, string>>;
  readonly #ask: ReadonlySet<string>;
  readonly #queue: string[] = [];
  #initialized = false;
  #first = true;
  #running = false;
  #interrupted = false;
  #nextRequest = 0;
  #nextCall = 0;
  #turns = 0;
  readonly #pending = new Map<string, (response: JsonObject) => void>();
  readonly #held: (() => void)[] = [];
  #mode: string;
  #model: string;
  /** The MCP servers `initialize` attached, by name. */
  #servers: string[] = [];
  #effort: string | null = null;
  readonly #total = { input: 0, output: 0, cacheRead: 0 };

  /** Every control request the host sent, in order. */
  readonly requests: JsonObject[] = [];
  /** Every user message's text, in order. */
  readonly prompts: string[] = [];
  /** Every `can_use_tool` request sent, with the answer the host gave. */
  readonly decided: { readonly request: JsonObject; readonly answer: JsonObject }[] = [];
  /** Every call that ran. */
  readonly ran: FakeQwenRun[] = [];
  /** True when the first line was not `initialize`. */
  directMode = false;

  constructor(
    options: FakeQwenOptions,
    child: FakeChild,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ) {
    this.#options = options;
    this.#child = child;
    this.#args = args;
    this.#env = env;
    this.#ask = readAskRules(env['QWEN_CODE_SYSTEM_SETTINGS_PATH']);
    this.#mode = argAfter(args, '--approval-mode') ?? 'auto';
    this.#model = argAfter(args, '--model') ?? 'qwen3-coder-plus';
    const authFailure = options.authFailure;
    if (authFailure !== undefined) {
      setImmediate(() => {
        this.#emit({
          type: 'result',
          subtype: 'error_during_execution',
          uuid: 'auth-failure',
          session_id: this.sessionId,
          is_error: true,
          duration_ms: 0,
          num_turns: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          error: { message: authFailure },
        });
        child.exit(1);
      });
    }
  }

  get sessionId(): string {
    return this.#options.sessionId ?? DEFAULT_SESSION;
  }

  /** The arguments and environment the CLI was started with. */
  get args(): readonly string[] {
    return this.#args;
  }

  get env(): Readonly<Record<string, string>> {
    return this.#env;
  }

  /** The ask rules the CLI read from its settings. */
  get askRules(): ReadonlySet<string> {
    return this.#ask;
  }

  /** Lets every held decision through. */
  release(): void {
    for (const next of this.#held.splice(0)) next();
  }

  receive(message: JsonObject): void {
    const first = this.#first;
    this.#first = false;
    if (message['type'] === 'user') {
      if (first) this.directMode = true;
      const content = (message['message'] as { content?: unknown } | undefined)?.content;
      const text = typeof content === 'string' ? content : '';
      this.prompts.push(text);
      this.#queue.push(text);
      if (this.#initialized) void this.#drive();
      return;
    }
    if (message['type'] === 'control_request') {
      const request = message['request'] as JsonObject;
      this.requests.push(request);
      this.#answer(textOf(message['request_id']), request);
      return;
    }
    if (message['type'] === 'control_response') {
      const response = message['response'] as JsonObject;
      const settle = this.#pending.get(textOf(response['request_id']));
      if (settle === undefined) return;
      this.#pending.delete(textOf(response['request_id']));
      const answer =
        response['subtype'] === 'success'
          ? ((response['response'] as JsonObject | undefined) ?? {})
          : { behavior: 'deny', message: `Error: ${textOf(response['error'])}` };
      if (this.#options.holdDecisions === true) this.#held.push(() => settle(answer));
      else settle(answer);
    }
  }

  #answer(requestId: string, request: JsonObject): void {
    const subtype = request['subtype'];
    const success = (response: JsonObject): void =>
      this.#emit({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response },
      });
    const failure = (error: string): void =>
      this.#emit({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
    switch (subtype) {
      case 'initialize': {
        if (this.#options.refuseInitialize !== undefined) return failure(this.#options.refuseInitialize);
        this.#initialized = true;
        const servers = request['mcpServers'];
        this.#servers = typeof servers === 'object' && servers !== null ? Object.keys(servers) : [];
        const effort = request['effort'];
        if (typeof effort === 'string') this.#effort = effort;
        success({
          subtype: 'initialize',
          session_id: this.sessionId,
          capabilities: { can_handle_can_use_tool: true },
          ...(this.#effort === null ? {} : { effort_status: { effort: this.#effort, applied: true } }),
        });
        if (this.#queue.length > 0) void this.#drive();
        return;
      }
      case 'interrupt':
        this.#interrupted = this.#running;
        return success({ subtype: 'interrupt' });
      case 'set_model':
        this.#model = textOf(request['model']);
        return success({ subtype: 'set_model', model: this.#model });
      case 'set_permission_mode': {
        const mode = textOf(request['mode']);
        if (!['plan', 'default', 'auto-edit', 'auto', 'yolo'].includes(mode)) {
          return failure(`Invalid permission mode: ${mode}`);
        }
        this.#mode = mode;
        return success({ status: 'updated', mode });
      }
      case 'set_effort':
        this.#effort = textOf(request['effort']);
        return success({ subtype: 'set_effort', effort: this.#effort, applied: true });
      case 'get_context_usage':
        return success({
          subtype: 'get_context_usage',
          modelName: this.#model,
          totalTokens: this.#total.input,
          contextWindowSize: 200000,
          skills: (this.#options.skills ?? []).map((name) => ({ name, tokens: 10 })),
        });
      default:
        return failure(`Unknown control request subtype: ${textOf(subtype)}`);
    }
  }

  #emit(message: JsonObject): void {
    this.#child.send(message);
  }

  #asks(name: string, defaultAllowed: boolean): boolean {
    if (this.#ask.has(name)) return true;
    if (name.startsWith('mcp__')) {
      for (const rule of this.#ask) if (rule.startsWith('mcp__') && name.startsWith(`${rule}__`)) return true;
    }
    return !defaultAllowed;
  }

  async #drive(): Promise<void> {
    if (this.#running || this.directMode) return;
    const prompt = this.#queue.shift();
    if (prompt === undefined) return;
    this.#running = true;
    this.#interrupted = false;
    this.#turns += 1;
    const servers = this.#servers;
    this.#emit({
      type: 'system',
      subtype: 'init',
      uuid: this.sessionId,
      session_id: this.sessionId,
      cwd: 'C:/work/session-1',
      tools: [...(this.#options.tools ?? QWEN_NAMES.tools)],
      mcp_servers: servers.map((name) => ({ name, status: this.#options.mcpStatus?.[name] ?? 'connected' })),
      model: this.#model,
      permission_mode: this.#options.mode ?? this.#mode,
      slash_commands: [],
      qwen_code_version: '0.25.1',
      agents: [],
    });
    for (const call of this.#options.calls?.(prompt) ?? []) {
      if (this.#interrupted) break;
      this.#nextCall += 1;
      const id = `call_${this.#nextCall}`;
      this.#emit({
        type: 'assistant',
        uuid: `assistant-${this.#nextCall}`,
        session_id: this.sessionId,
        parent_tool_use_id: null,
        message: {
          id: `message-${this.#nextCall}`,
          type: 'message',
          role: 'assistant',
          model: this.#model,
          content: [{ type: 'tool_use', id, name: call.name, input: call.input }],
          usage: this.#spend(),
        },
      });
      const asked = this.#asks(call.name, call.defaultAllowed ?? false);
      let allowed = true;
      let reason = '';
      if (asked) {
        this.#nextRequest += 1;
        const requestId = `cli-${this.#nextRequest}`;
        const request: JsonObject = {
          subtype: 'can_use_tool',
          tool_name: call.name,
          tool_use_id: id,
          input: call.input,
          permission_suggestions: null,
          blocked_path: null,
        };
        const answer = await new Promise<JsonObject>((resolve) => {
          this.#pending.set(requestId, resolve);
          this.#emit({ type: 'control_request', request_id: requestId, request });
        });
        this.decided.push({ request, answer });
        allowed = answer['behavior'] === 'allow';
        reason = typeof answer['message'] === 'string' ? answer['message'] : '';
      }
      if (this.#interrupted) break;
      if (allowed) this.ran.push({ toolName: call.name, toolUseId: id, asked, input: call.input });
      this.#emit({
        type: 'user',
        uuid: `user-${this.#nextCall}`,
        session_id: this.sessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              is_error: !allowed,
              content: allowed ? (call.output ?? 'ok') : `[Operation Cancelled] Reason: ${reason}`,
            },
          ],
        },
      });
    }
    if (!this.#interrupted) {
      if (this.#args.includes('--include-partial-messages')) {
        this.#emit({
          type: 'stream_event',
          uuid: `event-${this.#turns}`,
          session_id: this.sessionId,
          parent_tool_use_id: null,
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        });
      }
      this.#emit({
        type: 'assistant',
        uuid: `answer-${this.#turns}`,
        session_id: this.sessionId,
        parent_tool_use_id: null,
        message: {
          id: `answer-${this.#turns}`,
          type: 'message',
          role: 'assistant',
          model: this.#model,
          content: [{ type: 'text', text: 'done' }],
          usage: this.#spend(),
        },
      });
    }
    this.#emit({
      type: 'result',
      subtype: this.#interrupted ? 'error_during_execution' : 'success',
      uuid: `result-${this.#turns}`,
      session_id: this.sessionId,
      is_error: this.#interrupted,
      duration_ms: 12,
      num_turns: 1,
      ...(this.#interrupted ? { error: { message: 'Operation cancelled.' } } : { result: 'done' }),
      usage: {
        input_tokens: this.#total.input,
        output_tokens: this.#total.output,
        cache_read_input_tokens: this.#total.cacheRead,
        total_tokens: this.#total.input + this.#total.output,
      },
      permission_denials: [],
    });
    this.#running = false;
    void this.#drive();
  }

  /** One model call's usage, added to the session's running total. */
  #spend(): JsonObject {
    const usage = this.#options.usage ?? { input: 100, output: 20, cacheRead: 40 };
    this.#total.input += usage.input;
    this.#total.output += usage.output;
    this.#total.cacheRead += usage.cacheRead;
    return {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_input_tokens: usage.cacheRead,
      total_tokens: usage.input + usage.output,
    };
  }
}

function argAfter(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index < 0 ? null : (args[index + 1] ?? null);
}

function readAskRules(path: string | undefined): ReadonlySet<string> {
  if (path === undefined) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { permissions?: { ask?: unknown } };
    const ask = parsed.permissions?.ask;
    return new Set(Array.isArray(ask) ? ask.filter((rule): rule is string => typeof rule === 'string') : []);
  } catch {
    return new Set();
  }
}

export interface FakeQwen {
  readonly child: FakeChild;
  /** The fake CLI, once spawned. */
  readonly cli: FakeQwenCli;
  /** Pass as the runtime's `spawn`. */
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  ) => ChildProcess;
}

/** A fake CLI on an in-process child. It exits when its input ends, as the CLI does once it has drained. */
export function fakeQwen(options: FakeQwenOptions = {}): FakeQwen {
  const child = fakeChild();
  const spawnChild = spawnerFor(child);
  let cli: FakeQwenCli | null = null;
  child.onLine((message) => cli?.receive(message));
  return {
    child,
    get cli(): FakeQwenCli {
      if (cli === null) throw new Error('the fake CLI has not been spawned');
      return cli;
    },
    spawn: (command, args, spawnOptions) => {
      const started = spawnChild(command, args, spawnOptions);
      cli = new FakeQwenCli(options, child, args, spawnOptions.env);
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
