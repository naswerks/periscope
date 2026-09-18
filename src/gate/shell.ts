/**
 * The shell backstop — two layers, and the second exists because the first was insufficient.
 *
 * A shell command cannot be proven safe by looking at a path, so this is the only control over what
 * a shell tool call can reach outside the workspace. Both layers run; either one refusing is enough.
 *
 *   Layer 1, the denylist. Named boundary operations — publishing, remote surgery, branch deletion,
 *   merging — matched over the whole scannable text with `[\s\S]`, so a newline cannot hide one
 *   inside a compound command.
 *
 *   Layer 2, the git verb allowlist. This layer is not redundancy; it closes a real defect class.
 *   `git send-pack` — the plumbing that `git push` calls underneath — matches no denylist pattern,
 *   and a denylist-only classifier approved it as benign shell, which force-pushed a main branch
 *   under an automated actor. A denylist under-includes by construction: it can only refuse what
 *   somebody thought of. So a git invocation whose verb is not provably safe is refused without
 *   enumeration, which covers `send-pack`, `receive-pack`, aliases, and every verb git ships in a
 *   future release.
 *
 * The input is parsed, not raw — see `command.ts` for the defects a raw scan produces. Layer 1
 * scans `ParsedCommand.scannable`, which is the raw command minus comments and provably-inert data
 * payloads; layer 2 reads the parsed invocations. That narrows what is scanned and never what is
 * denied.
 *
 * The rule that decides every ambiguous case: a false refusal costs one human click; a false allow
 * costs the invariant. Every unknown shape in this file resolves toward refusing.
 */
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import type { ParsedCommand } from './command.js';
import { parseCommand } from './command.js';

/**
 * A named boundary rule and the pattern that recognises it.
 *
 * The name reaches the model verbatim in the refusal detail, because a refusal that does not say
 * which rule fired leaves the reader to guess, and a degrade is a named outcome.
 */
interface BoundaryRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly detail: string;
  /**
   * Evaluate the pattern per top-level command segment rather than over the whole string.
   *
   * The segmentation is the authority for what one command is; these patterns keep sole authority
   * for which shapes of one command refuse. A whole-string scan lets a flag belonging to a piped
   * command complete a pattern that began in an earlier one: `git branch -r --contains <sha> | tr
   * -d ' '` refused as "branch deletion" because the `-d` came from `tr`. That is a read-only
   * listing, and refusing it costs a human click for nothing.
   *
   * Narrows what is scanned, never what is denied. A match inside any single segment still
   * refuses; only cross-segment stitches — which the segmentation rules to be two commands — are
   * discarded, and layer 2 is untouched either way.
   */
  readonly segmentScoped?: boolean;
}

/**
 * Separators that end one top-level command, mirroring `command.ts`'s own set.
 *
 * Quote spans are not tracked here on purpose: an unbalanced or quoted separator yields more
 * segments, and more segments can only ever make a pattern harder to satisfy... which would be the
 * wrong direction. So the split runs over `scannable`, whose inert payloads are already masked, and
 * a segment that cannot be determined is scanned as part of a larger one — the refusing direction.
 */
