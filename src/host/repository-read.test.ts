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
import {
  MAX_REPOSITORY_FILE_BYTES,
  MAX_REPOSITORY_READ_BYTES,
  MAX_WORKSPACE_FILE_BYTES,
} from '../control/frames.js';
import {
  BINARY_PROBE_BYTES,
  listRepositoryDirectory,
  readRepositoryFile,
  readWorkspaceFile,
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
    assert.deepEqual(empty.value, { text: '', sizeBytes: 0, truncated: false, nextOffset: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The head read 1.8.2 made, kept here as the control: a probe of `max(wanted, BINARY_PROBE_BYTES)`
 * bytes, and a step back only over bytes read past the cut, of which there are none once `wanted`
 * reaches the probe's size.
 */
function headAsReleased(bytes: Buffer, wanted: number): string {
  const head = bytes.subarray(0, Math.max(wanted, BINARY_PROBE_BYTES));
  let cut = Math.min(head.length, wanted);
  while (cut > 0 && cut < head.length && (head[cut]! & 0xc0) === 0x80) cut -= 1;
  return head.subarray(0, cut).toString('utf8');
}

test('regression: a head read at the default maxBytes ends on a character boundary when a character straddles the cut', async () => {
  const root = await tempDir('repository');
  try {
    // '漢' is three bytes and starts at byte 49151, so the default cut (49152) falls inside it.
    const bytes = Buffer.concat([
      Buffer.alloc(MAX_REPOSITORY_READ_BYTES - 1, 0x61),
      Buffer.from('漢', 'utf8'),
      Buffer.alloc(16, 0x62),
    ]);
    await writeFile(join(root, 'brief.md'), bytes);

    const head = await readRepositoryFile(root, 'brief.md');
    assert.ok(head.ok);
    assert.equal(
      head.value.text,
      'a'.repeat(MAX_REPOSITORY_READ_BYTES - 1),
      'the page ends before the character',
    );
    assert.deepEqual(
      [head.value.truncated, head.value.nextOffset],
      [true, MAX_REPOSITORY_READ_BYTES - 1],
      'the next page starts on the character',
    );
    const next = await readRepositoryFile(root, 'brief.md', 1024, [], MAX_REPOSITORY_READ_BYTES - 1);
    assert.ok(next.ok);
    assert.equal(next.value.text, `漢${'b'.repeat(16)}`);

    // control: 1.8.2's loop split the character here, ending the page on a replacement character; below
    // the probe's size the two reads agree.
    assert.equal(
      headAsReleased(bytes, MAX_REPOSITORY_READ_BYTES),
      `${'a'.repeat(MAX_REPOSITORY_READ_BYTES - 1)}\uFFFD`,
    );
    const small = Buffer.concat([Buffer.alloc(99, 0x61), Buffer.from('漢', 'utf8')]);
    await writeFile(join(root, 'small.md'), small);
    const smallHead = await readRepositoryFile(root, 'small.md', 100);
    assert.ok(smallHead.ok);
    assert.equal(smallHead.value.text, headAsReleased(small, 100));
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

test('a repository file is read in pages that never split a character: offset 0 is the head, each page says where the next starts, and the last says null', async () => {
  const root = await tempDir('repository');
  try {
    // 'a' (1 byte), 'é' (2 bytes), '漢' (3 bytes), 'b' (1 byte): seven bytes.
    await writeFile(join(root, 'mixed.md'), 'aé漢b', 'utf8');

    const head = await readRepositoryFile(root, 'mixed.md', 2);
    assert.ok(head.ok);
    assert.deepEqual(
      head.value,
      { text: 'a', sizeBytes: 7, truncated: true, nextOffset: 1 },
      'the head steps back off the é, as the head read always did',
    );

    const second = await readRepositoryFile(root, 'mixed.md', 4, [], 1);
    assert.ok(second.ok);
    assert.deepEqual(second.value, { text: 'é', sizeBytes: 7, truncated: true, nextOffset: 3 });

    const third = await readRepositoryFile(root, 'mixed.md', 1, [], 3);
    assert.ok(third.ok);
    assert.deepEqual(
      third.value,
      { text: '漢', sizeBytes: 7, truncated: true, nextOffset: 6 },
      'a page smaller than its first character carries that character whole, so paging makes progress',
    );

    const last = await readRepositoryFile(root, 'mixed.md', 100, [], 6);
    assert.ok(last.ok);
    assert.deepEqual(last.value, { text: 'b', sizeBytes: 7, truncated: false, nextOffset: null });

    // The pages, joined, are the file.
    assert.equal(
      [head, second, third, last].map((page) => (page.ok ? page.value.text : '')).join(''),
      'aé漢b',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an offset past the end or inside a character refuses repository-read-failed by name; the end itself answers an empty last page', async () => {
  const root = await tempDir('repository');
  try {
    await writeFile(join(root, 'mixed.md'), 'aé', 'utf8');
    const inside = await readRepositoryFile(root, 'mixed.md', 10, [], 2);
    assert.ok(!inside.ok);
    assert.equal(inside.refusal.reason, 'repository-read-failed');
    assert.match(inside.refusal.detail, /inside a character/);

    const past = await readRepositoryFile(root, 'mixed.md', 10, [], 9);
    assert.ok(!past.ok);
    assert.equal(past.refusal.reason, 'repository-read-failed');
    assert.match(past.refusal.detail, /past the end of the file \(3 bytes\)/);

    // control: the end itself is a valid offset and answers an empty last page.
    const atEnd = await readRepositoryFile(root, 'mixed.md', 10, [], 3);
    assert.ok(atEnd.ok);
    assert.deepEqual(atEnd.value, { text: '', sizeBytes: 3, truncated: false, nextOffset: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the head of a file past the bound is served at offset 0; pages stop at the bound, and an offset past it is refused by name', async () => {
  const root = await tempDir('repository');
  try {
    const size = MAX_REPOSITORY_FILE_BYTES + 100;
    await writeFile(join(root, 'large.txt'), 'x'.repeat(size), 'utf8');

    const head = await readRepositoryFile(root, 'large.txt');
    assert.ok(head.ok, 'a file of any size has a head');
    assert.equal(head.value.text.length, MAX_REPOSITORY_READ_BYTES);
    assert.deepEqual(
      [head.value.sizeBytes, head.value.truncated, head.value.nextOffset],
      [size, true, MAX_REPOSITORY_READ_BYTES],
    );

    // A page that reaches the bound ends there: no next page, and the bytes past it remain.
    const atBound = await readRepositoryFile(root, 'large.txt', 1000, [], MAX_REPOSITORY_FILE_BYTES - 10);
    assert.ok(atBound.ok);
    assert.deepEqual(
      [atBound.value.text.length, atBound.value.truncated, atBound.value.nextOffset],
      [10, true, null],
    );

    const bound = await readRepositoryFile(root, 'large.txt', 1000, [], MAX_REPOSITORY_FILE_BYTES);
    assert.ok(bound.ok);
    assert.deepEqual(bound.value, { text: '', sizeBytes: size, truncated: true, nextOffset: null });

    const past = await readRepositoryFile(root, 'large.txt', 1000, [], MAX_REPOSITORY_FILE_BYTES + 1);
    assert.ok(!past.ok);
    assert.equal(past.refusal.reason, 'repository-read-failed');
    assert.match(past.refusal.detail, new RegExp(`past the ${MAX_REPOSITORY_FILE_BYTES} bytes`));

    // control: a file under the bound pages to its end, and the last page says null there.
    await writeFile(join(root, 'small.txt'), 'y'.repeat(MAX_REPOSITORY_READ_BYTES + 5), 'utf8');
    const tail = await readRepositoryFile(
      root,
      'small.txt',
      MAX_REPOSITORY_READ_BYTES,
      [],
      MAX_REPOSITORY_READ_BYTES,
    );
    assert.ok(tail.ok);
    assert.deepEqual([tail.value.text, tail.value.truncated, tail.value.nextOffset], ['yyyyy', false, null]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the head of a file whose first byte continues no character is served, decoded as the head read always decoded it', async () => {
  const root = await tempDir('repository');
  try {
    // Text in a single-byte encoding: a curly quote (0x93 in Windows-1252) leads the file.
    const bytes = Buffer.from([0x93, 0x61, 0x62, 0x63]);
    await writeFile(join(root, 'quoted.txt'), bytes);
    const head = await readRepositoryFile(root, 'quoted.txt');
    assert.ok(head.ok, head.ok ? '' : head.refusal.detail);
    assert.deepEqual(
      head.value,
      { text: bytes.toString('utf8'), sizeBytes: 4, truncated: false, nextOffset: null },
      'the stray byte decoded as a replacement character, never refused as inside a character',
    );
    const workspaceHead = await readWorkspaceFile(root, 'quoted.txt');
    assert.ok(workspaceHead.ok, workspaceHead.ok ? '' : workspaceHead.refusal.detail);
    assert.equal(workspaceHead.value.text, bytes.toString('utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('regression: walking a file that is not UTF-8 by nextOffset never refuses, and the pages cover every byte once', async () => {
  const root = await tempDir('repository');
  try {
    // A lead byte that claims three bytes, then more continuation bytes than any lead claims, a
    // stray continuation byte after an ASCII one, and a lead byte the file ends inside.
    const bytes = Buffer.from([0xe9, 0xa9, 0xa9, 0xa9, 0xa9, 0xa9, 0x41, 0xa9, 0x42, 0xc3]);
    await writeFile(join(root, 'latin.txt'), bytes);
    for (const maxBytes of [1, 2, 3, 5]) {
      const ends: number[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = await readRepositoryFile(root, 'latin.txt', maxBytes, [], offset);
        assert.ok(page.ok, `maxBytes ${maxBytes}, offset ${offset}: ${page.ok ? '' : page.refusal.detail}`);
        offset = page.value.nextOffset;
        ends.push(offset ?? bytes.length);
        assert.ok(ends.length <= bytes.length, 'the walk does not end');
      }
      assert.equal(
        ends.at(-1),
        bytes.length,
        `maxBytes ${maxBytes} stops before the end: ${ends.join(', ')}`,
      );
      assert.deepEqual(
        ends,
        [...ends].sort((a, b) => a - b),
        `maxBytes ${maxBytes} moves backwards: ${ends.join(', ')}`,
      );

      // The workspace read walks the same file the same way.
      const workspaceEnds: number[] = [];
      let at: number | null = 0;
      while (at !== null) {
        const page = await readWorkspaceFile(root, 'latin.txt', at, maxBytes);
        assert.ok(
          page.ok,
          `workspace maxBytes ${maxBytes}, offset ${at}: ${page.ok ? '' : page.refusal.detail}`,
        );
        at = page.value.nextOffset;
        workspaceEnds.push(at ?? bytes.length);
      }
      assert.deepEqual(workspaceEnds, ends);
    }

    // control: a start a lead byte claims is still inside a character, and refused.
    const inside = await readRepositoryFile(root, 'latin.txt', 3, [], 1);
    assert.ok(!inside.ok);
    assert.match(inside.refusal.detail, /inside a character/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the transcript folders: a path at or beneath one refuses transcripts-not-served whatever the root, read and list, and a listing leaves the folder out', async () => {
  const home = await tempDir('agent-home');
  try {
    const projects = join(home, 'projects');
    await mkdir(join(projects, 'C--work-repo'), { recursive: true });
    await writeFile(join(projects, 'C--work-repo', 'session-1.jsonl'), '{"type":"user"}\n', 'utf8');
    await writeFile(join(home, 'settings.json'), '{}\n', 'utf8');
    const fence = [projects];

    const read = await readRepositoryFile(
      home,
      'projects/C--work-repo/session-1.jsonl',
      undefined,
      [],
      0,
      fence,
    );
    assert.ok(!read.ok);
    assert.equal(read.refusal.reason, 'transcripts-not-served');
    assert.match(read.refusal.detail, /transcript files/);

    const listed = await listRepositoryDirectory(home, 'projects/C--work-repo', undefined, [], fence);
    assert.ok(!listed.ok);
    assert.equal(listed.refusal.reason, 'transcripts-not-served');

    // The folder spelled in another case is the same folder on a filesystem that folds case.
    const upper = await readRepositoryFile(home, 'projects/C--work-repo/session-1.jsonl', undefined, [], 0, [
      normalizePath(projects).toUpperCase(),
    ]);
    assert.ok(!upper.ok);
    assert.equal(upper.refusal.reason, 'transcripts-not-served');

    const top = await listRepositoryDirectory(home, '', undefined, [], fence);
    assert.ok(top.ok);
    assert.deepEqual(
      top.value.entries.map((entry) => entry.name),
      ['settings.json'],
      'the agent home is listed, without its transcript folder',
    );

    const workspace = await readWorkspaceFile(
      home,
      'projects/C--work-repo/session-1.jsonl',
      0,
      100,
      [],
      fence,
    );
    assert.ok(!workspace.ok);
    assert.equal(workspace.refusal.reason, 'transcripts-not-served');

    // Control: without the fence the same reads are served, and beside it nothing changes.
    const unfenced = await readRepositoryFile(home, 'projects/C--work-repo/session-1.jsonl');
    assert.ok(unfenced.ok);
    const beside = await readRepositoryFile(home, 'settings.json', undefined, [], 0, fence);
    assert.ok(beside.ok);
    assert.equal(beside.value.text, '{}\n');
    const neighbour = await listRepositoryDirectory(home, '', undefined, [], [`${projects}-old`]);
    assert.ok(neighbour.ok);
    assert.ok(
      neighbour.value.entries.some((entry) => entry.name === 'projects'),
      'a segment-wise neighbour fences nothing',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the transcript folders are checked on the real path too: a link into one is refused by name', async () => {
  const home = await tempDir('agent-home');
  try {
    const projects = join(home, 'projects');
    await mkdir(join(projects, 'C--work-repo'), { recursive: true });
    await writeFile(join(projects, 'C--work-repo', 'session-1.jsonl'), '{"type":"user"}\n', 'utf8');
    // A link inside a home used as a root, whose lexical resolution is innocent and whose real path is
    // the transcript folder.
    const inside = join(home, 'linked');
    try {
      await symlink(projects, inside, 'junction');
    } catch {
      // A filesystem that refuses link creation cannot host the attack either.
      return;
    }
    const through = await readRepositoryFile(home, 'linked/C--work-repo/session-1.jsonl', undefined, [], 0, [
      projects,
    ]);
    assert.ok(!through.ok);
    assert.equal(through.refusal.reason, 'transcripts-not-served');

    // The folder spelled through the link names the same folder.
    const spelled = await readRepositoryFile(
      home,
      'projects/C--work-repo/session-1.jsonl',
      undefined,
      [],
      0,
      [inside],
    );
    assert.ok(!spelled.ok);
    assert.equal(spelled.refusal.reason, 'transcripts-not-served');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The workspace read: the same jail over a workspace's directory, read in pages.
// ---------------------------------------------------------------------------

test('a workspace file is read in pages that never split a character, and the last page says so', async () => {
  const root = await tempDir('workspace');
  try {
    // 'a' (1 byte), 'é' (2 bytes), '漢' (3 bytes), 'b' (1 byte): seven bytes.
    await writeFile(join(root, 'mixed.md'), 'aé漢b', 'utf8');

    const first = await readWorkspaceFile(root, 'mixed.md', 0, 2);
    assert.ok(first.ok);
    assert.deepEqual(first.value, { text: 'a', sizeBytes: 7, nextOffset: 1 }, 'the cut steps back off the é');

    const second = await readWorkspaceFile(root, 'mixed.md', 1, 4);
    assert.ok(second.ok);
    assert.deepEqual(second.value, { text: 'é', sizeBytes: 7, nextOffset: 3 });

    const third = await readWorkspaceFile(root, 'mixed.md', 3, 1);
    assert.ok(third.ok);
    assert.deepEqual(
      third.value,
      { text: '漢', sizeBytes: 7, nextOffset: 6 },
      'a page smaller than its first character carries that character whole, so paging makes progress',
    );

    const last = await readWorkspaceFile(root, 'mixed.md', 6, 100);
    assert.ok(last.ok);
    assert.deepEqual(last.value, { text: 'b', sizeBytes: 7, nextOffset: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an offset inside a character or past the end refuses workspace-read-failed by name', async () => {
  const root = await tempDir('workspace');
  try {
    await writeFile(join(root, 'mixed.md'), 'aé', 'utf8');
    const inside = await readWorkspaceFile(root, 'mixed.md', 2, 10);
    assert.ok(!inside.ok);
    assert.equal(inside.refusal.reason, 'workspace-read-failed');
    assert.match(inside.refusal.detail, /inside a character/);

    const past = await readWorkspaceFile(root, 'mixed.md', 9, 10);
    assert.ok(!past.ok);
    assert.match(past.refusal.detail, /past the end/);

    // control: the end itself is a valid offset and answers an empty last page.
    const atEnd = await readWorkspaceFile(root, 'mixed.md', 3, 10);
    assert.ok(atEnd.ok);
    assert.deepEqual(atEnd.value, { text: '', sizeBytes: 3, nextOffset: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a file larger than the workspace read serves, or a binary one, is refused rather than paged', async () => {
  const root = await tempDir('workspace');
  try {
    await writeFile(join(root, 'large.txt'), 'x'.repeat(MAX_WORKSPACE_FILE_BYTES + 1), 'utf8');
    await writeFile(join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]));

    const large = await readWorkspaceFile(root, 'large.txt');
    assert.ok(!large.ok);
    assert.equal(large.refusal.reason, 'workspace-read-failed');
    assert.match(large.refusal.detail, /serves files up to/);

    const binary = await readWorkspaceFile(root, 'image.bin');
    assert.ok(!binary.ok);
    assert.match(binary.refusal.detail, /NUL byte/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the workspace read's jail and protected set: a climb refuses workspace-path-escape, a protected path refuses in any case", async () => {
  const root = await tempDir('workspace');
  try {
    await mkdir(join(root, 'secrets'), { recursive: true });
    await writeFile(join(root, 'secrets', 'token.json'), '{}', 'utf8');

    const climbed = await readWorkspaceFile(root, '../outside.md');
    assert.ok(!climbed.ok);
    assert.equal(climbed.refusal.reason, 'workspace-path-escape');

    const upper = normalizePath(join(root, 'SECRETS'));
    const denied = await readWorkspaceFile(root, 'secrets/token.json', 0, 100, [upper]);
    assert.ok(!denied.ok);
    assert.equal(denied.refusal.reason, 'credential-path-denied', 'the protected set folds case');

    // The lexical check folds case too, so a path beneath a protected directory spelled in another case
    // is refused by name before the filesystem is asked whether anything is there: the answer says
    // nothing about what the protected directory holds.
    const absent = await readWorkspaceFile(root, 'secrets/absent.json', 0, 100, [upper]);
    assert.ok(!absent.ok);
    assert.equal(absent.refusal.reason, 'credential-path-denied');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
