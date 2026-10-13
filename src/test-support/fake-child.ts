/**
 * An in-process stand-in for a child process speaking line-delimited JSON on its stdio. A test drives
 * it directly: it reads what the peer wrote to the child's stdin, writes bytes or messages to the
 * child's stdout and stderr, and ends the child. Nothing is spawned.
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import type { JsonObject } from '../control/frames.js';

export interface FakeChild {
  /** Pass as the spawner's return value. */
  readonly process: ChildProcess;
  /** Every line the peer wrote to the child's stdin, parsed, in order. */
  readonly received: JsonObject[];
  /** The command, arguments and options the child was spawned with. */
  spawned: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
  } | null;
  /** Called with each line the peer writes, after it is recorded. */
  onLine(listener: (message: JsonObject) => void): void;
  /** Bytes onto the child's stdout, exactly as given. */
  write(bytes: string | Uint8Array): void;
  /** One message onto the child's stdout, newline-terminated. */
  send(message: JsonObject): void;
  /** Text onto the child's stderr. */
  stderr(text: string): void;
  /** The child exits: its streams end, then `close` fires. */
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  /** Whether the peer ended the child's stdin. */
  readonly stdinEnded: boolean;
}

export function fakeChild(pid = 4242): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const received: JsonObject[] = [];
  const listeners: ((message: JsonObject) => void)[] = [];
  let pending = '';
  let stdinEnded = false;
  let exited = false;

  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString('utf8');
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line !== '') {
          const message = JSON.parse(line) as JsonObject;
          received.push(message);
          for (const listener of listeners) listener(message);
        }
        newline = pending.indexOf('\n');
      }
      callback();
    },
    final(callback) {
      stdinEnded = true;
      callback();
    },
  });

  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid,
    kill: () => true,
  }) as unknown as ChildProcess;

  const fake: FakeChild = {
    process: child,
    received,
    spawned: null,
    onLine(listener) {
      listeners.push(listener);
    },
    write(bytes) {
      stdout.write(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes));
    },
    send(message) {
      stdout.write(Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'));
    },
    stderr(text) {
      stderr.write(Buffer.from(text, 'utf8'));
    },
    exit(code, signal = null) {
      if (exited) return;
      exited = true;
      stdout.end();
      stderr.end();
      // `close` follows the streams' end, as a real child's does.
      setImmediate(() => emitter.emit('close', code, signal));
    },
    get stdinEnded() {
      return stdinEnded;
    },
  };
  return fake;
}

/** A spawner that hands back `child` and records how it was asked to start. */
export function spawnerFor(child: FakeChild) {
  return (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  ): ChildProcess => {
    child.spawned = { command, args, cwd: options.cwd, env: options.env };
    return child.process;
  };
}

/** Let every queued stream event and promise continuation run. */
export async function drain(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
}
