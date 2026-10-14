/**
 * Qwen Code's control envelope over a line peer: the requests this host sends the CLI and their
 * answers, the requests the CLI sends this host and theirs, and every other line handed on as a stream
 * message.
 *
 * The envelope, as the pinned CLI reads and writes it:
 * - A request is `{ type: 'control_request', request_id, request: { subtype, … } }`, in either
 *   direction.
 * - Its answer is `{ type: 'control_response', response: { subtype: 'success', request_id, response } }`
 *   or `{ …, response: { subtype: 'error', request_id, error } }`.
 * - A user message is `{ type: 'user', message: { role: 'user', content } }`.
 *
 * What it holds to:
 * - Every request this host sends carries an id and a deadline this host chose; no answer by then is
 *   `rpc-request-timed-out`, an error answer is `rpc-request-failed`.
 * - Every request the CLI sends is answered, and a handler that throws is answered with an error,
 *   which the CLI reads as a refusal: a permission request it cannot get an answer to is cancelled, so
 *   the call does not run.
 * - A cancel the CLI sends for one of its requests aborts the handler's signal.
 * - A line that is not one Qwen message is dropped and named; the peer keeps running.
 */
import type { JsonObject, JsonValue } from '../control/frames.js';
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { StdioLinePeer } from './stdio-lines.js';
import { startStdioLines } from './stdio-lines.js';
import type { ChildExit, SpawnChild } from './stdio-rpc.js';
import type { QwenHostRequest } from './qwen-wire.js';

/** How the CLI's request is answered: a response, or an error in words. */
export type QwenControlAnswer = { readonly response: JsonObject } | { readonly error: string };

export interface QwenControlOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The child's whole environment: nothing is inherited beside it. */
  readonly env: Readonly<Record<string, string>>;
  /** Every stream message, in arrival order. */
  readonly onMessage: (message: JsonObject) => void;
  /** Answers one request the CLI sent. Its signal aborts when the CLI cancels the request. */
  readonly onControlRequest: (
    subtype: string,
    request: JsonObject,
    requestId: string,
    signal: AbortSignal,
  ) => Promise<QwenControlAnswer>;
  readonly onStderr?: (line: string) => void;
  /** A line that was dropped, by name. The peer keeps running. */
  readonly onRefusal?: (refusal: Refusal) => void;
  readonly onExit?: (exit: ChildExit) => void;
  readonly spawn?: SpawnChild;
  readonly killTree?: (pid: number) => Promise<void>;
  readonly closeGraceMs?: number;
}

