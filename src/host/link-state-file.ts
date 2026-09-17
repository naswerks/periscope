/**
 * The link's last transition, kept on disk by `serve` so `periscope status` can answer "is this host
 * linked, and since when" without a socket: one JSON file beside the credentials, replaced whole on
 * every transition (written to a sibling, then renamed, so a reader never sees half a record). The
 * process id rides in it, so a stale record from a host that died can be told from a live one.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { LinkCause, LinkState } from '../control/link-state.js';
import { tokenCachePath } from './paths.js';

export interface LinkStateRecord {
  readonly state: LinkState;
  readonly cause: LinkCause;
  readonly at: string;
  readonly detail: string | null;
  /** The version the controller chose at the last accepted handshake; null before one. */
  readonly negotiatedVersion: number | null;
  /** The serve process that wrote the record. */
  readonly pid: number;
}

/** Beside the token cache and the paired credential; null where there is no home and no config dir. */
export function linkStatePath(env: NodeJS.ProcessEnv): string | null {
  const cache = tokenCachePath(env);
  return cache === null ? null : join(dirname(cache), 'link-state.json');
}

/** Writes the record whole. Returns the problem, or null. Never throws: the link must not depend on the disk. */
export function writeLinkState(env: NodeJS.ProcessEnv, record: LinkStateRecord): string | null {
  const path = linkStatePath(env);
  if (path === null)
    return 'there is nowhere to keep the link state (no home directory and no PERISCOPE_CONFIG_DIR)';
  try {
    mkdirSync(dirname(path), { recursive: true });
    const sibling = `${path}.${record.pid}.tmp`;
    writeFileSync(sibling, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    renameSync(sibling, path);
    return null;
  } catch (error) {
    return `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The record, or null when there is none or it is unreadable: an absent file is a host that never ran. */
export function readLinkState(env: NodeJS.ProcessEnv): LinkStateRecord | null {
  const path = linkStatePath(env);
  if (path === null) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<LinkStateRecord> | null;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.state !== 'string' ||
      typeof parsed.cause !== 'string' ||
      typeof parsed.at !== 'string' ||
      typeof parsed.pid !== 'number'
    ) {
      return null;
    }
    return {
      state: parsed.state,
      cause: parsed.cause,
      at: parsed.at,
      detail: typeof parsed.detail === 'string' ? parsed.detail : null,
      negotiatedVersion: typeof parsed.negotiatedVersion === 'number' ? parsed.negotiatedVersion : null,
      pid: parsed.pid,
    };
  } catch {
    return null;
  }
}
