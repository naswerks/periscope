#!/usr/bin/env node
/**
 * Write `contracts/codex-protocol-names.json`: the names the Codex app-server protocol declares at one
 * release, read from a clone of the Codex repository at that release's tag, with no binary.
 *
 *   node scripts/derive-codex-names.mjs <codex clone> <tag>
 *   node scripts/derive-codex-names.mjs C:/src/codex rust-v0.162.1
 *
 * Needs Node 23.8 or later (`zlib.zstdDecompressSync`) and git on the path.
 *
 * Every list holds identifiers only: interface facts, never copied text.
 * - The stable lists come from the TypeScript the release commits under
 *   `codex-rs/app-server-protocol/schema/typescript/`, which is what `app-server generate-ts` writes.
 * - The full lists, experimental methods included, come from the experimental export archive the
 *   binary embeds (`schema/precomputed/app-server-exports-experimental.json.zst`), which is what
 *   `app-server generate-ts --experimental` writes. A method in it and not in the stable list is
 *   experimental.
 * - Notifications are the same in both: the stable filter keeps every notification name. Which ones
 *   are experimental is read from the attribute on each entry of `server_notification_definitions!`
 *   in `codex-rs/app-server-protocol/src/protocol/common.rs`.
 * - `wireKeys` maps a wire key the adapter must read to the member it reads it into. The key of the
 *   agent message's stage field is found by its values: the member of the `agentMessage` item whose
 *   type's values include `final_answer`. The word itself is never written here.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const [clone, tag] = process.argv.slice(2);
if (clone === undefined || tag === undefined) {
  console.error('usage: node scripts/derive-codex-names.mjs <codex clone> <tag>');
  process.exit(2);
}

const PROTOCOL = 'codex-rs/app-server-protocol';
const OUT = fileURLToPath(new URL('../contracts/codex-protocol-names.json', import.meta.url));

const show = (path, encoding = 'utf8') =>
  execFileSync('git', ['-C', clone, 'show', `${tag}:${path}`], { encoding, maxBuffer: 256 * 1024 * 1024 });

const stableTs = (file) => show(`${PROTOCOL}/schema/typescript/${file}`);
const archive = JSON.parse(
  zstdDecompressSync(
    show(`${PROTOCOL}/schema/precomputed/app-server-exports-experimental.json.zst`, 'buffer'),
  ).toString('utf8'),
);
const experimentalTs = (file) => {
  const text = archive.typescript?.[file];
  if (typeof text !== 'string') throw new Error(`the experimental archive has no ${file}`);
  return text;
};

const methods = (source) => [...source.matchAll(/"method": "([^"]+)"/g)].map((match) => match[1]);
const kinds = (source) => [...source.matchAll(/\{ "type": "([A-Za-z]+)"/g)].map((match) => match[1]);

function flagged(all, stable) {
  const isStable = new Set(stable);
  return all.map((method) => ({ method, experimental: !isStable.has(method) }));
}

/** The names of `server_notification_definitions!` entries that carry an experimental attribute. */
function experimentalNotifications() {
  const source = show(`${PROTOCOL}/src/protocol/common.rs`);
  const start = source.indexOf('server_notification_definitions! {');
  if (start < 0) throw new Error('common.rs has no server_notification_definitions! block');
  const end = source.indexOf('\n}', start);
  const block = source.slice(start, end);
  const found = new Set();
  let pending = false;
  for (const line of block.split('\n')) {
    if (/#\[experimental\(/.test(line)) {
      pending = true;
      continue;
    }
    const entry = /^\s+[A-Z][A-Za-z]+(?: => "([^"]+)")? ?\(/.exec(line);
    if (entry !== null) {
      if (pending && entry[1] !== undefined) found.add(entry[1]);
      if (pending && entry[1] === undefined) {
        throw new Error(`an experimental notification without a wire name: ${line.trim()}`);
      }
      pending = false;
    }
  }
  return found;
}

/** The wire key of the agent message's stage field, found by the values its type admits. */
function stageKey() {
  const typeNames = Object.entries(archive.typescript)
    .filter(([, text]) => /export type \w+ = [^;]*"final_answer"/.test(text))
    .map(([, text]) => /export type (\w+) = /.exec(text)?.[1])
    .filter((name) => name !== undefined);
  if (typeNames.length !== 1)
    throw new Error(`expected one type admitting final_answer, found ${typeNames.length}`);
  const typeName = typeNames[0];
  const items = stableTs('v2/ThreadItem.ts');
  const arm = /\{ "type": "agentMessage",([^}]*)\}/.exec(items)?.[1];
  if (arm === undefined) throw new Error('ThreadItem.ts has no agentMessage arm');
  const keys = [...arm.matchAll(new RegExp(`(\\w+): ${typeName} \\| null`, 'g'))].map((match) => match[1]);
  if (keys.length !== 1)
    throw new Error(`expected one agentMessage member of type ${typeName}, found ${keys.length}`);
  return keys[0];
}

const notifications = methods(stableTs('ServerNotification.ts'));
const experimentalNames = experimentalNotifications();
for (const name of experimentalNames) {
  if (!notifications.includes(name))
    throw new Error(`common.rs marks ${name} experimental; the union lacks it`);
}

const names = {
  release: tag,
  version: tag.replace(/^rust-v/, ''),
  notifications: notifications.map((method) => ({ method, experimental: experimentalNames.has(method) })),
  serverRequests: flagged(methods(experimentalTs('ServerRequest.ts')), methods(stableTs('ServerRequest.ts'))),
  itemKinds: kinds(stableTs('v2/ThreadItem.ts')),
  clientMethods: flagged(methods(experimentalTs('ClientRequest.ts')), methods(stableTs('ClientRequest.ts'))),
  wireKeys: { agentMessage: { [stageKey()]: 'stage' } },
};

const experimentalItems = kinds(experimentalTs('v2/ThreadItem.ts'));
if (JSON.stringify(experimentalItems) !== JSON.stringify(names.itemKinds)) {
  throw new Error('the item kinds differ between the stable and the experimental exports');
}

writeFileSync(OUT, `${JSON.stringify(names, null, 2)}\n`);
const count = (list) => `${list.length} (${list.filter((entry) => entry.experimental).length} experimental)`;
console.log(
  [
    `wrote ${OUT} from ${tag}:`,
    `  notifications   ${count(names.notifications)}`,
    `  server requests ${count(names.serverRequests)}`,
    `  item kinds      ${names.itemKinds.length}`,
    `  client methods  ${count(names.clientMethods)}`,
  ].join('\n'),
);
