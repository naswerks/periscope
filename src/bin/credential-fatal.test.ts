/**
 * The process-level proof that a refused credential is fatal and loud.
 *
 * This spawns a real process instead of calling a function because the property under test is
 * "this process ends, unsuccessfully, and says why", and that is not a property any in-process
 * test can observe. The failure being pinned here is precisely one of exit code and event-loop
 * drain, which the test runner's own handles mask. A unit test asserting that a refusal reaches a
 * branch would pass against the defect, because the defect is never in the branch; it is in what
 * the process does afterwards.
 *
 * The defect class: a host whose refresh token has lapsed dials its controller with no header, is
 * refused, arms an unref'd retry timer, and, with no ref'd handle left, drains and exits zero. A
 * supervisor records a clean run; a dashboard shows a host that has finished. The operator is never
 * told the one thing they could act on.
 *
 * The exit code alone is not the assertion, and that is deliberate. `serve()` exits 1 for several
 * unrelated reasons (running as root, a missing controller URL, an unusable cache directory) so a
 * test that checked only the code would pass while proving nothing about credentials. Every case
 * below asserts the code and the words, and the transient case asserts a non-fatal refusal still
 * connects, which is the half that keeps this from being a rule that simply refuses everything.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Run, Settle } from '../test-support/spawn-harness.js';
import { runBinary as spawnBinary } from '../test-support/spawn-harness.js';

interface TokenEndpointReply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * A token endpoint, and nothing else.
 *
 * The host is pointed at explicit authorize/token URLs, which is a supported configuration and skips
 * discovery entirely — so this fake needs one route rather than a whole provider. It listens on port
 * 0 so parallel runs cannot collide.
 */
async function tokenEndpoint(
  reply: TokenEndpointReply,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const AUTHORITY = 'https://identity.example.invalid/tenant';
const CLIENT_ID = 'periscope-test-client';

/** A cache holding an expired access token and a refresh token, which is what forces a refresh. */
function cacheDirHolding(refreshToken: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'periscope-credential-'));
  writeFileSync(
    join(dir, 'token-cache.json'),
    JSON.stringify({
      tokens: {
        accessToken: 'an-expired-access-token',
        refreshToken,
        // Comfortably in the past, so `isFresh` is false without depending on the skew's value.
        expiresAt: 1_000_000_000_000,
        tokenType: 'Bearer',
        scope: 'api://test/.default',
      },
      protocol: 'loopback',
      authority: AUTHORITY,
      clientId: CLIENT_ID,
    }),
    'utf8',
  );
  return dir;
}

/**
 * Runs the binary with no verb (`serve`) and waits for it to end.
 *
 * The harness's timeout kill is a failure, not a clean-up. A host that has been refused and does
 * not exit is the false-running-forever shape, so the timeout kills the process and the caller
 * asserts on a `code` that will not match, rather than the test hanging until the runner cancels
 * it and takes its siblings down.
 *
 * `settle` is the other half, and it exists because staying alive is correct for the transient
 * class. With the retry timer ref'd, a host in a transient outage never exits, which means a case
 * about that class would otherwise sit the full timeout and end indistinguishably from a hang.
 * When the trace says the thing the case was waiting for, the harness records whether the process
 * was still alive and stops it deliberately. `alive` is how a caller asserts survival;
 * exit-and-assert-the-code remains for every terminal case.
 */
function runBinary(env: NodeJS.ProcessEnv, settle?: Settle): Promise<Run> {
  return spawnBinary([], env, settle);
}

function baseEnv(cacheDir: string, providerUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PERISCOPE_HOST_ID: 'credential-test-host',
    // A port nothing is listening on, on purpose. The controller must never be reached: if the
    // credential decision is fatal the host must not dial at all, and if this test ever starts
    // passing because a real controller answered, it is measuring the wrong thing.
    PERISCOPE_CONTROLLER_URL: 'ws://127.0.0.1:1/link',
    PERISCOPE_DECISION_URL: 'http://127.0.0.1:1/decision',
    PERISCOPE_CONFIG_DIR: cacheDir,
    PERISCOPE_IDENTITY_AUTHORITY: AUTHORITY,
    PERISCOPE_IDENTITY_CLIENT_ID: CLIENT_ID,
    // Set together, which is what makes discovery unnecessary.
    PERISCOPE_IDENTITY_AUTHORIZE_URL: `${providerUrl}/authorize`,
    PERISCOPE_IDENTITY_TOKEN_URL: `${providerUrl}/token`,
  };
}

