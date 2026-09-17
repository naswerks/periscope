/**
 * The package's own version, read from the manifest that ships beside `dist/`.
 *
 * Read here rather than baked in at build: `package.json` is the one place the version is stated,
 * and a constant copied into source would be a second place that can drift. The read is lazy and
 * memoised, and a manifest that cannot be read reports `unknown` rather than failing a verb that
 * only wanted to print a line.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/** `<name>@<version>` of the running package, or `unknown` when the manifest cannot be read. */
export function packageVersion(): string {
  if (cached !== null) return cached;
  try {
    const manifestPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
    cached = typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
