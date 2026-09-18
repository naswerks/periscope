/**
 * The discovery door's properties: the jail refuses by name, absence is a value, the listing is
 * paged and honest about totals, and the tail probe handles the rewrite hazard deliberately.
 *
 * The jail cases are the point of this file: every caller-supplied name that could shape a path
 * outside the projects root must refuse `transcript-path-escape` with the failing layer named. The
 * positive control — a legal name resolving and reading — is what keeps those refusals meaningful:
 * a jail that refuses everything would pass every negative case here for the wrong reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TRANSCRIPT_PAGE_SIZE, TRANSCRIPT_WHAT_PREFIX } from '../control/frames.js';
import {
  claudeProjectsRoot,
  claudeTranscriptResolver,
  defaultAgentHome,
  isMatchingUserEntry,
  listTranscripts,
  resolveTranscriptPath,
  tailTranscript,
  transcriptsRootUnder,
} from './claude-transcripts.js';

const userLine = (text: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'periscope-discovery-'));
}

/** Write one transcript and pin its mtime, so newest-first ordering is deterministic. */
async function plant(
  root: string,
  slug: string,
  sessionId: string,
  lines: string[],
  mtimeSeconds: number,
): Promise<void> {
  await mkdir(join(root, slug), { recursive: true });
  const file = join(root, slug, `${sessionId}.jsonl`);
  await writeFile(file, lines.map((line) => `${line}\n`).join(''), 'utf8');
  await utimes(file, mtimeSeconds, mtimeSeconds);
}

// --- the cwd on each row ----------------------------------------------------

test('regression: a backslash home reports the agent home and transcripts root in its own separator', () => {
  assert.equal(defaultAgentHome({ USERPROFILE: 'C:\\Users\\agent' }), 'C:\\Users\\agent\\.claude');
  assert.equal(transcriptsRootUnder('C:\\Users\\agent\\.claude'), 'C:\\Users\\agent\\.claude\\projects');
  assert.equal(defaultAgentHome({ HOME: '/home/agent/' }), '/home/agent/.claude');
  assert.equal(transcriptsRootUnder('/home/agent/.claude'), '/home/agent/.claude/projects');
});

