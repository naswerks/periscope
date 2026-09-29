/**
 * The hello's model catalog: the read that asks the agent for its models without calling one, the
 * bounds that keep a catalog from costing the controller the whole hello, and the host's promise
 * that the first hello already carries it.
 *
 * Whether a real agent answers the read with no prompt sent, and leaves no transcript behind, is a
 * live probe's question; this file holds the package's own handling of whatever the agent answers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { hostAgentProblem } from '../control/codec.js';
import type { HostAgent, HostConfiguration, HostModel, SessionPayload } from '../control/frames.js';
import {
  MAX_AGENT_CATALOG_BYTES,
  MAX_AGENT_MODELS,
  hostConfigure,
  unsetHostConfiguration,
} from '../control/frames.js';
import type { LinkHandlers } from '../control/link.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import { SessionRegistry } from '../sessions/registry.js';
import { fakeAgents } from '../test-support/fake-agent.js';
import type { AgentCatalog, CatalogQuery, StartCatalogQuery } from './agent-process.js';
import { readAgentCatalogWith } from './agent-process.js';
import type { HostEvent, HostLink } from './host.js';
import { PeriscopeHost } from './host.js';
import { agentSdkFacts } from './package-facts.js';

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const MODEL: HostModel = {
  value: 'alias-1',
  resolvedModel: 'model-id-1',
  displayName: 'Model One',
  description: 'The first model',
  supportedEffortLevels: ['low', 'high'],
  supportsFastMode: true,
  supportsAutoMode: false,
  supportsAdaptiveThinking: true,
};

const AGENT: HostAgent = { claudeCodeVersion: '2.1.284', sdkVersion: '0.3.284', models: [MODEL] };

// --- the read ---------------------------------------------------------------

/** A starter that records what it was asked and how often its query was closed. */
function starter(answer: () => Promise<{ readonly models?: readonly unknown[] }>): {
  readonly start: StartCatalogQuery;
  readonly asked: Parameters<StartCatalogQuery>[0][];
  closes: number;
} {
  const record = {
    asked: [] as Parameters<StartCatalogQuery>[0][],
    closes: 0,
    start: ((params) => {
      record.asked.push(params);
      const query: CatalogQuery = {
        initializationResult: answer as CatalogQuery['initializationResult'],
        close: () => {
          record.closes += 1;
        },
      };
      return query;
    }) as StartCatalogQuery,
  };
  return record;
}

const OPTIONS = { env: { PATH: 'p' }, cwd: fileURLToPath(new URL('.', import.meta.url)), timeoutMs: 1_000 };

test('the catalog read maps the agent answer, with no settings, no MCP, no transcript, and closes once', async () => {
  const fake = starter(() =>
    Promise.resolve({
      models: [
        {
          value: 'alias-1',
          resolvedModel: 'model-id-1',
          displayName: 'Model One',
          description: 'The first model',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          supportsFastMode: true,
          supportsAutoMode: false,
          supportsAdaptiveThinking: true,
        },
        // Only what the SDK declares required: every optional member becomes null or empty.
        { value: 'model-id-2', displayName: 'Model Two', description: 'The second model' },
      ],
    }),
  );
  const facts = agentSdkFacts();
  assert.ok(facts !== null, 'the installed SDK manifest reads');

  const read = await readAgentCatalogWith(fake.start, OPTIONS);

  assert.deepEqual(read, {
    ok: true,
    agent: {
      claudeCodeVersion: facts.claudeCodeVersion,
      sdkVersion: facts.sdkVersion,
      models: [
        MODEL,
        {
          value: 'model-id-2',
          resolvedModel: null,
          displayName: 'Model Two',
          description: 'The second model',
          supportedEffortLevels: [],
          supportsFastMode: null,
          supportsAutoMode: null,
          supportsAdaptiveThinking: null,
        },
      ],
    },
  });
  assert.equal(fake.asked.length, 1);
  const options = fake.asked[0]!.options;
  assert.deepEqual(options.settingSources, [], 'no settings tier is loaded');
  assert.equal(options.strictMcpConfig, true, 'no MCP server is loaded');
  assert.equal(options.persistSession, false, 'the read leaves no transcript');
  assert.equal(options.cwd, OPTIONS.cwd);
  assert.deepEqual(options.env, OPTIONS.env);
  assert.equal(options.model, undefined, 'the read chooses no model');
  assert.equal(fake.closes, 1, 'closed exactly once');

  // No turn was ever offered: the prompt stream ends without yielding.
  const first = await fake.asked[0]!.prompt[Symbol.asyncIterator]().next();
  assert.equal(first.done, true, 'the prompt stream yielded a message');
});

