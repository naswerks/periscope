/**
 * The shell backstop — two layers, and the second exists because the first was insufficient.
 *
 * A shell command cannot be proven safe by looking at a path, so this is the only control over what
 * a shell tool call can reach outside the workspace. Both layers run; either one refusing is enough.
 *
 *   Layer 1, the boundary rules. Named boundary operations — publishing, remote surgery, branch
 *   deletion, a hard reset, merging — read from the parsed invocation: the program, its subcommand and
 *   its option tokens, never a word anywhere in the string. A word inside a path (`remote` in
 *   `fields/edit-remote-work`, `push` in `logs/pre-push.log`) is part of that path's token and cannot
 *   complete a rule. Where a command sits inside another program's words rather than at a command
 *   position (`ssh host "git push"`, a pager named in `-c core.pager=…`), the same rules read it from
 *   those words: that is the residual check, and it is what keeps an unknown executor refusing.
 *
 *   Layer 2, the git verb allowlist. This layer is not redundancy; it closes a real defect class.
 *   `git send-pack` — the plumbing that `git push` calls underneath — matches no boundary rule, and a
 *   denylist-only classifier approved it as benign shell, which force-pushed a main branch under an
 *   automated actor. A denylist under-includes by construction: it can only refuse what somebody
 *   thought of. So a git invocation whose verb is not provably safe is refused without enumeration,
 *   which covers `send-pack`, `receive-pack`, aliases, and every verb git ships in a future release.
 *
 * Both layers read git wherever it runs: at a command position, behind a launcher (`env git
 * send-pack`), and as its dashed binary (`git-send-pack.exe`).
 *
 * The input is parsed, not raw — see `command.ts` for the defects a raw scan produces. Message prose and
 * provably-inert data payloads are set aside by the parser, which narrows what is read and never what
 * is denied.
 *
 * The rule that decides every ambiguous case: a false refusal costs one human click; a false allow
 * costs the invariant. Every unknown shape in this file resolves toward refusing.
 */
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import type { Invocation, ParsedCommand } from './command.js';
import { invocationOf, parseCommand, programNameOf } from './command.js';

/**
 * A named boundary rule and the shape of one invocation it recognises.
 *
 * The name reaches the model verbatim in the refusal detail, because a refusal that does not say
 * which rule fired leaves the reader to guess, and a degrade is a named outcome. Receipts cite the
 * names, so they do not change.
 */
interface BoundaryRule {
  readonly name: string;
  readonly fires: (invocation: Invocation) => boolean;
  readonly detail: string;
}

/** An invocation's words after its program: its global flags and their arguments, its verb, its arguments. */
function wordsOf(invocation: Invocation): string[] {
  return [
    ...invocation.globalFlags.flatMap((flag) =>
      flag.argument === null ? [flag.flag] : [flag.flag, flag.argument],
    ),
    ...(invocation.verb === null ? [] : [invocation.verb]),
    ...invocation.args,
  ];
}

/** The words that are not options, in order. */
const positional = (words: readonly string[]): string[] => words.filter((word) => !word.startsWith('-'));

/** Does `words` hold `sequence` as adjacent entries? */
function holdsAdjacent(words: readonly string[], sequence: readonly string[]): boolean {
  for (let i = 0; i + sequence.length <= words.length; i += 1) {
    if (sequence.every((word, offset) => words[i + offset] === word)) return true;
  }
  return false;
}

/**
 * Is `token` the long option `name`, or a prefix of it at least `shortest` characters long? git and the
 * Azure CLI both accept an unambiguous abbreviation, so `--del` is `--delete` to git.
 */
function isLongOption(token: string, name: string, shortest: number): boolean {
  const flag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
  return flag.startsWith('--') && flag.length >= shortest && name.startsWith(flag);
}

