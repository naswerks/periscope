/**
 * The shell backstop under generated commands: the parser and the classifier together.
 *
 * shell.test.ts pins named shapes. These state what must hold for every input: totality and
 * determinism over arbitrary text, the comment stripper's idempotence, the program-name
 * normalisation, and three monotonicity claims (quoting, composition, a trailing comment) whose
 * preconditions are stated exactly, because the parser is not a shell and its refusing direction is
 * deliberate. A precondition here is part of the claim, not a way of hiding a failure; where a
 * looser claim is false, the test below the property says which input falsifies it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { propertyRuns } from '../test-support/property.js';

import { INTERPRETER_NAMES, parseCommand, stripComments, stripPosixComments } from './command.js';
import { classifyShellCommand } from './shell.js';

const RUNS = propertyRuns();

// ---------------------------------------------------------------------------
// A command generator with the vocabulary the classifier cares about. Random text almost never
// spells `git branch -d`, so the shapes that matter are assembled from tokens, and raw strings are
// mixed in for the totality claims.
// ---------------------------------------------------------------------------

/** The git verbs `shell.ts` admits unconditionally, restated here so the claim is explicit. */
const ALLOWED_GIT_VERBS = [
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
  'merge-tree',
  '--version',
  '--help',
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
  'hash-object',
  'fetch',
  'pull',
  'ls-remote',
];

/** The words the denylist keys on. A path or a note carrying one is scanned as command text. */
const BOUNDARY_WORDS = /\b(git|gh|push|remote|branch|delete|pr|merge|stash)\b/i;

const PROGRAMS = [
  'git',
  'gh',
  'npm',
  'ls',
  'cat',
  'tr',
  'echo',
  'node',
  'bash',
  'sh',
  'pwsh',
  'xargs',
  'C:\\Git\\bin\\git.exe',
  './git',
];
const VERBS = [
  ...ALLOWED_GIT_VERBS,
  'push',
  'send-pack',
  'remote',
  'config',
  'STATUS',
  'publish',
  'pr',
  'create',
  '-C',
  '-c',
];
const ARGS = [
  '-d',
  '-D',
  '--delete',
  'origin',
  'main',
  "'topic'",
  '"topic"',
  '-m',
  "'do not push'",
  '"$(git push)"',
  '--get',
  'user.email',
  '--unset',
  '-v',
  'show',
  'add',
  'set-url',
  '--',
  'src/a.ts',
  '-f',
  'HEAD',
  '--contains',
  'abc123',
  '-r',
  'push',
  'merge',
  'stash',
  '#',
  'x',
  '/repo',
  "''",
  'do',
  'then',
  '-i',
];
const JOINERS = [' ; ', ' && ', ' | ', '\n', ' || ', ' '];

const WORDS: readonly string[] = [...VERBS, ...ARGS];
const wordArb: fc.Arbitrary<string> = fc.constantFrom<string>(...WORDS);

/** Non-ASCII text, and text built from the characters the tokenizer treats specially. */
const anyUnicodeString = fc.oneof(
  fc.string({ unit: 'grapheme' }),
  fc.string({
    unit: fc.constantFrom(
      '\ud83d',
      '\u{1F600}',
      'é',
      '"',
      "'",
      '`',
      '$',
      '#',
      '<',
      '>',
      '|',
      ';',
      '&',
      '(',
      ')',
      '{',
      '}',
      '\n',
      '\r',
      '\t',
      ' ',
      '\\',
      '/',
      '-',
      'git',
      'push',
    ),
  }),
);

const invocationArb = fc
  .tuple(fc.constantFrom(...PROGRAMS), fc.array(wordArb, { maxLength: 5 }))
  .map(([program, words]) => [program, ...words].join(' '));

/** The branch shapes, dense, because the segment-scoped rule is where a split can hide a flag. */
const branchArb = fc
  .array(
    fc.constantFrom('-d', '-D', '--delete', "'topic'", 'topic', "''", '-r', '--contains', 'abc123', '"x"'),
    { maxLength: 4 },
  )
  .map((words) => ['git', 'branch', ...words].join(' '));

