import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { mergePlugins, parsePluginDirs, pluginDirsProblem, readPluginManifests } from './plugin-dirs.js';

describe('plugin directories', () => {
  let root: string;
  let good: string;
  let nameless: string;
  let broken: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'periscope-plugin-dirs-'));
    good = join(root, 'good');
    mkdirSync(join(good, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(good, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'loop', version: '0.1.0' }),
    );
    nameless = join(root, 'nameless');
    mkdirSync(join(nameless, '.claude-plugin'), { recursive: true });
    writeFileSync(join(nameless, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1' }));
    broken = join(root, 'broken');
    mkdirSync(join(broken, '.claude-plugin'), { recursive: true });
    writeFileSync(join(broken, '.claude-plugin', 'plugin.json'), '{not json');
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('parses the platform path list, trimming and dropping empties, in order', () => {
    assert.deepEqual(parsePluginDirs(null), []);
    assert.deepEqual(parsePluginDirs(''), []);
    assert.deepEqual(parsePluginDirs(` ${good} ${delimiter}${delimiter} ${broken}`), [good, broken]);
  });

  it('accepts a directory with a manifest that names the plugin', () => {
    assert.equal(pluginDirsProblem([good]), null);
    assert.deepEqual(readPluginManifests([good]), [{ name: 'loop', version: '0.1.0', path: good }]);
  });

  it('names the first problem: relative, missing, no manifest, unreadable, nameless', () => {
    assert.match(pluginDirsProblem(['relative/dir']) ?? '', /not an absolute path/);
    assert.match(pluginDirsProblem([join(root, 'absent')]) ?? '', /does not exist/);
    assert.match(pluginDirsProblem([root]) ?? '', /no \.claude-plugin\/plugin\.json/);
    assert.match(pluginDirsProblem([broken]) ?? '', /not valid JSON/);
    assert.match(pluginDirsProblem([nameless]) ?? '', /names no plugin/);
    assert.match(pluginDirsProblem([good, nameless]) ?? '', /names no plugin/);
  });

  it('reports only the manifests it could read', () => {
    assert.deepEqual(readPluginManifests([broken, good, nameless]), [
      { name: 'loop', version: '0.1.0', path: good },
    ]);
    const noVersion = join(root, 'no-version');
    mkdirSync(join(noVersion, '.claude-plugin'), { recursive: true });
    writeFileSync(join(noVersion, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'bare' }));
    assert.deepEqual(readPluginManifests([noVersion]), [{ name: 'bare', version: null, path: noVersion }]);
  });

  it('merges the host directories first, the controller plugins after, one entry per path', () => {
    assert.equal(mergePlugins([], undefined), undefined);
    assert.deepEqual(mergePlugins([], [{ type: 'local', path: 'C:\\c' }]), [
      { type: 'local', path: 'C:\\c' },
    ]);
    assert.deepEqual(mergePlugins([good], undefined), [{ type: 'local', path: good }]);
    assert.deepEqual(
      mergePlugins(
        [good, broken],
        [
          { type: 'local', path: good, skipMcpDiscovery: true },
          { type: 'local', path: 'C:\\c' },
        ],
      ),
      [
        { type: 'local', path: good },
        { type: 'local', path: broken },
        { type: 'local', path: 'C:\\c' },
      ],
    );
  });
});
