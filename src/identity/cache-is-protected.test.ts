/**
 * The composition test: the gate refuses the agent the exact file this host writes its token to.
 *
 * Why it is a test of its own rather than a line in either module's suite. The gate's own tests
 * prove it refuses the paths it is given. The cache's own tests prove it writes to the path it is
 * told. Both can pass forever while the two paths are different, and nothing goes red — the
 * credential is simply unprotected, and every suite is green. That failure is invisible by
 * construction, so the assertion has to be the one nobody would think to write: the same `env`
 * goes into both sides, and the answer has to be a refusal.
 *
 * The `env` is stated, not read from the machine. A test that read the real environment would
 * pass or fail for a reason nobody chose, and on a machine with no `HOME` it would prove nothing
 * while still passing.
 *
 * Both path flavours run on every platform, and that is the point of the flavour table.
 *
 * Stating one environment — `USERPROFILE: 'C:/Users/agent'` — and resolving it with the running
 * platform's `node:path` is coherent on win32 and not on POSIX: `C:/Users/...` is a relative path
 * to `path.posix`, so it resolves against the test process's cwd and the gate compares two
 * unrelated strings. Every assertion here then fails on Linux, and the shell lane fails by
 * returning no refusal at all — which reads exactly like an unprotected credential.
 *
 * It is not one. Measured on a real Linux container with a POSIX env:
 *     Read -> credential-path-denied   Write -> credential-path-denied   Bash -> credential-path-denied
 *   The gate is correct on both platforms; a single-flavour test is Windows-only while reading as
 *   universal — the same defect class as a platform-conditional skip (see `host/paths.test.ts`).
 *
 * The resolver is injected, which is why this is provable anywhere. `localGate` takes `resolve`
 * as a parameter precisely so policy is testable without the machine. `core/paths.ts` is already
 * flavour-agnostic (it understands `/`, `\\`, drive letters and UNC), so pinning the resolver is
 * the only thing needed to assert the POSIX contract from Windows and the Windows contract from
 * POSIX. A platform-conditional test would prove one of them and skip the other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { posix, sep, win32 } from 'node:path';

import { credentialPaths, nodePathResolver, periscopeCredentialDir, tokenCachePath } from '../host/paths.js';
import { localGate } from '../gate/local.js';
import type { DecisionRequest } from '../gate/decision.js';
import type { PathResolver } from '../gate/jail.js';

/** `nodePathResolver`'s contract, over a stated flavour instead of the running platform's. */
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

interface Flavour {
  readonly name: string;
  readonly env: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
  readonly insideWorkspace: string;
  readonly relocated: NodeJS.ProcessEnv;
  readonly relocatedMark: RegExp;
  readonly resolve: PathResolver;
}

const FLAVOURS: readonly Flavour[] = [
  {
    name: 'windows paths',
    env: { USERPROFILE: 'C:/Users/agent' },
    workspaceRoot: 'C:/work/repo',
    insideWorkspace: 'C:/work/repo/src/index.ts',
    relocated: { USERPROFILE: 'C:/Users/agent', PERISCOPE_CONFIG_DIR: 'D:/secrets/periscope' },
    relocatedMark: /^D:/i,
    resolve: resolverFor(
      (...parts) => win32.resolve(...parts),
      (path) => win32.isAbsolute(path),
    ),
  },
  {
    name: 'posix paths',
    env: { HOME: '/home/agent' },
    workspaceRoot: '/work/repo',
    insideWorkspace: '/work/repo/src/index.ts',
    relocated: { HOME: '/home/agent', PERISCOPE_CONFIG_DIR: '/secrets/periscope' },
    relocatedMark: /^\/secrets\//,
    resolve: resolverFor(
      (...parts) => posix.resolve(...parts),
      (path) => posix.isAbsolute(path),
    ),
  },
];

/** The gate exactly as an embedder composes it: the protected set comes from `credentialPaths`. */
function gateFor(flavour: Flavour, env: NodeJS.ProcessEnv = flavour.env) {
  return localGate({
    workspaceRoot: flavour.workspaceRoot,
    resolve: flavour.resolve,
    protectedPaths: credentialPaths(env),
  });
}

