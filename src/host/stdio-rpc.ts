/**
 * A line-delimited JSON-RPC peer over a child process's stdio.
 *
 * The transport for a runtime this host drives through a protocol server rather than a library: one
 * JSON value per line in each direction on stdin and stdout, the child's stderr read line by line.
 * It knows nothing about any one runtime. A runtime's adapter names the methods, answers the requests
 * the child sends, and reads the notifications; this file only frames, correlates and ends.
 *
 * What it holds to:
 * - The child is spawned with an explicit argv and no shell. A batch file runs only through a shell,
 *   so one is refused as the child by name; name the program it runs.
 * - Inbound framing tolerates `\r\n`, a value split across chunks, several values in one chunk, and a
 *   character split across chunks. A line that is not one JSON-RPC message is dropped and named
 *   (`rpc-line-malformed`); a line past `MAX_RPC_LINE_BYTES` is dropped whole and named
 *   (`rpc-line-too-large`). Neither ends the peer.
 * - Every request this host sends carries an integer id, `jsonrpc: "2.0"` and a deadline this host
 *   chose: the peer may impose none. No answer by then is `rpc-request-timed-out`; an error answer is
 *   `rpc-request-failed`, or `rpc-server-overloaded` for the overload code.
 * - Notifications and requests from the child reach their handlers in arrival order, a notification
 *   that arrives before the answer to the request that caused it included. A request the handler
 *   does not answer, or the absence of a handler, is answered `-32601`: the child's request is never
 *   left waiting, and an error answer is a refusal on the child's side.
 * - Closing ends stdin, waits for the child to exit, then kills its process tree. Idempotent.
 */
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

import type { JsonObject, JsonValue } from '../control/frames.js';
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';

/**
 * The longest inbound line this host reads, in bytes. The peer imposes no cap of its own, and one of
 * its messages can carry a command's whole output, so the bound is this host's.
 */
export const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024;

/** How long a child is given to exit after its stdin ends, before its process tree is killed. */
export const RPC_CLOSE_GRACE_MS = 5000;

/** The JSON-RPC code for a method the receiver does not handle. */
export const RPC_METHOD_NOT_FOUND = -32601;

/** The JSON-RPC code for an error inside the receiver's own handler. */
export const RPC_INTERNAL_ERROR = -32603;

/** The code a peer answers with when it is too busy to take a request. */
export const RPC_SERVER_OVERLOADED = -32001;

/** A request id: an integer from this host, a string or an integer from the child. */
export type RpcId = string | number;

export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
}

/** What a handler answers a request from the child with. */
export type RpcAnswer = { readonly result: JsonValue } | { readonly error: RpcError };

/** One inbound message, classified. */
export type RpcInbound =
  | { readonly kind: 'request'; readonly id: RpcId; readonly method: string; readonly params: JsonObject }
  | { readonly kind: 'notification'; readonly method: string; readonly params: JsonObject }
  | { readonly kind: 'answer'; readonly id: RpcId; readonly result: JsonValue }
  | { readonly kind: 'error'; readonly id: RpcId | null; readonly error: RpcError };

/** How the child ended. */
export interface ChildExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** Set when the child never started, or its stdio failed: the error's message. */
  readonly error: string | null;
}

/** The spawner seam: how the child is started. The default is `child_process.spawn` with no shell. */
export type SpawnChild = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
) => ChildProcess;

