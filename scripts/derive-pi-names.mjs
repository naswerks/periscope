#!/usr/bin/env node
/**
 * Write `contracts/pi-names.json`: the names pi's RPC mode, its event unions and its tool registry
 * declare at one release, read from a clone of the pi repository at that release's tag, with no install.
 *
 *   node scripts/derive-pi-names.mjs <pi clone> <tag>
 *   node scripts/derive-pi-names.mjs C:/src/pi v1.2.0
 *
 * Needs git on the path. Every list holds identifiers only: interface facts, never copied text.
 * - `agentEvents`: the `type` of each member of `AgentEvent` (`packages/agent/src/types.ts`).
 * - `sessionEvents`: the `type` of each member `AgentSessionEvent` adds or restates
 *   (`packages/coding-agent/src/core/agent-session.ts`); with `agentEvents` they are every event the
 *   RPC mode writes to stdout.
 * - `rpcCommands`: the `type` of each member of `RpcCommand`, the commands RPC mode reads on stdin
 *   (`packages/coding-agent/src/modes/rpc/rpc-types.ts`).
 * - `rpcRecords`: the records RPC mode writes beside the events: its responses, its extension UI
 *   requests and its extension errors (the same file, and `rpc-mode.ts` for the last).
 * - `uiMethods`: the `method` of each extension UI request.
 * - `assistantMessageEvents`: the `type` of each member of `AssistantMessageEvent`
 *   (`packages/ai/src/types.ts`), the deltas a `message_update` carries.
 * - `tools`: every member of `ToolName` (`packages/coding-agent/src/core/tools/index.ts`), the built-in
 *   tools.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [clone, tag] = process.argv.slice(2);
if (clone === undefined || tag === undefined) {
  console.error('usage: node scripts/derive-pi-names.mjs <pi clone> <tag>');
  process.exit(2);
}

const OUT = fileURLToPath(new URL('../contracts/pi-names.json', import.meta.url));

const git = (args) =>
  execFileSync('git', ['-C', clone, '-c', 'gc.auto=0', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
const show = (path) => git(['show', `${tag}:${path}`]);

const unique = (values) => [...new Set(values)];

/**
 * The text of a type declaration from `opener` to the `;` that ends it: the first one outside every
 * brace, read with the comments taken out, since a comment inside a member may hold a `;` of its own.
 */
function declaration(source, opener, file) {
  const start = source.indexOf(opener);
  if (start < 0) throw new Error(`${file} has no ${opener}`);
  const text = source
    .slice(start)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (character === ';' && depth === 0) return text.slice(0, index);
  }
  throw new Error(`${file}: ${opener} is not closed`);
}

/** The string literals `member: "…"` names inside `text`, in order, once each. */
function literals(text, member) {
  return unique(
    [...text.matchAll(new RegExp(`\\b${member}: "([A-Za-z_][A-Za-z0-9_]*)"`, 'g'))].map((match) => match[1]),
  );
}

/** `list`, or a loud failure when it is empty: an empty list means the declaration moved. */
function nonEmpty(list, what) {
  if (list.length === 0) throw new Error(`${what} lists no names; the declaration moved`);
  return list;
}

const AGENT_TYPES = 'packages/agent/src/types.ts';
const agentEvents = nonEmpty(
  literals(declaration(show(AGENT_TYPES), 'export type AgentEvent =', AGENT_TYPES), 'type'),
  'AgentEvent',
);

const SESSION = 'packages/coding-agent/src/core/agent-session.ts';
const sessionEvents = nonEmpty(
  literals(declaration(show(SESSION), 'export type AgentSessionEvent =', SESSION), 'type'),
  'AgentSessionEvent',
);

const RPC_TYPES = 'packages/coding-agent/src/modes/rpc/rpc-types.ts';
const rpcTypes = show(RPC_TYPES);
const rpcCommands = nonEmpty(
  literals(declaration(rpcTypes, 'export type RpcCommand =', RPC_TYPES), 'type'),
  'RpcCommand',
);
const responses = literals(declaration(rpcTypes, 'export type RpcResponse =', RPC_TYPES), 'type');
const uiRequest = declaration(rpcTypes, 'export type RpcExtensionUIRequest =', RPC_TYPES);
const RPC_MODE = 'packages/coding-agent/src/modes/rpc/rpc-mode.ts';
const errors = [...show(RPC_MODE).matchAll(/output\(\{\s*type: "(extension_error)"/g)].map((m) => m[1]);
const rpcRecords = nonEmpty(
  unique([...responses, ...literals(uiRequest, 'type'), ...errors]),
  'the RPC records',
);
if (!rpcRecords.includes('extension_error')) throw new Error(`${RPC_MODE} writes no extension_error`);
const uiMethods = nonEmpty(literals(uiRequest, 'method'), 'RpcExtensionUIRequest');

const AI_TYPES = 'packages/ai/src/types.ts';
const assistantMessageEvents = nonEmpty(
  literals(declaration(show(AI_TYPES), 'export type AssistantMessageEvent =', AI_TYPES), 'type'),
  'AssistantMessageEvent',
);

const TOOLS = 'packages/coding-agent/src/core/tools/index.ts';
const toolNames = /export type ToolName =([^;]+);/.exec(show(TOOLS));
if (toolNames === null) throw new Error(`${TOOLS} has no ToolName`);
const tools = nonEmpty(unique([...toolNames[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])), 'ToolName');

const version = JSON.parse(show('packages/coding-agent/package.json')).version;
const names = {
  release: tag,
  version,
  agentEvents,
  sessionEvents,
  rpcCommands,
  rpcRecords,
  uiMethods,
  assistantMessageEvents,
  tools,
};

writeFileSync(OUT, `${JSON.stringify(names, null, 2)}\n`);
const counts = Object.entries(names)
  .filter(([, value]) => Array.isArray(value))
  .map(([key, value]) => `${key} ${value.length}`)
  .join(', ');
console.log(`wrote ${OUT} for ${tag} (${version}): ${counts}`);
