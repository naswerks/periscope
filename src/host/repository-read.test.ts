/**
 * The repository read: the jail, the bounds and the text-only rule, over a real temp directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tempDir } from '../test-support/temp-dir.js';
import { isContainedBy, normalizePath } from '../core/paths.js';
import { nodePathResolver } from './paths.js';
import { MAX_REPOSITORY_READ_BYTES } from '../control/frames.js';
import {
  BINARY_PROBE_BYTES,
  listRepositoryDirectory,
  readRepositoryFile,
  resolveRepositoryPath,
} from './repository-read.js';

async function plantRepository(): Promise<string> {
  const root = await tempDir('repository');
  await mkdir(join(root, 'docs', 'guides', 'topic'), { recursive: true });
  await writeFile(join(root, 'docs', 'guides', 'topic', '00-intro.md'), '# The intro\n\nsome text\n', 'utf8');
  await writeFile(join(root, 'docs', 'guides', 'topic', '01-setup.md'), '# Setup\n', 'utf8');
  await writeFile(join(root, 'README.md'), 'read me\n', 'utf8');
  await writeFile(join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  return root;
}

test('the listing names files and directories under the root, sorted, and the root itself by an empty path', async () => {
  const root = await plantRepository();
  try {
    const top = await listRepositoryDirectory(root, '');
    assert.ok(top.ok);
    assert.deepEqual(
      top.value.entries.map((entry) => [entry.name, entry.directory]),
      [
        ['README.md', false],
        ['docs', true],
        ['image.bin', false],
      ],
    );
    assert.equal(top.value.truncated, false);
    const readme = top.value.entries.find((entry) => entry.name === 'README.md');
    assert.equal(readme?.sizeBytes, 8);
    assert.ok((readme?.mtimeMs ?? 0) > 0);

    const nested = await listRepositoryDirectory(root, 'docs/guides/topic');
    assert.ok(nested.ok);
    assert.deepEqual(
      nested.value.entries.map((entry) => entry.name),
      ['00-intro.md', '01-setup.md'],
    );

    const backslashes = await listRepositoryDirectory(root, 'docs\\guides');
    assert.ok(backslashes.ok, 'a path with the other separator resolves the same directory');
    assert.deepEqual(
      backslashes.value.entries.map((entry) => entry.name),
      ['topic'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the listing stops at the cap and says so', async () => {
  const root = await plantRepository();
  try {
    const listed = await listRepositoryDirectory(root, 'docs/guides/topic', 1);
    assert.ok(listed.ok);
    assert.deepEqual(
      listed.value.entries.map((entry) => entry.name),
      ['00-intro.md'],
    );
    assert.equal(listed.value.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a path that is not a directory, or nothing at all, refuses repository-read-failed by name', async () => {
  const root = await plantRepository();
  try {
    const file = await listRepositoryDirectory(root, 'README.md');
    assert.ok(!file.ok);
    assert.equal(file.refusal.reason, 'repository-read-failed');
    assert.match(file.refusal.detail, /could not be listed as a directory/);

    const absent = await listRepositoryDirectory(root, 'docs/nowhere');
    assert.ok(!absent.ok);
    assert.equal(absent.refusal.reason, 'repository-read-failed');
    assert.match(absent.refusal.detail, /nothing is at that path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the read carries the head of a text file, cut at maxBytes on a character boundary, with the whole size', async () => {
  const root = await plantRepository();
  try {
    const whole = await readRepositoryFile(root, 'docs/guides/topic/00-intro.md');
    assert.ok(whole.ok);
    assert.equal(whole.value.text, '# The intro\n\nsome text\n');
    assert.equal(whole.value.sizeBytes, 23);
    assert.equal(whole.value.truncated, false);

    const head = await readRepositoryFile(root, 'docs/guides/topic/00-intro.md', 5);
    assert.ok(head.ok);
    assert.equal(head.value.text, '# The');
    assert.equal(head.value.sizeBytes, 23);
    assert.equal(head.value.truncated, true);

    // A two-byte character straddling the cut is dropped whole rather than split into a replacement.
    await writeFile(join(root, 'accent.md'), 'caf\u00e9!', 'utf8');
    const straddled = await readRepositoryFile(root, 'accent.md', 4);
    assert.ok(straddled.ok);
    assert.equal(straddled.value.text, 'caf');
    assert.equal(straddled.value.truncated, true);

    const empty = await writeFile(join(root, 'empty.md'), '', 'utf8').then(() =>
      readRepositoryFile(root, 'empty.md'),
    );
    assert.ok(empty.ok);
    assert.deepEqual(empty.value, { text: '', sizeBytes: 0, truncated: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('maxBytes is clamped to the wire bound, so an over-large ask reads exactly the cap', async () => {
  const root = await plantRepository();
  try {
    await writeFile(join(root, 'long.txt'), 'x'.repeat(MAX_REPOSITORY_READ_BYTES + 10), 'utf8');
    const read = await readRepositoryFile(root, 'long.txt', MAX_REPOSITORY_READ_BYTES * 4);
    assert.ok(read.ok);
    assert.equal(read.value.text.length, MAX_REPOSITORY_READ_BYTES);
    assert.equal(read.value.truncated, true);
    assert.equal(read.value.sizeBytes, MAX_REPOSITORY_READ_BYTES + 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a file with a NUL byte in its head is refused as binary; one with a NUL past the probe is served as text', async () => {
  const root = await plantRepository();
  try {
    const binary = await readRepositoryFile(root, 'image.bin');
    assert.ok(!binary.ok);
    assert.equal(binary.refusal.reason, 'repository-read-failed');
    assert.match(binary.refusal.detail, /NUL byte/);

    // control: the probe is bounded, so a NUL beyond it does not make a long text file binary.
    await writeFile(
      join(root, 'late-nul.txt'),
      Buffer.concat([Buffer.alloc(BINARY_PROBE_BYTES, 0x61), Buffer.from([0])]),
    );
    const late = await readRepositoryFile(root, 'late-nul.txt', 16);
    assert.ok(late.ok);
    assert.equal(late.value.text, 'a'.repeat(16));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a directory or an absent path is refused by name on the read', async () => {
  const root = await plantRepository();
  try {
    const directory = await readRepositoryFile(root, 'docs');
    assert.ok(!directory.ok);
    assert.equal(directory.refusal.reason, 'repository-read-failed');
    assert.match(directory.refusal.detail, /not a file/);

    const absent = await readRepositoryFile(root, 'nope.md');
    assert.ok(!absent.ok);
    assert.equal(absent.refusal.reason, 'repository-read-failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the lexical jail: a path that climbs out, an absolute path, or a NUL byte refuses repository-path-escape', () => {
  // A relative root resolves against the cwd on either platform; the assertions are about containment, not the prefix.
  const root = normalizePath(nodePathResolver('checkout'));
  assert.equal(resolveRepositoryPath(root, '').ok, true, 'the empty path is the root');
  assert.equal(
    resolveRepositoryPath(root, 'docs/../README.md').ok,
    true,
    'a climb that stays inside is fine',
  );
  for (const escape of ['..', '../sibling', 'docs/../../etc/passwd', 'a\0b']) {
    const resolved = resolveRepositoryPath(root, escape);
    assert.ok(!resolved.ok, `${JSON.stringify(escape)} must refuse`);
    assert.equal(resolved.refusal.reason, 'repository-path-escape');
  }
  // An absolute path joins under the root rather than replacing it; wherever it lands, it is inside.
  const absolute = resolveRepositoryPath(root, '/etc/passwd');
  assert.ok(absolute.ok);
  assert.ok(isContainedBy(absolute.value, root), `${absolute.value} must sit under ${root}`);
  assert.notEqual(absolute.value, root);
});

test('the physical jail: a link planted inside the root that leads outside it is refused, never followed', async () => {
  const root = await plantRepository();
  const outside = await tempDir('repository-outside');
  try {
    await writeFile(join(outside, 'secret.md'), 'secret\n', 'utf8');
    await mkdir(join(outside, 'secrets'), { recursive: true });
    try {
      await symlink(join(outside, 'secrets'), join(root, 'linked'), 'junction');
      await symlink(join(outside, 'secret.md'), join(root, 'linked.md'), 'file');
    } catch {
      // A filesystem that refuses link creation cannot host the attack either.
      return;
    }

    const listed = await listRepositoryDirectory(root, 'linked');
    assert.ok(!listed.ok);
    assert.equal(listed.refusal.reason, 'repository-path-escape');
    assert.match(listed.refusal.detail, /through a link/);

    const read = await readRepositoryFile(root, 'linked.md');
    assert.ok(!read.ok);
    assert.equal(read.refusal.reason, 'repository-path-escape');

    // And the root listing does not present the links as entries to follow.
    const top = await listRepositoryDirectory(root, '');
    assert.ok(top.ok);
    assert.ok(
      !top.value.entries.some((entry) => entry.name.startsWith('linked')),
      'links are left out of the listing',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('the protected set: a path at or beneath a protected path refuses credential-path-denied whatever the root is', async () => {
  const root = await plantRepository();
  try {
    // The root itself is re-pointed at a directory that holds credential material.
    const secrets = join(root, 'docs', 'guides');
    const listed = await listRepositoryDirectory(root, 'docs/guides/topic', undefined, [secrets]);
    assert.ok(!listed.ok);
    assert.equal(listed.refusal.reason, 'credential-path-denied');
    assert.match(listed.refusal.detail, /protected set/);

    const read = await readRepositoryFile(root, 'docs/guides/topic/00-intro.md', undefined, [secrets]);
    assert.ok(!read.ok);
    assert.equal(read.refusal.reason, 'credential-path-denied');

    // A sibling outside the protected path is unaffected, and a segment-wise neighbour is not covered.
    const sibling = await readRepositoryFile(root, 'README.md', undefined, [secrets]);
    assert.ok(sibling.ok);
    const neighbour = await listRepositoryDirectory(root, 'docs', undefined, [`${secrets}-notes`]);
    assert.ok(neighbour.ok);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the protected set is checked on the real path too: a link into a protected directory is refused by name', async () => {
  const root = await plantRepository();
  try {
    // A credential directory INSIDE the root (the shape of a home directory used as a root), and a
    // link beside it whose lexical resolution is innocent and whose real path is not.
    const creds = join(root, 'creds');
    await mkdir(creds, { recursive: true });
    await writeFile(join(creds, 'token-cache.json'), '{}\n', 'utf8');
    try {
      await symlink(creds, join(root, 'linked'), 'junction');
    } catch {
      // A filesystem that refuses link creation cannot host the attack either.
      return;
    }
    const direct = await readRepositoryFile(root, 'creds/token-cache.json', undefined, [creds]);
    assert.ok(!direct.ok);
    assert.equal(direct.refusal.reason, 'credential-path-denied');

    const through = await readRepositoryFile(root, 'linked/token-cache.json', undefined, [creds]);
    assert.ok(!through.ok);
    assert.equal(through.refusal.reason, 'credential-path-denied');

    // regression: the protected path spelled through a link (or any component the filesystem
    // rewrites) names the same directory, so the real-path check resolves both sides before it
    // compares them; a direct read of the credential file is refused whichever spelling the set holds.
    const spelledThroughLink = await readRepositoryFile(root, 'creds/token-cache.json', undefined, [
      join(root, 'linked'),
    ]);
    assert.ok(!spelledThroughLink.ok);
    assert.equal(spelledThroughLink.refusal.reason, 'credential-path-denied');

    // Control: without the protected set the same link is inside the root and is served.
    const unprotected = await readRepositoryFile(root, 'linked/token-cache.json');
    assert.ok(unprotected.ok);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
