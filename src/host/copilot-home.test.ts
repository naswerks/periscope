import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { COPILOT_EXCLUDED_TOOLS } from '../gate/tool-kind.js';
import { withTempDir } from '../test-support/temp-dir.js';
import type { CopilotPostureExpected, CopilotPostureRead } from './copilot-home.js';
import {
  COPILOT_STRIPPED_VARIABLES,
  COPILOT_TOKEN_LIFETIME_SECONDS,
  carryCopilotStateIn,
  carryCopilotStateOut,
  copilotPolicyDetail,
  copilotPolicyDirectories,
  copilotPolicyHooks,
  copilotRuntimePolicyLook,
  mergeCopilotPolicyLooks,
  copilotCanonicalPath,
  copilotOutsideDirectories,
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

test('regression: a root handed over in another spelling of the place the runtime reports is the same root: a link, or a Windows short name', () =>
  withTempDir('copilot-canonical', (dir) => {
    const real = join(dir, 'real-work');
    mkdirSync(real);
    const link = join(dir, 'link-work');
    symlinkSync(real, link, 'junction');
    const resolved = realpathSync.native(real);
    // The runtime reports the directories it allows resolved; the host was handed the link.
    const read: CopilotPostureRead = {
      ...clean,
      paths: { directories: [resolved], sessionApprovedPaths: [] },
    };
    const held: CopilotPostureExpected = { ...expected, cwd: link, writeRoots: [], home: join(dir, 'home') };
    assert.equal(copilotReadBackProblem(read, held), null);
    assert.deepEqual(copilotOutsideDirectories(read, held), []);
    // Control: a directory outside the link's target is still one the session does not own.
    assert.deepEqual(
      copilotOutsideDirectories({ ...read, paths: { directories: [join(dir, 'elsewhere')] } }, held),
      [join(dir, 'elsewhere')],
    );
    // A path not made yet keeps what follows its deepest existing ancestor.
    assert.equal(copilotCanonicalPath(join(link, 'not-yet', 'made')), join(resolved, 'not-yet', 'made'));
    return Promise.resolve();
  }));

test("a directory the runtime allows that is none of the session's is listed, and is no reason to refuse the open", () => {
  // The session's own directory, a write root and what sits inside its home are the session's.
  assert.deepEqual(copilotOutsideDirectories(clean, expected), []);
  const temp = 'C:/Users/op/AppData/Local/Temp';
  const wider: CopilotPostureRead = {
    ...clean,
    paths: { ...clean.paths, directories: [...clean.paths.directories, temp, 'C:/Users/someone'] },
  };
  assert.deepEqual(copilotOutsideDirectories(wider, expected), [temp, 'C:/Users/someone']);
  assert.equal(copilotReadBackProblem(wider, expected), null, 'an allowed directory refused the open');
  // The same folder handed over as a write root is the session's own.
  assert.deepEqual(
    copilotOutsideDirectories(wider, { ...expected, writeRoots: [...expected.writeRoots, temp] }),
    ['C:/Users/someone'],
  );
});

test('the read-back and the session config share one list of turned-off tools', () => {
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
      GH_HOST: 'github.example.com',
      gh_host: 'github.example.com',
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
    assert.deepEqual(
      await copilotTokenProvider(join(dir, 'absent'))({ host: 'https://github.com', reason: 'r' }),
      { kind: 'cancelled' },
    );
  }));

