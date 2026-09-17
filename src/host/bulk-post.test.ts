import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bulkOriginFor, postBulk } from './bulk-post.js';
import { readMachineFacts } from './machine.js';

// `allowedOrigin` is required, so it joins the shared fixture rather than every call site.
// It matches the `postUrl`s below, so every pre-existing case keeps the answer it always had.
const base = { deliveryId: 'd-1', fromOffset: 0, allowedOrigin: 'https://controller.example' };

test('a relative source path is refused rather than resolved against a cwd', async () => {
  // The controller cannot see this host's working directory, so "relative to it" is meaningless.
  const result = await postBulk({
    ...base,
    filePath: 'relative/transcript.jsonl',
    postUrl: 'https://controller.example/bulk/d-1',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.refusal.reason, 'path-not-absolute');
});

test('an unusable POST target is refused before anything is read', async () => {
  for (const postUrl of ['not a url', '', 'file:///etc/passwd', 'ftp://x/y']) {
    const result = await postBulk({ ...base, filePath: '/tmp/transcript.jsonl', postUrl });
    assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(postUrl)}`);
    if (!result.ok) assert.equal(result.refusal.reason, 'bulk-target-invalid');
  }
});

test('a missing source file fails as a named delivery failure, not an exception', async () => {
  const result = await postBulk({
    ...base,
    filePath: '/definitely/not/here/transcript.jsonl',
    postUrl: 'https://controller.example/bulk/d-1',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.refusal.reason, 'bulk-delivery-failed');
});

test('a delivered receipt carries the file bytes AND the stat pair a rewrite detector needs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'periscope-bulk-'));
  const file = join(dir, 'transcript.jsonl');
  const received: Buffer[] = [];
  const server = createServer((request, response) => {
    request.on('data', (chunk: Buffer) => received.push(chunk));
    request.on('end', () => {
      response.statusCode = 200;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(file, 'line-1\nline-2\n', 'utf8');
    const stats = await stat(file);
    const port = (server.address() as AddressInfo).port;

    const result = await postBulk({
      deliveryId: 'd-stat',
      fromOffset: 7,
      filePath: file,
      postUrl: `http://127.0.0.1:${port}/bulk/d-stat`,
      allowedOrigin: `http://127.0.0.1:${port}`,
    });

    assert.ok(result.ok, result.ok === false ? result.refusal.detail : '');
    assert.equal(
      Buffer.concat(received).toString('utf8'),
      'line-2\n',
      'the offset trims what was already pulled',
    );
    assert.equal(result.value.byteCount, stats.size - 7);
    // The pair describes the WHOLE file, not the slice — that is what a rewrite detector compares.
    assert.equal(result.value.sizeBytes, stats.size);
    assert.equal(result.value.mtimeMs, Math.floor(stats.mtimeMs));
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// The destination is the peer's choice; whether it is reached is not.

test('regression: a postUrl on a foreign origin is refused by name, before a byte or a credential moves', async () => {
  // The exfiltration shape: a well-formed https URL that simply is not this host's controller.
  // It must NOT collapse into `bulk-target-invalid` — a reader has to be able to tell an attempt
  // to redirect a credential apart from a typo.
  const listened: string[] = [];
  const server = createServer((_request, response) => {
    listened.push('a request reached the foreign origin');
    response.statusCode = 200;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await postBulk({
      ...base,
      filePath: '/tmp/transcript.jsonl',
      postUrl: `http://127.0.0.1:${port}/bulk/d-1`,
      allowedOrigin: 'https://controller.example',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.refusal.reason, 'bulk-target-not-controller');
      assert.match(
        result.refusal.detail,
        /controller\.example/,
        'the refusal names the origin it does trust',
      );
    }
    // The property that actually matters: nothing was SENT. A refusal that still made the request
    // would have leaked the credential and then reported a refusal.
    assert.deepEqual(listened, [], 'the foreign origin must never have been contacted at all');
  } finally {
    server.close();
  }
});

test('control: the same delivery to the matching origin still lands', async () => {
  // The discriminator for the test above. Without this pair, a `postBulk` that refused everything
  // would make the foreign-origin case green while proving nothing about the binding.
  const dir = await mkdtemp(join(tmpdir(), 'periscope-bulk-origin-'));
  const file = join(dir, 'transcript.jsonl');
  const received: Buffer[] = [];
  const server = createServer((request, response) => {
    request.on('data', (chunk: Buffer) => received.push(chunk));
    request.on('end', () => {
      response.statusCode = 200;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(file, 'only-line\n', 'utf8');
    const port = (server.address() as AddressInfo).port;

    const result = await postBulk({
      deliveryId: 'd-ok',
      fromOffset: 0,
      filePath: file,
      postUrl: `http://127.0.0.1:${port}/bulk/d-ok`,
      allowedOrigin: `http://127.0.0.1:${port}`, // the one variable, flipped
    });

    assert.ok(result.ok, result.ok === false ? result.refusal.detail : '');
    assert.equal(
      Buffer.concat(received).toString('utf8'),
      'only-line\n',
      'the identical call that the foreign origin refused must DELIVER here, or the pair is not a discriminator',
    );
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a port, a scheme or a host that differs is a different origin — none of them are the controller', async () => {
  for (const postUrl of [
    'https://controller.example.evil.test/bulk/d-1', // suffix, not the host
    'https://controller.example:8443/bulk/d-1', // same host, other port
    'http://controller.example/bulk/d-1', // same host, downgraded scheme
  ]) {
    const result = await postBulk({ ...base, filePath: '/tmp/transcript.jsonl', postUrl });
    assert.equal(result.ok, false, `expected a refusal for ${postUrl}`);
    if (!result.ok) assert.equal(result.refusal.reason, 'bulk-target-not-controller', postUrl);
  }
});

test('the controller origin is DERIVED from the ws link URL, because they are one deployment', () => {
  // `URL.origin` alone would call wss://h:8443 and https://h:8443 different peers, and the host
  // would then refuse every legitimate delivery its own controller asked for.
  for (const [controllerUrl, expected] of [
    ['wss://localhost:8443/periscope/link', 'https://localhost:8443'],
    ['ws://127.0.0.1:5000/periscope/link', 'http://127.0.0.1:5000'],
    ['https://localhost:8443/periscope/link', 'https://localhost:8443'],
  ] as const) {
    const derived = bulkOriginFor(controllerUrl);
    assert.ok(derived.ok, derived.ok === false ? derived.refusal.detail : '');
    assert.equal(derived.value, expected);
  }
});

test('control: a controller URL that is not a URL, or carries an unusable scheme, refuses', () => {
  // Without this the derivation could return a garbage origin and the binding above would compare
  // against it happily.
  for (const bad of ['not a url', '', 'file:///etc/passwd']) {
    const derived = bulkOriginFor(bad);
    assert.equal(derived.ok, false, `expected a refusal for ${JSON.stringify(bad)}`);
    if (!derived.ok) assert.equal(derived.refusal.reason, 'bulk-target-invalid');
  }
});

test('the machine facts resolve, including a home directory', () => {
  const facts = readMachineFacts();
  assert.ok(facts.hostname.length > 0);
  assert.ok(facts.platform.length > 0);
  // On Windows this comes from the USERPROFILE family; keyed on HOME alone it would be empty here.
  assert.ok(facts.homeDir.length > 0, 'home resolution must work on this platform');
  assert.ok(facts.tempDir.length > 0);
});
