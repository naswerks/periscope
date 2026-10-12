/**
 * What a controller can ask for over the link, and what it is refused BY NAME.
 *
 * The widening's whole risk is that a value arriving from off-box is well-formed JSON and meaningless
 * to the SDK. Two outcomes are acceptable — a named refusal before any process exists, or a value
 * carried faithfully — and exactly one is not: a value quietly dropped, which starts a session the
 * controller believes it configured and cannot tell it did not get.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SESSION_NEW_REQUEST_KEYS, sessionNewRequest } from '../control/frames.js';
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  SETTING_SOURCES,
  THINKING_DISPLAYS,
  THINKING_TYPES,
  mergeMcpServers,
  readSessionConfigure,
  readSessionRequest,
} from './wire-request.js';
import type { McpServerConfig } from './agent-process.js';
import type { ModelEndpoint } from './model-endpoints.js';
import { EXTRA_ENV_FLOOR, composeSpawnEnv } from '../sessions/spawn-env.js';
import type { EnvSource } from '../sessions/spawn-env.js';
import type { SessionNewEnv } from '../control/frames.js';

// ---------------------------------------------------------------------------
// The defaults path — the one that must not change for anybody.
// ---------------------------------------------------------------------------

test('a request of null composes NOTHING, so an old controller gets exactly the old behaviour', () => {
  const read = readSessionRequest(null);
  assert.equal(read.ok, true);
  assert.deepEqual(read.ok ? read.value : null, {}, 'a null request must add no keys at all');
});

test('every field left null is left ABSENT, never passed through as null', () => {
  // The composer below reads an absent key as "use the default" and a present one as a value it must
  // honour. Passing `null` through would overwrite a default with nothing — silently, on every field
  // the controller did not mention.
  const read = readSessionRequest(sessionNewRequest());
  assert.equal(read.ok, true);
  assert.deepEqual(Object.keys(read.ok ? read.value : {}), []);
});

/** One endpoint the operator declared, Anthropic's own route, so the request's Claude model may ride it. */
const DECLARED_ENDPOINT: ModelEndpoint = {
  name: 'example-endpoint',
  wireApi: 'anthropic-messages',
  runtimes: ['claude'],
  baseUrl: 'https://gateway.example',
  models: ['claude-fable-5'],
  modelAliases: {},
  contextWindow: null,
  env: {},
  firstParty: true,
  authToken: () => 'example-token',
};

