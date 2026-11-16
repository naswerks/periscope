import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { OPENCODE_DENIED_TOOLS } from '../gate/tool-kind.js';
import { tempDir } from '../test-support/temp-dir.js';
import {
  OPENCODE_OFF_PLUGINS,
  OPENCODE_SWITCHES,
  carryOpencodeStateIn,
  carryOpencodeStateOut,
  createOpencodeSessionHome,
  ensureOpencodeBase,
  isStrippedOpencodeVariable,
  opencodeConfig,
  opencodeConfigText,
  opencodeHostEnv,
  opencodeReadBackProblem,
  opencodeRuleset,
  opencodeShellEnv,
  sweepOpencodeHomes,
} from './opencode-home.js';
import type { OpencodePostureRead } from './opencode-home.js';

test("a session's home is made fresh under the base, every directory opencode reads inside it, and removed whole", async () => {
  const base = await tempDir('opencode-home');
  try {
    const made = createOpencodeSessionHome(base);
    assert.ok(made.ok);
    const home = made.value;
    assert.ok(home.home.startsWith(join(base, 'sessions')));
    assert.equal(home.database, join(home.home, 'data', 'session.db'));
    assert.ok(statSync(home.configDirectory).isDirectory());
    for (const [name, value] of Object.entries(home.env)) {
      assert.ok(value.startsWith(home.home), `${name} is outside the home`);
      assert.ok(statSync(value).isDirectory(), `${name} names no directory`);
    }
    assert.deepEqual(Object.keys(home.env).sort(), [
      'APPDATA',
      'HOME',
      'LOCALAPPDATA',
      'USERPROFILE',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
    ]);
    const other = createOpencodeSessionHome(base);
    assert.ok(other.ok);
    assert.notEqual(other.value.home, home.home, 'each session has its own');
    assert.ok(home.remove().ok);
    assert.equal(existsSync(home.home), false);
    assert.ok(home.remove().ok, 'removing twice is no failure');
    assert.ok(ensureOpencodeBase(base).ok);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a closing session's database is kept by its id, and a resume carries it into a fresh home; a session that left none keeps nothing", async () => {
  const base = await tempDir('opencode-carry');
  try {
    const first = createOpencodeSessionHome(base);
    assert.ok(first.ok);
    assert.ok(carryOpencodeStateOut(base, first.value.database, 'ses_none').ok);
    assert.equal(existsSync(join(base, 'state', 'ses_none')), false);
    writeFileSync(first.value.database, 'database');
    writeFileSync(`${first.value.database}-wal`, 'log');
    assert.ok(carryOpencodeStateOut(base, first.value.database, 'ses_kept').ok);
    const second = createOpencodeSessionHome(base);
    assert.ok(second.ok);
    assert.ok(carryOpencodeStateIn(base, second.value.database, 'ses_kept').ok);
    assert.equal(readFileSync(second.value.database, 'utf8'), 'database');
    assert.equal(readFileSync(`${second.value.database}-wal`, 'utf8'), 'log');
    const missing = carryOpencodeStateIn(base, second.value.database, 'ses_never');
    assert.ok(!missing.ok);
    assert.equal(missing.refusal.reason, 'request-key-unsupported');
    for (const id of ['..', '../escape', 'a/b', 'a\\b', '']) {
      assert.ok(!carryOpencodeStateIn(base, second.value.database, id).ok, `in: ${id}`);
      assert.ok(!carryOpencodeStateOut(base, second.value.database, id).ok, `out: ${id}`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a kept database is replaced, never deleted first: a close that cannot bring the new one in leaves the older copy for a resume', async () => {
  const base = await tempDir('opencode-replace');
  try {
    const first = createOpencodeSessionHome(base);
    assert.ok(first.ok);
    writeFileSync(first.value.database, 'first');
    assert.ok(carryOpencodeStateOut(base, first.value.database, 'ses_kept').ok);
    const kept = join(base, 'state', 'ses_kept', 'session.db');
    assert.equal(readFileSync(kept, 'utf8'), 'first');

    // The next close cannot copy the new database.
    const second = createOpencodeSessionHome(base);
    assert.ok(second.ok);
    writeFileSync(second.value.database, 'second');
    const remove = (path: string): void => rmSync(path, { recursive: true, force: true });
    const failing = carryOpencodeStateOut(base, second.value.database, 'ses_kept', {
      copy: () => {
        throw new Error('the volume is full');
      },
      rename: renameSync,
      remove,
    });
    assert.equal(failing.ok, false);
    assert.match(failing.ok ? '' : failing.refusal.detail, /could not be kept: the volume is full/);
    assert.equal(readFileSync(kept, 'utf8'), 'first', 'the older copy was deleted before its replacement');

    // The new database arrives beside the older one, and the last step fails: the older copy is put back.
    let renames = 0;
    const lastStepFails = carryOpencodeStateOut(base, second.value.database, 'ses_kept', {
      copy: copyFileSync,
      rename: (from, to) => {
        renames += 1;
        if (renames === 2) throw new Error('the name is held');
        renameSync(from, to);
      },
      remove,
    });
    assert.equal(lastStepFails.ok, false);
    assert.equal(readFileSync(kept, 'utf8'), 'first', 'the older copy was not put back');
    assert.deepEqual(
      readdirSync(join(base, 'state')),
      ['ses_kept'],
      'something was left beside the kept database',
    );

    // Control: a close that can, replaces it, and leaves nothing else in the directory.
    assert.ok(carryOpencodeStateOut(base, second.value.database, 'ses_kept').ok);
    assert.equal(readFileSync(kept, 'utf8'), 'second');
    assert.deepEqual(readdirSync(join(base, 'state')), ['ses_kept']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a session home a host left behind is cleared at the next open: its database kept for a resume, the home removed, and a live session's home left alone", async () => {
  const base = await tempDir('opencode-sweep');
  const made = (): { home: string; database: string } => {
    const one = createOpencodeSessionHome(base);
    assert.ok(one.ok);
    return { home: one.value.home, database: one.value.database };
  };
  const own = (home: string, owner: Record<string, unknown>): void =>
    writeFileSync(join(home, 'owner.json'), JSON.stringify(owner));

  // A home made by this process says so, and names its session once it is told.
  const live = createOpencodeSessionHome(base);
  assert.ok(live.ok);
  assert.deepEqual(JSON.parse(readFileSync(join(live.value.home, 'owner.json'), 'utf8')), {
    pid: process.pid,
  });
  live.value.holds('ses_live');
  assert.deepEqual(JSON.parse(readFileSync(join(live.value.home, 'owner.json'), 'utf8')), {
    pid: process.pid,
    session: 'ses_live',
  });

  // Three homes a host that is gone left: one holding a session, one that never opened one, and one whose
  // session id names no directory.
  const crashed = made();
  writeFileSync(crashed.database, 'the database');
  writeFileSync(`${crashed.database}-wal`, 'its log');
  own(crashed.home, { pid: 111, session: 'ses_crashed' });
  const unopened = made();
  own(unopened.home, { pid: 111 });
  const unkeepable = made();
  writeFileSync(unkeepable.database, 'the database');
  own(unkeepable.home, { pid: 111, session: '../escape' });
  // A directory nobody marked, and a home with a file that is not an owner's, are not this host's to judge.
  const unmarked = made();
  rmSync(join(unmarked.home, 'owner.json'));
  const unreadable = made();
  writeFileSync(join(unreadable.home, 'owner.json'), 'not json');

  const swept = sweepOpencodeHomes(base, (pid) => pid === process.pid);
  assert.deepEqual(swept.kept, ['ses_crashed']);
  assert.deepEqual([...swept.removed].sort(), [crashed.home, unopened.home].sort());
  assert.equal(readFileSync(join(base, 'state', 'ses_crashed', 'session.db'), 'utf8'), 'the database');
  assert.equal(readFileSync(join(base, 'state', 'ses_crashed', 'session.db-wal'), 'utf8'), 'its log');
  assert.equal(existsSync(crashed.home), false);
  assert.equal(existsSync(unopened.home), false);
  assert.equal(existsSync(live.value.home), true, "a live session's home was swept");
  assert.equal(existsSync(unmarked.home), true);
  assert.equal(existsSync(unreadable.home), true);
  // A database that could not be kept leaves its home where it is, and says so.
  assert.equal(existsSync(unkeepable.home), true, 'a home was removed with a database that was not kept');
  assert.equal(swept.problems.length, 1);
  assert.match(swept.problems[0] ?? '', /was not cleared: the session id \.\.\/escape names no directory/);
  // A base with no sessions directory sweeps nothing.
  assert.deepEqual(sweepOpencodeHomes(join(base, 'absent')), { kept: [], removed: [], problems: [] });
  await rm(base, { recursive: true, force: true });
});

test("the variables this host never hands an opencode session: opencode's, Node's preload and this host's own but the further worktrees' paths, in any case", () => {
  for (const name of [
    'OPENCODE_SERVER_PASSWORD',
    'opencode_config',
    'NODE_OPTIONS',
    'PERISCOPE_CONTROL_TOKEN',
    'Periscope_Ticket',
  ]) {
    assert.equal(isStrippedOpencodeVariable(name), true, name);
  }
  for (const name of [
    'PERISCOPE_WORKTREE_PERISCOPE',
    'periscope_worktree_x',
    'PATH',
    'HOME',
    'OPENROUTER_API_KEY',
  ]) {
    assert.equal(isStrippedOpencodeVariable(name), false, name);
  }
});

test("the host process's environment is the spawn environment less those, inside the session's home, with the switches; the shell's keeps the operator's home", () => {
  const spawn = {
    PATH: 'p',
    HOME: '/home/op',
    USERPROFILE: 'C:\\Users\\op',
    OPENCODE_CONFIG: '/home/op/evil.json',
    opencode_disable_project_config: '0',
    NODE_OPTIONS: '--require x',
    PERISCOPE_TICKET: 't',
    PERISCOPE_WORKTREE_A: '/w/a',
  };
  const home = { HOME: '/base/s/profile', USERPROFILE: '/base/s/profile', XDG_DATA_HOME: '/base/s/data' };
  const host = opencodeHostEnv(spawn, home);
  assert.deepEqual(host, {
    PATH: 'p',
    PERISCOPE_WORKTREE_A: '/w/a',
    ...home,
    ...OPENCODE_SWITCHES,
  });
  // The one switch the pinned SDK reads, and no name it does not.
  assert.deepEqual(OPENCODE_SWITCHES, { OPENCODE_DISABLE_FREE_MODELS: '1' });
  const shell = opencodeShellEnv(spawn);
  assert.deepEqual(shell, {
    PATH: 'p',
    HOME: '/home/op',
    USERPROFILE: 'C:\\Users\\op',
    PERISCOPE_WORKTREE_A: '/w/a',
  });
});

test('the rules are one list: every action asks, then each turned-off tool is denied', () => {
  const rules = opencodeRuleset();
  assert.deepEqual(rules, [
    { action: '*', resource: '*', effect: 'ask' },
    ...OPENCODE_DENIED_TOOLS.map((action) => ({ action, resource: '*', effect: 'deny' })),
  ]);
});

test("the configuration: this host's rules, the plugins off, one provider allowed, the servers, skills and instructions handed over, nothing that acts outside a call", () => {
  const config = opencodeConfig({
    provider: {
      id: 'endpoint-stub',
      entry: {
        name: 'stub',
        package: 'p',
        settings: { baseURL: 'http://127.0.0.1:9/v1' },
        models: { m: { name: 'm' } },
      },
    },
    model: 'm',
    servers: { docs: { type: 'remote', url: 'http://127.0.0.1:9/mcp', oauth: false, codemode: false } },
    skills: ['/plugins/a/skills'],
    instructions: ['/base/s/instructions.md'],
    shell: '/bin/bash',
  });
  assert.deepEqual(config['permissions'], opencodeRuleset());
  assert.deepEqual(
    config['plugins'],
    OPENCODE_OFF_PLUGINS.map((id) => `-${id}`),
  );
  assert.deepEqual(config['policies'], [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'provider.use', resource: 'endpoint-stub', effect: 'allow' },
  ]);
  assert.deepEqual(config['model'], { providerID: 'endpoint-stub', model: 'm' });
  assert.deepEqual(Object.keys((config['mcp'] as { servers: object }).servers), ['docs']);
  assert.deepEqual(config['skills'], ['/plugins/a/skills']);
  assert.deepEqual(config['instructions'], ['/base/s/instructions.md']);
  assert.deepEqual(config['agents'], { title: { disabled: true } }, 'no model call outside a run');
  const bare = opencodeConfig({
    provider: null,
    model: null,
    servers: {},
    skills: [],
    instructions: [],
    shell: '/bin/sh',
  });
  assert.deepEqual(
    bare['policies'],
    [{ action: 'provider.use', resource: '*', effect: 'deny' }],
    'no provider at all',
  );
  for (const key of ['providers', 'model', 'mcp', 'skills', 'instructions'])
    assert.equal(key in bare, false, key);
});

const HOME = process.platform === 'win32' ? 'C:\\base\\sessions\\s1' : '/base/sessions/s1';

/** The posture this host creates a session in. */
function posture(overrides: Partial<OpencodePostureRead> = {}): OpencodePostureRead {
  return {
    rules: opencodeRuleset(),
    agents: [
      { id: 'build', rules: [{ action: 'read', resource: '*', effect: 'allow' }, ...opencodeRuleset()] },
      { id: 'plan', rules: [{ action: 'edit', resource: '*', effect: 'deny' }, ...opencodeRuleset()] },
    ],
    saved: [],
    plugins: [{ id: 'opencode.tool.shell', source: { type: 'builtin' } }],
    servers: ['docs'],
    config: [{ type: 'directory', path: join(HOME, 'opencode-config') }, { type: 'global' }],
    models: [{ id: 'm', providerID: 'endpoint-stub' }],
    ...overrides,
  };
}

const EXPECTED = { servers: ['docs'], home: HOME, providerId: 'endpoint-stub' };

test("the configuration's text holds no reference the server would follow, and parses back to exactly what was written", () => {
  const config = {
    mcp: {
      servers: {
        probe: {
          type: 'remote',
          url: 'https://example.invalid/{env:HOME}/mcp',
          headers: {
            'x-file': '{file:C:/Users/op/.ssh/id_rsa}',
            'x-env': '{env:SECRET}',
            'x-escaped': '\\{file:~/x}',
            'x-plain': '{not-a-reference} and {"json": true}',
          },
        },
        local: {
          type: 'local',
          command: ['tool', '--token={env:TOKEN}'],
          environment: { A: '{file:/etc/x}' },
        },
      },
    },
    'a-key-{file:odd}': 1,
  };
  const text = opencodeConfigText(config);
  assert.doesNotMatch(text, /\{(?:env|file):/, 'the text holds a reference the server would follow');
  assert.deepEqual(JSON.parse(text), config, 'a value was changed by how it was written');
  // Control: a configuration with no reference is written as plain JSON.
  const plain = { shell: '/bin/sh', mcp: { servers: {} } };
  assert.equal(opencodeConfigText(plain), JSON.stringify(plain));
});

test('control: the read-back holds the posture this host created', () => {
  assert.equal(opencodeReadBackProblem(posture(), EXPECTED), null);
});

test('the read-back names each way the server is not in that posture', () => {
  const cases: [Partial<OpencodePostureRead>, RegExp][] = [
    [
      { rules: [{ action: '*', resource: '*', effect: 'allow' }] },
      /session's rules are not the ones this host wrote: \* \* allow/,
    ],
    [{ rules: opencodeRuleset().slice(0, -1) }, /session's rules are not the ones/],
    [
      {
        agents: [
          { id: 'build', rules: [...opencodeRuleset(), { action: 'edit', resource: '*', effect: 'allow' }] },
        ],
      },
      /agent build's rules do not end/,
    ],
    [{ agents: [] }, /lists no agent/],
    [{ saved: [{ action: 'shell', resource: '*' }] }, /saved approvals: shell \*/],
    [
      { plugins: [{ id: 'mine', source: { type: 'file' } }] },
      /plugins other than the runtime's own are loaded: mine/,
    ],
    [
      { plugins: [{ id: 'opencode.tool.schedule', source: { type: 'builtin' } }] },
      /plugins this host turns off are loaded: opencode\.tool\.schedule/,
    ],
    [{ servers: [] }, /MCP servers are none, not the session's docs/],
    [{ servers: ['docs', 'extra'] }, /MCP servers are docs, extra/],
    [
      {
        config: [
          {
            type: 'file',
            path:
              process.platform === 'win32'
                ? 'C:\\Users\\op\\.config\\opencode\\opencode.json'
                : '/home/op/.config/opencode/opencode.json',
          },
        ],
      },
      /configuration this host did not write/,
    ],
    [
      {
        models: [
          { id: 'm', providerID: 'endpoint-stub' },
          { id: 'x', providerID: 'opencode' },
        ],
      },
      /models of providers other than the session's: opencode/,
    ],
  ];
  for (const [overrides, pattern] of cases) {
    assert.match(opencodeReadBackProblem(posture(overrides), EXPECTED) ?? 'held', pattern);
  }
  assert.match(
    opencodeReadBackProblem(posture(), { ...EXPECTED, providerId: null }) ?? 'held',
    /models of providers other than the session's: endpoint-stub/,
    'a session with no endpoint is offered no model at all',
  );
});

test("a session home's configuration directory is the one the read-back holds the server to", async () => {
  const base = await tempDir('opencode-config-place');
  try {
    const made = createOpencodeSessionHome(base);
    assert.ok(made.ok);
    mkdirSync(join(made.value.configDirectory, 'nested'), { recursive: true });
    const read = posture({
      config: [{ type: 'directory', path: join(made.value.configDirectory, 'nested') }],
    });
    assert.equal(opencodeReadBackProblem(read, { ...EXPECTED, home: made.value.home }), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
