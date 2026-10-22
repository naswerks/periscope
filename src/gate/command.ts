/**
 * Parsing a shell command into invocations, so the classifier can classify a shape instead of
 * grepping a string.
 *
 * Why this file exists. A classifier that reads the raw command string produces three defects:
 * a Python heredoc is refused because a boundary word sits in a code comment; `git -C <path>
 * status` is refused as an unrecognised verb because global flags before the subcommand defeat
 * the verb finder; and `gh pr create` is refused as `gh pr merge` because the word appears in the
 * PR body prose — so any body discussing the landing is unpublishable by an agent. All three are
 * one defect: text that the shell will never execute is read as if it were the command.
 *
 * The fix is structural, not a longer pattern. Data payloads are separated here, by construction,
 * and the classifier is only ever handed what is left. Masking them out afterwards fails open the
 * moment the masker misjudges a shape; separating them fails the other way — anything this parser
 * cannot confidently classify as data stays in the scan.
 *
 * The direction is absolute: this narrows what is scanned, never what is denied. Every ambiguity
 * — an unbalanced quote, an unterminated heredoc, a shape this file does not recognise — resolves by
 * leaving the text in the scan. A false refusal costs one human click; a false allow costs the
 * invariant.
 *
 * This is not a shell. It does not know operator precedence, expansion, or `$IFS`; it knows where
 * a command can begin and which argument positions are provably inert data. A general parser would be
 * a larger surface with more ways to be wrong, and the classifier does not need one.
 */

import type { ShellDialect } from './decision.js';

/** A flag that appears before the verb, with its argument when the grammar gives it one. */
export interface GlobalFlag {
  readonly flag: string;
  /** The following token, when this flag's argument is mandatory. Null otherwise. */
  readonly argument: string | null;
}

/**
 * One invocation at a command position.
 *
 * `verb` is null when the invocation has no provable verb — bare `git`, flags and then nothing. That
 * is a refusable state, not a missing value: a call whose verb cannot be determined cannot be shown
 * to be safe.
 */
export interface Invocation {
  /** The command word with any path and `.exe`, `.cmd` or `.bat` stripped, lower-cased. `''` for an empty segment. */
  readonly program: string;
  readonly globalFlags: readonly GlobalFlag[];
  readonly verb: string | null;
  /** Everything after the verb that is not a separated data payload. Quotes preserved. */
  readonly args: readonly string[];
  /** Message arguments and heredoc bodies proven inert. Never handed to the classifier. */
  readonly dataPayloads: readonly string[];
}

export interface ParsedCommand {
  readonly invocations: readonly Invocation[];
  /**
   * Everything the shell could actually execute, reassembled — comments and inert data payloads
   * removed, separators preserved so a pattern spanning a compound still matches.
   *
   * This is what the denylist layer scans. It is the raw command minus provable non-code, never a
   * summary of it.
   */
  readonly scannable: string;
  /** True when a shell interpreter or eval token is present anywhere. See `INTERPRETER_NAMES`. */
  readonly hasInterpreter: boolean;
  /**
   * The POSIX reading with each escaped blank joined into its word (`C:/Program\ Files/…` one path, and
   * `a\ #` one word whose `#` opens no comment), when that changes the words. The classifier refuses when
   * either reading refuses, so the second reading can only add a refusal: a word that begins with an
   * escaped blank is read both ways.
   * @internal
   */
  readonly escapedReading?: ParsedCommand;
}

/**
 * Tokens that execute a string argument.
 *
 * Their presence inverts the tokenizer. Normally a quoted span is one argument, so
 * `bash -c "git push origin main"` puts `git` in the middle of an argument and never at a command
 * position. Handed to one of these, that quoted span is shell, so when any of them appears the quote
 * characters themselves become separators and the nested command lands at a command position where
 * the classifier can see it. Without this inversion, nesting smuggles.
 *
 * A closed, named set — extend by named entry, never by wildcard. Path components are stripped and
 * `.exe`, `.cmd` or `.bat` dropped, so `C:\Windows\System32\cmd.exe` fires and `deploy.sh` does not: running a script
 * file was never scannable at this layer, and pretending otherwise would be a claim the code cannot
 * keep.
 */
