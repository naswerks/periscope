/**
 * The daemon's start-up sequence, drivable without a socket or an agent. The link and the process
 * starter are injected, every process edge is recorded, and the credential files live in a
 * per-case temp directory so nothing reads the developer's own `~/.periscope`.
 *
 * The process-level halves (exit codes, draining, signals) stay with `credential-fatal.test.ts`;
 * what is proven here is the order of the refusals, the posture lines, and what the fatal path
 * asks the process to do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import { refusal } from '../core/refusal.js';
import type { SessionFrame, SessionPayload } from '../control/frames.js';
import { sessionNew } from '../control/frames.js';
import type { LinkHandlers } from '../control/link.js';
import type { LinkTransition } from '../control/link-state.js';
import type { HostEvent } from '../host/index.js';
import type { HostLink } from '../host/host.js';
import { fakeAgents, initMessage, settle } from '../test-support/fake-agent.js';
import { withTempDir } from '../test-support/temp-dir.js';
import type { CredentialPosture, ServeDeps, ServeOutcome, ServeViews } from './serve.js';
import { FATAL_EXIT_FLUSH_MS, readCredential, report, runServe } from './serve.js';

const AUTHORITY = 'https://identity.example/tenant';
const CLIENT_ID = 'periscope-test-client';

class FakeLink implements HostLink {
  started = false;
  stopped = false;
  handlers: LinkHandlers | null = null;

  send(): Result<void> {
    return ok(undefined);
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  forgetSession(): void {}

  transition(cause: LinkTransition['cause'], detail: string | null = null): void {
    this.handlers?.onTransition({
      from: 'connecting',
      to: 'closed',
      cause,
      at: new Date().toISOString(),
      detail,
    });
  }

  deliver(sessionId: string, payload: SessionPayload): void {
    const frame: SessionFrame = {
      frame: 'session',
      sessionId,
      seq: 1,
      at: new Date().toISOString(),
      payload,
    };
    this.handlers?.onSessionFrame(frame);
  }
}

interface Run {
  readonly outcome: ServeOutcome;
  readonly out: string[];
  readonly err: string[];
  readonly exitCodes: number[];
  readonly exits: number[];
  readonly signals: Map<string, () => void>;
  readonly link: FakeLink;
  readonly agents: ReturnType<typeof fakeAgents>;
}

interface Overrides {
  readonly raw?: NodeJS.ProcessEnv;
  readonly merged?: NodeJS.ProcessEnv | string;
  readonly getuid?: ServeDeps['getuid'];
}

/** A raw environment rooted in `dir` with no identity of its own; `extra` adds to it. */
function rawEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PERISCOPE_CONFIG_DIR: dir, HOME: '/home/agent', ...extra };
}

/** The merged view: the raw one plus the two URLs every serving host needs and a stated host id. */
function mergedEnv(raw: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...raw,
    PERISCOPE_CONTROLLER_URL: 'ws://127.0.0.1:1/link',
    PERISCOPE_DECISION_URL: 'http://127.0.0.1:1/decision',
    PERISCOPE_HOST_ID: 'configured-host',
    ...extra,
  };
}

function serve(views: ServeViews, overrides: Overrides = {}): Run {
  const out: string[] = [];
  const err: string[] = [];
  const exitCodes: number[] = [];
  const exits: number[] = [];
  const signals = new Map<string, () => void>();
  const link = new FakeLink();
  const agents = fakeAgents();

  const outcome = runServe(views, {
    log: (line) => out.push(line),
    stderr: (line) => err.push(line),
    setExitCode: (code) => exitCodes.push(code),
    exit: (code) => exits.push(code),
    onSignal: (signal, handler) => signals.set(signal, handler),
    transport: async () => {
      throw new Error('no decision transport in this test');
    },
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
    getuid: overrides.getuid === undefined ? () => 1000 : overrides.getuid,
    startProcess: agents.start,
  });
  return { outcome, out, err, exitCodes, exits, signals, link, agents };
}

function inDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  return withTempDir('serve', body);
}