test('the listing carries the cwd the CLI recorded on the transcript, read off its head — null when none', async () => {
  const root = await makeRoot();
  try {
    await plant(
      root,
      'C--src-app',
      'with-cwd',
      [
        JSON.stringify({ type: 'summary', summary: 'a summary line carries no cwd' }),
        JSON.stringify({ type: 'user', cwd: 'C:\\src\\app', message: { role: 'user', content: 'hi' } }),
      ],
      2_000,
    );
    await plant(root, 'slug-b', 'without', [userLine('no cwd anywhere')], 1_000);

    const page = await listTranscripts(root);
    assert.deepEqual(
      page.entries.map((e) => [e.sessionId, e.cwd]),
      [
        ['with-cwd', 'C:\\src\\app'],
        ['without', null],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- the root derivation ----------------------------------------------------

test('the projects root derives from the home directory, and no home means null, never a guess', () => {
  assert.equal(
    claudeProjectsRoot({ USERPROFILE: 'C:\\Users\\someone' }),
    'C:\\Users\\someone\\.claude\\projects',
  );
  assert.equal(claudeProjectsRoot({ HOME: '/home/someone' }), '/home/someone/.claude/projects');
  assert.equal(claudeProjectsRoot({}), null);
});

// --- the jail ---------------------------------------------------------------

test('control: a legal slug and session id resolve inside the root and the file reads', async () => {
  const root = await makeRoot();
  try {
    await plant(root, 'C--Dev-some-project', 'abc-123', [userLine('hello from the door')], 1_000_000);

    const resolved = resolveTranscriptPath(root, 'C--Dev-some-project', 'abc-123');
    assert.ok(resolved.ok, resolved.ok === false ? resolved.refusal.detail : '');
    assert.match(resolved.value, /C--Dev-some-project\/abc-123\.jsonl$/);

    const probed = await tailTranscript(root, 'C--Dev-some-project', 'abc-123', {
      needle: 'hello from the door',
    });
    assert.ok(probed.ok);
    assert.equal(
      probed.value.found,
      true,
      'the planted entry must be findable, or every refusal below is vacuous',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('regression: every name that could shape a path outside the root refuses transcript-path-escape, naming the layer', () => {
  const root = 'C:/jail/projects';
  const cases: { slug: string; id: string; layer: RegExp }[] = [
    { slug: '..', id: 'ok-id', layer: /dot-name layer/ },
    { slug: '.', id: 'ok-id', layer: /dot-name layer/ },
    { slug: 'ok-slug', id: '..', layer: /dot-name layer/ },
    { slug: 'ok-slug', id: '.', layer: /dot-name layer/ },
    { slug: 'a/b', id: 'ok-id', layer: /allowlist layer/ },
    { slug: 'a\\b', id: 'ok-id', layer: /allowlist layer/ },
    { slug: 'ok-slug', id: 'a/../../b', layer: /allowlist layer/ },
    { slug: 'C:/absolute', id: 'ok-id', layer: /allowlist layer/ },
    { slug: '', id: 'ok-id', layer: /allowlist layer/ },
    { slug: 'ok-slug', id: '', layer: /allowlist layer/ },
    { slug: 'has space', id: 'ok-id', layer: /allowlist layer/ },
    { slug: '..\\..', id: 'ok-id', layer: /allowlist layer/ },
  ];
  for (const { slug, id, layer } of cases) {
    const resolved = resolveTranscriptPath(root, slug, id);
    assert.equal(resolved.ok, false, `"${slug}"/"${id}" was not refused`);
    if (!resolved.ok) {
      assert.equal(
        resolved.refusal.reason,
        'transcript-path-escape',
        `"${slug}"/"${id}" refused with the wrong name`,
      );
      assert.match(resolved.refusal.detail, layer, `"${slug}"/"${id}" named the wrong layer`);
    }
  }
});

test('a directory-shaped junction inside the root is skipped by the listing, not followed', async () => {
  // The win32-expressible symlink case: a junction PASSES the name allowlist (its name is just a
  // name), so the listing's own filter is what keeps it out — readdir does not follow it, and a
  // dirent that is a link is not a directory. Junction creation needs no privilege on NTFS.
  const root = await makeRoot();
  const outside = await mkdtemp(join(tmpdir(), 'periscope-outside-'));
  try {
    await plant(root, 'honest-slug', 'session-1', [userLine('inside')], 1_000_000);
    await mkdir(join(outside, 'foreign'), { recursive: true });
    await writeFile(join(outside, 'foreign', 'secret.jsonl'), `${userLine('outside')}\n`, 'utf8');
    try {
      await symlink(join(outside, 'foreign'), join(root, 'linked-slug'), 'junction');
    } catch {
      // A filesystem that refuses junction creation cannot host the attack either.
      return;
    }

    const page = await listTranscripts(root);
    const slugs = page.entries.map((entry) => entry.projectSlug);
    assert.deepEqual(slugs, ['honest-slug'], `the junction was followed: ${slugs.join(', ')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// --- the listing ------------------------------------------------------------

test('a missing projects directory lists as empty — a fresh machine is not an error', async () => {
  const page = await listTranscripts(join(tmpdir(), 'periscope-does-not-exist-anywhere'));
  assert.deepEqual(page, { entries: [], totalCount: 0, nextIndex: null });
});

test('the listing is newest-first, integer-stamped, and only direct-child jsonl files count', async () => {
  const root = await makeRoot();
  try {
    await plant(root, 'slug-a', 'older', [userLine('a')], 1_000);
    await plant(root, 'slug-b', 'newest', [userLine('b')], 3_000);
    await plant(root, 'slug-a', 'middle', [userLine('c')], 2_000);
    // Nested files are the CLI's subagent transcripts — not part of this listing.
    await mkdir(join(root, 'slug-a', 'older', 'subagents'), { recursive: true });
    await writeFile(join(root, 'slug-a', 'older', 'subagents', 'agent-x.jsonl'), 'nested\n', 'utf8');
    // A non-jsonl file beside the transcripts is ignored.
    await writeFile(join(root, 'slug-a', 'notes.txt'), 'not a transcript\n', 'utf8');

    const page = await listTranscripts(root);
    assert.deepEqual(
      page.entries.map((entry) => entry.sessionId),
      ['newest', 'middle', 'older'],
    );
    assert.equal(page.totalCount, 3);
    assert.equal(page.nextIndex, null);
    for (const entry of page.entries) {
      assert.ok(Number.isInteger(entry.mtimeMs), `mtimeMs must be an integer, got ${entry.mtimeMs}`);
      assert.ok(entry.sizeBytes > 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the listing pages: fromIndex chains through nextIndex and the final page ends with null', async () => {
  const root = await makeRoot();
  try {
    for (let i = 0; i < 5; i += 1) {
      await plant(root, 'slug', `session-${i}`, [userLine(`entry ${i}`)], 1_000 + i);
    }

    const first = await listTranscripts(root, { pageSize: 2 });
    assert.equal(first.entries.length, 2);
    assert.equal(first.totalCount, 5);
    assert.equal(first.nextIndex, 2);

    const second = await listTranscripts(root, { fromIndex: first.nextIndex ?? 0, pageSize: 2 });
    assert.equal(second.entries.length, 2);
    assert.equal(second.nextIndex, 4);

    const third = await listTranscripts(root, { fromIndex: second.nextIndex ?? 0, pageSize: 2 });
    assert.equal(third.entries.length, 1);
    assert.equal(third.nextIndex, null, 'the last page must end the listing');

    const together = [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.sessionId);
    assert.equal(new Set(together).size, 5, 'paging must cover every entry exactly once');

    const past = await listTranscripts(root, { fromIndex: 99, pageSize: 2 });
    assert.deepEqual(past.entries, []);
    assert.equal(past.nextIndex, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the default page size is bounded well under the frame cap', () => {
  // The arithmetic half of the bound. An entry is under 300 bytes of JSON, so the page must stay
  // comfortably inside 64 KiB.
  assert.ok(
    TRANSCRIPT_PAGE_SIZE * 300 < 48 * 1024,
    `${TRANSCRIPT_PAGE_SIZE} entries can overrun the frame cap`,
  );
});

// --- the tail probe ---------------------------------------------------------

test('an absent transcript answers absent:true — a value, never a refusal', async () => {
  const root = await makeRoot();
  try {
    const probed = await tailTranscript(root, 'no-such-slug', 'no-such-id', {});
    assert.ok(probed.ok);
    assert.deepEqual(probed.value, {
      absent: true,
      found: false,
      newOffset: 0,
      sizeBytes: null,
      mtimeMs: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a probe from the current size answers not-found without reading, and carries the stat pair', async () => {
  const root = await makeRoot();
  try {
    await plant(root, 'slug', 'id', [userLine('already seen')], 1_000);
    const first = await tailTranscript(root, 'slug', 'id', {});
    assert.ok(first.ok);
    const size = first.value.newOffset;

    const probed = await tailTranscript(root, 'slug', 'id', { fromOffset: size });
    assert.ok(probed.ok);
    assert.equal(probed.value.found, false);
    assert.equal(probed.value.newOffset, size);
    assert.equal(probed.value.sizeBytes, size);
    assert.ok(Number.isInteger(probed.value.mtimeMs));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the needle matches against whitespace-normalized user text, and only user text', async () => {
  const root = await makeRoot();
  try {
    await plant(
      root,
      'slug',
      'id',
      [
        JSON.stringify({ type: 'assistant', message: { content: 'the needle word from the assistant' } }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', content: 'needle in a tool result' }] },
        }),
        userLine('the  needle\n  split   across whitespace'),
      ],
      1_000,
    );

    const wrongLane = await tailTranscript(root, 'slug', 'id', { needle: 'from the assistant' });
    assert.ok(wrongLane.ok);
    assert.equal(wrongLane.value.found, false, 'an assistant line must never satisfy a user probe');

    const toolOnly = await tailTranscript(root, 'slug', 'id', { needle: 'in a tool result' });
    assert.ok(toolOnly.ok);
    assert.equal(toolOnly.value.found, false, 'a tool-result-only user line carries no user text');

    const normalized = await tailTranscript(root, 'slug', 'id', {
      needle: 'the needle split across whitespace',
    });
    assert.ok(normalized.ok);
    assert.equal(normalized.value.found, true, 'whitespace runs must collapse before matching');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('regression: a file shorter than the asked offset was rewritten: the probe rescans from 0', async () => {
  const root = await makeRoot();
  try {
    const padding = userLine(`padding ${'x'.repeat(400)}`);
    await plant(root, 'slug', 'id', [padding, padding, padding], 1_000);
    const before = await tailTranscript(root, 'slug', 'id', {});
    assert.ok(before.ok);
    const oldSize = before.value.newOffset;

    // The CLI compacts: the file is REPLACED by something shorter that still holds the entry.
    await plant(root, 'slug', 'id', [userLine('the surviving entry')], 2_000);

    const probed = await tailTranscript(root, 'slug', 'id', {
      fromOffset: oldSize,
      needle: 'surviving entry',
    });
    assert.ok(probed.ok);
    assert.equal(
      probed.value.found,
      true,
      'a rewrite must trigger a whole-file rescan, or the entry is invisible',
    );
    assert.ok(probed.value.newOffset < oldSize, 'the new offset must describe the rewritten file');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a truncated final line is skipped, never an error — appending mid-line is the normal state', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, 'slug'), { recursive: true });
    await writeFile(
      join(root, 'slug', 'id.jsonl'),
      `${userLine('whole line')}\n{"type":"user","mess`,
      'utf8',
    );

    const probed = await tailTranscript(root, 'slug', 'id', { needle: 'whole line' });
    assert.ok(probed.ok);
    assert.equal(probed.value.found, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- the predicate, directly ------------------------------------------------

test('the user-entry predicate: shapes that count and shapes that never do', () => {
  assert.equal(
    isMatchingUserEntry(userLine('plain text'), null),
    true,
    'any user text satisfies a null needle',
  );
  assert.equal(
    isMatchingUserEntry(JSON.stringify({ type: 'user', message: { content: 'no role stated' } }), null),
    true,
  );
  assert.equal(
    isMatchingUserEntry(
      JSON.stringify({ type: 'user', message: { role: 'assistant', content: 'wrong role' } }),
      null,
    ),
    false,
  );
  assert.equal(
    isMatchingUserEntry(JSON.stringify({ type: 'user', message: { content: '   ' } }), null),
    false,
  );
  assert.equal(isMatchingUserEntry('not json', null), false);
  assert.equal(isMatchingUserEntry(JSON.stringify(['an', 'array']), null), false);
  assert.equal(
    isMatchingUserEntry(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'block one ' },
            { type: 'text', text: 'block two' },
          ],
        },
      }),
      'block one block two',
    ),
    true,
    'text blocks concatenate before matching',
  );
});

// --- the bulk-lane resolver -------------------------------------------------

test('the bulk resolver serves the namespace through the same jail, and nothing else', async () => {
  const root = await makeRoot();
  try {
    await plant(root, 'slug', 'id', [userLine('bulk me')], 1_000);
    const resolve = claudeTranscriptResolver(root);

    const good = resolve(`${TRANSCRIPT_WHAT_PREFIX}slug/id`, 'channel-1');
    assert.ok(good.ok, good.ok === false ? good.refusal.detail : '');
    assert.match(good.value, /slug\/id\.jsonl$/);

    const foreign = resolve('some-other-locator', 'channel-1');
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.refusal.reason, 'bulk-target-invalid');

    const shapeless = resolve(`${TRANSCRIPT_WHAT_PREFIX}only-a-slug`, 'channel-1');
    assert.equal(shapeless.ok, false);
    if (!shapeless.ok) assert.equal(shapeless.refusal.reason, 'bulk-target-invalid');

    const escaping = resolve(`${TRANSCRIPT_WHAT_PREFIX}../secrets`, 'channel-1');
    assert.equal(escaping.ok, false);
    if (!escaping.ok) assert.equal(escaping.refusal.reason, 'transcript-path-escape');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
