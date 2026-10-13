/**
 * The operator's model endpoints: the file's checks at start, each refusal beside the valid entry it
 * varies by one member; the three credential forms; what the hello lists; what a session on an
 * endpoint is spawned with; and which models an endpoint refuses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { withTempDir } from '../test-support/temp-dir.js';
import type { ModelEndpoint } from './model-endpoints.js';
import {
  endpointModelProblem,
  endpointSpawnEnv,
  hostEndpointsOf,
  readModelEndpoints,
} from './model-endpoints.js';

/** A DeepSeek-shaped entry in its vendor's documented form, with an `env` credential. */
const VALID = {
  name: 'deepseek',
  wireApi: 'anthropic-messages',
  runtimes: ['claude'],
  baseUrl: 'https://api.deepseek.example/anthropic',
  credential: { env: 'EXAMPLE_ENDPOINT_KEY' },
  models: ['deepseek-flash[1m]', 'deepseek-flash'],
  modelAliases: { opus: 'deepseek-flash[1m]', sonnet: 'deepseek-flash[1m]', haiku: 'deepseek-flash' },
  contextWindow: { autoCompactWindow: 786432 },
  env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
};

const ENV = { EXAMPLE_ENDPOINT_KEY: 'example-secret-value' };

/** What a read said, as text: its refusal, or the names it read. */
const said = (read: ReturnType<typeof readModelEndpoints>): string =>
  typeof read === 'string' ? read : `read ${read.endpoints.map((endpoint) => endpoint.name).join(', ')}`;

async function readEntries(
  entries: readonly unknown[],
  env: NodeJS.ProcessEnv = ENV,
  options: Parameters<typeof readModelEndpoints>[2] = {},
): Promise<ReturnType<typeof readModelEndpoints>> {
  return withTempDir('endpoints', async (dir) => {
    const path = join(dir, 'endpoints.json');
    await writeFile(path, JSON.stringify({ endpoints: entries }), 'utf8');
    return readModelEndpoints(path, env, options);
  });
}

async function problemFor(entry: Record<string, unknown>, env: NodeJS.ProcessEnv = ENV): Promise<string> {
  const read = await readEntries([entry], env);
  assert.equal(typeof read, 'string', 'the entry was accepted');
  return read as string;
}

const without = (key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(VALID).filter(([name]) => name !== key));

test('a vendor-shaped entry reads: its members, its credential, and the file it came from', async () => {
  await withTempDir('endpoints-valid', async (dir) => {
    const path = join(dir, 'endpoints.json');
    await writeFile(path, JSON.stringify({ endpoints: [VALID] }), 'utf8');
    const read = readModelEndpoints(path, ENV);
    assert.notEqual(typeof read, 'string', said(read));
    if (typeof read === 'string') return;
    assert.deepEqual(read.files, [path]);
    const [endpoint] = read.endpoints;
    assert.equal(endpoint?.name, 'deepseek');
    assert.equal(endpoint?.firstParty, false, 'firstParty defaults to false');
    assert.equal(endpoint?.authToken(), 'example-secret-value');
    assert.deepEqual(endpoint?.contextWindow, { autoCompactWindow: 786432 });
    assert.ok(
      !JSON.stringify(endpoint).includes('example-secret-value'),
      'the credential serialized with the record',
    );
  });
});

test('an empty list reads as no endpoints', async () => {
  const read = await readEntries([]);
  assert.notEqual(typeof read, 'string', said(read));
  assert.deepEqual(typeof read === 'string' ? null : read.endpoints, []);
});

test('two entries with one name, in any case, refuse start naming the endpoint', async () => {
  const read = await readEntries([VALID, { ...VALID, name: 'DeepSeek' }]);
  assert.match(said(read), /names the endpoint "DeepSeek" twice/);
});

test('an unknown wire API refuses start, naming the APIs this host knows', async () => {
  assert.match(
    await problemFor({ ...VALID, wireApi: 'anthropic-messages-v2' }),
    /wire API "anthropic-messages-v2".*anthropic-messages, openai-responses, openai-chat/,
  );
});

