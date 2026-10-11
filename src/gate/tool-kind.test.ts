/**
 * Every gated call carries a kind. Claude's tool names are read as the kinds the decision request
 * states, a name the map does not know is `other`, and the request the gate builds carries the kind
 * and the session's runtime to every decider, the HTTP one included.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { HookInput } from '../host/agent-process.js';
import type { DecisionRequest, ToolKind } from './decision.js';
import { TOOL_KINDS } from './decision.js';
import type { EscalationTransport } from './escalate.js';
import { escalatingDecider } from './escalate.js';
import { permissionHooks } from './gate.js';
import { DEFAULT_TOOL_FAMILIES } from './local.js';
import { CLAUDE_TOOL_KINDS, claudeToolKind } from './tool-kind.js';

/**
 * Each input type the agent SDK's `sdk-tools.d.ts` declares, the tool name a `PreToolUse` input
 * carries for it, and that tool's kind. The kind of a name that maps to `other` does not depend on
 * its spelling; the names that map anywhere else are the gate's own families, exactly.
 */
const SDK_TOOLS: ReadonlyArray<readonly [inputType: string, toolName: string, kind: ToolKind]> = [
  ['AgentInput', 'Agent', 'other'],
  ['BashInput', 'Bash', 'shell'],
  ['ExitPlanModeInput', 'ExitPlanMode', 'other'],
  ['FileEditInput', 'Edit', 'file_edit'],
  ['FileReadInput', 'Read', 'file_read'],
  ['FileWriteInput', 'Write', 'file_write'],
  ['GlobInput', 'Glob', 'file_read'],
  ['GrepInput', 'Grep', 'file_read'],
  ['TaskStopInput', 'TaskStop', 'other'],
  ['ListMcpResourcesInput', 'ListMcpResourcesTool', 'other'],
  ['RefreshMcpToolsInput', 'RefreshMcpTools', 'other'],
  ['McpInput', 'mcp__docs__search', 'mcp'],
  ['NotebookEditInput', 'NotebookEdit', 'file_edit'],
  ['ReadMcpResourceDirInput', 'ReadMcpResourceDir', 'other'],
  ['ReadMcpResourceInput', 'ReadMcpResourceTool', 'other'],
  ['ReportFindingsInput', 'ReportFindings', 'other'],
  ['TodoWriteInput', 'TodoWrite', 'other'],
  ['WebFetchInput', 'WebFetch', 'web'],
  ['WebSearchInput', 'WebSearch', 'web'],
  ['AskUserQuestionInput', 'AskUserQuestion', 'other'],
  ['SendFeedbackInput', 'SendFeedback', 'other'],
  ['ClaudeDesignInput', 'ClaudeDesign', 'other'],
  ['ProjectsInput', 'Projects', 'other'],
  ['EnterPlanModeInput', 'EnterPlanMode', 'other'],
  ['TaskCreateInput', 'TaskCreate', 'other'],
  ['TaskGetInput', 'TaskGet', 'other'],
  ['TaskUpdateInput', 'TaskUpdate', 'other'],
  ['TaskListInput', 'TaskList', 'other'],
  ['WorkflowInput', 'Workflow', 'other'],
  ['CronCreateInput', 'CronCreate', 'other'],
  ['CronDeleteInput', 'CronDelete', 'other'],
  ['CronListInput', 'CronList', 'other'],
  ['ScheduleWakeupInput', 'ScheduleWakeup', 'other'],
  ['RemoteTriggerInput', 'RemoteTrigger', 'other'],
  ['ShowOnboardingRolePickerInput', 'ShowOnboardingRolePicker', 'other'],
  ['ReadNotificationsInput', 'ReadNotifications', 'other'],
  // Its input carries a shell command, and it is `other`: the map names the shell family the gate
  // classifies, and this tool is not in it.
  ['MonitorInput', 'Monitor', 'other'],
  ['ProposeSkillsInput', 'ProposeSkills', 'other'],
  ['ProposeGoalInput', 'ProposeGoal', 'other'],
  ['ArtifactInput', 'Artifact', 'other'],
  ['PushNotificationInput', 'PushNotification', 'other'],
  ['EnterWorktreeInput', 'EnterWorktree', 'other'],
  ['ExitWorktreeInput', 'ExitWorktree', 'other'],
];

