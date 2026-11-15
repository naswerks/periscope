/**
 * Where the local gate places a path a tool names, before any check reads it.
 *
 * A tool running in the call's directory opens a rooted, a home or a drive-relative path where the
 * operating system puts it, so the gate must check that same file. The resolvers here are the operating
 * systems' own (`node:path`'s `win32` and `posix`), the same on every platform this suite runs on, so a
 * path the gate joined by text instead of placing resolves to the wrong file and the check under test
 * reads it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';

import type { DecisionRequest } from './decision.js';
import type { LocalGateOptions } from './local.js';
import { CODEX_TOOL_FAMILIES, localGate, PI_TOOL_FAMILIES } from './local.js';
import { placePath } from './placement.js';

const WORK = 'C:\\work\\session-1';
const HOME = 'C:\\Users\\op';
const KEYS = 'C:\\Users\\op\\.ssh';

const onWindows = (path: string): string => win32.resolve(path);

/** A gate whose file tools place a relative path where the call runs, read and written, as pi's do. */
const placing = (over: Partial<LocalGateOptions> = {}): ReturnType<typeof localGate> =>
  localGate({
    workspaceRoot: WORK,
    resolve: onWindows,
    protectedPaths: [KEYS],
    home: HOME,
    toolFamilies: PI_TOOL_FAMILIES,
    readsShellDialect: true,
    resolvesAgainstCallCwd: true,
    resolvesWritesAgainstCallCwd: true,
    ...over,
  });

const pi = placing();

function request(toolName: string, toolInput: unknown, cwd: string = WORK): DecisionRequest {
  return {
    toolName,
    toolUseId: 'call_1',
    toolInput,
    sessionId: 's',
    sessionKey: 'k',
    cwd,
    agentId: null,
    agentType: null,
  };
}

// ---------------------------------------------------------------------------
// Through the gate
// ---------------------------------------------------------------------------

test('a path rooted at the drive without naming it is checked at the root of the drive the call runs on', () => {
  assert.equal(
    pi(request('read', { path: '\\Users\\op\\.ssh\\id_rsa' }))?.reason,
    'credential-path-denied',
    'one leading backslash is the root of the drive the call runs on, not a folder under its directory',
  );
  // Control: the same file named in full is refused, and a file of the workspace is not.
  assert.equal(pi(request('read', { path: `${KEYS}\\id_rsa` }))?.reason, 'credential-path-denied');
  assert.equal(pi(request('read', { path: 'src\\a.ts' })), null);
});

test('a forward-slash root is the root of the drive the call runs on, whichever drive this process is on', () => {
  const elsewhere = placing({ workspaceRoot: 'Q:\\work\\session-1', protectedPaths: ['Q:\\secrets'] });
  assert.equal(
    elsewhere(request('read', { path: '/secrets/key.pem' }, 'Q:\\work\\session-1'))?.reason,
    'credential-path-denied',
  );
  // Control: the same root on a drive that does not hold the protected folder is read.
  assert.equal(pi(request('read', { path: '/secrets/key.pem' })), null);
});

test('a path from the home directory is checked at home for a read, as it is for a search', () => {
  assert.equal(pi(request('read', { path: '~/.ssh/id_rsa' }))?.reason, 'credential-path-denied');
  assert.equal(pi(request('read', { path: '~\\.ssh\\id_rsa' }))?.reason, 'credential-path-denied');
  // Control: the search already reads the form, and with no home known the path is the name it is written as.
  assert.equal(pi(request('grep', { pattern: 'x', path: '~/.ssh' }))?.reason, 'credential-path-denied');
  assert.equal(placing({ home: null })(request('read', { path: '~/.ssh/id_rsa' })), null);
});

test('a write through a rooted or a home path lands where the system puts it, outside the workspace', () => {
  assert.equal(
    pi(request('write', { path: '\\Users\\op\\out.txt', content: 'x' }))?.reason,
    'path-escapes-root',
  );
  assert.equal(pi(request('write', { path: '~/out.txt', content: 'x' }))?.reason, 'path-escapes-root');
  // Control: a relative write and a rooted one that lands inside the workspace both flow.
  assert.equal(pi(request('write', { path: 'out.txt', content: 'x' })), null);
  assert.equal(pi(request('write', { path: '\\work\\session-1\\out.txt', content: 'x' })), null);
});

test("a drive-relative path on the call's own drive is placed under the call's directory", () => {
  assert.equal(
    pi(request('read', { path: 'C:..\\..\\Users\\op\\.ssh\\id_rsa' }))?.reason,
    'credential-path-denied',
  );
  assert.equal(pi(request('read', { path: 'c:src\\a.ts' })), null, 'the drive letter is read in either case');
  assert.equal(pi(request('write', { path: 'C:out.txt', content: 'x' })), null);
});