export interface StdioRpcOptions {
  /** The program, by path. Never a batch file. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The child's whole environment: nothing is inherited beside it. */
  readonly env: Readonly<Record<string, string>>;
  readonly onNotification?: (method: string, params: JsonObject) => void;
  /** Answers a request from the child. Absent, every request is answered `-32601`. */
  readonly onRequest?: (method: string, params: JsonObject, id: RpcId) => RpcAnswer | Promise<RpcAnswer>;
  /** One line of the child's stderr. */
  readonly onStderr?: (line: string) => void;
  /** An inbound line that was dropped, by name. The peer keeps running. */
  readonly onRefusal?: (refusal: Refusal) => void;
  readonly onExit?: (exit: ChildExit) => void;
  readonly closeGraceMs?: number;
  readonly maxLineBytes?: number;
  readonly spawn?: SpawnChild;
  /** How a process tree is killed. The default is `killProcessTree`. */
  readonly killTree?: (pid: number) => Promise<void>;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const LINE_HEAD_CHARS = 120;
/** A stderr line longer than this is passed on in pieces of this size. */
const LINE_PIECE_CHARS = 64 * 1024;

/**
 * Splits a byte stream into JSON values, one per line. Pure: it holds bytes and returns what each
 * chunk completes, so its behaviour over any chunking is checkable without a process.
 */
export class JsonLineDecoder {
  readonly #maxLineBytes: number;
  readonly #utf8 = new TextDecoder('utf-8', { fatal: true });
  #held: Uint8Array[] = [];
  #heldBytes = 0;
  /** True while discarding the rest of a line that already passed the bound. */
  #discarding = false;

  constructor(maxLineBytes: number = MAX_RPC_LINE_BYTES) {
    this.#maxLineBytes = maxLineBytes;
  }

  /** The values (or named refusals) the lines this chunk completes hold, in order. */
  push(chunk: Uint8Array): Result<JsonValue>[] {
    const out: Result<JsonValue>[] = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== NEWLINE) continue;
      this.#take(chunk.subarray(start, index), out);
      this.#complete(out);
      start = index + 1;
    }
    if (start < chunk.length) this.#take(chunk.subarray(start), out);
    return out;
  }

  /** The stream ended: a last line without its newline is still a line. */
  end(): Result<JsonValue>[] {
    const out: Result<JsonValue>[] = [];
    if (this.#heldBytes > 0 || this.#discarding) this.#complete(out);
    return out;
  }

  #take(bytes: Uint8Array, out: Result<JsonValue>[]): void {
    if (bytes.length === 0) return;
    if (this.#discarding) return;
    if (this.#heldBytes + bytes.length > this.#maxLineBytes + 1) {
      // One byte of slack for a carriage return the line ends with.
      this.#held = [];
      this.#heldBytes = 0;
      this.#discarding = true;
      out.push(
        refuse(
          'rpc-line-too-large',
          `an inbound line passed ${this.#maxLineBytes} bytes and was dropped whole`,
        ),
      );
      return;
    }
    this.#held.push(bytes.slice());
    this.#heldBytes += bytes.length;
  }

  #complete(out: Result<JsonValue>[]): void {
    if (this.#discarding) {
      this.#discarding = false;
      return;
    }
    let line = concat(this.#held, this.#heldBytes);
    this.#held = [];
    this.#heldBytes = 0;
    if (line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN) line = line.subarray(0, -1);
    if (line.length === 0) return;
    if (line.length > this.#maxLineBytes) {
      out.push(
        refuse(
          'rpc-line-too-large',
          `an inbound line passed ${this.#maxLineBytes} bytes and was dropped whole`,
        ),
      );
      return;
    }
    let text: string;
    try {
      text = this.#utf8.decode(line);
    } catch {
      out.push(refuse('rpc-line-malformed', 'an inbound line is not UTF-8'));
      return;
    }
    try {
      out.push(ok(JSON.parse(text) as JsonValue));
    } catch {
      out.push(refuse('rpc-line-malformed', `an inbound line is not JSON: ${head(text)}`));
    }
  }
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function head(text: string): string {
  return text.length <= LINE_HEAD_CHARS ? text : `${text.slice(0, LINE_HEAD_CHARS)}…`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is RpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
}

/** One decoded value as a JSON-RPC message, or a named refusal. A missing `params` reads as empty. */
export function classifyRpc(value: JsonValue): Result<RpcInbound> {
  if (!isObject(value)) return refuse('rpc-line-malformed', 'an inbound line is not a JSON object');
  const method = value['method'];
  const id = value['id'];
  const rawParams = value['params'];
  if (typeof method === 'string') {
    if (rawParams !== undefined && rawParams !== null && !isObject(rawParams)) {
      return refuse('rpc-line-malformed', `${method}: its params are not an object`);
    }
    const params = isObject(rawParams) ? rawParams : {};
    if (id === undefined) return ok({ kind: 'notification', method, params });
    if (!isId(id))
      return refuse('rpc-line-malformed', `${method}: its id is neither a string nor an integer`);
    return ok({ kind: 'request', id, method, params });
  }
  if ('result' in value) {
    if (!isId(id)) return refuse('rpc-line-malformed', 'an answer carries no usable id');
    return ok({ kind: 'answer', id, result: value['result'] });
  }
  const error = value['error'];
  if (isObject(error) && typeof error['code'] === 'number' && typeof error['message'] === 'string') {
    if (id !== null && !isId(id)) return refuse('rpc-line-malformed', 'an error answer carries no usable id');
    return ok({
      kind: 'error',
      id: id ?? null,
      error: {
        code: error['code'],
        message: error['message'],
        ...(error['data'] === undefined ? {} : { data: error['data'] }),
      },
    });
  }
  return refuse(
    'rpc-line-malformed',
    `an inbound object is no JSON-RPC message: ${head(JSON.stringify(value))}`,
  );
}

/** A batch file runs only through a shell, and this transport never builds a shell command. */
export function isBatchFile(command: string): boolean {
  return /\.(?:cmd|bat)$/i.test(command);
}

/** One row of the process table: a process and its parent. */
export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
}

