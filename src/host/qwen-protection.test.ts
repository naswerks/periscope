/**
 * Qwen Code's credential material in the protected set: the runner's session homes, the operator's own
 * Qwen home and its files, and the variables file in the operator's home, which the CLI loads whatever
 * its own home is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { credentialPaths, join } from './paths.js';

const HOME = 'C:\\Users\\op';
const env = { USERPROFILE: HOME, HOME };

test("the operator's own Qwen home and the home directory's variables file are protected whether or not this host runs Qwen Code", () => {
  const paths = credentialPaths(env);
  for (const file of [
    'oauth_creds.json',
    'mcp-oauth-tokens.json',
    'mcp-oauth-tokens-v2.json',
    'extension-secrets-v1.json',
    'settings.json',
    '.env',
  ]) {
    assert.ok(paths.includes(join(HOME, '.qwen', file)), `~/.qwen/${file} is not protected`);
  }
  assert.ok(paths.includes(join(HOME, '.env')), '~/.env is not protected');
});

test("the runner's Qwen home protects every session home beneath it, and leaves the shared runtime directory readable", () => {
  const paths = credentialPaths(env, { qwenHome: 'C:\\runner\\qwen' });
  assert.ok(paths.includes(join('C:\\runner\\qwen', 'sessions')));
  assert.equal(paths.includes(join('C:\\runner\\qwen', 'runtime')), false);
  assert.equal(
    paths.includes('C:\\runner\\qwen'),
    false,
    'the whole home would block the chats a resume reads',
  );
  const fromEnv = credentialPaths({ ...env, PERISCOPE_QWEN_HOME: 'C:\\runner\\qwen' });
  assert.ok(fromEnv.includes(join('C:\\runner\\qwen', 'sessions')));
});

test("an operator's own QWEN_HOME keeps its credential files there, and is protected too", () => {
  const paths = credentialPaths({ ...env, QWEN_HOME: 'D:\\qwen' });
  assert.ok(paths.includes(join('D:\\qwen', 'oauth_creds.json')));
  assert.ok(paths.includes(join('D:\\qwen', 'settings.json')));
});
