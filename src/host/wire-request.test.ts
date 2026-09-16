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
  THINKING_TYPES,
  mergeMcpServers,
  readSessionConfigure,
  readSessionRequest,
} from './wire-request.js';
import type { McpServerConfig } from './agent-process.js';

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

test('every declared wire key is one this narrowing knows how to carry', () => {
  // The anti-drop check. A field added to the wire type and forgotten here would be accepted by
  // the codec, arrive intact, and then be silently discarded — the exact failure this file exists to
  // make impossible. Driving every key at once and asserting each one lands is what catches it.
  const asked = sessionNewRequest({
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
  });

  const read = readSessionRequest(asked);
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
  assert.deepEqual(composed['settingSources'], ['project']);
  assert.deepEqual(composed['env'], { extraAllowedKeys: ['NAS_X'], extraEnv: { NAS_Y: '1' } });
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
    thinking: { type: 'enabled', budgetTokens: 128000 },
  });
  assert.equal(all.ok, true);
  assert.deepEqual(all.ok ? all.value : null, {
    model: 'claude-opus-5',
    permissionMode: 'plan',
    thinking: { type: 'enabled', budgetTokens: 128000 },
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
