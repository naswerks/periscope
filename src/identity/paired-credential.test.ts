/**
 * The paired credential's pure half: the file shape, the credential it becomes, and the composition
 * fact the store's siblings each prove for themselves — the gate refuses the agent the exact file
 * `periscope pair` writes.
 *
 * The composition arms restate `cache-is-protected.test.ts`'s method, not its subject: stated
 * env, pinned resolver per flavour, both platforms provable from either. The token cache's own file
 * proves the directory is protected; these prove this file actually lives in it — the two facts
 * that together make "protected by having been put there" true rather than assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';

import { credentialPaths, pairedCredentialPath } from '../host/paths.js';
import { localGate } from '../gate/local.js';
import type { DecisionRequest } from '../gate/decision.js';
import type { PathResolver } from '../gate/jail.js';
import { PairedHostCredential, readPairedCredentialFile } from './paired-credential.js';
import { AUTHORIZATION_HEADER } from './credential.js';

// ── the file shape ─────────────────────────────────────────────────────────────────────────────────

test('a well-formed file round-trips, hostId and credential intact', () => {
  const read = readPairedCredentialFile({ hostId: 'ph-abc', credential: 'p1.ph-abc.s3cret' });

  assert.ok(read.ok, read.ok ? '' : read.refusal.detail);
  assert.deepEqual(read.value, { hostId: 'ph-abc', credential: 'p1.ph-abc.s3cret' });
});

test('every malformation is refused by name, and none is a crash', () => {
  const cases: unknown[] = [
    null,
    'a string',
    {},
    { hostId: 'ph-abc' },
    { credential: 'p1.ph-abc.s3cret' },
    { hostId: '', credential: 'p1..s3cret' },
    { hostId: 'ph-abc', credential: '' },
  ];

  for (const parsed of cases) {
    const read = readPairedCredentialFile(parsed);
    assert.equal(read.ok, false, JSON.stringify(parsed));
    if (!read.ok) assert.equal(read.refusal.reason, 'credential-cache-unreadable');
  }
});

test('regression: a file whose credential names a different host is corrupt, not usable', () => {
  // The daemon announces the file's hostId and authenticates with the file's credential. If the two
  // disagree, the controller refuses the hello after accepting the socket — a loop of accepted
  // dials and closed handshakes that names nothing. Caught here, where "re-pair" is printable.
  const read = readPairedCredentialFile({ hostId: 'ph-abc', credential: 'p1.ph-OTHER.s3cret' });

  assert.equal(read.ok, false);
  if (!read.ok) assert.match(read.refusal.detail, /does not match the hostId/);
});

// ── the credential it becomes ──────────────────────────────────────────────────────────────────────

test('the credential presents `Bearer p1...` on the Authorization header, every time', async () => {
  const credential = new PairedHostCredential({ hostId: 'ph-abc', credential: 'p1.ph-abc.s3cret' });

  const first = await credential.authorize();
  assert.ok(first.ok);
  assert.deepEqual(first.value, { header: AUTHORIZATION_HEADER, value: 'Bearer p1.ph-abc.s3cret' });

  // No refresh, no expiry, no state: the second answer is the first. Revocation is the
  // controller's, and it surfaces as the upgrade 401 the link already classifies as terminal.
  const second = await credential.authorize();
  assert.ok(second.ok);
  assert.deepEqual(second.value, first.value);
});

// ── the composition: the gate refuses the agent this exact file ────────────────────────────────────

function resolverFor(
  resolve: (candidate: string) => string,
  isAbsolute: (candidate: string) => boolean,
): PathResolver {
  return (candidate: string): string => {
    const resolved = resolve(candidate);
    if (!isAbsolute(resolved))
      throw new Error(`resolving ${candidate} produced a non-absolute path: ${resolved}`);
    return resolved;
  };
}

const FLAVOURS = [
  {
    name: 'windows paths',
    env: { USERPROFILE: 'C:/Users/agent' } as NodeJS.ProcessEnv,
    workspaceRoot: 'C:/work/repo',
    insideWorkspace: 'C:/work/repo/src/index.ts',
    resolve: resolverFor(
      (...parts) => win32.resolve(...parts),
      (path) => win32.isAbsolute(path),
    ),
  },
  {
    name: 'posix paths',
    env: { HOME: '/home/agent' } as NodeJS.ProcessEnv,
    workspaceRoot: '/work/repo',
    insideWorkspace: '/work/repo/src/index.ts',
    resolve: resolverFor(
      (...parts) => posix.resolve(...parts),
      (path) => posix.isAbsolute(path),
    ),
  },
] as const;

function request(flavour: (typeof FLAVOURS)[number], toolName: string, toolInput: unknown): DecisionRequest {
  return {
    toolName,
    toolUseId: 'toolu_test',
    toolInput,
    sessionId: 'session-test',
    sessionKey: 'handle-1',
    cwd: flavour.workspaceRoot,
    agentId: null,
    agentType: null,
  };
}

for (const flavour of FLAVOURS) {
  test(`regression: the gate refuses a read of the exact file the pair verb writes — ${flavour.name}`, () => {
    const path = pairedCredentialPath(flavour.env);
    assert.notEqual(path, null, 'this environment produces no path, so the assertion would be vacuous');
    assert.match(String(path), /paired-credential\.json$/);

    const gate = localGate({
      workspaceRoot: flavour.workspaceRoot,
      resolve: flavour.resolve,
      protectedPaths: credentialPaths(flavour.env),
    });

    const refusal = gate(request(flavour, 'Read', { file_path: path }));
    assert.equal(
      refusal?.reason,
      'credential-path-denied',
      `the gate has no opinion about ${String(path)} — the paired credential is not protected`,
    );
  });

  test(`control: the same gate allows an ordinary workspace read — ${flavour.name}`, () => {
    const gate = localGate({
      workspaceRoot: flavour.workspaceRoot,
      resolve: flavour.resolve,
      protectedPaths: credentialPaths(flavour.env),
    });

    assert.equal(
      gate(request(flavour, 'Read', { file_path: flavour.insideWorkspace })),
      null,
      'a gate that refuses everything makes the refusal above prove nothing',
    );
  });
}
