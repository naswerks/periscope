#!/usr/bin/env node
/**
 * The SDK drift detector, because the foundation is `0.3.x` and semver protects nothing there.
 *
 *   node scripts/check-drift.mjs          # compare the installed types against the hash baseline
 *   node scripts/check-drift.mjs --update  # accept the installed types as the new baseline
 *
 * The instability is concrete, not speculative: every `SessionStore` member is `@alpha`, there is a
 * method named `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, fields are deprecated in
 * place, and the message union grows without a major version. So the installed types are hashed and
 * the hash is committed, the same pin-the-wire habit this package applies to its own protocol,
 * pointed at a dependency.
 *
 * The baseline is a hash and never a copy. The SDK's type definitions are Anthropic's, all rights
 * reserved, so a copy under `contracts/` could not ship in an MIT repository; `contracts/sdk.sha256`
 * carries the SHA-256 of the installed `sdk.d.ts` after line-ending normalisation, beside the version
 * it was taken from in `contracts/sdk-version.txt`. `src/pins/sdk-baseline.test.ts` recomputes the
 * same hash with its own code, so the two readers can disagree and one alone cannot lie.
 *
 * Three checks, and each one fails a DIFFERENT way of drifting:
 *   1. the pin is EXACT      — a caret would let a bump arrive with no commit at all
 *   2. installed == pinned   — a lockfile or a stale `node_modules` disagreeing with package.json
 *   3. types == baseline     — the bump that changes the surface this package is written against
 *
 * When check 3 fires the diff to read is between the two SDK versions, not between two files here:
 * `npm diff --diff=@anthropic-ai/claude-agent-sdk@<baseline> --diff=@anthropic-ai/claude-agent-sdk@<installed> --diff-name-only`
 * names what moved, and the same command without the last flag shows it.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const at = (relative) => fileURLToPath(new URL(relative, root));

const SDK = '@anthropic-ai/claude-agent-sdk';
const failures = [];
const notes = [];

/**
 * Line endings are not drift. The npm tarball ships `sdk.d.ts` with CRLF and a checkout may hold it
 * either way, so the hash is taken over LF-normalised text; a detector that fires on line endings is
 * camouflage for a real surface change.
 */
const lf = (text) => text.replace(/\r\n/g, '\n');
const digest = (text) => createHash('sha256').update(lf(text), 'utf8').digest('hex');

const read = (path, what) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    failures.push(`${what} could not be read: ${path}`);
    return null;
  }
};

// ---- 1. the pin is exact -----------------------------------------------------------------------
const manifest = JSON.parse(read(at('package.json'), 'package.json') ?? '{}');
const pin = manifest.dependencies?.[SDK];

if (pin === undefined) {
  failures.push(`${SDK} is not a dependency of this package`);
} else if (!/^\d+\.\d+\.\d+$/.test(pin)) {
  failures.push(
    `the SDK pin is "${pin}" — it must be an EXACT version with no range operator. At 0.3.x a caret ` +
      `admits a surface change with no commit in this repo to review.`,
  );
} else {
  notes.push(`pin is exact: ${pin}`);
}

// ---- 2. installed matches the pin --------------------------------------------------------------
const installedManifest = read(at(`node_modules/${SDK}/package.json`), 'the installed SDK manifest');
const installedVersion = installedManifest ? JSON.parse(installedManifest).version : null;

if (installedVersion !== null && pin !== undefined && installedVersion !== pin) {
  failures.push(
    `installed ${SDK} is ${installedVersion} but package.json pins ${pin} — run \`npm ci\`, or the ` +
      `build is being type-checked against a surface it does not ship with.`,
  );
} else if (installedVersion !== null) {
  notes.push(`installed matches the pin: ${installedVersion}`);
}

// ---- 3. the installed types hash to the baseline -----------------------------------------------
const installedTypes = read(at(`node_modules/${SDK}/sdk.d.ts`), 'the installed sdk.d.ts');
const baselinePath = at('contracts/sdk.sha256');
const versionPath = at('contracts/sdk-version.txt');

if (process.argv.includes('--update')) {
  if (installedTypes === null || installedVersion === null) {
    process.stderr.write('drift: cannot update — the installed SDK could not be read.\n');
    process.exit(1);
  }
  const previous = (read(versionPath, 'the baseline SDK version') ?? '').trim();
  writeFileSync(baselinePath, `${digest(installedTypes)}\n`);
  writeFileSync(versionPath, `${installedVersion}\n`);
  process.stdout.write(
    `drift: baseline updated to ${installedVersion} (${lf(installedTypes).split('\n').length} lines hashed).\n`,
  );
  process.stdout.write(
    `Read the SDK diff before committing it — that is the entire point of the baseline:\n` +
      `  npm diff --diff=${SDK}@${previous || '<previous>'} --diff=${SDK}@${installedVersion} --diff-name-only\n`,
  );
  process.exit(0);
}

const baseline = (read(baselinePath, 'the sdk.d.ts hash baseline') ?? '').trim();
const baselineVersion = (read(versionPath, 'the baseline SDK version') ?? '').trim();

if (baseline !== '' && !/^[0-9a-f]{64}$/.test(baseline)) {
  failures.push(`contracts/sdk.sha256 does not hold one SHA-256 hex digest: "${baseline.slice(0, 40)}"`);
}

if (baselineVersion !== '' && installedVersion !== null && baselineVersion !== installedVersion) {
  failures.push(
    `the baseline is for ${baselineVersion} but ${installedVersion} is installed — the SDK was bumped ` +
      `without re-baselining. Run \`node scripts/check-drift.mjs --update\`, READ THE SDK DIFF, then commit it.`,
  );
}

if (installedTypes !== null && baseline !== '' && digest(installedTypes) !== baseline) {
  failures.push(
    `the installed sdk.d.ts does not hash to the baseline (compared with line endings normalised).\n` +
      `    installed: ${digest(installedTypes)} (${lf(installedTypes).split('\n').length} lines)\n` +
      `    baseline:  ${baseline}\n` +
      (baselineVersion === installedVersion
        ? `    The same SDK version now ships different types; read the installed sdk.d.ts before accepting it.`
        : `    The surface this package is written against has moved. Read the SDK diff between ` +
          `${baselineVersion || '<baseline>'} and ${installedVersion ?? '<installed>'} before accepting it.`),
  );
}

// ---- outcome ------------------------------------------------------------------------------------
for (const note of notes) process.stdout.write(`  note: ${note}\n`);

if (failures.length > 0) {
  process.stderr.write('SDK DRIFT DETECTED:\n');
  for (const failure of failures) process.stderr.write(`  FAIL: ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`No SDK drift: ${SDK}@${installedVersion} matches the hash baseline.\n`);
