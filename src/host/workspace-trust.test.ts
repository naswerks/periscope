/**
 * The trust read, against fixture config files.
 *
 * Fixtures rather than the real `~/.claude.json`: a test that read the developer's own config would
 * pass or fail on which directories they happen to have opened, and this package must never write
 * to that file at all.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

import { isUntrustedWorkspaceWarning, readWorkspaceTrust, trustConfigPath } from './workspace-trust.js';

function withConfig(contents: string, run: (path: string) => void): void {
  const dir = mkdtempSync(`${tmpdir()}/periscope-trust-`);
  const path = `${dir}/.claude.json`;
  writeFileSync(path, contents, 'utf8');
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a directory recorded as accepted reads as trusted', () => {
  withConfig(JSON.stringify({ projects: { 'C:\\work\\repo': { hasTrustDialogAccepted: true } } }), (path) => {
    assert.equal(readWorkspaceTrust(path, 'C:\\work\\repo'), 'trusted');
  });
});

test('a directory recorded as NOT accepted reads as untrusted', () => {
  withConfig(
    JSON.stringify({ projects: { 'C:\\work\\repo': { hasTrustDialogAccepted: false } } }),
    (path) => {
      assert.equal(readWorkspaceTrust(path, 'C:\\work\\repo'), 'untrusted');
    },
  );
});

test('a freshly provisioned directory is absent from the config, and that reads as untrusted', () => {
  withConfig(
    JSON.stringify({ projects: { 'C:\\somewhere\\else': { hasTrustDialogAccepted: true } } }),
    (path) => {
      // This is the case the host actually creates: it makes a directory nobody has ever opened, so
      // permission rules in any settings file there are void from the first message.
      assert.equal(readWorkspaceTrust(path, 'C:\\work\\brand-new'), 'untrusted');
    },
  );
});

test('separators and drive-letter casing are the same directory, not two', () => {
  withConfig(JSON.stringify({ projects: { 'C:\\Work\\Repo': { hasTrustDialogAccepted: true } } }), (path) => {
    assert.equal(readWorkspaceTrust(path, 'c:/Work/Repo'), 'trusted');
    assert.equal(readWorkspaceTrust(path, 'C:\\work\\repo\\'), 'trusted');
  });
});

test('unknown is a third answer: a config that cannot be read supports no claim either way', () => {
  assert.equal(
    readWorkspaceTrust('C:/definitely/not/here/.claude.json', 'C:/work'),
    'unknown',
    'a missing config must not be reported as an observation about the user’s machine',
  );
  withConfig('{ this is not json', (path) => {
    assert.equal(readWorkspaceTrust(path, 'C:/work'), 'unknown');
  });
  withConfig(JSON.stringify({ noProjectsKey: true }), (path) => {
    assert.equal(readWorkspaceTrust(path, 'C:/work'), 'unknown');
  });
});

test('the config path is derived from home and is never written', () => {
  assert.equal(trustConfigPath('C:\\Users\\dev'), 'C:/Users/dev/.claude.json');
  assert.equal(trustConfigPath('/home/dev'), '/home/dev/.claude.json');
});

test('the stderr matcher fires on the real line and not on ordinary output', () => {
  // The CLI owns the exact wording, so the matcher deliberately keys on the stable clause.
  assert.equal(
    isUntrustedWorkspaceWarning(
      'Ignoring 1 permissions.allow entry because this workspace has not been trusted',
    ),
    true,
  );
  assert.equal(
    isUntrustedWorkspaceWarning('Ignoring 4 permissions.deny entries — this workspace has not been trusted.'),
    true,
    'a different rule count and punctuation must still trip it',
  );
  // The positive control's other half: a matcher that fires on everything is as useless as one
  // that never fires.
  assert.equal(isUntrustedWorkspaceWarning('MCP server "x" failed to connect'), false);
  assert.equal(isUntrustedWorkspaceWarning('warning: trusted publisher check skipped'), false);
});