async function writePairedCredential(dir: string, hostId: string): Promise<void> {
  await writeFile(
    join(dir, 'paired-credential.json'),
    JSON.stringify({ hostId, credential: `p1.${hostId}.a-secret` }),
    'utf8',
  );
}

async function writeTokenCache(
  dir: string,
  tokens: { expiresAt: number; refreshToken: string | null },
): Promise<void> {
  await writeFile(
    join(dir, 'token-cache.json'),
    JSON.stringify({
      tokens: {
        accessToken: 'an-access-token',
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        tokenType: 'Bearer',
        scope: 'openid',
      },
      protocol: 'loopback',
      authority: AUTHORITY,
      clientId: CLIENT_ID,
    }),
    'utf8',
  );
}

const refused = (run: Run): string => (run.outcome.ok ? '' : run.outcome.detail);

// --- refusals, in order -------------------------------------------------------

test('running as root is refused before anything is read, naming the container fix', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: 'a config problem that must not be reached' }, { getuid: () => 0 });

    assert.equal(run.outcome.ok, false);
    assert.match(refused(run), /refusing to start as root/);
    assert.match(refused(run), /USER line/);
    assert.deepEqual(run.err, [`periscope: ${refused(run)}`]);
    assert.deepEqual(run.exitCodes, [1]);
    assert.equal(run.link.handlers, null, 'no link may be built for a host that cannot spawn');
  }));

test('control: a platform with no uid (win32) is not root, and a non-zero uid is not root', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    for (const getuid of [null, () => 1000]) {
      const run = serve({ raw, merged: mergedEnv(raw) }, { getuid });
      assert.equal(run.outcome.ok, true, run.err.join('\n'));
    }
  }));

test('a config file that cannot be used is fatal, reported after the root check', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: 'the config file at /cfg/config.json is not JSON' });

    assert.equal(run.outcome.ok, false);
    assert.deepEqual(run.err, ['periscope: the config file at /cfg/config.json is not JSON']);
    assert.deepEqual(run.exitCodes, [1]);
  }));

test('a missing controller URL is refused by name', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    for (const merged of [
      mergedEnv(raw, { PERISCOPE_CONTROLLER_URL: '' }),
      { ...raw, PERISCOPE_DECISION_URL: 'http://127.0.0.1:1/decision' },
    ]) {
      const run = serve({ raw, merged });
      assert.equal(refused(run), 'PERISCOPE_CONTROLLER_URL is not set');
      assert.deepEqual(run.exitCodes, [1]);
    }
  }));

test('a missing decision URL is refused with the reason neither default is survivable', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: mergedEnv(raw, { PERISCOPE_DECISION_URL: '' }) });

    assert.match(refused(run), /^PERISCOPE_DECISION_URL is not set/);
    assert.match(refused(run), /open door/);
    assert.equal(run.link.handlers, null);
  }));

test('the workspace posture is screened at start-up, by name', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: mergedEnv(raw, { PERISCOPE_WORKSPACE_KEY: 'shared' }) });

    assert.match(refused(run), /PERISCOPE_WORKSPACE_KEY is set but PERISCOPE_WORKSPACE_ROOT is not/);
    assert.deepEqual(run.exitCodes, [1]);
    assert.equal(run.link.handlers, null, 'a host that would refuse every session must not dial');
  }));

test('a corrupt paired credential is fatal rather than a fallback to the OIDC postures', () =>
  inDir(async (dir) => {
    await writeFile(join(dir, 'paired-credential.json'), 'not JSON', 'utf8');
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: mergedEnv(raw) });

    assert.equal(run.outcome.ok, false);
    assert.match(run.err.join('\n'), /^periscope: /);
    assert.doesNotMatch(
      run.out.join('\n'),
      /\[credential\] absent/,
      'a corrupt file must never read as anonymity',
    );
  }));

