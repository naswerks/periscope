/**
 * pi's built-in tools in the local gate: each held to the jail or the protected set by its own field
 * names, a relative path placed where the call runs, each shell read in its own grammar, and every tool
 * of the pinned release read as one kind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PI_NAMES } from '../host/pi-names.js';
import type { DecisionRequest } from './decision.js';
import type { PathResolver } from './jail.js';
import { localGate, PI_TOOL_FAMILIES } from './local.js';
import { piShellDialect, piToolKind } from './tool-kind.js';

const WORK = 'C:/work/session-1';
const AUTH = 'C:/Users/op/.pi/agent/auth.json';
const BASE = 'C:/runner/pi';

/** A resolver over Windows-shaped absolute paths, the same on every platform this suite runs on. */
const resolve: PathResolver = (path) => {
  const absolute = /^[A-Za-z]:\//.test(path) ? path : `${WORK}/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/');
};

const gate = localGate({
  workspaceRoot: WORK,
  resolve,
  protectedPaths: [AUTH, BASE],
  home: 'C:/Users/op',
  toolFamilies: PI_TOOL_FAMILIES,
  readsShellDialect: true,
  resolvesAgainstCallCwd: true,
  resolvesWritesAgainstCallCwd: true,
});

function request(toolName: string, toolInput: Record<string, unknown>): DecisionRequest {
  const dialect = piShellDialect(toolName);
  return {
    toolName,
    toolUseId: 'call_1',
    toolInput,
    sessionId: 's',
    sessionKey: 'k',
    cwd: WORK,
    agentId: null,
    agentType: null,
    runtime: 'pi',
    toolKind: piToolKind(toolName),
    ...(dialect === null ? {} : { shellDialect: dialect }),
  };
}

const reason = (toolName: string, toolInput: Record<string, unknown>): string | null =>
  gate(request(toolName, toolInput))?.reason ?? null;

test("pi's file tools are held to the jail and the protected set by their own field names", () => {
  assert.equal(reason('read', { path: AUTH }), 'credential-path-denied');
  assert.equal(reason('read', { path: `${BASE}/sessions/a.jsonl`, offset: 1 }), 'credential-path-denied');
  assert.equal(reason('read', { path: `${WORK}/src/a.ts` }), null);
  assert.equal(reason('write', { path: 'C:/elsewhere/a.ts', content: 'x' }), 'path-escapes-root');
  assert.equal(reason('write', { path: 'out.txt', content: 'x' }), null);
  assert.equal(reason('edit', { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }), null);
  assert.equal(reason('edit', { path: '../../elsewhere/a.ts', edits: [] }), 'path-escapes-root');
});

test('a search names its root relative to where the call runs, and one reaching the protected set is refused', () => {
  assert.equal(
    reason('grep', { pattern: 'key', path: '../../Users/op/.pi/agent' }),
    'credential-path-denied',
  );
  assert.equal(reason('find', { pattern: '*.json', path: BASE }), 'credential-path-denied');
  assert.equal(reason('ls', { path: `${BASE}/run` }), 'credential-path-denied');
  assert.equal(reason('grep', { pattern: 'x', path: 'src' }), null);
  assert.equal(reason('find', { pattern: '*.ts' }), null);
  assert.equal(reason('ls', {}), null);
});

test('each shell is read in its own grammar, and a command naming a protected path or crossing a boundary is refused in either', () => {
  assert.equal(reason('bash', { command: `cat ${AUTH}` }), 'credential-path-denied');
  assert.equal(reason('powershell', { command: `Get-Content '${AUTH}'` }), 'credential-path-denied');
  assert.equal(reason('bash', { command: 'git push origin main' }), 'shell-boundary-command');
  assert.equal(reason('powershell', { command: 'git push origin main' }), 'shell-boundary-command');
  assert.equal(reason('bash', { command: 'git status' }), null);
  assert.equal(reason('powershell', { command: 'Get-ChildItem src' }), null);
});

test('every tool of the pinned release reads as one kind, MCP tools by their prefix and anything else as other; each shell names its grammar', () => {
  assert.deepEqual(Object.fromEntries(PI_NAMES.tools.map((tool) => [tool, piToolKind(tool)])), {
    read: 'file_read',
    bash: 'shell',
    powershell: 'shell',
    edit: 'file_edit',
    write: 'file_write',
    grep: 'file_read',
    find: 'file_read',
    ls: 'file_read',
  });
  assert.equal(piToolKind('mcp__nas__seat_read'), 'mcp');
  assert.equal(piToolKind('deploy'), 'other');
  assert.deepEqual(
    ['bash', 'powershell', 'read', 'mcp__nas__seat_read'].map((tool) => piShellDialect(tool)),
    ['posix', 'powershell', null, null],
  );
});