/**
 * Running as uid 0 makes `serve()` refuse before it ever reads a credential, so every assertion
 * below would pass for a reason having nothing to do with identity. Skipped loudly rather than
 * silently: a container that runs as root should be told this property went unchecked.
 */
const asRoot = process.getuid?.() === 0;
const skipRoot = asRoot ? { skip: 'running as uid 0: serve() refuses before any credential is read' } : {};

test(
  'regression: a dead refresh grant ends the process non-zero and names the action',
  skipRoot,
  async () => {
    const provider = await tokenEndpoint({
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: 'the refresh token has expired due to inactivity',
      },
    });
    const cacheDir = cacheDirHolding('a-refresh-token-the-provider-no-longer-honours');

    try {
      const run = await runBinary(baseEnv(cacheDir, provider.url));

      assert.equal(
        run.code,
        1,
        `expected a failing exit, got ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );

      // The words, because the code alone is satisfied by several unrelated refusals.
      assert.match(run.stderr, /periscope login/, 'stderr must name the action a human can take');
      assert.match(run.stderr, /refused this credential/, 'stderr must say what was refused');

      // And the trace has to show the link deciding, not merely the process ending.
      assert.match(run.stdout, /credential_rejected/, 'the link must record why it closed');
      assert.match(run.stdout, /token-grant-rejected/, 'the refusal must be surfaced by its own name');
    } finally {
      await provider.close();
    }
  },
);

test(
  'a dead grant is distinguished from an unreachable provider — the second one keeps trying',
  skipRoot,
  async () => {
    // The half that stops this becoming "refuse everything". A 503 from the token endpoint is an
    // outage: the grant may be perfectly good and the next attempt may work, so the host must not
    // treat it as terminal. With both answers under one reason the choice could not be made at all.
    //
    // The harness settles on the transient name and the case asserts the property directly: the
    // host was still alive when the harness stopped it. Asserting `code !== 1` on an exit produced by
    // the process draining would make the termination mechanism the bug and the pass a coincidence.
    const provider = await tokenEndpoint({
      status: 503,
      body: { error: 'temporarily_unavailable', error_description: 'try again shortly' },
    });
    const cacheDir = cacheDirHolding('a-refresh-token-that-was-never-judged');

    try {
      const run = await runBinary(baseEnv(cacheDir, provider.url), { on: /token-request-failed/ });

      assert.doesNotMatch(
        run.stdout,
        /credential_rejected/,
        'an outage must not close the link as though a human were required',
      );
      assert.match(run.stdout, /token-request-failed/, 'an outage keeps its own transient name');
      assert.equal(run.alive, true, 'an outage must leave the host running — exiting is the defect');
    } finally {
      await provider.close();
    }
  },
);

test(
  'an expired token with no refresh token is fatal too — there is nothing left to try',
  skipRoot,
  async () => {
    // This one never reaches the token endpoint at all: the cache itself already says the only thing
    // that could renew it is absent. Same conclusion, different route to it, and it is the reason
    // `token-unavailable` sits beside `token-grant-rejected` in the predicate rather than alone.
    const provider = await tokenEndpoint({ status: 500, body: {} });
    const cacheDir = cacheDirHolding(null);

    try {
      const run = await runBinary(baseEnv(cacheDir, provider.url));

      assert.equal(
        run.code,
        1,
        `expected a failing exit, got ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );
      assert.match(run.stderr, /periscope login/);
      assert.match(run.stdout, /token-unavailable/);
    } finally {
      await provider.close();
    }
  },
);

