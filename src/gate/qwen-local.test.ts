import test from 'node:test';
import assert from 'node:assert/strict';

import type { DecisionRequest } from './decision.js';
import type { PathResolver } from './jail.js';
import { localGate, QWEN_TOOL_FAMILIES } from './local.js';
import { parseCommand, readCmdCommand } from './command.js';
import { QWEN_TOOL_KINDS, qwenShellDialect, qwenToolKind } from './tool-kind.js';
import { QWEN_NAMES } from '../host/qwen-names.js';

const WORK = 'C:/work/session-1';
const CREDS = 'C:/Users/op/.qwen/oauth_creds.json';

/** A resolver over Windows-shaped absolute paths, the same on every platform this suite runs on. */
const resolve: PathResolver = (path) => {
  const absolute = /^[A-Za-z]:\//.test(path) ? path : `${WORK}/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/');
};

const gate = localGate({
  workspaceRoot: WORK,
  resolve,
  protectedPaths: [CREDS, 'C:/runner/qwen/sessions'],
  home: 'C:/Users/op',
  toolFamilies: QWEN_TOOL_FAMILIES,
  readsShellDialect: true,
  checksShellDirectory: true,
  resolvesAgainstCallCwd: true,
});

function request(
  toolName: string,
  toolInput: Record<string, unknown>,
  extra: Partial<DecisionRequest> = {},
): DecisionRequest {
  return {
    toolName,
    toolUseId: 'call_1',
    toolInput,
    sessionId: 's',
    sessionKey: 'k',
    cwd: WORK,
    agentId: null,
    agentType: null,
    runtime: 'qwen-code',
    toolKind: qwenToolKind(toolName),
    ...(qwenToolKind(toolName) === 'shell' ? { shellDialect: 'cmd' as const } : {}),
    ...extra,
  };
}

test("Qwen Code's file tools are held to the jail and the protected set by their own field names", () => {
  assert.equal(gate(request('read_file', { file_path: CREDS }))?.reason, 'credential-path-denied');
  assert.equal(gate(request('zoom_image', { file_path: CREDS }))?.reason, 'credential-path-denied');
  assert.equal(
    gate(request('list_directory', { path: 'C:/runner/qwen/sessions' }))?.reason,
    'credential-path-denied',
  );
  assert.equal(
    gate(request('write_file', { file_path: 'C:/elsewhere/a.ts', content: 'x' }))?.reason,
    'path-escapes-root',
  );
  assert.equal(gate(request('edit', { file_path: `${WORK}/a.ts`, old_string: 'a', new_string: 'b' })), null);
  assert.equal(
    gate(request('notebook_edit', { notebook_path: 'C:/elsewhere/n.ipynb' }))?.reason,
    'path-escapes-root',
  );
  assert.equal(gate(request('read_file', { file_path: `${WORK}/src/a.ts` })), null);
});

test('a search names its root relative to where the call runs, and one reaching the protected set is refused', () => {
  assert.equal(
    gate(request('grep_search', { pattern: 'x', path: '../../Users/op/.qwen' }))?.reason,
    'credential-path-denied',
  );
  assert.equal(gate(request('glob', { pattern: '*.ts', path: 'src' })), null);
  assert.equal(
    gate(request('glob', { pattern: '*.json', path: 'C:/runner/qwen' }))?.reason,
    'credential-path-denied',
  );
});

test('a shell command runs in the directory it names, and one inside the protected set is refused there', () => {
  assert.equal(
    gate(
      request('run_shell_command', {
        command: 'type system-settings.json',
        directory: 'C:/runner/qwen/sessions/abc',
      }),
    )?.reason,
    'credential-path-denied',
  );
  assert.equal(gate(request('run_shell_command', { command: 'git status', directory: `${WORK}/src` })), null);
  assert.equal(gate(request('monitor', { command: `type ${CREDS}` }))?.reason, 'credential-path-denied');
});

test('cmd.exe reads a caret as an escape, a single quote as nothing and # as text, so each hides nothing from the cmd reading', () => {
  assert.equal(readCmdCommand('git pu^sh origin main'), 'git push origin main');
  assert.equal(readCmdCommand('echo "a^b" & git pu^sh'), 'echo "a^b" & git push');
  assert.equal(readCmdCommand("echo 'a & git push'"), 'echo  a & git push ');
  assert.ok(parseCommand('echo hi #& git push', 'cmd').scannable.includes('push'));
  assert.equal(parseCommand('echo hi #& git push', 'posix').scannable.includes('push'), false);
});

test('a cmd command is read both ways and refused when either reading refuses', () => {
  // The POSIX reading's own rules already refuse an unknown git verb; the cmd reading adds what it misses.
  assert.notEqual(gate(request('run_shell_command', { command: 'git pu^sh origin main' })), null);
  assert.equal(
    gate(request('run_shell_command', { command: 'echo hi #& git push origin main' }))?.reason,
    'shell-boundary-command',
  );
  assert.equal(
    gate(request('run_shell_command', { command: 'type C:/Users/op/.qw^en/oauth_creds.json' }))?.reason,
    'credential-path-denied',
  );
  assert.equal(gate(request('run_shell_command', { command: 'git status' })), null);
});