test('an identity that is configured wrong is fatal, never degraded to absent', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir, {
      PERISCOPE_IDENTITY_AUTHORITY: 'http://plaintext.example',
      PERISCOPE_IDENTITY_CLIENT_ID: CLIENT_ID,
    });
    const run = serve({ raw, merged: mergedEnv(raw) });

    assert.equal(run.outcome.ok, false);
    assert.match(refused(run), /must be https/);
    assert.doesNotMatch(run.out.join('\n'), /\[credential\] absent/);
  }));

// --- the posture lines ------------------------------------------------------------

test('the absent posture is said once at start-up, and the host dials', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: mergedEnv(raw) });

    assert.equal(run.outcome.ok, true, run.err.join('\n'));
    const postures = run.out.filter((line) => line.includes('[credential]'));
    assert.equal(postures.length, 1, run.out.join('\n'));
    assert.match(postures[0] ?? '', /\[credential\] absent - no identity is configured/);
    assert.equal(run.link.started, true, 'the host must start its link');
    assert.deepEqual(run.exitCodes, []);
    assert.deepEqual(run.err, []);
  }));

test('the paired posture names the host id the credential is bound to, and it wins over the configured one', () =>
  inDir(async (dir) => {
    await writePairedCredential(dir, 'ph-paired');
    const raw = rawEnv(dir, { PERISCOPE_HOST_ID: 'configured-host' });
    const run = serve({ raw, merged: mergedEnv(raw) });

    assert.equal(run.outcome.ok, true, run.err.join('\n'));
    const postures = run.out.filter((line) => line.includes('[credential]'));
    assert.equal(postures.length, 2, run.out.join('\n'));
    assert.match(postures[0] ?? '', /\[credential\] paired as ph-paired/);
    assert.match(
      postures[1] ?? '',
      /PERISCOPE_HOST_ID \('configured-host'\) is overridden by the paired credential's host id \('ph-paired'\)/,
    );
  }));

test('control: the override line is silent when the environment never named a host id', () =>
  inDir(async (dir) => {
    await writePairedCredential(dir, 'ph-paired');
    // The merged view carries a host id (from a config file, say); the raw one does not.
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: mergedEnv(raw) });

    assert.equal(run.outcome.ok, true);
    assert.doesNotMatch(
      run.out.join('\n'),
      /is overridden by/,
      'nothing was silently ignored, so nothing is said',
    );
    assert.match(run.out.join('\n'), /paired as ph-paired/);
  }));

test('control: the override line is silent when the two host ids agree', () =>
  inDir(async (dir) => {
    await writePairedCredential(dir, 'configured-host');
    const raw = rawEnv(dir, { PERISCOPE_HOST_ID: 'configured-host' });
    const run = serve({ raw, merged: mergedEnv(raw) });

    assert.equal(run.outcome.ok, true);
    assert.doesNotMatch(run.out.join('\n'), /is overridden by/);
  }));

test('the configured posture says nothing at start-up: the outcome is reported at the first dial', () =>
  inDir(async (dir) => {
    await writeTokenCache(dir, { expiresAt: Date.now() + 60 * 60 * 1000, refreshToken: 'r' });
    const raw = rawEnv(dir, {
      PERISCOPE_IDENTITY_AUTHORITY: AUTHORITY,
      PERISCOPE_IDENTITY_CLIENT_ID: CLIENT_ID,
    });
    const run = serve({ raw, merged: mergedEnv(raw) });

    assert.equal(run.outcome.ok, true, run.err.join('\n'));
    assert.deepEqual(
      run.out.filter((line) => line.includes('[credential]')),
      [],
    );
    assert.equal(run.link.started, true);
  }));

