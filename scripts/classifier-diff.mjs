#!/usr/bin/env node
/**
 * Every answer of the shell classifier, measured before a change and after it.
 *
 *   npm run build
 *   node scripts/classifier-diff.mjs <dist-before> [dist-after] [--samples <n>] [--json <file>]
 *
 * `<dist-before>` is the `dist/` of a build of the earlier tree (extract a tag with `git archive <tag>`
 * into a scratch directory, `npm ci`, `npx tsc`); `dist-after` defaults to this tree's `dist/`.
 *
 * The corpus is every quoted literal longer than two characters in `src/gate/*.test.ts`, the named shapes
 * below, and 40,000 commands drawn from a fixed seed, so two runs over the same builds print the same
 * report. Each command is parsed and classified under the POSIX, PowerShell and `cmd` readings, as the
 * local gate reads them. The report counts what changed, prints every refusal that now flows, and groups
 * the new refusals and the changed reasons by the rule that answers after the change, with samples. The
 * named controls are answers the later build must give whatever the earlier one gave: `MUST_FLOW` in the
 * readings each names, and `MUST_REFUSE` with the reason or rule each names. Every control that does not
 * hold is printed, and the script exits 1 when any does. `--json` writes every change, for a reviewer to
 * read in full.
 *
 * A change to `src/gate/` states what it lets an agent reach and what it stops; this is the measurement
 * of that sentence. A move nobody predicted is a finding about the change. It is run by hand: nothing in
 * `package.json` or CI runs it, and it reads `parseCommand` and `classifyShellCommand` only, not the local
 * gate's protected-path check.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const sampleCount = Number(option('--samples', '12'));
const jsonPath = option('--json', null);
const [before, after = join(ROOT, 'dist')] = args;
if (before === undefined) {
  process.stderr.write(
    'usage: node scripts/classifier-diff.mjs <dist-before> [dist-after] [--samples <n>] [--json <file>]\n',
  );
  process.exit(2);
}

const load = async (dist) => ({
  shell: await import(pathToFileURL(join(resolve(dist), 'gate', 'shell.js')).href),
  command: await import(pathToFileURL(join(resolve(dist), 'gate', 'command.js')).href),
});
const A = await load(before);
const B = await load(after);

// ---------------------------------------------------------------------------
// The corpus.
// ---------------------------------------------------------------------------

const corpus = new Set();

const testsDir = join(ROOT, 'src', 'gate');
for (const name of readdirSync(testsDir).filter((entry) => entry.endsWith('.test.ts'))) {
  const text = readFileSync(join(testsDir, name), 'utf8');
  for (const match of text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n$]|\\.)*)`/g)) {
    const literal = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
    if (literal.length > 2) corpus.add(literal);
  }
}

/** Shapes named on purpose: each family a change to the classifier has moved, and its controls. */
const NAMED = [
  // An escaped blank: one word to a POSIX shell, so a `#` after it is mid-word.
  String.raw`C:/Program\ Files/Git/mingw64/libexec/git-core/git-send-pack.exe origin main`,
  String.raw`git -C C:/My\ Repos/remote-tools status`,
  String.raw`git -C C:/My\ Repos/x push origin main`,
  String.raw`git -C C:\repo\ remote add o u`,
  String.raw`git status\ # ; git push`,
  String.raw`echo a\ # ; git push origin main`,
  String.raw`echo a\ # ; git send-pack origin main`,
  String.raw`echo a\	# ; git push origin main`,
  String.raw`echo a\\ # ; git push origin main`,
  String.raw`echo a\\\ # ; git push origin main`,
  'echo a\\\n# ; git push origin main',
  String.raw`bash -c "echo a\ # ; git push origin main"`,
  String.raw`bash -c "echo a\\ # ; git push origin main"`,
  String.raw`echo \" # " ; git push origin main`,
  String.raw`echo \" ; git send-pack origin main`,
  String.raw`env A=1\ git push origin main`,
  String.raw`cat notes\ about\ git\ push.txt`,
  String.raw`git status && git\ push origin main`,
  String.raw`bash -c "C:/Program\ Files/git-core/git-send-pack.exe origin"`,
  String.raw`git log C:\\ push`,
  String.raw`timeout 10 ssh build-host \ git-send-pack.exe origin`,
  String.raw`ssh build-host ''\ git push origin main`,
  // The Azure CLI: a quoted option name, a repeated option, the Windows shim, a dash word in a description.
  'az repos pr update --id 5 "--status" completed',
  "az repos pr update --id 5 '--status' completed",
  'az repos pr update --id 5 --status active --status completed',
  'az repos pr update --id 5 --status completed --status active',
  'az repos pr update --id 5 --auto-complete false --auto-complete true',
  'az.cmd repos pr update --id 5 --status completed',
  'AZ.CMD repos pr update --id 5 --status completed',
  'az.bat repos pr update --id 5 --status completed',
  '"C:/Program Files/az/az.cmd" repos pr update --id 5 --status completed',
  'az.cmd repos pr create --title "x" --description "git push origin main"',
  'az repos pr update --id 5 --description "notes" "--status" completed',
  'az repos pr update --id 5 --description "notes" --status completed',
  'az repos pr update --id 5 --description "- fixed it"',
  'az repos pr update --id 5 --description "- fixed it" --status active',
  'git.cmd push origin main',
  'git.bat push origin main',
  'gh.cmd pr merge 5',
  'git-send-pack.cmd origin main',
  'deploy.cmd --target prod',
  'npm.cmd test',
  // A command word an expansion supplies, read only as the program the line names for it.
  '$(which git) push origin main',
  '$(command -v gh) pr merge 5',
  'G=git && $G push origin main',
  'export G=git; $G push origin main',
  'G=git; ${G} push origin main',
  'G=$(which git); $G push origin main',
  'A=az; $A repos pr update --id 5 --status completed',
  'G=git; ! $G push origin main',
  'G=git; FOO=1 $G push origin main',
  'G=git; X=$(foo) $G push origin main',
  'G=git; G=docker; $G push img',
  '& (Get-Command git) push origin main',
  '& $(echo git) push origin main',
  "$G = 'git'; & $G push origin main",
  '$(echo git) push origin x',
  '`echo git` push origin x',
  'G=git; $G push origin main',
  '${G} push origin main',
  '"$(echo git)" push origin main',
  'g$(echo it) push origin main',
  '$(echo git) send-pack origin main',
  '$(echo gh) pr merge 5',
  '$AZ repos pr update --id 5 --status completed',
  '$(echo git) status',
  '$(echo git) -C /repo push origin main',
  'echo $($(echo git) push origin main)',
  'bash -c "$(echo git) push origin main"',
  '$EDITOR f',
  '$EDITOR README.md',
  '$(npm bin)/tsc',
  '$(npm bin)/tsc -p .',
  '$(which node) script.js',
  '"$HOME/bin/tool" run',
  '$(git rev-parse --show-toplevel)/scripts/build.sh',
  'cd $(git rev-parse --show-toplevel) && git status',
  'git -C $(pwd) status',
  'git -C $(pwd) push origin main',
  'echo `date` push',
  'echo $(date) push',
  '$PAGER push.log',
  '$(echo git)/x push',
  // Branch options and their values.
  'ssh build-host "git branch --sort=-committerdate"',
  'git branch --sort=-committerdate',
  'git branch --sort -committerdate',
  'git branch --so -committerdate',
  'ssh build-host "git branch --format=-d"',
  'ssh build-host git branch --format -d',
  'git branch --format=-d',
  'git branch --contains -d topic',
  'git branch --contains HEAD -d topic',
  'git branch -d x',
  'git branch -D x',
  'git branch -dr origin/x',
  'git branch -rD origin/x',
  'git branch -fd x',
  'git branch -dx x',
  'git branch --delete x',
  'git branch --del x',
  'ssh build-host "git branch -d x"',
  'ssh build-host -o core.pager=git push origin main',
  "git -c core.pager='git push origin main' log",
  'env GIT_PAGER=git push origin main',
  'ssh build-host git send-pack origin main',
  'git reset "--hard"',
  'git branch "-d" x',
  'ssh build-host git --exec-path=/x push origin main',
  'ssh build-host "git branch --color=-d"',
  'ssh build-host "git branch --color -d x"',
  'ssh build-host "git branch --format=x -d topic"',
  'rg -c core.pager=git push origin main',
  'ssh build-host "git push=x origin"',
  'git branch -ud topic',
  'git branch --with -d topic',
  'git branch --sort -D',
  // Quote removal in the command word, as a POSIX shell reads the name it runs.
  "g''it push origin main",
  '"g"it push origin main',
  String.raw`g\it push origin main`,
  String.raw`gi\t push origin main`,
  String.raw`g\it send-pack origin main`,
  String.raw`g\it status`,
  'b\'\'ash -c "git send-pack origin main"',
  String.raw`C:\Git\bin\git.exe push origin main`,
  String.raw`C:\Git\bin\git.exe status`,
  // A backslash inside a double-quoted span escapes a quote, so the span does not close at it.
  String.raw`echo "a \" # " ; git push origin main`,
  String.raw`echo "a \" # " ; git send-pack origin main`,
  String.raw`echo "a \\" # " ; git push origin main`,
  String.raw`echo "a \" ; git send-pack origin main`,
  String.raw`echo 'a \' # ; git push origin main`,
  String.raw`bash -c "echo \" # \" ; git push origin main"`,
  String.raw`git commit -m "say \"push\""`,
  // Heredoc bodies and commit messages: data to a data sink or a message flag, commands to a shell.
  'cat <<EOF\ngit push origin main\nEOF',
  'cat.cmd <<EOF\ngit push origin main\nEOF',
  'tee.bat out.txt <<EOF\ngit push origin main\nEOF',
  "cat <<'EOF'\ngit push origin main\nEOF",
  'bash <<EOF\ngit push origin main\nEOF',
  'python <<EOF\nimport os  # git push origin main\nEOF',
  'git commit -F - <<EOF\ngit push origin main\nEOF',
  'git.cmd commit -F - <<EOF\ngit push origin main\nEOF',
  'git commit -m "git push origin main"',
  'git.cmd commit -m "git push origin main"',
  'git.bat commit -m "gh pr merge 5"',
  'gh pr create --title "x" --body "git push origin main"',
  'gh.cmd pr create --title "x" --body "git push origin main"',
  'git commit -m "$(git push origin main)"',
  // A redirection's word is a file, and a keyword opens a command only as a command's first word.
  'G=git; echo hi > $G',
  'G=git; cat < $G',
  'G=git; echo then $G push',
  '> out $(echo git) push origin main',
  'G=git; $G push origin main 2> /dev/null',
  'G=git; if true; then $G push origin main; fi',
  // Shapes docs/gate.md lists as flowing, so a change that reads them shows here.
  '$(echo git -C .) push origin main',
  '$(echo git --no-pager) push origin main',
  '$(echo git -c x=y) push origin main',
  'G="git push"; $G origin main',
  'G="git -C ."; $G push origin main',
  "G=git bash -c '$G push origin main'",
  "env G=git bash -c '$G push origin main'",
  String.raw`bash -c "G=git; \$G push origin main"`,
  '${X:-git} push origin main',
  'G=gi; G+=t; $G push origin main',
  'export G=git PATH; $G push origin main',
  'printf -v G git; $G push origin main',
  'G=git; if $G push origin main; then :; fi',
  'G=git; while $G push origin main; do :; done',
  'G=git; until $G push origin main; do :; done',
  'FOO=1 git send-pack origin main',
  '! git send-pack origin main',
  'if git send-pack origin main; then :; fi',
  'gh pr "merge" 5',
  'gh "pr" merge 5',
  'env -u gh git send-pack origin main',
  'sudo -u az git send-pack origin main',
  'python -m azure.cli repos pr update --id 5 --status completed',
  'for G in git; do $G push origin main; done',
  'G=git; eval $G push origin main',
  '& (Get-Command git) push origin main',
  "$G = 'git'; & $G push origin main",
  // git's -c key=value inside another program's words: -c takes the pair, and the verb follows.
  'git -c a=b push origin main',
  'ssh h "git -c user.name=x push origin main"',
  'docker exec c git -c a=b push origin main',
  'ssh h "git -c a=b branch -d x"',
  'ssh h "git -c a=b reset --hard"',
  'ssh h "git -c a=b remote add o u"',
  'ssh h "git -c a=b status"',
  'docker exec c git -c core.editor=vim log',
];
for (const command of NAMED) corpus.add(command);