/**
 * The value an option was given: `--name value`, `--name=value` or an abbreviation of the name. The
 * value has its quotes removed and its case folded; it is `''` when the option stands bare and null
 * when it could expand (`$`, a backtick), which no rule here may read as a harmless value. Undefined
 * when the option is absent.
 */
function optionValue(words: readonly string[], name: string, shortest: number): string | null | undefined {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as string;
    if (!isLongOption(word, name, shortest)) continue;
    const raw = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[i + 1];
    if (raw === undefined || (!word.includes('=') && raw.startsWith('-'))) return '';
    if (raw.includes('$') || raw.includes('`')) return null;
    return raw.replace(/^["']|["']$/g, '').toLowerCase();
  }
  return undefined;
}

/** A `git branch` option that deletes: `-d`, `-D`, a short cluster carrying either, or `--delete`. */
const isBranchDeleteFlag = (token: string): boolean =>
  /^-[A-Za-z]*[dD][A-Za-z]*$/.test(token) || isLongOption(token, '--delete', 3);

/**
 * Does this `az` invocation complete an Azure DevOps pull request? `az repos pr update` with a status
 * other than `abandoned` or `active`, or `az repos pr create|update` with auto-complete set to anything
 * but `false`. A bare option, or a value that could expand, counts as completing.
 *
 * The known limit, as for `gh`: a raw REST call (`az rest`, `az devops invoke`) that completes a pull
 * request is not parsed here, as a raw `gh api` call is not.
 */
function completesAzurePullRequest(invocation: Invocation): boolean {
  const words = wordsOf(invocation);
  const commands = positional(words);
  const updating = holdsAdjacent(commands, ['repos', 'pr', 'update']);
  if (!updating && !holdsAdjacent(commands, ['repos', 'pr', 'create'])) return false;
  if (updating) {
    const status = optionValue(words, '--status', 4);
    if (status !== undefined && status !== 'abandoned' && status !== 'active') return true;
  }
  const autoComplete = optionValue(words, '--auto-complete', 3);
  return autoComplete !== undefined && autoComplete !== 'false';
}

/** The boundary rules, in match order. */
const BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    name: 'git-push',
    // The verb itself: `push`, and `http-push`, which publishes over HTTP. `stash push` is a stash. The
    // plumbing forms (`send-pack`, `receive-pack`) are the allowlist's to refuse, below.
    fires: (invocation) =>
      invocation.program === 'git' &&
      invocation.verb !== null &&
      (invocation.verb === 'push' || invocation.verb.endsWith('-push')),
    detail: 'publishing to a remote is a human decision, not an agent one',
  },
  {
    name: 'git-remote-surgery',
    // The read-only forms are exempt, and the exemption is exactly these shapes: `-v`, `--verbose`,
    // `show`, and the bare list. Everything mutating still refuses — `add`, `set-url`, `set-head`,
    // `set-branches`, `rename`, `remove`, `prune`, `update`. `get-url` is read-only and still refuses on
    // purpose: an exemption set that grows by inference is how a boundary erodes. `ls-remote` is a
    // query, and its own verb.
    fires: (invocation) =>
      invocation.program === 'git' && invocation.verb === 'remote' && !isReadOnlyRemote(invocation.args),
    detail: 'changing where this repository publishes is a human decision',
  },
  {
    name: 'git-branch-delete',
    // Plain `git branch`, `--show-current` and `checkout -b` all flow; `git push --delete` is caught by
    // the publish rule above. The flag is read from this invocation's own words, so a downstream
    // `tr -d ' '` cannot lend it one.
    fires: (invocation) =>
      invocation.program === 'git' &&
      invocation.verb === 'branch' &&
      invocation.args.some(isBranchDeleteFlag),
    detail: 'deleting a branch destroys history a human may still need',
  },
  {
    name: 'git-reset-hard',
    // `reset` sits in the safe verbs because a soft or mixed reset moves nothing a commit cannot
    // recover; `--hard` discards the working tree and the index, and `reset --hard <ref>` moves the
    // branch as well.
    fires: (invocation) =>
      invocation.program === 'git' &&
      invocation.verb === 'reset' &&
      invocation.args.some((token) => isLongOption(token, '--hard', 4)),
    detail: 'discarding uncommitted work and moving the branch is a human decision',
  },
  {
    name: 'gh-pr-merge',
    // `pr merge` anywhere in the words that are not options, so `gh -R owner/repo pr merge 5` still
    // parks. A raw `gh api` call that merges is not parsed here.
    fires: (invocation) =>
      invocation.program === 'gh' && holdsAdjacent(positional(wordsOf(invocation)), ['pr', 'merge']),
    detail: 'merging is a human boundary',
  },
  {
    name: 'az-repos-pr-complete',
    fires: (invocation) => invocation.program === 'az' && completesAzurePullRequest(invocation),
    detail: 'merging is a human boundary',
  },
];

