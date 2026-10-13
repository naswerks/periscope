/**
 * A stand-in for `codex app-server`: answers the client methods this host calls with shapes from the
 * pinned release's protocol, records every request, and lets a test send notifications and requests
 * of its own. It proves this package's handling only; what the real server does is the live probes'.
 *
 * One core (`FakeCodexServer`) speaks line-delimited JSON through a writer. `fakeCodex` binds it to
 * an in-process child for unit tests; `fake-codex-server.ts` binds it to a real process's stdio.
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { JsonObject, JsonValue } from '../control/frames.js';
import { CODEX_HOOK_TIMEOUT_SECONDS } from '../gate/hook-exchange.js';
import { codexHookLines } from '../host/codex-hook.js';
import { fakeChild, spawnerFor } from './fake-child.js';
import type { FakeChild } from './fake-child.js';

export interface FakeCodexOptions {
  /** The home `initialize` answers with; a session asserts it equals the configured one. */
  readonly codexHome: string;
  /** The version the `userAgent` names. Default the pinned `0.162.1`. */
  readonly version?: string;
  readonly threadId?: string;
  /** The model a thread opens on when none is named. */
  readonly model?: string;
  /** The cwd the thread answer names. Default: the directory the server was started in. */
  readonly cwd?: string;
  readonly models?: readonly JsonObject[];
  readonly account?: JsonObject | null;
  readonly requiresOpenaiAuth?: boolean;
  /** The `skills/list` answer. Default: one skill, no errors. */
  readonly skills?: JsonObject;
  /** Methods answered with this error instead. */
  readonly fail?: Readonly<Record<string, { readonly code: number; readonly message: string }>>;
  /** Methods never answered. */
  readonly silent?: readonly string[];
  /** Whether `turn/started` follows a `turn/start` answer. Default true. */
  readonly announceTurns?: boolean;
  /**
   * Periscope's hook as `hooks/list` shows it: `trusted` (the default); `untrusted` until the trust
   * write arrives; `stuck`, untrusted whatever is written; `absent`; `disabled`; `drifts`, trusted until
   * a thread opens and then changed.
   */
  readonly hookTrust?: 'trusted' | 'untrusted' | 'stuck' | 'absent' | 'disabled' | 'drifts';
  /** Other hooks `hooks/list` shows beside periscope's. */
  readonly foreignHooks?: readonly JsonObject[];
  /** Whether `config/read` lists an active project layer. */
  readonly projectLayer?: boolean;
  /** What `windowsSandbox/readiness` answers. Default `ready`. */
  readonly sandboxReadiness?: string;
}

/** The hash a fake lists for periscope's hook. */
export const FAKE_HOOK_HASH = 'sha256:periscope-hook';

/** `value` when it is a string, else empty. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The catalog a fake server offers unless told otherwise: one model takes `none`, one does not. */
export const FAKE_MODELS: readonly JsonObject[] = [
  {
    id: 'gpt-6-sol',
    model: 'gpt-6-sol',
    displayName: 'GPT-6-Sol',
    description: 'The default model.',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({
      reasoningEffort,
      description: '',
    })),
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-6-luna',
    model: 'gpt-6-luna',
    displayName: 'GPT-6-Luna',
    description: 'A model that can stop reasoning.',
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: ['none', 'low', 'medium'].map((reasoningEffort) => ({
      reasoningEffort,
      description: '',
    })),
    defaultReasoningEffort: 'low',
  },
  {
    id: 'codex-auto-review',
    model: 'codex-auto-review',
    displayName: 'Hidden',
    description: 'Never offered.',
    hidden: true,
    isDefault: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'low',
  },
];

interface Pending {
  readonly resolve: (answer: JsonObject) => void;
}

export class FakeCodexServer {
  readonly #options: FakeCodexOptions;
  readonly #write: (line: string) => void;
  readonly #cwd: string;
  /** Every request and notification the client sent, in order. */
  readonly received: JsonObject[] = [];
  readonly #asked = new Map<string | number, Pending>();
  #nextAsk = 0;
  #turns = 0;
  /** The turn running now, as this server last reported it. */
  currentTurn: string | null = null;
  thread: string | null = null;
  /** The skill roots the client set, as `skills/extraRoots/set` last named them. */
  extraRoots: string[] = [];
  /** Whether periscope's hook is listed trusted now. */
  hookTrusted: boolean;
  /** Whether a thread has opened, after which a drifting hook has changed. */
  #threadOpened = false;

  constructor(options: FakeCodexOptions, cwd: string, write: (line: string) => void) {
    this.#options = options;
    this.#cwd = cwd;
    this.#write = write;
    const trust = options.hookTrust ?? 'trusted';
    this.hookTrusted = trust === 'trusted' || trust === 'disabled' || trust === 'drifts';
  }