/**
 * Commands the later build must let through, each in the readings it names: programs the line does not
 * name, which no change to how an expansion is read may stop; the readings that never run an expansion
 * as a command word; and the words a redirection or an argument holds.
 */
const ALL = ['posix', 'powershell', 'cmd'];
const MUST_FLOW = [
  ...[
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
    '${G} push origin main',
    'g$(echo it) push origin main',
    '$AZ repos pr update --id 5 --status completed',
    'D=docker; $D push img',
    '$(echo docker) push img',
    '$EDITOR f',
    '$EDITOR notes.md',
    '$(npm bin)/tsc -p .',
    '$(which node) script.js',
    '"$HOME/bin/tool" run',
    '"$JAVA_HOME/bin/java" -jar app.jar push',
    '$(which kubectl) apply -f deploy.yaml',
    '$PYTHON -m pip install requests',
    '$MAKE install',
    '$NPM publish',
    '$CARGO publish',
    '$GO run . push',
    '$(git config core.editor) notes.md',
    '$(git rev-parse --show-toplevel)/scripts/build.sh',
    'G=git cmd; $G push origin main',
    'G=git; echo hi > $G',
    'G=git; cat < $G',
    'G=git; echo then $G push',
    String.raw`C:\Git\bin\git.exe status`,
    String.raw`g\it status`,
  ].map((command) => [command, ALL]),
  ...['$(echo git) push origin x', '`echo git` push origin x', 'G=git; $G push origin main'].map(
    (command) => [command, ['powershell', 'cmd']],
  ),
];

