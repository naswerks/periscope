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