test('control: read in the POSIX grammar alone, the comment hides the push and the caret hides the protected path', () => {
  const posixOnly = localGate({
    workspaceRoot: WORK,
    resolve,
    protectedPaths: [CREDS],
    toolFamilies: QWEN_TOOL_FAMILIES,
    readsShellDialect: false,
  });
  assert.equal(posixOnly(request('run_shell_command', { command: 'echo hi #& git push origin main' })), null);
  assert.equal(
    posixOnly(request('run_shell_command', { command: 'type C:/Users/op/.qw^en/oauth_creds.json' })),
    null,
  );
});

test("Qwen Code's tools read as kinds: the shell tools, the file tools, the web tools, MCP by prefix, and every other other", () => {
  const kinds = Object.fromEntries(
    [
      'run_shell_command',
      'monitor',
      'read_file',
      'glob',
      'grep_search',
      'list_directory',
      'zoom_image',
      'display_image',
      'write_file',
      'edit',
      'notebook_edit',
      'web_fetch',
      'web_search',
      'mcp__nas__seat_read',
      'exec',
      'agent',
      'skill',
    ].map((tool) => [tool, qwenToolKind(tool)]),
  );
  assert.deepEqual(kinds, {
    run_shell_command: 'shell',
    monitor: 'shell',
    read_file: 'file_read',
    glob: 'file_read',
    grep_search: 'file_read',
    list_directory: 'file_read',
    zoom_image: 'file_read',
    display_image: 'file_read',
    write_file: 'file_write',
    edit: 'file_edit',
    notebook_edit: 'file_edit',
    web_fetch: 'web',
    web_search: 'web',
    mcp__nas__seat_read: 'mcp',
    exec: 'other',
    agent: 'other',
    skill: 'other',
  });
});

test('the dialect is the shell the CLI picks from its environment: Git Bash, PowerShell by ComSpec, else cmd; bash off Windows', () => {
  assert.equal(qwenShellDialect('linux', { ComSpec: 'cmd.exe' }), 'posix');
  assert.equal(qwenShellDialect('win32', {}), 'cmd');
  assert.equal(qwenShellDialect('win32', { COMSPEC: 'C:\\Windows\\system32\\cmd.exe' }), 'cmd');
  assert.equal(
    qwenShellDialect('win32', { ComSpec: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }),
    'powershell',
  );
  assert.equal(qwenShellDialect('win32', { COMSPEC: 'powershell.exe' }), 'powershell');
  assert.equal(qwenShellDialect('win32', { MSYSTEM: 'MINGW64', ComSpec: 'pwsh.exe' }), 'posix');
  assert.equal(qwenShellDialect('win32', { TERM: 'cygwin' }), 'posix');
  assert.equal(qwenShellDialect('win32', { TERM: 'xterm-256color' }), 'cmd');
});

/**
 * The tools of the pinned release that run no command and name no path this gate reads, each stated
 * `other` by name: a tool the release adds must land here or in `QWEN_TOOL_KINDS`, never in `other` by
 * default. `autofix_pr` runs the CLI's own pull-request helpers by name, so its input is no command line.
 */
const QWEN_OTHER_TOOLS = [
  'exec',
  'todo_write',
  'save_memory',
  'manage_memory',
  'search_memory',
  'agent',
  'skill',
  'exit_plan_mode',
  'enter_plan_mode',
  'image_gen',
  'lsp',
  'ask_user_question',
  'cron_create',
  'cron_list',
  'cron_delete',
  'autofix_pr',
  'loop_wakeup',
  'create_sub_session',
  'list_agents',
  'task_stop',
  'task_create',
  'task_update',
  'task_list',
  'team_create',
  'team_delete',
  'team_plan_approval',
  'request_shutdown',
  'send_message',
  'structured_output',
  'tool_call',
  'tool_search',
  'read_mcp_resource',
  'advisor',
  'enter_worktree',
  'exit_worktree',
  'workflow',
  'artifact',
  'record_artifact',
  'record_source',
  'report_findings',
  'get_goal',
  'update_goal',
  'omni_downsample_image',
  'omni_downscale_video',
  'omni_downsample_audio',
  'omni_extract_keyframes',
  'omni_extract_audio',
  'omni_clip_video',
  'omni_convert_image',
  'omni_transcribe_audio',
  'omni_clip_image',
  'omni_clip_audio',
  'omni_caption_image',
  'omni_caption_audio',
  'omni_ocr_image',
  'omni_understand_video_segments',
  'omni_recall_media_memory',
  'propose_goal',
];

test('every tool of the pinned release has its kind stated: a row of its own, or other by name', () => {
  const stated = new Set([...Object.keys(QWEN_TOOL_KINDS), ...QWEN_OTHER_TOOLS]);
  const unstated = QWEN_NAMES.tools.filter((tool) => !stated.has(tool));
  assert.deepEqual(unstated, [], `${QWEN_NAMES.release} has tools whose kind is stated nowhere`);
  const gone = [...stated].filter((tool) => !QWEN_NAMES.tools.includes(tool));
  assert.deepEqual(gone, [], `kinds stated for tools ${QWEN_NAMES.release} does not have`);
  for (const tool of QWEN_OTHER_TOOLS) {
    assert.equal(Object.hasOwn(QWEN_TOOL_KINDS, tool), false, `${tool} is both other and a row`);
    assert.equal(qwenToolKind(tool), 'other', tool);
  }
});
