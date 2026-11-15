/**
 * The check the further-writes probe makes, over frames written here: it passes on two file-tool writes
 * that completed and landed, and it fails, by name, on each way a write can be something else. The probe
 * itself needs a real agent; its check does not.
 */
import { writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { tempDir } from './temp-dir.js';
import { assertWroteWithFileTools, toolCallsOn } from './write-check.js';

let seq = 0;

/** One `agent_item` frame on `sessionId`, as a peer receives it. */
function itemFrame(sessionId: string, item: Record<string, unknown>): string {
  seq += 1;
  return JSON.stringify({
    frame: 'session',
    sessionId,
    seq,
    at: '2000-01-01T00:00:00.000Z',
    payload: { kind: 'session_update', body: { update: 'agent_item', runtime: 'claude', item } },
  });
}

function call(id: string, toolName: string, toolKind: string, input: Record<string, unknown>): string {
  return itemFrame('s-1', {
    kind: 'tool_call',
    itemId: id,
    turnId: null,
    toolUseId: id,
    toolName,
    toolKind,
    input,
    truncated: false,
  });
}

function result(id: string, status: string): string {
  return itemFrame('s-1', {
    kind: 'tool_result',
    itemId: `${id}:result`,
    turnId: null,
    toolUseId: id,
    status,
    output: null,
    exitCode: null,
    durationMs: null,
    changes: null,
    truncated: false,
  });
}

/** Two files written in a temporary folder, and the frames of two `Write` calls that wrote them. */
async function written(): Promise<{ dir: string; first: string; second: string; frames: string[] }> {
  const dir = await tempDir('write-check');
  const first = join(dir, 'first.txt');
  const second = join(dir, 'second.txt');
  writeFileSync(first, 'pomegranate\n');
  writeFileSync(second, 'quince\n');
  const frames = [
    call('toolu_1', 'Write', 'file_write', { file_path: first, content: 'pomegranate' }),
    result('toolu_1', 'completed'),
    call('toolu_2', 'Write', 'file_write', { file_path: second, content: 'quince' }),
    result('toolu_2', 'completed'),
  ];
  return { dir, first, second, frames };
}

test('two file-tool writes that completed and landed pass, and each call is read with its result', async () => {
  const { dir, first, second, frames } = await written();
  try {
    assert.deepEqual(
      toolCallsOn(frames, 's-1').map((one) => [one.toolName, one.toolKind, one.status]),
      [
        ['Write', 'file_write', 'completed'],
        ['Write', 'file_write', 'completed'],
      ],
    );
    assertWroteWithFileTools(frames, 's-1', [
      { path: first, text: 'pomegranate' },
      { path: second, text: 'quince' },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('control: a shell call beside the writes fails the check, whatever landed', async () => {
  const { dir, first, second, frames } = await written();
  try {
    const shelled = [...frames, call('toolu_3', 'Bash', 'shell', { command: `echo quince > ${second}` })];
    assert.throws(
      () =>
        assertWroteWithFileTools(shelled, 's-1', [
          { path: first, text: 'pomegranate' },
          { path: second, text: 'quince' },
        ]),
      /a shell call ran/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('control: a file on disk that no file-tool call wrote fails the check', async () => {
  const { dir, first, second, frames } = await written();
  try {
    const one = frames.slice(0, 2);
    assert.throws(
      () =>
        assertWroteWithFileTools(one, 's-1', [
          { path: first, text: 'pomegranate' },
          { path: second, text: 'quince' },
        ]),
      /not one per file/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('control: a write that did not complete, or a file not on disk, fails the check', async () => {
  const { dir, first, second, frames } = await written();
  try {
    const blocked = [...frames.slice(0, 3), result('toolu_2', 'blocked')];
    assert.throws(
      () =>
        assertWroteWithFileTools(blocked, 's-1', [
          { path: first, text: 'pomegranate' },
          { path: second, text: 'quince' },
        ]),
      /did not complete/,
    );
    await rm(second);
    assert.throws(
      () =>
        assertWroteWithFileTools(frames, 's-1', [
          { path: first, text: 'pomegranate' },
          { path: second, text: 'quince' },
        ]),
      /is not on disk/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