test("the operator's token is given for github.com alone: asked for any other host the provider gives nothing, never reads the file, and says which host asked", () =>
  withTempDir('copilot-token-host', async (dir) => {
    const file = join(dir, 'token');
    writeFileSync(file, 'gho_operator');
    const read: string[] = [];
    const asked: string[] = [];
    const provide = copilotTokenProvider(
      file,
      (path) => {
        read.push(path);
        return 'gho_operator';
      },
      (host) => asked.push(host),
    );
    for (const host of [
      'https://github.example.com',
      'https://github.com.example.net',
      'https://ghe.corp.example',
      'evil.example',
      '',
    ]) {
      assert.deepEqual(await provide({ host, reason: 'startup' }), { kind: 'cancelled' }, host);
    }
    assert.deepEqual(read, [], 'the token file was read for a host the token is not for');
    assert.deepEqual(asked, [
      'https://github.example.com',
      'https://github.com.example.net',
      'https://ghe.corp.example',
      'evil.example',
      '',
    ]);
    // Control: github.com, however the runtime spells it, is given the token.
    for (const host of ['https://github.com', 'https://github.com/', 'github.com', 'HTTPS://GitHub.com']) {
      assert.equal((await provide({ host, reason: 'startup' })).kind, 'token', host);
    }
    assert.equal(asked.length, 5);
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
    // The runtime's own cache variable, which it reads on every platform, names a directory in the home too.
    assert.equal(first.value.env['COPILOT_CACHE_HOME'], join(first.value.home, 'cache'));
    assert.ok(existsSync(join(first.value.home, 'cache')));
    assert.equal(
      copilotRuntimeEnv({ COPILOT_CACHE_HOME: '/the/operators/own', PATH: 'p' }, first.value.env)[
        'COPILOT_CACHE_HOME'
      ],
      join(first.value.home, 'cache'),
      "the runtime was not started with the home's cache directory",
    );
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

test('a kept state is replaced, never deleted first: a close that cannot bring the new state in leaves the older copy for a resume', () =>
  withTempDir('copilot-replace', (base) => {
    const first = createCopilotSessionHome(base);
    assert.ok(first.ok);
    const stateOf = (home: string): string => join(home, 'session-state', 'abc-123');
    mkdirSync(stateOf(first.value.home), { recursive: true });
    writeFileSync(join(stateOf(first.value.home), 'events.jsonl'), 'first\n');
    assert.ok(carryCopilotStateOut(base, first.value.home, 'abc-123').ok);
    const kept = join(base, 'state', 'abc-123', 'events.jsonl');
    assert.equal(readFileSync(kept, 'utf8'), 'first\n');

    // The next close cannot move or copy the new state.
    const second = createCopilotSessionHome(base);
    assert.ok(second.ok);
    mkdirSync(stateOf(second.value.home), { recursive: true });
    writeFileSync(join(stateOf(second.value.home), 'events.jsonl'), 'second\n');
    const failing = carryCopilotStateOut(base, second.value.home, 'abc-123', {
      rename: () => {
        throw new Error('the volume is full');
      },
      copy: () => {
        throw new Error('the volume is full');
      },
      remove: (path) => rmSync(path, { recursive: true, force: true }),
    });
    assert.equal(failing.ok, false);
    assert.match(failing.ok ? '' : failing.refusal.detail, /could not be kept: the volume is full/);
    assert.equal(readFileSync(kept, 'utf8'), 'first\n', 'the older copy was deleted before its replacement');

    // The new state arrives beside the older one, and the last step fails: the older copy is put back.
    let renames = 0;
    const lastStepFails = carryCopilotStateOut(base, second.value.home, 'abc-123', {
      rename: (from, to) => {
        renames += 1;
        if (renames === 3) throw new Error('the name is held');
        renameSync(from, to);
      },
      copy: (from, to) => cpSync(from, to, { recursive: true }),
      remove: (path) => rmSync(path, { recursive: true, force: true }),
    });
    assert.equal(lastStepFails.ok, false);
    assert.equal(readFileSync(kept, 'utf8'), 'first\n', 'the older copy was not put back');
    assert.deepEqual(
      readdirSync(join(base, 'state')),
      ['abc-123'],
      'something was left beside the kept state',
    );

    // Control: a close that can, replaces it, and leaves nothing else in the directory.
    mkdirSync(stateOf(second.value.home), { recursive: true });
    writeFileSync(join(stateOf(second.value.home), 'events.jsonl'), 'second\n');
    assert.ok(carryCopilotStateOut(base, second.value.home, 'abc-123').ok);
    assert.equal(readFileSync(kept, 'utf8'), 'second\n');
    assert.deepEqual(readdirSync(join(base, 'state')), ['abc-123']);
    first.value.remove();
    second.value.remove();
    return Promise.resolve();
  }));

test('the machine-wide policy hooks are named by file and by key, and a source that cannot be read is kept apart from one that holds none', () =>
  withTempDir('copilot-policy', async (programData) => {
    const directory = join(programData, 'GitHub', 'Copilot', 'policy.d');
    const none = { found: [], unread: [] };
    assert.deepEqual(await copilotPolicyHooks({ directories: [directory] }), none, 'no directory');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'hooks.json'), '{}');
    writeFileSync(join(directory, 'notes.txt'), 'x');
    assert.deepEqual(await copilotPolicyHooks({ directories: [directory] }), {
      found: [join(directory, 'hooks.json')],
      unread: [],
    });
    const key = 'HKLM\\Software\\Policies\\GitHub\\Copilot';
    assert.deepEqual(
      await copilotPolicyHooks({ directories: [], registryHolds: () => Promise.resolve(true) }),
      { found: [key], unread: [] },
    );
    assert.deepEqual(
      await copilotPolicyHooks({ directories: [], registryHolds: () => Promise.resolve(false) }),
      none,
      'a key that is not there holds none',
    );
    assert.deepEqual(
      await copilotPolicyHooks({ directories: [], registryHolds: () => Promise.resolve(null) }),
      { found: [], unread: [key] },
      'a key that could not be read was counted as holding none',
    );
    assert.deepEqual(
      await copilotPolicyHooks({ directories: [], registryHolds: () => Promise.reject(new Error('x')) }),
      { found: [], unread: [key] },
    );
    // A path that is there and is no directory to list is not one that holds none.
    const listed = await copilotPolicyHooks({ directories: [join(directory, 'hooks.json', 'under')] });
    assert.deepEqual(listed.found, []);
    assert.ok(
      listed.unread.length === 0 || /hooks\.json/.test(listed.unread[0] ?? ''),
      listed.unread.join(' | '),
    );
    // A host with nowhere to look has read every source there is.
    assert.deepEqual(await copilotPolicyHooks({ directories: [] }), none);
  }));

test('the policy directories are the one the environment names and the one the runtime falls back to, on Windows alone', () => {
  const fallback = 'C:\\ProgramData\\GitHub\\Copilot\\policy.d';
  assert.deepEqual(copilotPolicyDirectories({ ProgramData: 'C:\\ProgramData' }, 'win32'), [fallback]);
  assert.deepEqual(copilotPolicyDirectories({ PROGRAMDATA: 'c:\\programdata\\' }, 'win32'), [fallback]);
  assert.deepEqual(copilotPolicyDirectories({ ProgramData: 'D:\\Data' }, 'win32'), [
    'D:\\Data\\GitHub\\Copilot\\policy.d',
    fallback,
  ]);
  assert.deepEqual(copilotPolicyDirectories({}, 'win32'), [fallback]);
  assert.deepEqual(copilotPolicyDirectories({ ProgramData: 'C:\\ProgramData' }, 'linux'), []);
  assert.deepEqual(copilotPolicyDirectories({}, 'darwin'), []);
});

test("the runtime's own account is read: a policy row is a source found, and what it could not load or answer is unread", () => {
  const nothing = { answer: { hooks: [], warnings: [], errors: [] } };
  assert.deepEqual(copilotRuntimePolicyLook(nothing, { answer: {} }), { found: [], unread: [] });
  assert.deepEqual(
    copilotRuntimePolicyLook(
      {
        answer: {
          hooks: [
            { hookType: 'preToolUse', origin: 'policy', source: 'policy.d/a.json', enabled: true },
            { hookType: 'preToolUse', origin: 'policy', source: 'policy.d/a.json', enabled: true },
            { hookType: 'postToolUse', origin: 'policy', enabled: true },
            { hookType: 'preToolUse', origin: 'policy', source: 'off.json', enabled: false },
            { hookType: 'preToolUse', origin: 'plugin', source: 'a-plugin', enabled: true },
          ],
          errors: ['registry policy: access denied'],
        },
      },
      { answer: { settingsJson: { hooks: { preToolUse: [{ type: 'command' }] } } } },
    ),
    {
      found: [
        'policy.d/a.json (preToolUse hook)',
        'a managed policy the runtime did not name (postToolUse hook)',
        "the machine's managed Copilot settings",
      ],
      unread: ['a hook source the runtime could not load (registry policy: access denied)'],
    },
  );
  // A call that failed, and an answer of a shape this host cannot read, are unread: neither is none.
  for (const [discovered, managed, unread] of [
    [{ failed: 'timed out' }, { answer: {} }, ["the runtime's own hook discovery (timed out)"]],
    [
      { answer: null },
      { answer: {} },
      ["the runtime's own hook discovery (an answer this host cannot read)"],
    ],
    [
      { answer: { hooks: 'none' } },
      { answer: {} },
      ["the runtime's own hook discovery (an answer this host cannot read)"],
    ],
    [
      { answer: { hooks: ['a-row'] } },
      { answer: {} },
      ["the runtime's own hook discovery (a row this host cannot read)"],
    ],
    [nothing, { failed: 'no such method' }, ["the machine's managed Copilot settings (no such method)"]],
    [nothing, { answer: 7 }, ["the machine's managed Copilot settings (an answer this host cannot read)"]],
    [
      nothing,
      { answer: { errorMessage: 'not valid JSON' } },
      ["the machine's managed Copilot settings (not valid JSON)"],
    ],
  ] as const) {
    assert.deepEqual(copilotRuntimePolicyLook(discovered, managed), { found: [], unread });
  }
  // Control: managed settings that hold no hook are no source of one.
  assert.deepEqual(
    copilotRuntimePolicyLook(nothing, { answer: { settingsJson: { telemetry: false, hooks: {} } } }),
    { found: [], unread: [] },
  );
});

test('what a look says of the session: nothing when every source read and none holds a hook, else what was found and what could not be read', () => {
  assert.equal(copilotPolicyDetail({ found: [], unread: [] }), null);
  assert.equal(
    copilotPolicyDetail({ found: ['a.json'], unread: [] }),
    'machine-wide Copilot policy hooks run in every session whatever its own settings say: a.json',
  );
  assert.match(
    copilotPolicyDetail({ found: [], unread: ['the key'] }) ?? '',
    /^not every place a machine-wide Copilot policy hook can sit could be read, so one that runs in every session is not ruled out: the key$/,
  );
  assert.match(
    copilotPolicyDetail(
      mergeCopilotPolicyLooks(
        { found: ['a.json'], unread: ['the key'] },
        { found: ['a.json', 'b'], unread: ['the key'] },
      ),
    ) ?? '',
    /say: a\.json, b; not every place .* is not ruled out: the key$/,
  );
});