/**
 * Programs that run the command named in their own arguments, and nothing else of their own. Behind one
 * of these, git is read as git: `env git send-pack` is `git send-pack`. A closed, named list — extend it
 * by entry. The command inside is read from the first git, `gh` or `az` word after the launcher, so a
 * launcher's options never need a grammar here; the cost is that a git word given to another program
 * behind a launcher (`timeout 10 rg git src`) is read as git and refused, one click.
 */
const LAUNCHERS: ReadonlySet<string> = new Set([
  'env',
  'sudo',
  'doas',
  'nohup',
  'nice',
  'ionice',
  'time',
  'timeout',
  'stdbuf',
  'command',
  'exec',
  'xargs',
  'watch',
  'start',
]);

/** The programs the boundary rules read. */
const RULED_PROGRAMS: ReadonlySet<string> = new Set(['git', 'gh', 'az']);

/** `git-<verb>` as a program: the dashed binary git runs its own subcommands through. */
const DASHED_GIT = /^git-([a-z][a-z0-9-]*)$/;

/** An invocation's program as the rules read it: a dashed git binary is git, with its suffix as the verb. */
function normalised(invocation: Invocation): Invocation {
  const dashed = DASHED_GIT.exec(invocation.program);
  if (dashed === null) return invocation;
  return {
    program: 'git',
    globalFlags: [],
    verb: dashed[1] as string,
    args: wordsOf(invocation),
    dataPayloads: invocation.dataPayloads,
  };
}

const isRuledWord = (word: string): boolean => {
  const program = programNameOf(word);
  return RULED_PROGRAMS.has(program) || DASHED_GIT.test(program);
};

/**
 * Every invocation the rules read: each one the parser found, each git behind a launcher, and each
 * dashed binary read as git.
 */
function reach(invocations: readonly Invocation[]): Invocation[] {
  const reached: Invocation[] = [];
  for (const parsed of invocations) {
    reached.push(normalised(parsed));
    if (!LAUNCHERS.has(parsed.program)) continue;
    const words = wordsOf(parsed);
    const start = words.findIndex(isRuledWord);
    if (start >= 0) reached.push(normalised(invocationOf(words.slice(start))));
  }
  return reached;
}

/**
 * Where a ruled program's name can appear inside another's words. Quotes, expansion characters and
 * separators end a word here — `ssh host "git push"` and `-c core.pager='git push'` both hold a git
 * word — while `-`, `.`, `/` and `\` do not, so a path is one word and `pre-push.log` holds no push.
 */
