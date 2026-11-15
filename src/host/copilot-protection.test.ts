/**
 * Copilot's credential material in the protected set, as Copilot's own tools meet it: the token file, the
 * runner's whole Copilot base (each session's `COPILOT_HOME` and the `LOCALAPPDATA` and `APPDATA` it starts
 * with, every kept session state), the operator's SDK install, and the operator's own `~/.copilot` on every
 * host. A read, a search, a listing and a shell command naming one are each refused before anything is
 * asked of anyone; a write is jailed where Copilot would write it. The session state is an agent's record
 * as well, refused by the read doors whatever their root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { DecisionRequest } from '../gate/decision.js';
import { COPILOT_TOOL_FAMILIES, localGate } from '../gate/local.js';
import { copilotShellDialect, copilotToolKind } from '../gate/tool-kind.js';
import { agentTranscriptPaths, credentialPaths, join, nodePathResolver } from './paths.js';

const win = process.platform === 'win32';
const HOME = win ? 'C:\\Users\\op' : '/home/op';
const BASE = win ? 'C:\\runner\\copilot' : '/srv/runner/copilot';
const SDK = win ? 'C:\\runner\\copilot-sdk' : '/srv/runner/copilot-sdk';
const TOKEN = win ? 'C:\\runner\\secrets\\copilot-token' : '/srv/runner/secrets/copilot-token';
const ROOT = win ? 'C:\\work\\session-1' : '/work/session-1';
const env = { USERPROFILE: HOME, HOME };
const options = { copilotHome: BASE, copilotSdk: SDK, copilotTokenFile: TOKEN };

/** Every Copilot path holding a credential or a record, each named, under the base unless named apart. */
const SESSION_HOME = join(BASE, 'sessions', '0f1e2d3c');
const HELD_PATHS = {
  'the token file': TOKEN,
  "a session's COPILOT_HOME": SESSION_HOME,
  "a session's LOCALAPPDATA": join(SESSION_HOME, 'local'),
  "a session's APPDATA": join(SESSION_HOME, 'roaming'),
  "a live session's state": join(SESSION_HOME, 'session-state', 'abc', 'events.jsonl'),
  'the kept states': join(BASE, 'state'),
  "a kept session's state": join(BASE, 'state', 'abc', 'events.jsonl'),
  "the operator's SDK install": join(SDK, 'node_modules', '@github', 'copilot-sdk', 'package.json'),
  "the operator's own Copilot home": join(HOME, '.copilot', 'config.json'),
} as const;

function gateWith(protectedPaths: readonly string[]) {
  const gate = localGate({
    workspaceRoot: ROOT,
    resolve: nodePathResolver,
    protectedPaths,
    home: HOME,
    toolFamilies: COPILOT_TOOL_FAMILIES,
    readsShellDialect: true,
    resolvesAgainstCallCwd: true,
    resolvesWritesAgainstCallCwd: true,
  });
  return (toolName: string, toolInput: unknown) => {
    const dialect = copilotShellDialect(toolName);
    const request: DecisionRequest = {
      toolName,
      toolUseId: 'call_1',
      toolInput,
      sessionId: 's',
      sessionKey: 'session-1',
      cwd: ROOT,
      agentId: null,
      agentType: null,
      toolKind: copilotToolKind(toolName),
      runtime: 'copilot',
      ...(dialect === null ? {} : { shellDialect: dialect }),
    };
    return gate(request)?.reason ?? null;
  };
}

/** The held paths `decide` does not refuse a `view` of, by name. */
function unprotected(decide: ReturnType<typeof gateWith>): string[] {
  return Object.entries(HELD_PATHS)
    .filter(([, path]) => decide('view', { path }) !== 'credential-path-denied')
    .map(([name]) => name);
}

test('every Copilot path holding a credential or a record is in the protected set before the first session, each named', () => {
  assert.deepEqual(unprotected(gateWith(credentialPaths(env, options))), []);
  const fromEnv = credentialPaths({
    ...env,
    PERISCOPE_COPILOT_HOME: BASE,
    PERISCOPE_COPILOT_SDK: SDK,
    PERISCOPE_COPILOT_TOKEN_FILE: TOKEN,
  });
  assert.deepEqual(unprotected(gateWith(fromEnv)), [], 'the paths named by the environment');
});

test('control: drop one Copilot path from the set and the test names exactly what it held', () => {
  assert.deepEqual(unprotected(gateWith(credentialPaths(env, { ...options, copilotSdk: null }))), [
    "the operator's SDK install",
  ]);
  assert.deepEqual(unprotected(gateWith(credentialPaths(env, { ...options, copilotTokenFile: null }))), [
    'the token file',
  ]);
  assert.deepEqual(unprotected(gateWith(credentialPaths(env, { ...options, copilotHome: null }))), [
    "a session's COPILOT_HOME",
    "a session's LOCALAPPDATA",
    "a session's APPDATA",
    "a live session's state",
    'the kept states',
    "a kept session's state",
  ]);
});

