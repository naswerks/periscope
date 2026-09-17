/**
 * `periscope status`: what this host is, read from what `serve` reads and from the link record
 * `serve` keeps, never from a socket. A host that cannot dial is exactly when the question is asked.
 */
import { readConfigFile } from '../host/config-file.js';
import { readLinkState } from '../host/link-state-file.js';
import { tokenCachePath } from '../host/paths.js';
import { FileTokenCache } from '../host/token-cache.js';
import { readMachineFacts } from '../host/machine.js';
import { describePosture, renderPosture } from './posture.js';
import { packageVersion } from '../host/package-facts.js';
import type { ServeViews } from './serve.js';
import { readCredential } from './serve.js';

export interface StatusOutcome {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

export interface StatusDeps {
  readonly nowMs: () => number;
  readonly pidAlive: (pid: number) => boolean;
}

function processPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const REAL: StatusDeps = { nowMs: () => Date.now(), pidAlive: processPidAlive };

export function runStatus(views: ServeViews, deps: StatusDeps = REAL): StatusOutcome {
  if (typeof views.merged === 'string') return { ok: false, lines: [views.merged] };
  const raw = views.raw;
  const file = readConfigFile(raw);
  const credential = readCredential(raw, () => undefined);

  let tokenExpiresAtMs: number | null = null;
  const cache = tokenCachePath(raw);
  if (cache !== null) {
    const cached = new FileTokenCache(cache).read();
    if (cached.ok) tokenExpiresAtMs = cached.value.tokens.expiresAt;
  }

  const posture = describePosture({
    raw,
    merged: views.merged,
    fileValues: file.problem === null ? file.values : {},
    credential,
    tokenExpiresAtMs,
    nowMs: deps.nowMs(),
    link: readLinkState(raw),
    pidAlive: deps.pidAlive,
    hostname: readMachineFacts().hostname,
  });
  return { ok: true, lines: [`periscope ${packageVersion()}`, ...renderPosture(posture)] };
}