/** Commands the later build must refuse, in every reading, with the reason or the rule each names. */
const MUST_REFUSE = [
  ['git push origin main', 'shell-boundary-command: git-push'],
  ['gh pr merge 5', 'shell-boundary-command: gh-pr-merge'],
  ['az repos pr update --id 5 --status completed', 'shell-boundary-command: az-repos-pr-complete'],
  ['git branch -D x', 'shell-boundary-command: git-branch-delete'],
  ['git reset --hard', 'shell-boundary-command: git-reset-hard'],
  ['git remote add o u', 'shell-boundary-command: git-remote-surgery'],
  ['git send-pack origin main', 'shell-verb-unrecognised'],
  ['ssh build-host "git push origin main"', 'shell-boundary-command: git-push'],
].map(([command, answer]) => [command, ALL, answer]);
for (const [command] of [...MUST_FLOW, ...MUST_REFUSE]) corpus.add(command);

let seed = 7;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (items) => items[Math.floor(random() * items.length)];
const WORDS = [
  'git',
  'gh',
  'az',
  'env',
  'ssh',
  'push',
  'remote',
  'branch',
  '-d',
  '-D',
  'status',
  'log',
  'diff',
  'config',
  'worktree',
  'list',
  'send-pack',
  'git-send-pack.exe',
  'C:/Program',
  'Files/Git/git-core/git-send-pack.exe',
  'repos',
  'pr',
  'update',
  '--status',
  '"--status"',
  'completed',
  'active',
  '--description',
  '"notes"',
  '"- fixed"',
  'merge',
  'origin',
  'main',
  '-C',
  'C:/My',
  'Repos/x',
  'bash',
  '-c',
  'xargs',
  'timeout',
  '10',
  'rg',
  'echo',
  '#',
  ';',
  '&&',
  '|',
  '"',
  "'",
  '\\',
  '\\\\',
  'a.b',
  'logs/pre-push.log',
  '$(',
  ')',
  '`',
  '$(echo git)',
  '`echo git`',
  '$VAR',
  '$G',
  'G=git;',
  'az.cmd',
  'git.cmd',
  '.cmd',
  '.bat',
  '--sort',
  '-committerdate',
  '--sort=-committerdate',
  '--format=',
  '--contains',
  '\\ #',
  'ssh build-host',
  'timeout 10',
  'reset',
  '--hard',
];
const UNITS = [
  'g',
  'i',
  't',
  ' ',
  '\\',
  '"',
  "'",
  '#',
  ';',
  '|',
  '&',
  '-',
  '/',
  'push',
  'git',
  '\t',
  '\n',
  '$',
  '(',
  ')',
  '`',
  '{',
  '}',
  '=',
  'd',
  '.cmd',
];
for (let i = 0; i < 40000; i += 1) {
  if (i % 2 === 0) {
    const joiner = random() < 0.3 ? '\\ ' : ' ';
    corpus.add(Array.from({ length: 1 + Math.floor(random() * 7) }, () => pick(WORDS)).join(joiner));
  } else {
    corpus.add(Array.from({ length: 1 + Math.floor(random() * 24) }, () => pick(UNITS)).join(''));
  }
}