  /** The hooks file periscope's hook is listed from. */
  get hooksPath(): string {
    return codexHookLines(this.#options.codexHome).hooksPath;
  }

  /** The run id Codex gives periscope's hook run for `toolUseId`. */
  hookRunId(toolUseId: string): string {
    return `pre-tool-use:0:${this.hooksPath}:${toolUseId}`;
  }

  /** Periscope's hook as `hooks/list` lists it now. */
  #ourHook(): JsonObject | null {
    const trust = this.#options.hookTrust ?? 'trusted';
    if (trust === 'absent') return null;
    const lines = codexHookLines(this.#options.codexHome);
    const drifted = trust === 'drifts' && this.#threadOpened;
    return {
      key: `${lines.hooksPath}:pre_tool_use:0:0`,
      eventName: 'preToolUse',
      handlerType: 'command',
      command: lines.listed,
      async: false,
      matcher: null,
      timeoutSec: CODEX_HOOK_TIMEOUT_SECONDS,
      statusMessage: null,
      additionalContextLimit: null,
      sourcePath: lines.hooksPath,
      source: 'user',
      pluginId: null,
      displayOrder: 0,
      enabled: trust !== 'disabled',
      isManaged: false,
      currentHash: drifted ? 'sha256:changed' : FAKE_HOOK_HASH,
      trustStatus: drifted ? 'modified' : this.hookTrusted ? 'trusted' : 'untrusted',
    };
  }

  get version(): string {
    return this.#options.version ?? '0.162.1';
  }

  /** The client requests that named `method`, in order. */
  requestsOf(method: string): JsonObject[] {
    return this.received.filter((message) => message['method'] === method && message['id'] !== undefined);
  }

  /** The client methods, in the order they were called or sent. */
  methods(): string[] {
    return this.received.map((message) => text(message['method']));
  }

  send(message: JsonObject): void {
    this.#write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params: JsonObject): void {
    this.send({ method, params });
  }

  /** A request from the server; resolves with what the client answered. */
  ask(method: string, params: JsonObject, id?: string | number): Promise<JsonObject> {
    this.#nextAsk += 1;
    const key = id ?? `ask-${this.#nextAsk}`;
    return new Promise<JsonObject>((resolve) => {
      this.#asked.set(key, { resolve });
      this.send({ id: key, method, params });
    });
  }

  /** The running turn ends: `turn/completed` with `status`. */
  completeTurn(status = 'completed', error: JsonObject | null = null): void {
    const id = this.currentTurn ?? `turn-${this.#turns}`;
    this.currentTurn = null;
    this.notify('turn/completed', {
      threadId: this.thread ?? '',
      turn: { id, status, error, items: [], durationMs: 12 },
    });
  }

  receive(message: JsonObject): void {
    const id = message['id'];
    const method = message['method'];
    if (typeof method !== 'string') {
      // An answer to a request this server sent.
      if (typeof id === 'string' || typeof id === 'number') {
        const pending = this.#asked.get(id);
        this.#asked.delete(id);
        pending?.resolve(message);
      }
      return;
    }
    this.received.push(message);
    if (id === undefined) return;
    if (this.#options.silent?.includes(method) === true) return;
    const failure = this.#options.fail?.[method];
    if (failure !== undefined) {
      this.send({ id, error: { code: failure.code, message: failure.message } });
      return;
    }
    const params = (message['params'] ?? {}) as JsonObject;
    this.#answer(id as string | number, method, params);
  }

  #answer(id: string | number, method: string, params: JsonObject): void {
    const reply = (result: JsonValue): void => this.send({ id, result });
    switch (method) {
      case 'initialize':
        return reply({
          userAgent: `periscope/${this.version} (Windows 10.0.26200; x86_64) test (periscope; ${text((params['clientInfo'] as JsonObject | undefined)?.['version'])})`,
          codexHome: this.#options.codexHome,
          platformFamily: 'windows',
          platformOs: 'windows',
        });
      case 'account/read':
        return reply({
          account: this.#options.account === undefined ? { type: 'apiKey' } : this.#options.account,
          requiresOpenaiAuth: this.#options.requiresOpenaiAuth ?? true,
        });
      case 'model/list':
        return reply({ data: [...(this.#options.models ?? FAKE_MODELS)], nextCursor: null });
      case 'thread/start':
      case 'thread/resume':
      case 'thread/fork': {
        const base = this.#options.threadId ?? 'thread-1';
        const thread =
          method === 'thread/fork'
            ? `${base}-fork`
            : method === 'thread/resume'
              ? text(params['threadId'])
              : base;
        this.thread = thread;
        this.#threadOpened = true;
        const config = (params['config'] ?? {}) as JsonObject;
        reply({
          thread: {
            id: thread,
            cliVersion: this.version,
            sessionId: thread,
            forkedFromId: null,
            parentThreadId: null,
            ephemeral: false,
            status: { type: 'idle' },
            turns: [],
          },
          model: typeof params['model'] === 'string' ? params['model'] : (this.#options.model ?? 'gpt-6-sol'),
          modelProvider: 'openai',
          cwd: this.#options.cwd ?? this.#cwd,
          instructionSources: [],
          approvalPolicy:
            typeof params['approvalPolicy'] === 'string' ? params['approvalPolicy'] : 'on-request',
          approvalsReviewer: 'user',
          sandbox: { type: 'workspaceWrite' },
          reasoningEffort:
            typeof config['model_reasoning_effort'] === 'string'
              ? config['model_reasoning_effort']
              : 'medium',
        });
        this.notify('thread/started', { thread: { id: thread, cliVersion: this.version } });
        return;
      }
      case 'skills/extraRoots/set': {
        const roots = params['extraRoots'];
        this.extraRoots = Array.isArray(roots)
          ? roots.filter((root): root is string => typeof root === 'string')
          : [];
        reply({});
        this.notify('skills/changed', {});
        return;
      }
      case 'skills/list':
        return reply(
          this.#options.skills ?? {
            data: [
              {
                cwd: this.#cwd,
                skills:
                  this.extraRoots.length === 0
                    ? [{ name: 'example:skill' }]
                    : this.extraRoots.flatMap((root) =>
                        rootSkills(root).map((name) => ({ name, path: root })),
                      ),
                errors: [],
              },
            ],
          },
        );
      case 'hooks/list': {
        const ours = this.#ourHook();
        return reply({
          data: [
            {
              cwd: this.#cwd,
              hooks: [...(ours === null ? [] : [ours]), ...(this.#options.foreignHooks ?? [])],
              warnings: [],
              errors: [],
            },
          ],
        });
      }
      case 'config/batchWrite': {
        const edits = Array.isArray(params['edits']) ? (params['edits'] as JsonObject[]) : [];
        const ours = this.#ourHook();
        const trusts = edits.some((edit) => {
          const value = (edit['value'] ?? {}) as JsonObject;
          const entry =
            ours === null
              ? undefined
              : (value[typeof ours['key'] === 'string' ? ours['key'] : ''] as JsonObject | undefined);
          return (
            edit['keyPath'] === 'hooks.state' &&
            edit['mergeStrategy'] === 'upsert' &&
            entry?.['trusted_hash'] === ours?.['currentHash']
          );
        });
        if (trusts && (this.#options.hookTrust ?? 'trusted') !== 'stuck') this.hookTrusted = true;
        return reply({
          status: 'ok',
          version: 'v2',
          filePath: join(this.#options.codexHome, 'config.toml'),
          overriddenMetadata: null,
        });
      }
      case 'config/read':
        return reply({
          config: {},
          origins: {},
          layers:
            this.#options.projectLayer === true
              ? [
                  {
                    name: { type: 'project', dotCodexFolder: join(this.#cwd, '.codex') },
                    version: 'v1',
                    config: {},
                  },
                ]
              : [],
        });
      case 'windowsSandbox/readiness':
        return reply({ status: this.#options.sandboxReadiness ?? 'ready' });
      case 'mcpServerStatus/list':
        return reply({ data: [{ name: 'docs', runtimeStatus: 'connected' }], nextCursor: null });
      case 'turn/start': {
        this.#turns += 1;
        const turn = `turn-${this.#turns}`;
        this.currentTurn = turn;
        reply({ turn: { id: turn, status: 'inProgress', items: [], error: null } });
        if (this.#options.announceTurns !== false) {
          this.notify('turn/started', {
            threadId: this.thread ?? '',
            turn: { id: turn, status: 'inProgress', items: [] },
          });
        }
        return;
      }
      case 'turn/interrupt':
        reply({});
        if (this.currentTurn !== null) this.completeTurn('interrupted');
        return;
      default:
        this.send({ id, error: { code: -32601, message: `${method} is not handled by the fake` } });
    }
  }
}

/**
 * The skills one root lists, named as Codex names a skill under a plugin root: the name of the
 * manifest at the root, a colon, and the skill's directory under `skills/`. A root with no manifest
 * lists its skills bare.
 */
function rootSkills(root: string): string[] {
  const manifest = join(root, '.claude-plugin', 'plugin.json');
  const named = existsSync(manifest)
    ? (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name
    : null;
  const skills = join(root, 'skills');
  if (!existsSync(skills)) return [];
  return readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skills, entry.name, 'SKILL.md')))
    .map((entry) => (typeof named === 'string' && named !== '' ? `${named}:${entry.name}` : entry.name));
}

export interface FakeCodex {
  readonly server: FakeCodexServer;
  readonly child: FakeChild;
  /** Pass as the runtime's `spawn`. */
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  ) => ChildProcess;
}

/** A fake app-server on an in-process child. Its cwd is the one the child is spawned with. */
export function fakeCodex(options: FakeCodexOptions): FakeCodex {
  const child = fakeChild();
  const spawnChild = spawnerFor(child);
  let server: FakeCodexServer | null = null;
  const holder = {
    get server(): FakeCodexServer {
      if (server === null) throw new Error('the fake app-server has not been spawned');
      return server;
    },
  };
  child.onLine((message) => server?.receive(message));
  return {
    get server() {
      return holder.server;
    },
    child,
    spawn: (command, args, spawnOptions) => {
      const started = spawnChild(command, args, spawnOptions);
      server = new FakeCodexServer(options, spawnOptions.cwd, (line) => child.write(line));
      return started;
    },
  };
}