test('the configured posture reports each authorization outcome on the credential line', () =>
  inDir(async (dir) => {
    const lines: string[] = [];
    const log = (channel: string, message: string, detail: string | null): void => {
      lines.push(`[${channel}] ${message}${detail === null ? '' : ` / ${detail}`}`);
    };
    const env = rawEnv(dir, {
      PERISCOPE_IDENTITY_AUTHORITY: AUTHORITY,
      PERISCOPE_IDENTITY_CLIENT_ID: CLIENT_ID,
      // Explicit endpoints, so no discovery; the token endpoint answers nothing, so a refresh is a
      // transport refusal rather than a network conversation.
      PERISCOPE_IDENTITY_AUTHORIZE_URL: 'http://127.0.0.1:1/authorize',
      PERISCOPE_IDENTITY_TOKEN_URL: 'http://127.0.0.1:1/token',
    });

    // A fresh token: presented from the cache.
    await writeTokenCache(dir, { expiresAt: Date.now() + 60 * 60 * 1000, refreshToken: 'r' });
    const fresh = readCredential(env, log) as CredentialPosture;
    assert.equal(fresh.pairedHostId, null);
    assert.ok(fresh.credential !== null);
    assert.equal((await fresh.credential.authorize()).ok, true);
    assert.deepEqual(lines, ['[credential] cache-hit']);

    // An expired token with no refresh token: refused by name, with the detail.
    lines.length = 0;
    await writeTokenCache(dir, { expiresAt: 1_000, refreshToken: null });
    const stale = readCredential(env, log) as CredentialPosture;
    assert.ok(stale.credential !== null);
    assert.equal((await stale.credential.authorize()).ok, false);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /^\[credential\] refused — token-unavailable \//);

    // An expired token with a refresh token: the refresh runs against the stated endpoint and its
    // failure is reported as the transient it is.
    lines.length = 0;
    await writeTokenCache(dir, { expiresAt: 1_000, refreshToken: 'r' });
    const refreshing = readCredential(env, log) as CredentialPosture;
    assert.ok(refreshing.credential !== null);
    assert.equal((await refreshing.credential.authorize()).ok, false);
    assert.match(lines[0] ?? '', /^\[credential\] refused — token-request-failed \//);
  }));

test('configured identity with nowhere to keep the cache is the named refusal', () =>
  inDir(async (dir) => {
    // The paired file is looked for in the config dir; the cache path derives from the same dir, so
    // the "nowhere" branch needs a home the derivation cannot resolve. Reachable only on a machine
    // with no home at all, which is why the posture reader is exercised directly here.
    const log = (): void => {};
    const configured = readCredential(
      rawEnv(dir, { PERISCOPE_IDENTITY_AUTHORITY: AUTHORITY, PERISCOPE_IDENTITY_CLIENT_ID: CLIENT_ID }),
      log,
    );
    assert.notEqual(typeof configured, 'string', 'with a config dir there is somewhere to keep the cache');
  }));

// --- the fatal path -----------------------------------------------------------------

test('regression: credential_rejected writes the remedy, latches exit 1, stops the host and schedules the exit', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: mergedEnv(raw) });
    assert.equal(run.outcome.ok, true);

    run.link.transition('credential_rejected', 'the provider refused the grant');

    assert.equal(run.err.length, 1, run.err.join('\n'));
    assert.match(
      run.err[0] ?? '',
      /^periscope: the controller or its identity provider refused this credential \(0 live session\(s\) stopped\) - run: periscope login, then start this host again$/,
    );
    assert.deepEqual(run.exitCodes, [1]);
    assert.equal(run.link.stopped, true, 'the host must stop, link included');
    assert.match(
      run.out.join('\n'),
      /\[link\] connecting -> closed \(credential_rejected\) — the provider refused the grant/,
    );

    assert.deepEqual(run.exits, [], 'the exit is scheduled, not immediate: the pipes need the flush window');
    await new Promise((resolve) => setTimeout(resolve, FATAL_EXIT_FLUSH_MS + 40));
    assert.deepEqual(run.exits, [1]);
  }));

test('the fatal remedy for a paired host is re-pairing, never login', () =>
  inDir(async (dir) => {
    await writePairedCredential(dir, 'ph-paired');
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: mergedEnv(raw) });
    assert.equal(run.outcome.ok, true);

    run.link.transition('credential_rejected', 'link-unauthorized');

    assert.match(run.err[0] ?? '', /periscope pair <code>/);
    assert.doesNotMatch(run.err[0] ?? '', /periscope login/);
    await new Promise((resolve) => setTimeout(resolve, FATAL_EXIT_FLUSH_MS + 40));
    assert.deepEqual(run.exits, [1]);
  }));