// ---------------------------------------------------------------------------
// The measurement.
// ---------------------------------------------------------------------------

const answerOf = (module, command, dialect) => {
  const parsed = module.command.parseCommand(command, dialect);
  const found = module.shell.classifyShellCommand(command, parsed);
  return found === null ? 'flows' : `${found.reason}: ${found.detail}`;
};
/** The reason and, for a boundary refusal, the rule: what a group of changes is keyed on. */
const keyOf = (answer) => {
  if (answer === 'flows') return 'flows';
  const [reason, rest] = answer.split(': ');
  return reason === 'shell-boundary-command' ? `${reason} ${rest}` : reason;
};

const changes = [];
for (const command of corpus) {
  for (const dialect of ['posix', 'powershell', 'cmd']) {
    const was = answerOf(A, command, dialect);
    const is = answerOf(B, command, dialect);
    if (was !== is) changes.push({ command, dialect, before: was, after: is });
  }
}

const loosened = changes.filter((change) => change.after === 'flows');
const tightened = changes.filter((change) => change.before === 'flows');
const moved = changes.filter((change) => change.before !== 'flows' && change.after !== 'flows');

const show = (change) =>
  `  ${change.dialect}: ${JSON.stringify(change.command)}\n` +
  `      before ${change.before.slice(0, 100)}\n      after  ${change.after.slice(0, 100)}`;

