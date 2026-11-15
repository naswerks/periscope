import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { COPILOT_EXCLUDED_TOOLS } from '../gate/tool-kind.js';
import { withTempDir } from '../test-support/temp-dir.js';
import type { CopilotPostureExpected, CopilotPostureRead } from './copilot-home.js';
import {
  COPILOT_STRIPPED_VARIABLES,
  COPILOT_TOKEN_LIFETIME_SECONDS,
  carryCopilotStateIn,
  carryCopilotStateOut,
  copilotPolicyHooks,
  copilotReadBackProblem,
  copilotRuntimeEnv,
  copilotTokenProvider,
  createCopilotSessionHome,
  isStrippedCopilotVariable,
} from './copilot-home.js';

const clean: CopilotPostureRead = {
  permissionModeResult: { success: true, mode: 'manual' },
  permissionMode: 'manual',
  agentMode: 'interactive',
  allowAll: {
    active: false,
    autoApproval: false,
    storedAutoApproval: false,
    runtimeOverride: false,
    baseline: { tools: false, paths: false, urls: false },
  },
  paths: {
    directories: ['C:/work', 'C:/tmp/periscope', 'C:/base/sessions/a/installed-plugins'],
    sessionApprovedPaths: [],
  },
  plugins: [],
  offeredTools: ['powershell', 'view', 'create'],
};

const expected: CopilotPostureExpected = {
  agentMode: 'interactive',
  cwd: 'C:/work',
  writeRoots: ['C:/tmp/periscope'],
  home: 'C:/base/sessions/a',
};

test('the read-back passes the posture this host started the runtime in', () => {
  assert.equal(copilotReadBackProblem(clean, expected), null);
  assert.equal(
    copilotReadBackProblem({ ...clean, agentMode: 'plan' }, { ...expected, agentMode: 'plan' }),
    null,
    'a plan open reads plan back',
  );
});

test('control: the read-back refuses each condition broken once, by name', () => {
  const broken: [string, CopilotPostureRead, CopilotPostureExpected, RegExp][] = [
    [
      'the create-time mode not applied',
      { ...clean, permissionModeResult: { success: false } },
      expected,
      /did not apply the manual permission mode/,
    ],
    ['no create-time answer at all', { ...clean, permissionModeResult: null }, expected, /did not apply/],
    ['allow-all', { ...clean, permissionMode: 'allow-all' }, expected, /permission mode is allow-all/],
    ['autopilot', { ...clean, agentMode: 'autopilot' }, expected, /agent mode is autopilot/],
    [
      'plan when interactive was asked',
      { ...clean, agentMode: 'plan' },
      expected,
      /agent mode is plan, not interactive/,
    ],
    [
      'an approve-all grant',
      { ...clean, allowAll: { ...clean.allowAll, active: true } },
      expected,
      /approve-all grant: active/,
    ],
    [
      'a stored approval',
      { ...clean, allowAll: { ...clean.allowAll, storedAutoApproval: true } },
      expected,
      /storedAutoApproval/,
    ],
    [
      'a baseline URL grant',
      { ...clean, allowAll: { ...clean.allowAll, baseline: { urls: true } } },
      expected,
      /baseline\.urls/,
    ],
    [
      'a path approved for the session',
      { ...clean, paths: { ...clean.paths, sessionApprovedPaths: ['C:/elsewhere'] } },
      expected,
      /paths approved for the session/,
    ],
    [
      'a directory outside the roots',
      { ...clean, paths: { directories: [...clean.paths.directories, 'C:/Users/someone'] } },
      expected,
      /outside the session's roots: C:\/Users\/someone/,
    ],
    ['a plugin', { ...clean, plugins: [{ name: 'p' }] }, expected, /1 plugin\(s\) installed/],
    [
      'a turned-off tool offered',
      { ...clean, offeredTools: [...clean.offeredTools, 'write_powershell'] },
      expected,
      /offers write_powershell/,
    ],
  ];
  for (const [what, read, held, words] of broken) {
    assert.match(copilotReadBackProblem(read, held) ?? '', words, `${what} was not refused`);
  }
});

test('the read-back and the session config share one list of turned-off tools (R3)', () => {
  for (const tool of COPILOT_EXCLUDED_TOOLS) {
    assert.match(
      copilotReadBackProblem({ ...clean, offeredTools: [tool] }, expected) ?? '',
      new RegExp(`offers ${tool}`),
      `the read-back would not refuse ${tool}`,
    );
  }
});

test("the runtime's environment holds no GitHub token and no COPILOT_ variable, whatever their case, and keeps the home's own", () => {
  const env = copilotRuntimeEnv(
    {
      PATH: 'C:/bin',
      GH_TOKEN: 'a',
      github_token: 'b',
      GH_ENTERPRISE_TOKEN: 'c',
      GITHUB_ENTERPRISE_TOKEN: 'd',
      COPILOT_GITHUB_TOKEN: 'e',
      Copilot_Cli_Path: 'C:/other/copilot.exe',
      COPILOT_HOME: 'C:/Users/me/.copilot',
      LOCALAPPDATA: 'C:/Users/me/AppData/Local',
      localappdata: 'C:/Users/me/AppData/Local',
      MARKER: 'kept',
    },
    { LOCALAPPDATA: 'C:/base/sessions/a/local', APPDATA: 'C:/base/sessions/a/roaming' },
  );
  assert.deepEqual(env, {
    PATH: 'C:/bin',
    MARKER: 'kept',
    LOCALAPPDATA: 'C:/base/sessions/a/local',
    APPDATA: 'C:/base/sessions/a/roaming',
  });
  for (const name of COPILOT_STRIPPED_VARIABLES)
    assert.equal(isStrippedCopilotVariable(name.toLowerCase()), true);
  assert.equal(isStrippedCopilotVariable('GITHUB_SHA'), false);
});