test('a runtime this host routes no endpoint for refuses start, naming the runtimes it routes', async () => {
  assert.match(
    await problemFor({ ...VALID, runtimes: ['example-runtime'] }),
    /runtime "example-runtime", which this host routes no model endpoint for — it routes claude, codex/,
  );
  assert.match(
    await problemFor({ ...VALID, runtimes: ['codex'] }),
    /runtime codex, which does not speak anthropic-messages — codex speaks openai-responses/,
    'codex is routed, and an Anthropic-format endpoint is still not one it can reach',
  );
});

test('a runtime that does not speak the wire API refuses start: claude speaks anthropic-messages only', async () => {
  assert.match(
    await problemFor({ ...VALID, wireApi: 'openai-chat' }),
    /runtime claude, which does not speak openai-chat — claude speaks anthropic-messages/,
  );
});

test('a missing credential refuses start by form: an unset variable, an empty one, an absent file', async () => {
  assert.match(
    await problemFor(VALID, {}),
    /credential variable EXAMPLE_ENDPOINT_KEY, which is unset or empty/,
  );
  assert.match(await problemFor(VALID, { EXAMPLE_ENDPOINT_KEY: '  ' }), /unset or empty/);
  assert.match(await problemFor(without('credential')), /needs a "credential"/);
  assert.match(
    await problemFor({ ...VALID, credential: { file: join('C:/', 'nonexistent-credential-file') } }),
    /credential file .*nonexistent-credential-file, which cannot be read \(ENOENT\)/,
  );
});

test('a firstParty that is not true or false refuses start', async () => {
  assert.match(await problemFor({ ...VALID, firstParty: 'yes' }), /"firstParty" that is not true or false/);
});

test('an unknown key refuses start, naming the keys an endpoint takes', async () => {
  assert.match(
    await problemFor({ ...VALID, contextWindw: { autoCompactWindow: 786432 } }),
    /unknown key 'contextWindw'/,
  );
});

test('an entry that is not first-party must map opus, sonnet and haiku, and list no Claude id', async () => {
  assert.match(
    await problemFor({
      ...VALID,
      modelAliases: { opus: 'deepseek-flash[1m]', sonnet: 'deepseek-flash[1m]' },
    }),
    /maps no model for haiku/,
  );
  assert.match(
    await problemFor({ ...VALID, models: [...VALID.models, 'claude-opus-5-5'] }),
    /lists claude-opus-5-5, a Claude model id, and is not marked "firstParty"/,
  );
  const firstParty = await readEntries([
    { ...VALID, firstParty: true, models: ['claude-opus-5-5'], modelAliases: {}, contextWindow: null },
  ]);
  assert.notEqual(typeof firstParty, 'string', `a first-party entry was refused: ${said(firstParty)}`);
});

test('an alias maps only a tier, and only to a model the entry lists', async () => {
  assert.match(
    await problemFor({ ...VALID, modelAliases: { ...VALID.modelAliases, opusplan: 'deepseek-flash' } }),
    /maps the alias 'opusplan'/,
  );
  assert.match(
    await problemFor({ ...VALID, modelAliases: { ...VALID.modelAliases, haiku: 'deepseek-lite' } }),
    /maps haiku to "deepseek-lite", which its "models" list does not name/,
  );
});

test('the window takes one form: maxContextTokens beside a [1m] id refuses, either form alone reads', async () => {
  assert.match(
    await problemFor({ ...VALID, contextWindow: { maxContextTokens: 983616 } }),
    /declares "maxContextTokens" and lists deepseek-flash\[1m\]/,
  );
  assert.match(
    await problemFor({ ...VALID, contextWindow: { autoCompactWindow: 786432, maxContextTokens: 983616 } }),
    /exactly one of/,
  );
  assert.match(
    await problemFor({ ...VALID, contextWindow: { autoCompactWindow: 99_999 } }),
    /from 100000 to 1000000/,
  );
  const alibaba = await readEntries([
    {
      ...VALID,
      name: 'alibaba',
      models: ['qwen3.8-max', 'qwen3.8-flash'],
      modelAliases: { opus: 'qwen3.8-max', sonnet: 'qwen3.8-max', haiku: 'qwen3.8-flash' },
      contextWindow: { maxContextTokens: 983616 },
    },
  ]);
  assert.notEqual(typeof alibaba, 'string', said(alibaba));
});