const SEGMENT_SPLIT = /[|&;\n\r()`]+/;

/** Does `pattern` match inside any single top-level segment of `text`? */
function matchesInAnySegment(pattern: RegExp, text: string): boolean {
  return text.split(SEGMENT_SPLIT).some((segment) => pattern.test(segment));
}

/**
 * The denylist, in match order. `[\s\S]` rather than `.` throughout: a compound command spanning a
 * newline must not be able to hide a boundary operation behind the line break.
 */
const BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    name: 'git-push',
    // The lookbehind excises exactly one token pair: `stash push`. `git stash push -- <paths>` is the
    // only canonical partial-stash form, and it parsed as a publish — so that operation was literally
    // unperformable. A stash cannot publish anything, and layer 2 admits `stash` as a known-safe verb.
    // The exclusion is whole-token (a bare `\b` matches inside a hyphenated token, so `my-stash push`
    // had the suffix of `my-stash` read as the excluded token) and adjacency-strict, so
    // `git stash push … ; git push origin main` still matches on the second occurrence.
    pattern: /\bgit\b[\s\S]*?(?<!(?:^|[\s;&|(){}])stash\s{1,8})\bpush\b/i,
    detail: 'publishing to a remote is a human decision, not an agent one',
  },
  {
    name: 'git-remote-surgery',
    // The lookbehind keeps `git ls-remote` — a remote query — out of this rule, whole-token for the
    // same reason as above (a bare substring exclusion lets any token ending in `ls-` suppress it).
    //
    // The read-only forms are exempt, and the exemption is exactly these shapes: `-v`,
    // `--verbose`, `show`, and the bare list. Everything mutating still refuses — `add`, `set-url`,
    // `set-head`, `set-branches`, `rename`, `remove`, `prune`, `update`. `get-url` is read-only and
    // still refuses on purpose: an exemption set that grows by inference is how a boundary erodes.
    pattern: /\bgit\b[\s\S]*?(?<!(?:^|[\s;&|(){}])ls-)\bremote\b(?!\s+(?:-v|--verbose|show)\b)(?!\s*$)/i,
    detail: 'changing where this repository publishes is a human decision',
  },
  {
    name: 'git-branch-delete',
    // Plain `git branch`, `--show-current` and `checkout -b` all flow; `git push --delete` is caught
    // by the publish rule above.
    //
    // Segment-scoped. `[\s\S]*?` crosses pipes, so a read-only listing would borrow its `-d` from
    // a downstream `tr -d ' '` and refuse as a deletion. The publish rule is deliberately not
    // scoped: a push anywhere in a piped command is a push.
    pattern: /\bgit\b[\s\S]*?\bbranch\b[\s\S]*?(\s-[dD]\b|--delete\b)/i,
    detail: 'deleting a branch destroys history a human may still need',
    segmentScoped: true,
  },
  {
    name: 'git-reset-hard',
    // `reset` sits in the safe verbs because a soft or mixed reset moves nothing a commit cannot
    // recover; `--hard` discards the working tree and the index, and `reset --hard <ref>` moves the
    // branch as well. Segment-scoped like the branch rule, so a downstream `--hard` in another
    // program cannot be borrowed.
    pattern: /\bgit\b[\s\S]*?\breset\b[\s\S]*?\s--hard\b/i,
    detail: 'discarding uncommitted work and moving the branch is a human decision',
    segmentScoped: true,
  },
  {
    name: 'gh-pr-merge',
    pattern: /\bgh\b[\s\S]*?\bpr\b[\s\S]*?\bmerge\b/i,
    detail: 'merging is a human boundary',
  },
];

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
  // read-only terminal flags, surfaced as the verb when nothing else is: git prints and exits.
  '--version',
  '--help',
  // local-only writes. `branch -d` and friends are already refused by the denylist above.
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

/** The `git remote` shapes that only print. The same three the denylist above exempts. */
const REMOTE_READ_FLAGS: ReadonlySet<string> = new Set(['-v', '--verbose']);

/**
 * `git config` is a read verb and a write verb wearing one name, so it cannot sit in the allowlist:
 * a bare `git config user.email you@example` is a write and reads identically to a query without
 * this rule. Only the provably-reading shapes are admitted.
 */
function isReadOnlyConfig(args: readonly string[]): boolean {
  let sawRead = false;
  for (const argument of args) {
    if (CONFIG_WRITE_FLAGS.has(argument)) return false;
    if (CONFIG_READ_FLAGS.has(argument)) sawRead = true;
  }
  return sawRead;
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

function isAllowedGitInvocation(verb: string, args: readonly string[]): boolean {
  if (ALLOWED_GIT_VERBS.has(verb)) return true;
  if (verb === 'config') return isReadOnlyConfig(args);
  if (verb === 'remote') return isReadOnlyRemote(args);
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
  // Layer 1 — the denylist, over text the shell could actually execute.
  for (const rule of BOUNDARY_RULES) {
    const fired =
      rule.segmentScoped === true
        ? matchesInAnySegment(rule.pattern, parsed.scannable)
        : rule.pattern.test(parsed.scannable);
    if (fired) {
      return refusal('shell-boundary-command', `${rule.name}: ${rule.detail}`);
    }
  }

  // Layer 2 — the git verb allowlist. Non-git invocations are not this layer's business; shell
  // commands as a whole are covered by the workspace jail, this file, and the audit trail together.
  //
  // It is deliberately git-only. Extending an allowlist posture to another program is a boundary
  // decision that belongs to the embedder's policy (`ToolFamilies`, the local gate's options), not
  // to this file.
  for (const invocation of parsed.invocations) {
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