const RESIDUAL_SPLIT = /[\s"'`=$(){}[\];|&<>,]+/;

/**
 * The residual check: a git, `gh` or `az` word inside any invocation's words — the arguments of a
 * program this file does not know, a global flag's value, an argument git hands to a pager — is read as
 * the start of a command and given the boundary rules. Layer 1 only: reading a git word in a search as
 * a git invocation for the allowlist would refuse `rg git src` for naming git.
 */
function residualRefusal(invocations: readonly Invocation[]): BoundaryRule | null {
  for (const invocation of invocations) {
    const words = wordsOf(invocation)
      .flatMap((word) => word.split(RESIDUAL_SPLIT))
      .filter((word) => word !== '');
    for (let i = 0; i < words.length; i += 1) {
      if (!isRuledWord(words[i] as string)) continue;
      const nested = normalised(invocationOf(words.slice(i)));
      const rule = BOUNDARY_RULES.find((candidate) => candidate.fires(nested));
      if (rule !== undefined) return rule;
    }
  }
  return null;
}

/**
 * Git verbs that are known-safe: reads, local-only writes, and download-only network.
 *
 * The organising idea is publish. None of these can send anything to a remote, which is why
 * `fetch`, `pull` and `ls-remote` sit here despite touching the network, and why `commit` does too —
 * a local commit publishes nothing.
 *
 * Exact-case: git subcommands are lowercase, so a cased oddity is not proven safe and refuses.
 */
const ALLOWED_GIT_VERBS: ReadonlySet<string> = new Set([
  // reads
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'describe',
  'blame',
  'grep',
  'shortlog',
  'reflog',
  'ls-files',
  'ls-tree',
  'cat-file',
  'merge-base',
  'rev-list',
  'check-ignore',
  'check-attr',
  'for-each-ref',
  // `merge-tree` writes the merged tree's objects to the object store and moves no ref, so it publishes
  // nothing, as `hash-object` below does not.
  'merge-tree',
  // read-only terminal flags, surfaced as the verb when nothing else is: git prints and exits.
  '--version',
  '--help',
  // local-only writes. `branch -d` and friends are already refused by the rules above.
  'add',
  'commit',
  'restore',
  'checkout',
  'switch',
  'branch',
  'stash',
  'init',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'reset',
  'rm',
  'mv',
  'tag',
  'clean',
  'apply',
  // `hash-object` sits with the local writes rather than the reads, and the placement is the point.
  // Its common form only prints a sha, but `-w` writes a loose object — and this allowlist is
  // verb-level, so admitting the verb admits `-w`. It qualifies on the same ground `init` does: an
  // unreferenced loose object cannot publish anything.
  'hash-object',
  // download-only network — cannot publish.
  'fetch',
  'pull',
  'ls-remote',
]);

/** `git config` flags that only read. Exact tokens, never prefixes. */
const CONFIG_READ_FLAGS: ReadonlySet<string> = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--get-color',
  '--get-colorbool',
  '--list',
  '-l',
]);

/** `git config` flags that mutate. If present, refuse, even beside a read flag. */
const CONFIG_WRITE_FLAGS: ReadonlySet<string> = new Set([
  '--add',
  '--unset',
  '--unset-all',
  '--replace-all',
  '--set-all',
  '--edit',
  '-e',
  '--rename-section',
  '--remove-section',
  '--default',
]);

/** git 2.46's `git config` subcommands that only read. */
const CONFIG_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(['get', 'list']);

/** The `git remote` shapes that only print. The same three the boundary rule exempts. */
const REMOTE_READ_FLAGS: ReadonlySet<string> = new Set(['-v', '--verbose']);

/**
 * `git config` is a read verb and a write verb wearing one name, so it cannot sit in the allowlist:
 * a bare `git config user.email you@example` is a write and reads identically to a query without
 * this rule. Only the provably-reading shapes are admitted: a read flag; git 2.46's `get` and `list`;
 * and a bare read, which is exactly one argument that is not an option, shaped `section.key`. The dot
 * is what refuses `git config edit` (one argument, and on git 2.46 it opens an editor on the file), and
 * the single argument is what refuses `set`, `unset`, `rename-section`, `remove-section` and a value.
 */
