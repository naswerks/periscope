/**
 * An endpoint's own variables outrank a controller's lane: the host applies its endpoint's environment
 * after the controller's literals, so a key an operator declares for the controller and an endpoint also
 * sets reaches the session as the endpoint set it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { composeSpawnEnv } from './spawn-env.js';

test("a key both the controller's lane and the endpoint set reaches the session as the endpoint set it", () => {
  const env = composeSpawnEnv(
    { PATH: 'p' },
    { extraAllowedKeys: ['REGION_HINT'], extraEnv: { REGION_HINT: 'from the controller' } },
    { REGION_HINT: 'from the endpoint' },
  );
  assert.equal(env['REGION_HINT'], 'from the endpoint');
});

test("control: with no endpoint value the controller's declared literal stands", () => {
  const env = composeSpawnEnv(
    { PATH: 'p' },
    { extraAllowedKeys: ['REGION_HINT'], extraEnv: { REGION_HINT: 'from the controller' } },
    {},
  );
  assert.equal(env['REGION_HINT'], 'from the controller');
});
