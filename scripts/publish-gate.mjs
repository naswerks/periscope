#!/usr/bin/env node
/**
 * The publish gate. `"private": true` stands until every item below is satisfied.
 *
 *   node scripts/publish-gate.mjs
 *
 * The gate is inert while `private` is true, by design: it is not a to-do list that blocks work
 * today. It is the thing that stops a one-line `"private"` deletion from shipping a package with no
 * licence, no security document, and a README that cannot say which CLI it was tested against.
 *
 * It still reports the outstanding items on every run, so the distance to publishable is visible
 * rather than discovered on the day someone removes the line.
 *
 * Two items cannot be checked by a script: npm name availability and a green CI run. They are
 * fail-closed: with `private` removed and no attestation in `publish-attestation.json`, the gate
 * refuses. A gate that waves through what it cannot see is not a gate.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const at = (relative) => fileURLToPath(new URL(relative, root));
const readIfPresent = (relative) => (existsSync(at(relative)) ? readFileSync(at(relative), 'utf8') : null);

const manifest = JSON.parse(readFileSync(at('package.json'), 'utf8'));
const isPrivate = manifest.private === true;
const missing = [];

const require_ = (condition, item) => {
  if (!condition) missing.push(item);
};

// ---- the mechanical items -----------------------------------------------------------------------
require_(existsSync(at('LICENSE')), 'LICENSE is missing');
require_(
  existsSync(at('LICENSE')) && readFileSync(at('LICENSE'), 'utf8').startsWith('MIT License'),
  'LICENSE must be the MIT licence text (package.json declares license: MIT)',
);
require_(existsSync(at('SECURITY.md')), 'SECURITY.md, the document that decides adoption');
require_(existsSync(at('README.md')), 'README.md');

const readme = readIfPresent('README.md') ?? '';
const sdkPin = manifest.dependencies?.['@anthropic-ai/claude-agent-sdk'] ?? '';
const cliVersion = (readIfPresent('contracts/cli-version.txt') ?? '').trim();

require_(
  sdkPin !== '' && readme.includes(sdkPin),
  `README must state the tested SDK version (${sdkPin || 'the pin is missing'}); "what versions are ` +
    `tested" is one of the first questions an installer asks`,
);
require_(
  cliVersion !== '' && readme.includes(cliVersion),
  `README must state the tested CLI version (${cliVersion || 'contracts/cli-version.txt is missing'})`,
);

/**
 * The ACP claim, checked rather than remembered: both halves, and never the word "compatible".
 *
 * Credit is honest and costs a line. But no ACP client can reach this host, by design: ACP points
 * the connection inbound and Periscope dials out. Someone would try it on the strength of one
 * adjective and fail.
 */
require_(
  readme.includes('Agent Client Protocol'),
  'README must credit ACP — naming follows it, and saying so costs a line',
);
require_(
  /not ACP compat|not be described as ACP-compat|is not an ACP implementation/i.test(readme),
  'README must state the DENIAL half of the ACP claim, not only the credit',
);
require_(
  !/\bACP[- ]compatible\b/i.test(readme.replace(/not be described as ACP-compatible/gi, '')),
  'README claims ACP compatibility; no ACP client can reach this host, by design',
);

// ---- package shape --------------------------------------------------------------------------------
require_(
  Array.isArray(manifest.files) && manifest.files.length > 0,
  'package.json needs a `files` allowlist',
);
require_(manifest.sideEffects === false, 'package.json needs `"sideEffects": false`');
require_(typeof manifest.engines?.node === 'string', 'package.json needs `engines.node`');
require_(manifest.version !== '0.0.0', 'package.json still has the placeholder version 0.0.0');

/**
 * The identity fields. A placeholder that survives a flip ships a package pointing at a repository
 * that does not exist, and the changelog must know the version being published: either it is still
 * gathering under Unreleased, or the version has its own section.
 */
const identity = [manifest.repository?.url, manifest.bugs?.url, manifest.homepage].map((v) =>
  String(v ?? ''),
);
require_(
  identity.every((v) => v !== '' && !/\bOWNER\b/.test(v)),
  `package.json still carries an OWNER placeholder in repository, bugs or homepage (${identity.join(', ')})`,
);
require_(
  typeof manifest.author === 'string' && manifest.author.trim() !== '',
  'package.json names no author',
);
require_(
  !manifest.name.startsWith('@') || manifest.publishConfig?.access === 'public',
  'a scoped name publishes as restricted unless publishConfig.access is "public"',
);
const changelog = readIfPresent('CHANGELOG.md') ?? '';
require_(
  /^## Unreleased\s*$/m.test(changelog) || changelog.includes(`## [${manifest.version}]`),
  `CHANGELOG.md has neither an Unreleased section nor a section for ${manifest.version}`,
);

/**
 * The donor-artifact scan, measured every run, never remembered.
 *
 * `THIRD-PARTY-NOTICES.md` is owed only if an artifact was actually taken: a schema file, a
 * generated type, copied source. Names and design ideas do not create the obligation, and listing
 * them as if they did implies a derivation that did not happen, which is its own kind of false
 * statement in the document whose whole job is to be true.
 *
 * The expected answer is that the scan finds nothing. It runs anyway, because "none should have
 * survived" is a claim about every future commit.
 */
