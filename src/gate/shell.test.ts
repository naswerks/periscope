/**
 * The shell backstop's invariants.
 *
 * Layer 1 is the denylist and layer 2 is the git verb allowlist, and the tests are grouped that way
 * because the second layer exists only because the first under-includes: `git send-pack` matches no
 * pattern, and a denylist alone lets it force-push a main branch. A suite that proved "the command
 * refuses" without saying which layer refused it could not tell whether the second layer was doing
 * anything at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyShellCommand } from './shell.js';
import { parseCommand } from './command.js';

const refusalFor = (command: string): { reason: string; detail: string } | null => {
  const found = classifyShellCommand(command);
  return found === null ? null : { reason: found.reason, detail: found.detail };
};

const flows = (command: string): boolean => classifyShellCommand(command) === null;

// ---------------------------------------------------------------------------
// Layer 1 — the denylist. Each rule names itself in the detail.
// ---------------------------------------------------------------------------

test('publishing to a remote refuses, and the refusal names the rule that fired', () => {
  const found = refusalFor('git push origin main');
  assert.equal(found?.reason, 'shell-boundary-command');
  assert.match(found?.detail ?? '', /^git-push:/);
});

test('every publish form refuses — force, delete, refspecs, and a global flag in between', () => {
  for (const command of [
    'git push --force origin main',
    'git push -f',
    'git push --delete origin topic',
    'git push origin HEAD:refs/heads/main',
    'git -C /repo push origin main',
    'git -c user.name=x push origin main',
  ]) {
    assert.equal(refusalFor(command)?.reason, 'shell-boundary-command', `${command} did not refuse`);
  }
});

test('regression: a newline cannot hide a publish inside a compound command', () => {
  assert.equal(refusalFor('git status\ngit push origin main')?.reason, 'shell-boundary-command');
});

test('remote surgery refuses and says so', () => {
  const found = refusalFor('git remote add upstream https://example.invalid/x.git');
  assert.match(found?.detail ?? '', /^git-remote-surgery:/);
});

test('every mutating remote form still refuses', () => {
  for (const subcommand of [
    'add o u',
    'set-url o u',
    'set-head o m',
    'set-branches o m',
    'rename a b',
    'remove o',
    'prune o',
    'update',
  ]) {
    assert.equal(
      refusalFor(`git remote ${subcommand}`)?.reason,
      'shell-boundary-command',
      `git remote ${subcommand} flowed`,
    );
  }
});

test('deliberate: the read-only remote shapes flow — the reference classifier exempts them too', () => {
  assert.ok(flows('git remote -v'));
  assert.ok(flows('git remote --verbose'));
  assert.ok(flows('git remote show origin'));
  assert.ok(flows('git remote'));
});

test('deliberate: `git remote get-url` still refuses — an exemption that grows by inference erodes', () => {
  assert.notEqual(classifyShellCommand('git remote get-url origin'), null);
});

test('a read-only remote followed by surgery still refuses, on the second invocation', () => {
  assert.notEqual(classifyShellCommand('git remote -v; git remote set-url origin x'), null);
});

test('`git ls-remote` is a query, not surgery, and flows', () => {
  assert.ok(flows('git ls-remote origin'));
});

test('a token merely ending in ls- does not suppress the remote rule', () => {
  // A bare substring exclusion let any such token through; the exclusion is whole-token.
  assert.notEqual(classifyShellCommand('git fools-remote origin add x'), null);
});

test('branch deletion refuses in both spellings and the long form', () => {
  for (const command of ['git branch -d topic', 'git branch -D topic', 'git branch --delete topic']) {
    assert.match(refusalFor(command)?.detail ?? '', /^git-branch-delete:/, `${command} did not refuse`);
  }
});

test('ordinary branch work flows', () => {
  assert.ok(flows('git branch'));
  assert.ok(flows('git branch --show-current'));
  assert.ok(flows('git checkout -b topic'));
});

test('merging a pull request refuses', () => {
  assert.match(refusalFor('gh pr merge 42')?.detail ?? '', /^gh-pr-merge:/);
});

test('regression: `git stash push` is not a publish — it is the only canonical partial-stash form', () => {
  assert.ok(flows('git stash push -- src/a.ts'));
});

test('a stash followed by a real publish still refuses, on the second occurrence', () => {
  assert.notEqual(classifyShellCommand('git stash push -- x && git push origin main'), null);
});

test('a token merely ending in stash does not suppress the publish rule', () => {
  assert.notEqual(classifyShellCommand('git my-stash push origin main'), null);
});

// ---------------------------------------------------------------------------
// Layer 2 — the verb allowlist.
// ---------------------------------------------------------------------------

test('regression: `git send-pack` refuses, and it is the allowlist that refuses it', () => {
  // The plumbing behind a publish. It matches no denylist pattern, so a denylist-only classifier
  // approves it as benign shell and it force-pushes a main branch. Layer 1 still does not match it;
  // the reason must be the allowlist, or this test would pass while layer 2 did nothing.
  const found = refusalFor('git send-pack origin main');
  assert.equal(found?.reason, 'shell-verb-unrecognised', 'send-pack was not refused by the allowlist');
});

test('the other plumbing publish forms refuse the same way', () => {
  for (const verb of ['receive-pack', 'upload-pack']) {
    assert.equal(refusalFor(`git ${verb} origin`)?.reason, 'shell-verb-unrecognised', `git ${verb} flowed`);
  }
});

test('`git http-push` refuses at layer 1 — `-` is a word boundary and the publish rule sees it', () => {
  // Recorded rather than smoothed over: the two layers overlap on exactly this verb, and asserting
  // the allowlist reason here would have been asserting something false about which layer holds it.
  // Defence in depth is the point — the verb is refused twice over.
  assert.equal(refusalFor('git http-push origin')?.reason, 'shell-boundary-command');
});

test('regression: a verb nobody enumerated refuses, which is what covers whatever git ships next', () => {
  assert.equal(refusalFor('git publish-everything --to prod')?.reason, 'shell-verb-unrecognised');
});

test('a git invocation with no determinable verb refuses', () => {
  assert.equal(refusalFor('git')?.reason, 'shell-verb-unrecognised');
  assert.equal(refusalFor('git -C /x')?.reason, 'shell-verb-unrecognised');
});

test('a cased oddity is not proven safe and refuses', () => {
  assert.equal(refusalFor('git STATUS')?.reason, 'shell-verb-unrecognised');
});

test('regression: `git -C <path> status` flows — a global flag does not hide the verb', () => {
  assert.ok(flows('git -C /some/repo status'), 'a read-only status was refused as an unrecognised verb');
});

test('the known-safe verbs flow', () => {
  for (const command of [
    'git status',
    'git log --oneline -5',
    'git diff HEAD',
    'git add src/a.ts',
    'git commit -m "a message"',
    'git fetch origin',
    'git pull',
    'git rev-parse HEAD',
    'git check-ignore -v x',
    'git --version',
    'git stash',
  ]) {
    assert.ok(flows(command), `${command} was refused`);
  }
});

test('`git config` flows only in its provably-reading shapes', () => {
  assert.ok(flows('git config --get user.email'));
  assert.ok(flows('git config --list'));
  assert.notEqual(classifyShellCommand('git config user.email you@example.invalid'), null);
  assert.notEqual(classifyShellCommand('git config --get user.email --unset core.x'), null);
});

test("a non-git program is not this layer's business", () => {
  assert.ok(flows('npm test'));
  assert.ok(flows('ls -la'));
  assert.ok(flows('node --version'));
});

// ---------------------------------------------------------------------------
// Nesting through an interpreter, and the reason the tokenizer inverts on one.
// ---------------------------------------------------------------------------

test('regression: `bash -c "git push …"` refuses; nesting does not smuggle', () => {
  assert.notEqual(classifyShellCommand('bash -c "git push origin main"'), null);
});

test('regression: the allowlist reaches inside the interpreter too — `bash -c "git send-pack …"`', () => {
  // This is the case the quote inversion exists for: layer 1 has no send-pack pattern, so if the
  // nested invocation never reached a command position, nothing at all would refuse it.
  const found = refusalFor('bash -c "git send-pack origin main"');
  assert.equal(found?.reason, 'shell-verb-unrecognised', 'a nested send-pack was not seen by the allowlist');
});

test('every interpreter spelling inverts, including the PowerShell and xargs forms', () => {
  for (const command of [
    'sh -c "git send-pack origin main"',
    'pwsh -c "git send-pack origin main"',
    'powershell -Command "git send-pack origin main"',
    'cmd /c "git send-pack origin main"',
    'echo main | xargs -I{} git send-pack origin {}',
    'iex "git send-pack origin main"',
  ]) {
    assert.notEqual(classifyShellCommand(command), null, `${command} flowed`);
  }
});

test('an interpreter named by full path with .exe still inverts', () => {
  assert.notEqual(
    classifyShellCommand('C:\\Windows\\System32\\cmd.exe /c "git send-pack origin main"'),
    null,
  );
});

// ---------------------------------------------------------------------------
// The three defects, at the classifier rather than the parser — the refusals that must not happen.
// ---------------------------------------------------------------------------

test('regression: `gh pr create` whose body discusses merging flows', () => {
  assert.ok(
    flows('gh pr create --title "the work" --body "this lands when we merge it after review"'),
    'a PR body discussing the landing made the PR unpublishable',
  );
});

test('regression: a script whose comment mentions a boundary word flows', () => {
  const command = ['python <<EOF', '# never git push from a hook', 'print(1)', 'EOF'].join('\n');
  assert.ok(flows(command), 'a code comment refused a benign script');
});

test('a commit whose message mentions a boundary word flows', () => {
  assert.ok(flows('git commit -m "do not push this yet"'));
});

test('regression: an interpolating message does not flow — a payload that expands is not data', () => {
  assert.notEqual(
    classifyShellCommand('git commit -m "$(git push origin main)"'),
    null,
    'an interpolating payload was treated as inert prose',
  );
});

// Guards the selector: if `classifyShellCommand` refused everything, every `flows` assertion above
// would fail loudly — but if it refused nothing, every refusal assertion would fail instead. This
// asserts both directions move, so a broken classifier cannot look like a strict one or a lax one.
test('the classifier discriminates — it refuses some commands and admits others', () => {
  assert.notEqual(classifyShellCommand('git push origin main'), null);
  assert.equal(classifyShellCommand('git status'), null);
});

// ---------------------------------------------------------------------------
// Segment scoping — the classifier must not tax verification.
//
// `git branch -r --contains <sha> | tr -d ' '` — a read-only branch listing — refused as "branch
// deletion" when `[\s\S]*?` reached across a pipe and borrowed the `-d` from `tr`. That is exactly
// the command an agent runs to check its own work.
//
// The rule is unchanged. This narrows what is scanned, never what is denied — the counter-test
// below refuses a real deletion in every shape, including beside a read-only one.
// ---------------------------------------------------------------------------

test('a read-only branch listing does not borrow a delete flag from a piped command', () => {
  assert.ok(flows("git branch -r --contains ed244808 | tr -d ' '"));
  assert.ok(flows("git branch --contains ed244808 | tr -d ' '"));
  assert.ok(flows("git status -sb; git branch -r --contains ed244808 | tr -d ' '"));
});

test('a real branch deletion still refuses in every shape', () => {
  for (const command of [
    'git branch -d feature/x',
    'git branch -D feature/x',
    'git branch --delete feature/x',
    'git status -sb; git branch -d feature/x',
    'git branch --contains ed244808 && git branch -D old/branch',
  ]) {
    const found = refusalFor(command);
    assert.notEqual(found, null, `${command} deletes a branch and must refuse`);
    assert.match(found!.detail, /branch/i);
  }
});

test('regression: `git reset --hard` is a boundary, while a soft or mixed reset still flows', () => {
  for (const command of [
    'git reset --hard',
    'git reset --hard origin/main',
    'git reset --hard HEAD~1',
    'git   reset   --hard',
  ]) {
    const refused = refusalFor(command);
    assert.equal(refused?.reason, 'shell-boundary-command', `${command} flowed`);
    assert.match(refused?.detail ?? '', /git-reset-hard/);
  }
  for (const command of [
    'git reset',
    'git reset --soft HEAD~1',
    'git reset --mixed HEAD',
    'git reset HEAD -- file.txt',
  ]) {
    assert.equal(refusalFor(command), null, `${command} was refused: a recoverable reset is a local write`);
  }
  // Segment-scoped: the flag of another program in the pipe is not borrowed.
  assert.equal(refusalFor('git reset | grep --hard'), null);
});

// ---------------------------------------------------------------------------
// Read-only git that publishes nothing.
// ---------------------------------------------------------------------------

test('regression: `git for-each-ref` and `git merge-tree` are reads, and flow', () => {
  for (const command of [
    'git for-each-ref refs/heads',
    "git for-each-ref --format='%(refname:short)' refs/remotes",
    'git merge-tree --write-tree main topic',
  ]) {
    assert.equal(refusalFor(command), null, `${command} was refused`);
  }
});

test('regression: `git worktree list` flows, and every other worktree subcommand still refuses', () => {
  assert.equal(refusalFor('git worktree list'), null);
  assert.equal(refusalFor('git worktree list --porcelain'), null);
  for (const command of [
    'git worktree add ../other topic',
    'git worktree remove ../other',
    'git worktree prune',
    'git worktree move ../other ../moved',
    'git worktree lock ../other',
    'git worktree',
  ]) {
    assert.equal(refusalFor(command)?.reason, 'shell-verb-unrecognised', `${command} flowed`);
  }
});

test('regression: a bare `git config section.key` read flows, as do `git config get` and `git config list`', () => {
  for (const command of [
    'git config user.email',
    'git config --global user.name',
    'git config --type=bool core.bare',
    'git config get user.email',
    'git config get --all remote.origin.fetch',
    'git config list',
    'git config list --show-origin',
  ]) {
    assert.equal(refusalFor(command), null, `${command} was refused`);
  }
});

test('control: a `git config` write still refuses in every shape, `git config edit` included', () => {
  for (const command of [
    'git config user.email you@example.invalid',
    'git config --bool core.bare true',
    'git config edit',
    'git config set user.name someone',
    'git config unset user.name',
    'git config rename-section old new',
    'git config remove-section old',
    'git config --get user.email --unset core.x',
  ]) {
    assert.equal(refusalFor(command)?.reason, 'shell-verb-unrecognised', `${command} flowed`);
  }
});

// ---------------------------------------------------------------------------
// The rules read the subcommand, not a word in a path.
// ---------------------------------------------------------------------------

test('regression: a boundary word inside a path is part of the path, and a read-only command through it flows', () => {
  for (const command of [
    'git diff --stat a1b2c3 d4e5f6 -- src/app/fields/edit-remote-work src/app/schema.graphql | tail -40',
    'git add src/app/fields/edit-remote-work/edit-remote-work.component.ts',
    'git diff -- src/app/fields/edit-remote-work/',
    'git diff -U0 -- src/app/fields/edit-remote-work',
    'git log -L 10,20:src/app/fields/edit-remote-work/edit.ts',
    'git -C C:/work/remote-tools status',
    "git status -sb && git log --oneline -8 --format='%h %ad %s' --date=iso && ls logs 2>/dev/null && tail -40 logs/pre-push.log 2>/dev/null",
  ]) {
    assert.equal(refusalFor(command), null, `${command} was refused`);
  }
});

test('regression: a boundary word another program prints or searches for is not a git subcommand', () => {
  for (const command of [
    'git status; echo push',
    'git log --oneline | grep remote',
    'git status && tail -5 push.log',
  ]) {
    assert.equal(refusalFor(command), null, `${command} was refused`);
  }
});

test('control: `git push` in its own segment after `git status &&` still parks', () => {
  assert.match(refusalFor('git status && git push origin main')?.detail ?? '', /^git-push:/);
});

test("control: a git command inside another program's words still refuses, by the residual check", () => {
  for (const command of [
    'ssh build-host git push origin main',
    'ssh build-host "git push origin main"',
    "git -c core.pager='git push origin main' log",
    'rg -n "git push" docs/',
  ]) {
    assert.equal(refusalFor(command)?.reason, 'shell-boundary-command', `${command} flowed`);
  }
});

test('regression: a branch deletion refuses in a short cluster and an abbreviated long option', () => {
  for (const command of [
    'git branch -dr origin/topic',
    'git branch -rD origin/topic',
    'git branch --del topic',
  ]) {
    assert.match(refusalFor(command)?.detail ?? '', /^git-branch-delete:/, `${command} flowed`);
  }
  assert.match(refusalFor('git reset --har HEAD~1')?.detail ?? '', /^git-reset-hard:/);
});

test('regression: an option value that starts with a dash is the value, not a branch deletion', () => {
  // git reads each value below as the option's own (a sort key, a format, a commit, a colour) and deletes
  // nothing; `-dx` is no cluster of git branch's options, and git refuses the unknown switch.
  for (const command of [
    'ssh build-host "git branch --sort=-committerdate"',
    'git branch --sort -committerdate',
    'git branch --so -committerdate',
    'git branch --sort=-committerdate',
    'ssh build-host "git branch --format=-d"',
    'ssh build-host git branch --format -d',
    'git branch --contains -d topic',
    'ssh build-host "git branch --color=-d"',
    'git branch -dx topic',
  ]) {
    assert.equal(refusalFor(command), null, `${command} was refused`);
  }
});

test('control: a real branch deletion still parks in a cluster of branch options, after an option value, and after an option that takes no separate value', () => {
  for (const command of [
    'git branch -fd topic',
    'git branch --contains HEAD -d topic',
    'git branch --sort=-committerdate -d topic',
    'git branch --color -d topic',
    'ssh build-host "git branch --color -d topic"',
    'ssh build-host "git branch -d topic"',
  ]) {
    assert.match(refusalFor(command)?.detail ?? '', /^git-branch-delete:/, `${command} flowed`);
  }
});

test("control: the text after an = in another program's words still begins a command, and an option's =value after it stays its value", () => {
  for (const command of [
    "git -c core.pager='git push origin main' log",
    'rg -c core.pager=git push origin main',
    'ssh build-host -o core.pager=git push origin main',
    'ssh build-host git --exec-path=/x push origin main',
  ]) {
    assert.match(refusalFor(command)?.detail ?? '', /^git-push:/, `${command} flowed`);
  }
});

// ---------------------------------------------------------------------------
// Git behind a launcher, and git's dashed binaries.
// ---------------------------------------------------------------------------

const LAUNCHED: ReadonlyArray<readonly [string, string]> = [
  ['env', 'env GIT_TRACE=1'],
  ['sudo', 'sudo -u build'],
  ['doas', 'doas -u build'],
  ['nohup', 'nohup'],
  ['nice', 'nice -n 5'],
  ['ionice', 'ionice -c 3'],
  ['time', 'time'],
  ['timeout', 'timeout 10'],
  ['stdbuf', 'stdbuf -oL'],
  ['command', 'command'],
  ['exec', 'exec'],
  ['xargs', 'xargs -n 1'],
  ['watch', 'watch -n 5'],
  ['start', 'start'],
];

for (const [launcher, prefix] of LAUNCHED) {
  test(`regression: behind \`${launcher}\`, git is read as git by both layers`, () => {
    assert.match(
      refusalFor(`${prefix} git push origin main`)?.detail ?? '',
      /^git-push:/,
      `${prefix} git push flowed`,
    );
    assert.equal(
      refusalFor(`${prefix} git send-pack origin main`)?.reason,
      'shell-verb-unrecognised',
      `${prefix} git send-pack was not refused by the allowlist`,
    );
    assert.equal(refusalFor(`${prefix} git status`), null, `${prefix} git status was refused`);
  });
}

test('regression: a dashed git binary is git, by path and with .exe', () => {
  assert.match(refusalFor('git-push origin main')?.detail ?? '', /^git-push:/);
  for (const command of [
    '"C:/Program Files/Git/mingw64/libexec/git-core/git-send-pack.exe" origin main',
    '/usr/lib/git-core/git-receive-pack origin',
  ]) {
    assert.equal(refusalFor(command)?.reason, 'shell-verb-unrecognised', `${command} flowed`);
  }
  assert.equal(refusalFor('/usr/lib/git-core/git-rev-parse HEAD'), null, 'a dashed read flows');
});

test('regression: a dashed git binary behind a backslash-escaped space is git, as the quoted path is', () => {
  // To a POSIX shell `C:/Program\ Files/...` is one word: the call runs the dashed binary itself.
  const escaped = String.raw`C:/Program\ Files/Git/mingw64/libexec/git-core/git-send-pack.exe origin main`;
  assert.equal(refusalFor(escaped)?.reason, 'shell-verb-unrecognised', `${escaped} flowed`);
  assert.equal(
    refusalFor('"C:/Program Files/Git/mingw64/libexec/git-core/git-send-pack.exe" origin main')?.reason,
    'shell-verb-unrecognised',
    'the control: the quoted path refuses the same way',
  );
  assert.equal(
    refusalFor(String.raw`C:/Program\ Files/Git/cmd/git.exe status`),
    null,
    'an escaped path to a read flows',
  );
});

test('deliberate: an escaped space is read both ways, so reading it only adds a refusal', () => {
  // Joined alone, a word that begins with an escaped space would hide the git behind it, though ssh hands
  // the word to a remote shell that splits it again. The split reading still sees it.
  // The split reading holds `git-send-pack.exe` as a word of its own behind the launcher, so the
  // allowlist refuses it as git's plumbing, and the push after the quoted empty word parks.
  const sendPack = String.raw`timeout 10 ssh build-host \ git-send-pack.exe origin`;
  assert.equal(refusalFor(sendPack)?.reason, 'shell-verb-unrecognised', `${sendPack} flowed`);
  const push = String.raw`ssh build-host ''\ git push origin main`;
  assert.match(refusalFor(push)?.detail ?? '', /^git-push:/, `${push} flowed`);
});

test('regression: a `#` after an escaped blank is part of the word, so the command after it is read', () => {
  // To a POSIX shell `a\ #` is one word, `a #`: the `#` opens no comment and the push after the `;` runs.
  for (const command of [
    String.raw`echo a\ # ; git push origin main`,
    'echo a\\\t# ; git push origin main',
    String.raw`echo a\\\ # ; git push origin main`,
    String.raw`bash -c "echo a\ # ; git push origin main"`,
  ]) {
    assert.match(refusalFor(command)?.detail ?? '', /^git-push:/, `${command} flowed`);
  }
  assert.equal(
    refusalFor(String.raw`echo a\ # ; git send-pack origin main`)?.reason,
    'shell-verb-unrecognised',
    'the plumbing form after the same word is refused by the allowlist',
  );
});

test('control: a backslash pair escapes nothing, so the blank after it starts a word and the `#` a comment', () => {
  assert.equal(refusalFor(String.raw`echo a\\ # ; git push origin main`), null);
  assert.equal(refusalFor('echo a # ; git push origin main'), null);
  assert.equal(refusalFor(String.raw`bash -c "echo a\\ # ; git push origin main"`), null);
});

test('deliberate: a backslash before a quote is not read as an escape, so the quote opens a span and what follows it stays in the scan', () => {
  // bash runs only `echo "` here; reading the quote as a quote refuses instead, the direction that scans more.
  assert.match(refusalFor(String.raw`echo \" # " ; git push origin main`)?.detail ?? '', /^git-push:/);
});

test('control: PowerShell and cmd.exe read a backslash as an ordinary character, so they get no escaped reading', () => {
  const command = String.raw`git -C C:\repo\ remote add o u`;
  assert.notEqual(
    parseCommand(command).escapedReading,
    undefined,
    'the POSIX reading joins the escaped space',
  );
  assert.equal(parseCommand(command, 'powershell').escapedReading, undefined);
  assert.equal(parseCommand(command, 'cmd').escapedReading, undefined);
  assert.match(
    classifyShellCommand(command, parseCommand(command, 'powershell'))?.detail ?? '',
    /^git-remote-surgery:/,
  );
});

// ---------------------------------------------------------------------------
// Merging a pull request, on GitHub and on Azure DevOps.
// ---------------------------------------------------------------------------

test('control: `gh pr merge` still parks, by any route', () => {
  for (const command of [
    'gh pr merge 42',
    'gh -R owner/repo pr merge 42',
    'env gh pr merge 42',
    'gh pr merge 42 --squash',
  ]) {
    assert.match(refusalFor(command)?.detail ?? '', /^gh-pr-merge:/, `${command} flowed`);
  }
});

test('regression: completing an Azure DevOps pull request is a merge, and parks', () => {
  for (const command of [
    'az repos pr update --id 5 --status completed',
    'az repos pr update --id 5 --status=completed',
    'az repos pr update --id 5 --status Completed',
    'az repos pr update --id 5 --status "completed"',
    'az repos pr update --id 5 --st completed',
    'az repos pr update --id 5 --status $STATUS',
    'az repos pr update --id 5 --auto-complete true',
    'az repos pr update --id 5 --auto-complete',
    'az repos pr create --title "the work" --auto-complete true',
    'az --org https://dev.azure.com/example repos pr update --id 5 --status completed',
    'env az repos pr update --id 5 --status completed',
    'git status && az repos pr update --id 5 --status completed',
  ]) {
    const found = refusalFor(command);
    assert.equal(found?.reason, 'shell-boundary-command', `${command} flowed`);
    assert.match(found?.detail ?? '', /^az-repos-pr-complete: merging is a human boundary$/);
  }
});

test('control: an Azure DevOps pull request that is not completed flows', () => {
  for (const command of [
    'az repos pr update --id 5 --status abandoned',
    'az repos pr update --id 5 --status active',
    'az repos pr update --id 5 --auto-complete false',
    'az repos pr create --title "the work" --auto-complete false',
    'az repos pr list',
    'az repos pr show --id 5',
    'az repos pr create --title "the work" --description "this merges after review"',
    'az repos pr update --id 5 --description "set the status to completed after review"',
  ]) {
    assert.equal(refusalFor(command), null, `${command} was refused`);
  }
});

test('regression: an Azure DevOps completion parks through a quoted option name, a repeated option and a dash word in a description', () => {
  for (const command of [
    'az repos pr update --id 5 "--status" completed',
    "az repos pr update --id 5 '--status' completed",
    'az repos pr update --id 5 "--status=completed"',
    'az repos pr update --id 5 --status active --status completed',
    'az repos pr update --id 5 --auto-complete false --auto-complete true',
    'az repos pr update --id 5 --description "notes" "--status" completed',
  ]) {
    assert.match(refusalFor(command)?.detail ?? '', /^az-repos-pr-complete:/, `${command} flowed`);
  }
});

test('control: a quoted paragraph that opens with a dash stays prose, and a pull request every occurrence leaves open flows', () => {
  for (const command of [
    'az repos pr update --id 5 --description "- fixed it"',
    'az repos pr update --id 5 --description "- fixed it" "- tested it" --status active',
    'az repos pr update --id 5 --status abandoned --status active',
    'az repos pr update --id 5 --auto-complete false --auto-complete false',
  ]) {
    assert.equal(refusalFor(command), null, `${command} was refused`);
  }
});

test('regression: a .cmd or .bat shim is the program it runs, to every rule and to the prose separation', () => {
  for (const command of [
    'az.cmd repos pr update --id 5 --status completed',
    'AZ.CMD repos pr update --id 5 --status completed',
    'az.bat repos pr update --id 5 --auto-complete true',
    '"C:/Program Files/Microsoft SDKs/Azure/CLI2/wbin/az.cmd" repos pr update --id 5 --status completed',
  ]) {
    assert.match(refusalFor(command)?.detail ?? '', /^az-repos-pr-complete:/, `${command} flowed`);
  }
  assert.match(refusalFor('git.cmd push origin main')?.detail ?? '', /^git-push:/);
  assert.match(refusalFor('git.bat push origin main')?.detail ?? '', /^git-push:/);
  assert.match(refusalFor('gh.cmd pr merge 5')?.detail ?? '', /^gh-pr-merge:/);
  assert.equal(refusalFor('git-send-pack.cmd origin main')?.reason, 'shell-verb-unrecognised');
  assert.equal(refusalFor('git.cmd status'), null, 'a read through the shim flows');
  assert.equal(
    refusalFor('az.cmd repos pr create --title "x" --description "git push origin main"'),
    null,
    'a description naming a push is prose to az.cmd, as it is to az',
  );
});

test('control: behind a launcher, a shim does not take a git word after it out of the allowlist', () => {
  assert.equal(refusalFor('xargs $G az.cmd git-send-pack.exe origin')?.reason, 'shell-verb-unrecognised');
  assert.match(
    refusalFor('env az.cmd repos pr update --id 5 --status completed')?.detail ?? '',
    /^az-repos-pr-complete:/,
  );
});

// ---------------------------------------------------------------------------
// A command word an expansion supplies.
// ---------------------------------------------------------------------------

test('regression: a command word an expansion supplies is read as the program the line names for it', () => {
  for (const command of [
    '$(echo git) push origin x',
    '`echo git` push origin x',
    '"$(echo git)" push origin main',
    '$(which git) push origin main',
    'G=git; $G push origin main',
    'G=git && $G push origin main',
    'export G=git; $G push origin main',
    'G=git; ${G} push origin main',
    'G=git; "$G" push origin main',
    'G=$(which git); $G push origin main',
    '$(echo git) -C /repo push origin main',
    'echo $($(echo git) push origin main)',
    'bash -c "$(echo git) push origin main"',
  ]) {
    assert.match(refusalFor(command)?.detail ?? '', /^git-push:/, `${command} flowed`);
  }
  assert.match(refusalFor('$(echo gh) pr merge 5')?.detail ?? '', /^gh-pr-merge:/);
  assert.match(refusalFor('$(command -v gh) pr merge 5')?.detail ?? '', /^gh-pr-merge:/);
  assert.match(
    refusalFor('A=az; $A repos pr update --id 5 --status completed')?.detail ?? '',
    /^az-repos-pr-complete:/,
  );
  assert.equal(
    refusalFor('$(echo git) send-pack origin main')?.reason,
    'shell-verb-unrecognised',
    'read as git, by the allowlist too',
  );
  assert.equal(refusalFor('$(echo git) status'), null, 'a read through the expansion flows');
});

test('control: a command word whose program the line does not name is not guessed, and flows', () => {
  for (const command of [
    '$DOCKER push registry/image:tag',
    '$(which docker) push img',
    '"$HELM" push chart.tgz oci://r',
    '$ADB push app.apk /data/local/tmp',
    '$CC -O2 -o push main.c',
    'for f in $FILES; do $f push; done',
    '$1 push',
    '"$@" push',
    '$X reset --hard',
    '$TOOL remote add foo bar',
    '$PKG branch -d x',
    '$G push origin main',
    'g$(echo it) push origin main',
    'D=docker; $D push img',
    'G=git cmd; $G push origin main',
    'G=git; G=docker; $G push img',
    '$EDITOR notes.md',
    '$(npm bin)/tsc -p .',
    '"$HOME/bin/tool" run',
    "'$G' push",
  ]) {
    assert.equal(refusalFor(command), null, `${command} was refused`);
  }
});

test('control: PowerShell and cmd.exe do not run an expansion as a command word, so their readings do not read one', () => {
  const command = '$(echo git) push origin x';
  assert.equal(classifyShellCommand(command, parseCommand(command, 'powershell')), null);
  assert.equal(classifyShellCommand(command, parseCommand(command, 'cmd')), null);
  assert.match(refusalFor(command)?.detail ?? '', /^git-push:/, 'the POSIX reading still reads it');
});

test('control: a refusal another rule makes stays that refusal beside a command word an expansion supplies', () => {
  assert.equal(
    refusalFor('G=git; $G push origin main; git send-pack origin main')?.reason,
    'shell-verb-unrecognised',
    'the allowlist refusal stays local',
  );
});