/**
 * An environment with a controller nobody answers and no identity configured at all.
 *
 * `PERISCOPE_CONFIG_DIR` is pointed at an empty fixture, not deleted, and the difference matters.
 * Deleting it does not make this host anonymous; it makes it read whatever the developer has,
 * because `periscopeCredentialDir` falls back to `~/.periscope` when the variable is absent. On any
 * machine that has run `periscope pair` the spawned binary then finds a real paired credential,
 * announces `[credential] paired as <hostId>`, and this case fails asserting `[credential] absent`,
 * while an unpaired CI machine never sees it.
 *
 * A fixture root rather than one more `delete`: a strip list stops being correct the moment a
 * credential source is added outside it, and nothing goes red to say so, because the list is not
 * derived from anything. An empty fixture root is not a longer list: it redirects the one path
 * every config-dir-rooted credential resolves through, so a future source cannot silently join by
 * being absent from an enumeration. The identity variables below still need deleting; they are
 * read from the environment directly and are rooted in nothing.
 */
function anonymousEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PERISCOPE_HOST_ID: 'transient-test-host',
    // A port nothing listens on: every dial is refused at the socket, which is the transient class.
    PERISCOPE_CONTROLLER_URL: 'ws://127.0.0.1:1/link',
    PERISCOPE_DECISION_URL: 'http://127.0.0.1:1/decision',
    // An empty directory: no `paired-credential.json`, no `token-cache.json`, nothing to find.
    PERISCOPE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'periscope-anonymous-')),
  };
  // Stripped rather than trusted absent: the machine running this suite may itself be configured.
  delete env['PERISCOPE_IDENTITY_AUTHORITY'];
  delete env['PERISCOPE_IDENTITY_CLIENT_ID'];
  delete env['PERISCOPE_IDENTITY_AUTHORIZE_URL'];
  delete env['PERISCOPE_IDENTITY_TOKEN_URL'];
  return env;
}

/**
 * The pin that fails on an unpaired machine too, which is the only kind worth having here.
 *
 * The defect this guards is invisible to an unpaired CI machine: with `PERISCOPE_CONFIG_DIR`
 * deleted, a machine that has never run `periscope pair` finds nothing at `~/.periscope`, reports
 * `absent`, and goes green while the bug sits there waiting for a developer who has paired. Every
 * assertion inside the transient case below is therefore blind on CI, including the `paired as`
 * line beside them; mutual exclusion means those two can never disagree, so they diagnose rather
 * than protect.
 *
 * This one asserts the environment instead of the run: a config dir that is set, exists, and is
 * empty. Revert `anonymousEnv` to `delete env['PERISCOPE_CONFIG_DIR']` and it goes red on every
 * machine.
 *
 * Its own discriminator is in the second half, and it is the same predicate over a fixture that
 * does hold a credential. One variable (which directory) and the two halves must disagree, or the
 * check is one observation wearing two names.
 */
test("regression: the anonymous fixture is a real empty directory, never the developer's ~/.periscope", () => {
  const configured = anonymousEnv()['PERISCOPE_CONFIG_DIR'];

  assert.ok(
    configured !== undefined && configured.trim() !== '',
    'PERISCOPE_CONFIG_DIR must be set: deleting it makes the spawned binary read the real ~/.periscope, ' +
      'so the suite then measures whoever is running it',
  );
  assert.deepEqual(
    readdirSync(configured),
    [],
    'the anonymous fixture must hold no credential of any kind — that is what makes the host anonymous',
  );

  // The discriminator: the same predicate over a fixture that deliberately holds a paired credential.
  // Without this, an `anonymousEnv` pointing at a path that does not exist would satisfy the emptiness
  // assertion by accident and prove nothing about isolation.
  assert.deepEqual(
    readdirSync(cacheDirHoldingPairedCredential('ph-discriminator')),
    ['paired-credential.json'],
    'the identical check must see a credential when one is there, or it is not discriminating',
  );
});

