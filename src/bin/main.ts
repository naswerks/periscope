/**
 * The composition root, and the only place this package reads the environment.
 *
 * Everything below takes its configuration as arguments. That is what makes the rest of the
 * package testable without a process, and it is why "where does this value come from?" has one
 * answer instead of one per module. `main` itself takes the environment and the process edges as
 * arguments for the same reason; `bin/periscope.ts` is the one line that hands it the real ones.
 */
import { readConfigFile, withConfigFallback } from '../host/config-file.js';
import { packageVersion } from '../host/package-facts.js';
import { USAGE, readCommand } from './command.js';
import { runConfig } from './config.js';
import { runLogin } from './login.js';
import { runPair } from './pair.js';
import type { ServeOutcome, ServeViews } from './serve.js';
import { runServe } from './serve.js';
import { runStatus } from './status.js';

/** The process edges. `processIo()` is the real set; a test supplies recording ones. */
export interface Io {
  /** One stdout line, without its newline. */
  readonly stdout: (line: string) => void;
  /** One stderr line, without its newline. */
  readonly stderr: (line: string) => void;
  readonly setExitCode: (code: number) => void;
  /** The verbs, replaceable so the dispatch is testable without a provider, a controller or a host. */
  readonly runLogin?: typeof runLogin;
  readonly runPair?: typeof runPair;
  readonly runConfig?: typeof runConfig;
  readonly serve?: (views: ServeViews) => ServeOutcome;
  readonly runStatus?: typeof runStatus;
  /** The package version, replaceable so the dispatch test does not read the manifest. */
  readonly version?: () => string;
}