/** Reads the process table once. A process that exits while it is read is left out. */
export type ReadProcessTable = () => Promise<readonly ProcessEntry[]>;

/** The two reads `/proc` is listed through, so the listing can be exercised without one. */
export interface ProcReads {
  readonly readdir: (path: string) => Promise<readonly string[]>;
  readonly readFile: (path: string) => Promise<string>;
}

const procReads: ProcReads = {
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path, 'utf8'),
};

/**
 * The parent pid in one `/proc/<pid>/stat` line, or null when the line cannot be read. The command
 * name is parenthesised and may hold spaces and parentheses itself, so the fields are counted from
 * the last `)`: the state, then the parent pid.
 */
export function parentOfStat(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const ppid = Number(
    stat
      .slice(close + 1)
      .trim()
      .split(/\s+/)[1],
  );
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
}

/**
 * The process table from `/proc`, or null where there is no `/proc` to list. A pid listed and gone
 * before its `stat` is read has exited, and is left out.
 */
export async function readProcTable(reads: ProcReads = procReads): Promise<ProcessEntry[] | null> {
  let names: readonly string[];
  try {
    names = await reads.readdir('/proc');
  } catch {
    return null;
  }
  const rows = await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map(async (name): Promise<ProcessEntry | null> => {
        try {
          const ppid = parentOfStat(await reads.readFile(`/proc/${name}/stat`));
          return ppid === null ? null : { pid: Number(name), ppid };
        } catch {
          return null;
        }
      }),
  );
  return rows.filter((row): row is ProcessEntry => row !== null);
}

/** The process table from `ps -A -o pid=,ppid=`, for a system with no `/proc`; empty if `ps` fails. */
export function readPsTable(): Promise<ProcessEntry[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        resolve([]);
        return;
      }
      const rows: ProcessEntry[] = [];
      for (const line of stdout.split('\n')) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(pid) && Number.isInteger(ppid))
          rows.push({ pid: pid as number, ppid: ppid as number });
      }
      resolve(rows);
    });
  });
}

/** The process table on this system: `/proc` where there is one, `ps` elsewhere. */
export const readProcessTable: ReadProcessTable = async () => (await readProcTable()) ?? readPsTable();