interface Pending {
  readonly subtype: string;
  readonly settle: (result: Result<JsonObject>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A started Qwen CLI, spoken to through its control envelope. */
export class QwenControl {
  readonly #options: QwenControlOptions;
  readonly #peer: StdioLinePeer;
  readonly #pending = new Map<string, Pending>();
  readonly #inbound = new Map<string, AbortController>();
  #nextId = 0;

  private constructor(options: QwenControlOptions, peer: StdioLinePeer) {
    this.#options = options;
    this.#peer = peer;
  }

  /** Start the CLI. Refuses what the line peer refuses: a batch file as the program. */
  static start(options: QwenControlOptions): Result<QwenControl> {
    const holder: { control: QwenControl | null } = { control: null };
    const started = startStdioLines({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      onValue: (value) => {
        const control = holder.control;
        if (control !== null) control.#accept(value);
      },
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      ...(options.onRefusal === undefined ? {} : { onRefusal: options.onRefusal }),
      onExit: (exit) => {
        const control = holder.control;
        if (control !== null) control.#ended(exit);
        options.onExit?.(exit);
      },
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.killTree === undefined ? {} : { killTree: options.killTree }),
      ...(options.closeGraceMs === undefined ? {} : { closeGraceMs: options.closeGraceMs }),
    });
    if (!started.ok) return started;
    const control = new QwenControl(options, started.value);
    holder.control = control;
    return ok(control);
  }

  /** The child's pid, or null when it never started. */
  get pid(): number | null {
    return this.#peer.pid;
  }

  /** True once the child has exited or close was asked. */
  get ended(): boolean {
    return this.#peer.ended;
  }

  /**
   * Send a request and wait for its answer, at most `deadlineMs`. Never throws: every way it can fail
   * is a named refusal.
   */
  request(subtype: QwenHostRequest, payload: JsonObject, deadlineMs: number): Promise<Result<JsonObject>> {
    if (this.#peer.ended)
      return Promise.resolve(refuse('rpc-request-failed', `${subtype}: the CLI has ended`));
    this.#nextId += 1;
    const requestId = `periscope-${this.#nextId}`;
    return new Promise<Result<JsonObject>>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve(refuse('rpc-request-timed-out', `${subtype} met no answer within ${deadlineMs} ms`));
      }, deadlineMs);
      this.#pending.set(requestId, { subtype, settle: resolve, timer });
      const sent = this.#peer.send({
        type: 'control_request',
        request_id: requestId,
        request: { ...payload, subtype },
      });
      if (!sent) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        resolve(refuse('rpc-request-failed', `${subtype}: the CLI's input is closed`));
      }
    });
  }

  /** Send one user message. False when the CLI's input is closed. */
  sendUser(text: string): boolean {
    return this.#peer.send({ type: 'user', message: { role: 'user', content: text } });
  }

  /**
   * End the CLI: its input ends, it is given the grace period to exit, then its process tree is killed.
   * Requests still waiting are refused, and the CLI's own requests still being decided are aborted.
   */
  close(): Promise<void> {
    this.#refuseWaiting('the CLI was closed before it answered');
    for (const controller of this.#inbound.values()) controller.abort();
    this.#inbound.clear();
    return this.#peer.close();
  }

  #ended(exit: ChildExit): void {
    const how =
      exit.error ?? (exit.signal === null ? `exit code ${String(exit.code)}` : `signal ${exit.signal}`);
    this.#refuseWaiting(`the CLI ended before it answered (${how})`);
    for (const controller of this.#inbound.values()) controller.abort();
    this.#inbound.clear();
  }

  #refuseWaiting(detail: string): void {
    for (const [requestId, waiting] of this.#pending) {
      clearTimeout(waiting.timer);
      this.#pending.delete(requestId);
      waiting.settle(refuse('rpc-request-failed', `${waiting.subtype}: ${detail}`));
    }
  }

  #accept(value: JsonValue): void {
    if (!isObject(value) || typeof value['type'] !== 'string') {
      this.#options.onRefusal?.(
        refusal('rpc-line-malformed', 'an inbound line is not one Qwen stream-json message'),
      );
      return;
    }
    switch (value['type']) {
      case 'control_request':
        this.#answerRequest(value);
        return;
      case 'control_response':
        this.#settle(value);
        return;
      case 'control_cancel_request': {
        const requestId = value['request_id'];
        if (typeof requestId === 'string' && requestId !== '') {
          this.#inbound.get(requestId)?.abort();
        } else {
          for (const controller of this.#inbound.values()) controller.abort();
        }
        return;
      }
      default:
        this.#options.onMessage(value);
    }
  }

  #settle(value: JsonObject): void {
    const response = value['response'];
    if (!isObject(response) || typeof response['request_id'] !== 'string') {
      this.#options.onRefusal?.(refusal('rpc-line-malformed', 'a control response names no request id'));
      return;
    }
    const requestId = response['request_id'];
    const waiting = this.#pending.get(requestId);
    // An answer after its deadline has already been reported as timed out.
    if (waiting === undefined) return;
    clearTimeout(waiting.timer);
    this.#pending.delete(requestId);
    if (response['subtype'] === 'success') {
      const answer = response['response'];
      waiting.settle(ok(isObject(answer) ? answer : {}));
      return;
    }
    const error = response['error'];
    const message =
      typeof error === 'string'
        ? error
        : isObject(error) && typeof error['message'] === 'string'
          ? error['message']
          : 'no message';
    waiting.settle(refuse('rpc-request-failed', `${waiting.subtype} answered with an error: ${message}`));
  }

  #answerRequest(value: JsonObject): void {
    const requestId = value['request_id'];
    const request = value['request'];
    if (typeof requestId !== 'string' || requestId === '' || !isObject(request)) {
      this.#options.onRefusal?.(
        refusal('rpc-line-malformed', 'a control request from the CLI names no request id or request'),
      );
      return;
    }
    const subtype = typeof request['subtype'] === 'string' ? request['subtype'] : '';
    const controller = new AbortController();
    this.#inbound.set(requestId, controller);
    void this.#options
      .onControlRequest(subtype, request, requestId, controller.signal)
      .catch((error: unknown): QwenControlAnswer => ({
        error: `the host failed to answer: ${describe(error)}`,
      }))
      .then((answer) => {
        this.#inbound.delete(requestId);
        this.#peer.send({
          type: 'control_response',
          response:
            'response' in answer
              ? { subtype: 'success', request_id: requestId, response: answer.response }
              : { subtype: 'error', request_id: requestId, error: answer.error },
        });
      });
  }
}