test('regression: a transient outage keeps the process alive past its first backoff — no false-finished exit', async () => {
  // The settle pattern is the retry firing: `backoff -> connecting` can only be printed by a
  // process that survived the whole backoff window, so matching it is the measurement. With an
  // unref'd retry timer this exact scenario drains and exits 0 in under a second, a network blip
  // recorded as a clean finish.
  const run = await runBinary(anonymousEnv(), { on: /backoff -> connecting/ });

  assert.equal(
    run.alive,
    true,
    `the host must outlive its first backoff window, not drain to a clean exit\nstdout:\n${run.stdout}`,
  );
  // The anonymous posture is stated once at start-up; silent-unauthenticated is its own defect.
  assert.match(run.stdout, /\[credential\] absent/, 'a host with no identity must say so before dialling');

  // The regression pin, and it names its own cause. Without this line the failure mode above reads
  // only as "`absent` is missing", which sends a reader hunting the posture logic. What actually
  // goes wrong is that this case reads the developer's machine, and `paired as` is the sentence
  // that proves it. Its discriminator is the revoked-credential case below, which asserts this same
  // phrase must render for a fixture that does hold a credential: one variable (which config dir),
  // two opposite outcomes. Assert only that phrase, never the host id: the id is this machine's and
  // pinning it would make the test pass for the wrong reason on the next machine.
  assert.doesNotMatch(
    run.stdout,
    /paired as/,
    'this case must read an empty fixture config dir — a real ~/.periscope makes it measure the machine',
  );

  assert.doesNotMatch(run.stdout, /credential_rejected/, 'nothing here is a credential judgement');
  assert.doesNotMatch(
    run.stderr,
    /refused this credential/,
    'the fatal stderr line belongs to the terminal class only',
  );
});

/** A controller that answers every WebSocket upgrade with one status and hangs up. */
async function upgradeRefusingController(
  status: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer();
  server.on('upgrade', (_request, socket) => {
    socket.write(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/link`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A cache whose access token is still fresh, so the host presents it without any refresh. */
function cacheDirHoldingFreshToken(): string {
  const dir = mkdtempSync(join(tmpdir(), 'periscope-credential-'));
  writeFileSync(
    join(dir, 'token-cache.json'),
    JSON.stringify({
      tokens: {
        accessToken: 'a-token-the-provider-considers-fine',
        refreshToken: 'unused-while-fresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
        tokenType: 'Bearer',
        scope: 'api://test/.default',
      },
      protocol: 'loopback',
      authority: AUTHORITY,
      clientId: CLIENT_ID,
    }),
    'utf8',
  );
  return dir;
}

test(
  'regression: a 401 at the upgrade ends the process non-zero naming link-unauthorized — the token layer never saw it',
  skipRoot,
  async () => {
    // The provider approved this token (it is fresh and never refreshed; the token endpoint below
    // answers 500 precisely so a silent refresh could not be what this case measures). The
    // controller then refuses the upgrade: the one refusal the token-layer split structurally cannot
    // catch, and without its own reason it would wear a transport failure's name and retry forever.
    const provider = await tokenEndpoint({ status: 500, body: {} });
    const controller = await upgradeRefusingController(401);
    const cacheDir = cacheDirHoldingFreshToken();

    try {
      const env = { ...baseEnv(cacheDir, provider.url), PERISCOPE_CONTROLLER_URL: controller.url };
      const run = await runBinary(env);

      assert.equal(
        run.code,
        1,
        `expected a failing exit, got ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );

      // The words, because the code alone is satisfied by several unrelated refusals.
      assert.match(run.stderr, /periscope login/, 'stderr must name the action a human can take');
      assert.match(run.stderr, /refused this credential/, 'stderr must say what was refused');
      assert.match(run.stderr, /0 live session\(s\) stopped/, 'the death line must say what work it cut');

      // And the trace names the door: the upgrade, not the token endpoint and not the transport.
      assert.match(run.stdout, /link-unauthorized/, 'the refusal must be surfaced by its own name');
      assert.match(run.stdout, /credential_rejected/, 'the link must record why it closed');
      assert.doesNotMatch(
        run.stdout,
        /token-grant-rejected/,
        'the token layer must not be the one speaking here',
      );
    } finally {
      await controller.close();
      await provider.close();
    }
  },
);

/**
 * win32 cannot deliver a catchable SIGTERM to a spawned child — `child.kill` terminates the process
 * without running its handlers — so the latch property is only observable where signals are real.
 * Skipped loudly here; the linux CI leg runs it on every push.
 */
const onWindows = process.platform === 'win32';
const skipSignals = onWindows
  ? { skip: 'win32 delivers no catchable SIGTERM to a spawned child; the linux CI leg runs this' }
  : {};