/**
 * Every descendant of `root` in `table`, breadth-first, so each parent comes before its children. A
 * process that is its own parent, and any tree not under `root`, is never reached. Pid 1 and lower are
 * never entered, even where a table lists one under `root`: through init the walk would reach every
 * process on the system.
 */
export function descendantsOf(root: number, table: readonly ProcessEntry[]): number[] {
  const children = new Map<number, number[]>();
  for (const { pid, ppid } of table) {
    if (pid === ppid || pid <= 1) continue;
    const siblings = children.get(ppid);
    if (siblings === undefined) children.set(ppid, [pid]);
    else siblings.push(pid);
  }
  const found: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** The seams `killProcessTree` is exercised through; each defaults to the real one. */
export interface KillTreeSeams {
  readonly platform?: NodeJS.Platform;
  readonly readTable?: ReadProcessTable;
  readonly signal?: (target: number) => void;
}

/**
 * Kill a process and every process under it. A process already gone is not an error.
 *
 * On Windows, `taskkill /T /F` walks the tree from the pid. Elsewhere the child is a process-group
 * leader, but a descendant may have started a group or a session of its own, which a signal to the
 * child's group never reaches. So the descendants are collected from the process table first, before
 * any signal (a killed parent's children are reparented, and a later walk cannot find them), and each
 * descendant's group and the descendant itself are killed, then the child's group. Pid 1 and lower
 * and this process are never signalled.
 */
export async function killProcessTree(pid: number, seams: KillTreeSeams = {}): Promise<void> {
  if ((seams.platform ?? process.platform) === 'win32') {
    return new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
  }
  const signal = seams.signal ?? ((target: number) => process.kill(target, 'SIGKILL'));
  const send = (target: number): void => {
    if (Math.abs(target) <= 1 || Math.abs(target) === process.pid) return;
    try {
      signal(target);
    } catch {
      // Gone already, or not a group leader: either way nothing is left to signal there.
    }
  };
  let table: readonly ProcessEntry[] = [];
  try {
    table = await (seams.readTable ?? readProcessTable)();
  } catch {
    // An unreadable table leaves the child's group, which is still signalled.
  }
  for (const descendant of descendantsOf(pid, table)) {
    send(-descendant);
    send(descendant);
  }
  send(-pid);
}

const defaultSpawn: SpawnChild = (command, args, options) =>
  nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    // A group leader elsewhere, so its group is signalled at close, beside its descendants.
    detached: process.platform !== 'win32',
  });

interface Pending {
  readonly method: string;
  readonly settle: (result: Result<JsonValue>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** A started child speaking line-delimited JSON-RPC. */
export class StdioRpcPeer {
  readonly #options: StdioRpcOptions;
  readonly #child: ChildProcess;
  readonly #decoder: JsonLineDecoder;
  readonly #stderr: LineSplitter;
  readonly #pending = new Map<number, Pending>();
  readonly #exited: Promise<ChildExit>;
  #resolveExit: (exit: ChildExit) => void = () => undefined;
  #nextId = 0;
  #exit: ChildExit | null = null;
  #closing: Promise<void> | null = null;

  /** Use `startStdioRpc`, which refuses a batch file before anything is spawned. */
  private constructor(options: StdioRpcOptions) {
    this.#options = options;
    this.#decoder = new JsonLineDecoder(options.maxLineBytes ?? MAX_RPC_LINE_BYTES);
    this.#stderr = new LineSplitter((line) => options.onStderr?.(line));
    this.#exited = new Promise<ChildExit>((resolve) => {
      this.#resolveExit = resolve;
    });
    const spawn = options.spawn ?? defaultSpawn;
    this.#child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env });
    this.#wire();
  }

  /** @internal */
  static start(options: StdioRpcOptions): StdioRpcPeer {
    return new StdioRpcPeer(options);
  }

  /** The child's pid, or null when it never started. */
  get pid(): number | null {
    return this.#child.pid ?? null;
  }