function isReadOnlyConfig(args: readonly string[]): boolean {
  if (args.some((argument) => CONFIG_WRITE_FLAGS.has(argument))) return false;
  if (args.some((argument) => CONFIG_READ_FLAGS.has(argument))) return true;
  const words = positional(args);
  if (words.length > 0 && CONFIG_READ_SUBCOMMANDS.has(words[0] as string)) return true;
  return words.length === 1 && (words[0] as string).includes('.');
}

/**
 * `git remote`, same problem and same treatment. Admitted: the bare list, `-v`/`--verbose`, and
 * `show <name>`. Anything else — a subcommand, an unknown flag — is not proven read-only and refuses.
 *
 * Both layers must agree before a remote command flows. The vocabulary is stated twice on purpose
 * rather than shared through one looser predicate: two independent statements of the same three
 * shapes cannot both be widened by accident.
 */
function isReadOnlyRemote(args: readonly string[]): boolean {
  for (const argument of args) {
    if (argument === 'show') return true;
    if (REMOTE_READ_FLAGS.has(argument)) continue;
    return false;
  }
  return true;
}

/** `git worktree` only lists: `add`, `remove`, `prune`, `move`, `lock` and the rest change the repository. */
function isReadOnlyWorktree(args: readonly string[]): boolean {
  return positional(args)[0] === 'list';
}

function isAllowedGitInvocation(verb: string, args: readonly string[]): boolean {
  if (ALLOWED_GIT_VERBS.has(verb)) return true;
  if (verb === 'config') return isReadOnlyConfig(args);
  if (verb === 'remote') return isReadOnlyRemote(args);
  if (verb === 'worktree') return isReadOnlyWorktree(args);
  return false;
}

// ---------------------------------------------------------------------------

/**
 * Classify a shell command. Returns the refusal that fired, or null when nothing did.
 *
 * `parsed` may be supplied by a caller that already parsed the command — the credential check does,
 * and parsing twice would be work for nothing.
 */
export function classifyShellCommand(
  command: string,
  parsed: ParsedCommand = parseCommand(command),
): Refusal | null {
  // A POSIX reading with an escaped blank is read both ways — split, and joined as a POSIX shell joins
  // it — and refused when either refuses, so reading the escape can only add a refusal.
  const refused = classifyReading(parsed);
  if (refused !== null || parsed.escapedReading === undefined) return refused;
  return classifyReading(parsed.escapedReading);
}

function classifyReading(parsed: ParsedCommand): Refusal | null {
  const reached = reach(parsed.invocations);

  // Layer 1 — the boundary rules, over every invocation the parse reaches, then over the commands
  // that sit inside other programs' words.
  for (const invocation of reached) {
    const rule = BOUNDARY_RULES.find((candidate) => candidate.fires(invocation));
    if (rule !== undefined) return refusal('shell-boundary-command', `${rule.name}: ${rule.detail}`);
  }
  const residual = residualRefusal(parsed.invocations);
  if (residual !== null) return refusal('shell-boundary-command', `${residual.name}: ${residual.detail}`);

  // Layer 2 — the git verb allowlist. Non-git invocations are not this layer's business; shell
  // commands as a whole are covered by the workspace jail, this file, and the audit trail together.
  //
  // It is deliberately git-only. Extending an allowlist posture to another program is a boundary
  // decision that belongs to the embedder's policy (`ToolFamilies`, the local gate's options), not
  // to this file.
  for (const invocation of reached) {
    if (invocation.program !== 'git') continue;
    if (invocation.verb === null) {
      return refusal(
        'shell-verb-unrecognised',
        'a git invocation with no determinable verb cannot be shown to be safe, so it is refused',
      );
    }
    if (!isAllowedGitInvocation(invocation.verb, invocation.args)) {
      return refusal(
        'shell-verb-unrecognised',
        `git ${invocation.verb} is not a verb this host can prove is safe; the allowlist refuses ` +
          'anything it cannot name, which is what covers the plumbing forms of publishing',
      );
    }
  }

  return null;
}