test('the fatal line counts the live sessions it cut', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: mergedEnv(raw) });
    assert.equal(run.outcome.ok, true);

    run.link.deliver('handle-1', sessionNew(dir));
    await settle();
    assert.equal(run.agents.started.length, 1, 'the injected starter must have been used');
    // A session counts as live once the agent has reported itself; before that it is provisioning.
    run.agents.started[0]?.emit(initMessage('agent-1'));
    await settle();

    run.link.transition('credential_rejected', 'the provider refused the grant');

    assert.match(run.err[0] ?? '', /\(1 live session\(s\) stopped\)/);
    assert.equal(run.agents.started[0]?.closed(), true, 'the session must be stopped with the host');
    await new Promise((resolve) => setTimeout(resolve, FATAL_EXIT_FLUSH_MS + 40));
    assert.deepEqual(run.exits, [1]);
  }));

test('control: every other link cause is an observation, never an exit', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: mergedEnv(raw) });

    run.link.transition('socket_error', 'ECONNREFUSED');
    run.link.transition('credential_unavailable', 'no token');

    assert.deepEqual(run.err, []);
    assert.deepEqual(run.exitCodes, []);
    assert.equal(run.link.stopped, false);
    await new Promise((resolve) => setTimeout(resolve, FATAL_EXIT_FLUSH_MS + 40));
    assert.deepEqual(run.exits, []);
  }));

// --- signals -------------------------------------------------------------------------------

test('SIGTERM and SIGINT stop the host and record a clean exit', () =>
  inDir(async (dir) => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const raw = rawEnv(dir);
      const run = serve({ raw, merged: mergedEnv(raw) });
      const handler = run.signals.get(signal);
      assert.ok(handler !== undefined, `${signal} is not subscribed`);

      handler();

      assert.equal(run.link.stopped, true);
      assert.deepEqual(run.exitCodes, [0]);
    }
  }));

test('regression: a signal after a fatal refusal does not reset the latched exit code', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: mergedEnv(raw) });

    run.link.transition('credential_rejected', 'refused');
    run.signals.get('SIGTERM')?.();

    assert.deepEqual(run.exitCodes, [1], 'the stop must not be read as evidence the run was fine');
    await new Promise((resolve) => setTimeout(resolve, FATAL_EXIT_FLUSH_MS + 40));
  }));

// --- the trace ------------------------------------------------------------------------------

test('every host event renders as one trace line on its channel', () => {
  const lines: string[] = [];
  const log = (channel: string, message: string, detail: string | null): void => {
    lines.push(`[${channel}] ${message}${detail === null ? '' : ` — ${detail}`}`);
  };
  const events: HostEvent[] = [
    {
      kind: 'link',
      transition: { from: 'idle', to: 'connecting', cause: 'start_requested', at: 'now', detail: null },
    },
    { kind: 'refusal', refusal: refusal('session-unknown', 'no such handle'), sessionKey: 'h1' },
    { kind: 'refusal', refusal: refusal('frame-malformed', 'bad frame'), sessionKey: null },
    { kind: 'gap', sessionKey: 'h1', expected: 3, received: 5 },
    { kind: 'session-opened', sessionKey: 'h1', cwd: '/work' },
    { kind: 'session-closed', sessionKey: 'h1' },
    { kind: 'prompt-held', sessionKey: 'h1', held: 1 },
    { kind: 'prompt-delivered', sessionKey: 'h1', delivered: 1 },
    { kind: 'prompt-withdrawn', sessionKey: 'h1', withdrawn: 1 },
    {
      kind: 'transition',
      sessionKey: 'h1',
      transition: {
        sessionId: 'agent-1',
        seq: 2,
        at: 'now',
        from: 'idle',
        to: 'working',
        activity: null,
        entryId: null,
        cause: { kind: 'control', event: 'prompt_submitted', detail: 'a turn' },
        where: { cwd: '/work', worktree: null, branch: null, unknownReason: null },
        correlationId: null,
      },
    },
    {
      kind: 'degrade',
      sessionKey: 'h1',
      degrade: { kind: 'workspace_untrusted', detail: 'rules void', at: 'now' },
    },
  ];
  for (const event of events) report(event, log);

  assert.deepEqual(lines, [
    '[link] idle -> connecting (start_requested)',
    '[refused] h1: session-unknown — no such handle',
    '[refused] link: frame-malformed — bad frame',
    '[gap] h1 expected 3, received 5',
    '[session] h1 opened in /work',
    '[session] h1 closed',
    '[held] h1 a turn waits for the session to open — 1 held',
    '[held] h1 held turns delivered — 1 delivered',
    '[held] h1 the controller cancelled before the session opened — 1 withdrawn',
    '[state] h1 idle -> working (control/prompt_submitted) — a turn',
    '[degrade] h1 workspace_untrusted — rules void',
  ]);
});

