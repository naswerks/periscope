/**
 * `periscope pair`: the verb's whole decision surface, drivable without a controller or a disk.
 * `PairDeps` injects the transport and the store, so nothing here touches a network or a path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Result } from '../core/result.js';
import { ok, refuse } from '../core/result.js';
import type { PairedCredentialFile, PairedCredentialStore } from '../identity/paired-credential.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readConfigFile } from '../host/config-file.js';
import { runPair } from './pair.js';

const ENV: NodeJS.ProcessEnv = {
  HOME: '/home/agent',
  PERISCOPE_DECISION_URL: 'https://controller.example:8443/periscope/decision',
  PERISCOPE_MACHINE_LABEL: 'the test machine',
};

class MemoryStore implements PairedCredentialStore {
  written: PairedCredentialFile | null = null;
  writeAnswer: Result<unknown> = ok({});

  read(): Result<PairedCredentialFile> {
    return this.written === null ? refuse('token-unavailable', 'nothing written') : ok(this.written);
  }

  write(file: PairedCredentialFile): Result<unknown> {
    if (this.writeAnswer.ok) this.written = file;
    return this.writeAnswer;
  }
}

function transportAnswering(status: number, body: unknown): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    transportAnswering.lastUrl = String(url);
    transportAnswering.lastBody = typeof init?.body === 'string' ? init.body : null;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}
transportAnswering.lastUrl = '';
transportAnswering.lastBody = null as string | null;

test('the happy path: POSTs the code, writes the credential, says where it landed', async () => {
  const store = new MemoryStore();
  const lines: string[] = [];
  const transport = transportAnswering(200, { hostId: 'ph-abc', hostCredential: 'p1.ph-abc.s3cret' });

  const outcome = await runPair('THE-code ', ENV, {
    transport,
    store: () => store,
    write: (line) => lines.push(line),
  });

  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail);
  assert.equal(outcome.hostId, 'ph-abc');
  assert.deepEqual(store.written, { hostId: 'ph-abc', credential: 'p1.ph-abc.s3cret' });

  // The URL derives from the decision URL's origin (the one controller address every configured
  // host already has) and the body carries the code verbatim (the door normalizes; a client that
  // also normalized would hide a door regression).
  assert.equal(transportAnswering.lastUrl, 'https://controller.example:8443/api/periscope/pair');
  assert.match(String(transportAnswering.lastBody), /THE-code/);
  assert.match(String(transportAnswering.lastBody), /the test machine/);
  assert.ok(
    lines.some((l) => l.includes('paired as ph-abc')),
    lines.join('\n'),
  );
});

test('PERISCOPE_PAIR_URL wins over the derivation when set', async () => {
  const transport = transportAnswering(200, { hostId: 'ph-x', hostCredential: 'p1.ph-x.s' });

  const outcome = await runPair(
    'c',
    { ...ENV, PERISCOPE_PAIR_URL: 'https://elsewhere.example/pair' },
    {
      transport,
      store: () => new MemoryStore(),
      write: () => {},
    },
  );

  assert.ok(outcome.ok);
  assert.equal(transportAnswering.lastUrl, 'https://elsewhere.example/pair');
});

test('no code is usage, not a network call', async () => {
  let called = false;
  const outcome = await runPair(null, ENV, {
    transport: async () => {
      called = true;
      return new Response('');
    },
    store: () => new MemoryStore(),
    write: () => {},
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.detail, /periscope pair <code>/);
  assert.equal(called, false, 'a parse-level refusal must not burn a round-trip');
});

test('nowhere to redeem is a refusal naming what to set', async () => {
  const outcome = await runPair(
    'c',
    { HOME: '/home/agent' },
    {
      store: () => new MemoryStore(),
      write: () => {},
    },
  );

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.detail, /PERISCOPE_PAIR_URL|PERISCOPE_DECISION_URL/);
});

test("regression: the controller's refusal surfaces with the honest instruction: mint a fresh code", async () => {
  const store = new MemoryStore();
  const outcome = await runPair('c', ENV, {
    transport: transportAnswering(401, 'pair-code-refused'),
    store: () => store,
    write: () => {},
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.detail, /pair-code-refused/);
    assert.match(outcome.detail, /mint a fresh one/i);
  }
  assert.equal(store.written, null, 'a refusal must write nothing');
});

test('a wrong door (404) is named as a wrong door, not as a refused code', async () => {
  const store = new MemoryStore();
  const outcome = await runPair('c', ENV, {
    transport: transportAnswering(404, ''),
    store: () => store,
    write: () => {},
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.detail, /nothing answers the pair route/);
    assert.match(outcome.detail, /--controller/);
    assert.doesNotMatch(outcome.detail, /mint a fresh/i);
  }
  assert.equal(store.written, null);
});

test('a credential outside the p1.<hostId>.<secret> shape is refused before anything is written', async () => {
  const store = new MemoryStore();
  for (const hostCredential of ['opaque-token', 'p1.other-host.secret', 'p1.ph-abc.']) {
    const outcome = await runPair('c', ENV, {
      transport: transportAnswering(200, { hostId: 'ph-abc', hostCredential }),
      store: () => store,
      write: () => {},
    });
    assert.equal(outcome.ok, false, hostCredential);
    if (!outcome.ok) assert.match(outcome.detail, /p1.<hostId>.<secret>/);
    assert.equal(store.written, null, hostCredential);
  }
});

test('a success answer without a credential writes nothing and says so', async () => {
  const store = new MemoryStore();
  const outcome = await runPair('c', ENV, {
    transport: transportAnswering(200, { hostId: 'ph-abc' }),
    store: () => store,
    write: () => {},
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.detail, /nothing was written/);
  assert.equal(store.written, null);
});

test("a store refusal (a too-wide file, a full disk) is the verb's failure, loudly", async () => {
  const store = new MemoryStore();
  store.writeAnswer = refuse('credential-cache-write-failed', 'disk said no');

  const outcome = await runPair('c', ENV, {
    transport: transportAnswering(200, { hostId: 'ph-abc', hostCredential: 'p1.ph-abc.s' }),
    store: () => store,
    write: () => {},
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.detail, /disk said no/);
});

test('an unreachable controller is a refusal naming the address, never a throw', async () => {
  const outcome = await runPair('c', ENV, {
    transport: async () => {
      throw new Error('ECONNREFUSED');
    },
    store: () => new MemoryStore(),
    write: () => {},
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.detail, /could not be reached/);
    assert.match(outcome.detail, /controller\.example/);
  }
});

// --- the flags, and the addresses the controller answers with ------------------------

test('--controller names where to redeem, its origin only, and wins over both environment paths', async () => {
  const store = new MemoryStore();
  const transport = transportAnswering(200, { hostId: 'ph-1', hostCredential: 'p1.ph-1.s' });
  const env = { ...ENV, PERISCOPE_PAIR_URL: 'https://elsewhere.example/api/periscope/pair' };

  const outcome = await runPair(
    'code',
    env,
    { transport, store: () => store, write: () => {} },
    {
      controller: 'https://c.example:7157/some/path?q=1',
    },
  );

  assert.ok(outcome.ok);
  assert.equal(
    transportAnswering.lastUrl,
    'https://c.example:7157/api/periscope/pair',
    'the flag beats PERISCOPE_PAIR_URL and the decision URL, and only its origin is used',
  );
});

test('regression: a --controller that is not an http(s) URL is refused by name, never sent anywhere', async () => {
  const transport = transportAnswering(200, { hostId: 'ph-1', hostCredential: 'p1.ph-1.s' });
  transportAnswering.lastUrl = '';
  const outcome = await runPair(
    'code',
    ENV,
    { transport, store: () => new MemoryStore(), write: () => {} },
    {
      controller: 'wss://c.example/periscope/link',
    },
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.detail, /not an http\(s\) URL/);
  assert.equal(transportAnswering.lastUrl, '', 'nothing was posted');
});

test('--label wins over PERISCOPE_MACHINE_LABEL, which wins over the hostname', async () => {
  const transport = transportAnswering(200, { hostId: 'ph-1', hostCredential: 'p1.ph-1.s' });
  await runPair(
    'code',
    ENV,
    { transport, store: () => new MemoryStore(), write: () => {} },
    { label: 'named on the command' },
  );
  assert.equal(
    (JSON.parse(transportAnswering.lastBody ?? '{}') as { machineLabel?: string }).machineLabel,
    'named on the command',
  );

  await runPair('code', ENV, { transport, store: () => new MemoryStore(), write: () => {} });
  assert.equal(
    (JSON.parse(transportAnswering.lastBody ?? '{}') as { machineLabel?: string }).machineLabel,
    'the test machine',
    'the environment path is unchanged',
  );
});

test('the addresses the controller answers with are written to the config file beside the credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'periscope-pair-'));
  try {
    const env: NodeJS.ProcessEnv = { PERISCOPE_CONFIG_DIR: dir };
    const lines: string[] = [];
    const transport = transportAnswering(200, {
      hostId: 'ph-1',
      hostCredential: 'p1.ph-1.s',
      controllerUrl: 'wss://c.example:7157/periscope/link',
      decisionUrl: 'https://c.example:7157/periscope/decision',
    });

    const outcome = await runPair(
      'code',
      env,
      { transport, store: () => new MemoryStore(), write: (line) => lines.push(line) },
      {
        controller: 'https://c.example:7157',
      },
    );

    assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail);
    assert.deepEqual(readConfigFile(env).values, {
      PERISCOPE_CONTROLLER_URL: 'wss://c.example:7157/periscope/link',
      PERISCOPE_DECISION_URL: 'https://c.example:7157/periscope/decision',
    });
    assert.ok(lines.some((line) => line.includes('serve needs nothing else')));

    // The control: a controller that names no addresses writes no config and says so, and the
    // credential is still written.
    const bare = new MemoryStore();
    const before = transportAnswering(200, { hostId: 'ph-2', hostCredential: 'p1.ph-2.s' });
    const env2: NodeJS.ProcessEnv = { PERISCOPE_CONFIG_DIR: join(dir, 'bare') };
    const lines2: string[] = [];
    const second = await runPair(
      'code',
      env2,
      { transport: before, store: () => bare, write: (line) => lines2.push(line) },
      {
        controller: 'https://c.example:7157',
      },
    );
    assert.ok(second.ok);
    assert.deepEqual(bare.written, { hostId: 'ph-2', credential: 'p1.ph-2.s' });
    assert.deepEqual(readConfigFile(env2).values, {});
    assert.ok(lines2.some((line) => line.includes('did not name its link and decision URLs')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the environment wins over the written addresses, and the write says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'periscope-pair-'));
  try {
    const env: NodeJS.ProcessEnv = {
      PERISCOPE_CONFIG_DIR: dir,
      PERISCOPE_CONTROLLER_URL: 'wss://from-env.example/link',
    };
    const lines: string[] = [];
    const transport = transportAnswering(200, {
      hostId: 'ph-1',
      hostCredential: 'p1.ph-1.s',
      controllerUrl: 'wss://c.example/periscope/link',
      decisionUrl: 'https://c.example/periscope/decision',
    });
    const outcome = await runPair(
      'code',
      env,
      { transport, store: () => new MemoryStore(), write: (line) => lines.push(line) },
      {
        controller: 'https://c.example',
      },
    );
    assert.ok(outcome.ok);
    assert.equal(
      readConfigFile(env).values['PERISCOPE_CONTROLLER_URL'],
      'wss://c.example/periscope/link',
      'the file holds what was answered',
    );
    assert.ok(
      lines.some((line) => line.includes('PERISCOPE_CONTROLLER_URL is set in the environment')),
      'and the shadowing is said',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