const donorArtifacts = ['schema/v1', 'acp-schema', 'agent-client-protocol.json', 'generated/acp'];
const foundDonors = donorArtifacts.filter((candidate) => existsSync(at(candidate)));

if (foundDonors.length > 0) {
  require_(
    existsSync(at('THIRD-PARTY-NOTICES.md')),
    `THIRD-PARTY-NOTICES.md — a donor artifact survived (${foundDonors.join(', ')}), which DOES create ` +
      `an Apache-2.0 notice obligation`,
  );
}

/**
 * The dependency scan. The Agent SDK's type definitions are Anthropic's, all rights reserved, so a
 * copy of them anywhere in the package (a `.d.ts` outside `dist/` and `node_modules/`) cannot
 * ship under this licence, whatever notice accompanies it. The baseline is a hash, never the text.
 */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git', '.nas', 'coverage', 'reports', '.stryker-tmp']);
const typeDefinitionFiles = (dir, prefix = '') =>
  readdirSync(at(dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      return SKIPPED_DIRS.has(entry.name) ? [] : typeDefinitionFiles(`${dir}${entry.name}/`, `${relative}/`);
    return entry.name.endsWith('.d.ts') ? [relative] : [];
  });
const redistributed = typeDefinitionFiles('./');
require_(
  redistributed.length === 0,
  `a dependency's type definitions are checked in and cannot be redistributed (${redistributed.join(', ')}); ` +
    `keep the hash baseline (contracts/sdk.sha256) and delete the copy`,
);

/**
 * The pack checks: publint audits the manifest (`exports`, `files`, `bin`, the condition order) and attw
 * resolves the packed tarball's types under every resolution mode an ESM-only package offers. Both read
 * the tarball a consumer receives, so they run after a build; a missing `dist/` is reported as such.
 * The bins are resolved from the installed packages and run under this Node, never through a shell.
 */
function packCheck(label, pkg, binName, args) {
  const installed = readIfPresent(`node_modules/${pkg}/package.json`);
  if (installed === null) return `${label} is not installed (npm i -D ${pkg})`;
  const manifest = JSON.parse(installed);
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
  if (typeof bin !== 'string') return `${label} declares no ${binName} bin`;
  try {
    execFileSync(process.execPath, [at(`node_modules/${pkg}/${bin}`), ...args], {
      cwd: at('./'),
      stdio: 'pipe',
    });
    return null;
  } catch (error) {
    const out = `${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}`
      .trim()
      .split('\n')
      .filter(Boolean);
    return `${label} reported: ${out.slice(-4).join(' | ') || String(error.message)}`;
  }
}
const packReports = [
  packCheck('publint', 'publint', 'publint', ['--strict']),
  packCheck('attw', '@arethetypeswrong/cli', 'attw', ['--pack', '.', '--profile', 'esm-only']),
];
for (const report of packReports) require_(report === null, report);

// ---- the two a script cannot see -----------------------------------------------------------------
const attestation = readIfPresent('publish-attestation.json');
if (!isPrivate) {
  if (attestation === null) {
    missing.push(
      'publish-attestation.json — two items cannot be checked mechanically and must be attested: ' +
        '`npmNameAvailable` (the scope was verified free) and `ciGreen` (the matrix passed on the ' +
        'commit being published). Fail-closed by design.',
    );
  } else {
    const attested = JSON.parse(attestation);
    require_(
      attested.npmNameAvailable?.checkedOn,
      'publish-attestation.json needs npmNameAvailable.checkedOn',
    );
    require_(attested.ciGreen?.commit, 'publish-attestation.json needs ciGreen.commit');
  }
}

// ---- outcome --------------------------------------------------------------------------------------
process.stdout.write(`publish gate: private=${isPrivate}, ${missing.length} item(s) outstanding\n`);
process.stdout.write(
  `  donor-artifact scan: ${foundDonors.length === 0 ? 'clean (no ACP notice owed)' : foundDonors.join(', ')}\n`,
);
process.stdout
  .write(`  type-definition scan: ${redistributed.length === 0 ? 'clean (no dependency types checked in)' : redistributed.join(', ')}
`);
process.stdout.write(
  `  pack checks: ${packReports.every((r) => r === null) ? 'publint and attw clean' : 'see OUTSTANDING'}\n`,
);
for (const item of missing) process.stdout.write(`  OUTSTANDING: ${item}\n`);

if (isPrivate) {
  process.stdout.write('\nGate is INERT because the package is private. Nothing can publish.\n');
  process.exit(0);
}

if (missing.length > 0) {
  process.stderr.write(
    `\nPUBLISH GATE RED: \`private\` has been removed while ${missing.length} item(s) are missing.\n` +
      `Restore \`"private": true\` or satisfy them.\n`,
  );
  process.exit(1);
}

process.stdout.write('\nPublish gate PASSED: every item is satisfied.\n');
