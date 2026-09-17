/**
 * What the host's own gate does with an MCP tool — and what it costs that the answer is "nothing".
 *
 * The gap this file makes visible. `localGate` matches on tool name. An MCP tool arrives as
 * `mcp__{server}__{tool}`, matches no default family, and gets no local opinion — so the call
 * escalates to the controller. That is fail-closed and it is correct: this module only ever adds
 * refusals, and inventing an opinion about a tool whose meaning the host does not know is exactly
 * what the package forbids.
 *
 * But "no opinion" undersells the cost, and the cost is the point. With the controller
 * unreachable, an MCP tool call is escalated, waits out the decision deadline, and is refused as
 * `permission-decision-unavailable` — an outage. That is precisely the timeout-then-outage path the
 * host's own gate exists to replace: a local refusal is immediate and names the rule, while this
 * is a long silence ending in "nobody decided". So the offline property does not extend to MCP tools
 * by default.
 *
 * The answer is the embedder's, and the mechanism already exists. `ToolFamilies` is supplied at
 * construction, so a controller registering a tool that runs commands or touches paths names it
 * there and gets the same local refusal `Bash` gets. Both that and the fact that the name reaches
 * this code are checked below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TOOL_FAMILIES, localGate } from './local.js';
import type { DecisionRequest } from './decision.js';

const resolve = (candidate: string): string => (candidate.startsWith('/') ? candidate : `/work/${candidate}`);

function gate(families = DEFAULT_TOOL_FAMILIES): ReturnType<typeof localGate> {
  return localGate({
    workspaceRoot: '/work',
    resolve,
    protectedPaths: ['/home/user/.periscope'],
    toolFamilies: families,
  });
}

function request(toolName: string, toolInput: unknown): DecisionRequest {
  return {
    toolName,
    toolUseId: 'tu-1',
    toolInput,
    sessionId: 's1',
    sessionKey: 'handle-1',
    cwd: '/work',
    agentId: null,
    agentType: null,
  };
}

// The gap, asserted rather than described. An MCP tool carrying a path outside the jail — the
// exact input the local gate refuses for `Read` — gets no opinion under the defaults.
test('an MCP tool gets no local opinion by default, even carrying an input Read would be refused for', () => {
  const escaping = { file_path: '/home/user/.periscope/token-cache.json' };

  assert.notEqual(
    gate()(request('Read', escaping)),
    null,
    'the control is broken: Read must be refused for this input',
  );
  assert.equal(
    gate()(request('mcp__controller__fetch', escaping)),
    null,
    'an MCP tool acquired a local opinion the host has no basis for',
  );
});

test('the no-opinion answer is null — never an allow, so the surrounding gate still asks', () => {
  // Null and "allowed" are different answers, and this module can only ever produce the first. An
  // allow here would remove a refusal, which is the one thing it must never do.
  const answer = gate()(request('mcp__controller__anything', { note: 'x' }));
  assert.equal(answer, null);
});

// The mechanism that closes it, proven reachable. The name is data, so an embedder covers an MCP
// tool exactly as it covers `Bash` — with no host-side knowledge of what the tool means.
test('an embedder can cover an MCP tool by naming it in ToolFamilies, with no change to the host', () => {
  const covered = gate({
    ...DEFAULT_TOOL_FAMILIES,
    shell: [...DEFAULT_TOOL_FAMILIES.shell, 'mcp__controller__run'],
  });

  const refusal = covered(request('mcp__controller__run', { command: 'git push origin main' }));
  assert.notEqual(refusal, null, 'naming an MCP tool in a family did not bring it under the local rules');
  assert.equal(refusal?.reason, 'shell-boundary-command');
});

test('an MCP tool named in the read family is jailed exactly as Read is', () => {
  const covered = gate({
    ...DEFAULT_TOOL_FAMILIES,
    read: [...DEFAULT_TOOL_FAMILIES.read, 'mcp__controller__fetch'],
  });

  const refusal = covered(
    request('mcp__controller__fetch', { file_path: '/home/user/.periscope/token-cache.json' }),
  );
  assert.equal(refusal?.reason, 'credential-path-denied');
});

test('an MCP tool named in the write family is jailed exactly as Write is', () => {
  const covered = gate({
    ...DEFAULT_TOOL_FAMILIES,
    write: [...DEFAULT_TOOL_FAMILIES.write, 'mcp__controller__save'],
  });

  const refusal = covered(request('mcp__controller__save', { file_path: '/elsewhere/x.txt' }));
  assert.equal(refusal?.reason, 'path-escapes-root');
});

// The default families name no MCP tool, and that is deliberate: this package cannot know any tool's
// meaning, so a default that guessed would be a name earned by observation.
test('the shipped defaults name no MCP tool — the host has no basis to guess one', () => {
  const named = [
    ...DEFAULT_TOOL_FAMILIES.write,
    ...DEFAULT_TOOL_FAMILIES.read,
    ...DEFAULT_TOOL_FAMILIES.shell,
  ];

  assert.deepEqual(
    named.filter((name) => name.startsWith('mcp__')),
    [],
    "a default family names an MCP tool — the host is asserting what somebody else's tool does",
  );
});

test('the local gate is still total over an MCP name: it returns, it does not throw', () => {
  for (const input of [null, undefined, {}, { command: 'ls' }, { file_path: '/work/x' }, 'string', 42]) {
    assert.doesNotThrow(() => gate()(request('mcp__controller__odd', input)));
  }
});
