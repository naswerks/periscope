/**
 * THE TRANSCRIPTS PIN: the runner does not look for, read or keep the agent's transcript files, and
 * the bulk lane stays whole without them.
 *
 * Each half with its own instrument:
 *   - the source: nothing the binary composes names a transcript reader, and the inert names a reader
 *     exported are reached only through the host barrel that keeps them importable;
 *   - the binary's composition, driven: the host `runServe` builds answers `transcript_list`,
 *     `transcript_tail` and a `claude-transcript:` `bulk_request` with `transcripts-not-served`,
 *     composes no bulk resolver at all, and reports no transcripts root in the hello;
 *   - the read doors of that composition: with the repository root at the agent home or at the
 *     user's home, a transcript file is neither read nor listed, and what sits beside it is served
 *     as before;
 *   - the lane: a host given a resolver of the embedder's still delivers through the bulk POST, and
 *     still answers the transcript namespace before that resolver is asked.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import type {
  HostConfiguration,
  RepositoryListResult,
  RepositoryReadResult,
  SessionFrame,
  SessionPayload,
} from '../control/frames.js';
import {
  TRANSCRIPT_WHAT_PREFIX,
  repositoryList,
  repositoryRead,
  transcriptList,
  transcriptTail,
} from '../control/frames.js';
import type { LinkHandlers } from '../control/link.js';
import { PeriscopeHost } from '../host/host.js';
import type { HostLink } from '../host/host.js';
import { runServe } from '../bin/serve.js';
import { SessionRegistry } from '../sessions/registry.js';
import { fakeAgents, settle } from '../test-support/fake-agent.js';
import { withTempDir } from '../test-support/temp-dir.js';
import { allFiles, sourceFiles } from './walk.js';

/** The names a transcript reader exported; each is inert, and nothing the binary runs may call one. */
const READER_NAMES = [
  'claudeTranscriptResolver',
  'listTranscripts',
  'tailTranscript',
  'resolveTranscriptPath',
  'transcriptsRootUnder',
  'claudeProjectsRoot',
  'isMatchingUserEntry',
] as const;

/** The module that keeps those names importable, and the one barrel allowed to re-export it. */
const INERT_MODULE = 'host/transcripts-not-served.ts';
const INERT_IMPORTERS = new Set(['host/index.ts']);

