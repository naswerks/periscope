/**
 * The parser's invariants — and the three defects that make parsing the design instead of a
 * longer pattern. Each of those is written here as an explicit case, because a defect designed out
 * with no test is a defect waiting for the next refactor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isInertLiteral, parseCommand, programNameOf, stripComments, tokenize } from './command.js';

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

test('a separator becomes its own token, so the tokens say where a command may begin', () => {
  assert.deepEqual(tokenize('git status; git log'), ['git', 'status', ';', 'git', 'log']);
});

test('a quoted span is one token, so an argument with spaces is not read as several', () => {
  assert.deepEqual(tokenize('git commit -m "two words"'), ['git', 'commit', '-m', '"two words"']);
});

test('a separator inside quotes is data and opens no command position', () => {
  assert.deepEqual(tokenize('echo "a; b"'), ['echo', '"a; b"']);
});

test('regression: with an interpreter present, quotes become separators so nesting cannot smuggle', () => {
  // A token break alone would leave `git` right after `-c`, which is an argument position — and the
  // verb allowlist only reads invocations at command positions. It has to be a separator.
  const tokens = tokenize('bash -c "git send-pack origin main"', true);
  const git = tokens.indexOf('git');
  assert.ok(git > 0, 'the nested git token was not found at all');
  assert.equal(tokens[git - 1], '\n', 'the quote did not open a command position');
});

test('an unbalanced quote keeps its text in the scan rather than throwing it away', () => {
  const parsed = parseCommand('echo "git push origin main');
  assert.match(parsed.scannable, /git push/, 'text after an unbalanced quote vanished from the scan');
});

test('a program name drops its directory and its .exe, so a full path is still recognised', () => {
  assert.equal(programNameOf('C:\\Program Files\\Git\\bin\\git.exe'), 'git');
  assert.equal(programNameOf('/usr/bin/git'), 'git');
  assert.equal(programNameOf("'git'"), 'git');
});

test('regression: a program name drops a .cmd or .bat shim suffix in any case, as it drops .exe', () => {
  assert.equal(programNameOf('az.cmd'), 'az');
  assert.equal(programNameOf('C:\\Program Files\\Azure\\wbin\\AZ.CMD'), 'az');
  assert.equal(programNameOf('git.bat'), 'git');
  assert.equal(programNameOf('deploy.cmd'), 'deploy');
  assert.equal(programNameOf('notes.cmdx'), 'notes.cmdx', 'only a whole suffix is dropped');
});

// ---------------------------------------------------------------------------
// Defect 1 — a boundary word in a code comment refuses a benign script.
// ---------------------------------------------------------------------------

test('regression: a boundary word inside a comment does not reach the scan (the heredoc comment)', () => {
  const command = ['python <<EOF', '# we do not git push from here', 'print("hello")', 'EOF'].join('\n');
  const parsed = parseCommand(command);
  assert.doesNotMatch(parsed.scannable, /git push/, 'a comment reached the scan as command text');
});

test('a comment inside quotes survives, because an interpreter has its own idea of a comment', () => {
  assert.equal(stripComments('echo "# not a comment"'), 'echo "# not a comment"');
});

test('a hash mid-token is not a comment — only word position opens one', () => {
  assert.equal(stripComments('git log --format=a#b'), 'git log --format=a#b');
});

test('a comment ends at its newline and the command after it survives', () => {
  assert.match(stripComments('echo hi # a note\ngit status'), /git status/);
});

test('regression: the escaped reading keeps a `#` after an escaped blank inside its word, and reads the command after it', () => {
  const parsed = parseCommand(String.raw`echo a\ # ; git push origin main`);
  assert.equal(
    parsed.escapedReading?.invocations[0]?.verb,
    'a #',
    'the escaped blank and the # are one word',
  );
  assert.equal(parsed.escapedReading?.invocations[1]?.verb, 'push', 'the push after the ; was not read');
  assert.equal(parsed.invocations.length, 1, 'the split reading still takes the # for a comment');
});

// ---------------------------------------------------------------------------
// Defect 2 — global flags before the subcommand defeat the verb finder.
// ---------------------------------------------------------------------------

test('regression: `git -C <path> status` reads `status`, not the path (the global flag)', () => {
  const parsed = parseCommand('git -C /some/repo status');
  assert.equal(parsed.invocations[0]?.verb, 'status');
});

test('the other mandatory-argument global flags do not swallow the verb either', () => {
  for (const flag of ['--git-dir', '--work-tree', '--namespace']) {
    const parsed = parseCommand(`git ${flag} /x status`);
    assert.equal(parsed.invocations[0]?.verb, 'status', `${flag} swallowed the verb`);
  }
});

test('an inline global flag is skipped without consuming anything', () => {
  assert.equal(parseCommand('git --git-dir=/x status').invocations[0]?.verb, 'status');
});

test('deliberate: --exec-path does not consume the next token, because its argument is optional', () => {
  // Bare `git --exec-path` prints and exits. Treating its argument as mandatory would swallow a real
  // verb and under-refuse — the one direction this file may never take.
  assert.equal(parseCommand('git --exec-path status').invocations[0]?.verb, 'status');
});

test('a git invocation with no determinable verb reports null rather than guessing one', () => {
  assert.equal(parseCommand('git -C /x').invocations[0]?.verb, null);
  assert.equal(parseCommand('git').invocations[0]?.verb, null);
});

test('a read-only terminal flag is the verb, because git prints and exits on it', () => {
  assert.equal(parseCommand('git --version').invocations[0]?.verb, '--version');
});

// ---------------------------------------------------------------------------
// Defect 3 — a boundary word in PR body prose refuses the PR that discusses it.
// ---------------------------------------------------------------------------

test('regression: a --body payload never reaches the scan (the PR body prose)', () => {
  const parsed = parseCommand('gh pr create --title "the work" --body "this will merge after review"');
  assert.doesNotMatch(parsed.scannable, /merge/, 'the PR body reached the scan as command text');
  assert.deepEqual(parsed.invocations[0]?.dataPayloads, ['"the work"', '"this will merge after review"']);
});

test('a commit message payload never reaches the scan either', () => {
  const parsed = parseCommand('git commit -m "do not push yet"');
  assert.doesNotMatch(parsed.scannable, /push/);
});

test('an inline --body= payload is separated the same way as the spaced form', () => {
  const parsed = parseCommand('gh pr create --body="mentions merge"');
  assert.doesNotMatch(parsed.scannable, /merge/);
});

test('a message flag on a non-message-bearing shape is not treated as data', () => {
  // `git push -m` is not a commit; nothing here is prose, so nothing is separated.
  const parsed = parseCommand('git tag -m "annotate"');
  assert.deepEqual(parsed.invocations[0]?.dataPayloads, []);
});

// ---------------------------------------------------------------------------
// Parsing does not make a payload safe.
// ---------------------------------------------------------------------------

test('regression: an interpolating message payload stays in the scan — both shells expand it', () => {
  const parsed = parseCommand('git commit -m "$(git push origin main)"');
  assert.match(parsed.scannable, /git push/, 'an interpolating payload was treated as inert data');
  assert.deepEqual(parsed.invocations[0]?.dataPayloads, []);
});

test('a backtick payload stays in the scan for the same reason', () => {
  assert.match(parseCommand('git commit -m "`git push`"').scannable, /git push/);
});

test('a bare message payload stays in the scan — only a quoted literal is provably inert', () => {
  assert.match(parseCommand('git commit -m push').scannable, /push/);
});

test('the inertness rule itself: single quotes are literal, double quotes only without $ or backtick', () => {
  assert.equal(isInertLiteral("'anything $ here'"), true);
  assert.equal(isInertLiteral('"plain text"'), true);
  assert.equal(isInertLiteral('"$(x)"'), false);
  assert.equal(isInertLiteral('"`x`"'), false);
  assert.equal(isInertLiteral('bare'), false);
  assert.equal(isInertLiteral('"'), false);
});

// ---------------------------------------------------------------------------
// Heredocs
// ---------------------------------------------------------------------------

test('a heredoc into a data sink is data', () => {
  const command = ['git commit -F - <<MSG', 'this text mentions push', 'MSG'].join('\n');
  assert.doesNotMatch(parseCommand(command).scannable, /push/);
});

test('regression: a heredoc into an interpreter is code and stays scanned', () => {
  const command = ['bash <<EOF', 'git push origin main', 'EOF'].join('\n');
  assert.match(parseCommand(command).scannable, /git push/, 'a heredoc into a shell was masked as data');
});

test('an unterminated heredoc leaves everything in the scan', () => {
  const command = ['git commit -F - <<MSG', 'git push origin main'].join('\n');
  assert.match(parseCommand(command).scannable, /git push/);
});

test('a heredoc into cat or tee is file content, not command text', () => {
  const command = ['cat > notes.txt <<BODY', 'remember to push later', 'BODY'].join('\n');
  assert.doesNotMatch(parseCommand(command).scannable, /push/);
});

// ---------------------------------------------------------------------------
// Command positions
// ---------------------------------------------------------------------------

test('regression: a keyword opener starts a command position — the loop-body hole', () => {
  const parsed = parseCommand('for f in *.ts; do git send-pack origin main; done');
  const git = parsed.invocations.find((invocation) => invocation.program === 'git');
  assert.equal(git?.verb, 'send-pack', 'a git invocation inside a loop body was never parsed as one');
});

test('regression: a brace block starts one too — the if-block hole', () => {
  const parsed = parseCommand('if (Test-Path .git) { git send-pack origin main }');
  const git = parsed.invocations.find((invocation) => invocation.program === 'git');
  assert.equal(git?.verb, 'send-pack');
});

test('the word git as an argument is not an invocation', () => {
  const parsed = parseCommand('echo git push');
  assert.equal(parsed.invocations.length, 1);
  assert.equal(parsed.invocations[0]?.program, 'echo');
});

test('a compound produces one invocation per command position', () => {
  const parsed = parseCommand('git status && git log');
  assert.deepEqual(
    parsed.invocations.map((invocation) => invocation.verb),
    ['status', 'log'],
  );
});

test('regression: a command word an expansion supplies is set aside with the program the line names for it, at any depth', () => {
  const named = (command: string): unknown => parseCommand(command).expandedCommands;
  assert.deepEqual(named('$(echo git) push origin x'), [{ program: 'git', words: ['push', 'origin', 'x'] }]);
  assert.deepEqual(named('`which /usr/bin/git` push'), [{ program: 'git', words: ['push'] }]);
  assert.deepEqual(named('$(command -v gh) pr merge 5'), [{ program: 'gh', words: ['pr', 'merge', '5'] }]);
  assert.deepEqual(named('G=git; ${G} push'), [{ program: 'git', words: ['push'] }]);
  assert.deepEqual(named('export G="git"; "$G" push'), [{ program: 'git', words: ['push'] }]);
  assert.deepEqual(named('G=git; echo $($G push)'), [{ program: 'git', words: ['push'] }], 'inside one');
  assert.deepEqual(named('$(which docker) push img'), [{ program: 'docker', words: ['push', 'img'] }]);
});

test('control: a command word whose program the line does not name is not set aside', () => {
  for (const command of [
    '$G push',
    'g$(echo it) push',
    '$(git config core.editor) notes.md',
    'G=git cmd; $G push',
    '$G push; G=git',
    'G=git; G=$X; $G push',
    '$(npm bin)/tsc -p .',
    '"$HOME/bin/tool" run',
    "'$G' push",
    'git -C $(pwd) status',
  ]) {
    assert.equal(parseCommand(command).expandedCommands, undefined, command);
  }
  assert.equal(parseCommand('$(echo git) push', 'powershell').expandedCommands, undefined);
  assert.equal(parseCommand('$(echo git) push', 'cmd').expandedCommands, undefined);
});

// Guards the selector, not the rules: if `parseCommand` returned nothing for everything, every
// assertion above that looks for an absence would pass while checking nothing.
test('the parser actually produces invocations and scannable text', () => {
  const parsed = parseCommand('git commit -m "hello" && gh pr create --body "world"');
  assert.ok(parsed.invocations.length >= 2, 'the parser found no invocations at all');
  assert.match(parsed.scannable, /git/);
  assert.match(parsed.scannable, /gh/);
});

test("regression: an Azure DevOps pull request's title, description and merge message are prose, not command text", () => {
  const invocation = parseCommand(
    'az repos pr create --title "merge the work" -d "it merges" --merge-commit-message "merge it" --source-branch topic',
  ).invocations[0];
  assert.deepEqual(invocation?.dataPayloads, ['"merge the work"', '"it merges"', '"merge it"']);
  assert.ok(
    invocation?.args.includes('--source-branch') && invocation.args.includes('topic'),
    'a later flag stays an argument',
  );
  const inline = parseCommand('az repos pr update --id 5 --description="set it to completed"').invocations[0];
  assert.deepEqual(inline?.dataPayloads, ['"set it to completed"']);
});

test("regression: az's --description takes every word up to the next flag", () => {
  const invocation = parseCommand('az repos pr update --id 5 --description "line one" "line two" --title "x"')
    .invocations[0];
  assert.deepEqual(invocation?.dataPayloads, ['"line one"', '"line two"', '"x"']);
  assert.ok(
    !invocation?.args.some((arg) => arg.includes('line')),
    'no paragraph of the description stays in the scan',
  );
});

test("regression: az's description run ends on a quoted option name, and not on a quoted paragraph that opens with a dash", () => {
  const ended = parseCommand('az repos pr update --id 5 --description "notes" "--status" completed')
    .invocations[0];
  assert.deepEqual(ended?.dataPayloads, ['"notes"']);
  assert.ok(
    ended?.args.includes('"--status"') && ended.args.includes('completed'),
    'the option after the run stays in the scan',
  );
  const prose = parseCommand('az repos pr update --id 5 --description "- fixed it" "- tested it"')
    .invocations[0];
  assert.deepEqual(prose?.dataPayloads, ['"- fixed it"', '"- tested it"']);
});

test('control: az prose that could expand stays in the scan, and az outside a pull request write is not prose', () => {
  const expanding = parseCommand('az repos pr create --description "$(git push origin main)"');
  assert.match(expanding.scannable, /git push/);
  const listing = parseCommand('az repos pr list --title "merge"').invocations[0];
  assert.deepEqual(listing?.dataPayloads, []);
});
