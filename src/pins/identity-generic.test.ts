/**
 * The genericness pin for identity: no provider is named in the code, and the authority is never a
 * constant.
 *
 * An identity layer is the single most likely place a provider leaks in, because any one deployment
 * has exactly one provider and hardcoding its authority would work perfectly there and nowhere
 * else. The failure is invisible from inside: every test passes, the host signs in, and the package
 * is quietly single-tenant.
 *
 * Test files are exempt: fixtures naming a provider are fine and common. What is forbidden is a
 * provider host reachable from shipped code. This file names the markers, so it is exempt too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sourceFiles } from './walk.js';

/** Hostnames and product names that would mean a provider had been baked in. */
const PROVIDER_MARKERS = [
  'login.microsoftonline.com',
  'ciamlogin.com',
  'sts.windows.net',
  'okta.com',
  'auth0.com',
  'accounts.google.com',
];

/** Shipped code only: `.test.ts` files may hold fixtures, and this file names the markers. */
function shippedIdentityFiles() {
  return sourceFiles().filter(
    (file) =>
      (file.path.startsWith('identity/') || file.path.startsWith('host/')) && !file.path.endsWith('.test.ts'),
  );
}

test('regression: no identity provider host is hardcoded in shipped identity or host code', () => {
  const offenders: string[] = [];

  for (const file of shippedIdentityFiles()) {
    file.text.split('\n').forEach((line, index) => {
      for (const marker of PROVIDER_MARKERS) {
        if (line.includes(marker)) offenders.push(`${file.path}:${index + 1} names ${marker}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `an identity provider has been baked into the package; the authority is configuration:\n  ${offenders.join('\n  ')}`,
  );
});

test('regression: a provider error code is known in exactly one shipped file, and it is the device-code module', () => {
  // A provider's error vocabulary is the second way a provider leaks in. One file may hold the list
  // (`AUTH_FLOW_BLOCKED_CODES`); everything else asks `isAuthFlowBlocked` and never spells a code.
  const spellers = sourceFiles()
    .filter((file) => !file.path.endsWith('.test.ts') && /\bAADSTS\d+\b/.test(file.text))
    .map((file) => file.path);
  assert.deepEqual(spellers, ['identity/device-code.ts']);
});

test('regression: the authority is read from configuration, and there is exactly one place it comes from', () => {
  // A second reader would be a second answer to "which provider is this host talking to".
  const readers = sourceFiles().filter((file) => file.text.includes('PERISCOPE_IDENTITY_AUTHORITY'));
  const shipped = readers.filter((file) => !file.path.endsWith('.test.ts'));

  assert.deepEqual(
    shipped.map((file) => file.path),
    ['identity/config.ts'],
  );
});

// Guards the selector: if `shippedIdentityFiles()` were empty or the marker list broken, the first
// assertion would pass over nothing at all.
test('control: the scan covers a real, populated set of identity files', () => {
  const scanned = shippedIdentityFiles().map((file) => file.path);

  assert.ok(scanned.length >= 8, `only ${scanned.length} files were scanned: ${scanned.join(', ')}`);
  for (const expected of ['identity/config.ts', 'identity/token.ts', 'host/token-cache.ts']) {
    assert.ok(scanned.includes(expected), `${expected} was not scanned`);
  }
});

test('control: the marker list matches a provider host when one is present', () => {
  // Without this, a typo in every marker would make the rule vacuous while still passing.
  assert.ok(PROVIDER_MARKERS.some((marker) => 'https://contoso.ciamlogin.com/tenant'.includes(marker)));
});
