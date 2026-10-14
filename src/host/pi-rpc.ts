/**
 * pi's RPC envelope over a line peer: the commands this host sends pi and their answers, and every other
 * line handed on as an event or a record.
 *
 * The envelope, as the pinned release reads and writes it:
 * - A command is `{ id, type: '<command>', … }`. Its answer is `{ id, type: 'response', command, success,
 *   data | error }`, carrying the command's id; pi answers some commands only when they are done (`abort`
 *   waits for the turn to stop), and `prompt` as soon as it is accepted.
 * - Everything else pi writes is an event (`{ type: '<event>', … }`), an extension's UI request or an
 *   extension's error.
 *
 * What it holds to:
 * - Every command this host sends carries an id and a deadline this host chose; no answer by then is
 *   `rpc-request-timed-out`. An answer that says it failed is an answer, handed back whole: a failed
 *   `prompt` is how pi says a model cannot be reached.
 * - An extension's UI request that waits for an answer (a choice, a confirmation, a text) is answered at
 *   once, cancelled: nobody here answers a dialog, and an unanswered one would wait forever. One that
 *   only informs is handed on.
 * - A line that is not one pi message is dropped and named; the peer keeps running.
 */
import type { JsonObject, JsonValue } from '../control/frames.js';
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { PiHostCommand } from './pi-wire.js';
import { PI_DIALOG_METHODS } from './pi-wire.js';
import type { StdioLinePeer } from './stdio-lines.js';
import { startStdioLines } from './stdio-lines.js';
import type { ChildExit, SpawnChild } from './stdio-rpc.js';

export interface PiRpcOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The child's whole environment: nothing is inherited beside it. */
  readonly env: Readonly<Record<string, string>>;
  /** Every event, in arrival order. */
  readonly onEvent: (event: JsonObject) => void;
  /** Every extension UI request and extension error, in arrival order, after any answer it took. */
  readonly onRecord: (record: JsonObject) => void;
  readonly onStderr?: (line: string) => void;
  /** A line that was dropped, by name. The peer keeps running. */
  readonly onRefusal?: (refusal: Refusal) => void;
  readonly onExit?: (exit: ChildExit) => void;
  readonly spawn?: SpawnChild;
  readonly killTree?: (pid: number) => Promise<void>;
  readonly closeGraceMs?: number;
}

interface Pending {
  readonly command: PiHostCommand;
  readonly settle: (result: Result<JsonObject>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A started pi, spoken to through its RPC envelope. */
export class PiRpc {
  readonly #options: PiRpcOptions;
  readonly #peer: StdioLinePeer;
  readonly #pending = new Map<string, Pending>();
  #nextId = 0;

  private constructor(options: PiRpcOptions, peer: StdioLinePeer) {
    this.#options = options;
    this.#peer = peer;
  }

  /** Start pi. Refuses what the line peer refuses: a batch file as the program. */
  static start(options: PiRpcOptions): Result<PiRpc> {
    const holder: { rpc: PiRpc | null } = { rpc: null };
    const started = startStdioLines({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      onValue: (value) => {
        const rpc = holder.rpc;
        if (rpc !== null) rpc.#accept(value);
      },
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      ...(options.onRefusal === undefined ? {} : { onRefusal: options.onRefusal }),
      onExit: (exit) => {
        const rpc = holder.rpc;
        if (rpc !== null) rpc.#ended(exit);
        options.onExit?.(exit);
      },
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.killTree === undefined ? {} : { killTree: options.killTree }),
      ...(options.closeGraceMs === undefined ? {} : { closeGraceMs: options.closeGraceMs }),
    });
    if (!started.ok) return started;
    const rpc = new PiRpc(options, started.value);
    holder.rpc = rpc;
    return ok(rpc);
  }

  /** The child's pid, or null when it never started. */
  get pid(): number | null {
    return this.#peer.pid;
  }

  /** True once the child has exited or close was asked. */
  get ended(): boolean {
    return this.#peer.ended;
  }

  /** Settles once, when the child has exited and its output has been read to the end. */
  get exited(): Promise<ChildExit> {
    return this.#peer.exited;
  }

  /**
   * Send a command and wait for its answer, at most `deadlineMs`. The answer is handed back whole,
   * whether it says it succeeded or failed. Never throws: no answer is a named refusal.
   */
  request(command: PiHostCommand, payload: JsonObject, deadlineMs: number): Promise<Result<JsonObject>> {
    if (this.#peer.ended) return Promise.resolve(refuse('rpc-request-failed', `${command}: pi has ended`));
    this.#nextId += 1;
    const id = `periscope-${this.#nextId}`;
    return new Promise<Result<JsonObject>>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve(refuse('rpc-request-timed-out', `${command} met no answer within ${deadlineMs} ms`));
      }, deadlineMs);
      this.#pending.set(id, { command, settle: resolve, timer });
      if (!this.#peer.send({ ...payload, id, type: command })) {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(refuse('rpc-request-failed', `${command}: pi's input is closed`));
      }
    });
  }

  /**
   * End pi: its input ends, it is given the grace period to exit, then its process tree is killed.
   * Commands still waiting are refused.
   */
  close(): Promise<void> {
    this.#refuseWaiting('pi was closed before it answered');
    return this.#peer.close();
  }

  #ended(exit: ChildExit): void {
    const how =
      exit.error ?? (exit.signal === null ? `exit code ${String(exit.code)}` : `signal ${exit.signal}`);
    this.#refuseWaiting(`pi ended before it answered (${how})`);
  }

  #refuseWaiting(detail: string): void {
    for (const [id, waiting] of this.#pending) {
      clearTimeout(waiting.timer);
      this.#pending.delete(id);
      waiting.settle(refuse('rpc-request-failed', `${waiting.command}: ${detail}`));
    }
  }

  #accept(value: JsonValue): void {
    if (!isObject(value) || typeof value['type'] !== 'string' || value['type'] === '') {
      this.#options.onRefusal?.(refusal('rpc-line-malformed', 'an inbound line is not one pi RPC message'));
      return;
    }
    switch (value['type']) {
      case 'response':
        this.#settle(value);
        return;
      case 'extension_ui_request':
        this.#answerDialog(value);
        this.#options.onRecord(value);
        return;
      case 'extension_error':
        this.#options.onRecord(value);
        return;
      default:
        this.#options.onEvent(value);
    }
  }

  #settle(value: JsonObject): void {
    const id = value['id'];
    const waiting = typeof id === 'string' ? this.#pending.get(id) : undefined;
    if (typeof id !== 'string' || waiting === undefined) {
      // An answer to no command this host is waiting on: one past its deadline, already reported as
      // timed out, or pi's answer to a line it could not read. Handed on as a record either way.
      if (typeof id !== 'string') this.#options.onRecord(value);
      return;
    }
    clearTimeout(waiting.timer);
    this.#pending.delete(id);
    waiting.settle(ok(value));
  }

  #answerDialog(value: JsonObject): void {
    const id = value['id'];
    const method = value['method'];
    if (typeof id !== 'string' || typeof method !== 'string' || !PI_DIALOG_METHODS.includes(method)) return;
    this.#peer.send({ type: 'extension_ui_response', id, cancelled: true });
  }
}
