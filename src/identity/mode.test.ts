/**
 * The token file's mode, and the honest answer on a platform that has no opinion about modes.
 *
 * This is where the property is actually proven, and it is pure on purpose. The measured fact is
 * that win32 reports `0o666` for a file written `0o600`, for a file `chmod`ed to `0o600`, and for a
 * deliberately world-readable one — so on win32 a real-file assertion cannot tell a private token
 * from a public one. Every branch below is therefore driven through stated inputs, which is the
 * only way the POSIX branches are exercised here at all.
 *
 * And the instrument has an inconclusive state, which is why `write-bit-only` and `unobservable`
 * are different inputs. Also measured on win32: `chmod 0444` does read back as `444` — the
 * write bit is the one real bit there. That is the positive control for the whole negative claim:
 * a probe reporting "privacy is unconfirmable" is only worth something if it could have reported
 * something else. When even `0444` changes nothing, the honest answer is not "unenforced" — it is
 * "this instrument observed nothing", and those are different investigations.
 *
 * What this does not prove, stated here so nobody reads it as more: that a real file on a real
 * POSIX filesystem comes out `0o600`. That half is only provable by a run on a POSIX filesystem.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CREDENTIAL_MODE,
  classifyCredentialMode,
  classifyProbeReadings,
  isWiderThan,
  toOctal,
} from './mode.js';

const ENFORCED = 'enforced';
const NOT_ENFORCED = 'write-bit-only';
const UNOBSERVABLE = 'unobservable';

test('where modes are enforced, a file that came out exactly as asked is verified', () => {
  const outcome = classifyCredentialMode(0o600, ENFORCED);

  assert.equal(outcome.kind, 'verified');
  assert.equal(outcome.observed, 0o600);
});

test('regression: where modes are enforced, a file readable by the group is refused by name', () => {
  const outcome = classifyCredentialMode(0o640, ENFORCED);

  assert.equal(outcome.kind, 'too-wide');
  assert.equal(outcome.kind === 'too-wide' ? outcome.refusal.reason : null, 'credential-mode-too-wide');
});

test('regression: where modes are enforced, a world-readable file is refused by name', () => {
  const outcome = classifyCredentialMode(0o644, ENFORCED);

  assert.equal(outcome.kind, 'too-wide');
});

test('regression: the refusal names both the mode asked for and the one that landed', () => {
  const outcome = classifyCredentialMode(0o666, ENFORCED);

  assert.equal(outcome.kind, 'too-wide');
  if (outcome.kind !== 'too-wide') return;
  assert.match(outcome.refusal.detail, /0666/);
  assert.match(outcome.refusal.detail, /0600/);
});

test('a NARROWER file than requested is not "too wide" — 0400 is more private, not less', () => {
  // The invariant is about excess permission, not about equality. Refusing 0400 would make a
  // more-restrictive filesystem policy look like a defect.
  assert.equal(classifyCredentialMode(0o400, ENFORCED).kind, 'verified');
});

test('regression: where modes are not enforced, the outcome is a named degrade, never a quiet pass', () => {
  const outcome = classifyCredentialMode(0o666, NOT_ENFORCED);

  assert.equal(outcome.kind, 'unenforced');
  assert.equal(outcome.kind === 'unenforced' ? outcome.refusal.reason : null, 'credential-mode-unenforced');
});

test('regression: the unenforced outcome is not "verified" — the whole point of splitting them', () => {
  // This is the false green a naive check ships: on win32 the observed mode is 0666 for
  // every file, so any check phrased as "is it acceptable?" answers yes and reads as proof. The two
  // outcomes must be distinguishable by a caller, not merely differently worded.
  const onWindows = classifyCredentialMode(0o666, NOT_ENFORCED);
  const onPosix = classifyCredentialMode(0o600, ENFORCED);

  assert.notEqual(onWindows.kind, onPosix.kind);
  assert.equal(onPosix.kind, 'verified');
});

test('regression: the degrade says why it cannot confirm, and what is protecting the file instead', () => {
  const outcome = classifyCredentialMode(0o666, NOT_ENFORCED);

  assert.equal(outcome.kind, 'unenforced');
  if (outcome.kind !== 'unenforced') return;
  assert.match(outcome.refusal.detail, /cannot distinguish owner-only from world-readable/);
  // An operator reading this must learn that the gate is the control here, not the mode.
  assert.match(outcome.refusal.detail, /gate/);
});

test('regression: the degrade states that it measured this, so it is not a dead check', () => {
  // The whole reason `write-bit-only` exists as a distinct input: the probe demonstrated it can
  // observe a mode change before claiming it cannot observe privacy.
  const outcome = classifyCredentialMode(0o666, NOT_ENFORCED);

  assert.equal(
    outcome.kind === 'unenforced' && /measurement rather than a dead check/.test(outcome.refusal.detail),
    true,
  );
});

test('the unenforced branch wins over the too-wide branch — an unenforceable 0666 is not a finding', () => {
  // Ordering matters: reporting `too-wide` on win32 would be a permanent false positive on every
  // write, which is how a real signal gets ignored.
  assert.equal(classifyCredentialMode(0o666, NOT_ENFORCED).kind, 'unenforced');
});

// ---------------------------------------------------------------------------
// Reading the probe — the case the vacuous control forces into existence
// ---------------------------------------------------------------------------
//
// Removing the 0444 positive control from the real probe leaves the entire suite green on win32,
// because there a probe that runs the control and one that assumes its answer both report
// `write-bit-only`. What is uniquely lost is the ability to tell a filesystem that records only the
// write bit apart from one that records nothing — a difference that only appears on a filesystem
// this machine cannot produce on demand. Stating the readings as data is what makes it testable.

test('three readings from a POSIX filesystem read as enforced', () => {
  // 0600 asked for and got, and asking for 0666 changed the answer.
  assert.equal(classifyProbeReadings(0o600, 0o666, 0o444), 'enforced');
});

test('regression: the win32 readings — 666 / 666 / 444 — read as measured-but-unenforceable', () => {
  // Exactly what win32 produces, verified by probe: 0600 and 0666 are indistinguishable, but
  // clearing the write bit is recorded.
  assert.equal(classifyProbeReadings(0o666, 0o666, 0o444), 'write-bit-only');
});

test('regression: the case only the positive control can satisfy — 666 / 666 / 666 is inconclusive', () => {
  // A filesystem that reports the same mode whatever it is asked, including when the write bit is
  // cleared. Without the third reading this is indistinguishable from the win32 shape above, and
  // the host would report "privacy is unconfirmable here" as if it had measured something.
  assert.equal(classifyProbeReadings(0o666, 0o666, 0o666), 'unobservable');
});

test('regression: the win32 shape and the dead-instrument shape differ only in the control reading', () => {
  // The two calls are identical but for the third argument. That is the whole value of taking it.
  assert.notEqual(classifyProbeReadings(0o666, 0o666, 0o444), classifyProbeReadings(0o666, 0o666, 0o666));
});

test('a filesystem that reports 0600 for everything is inconclusive, not "enforced"', () => {
  // The mirror trap: narrow matches what was requested, so a naive check calls it enforced — while
  // the filesystem is in fact reporting one constant and confirming nothing.
  assert.equal(classifyProbeReadings(0o600, 0o600, 0o600), 'unobservable');
});

test("probe readings carrying stat's file-type bits are masked before comparison", () => {
  assert.equal(classifyProbeReadings(0o100600, 0o100666, 0o100444), 'enforced');
});

// ---------------------------------------------------------------------------
// The inconclusive state — an instrument that can say "I could not tell"
// ---------------------------------------------------------------------------

test('regression: an instrument that observed nothing reports inconclusive, not "unenforced"', () => {
  // "This filesystem records nothing" and "my probe is broken" are indistinguishable from here, and
  // reporting the second as the first is how a dead check gets read as evidence.
  const outcome = classifyCredentialMode(0o666, UNOBSERVABLE);

  assert.equal(outcome.kind, 'unobservable');
  assert.equal(
    outcome.kind === 'unobservable' ? outcome.refusal.reason : null,
    'credential-mode-unobservable',
  );
});

test('regression: inconclusive and unenforced are different outcomes — a fact versus a gap', () => {
  // A caller must be able to branch: "privacy is unconfirmable here" needs no action, and "the
  // instrument is dead" needs investigating.
  const measured = classifyCredentialMode(0o666, NOT_ENFORCED);
  const inconclusive = classifyCredentialMode(0o666, UNOBSERVABLE);

  assert.notEqual(measured.kind, inconclusive.kind);
  assert.notEqual(
    measured.kind === 'unenforced' ? measured.refusal.reason : null,
    inconclusive.kind === 'unobservable' ? inconclusive.refusal.reason : null,
  );
});

test('the inconclusive detail says it is about the instrument, not about privacy', () => {
  const outcome = classifyCredentialMode(0o666, UNOBSERVABLE);

  assert.equal(outcome.kind, 'unobservable');
  if (outcome.kind !== 'unobservable') return;
  assert.match(outcome.refusal.detail, /inconclusive instrument/);
});

test('inconclusive wins over every other branch — nothing can be concluded from a dead instrument', () => {
  // Including the one that would otherwise look like a security finding.
  assert.equal(classifyCredentialMode(0o644, UNOBSERVABLE).kind, 'unobservable');
  assert.equal(classifyCredentialMode(0o600, UNOBSERVABLE).kind, 'unobservable');
});

test('isWiderThan compares permission bits only, ignoring the file-type bits stat returns', () => {
  // `statSync().mode` carries S_IFREG (0o100000) above the permission bits; masking is what keeps a
  // regular file from reading as "wider than requested" on every single write.
  assert.equal(isWiderThan(0o100600, CREDENTIAL_MODE), false);
  assert.equal(isWiderThan(0o100644, CREDENTIAL_MODE), true);
});

test('isWiderThan is false for an identical mode and true for any added bit', () => {
  assert.equal(isWiderThan(0o600, 0o600), false);
  for (const extra of [0o001, 0o004, 0o010, 0o040, 0o100]) {
    assert.equal(
      isWiderThan(0o600 | extra, 0o600),
      true,
      `mode ${toOctal(0o600 | extra)} should read as wider`,
    );
  }
});

test('toOctal renders a mode the way a human writes one', () => {
  assert.equal(toOctal(0o600), '0600');
  assert.equal(toOctal(0o100644), '0644');
});

// Guards the selector: if `classifyCredentialMode` returned the same kind for everything, most
// assertions above would still pass.
test('control: the classifier really does produce all four outcomes', () => {
  const kinds = new Set([
    classifyCredentialMode(0o600, ENFORCED).kind,
    classifyCredentialMode(0o644, ENFORCED).kind,
    classifyCredentialMode(0o666, NOT_ENFORCED).kind,
    classifyCredentialMode(0o666, UNOBSERVABLE).kind,
  ]);

  assert.deepEqual([...kinds].sort(), ['too-wide', 'unenforced', 'unobservable', 'verified']);
});