const heredocArb = fc
  .tuple(
    fc.constantFrom('cat', 'python', 'git commit -F -', 'tee out.txt'),
    fc.array(invocationArb, { maxLength: 2 }),
    fc.boolean(),
  )
  .map(([receiver, body, terminated]) =>
    [`${receiver} <<EOF`, ...body, terminated ? 'EOF' : 'EOF '].join('\n'),
  );

const compoundArb = fc
  .tuple(
    fc.array(
      fc.oneof(
        { weight: 3, arbitrary: invocationArb },
        { weight: 1, arbitrary: branchArb },
        { weight: 1, arbitrary: heredocArb },
      ),
      {
        minLength: 1,
        maxLength: 3,
      },
    ),
    fc.array(fc.constantFrom(...JOINERS), { minLength: 2, maxLength: 2 }),
  )
  .map(([parts, joiners]) =>
    parts.reduce((text, part, index) => (index === 0 ? part : `${text}${joiners[index % 2]}${part}`), ''),
  );

const commandArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: compoundArb },
  {
    weight: 1,
    arbitrary: fc.tuple(compoundArb, fc.string()).map(([command, comment]) => `${command} # ${comment}`),
  },
  { weight: 1, arbitrary: fc.string() },
  { weight: 1, arbitrary: anyUnicodeString },
);

const anyTextArb = fc.oneof(fc.string(), anyUnicodeString, commandArb);

const refuses = (command: string): boolean => classifyShellCommand(command) !== null;

/** Does the tokenizer's quote machine end outside a quote? Mirrors `tokenize`, which has no escapes. */
function endsOutsideQuotes(text: string): boolean {
  let quote = '';
  for (const character of text) {
    if (quote !== '') {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    }
  }
  return quote === '';
}

const hasInterpreterToken = (text: string): boolean => parseCommand(text).hasInterpreter;

/** Does the text end in an unpaired backslash, which escapes a blank appended after it? */
const endsInEscape = (text: string): boolean => /(?:^|[^\\])(?:\\\\)*\\$/.test(text);

/**
 * Does the command end outside a quote, and outside an escape, in both POSIX readings: comments stripped
 * as the split reading strips them, and as the escaped reading does, where a `#` after an escaped blank is
 * mid-word and the text after it is kept?
 */
const endsOpenInBothReadings = (command: string): boolean => {
  const escaped = stripPosixComments(command, true);
  return endsOutsideQuotes(stripComments(command)) && endsOutsideQuotes(escaped) && !endsInEscape(escaped);
};

// ---------------------------------------------------------------------------

test('parsing and classifying never throw and answer the same twice for any text', () => {
  fc.assert(
    fc.property(anyTextArb, (command) => {
      assert.deepEqual(parseCommand(command), parseCommand(command));
      assert.deepEqual(classifyShellCommand(command), classifyShellCommand(command));
    }),
    RUNS,
  );
});

test('stripping comments is idempotent', () => {
  fc.assert(
    fc.property(anyTextArb, (command) => {
      const once = stripComments(command);
      assert.equal(stripComments(once), once);
    }),
    RUNS,
  );
});

test('every parsed program name is lower-case and carries no path separator', () => {
  fc.assert(
    fc.property(anyTextArb, (command) => {
      for (const invocation of parseCommand(command).invocations) {
        assert.equal(invocation.program, invocation.program.toLowerCase());
        assert.ok(
          !invocation.program.includes('/') && !invocation.program.includes('\\'),
          invocation.program,
        );
      }
    }),
    RUNS,
  );
});

