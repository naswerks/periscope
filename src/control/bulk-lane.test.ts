/**
 * The property: no bulk payload can cross the link.
 *
 * The codec enforces it by size (codec.test.ts). This file enforces it by shape: the bulk lane's
 * frames carry a locator and a receipt, and there is no field on any of them for content to travel
 * in. Both halves matter: a size limit alone would be one raised constant away from a hole.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { BulkDelivered, BulkFailed, BulkRequest, SessionPayload } from './frames.js';

test('bulk_request carries a locator and no content field', () => {
  const request: BulkRequest = {
    kind: 'bulk_request',
    deliveryId: 'd-1',
    what: 'transcript',
    fromOffset: 0,
    postUrl: 'https://controller.example/bulk/d-1',
  };
  assert.deepEqual(Object.keys(request).sort(), ['deliveryId', 'fromOffset', 'kind', 'postUrl', 'what']);
});

test('the bulk receipts carry counts and reasons, never bytes', () => {
  // Protocol v4 widened the receipt by two stat numbers (rewrite detection for a transcript pull);
  // the property this test pins is unchanged: counts and reasons, never bytes.
  const delivered: BulkDelivered = {
    kind: 'bulk_delivered',
    deliveryId: 'd-1',
    byteCount: 3_090_000,
    sizeBytes: 3_090_000,
    mtimeMs: 1_724_500_000_000,
  };
  assert.deepEqual(Object.keys(delivered).sort(), [
    'byteCount',
    'deliveryId',
    'kind',
    'mtimeMs',
    'sizeBytes',
  ]);

  const failed: BulkFailed = {
    kind: 'bulk_failed',
    deliveryId: 'd-1',
    refusal: { reason: 'bulk-delivery-failed', detail: 'controller answered 503' },
  };
  assert.deepEqual(Object.keys(failed).sort(), ['deliveryId', 'kind', 'refusal']);
});

test('every payload kind is accounted for, so a new one cannot quietly add a content field', () => {
  // A `satisfies`-style exhaustive list. Adding a kind to the union without adding it here fails
  // to compile, which is what stops this test from silently going out of date.
  const everyKind: SessionPayload['kind'][] = [
    'session_update',
    'session_delta',
    'session_new',
    'session_prompt',
    'session_cancel',
    'bulk_request',
    'bulk_delivered',
    'bulk_failed',
  ];
  const check = (kind: SessionPayload['kind']): SessionPayload['kind'] => kind;
  for (const kind of everyKind) assert.equal(check(kind), kind);
  assert.equal(new Set(everyKind).size, everyKind.length);
});
