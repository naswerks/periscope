/**
 * A substitute agent process for tests. It reproduces the one behaviour that shapes the session
 * contract: it emits nothing until a message is pushed. Every claim about a real agent is proven by
 * the `.live.test.ts` probes; this fake proves only the package's own handling.
 */
import { AsyncQueue } from '../core/async-queue.js';
import type { AgentProcess, AgentProcessRequest, SDKMessage } from '../host/agent-process.js';

/** The test's handle on one started fake process. */
export interface FakeAgent {
  readonly request: AgentProcessRequest;
  /** Every prompt text the session queued, in order. */
  readonly prompts: string[];
  /** How many times the session interrupted the turn. */
  interrupts: number;
  /** Push a message onto the process's output stream. */
  emit(message: SDKMessage): void;
  /** End the stream by throwing `error` from the generator, as a process death would. */
  fail(error: Error): void;
  /** End the stream normally. */
  finish(): void;
  /** Whether the session has closed the process. */
  closed(): boolean;
}

export interface FakeAgents {
  /** Pass as `startProcess` to a `SessionRegistry` or `PeriscopeHost`. */
  readonly start: (request: AgentProcessRequest) => AgentProcess;
  /** Every process started so far, in start order. */
  readonly started: FakeAgent[];
}

/** How many turns the fake takes before it says no — the real queue's bound, so a held-turn flush (8) fits. */
export const FAKE_PROMPT_CAPACITY = 16;

export function fakeAgents(): FakeAgents {
  const started: FakeAgent[] = [];
  const start = (request: AgentProcessRequest): AgentProcess => {
    const queue = new AsyncQueue<SDKMessage>();
    const prompts: string[] = [];
    let isClosed = false;
    let failure: Error | null = null;

    async function* messages(): AsyncGenerator<SDKMessage, void> {
      for await (const message of queue) yield message;
      if (failure !== null) throw failure;
    }

    const record: FakeAgent = {
      request,
      prompts,
      interrupts: 0,
      emit: (message) => queue.push(message),
      fail: (error) => {
        failure = error;
        queue.end();
      },
      finish: () => queue.end(),
      closed: () => isClosed,
    };
    started.push(record);

    return {
      messages: messages(),
      prompt: (text: string) => {
        if (isClosed) return false;
        // The real process bounds its pending turns (MAX_PENDING_PROMPTS); the fake bounds at a
        // number a test can reach, so the registry's refusal path is exercised without a queue.
        if (prompts.length >= FAKE_PROMPT_CAPACITY) return false;
        prompts.push(text);
        return true;
      },
      interrupt: () => {
        record.interrupts += 1;
        return Promise.resolve();
      },
      setModel: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve(),
      setThinking: () => Promise.resolve(),
      close: () => {
        isClosed = true;
        queue.end();
      },
    };
  };
  return { start, started };
}

/** A `system/init` message with the fields the observer reads, cast to the SDK's union. */
export function initMessage(sessionId: string, overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    claude_code_version: '9.9.9',
    model: 'test-model',
    cwd: '/work',
    tools: [],
    mcp_servers: [],
    permissionMode: 'default',
    apiKeySource: 'none',
    slash_commands: [],
    agents: [],
    skills: [],
    plugins: [],
    output_style: 'default',
    uuid: `${sessionId}-init`,
    ...overrides,
  } as unknown as SDKMessage;
}

/** Yield to the event loop enough times for queued microtasks and immediates to drain. */
export async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
}
