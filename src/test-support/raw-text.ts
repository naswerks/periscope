/**
 * The text of a `ws` message, whatever shape the socket delivered it in. `String(data)` renders a
 * Buffer correctly and an ArrayBuffer or a Buffer list as `[object ...]`, so the shape is named.
 */
import type { RawData } from 'ws';

export function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