test("an entry's env may not set what its members set, nor a variable every session is stripped of", async () => {
  assert.match(
    await problemFor({ ...VALID, env: { anthropic_base_url: 'https://elsewhere.example' } }),
    /sets anthropic_base_url in "env", which this host sets from the endpoint's own members/,
  );
  assert.match(await problemFor({ ...VALID, env: { CLAUDE_EFFORT: 'max' } }), /a variable this host strips/);
  assert.match(await problemFor({ ...VALID, env: { API_TIMEOUT_MS: 3_000_000 } }), /not a string/);
});

test('a base URL that is not http or https refuses start', async () => {
  assert.match(await problemFor({ ...VALID, baseUrl: 'ftp://api.example' }), /absolute http or https URL/);
});

test('more endpoints than a hello carries refuse start', async () => {
  const many = Array.from({ length: 9 }, (_, index) => ({ ...VALID, name: `endpoint-${index}` }));
  assert.match(said(await readEntries(many)), /declares 9 endpoints; at most 8/);
});

test('a file credential is read whole and trimmed, and the file joins the files the protected set takes', async () => {
  await withTempDir('endpoints-file', async (dir) => {
    const key = join(dir, 'key.txt');
    await writeFile(key, 'from-a-file\n', 'utf8');
    const path = join(dir, 'endpoints.json');
    await writeFile(path, JSON.stringify({ endpoints: [{ ...VALID, credential: { file: key } }] }), 'utf8');
    const read = readModelEndpoints(path, {});
    assert.notEqual(typeof read, 'string', said(read));
    if (typeof read === 'string') return;
    assert.equal(read.endpoints[0]?.authToken(), 'from-a-file');
    assert.deepEqual(read.files, [path, key]);

    await writeFile(key, 'line one\nline two\n', 'utf8');
    assert.match(said(readModelEndpoints(path, {})), /more than one line/);
  });
});

/** A helper that runs this Node with a script: an absolute executable, no shell. */
const nodeHelper = (script: string): { helper: { command: string; args: string[] } } => ({
  helper: { command: process.execPath, args: ['-e', script] },
});

test('a helper credential is the one line its command prints, run with no shell', async () => {
  const read = await readEntries(
    [{ ...VALID, credential: nodeHelper("process.stdout.write('from-a-helper\\n')") }],
    {},
  );
  assert.notEqual(typeof read, 'string', said(read));
  assert.equal(typeof read === 'string' ? null : read.endpoints[0]?.authToken(), 'from-a-helper');
});

test('a failing helper refuses start naming the endpoint and its exit, and never what it printed', async () => {
  const marker = 'marker-that-must-never-be-repeated';
  const read = await readEntries(
    [
      {
        ...VALID,
        credential: nodeHelper(
          `process.stdout.write('${marker}'); process.stderr.write('${marker}'); process.exit(3)`,
        ),
      },
    ],
    {},
  );
  assert.match(said(read), /endpoint "deepseek" has a credential helper .* that exited with code 3/);
  assert.ok(!said(read).includes(marker), 'the helper output was repeated in the refusal');

  const silent = await readEntries([{ ...VALID, credential: nodeHelper('process.exit(0)') }], {});
  assert.match(said(silent), /printed nothing/);
});

test('a Windows batch file is refused as a helper, naming the program to run instead', async () => {
  const read = await readEntries(
    [{ ...VALID, credential: { helper: { command: 'C:\\tools\\vault.cmd', args: [] } } }],
    {},
    { platform: 'win32' },
  );
  assert.match(said(read), /a Windows batch file: Node runs one only through a shell/);
  assert.match(said(read), /python\.exe with -IBm azure\.cli/);
  const elsewhere = await readEntries(
    [{ ...VALID, credential: { helper: { command: '/opt/tools/vault.cmd', args: [] } } }],
    {},
    { platform: 'linux' },
  );
  assert.doesNotMatch(said(elsewhere), /batch file/, 'the batch-file rule is a Windows rule');
});

