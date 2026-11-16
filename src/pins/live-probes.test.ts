/**
 * A rot guard on the probes that need a real agent.
 *
 * The properties those probes cover (that an undeclared variable cannot reach a spawn, that
 * ambient credentials resolve, that a resume carries its context) all fail silently in production,
 * and none of them are exercised by an ordinary `npm test`. So the one thing an ordinary run can
 * check is that they still exist, still name their properties, and are still reachable by the
 * script that runs them. A probe file quietly deleted or renamed would otherwise take its property
 * with it and leave a green suite behind.
 *
 * This is not a substitute for running them. It is the difference between "not exercised in this
 * run" and "no longer exercised by anything".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { allFiles } from './walk.js';

const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

const liveFiles = (): { path: string; text: string }[] =>
  allFiles().filter((file) => file.path.endsWith('.live.test.ts'));

/** The properties the live probes must claim, matched case-insensitively so a rename of case alone does not rot them. */
const CLAIMED_PROPERTIES = [
  'cannot see a variable that is not on the allow-list',
  'version receipt is per session',
  'workspace trust is explicit',
  'survives resume with its context',
  'a write the gate allows outside its own directory lands',
  "a message pushed while a turn's shell call runs lands inside that turn",
  'every call of a copilot session asks this host',
  'every call of an opencode session asks this host',
];

/** A workspace created under the OS temp directory, and a `mkdtempSync` that is not. */
const TMPDIR_WORKSPACE = /mkdtempSync\(`\$\{tmpdir\(\)\}/;
const OTHER_WORKSPACE = /mkdtempSync\((?!`\$\{tmpdir\(\)\})/;

const claims = (bodies: string, property: string): boolean =>
  bodies.toLowerCase().includes(property.toLowerCase());

test('the live probes exist and each states the property it proves', () => {
  const files = liveFiles();
  assert.ok(files.length > 0, 'every real-agent probe has disappeared');

  const bodies = files.map((file) => file.text).join('\n');
  for (const property of CLAIMED_PROPERTIES) {
    assert.ok(claims(bodies, property), `no live probe claims: ${property}`);
  }
});

test('a live probe never runs against a directory inside a repository', () => {
  // The agent discovers project settings by walking up from its working directory, so a probe
  // rooted in a checkout would load that checkout's settings, hooks included, and could act on a
  // system it is not testing. Every workspace here comes from the OS temp directory instead.
  for (const file of liveFiles()) {
    assert.match(
      file.text,
      TMPDIR_WORKSPACE,
      `${file.path} must build its workspaces under the OS temp directory`,
    );
    assert.equal(
      OTHER_WORKSPACE.test(file.text),
      false,
      `${file.path} creates a workspace somewhere other than the OS temp directory`,
    );
  }
});

test('the live probes are reachable by a script, and excluded from no ordinary run by accident', () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { scripts: Record<string, string> };

  assert.ok(manifest.scripts['test:live'], 'nothing runs the live probes');
  assert.match(manifest.scripts['test:live'] ?? '', /\.live\.test\.js/);
  // And the ordinary suite still loads them, which is what makes their skips visible in its summary
  // rather than invisible by omission.
  assert.match(manifest.scripts['test'] ?? '', /dist\/\*\*\/\*\.test\.js/);
});

test('the probes skip on a named condition rather than on an accident', () => {
  for (const file of liveFiles()) {
    assert.match(file.text, /PERISCOPE_LIVE/, `${file.path} has no gate`);
    // The reason has to travel with the skip, or the summary reports a number and no cause.
    assert.match(
      file.text,
      /not exercised/i,
      `${file.path} skips without stating that the property went unproven`,
    );
  }
});

/**
 * What starts an agent, a runtime or a host: a thing that keeps this process from exiting until it is
 * ended. `query(` is not among them: a probe reads it in a `for await`, which ends it however the loop
 * is left.
 */
