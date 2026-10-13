/**
 * The line decoder against its definition: any sequence of JSON values, each ended by `\n` or `\r\n`,
 * cut into chunks at arbitrary byte offsets (inside a character included), decodes to the same
 * values in the same order; a line past the bound becomes exactly one `rpc-line-too-large` in its
 * place, and the lines around it are read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';

import type { JsonValue } from '../control/frames.js';
import type { Result } from '../core/result.js';
import { propertyRuns } from '../test-support/property.js';
import { JsonLineDecoder } from './stdio-rpc.js';

const values = fc.array(fc.jsonValue({ stringUnit: 'binary' }), { minLength: 1, maxLength: 12 });
const endings = fc.array(fc.constantFrom('\n', '\r\n'), { minLength: 12, maxLength: 12 });

function chunked(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const offsets = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].sort((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const offset of offsets) {
    chunks.push(bytes.subarray(start, offset));
    start = offset;
  }
  chunks.push(bytes.subarray(start));
  return chunks;
}

function decodeAll(decoder: JsonLineDecoder, chunks: readonly Uint8Array[]): Result<JsonValue>[] {
  return [...chunks.flatMap((chunk) => decoder.push(chunk)), ...decoder.end()];
}

test('any values, any line endings, any chunking: the same values back, in order', () => {
  fc.assert(
    fc.property(values, endings, fc.array(fc.nat(), { maxLength: 40 }), (sent, ends, cuts) => {
      const text = sent.map((value, index) => `${JSON.stringify(value)}${ends[index] ?? '\n'}`).join('');
      const decoded = decodeAll(new JsonLineDecoder(), chunked(Buffer.from(text, 'utf8'), cuts));
      const expected = sent.map((value) => ({
        ok: true,
        value: JSON.parse(JSON.stringify(value)) as JsonValue,
      }));
      assert.deepEqual(decoded, expected);
    }),
    propertyRuns(),
  );
});

test('a line past the bound is one rpc-line-too-large in its place, under any chunking', () => {
  const bound = 48;
  const line = fc.oneof(
    fc.record({ big: fc.constant(false), value: fc.jsonValue({ maxDepth: 1 }) }),
    fc.record({ big: fc.constant(true), value: fc.string({ minLength: bound, maxLength: bound * 3 }) }),
  );
  fc.assert(
    fc.property(
      fc.array(line, { minLength: 1, maxLength: 10 }),
      fc.array(fc.nat(), { maxLength: 30 }),
      (lines, cuts) => {
        const kept = lines.filter(
          (entry) => entry.big || Buffer.byteLength(JSON.stringify(entry.value), 'utf8') <= bound,
        );
        const text = kept.map((entry) => `${JSON.stringify(entry.value)}\n`).join('');
        const decoded = decodeAll(new JsonLineDecoder(bound), chunked(Buffer.from(text, 'utf8'), cuts));
        const expected = kept.map((entry) =>
          entry.big
            ? 'rpc-line-too-large'
            : JSON.stringify(JSON.parse(JSON.stringify(entry.value)) as JsonValue),
        );
        assert.deepEqual(
          decoded.map((result) => (result.ok ? JSON.stringify(result.value) : result.refusal.reason)),
          expected,
        );
      },
    ),
    propertyRuns(),
  );
});
