/**
 * The local JSONL mirror: the store's effects, on a real disk.
 *
 * It lives here for the one reason everything else in this directory does: it names `node:fs`.
 * The rules worth testing (which key becomes which record, what a missing transcript returns, what
 * a corrupt line does) are in `persistence/store.ts` and are proven without a disk. This file is
 * the part that cannot be, so it is small and it is the only place a path is built.
 *
 * The root is a jail, and the token is escaped before it gets here. A project key is
 * caller-supplied and may contain anything, separators included; `transcriptToken` percent-encodes
 * each segment so a key cannot introduce one. This checks containment anyway, because a jail that
 * relies on its caller having escaped correctly is a jail with one lock on the outside.
 */
import { mkdir, readFile, readdir, rm, stat, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { StoreEffects } from '../persistence/store.js';
import { isContainedBy, normalizePath, requireAbsolute } from '../core/paths.js';

/** File-backed effects rooted at one directory. The root must be absolute. */
export function nodeStoreEffects(root: string): StoreEffects {
  const absolute = requireAbsolute(root);
  if (!absolute.ok) {
    throw new Error(`the transcript root must be absolute: ${absolute.refusal.detail}`);
  }
  const rootPath = normalizePath(absolute.value);

  const pathFor = (token: string): string => {
    const candidate = normalizePath(resolve(rootPath, `${token}.jsonl`));
    if (!isContainedBy(candidate, rootPath)) {
      // Unreachable through `transcriptToken`, which escapes every segment. Kept because the day it
      // becomes reachable is the day somebody writes a second token function.
      throw new Error(`refusing a transcript path outside the store root: ${token}`);
    }
    return candidate;
  };

  return {
    async appendTo(token: string, text: string): Promise<void> {
      const file = pathFor(token);
      await mkdir(dirname(file), { recursive: true });
      // A real append, not a read-modify-write: a transcript reaches megabytes and batches arrive
      // throughout a turn, so rewriting per batch would cost the square of the session's length.
      await appendFile(file, text, 'utf8');
    },

    async readAll(token: string): Promise<string | null> {
      try {
        return await readFile(pathFor(token), 'utf8');
      } catch (error) {
        // A transcript that was never written is `null`, and that is distinct from a read that
        // failed — the store contract turns the first into "nothing was ever stored" and must not
        // be handed it for a permission error.
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async list(projectKey: string) {
      const scope = pathFor(encodeURIComponent(projectKey)).replace(/\.jsonl$/, '');
      let names: string[];
      try {
        names = await readdir(scope);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }

      const found: { token: string; sessionId: string; mtime: number }[] = [];
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const encodedId = name.slice(0, -'.jsonl'.length);
        const stats = await stat(join(scope, name));
        found.push({
          token: `${encodeURIComponent(projectKey)}/${encodedId}`,
          sessionId: decodeURIComponent(encodedId),
          // Floored: the contract asks for integer epoch milliseconds and a fractional source here
          // would not compare equal to a summary's own stamp.
          mtime: Math.floor(stats.mtimeMs),
        });
      }
      return found;
    },

    async remove(token: string): Promise<void> {
      await rm(pathFor(token), { force: true });
    },

    async subkeys(projectKey: string, sessionId: string): Promise<readonly string[]> {
      // A session's subagent transcripts live under a directory named for the session, beside its
      // own file. Absent means it never spawned one, which is not an error.
      const scope = pathFor(`${encodeURIComponent(projectKey)}/${encodeURIComponent(sessionId)}`).replace(
        /\.jsonl$/,
        '',
      );
      try {
        return (await readdir(scope))
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => decodeURIComponent(name.slice(0, -'.jsonl'.length)));
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    },
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}