test("every Copilot tool that reads is refused a credential path: view, grep and glob by their paths, and a command in either of Copilot's shells", () => {
  const decide = gateWith(credentialPaths(env, options));
  for (const path of [TOKEN, join(BASE, 'state'), join(HOME, '.copilot', 'config.json')]) {
    assert.equal(decide('view', { path }), 'credential-path-denied', `view ${path}`);
    assert.equal(decide('powershell', { command: `Get-Content '${path}'` }), 'credential-path-denied');
    assert.equal(decide('bash', { command: `cat '${path}'` }), 'credential-path-denied');
  }
  assert.equal(decide('grep', { pattern: 'token', paths: [join(BASE, 'state')] }), 'credential-path-denied');
  assert.equal(
    decide('glob', { pattern: '*.json', paths: [join(HOME, '.copilot')] }),
    'credential-path-denied',
  );
  assert.equal(
    decide('grep', { pattern: 'x', paths: ['src', join(BASE, 'sessions')] }),
    'credential-path-denied',
  );
});

test('the home the runtime is started with is read as the protected path it is, through the variable that names it', () => {
  const gate = localGate({
    workspaceRoot: ROOT,
    resolve: nodePathResolver,
    protectedPaths: credentialPaths(env, options),
    home: HOME,
    toolFamilies: COPILOT_TOOL_FAMILIES,
    readsShellDialect: true,
    resolvesAgainstCallCwd: true,
    resolvesWritesAgainstCallCwd: true,
    spawnEnv: () => ({ COPILOT_HOME: SESSION_HOME, LOCALAPPDATA: join(SESSION_HOME, 'local') }),
  });
  const shell = (command: string) =>
    gate({
      toolName: 'powershell',
      toolUseId: 'call_1',
      toolInput: { command },
      sessionId: 's',
      sessionKey: 'session-1',
      cwd: ROOT,
      agentId: null,
      agentType: null,
      toolKind: 'shell',
      runtime: 'copilot',
      shellDialect: 'powershell',
    })?.reason ?? null;
  assert.equal(shell('Get-Content $env:COPILOT_HOME\\config.json'), 'credential-path-denied');
  assert.equal(shell('Get-ChildItem $env:LOCALAPPDATA'), 'credential-path-denied');
});

test("control: a search's paths are its roots; read only its path, a protected directory in the list would pass", () => {
  const decide = gateWith(credentialPaths(env, options));
  assert.equal(decide('grep', { pattern: 'x', paths: [ROOT] }), null, 'the workspace itself is searched');
  assert.equal(decide('grep', { pattern: 'x', paths: [join(BASE, 'state')] }), 'credential-path-denied');
  // The same search naming the directory as `path` is refused by the older rule too: the list adds roots.
  assert.equal(decide('grep', { pattern: 'x', path: join(BASE, 'state') }), 'credential-path-denied');
  // Copilot's searches take `paths` as one string too, and it is the same root.
  assert.equal(decide('grep', { pattern: 'x', paths: join(BASE, 'state') }), 'credential-path-denied');
  assert.equal(
    decide('glob', { pattern: '*.json', paths: join(HOME, '.copilot') }),
    'credential-path-denied',
  );
  assert.equal(decide('grep', { pattern: 'x', paths: ROOT }), null);
});

test('Copilot writes a relative path where the call runs, so a write is jailed there: inside goes on, out is refused', () => {
  const decide = gateWith([]);
  assert.equal(decide('create', { path: 'out.txt', file_text: 'x' }), null);
  assert.equal(decide('edit', { path: join('src', 'a.ts'), old_str: 'a', new_str: 'b' }), null);
  assert.equal(
    decide('create', { path: join('..', '..', 'elsewhere.txt'), file_text: 'x' }),
    'path-escapes-root',
  );
  assert.equal(decide('create', { path: join(HOME, 'x.txt'), file_text: 'x' }), 'path-escapes-root');
  assert.equal(
    decide('str_replace_editor', { command: 'view', path: join(HOME, 'x.txt') }),
    'path-escapes-root',
    'every command of str_replace_editor is held as a write, its view included',
  );
});

test('apply_patch is held to the files its patch names, whether the patch is the whole input or a member', () => {
  const decide = gateWith([]);
  const inside = '*** Begin Patch\n*** Add File: notes.txt\n+hi\n*** End Patch\n';
  const outside = `*** Begin Patch\n*** Add File: ${join(HOME, 'x.txt')}\n+hi\n*** End Patch\n`;
  assert.equal(decide('apply_patch', inside), null);
  assert.equal(decide('apply_patch', outside), 'path-escapes-root');
  assert.equal(decide('apply_patch', { command: outside }), 'path-escapes-root');
});

test('the session state is an agent record: the read doors refuse it whatever their root', () => {
  const records = agentTranscriptPaths(env, { copilotHome: BASE });
  for (const path of [join(BASE, 'sessions'), join(BASE, 'state'), join(HOME, '.copilot', 'session-state')]) {
    assert.ok(records.includes(path), `${path} is not an agent record`);
  }
  assert.ok(agentTranscriptPaths({ ...env, PERISCOPE_COPILOT_HOME: BASE }).includes(join(BASE, 'state')));
  assert.equal(agentTranscriptPaths(env).includes(join(BASE, 'state')), false);
});