test('control: a token planted under a name the strip list does not hold is kept, so the strip is by name, not by value', () => {
  const env = copilotRuntimeEnv({ MY_TOKEN: 'ghp_planted' }, {});
  assert.equal(env['MY_TOKEN'], 'ghp_planted');
});

test('the token provider reads the file at each acquisition, trimmed, and says it has none when the file is empty or gone', () =>
  withTempDir('copilot-token', async (dir) => {
    const file = join(dir, 'token');
    writeFileSync(file, 'gho_first\n');
    const provide = copilotTokenProvider(file);
    assert.deepEqual(await provide({ host: 'https://github.com', reason: 'startup' }), {
      kind: 'token',
      accessToken: 'gho_first',
      expiresIn: 28_800,
    });
    writeFileSync(file, 'gho_rotated');
    assert.equal(
      ((await provide({ host: 'https://github.com', reason: 'refresh' })) as { accessToken: string })
        .accessToken,
      'gho_rotated',
    );
    writeFileSync(file, '  \n');
    assert.deepEqual(await provide({ host: 'https://github.com', reason: 'refresh' }), { kind: 'cancelled' });
    assert.deepEqual(await copilotTokenProvider(join(dir, 'absent'))({ host: 'h', reason: 'r' }), {
      kind: 'cancelled',
    });
  }));

test('the lifetime a handed-over token is said to have clears the hour the runtime demands once it has checked the token', () => {
  // The SDK refuses a token result with an hour or less left after the runtime validates it.
  assert.ok(
    COPILOT_TOKEN_LIFETIME_SECONDS > 60 * 60 + 15 * 60,
    `${COPILOT_TOKEN_LIFETIME_SECONDS}s leaves no room`,
  );
});

test('each session has a fresh home of its own, removed whole, with its caches pointed inside it', () =>
  withTempDir('copilot-base', (base) => {
    const first = createCopilotSessionHome(base);
    const second = createCopilotSessionHome(base);
    assert.ok(first.ok && second.ok);
    assert.notEqual(first.value.home, second.value.home);
    assert.equal(first.value.env['LOCALAPPDATA'], join(first.value.home, 'local'));
    assert.equal(first.value.env['APPDATA'], join(first.value.home, 'roaming'));
    assert.ok(first.value.home.startsWith(join(base, 'sessions')));
    writeFileSync(join(first.value.home, 'settings.json'), '{}');
    assert.ok(first.value.remove().ok);
    assert.equal(existsSync(first.value.home), false);
    assert.ok(first.value.remove().ok, 'idempotent');
    assert.ok(second.value.remove().ok);
    return Promise.resolve();
  }));

test("a closed session's state is kept for a resume, and a resume of a session with none kept is refused", () =>
  withTempDir('copilot-state', (base) => {
    const made = createCopilotSessionHome(base);
    assert.ok(made.ok);
    const state = join(made.value.home, 'session-state', 'abc-123');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'events.jsonl'), '{"type":"session.start"}\n');
    assert.ok(carryCopilotStateOut(base, made.value.home, 'abc-123').ok);
    assert.ok(existsSync(join(base, 'state', 'abc-123', 'events.jsonl')));
    made.value.remove();

    const resumed = createCopilotSessionHome(base);
    assert.ok(resumed.ok);
    assert.ok(carryCopilotStateIn(base, resumed.value.home, 'abc-123').ok);
    assert.equal(
      readFileSync(join(resumed.value.home, 'session-state', 'abc-123', 'events.jsonl'), 'utf8'),
      '{"type":"session.start"}\n',
    );
    const unknown = carryCopilotStateIn(base, resumed.value.home, 'never-kept');
    assert.equal(unknown.ok, false);
    assert.equal(unknown.ok ? null : unknown.refusal.reason, 'request-key-unsupported');
    const escape = carryCopilotStateIn(base, resumed.value.home, '../sessions');
    assert.equal(escape.ok, false, 'an id that climbs names no session');
    assert.ok(
      carryCopilotStateOut(base, resumed.value.home, 'left-nothing').ok,
      'a session with no state moves nothing',
    );
    resumed.value.remove();
    return Promise.resolve();
  }));

test('the machine-wide policy hooks are named by file and by key', () =>
  withTempDir('copilot-policy', async (programData) => {
    assert.deepEqual(await copilotPolicyHooks({ programData }), []);
    const directory = join(programData, 'GitHub', 'Copilot', 'policy.d');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'hooks.json'), '{}');
    writeFileSync(join(directory, 'notes.txt'), 'x');
    assert.deepEqual(await copilotPolicyHooks({ programData }), [join(directory, 'hooks.json')]);
    assert.deepEqual(
      await copilotPolicyHooks({ programData: null, registryHolds: () => Promise.resolve(true) }),
      ['HKLM\\Software\\Policies\\GitHub\\Copilot'],
    );
    assert.deepEqual(
      await copilotPolicyHooks({ programData: null, registryHolds: () => Promise.resolve(null) }),
      [],
    );
  }));