test("a drive-relative path on another drive, and another user's home, cannot be placed and are refused by name", () => {
  assert.equal(pi(request('read', { path: 'D:id_rsa' }))?.reason, 'path-unplaceable');
  assert.equal(pi(request('write', { path: 'D:out.txt', content: 'x' }))?.reason, 'path-unplaceable');
  assert.equal(pi(request('read', { path: '~bob/.ssh/id_rsa' }))?.reason, 'path-unplaceable');
  // Control: a file merely named with a leading tilde is the name it is written as.
  assert.equal(pi(request('read', { path: '~notes.txt' })), null);
  assert.equal(pi(request('read', { path: '~$report.docx' })), null);
});

test("a patch's files are placed the same way, each one", () => {
  const codex = localGate({
    workspaceRoot: WORK,
    resolve: onWindows,
    protectedPaths: [KEYS],
    home: HOME,
    toolFamilies: CODEX_TOOL_FAMILIES,
    resolvesAgainstCallCwd: true,
  });
  const patch = (file: string): DecisionRequest =>
    request('apply_patch', { command: `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch` });
  assert.equal(codex(patch('\\Users\\op\\.ssh\\authorized_keys'))?.reason, 'credential-path-denied');
  assert.equal(codex(patch('\\Users\\op\\notes.txt'))?.reason, 'path-escapes-root');
  assert.equal(codex(patch('D:notes.txt'))?.reason, 'path-unplaceable');
  assert.equal(codex(patch('src\\a.ts')), null);
});

test('a gate that leaves a relative path to its resolver still places a rooted and a home path', () => {
  const plain = localGate({ workspaceRoot: WORK, resolve: onWindows, protectedPaths: [KEYS], home: HOME });
  assert.equal(
    plain(request('Read', { file_path: '\\Users\\op\\.ssh\\id_rsa' }))?.reason,
    'credential-path-denied',
  );
  assert.equal(plain(request('Read', { file_path: '~/.ssh/id_rsa' }))?.reason, 'credential-path-denied');
  assert.equal(
    plain(request('Grep', { pattern: 'x', path: '\\Users\\op\\.ssh' }))?.reason,
    'credential-path-denied',
  );
});

test('under a POSIX call directory a backslash and a drive-shaped name are ordinary names, and nothing new is refused', () => {
  const linux = localGate({
    workspaceRoot: '/work/session-1',
    resolve: (path) => posix.resolve(path),
    protectedPaths: ['/home/op/.ssh'],
    home: '/home/op',
    toolFamilies: PI_TOOL_FAMILIES,
    resolvesAgainstCallCwd: true,
    resolvesWritesAgainstCallCwd: true,
  });
  const at = (toolName: string, toolInput: unknown): DecisionRequest =>
    request(toolName, toolInput, '/work/session-1');
  assert.equal(linux(at('read', { path: '\\Users\\op\\.ssh\\id_rsa' })), null);
  assert.equal(linux(at('read', { path: 'D:id_rsa' })), null);
  assert.equal(linux(at('write', { path: 'D:out.txt', content: 'x' })), null);
  assert.equal(linux(at('read', { path: '/work/session-1/a.ts' })), null);
  // Home is home on every system.
  assert.equal(linux(at('read', { path: '~/.ssh/id_rsa' }))?.reason, 'credential-path-denied');
  assert.equal(linux(at('write', { path: '~/out.txt', content: 'x' }))?.reason, 'path-escapes-root');
});

// ---------------------------------------------------------------------------
// The placement itself
// ---------------------------------------------------------------------------

const placedAt = (candidate: string, directory: string | null, placesRelative = true): string => {
  const placed = placePath(candidate, { directory, home: HOME, placesRelative });
  return typeof placed === 'string' ? placed : placed.reason;
};

test('each form is placed where Windows puts it for a tool running in the directory', () => {
  assert.equal(win32.resolve(placedAt('\\a\\b', WORK)), 'C:\\a\\b');
  assert.equal(win32.resolve(placedAt('/a/b', WORK)), 'C:\\a\\b');
  assert.equal(win32.resolve(placedAt('C:a\\b', WORK)), 'C:\\work\\session-1\\a\\b');
  assert.equal(win32.resolve(placedAt('C:', WORK)), WORK);
  assert.equal(win32.resolve(placedAt('a\\b', WORK)), 'C:\\work\\session-1\\a\\b');
  assert.equal(win32.resolve(placedAt('~\\a', WORK)), 'C:\\Users\\op\\a');
  assert.equal(win32.resolve(placedAt('~', WORK)), HOME);
  assert.equal(placedAt('D:\\a\\b', WORK), 'D:\\a\\b', 'a path that names its drive and its root is itself');
  assert.equal(placedAt('\\\\server\\share\\a', WORK), '\\\\server\\share\\a', 'a share is itself');
  assert.equal(placedAt('D:a', WORK), 'path-unplaceable');
  assert.equal(placedAt('~bob\\a', WORK), 'path-unplaceable');
});

