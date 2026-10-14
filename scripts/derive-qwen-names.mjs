#!/usr/bin/env node
/**
 * Write `contracts/qwen-code-names.json`: the names Qwen Code's stream-json protocol and tool registry
 * declare at one release, read from a clone of the Qwen Code repository at that release's tag, with no
 * binary.
 *
 *   node scripts/derive-qwen-names.mjs <qwen-code clone> <tag>
 *   node scripts/derive-qwen-names.mjs C:/src/qwen-code v0.25.1
 *
 * Needs git on the path. Every list holds identifiers only: interface facts, never copied text.
 * - `tools`: every value of `ToolNames` (`packages/core/src/tools/tool-names.ts`), in declaration order.
 *   It is the ask-rule list: a session's settings name each of these.
 * - `messageTypes`: the `type` of each member of the SDK's `SDKMessage` union
 *   (`packages/sdk-typescript/src/types/protocol.ts`).
 * - `resultSubtypes` and `contentBlocks`: the result interfaces' subtypes and the content block kinds,
 *   from the same file.
 * - `systemSubtypes`: every literal subtype the CLI's stream-json path emits on a `system` message:
 *   the first argument of `emitSystemMessage(…)` and the `subtype` beside `type: 'system'`, in
 *   `packages/cli/src/nonInteractiveCli.ts` and `packages/cli/src/nonInteractive/`.
 * - `streamEvents` and `streamDeltas`: the event and delta kinds `StreamJsonOutputAdapter.ts` writes.
 * - `hostControlRequests`: the subtypes the CLI's control dispatcher routes (`getControllerForRequest`).
 * - `cliControlRequests`: the subtypes the CLI's controllers send the host (`sendControlRequest`).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [clone, tag] = process.argv.slice(2);
if (clone === undefined || tag === undefined) {
  console.error('usage: node scripts/derive-qwen-names.mjs <qwen-code clone> <tag>');
  process.exit(2);
}

const OUT = fileURLToPath(new URL('../contracts/qwen-code-names.json', import.meta.url));

const git = (args) =>
  execFileSync('git', ['-C', clone, '-c', 'gc.auto=0', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
const show = (path) => git(['show', `${tag}:${path}`]);
const listed = (directory) =>
  git(['ls-tree', '-r', '--name-only', tag, '--', directory])
    .split('\n')
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'));

const unique = (values) => [...new Set(values)];

function block(source, opener, closer, file) {
  const start = source.indexOf(opener);
  if (start < 0) throw new Error(`${file} has no ${opener}`);
  const end = source.indexOf(closer, start);
  if (end < 0) throw new Error(`${file}: ${opener} is not closed`);
  return source.slice(start, end);
}

function tools() {
  const file = 'packages/core/src/tools/tool-names.ts';
  const names = block(show(file), 'export const ToolNames', '} as const', file);
  const found = [...names.matchAll(/^\s+[A-Z][A-Z0-9_]*:\s*'([a-z0-9_]+)'/gm)].map((match) => match[1]);
  if (found.length === 0) throw new Error(`${file}: ToolNames lists no names`);
  return found;
}

function protocol() {
  const file = 'packages/sdk-typescript/src/types/protocol.ts';
  const source = show(file);
  const union = block(source, 'export type SDKMessage =', ';', file);
  const members = [...union.matchAll(/\|\s*([A-Za-z]+)/g)].map((match) => match[1]);
  const typeOf = (name) => {
    const iface = new RegExp(`export interface ${name} \\{\\s*type: '([a-z_]+)'`).exec(source);
    if (iface !== null) return [iface[1]];
    const alias = new RegExp(`export type ${name} =([^;]+);`).exec(source);
    if (alias === null) throw new Error(`${file}: ${name} is neither an interface nor a union`);
    return [...alias[1].matchAll(/\|?\s*([A-Za-z]+)/g)].flatMap((match) => typeOf(match[1]));
  };
  const messageTypes = unique(members.flatMap(typeOf));
  const resultSubtypes = unique(
    [...source.matchAll(/export interface SDKResultMessage[A-Za-z]* \{[^}]*?subtype: ([^;]+);/gs)].flatMap(
      (match) => [...match[1].matchAll(/'([a-z_]+)'/g)].map((literal) => literal[1]),
    ),
  );
  const contentBlocks = unique(
    [...source.matchAll(/export interface [A-Za-z]*Block \{\s*type: '([a-z_]+)'/g)].map((match) => match[1]),
  );
  return { messageTypes, resultSubtypes, contentBlocks };
}

function systemSubtypes() {
  const files = ['packages/cli/src/nonInteractiveCli.ts', ...listed('packages/cli/src/nonInteractive')];
  const found = [];
  for (const file of files) {
    const source = show(file);
    // A helper that passes its first parameter on as the subtype (`emitVisionNotice(subtype, …)`)
    // emits whatever literal its callers name.
    const emitters = ['emitSystemMessage'];
    for (const helper of source.matchAll(
      /(?:const|function)\s+(\w+)\s*=?\s*\((\w+): string[^)]*\)[^{]*\{[\s\S]{0,600}?emitSystemMessage\(\2\b/g,
    )) {
      emitters.push(helper[1]);
    }
    for (const emitter of emitters) {
      for (const match of source.matchAll(new RegExp(`\\b${emitter}\\(\\s*'([a-z_]+)'`, 'g'))) {
        found.push(match[1]);
      }
    }
    for (const match of source.matchAll(/type: 'system',\s*subtype: '([a-z_]+)'/g)) found.push(match[1]);
  }
  if (!found.includes('init')) throw new Error('no init subtype found; the emit sites moved');
  return unique(found);
}

function stream() {
  const file = 'packages/cli/src/nonInteractive/io/StreamJsonOutputAdapter.ts';
  const source = show(file);
  const literals = unique([...source.matchAll(/type: '([a-z_]+)'/g)].map((match) => match[1]));
  const streamDeltas = unique(
    [...source.matchAll(/delta:\s*\{\s*type:\s*'([a-z_]+)'/g)].map((match) => match[1]),
  );
  return {
    streamEvents: literals.filter((name) => name !== 'stream_event' && !streamDeltas.includes(name)),
    streamDeltas,
  };
}

function control() {
  const dispatcher = 'packages/cli/src/nonInteractive/control/ControlDispatcher.ts';
  const routed = block(show(dispatcher), 'private getControllerForRequest', 'default:', dispatcher);
  const hostControlRequests = [...routed.matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]);
  const sent = [];
  for (const file of listed('packages/cli/src/nonInteractive/control/controllers')) {
    const source = show(file);
    for (const match of source.matchAll(/sendControlRequest\(\s*\{\s*subtype: '([a-z_]+)'/g))
      sent.push(match[1]);
  }
  return { hostControlRequests, cliControlRequests: unique(sent) };
}

const version = JSON.parse(show('packages/cli/package.json')).version;
const names = {
  release: tag,
  version,
  tools: tools(),
  ...protocol(),
  systemSubtypes: systemSubtypes(),
  ...stream(),
  ...control(),
};

writeFileSync(OUT, `${JSON.stringify(names, null, 2)}\n`);
const counts = Object.entries(names)
  .filter(([, value]) => Array.isArray(value))
  .map(([key, value]) => `${key} ${value.length}`)
  .join(', ');
console.log(`wrote ${OUT} for ${tag} (${version}): ${counts}`);
