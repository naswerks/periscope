/**
 * `periscope hook codex`: the command Codex runs as its one `PreToolUse` hook, once per tool call.
 *
 * It reads the event Codex writes to its standard input, asks the session's host over the hook channel,
 * and writes one of the two outputs Codex honours: nothing (the call proceeds) or a deny with a reason
 * (it is blocked). It always exits 0 and never writes to standard error.
 *
 * Codex lets a call proceed whenever its hook fails: a timeout, a crash, a non-zero exit, output it
 * cannot parse. So this command fails closed itself. Every path that is not a verified allow from the
 * host writes the deny: no channel in the environment, a channel that cannot be reached or closes early,
 * an answer that does not verify against the session's token, input that is not JSON or is too large, an
 * error thrown anywhere, and its own deadline, which expires inside Codex's timeout.
 *
 * It runs on every tool call, so it loads nothing but itself and the exchange module: the rest of this
 * package is never imported on this path.
 */
import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';

import {
  HOOK_CHANNEL_VARIABLE,
  HOOK_DEADLINE_VARIABLE,
  HOOK_EXCHANGE_VERSION,
  HOOK_EXPIRY_EVENT,
  HOOK_TOKEN_VARIABLE,
  MAX_HOOK_INPUT_BYTES,
  hookDeadlineMs,
  hookDenyOutput,
  hookOutputFor,
  readHookAnswer,
} from '../gate/hook-exchange.js';

/** The largest answer line this command reads. */
const MAX_ANSWER_BYTES = 64 * 1024;

/** How long `--probe` waits for its input. */
const PROBE_INPUT_DEADLINE_MS = 10_000;

/** The process edges, injectable so the exchange can be checked without a child process. */
export interface HookIo {
  readonly stdin: NodeJS.ReadableStream;
  /** Writes the output and calls `done` once it is flushed. An empty output writes nothing. */
  readonly write: (text: string, done: () => void) => void;
  readonly setExitCode: (code: number) => void;
  /** Opens the channel. Defaults to `node:net`'s `connect`. */
  readonly connect?: (address: string) => Socket;
  /** Registers a last resort for an error nothing else caught. Absent in a test. */
  readonly onFatal?: (handler: (error: unknown) => void) => void;
  /** This package's version, for `--probe`. */
  readonly version?: () => Promise<string>;
}

/** The real process edges. */
export function hookIo(): HookIo {
  return {
    stdin: process.stdin,
    write: (text, done) => {
      if (text === '') done();
      else process.stdout.write(text, () => done());
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
    onFatal: (handler) => {
      process.on('uncaughtException', handler);
      process.on('unhandledRejection', handler);
    },
    version: async () => (await import('../host/package-facts.js')).packageVersion(),
  };
}

/** Run `hook <runtime> [--probe]`. Resolves once the output is written. */
export function runHook(argv: readonly string[], env: NodeJS.ProcessEnv, io: HookIo): Promise<void> {
  const runtime = argv[1] ?? '';
  const probe = argv.slice(2).includes('--probe');

  return new Promise<void>((resolve) => {
    let finished = false;
    let socket: Socket | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const finish = (text: string): void => {
      if (finished) return;
      finished = true;
      if (deadline !== undefined) clearTimeout(deadline);
      socket?.destroy();
      stopReading();
      io.setExitCode(0);
      io.write(text, () => {
        io.setExitCode(0);
        resolve();
      });
    };
    const deny = (reason: string): void => finish(hookDenyOutput(reason));

    io.onFatal?.((error) => deny(`the hook failed while deciding this call: ${String(error)}`));

    const chunks: Buffer[] = [];
    let size = 0;
    const stopReading = (): void => {
      io.stdin.removeAllListeners('data');
      io.stdin.removeAllListeners('end');
      const destroyable = io.stdin as NodeJS.ReadableStream & { destroy?: () => void };
      destroyable.destroy?.();
    };

    if (probe) {
      // Prove the command starts through the runtime's shell and reads its input that way: the line
      // names this package's version and how many bytes arrived.
      deadline = setTimeout(() => finish(''), PROBE_INPUT_DEADLINE_MS);
      const report = (): void => {
        const version = io.version ?? (() => Promise.resolve('unknown'));
        version().then(
          (value) => finish(`periscope hook probe ${value} ${size}\n`),
          () => finish(`periscope hook probe unknown ${size}\n`),
        );
      };
      io.stdin.on('data', (chunk: Buffer | string) => {
        size += Buffer.byteLength(chunk);
      });
      io.stdin.on('end', report);
      io.stdin.on('error', report);
      return;
    }

    if (runtime !== 'codex') {
      deny(`this hook answers for codex, and was run for '${runtime}'`);
      return;
    }

    const deadlineMs = hookDeadlineMs(env[HOOK_DEADLINE_VARIABLE]);
    // Ref'd on purpose: it is what keeps this process alive until the host answers or the call is blocked.
    deadline = setTimeout(
      () =>
        deny(`${HOOK_EXPIRY_EVENT}: no decision from the host within ${deadlineMs}ms; the call did not run`),
      deadlineMs,
    );

    const ask = (event: unknown): void => {
      const address = env[HOOK_CHANNEL_VARIABLE];
      const token = env[HOOK_TOKEN_VARIABLE];
      if (address === undefined || address === '' || token === undefined || token === '') {
        deny("the hook channel is not set in this process's environment, so no decision can be asked for");
        return;
      }
      const nonce = randomBytes(16).toString('hex');
      let answer = Buffer.alloc(0);
      const open = io.connect ?? connect;
      try {
        socket = open(address);
      } catch (error) {
        deny(`the hook channel could not be opened: ${String(error)}`);
        return;
      }
      socket.on('error', (error) => deny(`the hook channel could not be reached: ${error.message}`));
      socket.on('close', () => deny('the hook channel closed before the host answered'));
      socket.on('connect', () => {
        const line = JSON.stringify({
          v: HOOK_EXCHANGE_VERSION,
          kind: 'decide',
          token,
          nonce,
          runtime,
          event,
        });
        socket?.write(`${line}\n`);
      });
      socket.on('data', (chunk: Buffer) => {
        answer = Buffer.concat([answer, chunk]);
        const newline = answer.indexOf(0x0a);
        if (newline === -1) {
          if (answer.length > MAX_ANSWER_BYTES) deny('the host answered with more than this hook reads');
          return;
        }
        const body = readHookAnswer(answer.subarray(0, newline).toString('utf8'), token, nonce);
        if (body === null) {
          deny("the host's answer did not verify against this session's token, so it is not believed");
          return;
        }
        finish(hookOutputFor(body));
      });
    };

    const tryParse = (final: boolean): void => {
      let event: unknown;
      try {
        event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        if (final) deny('the hook input is not one JSON value, so the call it describes cannot be decided');
        return;
      }
      // One complete value is all the runtime writes; reading further would wait on a stream that may
      // never end.
      stopReading();
      ask(event);
    };

    io.stdin.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > MAX_HOOK_INPUT_BYTES) {
        deny(`the hook input exceeded ${MAX_HOOK_INPUT_BYTES} bytes`);
        return;
      }
      chunks.push(buffer);
      // A JSON object can only be complete after a closing brace, so only then is a parse worth trying.
      if (buffer.toString('utf8').trimEnd().endsWith('}')) tryParse(false);
    });
    io.stdin.on('end', () => {
      if (!finished && socket === null) tryParse(true);
    });
    io.stdin.on('error', () => deny('the hook input could not be read'));
  });
}
