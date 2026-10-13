/**
 * The publish gate's changelog check reads the heading this changelog writes, `## [Unreleased]`, as
 * well as `## Unreleased`: a non-empty Unreleased section, or a section for the version, is ready.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

type ChangelogReady = (changelog: string, version: string) => boolean;

const load = async (): Promise<ChangelogReady> => {
  const path = fileURLToPath(new URL('../../scripts/changelog-heading.mjs', import.meta.url));
  const loaded = (await import(pathToFileURL(path).href)) as { changelogReady: ChangelogReady };
  return loaded.changelogReady;
};

test('control: a non-empty bracketed Unreleased section with no version heading is ready', async () => {
  const ready = await load();
  assert.equal(
    ready('# Changelog\n\n## [Unreleased]\n\n- Added: a thing.\n\n## [1.6.0] - 2026-10-11\n', '1.7.0'),
    true,
  );
  assert.equal(ready('# Changelog\n\n## Unreleased\n\n- Added: a thing.\n', '1.7.0'), true);
});

test('a changelog with neither an Unreleased section nor the version is not ready, and an empty Unreleased is not either', async () => {
  const ready = await load();
  assert.equal(ready('# Changelog\n\n## [1.6.0] - 2026-10-11\n\n- Added: a thing.\n', '1.7.0'), false);
  assert.equal(ready('# Changelog\n\n## [Unreleased]\n\n## [1.6.0] - 2026-10-11\n', '1.7.0'), false);
});

test("a section for the release's own version is ready", async () => {
  const ready = await load();
  assert.equal(ready('# Changelog\n\n## [1.7.0] - 2026-10-13\n\n- Added: a thing.\n', '1.7.0'), true);
});
