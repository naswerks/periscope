/**
 * pi's credential material in the protected set, as pi's own tools meet it: the runner's whole pi home
 * (its agent home with the sign-in and the endpoints' keys, the sessions store, every session's run
 * directory with the channel's token and the tickets), and the sign-in, token and models files of the
 * operator's own `~/.pi/agent`, on every host. A read, a search, a listing and a shell command naming
 * one are each refused before anything is asked of anyone; a write is jailed where pi would write it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { DecisionRequest } from '../gate/decision.js';
import { PI_TOOL_FAMILIES, localGate } from '../gate/local.js';
import { piShellDialect, piToolKind } from '../gate/tool-kind.js';
import { credentialPaths, join, nodePathResolver } from './paths.js';

const win = process.platform === 'win32';
const HOME = win ? 'C:\\Users\\op' : '/home/op';
const BASE = win ? 'C:\\runner\\pi' : '/srv/runner/pi';
const ROOT = win ? 'C:\\work\\session-1' : '/work/session-1';
const env = { USERPROFILE: HOME, HOME };

test("the runner's pi home is protected whole, and the operator's own pi sign-in, token and models files on every host", () => {
  const paths = credentialPaths(env, { piHome: BASE });
  assert.ok(paths.includes(BASE), 'the runner pi home is not protected');
  for (const file of ['auth.json', 'mcp-auth.json', 'models.json']) {
    assert.ok(paths.includes(join(HOME, '.pi', 'agent', file)), `~/.pi/agent/${file} is not protected`);
  }
  assert.ok(
    credentialPaths({ ...env, PERISCOPE_PI_HOME: BASE }).includes(BASE),
    'the home named by the environment',
  );
  assert.equal(credentialPaths(env).includes(BASE), false);
});

function gateWith(protectedPaths: readonly string[]) {
  const gate = localGate({
    workspaceRoot: ROOT,
    resolve: nodePathResolver,
    protectedPaths,
    home: HOME,
    toolFamilies: PI_TOOL_FAMILIES,
    readsShellDialect: true,
    resolvesAgainstCallCwd: true,
    resolvesWritesAgainstCallCwd: true,
  });
  return (toolName: string, toolInput: Record<string, unknown>) => {
    const toolKind = piToolKind(toolName);
    const dialect = piShellDialect(toolName);
    const request: DecisionRequest = {
      toolName,
      toolUseId: 'call_1',
      toolInput,
      sessionId: 's',
      sessionKey: 'session-1',
      cwd: ROOT,
      agentId: null,
      agentType: null,
      toolKind,
      runtime: 'pi',
      ...(dialect === null ? {} : { shellDialect: dialect }),
    };
    return gate(request);
  };
}

const AUTH = join(BASE, 'agent', 'auth.json');
const SESSION = join(BASE, 'sessions', '2026-10-14T00-00-00-000Z_x.jsonl');
const CONFIG = join(BASE, 'run', 'r1', 'extension.json');
const OWN_AUTH = join(HOME, '.pi', 'agent', 'auth.json');
const MODELS = join(BASE, 'agent', 'models.json');

test("every pi tool that reads is refused a credential path: read, grep, find and ls, and a shell command in either of pi's shells", () => {
  const decide = gateWith(credentialPaths(env, { piHome: BASE }));
  const refusedReason = (toolName: string, input: Record<string, unknown>) =>
    decide(toolName, input)?.reason ?? null;
  for (const path of [AUTH, SESSION, CONFIG, OWN_AUTH, MODELS, join(BASE, 'agent', 'mcp-auth.json')]) {
    assert.equal(refusedReason('read', { path }), 'credential-path-denied', `read ${path}`);
    assert.equal(
      refusedReason('bash', { command: `cat '${path}'` }),
      'credential-path-denied',
      `bash cat ${path}`,
    );
    assert.equal(
      refusedReason('powershell', { command: `Get-Content '${path}'` }),
      'credential-path-denied',
      `powershell ${path}`,
    );
  }
  assert.equal(
    refusedReason('grep', { pattern: 'key', path: join(BASE, 'agent') }),
    'credential-path-denied',
  );
  assert.equal(refusedReason('find', { pattern: '*.json', path: BASE }), 'credential-path-denied');
  assert.equal(refusedReason('ls', { path: join(BASE, 'sessions') }), 'credential-path-denied');
});

test('control: the same reads with the pi home left out of the set are not refused as credentials, so the refusals above are the set at work', () => {
  const decide = gateWith(credentialPaths(env));
  assert.notEqual(decide('read', { path: AUTH })?.reason ?? null, 'credential-path-denied');
  assert.notEqual(decide('read', { path: SESSION })?.reason ?? null, 'credential-path-denied');
  // The operator's own file stays protected without the runner's home: it is protected on every host.
  assert.equal(decide('read', { path: OWN_AUTH })?.reason ?? null, 'credential-path-denied');
});

test('pi writes a relative path where the session runs, so a write is jailed there: inside it goes on, and one that climbs out is refused', () => {
  const decide = gateWith([]);
  assert.equal(decide('write', { path: 'out.txt', content: 'x' }), null);
  assert.equal(decide('edit', { path: join('src', 'a.ts'), edits: [] }), null);
  assert.equal(
    decide('write', { path: join('..', '..', 'elsewhere.txt'), content: 'x' })?.reason,
    'path-escapes-root',
  );
  assert.equal(decide('write', { path: join(HOME, 'x.txt'), content: 'x' })?.reason, 'path-escapes-root');
});

test('control: without the write option a relative path is read where this process runs, not where the session does', () => {
  const plain = localGate({
    workspaceRoot: ROOT,
    resolve: nodePathResolver,
    protectedPaths: [],
    toolFamilies: PI_TOOL_FAMILIES,
  });
  const request: DecisionRequest = {
    toolName: 'write',
    toolUseId: 'call_1',
    toolInput: { path: 'out.txt' },
    sessionId: 's',
    sessionKey: 'session-1',
    cwd: ROOT,
    agentId: null,
    agentType: null,
  };
  assert.equal(
    plain(request)?.reason,
    'path-escapes-root',
    'the relative path landed inside the session without the option',
  );
});
