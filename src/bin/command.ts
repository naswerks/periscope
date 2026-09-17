/**
 * Which command the binary was asked for.
 *
 * Extracted out of the composition root so it can be called without starting a host, the same
 * reason, and the same shape, as `workspaces.ts`. `bin/periscope.ts` calls `main()` on load, so
 * importing it to test one function starts a host, opens a socket and spawns nothing useful. The
 * fix is to split the function out; it is not to add a startup guard to the entry point, because
 * changing production behaviour to make a test possible is how a suite starts describing a system
 * nobody ships.
 *
 * The parser is deliberately tiny and not an option library. This package's direct dependencies
 * are the agent SDK with its peer closure, `ws` and `zod`; a CLI framework for a handful of verbs
 * would be a new dependency in a package whose boundary claims are auditable from one directory.
 */

/** The verbs this binary answers to. Anything else is named rather than guessed at. */
export type Command =
  /** Run the host: dial the controller, serve sessions. The default, and what a supervisor starts. */
  | { readonly kind: 'serve' }
  /**
   * Acquire a token interactively and write it to the cache the daemon reads.
   *
   * Why the verb exists: `bin/serve.ts` never calls `signIn`. It builds a credential over the
   * file token cache and a refresher, so it presents a token that is already there, and nothing
   * else in this package ever writes one. An `npx`-installed host on someone's laptop with no way
   * to sign in is not a host; it is a process that reads an empty cache, refuses by name, and
   * (because the link is fail-open) connects with no headers at all.
   */
  | { readonly kind: 'login' }
  /**
   * Trade a pair code for this machine's durable credential and write it beside the token cache.
   *
   * An OIDC refresh token can expire after a period of inactivity, so an unattended host on the
   * `login` credential can quietly stop being able to dial. A paired credential has no clock; it
   * dies only when the controller revokes it, and that refusal is loud (the upgrade 401 is terminal
   * and the process exits naming it). `code: null` is the operator forgetting the argument, named
   * at parse so the message can say what to type.
   */
  | {
      readonly kind: 'pair';
      readonly code: string | null;
      /** `--controller <origin>`: where to redeem, and what the controller names its routes from. */
      readonly controller: string | null;
      /** `--label <name>`: what the controller lists this machine as; overrides the environment. */
      readonly label: string | null;
      /** An argument the parser could not place, named so the usage line can say what to type. */
      readonly problem: string | null;
    }
  /**
   * Read or write the config file the daemon falls back to.
   *
   * Why the verb exists: with every setting readable from the environment only, a user with no UI
   * and no supervisor has no way to configure a repository short of exporting variables into every
   * shell that starts the host. The file is a fallback (the environment still wins per key) and
   * nothing else in this package writes it. `key: null` lists the file; `value: null` reads one
   * key; both stated is a write.
   */
  | {
      readonly kind: 'config';
      readonly key: string | null;
      readonly value: string | null;
      /** `--unset <key>`: remove the key from the file. */
      readonly unset: boolean;
    }
  /** Print the package version. */
  | { readonly kind: 'version' }
  /** Say what the verbs are. */
  | { readonly kind: 'status' }
  | { readonly kind: 'help' }
  /** A verb this binary does not have. Named, never silently treated as `serve`. */
  | { readonly kind: 'unknown'; readonly name: string };

/**
 * Read the command from an argv tail (`process.argv.slice(2)`).
 *
 * No arguments means `serve`, and that is a contract rather than a preference: a supervisor or
 * container starts this binary with no arguments, so a bare invocation is the daemon.
 *
 * An unrecognised first argument is `unknown`, never `serve`. Falling back to the default would
 * mean `periscope logn` silently starts a host: the operator believes they are signing in, the
 * process dials out and starts accepting sessions, and the mistake surfaces much later as an empty
 * token cache. A typo must fail loudly at the only moment it is cheap to fix.
 */
export function readCommand(argv: readonly string[]): Command {
  const first = argv[0];

  if (first === undefined || first === '') return { kind: 'serve' };

  switch (first) {
    case 'serve':
      return { kind: 'serve' };
    case 'login':
      return { kind: 'login' };
    case 'pair':
      return readPairArguments(argv.slice(1));
    case 'config': {
      if (argv[1] === '--unset') {
        const key = argv[2];
        return {
          kind: 'config',
          key: key === undefined || key === '' ? null : key,
          value: null,
          unset: true,
        };
      }
      const key = argv[1];
      const value = argv[2];
      return {
        kind: 'config',
        key: key === undefined || key === '' ? null : key,
        value: value === undefined || value === '' ? null : value,
        unset: false,
      };
    }
    case 'version':
    case '--version':
    case '-v':
      return { kind: 'version' };
    case 'status':
      return { kind: 'status' };
    case 'help':
    case '--help':
    case '-h':
      return { kind: 'help' };
    default:
      return { kind: 'unknown', name: first };
  }
}

/** The two flags `pair` takes. A closed set: anything else starting with `--` is a problem, never the code. */
const PAIR_FLAGS = ['--controller', '--label'] as const;

/**
 * `pair`'s tail: one positional (the code) and two optional flags, each as `--flag value` or
 * `--flag=value`. Hand-rolled for the same reason the whole parser is: two flags do not earn an
 * option library. An unknown `--x` is a problem rather than the code, so a typo'd flag cannot be
 * sent to the controller as a pair code and refused there with the wrong message.
 */
function readPairArguments(rest: readonly string[]): Command {
  let code: string | null = null;
  let controller: string | null = null;
  let label: string | null = null;
  let problem: string | null = null;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? '';
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=');
      const name = equals === -1 ? argument : argument.slice(0, equals);
      if (!(PAIR_FLAGS as readonly string[]).includes(name)) {
        problem ??= `unknown option '${name}'`;
        continue;
      }
      let value: string | undefined;
      if (equals === -1) {
        value = rest[index + 1];
        index += 1;
      } else {
        value = argument.slice(equals + 1);
      }
      if (value === undefined || value === '') {
        problem ??= `${name} needs a value`;
        continue;
      }
      if (name === '--controller') controller = value;
      else label = value;
      continue;
    }
    if (argument === '') continue;
    if (code === null) code = argument;
    else problem ??= `unexpected argument '${argument}'`;
  }

  return { kind: 'pair', code, controller, label, problem };
}

/** What `help` prints. Kept beside the parser so a new verb cannot be added without a line here. */
export const USAGE = [
  'periscope — hosts Claude Code sessions for a remote controller.',
  '',
  'Usage:',
  '  periscope [serve]        Dial the controller and serve sessions (the default).',
  '  periscope login          Sign in and write the token cache this host presents.',
  '  periscope pair <code> [--controller <origin>] [--label <name>]',
  "                           Trade a pair code for this machine's durable credential. The controller",
  '                           origin names where to redeem and writes the link URLs to the config file;',
  '                           the label is what the controller lists this machine as.',
  '  periscope config                 Show the config file and every value in it.',
  '  periscope config <key> [value]   Read one config value, or write it.',
  '  periscope config --unset <key>   Remove one config value from the file.',
  '  periscope status         Say what this host is: its link, credential, ids, workspace and where',
  '                           each setting came from. Reads what serve left behind; never dials.',
  '  periscope version        Print the package version.',
  '  periscope help           Show this.',
  '',
  'Configuration is read from the environment first, then the config file (the environment wins);',
  'see README.md.',
].join('\n');