export const INTERPRETER_NAMES: readonly string[] = [
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'pwsh',
  'powershell',
  'cmd',
  'xargs',
  'eval',
  'source',
  'iex',
  'icm',
  'invoke-expression',
  'invoke-command',
];

/**
 * Where a new command can begin. Punctuation only; the keyword openers are separate.
 *
 * `{` and `}` are members because `if (…) { git send-pack … }` otherwise never reached a command
 * position at all — the same hole `do`/`then` closed for loops.
 */
const SEPARATORS = new Set(['|', '&', ';', '(', ')', '`', '<', '>', '{', '}', '\n', '\r']);

/**
 * Where a top-level segment ends, for deciding which invocation is receiving a heredoc.
 *
 * This is a different set from `SEPARATORS`, and confusing the two is a real defect: with the
 * wider set, `cat > notes.txt <<BODY` is read wrongly — the redirect ends the segment, so the
 * receiver reads as `notes.txt` rather than `cat`, and a heredoc that is plainly file content is
 * scanned as command text. A redirect changes where output goes; it does not start a new command,
 * so it must not end the segment that owns the heredoc.
 */
const SEGMENT_SEPARATORS = new Set(['|', '&', ';', '(', ')', '`', '\n', '\r']);

/**
 * Shell keywords that open a command position without being punctuation.
 *
 * More separators and more openers can only ever create more command positions, so strictly more
 * invocations reach the classifier and strictly more are refused. Widening this set is structurally
 * incapable of admitting something that is refused today.
 */
const OPENER_KEYWORDS = new Set(['do', 'then', 'else', 'elif']);

/** Receivers whose heredoc body is file content, never command text. */
const DATA_RECEIVERS = new Set(['cat', 'tee']);

/**
 * Programs whose message flags carry prose. The `gh` entries are keyed on `pr create`/`pr edit`, the `az`
 * entries on `repos pr create`/`repos pr update`.
 */
const MESSAGE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  git: ['-m', '--message'],
  gh: ['-t', '--title', '-b', '--body'],
  az: ['--title', '--description', '-d', '--merge-commit-message'],
};

const INLINE_MESSAGE_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  git: ['--message='],
  gh: ['--title=', '--body='],
  az: ['--title=', '--description=', '--merge-commit-message='],
};

/**
 * Message flags whose value is every word up to the next option (`endsVariadicRun`), not one token: `az`'s `--description`
 * takes `"line one" "line two"` as two paragraphs. Each inert literal in the run is data; anything else
 * stays in the scan, as one word after any other message flag does.
 */
const VARIADIC_MESSAGE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  az: ['--description', '-d'],
};

/** Does `words` hold `sequence` as adjacent entries? */
function holdsAdjacent(words: readonly string[], sequence: readonly string[]): boolean {
  for (let i = 0; i + sequence.length <= words.length; i += 1) {
    if (sequence.every((word, offset) => words[i + offset] === word)) return true;
  }
  return false;
}

/** `az repos pr create` or `az repos pr update`, read from the words that are not options. */
function isAzurePullRequestWrite(tokens: readonly string[]): boolean {
  const words = tokens.filter((token) => !token.startsWith('-'));
  return holdsAdjacent(words, ['repos', 'pr', 'create']) || holdsAdjacent(words, ['repos', 'pr', 'update']);
}

/**
 * Git global flags whose following token is their argument rather than the verb.
 *
 * Deliberately not here: `--exec-path`. Bare `git --exec-path` prints and exits, so its argument
 * is optional and only legal in the `=` form — consuming the next token would swallow a real verb and
 * under-refuse. The set is exactly the flags whose argument is mandatory; one added by resemblance
 * rather than by grammar is a hole.
 */
const GIT_FLAGS_TAKING_AN_ARGUMENT = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

