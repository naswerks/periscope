/**
 * A child process that speaks one JSON value per line on its stdio, with an envelope of its own.
 *
 * The line half of `stdio-rpc.ts`, for a runtime whose protocol is not JSON-RPC: this file frames,
 * writes and ends, and hands every decoded value to the runtime's adapter, which owns the envelope.
 * It shares the JSON-RPC peer's framing (`JsonLineDecoder`), its stderr splitter, its spawner and its
 * process-tree kill, so both close a child the same way.
 *
 * What it holds to:
 * - The child is spawned with an explicit argv and no shell; a batch file is refused by name.
 * - Inbound framing tolerates `\r\n`, a value split across chunks, several values in one chunk and a
 *   character split across chunks. A line that is not JSON is dropped and named (`rpc-line-malformed`),
 *   a line past the bound is dropped whole and named (`rpc-line-too-large`); neither ends the peer.
 * - Values reach the adapter in arrival order.
 * - Closing ends stdin, waits a grace period for the child to exit, then kills its process tree, as the
 *   JSON-RPC peer does. Idempotent.
 */
import type { ChildProcess } from 'node:child_process';

import type { JsonValue } from '../control/frames.js';
import type { Refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { ChildExit, SpawnChild } from './stdio-rpc.js';
import {
  JsonLineDecoder,
  LineSplitter,
  MAX_RPC_LINE_BYTES,
  RPC_CLOSE_GRACE_MS,
  defaultSpawn,
  isBatchFile,
  killProcessTree,
} from './stdio-rpc.js';

export interface StdioLinesOptions {
  /** The program, by path. Never a batch file. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The child's whole environment: nothing is inherited beside it. */
  readonly env: Readonly<Record<string, string>>;
  /** One decoded value from the child's stdout, in arrival order. */
  readonly onValue?: (value: JsonValue) => void;
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

/** A started child speaking one JSON value per line. */
export class StdioLinePeer {
  readonly #options: StdioLinesOptions;
  readonly #child: ChildProcess;
  readonly #decoder: JsonLineDecoder;
  readonly #stderr: LineSplitter;
  readonly #exited: Promise<ChildExit>;
  #resolveExit: (exit: ChildExit) => void = () => undefined;
  #exit: ChildExit | null = null;
  #closing: Promise<void> | null = null;

  /** Use `startStdioLines`, which refuses a batch file before anything is spawned. */
  private constructor(options: StdioLinesOptions) {
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
  static start(options: StdioLinesOptions): StdioLinePeer {
    return new StdioLinePeer(options);
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

  /** Write one value as one line. False when the peer has ended or its stdin cannot take it. */
  send(value: JsonValue): boolean {
    if (this.ended) return false;
    const stdin = this.#child.stdin;
    if (stdin === null || stdin.destroyed || stdin.writableEnded) return false;
    stdin.write(`${JSON.stringify(value)}\n`);
    return true;
  }

  /**
   * End the peer: stdin ends, the child is given the grace period to exit, then its process tree is
   * killed. Idempotent: every call returns the same promise.
   */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
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
    this.#options.onExit?.(exit);
    this.#resolveExit(exit);
  }

  #accept(decoded: Result<JsonValue>): void {
    if (!decoded.ok) {
      this.#options.onRefusal?.(decoded.refusal);
      return;
    }
    this.#options.onValue?.(decoded.value);
  }
}

/**
 * Start a child and speak one JSON value per line to it. Refuses a batch file as the child, before
 * anything is spawned: it would run only through a shell.
 */
export function startStdioLines(options: StdioLinesOptions): Result<StdioLinePeer> {
  if (isBatchFile(options.command)) {
    return refuse(
      'rpc-request-failed',
      `${options.command} is a batch file, which runs only through a shell; name the program it runs`,
    );
  }
  return ok(StdioLinePeer.start(options));
}