/** The names the gate's own families carry that no input type in this SDK declares. */
const FAMILY_ONLY_TOOLS: ReadonlyArray<readonly [toolName: string, kind: ToolKind]> = [
  ['PowerShell', 'shell'],
  ['NotebookRead', 'file_read'],
  ['MultiEdit', 'file_edit'],
];

test("every Claude tool name maps to its documented kind, and a name the map does not know is 'other'", () => {
  const misread = [...SDK_TOOLS.map(([, name, kind]) => [name, kind] as const), ...FAMILY_ONLY_TOOLS].flatMap(
    ([name, kind]) => {
      const read = claudeToolKind(name);
      return read === kind ? [] : [`${name}: expected ${kind}, read ${read}`];
    },
  );
  assert.deepEqual(misread, []);

  // An unknown name and a known one side by side: the fallback is `other`, and it is a fallback, not
  // the answer for everything.
  assert.equal(claudeToolKind('a-tool-no-table-names'), 'other');
  assert.equal(claudeToolKind('Bash'), 'shell');
  // A name that merely contains the MCP prefix is not an MCP tool; one that starts with it is.
  assert.equal(claudeToolKind('not_mcp__x'), 'other');
  assert.equal(claudeToolKind('mcp__server__tool'), 'mcp');
});

test('the tool kinds are the seven the wire declares, and the map uses no other word', () => {
  assert.deepEqual([...TOOL_KINDS], ['shell', 'file_read', 'file_write', 'file_edit', 'mcp', 'web', 'other']);
  const strays = Object.values(CLAUDE_TOOL_KINDS).filter(
    (kind) => !(TOOL_KINDS as readonly string[]).includes(kind),
  );
  assert.deepEqual(strays, []);
});

test("every tool in the gate's own families has a kind other than 'other', and the one its family names", () => {
  const families: ReadonlyArray<readonly [readonly string[], readonly ToolKind[]]> = [
    [DEFAULT_TOOL_FAMILIES.shell, ['shell']],
    [DEFAULT_TOOL_FAMILIES.read, ['file_read']],
    [DEFAULT_TOOL_FAMILIES.search ?? [], ['file_read']],
    [DEFAULT_TOOL_FAMILIES.write, ['file_write', 'file_edit']],
  ];
  const misread = families.flatMap(([names, kinds]) =>
    names.flatMap((name) =>
      kinds.includes(claudeToolKind(name)) ? [] : [`${name}: ${claudeToolKind(name)}`],
    ),
  );
  assert.deepEqual(misread, []);
  assert.ok(DEFAULT_TOOL_FAMILIES.shell.length >= 2, 'the shell family looks empty');
});

/** The input types `ToolInputSchemas` names in the installed SDK's `sdk-tools.d.ts`. */
function sdkInputTypes(): string[] {
  const types = readFileSync(
    fileURLToPath(
      new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts', import.meta.url),
    ),
    'utf8',
  );
  const union = /export type ToolInputSchemas =([\s\S]*?);/.exec(types)?.[1] ?? '';
  return [...union.matchAll(/\|\s*(\w+Input)\b/g)].map((match) => match[1] ?? '');
}

test('every tool input type the installed SDK declares has its name and kind stated above', () => {
  const declared = sdkInputTypes();
  // Positive control on the reader: a parse that found nothing would make the comparison vacuous.
  assert.ok(
    declared.includes('BashInput'),
    'the reader cannot find an input type the SDK is known to declare',
  );
  assert.ok(declared.length >= 40, `the union looks unread: ${declared.length} types`);

  assert.deepEqual(
    [...declared].sort(),
    SDK_TOOLS.map(([inputType]) => inputType).sort(),
    'the SDK declares a tool input type this table does not state, or no longer declares one it does; ' +
      'state the tool name and its kind',
  );
});