test('the agent home is read from the merged view: a relative one refuses by name before the dial, an absolute one from the file alone is honoured', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);

    const relative = serve({ raw, merged: mergedEnv(raw, { PERISCOPE_AGENT_HOME: 'agent/here' }) });
    assert.match(refused(relative), /PERISCOPE_AGENT_HOME must be an absolute path/);
    assert.deepEqual(relative.exitCodes, [1]);
    assert.equal(relative.link.handlers, null, 'a host with a home relative to nothing must not dial');

    // Set in the config-file view only (the raw environment never names it): the merged read is
    // what lets `host_configure` and `periscope config` govern the same value.
    const absolute = serve({ raw, merged: mergedEnv(raw, { PERISCOPE_AGENT_HOME: join(dir, 'agent') }) });
    assert.equal(absolute.outcome.ok, true, absolute.err.join('\n'));
    assert.equal(absolute.link.started, true, 'an absolute agent home must not stop the dial');
    assert.deepEqual(absolute.exitCodes, []);
    assert.equal(
      absolute.out.some((line) => line.includes('deprecated')),
      false,
      'nothing deprecated was configured',
    );
  }));

test('a merged view carrying PERISCOPE_TRANSCRIPTS_ROOT configures nothing: the transcripts root derives from the agent home', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    const run = serve({
      raw,
      merged: mergedEnv(raw, { PERISCOPE_TRANSCRIPTS_ROOT: join(dir, 'old-projects') }),
    });

    assert.equal(run.outcome.ok, true, run.err.join('\n'));
    assert.equal(run.link.started, true);
    assert.equal(
      run.out.some((line) => line.includes('PERISCOPE_TRANSCRIPTS_ROOT')),
      false,
      'the retired key is not named; it is not read',
    );
  }));

test('a controller URL that is not ws(s), or a decision URL that is not http(s), is refused at boot by name', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    const https = serve({
      raw,
      merged: mergedEnv(raw, { PERISCOPE_CONTROLLER_URL: 'https://c.example/link' }),
    });
    assert.match(refused(https), /PERISCOPE_CONTROLLER_URL must use ws or wss/);
    const ws = serve({ raw, merged: mergedEnv(raw, { PERISCOPE_DECISION_URL: 'ws://c.example/decision' }) });
    assert.match(refused(ws), /PERISCOPE_DECISION_URL must use http or https/);
    assert.equal(https.link.started || ws.link.started, false, 'nothing dials on a refused address');
  }));

test('an empty PERISCOPE_HOST_ID counts as unset: the hostname is announced', () =>
  inDir(async (dir) => {
    const raw = rawEnv(dir);
    const run = serve({ raw, merged: mergedEnv(raw, { PERISCOPE_HOST_ID: '' }) });
    assert.equal(run.outcome.ok, true, run.err.join('\n'));
    const host = run.out.find((line) => line.includes('[host]')) ?? '';
    assert.doesNotMatch(host, /host\s+·/, 'an empty host id must not be announced as nothing');
    assert.match(
      host,
      /^\S+ \[host\] periscope \S+ · host \S+/,
      'the host line names the version and a host id',
    );
  }));