test("a path rooted without a drive, in a directory on a share, starts at the share's root", () => {
  const share = '\\\\files\\team\\work\\session-1';
  assert.equal(win32.resolve(placedAt('\\a\\b', share)), '\\\\files\\team\\a\\b');
  assert.equal(placedAt('C:a', share), 'path-unplaceable', 'a share has no drive for it to be relative to');
});

test('control: a relative path is left as written where the gate does not place it, and refused where there is nowhere to place it', () => {
  assert.equal(placedAt('a/b', WORK, false), 'a/b');
  assert.equal(placedAt('a/b', '/work', false), 'a/b');
  assert.equal(placedAt('a/b', null), 'path-not-absolute');
  assert.equal(placedAt('/a/b', null), '/a/b');
  assert.equal(placedAt('a/b', '/work'), '/work/a/b');
});

// ---------------------------------------------------------------------------
// Other spellings of one file
// ---------------------------------------------------------------------------

test('a device prefix is the drive path after it: a protected file under it is refused, and any other is read or written as its plain spelling is', () => {
  for (const path of [
    '\\\\?\\C:\\Users\\op\\.ssh\\id_rsa',
    '\\\\.\\C:\\Users\\op\\.ssh\\id_rsa',
    '//?/C:/Users/op/.ssh/id_rsa',
  ]) {
    assert.equal(pi(request('read', { path }))?.reason, 'credential-path-denied', path);
  }
  assert.equal(pi(request('read', { path: '\\\\?\\C:\\work\\session-1\\a.ts' })), null);
  assert.equal(
    pi(request('write', { path: '\\\\?\\C:\\work\\session-1\\out.txt', content: 'x' })),
    null,
    'the long-path spelling of a file in the workspace is written',
  );
  assert.equal(
    pi(request('write', { path: '\\\\?\\C:\\elsewhere\\out.txt', content: 'x' }))?.reason,
    'path-escapes-root',
  );
});

test("a share that names this machine's own drive is that drive's path", () => {
  const named = placing({ localNames: ['RUNNER-7'] });
  for (const path of [
    '\\\\localhost\\C$\\Users\\op\\.ssh\\id_rsa',
    '\\\\127.0.0.1\\c$\\Users\\op\\.ssh\\id_rsa',
    '\\\\runner-7\\C$\\Users\\op\\.ssh\\id_rsa',
    '\\\\?\\UNC\\localhost\\C$\\Users\\op\\.ssh\\id_rsa',
  ]) {
    assert.equal(named(request('read', { path }))?.reason, 'credential-path-denied', path);
  }
  assert.equal(
    named(request('grep', { pattern: 'x', path: '\\\\localhost\\C$\\Users\\op' }))?.reason,
    'credential-path-denied',
    'a search above the protected folder',
  );
  // Control: another machine's share is a share, and so is this machine's under a name the gate was not told.
  assert.equal(named(request('read', { path: '\\\\files\\C$\\Users\\op\\.ssh\\id_rsa' })), null);
  assert.equal(pi(request('read', { path: '\\\\runner-7\\C$\\Users\\op\\.ssh\\id_rsa' })), null);
  assert.equal(named(request('read', { path: '\\\\files\\team\\notes.txt' })), null);
});

test('a device or volume form that maps to no drive path is refused by name', () => {
  for (const path of [
    '\\\\?\\Volume{4c1b02c1-d990-11dc-99ae-806e6f6e6963}\\Users\\op\\.ssh\\id_rsa',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\Users\\op\\.ssh\\id_rsa',
    '\\\\.\\PhysicalDrive0',
    '\\\\.\\C:',
  ]) {
    assert.equal(pi(request('read', { path }))?.reason, 'path-unplaceable', path);
  }
});

