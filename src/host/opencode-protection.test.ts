/**
 * opencode's credential material in the protected set, as opencode's own tools meet it: the runner's whole
 * opencode base (each session's home, with its database and the configuration that holds an endpoint's key,
 * and every kept database), the operator's SDK install, the operator's own opencode directories under their
 * home and wherever their environment moves them, and the machine-wide configuration directory every opencode
 * process reads. A read, a search and a shell command naming one are each refused before anything is asked of
 * anyone; a write is jailed where opencode would write it. The databases are an agent's record as well,
 * refused by the read doors whatever their root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { DecisionRequest } from '../gate/decision.js';
import { OPENCODE_TOOL_FAMILIES, localGate } from '../gate/local.js';
import { opencodeToolKind } from '../gate/tool-kind.js';
import {
  agentTranscriptPaths,
  credentialPaths,
  join,
  nodePathResolver,
  opencodeSystemDirectory,
} from './paths.js';

const win = process.platform === 'win32';
const HOME = win ? 'C:\\Users\\op' : '/home/op';
const BASE = win ? 'C:\\runner\\opencode' : '/srv/runner/opencode';
const SDK = win ? 'C:\\runner\\opencode-sdk' : '/srv/runner/opencode-sdk';
const ROOT = win ? 'C:\\work\\session-1' : '/work/session-1';
const MOVED = win ? 'C:\\xdg' : '/xdg';
const PROGRAM_DATA = win ? 'C:\\ProgramData' : '/unused';
const env = { USERPROFILE: HOME, HOME, ProgramData: PROGRAM_DATA };
const options = { opencodeHome: BASE, opencodeSdk: SDK };

/** Every opencode path holding a credential or a record, each named. */
const SESSION_HOME = join(BASE, 'sessions', '0f1e2d3c');
const HELD_PATHS = {
  "a session's home": SESSION_HOME,
  "a live session's database": join(SESSION_HOME, 'data', 'session.db'),
  "a session's configuration": join(SESSION_HOME, 'opencode-config', 'opencode.json'),
  'the kept databases': join(BASE, 'state'),
  "a kept session's database": join(BASE, 'state', 'ses_abc', 'session.db'),
  "the operator's SDK install": join(SDK, 'node_modules', '@opencode', 'sdk', 'package.json'),
  "the operator's own opencode data": join(HOME, '.local', 'share', 'opencode', 'opencode.db'),
  "the operator's own opencode configuration": join(HOME, '.config', 'opencode', 'opencode.json'),
  "the operator's own opencode state": join(HOME, '.local', 'state', 'opencode', 'service.json'),
  "the machine's opencode configuration": join(opencodeSystemDirectory(env), 'opencode.json'),
} as const;

function gateWith(protectedPaths: readonly string[]) {
  const gate = localGate({
    workspaceRoot: ROOT,
    resolve: nodePathResolver,
    protectedPaths,
    home: HOME,
    toolFamilies: OPENCODE_TOOL_FAMILIES,
    readsShellDialect: true,
    resolvesAgainstCallCwd: true,
    resolvesWritesAgainstCallCwd: true,
  });
  return (toolName: string, toolInput: unknown, shellDialect?: 'powershell' | 'posix') => {
    const request: DecisionRequest = {
      toolName,
      toolUseId: 'call_1',
      toolInput,
      sessionId: 's',
      sessionKey: 'session-1',
      cwd: ROOT,
      agentId: null,
      agentType: null,
      toolKind: opencodeToolKind(toolName),
      runtime: 'opencode',
      ...(shellDialect === undefined ? {} : { shellDialect }),
    };
    return gate(request)?.reason ?? null;
  };
}

/** The held paths `decide` does not refuse a `read` of, by name. */
function unprotected(decide: ReturnType<typeof gateWith>): string[] {
  return Object.entries(HELD_PATHS)
    .filter(([, path]) => decide('read', { path }) !== 'credential-path-denied')
    .map(([name]) => name);
}

test('every opencode path holding a credential or a record is in the protected set before the first session, each named', () => {
  assert.deepEqual(unprotected(gateWith(credentialPaths(env, options))), []);
  const fromEnv = credentialPaths({ ...env, PERISCOPE_OPENCODE_HOME: BASE, PERISCOPE_OPENCODE_SDK: SDK });
  assert.deepEqual(unprotected(gateWith(fromEnv)), [], 'the paths named by the environment');
});