function request(flavour: Flavour, toolName: string, toolInput: unknown): DecisionRequest {
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
  test(`regression: reading the token cache path this host writes is refused — ${flavour.name}`, () => {
    const cachePath = tokenCachePath(flavour.env);
    assert.notEqual(
      cachePath,
      null,
      'this environment produces no cache path, so the assertion below would be vacuous',
    );

    const refusal = gateFor(flavour)(request(flavour, 'Read', { file_path: cachePath }));

    assert.notEqual(
      refusal,
      null,
      `the gate has no opinion about ${String(cachePath)} — the token cache is NOT protected`,
    );
    assert.equal(refusal?.reason, 'credential-path-denied');
  });

  test(`regression: a shell command naming the token cache refuses too — ${flavour.name}`, () => {
    // The lane that reads as a credential leak on Linux under a Windows-only env: it returns no
    // refusal at all, because the protected needle resolves to a cwd-prefixed path that can never
    // appear in the command text. With the flavour stated, both platforms refuse by name.
    const cachePath = tokenCachePath(flavour.env);
    const refusal = gateFor(flavour)(request(flavour, 'Bash', { command: `cat ${String(cachePath)}` }));

    assert.notEqual(refusal, null, `a shell command naming ${String(cachePath)} was NOT refused`);
    assert.equal(refusal?.reason, 'credential-path-denied');
  });

  test(`regression: writing the token cache is refused — no planting one — ${flavour.name}`, () => {
    // Reading the credential is the obvious attack. Writing one is the quieter one: an agent that can
    // replace the cache chooses which identity this host presents to its controller.
    const refusal = gateFor(flavour)(
      request(flavour, 'Write', { file_path: tokenCachePath(flavour.env), content: 'x' }),
    );

    assert.equal(refusal?.reason, 'credential-path-denied');
  });

  test(`regression: coverage survives a relocated cache; both sides share one call — ${flavour.name}`, () => {
    // The failure this guards against is not "someone typed the wrong path once". It is "the two
    // paths were equal on the day they were written and one of them moved". Relocating via config is
    // the cheapest way to make them move independently — if they were separate literals, this fails.
    const cachePath = tokenCachePath(flavour.relocated);
    assert.match(
      String(cachePath),
      flavour.relocatedMark,
      'the cache did not move with the configured directory',
    );

    const refusal = gateFor(flavour, flavour.relocated)(request(flavour, 'Read', { file_path: cachePath }));
    assert.equal(refusal?.reason, 'credential-path-denied');
  });

  test(`regression: a later sibling of the cache is covered by the same denial — ${flavour.name}`, () => {
    // The protected entry is the directory, so a second credential file added later is protected by
    // having been put there rather than by somebody remembering to add a line here.
    const sibling = `${String(periscopeCredentialDir(flavour.env))}/some-future-secret.json`;

    assert.equal(
      gateFor(flavour)(request(flavour, 'Read', { file_path: sibling }))?.reason,
      'credential-path-denied',
    );
  });

  // -------------------------------------------------------------------------
  // Selector controls. Without these, every assertion above could pass for the wrong reason.
  // -------------------------------------------------------------------------

  test(`control: this gate does allow an ordinary read inside the workspace — ${flavour.name}`, () => {
    // If the gate refused everything, the refusals above would prove nothing at all.
    assert.equal(gateFor(flavour)(request(flavour, 'Read', { file_path: flavour.insideWorkspace })), null);
  });

  test(`control: the cache path is a real absolute path, not an empty string — ${flavour.name}`, () => {
    // `isContainedBy('', '')` style degenerate answers would make the denial trivially true.
    const cachePath = String(tokenCachePath(flavour.env));
    assert.ok(cachePath.length > 10, cachePath);
    assert.match(cachePath, /token-cache\.json$/);
  });
}

// ---------------------------------------------------------------------------
// The native leg. The flavour table above pins the resolver, which is what makes both contracts
// provable everywhere — but a pinned resolver is, by construction, not the one the host ships with.
// This leg runs the real `nodePathResolver` against the environment shape that platform actually
// has, so the composition is asserted end to end on whichever machine is running.
// ---------------------------------------------------------------------------

const NATIVE = sep === '\\' ? FLAVOURS[0]! : FLAVOURS[1]!;

test("regression: with the real resolver and this platform's own env shape, all three lanes refuse", () => {
  const gate = localGate({
    workspaceRoot: NATIVE.workspaceRoot,
    resolve: nodePathResolver,
    protectedPaths: credentialPaths(NATIVE.env),
  });
  const cachePath = String(tokenCachePath(NATIVE.env));

  assert.equal(gate(request(NATIVE, 'Read', { file_path: cachePath }))?.reason, 'credential-path-denied');
  assert.equal(
    gate(request(NATIVE, 'Write', { file_path: cachePath, content: 'x' }))?.reason,
    'credential-path-denied',
  );
  assert.equal(
    gate(request(NATIVE, 'Bash', { command: `cat ${cachePath}` }))?.reason,
    'credential-path-denied',
  );
});

test('control: the native leg still allows an ordinary workspace read', () => {
  const gate = localGate({
    workspaceRoot: NATIVE.workspaceRoot,
    resolve: nodePathResolver,
    protectedPaths: credentialPaths(NATIVE.env),
  });

  assert.equal(gate(request(NATIVE, 'Read', { file_path: NATIVE.insideWorkspace })), null);
});
