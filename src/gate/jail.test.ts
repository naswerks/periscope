/**
 * The path jail and the credential denial.
 *
 * The resolver is injected, which is the only way the normalization-failure path can be exercised at
 * all: a real resolver does not fail on demand, so a suite built on one would report that branch as
 * covered while never entering it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { JailOptions } from './jail.js';
import { checkPath, checkShellForProtectedPaths, commandFromToolInput, pathFromToolInput } from './jail.js';

/** A resolver good enough for the jail's own rules: absolutise, then resolve `..` textually. */
const fakeResolve = (candidate: string): string => {
  const unified = candidate.replace(/\\/g, '/');
  const rooted = unified.startsWith('/') || /^[A-Za-z]:\//.test(unified) ? unified : `C:/work/${unified}`;
  const drive = /^[A-Za-z]:\//.test(rooted) ? rooted.slice(0, 3) : '/';
  const segments: string[] = [];
  for (const segment of rooted.slice(drive.length).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return drive + segments.join('/');
};

const jail = (overrides: Partial<JailOptions> = {}): JailOptions => ({
  workspaceRoot: 'C:/repo',
  resolve: fakeResolve,
  protectedPaths: ['C:/Users/agent/.claude', 'C:/Users/agent/.claude.json'],
  ...overrides,
});

const reasonOf = (candidate: string | null, options: JailOptions = jail()): string | null =>
  checkPath(candidate, options)?.reason ?? null;

// ---------------------------------------------------------------------------
// Reading the target out of the tool input
// ---------------------------------------------------------------------------

test('the path is read from whichever field the tool uses, in precedence order', () => {
  assert.equal(pathFromToolInput({ file_path: 'a' }), 'a');
  assert.equal(pathFromToolInput({ notebook_path: 'b' }), 'b');
  assert.equal(pathFromToolInput({ path: 'c' }), 'c');
  assert.equal(pathFromToolInput({ file_path: 'a', path: 'c' }), 'a');
});

test('a missing, blank or non-string path reads as none rather than as an empty one', () => {
  assert.equal(pathFromToolInput({}), null);
  assert.equal(pathFromToolInput({ file_path: '   ' }), null);
  assert.equal(pathFromToolInput({ file_path: 42 }), null);
  assert.equal(pathFromToolInput(null), null);
  assert.equal(pathFromToolInput('not an object'), null);
});

test('the command is read the same way', () => {
  assert.equal(commandFromToolInput({ command: 'git status' }), 'git status');
  assert.equal(commandFromToolInput({ command: '' }), null);
  assert.equal(commandFromToolInput({}), null);
});

// ---------------------------------------------------------------------------
// The jail
// ---------------------------------------------------------------------------

test('a path inside the workspace flows', () => {
  assert.equal(reasonOf('C:/repo/src/a.ts'), null);
});

test('the workspace root itself is inside the workspace', () => {
  assert.equal(reasonOf('C:/repo'), null);
});

test('regression: a traversal out of the workspace refuses', () => {
  assert.equal(reasonOf('C:/repo/../secrets/keys.txt'), 'path-escapes-root');
});

test('regression: the sibling-prefix case — `C:\\repo-evil` is not under `C:\\repo`', () => {
  // The classic string-prefix hole. It reads as inside by every naive comparison, and the
  // trailing-separator guard is the whole reason it is not.
  assert.equal(reasonOf('C:/repo-evil/x.txt'), 'path-escapes-root');
});

test('a plainly outside path refuses', () => {
  assert.equal(reasonOf('C:/Windows/System32/drivers/etc/hosts'), 'path-escapes-root');
});

test('regression: failure to find a path refuses — it is not treated as nothing to check', () => {
  assert.equal(reasonOf(null), 'path-input-missing');
});

test('regression: any normalization failure refuses — a resolver that throws did not allow it', () => {
  const throwing = jail({
    resolve: () => {
      throw new Error('ENAMETOOLONG');
    },
  });
  assert.equal(reasonOf('C:/repo/src/a.ts', throwing), 'path-unresolvable');
});

test('a resolver that returns nothing usable refuses too', () => {
  assert.equal(reasonOf('x', jail({ resolve: () => '' })), 'path-unresolvable');
  assert.equal(reasonOf('x', jail({ resolve: () => 'still/relative' })), 'path-not-absolute');
});

test('regression: no declared root refuses — a jail with no walls is not a jail', () => {
  assert.equal(reasonOf('C:/repo/src/a.ts', jail({ workspaceRoot: null })), 'path-escapes-root');
  assert.equal(reasonOf('C:/repo/src/a.ts', jail({ workspaceRoot: '  ' })), 'path-escapes-root');
});

test('an unresolvable root refuses as well — the walls have to be findable too', () => {
  const options = jail({
    workspaceRoot: 'C:/repo',
    resolve: (candidate) => {
      if (candidate === 'C:/repo') throw new Error('the root vanished');
      return fakeResolve(candidate);
    },
  });
  assert.equal(reasonOf('C:/repo/src/a.ts', options), 'path-unresolvable');
});

test('a relative path is resolved before it is judged, and lands inside when it belongs there', () => {
  // The resolver roots relative paths at C:/work, which is outside C:/repo — so this must refuse,
  // and it must refuse as an escape rather than as a normalization failure.
  assert.equal(reasonOf('../etc/passwd'), 'path-escapes-root');
});

// ---------------------------------------------------------------------------
// The credential denial. The gate is the only control here.
// ---------------------------------------------------------------------------

test('regression: reading the token cache refuses, by name', () => {
  const found = checkPath('C:/Users/agent/.claude/.credentials.json', jail());
  assert.equal(found?.reason, 'credential-path-denied');
  assert.match(found?.detail ?? '', /credential material/);
});

test('regression: the protected file is protected as well as the protected directory', () => {
  assert.equal(reasonOf('C:/Users/agent/.claude.json'), 'credential-path-denied');
});

test('regression: a traversal into the credential path is a credential denial, not an escape', () => {
  // The distinction matters to whoever reads the trace: one says the agent wandered, the other says
  // it went for the credential.
  assert.equal(reasonOf('C:/repo/../Users/agent/.claude/.credentials.json'), 'credential-path-denied');
});

test('a sibling of the credential directory is not protected — the guard is segment-wise here too', () => {
  assert.equal(reasonOf('C:/Users/agent/.claude-notes/todo.md'), 'path-escapes-root');
});

test('regression: the credential denial holds even when the credential sits inside the workspace', () => {
  const options = jail({ workspaceRoot: 'C:/Users/agent', protectedPaths: ['C:/Users/agent/.claude'] });
  assert.equal(reasonOf('C:/Users/agent/.claude/.credentials.json', options), 'credential-path-denied');
});

test('an empty protected set protects nothing, so the jail alone decides', () => {
  const options = jail({ protectedPaths: [] });
  assert.equal(reasonOf('C:/Users/agent/.claude/.credentials.json', options), 'path-escapes-root');
});

// ---------------------------------------------------------------------------
// The credential denial over a shell command
// ---------------------------------------------------------------------------

test('regression: a shell command naming the token cache refuses', () => {
  const found = checkShellForProtectedPaths('cat C:\\Users\\agent\\.claude\\.credentials.json', jail());
  assert.equal(found?.reason, 'credential-path-denied');
});

test('the shell check is slash- and case-insensitive, because Windows paths arrive both ways', () => {
  assert.notEqual(checkShellForProtectedPaths('type c:/USERS/Agent/.CLAUDE/.credentials.json', jail()), null);
});

test('it fires wherever the path appears, not only as the first argument', () => {
  assert.notEqual(
    checkShellForProtectedPaths('node -e "x" < C:/Users/agent/.claude/.credentials.json', jail()),
    null,
  );
});

test('deliberate: a command that merely mentions the path also refuses — the stated over-refusal', () => {
  // Deliberate, and the reason is at the site: a boundary verb is only dangerous at a command
  // position, so parsing tells you whether it is one; a credential path is dangerous wherever it
  // appears, including in shapes this parser has no model of. The cost is one human click.
  assert.notEqual(checkShellForProtectedPaths('echo "check C:/Users/agent/.claude/"', jail()), null);
});

test('an ordinary command flows', () => {
  assert.equal(checkShellForProtectedPaths('npm test', jail()), null);
  assert.equal(checkShellForProtectedPaths('git status', jail()), null);
});

test('a protected path the resolver cannot resolve is still protected', () => {
  // Dropping it from the set on a resolver failure would silently shrink the protected surface —
  // the one direction this module may never take.
  const options = jail({
    protectedPaths: ['C:/Users/agent/.claude'],
    resolve: (candidate) => {
      if (candidate === 'C:/Users/agent/.claude') throw new Error('unresolvable');
      return fakeResolve(candidate);
    },
  });
  assert.notEqual(checkShellForProtectedPaths('cat C:/Users/agent/.claude/.credentials.json', options), null);
});

// Guards the selector: a jail that refused everything would satisfy every refusal assertion above.
test('the jail discriminates — inside flows, outside refuses, credentials refuse differently', () => {
  assert.equal(reasonOf('C:/repo/src/a.ts'), null);
  assert.equal(reasonOf('C:/elsewhere/a.ts'), 'path-escapes-root');
  assert.equal(reasonOf('C:/Users/agent/.claude/x'), 'credential-path-denied');
});