  /** Settles once, when the child has exited and its stdout has been read to the end. */
  get exited(): Promise<ChildExit> {
    return this.#exited;
  }

  /** True once the child has exited or close was asked. */
  get ended(): boolean {
    return this.#exit !== null || this.#closing !== null;
  }

  /**
   * Send a request and wait for its answer, at most `deadlineMs`. Never throws: every way it can fail
   * is a named refusal. `params` null sends a request with no `params` member, for a method that takes
   * none.
   */
  request(method: string, params: JsonObject | null, deadlineMs: number): Promise<Result<JsonValue>> {
    if (this.ended) {
      return Promise.resolve(refuse('rpc-request-failed', `${method}: the peer has ended`));
    }
    this.#nextId += 1;
    const id = this.#nextId;
    return new Promise<Result<JsonValue>>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve(refuse('rpc-request-timed-out', `${method} met no answer within ${deadlineMs} ms`));
      }, deadlineMs);
      this.#pending.set(id, { method, settle: resolve, timer });
      this.#write(params === null ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a notification. Dropped once the peer has ended. */
  notify(method: string, params: JsonObject): void {
    if (this.ended) return;
    this.#write({ jsonrpc: '2.0', method, params });
  }

  /**
   * End the peer: stdin ends, the child is given the grace period to exit, then its process tree is
   * killed. Idempotent: every call returns the same promise. Requests still waiting are refused.
   */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#refuseWaiting('the peer was closed before it answered');
    try {
      this.#child.stdin?.end();
    } catch {
      // A stdin that already failed is the exit's to report.
    }
    const grace = this.#options.closeGraceMs ?? RPC_CLOSE_GRACE_MS;
    const exitedInTime = await Promise.race([
      this.#exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), grace)),
    ]);
    const pid = this.#child.pid;
    // Elsewhere the group outlives its leader, so it is signalled whether or not the child left on
    // its own; on Windows a tree is walked from a live pid, so only a child still running is killed.
    if (pid !== undefined && (!exitedInTime || process.platform !== 'win32')) {
      await (this.#options.killTree ?? killProcessTree)(pid);
    }
    if (!exitedInTime) {
      await Promise.race([this.#exited, new Promise((resolve) => setTimeout(resolve, grace))]);
    }
  }

  #wire(): void {
    const child = this.#child;
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const decoded of this.#decoder.push(chunk)) this.#accept(decoded);
    });
    child.stderr?.on('data', (chunk: Buffer) => this.#stderr.push(chunk));
    child.stdin?.on('error', () => {
      // A write to a child that is gone; its exit reports it.
    });
    child.on('error', (error: Error) => this.#ended({ code: null, signal: null, error: error.message }));
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) =>
      this.#ended({ code, signal, error: null }),
    );
  }

  #ended(exit: ChildExit): void {
    if (this.#exit !== null) return;
    for (const decoded of this.#decoder.end()) this.#accept(decoded);
    this.#stderr.end();
    this.#exit = exit;
    this.#refuseWaiting(`the peer ended before it answered (${describeExit(exit)})`);
    this.#options.onExit?.(exit);
    this.#resolveExit(exit);
  }

  #refuseWaiting(detail: string): void {
    for (const [id, waiting] of this.#pending) {
      clearTimeout(waiting.timer);
      this.#pending.delete(id);
      waiting.settle(refuse('rpc-request-failed', `${waiting.method}: ${detail}`));
    }
  }

  #accept(decoded: Result<JsonValue>): void {
    if (!decoded.ok) {
      this.#options.onRefusal?.(decoded.refusal);
      return;
    }
    const classified = classifyRpc(decoded.value);
    if (!classified.ok) {
      this.#options.onRefusal?.(classified.refusal);
      return;
    }
    const message = classified.value;
    switch (message.kind) {
      case 'notification':
        this.#options.onNotification?.(message.method, message.params);
        return;
      case 'request':
        void this.#answer(message.id, message.method, message.params);
        return;
      case 'answer':
      case 'error':
        this.#settle(message);
        return;
    }
  }

  #settle(message: Extract<RpcInbound, { kind: 'answer' | 'error' }>): void {
    if (typeof message.id !== 'number') {
      if (message.kind === 'error') {
        this.#options.onRefusal?.(
          refusal(
            'rpc-request-failed',
            `the peer reported an error: ${message.error.code} ${message.error.message}`,
          ),
        );
      }
      return;
    }
    const waiting = this.#pending.get(message.id);
    // An answer after its deadline has already been reported as timed out.
    if (waiting === undefined) return;
    clearTimeout(waiting.timer);
    this.#pending.delete(message.id);
    if (message.kind === 'answer') {
      waiting.settle(ok(message.result));
      return;
    }
    const { code, message: text } = message.error;
    waiting.settle(
      refuse(
        code === RPC_SERVER_OVERLOADED ? 'rpc-server-overloaded' : 'rpc-request-failed',
        `${waiting.method} answered ${code}: ${text}`,
      ),
    );
  }

  async #answer(id: RpcId, method: string, params: JsonObject): Promise<void> {
    let answer: RpcAnswer;
    const handler = this.#options.onRequest;
    if (handler === undefined) {
      answer = { error: { code: RPC_METHOD_NOT_FOUND, message: `${method} is not handled here` } };
    } else {
      try {
        answer = await handler(method, params, id);
      } catch (error) {
        answer = {
          error: {
            code: RPC_INTERNAL_ERROR,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
    if ('result' in answer) {
      this.#write({ jsonrpc: '2.0', id, result: answer.result });
      return;
    }
    const { code, message, data } = answer.error;
    this.#write({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  #write(message: JsonObject): void {
    const stdin = this.#child.stdin;
    if (stdin === null || stdin.destroyed || stdin.writableEnded) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }
}

/**
 * Start a child and speak JSON-RPC to it. Refuses a batch file as the child, before anything is
 * spawned: it would run only through a shell.
 */
export function startStdioRpc(options: StdioRpcOptions): Result<StdioRpcPeer> {
  if (isBatchFile(options.command)) {
    return refuse(
      'rpc-request-failed',
      `${options.command} is a batch file, which runs only through a shell; name the program it runs`,
    );
  }
  return ok(StdioRpcPeer.start(options));
}

function describeExit(exit: ChildExit): string {
  if (exit.error !== null) return exit.error;
  if (exit.signal !== null) return `signal ${exit.signal}`;
  return `exit code ${String(exit.code)}`;
}

/** Splits stderr into lines; a line longer than the bound is passed on in pieces. */
class LineSplitter {
  readonly #emit: (line: string) => void;
  readonly #utf8 = new TextDecoder('utf-8');
  #held = '';

  constructor(emit: (line: string) => void) {
    this.#emit = emit;
  }

  push(chunk: Uint8Array): void {
    this.#held += this.#utf8.decode(chunk, { stream: true });
    let newline = this.#held.indexOf('\n');
    while (newline >= 0) {
      this.#emitLine(this.#held.slice(0, newline));
      this.#held = this.#held.slice(newline + 1);
      newline = this.#held.indexOf('\n');
    }
    while (this.#held.length > LINE_PIECE_CHARS) {
      this.#emitLine(this.#held.slice(0, LINE_PIECE_CHARS));
      this.#held = this.#held.slice(LINE_PIECE_CHARS);
    }
  }

  end(): void {
    this.#held += this.#utf8.decode();
    if (this.#held !== '') this.#emitLine(this.#held);
    this.#held = '';
  }

  #emitLine(line: string): void {
    try {
      this.#emit(line.endsWith('\r') ? line.slice(0, -1) : line);
    } catch {
      // A stderr listener's fault is not the peer's.
    }
  }
}