/** Comments removed, so prose about a reader is not a call of one. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Each shipped file that names a reader in code, or imports the inert module, other than its barrel. */
function readerReferences(files: readonly { path: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (file.path === INERT_MODULE) continue;
    const code = withoutComments(file.text);
    if (/from\s*['"][./]*(?:host\/)?transcripts-not-served\.js['"]/.test(code)) {
      if (!INERT_IMPORTERS.has(file.path)) found.push(`${file.path} imports the inert transcript module`);
      continue;
    }
    for (const name of READER_NAMES) {
      if (new RegExp(`\\b${name}\\b`).test(code)) found.push(`${file.path} names ${name}`);
    }
  }
  return found;
}

test('regression: nothing the package ships names a transcript reader, and only the host barrel reaches the inert names', () => {
  const files = sourceFiles();
  assert.ok(
    files.some((file) => file.path === 'bin/serve.ts'),
    'the walk missed the composition root; it proves nothing',
  );
  assert.ok(
    files.some((file) => file.path === INERT_MODULE),
    'the inert module is gone, so its names left the public API; that is the next major version',
  );
  assert.deepEqual(readerReferences(files), []);
  // The claude resolver is not merely unused: no file under src/ defines one that reads.
  assert.equal(
    allFiles().some((file) => file.path === 'host/claude-transcripts.ts'),
    false,
    'a transcript reader is back in the tree',
  );
});

test('control: the scanner fires on a composition that wires a transcript reader, and not on prose', () => {
  assert.deepEqual(
    readerReferences([
      {
        path: 'bin/serve.ts',
        text: "import { claudeTranscriptResolver } from '../host/index.js';\nconst bulk = claudeTranscriptResolver(root);",
      },
    ]),
    ['bin/serve.ts names claudeTranscriptResolver'],
  );
  assert.deepEqual(
    readerReferences([
      {
        path: 'bin/reconfigure.ts',
        text: "import { listTranscripts } from '../host/transcripts-not-served.js';",
      },
    ]),
    ['bin/reconfigure.ts imports the inert transcript module'],
  );
  assert.deepEqual(
    readerReferences([{ path: 'host/host.ts', text: '// listTranscripts once answered here\nconst x = 1;' }]),
    [],
  );
});

// ---------------------------------------------------------------------------
// The binary's composition, driven.
// ---------------------------------------------------------------------------

/** The link the binary's host is handed: it records what is sent and what the next hello declares. */
class RecordingLink implements HostLink {
  readonly sent: { sessionId: string; payload: SessionPayload }[] = [];
  handlers: LinkHandlers | null = null;
  started = false;
  announced: HostConfiguration | null = null;

  send(sessionId: string, payload: SessionPayload): Result<void> {
    this.sent.push({ sessionId, payload });
    return ok(undefined);
  }

  start(): void {
    this.started = true;
  }

  stop(): void {}

  forgetSession(): void {}

  announce(_capabilities: readonly string[], configuration: HostConfiguration): void {
    this.announced = configuration;
  }

  deliver(sessionId: string, seq: number, payload: SessionPayload): void {
    const frame: SessionFrame = { frame: 'session', sessionId, seq, at: new Date().toISOString(), payload };
    this.handlers?.onSessionFrame(frame);
  }
}

/** Every refusal the host answered, as `id: reason`, in the order it answered. */
function refusalsOn(link: RecordingLink): string[] {
  return link.sent.flatMap(({ payload }) => {
    if (payload.kind === 'transcript_failed') return [`${payload.requestId}: ${payload.refusal.reason}`];
    if (payload.kind === 'bulk_failed') return [`${payload.deliveryId}: ${payload.refusal.reason}`];
    return [];
  });
}

/** A user home whose agent home holds a transcript, a settings file beside it, and a sign-in. */
async function plantHome(dir: string): Promise<string> {
  const home = join(dir, 'home');
  await mkdir(join(home, '.claude', 'projects', 'C--work-repo'), { recursive: true });
  await writeFile(
    join(home, '.claude', 'projects', 'C--work-repo', 'session-1.jsonl'),
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })}\n`,
    'utf8',
  );
  await writeFile(join(home, '.claude', 'settings.json'), '{"theme":"dark"}\n', 'utf8');
  await writeFile(join(home, '.claude', '.credentials.json'), '{}\n', 'utf8');
  return home;
}

/** The binary, started over `home` with the merged view's extra keys, on a recording link. */
async function serveOver(
  dir: string,
  home: string,
  extra: NodeJS.ProcessEnv = {},
): Promise<{ readonly link: RecordingLink; readonly stop: () => void }> {
  // The host's own credential directory beside the home, not above it: above, it would protect the
  // whole home and hide what the transcript folders refuse.
  const raw: NodeJS.ProcessEnv = { PERISCOPE_CONFIG_DIR: join(dir, 'config'), HOME: home, USERPROFILE: home };
  const merged: NodeJS.ProcessEnv = {
    ...raw,
    PERISCOPE_CONTROLLER_URL: 'ws://127.0.0.1:1/link',
    PERISCOPE_DECISION_URL: 'http://127.0.0.1:1/decision',
    PERISCOPE_HOST_ID: 'transcripts-pin',
    ...extra,
  };
  const link = new RecordingLink();
  const outcome = runServe(
    { raw, merged },
    {
      log: () => undefined,
      stderr: () => undefined,
      setExitCode: () => undefined,
      exit: () => undefined,
      onSignal: () => undefined,
      transport: () => Promise.reject(new Error('no decision transport in this pin')),
      link: (handlers) => {
        link.handlers = handlers;
        return link;
      },
      getuid: () => 1000,
      startProcess: fakeAgents().start,
      readAgentCatalog: () => Promise.resolve({ ok: false, detail: 'no catalog in this pin' }),
    },
  );
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail);
  for (let turn = 0; turn < 20 && !link.started; turn += 1) await settle();
  assert.ok(link.started, 'the binary never started its link');
  return { link, stop: () => (outcome.ok ? outcome.host.stop('the pin is over') : undefined) };
}

test('regression: the binary composes no transcript reader: the three transcript asks answer transcripts-not-served, no other locator resolves, and the hello reports no transcripts root', () =>
  withTempDir('transcripts-not-served', async (dir) => {
    // A transcript where the default agent home keeps them, so a reader that came back would find it.
    const home = await plantHome(dir);
    const { link, stop } = await serveOver(dir, home);
    try {
      link.deliver('discovery', 1, transcriptList('ask-list'));
      link.deliver('discovery', 2, transcriptTail('ask-tail', 'C--work-repo', 'session-1', 0));
      const pull = (deliveryId: string, what: string): SessionPayload => ({
        kind: 'bulk_request',
        deliveryId,
        what,
        fromOffset: 0,
        postUrl: 'http://127.0.0.1:1/bulk',
      });
      link.deliver(
        'discovery',
        3,
        pull('pull-transcript', `${TRANSCRIPT_WHAT_PREFIX}C--work-repo/session-1`),
      );
      link.deliver('discovery', 4, pull('pull-other', 'notes:readme'));
      await settle();

      assert.deepEqual(refusalsOn(link), [
        'ask-list: transcripts-not-served',
        'ask-tail: transcripts-not-served',
        'pull-transcript: transcripts-not-served',
        'pull-other: bulk-target-invalid',
      ]);
      const other = link.sent.find(
        ({ payload }) => payload.kind === 'bulk_failed' && payload.deliveryId === 'pull-other',
      );
      assert.match(
        other?.payload.kind === 'bulk_failed' ? other.payload.refusal.detail : '',
        /resolves no bulk content/,
        'the binary composed a bulk resolver',
      );
      assert.ok(link.announced !== null, 'the hello was never announced');
      assert.equal(link.announced.transcriptsRoot, null, 'the hello reports a transcripts root');
      assert.equal(link.announced.agentHome, join(home, '.claude'), 'the agent home is still reported');
    } finally {
      stop();
    }
  }));

/** Every repository answer the host sent, by request id, once `count` of them have arrived. */
async function repositoryAnswers(
  link: RecordingLink,
  count: number,
): Promise<Map<string, RepositoryListResult | RepositoryReadResult>> {
  const answers = (): (RepositoryListResult | RepositoryReadResult)[] =>
    link.sent.flatMap(({ payload }) =>
      payload.kind === 'repository_list_result' || payload.kind === 'repository_read_result' ? [payload] : [],
    );
  for (let turn = 0; turn < 500 && answers().length < count; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return new Map(answers().map((answer) => [answer.requestId, answer]));
}

test('regression: the read doors refuse the agent transcript files whatever their root: a root at the agent home or the user home neither reads nor lists them, and what sits beside them is served as before', () =>
  withTempDir('transcripts-read-doors', async (dir) => {
    const home = await plantHome(dir);
    const roots = [
      { root: join(home, '.claude'), under: '' },
      { root: home, under: '.claude/' },
    ];
    for (const { root, under } of roots) {
      const { link, stop } = await serveOver(dir, home, {
        PERISCOPE_WORKSPACE_ROOT: join(dir, 'workspaces'),
        PERISCOPE_REPOSITORY_ROOT: root,
      });
      try {
        link.deliver(
          'discovery',
          1,
          repositoryRead('read-transcript', `${under}projects/C--work-repo/session-1.jsonl`),
        );
        link.deliver('discovery', 2, repositoryList('list-projects', `${under}projects`));
        link.deliver('discovery', 3, repositoryList('list-home', under === '' ? '' : '.claude'));
        link.deliver('discovery', 4, repositoryRead('read-settings', `${under}settings.json`));
        link.deliver('discovery', 5, repositoryRead('read-sign-in', `${under}.credentials.json`));
        const answers = await repositoryAnswers(link, 5);
        const at = `with the root at ${root}`;

        const transcript = answers.get('read-transcript');
        assert.equal(
          transcript?.refusal?.reason,
          'transcripts-not-served',
          `a transcript file was read ${at}`,
        );
        assert.equal(transcript?.kind === 'repository_read_result' ? transcript.text : 'none', null);
        assert.equal(
          answers.get('list-projects')?.refusal?.reason,
          'transcripts-not-served',
          `the transcript folder was listed ${at}`,
        );
        const listed = answers.get('list-home');
        assert.equal(listed?.refusal, null, `the agent home itself is listed ${at}`);
        const names =
          listed?.kind === 'repository_list_result' ? listed.entries.map((entry) => entry.name) : [];
        assert.ok(
          !names.includes('projects'),
          `the listing names the transcript folder ${at}: ${names.join(', ')}`,
        );
        assert.ok(
          names.includes('settings.json'),
          `the listing lost what sits beside it ${at}: ${names.join(', ')}`,
        );

        // Control: beside the transcripts, the doors behave exactly as before.
        const settings = answers.get('read-settings');
        assert.equal(settings?.refusal, null, `a settings file beside the transcripts was refused ${at}`);
        assert.equal(
          settings?.kind === 'repository_read_result' ? settings.text : null,
          '{"theme":"dark"}\n',
        );
        assert.equal(answers.get('read-sign-in')?.refusal?.reason, 'credential-path-denied');
      } finally {
        stop();
      }
    }
  }));

// ---------------------------------------------------------------------------
// The lane, with a resolver of the embedder's.
// ---------------------------------------------------------------------------

test("the bulk lane stays whole: an embedder's resolver delivers through the bulk POST, and the transcript namespace never reaches it", () =>
  withTempDir('bulk-lane-whole', async (dir) => {
    const file = join(dir, 'readme.txt');
    await writeFile(file, 'the bytes the resolver names\n', 'utf8');

    const received: Buffer[] = [];
    const receiver = createServer((request, response) => {
      request.on('data', (chunk: Buffer) => received.push(chunk));
      request.on('end', () => {
        response.statusCode = 200;
        response.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const port = (receiver.address() as AddressInfo).port;

    const link = new RecordingLink();
    const asked: string[] = [];
    const host = new PeriscopeHost({
      // The bulk POST may go only to the controller's own origin, so the receiver stands at it.
      controllerUrl: `ws://127.0.0.1:${port}/link`,
      hostId: 'bulk-lane-pin',
      decide: () => Promise.resolve({ behavior: 'allow' }),
      protectedPaths: [],
      registry: new SessionRegistry({ baseEnv: {}, homeDir: dir }),
      link: (handlers) => {
        link.handlers = handlers;
        return link;
      },
      bulk: (what) => {
        asked.push(what);
        return ok(file);
      },
    });
    try {
      host.start();
      const pull = (deliveryId: string, what: string): SessionPayload => ({
        kind: 'bulk_request',
        deliveryId,
        what,
        fromOffset: 0,
        postUrl: `http://127.0.0.1:${port}/bulk/${deliveryId}`,
      });
      link.deliver('session-1', 1, pull('d-transcript', `${TRANSCRIPT_WHAT_PREFIX}C--work-repo/session-1`));
      link.deliver('session-1', 2, pull('d-notes', 'notes:readme'));
      for (let turn = 0; turn < 200; turn += 1) {
        if (link.sent.some(({ payload }) => payload.kind === 'bulk_delivered')) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.deepEqual(refusalsOn(link), ['d-transcript: transcripts-not-served']);
      assert.deepEqual(asked, ['notes:readme'], 'the transcript locator reached the resolver');
      const delivered = link.sent.find(({ payload }) => payload.kind === 'bulk_delivered');
      assert.ok(delivered !== undefined, 'the lane delivered nothing');
      assert.equal(
        delivered.payload.kind === 'bulk_delivered' ? delivered.payload.deliveryId : '',
        'd-notes',
      );
      assert.equal(Buffer.concat(received).toString('utf8'), await readFile(file, 'utf8'));
    } finally {
      host.stop('the pin is over');
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  }));
