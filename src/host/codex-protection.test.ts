/**
 * What a Codex runtime adds to the protections every session has: its home's sign-in joins the
 * protected read set, its model route and identity join the env floor, and its tool names read as
 * the same tool kinds a controller judges Claude's by.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';

import { checkReadPath, checkShellForProtectedPaths } from '../gate/jail.js';
import type { JailOptions } from '../gate/jail.js';
import { codexItemToolName, codexToolKind } from '../gate/tool-kind.js';
import { EXTRA_ENV_FLOOR, envKeysBeneathFloor } from '../sessions/spawn-env.js';
import { credentialPaths } from './paths.js';

const ENV = { USERPROFILE: 'C:/Users/agent', PERISCOPE_CODEX_HOME: 'C:/runner/codex-home' };

const jail = (protectedPaths: readonly string[]): JailOptions => ({
  workspaceRoot: 'C:/work',
  resolve: (path) => posix.normalize(path.replace(/\\/g, '/')),
  protectedPaths,
});

test("the runner's Codex home protects its sign-in and its hook files, the operator's own its sign-in, and neither the whole home", () => {
  const paths = credentialPaths(ENV);
  for (const expected of [
    'C:/runner/codex-home/auth.json',
    'C:/runner/codex-home/.credentials.json',
    'C:/Users/agent/.codex/auth.json',
    'C:/Users/agent/.codex/.credentials.json',
    'C:/runner/codex-home/hooks.json',
    'C:/runner/codex-home/hooks',
    'C:/runner/codex-home/config.toml',
  ]) {
    assert.ok(paths.includes(expected), `${expected} is not protected`);
  }
  assert.ok(
    !paths.includes('C:/runner/codex-home'),
    'the whole home is protected, rollouts and config included',
  );
  assert.ok(
    credentialPaths(ENV, { codexHome: 'D:/other' }).includes('D:/other/auth.json'),
    'the resolved home outranks the variable',
  );
});

test("a session reading a Codex sign-in or the runner home's config is refused credential-path-denied; the operator's own config is not", () => {
  const options = jail(credentialPaths(ENV));
  assert.equal(checkReadPath('C:/runner/codex-home/auth.json', options)?.reason, 'credential-path-denied');
  assert.equal(
    checkReadPath('C:/Users/agent/.codex/.credentials.json', options)?.reason,
    'credential-path-denied',
  );
  assert.equal(checkReadPath('C:/runner/codex-home/config.toml', options)?.reason, 'credential-path-denied');
  assert.equal(checkReadPath('C:/Users/agent/.codex/config.toml', options), null);
  assert.equal(
    checkShellForProtectedPaths('type C:\\runner\\codex-home\\auth.json', options)?.reason,
    'credential-path-denied',
  );
});

test("Codex's home, local route, model route, identity and certificate authority are beneath the env floor, by exact name", () => {
  const codexKeys = [
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'CODEX_OSS_BASE_URL',
    'CODEX_OSS_PORT',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'CODEX_ACCESS_TOKEN',
    'CODEX_CA_CERTIFICATE',
  ];
  assert.deepEqual(envKeysBeneathFloor(codexKeys, EXTRA_ENV_FLOOR), codexKeys);
  for (const key of codexKeys) assert.ok(EXTRA_ENV_FLOOR.includes(key), `${key} is not an exact floor entry`);
  // Control: exact names, not a family. A name beside them stays above the floor.
  assert.deepEqual(envKeysBeneathFloor(['OPENAI_ORGANIZATION', 'CODEX_SOMETHING_ELSE'], EXTRA_ENV_FLOOR), []);
});

test("Codex's tool names read as tool kinds; a name the map does not hold is other", () => {
  assert.equal(codexToolKind('Bash'), 'shell');
  assert.equal(codexToolKind('apply_patch'), 'file_edit');
  assert.equal(codexToolKind('view_image'), 'file_read');
  assert.equal(codexToolKind('web_search'), 'web');
  assert.equal(codexToolKind('mcp__docs__search'), 'mcp');
  for (const other of [
    'spawn_agent',
    'update_plan',
    'request_user_input',
    'tool_search',
    'spawnAgent',
    'image_generation',
  ]) {
    assert.equal(codexToolKind(other), 'other', other);
  }
});

test('each tool item is named as the tool it calls; an item that calls none is no tool', () => {
  assert.equal(codexItemToolName({ type: 'commandExecution' }), 'Bash');
  assert.equal(codexItemToolName({ type: 'fileChange' }), 'apply_patch');
  assert.equal(
    codexItemToolName({ type: 'mcpToolCall', server: 'docs', tool: 'search' }),
    'mcp__docs__search',
  );
  assert.equal(codexItemToolName({ type: 'webSearch' }), 'web_search');
  assert.equal(codexItemToolName({ type: 'imageView' }), 'view_image');
  assert.equal(codexItemToolName({ type: 'imageGeneration' }), 'image_generation');
  assert.equal(codexItemToolName({ type: 'collabAgentToolCall', tool: 'spawnAgent' }), 'spawnAgent');
  for (const none of ['agentMessage', 'reasoning', 'plan', 'contextCompaction', 'userMessage']) {
    assert.equal(codexItemToolName({ type: none }), null, none);
  }
  assert.equal(
    codexItemToolName({ type: 'mcpToolCall' }),
    null,
    'an MCP call naming no server is no tool name invented',
  );
});
