/**
 * The two impure inputs the host's own gate takes: the real resolver, and where credential material
 * lives.
 *
 * The environment is passed in rather than read, so these assert a stated environment instead of
 * whatever the machine running them happens to have — a test that reads the real one passes or fails
 * for a reason nobody chose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, join, sep } from 'node:path';

import { credentialPaths, nodePathResolver, periscopeCredentialDir, tokenCachePath } from './paths.js';

const windows = sep === '\\';

test('the resolver returns an absolute path for an absolute input', () => {
  const input = windows ? 'C:\\repo\\src\\a.ts' : '/repo/src/a.ts';
  assert.ok(isAbsolute(nodePathResolver(input)));
});

test('the resolver resolves traversal, which is what makes containment answerable', () => {
  const resolved = nodePathResolver(windows ? 'C:\\repo\\..\\secrets\\k.txt' : '/repo/../secrets/k.txt');
  assert.doesNotMatch(resolved, /\.\./, 'a traversal survived resolution');
  assert.match(resolved, /secrets/);
});

test('the resolver absolutises a RELATIVE path — which is why the jail re-checks containment after', () => {
  // It resolves against this process's cwd, which is a different directory from the session's
  // workspace. Resolution alone proves nothing about where the path belongs.
  const resolved = nodePathResolver('../elsewhere/x.txt');
  assert.ok(isAbsolute(resolved));
});

test('the resolver normalises mixed separators to the platform form', () => {
  const resolved = nodePathResolver(windows ? 'C:/repo\\src/a.ts' : '/repo/src/a.ts');
  assert.ok(isAbsolute(resolved));
  if (windows) assert.match(resolved, /\\/);
});

test('a drive-relative Windows path resolves rather than being read as rooted', { skip: !windows }, () => {
  // `C:foo` means "foo relative to the current directory ON DRIVE C", not `C:\foo`. A hand-rolled
  // normaliser reads it as rooted, which is one of the ways out of a jail built on string compare.
  //
  // The drive is taken from the cwd, not hard-coded. A literal `C:foo` asserted not to equal
  // `c:\foo` holds only while the process happens to be running on drive C, because the "current
  // directory on drive C" is then some deep path. On a CI runner checked out to `D:\a\...`, the
  // current directory on an untouched drive C is `C:\` itself, so `resolve('C:foo')` legitimately
  // returns `c:\foo` and the assertion fails on a correct resolver.
  //
  // Deriving the drive from `process.cwd()` makes the two forms always distinguishable: the cwd is
  // never a bare drive root in practice, and the guard below states that precondition instead of
  // assuming it.
  const drive = process.cwd().slice(0, 2);
  assert.match(drive, /^[A-Za-z]:$/, 'this test needs a drive-lettered cwd to have anything to say');
  assert.notEqual(
    process.cwd(),
    `${drive}\\`,
    'cwd is a bare drive root — rooted and drive-relative coincide',
  );

  const resolved = nodePathResolver(`${drive}foo`);
  assert.ok(isAbsolute(resolved));
  // The property: drive-relative resolves against the cwd on that drive...
  assert.equal(resolved.toLowerCase(), join(process.cwd(), 'foo').toLowerCase());
  // ...and is therefore NOT the rooted reading, which is the escape a string-compare jail would miss.
  assert.notEqual(resolved.toLowerCase(), `${drive.toLowerCase()}\\foo`);
});

// ---------------------------------------------------------------------------
// Credential paths
// ---------------------------------------------------------------------------

test('the agent CLI token cache and its state file are both protected', () => {
  const paths = credentialPaths({ USERPROFILE: 'C:/Users/agent' });
  assert.ok(
    paths.some((path) => path.endsWith('/.claude')),
    'the token cache directory is not protected',
  );
  assert.ok(
    paths.some((path) => path.endsWith('/.claude.json')),
    'the state file is not protected',
  );
});

test('ambient cloud and ssh credentials are protected too — same user, same tools', () => {
  const paths = credentialPaths({ USERPROFILE: 'C:/Users/agent' });
  for (const expected of ['/.aws', '/.config/gcloud', '/.azure', '/.ssh']) {
    assert.ok(
      paths.some((path) => path.endsWith(expected)),
      `${expected} is not protected`,
    );
  }
});

test('regression: a backslash home prints its paths with backslashes, never a mix', () => {
  assert.equal(periscopeCredentialDir({ USERPROFILE: 'C:\\Users\\agent' }), 'C:\\Users\\agent\\.periscope');
  assert.equal(periscopeCredentialDir({ USERPROFILE: 'C:\\Users\\agent\\' }), 'C:\\Users\\agent\\.periscope');
  assert.equal(
    tokenCachePath({ USERPROFILE: 'C:\\Users\\agent' }),
    'C:\\Users\\agent\\.periscope\\token-cache.json',
  );
  assert.equal(periscopeCredentialDir({ HOME: '/home/agent' }), '/home/agent/.periscope');
  const paths = credentialPaths({ USERPROFILE: 'C:\\Users\\agent' });
  assert.ok(paths.includes('C:\\Users\\agent\\.config\\gcloud'), `got ${paths.join(', ')}`);
});

test('regression: USERPROFILE wins over HOME; it is the load-bearing one on Windows', () => {
  const paths = credentialPaths({ USERPROFILE: 'C:/Users/agent', HOME: '/home/other' });
  assert.ok(
    paths.every((path) => !path.startsWith('/home/other')),
    'HOME was preferred over USERPROFILE',
  );
});

test('HOME is used when USERPROFILE is absent', () => {
  const paths = credentialPaths({ HOME: '/home/agent' });
  assert.ok(paths.some((path) => path === '/home/agent/.claude'));
});

test('an explicitly configured credential directory is protected as well', () => {
  const paths = credentialPaths({ HOME: '/home/agent', CLAUDE_CONFIG_DIR: '/opt/creds' });
  assert.ok(paths.includes('/opt/creds'));
});

test('a trailing separator on the home directory does not double up', () => {
  const paths = credentialPaths({ HOME: '/home/agent/' });
  assert.ok(paths.includes('/home/agent/.claude'), `got ${paths.join(', ')}`);
});

test('an environment with no home at all still returns a usable set rather than throwing', () => {
  const paths = credentialPaths({});
  assert.ok(Array.isArray(paths));
});

// Guards the SELECTOR: an empty set would satisfy every `every(...)` assertion above.
test('the default set is not empty on a normal environment', () => {
  assert.ok(credentialPaths({ USERPROFILE: 'C:/Users/agent' }).length >= 6);
});

// ---------------------------------------------------------------------------
// This host's own credential material
// ---------------------------------------------------------------------------

test("regression: the host's own credential directory is in the protected set", () => {
  // Without this the gate would guard the agent CLI's token cache and every ambient cloud
  // credential while leaving THIS host's token — the one it just wrote — readable by the agent.
  const env = { USERPROFILE: 'C:/Users/agent' };

  assert.ok(credentialPaths(env).includes(String(periscopeCredentialDir(env))));
});

test('regression: the cache path and the protected set come from one source, so they cannot drift', () => {
  // The failure this removes is not a typo. It is two literals that were equal on the day they were
  // written and then one of them moved — and nothing goes red when they do.
  const env = { USERPROFILE: 'C:/Users/agent' };
  const dir = String(periscopeCredentialDir(env));

  assert.equal(String(tokenCachePath(env)).startsWith(dir), true);
  assert.ok(credentialPaths(env).includes(dir));
});

test("the cache is NOT hidden inside the agent CLI's directory", () => {
  // Squatting in `~/.claude` would inherit protection by coincidence, and break silently the moment
  // either side reorganised.
  const env = { USERPROFILE: 'C:/Users/agent' };

  assert.doesNotMatch(String(tokenCachePath(env)), /\.claude/);
});

test('PERISCOPE_CONFIG_DIR moves the cache AND the protection together', () => {
  const env = { USERPROFILE: 'C:/Users/agent', PERISCOPE_CONFIG_DIR: 'D:/secrets/periscope' };

  assert.equal(periscopeCredentialDir(env), 'D:/secrets/periscope');
  assert.equal(tokenCachePath(env), 'D:/secrets/periscope/token-cache.json');
  assert.ok(credentialPaths(env).includes('D:/secrets/periscope'));
});

test('the cache path exists exactly when a credential directory does — never a guessed fallback', () => {
  // An empty env still resolves through `homedir()`, which is deliberate: "the env did not say"
  // is not the same as "there is nowhere". What must never happen is a cache path appearing when
  // there is no directory to put it in — a fallback to a temp directory would write a token
  // somewhere world-readable, which is worse than refusing to cache at all.
  for (const env of [{}, { USERPROFILE: 'C:/Users/agent' }, { HOME: '/home/agent' }]) {
    assert.equal(tokenCachePath(env) === null, periscopeCredentialDir(env) === null, JSON.stringify(env));
  }
});

test('the cache file sits directly in the credential directory, under a name that says what it is', () => {
  assert.equal(tokenCachePath({ HOME: '/home/agent' }), '/home/agent/.periscope/token-cache.json');
});

test("USERPROFILE wins over HOME for the host's own directory too", () => {
  assert.equal(
    periscopeCredentialDir({ USERPROFILE: 'C:/Users/agent', HOME: '/home/other' }),
    'C:/Users/agent/.periscope',
  );
});

test('the effective agent home is protected: passed by the composition root, or read from the environment', () => {
  const env = { USERPROFILE: 'C:/Users/x' };
  assert.ok(credentialPaths({ ...env, PERISCOPE_AGENT_HOME: 'D:/agents/home' }).includes('D:/agents/home'));
  assert.ok(credentialPaths(env, { agentHome: 'D:/agents/home' }).includes('D:/agents/home'));
  // The default under the home directory is already there, and is not listed twice.
  const defaulted = credentialPaths(env, { agentHome: 'C:/Users/x/.claude' });
  assert.equal(defaulted.filter((path) => path === 'C:/Users/x/.claude').length, 1);
});
