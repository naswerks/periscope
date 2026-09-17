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
  /** The command word with any path and `.exe` stripped, lower-cased. `''` for an empty segment. */
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
 * `.exe` dropped, so `C:\Windows\System32\cmd.exe` fires and `deploy.sh` does not: running a script
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

/** Programs whose message flags carry prose. The `gh` entries are keyed on `pr create`/`pr edit`. */
const MESSAGE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  git: ['-m', '--message'],
  gh: ['-t', '--title', '-b', '--body'],
};

const INLINE_MESSAGE_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  git: ['--message='],
  gh: ['--title=', '--body='],
};

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

/** The command word with any directory prefix and a trailing `.exe` removed, lower-cased. */
export function programNameOf(token: string): string {
  const bare = token.replace(/^["']|["']$/g, '');
  const lastSeparator = Math.max(bare.lastIndexOf('/'), bare.lastIndexOf('\\'));
  const component = lastSeparator >= 0 ? bare.slice(lastSeparator + 1) : bare;
  const withoutExe = component.toLowerCase().endsWith('.exe') ? component.slice(0, -4) : component;
  return withoutExe.toLowerCase();
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
  let result = '';
  let quote = '';
  let atWordStart = true;

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
      continue;
    }

    if (character === '#' && atWordStart) {
      // Skip to the end of the line; the newline itself survives because it is a separator.
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
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  let nested = '';
  let skippingComment = false;

  const flush = (): void => {
    if (current !== '') tokens.push(current);
    current = '';
  };

  for (const character of command) {
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
        const payload = tokens[index + 1];
        if (payload !== undefined) {
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
 * Parse a command into its invocations and the text a classifier may scan.
 *
 * Total: every input produces a result. An input this parser cannot make sense of yields invocations
 * it could read and a `scannable` that still holds everything else.
 */
export function parseCommand(command: string): ParsedCommand {
  const withoutComments = stripComments(command);
  const hasInterpreter = tokenize(withoutComments).some((token) =>
    INTERPRETER_NAMES.includes(programNameOf(token)),
  );
  const heredocs = separateHeredocBodies(withoutComments);

  const tokens = tokenize(heredocs.text, hasInterpreter);
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

  return {
    invocations,
    scannable: scannableTokens.join(' '),
    hasInterpreter,
  };
}