test('a failed answer is a reading that says so, and the agent is still closed once', async () => {
  const fake = starter(() => Promise.reject(new Error('the agent exited')));
  const read = await readAgentCatalogWith(fake.start, OPTIONS);
  assert.deepEqual(read, { ok: false, detail: "the agent's answer to initialize failed: the agent exited" });
  assert.equal(fake.closes, 1);
});

test('an agent that never answers is given up on at the bound, closed once, and a late answer changes nothing', async () => {
  let answer: (value: { models: readonly unknown[] }) => void = () => undefined;
  const fake = starter(() => new Promise((resolve) => (answer = resolve)));
  const read = await readAgentCatalogWith(fake.start, { ...OPTIONS, timeoutMs: 20 });
  assert.deepEqual(read, { ok: false, detail: 'the agent did not answer within 20ms' });
  assert.equal(fake.closes, 1);

  answer({ models: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.closes, 1, 'a late answer closed the agent again');
});

test('an agent that cannot start is a reading that says so; there is nothing to close', async () => {
  const start: StartCatalogQuery = () => {
    throw new Error('spawn claude ENOENT');
  };
  const read = await readAgentCatalogWith(start, OPTIONS);
  assert.deepEqual(read, { ok: false, detail: 'the agent did not start: spawn claude ENOENT' });
});

test('a relative directory is refused before any agent starts', async () => {
  const fake = starter(() => Promise.resolve({ models: [] }));
  const read = await readAgentCatalogWith(fake.start, { ...OPTIONS, cwd: 'relative/dir' });
  assert.equal(read.ok, false);
  assert.equal(fake.asked.length, 0, 'an agent was started for a read that was already refused');
});

test('the SDK facts are the installed manifest, the same versions the contracts record', () => {
  const facts = agentSdkFacts();
  const recorded = (name: string): string => readFileSync(at(`../../contracts/${name}`), 'utf8').trim();
  assert.ok(facts !== null);
  assert.match(facts.sdkVersion, /^\d+\.\d+\.\d+$/, 'the facts read a version at all');
  assert.equal(facts.sdkVersion, recorded('sdk-version.txt'));
  assert.equal(facts.claudeCodeVersion, recorded('cli-version.txt'));
});

// --- the bounds ---------------------------------------------------------------

const models = (count: number, description: string): HostModel[] =>
  Array.from({ length: count }, (_, index) => ({ ...MODEL, value: `alias-${index}`, description }));

test('a catalog inside every bound rides the hello', () => {
  assert.equal(hostAgentProblem(AGENT), null);
  assert.equal(
    hostAgentProblem({ ...AGENT, models: models(MAX_AGENT_MODELS, 'short') }),
    null,
    'the model bound is inclusive',
  );
});

test('a catalog past a bound is named, whichever bound it is', () => {
  assert.match(hostAgentProblem({ ...AGENT, models: models(MAX_AGENT_MODELS + 1, 'short') }) ?? '', /models/);
  assert.match(hostAgentProblem({ ...AGENT, models: [{ ...MODEL, value: '' }] }) ?? '', /value/);
  assert.match(
    hostAgentProblem({ ...AGENT, models: [{ ...MODEL, description: 'x'.repeat(1001) }] }) ?? '',
    /description/,
  );
  // Every member inside its own bound, the whole past the budget: the bound the hello needs.
  const heavy = { ...AGENT, models: models(MAX_AGENT_MODELS, 'x'.repeat(900)) };
  assert.match(
    hostAgentProblem(heavy) ?? '',
    new RegExp(`over the ${MAX_AGENT_CATALOG_BYTES} a hello gives it`),
  );
});

// --- the host ---------------------------------------------------------------

/** A link that records the order of what the host asked of it. */
class OrderedLink implements HostLink {
  readonly calls: string[] = [];
  readonly sent: { sessionId: string; payload: SessionPayload }[] = [];
  announced: HostConfiguration | null = null;
  handlers: LinkHandlers | null = null;

  send(sessionId: string, payload: SessionPayload): Result<void> {
    this.sent.push({ sessionId, payload });
    return ok(undefined);
  }
  start(): void {
    this.calls.push('start');
  }
  stop(): void {
    this.calls.push('stop');
  }
  forgetSession(): void {}
  announce(_capabilities: readonly string[], configuration: HostConfiguration): void {
    this.calls.push('announce');
    this.announced = configuration;
  }
}

function hostWith(
  agentCatalog: (() => Promise<AgentCatalog>) | undefined,
  extra: { reconfigure?: boolean } = {},
) {
  const link = new OrderedLink();
  const events: HostEvent[] = [];
  const host = new PeriscopeHost({
    controllerUrl: 'ws://controller.invalid/link',
    hostId: 'host-1',
    decide: async () => ({ behavior: 'allow' }),
    protectedPaths: [],
    registry: new SessionRegistry({ baseEnv: {}, homeDir: '', startProcess: fakeAgents().start }),
    link: (handlers) => {
      link.handlers = handlers;
      return link;
    },
    report: (event) => events.push(event),
    ...(agentCatalog === undefined ? {} : { agentCatalog }),
    ...(extra.reconfigure === true
      ? {
          // Rebuilt from a file, which holds no catalog.
          reconfigure: () =>
            ok({
              workspaces: undefined,
              transcriptsRoot: undefined,
              bulk: undefined,
              linkCapabilities: [],
              configuration: unsetHostConfiguration(),
              pluginDirs: [],
              overriddenByEnvironment: [],
              pendingRestart: [],
            }),
        }
      : {}),
  });
  return { host, link, events };
}

function deferred(): { readonly promise: Promise<AgentCatalog>; resolve: (catalog: AgentCatalog) => void } {
  let resolve: (catalog: AgentCatalog) => void = () => undefined;
  const promise = new Promise<AgentCatalog>((settle) => (resolve = settle));
  return { promise, resolve: (catalog) => resolve(catalog) };
}

const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('with a catalog read, the link starts after it, and the first hello already carries the catalog', async () => {
  const read = deferred();
  const { host, link, events } = hostWith(() => read.promise);
  host.start();
  await drain();
  assert.deepEqual(link.calls, [], 'the link started before the catalog was read');

  read.resolve({ ok: true, agent: AGENT });
  await drain();
  assert.deepEqual(link.calls, ['announce', 'start'], 'the hello is stated first, then the link dials');
  assert.deepEqual(link.announced?.agent, AGENT);
  assert.deepEqual(
    events.filter((event) => event.kind === 'agent-catalog'),
    [{ kind: 'agent-catalog', agent: AGENT, detail: null }],
  );
  host.stop();
});

test('a stop before the read settles means the link never starts', async () => {
  const read = deferred();
  const { host, link } = hostWith(() => read.promise);
  host.start();
  host.stop();
  read.resolve({ ok: true, agent: AGENT });
  await drain();
  assert.equal(link.calls.includes('start'), false, 'a stopped host dialled');
  assert.equal(link.calls.includes('announce'), false);
});

test('a failed read, a throwing read and an oversized catalog each ride as null, named, and the link still starts', async () => {
  const cases: [string, () => Promise<AgentCatalog>, RegExp][] = [
    [
      'a failed read',
      () => Promise.resolve({ ok: false, detail: 'the agent did not answer within 20ms' }),
      /within 20ms/,
    ],
    ['a throwing read', () => Promise.reject(new Error('boom')), /the catalog read failed: boom/],
    [
      'an oversized catalog',
      () => Promise.resolve({ ok: true, agent: { ...AGENT, models: models(MAX_AGENT_MODELS + 1, 'short') } }),
      /models/,
    ],
  ];
  for (const [what, read, detail] of cases) {
    const { host, link, events } = hostWith(read);
    host.start();
    await drain();
    await drain();
    assert.deepEqual(link.calls, ['announce', 'start'], `${what}: the link did not start`);
    assert.equal(link.announced?.agent, null, `${what}: the hello should carry agent: null`);
    const reported = events.find((event) => event.kind === 'agent-catalog');
    assert.ok(reported?.kind === 'agent-catalog' && reported.agent === null, what);
    assert.match(reported.detail ?? '', detail, what);
    host.stop();
  }
});

test('without a catalog read the link starts at once and the hello carries no agent member', () => {
  const { host, link, events } = hostWith(undefined);
  host.start();
  assert.deepEqual(link.calls, ['start']);
  assert.equal(link.announced, null);
  assert.equal(
    events.some((event) => event.kind === 'agent-catalog'),
    false,
  );
  host.stop();
});

test('a configure answer and the hello after it keep the catalog, though the file they are rebuilt from has none', async () => {
  const { host, link } = hostWith(() => Promise.resolve({ ok: true, agent: AGENT }), { reconfigure: true });
  host.start();
  await drain();
  await drain();

  link.handlers?.onSessionFrame({
    frame: 'session',
    sessionId: 'host-channel',
    seq: 1,
    at: '2000-01-01T00:00:00.000Z',
    payload: hostConfigure('request-1', [{ key: 'PERISCOPE_BRANCH_SCHEME', value: '{key}' }]),
  });

  const answer = link.sent.find((entry) => entry.payload.kind === 'host_configure_result');
  assert.ok(answer !== undefined, 'the configure was answered');
  const configuration = (answer.payload as unknown as { configuration: HostConfiguration }).configuration;
  assert.deepEqual(configuration.agent, AGENT, 'the answer dropped the catalog');
  assert.deepEqual(link.announced?.agent, AGENT, 'the next hello dropped the catalog');
  host.stop();
});
