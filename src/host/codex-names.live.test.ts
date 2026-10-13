/**
 * The names snapshot against the binary the operator installed: what `codex app-server generate-ts
 * --experimental` writes, read and then deleted, must declare exactly the notifications, server
 * requests, item kinds and client methods `contracts/codex-protocol-names.json` holds.
 *
 * The coverage pin holds `CODEX_COVERAGE` to the snapshot from the release's own source with no binary;
 * this holds the snapshot to the binary, so a binary whose protocol is not the pinned release's is
 * caught as such and never read through a table written for another.
 *
 * It skips loudly: it runs only with `PERISCOPE_LIVE=1` and `PERISCOPE_CODEX_BIN` naming the binary
 * or the npm launcher. Without both, the property is NOT exercised, and the skip says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { codexCommand } from './codex-binary.js';
import { CODEX_NAMES } from './codex-names.js';

const LIVE = process.env['PERISCOPE_LIVE'] === '1';
const BINARY = process.env['PERISCOPE_CODEX_BIN'] ?? '';
const skip = !LIVE
  ? 'PERISCOPE_LIVE is not set — this property is NOT exercised'
  : BINARY === ''
    ? 'PERISCOPE_CODEX_BIN is not set — this property is NOT exercised'
    : false;

const methods = (source: string): string[] =>
  [...source.matchAll(/"method": "([^"]+)"/g)].map((match) => match[1] ?? '');
const kinds = (source: string): string[] =>
  [...source.matchAll(/\{ "type": "([A-Za-z]+)"/g)].map((match) => match[1] ?? '');

test('the binary declares exactly the names the snapshot holds, experimental ones included', { skip }, () => {
  const out = mkdtempSync(`${tmpdir()}${sep}periscope-codex-names-`);
  try {
    const command = codexCommand(BINARY, ['app-server', 'generate-ts', '--experimental', '--out', out]);
    execFileSync(command.command, [...command.args], { windowsHide: true, timeout: 120_000 });
    const read = (file: string): string => readFileSync(join(out, file), 'utf8');
    assert.deepEqual(
      methods(read('ServerNotification.ts')).sort(),
      CODEX_NAMES.notifications.map((entry) => entry.method).sort(),
    );
    assert.deepEqual(
      methods(read('ServerRequest.ts')).sort(),
      CODEX_NAMES.serverRequests.map((entry) => entry.method).sort(),
    );
    assert.deepEqual(
      methods(read('ClientRequest.ts')).sort(),
      CODEX_NAMES.clientMethods.map((entry) => entry.method).sort(),
    );
    assert.deepEqual(kinds(read(join('v2', 'ThreadItem.ts'))).sort(), [...CODEX_NAMES.itemKinds].sort());
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