test('a helper command that is not an absolute path refuses start', async () => {
  assert.match(
    await problemFor({ ...VALID, credential: { helper: { command: 'az', args: [] } } }),
    /helper command that is an absolute path/,
  );
});

test('a file wrong in shape runs no helper', async () => {
  await withTempDir('endpoints-no-run', async (dir) => {
    const witness = join(dir, 'ran.txt').split('\\').join('/');
    const read = await readEntries(
      [
        {
          ...VALID,
          firstParty: 'no',
          credential: nodeHelper(`require('fs').writeFileSync('${witness}', 'ran'); console.log('x')`),
        },
      ],
      {},
    );
    assert.match(said(read), /firstParty/);
    await assert.rejects(
      import('node:fs/promises').then((fs) => fs.readFile(witness)),
      'the helper ran',
    );
  });
});

const ENDPOINT: ModelEndpoint = {
  name: 'deepseek',
  wireApi: 'anthropic-messages',
  runtimes: ['claude'],
  baseUrl: 'https://api.deepseek.example/anthropic',
  models: ['deepseek-flash[1m]', 'deepseek-flash'],
  modelAliases: { opus: 'deepseek-flash[1m]', sonnet: 'deepseek-flash[1m]', haiku: 'deepseek-flash' },
  contextWindow: { autoCompactWindow: 786432 },
  env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
  firstParty: false,
  authToken: () => 'example-secret-value',
};

test('the hello lists names, wire APIs, runtimes and models with alias ids, and nothing else', () => {
  assert.deepEqual(hostEndpointsOf([ENDPOINT]), [
    {
      name: 'deepseek',
      wireApi: 'anthropic-messages',
      runtimes: ['claude'],
      models: ['deepseek-flash[1m]', 'deepseek-flash', 'opus', 'sonnet', 'haiku'],
    },
  ]);
});