/** The real process edges: stdout, stderr and the exit code. The verbs take their defaults. */
export function processIo(): Io {
  return {
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

/**
 * The config file fills absences, and only absences, for every verb that consumes configuration
 * (`serve`, `login`, `pair`), which is what makes USAGE's unconditional env-first-then-file
 * sentence true. The merged view is consulted for the closed key set only, so a deployment that
 * sets env vars is configured by them alone, and nothing outside that set (identity configuration,
 * the config dir itself) can arrive from a file. A file that exists and cannot be used is fatal
 * rather than silently empty: a corrupt file must not impersonate a deliberate absence (the paired
 * credential takes the same posture, for the same reason).
 *
 * `pair` belongs on that list: `PERISCOPE_DECISION_URL` is a legal config key and is exactly what
 * `redemptionUrl` derives the redemption door from, so a config-file-only machine handed raw env
 * would answer "nowhere to redeem the code" at the first step of the very flow the config verb was
 * built for. `login` reads no config key today; it rides the merged view so the help text's claim
 * is true by wiring rather than by coincidence.
 */
function environmentWithConfigFile(raw: NodeJS.ProcessEnv): NodeJS.ProcessEnv | string {
  const fileConfig = readConfigFile(raw);
  if (fileConfig.problem !== null) return fileConfig.problem;
  return withConfigFallback(raw, fileConfig.values);
}

/** `error` as one line, for a verb that threw instead of returning. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The command dispatch.
 *
 * `serve` runs synchronously, which is the path every supervisor takes. `login` and `pair` are the
 * asynchronous verbs; each returns its own promise so a caller can await the outcome, and nothing
 * about the daemon's start-up ordering depends on them. `raw` is the process environment as
 * received; the merged view, where the config file fills absences, is derived per verb.
 */
export function main(argv: readonly string[], raw: NodeJS.ProcessEnv, io: Io): Promise<void> | void {
  const command = readCommand(argv);

  if (command.kind === 'help') {
    io.stdout(USAGE);
    return;
  }

  if (command.kind === 'version') {
    io.stdout((io.version ?? packageVersion)());
    return;
  }

  if (command.kind === 'unknown') {
    // Named rather than defaulted to `serve` (see `readCommand`): a typo that silently starts a host
    // is discovered much later, as an empty token cache.
    io.stderr(`periscope: unknown command '${command.name}'\n\n${USAGE}`);
    io.setExitCode(1);
    return;
  }

  if (command.kind === 'login') {
    const env = environmentWithConfigFile(raw);
    if (typeof env === 'string') {
      io.stderr(`periscope: ${env}`);
      io.setExitCode(1);
      return;
    }
    // The interactive half is a separate act by design; the daemon never signs anyone in.
    return (io.runLogin ?? runLogin)(env).then(
      (result) => {
        if (!result.ok) {
          io.stderr(`periscope: login failed - ${result.refusal.reason} - ${result.refusal.detail}`);
          io.setExitCode(1);
        }
      },
      // `runLogin` returns refusals rather than throwing, so this branch is for the failure it did
      // not model. Without it a throw here would be an unhandled rejection followed by exit 0: a
      // sign-in that crashed reporting success to whoever scripted it.
      (error: unknown) => {
        io.stderr(`periscope: login failed - ${describe(error)}`);
        io.setExitCode(1);
      },
    );
  }

  if (command.kind === 'status') {
    const outcome = (io.runStatus ?? runStatus)({ raw, merged: environmentWithConfigFile(raw) });
    const sink = outcome.ok ? io.stdout : io.stderr;
    for (const line of outcome.lines) sink(outcome.ok ? line : `periscope: ${line}`);
    if (!outcome.ok) io.setExitCode(1);
    return;
  }
  if (command.kind === 'config') {
    // Synchronous by nature: one file read or one file write, no network, no process.
    //
    // Raw env, deliberately. This is the one verb that must never see the merged view, twice over:
    // its "currently overridden by the environment" marker exists to distinguish env from file,
    // and a merged env would mark every file value as overridden by itself; and this verb is the
    // escape hatch that makes fatal-on-corrupt safe everywhere else. A corrupt file must still
    // leave `periscope config` able to say which file is broken and why, rather than refusing
    // before the verb runs.
    const outcome = (io.runConfig ?? runConfig)(command.key, command.value, raw, command.unset);
    const sink = outcome.ok ? io.stdout : io.stderr;
    for (const line of outcome.lines) sink(line);
    if (!outcome.ok) io.setExitCode(1);
    return;
  }

  if (command.kind === 'pair') {
    if (command.problem !== null) {
      io.stderr(
        `periscope: ${command.problem} - usage: periscope pair <code> [--controller <origin>] [--label <name>]`,
      );
      io.setExitCode(1);
      return;
    }
    const env = environmentWithConfigFile(raw);
    if (typeof env === 'string') {
      io.stderr(`periscope: ${env}`);
      io.setExitCode(1);
      return;
    }
    // The same shape as `login`, for the same reasons, including the rejection branch, because a
    // pairing that crashed must not report success to whoever scripted it.
    return (io.runPair ?? runPair)(command.code, env, undefined, {
      controller: command.controller,
      label: command.label,
    }).then(
      (result) => {
        if (!result.ok) {
          io.stderr(`periscope: pair failed - ${result.detail}`);
          io.setExitCode(1);
        }
      },
      (error: unknown) => {
        io.stderr(`periscope: pair failed - ${describe(error)}`);
        io.setExitCode(1);
      },
    );
  }

  // The daemon reads two views: configuration from the merged one, credentials and the session
  // environment from the raw one. `runServe` says which reads which, and reports its own refusals.
  const serve = io.serve ?? ((views: ServeViews) => runServe(views, processServeDeps(io)));
  serve({ raw, merged: environmentWithConfigFile(raw) });
}

/** The daemon's edges over a caller-supplied `io`, with the process itself behind exit and signals. */
function processServeDeps(io: Io): Parameters<typeof runServe>[1] {
  return {
    log: io.stdout,
    stderr: io.stderr,
    setExitCode: io.setExitCode,
    exit: (code) => process.exit(code),
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
  };
}
