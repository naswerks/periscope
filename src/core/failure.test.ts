import test from 'node:test';
import assert from 'node:assert/strict';

import { certificateRemedy, describeFailure, isCertificateRefusal } from './failure.js';

/** The shape Node's fetch throws over a self-signed server: a wrapper whose cause carries the code. */
function fetchFailedOverSelfSigned(): Error {
  const cause = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  return new TypeError('fetch failed', { cause });
}

test('the innermost cause is described, code first, so "fetch failed" names the certificate', () => {
  assert.equal(
    describeFailure(fetchFailedOverSelfSigned()),
    'DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate',
  );
  assert.equal(describeFailure(new Error('plain')), 'plain');
  assert.equal(describeFailure('a string'), 'a string');
  const coded = Object.assign(new Error('ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
  assert.equal(
    describeFailure(coded),
    'ECONNREFUSED 127.0.0.1:1',
    'a message already naming its code is not prefixed twice',
  );
});

test('a certificate refusal is recognised at any depth of nested causes, and nothing else is', () => {
  assert.equal(isCertificateRefusal(fetchFailedOverSelfSigned()), true);
  assert.equal(
    isCertificateRefusal(Object.assign(new Error('x'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })),
    true,
  );
  assert.equal(isCertificateRefusal(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), false);
  assert.equal(isCertificateRefusal(new Error('fetch failed')), false);
  assert.equal(isCertificateRefusal(null), false);
});

test('control: a cause that points back at itself does not hang the walk', () => {
  const looped: { cause?: unknown; code: string } = { code: 'ECONNRESET' };
  looped.cause = looped;
  assert.equal(isCertificateRefusal(looped), false);
  assert.match(describeFailure(looped), /ECONNRESET/);
});

test('the remedy names the file route first and the insecure switch as the alternative', () => {
  const remedy = certificateRemedy('the controller');
  assert.match(remedy, /NODE_EXTRA_CA_CERTS/);
  assert.match(remedy, /NODE_TLS_REJECT_UNAUTHORIZED=0/);
  assert.ok(remedy.indexOf('NODE_EXTRA_CA_CERTS') < remedy.indexOf('NODE_TLS_REJECT_UNAUTHORIZED'));
});