test('a session on an endpoint is spawned with its address, credential, tiers, window, the two switches and its env', () => {
  assert.deepEqual(endpointSpawnEnv(ENDPOINT), {
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.example/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'example-secret-value',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  });
  const sized = endpointSpawnEnv({ ...ENDPOINT, contextWindow: { maxContextTokens: 983616 } });
  assert.equal(sized['CLAUDE_CODE_MAX_CONTEXT_TOKENS'], '983616');
  assert.equal('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in sized, false, 'both window forms were set');
  const members = endpointSpawnEnv({ ...ENDPOINT, env: { ANTHROPIC_BASE_URL: 'https://elsewhere.example' } });
  assert.equal(members['ANTHROPIC_BASE_URL'], ENDPOINT.baseUrl, "an embedder's env overrode a member");
});

test("regression: a Claude model id on an endpoint that is not Anthropic's own route is refused, naming both", () => {
  assert.match(
    endpointModelProblem('claude-opus-5-5', ENDPOINT) ?? '',
    /^model claude-opus-5-5 named for endpoint "deepseek", which is not marked as Anthropic's own route/,
  );
  assert.equal(endpointModelProblem('deepseek-flash', ENDPOINT), null, "the endpoint's own id");
  assert.equal(
    endpointModelProblem('claude-opus-5-5', { ...ENDPOINT, firstParty: true }),
    null,
    'a first-party route',
  );
  assert.equal(endpointModelProblem(null, ENDPOINT), null, 'no model is the runtime default');
});

test('an alias the endpoint does not map is refused; a mapped one, with or without [1m], is not', () => {
  for (const model of ['default', 'best', 'opusplan', 'fable', 'fable[1m]', 'Default']) {
    assert.match(
      endpointModelProblem(model, ENDPOINT) ?? '',
      new RegExp(`^model ${model.replace(/[[\]]/g, '\\$&')} named for endpoint "deepseek"`),
      `${model} was not refused`,
    );
  }
  for (const model of ['opus', 'opus[1m]', 'sonnet', 'haiku']) {
    assert.equal(endpointModelProblem(model, ENDPOINT), null, `${model} was refused`);
  }
  assert.equal(
    endpointModelProblem('fable', {
      ...ENDPOINT,
      modelAliases: { ...ENDPOINT.modelAliases, fable: 'deepseek-flash' },
    }),
    null,
    'a mapped fable',
  );
});

// ---------------------------------------------------------------------------
// An endpoint Codex reaches
// ---------------------------------------------------------------------------

/** An OpenAI Responses endpoint the operator named Codex on, in the members Codex reads. */
const CODEX_ENDPOINT = {
  name: 'gateway',
  wireApi: 'openai-responses',
  runtimes: ['codex'],
  baseUrl: 'https://gateway.example/v1',
  credential: { env: 'EXAMPLE_ENDPOINT_KEY' },
  models: ['gpt-6-sol', 'claude-opus-5'],
  contextWindow: { maxContextTokens: 400000 },
  env: { EXAMPLE_FLAG: '1' },
};

test("an endpoint only Codex reaches reads without Claude's rules: no model tiers, and any model id", async () => {
  const read = await readEntries([CODEX_ENDPOINT]);
  assert.notEqual(typeof read, 'string', said(read));
  if (typeof read === 'string') return;
  assert.deepEqual(read.ignored, []);
  assert.deepEqual(hostEndpointsOf(read.endpoints), [
    {
      name: 'gateway',
      wireApi: 'openai-responses',
      runtimes: ['codex'],
      models: ['gpt-6-sol', 'claude-opus-5'],
    },
  ]);
  const endpoint = read.endpoints[0] as ModelEndpoint;
  assert.equal(
    endpointModelProblem('claude-opus-5', endpoint),
    null,
    "the alias rule is Claude's: a Codex session never meets it",
  );
  assert.equal(endpointModelProblem('opus', endpoint), null);
});

test('a model tier or the first-party marker on an endpoint only Codex reaches is ignored and reported, never refused', async () => {
  const read = await readEntries([
    { ...CODEX_ENDPOINT, modelAliases: { opus: 'gpt-6-sol' }, firstParty: true },
  ]);
  assert.notEqual(typeof read, 'string', said(read));
  if (typeof read === 'string') return;
  assert.deepEqual(read.ignored, [{ endpoint: 'gateway', members: ['modelAliases', 'firstParty'] }]);
  const endpoint = read.endpoints[0] as ModelEndpoint;
  assert.equal(endpoint.firstParty, false, 'no runtime reaching it reads the marker, so none is applied');
  assert.deepEqual(endpoint.modelAliases, {});
  assert.deepEqual(
    hostEndpointsOf(read.endpoints)[0]?.models,
    ['gpt-6-sol', 'claude-opus-5'],
    'no tier is offered',
  );
});

test("control: Claude's rules still hold on an endpoint Claude reaches", async () => {
  assert.match(await problemFor({ ...VALID, modelAliases: {} }), /maps no model for opus, sonnet, haiku/);
});

test('Codex on an endpoint it cannot speak is refused at start: an OpenAI Chat endpoint', async () => {
  assert.match(
    await problemFor({ ...CODEX_ENDPOINT, wireApi: 'openai-chat' }),
    /runtime codex, which does not speak openai-chat — codex speaks openai-responses/,
  );
});

test('the hello lists a runtime on an endpoint only where it speaks its API: Codex on Responses, never on Chat', () => {
  const declared = (
    wireApi: ModelEndpoint['wireApi'],
    runtimes: string[],
  ): Omit<ModelEndpoint, 'authToken'> => ({
    name: `on-${wireApi}`,
    wireApi,
    runtimes,
    baseUrl: 'https://x.example',
    models: ['m'],
    modelAliases: {},
    contextWindow: null,
    env: {},
    firstParty: false,
  });
  assert.deepEqual(
    hostEndpointsOf([declared('openai-responses', ['codex']), declared('openai-chat', ['codex'])]).map(
      (endpoint) => [endpoint.name, endpoint.runtimes],
    ),
    [
      ['on-openai-responses', ['codex']],
      ['on-openai-chat', []],
    ],
  );
});