/** Every wire key at once, for the anti-drop check and its twin. */
const EVERY_KEY = sessionNewRequest({
  resume: 'session-abc',
  fork: true,
  settingSources: ['project'],
  plugins: [{ type: 'local', path: '/plugins/one', skipMcpDiscovery: null }],
  mcpServers: { probe: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
  strictMcpConfig: false,
  includePartialMessages: false,
  thinking: { type: 'adaptive', display: 'summarized' },
  forwardSubagentText: true,
  env: { extraAllowedKeys: ['NAS_X'], extraDeniedKeys: null, extraEnv: { NAS_Y: '1' } },
  model: 'claude-fable-5',
  systemPrompt: 'be brief',
  effort: 'high',
  permissionMode: 'bypassPermissions',
  runtime: 'claude',
  endpoint: 'example-endpoint',
});

test('every declared wire key is one this narrowing knows how to carry', () => {
  // The anti-drop check. A field added to the wire type and forgotten here would be accepted by
  // the codec, arrive intact, and then be silently discarded — the exact failure this file exists to
  // make impossible. Driving every key at once and asserting each one lands is what catches it.
  const asked = EVERY_KEY;

  const read = readSessionRequest(asked, EXTRA_ENV_FLOOR, ['NAS_X', 'NAS_Y'], [DECLARED_ENDPOINT]);
  assert.equal(read.ok, true, read.ok ? '' : `${read.refusal.reason}: ${read.refusal.detail}`);
  const composed = read.ok ? (read.value as Record<string, unknown>) : {};

  assert.deepEqual(
    Object.keys(composed).sort(),
    Object.keys(SESSION_NEW_REQUEST_KEYS).sort(),
    'a declared wire key was dropped on the way in, or an undeclared one was invented',
  );
  assert.equal(composed['resume'], 'session-abc');
  assert.equal(composed['fork'], true);
  assert.equal(composed['model'], 'claude-fable-5');
  assert.equal(composed['systemPrompt'], 'be brief');
  assert.equal(composed['strictMcpConfig'], false);
  assert.equal(composed['effort'], 'high');
  assert.equal(composed['permissionMode'], 'bypassPermissions');
  assert.equal(composed['endpoint'], 'example-endpoint');
  assert.deepEqual(composed['settingSources'], ['project']);
  assert.deepEqual(composed['env'], { extraAllowedKeys: ['NAS_X'], extraEnv: { NAS_Y: '1' } });
});

test('regression: the same request with nothing declared is refused env-key-refused, naming the key in each lane', () => {
  // The twin of the anti-drop check: its env lanes carry above only because the operator declared
  // both keys. With no declaration, the default, the same request is refused, and one refusal names
  // every undeclared key in both lanes.
  const read = readSessionRequest(EVERY_KEY);
  assert.equal(read.ok, false, 'an undeclared key was accepted');
  assert.equal(read.ok ? '' : read.refusal.reason, 'env-key-refused');
  assert.match(read.ok ? '' : read.refusal.detail, /extraAllowedKeys names NAS_X/);
  assert.match(read.ok ? '' : read.refusal.detail, /extraEnv sets NAS_Y/);
});

// ---------------------------------------------------------------------------
// The refusals. Each one is a value that would otherwise do nothing, silently.
// ---------------------------------------------------------------------------

test('regression: a settings tier this host does not know is refused, never ignored', () => {
  const read = readSessionRequest(sessionNewRequest({ settingSources: ['project', 'enterprise'] }));
  assert.equal(read.ok, false);
  assert.equal(read.ok ? '' : read.refusal.reason, 'frame-malformed');
  assert.match(
    read.ok ? '' : read.refusal.detail,
    /enterprise/,
    'the refusal must name the value it refused',
  );
  assert.match(
    read.ok ? '' : read.refusal.detail,
    /permission rules nobody told it were absent/,
    'the refusal must say WHY dropping it would be worse',
  );
});

test('regression: a plugin type the SDK does not support is refused; loading nothing quietly is the failure', () => {
  const read = readSessionRequest(
    sessionNewRequest({ plugins: [{ type: 'remote', path: 'https://x/y', skipMcpDiscovery: null }] }),
  );
  assert.equal(read.ok, false);
  assert.match(read.ok ? '' : read.refusal.detail, /"remote"/);
});

test('regression: a thinking shape this SDK does not declare is refused', () => {
  const read = readSessionRequest(sessionNewRequest({ thinking: { type: 'verbose' } }));
  assert.equal(read.ok, false);
  assert.match(read.ok ? '' : read.refusal.detail, /verbose/);
});

test('an MCP server declared under an empty name is refused — its tools would be unreachable', () => {
  const read = readSessionRequest(sessionNewRequest({ mcpServers: { '': { type: 'http' } } }));
  assert.equal(read.ok, false);
  assert.equal(read.ok ? '' : read.refusal.reason, 'mcp-descriptor-invalid');
});

test('an MCP server whose config is not an object is refused rather than handed to the SDK', () => {
  const read = readSessionRequest(sessionNewRequest({ mcpServers: { probe: 'http://x' as never } }));
  assert.equal(read.ok, false);
  assert.equal(read.ok ? '' : read.refusal.reason, 'mcp-descriptor-invalid');
});

// ---------------------------------------------------------------------------
// The copies that could drift from the SDK.
// ---------------------------------------------------------------------------

test('regression: every setting source and thinking type this file lists is one the SDK actually declares', () => {
  // The same argument as the permission pin's: a name checked against nothing is a name that can be
  // wrong forever. Two small copies exist here because the SDK ships them as bare string unions with
  // no runtime value to read, so this is what keeps them honest.
  const types = readFileSync(
    fileURLToPath(new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts', import.meta.url)),
    'utf8',
  );

  // Positive control FIRST: prove the file loaded and the search can find something known-present,
  // or every assertion below passes for the wrong reason.
  assert.ok(types.length > 100_000, `sdk.d.ts looks unread: ${types.length} chars`);
  assert.match(
    types,
    /SettingSource = 'user' \| 'project' \| 'local'/,
    'the search cannot find a union it has',
  );

  for (const source of SETTING_SOURCES) {
    assert.match(types, new RegExp(`'${source}'`), `${source} is not a name the SDK declares`);
  }
  for (const thinking of THINKING_TYPES) {
    assert.match(
      types,
      new RegExp(`type: '${thinking}'`),
      `${thinking} is not a thinking shape the SDK declares`,
    );
  }
  assert.deepEqual([...SETTING_SOURCES], ['user', 'project', 'local']);
});

// ---------------------------------------------------------------------------
// The merge, and the collision neither side may win.
// ---------------------------------------------------------------------------

const server = (url: string): McpServerConfig => ({ type: 'http', url }) as unknown as McpServerConfig;

test('the host keeps its own tools when the controller registers none, and vice versa', () => {
  const hostOnly = mergeMcpServers(undefined, { host: server('http://host/mcp') });
  assert.deepEqual(hostOnly.ok ? Object.keys(hostOnly.value ?? {}) : [], ['host']);

  const controllerOnly = mergeMcpServers({ theirs: server('http://theirs/mcp') }, null);
  assert.deepEqual(controllerOnly.ok ? Object.keys(controllerOnly.value ?? {}) : [], ['theirs']);
});

test('both sets survive a merge — registering tools does not cost the host its own', () => {
  const merged = mergeMcpServers(
    { theirs: server('http://theirs/mcp') },
    { host: server('http://host/mcp') },
  );
  assert.equal(merged.ok, true);
  assert.deepEqual(Object.keys(merged.ok ? (merged.value ?? {}) : {}).sort(), ['host', 'theirs']);
});

test('regression: a name both sides claim is refused; neither precedence is safe', () => {
  // If the controller wins, a remote peer replaces the host's own tool server, the one carrying the
  // host's identity into every call. If the host wins, a registration the controller believes it
  // made silently does not exist. Refused before any process exists, naming the server both sides
  // claimed.
  const merged = mergeMcpServers(
    { shared: server('http://theirs/mcp') },
    { shared: server('http://host/mcp') },
  );
  assert.equal(merged.ok, false);
  assert.equal(merged.ok ? '' : merged.refusal.reason, 'mcp-descriptor-invalid');
  assert.match(merged.ok ? '' : merged.refusal.detail, /"shared"/);
  assert.match(merged.ok ? '' : merged.refusal.detail, /Rename one/);
});

// ---------------------------------------------------------------------------
// protocol v6: the CLI-parity members and the live change.
// ---------------------------------------------------------------------------

test('regression: an effort level the SDK does not declare is refused, never dropped', () => {
  assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max']);
  const read = readSessionRequest(sessionNewRequest({ effort: 'extreme' }));
  assert.equal(read.ok, false);
  assert.equal(read.ok ? '' : read.refusal.reason, 'frame-malformed');
  assert.match(read.ok ? '' : read.refusal.detail, /extreme/);
});

test('regression: a permission mode the SDK does not declare is refused, never dropped, and never defaulted', () => {
  assert.deepEqual(
    [...PERMISSION_MODES],
    ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'],
  );
  const read = readSessionRequest(sessionNewRequest({ permissionMode: 'yolo' }));
  assert.equal(read.ok, false);
  assert.equal(read.ok ? '' : read.refusal.reason, 'frame-malformed');
  assert.match(read.ok ? '' : read.refusal.detail, /yolo/);
});

// ---------------------------------------------------------------------------
// protocol 15: the runtime a session runs on.
// ---------------------------------------------------------------------------

test('a runtime this host cannot spawn is refused runtime-unavailable, naming it, before any other member is read', () => {
  // The env lane here would refuse on its own (nothing is declared); the runtime is refused first.
  const read = readSessionRequest(
    sessionNewRequest({
      runtime: 'example-runtime',
      env: { extraAllowedKeys: ['NAS_X'], extraDeniedKeys: null, extraEnv: null },
    }),
  );
  assert.equal(read.ok, false);
  assert.equal(read.ok ? '' : read.refusal.reason, 'runtime-unavailable');
  assert.match(read.ok ? '' : read.refusal.detail, /"example-runtime"/);
  assert.match(read.ok ? '' : read.refusal.detail, /claude/);
});

test('null, absent and claude open as before: claude composes as the named runtime, null and absent compose nothing', () => {
  const named = readSessionRequest(sessionNewRequest({ runtime: 'claude' }));
  assert.equal(named.ok, true);
  assert.deepEqual(named.ok ? named.value : null, { runtime: 'claude' });

  const stated = readSessionRequest(sessionNewRequest({ runtime: null }));
  assert.deepEqual(stated.ok ? stated.value : null, {}, 'a null runtime composes nothing');

  const absent = readSessionRequest(sessionNewRequest());
  assert.equal('runtime' in (absent.ok ? absent.value : {}), false, 'an absent runtime composes nothing');
  assert.equal('runtime' in sessionNewRequest(), false, 'the builder leaves an unasked runtime out');
});

test('readSessionConfigure narrows the live change: asked members only, unknown values refused by name', () => {
  const nothing = readSessionConfigure({
    kind: 'session_configure',
    model: null,
    permissionMode: null,
    thinking: null,
  });
  assert.equal(nothing.ok, true);
  assert.deepEqual(nothing.ok ? nothing.value : null, {}, 'nothing asked, nothing changed');

  const all = readSessionConfigure({
    kind: 'session_configure',
    model: 'claude-opus-5',
    permissionMode: 'plan',
    thinking: { type: 'adaptive', display: 'summarized' },
  });
  assert.equal(all.ok, true);
  assert.deepEqual(all.ok ? all.value : null, {
    model: 'claude-opus-5',
    permissionMode: 'plan',
    thinking: { type: 'adaptive', display: 'summarized' },
  });

  const badMode = readSessionConfigure({
    kind: 'session_configure',
    model: null,
    permissionMode: 'yolo',
    thinking: null,
  });
  assert.equal(badMode.ok, false);
  assert.equal(badMode.ok ? '' : badMode.refusal.reason, 'frame-malformed');

  const badThinking = readSessionConfigure({
    kind: 'session_configure',
    model: null,
    permissionMode: null,
    thinking: { type: 'sometimes' },
  });
  assert.equal(badThinking.ok, false);
  assert.equal(badThinking.ok ? '' : badThinking.refusal.reason, 'frame-malformed');
});

test('regression: a fixed thinking budget is refused by name at both doors, and the refusal names the fix', () => {
  // `enabled` with a budget is the SDK's own shape, and the current models answer it with a 400, so a
  // session that took it would open and then fail its first turn. Refused before anything starts.
  const fixed = { type: 'enabled', budgetTokens: 2048 };
  const opened = readSessionRequest(sessionNewRequest({ thinking: fixed }));
  const configured = readSessionConfigure({
    kind: 'session_configure',
    model: null,
    permissionMode: null,
    thinking: fixed,
  });
  for (const read of [opened, configured]) {
    assert.equal(read.ok, false, 'a fixed budget was accepted');
    assert.equal(read.ok ? '' : read.refusal.reason, 'frame-malformed');
    assert.match(read.ok ? '' : read.refusal.detail, /fixed token budget/);
    assert.match(read.ok ? '' : read.refusal.detail, /"adaptive"/, 'the refusal says what to ask for');
  }
});

test('adaptive thinking takes display summarized or omitted, and nothing else; absent or null is the default', () => {
  for (const thinking of [
    { type: 'adaptive' },
    { type: 'adaptive', display: 'summarized' },
    { type: 'adaptive', display: 'omitted' },
    { type: 'adaptive', display: null },
    { type: 'disabled' },
  ]) {
    const read = readSessionRequest(sessionNewRequest({ thinking }));
    assert.equal(read.ok, true, `${JSON.stringify(thinking)} was refused`);
  }
  const unknown = readSessionRequest(
    sessionNewRequest({ thinking: { type: 'adaptive', display: 'highlights' } }),
  );
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok ? '' : unknown.refusal.detail, /highlights/);
});

test('every display this file lists is one the SDK declares for adaptive thinking', () => {
  const types = readFileSync(
    fileURLToPath(new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts', import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const adaptive = /export declare type ThinkingAdaptive = \{([^}]*)\}/.exec(types)?.[1] ?? '';
  // Positive control: the declaration was found and it is the one carrying `display`.
  assert.match(adaptive, /type: 'adaptive'/, 'ThinkingAdaptive was not found in sdk.d.ts');
  for (const display of THINKING_DISPLAYS) {
    assert.match(
      adaptive,
      new RegExp(`'${display}'`),
      `${display} is not a display ThinkingAdaptive declares`,
    );
  }
});

test('regression: an extraEnv key beneath the floor is refused env-key-refused before anything is composed', () => {
  for (const key of [
    'PATH',
    'path',
    'NODE_OPTIONS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'ANTHROPIC_BASE_URL',
    'LD_PRELOAD',
  ]) {
    const refused = readSessionRequest(
      sessionNewRequest({ env: { extraAllowedKeys: null, extraDeniedKeys: null, extraEnv: { [key]: 'x' } } }),
    );
    assert.equal(refused.ok, false, `${key} was accepted`);
    assert.equal(refused.ok ? '' : refused.refusal.reason, 'env-key-refused');
    assert.match(refused.ok ? '' : refused.refusal.detail, new RegExp(key));
  }
});

/** A key above the floor, and one only an embedder-shortened floor lets through: the control and its twin. */
const ABOVE_THE_FLOOR = sessionNewRequest({
  env: { extraAllowedKeys: null, extraDeniedKeys: null, extraEnv: { NAS_Y: '1' } },
});
const NODE_OPTIONS_SET = sessionNewRequest({
  env: { extraAllowedKeys: null, extraDeniedKeys: null, extraEnv: { NODE_OPTIONS: '--x' } },
});

test('control: a key above the floor composes, and an embedder-shortened floor admits what it names', () => {
  const above = readSessionRequest(ABOVE_THE_FLOOR, EXTRA_ENV_FLOOR, ['NAS_Y']);
  assert.equal(above.ok, true);

  const widened = readSessionRequest(NODE_OPTIONS_SET, ['PATH'], ['NODE_OPTIONS']);
  assert.equal(widened.ok, true, "the floor is the embedder's: a shorter list admits NODE_OPTIONS");
});

test('regression: the same two requests with nothing declared are refused env-key-refused, naming the key', () => {
  // The twin of the control above: being above the floor, or beneath none, is not enough. A key
  // reaches the spawn by a controller's lane only when this host's operator declared it.
  const above = readSessionRequest(ABOVE_THE_FLOOR);
  assert.equal(above.ok, false, 'a key above the floor was accepted with nothing declared');
  assert.equal(above.ok ? '' : above.refusal.reason, 'env-key-refused');
  assert.match(above.ok ? '' : above.refusal.detail, /NAS_Y/);

  const widened = readSessionRequest(NODE_OPTIONS_SET, ['PATH']);
  assert.equal(widened.ok, false, 'a shortened floor admitted a key nobody declared');
  assert.equal(widened.ok ? '' : widened.refusal.reason, 'env-key-refused');
  assert.match(widened.ok ? '' : widened.refusal.detail, /NODE_OPTIONS/);
});

// ---------------------------------------------------------------------------
// The controller's two env lanes. A key reaches the spawn by either lane only when this host's
// operator declared it, and nothing declares a key by default.
// ---------------------------------------------------------------------------

/**
 * The environment a spawn would receive for this request over the stated base environment. The base
 * is always the test's own literal and never `process.env`, so a failure message prints only what the
 * test put there, not this machine's variables.
 */
function spawnedFrom(base: EnvSource, read: ReturnType<typeof readSessionRequest>): Record<string, string> {
  return read.ok ? composeSpawnEnv(base, read.value.env ?? {}) : {};
}

test('regression: extraAllowedKeys cannot re-admit ANTHROPIC_BASE_URL from the host environment', () => {
  // The allow-list keeps the host's own model endpoint out of every spawn. Naming it in
  // extraAllowedKeys must not put it back: that would send the session's model traffic to a server
  // the controller chose.
  const base = { ANTHROPIC_BASE_URL: 'https://elsewhere.example' };
  const read = readSessionRequest(
    sessionNewRequest({
      env: { extraAllowedKeys: ['ANTHROPIC_BASE_URL'], extraDeniedKeys: null, extraEnv: null },
    }),
  );
  assert.equal(
    read.ok,
    false,
    `accepted; the spawn environment would be ${JSON.stringify(spawnedFrom(base, read))}`,
  );
  assert.equal(read.ok ? '' : read.refusal.reason, 'env-key-refused');
  assert.match(read.ok ? '' : read.refusal.detail, /ANTHROPIC_BASE_URL/);
});

test('regression: extraEnv cannot switch the model provider and name the server it calls', () => {
  const base = {};
  const read = readSessionRequest(
    sessionNewRequest({
      env: {
        extraAllowedKeys: null,
        extraDeniedKeys: null,
        extraEnv: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: 'https://x' },
      },
    }),
  );
  assert.equal(
    read.ok,
    false,
    `accepted; the spawn environment would be ${JSON.stringify(spawnedFrom(base, read))}`,
  );
  assert.equal(read.ok ? '' : read.refusal.reason, 'env-key-refused');
  assert.match(read.ok ? '' : read.refusal.detail, /CLAUDE_CODE_USE_BEDROCK/);
  assert.match(read.ok ? '' : read.refusal.detail, /ANTHROPIC_BEDROCK_BASE_URL/);
});

test('regression: extraEnv cannot route the agent through a proxy it trusts, in either spelling of the proxy key', () => {
  // Tools on POSIX read both `HTTPS_PROXY` and `https_proxy`, so each spelling is refused by name,
  // and the certificate file that would make the proxy trusted with it.
  const base = {};
  const read = readSessionRequest(
    sessionNewRequest({
      env: {
        extraAllowedKeys: null,
        extraDeniedKeys: null,
        extraEnv: { HTTPS_PROXY: 'http://x', https_proxy: 'http://x', SSL_CERT_FILE: 'C:\\x.pem' },
      },
    }),
  );
  assert.equal(
    read.ok,
    false,
    `accepted; the spawn environment would be ${JSON.stringify(spawnedFrom(base, read))}`,
  );
  assert.equal(read.ok ? '' : read.refusal.reason, 'env-key-refused');
  assert.match(read.ok ? '' : read.refusal.detail, /HTTPS_PROXY/);
  assert.match(read.ok ? '' : read.refusal.detail, /https_proxy/);
  assert.match(read.ok ? '' : read.refusal.detail, /SSL_CERT_FILE/);
});

// Each of the three requests above is held by two screens, and each screen is proven here on its
// own: the floor with every key declared, the declaration with the floor emptied, and the pair that
// admits them when an embedder empties the floor and the operator declares the keys.

interface EnvAttack {
  readonly name: string;
  /** The host's own environment, a literal: never `process.env`. */
  readonly base: EnvSource;
  readonly env: SessionNewEnv;
  /** Every key the request places, in the spelling sent. */
  readonly keys: readonly string[];
  /** What an operator declares to admit them. Case-insensitive, so one spelling admits both. */
  readonly declare: readonly string[];
}

const ENV_ATTACKS: readonly EnvAttack[] = [
  {
    name: 'the host model endpoint re-admitted',
    base: { ANTHROPIC_BASE_URL: 'https://elsewhere.example' },
    env: { extraAllowedKeys: ['ANTHROPIC_BASE_URL'], extraDeniedKeys: null, extraEnv: null },
    keys: ['ANTHROPIC_BASE_URL'],
    declare: ['ANTHROPIC_BASE_URL'],
  },
  {
    name: 'the provider switched and its server named',
    base: {},
    env: {
      extraAllowedKeys: null,
      extraDeniedKeys: null,
      extraEnv: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: 'https://x' },
    },
    keys: ['CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BEDROCK_BASE_URL'],
    declare: ['CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BEDROCK_BASE_URL'],
  },
  {
    name: 'a proxy in both spellings and a certificate file',
    base: {},
    env: {
      extraAllowedKeys: null,
      extraDeniedKeys: null,
      extraEnv: { HTTPS_PROXY: 'http://x', https_proxy: 'http://x', SSL_CERT_FILE: 'C:\\x.pem' },
    },
    keys: ['HTTPS_PROXY', 'https_proxy', 'SSL_CERT_FILE'],
    declare: ['HTTPS_PROXY', 'SSL_CERT_FILE'],
  },
];

test('regression: the floor alone refuses each of them, with every key declared', () => {
  for (const attack of ENV_ATTACKS) {
    const read = readSessionRequest(sessionNewRequest({ env: attack.env }), EXTRA_ENV_FLOOR, attack.keys);
    assert.equal(
      read.ok,
      false,
      `${attack.name}: accepted with every key declared; the spawn environment would be ` +
        JSON.stringify(spawnedFrom(attack.base, read)),
    );
    assert.equal(read.ok ? '' : read.refusal.reason, 'env-key-refused');
    assert.match(read.ok ? '' : read.refusal.detail, /floor/, `${attack.name}: refused by the floor`);
    for (const key of attack.keys) {
      assert.ok(
        (read.ok ? '' : read.refusal.detail).includes(key),
        `${attack.name}: the refusal does not name ${key}`,
      );
    }
  }
});

test('regression: the declaration alone refuses each of them, with the floor emptied', () => {
  for (const attack of ENV_ATTACKS) {
    const read = readSessionRequest(sessionNewRequest({ env: attack.env }), [], []);
    assert.equal(
      read.ok,
      false,
      `${attack.name}: accepted with nothing declared; the spawn environment would be ` +
        JSON.stringify(spawnedFrom(attack.base, read)),
    );
    assert.equal(read.ok ? '' : read.refusal.reason, 'env-key-refused');
    assert.match(read.ok ? '' : read.refusal.detail, /not declared/, `${attack.name}: refused as undeclared`);
    for (const key of attack.keys) {
      assert.ok(
        (read.ok ? '' : read.refusal.detail).includes(key),
        `${attack.name}: the refusal does not name ${key}`,
      );
    }
  }
});

test('control: an emptied floor and a declaration admit each of them, and the spawn carries every key', () => {
  // The pair the two tests above stand on: the same request, the same screens, one variable each.
  // A declaration in one spelling admits both, so `https_proxy` arrives on `HTTPS_PROXY`'s name.
  for (const attack of ENV_ATTACKS) {
    const read = readSessionRequest(sessionNewRequest({ env: attack.env }), [], attack.declare);
    assert.equal(read.ok, true, `${attack.name}: ${read.ok ? '' : read.refusal.detail}`);
    const spawned = spawnedFrom(attack.base, read);
    for (const key of attack.keys) {
      assert.ok(key in spawned, `${attack.name}: the spawn does not carry ${key}`);
    }
  }
});

test('control: an env whose three lanes are all null composes an empty policy, with nothing declared', () => {
  const read = readSessionRequest(
    sessionNewRequest({ env: { extraAllowedKeys: null, extraDeniedKeys: null, extraEnv: null } }),
  );
  assert.equal(read.ok, true, read.ok ? '' : read.refusal.detail);
  assert.deepEqual(read.ok ? read.value.env : null, {});
});

test('control: extraDeniedKeys only removes keys, so it is never screened, a floored name included', () => {
  const read = readSessionRequest(
    sessionNewRequest({
      env: { extraAllowedKeys: null, extraDeniedKeys: ['ANTHROPIC_BASE_URL', 'NAS_Z'], extraEnv: null },
    }),
  );
  assert.equal(read.ok, true, read.ok ? '' : read.refusal.detail);
  assert.deepEqual(read.ok ? read.value.env : null, { extraDeniedKeys: ['ANTHROPIC_BASE_URL', 'NAS_Z'] });
});

// ---------------------------------------------------------------------------
// The endpoint a session names: chosen by name, never described.
// ---------------------------------------------------------------------------

/** An endpoint that is not Anthropic's own route, its tiers mapped to its own ids. */
const OPEN_WEIGHT: ModelEndpoint = {
  name: 'open-weight',
  wireApi: 'anthropic-messages',
  runtimes: ['claude'],
  baseUrl: 'https://open-weight.example/anthropic',
  models: ['open-model', 'open-model-small'],
  modelAliases: { opus: 'open-model', sonnet: 'open-model', haiku: 'open-model-small' },
  contextWindow: null,
  env: {},
  firstParty: false,
  authToken: () => 'open-weight-token',
};

test('a request that names no endpoint composes none, whatever endpoints the host declares', () => {
  const read = readSessionRequest(
    sessionNewRequest({ model: 'claude-opus-5-5' }),
    EXTRA_ENV_FLOOR,
    [],
    [OPEN_WEIGHT],
  );
  assert.equal(read.ok, true, read.ok ? '' : read.refusal.detail);
  assert.equal(read.ok ? 'endpoint' in read.value : true, false);
});

test('a declared endpoint is composed by its name, and nothing it describes rides the request', () => {
  const read = readSessionRequest(
    sessionNewRequest({ endpoint: 'open-weight', model: 'open-model' }),
    EXTRA_ENV_FLOOR,
    [],
    [OPEN_WEIGHT],
  );
  assert.equal(read.ok, true, read.ok ? '' : read.refusal.detail);
  assert.deepEqual(read.ok ? read.value : null, { endpoint: 'open-weight', model: 'open-model' });
});

test('an endpoint the host does not declare is refused endpoint-unknown, naming it and the ones it declares', () => {
  const read = readSessionRequest(
    sessionNewRequest({ endpoint: 'elsewhere' }),
    EXTRA_ENV_FLOOR,
    [],
    [OPEN_WEIGHT],
  );
  assert.equal(read.ok ? '' : read.refusal.reason, 'endpoint-unknown');
  assert.match(
    read.ok ? '' : read.refusal.detail,
    /"elsewhere" is not one this host declares; .* are open-weight/,
  );
  const none = readSessionRequest(sessionNewRequest({ endpoint: 'elsewhere' }));
  assert.match(none.ok ? '' : none.refusal.detail, /lists are none/);
});

test("an endpoint that cannot carry the runtime is refused endpoint-incompatible, for either of its one meaning's two causes", () => {
  const excluded = readSessionRequest(
    sessionNewRequest({ endpoint: 'open-weight' }),
    EXTRA_ENV_FLOOR,
    [],
    [{ ...OPEN_WEIGHT, runtimes: ['example-runtime'] }],
  );
  assert.equal(excluded.ok ? '' : excluded.refusal.reason, 'endpoint-incompatible');
  assert.match(
    excluded.ok ? '' : excluded.refusal.detail,
    /does not carry runtime claude; it carries example-runtime/,
  );

  const unspoken = readSessionRequest(
    sessionNewRequest({ endpoint: 'open-weight' }),
    EXTRA_ENV_FLOOR,
    [],
    [{ ...OPEN_WEIGHT, wireApi: 'openai-chat' }],
  );
  assert.equal(unspoken.ok ? '' : unspoken.refusal.reason, 'endpoint-incompatible');
  assert.match(
    unspoken.ok ? '' : unspoken.refusal.detail,
    /speaks openai-chat, which runtime claude does not speak/,
  );
});

test("regression: a Claude model id on an endpoint that is not Anthropic's own route is refused model-endpoint-mismatch, naming both", () => {
  const read = readSessionRequest(
    sessionNewRequest({ endpoint: 'open-weight', model: 'claude-opus-5-5' }),
    EXTRA_ENV_FLOOR,
    [],
    [OPEN_WEIGHT],
  );
  assert.equal(read.ok ? '' : read.refusal.reason, 'model-endpoint-mismatch');
  assert.match(read.ok ? '' : read.refusal.detail, /^model claude-opus-5-5 named for endpoint "open-weight"/);

  // Twins: the same id on a first-party route opens, and the endpoint's own id opens.
  const firstParty = readSessionRequest(
    sessionNewRequest({ endpoint: 'open-weight', model: 'claude-opus-5-5' }),
    EXTRA_ENV_FLOOR,
    [],
    [{ ...OPEN_WEIGHT, firstParty: true }],
  );
  assert.equal(firstParty.ok, true, firstParty.ok ? '' : firstParty.refusal.detail);
  const own = readSessionRequest(
    sessionNewRequest({ endpoint: 'open-weight', model: 'open-model' }),
    EXTRA_ENV_FLOOR,
    [],
    [OPEN_WEIGHT],
  );
  assert.equal(own.ok, true, own.ok ? '' : own.refusal.detail);
});

test('an alias the endpoint does not map is refused model-endpoint-mismatch; a mapped one and no model open', () => {
  const asked = (model: string | null) =>
    readSessionRequest(
      sessionNewRequest({ endpoint: 'open-weight', model }),
      EXTRA_ENV_FLOOR,
      [],
      [OPEN_WEIGHT],
    );
  for (const model of ['default', 'opusplan', 'fable', 'best[1m]']) {
    const read = asked(model);
    assert.equal(read.ok ? '' : read.refusal.reason, 'model-endpoint-mismatch', `${model} opened`);
  }
  for (const model of ['opus', 'sonnet[1m]', 'haiku', null]) {
    const read = asked(model);
    assert.equal(read.ok, true, `${String(model)}: ${read.ok ? '' : read.refusal.detail}`);
  }
});

test("the variables an endpoint sets refuse on both of a controller's lanes: undeclared, and beneath the floor when declared", () => {
  // The names the host's own lane sets for an endpoint. A controller may set none of them itself.
  const names = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
    'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
  ];
  for (const name of names) {
    for (const env of [
      { extraAllowedKeys: [name], extraDeniedKeys: null, extraEnv: null },
      { extraAllowedKeys: null, extraDeniedKeys: null, extraEnv: { [name]: '1' } },
    ]) {
      const undeclared = readSessionRequest(sessionNewRequest({ env }));
      assert.equal(undeclared.ok ? '' : undeclared.refusal.reason, 'env-key-refused', `${name} undeclared`);
      if (name.startsWith('ANTHROPIC_')) {
        const declared = readSessionRequest(sessionNewRequest({ env }), EXTRA_ENV_FLOOR, [name]);
        assert.equal(declared.ok ? '' : declared.refusal.reason, 'env-key-refused', `${name} declared`);
        assert.match(declared.ok ? '' : declared.refusal.detail, /beneath this host's floor/);
      }
    }
  }
});