// ---------------------------------------------------------------------------
// The request the gate builds.
// ---------------------------------------------------------------------------

const preToolUse = (toolName: string): HookInput =>
  ({
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    tool_name: toolName,
    tool_input: { command: 'ls' },
    tool_use_id: 'toolu_1',
  }) as unknown as HookInput;

type Handler = (
  input: HookInput,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<unknown>;

/** Runs one call through a gate and returns the request its decider was asked about. */
async function askedAbout(
  input: HookInput,
  options: {
    readonly runtime?: string;
    readonly decide?: (request: DecisionRequest) => Promise<unknown>;
  } = {},
): Promise<DecisionRequest | undefined> {
  let asked: DecisionRequest | undefined;
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    decide: async (request) => {
      asked = request;
      return options.decide === undefined ? { behavior: 'allow' } : options.decide(request);
    },
    onOutcome: () => undefined,
    decisionTimeoutMs: 5_000,
    holdAfterMs: 5_000,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as Handler;
  await handler(input, 'toolu_1', { signal: new AbortController().signal });
  return asked;
}

test("the gate's request carries the tool's kind beside its unchanged name, and the session's runtime", async () => {
  const shell = await askedAbout(preToolUse('Bash'));
  assert.equal(shell?.toolName, 'Bash');
  assert.equal(shell?.toolKind, 'shell');
  assert.equal(shell?.runtime, 'claude', 'a gate composed without a runtime names the default');

  const unknown = await askedAbout(preToolUse('a-tool-no-table-names'));
  assert.equal(unknown?.toolKind, 'other', 'an unmapped name is stated as other, never left out');
});

test('control: a gate composed for another runtime names that runtime, not the default', async () => {
  const asked = await askedAbout(preToolUse('Read'), { runtime: 'example-runtime' });
  assert.equal(asked?.runtime, 'example-runtime');
  assert.equal(asked?.toolKind, 'file_read');
});

test("an input the gate cannot read is refused with a request that still states 'other' and the runtime", async () => {
  const unreadable = {
    hook_event_name: 'PreToolUse',
    get tool_name(): string {
      throw new Error('unreadable');
    },
  } as unknown as HookInput;
  const outcomes: { request: DecisionRequest; kind: string }[] = [];
  const registrations = permissionHooks({
    sessionKey: 'handle-1',
    runtime: 'example-runtime',
    decide: async () => ({ behavior: 'allow' }),
    onOutcome: (outcome) => outcomes.push(outcome),
    decisionTimeoutMs: 5_000,
    holdAfterMs: 5_000,
  });
  const handler = registrations.PreToolUse?.[0]?.hooks[0] as unknown as Handler;
  await handler(unreadable, 'toolu_1', { signal: new AbortController().signal });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.kind, 'refused');
  assert.equal(outcomes[0]?.request.toolKind, 'other');
  assert.equal(outcomes[0]?.request.runtime, 'example-runtime');
});

test('the escalated body carries toolKind and runtime beside every member it carried before', async () => {
  let posted: Record<string, unknown> | undefined;
  const transport: EscalationTransport = async (_url, init) => {
    posted = JSON.parse(init.body) as Record<string, unknown>;
    return { status: 200, text: async () => JSON.stringify({ behavior: 'allow' }) };
  };
  const decide = escalatingDecider({ url: 'https://controller.example/decide', transport });
  await askedAbout(preToolUse('mcp__docs__search'), {
    decide: (request) => decide(request, new AbortController().signal),
  });

  assert.ok(posted !== undefined, 'nothing was posted');
  for (const member of [
    'toolName',
    'toolUseId',
    'toolInput',
    'sessionId',
    'sessionKey',
    'cwd',
    'agentId',
    'agentType',
  ]) {
    assert.ok(member in posted, `the posted body lost ${member}`);
  }
  assert.equal(posted['toolName'], 'mcp__docs__search');
  assert.equal(posted['toolKind'], 'mcp');
  assert.equal(posted['runtime'], 'claude');
});
