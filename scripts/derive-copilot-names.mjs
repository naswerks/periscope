#!/usr/bin/env node
/**
 * Write `contracts/copilot-names.json`: the session events `@github/copilot-sdk` declares at one release,
 * read from an install of that release, with nothing started and nothing fetched.
 *
 *   node scripts/derive-copilot-names.mjs <install directory>
 *   node scripts/derive-copilot-names.mjs .
 *
 * The install directory is the one `npm install` wrote `node_modules` into: this checkout, whose development
 * dependency is the pinned release, or an operator's `PERISCOPE_COPILOT_SDK` directory. Every list holds
 * identifiers only: interface facts, never copied text.
 * - `version`: the SDK's own version, and `runtimeVersion`: the runtime that release pins
 *   (`copilotRuntime.version` in its manifest).
 * - `sessionEvents`: the `type` of each member of `SessionEvent` (`dist/generated/session-events.d.ts`),
 *   in the order the union names them: every event a session's `onEvent` is handed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory] = process.argv.slice(2);
if (directory === undefined) {
  console.error('usage: node scripts/derive-copilot-names.mjs <install directory>');
  process.exit(2);
}

const OUT = fileURLToPath(new URL('../contracts/copilot-names.json', import.meta.url));
const ROOT = join(resolve(directory), 'node_modules', '@github', 'copilot-sdk');
const EVENTS = 'dist/generated/session-events.d.ts';

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const source = readFileSync(join(ROOT, EVENTS), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

/** The members of the union `name` declares, by interface name, in order. */
function unionMembers(name) {
  const match = new RegExp(`export type ${name} =([^;]+);`).exec(source);
  if (match === null) throw new Error(`${EVENTS} declares no ${name}`);
  const members = match[1]
    .split('|')
    .map((member) => member.trim())
    .filter((member) => member !== '');
  if (members.length === 0) throw new Error(`${name} has no members; the declaration moved`);
  for (const member of members) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(member))
      throw new Error(`${name} names ${member}, which is no interface`);
  }
  return members;
}

/** The one `type: "…"` literal the interface `name` declares at its own top level. */
function typeOf(name) {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`${EVENTS} declares no interface ${name}`);
  let depth = 0;
  let index = source.indexOf('{', start);
  const opened = index;
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  // Only the interface's own members: a nested object's `type` is not the event's.
  let body = '';
  depth = 0;
  for (const character of source.slice(opened + 1, index)) {
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (depth === 0) body += character;
  }
  const types = [...body.matchAll(/(?:^|[\s;])type: "([a-z][A-Za-z0-9_.]*)";/g)].map((found) => found[1]);
  if (types.length !== 1) throw new Error(`${name} declares ${types.length} event types; one was expected`);
  return types[0];
}

const sessionEvents = unionMembers('SessionEvent').map(typeOf);
if (new Set(sessionEvents).size !== sessionEvents.length)
  throw new Error('SessionEvent names an event twice');

const names = {
  package: manifest.name,
  version: manifest.version,
  runtimeVersion: manifest.copilotRuntime?.version,
  sessionEvents,
};
if (typeof names.runtimeVersion !== 'string')
  throw new Error(`${manifest.name} names no copilotRuntime.version`);

writeFileSync(OUT, `${JSON.stringify(names, null, 2)}\n`);
console.log(
  `wrote ${OUT} for ${names.package} ${names.version} (runtime ${names.runtimeVersion}): sessionEvents ${sessionEvents.length}`,
);
