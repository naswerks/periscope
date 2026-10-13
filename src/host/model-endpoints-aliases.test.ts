/**
 * An agent alias an endpoint lists as a model and does not map is named at start, never refused: a
 * session naming it is refused by name at its open, so it never reaches another model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { withTempDir } from '../test-support/temp-dir.js';
import { endpointModelProblem, readModelEndpoints } from './model-endpoints.js';

const ENTRY = {
  name: 'deepseek',
  wireApi: 'anthropic-messages',
  runtimes: ['claude'],
  baseUrl: 'https://api.deepseek.example/anthropic',
  credential: { env: 'EXAMPLE_ENDPOINT_KEY' },
  models: ['deepseek-flash', 'default', 'opusplan', 'opus'],
  modelAliases: { opus: 'deepseek-flash', sonnet: 'deepseek-flash', haiku: 'deepseek-flash' },
};

const read = (entries: readonly unknown[]): Promise<ReturnType<typeof readModelEndpoints>> =>
  withTempDir('endpoints', async (dir) => {
    const path = join(dir, 'endpoints.json');
    await writeFile(path, JSON.stringify({ endpoints: entries }), 'utf8');
    return readModelEndpoints(path, { EXAMPLE_ENDPOINT_KEY: 'example-secret-value' });
  });

test('an unmapped alias listed as a model is reported, the endpoint still read, and a mapped one is not reported', async () => {
  const reading = await read([ENTRY]);
  assert.ok(typeof reading !== 'string', typeof reading === 'string' ? reading : '');
  assert.deepEqual(reading.unmappedAliases, [{ endpoint: 'deepseek', members: ['default', 'opusplan'] }]);
  assert.deepEqual(
    reading.endpoints.map((endpoint) => endpoint.name),
    ['deepseek'],
  );
  const endpoint = reading.endpoints[0];
  assert.ok(endpoint !== undefined);
  // What makes it a report rather than a refusal: naming it is refused by name, so nothing misroutes.
  assert.match(endpointModelProblem('default', endpoint) ?? '', /alias/);
  assert.equal(endpointModelProblem('opus', endpoint), null);
});

test('control: an endpoint marked as the first-party route reports no alias, since there the agent resolves it', async () => {
  const reading = await read([
    { ...ENTRY, firstParty: true, models: ['claude-opus-5-5', 'default'], modelAliases: {} },
  ]);
  assert.ok(typeof reading !== 'string', typeof reading === 'string' ? reading : '');
  assert.deepEqual(reading.unmappedAliases, []);
});
