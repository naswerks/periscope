#!/usr/bin/env node
/**
 * Accept the current wire vectors and public API as the contracts baseline.
 *
 *   npm run contracts:update
 *
 * Builds, then runs the two contract pins with `PERISCOPE_UPDATE_CONTRACTS=1`, under which each pin
 * rewrites its files (`contracts/wire-vectors/*.json`, `contracts/public-api.txt`) before checking
 * them. The pins print what they changed; this script prints which files under `contracts/`
 * actually moved, and exits with the child's code so an authoring error still fails.
 *
 * Read the diff before committing it. That is the whole point of a baseline.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const at = (relative) => fileURLToPath(new URL(relative, root));

const TRACKED = ['contracts/public-api.txt', 'contracts/wire-vectors'];

/** `path -> sha256` for every tracked file, so a rewrite that changed nothing is reported as such. */
function fingerprint() {
  const digests = new Map();
  const visit = (relative) => {
    const absolute = at(relative);
    if (!existsSync(absolute)) return;
    if (readdirSyncSafe(absolute) !== null) {
      for (const entry of readdirSyncSafe(absolute)) visit(`${relative}/${entry}`);
      return;
    }
    digests.set(relative, createHash('sha256').update(readFileSync(absolute)).digest('hex'));
  };
  for (const entry of TRACKED) visit(entry);
  return digests;
}

function readdirSyncSafe(path) {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

function run(args, env) {
  const child = spawnSync(process.execPath, args, {
    cwd: rootPath,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (child.error !== undefined) {
    process.stderr.write(`contracts: could not start ${args.join(' ')}: ${child.error.message}\n`);
    return 1;
  }
  return child.status ?? 1;
}

const before = fingerprint();

process.stdout.write('contracts: building\n');
const built = run([at('node_modules/typescript/bin/tsc')]);
if (built !== 0) {
  process.stderr.write('contracts: the build failed; nothing was rewritten\n');
  process.exit(built);
}

process.stdout.write('contracts: rewriting under PERISCOPE_UPDATE_CONTRACTS=1\n');
const status = run(['--test', at('dist/pins/wire-vectors.test.js'), at('dist/pins/public-api.test.js')], {
  PERISCOPE_UPDATE_CONTRACTS: '1',
});

const after = fingerprint();
const written = [...after].filter(([path, digest]) => before.get(path) !== digest).map(([path]) => path);
const removed = [...before.keys()].filter((path) => !after.has(path));

if (written.length === 0 && removed.length === 0) {
  process.stdout.write('contracts: nothing changed; the baseline already matched\n');
} else {
  for (const path of written) process.stdout.write(`contracts: wrote ${path}\n`);
  for (const path of removed) process.stdout.write(`contracts: removed ${path}\n`);
  process.stdout.write(
    `contracts: ${written.length} written, ${removed.length} removed. Read the diff before committing it.\n`,
  );
}

if (status !== 0) {
  process.stderr.write(
    `contracts: the pins failed after rewriting (exit ${status}); an authored case disagrees with the code\n`,
  );
}
process.exit(status);
