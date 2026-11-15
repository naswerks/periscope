#!/usr/bin/env node
/**
 * Write `contracts/opencode-names.json`: the events `@opencode/sdk`'s stream declares at one release, read from
 * an install of that release, with nothing started and nothing fetched.
 *
 *   node scripts/derive-opencode-names.mjs <install directory>
 *   node scripts/derive-opencode-names.mjs .
 *
 * The install directory is the one `npm install` wrote `node_modules` into: this checkout, whose development
 * dependency is the pinned release, or an operator's `PERISCOPE_OPENCODE_SDK` directory. Every list holds
 * identifiers only: interface facts, never copied text.
 * - `version`: the SDK's own version.
 * - `events`: the `type` of each member of the client's `V2Event` (`dist/promise/generated/types.d.ts` of the
 *   `@opencode/client` the SDK resolves), in the order the union names them: every event the server's stream
 *   carries. A member whose type is a template (`rpc.${string}`) is written as its prefix and `*`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory] = process.argv.slice(2);
if (directory === undefined) {
  console.error('usage: node scripts/derive-opencode-names.mjs <install directory>');
  process.exit(2);
}

const OUT = fileURLToPath(new URL('../contracts/opencode-names.json', import.meta.url));
const ROOT = join(resolve(directory), 'node_modules');
const SDK = join(ROOT, '@opencode', 'sdk');
const TYPES = join('dist', 'promise', 'generated', 'types.d.ts');

/** The SDK's own copy of a package when it holds one, else the one beside it, as Node resolves it. */
function resolved(name) {
  const own = join(SDK, 'node_modules', ...name.split('/'));
  return existsSync(own) ? own : join(ROOT, ...name.split('/'));
}

const manifest = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8'));
const source = readFileSync(join(resolved('@opencode/client'), TYPES), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  // A template type (`${"rpc."}${string}`) holds braces of its own: read it as its prefix and `*` first.
  .replace(/`\$\{"([a-z][a-z.]*)"\}\$\{string\}`/g, '"$1*"');

/** The members of the union `name` declares, by type name, in order. */
function unionMembers(name) {
  const match = new RegExp(`export type ${name} =([^;]+);`).exec(source);
  if (match === null) throw new Error(`${TYPES} declares no ${name}`);
  const members = match[1]
    .split('|')
    .map((member) => member.trim())
    .filter((member) => member !== '');
  if (members.length === 0) throw new Error(`${name} has no members; the declaration moved`);
  for (const member of members) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(member)) throw new Error(`${name} names ${member}, which is no type`);
  }
  return members;
}

/** The one `type` the object type `name` declares at its own top level: a literal, or a template's prefix. */
function typeOf(name) {
  const start = source.indexOf(`export type ${name} = {`);
  if (start < 0) throw new Error(`${TYPES} declares no object type ${name}`);
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
  // Only the type's own members: a nested object's `type` is not the event's.
  let body = '';
  depth = 0;
  for (const character of source.slice(opened + 1, index)) {
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (depth === 0) body += character;
  }
  const types = [...body.matchAll(/(?:^|[\s;])type: "([a-z][A-Za-z0-9_.*-]*)";/g)].map((found) => found[1]);
  if (types.length !== 1) throw new Error(`${name} declares ${types.length} event types; one was expected`);
  return types[0];
}

const events = unionMembers('V2Event').map(typeOf);
if (new Set(events).size !== events.length) throw new Error('V2Event names an event twice');

const names = { package: '@opencode/sdk', version: manifest.version, events };
writeFileSync(OUT, `${JSON.stringify(names, null, 2)}\n`);
console.log(`wrote ${OUT}: ${events.length} events at @opencode/sdk ${manifest.version}`);