const STARTS =
  /\.open\(\{|\.create\(\{|\bstart(?:Agent|Codex|Qwen|Pi|Copilot|Opencode)Process\(|\bstartStdioRpc\(|\bPiRpc\.start\(|\bnew PeriscopeHost\(/;

/** One top-level test or function of a probe file: its name (null for a test) and its text. */
interface Unit {
  readonly name: string | null;
  readonly text: string;
}

function unitsOf(text: string): Unit[] {
  const starts = [...text.matchAll(/^(?:test\(|(?:async )?function (\w+))/gm)];
  return starts.map((start, index) => ({
    name: start[1] ?? null,
    text: text.slice(start.index, starts[index + 1]?.index ?? text.length),
  }));
}

/**
 * The units of a probe file that start something and leave its end to a line a failed assertion would
 * skip. A unit that starts something ends it in a `finally` of its own, or hands it over: straight into
 * a call of a function that has one, or back to callers that each have one.
 */
function leavesRunning(text: string): string[] {
  const units = unitsOf(text);
  const guarded = (unit: Unit): boolean => /\bfinally\b/.test(unit.text);
  const calls = (name: string): RegExp => new RegExp(`(?<![.\\w])${name}\\(`);
  const guardedNames = units.flatMap((unit) => (unit.name !== null && guarded(unit) ? [unit.name] : []));
  // A start written inside the call of a guarded function is that function's to end, so the statement
  // of such a call is left out before a unit is read for what it starts itself.
  const handedOver =
    guardedNames.length === 0 ? null : new RegExp(`(?<![.\\w])(?:${guardedNames.join('|')})\\([^;]*;`, 'gs');
  return units
    .filter((unit) => {
      if (guarded(unit)) return false;
      const own = handedOver === null ? unit.text : unit.text.replace(handedOver, ';');
      if (!STARTS.test(own)) return false;
      const name = unit.name;
      if (name === null) return true;
      const callers = units.filter((other) => other !== unit && calls(name).test(other.text));
      return callers.length === 0 || callers.some((caller) => !guarded(caller));
    })
    .map((unit) => unit.name ?? /^test\(\s*(['"`])((?:(?!\1).)*)\1/s.exec(unit.text)?.[2] ?? 'a test');
}

test('a live probe ends what it starts in a finally: a failed assertion leaves no agent running', () => {
  // A probe whose assertion throws past the line that stops its session leaves an agent running, and
  // the probe's own process then cannot exit: the run hangs until something outside ends it.
  const found = liveFiles().flatMap((file) =>
    leavesRunning(file.text).map((unit) => `${file.path}: ${unit}`),
  );
  assert.deepEqual(found, [], 'a probe starts something and ends it on a line a failed assertion would skip');
});

// Guards the selectors, not the rules: a regex that fires on nothing and an `includes` that
// discriminates nothing would both leave the assertions above green over any file at all.
test('control: a start with no finally is found, and one that is guarded or handed over is not', () => {
  const unguarded = [
    "test('a turn', async () => {",
    '  const opened = await sessions.open({ cwd });',
    '  assert.ok(opened.ok);',
    "  opened.value.stop('done');",
    '});',
  ].join('\n');
  assert.deepEqual(leavesRunning(unguarded), ['a turn']);
  const guarded = unguarded
    .replace('  assert.ok', '  try {\n  assert.ok')
    .replace("  opened.value.stop('done');", "  } finally {\n  opened.value.stop('done');\n  }");
  assert.deepEqual(leavesRunning(guarded), []);

  // A helper that starts and hands back is its callers' to end: each caller needs the finally.
  const helper = 'function start(dir: string) {\n  return startPiProcess(request(dir));\n}\n';
  const careful =
    "test('one', async () => {\n  const run = start(dir);\n  try {\n  } finally {\n    run.close();\n  }\n});\n";
  const careless =
    "test('two', async () => {\n  const run = start(dir);\n  assert.ok(run);\n  run.close();\n});\n";
  assert.deepEqual(leavesRunning(helper + careful), []);
  assert.deepEqual(leavesRunning(helper + careful + careless), ['start']);

  // A start handed straight into a function that has the finally is that function's.
  const leg =
    'async function leg(agent: AgentProcess) {\n  try {\n    await agent.turn();\n  } finally {\n    agent.close();\n  }\n}\n';
  const handing =
    "test('three', async () => {\n  const first = await leg(\n    startAgentProcess(request(cwd)),\n  );\n  assert.ok(first);\n});\n";
  assert.deepEqual(leavesRunning(leg + handing), []);
  // Reading a query in a loop starts nothing this rule holds.
  assert.deepEqual(
    leavesRunning(
      "test('four', async () => {\n  for await (const one of query({ prompt })) seen.push(one);\n});\n",
    ),
    [],
  );

  assert.ok(
    liveFiles().some((file) => STARTS.test(file.text)),
    'no probe file starts anything by these names, so the rule above reads nothing',
  );
});

/**
 * The timers of a probe file that nothing waits out and nothing can clear, by line. A sleep that is
 * awaited runs to its end before the next line. A timer that is one arm of a race is left running when
 * the other arm wins, and holds the probe's own process open until it fires: such a timer keeps its
 * handle, so the race can clear it. A `setTimeout(` inside a string is a script the probe writes, not a
 * timer of its own.
 */
function droppedTimers(text: string): number[] {
  const lines: number[] = [];
  for (const match of text.matchAll(/(?<!["'`])\bsetTimeout\(/g)) {
    const before = text.slice(0, match.index);
    if (/=\s*$/.test(before)) continue;
    const waited = before.lastIndexOf('await new Promise');
    if (waited >= 0 && !before.slice(waited).includes(';')) continue;
    lines.push(before.split('\n').length);
  }
  return lines;
}

test("a live probe leaves no timer running that it neither waits out nor can clear: one would hold the probe's process open until it fires", () => {
  const found = liveFiles().flatMap((file) => droppedTimers(file.text).map((line) => `${file.path}:${line}`));
  assert.deepEqual(found, [], 'a probe sets a timer, drops its handle and does not wait for it');
});

test('control: a raced timer whose handle is dropped is found, and an awaited sleep, a kept handle and a script in a string are not', () => {
  const raced =
    'const won = await Promise.race([\n  opened,\n  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 180_000)),\n]);\n';
  assert.deepEqual(droppedTimers(raced), [3]);
  assert.deepEqual(droppedTimers('await new Promise((resolve) => setTimeout(resolve, 2_000));\n'), []);
  assert.deepEqual(
    droppedTimers('const timer = setTimeout(() => resolve(false), 180_000);\nclearTimeout(timer);\n'),
    [],
  );
  assert.deepEqual(
    droppedTimers('new Promise<void>((resolve) => (timer = setTimeout(resolve, 5_000)));\n'),
    [],
  );
  assert.deepEqual(droppedTimers('writeFileSync(file, `node -e "setTimeout(() => {}, 20000)"`);\n'), []);
  assert.ok(
    liveFiles().some((file) => /\bsetTimeout\(/.test(file.text)),
    'no probe file sets a timer, so the rule above reads nothing',
  );
});

// Guards the selectors, not the rules: a regex that fires on nothing and an `includes` that
// discriminates nothing would both leave the assertions above green over any file at all.
test('control: the workspace patterns and the property check discriminate on planted text', () => {
  assert.match('const cwd = mkdtempSync(`${tmpdir()}/periscope-live-`);', TMPDIR_WORKSPACE);
  assert.doesNotMatch('const cwd = mkdtempSync(`${tmpdir()}/periscope-live-`);', OTHER_WORKSPACE);

  assert.doesNotMatch("const cwd = mkdtempSync(join(process.cwd(), 'live-'));", TMPDIR_WORKSPACE);
  assert.match("const cwd = mkdtempSync(join(process.cwd(), 'live-'));", OTHER_WORKSPACE);
  assert.match("const cwd = mkdtempSync('/repo/checkout/live-');", OTHER_WORKSPACE);

  const bodies = liveFiles()
    .map((file) => file.text)
    .join('\n');
  assert.ok(bodies.length > 1_000, 'the probe bodies look unread');
  const unclaimed = 'a property that no live probe has ever claimed';
  assert.equal(claims(bodies, unclaimed), false, 'the property check accepts a string nobody claims');
  assert.equal(
    claims(bodies, CLAIMED_PROPERTIES[0] ?? ''),
    true,
    'the property check rejects a claimed property',
  );
});
