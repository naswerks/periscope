/**
 * Temporary directories for tests. Every test that writes to disk writes under the OS temp
 * directory and removes what it made; nothing here can point at the developer's real home.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a fresh directory under the OS temp root, named `periscope-<label>-<random>`. */
export function tempDir(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `periscope-${label}-`));
}

/** Run `body` with a fresh temp directory and remove it afterwards, whatever `body` does. */
export async function withTempDir<T>(label: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await tempDir(label);
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