test(
  'regression: a signal cannot launder a failure — SIGTERM after a fatal refusal still exits non-zero',
  { ...skipRoot, ...skipSignals },
  async () => {
    const provider = await tokenEndpoint({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'the refresh token has expired due to inactivity' },
    });
    const cacheDir = cacheDirHolding('a-refresh-token-the-provider-no-longer-honours');

    try {
      // The signal is sent the instant the trace shows the fatal conclusion, aiming for the window
      // between the exit code being latched and the drain completing. If the process wins the race
      // and exits first, the kill is a no-op and the assertion still holds — the run exercises the
      // guard only when the signal lands, which on a real machine it regularly does. What can never
      // happen, either way, is an exit 0.
      const run = await runBinary(baseEnv(cacheDir, provider.url), {
        on: /credential_rejected/,
        signal: 'SIGTERM',
      });

      assert.equal(
        run.code,
        1,
        `a shutdown signal reset a latched failure to ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );
    } finally {
      await provider.close();
    }
  },
);

/** A config dir holding a paired credential and no token cache: the posture `periscope pair` leaves. */
function cacheDirHoldingPairedCredential(hostId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'periscope-paired-'));
  writeFileSync(
    join(dir, 'paired-credential.json'),
    JSON.stringify({ hostId, credential: `p1.${hostId}.a-secret-the-controller-has-revoked` }),
    'utf8',
  );
  return dir;
}

test(
  'regression: a revoked paired credential dies through the same terminal door, and the remedy names re-pairing',
  skipRoot,
  async () => {
    // The controller refuses the upgrade 401, which is exactly what revocation looks like from this
    // side: the controller's record went dead and the door stopped opening. The whole path below is
    // the link's existing machinery reused verbatim (`link-unauthorized`, then terminal, then exit
    // 1); pairing adds no vocabulary to it, and this case is the proof that the composition composes.
    const controller = await upgradeRefusingController(401);
    const cacheDir = cacheDirHoldingPairedCredential('ph-revoked-host');

    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PERISCOPE_CONTROLLER_URL: controller.url,
        PERISCOPE_DECISION_URL: 'http://127.0.0.1:1/decision',
        PERISCOPE_CONFIG_DIR: cacheDir,
      };
      // No OIDC identity and no configured host id: the paired credential alone carries both.
      delete env['PERISCOPE_IDENTITY_AUTHORITY'];
      delete env['PERISCOPE_IDENTITY_CLIENT_ID'];
      delete env['PERISCOPE_IDENTITY_AUTHORIZE_URL'];
      delete env['PERISCOPE_IDENTITY_TOKEN_URL'];
      delete env['PERISCOPE_HOST_ID'];

      const run = await runBinary(env);

      assert.equal(
        run.code,
        1,
        `expected a failing exit, got ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );

      // The posture line: which credential this host was on is stated before the first dial.
      assert.match(
        run.stdout,
        /\[credential\] paired as ph-revoked-host/,
        'the paired posture must be stated at start-up',
      );

      // The composed terminal path, by the link's own names; nothing new was minted for revocation.
      assert.match(run.stdout, /link-unauthorized/, 'the upgrade refusal must keep its terminal name');
      assert.match(run.stdout, /credential_rejected/, 'the link must record why it closed');

      // The remedy is the paired one: `login` writes a token this host would not even present.
      assert.match(run.stderr, /refused this credential/, 'the death line must say what was refused');
      assert.match(run.stderr, /periscope pair/, "a paired host's remedy is re-pairing, not signing in");
      assert.doesNotMatch(
        run.stderr,
        /periscope login/,
        'naming login here sends the operator to the wrong flow',
      );
    } finally {
      await controller.close();
    }
  },
);

test('control: the binary under test exists and this harness can actually run it', async () => {
  // Without this, a wrong path or a missing build would make every assertion above pass vacuously
  // by way of a process that never started and a `code` that happened to match.
  const run = await runBinary({ ...process.env, PERISCOPE_CONTROLLER_URL: '', PERISCOPE_DECISION_URL: '' });

  assert.equal(run.code, 1, 'a host with no controller URL must refuse to start');
  assert.match(run.stderr, /periscope:/, 'the binary reports its own refusals on stderr');
  assert.doesNotMatch(
    run.stderr,
    /refused this credential/,
    'this control must fail for its own reason, never the credential one',
  );
});