const grouped = (list, keyFor) => {
  const groups = new Map();
  for (const change of list) {
    const key = keyFor(change);
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
};

console.log(`corpus ${corpus.size} commands x 3 readings (${corpus.size * 3} answers)`);
console.log(
  `answers changed: ${changes.length} ` +
    `(refused->flows ${loosened.length}, flows->refused ${tightened.length}, ` +
    `refusal->other refusal ${moved.length})`,
);
console.log(`\nrefused->flows, every one (${loosened.length}):`);
for (const change of loosened) console.log(show(change));
console.log(`\nflows->refused, by the answer after (${tightened.length}):`);
for (const [key, list] of grouped(tightened, (change) => keyOf(change.after))) {
  console.log(`${key}: ${list.length}`);
  for (const change of list.slice(0, sampleCount)) console.log(show(change));
}
console.log(`\nrefusal->other refusal, by before -> after (${moved.length}):`);
for (const [key, list] of grouped(moved, (change) => `${keyOf(change.before)} -> ${keyOf(change.after)}`)) {
  console.log(`${key}: ${list.length}`);
  for (const change of list.slice(0, sampleCount)) console.log(show(change));
}
const failed = [
  ...MUST_FLOW.flatMap(([command, dialects]) =>
    dialects
      .map((dialect) => ({ command, dialect, want: 'flows', got: answerOf(B, command, dialect) }))
      .filter((control) => control.got !== 'flows'),
  ),
  ...MUST_REFUSE.flatMap(([command, dialects, want]) =>
    dialects
      .map((dialect) => ({ command, dialect, want, got: answerOf(B, command, dialect) }))
      .filter((control) => !control.got.startsWith(want)),
  ),
];
const controls = MUST_FLOW.length + MUST_REFUSE.length;
console.log(
  `\nnamed controls: ${MUST_FLOW.length} must flow, ${MUST_REFUSE.length} must refuse; not held: ${failed.length}`,
);
for (const control of failed) {
  console.log(
    `  ${control.dialect}: ${JSON.stringify(control.command)}\n      want ${control.want}\n      got  ${control.got.slice(0, 100)}`,
  );
}
if (controls === 0 || failed.length > 0) process.exitCode = 1;
if (jsonPath !== null) writeFileSync(jsonPath, `${JSON.stringify(changes, null, 2)}\n`);
