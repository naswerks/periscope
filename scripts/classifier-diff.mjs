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
 * the new refusals and the changed reasons by the rule that answers after the change, with samples.
 * `--json` writes every change, for a reviewer to read in full.
 *
 * A change to `src/gate/` states what it lets an agent reach and what it stops; this is the measurement
 * of that sentence. A move nobody predicted is a finding about the change.
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
  // A command word an expansion supplies.
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
];
for (const command of NAMED) corpus.add(command);

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
if (jsonPath !== null) writeFileSync(jsonPath, `${JSON.stringify(changes, null, 2)}\n`);
