import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBranchList, parseBranchTips, parseWorktreePorcelain } from './worktree-porcelain.js';

const PORCELAIN = [
  'worktree C:/Dev/repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree C:/Dev/repo-workspaces/session-150',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/repo/session-150',
  '',
  'worktree C:/Dev/repo-workspaces/solo-abc',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
  'worktree C:/Dev/repo-workspaces/feature-34',
  'HEAD 4444444444444444444444444444444444444444',
  'branch refs/heads/repo/feature-34',
  'locked keep me',
  'prunable gitdir file points to non-existent location',
  '',
  'worktree C:/Dev/repo.git',
  'bare',
  'unknownattribute with a value',
  '',
].join('\n');

test('parseWorktreePorcelain reads every record kind: branch, detached, locked, prunable, bare', () => {
  const worktrees = parseWorktreePorcelain(PORCELAIN);
  assert.equal(worktrees.length, 5);
  assert.deepEqual(worktrees[0], {
    path: 'C:/Dev/repo',
    head: '1111111111111111111111111111111111111111',
    branch: 'main',
    detached: false,
    locked: false,
    prunable: false,
    bare: false,
  });
  assert.equal(worktrees[1]?.branch, 'repo/session-150', 'refs/heads/ is stripped');
  assert.deepEqual(
    [worktrees[2]?.branch, worktrees[2]?.detached],
    [null, true],
    'a detached worktree has no branch and says so',
  );
  assert.deepEqual(
    [worktrees[3]?.locked, worktrees[3]?.prunable],
    [true, true],
    'reasons after the flag are ignored',
  );
  assert.equal(worktrees[4]?.bare, true, 'a bare entry is carried and an unknown attribute is not fatal');
});

test('control: each flag is read from its own record only, so the parser discriminates rather than accumulates', () => {
  // The same list with the flags on different records: a parser that leaked state between blocks
  // would mark the first entry with the second's flags.
  const worktrees = parseWorktreePorcelain(PORCELAIN);
  assert.equal(worktrees[0]?.detached, false);
  assert.equal(worktrees[0]?.locked, false);
  assert.equal(worktrees[1]?.locked, false);
  assert.equal(parseWorktreePorcelain('').length, 0, 'no output is no worktrees');
  assert.equal(
    parseWorktreePorcelain('worktree /x\r\nHEAD abc\r\n\r\n')[0]?.head,
    'abc',
    'CRLF output parses too',
  );
});

test('parseBranchTips maps each branch to its tip date, and parseBranchList reads the merged set', () => {
  const tips = parseBranchTips(
    [
      'main\t2026-09-01T10:00:00+00:00',
      'repo/session-150\t2026-09-09T08:30:00+00:00',
      '',
      'broken-line',
    ].join('\n'),
  );
  assert.deepEqual(
    [...tips.entries()],
    [
      ['main', '2026-09-01T10:00:00+00:00'],
      ['repo/session-150', '2026-09-09T08:30:00+00:00'],
    ],
  );
  const merged = parseBranchList(['* main', '  repo/session-150', '+ repo/feature-34', ''].join('\n'));
  assert.deepEqual(
    [...merged],
    ['main', 'repo/session-150', 'repo/feature-34'],
    'the current and worktree markers are stripped',
  );
});