test('what Windows ignores at the end of a name, and a stream named after it, do not hide a protected path', () => {
  for (const path of [
    `${KEYS}.\\id_rsa`,
    `${KEYS} \\id_rsa`,
    `${KEYS}\\id_rsa::$DATA`,
    `${KEYS}::$INDEX_ALLOCATION\\id_rsa`,
    'C:\\Users\\op.\\.ssh\\id_rsa',
  ]) {
    assert.equal(pi(request('read', { path }))?.reason, 'credential-path-denied', path);
  }
  const file = placing({ protectedPaths: ['C:\\Users\\op\\.claude.json'] });
  assert.equal(
    file(request('read', { path: 'C:\\Users\\op\\.claude.json::$DATA' }))?.reason,
    'credential-path-denied',
  );
  assert.equal(
    file(request('read', { path: 'C:\\Users\\op\\.claude.json.' }))?.reason,
    'credential-path-denied',
  );
  assert.equal(
    pi(request('grep', { pattern: 'x', path: 'C:\\Users\\op.' }))?.reason,
    'credential-path-denied',
    'a search root that holds the protected folder',
  );
  // Control: a neighbour whose name only starts the same is not the protected path, and the write limits stay as strict as they were.
  assert.equal(pi(request('read', { path: 'C:\\Users\\op\\.ssh-notes\\a.txt' })), null);
  assert.equal(
    pi(request('write', { path: 'C:\\work\\session-1.\\out.txt', content: 'x' }))?.reason,
    'path-escapes-root',
  );
});

test('a short name is read as the folder the file system says it is, and never refused for its shape', () => {
  const asked: string[] = [];
  const realPath = (path: string): string => {
    asked.push(path);
    return path.replace(/SSH~1/i, '.ssh').replace(/OP~1/i, 'op');
  };
  const expanding = placing({ realPath });
  assert.equal(
    expanding(request('read', { path: 'C:\\Users\\op\\SSH~1\\id_rsa' }))?.reason,
    'credential-path-denied',
  );
  assert.equal(
    expanding(request('read', { path: 'C:\\Users\\OP~1\\.ssh\\id_rsa' }))?.reason,
    'credential-path-denied',
  );
  assert.equal(
    expanding(request('grep', { pattern: 'x', path: 'C:\\Users\\OP~1' }))?.reason,
    'credential-path-denied',
  );
  // A short name that names something else is read, and one in the workspace or a further root is written.
  assert.equal(expanding(request('read', { path: 'C:\\PROGRA~1\\nodejs\\node.exe' })), null);
  assert.equal(
    expanding(request('write', { path: 'C:\\work\\session-1\\BUILDO~1\\a.txt', content: 'x' })),
    null,
  );
  const temp = placing({ realPath, writeRoots: ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\s1'] });
  assert.equal(
    temp(request('write', { path: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\s1\\out.txt', content: 'x' })),
    null,
    'a temp folder handed over in short form is still written',
  );
  // The file system is asked only about a path with a segment of that shape.
  asked.length = 0;
  expanding(request('read', { path: 'C:\\work\\session-1\\src\\a.ts' }));
  assert.deepEqual(asked, []);
});

test('control: with no way to ask the file system, or one that fails, a short name is checked as written', () => {
  assert.equal(pi(request('read', { path: 'C:\\Users\\op\\SSH~1\\id_rsa' })), null);
  const failing = placing({
    realPath: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(failing(request('read', { path: 'C:\\Users\\op\\SSH~1\\id_rsa' })), null);
  assert.equal(failing(request('read', { path: `${KEYS}\\id_rsa` }))?.reason, 'credential-path-denied');
});

test('a protected path that is itself spelled with a short name covers the long spelling of the same folder', () => {
  const realPath = (path: string): string => path.replace(/RUNNER~1/i, 'runner-account');
  const short = placing({ protectedPaths: ['C:\\Users\\RUNNER~1\\.periscope'], realPath });
  assert.equal(
    short(request('read', { path: 'C:\\Users\\runner-account\\.periscope\\token-cache.json' }))?.reason,
    'credential-path-denied',
  );
});

test('control: under a POSIX path a trailing dot, a colon and two leading slashes are part of an ordinary name', () => {
  const linux = localGate({
    workspaceRoot: '/work/session-1',
    resolve: (path) => posix.resolve(path),
    protectedPaths: ['/home/op/.ssh'],
    home: '/home/op',
    toolFamilies: PI_TOOL_FAMILIES,
    resolvesAgainstCallCwd: true,
    resolvesWritesAgainstCallCwd: true,
  });
  const read = (path: string): ReturnType<typeof linux> =>
    linux(request('read', { path }, '/work/session-1'));
  assert.equal(read('/home/op/.ssh./id_rsa'), null);
  assert.equal(read('/home/op/.ssh:old/id_rsa'), null);
  assert.equal(read('//./home/op/notes.txt'), null);
  assert.equal(read('//?/C:/Users/op/.ssh/id_rsa'), null);
  assert.equal(read('/home/op/.ssh/id_rsa')?.reason, 'credential-path-denied');
});