// The precondition excludes the characters the interpreter inversion re-reads: a quote becomes a
// separator inside `bash -c "..."` and can move a flag across a segment boundary (the finding
// pinned below). A `#` is no longer excluded: a comment inside the payload is a comment to the
// nested shell too, and the tokenizer reads it that way, so the answer is the same on both sides.
// Single-line heads only: inside an interpreter payload a heredoc's newlines are segment separators,
// so a heredoc that over-refuses on its own (an unterminated body keeps its text in the scan) can flow
// correctly inside `bash -c`. That is the refusing direction on the outside, not a hole on the inside.
test('a single-line command with no quotes, comments or expansions that refuses still refuses inside bash -c "..."', () => {
  const eligible = commandArb.filter((command) => !/["'$`\n\r]/.test(command));
  fc.assert(
    fc.property(eligible, (command) => {
      fc.pre(refuses(command));
      assert.ok(
        refuses(`bash -c "${command}"`),
        `refused alone, flowed inside bash -c: ${JSON.stringify(command)}`,
      );
    }),
    RUNS,
  );
});

// A comment inside an interpreter payload is a comment, as it is outside one: `bash -c "git status #
// push"` and `git status # push` both flow, and `git status # stash\ngit push` refuses on the push in
// its second line, inside `bash -c` or not. Each pair answers alike. A bare `push` on the next line is a
// program named push, not git's subcommand, so the control is a real `git push`.
test('regression: a comment inside bash -c is a comment, so the answer matches the same text outside', () => {
  assert.equal(
    classifyShellCommand('git status # push'),
    null,
    'the control: a trailing comment flows on its own',
  );
  assert.equal(
    classifyShellCommand('bash -c "git status # push"'),
    null,
    'the same comment inside the payload flows',
  );
  const outside = classifyShellCommand('git status # stash\ngit push');
  assert.notEqual(outside, null, 'the control: a push on the next line refuses on its own');
  assert.deepEqual(
    classifyShellCommand('bash -c "git status # stash\ngit push"'),
    outside,
    'the same lines inside the payload refuse for the same reason',
  );
});

// A branch deletion that refuses on its own once flowed inside an interpreter: the inversion turned
// the quoted argument into a segment break between `branch` and `-d`. A nested quote of the other
// kind now stays inside the payload's segment.
test('regression: a quoted argument inside bash -c does not split the segment-scoped branch-delete rule', () => {
  assert.notEqual(classifyShellCommand("git branch 'topic' -d"), null, 'the control: refused on its own');
  assert.notEqual(
    classifyShellCommand('bash -c "git branch \'topic\' -d"'),
    null,
    'must refuse inside the interpreter',
  );
  assert.notEqual(classifyShellCommand('sh -c \'git push "origin" main\''), null, 'the other nesting order');
});

// The delimiter always closes the payload, so a nested quote left open cannot swallow what follows.
test('control: a nested quote left open inside bash -c does not hide a command after the delimiter', () => {
  assert.notEqual(
    classifyShellCommand('bash -c "echo \'a" ; git push origin main'),
    null,
    'the push after the payload must stay in the scan',
  );
});

// The tail is one line: a line it supplies can otherwise close a heredoc the head left open, and
// the head's body (the very text that refused) becomes data the receiver never executes. That is
// the parser reading the shell correctly, not a hole, so the claim is stated for a one-line tail.
// The head must also end outside a quote: text appended inside an open quote is quoted data, not a
// following command, and a shell would refuse to run either form.
test('a command that refuses still refuses with a one-line command appended after a semicolon', () => {
  const tail = commandArb.filter((text) => !/["'\n\r]/.test(text) && !hasInterpreterToken(text));
  fc.assert(
    fc.property(commandArb, tail, (command, appended) => {
      fc.pre(endsOutsideQuotes(stripComments(command)));
      fc.pre(refuses(command));
      assert.ok(
        refuses(`${command} ; ${appended}`),
        `refused alone, flowed with a tail: ${JSON.stringify([command, appended])}`,
      );
    }),
    RUNS,
  );
});

// Outside a quote a `#` at word start opens a comment the stripper removes before anything else
// reads the text, so the note cannot reach a rule. Inside an unbalanced quote it is quoted text,
// which is why the command must end outside one, in both POSIX readings: a blank after an unpaired
// backslash is part of the word before it, so a `#` after one opens no comment (`echo a\ # ; git push`
// runs the push) and the escaped reading keeps the text after it, quotes included. A command that ends
// in an unpaired backslash escapes the blank in front of the note, which is then words of the command
// and not a comment, so the claim is stated for a command that does not.
test('a trailing comment never changes the outcome of a command that ends outside a quote and an escape', () => {
  const note = fc
    .oneof(fc.string(), fc.constantFrom('git push origin main', "it's", 'do not merge', '"', 'EOF'))
    .filter((text) => !text.includes('\n') && !text.includes('\r'));
  const eligible = anyTextArb.filter(endsOpenInBothReadings);
  fc.assert(
    fc.property(eligible, note, (command, appended) => {
      assert.deepEqual(classifyShellCommand(`${command} # ${appended}`), classifyShellCommand(command));
    }),
    RUNS,
  );
});

// The path here carries no boundary word, so this claim holds whatever reads the path. The property
// below it states the stronger claim the boundary rules make: a path naming one flows too.
test('every allowed git verb stays allowed behind a -C <path> global flag naming no boundary word', () => {
  const segment = fc.constantFrom(
    'repo',
    'src',
    'x',
    'push',
    'remote',
    'gh',
    'pr',
    'merge',
    'a-b',
    'c.d',
    'C:',
    'work tree',
  );
  const pathArb = fc
    .array(segment, { minLength: 1, maxLength: 3 })
    .map((segments) => segments.join('/'))
    .filter((path) => !path.includes(' ') && !BOUNDARY_WORDS.test(path));
  fc.assert(
    fc.property(fc.constantFrom(...ALLOWED_GIT_VERBS), pathArb, (verb, path) => {
      fc.pre(!refuses(`git ${verb}`));
      assert.equal(
        classifyShellCommand(`git -C ${path} ${verb}`),
        null,
        `git -C ${path} ${verb} was refused`,
      );
    }),
    RUNS,
  );
});

// The boundary rules read the subcommand, not a word in a path: a path is one token, and a boundary word
// inside it (`push`, `remote`, `pre-push.log`, a folder named `gh`) cannot complete a rule.
test('regression: every allowed git verb stays allowed behind a -C <path> global flag, whatever boundary word the path holds', () => {
  const segment = fc.constantFrom(
    'repo',
    'src',
    'push',
    'remote',
    'gh',
    'pr',
    'merge',
    'branch',
    'delete',
    'stash',
    'a-b',
    'c.d',
    'pre-push.log',
    'edit-remote-work',
  );
  const pathArb = fc.array(segment, { minLength: 1, maxLength: 3 }).map((segments) => segments.join('/'));
  fc.assert(
    fc.property(fc.constantFrom(...ALLOWED_GIT_VERBS), pathArb, (verb, path) => {
      fc.pre(!refuses(`git ${verb}`));
      assert.equal(
        classifyShellCommand(`git -C ${path} ${verb}`),
        null,
        `git -C ${path} ${verb} was refused`,
      );
    }),
    RUNS,
  );
});

test('control: the generator produces commands the classifier both refuses and admits', () => {
  const samples = fc.sample(commandArb, { numRuns: 300, seed: 7 });
  assert.ok(samples.some(refuses), 'no generated command refused; the vocabulary is not reaching the rules');
  assert.ok(
    samples.some((command) => !refuses(command)),
    'every generated command refused; the properties would be vacuous',
  );
  assert.ok(
    INTERPRETER_NAMES.includes('bash'),
    'the quoting claim wraps in an interpreter the parser inverts on',
  );
  assert.ok(
    endsOutsideQuotes("a 'b' c") && !endsOutsideQuotes("a 'b"),
    'the quote machine must discriminate',
  );
  assert.ok(endsInEscape('a\\') && endsInEscape('a\\\\\\'), 'an unpaired backslash at the end escapes');
  assert.ok(
    !endsInEscape('a\\\\') && !endsInEscape('a\\b'),
    'a pair, or a backslash before a letter, does not',
  );
  assert.ok(
    endsOpenInBothReadings('a\\ #b') && !endsOpenInBothReadings("a\\ # it's"),
    'the escaped reading keeps its quote',
  );
});