test('control: drop one opencode path from the set and the test names exactly what it held', () => {
  assert.deepEqual(unprotected(gateWith(credentialPaths(env, { ...options, opencodeSdk: null }))), [
    "the operator's SDK install",
  ]);
  assert.deepEqual(unprotected(gateWith(credentialPaths(env, { ...options, opencodeHome: null }))), [
    "a session's home",
    "a live session's database",
    "a session's configuration",
    'the kept databases',
    "a kept session's database",
  ]);
});

test("the operator's opencode directories are protected where the environment moves them, whether or not this host runs opencode", () => {
  const moved = credentialPaths({
    ...env,
    XDG_DATA_HOME: join(MOVED, 'data'),
    XDG_CONFIG_HOME: join(MOVED, 'config'),
    XDG_STATE_HOME: join(MOVED, 'state'),
  });
  const decide = gateWith(moved);
  for (const path of [
    join(MOVED, 'data', 'opencode', 'opencode.db'),
    join(MOVED, 'config', 'opencode', 'opencode.json'),
    join(MOVED, 'state', 'opencode', 'x'),
  ]) {
    assert.equal(decide('read', { path }), 'credential-path-denied', path);
  }
  // Control: the moved directory's other tools are not this runtime's to protect.
  assert.equal(decide('read', { path: join(MOVED, 'data', 'other-tool', 'x') }), null);
});

test("the machine-wide configuration directory is the platform's own", () => {
  assert.equal(opencodeSystemDirectory({ ProgramData: 'D:\\PD' }, 'win32'), join('D:\\PD', 'opencode'));
  assert.equal(opencodeSystemDirectory({}, 'win32'), join('C:\\ProgramData', 'opencode'));
  assert.equal(opencodeSystemDirectory({}, 'darwin'), '/Library/Application Support/opencode');
  assert.equal(opencodeSystemDirectory({}, 'linux'), '/etc/opencode');
});

test('every opencode tool that reads is refused a credential path: read and a directory request by their paths, glob and grep by their roots, and a command in its shell', () => {
  const decide = gateWith(credentialPaths(env, options));
  for (const path of [join(BASE, 'state'), join(HOME, '.local', 'share', 'opencode', 'auth.json')]) {
    assert.equal(decide('read', { path }), 'credential-path-denied', `read ${path}`);
    assert.equal(decide('external_directory', { path }), 'credential-path-denied', `directory ${path}`);
    assert.equal(decide('grep', { pattern: 'key', path }), 'credential-path-denied', `grep ${path}`);
    assert.equal(decide('glob', { pattern: '*.json', path }), 'credential-path-denied', `glob ${path}`);
    assert.equal(
      decide(
        'shell',
        { command: win ? `Get-Content '${path}'` : `cat '${path}'` },
        win ? 'powershell' : 'posix',
      ),
      'credential-path-denied',
      `shell ${path}`,
    );
  }
});

test('opencode writes a relative path where the call runs, so a write is jailed there: inside goes on, out is refused', () => {
  const decide = gateWith([]);
  assert.equal(decide('edit', { path: 'out.txt' }), null);
  assert.equal(decide('edit', { path: join('src', 'a.ts') }), null);
  assert.equal(decide('edit', { path: join('..', '..', 'elsewhere.txt') }), 'path-escapes-root');
  assert.equal(decide('edit', { path: join(HOME, 'x.txt') }), 'path-escapes-root');
});

test('the session databases are an agent record: the read doors refuse them whatever their root', () => {
  const records = agentTranscriptPaths(env, { opencodeHome: BASE });
  for (const path of [
    join(BASE, 'sessions'),
    join(BASE, 'state'),
    join(HOME, '.local', 'share', 'opencode'),
  ]) {
    assert.ok(records.includes(path), `${path} is not an agent record`);
  }
  assert.ok(agentTranscriptPaths({ ...env, PERISCOPE_OPENCODE_HOME: BASE }).includes(join(BASE, 'state')));
  assert.ok(agentTranscriptPaths({ ...env, XDG_DATA_HOME: MOVED }).includes(join(MOVED, 'opencode')));
  assert.equal(agentTranscriptPaths(env).includes(join(BASE, 'state')), false);
});