/** Read-only terminal flags: git prints and exits, so they are the verb rather than a skipped flag. */
const TERMINAL_GIT_FLAGS = new Set(['--version', '--help']);

// ---------------------------------------------------------------------------

/**
 * The command word with any directory prefix and a trailing `.exe`, `.cmd` or `.bat` removed, lower-cased.
 * Windows runs a program through any of the three: `az` is `az.cmd`, and a `git.cmd` shim runs git.
 */
export function programNameOf(token: string): string {
  const bare = token.replace(/^["']|["']$/g, '');
  const lastSeparator = Math.max(bare.lastIndexOf('/'), bare.lastIndexOf('\\'));
  const component = lastSeparator >= 0 ? bare.slice(lastSeparator + 1) : bare;
  const withoutExtension = /\.(?:exe|cmd|bat)$/i.test(component) ? component.slice(0, -4) : component;
  return withoutExtension.toLowerCase();
}

/**
 * Does this word end a variadic message run? `az`'s argument parser ends one on a word that starts with
 * `-` once the shell has removed its quotes and holds no space, so a quoted option name (`"--status"`)
 * ends it as a bare one does, and a quoted paragraph that starts with a dash (`"- fixed it"`) does not.
 */
function endsVariadicRun(word: string): boolean {
  const received = word.replace(/["']/g, '');
  return received.startsWith('-') && !received.includes(' ');
}

/**
 * Is this token provably a literal that cannot expand?
 *
 * Parsing does not make a payload safe, and this is where that is enforced. A single-quoted span
 * is literal by grammar in both POSIX shells and PowerShell. A double-quoted span is literal only
 * without `$` or a backtick, because both shells expand `"$(git push …)"` inside double quotes — so
 * an interpolating message argument stays in the scan and is classified like any other command text.
 * A bare argument is never inert.
 */
export function isInertLiteral(token: string): boolean {
  if (token.length < 2) return false;
  const quote = token[0];
  if (quote !== '"' && quote !== "'") return false;
  if (token[token.length - 1] !== quote) return false;
  if (quote === "'") return true;
  return !token.includes('$') && !token.includes('`');
}

/**
 * Drop `#`-to-end-of-line comments at word position, outside quotes.
 *
 * This is the precise fix for the comment-in-heredoc defect. A boundary word inside `# don't do X`
 * cannot be executed by anything, yet a raw-string classifier reads it as command text and refuses
 * a benign script. `#` opens a comment at word position in sh, PowerShell, Python, Perl, Ruby and
 * PHP — it cannot open one mid-token (`a#b` is one word) and it cannot survive a quote, so both
 * conditions are checked rather than assumed.
 *
 * Narrowing what is scanned, again: a comment cannot invoke anything, so removing it cannot admit
 * an invocation. A `#` inside a quoted span is left alone, because a quoted span may be an argument
 * to an interpreter and interpreters do not honour this parser's idea of a comment.
 */
export function stripComments(command: string): string {
  return stripPosixComments(command, false);
}

/**
 * `stripComments`, with a POSIX shell's escaped blank read when `escapes` is set: outside a quote, a blank
 * after an unpaired backslash is part of the word before it, so it starts no word and a `#` after it is
 * mid-word, as bash reads `echo a\ # ; git push` (one word `a #`, then the push). Only the blank is read
 * as escaped: a backslash before a quote is not, so a quote after one still opens a span, the reading
 * that scans more.
 */
function stripPosixComments(command: string, escapes: boolean): string {
  let result = '';
  let quote = '';
  let atWordStart = true;
  let backslashes = 0;

  for (let i = 0; i < command.length; i += 1) {
    const character = command[i] as string;

    if (quote !== '') {
      result += character;
      if (character === quote) quote = '';
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      atWordStart = false;
      backslashes = 0;
      continue;
    }

    if (character === '#' && atWordStart) {
      // Skip to the end of the line; the newline itself survives because it is a separator.
      while (i < command.length && command[i] !== '\n') i += 1;
      if (i < command.length) result += '\n';
      atWordStart = true;
      backslashes = 0;
      continue;
    }

    result += character;
    const escapedBlank = escapes && backslashes % 2 === 1 && (character === ' ' || character === '\t');
    backslashes = character === '\\' ? backslashes + 1 : 0;
    atWordStart =
      !escapedBlank &&
      (character === ' ' ||
        character === '\t' ||
        character === '\n' ||
        character === '\r' ||
        SEPARATORS.has(character));
  }

  return result;
}

/**
 * Drop PowerShell's comments: a `<# … #>` block, which ends at its own `#>` and lets the line go on,
 * and a `#` at word position, which runs to the end of the line. Outside quotes a backtick escapes the
 * next character, so `` `# `` is not a comment; inside double quotes a backtick escapes the next
 * character and `""` is a quote, and inside single quotes `''` is a quote, so a quote that closes in
 * neither grammar's sense does not end the span early.
 *
 * The POSIX reading of the same text sees `<#` as a redirection followed by a comment to the end of
 * the line, which hides `<# note #> git push` from every later check. That is why a PowerShell command
 * is read both ways and refused when either reading refuses. An unterminated `<#` is left in place:
 * the reading that scans more.
 */
export function stripPowerShellComments(command: string): string {
  let result = '';
  let quote = '';
  let atWordStart = true;

  for (let i = 0; i < command.length; i += 1) {
    const character = command[i] as string;

    if (quote === "'") {
      result += character;
      if (character === "'") {
        if (command[i + 1] === "'") {
          result += "'";
          i += 1;
        } else quote = '';
      }
      continue;
    }

    if (quote === '"') {
      result += character;
      if (character === '`' && i + 1 < command.length) {
        result += command[i + 1] as string;
        i += 1;
      } else if (character === '"') {
        if (command[i + 1] === '"') {
          result += '"';
          i += 1;
        } else quote = '';
      }
      continue;
    }

    if (character === '`' && i + 1 < command.length) {
      result += character + (command[i + 1] as string);
      i += 1;
      atWordStart = false;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      atWordStart = false;
      continue;
    }

    if (character === '<' && command[i + 1] === '#') {
      const close = command.indexOf('#>', i + 2);
      if (close === -1) {
        // Unterminated: kept, and its `#` is not read as a comment either, so the rest stays scanned.
        result += '<#';
        i += 1;
        atWordStart = false;
        continue;
      }
      // The block is replaced by a space, so the words on either side stay apart.
      result += ' ';
      i = close + 1;
      atWordStart = true;
      continue;
    }

    if (character === '#' && atWordStart) {
      while (i < command.length && command[i] !== '\n') i += 1;
      if (i < command.length) result += '\n';
      atWordStart = true;
      continue;
    }

    result += character;
    atWordStart =
      character === ' ' ||
      character === '\t' ||
      character === '\n' ||
      character === '\r' ||
      SEPARATORS.has(character);
  }

  return result;
}

/**
 * A `cmd.exe` command as the shared tokenizer can read it: what `cmd.exe` itself would run.
 *
 * Three rules differ from a POSIX shell's, and each would hide text from the POSIX reading. Outside
 * double quotes a caret escapes the next character, so `git pu^sh` runs `git push`: the caret is
 * removed and the character kept. A single quote is no quote at all, so `echo 'a & git push'` runs
 * `git push` after the `&`: each one is read as a space. And `#` opens no comment, so nothing is
 * stripped. Inside double quotes a caret is an ordinary character. There is no heredoc to set aside.
 * Every difference is resolved toward scanning more text, never less.
 */
export function readCmdCommand(command: string): string {
  let result = '';
  let quoted = false;
  for (let i = 0; i < command.length; i += 1) {
    const character = command[i] as string;
    if (character === '"') {
      quoted = !quoted;
      result += character;
      continue;
    }
    if (!quoted && character === '^' && i + 1 < command.length) {
      result += command[i + 1] as string;
      i += 1;
      continue;
    }
    result += !quoted && character === "'" ? ' ' : character;
  }
  return result;
}

/**
 * Split into tokens, with separators preserved as their own single-character tokens.
 *
 * `quotesAreSeparators` is the interpreter inversion: when set, the quote characters that delimit a
 * payload become separators, not merely token breaks, so an interpreter's quoted payload starts at
 * a command position and the classifier can see the invocation inside it. A token break alone would
 * not be enough: `bash -c "git send-pack …"` would put `git` immediately after `-c`, which is an
 * argument position, and the verb allowlist only reads invocations at command positions.
 *
 * Inside a delimited payload a quote of the other kind is the nested command's own quoting and stays
 * inside its token: `bash -c "git branch 'topic' -d"` must reach the classifier as one segment, or a
 * quoted argument splits a segment-scoped rule between the verb and its flag. The delimiter itself
 * always closes the payload, even inside such a nested quote, so text after it is never swallowed
 * into a token and stays in the scan.
 *
 * An unbalanced quote does not fail: it falls through to the end of the input as one long token,
 * which keeps its text in the scan. Failing would have to choose a direction, and the only safe
 * direction is the one that scans more.
 *
 * Inside a delimited payload a `#` at word start opens a comment to the end of the line, as the
 * interpreter receiving the payload reads it. `stripComments` leaves quoted spans alone because a
 * quoted span may be data; once the inversion has decided a span is a nested command, the nested
 * shell's own comment rule applies, so `bash -c "git status # push"` scans `git status` and
 * nothing else, exactly as the same text does outside the quotes.
 */
export function tokenize(command: string, quotesAreSeparators = false): string[] {
  return splitWords(command, quotesAreSeparators, false);
}

/**
 * Does this character, after an escaped blank, continue the word? A `#` does: the escaped blank started
 * no word, so the `#` is mid-word and opens no comment.
 */
function continuesWord(character: string | undefined): boolean {
  return (
    character !== undefined &&
    character !== ' ' &&
    character !== '\t' &&
    character !== '\n' &&
    character !== '\r' &&
    !SEPARATORS.has(character)
  );
}

/**
 * `tokenize`, with a POSIX shell's escaped blank read when `escapes` is set: outside a quote, a
 * backslash before a blank that continues the word joins the word, as `C:/Program\ Files/…` is one path
 * to bash. Read only where it splits words: `\\` is a pair, so its second backslash escapes nothing, and a
 * blank before a separator or the end is left as it was. Inside an interpreter's payload a `#` after an
 * escaped blank is joined into the word too, so it opens no comment there either. PowerShell and cmd.exe
 * read a backslash as an ordinary character, so only the POSIX reading sets it.
 */
function splitWords(command: string, quotesAreSeparators: boolean, escapes: boolean): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  let nested = '';
  let skippingComment = false;

  const flush = (): void => {
    if (current !== '') tokens.push(current);
    current = '';
  };

  const characters = [...command];
  for (let i = 0; i < characters.length; i += 1) {
    const character = characters[i] as string;
    if (quotesAreSeparators) {
      if (skippingComment) {
        if (character !== '\n') continue;
        skippingComment = false;
      }
      if (character === '"' || character === "'") {
        if (quote === '') {
          flush();
          tokens.push('\n');
          quote = character;
          continue;
        }
        if (character === quote) {
          flush();
          tokens.push('\n');
          quote = '';
          nested = '';
          continue;
        }
        nested = nested === character ? '' : character;
        current += character;
        continue;
      }
      if (nested !== '') {
        current += character;
        continue;
      }
      if (quote !== '' && character === '#' && current === '') {
        skippingComment = true;
        continue;
      }
    } else if (quote !== '') {
      current += character;
      if (character === quote) quote = '';
      continue;
    } else if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }

    if (escapes && character === '\\') {
      const next = characters[i + 1];
      if (next === '\\') {
        current += '\\\\';
        i += 1;
        continue;
      }
      if ((next === ' ' || next === '\t') && continuesWord(characters[i + 2])) {
        current += next;
        i += 1;
        continue;
      }
    }

    if (SEPARATORS.has(character)) {
      flush();
      tokens.push(character);
      continue;
    }

    if (character === ' ' || character === '\t') {
      flush();
      continue;
    }

    current += character;
  }

  flush();
  return tokens;
}

// ---------------------------------------------------------------------------

interface HeredocIntro {
  readonly delimiter: string;
  readonly index: number;
}

/**
 * The first top-level `<<DELIM` on a line, outside quotes. `<<<` is a here-string (one word) and is
 * deliberately not one.
 */
function findHeredocIntro(line: string): HeredocIntro | null {
  let quote = '';
  for (let i = 0; i < line.length - 1; i += 1) {
    const character = line[i] as string;
    if (quote !== '') {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character !== '<' || line[i + 1] !== '<') continue;
    if (line[i + 2] === '<') {
      i += 2;
      continue;
    }
    let j = i + 2;
    if (line[j] === '-') j += 1;
    while (line[j] === ' ') j += 1;
    let delimiterQuote = '';
    if (line[j] === '"' || line[j] === "'") {
      delimiterQuote = line[j] as string;
      j += 1;
    }
    const start = j;
    while (j < line.length && /[A-Za-z0-9_]/.test(line[j] as string)) j += 1;
    if (j === start) return null;
    if (delimiterQuote !== '' && line[j] !== delimiterQuote) return null;
    return { delimiter: line.slice(start, j), index: i };
  }
  return null;
}

/**
 * Which program is receiving this line's heredoc, for the data-sink decision.
 *
 * A heredoc into an interpreter is code and stays scanned. That is why the set of sinks is an
 * allowlist rather than "anything but a shell": an unknown receiver might execute its input, and
 * unknown-means-scan is the only direction that cannot open a door.
 */
function heredocReceiverIsDataSink(line: string, upTo: number): boolean {
  let segmentStart = 0;
  let quote = '';
  for (let i = 0; i < upTo; i += 1) {
    const character = line[i] as string;
    if (quote !== '') {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (SEGMENT_SEPARATORS.has(character)) segmentStart = i + 1;
  }
  const receiving = line.slice(segmentStart, upTo).trim();
  const tokens = tokenize(receiving);
  if (tokens.length === 0) return false;
  const program = programNameOf(tokens[0] as string);
  if (DATA_RECEIVERS.has(program)) return true;
  if (program === 'git') return tokens.some((token) => token === 'commit');
  if (program === 'gh') {
    const words = tokens.slice(1).filter((token) => !token.startsWith('-'));
    return words[0] === 'pr' && (words[1] === 'create' || words[1] === 'edit');
  }
  if (program === 'az') return isAzurePullRequestWrite(tokens.slice(1));
  return false;
}

/**
 * Blank the bodies of heredocs whose receiver only ever treats them as data.
 *
 * An unterminated heredoc leaves everything in place — the over-refusal direction.
 */
function separateHeredocBodies(command: string): { text: string; payloads: string[] } {
  const lines = command.split('\n');
  const payloads: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const intro = findHeredocIntro(lines[i] as string);
    if (intro === null) continue;

    let terminator = i + 1;
    while (terminator < lines.length && (lines[terminator] as string).trim() !== intro.delimiter)
      terminator += 1;
    if (terminator >= lines.length) return { text: command, payloads: [] };

    if (heredocReceiverIsDataSink(lines[i] as string, intro.index)) {
      for (let body = i + 1; body < terminator; body += 1) {
        payloads.push(lines[body] as string);
        lines[body] = '';
      }
    }
    i = terminator;
  }

  return { text: lines.join('\n'), payloads };
}

// ---------------------------------------------------------------------------

/** Does this invocation's shape make its message flags carry prose rather than code? */
function isMessageBearing(program: string, tokens: readonly string[]): boolean {
  if (program === 'git') return tokens.some((token) => token === 'commit');
  if (program === 'az') return isAzurePullRequestWrite(tokens);
  if (program !== 'gh') return false;
  const words = tokens.filter((token) => !token.startsWith('-'));
  return words[0] === 'pr' && (words[1] === 'create' || words[1] === 'edit');
}

/**
 * One command position's tokens, read as an invocation.
 *
 * The verb is found by grammar, not by position. Global flags are skipped, and the five whose
 * argument is mandatory consume the token after them — which is the whole reason `git -C <path>
 * status` reads `status` here and not `<path>`.
 */
function readInvocation(tokens: readonly string[]): { invocation: Invocation; scannable: string[] } {
  if (tokens.length === 0) {
    return {
      invocation: { program: '', globalFlags: [], verb: null, args: [], dataPayloads: [] },
      scannable: [],
    };
  }

  const program = programNameOf(tokens[0] as string);
  const globalFlags: GlobalFlag[] = [];
  const args: string[] = [];
  const dataPayloads: string[] = [];
  const messageBearing = isMessageBearing(program, tokens.slice(1));
  const flags = MESSAGE_FLAGS[program] ?? [];
  const inlinePrefixes = INLINE_MESSAGE_PREFIXES[program] ?? [];
  const variadic = VARIADIC_MESSAGE_FLAGS[program] ?? [];

  // Built alongside, never filtered afterwards. Deriving the scannable tokens by removing anything
  // that appears in `dataPayloads` silently fails on the inline form: the token is `--body="…"`
  // while the payload is `"…"`, so the token matches nothing and the prose goes straight into the
  // scan. Deciding what is scannable at the point the payload is recognised
  // makes the two impossible to disagree.
  const scannable: string[] = [tokens[0] as string];

  let verb: string | null = null;
  let index = 1;

  // Global flags run until the first non-flag token, which is the verb.
  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (program === 'git' && TERMINAL_GIT_FLAGS.has(token)) {
      verb = token;
      scannable.push(token);
      index += 1;
      break;
    }
    if (program === 'git' && GIT_FLAGS_TAKING_AN_ARGUMENT.has(token)) {
      const argument = tokens[index + 1] ?? null;
      globalFlags.push({ flag: token, argument });
      scannable.push(token);
      if (argument !== null) scannable.push(argument);
      index += 2;
      continue;
    }
    if (token.startsWith('-')) {
      globalFlags.push({ flag: token, argument: null });
      scannable.push(token);
      index += 1;
      continue;
    }
    verb = token;
    scannable.push(token);
    index += 1;
    break;
  }

  // The tail, with message payloads separated out where the shape earns it.
  for (; index < tokens.length; index += 1) {
    const token = tokens[index] as string;

    if (messageBearing) {
      const inlinePrefix = inlinePrefixes.find((prefix) => token.startsWith(prefix));
      if (inlinePrefix !== undefined) {
        const payload = token.slice(inlinePrefix.length);
        if (isInertLiteral(payload)) {
          dataPayloads.push(payload);
          // The flag itself stays visible; only its argument leaves the scan.
          scannable.push(inlinePrefix);
        } else {
          // An interpolating payload is not data — it goes back into the scan as an argument.
          args.push(token);
          scannable.push(token);
        }
        continue;
      }
      if (flags.includes(token)) {
        args.push(token);
        scannable.push(token);
        // One word, or for a variadic flag every word up to the next option.
        const last = variadic.includes(token) ? tokens.length - 1 : index + 1;
        while (index + 1 <= last && index + 1 < tokens.length) {
          const payload = tokens[index + 1] as string;
          if (variadic.includes(token) && endsVariadicRun(payload)) break;
          if (isInertLiteral(payload)) dataPayloads.push(payload);
          else {
            args.push(payload);
            scannable.push(payload);
          }
          index += 1;
        }
        continue;
      }
    }

    args.push(token);
    scannable.push(token);
  }

  return { invocation: { program, globalFlags, verb, args, dataPayloads }, scannable };
}

/**
 * Words read as one invocation, by the same grammar as a command position: for the classifier, which
 * finds a command inside another's words — a launcher's (`env git push`) or text a program will run
 * (`ssh host "git push"`). Not part of the gate's barrel.
 */
export function invocationOf(tokens: readonly string[]): Invocation {
  return readInvocation(tokens).invocation;
}

/**
 * Parse a command into its invocations and the text a classifier may scan.
 *
 * Total: every input produces a result. An input this parser cannot make sense of yields invocations
 * it could read and a `scannable` that still holds everything else.
 */
export function parseCommand(command: string, dialect: ShellDialect = 'posix'): ParsedCommand {
  const withoutComments =
    dialect === 'powershell'
      ? stripPowerShellComments(command)
      : dialect === 'cmd'
        ? readCmdCommand(command)
        : stripComments(command);
  const plain = wordsOfText(withoutComments, dialect === 'posix', false);
  const parsed: ParsedCommand = { ...positionsOf(plain.tokens), hasInterpreter: plain.hasInterpreter };
  if (dialect !== 'posix') return parsed;
  // A POSIX shell joins an escaped blank into its word, so a `#` after one is inside that word and opens
  // no comment; PowerShell and cmd.exe have no such escape. Read that way too, from the comments on,
  // beside the reading above, only when it changes the words.
  const escaped = wordsOfText(stripPosixComments(command, true), true, true);
  const tokens = plain.tokens;
  if (
    escaped.tokens.length === tokens.length &&
    escaped.tokens.every((token, index) => token === tokens[index])
  )
    return parsed;
  return {
    ...parsed,
    escapedReading: { ...positionsOf(escaped.tokens), hasInterpreter: escaped.hasInterpreter },
  };
}

/**
 * A command's text, its comments already removed, split into words: whether an interpreter is named, the
 * heredoc bodies a data sink receives set aside when `heredocs` is set, and the split. PowerShell and
 * cmd.exe have no heredoc: `<<` there is not a body to separate, so nothing is set aside as data.
 */
function wordsOfText(
  text: string,
  heredocs: boolean,
  escapes: boolean,
): { tokens: string[]; hasInterpreter: boolean } {
  const hasInterpreter = tokenize(text).some((token) => INTERPRETER_NAMES.includes(programNameOf(token)));
  const body = heredocs ? separateHeredocBodies(text).text : text;
  return { tokens: splitWords(body, hasInterpreter, escapes), hasInterpreter };
}

/** A command's tokens read position by position: its invocations and the text a classifier may scan. */
function positionsOf(tokens: readonly string[]): { invocations: Invocation[]; scannable: string } {
  const invocations: Invocation[] = [];
  const scannableTokens: string[] = [];

  let position: string[] = [];
  let atCommandPosition = true;

  const closePosition = (): void => {
    if (position.length > 0) {
      // The separation is what reaches the scan. The reader decides scannability as it recognises
      // each payload, so the classifier is handed text that could actually run.
      const read = readInvocation(position);
      invocations.push(read.invocation);
      scannableTokens.push(...read.scannable);
    }
    position = [];
  };

  for (const token of tokens) {
    if (token.length === 1 && SEPARATORS.has(token)) {
      closePosition();
      scannableTokens.push(token);
      atCommandPosition = true;
      continue;
    }
    if (atCommandPosition && OPENER_KEYWORDS.has(token.toLowerCase())) {
      // A keyword opener is not part of the invocation it introduces, and it opens another one.
      closePosition();
      scannableTokens.push(token);
      continue;
    }
    if (!atCommandPosition && OPENER_KEYWORDS.has(token.toLowerCase())) {
      closePosition();
      scannableTokens.push(token);
      atCommandPosition = true;
      continue;
    }
    position.push(token);
    atCommandPosition = false;
  }
  closePosition();

  return { invocations, scannable: scannableTokens.join(' ') };
}
